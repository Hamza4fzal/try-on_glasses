// Automated tracking tests (headless Chrome, no webcam needed).
//   1. Benchmark: production tracker/solver on scripted synthetic motion — accuracy, lag, jitter.
//   2. Smoke: the real tracking-lab page with getUserMedia stubbed by a canvas stream —
//      start, detect, solve, then stop and verify every camera track is ended.
//
// Usage: node tests/run-tracking.mjs [--gpu] [--json]
// Env:   CHROME_PATH to override browser discovery.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const args = new Set(process.argv.slice(2));
const delegate = args.has('--gpu') ? 'GPU' : 'CPU';

const TARGETS = {
  staticJitterMeanPx: 0.3,
  staticScaleJitterPct: 0.15,
  staticRollJitterDeg: 0.05,
  staticErrP95PctEye: 1.5,
  driftErrP95PctEye: 3,
  motionErrP95PctEye: 6,
  rollErrMeanDeg: 1.5,
  scaleErrP95Pct: 4,
  reacquireMaxFrames: 3,
  maxValidFramesWhileHidden: 6, // holdMs 180 @ 30 fps
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found; set CHROME_PATH');
  return found;
}

const fmt = (s, d = 2) => (s && Number.isFinite(s.mean) ? `mean ${s.mean.toFixed(d)} p95 ${s.p95.toFixed(d)} max ${s.max.toFixed(d)}` : '—');

/** Grid search over filter parameters on the recorded sequence; prints the trade-off table. */
async function sweep(page) {
  const grid = [];
  for (const pb of [0.012, 0.03, 0.05, 0.08])
    for (const pd of [1, 2.5, 4])
      for (const pmin of [0.8, 1.5])
        grid.push({ positionFilter: { minCutoff: pmin, beta: pb, dCutoff: pd } });
  const rotGrid = [];
  for (const rb of [3.5, 6, 10, 15]) for (const rd of [1, 2.5, 4]) for (const rmin of [0.8, 1.4]) rotGrid.push({ minCutoff: rmin, beta: rb, dCutoff: rd });
  const depthGrid = [];
  for (const db of [2, 5, 10, 20]) for (const dd of [1, 2.5, 4]) for (const dmin of [0.5, 0.8]) depthGrid.push({ minCutoff: dmin, beta: db, dCutoff: dd });

  const row = (r, key) => {
    const s = (n) => r.segments.find((x) => x.segment.startsWith(n));
    return { key, ...pick(s) };
  };
  const pick = (s) => ({
    jit: s('noisy static').jitterPx.mean,
    rollJit: s('noisy static').rollJitterDeg.mean,
    scaleJit: s('noisy static').scaleJitterPct.mean,
    drift: s('noisy slow drift').poseAnchorErrPctEyeSpan.p95,
    pan: s('noisy pan').poseAnchorErrPctEyeSpan.p95,
    comb: s('combined').poseAnchorErrPctEyeSpan.p95,
    roll: s('roll').rollErrDeg.mean,
    scale: s('approach').scaleErrPct.p95,
  });
  const print = (title, rows, cols) => {
    console.log(`\n=== ${title} ===`);
    console.log(['config'.padEnd(34), ...cols.map((c) => c.padStart(8))].join(''));
    for (const r of rows) console.log([r.key.padEnd(34), ...cols.map((c) => r[c].toFixed(3).padStart(8))].join(''));
  };

  const posRows = [];
  for (const cfg of grid) {
    const r = await page.evaluate((c) => window.evaluateTracking(c), cfg);
    const p = cfg.positionFilter;
    posRows.push(row(r, `pos min${p.minCutoff} b${p.beta} d${p.dCutoff}`));
  }
  print('position filter', posRows, ['jit', 'drift', 'pan', 'comb']);

  const rotRows = [];
  for (const rc of rotGrid) {
    const r = await page.evaluate((c) => window.evaluateTracking({ rotationFilter: c }), rc);
    rotRows.push(row(r, `rot min${rc.minCutoff} b${rc.beta} d${rc.dCutoff}`));
  }
  print('rotation filter', rotRows, ['rollJit', 'roll']);

  const depthRows = [];
  for (const dc of depthGrid) {
    const r = await page.evaluate((c) => window.evaluateTracking({ depthFilter: c }), dc);
    depthRows.push(row(r, `depth min${dc.minCutoff} b${dc.beta} d${dc.dCutoff}`));
  }
  print('depth filter', depthRows, ['scaleJit', 'scale']);
}

async function main() {
  const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run'],
  });
  const failures = [];
  try {
    // ---------- 1. Benchmark ----------
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`${url}tests/harness.html`);
    await page.waitForFunction(() => document.title.includes('(ready)'), { timeout: 30000 });
    const t0 = Date.now();
    await page.evaluate((d) => window.recordTracking(d), delegate);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (args.has('--sweep')) {
      await sweep(page);
      return;
    }
    const r = await page.evaluate(() => window.evaluateTracking({}));

    if (args.has('--json')) console.log(JSON.stringify(r, null, 2));
    console.log(`\n=== Tracking benchmark (delegate ${r.delegate}, ${secs}s) ===`);
    console.log(`baseline eye span ${r.eyeSpanBaselinePx.toFixed(1)} px, static |yaw,pitch| ${fmt(r.yawPitchStatic)}°, roll0 ${r.roll0.toFixed(2)}°`);
    console.log(`inference ms ${fmt(r.inferenceMs, 1)}   true-size k ${r.trueSizeFactor.toFixed(3)}`);
    for (const s of r.segments) {
      console.log(`\n-- ${s.segment}  [frames ${s.frames}, detected ${s.detectedFrames}, valid ${s.validFrames}]`);
      console.log(`   raw anchor err px     ${fmt(s.rawAnchorErrPx)}`);
      console.log(`   pose anchor err px    ${fmt(s.poseAnchorErrPx)}`);
      console.log(`   pose anchor err %eye  ${fmt(s.poseAnchorErrPctEyeSpan)}`);
      console.log(`   roll err °            ${fmt(s.rollErrDeg)}`);
      console.log(`   scale err %           ${fmt(s.scaleErrPct)}`);
      console.log(`   residual %eye         ${fmt(s.residualPct)}   confidence ${fmt(s.confidence, 3)}`);
      if (s.jitterPx) {
        console.log(`   raw jitter px/frame   ${fmt(s.rawJitterPx, 3)}`);
        console.log(`   pose jitter px/frame  ${fmt(s.jitterPx, 3)}`);
        console.log(`   roll jitter °/frame   ${fmt(s.rollJitterDeg, 3)}   scale jitter %/frame ${fmt(s.scaleJitterPct, 3)}`);
      }
    }
    console.log(`\nhidden: ${r.validWhileHidden}/${r.hiddenFrames} frames still valid (hold); reacquired after ${r.reacquireFrames} frames`);

    const seg = (name) => r.segments.find((s) => s.segment.startsWith(name));
    const check = (ok, label) => {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failures.push(label);
    };
    console.log('\n=== Acceptance ===');
    const st = seg('static');
    check(st.poseAnchorErrPctEyeSpan.p95 <= TARGETS.staticErrP95PctEye, `static anchor err p95 ${st.poseAnchorErrPctEyeSpan.p95.toFixed(2)}% ≤ ${TARGETS.staticErrP95PctEye}%`);
    const ns = seg('noisy static');
    check(ns.jitterPx.mean <= TARGETS.staticJitterMeanPx, `noisy static: jitter mean ${ns.jitterPx.mean.toFixed(3)} px ≤ ${TARGETS.staticJitterMeanPx} (raw ${ns.rawJitterPx.mean.toFixed(3)})`);
    check(ns.scaleJitterPct.mean <= TARGETS.staticScaleJitterPct, `noisy static: scale jitter mean ${ns.scaleJitterPct.mean.toFixed(3)}% ≤ ${TARGETS.staticScaleJitterPct}%`);
    check(ns.rollJitterDeg.mean <= TARGETS.staticRollJitterDeg, `noisy static: roll jitter mean ${ns.rollJitterDeg.mean.toFixed(3)}° ≤ ${TARGETS.staticRollJitterDeg}°`);
    check(ns.poseAnchorErrPctEyeSpan.p95 <= TARGETS.staticErrP95PctEye, `noisy static: anchor err p95 ${ns.poseAnchorErrPctEyeSpan.p95.toFixed(2)}% ≤ ${TARGETS.staticErrP95PctEye}%`);
    const nd = seg('noisy slow drift');
    check(nd.poseAnchorErrPctEyeSpan.p95 <= TARGETS.driftErrP95PctEye, `noisy slow drift: anchor err p95 ${nd.poseAnchorErrPctEyeSpan.p95.toFixed(2)}% ≤ ${TARGETS.driftErrP95PctEye}%`);
    for (const name of ['pan', 'approach', 'roll', 'combined', 'noisy pan']) {
      const s = seg(name);
      check(s.poseAnchorErrPctEyeSpan.p95 <= TARGETS.motionErrP95PctEye, `${name}: anchor err p95 ${s.poseAnchorErrPctEyeSpan.p95.toFixed(2)}% ≤ ${TARGETS.motionErrP95PctEye}%`);
    }
    check(seg('roll').rollErrDeg.mean <= TARGETS.rollErrMeanDeg, `roll err mean ${seg('roll').rollErrDeg.mean.toFixed(2)}° ≤ ${TARGETS.rollErrMeanDeg}°`);
    check(seg('approach').scaleErrPct.p95 <= TARGETS.scaleErrP95Pct, `scale err p95 ${seg('approach').scaleErrPct.p95.toFixed(2)}% ≤ ${TARGETS.scaleErrP95Pct}%`);
    check(r.validWhileHidden <= TARGETS.maxValidFramesWhileHidden, `stale pose while hidden ${r.validWhileHidden} ≤ ${TARGETS.maxValidFramesWhileHidden} frames`);
    check(r.reacquireFrames >= 0 && r.reacquireFrames <= TARGETS.reacquireMaxFrames, `reacquire in ${r.reacquireFrames} ≤ ${TARGETS.reacquireMaxFrames} frames`);
    await page.close();

    // ---------- 2. Smoke test of the real page ----------
    console.log('\n=== Smoke: demo/tracking.html with stubbed camera ===');
    const p2 = await browser.newPage();
    p2.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await p2.evaluateOnNewDocument(() => {
      const streams = [];
      window.__streams = streams;
      navigator.mediaDevices.getUserMedia = async () => {
        const img = new Image();
        img.src = '/test-assets/portrait.jpg';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        const ctx = c.getContext('2d');
        let t = 0;
        const draw = () => {
          ctx.fillStyle = '#6b6259';
          ctx.fillRect(0, 0, 1280, 720);
          ctx.drawImage(img, 640 - 400 * 1.15 + 60 * Math.sin(t / 20), 360 - 200 * 1.15, 820 * 1.15, 1024 * 1.15);
          t++;
        };
        draw();
        setInterval(draw, 33);
        const s = c.captureStream(30);
        streams.push(s);
        return s;
      };
    });
    // Headless Chrome only has a software GPU, so force the CPU delegate for a meaningful fps check.
    await p2.goto(`${url}demo/tracking.html?delegate=CPU`);
    await p2.click('#start');
    await p2.waitForFunction(() => document.getElementById('hud')?.textContent?.includes('pose valid'), { timeout: 30000 });
    await new Promise((res) => setTimeout(res, 2500));
    const hud = await p2.$eval('#hud', (e) => e.textContent);
    console.log(hud.split('\n').map((l) => '   ' + l).join('\n'));
    const trackFps = Number(/track ([\d.]+)/.exec(hud)?.[1] ?? 0);
    check(/pose valid/.test(hud), 'page: pose valid with stubbed camera');
    // Liveness only: headless Chrome has no GPU, so this number says nothing about real-device perf.
    check(trackFps >= 3, `page: tracking loop running continuously (${trackFps} fps, headless software rendering)`);
    await p2.click('#stop');
    const ended = await p2.evaluate(() => window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')));
    check(ended, 'page: all camera tracks ended after Stop');
    await p2.close();
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
