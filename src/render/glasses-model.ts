import {
  Box3,
  Color,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Texture,
  Vector3,
  type Group,
} from 'three';
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import type { MaterialOverride } from '../product/catalog';

/**
 * A loaded eyewear model following docs/MODEL_SPEC.md (glasses space: metres, +X wearer's left,
 * +Y up, +Z forward, origin at the nose rest; temples `temple_L` / `temple_R` pivoted at hinges).
 *
 * Owns every GPU resource it creates; `dispose()` frees all of them (geometries, every material
 * ever assigned incl. variants and override clones, their textures and decoded images).
 */

export type RenderQuality = 'high' | 'low';

export interface VtoModelMeta {
  spec?: number;
  style?: string;
  title?: string;
  lensWidthMm?: number;
  lensHeightMm?: number;
  bridgeMm?: number;
  templeLengthMm?: number;
  frameWidthMm?: number;
  /** Glasses-space lens centres in metres ([left, right]). */
  lensCenters?: [number, number, number][];
}

export interface TempleInfo {
  node: Object3D;
  /** +1 = wearer's left (+X), −1 = right. */
  side: 1 | -1;
  restQuaternion: Quaternion;
  /** Unit direction pivot → ear bend in glasses space with the temple at rest. */
  restDir: Vector3;
}

interface VariantMapping {
  material: number;
  variants: number[];
}

interface SlotMesh {
  mesh: Mesh;
  slot: string;
  defaultMaterial: Material;
  mappings: VariantMapping[];
}

const TEMPLE_NAME = { L: /^temple[_-]?l(eft)?$/i, R: /^temple[_-]?r(ight)?$/i };

function slotOf(obj: Object3D, material: Material): string {
  for (let o: Object3D | null = obj; o; o = o.parent) {
    const s = o.userData?.vtoSlot;
    if (typeof s === 'string') return s;
  }
  // Models without slot extras (e.g. a plain Blender export): infer from names.
  const name = `${material.name} ${obj.name}`.toLowerCase();
  if (/lens|glass/.test(name)) return 'lens';
  if (/pad/.test(name)) return 'pad';
  if (/temple|arm/.test(name)) return 'temple';
  return 'frame';
}

export class GlassesModel {
  readonly variants: string[];
  readonly bounds = new Box3();
  readonly temples: TempleInfo[] = [];
  private readonly slotMeshes: SlotMesh[] = [];
  private readonly ownedMaterials = new Set<Material>();
  private readonly processed = new WeakSet<Material>();
  private overrideClones: Material[] = [];
  private currentVariant: string | null = null;
  private disposed = false;

  private constructor(
    readonly root: Group,
    private readonly parser: GLTFParser,
    readonly meta: VtoModelMeta,
    variants: string[],
    readonly quality: RenderQuality,
    private readonly sceneUnitsPerMetre = 100,
  ) {
    this.variants = variants;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) {
        const mat = mesh.material as Material;
        const ext = mesh.userData?.gltfExtensions?.KHR_materials_variants as { mappings?: VariantMapping[] } | undefined;
        this.slotMeshes.push({ mesh, slot: slotOf(mesh, mat), defaultMaterial: mat, mappings: ext?.mappings ?? [] });
        this.adopt(mat);
      }
      for (const side of ['L', 'R'] as const) {
        if (TEMPLE_NAME[side].test(o.name) && !this.temples.some((t) => t.node === o)) {
          const eb = o.userData?.vtoTemple?.earBend;
          const dir = Array.isArray(eb) && eb.length === 3 ? new Vector3(eb[0], eb[1], eb[2]) : new Vector3(0, 0, -1);
          dir.applyQuaternion(o.quaternion).normalize();
          this.temples.push({ node: o, side: side === 'L' ? 1 : -1, restQuaternion: o.quaternion.clone(), restDir: dir });
        }
      }
    });
    root.updateMatrixWorld(true);
    this.bounds.setFromObject(root, true);
  }

  /**
   * @param sceneUnitsPerMetre scene length units per metre (the try-on scene is in cm → 100).
   *   Needed because glTF's KHR_materials_volume attenuationDistance is in world units.
   */
  static async load(url: string, quality: RenderQuality = 'high', sceneUnitsPerMetre = 100): Promise<GlassesModel> {
    const gltf = await new GLTFLoader().loadAsync(url);
    let meta: VtoModelMeta = {};
    gltf.scene.traverse((o) => {
      if (o.userData?.vto && typeof o.userData.vto === 'object') meta = o.userData.vto as VtoModelMeta;
    });
    const vext = gltf.userData?.gltfExtensions?.KHR_materials_variants as { variants?: { name: string }[] } | undefined;
    const variants = (vext?.variants ?? []).map((v) => v.name);
    const model = new GlassesModel(gltf.scene, gltf.parser, meta, variants, quality, sceneUnitsPerMetre);
    if (variants.length) await model.setVariant(variants[0]);
    return model;
  }

  get variant(): string | null {
    return this.currentVariant;
  }

  /** Physical frame width in metres (from metadata, else measured). */
  get frameWidthM(): number {
    return this.meta.frameWidthMm ? this.meta.frameWidthMm / 1000 : this.bounds.max.x - this.bounds.min.x;
  }

  /**
   * Selects a KHR_materials_variants variant (null/unknown → file defaults), then applies
   * per-slot overrides from the product configuration.
   */
  async setVariant(name: string | null, overrides?: Record<string, MaterialOverride>): Promise<void> {
    if (this.disposed) return;
    const vi = name ? this.variants.indexOf(name) : -1;
    const assigned: Material[] = [];
    for (const sm of this.slotMeshes) {
      const mapping = vi >= 0 ? sm.mappings.find((m) => m.variants.includes(vi)) : undefined;
      const mat = mapping ? ((await this.parser.getDependency('material', mapping.material)) as Material) : sm.defaultMaterial;
      if (this.disposed) return;
      this.adopt(mat);
      assigned.push(mat);
    }
    // Overrides clone; shared (parser-cached) materials are never mutated.
    for (const c of this.overrideClones) c.dispose();
    this.overrideClones = [];
    this.slotMeshes.forEach((sm, i) => {
      let mat = assigned[i];
      const ov = overrides?.[sm.slot];
      if (ov) {
        mat = mat.clone();
        applyOverride(mat, ov, this.quality);
        this.overrideClones.push(mat);
      }
      sm.mesh.material = mat;
    });
    this.currentVariant = vi >= 0 ? name : null;
  }

  /** Meshes for a slot (debug / UI). */
  meshesOfSlot(slot: string): Mesh[] {
    return this.slotMeshes.filter((s) => s.slot === slot).map((s) => s.mesh);
  }

  /** Visits every mesh with its slot (its current material is `mesh.material`). */
  forEachMesh(fn: (mesh: Mesh, slot: string) => void): void {
    for (const s of this.slotMeshes) fn(s.mesh, s.slot);
  }

  get slots(): string[] {
    return [...new Set(this.slotMeshes.map((s) => s.slot))];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    const textures = new Set<Texture>();
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const m of [...this.ownedMaterials, ...this.overrideClones]) {
      for (const v of Object.values(m)) if (v instanceof Texture) textures.add(v);
      m.dispose();
    }
    for (const t of textures) {
      const img = t.source?.data as { close?: () => void } | undefined;
      t.dispose();
      img?.close?.(); // ImageBitmap
    }
    this.ownedMaterials.clear();
    this.overrideClones = [];
  }

  private adopt(mat: Material): void {
    this.ownedMaterials.add(mat);
    if (this.processed.has(mat)) return;
    this.processed.add(mat);
    prepareMaterial(mat, this.quality, this.sceneUnitsPerMetre);
  }
}

/**
 * Unit conversion (see load), then for low quality: physically based transmission (an extra scene render per frame) is replaced by
 * alpha blending with the same perceived tint. High quality keeps glTF materials as authored.
 */
function prepareMaterial(mat: Material, quality: RenderQuality, sceneUnitsPerMetre: number): void {
  const phys = mat as MeshPhysicalMaterial;
  // glTF attenuationDistance is in world units (metres for a model at unit scale); our scene is
  // in cm and the model is scaled into it, so convert. (thickness is local-space: no change.)
  if (phys.isMeshPhysicalMaterial && Number.isFinite(phys.attenuationDistance)) {
    phys.attenuationDistance *= sceneUnitsPerMetre;
  }
  if (quality === 'low' && phys.isMeshPhysicalMaterial && phys.transmission > 0) {
    const lum = 0.2126 * phys.color.r + 0.7152 * phys.color.g + 0.0722 * phys.color.b;
    const see = phys.transmission * (phys.map ? 0.6 : lum);
    phys.transmission = 0;
    phys.transparent = true;
    phys.opacity = Math.min(1, Math.max(0.06, 1 - see));
    phys.depthWrite = false;
    phys.needsUpdate = true;
  }
}

const tmpColor = new Color();

function applyOverride(mat: Material, ov: MaterialOverride, quality: RenderQuality): void {
  const std = mat as MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return;
  if (ov.color) std.color.copy(tmpColor.set(ov.color));
  if (ov.roughness !== undefined) std.roughness = ov.roughness;
  if (ov.metalness !== undefined) std.metalness = ov.metalness;
  const phys = mat as MeshPhysicalMaterial;
  if (ov.transmission !== undefined && phys.isMeshPhysicalMaterial) {
    if (quality === 'high') phys.transmission = ov.transmission;
    else {
      phys.transparent = true;
      phys.opacity = Math.min(1, Math.max(0.06, 1 - ov.transmission));
    }
  }
  mat.needsUpdate = true;
}
