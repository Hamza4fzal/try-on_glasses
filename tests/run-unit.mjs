// Unit tests for pure logic (no browser): the adaptive-quality governor.
// Node runs the TypeScript source directly (type stripping).
//
// Usage: node tests/run-unit.mjs
import { PerformanceGovernor, qualityLevels } from '../src/app/perf-governor.ts';

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

/** Feeds `seconds` of frames at `fps`; returns the level after each 2-s window. */
function run(g, t0, seconds, fps) {
  const levels = [];
  let t = t0;
  const dt = 1000 / fps;
  const end = t0 + seconds * 1000;
  let lastWindow = t0;
  while (t < end) {
    t += dt;
    g.frame(t);
    if (t - lastWindow >= 2000) {
      levels.push(g.level);
      lastWindow = t;
    }
  }
  return { t, levels };
}

console.log('=== Quality ladder ===');
{
  const l3 = qualityLevels(3);
  check(l3.length === 4 && l3[0].pixelRatio === 2 && l3[0].occlusion === 'soft' && l3[0].shadows, 'DPR 3 phone: 4 levels, best = 2× + soft occlusion + shadows');
  check(l3.at(-1).pixelRatio === 1 && l3.at(-1).occlusion === 'hard' && !l3.at(-1).shadows, 'cheapest = 1×, hard occlusion, no shadows');
  const l1 = qualityLevels(1);
  check(l1.length === 3 && l1.every((l) => l.pixelRatio === 1), `1× display: duplicate levels removed (${l1.length})`);
  const costs = l3.map((l) => l.pixelRatio ** 2 * (l.occlusion === 'soft' ? 1.5 : 1) * (l.shadows ? 1.2 : 1));
  check(costs.every((c, i) => i === 0 || c <= costs[i - 1]), 'levels are ordered by cost');
}

console.log('\n=== Governor ===');
{
  const g = new PerformanceGovernor(qualityLevels(3), 0);
  g.setCameraFps(30);
  const r = run(g, 0, 20, 30);
  check(r.levels.every((l) => l === 0), 'steady 30 fps: stays at the best level');
}
{
  const g = new PerformanceGovernor(qualityLevels(3), 0);
  g.setCameraFps(30);
  const r = run(g, 0, 30, 14);
  check(g.level === 3, `14 fps: steps down to the cheapest level (${r.levels.join('')})`);
  // Steps are spaced: never two changes in consecutive windows.
  let ok = true;
  for (let i = 2; i < r.levels.length; i++) if (r.levels[i] !== r.levels[i - 1] && r.levels[i - 1] !== r.levels[i - 2]) ok = false;
  check(ok, 'a settle window follows every change');
}
{
  // Slow at first (e.g. another tab busy), then fast: climbs back to the top.
  const g = new PerformanceGovernor(qualityLevels(3), 0);
  g.setCameraFps(30);
  const a = run(g, 0, 10, 15);
  const down = g.level;
  const b = run(g, a.t, 90, 30);
  check(down > 0 && g.level === 0, `recovers when the device has headroom again (down to ${down}, back to ${g.level})`);
  void b;
}
{
  // Level 1 sustainable at 30, level 0 only 20 fps: probe fails once, then never retried.
  const g = new PerformanceGovernor(qualityLevels(3), 1);
  g.setCameraFps(30);
  let t = 0;
  const seen = [];
  for (let s = 0; s < 120; s++) {
    const fps = g.level === 0 ? 20 : 30;
    for (let i = 0; i < fps; i++) {
      t += 1000 / fps;
      g.frame(t);
    }
    seen.push(g.level);
  }
  const upgrades = seen.filter((l, i) => i > 0 && l < seen[i - 1]).length;
  check(upgrades === 1 && g.level === 1, `failed upgrade is not retried (upgrades: ${upgrades}, final level ${g.level})`);
}
{
  // A 24 fps camera: 24 fps is "full speed", no downgrade.
  const g = new PerformanceGovernor(qualityLevels(2), 0);
  g.setCameraFps(24);
  run(g, 0, 20, 24);
  check(g.level === 0, '24 fps camera delivering 24 fps: no downgrade');
}
{
  // Long gap (tab hidden) is ignored.
  const g = new PerformanceGovernor(qualityLevels(2), 0);
  g.setCameraFps(30);
  const a = run(g, 0, 6, 30);
  g.frame(a.t + 30000);
  run(g, a.t + 30000, 6, 30);
  check(g.level === 0, 'a long pause is not mistaken for slowness');
}
{
  // 60 fps camera: target is capped at 30.
  const g = new PerformanceGovernor(qualityLevels(2), 0);
  g.setCameraFps(60);
  run(g, 0, 20, 31);
  check(g.level === 0, '60 fps camera tracked at 31 fps: no downgrade (target capped at 30)');
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
