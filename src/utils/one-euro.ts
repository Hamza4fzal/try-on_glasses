/**
 * One-Euro filter (Casiez, Roussel, Vogel — CHI 2012).
 *
 * A speed-adaptive low-pass filter: heavy smoothing when the signal is slow
 * (kills jitter while the head is still), light smoothing when it moves fast
 * (kills lag during head turns). This is the standard choice for AR anchors.
 *
 *   minCutoff  — cutoff (Hz) at zero speed. Lower = smoother at rest, more lag.
 *   beta       — speed coefficient. Higher = less lag during fast motion.
 *   dCutoff    — cutoff (Hz) for the derivative estimate.
 *
 * Allocation-free: safe to call every frame.
 */
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

const TWO_PI = Math.PI * 2;

export function smoothingAlpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private initialized = false;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.initialized = false;
    this.dx = 0;
  }

  get value(): number {
    return this.x;
  }

  /** @param dt seconds since the previous sample (must be > 0) */
  filter(value: number, dt: number): number {
    if (!this.initialized || !(dt > 0)) {
      this.x = value;
      this.dx = 0;
      this.initialized = true;
      return value;
    }
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingAlpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += smoothingAlpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Fixed-dimension vector variant: speed is the vector magnitude, so all axes share one cutoff. */
export class OneEuroVectorFilter {
  readonly value: Float64Array;
  private readonly dx: Float64Array;
  private initialized = false;

  constructor(
    readonly dim: number,
    public params: OneEuroParams,
  ) {
    this.value = new Float64Array(dim);
    this.dx = new Float64Array(dim);
  }

  reset(): void {
    this.initialized = false;
    this.dx.fill(0);
  }

  filter(input: ArrayLike<number>, dt: number): Float64Array {
    const n = this.dim;
    if (!this.initialized || !(dt > 0)) {
      for (let i = 0; i < n; i++) this.value[i] = input[i];
      this.dx.fill(0);
      this.initialized = true;
      return this.value;
    }
    const { minCutoff, beta, dCutoff } = this.params;
    const aD = smoothingAlpha(dCutoff, dt);
    let speedSq = 0;
    for (let i = 0; i < n; i++) {
      const raw = (input[i] - this.value[i]) / dt;
      this.dx[i] += aD * (raw - this.dx[i]);
      speedSq += this.dx[i] * this.dx[i];
    }
    const a = smoothingAlpha(minCutoff + beta * Math.sqrt(speedSq), dt);
    for (let i = 0; i < n; i++) this.value[i] += a * (input[i] - this.value[i]);
    return this.value;
  }
}
