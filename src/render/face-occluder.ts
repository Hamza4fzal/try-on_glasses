import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type Side,
} from 'three';
import { CANONICAL_POSITIONS, CANONICAL_TRIANGLES, CANONICAL_VERTEX_COUNT } from '../tracking/canonical-face-data';
import type { CameraModel } from '../tracking/camera-model';
import type { TrackerFrame } from '../tracking/face-tracker';
import type { FacePose } from '../tracking/pose-solver';
import { LM } from '../tracking/landmarks';
import { HEAD_MODEL } from './head-model';
import { len3 } from '../utils/fast-math';

/** Max per-vertex deviation of the live face from the canonical shape (cm) — rejects outliers. */
const MAX_DEVIATION = 1.6;
/** Per-frame smoothing of the live shape deviation (the rigid motion itself is not delayed). */
const SHAPE_SMOOTHING = 0.45;
const HEAD_WIDTH_RANGE = [0.86, 1.18] as const;

/**
 * Invisible geometry for the wearer's head, used to hide the parts of the glasses that are behind
 * it (far temple when the head turns, temple ends behind the ears):
 *
 *  - the FACE follows the live landmarks: every vertex sits on the camera ray through its tracked
 *    image position, at the depth of the solved (smoothed) face pose, pushed `faceInset` inwards.
 *    So the occluding silhouette is the wearer's real face outline, not an average one. The
 *    deviation from the canonical shape is expressed in face space and lightly smoothed, so rigid
 *    head motion is never delayed. Low-confidence frames fall back to the rigid canonical face.
 *  - SKULL and EARS are proxies (HEAD_MODEL) placed with the face pose, widened to the measured
 *    head width.
 *
 * The camera-space face surface is also exposed (`faceGeometry`) for contact-shadow receiving.
 * Rendering is decided by the caller: as a depth-only pre-pass (soft occlusion) or directly in the
 * main pass (hard occlusion, the fallback). update() is allocation-free.
 */
export class FaceOccluder {
  /** Root in camera space (identity matrix). */
  readonly group = new Group();
  /** Live face surface in camera space (cm). */
  readonly faceGeometry: BufferGeometry;
  /** Side of the face triangles that faces the camera. */
  readonly faceSide: Side;
  /** Measured head width relative to the canonical head (slowly smoothed; 1 until measured). */
  headWidthRatio = 1;
  /** True while the face follows live landmarks (false = rigid canonical fallback). */
  live = false;
  /** Use live landmarks for the face surface (false = always rigid canonical). */
  liveShape = true;
  enabled = true;

  readonly depthMaterial = new MeshBasicMaterial({
    colorWrite: false,
    side: DoubleSide,
    // Pushed back a hair so a co-planar shadow receiver still passes the depth test.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly debugMaterial = new MeshBasicMaterial({ color: 0x29d3ff, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly meshes: Mesh[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly head = new Group();
  private readonly canonNormals: Float32Array;
  private readonly delta = new Float32Array(CANONICAL_VERTEX_COUNT * 3);
  private hasDelta = false;
  private readonly canonWidth: number;
  private readonly Finv = new Matrix4();
  private readonly S = new Matrix4();
  private readonly v = new Vector3();
  private debug = false;

  constructor(readonly faceInset = HEAD_MODEL.faceInset) {
    this.group.matrixAutoUpdate = false;
    this.head.matrixAutoUpdate = false;
    this.group.add(this.head);

    const canon = new BufferGeometry();
    canon.setAttribute('position', new BufferAttribute(CANONICAL_POSITIONS.slice(), 3));
    canon.setIndex(new BufferAttribute(CANONICAL_TRIANGLES, 1));
    canon.computeVertexNormals();
    const n = canon.getAttribute('normal');
    // The nose tip (vertex 1) must face +z (out of the face) → outward normal sign.
    const sign = n.getZ(LM.noseTip) > 0 ? 1 : -1;
    this.faceSide = sign > 0 ? FrontSide : BackSide;
    this.canonNormals = new Float32Array(CANONICAL_VERTEX_COUNT * 3);
    for (let i = 0; i < CANONICAL_VERTEX_COUNT * 3; i++) this.canonNormals[i] = sign * (n.array[i] as number);
    canon.dispose();

    this.faceGeometry = new BufferGeometry();
    const pos = new BufferAttribute(new Float32Array(CANONICAL_VERTEX_COUNT * 3), 3);
    pos.setUsage(DynamicDrawUsage);
    this.faceGeometry.setAttribute('position', pos);
    this.faceGeometry.setIndex(new BufferAttribute(CANONICAL_TRIANGLES, 1));
    this.addMesh(this.faceGeometry, this.group).frustumCulled = false;

    const skull = new SphereGeometry(1, 40, 24);
    skull.scale(...HEAD_MODEL.skull.radii);
    skull.translate(...HEAD_MODEL.skull.center);
    this.addMesh(skull, this.head);
    for (const side of [1, -1]) {
      const ear = new SphereGeometry(1, 20, 14);
      ear.scale(...HEAD_MODEL.ear.radii);
      const [x, y, z] = HEAD_MODEL.ear.center;
      ear.translate(side * x, y, z);
      this.addMesh(ear, this.head);
    }

    const c = CANONICAL_POSITIONS;
    const a = LM.rightFaceEdge * 3, b = LM.leftFaceEdge * 3;
    this.canonWidth = len3(c[a] - c[b], c[a + 1] - c[b + 1], c[a + 2] - c[b + 2]);
    this.group.visible = false;
  }

  private addMesh(geometry: BufferGeometry, parent: Group): Mesh {
    const mesh = new Mesh(geometry, this.depthMaterial);
    mesh.renderOrder = -10; // before the glasses (and their transmission pass) in every list
    parent.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geometry);
    return mesh;
  }

  setDebug(on: boolean): void {
    this.debug = on;
    for (const m of this.meshes) m.material = on ? this.debugMaterial : this.depthMaterial;
  }

  get debugVisible(): boolean {
    return this.debug;
  }

  /** New wearer: forget the measured shape and head width. */
  reset(): void {
    this.hasDelta = false;
    this.delta.fill(0);
    this.headWidthRatio = 1;
    this.live = false;
  }

  update(frame: TrackerFrame, pose: FacePose, camera: CameraModel): void {
    this.group.visible = pose.valid && this.enabled;
    if (!this.group.visible) return;
    const F = pose.faceMatrix;
    const C = CANONICAL_POSITIONS;
    const v = this.v;
    const d = this.delta;

    const useLive = this.liveShape && frame.hasFace && pose.confidence >= 0.3;
    if (useLive) {
      this.Finv.copy(F).invert();
      const a = pose.reacquired || !this.hasDelta ? 1 : SHAPE_SMOOTHING;
      const L = frame.landmarks;
      for (let i = 0, j = 0; i < CANONICAL_VERTEX_COUNT; i++, j += 3) {
        // Rigid prediction → keep its depth, take the observed image position.
        v.set(C[j], C[j + 1], C[j + 2]).applyMatrix4(F);
        camera.unproject(L[j], L[j + 1], v.z, v);
        v.applyMatrix4(this.Finv);
        d[j] += (clamp(v.x - C[j], MAX_DEVIATION) - d[j]) * a;
        d[j + 1] += (clamp(v.y - C[j + 1], MAX_DEVIATION) - d[j + 1]) * a;
        d[j + 2] += (clamp(v.z - C[j + 2], MAX_DEVIATION) - d[j + 2]) * a;
      }
      this.hasDelta = true;
      // Head width from the face outline at cheekbone level, only from near-frontal, confident views.
      if (Math.abs(pose.yawDeg) < 15 && Math.abs(pose.pitchDeg) < 20 && pose.confidence > 0.5) {
        const p = LM.rightFaceEdge * 3, q = LM.leftFaceEdge * 3;
        const w = len3(C[p] + d[p] - C[q] - d[q], C[p + 1] + d[p + 1] - C[q + 1] - d[q + 1], C[p + 2] + d[p + 2] - C[q + 2] - d[q + 2]);
        const r = Math.min(HEAD_WIDTH_RANGE[1], Math.max(HEAD_WIDTH_RANGE[0], w / this.canonWidth));
        this.headWidthRatio += (r - this.headWidthRatio) * (pose.reacquired ? 0.3 : 0.04);
      }
    }
    this.live = useLive || this.hasDelta;
    const useDelta = this.liveShape && this.hasDelta;

    const pos = this.faceGeometry.getAttribute('position') as BufferAttribute;
    const out = pos.array as Float32Array;
    const N = this.canonNormals;
    const inset = this.faceInset;
    for (let j = 0; j < CANONICAL_VERTEX_COUNT * 3; j += 3) {
      v.set(C[j] - N[j] * inset, C[j + 1] - N[j + 1] * inset, C[j + 2] - N[j + 2] * inset);
      if (useDelta) {
        v.x += d[j];
        v.y += d[j + 1];
        v.z += d[j + 2];
      }
      v.applyMatrix4(F);
      out[j] = v.x;
      out[j + 1] = v.y;
      out[j + 2] = v.z;
    }
    pos.needsUpdate = true;

    this.head.matrix.multiplyMatrices(F, this.S.makeScale(this.headWidthRatio, 1, 1));
    this.head.matrixWorldNeedsUpdate = true;
    this.group.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.depthMaterial.dispose();
    this.debugMaterial.dispose();
    this.group.removeFromParent();
  }
}

function clamp(x: number, m: number): number {
  return x < -m ? -m : x > m ? m : x;
}
