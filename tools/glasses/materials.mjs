// glTF PBR material library for the dev catalogue + per-style material variants.
// Values are linear-space factors per the glTF spec; textures are sRGB.
import { TORTOISE_PALETTES, gradientTexture, tortoiseTexture } from './textures.mjs';

const clearcoat = (r = 0.06) => ({ KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: r } });

/** Each entry: (textures) → glTF material JSON. `textures` maps texture keys → texture indices. */
const LIBRARY = {
  // --- acetates (cellulose acetate: IOR ≈ 1.47–1.50, polished + lacquer-like clearcoat)
  acetate_havana: (t) => ({
    pbrMetallicRoughness: { baseColorTexture: { index: t.havana }, metallicFactor: 0, roughnessFactor: 0.24 },
    extensions: { ...clearcoat(), KHR_materials_ior: { ior: 1.49 } },
  }),
  acetate_honey: (t) => ({
    pbrMetallicRoughness: { baseColorTexture: { index: t.honey }, metallicFactor: 0, roughnessFactor: 0.24 },
    extensions: { ...clearcoat(), KHR_materials_ior: { ior: 1.49 } },
  }),
  acetate_black: () => ({
    pbrMetallicRoughness: { baseColorFactor: [0.009, 0.009, 0.01, 1], metallicFactor: 0, roughnessFactor: 0.2 },
    extensions: { ...clearcoat(0.025), KHR_materials_ior: { ior: 1.49 } },
  }),
  acetate_crystal: () => ({
    pbrMetallicRoughness: { baseColorFactor: [0.97, 0.97, 0.97, 1], metallicFactor: 0, roughnessFactor: 0.06 },
    extensions: {
      ...clearcoat(0.02),
      KHR_materials_ior: { ior: 1.49 },
      KHR_materials_transmission: { transmissionFactor: 0.9 },
      KHR_materials_volume: { thicknessFactor: 0.004, attenuationDistance: 0.03, attenuationColor: [0.92, 0.94, 0.96] },
    },
  }),
  acetate_rose: () => ({
    pbrMetallicRoughness: { baseColorFactor: [1, 0.9, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.08 },
    extensions: {
      ...clearcoat(0.02),
      KHR_materials_ior: { ior: 1.49 },
      KHR_materials_transmission: { transmissionFactor: 0.82 },
      KHR_materials_volume: { thicknessFactor: 0.004, attenuationDistance: 0.008, attenuationColor: [0.93, 0.55, 0.58] },
    },
  }),

  // --- metals (measured F0 colours, linear)
  metal_gold: () => ({ pbrMetallicRoughness: { baseColorFactor: [1.0, 0.766, 0.336, 1], metallicFactor: 1, roughnessFactor: 0.2 } }),
  metal_silver: () => ({ pbrMetallicRoughness: { baseColorFactor: [0.95, 0.94, 0.92, 1], metallicFactor: 1, roughnessFactor: 0.17 } }),
  metal_gunmetal: () => ({ pbrMetallicRoughness: { baseColorFactor: [0.29, 0.3, 0.32, 1], metallicFactor: 1, roughnessFactor: 0.3 } }),
  metal_black: () => ({
    // Powder-coated steel: dielectric-ish matte paint over metal.
    pbrMetallicRoughness: { baseColorFactor: [0.02, 0.02, 0.022, 1], metallicFactor: 0.4, roughnessFactor: 0.45 },
  }),
  steel: () => ({ pbrMetallicRoughness: { baseColorFactor: [0.82, 0.82, 0.83, 1], metallicFactor: 1, roughnessFactor: 0.28 } }),

  // --- silicone nose pads
  pad_silicone: () => ({
    pbrMetallicRoughness: { baseColorFactor: [0.97, 0.97, 0.95, 1], metallicFactor: 0, roughnessFactor: 0.32 },
    extensions: {
      KHR_materials_ior: { ior: 1.41 },
      KHR_materials_transmission: { transmissionFactor: 0.7 },
      KHR_materials_volume: { thicknessFactor: 0.0012, attenuationDistance: 0.01, attenuationColor: [0.97, 0.97, 0.93] },
    },
  }),

  // --- lenses (thin polycarbonate / CR-39, IOR ≈ 1.5–1.59)
  lens_clear: () => ({
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.02 },
    extensions: {
      KHR_materials_ior: { ior: 1.5 },
      KHR_materials_transmission: { transmissionFactor: 1 },
      // Anti-reflective coating: a thin film that tints the residual reflection green/violet.
      KHR_materials_iridescence: { iridescenceFactor: 0.45, iridescenceIor: 1.38, iridescenceThicknessMaximum: 290 },
      KHR_materials_specular: { specularFactor: 0.3 },
    },
  }),
  lens_g15: () => ({
    // G-15: ~15 % transmission, neutral green-grey.
    pbrMetallicRoughness: { baseColorFactor: [0.15, 0.19, 0.13, 1], metallicFactor: 0, roughnessFactor: 0.02 },
    extensions: { KHR_materials_ior: { ior: 1.5 }, KHR_materials_transmission: { transmissionFactor: 1 } },
  }),
  lens_grey_gradient: (t) => ({
    pbrMetallicRoughness: { baseColorTexture: { index: t.greyGradient }, metallicFactor: 0, roughnessFactor: 0.02 },
    extensions: { KHR_materials_ior: { ior: 1.5 }, KHR_materials_transmission: { transmissionFactor: 1 } },
  }),
  lens_blue_mirror: () => ({
    // Multilayer mirror coating: strong thin-film interference reflection over a dark grey base.
    pbrMetallicRoughness: { baseColorFactor: [0.1, 0.16, 0.34, 1], metallicFactor: 0.45, roughnessFactor: 0.04 },
    extensions: {
      KHR_materials_ior: { ior: 1.5 },
      KHR_materials_transmission: { transmissionFactor: 1 },
      KHR_materials_iridescence: { iridescenceFactor: 1, iridescenceIor: 2.0, iridescenceThicknessMaximum: 520 },
    },
  }),
};

/** Textures referenced by the library: key → () => PNG bytes. */
const TEXTURES = {
  havana: () => tortoiseTexture(TORTOISE_PALETTES.havana, 512, 7),
  honey: () => tortoiseTexture(TORTOISE_PALETTES.honey, 512, 11),
  greyGradient: () => gradientTexture('#3a3a3c', '#b4b4b6'),
};

const TEXTURE_USE = {
  acetate_havana: ['havana'],
  acetate_honey: ['honey'],
  lens_grey_gradient: ['greyGradient'],
};

/**
 * Lazily adds only the materials/textures a model uses. Returns `get(name) → material index`.
 */
export function materialRegistry(builder) {
  const tex = {};
  const mats = {};
  return (name) => {
    if (mats[name] !== undefined) return mats[name];
    for (const key of TEXTURE_USE[name] ?? []) {
      if (tex[key] === undefined) tex[key] = builder.addTexturePNG(TEXTURES[key](), key);
    }
    const def = LIBRARY[name](tex);
    mats[name] = builder.addMaterial({ name, ...def });
    return mats[name];
  };
}

/**
 * Variants per style: slot → material. Slots not listed fall back to `base`.
 * The first variant is the default material assignment in the file.
 */
export const VARIANTS = {
  aria: {
    base: { hinge: 'steel', lens: 'lens_clear' },
    variants: [
      { name: 'havana', slots: { frame: 'acetate_havana', temple: 'acetate_havana' } },
      { name: 'black', slots: { frame: 'acetate_black', temple: 'acetate_black' } },
      { name: 'crystal', slots: { frame: 'acetate_crystal', temple: 'acetate_crystal' } },
      { name: 'honey', slots: { frame: 'acetate_honey', temple: 'acetate_honey' } },
    ],
  },
  mira: {
    base: { hinge: 'steel', lens: 'lens_clear' },
    variants: [
      { name: 'black', slots: { frame: 'acetate_black', temple: 'acetate_black' } },
      { name: 'rose', slots: { frame: 'acetate_rose', temple: 'acetate_rose' } },
      { name: 'havana', slots: { frame: 'acetate_havana', temple: 'acetate_havana' } },
    ],
  },
  orbit: {
    base: { pad: 'pad_silicone', lens: 'lens_clear' },
    variants: [
      { name: 'gold', slots: { metal: 'metal_gold', tip: 'acetate_havana' } },
      { name: 'silver', slots: { metal: 'metal_silver', tip: 'acetate_black' } },
      { name: 'gunmetal', slots: { metal: 'metal_gunmetal', tip: 'acetate_black' } },
      { name: 'matte_black', slots: { metal: 'metal_black', tip: 'acetate_black' } },
    ],
  },
  pilot: {
    base: { pad: 'pad_silicone', tip: 'acetate_black' },
    variants: [
      { name: 'gold_g15', slots: { metal: 'metal_gold', lens: 'lens_g15' } },
      { name: 'silver_gradient', slots: { metal: 'metal_silver', lens: 'lens_grey_gradient' } },
      { name: 'gunmetal_mirror', slots: { metal: 'metal_gunmetal', lens: 'lens_blue_mirror' } },
    ],
  },
};
