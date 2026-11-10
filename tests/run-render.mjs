// Phase 3 rendering tests (headless Chrome, software WebGL, no webcam needed):
//   1. Every GLB in public/models passes the Khronos glTF validator and follows the model spec.
//   2. Fit on a real face: the fitting lab with getUserMedia stubbed by a portrait photo.
//      Projected lens centres / nose rest are compared to the tracked pupils / nose bridge,
//      and a screenshot per product is written to test-output/tryon/.
//   3. Rendering actually draws glasses (pixel diff with the rig hidden vs shown).
//   4. Variant switching changes materials; switching products many times leaks no GPU resources.
//   5. Stop ends every camera track.
//
// Usage: node tests/run-render.mjs [--json]
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import validator from 'gltf-validator';
import { startEnv, stubCameraScript, watchErrors } from './lib.mjs';

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

// Fit tolerances, as % of the outer eye-corner span (~9 cm on an average adult → 1 % ≈ 0.9 mm).
const FIT = {
  noseRestErrPct: 3, // projected nose rest vs observed bridge landmarks
  lensBelowPupilPct: [-4, 12], // lens centre vs pupil, vertical (+ = lens centre lower)
  lensOutsidePupilPct: [-6, 14], // lens centre vs pupil, horizontal (+ = further from the nose)
};

// ---------- 1. Models
console.log('=== Models ===');
const models = readdirSync('public/models').filter((f) => f.endsWith('.glb'));
for (const f of models) {
  const bytes = new Uint8Array(readFileSync(join('public/models', f)));
  const report = await validator.validateBytes(bytes, { maxIssues: 20 });
  check(report.issues.numErrors === 0 && report.issues.numWarnings === 0, `${f}: glTF validator 0 errors / 0 warnings`);
}

const env = await startEnv();
const results = {};
try {
  // ---------- 2–5. Fitting lab with a stubbed camera
  console.log('\n=== Fitting lab with stubbed camera (portrait) ===');
  const page = await env.browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = watchErrors(page, 'tryon');
  await page.evaluateOnNewDocument(stubCameraScript());
  await page.goto(`${env.url}demo/tryon.html?delegate=CPU&capture`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { timeout: 60000 });
  await page.addStyleTag({ content: '.lab-panel,.bar,.status{display:none!important}' });
  await page.$eval('#start', (b) => b.click());
  await page.waitForFunction(() => window.__vto?.loop.solver.pose.valid && window.__vto.loop.trueSize.sampleCount > 15, { timeout: 60000 });

  const catalog = JSON.parse(readFileSync('public/products/products.json', 'utf8'));
  mkdirSync('test-output/tryon', { recursive: true });
  const memBaseline = await page.evaluate(() => ({ ...window.__vto.view.renderer.info.memory }));

  for (const p of catalog.products) {
    await page.evaluate((id) => window.__vto.show(id), p.id);
    await new Promise((r) => setTimeout(r, 1200));
    const fit = await page.evaluate(() => {
      const { rig, loop, view, model } = window.__vto;
      const pose = loop.solver.pose;
      const frame = loop.solver.camera;
      const W = frame.frameWidth, H = frame.frameHeight;
      const L = window.__lastFrame;
      const proj = (v) => {
        const uv = { x: 0, y: 0 };
        frame.project(v, uv);
        return [uv.x * W, uv.y * H];
      };
      const toCam = (p) => {
        const v = pose.anchorCamera.clone().set(p[0], p[1], p[2]);
        return v.applyMatrix4(rig.group.matrixWorld);
      };
      const lens = model.meta.lensCenters.map((c) => proj(toCam(c)));
      const rest = proj(toCam([0, 0, 0]));
      const lm = (i) => [L[i * 3] * W, L[i * 3 + 1] * H];
      const pupilL = lm(473), pupilR = lm(468); // 473 = subject's left iris
      const blend = rig.calibration.bridgeAlignment;
      const a = lm(168), b = lm(6);
      const bridge = [a[0] + (b[0] - a[0]) * blend, a[1] + (b[1] - a[1]) * blend];
      const span = Math.hypot(...[0, 1].map((k) => lm(263)[k] - lm(33)[k]));
      const pct = (v) => (100 * v) / span;
      // Unmirrored image: the subject's left eye is on the image's right (larger x).
      const outsideL = pct(lens[0][0] - pupilL[0]); // left lens: further from nose = larger x
      const outsideR = pct(pupilR[0] - lens[1][0]);
      // Pixel diff: rig hidden vs shown.
      const gl = view.canvas;
      const grab = () => {
        view.render();
        const c = document.createElement('canvas');
        c.width = gl.width;
        c.height = gl.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(gl, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const shown = grab();
      rig.group.visible = false;
      const hidden = grab();
      rig.group.visible = true;
      view.render();
      let changed = 0;
      for (let i = 0; i < shown.length; i += 4) {
        if (Math.abs(shown[i] - hidden[i]) + Math.abs(shown[i + 1] - hidden[i + 1]) + Math.abs(shown[i + 2] - hidden[i + 2]) > 24) changed++;
      }
      return {
        noseRestErrPct: pct(Math.hypot(rest[0] - bridge[0], rest[1] - bridge[1])),
        lensBelowPupilPct: [pct(lens[0][1] - pupilL[1]), pct(lens[1][1] - pupilR[1])],
        lensOutsidePupilPct: [outsideL, outsideR],
        glassesPixelsPct: (100 * changed) / (shown.length / 4),
        kEff: rig.kEff,
        temple: rig.templeFit.map((t) => ({ spread: t.spreadDeg, droop: t.droopDeg, clamped: t.clamped })),
        yaw: pose.yawDeg,
        pitch: pose.pitchDeg,
      };
    });
    results[p.id] = fit;
    await page.screenshot({ path: `test-output/tryon/${p.id}.png` });
    const f2 = (v) => v.toFixed(1);
    console.log(
      `  ${p.id}: nose-rest err ${f2(fit.noseRestErrPct)}%, lens below pupil L/R ${fit.lensBelowPupilPct.map(f2).join('/')}%, ` +
        `outside ${fit.lensOutsidePupilPct.map(f2).join('/')}%, glasses cover ${f2(fit.glassesPixelsPct)}% of view, kEff ${fit.kEff.toFixed(3)}, ` +
        `temples ${fit.temple.map((t) => `${f2(t.spread)}°/${f2(t.droop)}°${t.clamped ? '*' : ''}`).join(' ')}`,
    );
    check(fit.noseRestErrPct <= FIT.noseRestErrPct, `${p.id}: nose rest on the tracked bridge (${f2(fit.noseRestErrPct)}% ≤ ${FIT.noseRestErrPct}%)`);
    const inR = (v, [lo, hi]) => v >= lo && v <= hi;
    check(fit.lensBelowPupilPct.every((v) => inR(v, FIT.lensBelowPupilPct)), `${p.id}: lens height vs pupils within ${FIT.lensBelowPupilPct.join('…')}%`);
    check(fit.lensOutsidePupilPct.every((v) => inR(v, FIT.lensOutsidePupilPct)), `${p.id}: lens centration vs pupils within ${FIT.lensOutsidePupilPct.join('…')}%`);
    check(fit.glassesPixelsPct > 0.5, `${p.id}: glasses visibly rendered (${f2(fit.glassesPixelsPct)}% of pixels changed)`);
  }

  // Variants: materials change.
  const variantCheck = await page.evaluate(async () => {
    const { show } = window.__vto;
    await show('pilot', 'gold_g15');
    const a = window.__vto.model.meshesOfSlot('lens')[0].material.name;
    await show('pilot', 'gunmetal_mirror');
    const b = window.__vto.model.meshesOfSlot('lens')[0].material.name;
    const metal = window.__vto.model.meshesOfSlot('metal')[0].material.name;
    return { a, b, metal };
  });
  check(variantCheck.a === 'lens_g15' && variantCheck.b === 'lens_blue_mirror' && variantCheck.metal === 'metal_gunmetal', `variants switch materials (${variantCheck.a} → ${variantCheck.b}, ${variantCheck.metal})`);

  // Leak check: cycle every product 3× and return to the first.
  const ids = catalog.products.map((p) => p.id);
  for (let r = 0; r < 3; r++) for (const id of ids) await page.evaluate((x) => window.__vto.show(x), id);
  await page.evaluate((x) => window.__vto.show(x), ids[ids.length - 1]);
  await new Promise((r) => setTimeout(r, 500));
  // Baseline was taken with the first product loaded; compare with the same product loaded.
  await page.evaluate((x) => window.__vto.show(x), ids[0]);
  await new Promise((r) => setTimeout(r, 500));
  const memEnd = await page.evaluate(() => ({ ...window.__vto.view.renderer.info.memory }));
  console.log(`  GPU memory: start ${JSON.stringify(memBaseline)}, after ${3 * ids.length} switches ${JSON.stringify(memEnd)}`);
  check(memEnd.geometries <= memBaseline.geometries && memEnd.textures <= memBaseline.textures, 'no GPU geometry/texture leak after repeated product switches');

  await page.$eval('#stop', (b) => b.click());
  const ended = await page.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
  check(ended, 'all camera tracks ended after Stop');
  check(errors.length === 0, `no page errors (${errors.length})`);
  await page.close();
} finally {
  await env.close();
}

if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
