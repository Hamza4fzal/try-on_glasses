/**
 * Adaptive quality: keeps the try-on at the camera's frame rate by trading render cost.
 *
 * The camera delivers frames at a fixed rate (usually 30 fps); every frame is tracked and
 * rendered. When a device can't keep up, the tracked rate drops below the camera's and the
 * overlay starts to lag the face — far worse than slightly simpler rendering. So:
 *
 *   - measured over 2 s windows: tracked fps vs target (camera fps, capped at 30);
 *   - one window clearly below target (< 80 %) → step down one level (after a 1-window settle);
 *   - five consecutive windows at target (≥ 93 %) → try one level up; if that fails within two
 *     windows, step back and don't try that level again this session (no oscillation).
 *
 * Levels go from best to cheapest. Each step removes a cost that scales with pixels or passes,
 * while tracking accuracy and fit are never touched:
 *   render resolution → transmission buffer resolution → soft occlusion + contact shadows
 *   (two extra passes) → 1× resolution.
 *
 * Pure logic (no DOM / three.js), so it is unit-tested in isolation.
 */

export interface QualityLevel {
  /** Device-pixel ratio of the WebGL canvas. */
  pixelRatio: number;
  /** Resolution scale of three.js' transmission (lens refraction) buffer. */
  transmissionScale: number;
  occlusion: 'soft' | 'hard';
  shadows: boolean;
}

export interface GovernorOptions {
  windowMs?: number;
  /** Fraction of target below which a window counts as slow. */
  slow?: number;
  /** Fraction of target at or above which a window counts as good. */
  good?: number;
  /** Good windows in a row before trying a better level. */
  upAfter?: number;
}

/** Quality ladder for a device. `high`: start at the top; otherwise start at the cheap end. */
export function qualityLevels(devicePixelRatio: number, maxPixelRatio = 2): QualityLevel[] {
  const dpr = Math.max(1, Math.min(devicePixelRatio || 1, maxPixelRatio));
  const candidates: QualityLevel[] = [
    { pixelRatio: dpr, transmissionScale: 1, occlusion: 'soft', shadows: true },
    { pixelRatio: Math.min(dpr, 1.5), transmissionScale: 0.5, occlusion: 'soft', shadows: true },
    { pixelRatio: Math.min(dpr, 1.5), transmissionScale: 0.5, occlusion: 'hard', shadows: false },
    { pixelRatio: 1, transmissionScale: 0.5, occlusion: 'hard', shadows: false },
  ];
  // Drop levels identical to the previous one (e.g. 1× displays).
  return candidates.filter((l, i) => {
    const p = candidates[i - 1];
    return !p || p.pixelRatio !== l.pixelRatio || p.transmissionScale !== l.transmissionScale || p.occlusion !== l.occlusion || p.shadows !== l.shadows;
  });
}

export class PerformanceGovernor {
  /** Index into `levels` (0 = best). */
  level: number;
  /** Best level we may still try (raised when an upgrade failed). */
  private ceiling = 0;
  private targetFps = 30;
  private windowStart = -1;
  private frames = 0;
  private settle = 0;
  private goodRun = 0;
  private probing = -1; // level we came from while trying a better one; -1 = not probing
  private probeWindows = 0;
  private readonly o: Required<GovernorOptions>;
  /** Last measured window fps (diagnostics). */
  fps = 0;

  readonly levels: QualityLevel[];

  // (No parameter properties: this file also runs under Node's type stripping in unit tests.)
  constructor(levels: QualityLevel[], startLevel = 0, opts: GovernorOptions = {}) {
    this.levels = levels;
    this.o = { windowMs: 2000, slow: 0.8, good: 0.93, upAfter: 5, ...opts };
    this.level = Math.max(0, Math.min(levels.length - 1, startLevel));
  }

  get current(): QualityLevel {
    return this.levels[this.level];
  }

  /** Camera frame rate (frames can't be tracked faster). Capped at 30: enough for a mirror. */
  setCameraFps(fps: number | undefined): void {
    this.targetFps = Math.min(30, fps && fps > 1 ? fps : 30);
  }

  /** Restart measuring (camera (re)started, tab shown again, …). */
  reset(): void {
    this.windowStart = -1;
    this.frames = 0;
    this.goodRun = 0;
    this.settle = 1;
    this.probing = -1;
  }

  /**
   * Call once per tracked+rendered frame. Returns the new level when it changed, else null.
   */
  frame(nowMs: number): QualityLevel | null {
    if (this.windowStart < 0) {
      this.windowStart = nowMs;
      this.frames = 0;
      return null;
    }
    this.frames++;
    const elapsed = nowMs - this.windowStart;
    if (elapsed < this.o.windowMs) return null;
    // A long gap (tab hidden, camera paused) isn't a performance signal.
    if (elapsed > this.o.windowMs * 3) {
      this.reset();
      this.windowStart = nowMs;
      return null;
    }
    const fps = (this.frames * 1000) / elapsed;
    this.fps = fps;
    this.windowStart = nowMs;
    this.frames = 0;
    return this.judge(fps);
  }

  private judge(fps: number): QualityLevel | null {
    if (this.settle > 0) {
      this.settle--; // first window after a change: shader compiles, buffer reallocation
      return null;
    }
    const slow = fps < this.targetFps * this.o.slow;
    const good = fps >= this.targetFps * this.o.good;

    if (this.probing >= 0) {
      this.probeWindows++;
      if (slow) {
        // The better level doesn't hold: go back and never try it again this session.
        const back = this.probing;
        this.ceiling = this.level + 1;
        this.probing = -1;
        return this.set(back);
      }
      if (this.probeWindows >= 2) this.probing = -1; // upgrade confirmed
    }

    if (slow) {
      this.goodRun = 0;
      return this.level < this.levels.length - 1 ? this.set(this.level + 1) : null;
    }
    if (good) {
      this.goodRun++;
      if (this.goodRun >= this.o.upAfter && this.level > this.ceiling) {
        const from = this.level;
        const changed = this.set(this.level - 1);
        this.probing = from;
        this.probeWindows = 0;
        return changed;
      }
    } else {
      this.goodRun = 0;
    }
    return null;
  }

  private set(level: number): QualityLevel {
    this.level = level;
    this.goodRun = 0;
    this.settle = 1;
    return this.current;
  }
}
