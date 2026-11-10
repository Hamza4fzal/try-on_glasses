/**
 * Product catalogue: the per-product data the try-on needs. In the standalone app it comes from
 * public/products/products.json; in WordPress it will come from WooCommerce product meta. Every
 * value is sanitised and clamped on load, so a bad admin entry can never break the renderer.
 */

export type Vec3Tuple = [number, number, number];

/**
 * Per-model fit calibration. Applied on top of the model's physical (true-size) geometry.
 * Axes are the wearer's face axes: +x = wearer's left, +y = up, +z = away from the face.
 */
export interface Calibration {
  /** Multiplier on the model's authored physical size (1 = exactly as modelled). */
  scale: number;
  /** Translation from the nose rest, in real millimetres. */
  offsetMm: Vec3Tuple;
  /** Rotation about the nose rest in degrees: x = pantoscopic tilt (+ = lower rim towards the cheeks), y = yaw, z = roll. */
  rotationDeg: Vec3Tuple;
  /** Where on the nose the frame rests: 0 = nasion (landmark 168), 1 = lower bridge (landmark 6). */
  bridgeAlignment: number;
  /** Aim the temples at the ears automatically (recommended). */
  templeAutoFit: boolean;
  /** Added to the temple spread (degrees, + = outwards). */
  templeSpreadDeg: number;
  /** Added to the temple droop (degrees, + = tips down). */
  templeDroopDeg: number;
  /**
   * 0 = true physical size on every face (iris-calibrated); 1 = scale with the face like the
   * canonical model (every face sees the same relative fit). In between blends the two.
   */
  faceWidthAdaptation: number;
}

export interface MaterialOverride {
  color?: string;
  roughness?: number;
  metalness?: number;
  /** Lens tint strength 0..1 for transmissive slots. */
  transmission?: number;
}

export interface ProductVariant {
  id: string;
  label: string;
  /** CSS colour for the swatch. */
  swatch: string;
  /** Name of a KHR_materials_variants variant inside the model. */
  gltfVariant?: string;
  /** Extra per-slot material overrides (slot → override), applied after gltfVariant. */
  materialOverrides?: Record<string, MaterialOverride>;
  /** Product photo of this colourway (URL, resolved relative to the catalogue). */
  image?: string;
}

export interface FrameSize {
  lensWidthMm?: number;
  bridgeMm?: number;
  templeLengthMm?: number;
  lensHeightMm?: number;
  frameWidthMm?: number;
}

export interface ProductConfig {
  id: string;
  name: string;
  sku?: string;
  price?: string;
  enabled: boolean;
  /** GLB URL, resolved relative to the catalogue URL. */
  model: string;
  /** Product photo / thumbnail URL (optional, resolved relative to the catalogue URL). */
  image?: string;
  frame: FrameSize;
  calibration: Calibration;
  variants: ProductVariant[];
  defaultVariant?: string;
}

export interface Catalog {
  version: 1;
  products: ProductConfig[];
}

export const DEFAULT_CALIBRATION: Readonly<Calibration> = Object.freeze({
  scale: 1,
  offsetMm: [0, 0, 0] as Vec3Tuple,
  rotationDeg: [0, 0, 0] as Vec3Tuple,
  // Frame rests ≈ 4–5 mm above the inner eye corners (canonical 168 is ≈ 6.8 mm above, 6 ≈ 1.2 mm
  // below), which puts the pupils 0–4 mm above the lens centre for typical optical frames.
  bridgeAlignment: 0.25,
  templeAutoFit: true,
  templeSpreadDeg: 0,
  templeDroopDeg: 0,
  faceWidthAdaptation: 0,
});

/** Allowed ranges (also drive the calibration UI sliders). */
export const CALIBRATION_LIMITS = {
  scale: [0.8, 1.25],
  offsetMm: [-15, 15],
  rotationDeg: [-20, 20],
  bridgeAlignment: [-0.5, 1.5],
  templeSpreadDeg: [-10, 20],
  templeDroopDeg: [-15, 15],
  faceWidthAdaptation: [0, 1],
} as const;

const num = (v: unknown, def: number, [lo, hi]: readonly [number, number]): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const vec = (v: unknown, def: Vec3Tuple, range: readonly [number, number]): Vec3Tuple => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0], def[0], range), num(a[1], def[1], range), num(a[2], def[2], range)];
};

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const CSS_COLOR = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** Relative URLs or http(s) only (no javascript:/data: etc.). */
const url = (v: unknown): string | undefined => {
  const s = str(v, 500);
  if (!s) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' ? s : undefined;
};

export function sanitizeCalibration(input: unknown): Calibration {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_CALIBRATION;
  const L = CALIBRATION_LIMITS;
  return {
    scale: num(o.scale, d.scale, L.scale),
    offsetMm: vec(o.offsetMm, d.offsetMm, L.offsetMm),
    rotationDeg: vec(o.rotationDeg, d.rotationDeg, L.rotationDeg),
    bridgeAlignment: num(o.bridgeAlignment, d.bridgeAlignment, L.bridgeAlignment),
    templeAutoFit: typeof o.templeAutoFit === 'boolean' ? o.templeAutoFit : d.templeAutoFit,
    templeSpreadDeg: num(o.templeSpreadDeg, d.templeSpreadDeg, L.templeSpreadDeg),
    templeDroopDeg: num(o.templeDroopDeg, d.templeDroopDeg, L.templeDroopDeg),
    faceWidthAdaptation: num(o.faceWidthAdaptation, d.faceWidthAdaptation, L.faceWidthAdaptation),
  };
}

function sanitizeOverride(input: unknown): MaterialOverride | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const out: MaterialOverride = {};
  if (typeof o.color === 'string' && CSS_COLOR.test(o.color)) out.color = o.color;
  if (o.roughness !== undefined) out.roughness = num(o.roughness, 0.3, [0, 1]);
  if (o.metalness !== undefined) out.metalness = num(o.metalness, 0, [0, 1]);
  if (o.transmission !== undefined) out.transmission = num(o.transmission, 1, [0, 1]);
  return Object.keys(out).length ? out : undefined;
}

function sanitizeVariant(input: unknown): ProductVariant | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const id = str(o.id, 64);
  if (!id) return null;
  const overrides: Record<string, MaterialOverride> = {};
  if (o.materialOverrides && typeof o.materialOverrides === 'object') {
    for (const [slot, v] of Object.entries(o.materialOverrides as Record<string, unknown>)) {
      const s = sanitizeOverride(v);
      if (s && /^[a-z0-9_-]{1,32}$/i.test(slot)) overrides[slot] = s;
    }
  }
  const swatch = typeof o.swatch === 'string' && CSS_COLOR.test(o.swatch) ? o.swatch : '#888888';
  return {
    id,
    label: str(o.label, 80) ?? id,
    swatch,
    gltfVariant: str(o.gltfVariant, 64),
    materialOverrides: Object.keys(overrides).length ? overrides : undefined,
    image: url(o.image),
  };
}

export function sanitizeProduct(input: unknown): ProductConfig | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const id = str(o.id, 64);
  const model = str(o.model, 500);
  if (!id || !model || !/\.glb(\?.*)?$/i.test(model)) return null;
  const f = (o.frame && typeof o.frame === 'object' ? o.frame : {}) as Record<string, unknown>;
  const mm = (v: unknown) => (typeof v === 'number' && v > 0 && v < 300 ? v : undefined);
  const variants = (Array.isArray(o.variants) ? o.variants : []).map(sanitizeVariant).filter((v): v is ProductVariant => !!v);
  return {
    id,
    name: str(o.name, 120) ?? id,
    sku: str(o.sku, 64),
    price: str(o.price, 32),
    enabled: o.enabled !== false,
    model,
    image: url(o.image),
    frame: {
      lensWidthMm: mm(f.lensWidthMm),
      bridgeMm: mm(f.bridgeMm),
      templeLengthMm: mm(f.templeLengthMm),
      lensHeightMm: mm(f.lensHeightMm),
      frameWidthMm: mm(f.frameWidthMm),
    },
    calibration: sanitizeCalibration(o.calibration),
    variants,
    defaultVariant: variants.some((v) => v.id === o.defaultVariant) ? (o.defaultVariant as string) : variants[0]?.id,
  };
}

/** Loads and sanitises the catalogue; model URLs are resolved against the catalogue URL. */
export async function loadCatalog(url: string): Promise<Catalog> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Catalogue ${url}: HTTP ${res.status}`);
  const raw = (await res.json()) as { products?: unknown[] };
  const base = new URL(url, location.href);
  const products = (raw.products ?? [])
    .map(sanitizeProduct)
    .filter((p): p is ProductConfig => !!p)
    .map((p) => ({
      ...p,
      model: new URL(p.model, base).href,
      image: p.image && new URL(p.image, base).href,
      variants: p.variants.map((v) => ({ ...v, image: v.image && new URL(v.image, base).href })),
    }));
  return { version: 1, products };
}

/** Serialise a calibration compactly (rounded) for copy-paste into the catalogue / WP meta. */
export function calibrationToJSON(c: Calibration): string {
  const r = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return JSON.stringify(
    {
      scale: r(c.scale, 3),
      offsetMm: c.offsetMm.map((v) => r(v, 1)),
      rotationDeg: c.rotationDeg.map((v) => r(v, 1)),
      bridgeAlignment: r(c.bridgeAlignment),
      templeAutoFit: c.templeAutoFit,
      templeSpreadDeg: r(c.templeSpreadDeg, 1),
      templeDroopDeg: r(c.templeDroopDeg, 1),
      faceWidthAdaptation: r(c.faceWidthAdaptation),
    },
    null,
    2,
  );
}
