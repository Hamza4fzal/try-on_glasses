import { Vector3 } from 'three';
import type { CameraModel } from './camera-model';
import type { TrackerFrame } from './face-tracker';
import { IRIS_DIAMETER_MM, LM } from './landmarks';
import { canonical, type FacePose } from './pose-solver';

/**
 * Estimates the wearer's real face size relative to MediaPipe's canonical face.
 *
 * Monocular tracking is scale-ambiguous: MediaPipe fits every face to the same canonical size.
 * The human iris is a near-constant ~11.7 mm (SD ≈ 0.4–0.5 mm) across adults, so its pixel size
 * relative to the face gives a physical ruler:
 *
 *   k = realFaceSize / canonicalFaceSize = 11.7 mm / (iris diameter measured in canonical units)
 *
 * Glasses authored at true physical size are then scaled by 1/k in canonical space, so a 140 mm
 * frame looks correctly narrow on a wide face and wide on a narrow face.
 *
 * Robustness: samples are taken only near-frontal (iris foreshortening and eyelid occlusion grow
 * with yaw/pitch) and with enough iris pixels; the estimate is a running median, clamped, and eased.
 */
export interface TrueSizeConfig {
  maxYawDeg: number;
  maxPitchDeg: number;
  minIrisPx: number;
  windowSize: number;
  minSamples: number;
  minFactor: number;
  maxFactor: number;
  /** Easing time constant for the published factor (s). */
  easeSeconds: number;
}

export const DEFAULT_TRUE_SIZE_CONFIG: TrueSizeConfig = {
  maxYawDeg: 15,
  maxPitchDeg: 15,
  minIrisPx: 9,
  windowSize: 90,
  minSamples: 15,
  minFactor: 0.85,
  maxFactor: 1.15,
  easeSeconds: 0.6,
};

export class TrueSizeEstimator {
  readonly config: TrueSizeConfig;
  /** Published, eased factor k (1 until enough samples). */
  factor = 1;
  /** Latest raw median estimate (diagnostics). */
  rawEstimate = 1;
  sampleCount = 0;
  lastIrisPx = 0;

  private readonly samples: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private lastTs = 0;

  private readonly pupilCanonR = new Vector3();
  private readonly pupilCanonL = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly uvA = { x: 0, y: 0 };
  private readonly uvB = { x: 0, y: 0 };
  private readonly tmp = new Vector3();

  constructor(
    private readonly camera: CameraModel,
    config: Partial<TrueSizeConfig> = {},
  ) {
    this.config = { ...DEFAULT_TRUE_SIZE_CONFIG, ...config };
    this.samples = new Float64Array(this.config.windowSize);
    this.sorted = new Float64Array(this.config.windowSize);
    // Approximate pupil centres in canonical space: centre of each eye's corner/lid points.
    eyeCentre(LM.rightEyeOuter, LM.rightEyeInner, LM.rightEyeUpper, LM.rightEyeLower, this.pupilCanonR, this.tmp);
    eyeCentre(LM.leftEyeOuter, LM.leftEyeInner, LM.leftEyeUpper, LM.leftEyeLower, this.pupilCanonL, this.tmp);
  }

  reset(): void {
    this.sampleCount = 0;
    this.head = 0;
    this.factor = 1;
    this.rawEstimate = 1;
  }

  update(frame: TrackerFrame, pose: FacePose): number {
    const dt = this.lastTs ? Math.min(0.25, Math.max(0, (frame.timestampMs - this.lastTs) / 1000)) : 0;
    this.lastTs = frame.timestampMs;
    if (!pose.valid || frame.landmarkCount < 478) return this.ease(dt);
    const c = this.config;
    if (Math.abs(pose.yawDeg) > c.maxYawDeg || Math.abs(pose.pitchDeg) > c.maxPitchDeg) return this.ease(dt);

    const W = frame.frameWidth;
    const H = frame.frameHeight;
    const irisR = irisDiameterPx(frame.landmarks, LM.rightIrisRing, W, H);
    const irisL = irisDiameterPx(frame.landmarks, LM.leftIrisRing, W, H);
    const irisPx = (irisR + irisL) / 2;
    this.lastIrisPx = irisPx;
    if (irisPx < c.minIrisPx) return this.ease(dt);
    // Reject frames where the eyes disagree a lot (blink, glare, partial occlusion).
    if (Math.abs(irisR - irisL) / irisPx > 0.2) return this.ease(dt);

    // Pixels per canonical cm at each pupil, measured along the face's own X axis.
    const ppcR = this.pxPerCanonicalCm(pose, this.pupilCanonR);
    const ppcL = this.pxPerCanonicalCm(pose, this.pupilCanonL);
    if (!(ppcR > 0 && ppcL > 0)) return this.ease(dt);
    const irisCanonCm = (irisR / ppcR + irisL / ppcL) / 2;
    const k = IRIS_DIAMETER_MM / 10 / irisCanonCm;
    if (!(k > 0.5 && k < 2)) return this.ease(dt);

    this.samples[this.head] = k;
    this.head = (this.head + 1) % c.windowSize;
    this.sampleCount = Math.min(this.sampleCount + 1, c.windowSize);
    this.rawEstimate = this.median();
    return this.ease(dt);
  }

  private ease(dt: number): number {
    const c = this.config;
    const target = this.sampleCount >= c.minSamples ? clamp(this.rawEstimate, c.minFactor, c.maxFactor) : 1;
    if (dt > 0) this.factor += (target - this.factor) * (1 - Math.exp(-dt / c.easeSeconds));
    return this.factor;
  }

  private pxPerCanonicalCm(pose: FacePose, p: Vector3): number {
    const cam = this.camera;
    this.a.copy(p).applyMatrix4(pose.faceMatrix);
    this.b.copy(p).setX(p.x + 1).applyMatrix4(pose.faceMatrix);
    if (!cam.project(this.a, this.uvA) || !cam.project(this.b, this.uvB)) return 0;
    return Math.hypot((this.uvB.x - this.uvA.x) * cam.frameWidth, (this.uvB.y - this.uvA.y) * cam.frameHeight);
  }

  private median(): number {
    const n = this.sampleCount;
    for (let i = 0; i < n; i++) this.sorted[i] = this.samples[i];
    const view = this.sorted.subarray(0, n);
    view.sort();
    return n % 2 ? view[(n - 1) >> 1] : (view[n / 2 - 1] + view[n / 2]) / 2;
  }
}

/** Mean of the two ring diameters (horizontal pair 0–2, vertical pair 1–3), in pixels. */
function irisDiameterPx(L: Float32Array, ring: readonly number[], W: number, H: number): number {
  const d = (i: number, j: number) =>
    Math.hypot((L[ring[i] * 3] - L[ring[j] * 3]) * W, (L[ring[i] * 3 + 1] - L[ring[j] * 3 + 1]) * H);
  return (d(0, 2) + d(1, 3)) / 2;
}

function eyeCentre(a: number, b: number, c: number, d: number, out: Vector3, tmp: Vector3): Vector3 {
  out.set(0, 0, 0);
  for (const i of [a, b, c, d]) out.add(canonical(i, tmp));
  return out.multiplyScalar(0.25);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
