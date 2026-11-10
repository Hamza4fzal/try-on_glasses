// Shrinks an eyewear GLB for the web without changing how it looks or fits:
//
//   - geometry: quantised (KHR_mesh_quantization: positions 14-bit ≈ 0.01 mm on a frame,
//     normals 10-bit, UVs 12-bit) and meshopt-compressed (EXT_meshopt_compression) — decoded in
//     the browser by three.js' bundled MeshoptDecoder (no extra download, no network);
//   - textures: WebP (EXT_texture_webp), max 1024 px;
//   - duplicate materials/textures/accessors merged, unused data dropped.
//
// Node names, temple pivots, extras (vtoSlot, vtoTemple, vto metadata) and every
// KHR_materials_* extension incl. KHR_materials_variants are preserved.
//
// Usage: node tools/optimize-model.mjs input.glb [output.glb]     (default: overwrite input)
// Also used by tools/generate-models.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import validator from 'gltf-validator';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

let ioPromise = null;
function getIO() {
  ioPromise ??= Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]).then(() =>
    new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder }),
  );
  return ioPromise;
}

/** @param {Uint8Array} glb @returns {Promise<Uint8Array>} */
export async function optimizeGlb(glb, { textureSize = 1024, textureQuality = 88 } = {}) {
  const io = await getIO();
  const doc = await io.readBinary(glb);
  await doc.transform(dedup(), prune({ keepLeaves: true, keepExtras: true, keepAttributes: true }));
  const before = worldThickness(doc);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: textureQuality, resize: [textureSize, textureSize] }),
    // 'scene': one dequantisation scale for every mesh, so shared volume materials stay consistent.
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );
  preserveVolumeThickness(doc, before);
  return io.writeBinary(doc);
}

/**
 * KHR_materials_volume thickness is in MESH space. Quantisation stores positions as integers and
 * moves a (tiny) scale onto the mesh nodes, which would shrink the thickness renderers derive
 * (tinted acetate / crystal colours would wash out). Rescale thickness to keep it in world units.
 */
function volumeScales(doc) {
  /** @type {Map<object, number[]>} material → world scales of the nodes that use it */
  const out = new Map();
  const names = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    if (!mat.getExtension('KHR_materials_volume')) continue;
    if (names.has(mat.getName())) throw new Error(`Volume materials need unique names ("${mat.getName()}")`);
    names.add(mat.getName());
  }
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const scale = Math.cbrt(Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])));
    for (const prim of mesh.listPrimitives()) {
      const materials = [prim.getMaterial(), ...variantMaterials(prim)];
      for (const mat of materials) {
        if (!mat?.getExtension('KHR_materials_volume')) continue;
        out.set(mat, [...(out.get(mat) ?? []), scale]);
      }
    }
  }
  return out;
}

function variantMaterials(prim) {
  const ext = prim.getExtension('KHR_materials_variants');
  return ext ? ext.listMappings().map((m) => m.getMaterial()) : [];
}

/** World-space thickness per material name (names are unique, checked above). */
function worldThickness(doc) {
  const out = new Map();
  for (const [mat, scales] of volumeScales(doc)) {
    if (scales.some((s) => Math.abs(s / scales[0] - 1) > 1e-4)) {
      throw new Error(`Material "${mat.getName()}" is used at different scales; cannot preserve volume thickness`);
    }
    out.set(mat.getName(), { mat, scale: scales[0], world: mat.getExtension('KHR_materials_volume').getThicknessFactor() * scales[0] });
  }
  return out;
}

// gltf-transform's quantize() already rescales the default material of each primitive (cloning it
// if needed) but not materials reached only through KHR_materials_variants — so set every volume
// material to its original world thickness, whatever quantize did.
function preserveVolumeThickness(doc, before) {
  for (const [name, a] of worldThickness(doc)) {
    const b = before.get(name);
    if (b) a.mat.getExtension('KHR_materials_volume').setThicknessFactor(b.world / a.scale);
  }
}

/** Khronos validator summary; throws on errors. */
export async function validateGlb(glb, label = 'model') {
  const report = await validator.validateBytes(new Uint8Array(glb), { maxIssues: 50 });
  const { numErrors, numWarnings } = report.issues;
  for (const m of report.issues.messages) {
    if (m.severity <= 1) console.log(`   [${m.severity === 0 ? 'error' : 'warn'}] ${m.code} ${m.pointer ?? ''}: ${m.message}`);
  }
  if (numErrors) throw new Error(`${label}: ${numErrors} validation error(s)`);
  return { report, numWarnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output = input] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: node tools/optimize-model.mjs input.glb [output.glb]');
    process.exit(1);
  }
  const src = readFileSync(input);
  const out = await optimizeGlb(src);
  await validateGlb(out, output);
  writeFileSync(output, out);
  console.log(`${input}: ${(src.length / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB (${output})`);
}
