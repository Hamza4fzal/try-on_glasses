import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Matrix4,
} from 'three';
import { CANONICAL_POSITIONS, CANONICAL_TRIANGLES, CANONICAL_VERTEX_COUNT } from '../tracking/canonical-face-data';
import { HEAD_MODEL } from './head-model';

/**
 * Invisible depth-only geometry for the wearer's head: the canonical face mesh (pushed slightly
 * inwards) plus a skull ellipsoid and ear proxies. Rendered before the glasses with colour writes
 * off, it hides temple segments that pass behind the head/ears and the far temple when the head
 * turns, while the camera image shows through.
 *
 * Placed with the face matrix F (canonical cm → camera cm). Debug mode renders it as a wireframe.
 */
export class FaceOccluder {
  readonly group = new Group();
  private readonly depthMaterial = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });
  private readonly debugMaterial = new MeshBasicMaterial({ color: 0x29d3ff, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly meshes: Mesh[] = [];
  private readonly geometries: BufferGeometry[] = [];
  enabled = true;

  constructor() {
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = -10;

    const face = buildInsetFace(HEAD_MODEL.faceInset);
    this.add(face);

    const skull = new SphereGeometry(1, 40, 24);
    skull.scale(...HEAD_MODEL.skull.radii);
    skull.translate(...HEAD_MODEL.skull.center);
    this.add(skull);

    for (const side of [1, -1]) {
      const ear = new SphereGeometry(1, 20, 14);
      ear.scale(...HEAD_MODEL.ear.radii);
      const [x, y, z] = HEAD_MODEL.ear.center;
      ear.translate(side * x, y, z);
      this.add(ear);
    }
  }

  private add(geometry: BufferGeometry): void {
    const mesh = new Mesh(geometry, this.depthMaterial);
    mesh.renderOrder = -10; // before the glasses (and their transmission pass) in every list
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geometry);
  }

  setDebug(on: boolean): void {
    for (const m of this.meshes) m.material = on ? this.debugMaterial : this.depthMaterial;
  }

  update(faceMatrix: Matrix4, visible: boolean): void {
    this.group.visible = visible && this.enabled;
    if (!this.group.visible) return;
    this.group.matrix.copy(faceMatrix);
    this.group.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.depthMaterial.dispose();
    this.debugMaterial.dispose();
    this.group.removeFromParent();
  }
}

/** Canonical face mesh with every vertex moved `inset` cm along its inward normal. */
function buildInsetFace(inset: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(CANONICAL_POSITIONS.slice(), 3));
  g.setIndex(new BufferAttribute(CANONICAL_TRIANGLES, 1));
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  const p = g.getAttribute('position');
  // Orientation check: the nose tip (vertex 1) must face +z (out of the face).
  const sign = n.getZ(1) > 0 ? 1 : -1;
  for (let i = 0; i < CANONICAL_VERTEX_COUNT; i++) {
    p.setXYZ(i, p.getX(i) - sign * n.getX(i) * inset, p.getY(i) - sign * n.getY(i) * inset, p.getZ(i) - sign * n.getZ(i) * inset);
  }
  g.deleteAttribute('normal');
  g.computeBoundingSphere();
  return g;
}
