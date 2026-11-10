import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { OneEuroFilter, OneEuroVectorFilter, smoothingAlpha, type OneEuroParams } from '../utils/one-euro';
import { CANONICAL_POSITIONS } from './canonical-face-data';
import { CameraModel } from './camera-model';
import type { TrackerFrame } from './face-tracker';
import { LM } from './landmarks';

/**
 * PoseSolver — turns raw Face Landmarker output into a stable, landmark-locked face pose.
 *
 * Output is the FACE MATRIX F: canonical face space (cm, MediaPipe canonical model) → camera space
 * (cm, MediaPipe's 63° virtual camera, unmirrored). Anything authored in canonical face space
 * (glasses anchor, occlusion mesh) is placed with F.
 *
 * Pipeline per frame:
 *  1. Rotation R and scale σ from MediaPipe's facial transformation matrix M.
 *  2. Position: the canonical anchor (nose bridge) is pinned onto the ray through the OBSERVED
 *     bridge landmarks, so the bridge can never visibly slide off the nose, even when M's
 *     translation (fitted to the whole face, incl. jaw/mouth) drifts.
 *  3. Depth: chosen so the rotated canonical eye region projects with the same spread as the
 *     observed eye-region landmarks (rotation-aware → correct at any yaw/pitch).
 *  4. Smoothing: One-Euro on image position, log-depth, and adaptive quaternion slerp.
 */

export interface PoseSolverConfig {
  /** Anchor = lerp(canonical[noseBridgeTop], canonical[noseBridgeMid], anchorBlend). */
  anchorBlend: number;
  /** Image-space anchor filter; units: thousandths of frame height. */
  positionFilter: OneEuroParams;
  /** Log-depth filter (unitless; speed ≈ relative depth change per second). */
  depthFilter: OneEuroParams;
  /** Rotation: cutoff = minCutoff + beta · angularSpeed(rad/s). */
  rotationFilter: OneEuroParams;
  /** Model scale σ from M (≈1); very slow. */
  scaleFilter: OneEuroParams;
  /** Keep the last pose this long after the face is lost before reporting invalid (ms). */
  holdMs: number;
}

/**
 * Filter defaults were chosen by grid search (tests/run-tracking.mjs --sweep) on recorded tracker
 * output with injected webcam-like noise, picking the point that meets every jitter AND lag target
 * with margin. Re-validate on real cameras before changing.
 */
export const DEFAULT_POSE_SOLVER_CONFIG: PoseSolverConfig = {
  anchorBlend: 0.5,
  positionFilter: { minCutoff: 0.8, beta: 0.05, dCutoff: 4.0 },
  depthFilter: { minCutoff: 0.5, beta: 10, dCutoff: 2.5 },
  rotationFilter: { minCutoff: 0.8, beta: 6, dCutoff: 2.5 },
  scaleFilter: { minCutoff: 0.3, beta: 0, dCutoff: 1.0 },
  holdMs: 180,
};

export interface FacePose {
  valid: boolean;
  /** True on the first valid frame after (re)acquisition — consumers may snap instead of animate. */
  reacquired: boolean;
  timestampMs: number;
  /** Canonical face space (cm) → camera space (cm). Smoothed. */
  readonly faceMatrix: Matrix4;
  /** The canonical-space anchor point (cm). */
  readonly anchorCanonical: Vector3;
  /** Anchor in camera space (cm). Smoothed. */
  readonly anchorCamera: Vector3;
  readonly rotation: Quaternion;
  /** Head angles in degrees (yaw: + = subject turns to their left; pitch: + = looks up; roll). */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Uniform scale of M (≈1). */
  modelScale: number;
  /** Observed/predicted eye-region spread before depth correction (≈1 when M is consistent). */
  alignRatio: number;
  /** RMS reprojection error of the eye region after correction, as a fraction of eye span. */
  fitResidual: number;
  /** 0..1 heuristic tracking confidence derived from fitResidual and landmark plausibility. */
  confidence: number;
  /** Eye-region span in pixels (useful to reason about distance/resolution). */
  eyeSpanPx: number;
}

/** Eye-region points used for depth/scale estimation and fit-quality measurement. */
const EYE_REGION = [
  LM.rightEyeOuter,
  LM.rightEyeInner,
  LM.rightEyeUpper,
  LM.rightEyeLower,
  LM.leftEyeInner,
  LM.leftEyeOuter,
  LM.leftEyeUpper,
  LM.leftEyeLower,
  LM.noseBridgeTop,
  LM.noseBridgeMid,
  197,
] as const;

const N_EYE = EYE_REGION.length;

export class PoseSolver {
  readonly config: PoseSolverConfig;
  readonly pose: FacePose;

  private readonly posFilter: OneEuroVectorFilter;
  private readonly depthFilter: OneEuroFilter;
  private readonly scaleFilter: OneEuroFilter;
  private readonly qFiltered = new Quaternion();
  private angularSpeed = 0;
  private hasState = false;
  private lastTimestamp = 0;
  private lastSeenTimestamp = -Infinity;

  // Scratch (no per-frame allocation)
  private readonly M = new Matrix4();
  private readonly tM = new Vector3();
  private readonly qM = new Quaternion();
  private readonly sM = new Vector3();
  private readonly tmpV = new Vector3();
  private readonly tmpV2 = new Vector3();
  private readonly tmpUV = { x: 0, y: 0 };
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly predPx = new Float64Array(N_EYE * 2);
  private readonly obsPx = new Float64Array(N_EYE * 2);
  private readonly uvIn = new Float64Array(2);
  private readonly scaleMat = new Matrix4();
  private readonly negAnchor = new Matrix4();

  constructor(
    readonly camera: CameraModel,
    config: Partial<PoseSolverConfig> = {},
  ) {
    this.config = { ...DEFAULT_POSE_SOLVER_CONFIG, ...config };
    this.posFilter = new OneEuroVectorFilter(2, this.config.positionFilter);
    this.depthFilter = new OneEuroFilter(this.config.depthFilter);
    this.scaleFilter = new OneEuroFilter(this.config.scaleFilter);
    this.pose = {
      valid: false,
      reacquired: false,
      timestampMs: 0,
      faceMatrix: new Matrix4(),
      anchorCanonical: new Vector3(),
      anchorCamera: new Vector3(),
      rotation: new Quaternion(),
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      modelScale: 1,
      alignRatio: 1,
      fitResidual: 0,
      confidence: 0,
      eyeSpanPx: 0,
    };
    this.setAnchorBlend(this.config.anchorBlend);
  }

  setAnchorBlend(t: number): void {
    this.config.anchorBlend = t;
    const a = canonical(LM.noseBridgeTop, this.tmpV);
    const b = canonical(LM.noseBridgeMid, this.tmpV2);
    this.pose.anchorCanonical.copy(a).lerp(b, t);
    this.negAnchor.makeTranslation(-this.pose.anchorCanonical.x, -this.pose.anchorCanonical.y, -this.pose.anchorCanonical.z);
  }

  reset(): void {
    this.hasState = false;
    this.posFilter.reset();
    this.depthFilter.reset();
    this.scaleFilter.reset();
    this.angularSpeed = 0;
    this.pose.valid = false;
  }

  update(frame: TrackerFrame): FacePose {
    const pose = this.pose;
    pose.reacquired = false;

    if (!frame.hasFace || !frame.hasMatrix) {
      if (frame.timestampMs - this.lastSeenTimestamp > this.config.holdMs) {
        pose.valid = false;
        this.hasState = false;
      }
      return pose;
    }

    const cam = this.camera;
    cam.setFrameSize(frame.frameWidth, frame.frameHeight);
    const W = frame.frameWidth;
    const H = frame.frameHeight;
    const L = frame.landmarks;

    // ---- 1. Decompose MediaPipe's transform ----
    this.M.fromArray(frame.matrix);
    this.M.decompose(this.tM, this.qM, this.sM);
    const sRaw = (this.sM.x + this.sM.y + this.sM.z) / 3;

    // ---- 2. Observed anchor in normalized image coords ----
    const t = this.config.anchorBlend;
    const ia = LM.noseBridgeTop * 3;
    const ib = LM.noseBridgeMid * 3;
    const u = L[ia] + (L[ib] - L[ia]) * t;
    const v = L[ia + 1] + (L[ib + 1] - L[ia + 1]) * t;

    // ---- 3. Depth from eye-region spread (predicted under M vs observed) ----
    let cxP = 0, cyP = 0, cxO = 0, cyO = 0;
    let projectedOk = true;
    for (let k = 0; k < N_EYE; k++) {
      const idx = EYE_REGION[k];
      canonical(idx, this.tmpV).applyMatrix4(this.M);
      if (!cam.project(this.tmpV, this.tmpUV)) projectedOk = false;
      const px = this.tmpUV.x * W, py = this.tmpUV.y * H;
      const ox = L[idx * 3] * W, oy = L[idx * 3 + 1] * H;
      this.predPx[k * 2] = px; this.predPx[k * 2 + 1] = py;
      this.obsPx[k * 2] = ox; this.obsPx[k * 2 + 1] = oy;
      cxP += px; cyP += py; cxO += ox; cyO += oy;
    }
    if (!projectedOk) return pose;
    cxP /= N_EYE; cyP /= N_EYE; cxO /= N_EYE; cyO /= N_EYE;
    let spreadP = 0, spreadO = 0;
    for (let k = 0; k < N_EYE; k++) {
      spreadP += Math.hypot(this.predPx[k * 2] - cxP, this.predPx[k * 2 + 1] - cyP);
      spreadO += Math.hypot(this.obsPx[k * 2] - cxO, this.obsPx[k * 2 + 1] - cyO);
    }
    if (spreadP < 1e-3 || spreadO < 1e-3) return pose;
    const r = spreadO / spreadP;
    if (!(r > 0.5 && r < 2)) return pose; // implausible → treat as a tracking glitch

    // Canonical anchor under M → its depth, then correct by r (closer if the face looks bigger).
    this.tmpV.copy(pose.anchorCanonical).applyMatrix4(this.M);
    const depthRaw = -this.tmpV.z / r;
    if (!(depthRaw > 1)) return pose;

    // ---- 4. Temporal filtering ----
    const dt = this.hasState ? Math.max(1e-3, (frame.timestampMs - this.lastTimestamp) / 1000) : 0;
    if (!this.hasState) {
      this.posFilter.reset();
      this.depthFilter.reset();
      this.scaleFilter.reset();
      this.qFiltered.copy(this.qM);
      this.angularSpeed = 0;
      pose.reacquired = true;
    }

    // Position in "milli-heights" so filter params are resolution-independent.
    this.uvIn[0] = u * W * (1000 / H);
    this.uvIn[1] = v * 1000;
    const fuv = this.posFilter.filter(this.uvIn, dt);
    const uF = (fuv[0] * H) / (1000 * W);
    const vF = fuv[1] / 1000;
    const depthF = Math.exp(this.depthFilter.filter(Math.log(depthRaw), dt));
    const sF = this.scaleFilter.filter(sRaw, dt);

    if (dt > 0) {
      const angle = this.qFiltered.angleTo(this.qM);
      const rp = this.config.rotationFilter;
      this.angularSpeed += smoothingAlpha(rp.dCutoff, dt) * (angle / dt - this.angularSpeed);
      const a = smoothingAlpha(rp.minCutoff + rp.beta * Math.abs(this.angularSpeed), dt);
      this.qFiltered.slerp(this.qM, a);
    }

    // ---- 5. Compose F = T(anchorCam) · R · S(σ) · T(−anchorCanonical) ----
    cam.unproject(uF, vF, -depthF, pose.anchorCamera);
    pose.rotation.copy(this.qFiltered);
    this.scaleMat.makeScale(sF, sF, sF);
    pose.faceMatrix
      .makeRotationFromQuaternion(pose.rotation)
      .multiply(this.scaleMat)
      .setPosition(pose.anchorCamera)
      .multiply(this.negAnchor);

    // ---- 6. Diagnostics: residual of the SMOOTHED pose vs. this frame's observations ----
    // This is the misalignment a viewer would actually see (fit error + smoothing lag).
    let errSq = 0;
    for (let k = 0; k < N_EYE; k++) {
      canonical(EYE_REGION[k], this.tmpV).applyMatrix4(pose.faceMatrix);
      cam.project(this.tmpV, this.tmpUV);
      const dx = this.tmpUV.x * W - this.obsPx[k * 2];
      const dy = this.tmpUV.y * H - this.obsPx[k * 2 + 1];
      errSq += dx * dx + dy * dy;
    }
    const eyeSpan = Math.hypot(
      (L[LM.leftEyeOuter * 3] - L[LM.rightEyeOuter * 3]) * W,
      (L[LM.leftEyeOuter * 3 + 1] - L[LM.rightEyeOuter * 3 + 1]) * H,
    );
    pose.eyeSpanPx = eyeSpan;
    pose.fitResidual = Math.sqrt(errSq / N_EYE) / Math.max(eyeSpan, 1);
    pose.confidence = clamp01(1 - (pose.fitResidual - 0.02) / 0.1);

    this.euler.setFromQuaternion(pose.rotation, 'YXZ');
    pose.yawDeg = (this.euler.y * 180) / Math.PI;
    pose.pitchDeg = (this.euler.x * 180) / Math.PI;
    pose.rollDeg = (this.euler.z * 180) / Math.PI;
    pose.modelScale = sF;
    pose.alignRatio = r;
    pose.timestampMs = frame.timestampMs;
    pose.valid = true;

    this.hasState = true;
    this.lastTimestamp = frame.timestampMs;
    this.lastSeenTimestamp = frame.timestampMs;
    return pose;
  }
}

export function canonical(index: number, out: Vector3): Vector3 {
  return out.set(CANONICAL_POSITIONS[index * 3], CANONICAL_POSITIONS[index * 3 + 1], CANONICAL_POSITIONS[index * 3 + 2]);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
