// Renders a product image for every catalogue product × colourway from its own GLB (3D fit
// preview, ?thumb mode: transparent background, no head) → public/products/images/<id>-<variant>.webp
// Used by the demo store. Real stores use their own product photography.
//
// Usage: node tools/render-thumbs.mjs
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv, watchErrors } from '../tests/lib.mjs';

const catalog = JSON.parse(readFileSync('public/products/products.json', 'utf8'));
const outDir = 'public/products/images';
mkdirSync(outDir, { recursive: true });

const env = await startEnv();
try {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
  const errors = watchErrors(page, 'viewer');
  await page.goto(`${env.url}demo/viewer.html?thumb&capture&view=product`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { timeout: 60000 });
  await page.addStyleTag({ content: 'html,body,.stage,canvas{background:transparent!important}.lab-panel,.bar,.status,#status{display:none!important}' });
  for (const p of catalog.products) {
    for (const v of p.variants) {
      await page.evaluate((id, vid) => window.__viewer.show(id, vid), p.id, v.id);
      await page.evaluate(() => {
        window.__viewer.setHead(false);
        window.__viewer.setView('product');
      });
      await new Promise((r) => setTimeout(r, 500));
      const file = join(outDir, `${p.id}-${v.id}.webp`);
      await page.screenshot({ path: file, type: 'webp', quality: 88, omitBackground: true, clip: { x: 55, y: 85, width: 800, height: 480 } });
      console.log(`${file} ${(statSync(file).size / 1024).toFixed(0)} KB`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await env.close();
}
