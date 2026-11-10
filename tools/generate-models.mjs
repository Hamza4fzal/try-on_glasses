// Generates the development eyewear catalogue as glTF binaries (public/models/*.glb).
//
// These stand in for production Blender models until real ones exist. They follow exactly the
// same contract (docs/MODEL_SPEC.md): metres, +X wearer's left, +Y up, +Z forward, origin at the
// nose rest, separate frame / lens / temple / hinge / pad meshes, temples pivoted at the hinges,
// and colourways as KHR_materials_variants. Every file is checked with the Khronos validator.
//
// The shipped files are web-optimised by tools/optimize-model.mjs (meshopt geometry, WebP
// textures); --raw writes the unoptimised authoring output instead.
//
// Usage: node tools/generate-models.mjs [styleId ...] [--raw]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';
import { GltfBuilder } from './glasses/gltf-builder.mjs';
import { optimizeGlb, validateGlb } from './optimize-model.mjs';
import { VARIANTS, materialRegistry } from './glasses/materials.mjs';
import { STYLES, buildStyle } from './glasses/styles.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public/models');
const SPEC_VERSION = 1;

function toGLB(id) {
  const built = buildStyle(id);
  const vdef = VARIANTS[id];
  const b = new GltfBuilder();
  b.setVariants(vdef.variants.map((v) => v.name));
  const mat = materialRegistry(b);

  const slotMaterials = (slot) => {
    const per = vdef.variants.map((v) => v.slots[slot] ?? vdef.base[slot]);
    if (per.some((m) => !m)) throw new Error(`${id}: no material for slot "${slot}"`);
    const idx = per.map(mat);
    const varies = idx.some((m) => m !== idx[0]);
    return { material: idx[0], variantMaterials: varies ? idx : undefined };
  };

  const partNode = (name, part) => {
    const { material, variantMaterials } = slotMaterials(part.slot);
    const mesh = b.addMesh(name, [{ geometry: part.mesh.toGeometry(), material, variantMaterials }]);
    return b.addNode({ name, mesh, extras: { vtoSlot: part.slot } });
  };

  const children = [];
  for (const part of built.front) children.push(partNode(part.name, part));
  for (const t of built.temples) {
    const kids = t.parts.map((p) => partNode(`${t.name}_${p.name}`, p));
    children.push(
      b.addNode({
        name: t.name,
        translation: t.pivot.map((v) => v / 1000),
        children: kids,
        extras: { vtoTemple: { earBend: t.earBend.map((v) => +(v / 1000).toFixed(5)) } },
      }),
    );
  }
  const rootNode = b.addNode({
    name: 'glasses',
    children,
    extras: { vto: { spec: SPEC_VERSION, style: id, title: STYLES[id].title, ...built.meta } },
  });
  b.addRootNode(rootNode);
  return { glb: b.toGLB(), meta: built.meta };
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const list = ids.length ? ids : Object.keys(STYLES);
  const keepRaw = process.argv.includes('--raw');
  mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const id of list) {
    const t0 = performance.now();
    const { glb: raw, meta } = toGLB(id);
    // Validate the authored file, then ship the web-optimised one (validated again).
    const report = await validator.validateBytes(new Uint8Array(raw), { maxIssues: 50 });
    const { numErrors, numWarnings, numInfos } = report.issues;
    let glb = raw;
    if (!numErrors && !keepRaw) {
      glb = await optimizeGlb(raw);
      await validateGlb(glb, id);
    }
    const file = join(outDir, `${id}.glb`);
    writeFileSync(file, glb);
    const info = report.info;
    console.log(
      `${id.padEnd(6)} ${(raw.length / 1024).toFixed(0).padStart(5)} KB → ${(glb.length / 1024).toFixed(0).padStart(4)} KB  ` +
        `${String(info.totalVertexCount).padStart(6)} verts  ` +
        `${String(info.totalTriangleCount).padStart(6)} tris  ${info.materialCount} materials  ` +
        `${meta.lensWidthMm}□${meta.bridgeMm}-${meta.templeLengthMm}, frame ${meta.frameWidthMm} mm  ` +
        `validator: ${numErrors} errors, ${numWarnings} warnings, ${numInfos} infos  (${(performance.now() - t0).toFixed(0)} ms)`,
    );
    for (const m of report.issues.messages) {
      if (m.severity <= 1) console.log(`   [${m.severity === 0 ? 'error' : 'warn'}] ${m.code} ${m.pointer ?? ''}: ${m.message}`);
    }
    if (numErrors) failed++;
  }
  if (failed) {
    console.error(`${failed} model(s) failed validation`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
