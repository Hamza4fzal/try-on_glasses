// Production-build smoke test + download budget:
//   - builds with Vite, serves dist/ with `vite preview` (what a server / the WordPress plugin ships)
//   - the demo store loads, the try-on opens and goes live from the BUILT bundle
//   - reports what a customer downloads at each step (gzip sizes, as a typical server sends them)
//   - production pages contain no debug overlay
//
// Usage: node tests/run-dist.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';
import { findChrome, stubCameraScript, watchErrors } from './lib.mjs';

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;

console.log('=== Build ===');
await build({ logLevel: 'error' });
check(true, 'vite build succeeded');

const server = await preview({ logLevel: 'error', preview: { port: 4199, strictPort: false, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run'],
});

// Transfer size per request, as gzip (vite preview doesn't compress; production servers do).
const gz = new Map();
function wireSize(path) {
  if (!gz.has(path)) {
    const file = join('dist', path);
    let size = 0;
    try {
      if (statSync(file).isFile()) {
        const buf = readFileSync(file);
        size = /\.(webp|png|jpe?g)$/.test(file) ? buf.length : gzipSync(buf, { level: 6 }).length;
      }
    } catch {
      /* not a file */
    }
    gz.set(path, size);
  }
  return gz.get(path);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = watchErrors(page, 'dist');
  await page.evaluateOnNewDocument(stubCameraScript());
  const phase = { name: 'page' };
  const totals = {};
  const origin = new URL(url).origin;
  page.on('requestfinished', (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin) return;
    const path = decodeURIComponent(u.pathname).replace(/^\//, '');
    const kind = /\.js$/.test(path) ? 'js' : /\.wasm$/.test(path) ? 'wasm' : /\.task$/.test(path) ? 'tracking model' : /\.glb$/.test(path) ? '3D model' : /\.(webp|png|jpe?g)$/.test(path) ? 'images' : 'other';
    const t = (totals[phase.name] ??= {});
    t[kind] = (t[kind] ?? 0) + wireSize(path);
  });

  // The stub camera image lives in test-assets (not part of the build): serve it from memory.
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().endsWith('/test-assets/portrait.jpg')) {
      r.respond({ status: 200, contentType: 'image/jpeg', body: readFileSync('test-assets/portrait.jpg') });
    } else r.continue();
  });

  console.log('\n=== Built demo store ===');
  await page.goto(`${url}demo/shop.html?delegate=CPU`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { polling: 100, timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  check(true, 'product page renders from the built bundle');

  phase.name = 'intent (hover)';
  await page.hover('#try');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /try-on-engine/.test(e.name)), { polling: 100, timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));

  phase.name = 'open (intro)';
  await page.click('#try');
  await page.waitForFunction(
    () => {
      const e = window.__shop.vto._modal?.tryOnEngine;
      return e?.trackingReady && e.product;
    },
    { polling: 100, timeout: 90000 },
  );

  phase.name = 'live';
  await page.evaluate(() => document.querySelector('vto-modal').shadowRoot.querySelector('.start').click());
  await page.waitForFunction(() => window.__shop.vto.state === 'live' && window.__shop.vto._modal.tryOnEngine.loop.solver.pose.valid, {
    polling: 100,
    timeout: 90000,
  });
  check(true, 'try-on goes live from the built bundle (camera → tracking → 3D)');

  phase.name = 'other frame';
  await page.evaluate(() => document.querySelector('vto-modal').shadowRoot.querySelector('.frame-chip[data-product="pilot"]').click());
  await page.waitForFunction(() => window.__shop.vto._modal.tryOnEngine.product?.id === 'pilot', { polling: 100, timeout: 30000 });

  console.log('\n=== What a customer downloads (gzip) ===');
  for (const [name, t] of Object.entries(totals)) {
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    const parts = Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${kb(v)}`)
      .join(', ');
    console.log(`  ${name.padEnd(15)} ${kb(sum).padStart(8)}   (${parts})`);
  }
  const pageJs = totals.page?.js ?? 0;
  check(pageJs < 30 * 1024, `product page JavaScript stays small (${kb(pageJs)} < 30 KB)`);
  check((totals.page?.wasm ?? 0) + (totals.page?.['3D model'] ?? 0) === 0, 'no tracking runtime or 3D models with the product page');
  const model = totals['other frame']?.['3D model'] ?? 0;
  check(model > 0 && model < 350 * 1024, `switching frames downloads one compressed model (${kb(model)})`);

  // Production pages must not ship the debug overlay.
  const shopHtml = readFileSync('dist/demo/shop.html', 'utf8');
  const chunks = [...shopHtml.matchAll(/(?:src|href)="\.\.\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const engineChunks = readdirSync('dist/assets').filter((f) => /^(try-on-engine|try-on-modal)-.*\.js$/.test(f));
  const leaks = [...chunks, ...engineChunks].filter((f) => /landmark overlay|DebugOverlay/.test(readFileSync(join('dist/assets', f), 'utf8')));
  check(leaks.length === 0, 'no debug overlay in the customer bundle');
  check(errors.length === 0, `no page errors (${errors.length})`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
