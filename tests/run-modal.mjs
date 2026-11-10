// Customer try-on modal tests (headless Chrome, stubbed camera, demo store page):
//   - camera is requested only after the explicit "Start camera" click (privacy)
//   - full flow: intro → live → colour → other frame → photo → back → close (tracks ended, focus restored)
//   - nothing is uploaded: every request is a GET to the page's own origin, no request bodies
//   - error states: permission denied (with help), no camera, camera busy, insecure context
//   - page hidden → camera stopped and "paused" shown
//   - Escape closes, focus stays trapped inside the dialog
//   - phone layout renders (screenshots)
// Screenshots: test-output/modal/
//
// Usage: node tests/run-modal.mjs
import { mkdirSync } from 'node:fs';
import { startEnv, stubCameraScript, watchErrors } from './lib.mjs';

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const out = 'test-output/modal';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helpers evaluated in the page.
const Q = `window.__q = (sel) => document.querySelector('vto-modal')?.shadowRoot?.querySelector(sel);
window.__click = (sel) => { const el = window.__q(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
window.__visible = (sel) => { const el = window.__q(sel); return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0; };
window.__state = () => window.__shop?.vto.state;`;

async function openShop(env, { camera = 'ok', viewport = { width: 1280, height: 800 }, query = '' } = {}) {
  const page = await env.browser.newPage();
  await page.setViewport(viewport);
  const errors = watchErrors(page, 'shop');
  if (camera === 'ok') await page.evaluateOnNewDocument(stubCameraScript());
  else {
    await page.evaluateOnNewDocument(`(() => {
      window.__streams = [];
      window.__gumCalls = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.__gumCalls++; throw new DOMException('stub', '${camera}'); };
    })();`);
  }
  await page.evaluateOnNewDocument(Q);
  await page.goto(`${env.url}demo/shop.html?delegate=CPU&capture${query}`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { polling: 100, timeout: 60000 });
  return { page, errors };
}

const env = await startEnv();
try {
  // ------------------------------------------------------------ main flow (desktop)
  console.log('=== Customer flow (desktop) ===');
  const { page, errors } = await openShop(env);
  const origin = new URL(env.url).origin;
  const badRequests = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    const local = u.origin === origin || u.protocol === 'blob:' || u.protocol === 'data:';
    if (!local || r.method() !== 'GET' || r.postData()) badRequests.push(`${r.method()} ${r.url().slice(0, 120)}`);
  });
  await page.screenshot({ path: `${out}/01-product-page.png` });

  await page.click('#try');
  await page.waitForFunction(() => window.__visible('.start'), { polling: 100, timeout: 10000 });
  await sleep(400);
  await page.screenshot({ path: `${out}/02-intro.png` });
  const streamsBefore = await page.evaluate(() => window.__streams.length);
  check(streamsBefore === 0, 'camera not requested before the customer clicks "Start camera"');
  const introText = await page.evaluate(() => window.__q('[data-panel="intro"]').textContent);
  check(/never|Nothing is recorded, uploaded or saved/i.test(introText) && /permission/i.test(introText), 'intro explains privacy and the permission prompt');
  const focusInDialog = await page.evaluate(() => document.querySelector('vto-modal').shadowRoot.activeElement?.className ?? '');
  check(/start/.test(focusInDialog), `focus moved into the dialog (${focusInDialog})`);
  const overflow = await page.evaluate(() => document.documentElement.style.overflow);
  check(overflow === 'hidden', 'page scroll locked while open');

  await page.evaluate(() => window.__click('.start'));
  await page.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 90000 });
  await page.waitForFunction(() => window.__shop.vto._modal.tryOnEngine.loop.solver.pose.valid, { polling: 100, timeout: 60000 });
  await sleep(1500);
  await page.screenshot({ path: `${out}/03-live.png` });
  const live = await page.evaluate(() => {
    const e = window.__shop.vto._modal.tryOnEngine;
    return { rig: e.rig.group.visible, product: e.product.id, variant: e.variant.id, mirrored: window.__q('.gl').classList.contains('mirror'), quality: e.quality, occl: e.occlusionMode };
  });
  check(live.rig && live.product === 'aria' && live.variant === 'havana', `live try-on shows ${live.product}/${live.variant} (quality ${live.quality}, occlusion ${live.occl})`);
  check(live.mirrored, 'selfie preview is mirrored');

  // Colour
  await page.evaluate(() => window.__click('.swatch[data-variant="crystal"]'));
  await page.waitForFunction(() => window.__shop.vto._modal.tryOnEngine.variant?.id === 'crystal', { polling: 100, timeout: 10000 });
  const synced = await page.evaluate(() => document.querySelector('#p-swatches [data-variant="crystal"]').getAttribute('aria-checked'));
  check(synced === 'true', 'colour change in the modal is reflected on the product page');
  const label = await page.evaluate(() => window.__q('.colour-label strong').textContent);
  check(label === 'Crystal clear', `colour label updates (${label})`);
  await sleep(800);
  await page.screenshot({ path: `${out}/04-crystal.png` });

  // Other frame
  await page.evaluate(() => window.__click('.frame-chip[data-product="pilot"]'));
  await page.waitForFunction(() => window.__shop.vto._modal.tryOnEngine.product?.id === 'pilot', { polling: 100, timeout: 20000 });
  const title = await page.evaluate(() => window.__q('.title-name').textContent);
  check(title === 'Pilot', 'switching frames inside the modal updates model and title');
  await sleep(1000);
  await page.screenshot({ path: `${out}/05-pilot.png` });

  // Photo
  await page.evaluate(() => window.__click('.shutter'));
  await page.waitForFunction(() => window.__state() === 'photo', { polling: 100, timeout: 10000 });
  const photo = await page.evaluate(async () => {
    const img = window.__q('.photo img');
    await img.decode();
    const a = window.__q('.save');
    // Mean brightness of the photo (not a black frame).
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 5), href: a.href.slice(0, 5), download: a.download, mean: sum / (64 * 64 * 3) };
  });
  check(photo.w > 300 && photo.h > 300 && photo.src === 'blob:' && photo.mean > 20, `photo captured locally (${photo.w}×${photo.h}, ${photo.src} URL, mean ${photo.mean.toFixed(0)})`);
  check(photo.href === 'blob:' && /pilot-try-on\.jpg$/.test(photo.download), `save link is a local download (${photo.download})`);
  await page.screenshot({ path: `${out}/06-photo.png` });
  await page.evaluate(() => window.__click('.back'));
  await page.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 10000 });
  check(true, 'back from photo to live try-on');

  // Focus trap: tab many times — focus must stay inside the dialog.
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  const trapped = await page.evaluate(() => document.activeElement?.tagName === 'VTO-MODAL');
  check(trapped, 'keyboard focus stays inside the dialog');

  // Escape closes; camera off; focus returns.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__state() === 'closed', { polling: 100, timeout: 5000 });
  const closed = await page.evaluate(() => ({
    ended: window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
    focus: document.activeElement?.id,
    overflow: document.documentElement.style.overflow,
    hidden: document.querySelector('vto-modal').hidden,
  }));
  check(closed.ended, 'Escape closes the modal and every camera track is stopped');
  check(closed.focus === 'try' && closed.overflow === '' && closed.hidden, 'focus returns to the button, scroll restored');

  // Re-open (second product via grid card) → straight to intro, then live again quickly.
  await page.evaluate(() => document.querySelector('.card .try-sm').click());
  await page.waitForFunction(() => window.__state() === 'intro', { polling: 100, timeout: 5000 });
  await page.evaluate(() => window.__click('.start'));
  await page.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 30000 });
  check(true, 're-open from a product card and restart');

  // Page hidden → paused + camera stopped.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const paused = await page.evaluate(() => ({ state: window.__state(), ended: window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')) }));
  check(paused.state === 'paused' && paused.ended, 'page in background → camera stopped, "paused" shown');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.screenshot({ path: `${out}/07-paused.png` });
  await page.evaluate(() => window.__click('.resume'));
  await page.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 30000 });
  check(true, 'resume after pause');
  await page.evaluate(() => window.__click('.close'));
  await page.waitForFunction(() => window.__state() === 'closed', { polling: 100, timeout: 5000 }).catch(async (e) => {
    console.log('state after close click:', await page.evaluate(() => window.__state()), errors);
    throw e;
  });

  check(badRequests.length === 0, `no uploads / third-party requests (${badRequests.length}${badRequests.length ? ': ' + badRequests.slice(0, 3).join(', ') : ''})`);
  check(errors.length === 0, `no page errors (${errors.length})`);
  await page.close();

  // ------------------------------------------------------------ error states
  console.log('\n=== Error states ===');
  const cases = [
    ['NotAllowedError', 'Camera access is blocked', true],
    ['NotFoundError', 'No camera found', false],
    ['NotReadableError', 'Your camera is busy', false],
  ];
  for (const [name, expectTitle, expectHelp] of cases) {
    const { page: p, errors: errs } = await openShop(env, { camera: name });
    await p.click('#try');
    await p.waitForFunction(() => window.__visible('.start'), { polling: 100, timeout: 10000 });
    await p.evaluate(() => window.__click('.start'));
    await p.waitForFunction(() => window.__state() === 'error', { polling: 100, timeout: 20000 });
    const r = await p.evaluate(() => ({
      title: window.__q('[data-panel="error"] h3').textContent,
      help: window.__visible('.help'),
      retry: window.__visible('.retry'),
      calls: window.__gumCalls,
    }));
    check(r.title === expectTitle && r.help === expectHelp && r.retry, `${name} → "${r.title}"${r.help ? ' + how-to-unblock help' : ''}, retry offered`);
    if (name === 'NotAllowedError') {
      await p.screenshot({ path: `${out}/08-denied.png` });
      await p.evaluate(() => window.__click('.retry'));
      await p.waitForFunction((n) => window.__gumCalls > n, { timeout: 5000 }, r.calls);
      check(true, 'retry asks for the camera again');
    }
    check(errs.filter((e) => !/stub/.test(e)).length === 0, `${name}: no unexpected page errors`);
    await p.close();
  }

  // Insecure context: simulate http:// on a non-localhost host.
  {
    const p = await env.browser.newPage();
    await p.evaluateOnNewDocument(`Object.defineProperty(window, 'isSecureContext', { get: () => false }); ${Q}`);
    await p.goto(`${env.url}demo/shop.html?delegate=CPU`);
    await p.waitForFunction(() => document.title.includes('(ready)'), { polling: 100, timeout: 60000 });
    await p.click('#try');
    await p.waitForFunction(() => window.__visible('.start'), { polling: 100, timeout: 10000 });
    await p.evaluate(() => window.__click('.start'));
    await p.waitForFunction(() => window.__state() === 'error', { polling: 100, timeout: 10000 });
    const r = await p.evaluate(() => ({ title: window.__q('[data-panel="error"] h3').textContent, retry: window.__visible('.retry') }));
    check(r.title === 'Secure connection needed' && !r.retry, `no HTTPS → "${r.title}" (no pointless retry)`);
    await p.close();
  }

  // ------------------------------------------------------------ lazy loading + camera race
  console.log('\n=== Lazy loading & camera races ===');
  {
    const p = await env.browser.newPage();
    const errs = watchErrors(p, 'lazy');
    await p.evaluateOnNewDocument(stubCameraScript());
    await p.evaluateOnNewDocument(Q);
    const urls = [];
    p.on('request', (r) => urls.push(r.url()));
    const HEAVY_JS = /try-on-engine|try-on-modal|[/._]three[/._@]|tasks-vision/;
    const HEAVY_DATA = /\.wasm|\.task|\.glb/;
    await p.goto(`${env.url}demo/shop.html?delegate=CPU`);
    await p.waitForFunction(() => document.title.includes('(ready)'), { polling: 100, timeout: 60000 });
    await sleep(800);
    const atLoad = urls.filter((u) => HEAVY_JS.test(u) || HEAVY_DATA.test(u));
    check(atLoad.length === 0, `product page loads no 3D engine / tracking / models up front (${atLoad.length} requests)`);

    await p.hover('#try');
    await p.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /try-on-engine/.test(e.name)), { polling: 100, timeout: 20000 });
    await sleep(500);
    check(
      urls.some((u) => /try-on-modal/.test(u)) && urls.some((u) => /try-on-engine/.test(u)) && !urls.some((u) => HEAVY_DATA.test(u)),
      'hovering the button prefetches the try-on code only (no tracking data, no models)',
    );

    await p.click('#try');
    await p.waitForFunction(() => window.__visible('.start'), { polling: 100, timeout: 10000 });
    await p.waitForFunction(() => window.__shop.vto._modal?.tryOnEngine?.trackingReady && window.__shop.vto._modal.tryOnEngine.product, { polling: 100, timeout: 90000 });
    const streams0 = await p.evaluate(() => window.__streams.length);
    check(
      urls.some((u) => /\.wasm/.test(u)) && urls.some((u) => /\.task/.test(u)) && urls.some((u) => /\.glb/.test(u)) && streams0 === 0,
      'opening preloads face tracking + the frame during the intro, still without the camera',
    );

    // The customer cancels while the permission prompt is open, then starts again: the first
    // (late) stream must be stopped and never shown.
    await p.evaluate(() => (window.__gumDelay = 1200));
    await p.evaluate(() => window.__click('.start'));
    await p.waitForFunction(() => window.__state() === 'waiting', { polling: 50, timeout: 5000 });
    await p.evaluate(() => window.__click('.cancel'));
    await p.evaluate(() => (window.__gumDelay = 0));
    await p.evaluate(() => window.__click('.start'));
    await p.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 30000 });
    await sleep(1800); // the first, delayed getUserMedia resolves meanwhile
    const live = await p.evaluate(() => window.__streams.map((s) => s.getVideoTracks().filter((t) => t.readyState === 'live').length));
    check(live.length === 2 && live.reduce((a, b) => a + b, 0) === 1, `cancel + restart during the prompt leaves exactly one camera on (${JSON.stringify(live)})`);
    check(await p.evaluate(() => window.__state() === 'live'), 'try-on still live after the late stream was discarded');

    // Headless software rendering runs far below the camera's 30 fps: adaptive quality must
    // step down to the cheapest level and keep tracking.
    const t0 = Date.now();
    await p
      .waitForFunction(() => {
        const q = window.__shop.vto._modal.tryOnEngine.qualityLevel;
        return q.index === q.count - 1;
      }, { polling: 250, timeout: 40000 })
      .catch(() => undefined);
    const q = await p.evaluate(() => {
      const e = window.__shop.vto._modal.tryOnEngine;
      return { ...e.qualityLevel, occ: e.occlusionMode, shadows: e.shadows.enabled, fps: e.renderFps, valid: e.loop.solver.pose.valid, dpr: e.view.renderer.getPixelRatio() };
    });
    check(
      q.index === q.count - 1 && q.occ === 'hard' && !q.shadows && q.dpr === q.pixelRatio && q.valid,
      `slow device (${q.fps.toFixed(1)} fps): adaptive quality stepped down to ${q.index + 1}/${q.count} (hard occlusion, no shadows) in ${((Date.now() - t0) / 1000).toFixed(0)} s, still tracking`,
    );
    await p.screenshot({ path: `${out}/13-adaptive-low.png` });

    // Closing while the engine is still loading must also release the camera.
    await p.evaluate(() => window.__shop.vto.close());
    const after = await p.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
    check(after, 'all tracks ended after close');
    check(errs.length === 0, `lazy: no page errors (${errs.length})`);
    await p.close();
  }

  // ------------------------------------------------------------ phone layout
  console.log('\n=== Phone layout ===');
  {
    const { page: p, errors: errs } = await openShop(env, { viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
    await p.screenshot({ path: `${out}/10-phone-product.png` });
    await p.evaluate(() => document.querySelector('#try').click());
    await p.waitForFunction(() => window.__visible('.start'), { polling: 100, timeout: 10000 });
    await sleep(400);
    await p.screenshot({ path: `${out}/11-phone-intro.png` });
    await p.evaluate(() => window.__click('.start'));
    await p.waitForFunction(() => window.__state() === 'live', { polling: 100, timeout: 90000 });
    await p.waitForFunction(() => window.__shop.vto._modal.tryOnEngine.loop.solver.pose.valid, { polling: 100, timeout: 60000 });
    await sleep(1500);
    await p.screenshot({ path: `${out}/12-phone-live.png` });
    const box = await p.evaluate(() => {
      const r = window.__q('.dialog').getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    check(box.w === 390 && box.h === 844, `full-screen dialog on phones (${box.w}×${box.h})`);
    check(errs.length === 0, `phone: no page errors (${errs.length})`);
    await p.close();
  }
} finally {
  await env.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
