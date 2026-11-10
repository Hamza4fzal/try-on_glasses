// Minimal glTF 2.0 binary (GLB) writer: meshes, PBR materials with KHR extensions,
// embedded PNG textures, node hierarchy, extras and KHR_materials_variants.

const COMPONENT = { f32: 5126, u16: 5123, u32: 5125 };
const TARGET = { array: 34962, element: 34963 };

export class GltfBuilder {
  constructor(generator = 'vto-eyewear tools/generate-models.mjs') {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      textures: [],
      images: [],
      samplers: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
    };
    this.chunks = [];
    this.byteLength = 0;
    this.extensionsUsed = new Set();
    this.variantNames = [];
  }

  _bufferView(bytes, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.byteLength += bytes.byteLength;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  _accessor(array, type, componentType, target, withMinMax = false) {
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const acc = {
      bufferView: this._bufferView(array, target),
      componentType,
      count: array.length / width,
      type,
    };
    if (withMinMax) {
      const min = new Array(width).fill(Infinity);
      const max = new Array(width).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const k = i % width;
        // Math.fround keeps min/max bit-identical to the stored float32 values (validator check).
        const v = Math.fround(array[i]);
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      acc.min = min;
      acc.max = max;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  /** geometry: { positions, normals, uvs?, indices } as plain arrays or typed arrays. */
  _geometry(g) {
    const attributes = {
      POSITION: this._accessor(Float32Array.from(g.positions), 'VEC3', COMPONENT.f32, TARGET.array, true),
      NORMAL: this._accessor(Float32Array.from(g.normals), 'VEC3', COMPONENT.f32, TARGET.array),
    };
    if (g.uvs && g.uvs.length) {
      attributes.TEXCOORD_0 = this._accessor(Float32Array.from(g.uvs), 'VEC2', COMPONENT.f32, TARGET.array);
    }
    const vertexCount = g.positions.length / 3;
    const idx = vertexCount > 65535 ? Uint32Array.from(g.indices) : Uint16Array.from(g.indices);
    const indices = this._accessor(idx, 'SCALAR', vertexCount > 65535 ? COMPONENT.u32 : COMPONENT.u16, TARGET.element);
    return { attributes, indices };
  }

  addTexturePNG(pngBytes, name) {
    if (!this.json.samplers.length) {
      // LINEAR_MIPMAP_LINEAR / LINEAR / REPEAT
      this.json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    }
    const bufferView = this._bufferView(new Uint8Array(pngBytes));
    this.json.images.push({ name, mimeType: 'image/png', bufferView });
    this.json.textures.push({ name, sampler: 0, source: this.json.images.length - 1 });
    return this.json.textures.length - 1;
  }

  addMaterial(def) {
    for (const ext of Object.keys(def.extensions ?? {})) this.extensionsUsed.add(ext);
    this.json.materials.push(def);
    return this.json.materials.length - 1;
  }

  setVariants(names) {
    this.variantNames = names.slice();
  }

  /**
   * primitives: [{ geometry, material, variantMaterials?: number[] }]
   *   variantMaterials[i] = material index for variant i (omit → no variant mapping).
   */
  addMesh(name, primitives) {
    const prims = primitives.map((p) => {
      const { attributes, indices } = this._geometry(p.geometry);
      const prim = { attributes, indices, material: p.material, mode: 4 };
      if (p.variantMaterials && this.variantNames.length) {
        const byMaterial = new Map();
        p.variantMaterials.forEach((m, vi) => {
          if (!byMaterial.has(m)) byMaterial.set(m, []);
          byMaterial.get(m).push(vi);
        });
        prim.extensions = {
          KHR_materials_variants: {
            mappings: [...byMaterial].map(([material, variants]) => ({ material, variants })),
          },
        };
        this.extensionsUsed.add('KHR_materials_variants');
      }
      return prim;
    });
    this.json.meshes.push({ name, primitives: prims });
    return this.json.meshes.length - 1;
  }

  addNode(def) {
    this.json.nodes.push(def);
    return this.json.nodes.length - 1;
  }

  addRootNode(index) {
    this.json.scenes[0].nodes.push(index);
  }

  toGLB() {
    const json = this.json;
    json.buffers[0].byteLength = this.byteLength;
    if (this.variantNames.length) {
      json.extensions = { KHR_materials_variants: { variants: this.variantNames.map((name) => ({ name })) } };
    }
    if (this.extensionsUsed.size) json.extensionsUsed = [...this.extensionsUsed].sort();
    for (const k of ['textures', 'images', 'samplers', 'materials', 'meshes']) if (!json[k].length) delete json[k];

    const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
    const binPad = (4 - (this.byteLength % 4)) % 4;
    const binChunk = Buffer.concat([...this.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), Buffer.alloc(binPad)]);

    const header = Buffer.alloc(12);
    const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
    header.writeUInt32LE(0x46546c67, 0); // 'glTF'
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(jsonChunk.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binChunk.length, 0);
    bh.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
    return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
  }
}
