// Performance / memory checks (headless Chrome, stubbed camera, fitting lab, adaptive off):
//   - per-frame JS allocation attributed to OUR code (src/) via the sampling heap profiler —
//     the hot path must not allocate (GC pauses = visible stutter on phones);
//   - heap does not grow over a long run (after forced GC);
//   - timings per frame (inference, our CPU work) for the report.
// MediaPipe's and three.js' own allocations are reported but not asserted (not ours to change).
//
// Usage: node tests/run-perf.mjs [seconds=15]
import { startEnv, stubCameraScript, watchErrors } from './lib.mjs';

const seconds = Number(process.argv[2] ?? 15);
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = await startEnv();
try {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 1100, height: 760 });
  const errors = watchErrors(page, 'perf');
  await page.evaluateOnNewDocument(stubCameraScript({ drift: 30 }));
  await page.goto(`${env.url}demo/tryon.html?delegate=CPU&capture`);
  await page.waitForFunction(() => document.title.includes('(ready)'), { polling: 100, timeout: 90000 });
  await page.$eval('#start', (b) => b.click());
  await page.waitForFunction(() => window.__vto.engine.loop.solver.pose.valid, { polling: 100, timeout: 90000 });
  await sleep(3000); // warm-up: shader compiles, JIT, estimator convergence

  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  const frames = () => page.evaluate(() => window.__vto.engine.frameCount);

  // ---- 1. allocation sampling
  /** Profiles allocations during `run()`; returns bytes per group and per function in our code. */
  async function allocations(run) {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const n = await run();
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const byGroup = new Map();
    const byFn = new Map();
    const walk = (node) => {
      const url = node.callFrame.url || '';
      const group = /\/src\//.test(url) ? 'ours (src/)' : /three/.test(url) ? 'three.js' : /tasks-vision|mediapipe|wasm/.test(url) ? 'MediaPipe' : url ? 'other' : '(native/VM)';
      byGroup.set(group, (byGroup.get(group) ?? 0) + node.selfSize);
      if (group === 'ours (src/)' && node.selfSize) {
        const key = `${node.callFrame.functionName || '(anonymous)'} ${url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}`;
        byFn.set(key, (byFn.get(key) ?? 0) + node.selfSize);
      }
      for (const c of node.children) walk(c);
    };
    walk(profile.head);
    for (const [g, b] of [...byGroup].sort((x, y) => y[1] - x[1])) console.log(`  ${g.padEnd(14)} ${(b / n).toFixed(0).padStart(9)} B/frame`);
    const top = [...byFn].sort((x, y) => y[1] - x[1]).slice(0, 6);
    if (top.length) console.log('  largest sites in our code:');
    for (const [k, b] of top) console.log(`    ${(b / n).toFixed(0).padStart(7)} B/frame  ${k}`);
    return (byGroup.get('ours (src/)') ?? 0) / n;
  }

  // ---- 1a. live pipeline (informational: at headless frame rates V8 never optimises our
  //      functions, and unoptimised code boxes every intermediate double)
  console.log(`=== Allocations, live pipeline at headless speed (${seconds} s) ===`);
  const f0 = await frames();
  await allocations(async () => {
    await sleep(seconds * 1000);
    const n = (await frames()) - f0;
    console.log(`  ${n} frames (${(n / seconds).toFixed(1)} fps headless)`);
    return Math.max(1, n);
  });

  // ---- 1b. our per-frame code, hot (as at 30-60 fps on a device): pose solver, true size,
  //      live occluder, rig + temples, shadows, guidance — driven with the last real frame.
  console.log('\n=== Allocations, our per-frame code once optimised (asserted) ===');
  await page.evaluate(() => {
    const e = window.__vto.engine;
    e.pauseTracking();
    const L = e.loop;
    const f = e.tracker.frame;
    const anchor = e.anchor;
    window.__hot = (count) => {
      let t = f.timestampMs;
      const t0 = performance.now();
      for (let i = 0; i < count; i++) {
        t += 33.3;
        f.timestampMs = t;
        const pose = L.solver.update(f);
        L.trueSize.update(f, pose);
        e.occluder.update(f, pose, L.camera);
        e.rig.setHeadWidthScale(e.occluder.headWidthRatio);
        e.rig.update(pose, L.trueSize.factor);
        anchor.setFromMatrixPosition(e.rig.group.matrix);
        e.shadows.update(anchor, pose.valid);
        e.guidance.update(t, f, pose, e.view.visibleRect, 0.2);
      }
      return (performance.now() - t0) / count;
    };
    window.__hot(4000); // warm-up → optimised code
  });
  let msPerFrame = 0;
  const ours = await allocations(async () => {
    msPerFrame = await page.evaluate(() => window.__hot(4000));
    return 4000;
  });
  // What remains is V8 boxing doubles returned across non-inlined calls (~12 B each): at 30 fps
  // a few KB/s, vs ~200 KB per frame allocated inside MediaPipe's result objects.
  check(ours < 400, `our per-frame code allocates (almost) nothing (${ours.toFixed(0)} B/frame < 400; was ~1 KB before Phase 6)`);
  console.log(`  CPU time of that code: ${(msPerFrame * 1000).toFixed(0)} µs/frame`);
  await page.evaluate(() => window.__vto.engine.startTracking());

  // ---- 2. heap growth
  console.log('\n=== Heap over time ===');
  await cdp.send('HeapProfiler.collectGarbage');
  const h0 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  await sleep(seconds * 1000);
  await cdp.send('HeapProfiler.collectGarbage');
  const h1 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const growth = (h1 - h0) / 1024 / 1024;
  console.log(`  heap after GC: ${(h0 / 1048576).toFixed(1)} MB → ${(h1 / 1048576).toFixed(1)} MB`);
  check(growth < 2, `no heap growth over ${seconds} s (${growth >= 0 ? '+' : ''}${growth.toFixed(2)} MB)`);

  // ---- 3. timings
  console.log('\n=== Frame timings (headless CPU delegate + software WebGL — real devices are much faster) ===');
  const t = await page.evaluate(() => {
    const e = window.__vto.engine;
    return { inference: e.loop.stats.inferenceMs, work: e.frameMs, fps: e.renderFps };
  });
  console.log(`  inference ${t.inference.toFixed(1)} ms, rest of the frame (pose, rig, occluder, render submit) ${t.work.toFixed(1)} ms, ${t.fps.toFixed(1)} fps`);
  check(errors.length === 0, `no page errors (${errors.length})`);
} finally {
  await env.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
