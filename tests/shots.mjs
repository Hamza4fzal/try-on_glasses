// Renders every catalogue model on the canonical head from several angles (3D fit preview) and
// saves PNGs to test-output/shots/ for visual review of model quality and natural fit.
//
// Usage: node tests/shots.mjs [productId ...] [--views=front,three,side,top,close] [--variants]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv, watchErrors } from './lib.mjs';

const args = process.argv.slice(2);
const viewsArg = args.find((a) => a.startsWith('--views='));
const views = viewsArg ? viewsArg.slice(8).split(',') : ['front', 'three', 'side', 'top', 'close'];
const allVariants = args.includes('--variants');
const catalog = JSON.parse(readFileSync('public/products/products.json', 'utf8'));
const ids = args.filter((a) => !a.startsWith('--'));
const products = catalog.products.filter((p) => !ids.length || ids.includes(p.id));
const outDir = 'test-output/shots';
mkdirSync(outDir, { recursive: true });

const env = await startEnv();
try {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  watchErrors(page, 'viewer');
  await page.goto(`${env.url}demo/viewer.html?capture`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { timeout: 60000 });
  await page.addStyleTag({ content: '.lab-panel,.bar{display:none!important}' });
  for (const p of products) {
    const variants = allVariants ? p.variants.map((v) => v.id) : [p.defaultVariant ?? p.variants[0]?.id];
    for (const v of variants) {
      await page.evaluate((id, vid) => window.__viewer.show(id, vid), p.id, v);
      for (const view of views) {
        await page.evaluate((name) => window.__viewer.setView(name), view);
        await new Promise((r) => setTimeout(r, 400));
        const file = join(outDir, `${p.id}-${v}-${view}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
    }
  }
} finally {
  await env.close();
}
