import { AxesHelper, Box3Helper, Color, Euler, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { DEFAULT_CALIBRATION, type Calibration } from '../product/catalog';
import { LM } from '../tracking/landmarks';
import { canonical, type FacePose } from '../tracking/pose-solver';
import type { GlassesModel } from './glasses-model';
import { HEAD_MODEL } from './head-model';

const DEG = Math.PI / 180;

/** Temple auto-fit limits relative to the model's rest pose (degrees). */
const SPREAD_RANGE = [-6, 22] as const;
const DROOP_RANGE = [-12, 20] as const;

export interface TempleFit {
  /** Applied spread relative to rest (deg, + = outwards). */
  spreadDeg: number;
  /** Applied droop relative to rest (deg, + = tips down). */
  droopDeg: number;
  /** True when the auto-fit wanted more than the allowed range. */
  clamped: boolean;
}

/**
 * Attaches a GlassesModel to the tracked face.
 *
 *   camera ← F (face pose, canonical cm → camera cm) ← G (glasses m → canonical cm)
 *
 *   G = T(noseRest) · S(1/kEff) · T(offset) · R(rotation) · S(100 · scale)
 *
 * noseRest is a canonical point on the nose (bridgeAlignment between landmarks 168 and 6);
 * kEff = k^(1 − faceWidthAdaptation) where k is the wearer's real-size factor (iris ruler), so with
 * adaptation 0 the frame keeps its physical size on every face. Offsets are real millimetres.
 *
 * Temples are then aimed at the ear rests of the canonical head (HEAD_MODEL), expressed in glasses
 * space through G⁻¹ — so pantoscopic tilt, scale and face size are all compensated naturally.
 *
 * update() is allocation-free.
 */
export class GlassesRig {
  /** matrix = F · G; add to the scene. */
  readonly group = new Group();
  model: GlassesModel | null = null;
  readonly calibration: Calibration = structuredClone(DEFAULT_CALIBRATION) as Calibration;
  readonly templeFit: [TempleFit, TempleFit] = [
    { spreadDeg: 0, droopDeg: 0, clamped: false },
    { spreadDeg: 0, droopDeg: 0, clamped: false },
  ];
  /** Effective size factor used for the last update. */
  kEff = 1;

  private readonly inner = new Group(); // glasses space
  private readonly axes = new AxesHelper(0.03);
  private boxHelper: Box3Helper | null = null;
  private debug = false;

  private readonly G = new Matrix4();
  private readonly Ginv = new Matrix4();
  private readonly m1 = new Matrix4();
  private readonly noseRest = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly q = new Quaternion();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly dir = new Vector3();
  private readonly target = new Vector3();
  private lastK = NaN;
  private dirty = true;

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.inner);
    this.axes.visible = false;
    this.inner.add(this.axes);
  }

  setModel(model: GlassesModel | null): void {
    if (this.model) this.inner.remove(this.model.root);
    if (this.boxHelper) {
      this.inner.remove(this.boxHelper);
      this.boxHelper.geometry.dispose();
      (this.boxHelper.material as { dispose(): void }).dispose();
      this.boxHelper = null;
    }
    this.model = model;
    if (model) {
      this.inner.add(model.root);
      this.boxHelper = new Box3Helper(model.bounds, new Color(0xff9a1f));
      this.boxHelper.visible = this.debug;
      this.inner.add(this.boxHelper);
    }
    this.dirty = true;
  }

  setCalibration(c: Calibration): void {
    Object.assign(this.calibration, structuredClone(c));
    this.dirty = true;
  }

  setDebug(on: boolean): void {
    this.debug = on;
    this.axes.visible = on;
    if (this.boxHelper) this.boxHelper.visible = on;
  }

  /** Per tracked frame. `k` = TrueSizeEstimator.factor. */
  update(pose: FacePose, k: number): void {
    if (!this.model || !pose.valid) {
      this.group.visible = false;
      return;
    }
    if (this.dirty || k !== this.lastK) this.recompute(k);
    this.group.matrix.multiplyMatrices(pose.faceMatrix, this.G);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.visible = true;
  }

  /** Places the glasses on the canonical face itself (no tracking) — used by the 3D fit preview. */
  updateCanonical(k = 1): void {
    if (!this.model) return;
    if (this.dirty || k !== this.lastK) this.recompute(k);
    this.group.matrix.copy(this.G);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.visible = true;
  }

  /** Glasses-space point (m) → canonical face space (cm). */
  glassesToCanonical(p: Vector3, out: Vector3): Vector3 {
    return out.copy(p).applyMatrix4(this.G);
  }

  private recompute(k: number): void {
    const c = this.calibration;
    this.lastK = k;
    this.dirty = false;
    this.kEff = Math.pow(k, 1 - c.faceWidthAdaptation);

    const a = canonical(LM.noseBridgeTop, this.v1);
    const b = canonical(LM.noseBridgeMid, this.v2);
    this.noseRest.copy(a).lerp(b, c.bridgeAlignment);

    const inv = 1 / this.kEff;
    const s = 100 * c.scale; // m → cm
    this.euler.set(c.rotationDeg[0] * DEG, c.rotationDeg[1] * DEG, c.rotationDeg[2] * DEG, 'YXZ');
    this.G.makeTranslation(this.noseRest.x, this.noseRest.y, this.noseRest.z)
      .multiply(this.m1.makeScale(inv, inv, inv))
      .multiply(this.m1.makeTranslation(c.offsetMm[0] / 10, c.offsetMm[1] / 10, c.offsetMm[2] / 10))
      .multiply(this.m1.makeRotationFromEuler(this.euler))
      .multiply(this.m1.makeScale(s, s, s));
    this.Ginv.copy(this.G).invert();
    this.fitTemples();
  }

  private fitTemples(): void {
    const model = this.model;
    if (!model) return;
    const c = this.calibration;
    const ear = HEAD_MODEL.earRest;
    for (const t of model.temples) {
      const r0 = t.restDir;
      const theta0 = Math.atan2(t.side * r0.x, -r0.z);
      const phi0 = Math.atan2(-r0.y, Math.hypot(r0.x, r0.z));
      let theta = theta0, phi = phi0;
      const fit = this.templeFit[t.side === 1 ? 0 : 1];
      fit.clamped = false;
      if (c.templeAutoFit) {
        this.target.set(t.side * ear.x, ear.y, ear.z).applyMatrix4(this.Ginv).sub(t.node.position);
        const want = Math.atan2(t.side * this.target.x, -this.target.z);
        const wantPhi = Math.atan2(-this.target.y, Math.hypot(this.target.x, this.target.z));
        theta = clamp(want, theta0 + SPREAD_RANGE[0] * DEG, theta0 + SPREAD_RANGE[1] * DEG);
        phi = clamp(wantPhi, phi0 + DROOP_RANGE[0] * DEG, phi0 + DROOP_RANGE[1] * DEG);
        fit.clamped = theta !== want || phi !== wantPhi;
      }
      theta += c.templeSpreadDeg * DEG;
      phi += c.templeDroopDeg * DEG;
      this.dir.set(t.side * Math.sin(theta) * Math.cos(phi), -Math.sin(phi), -Math.cos(theta) * Math.cos(phi));
      this.q.setFromUnitVectors(r0, this.dir);
      t.node.quaternion.copy(this.q).multiply(t.restQuaternion);
      fit.spreadDeg = (theta - theta0) / DEG;
      fit.droopDeg = (phi - phi0) / DEG;
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
