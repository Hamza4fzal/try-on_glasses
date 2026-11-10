// Procedural textures for the dev eyewear models, encoded as PNG with no dependencies.
//   - tortoiseshell acetate: tileable, horizontally stretched blotches, domain-warped fBm
//   - vertical gradient tints for sunglass lenses
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes 8-bit RGB (channels=3) or RGBA (channels=4) pixels, row-major, top row first. */
export function encodePNG(width, height, pixels, channels = 3) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type RGBA / RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- noise

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise on a lattice that wraps with period (px, py) → tileable. */
function periodicNoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const m = (a, p) => ((a % p) + p) % p;
  const a = hash2(m(x0, px), m(y0, py), seed);
  const b = hash2(m(x0 + 1, px), m(y0, py), seed);
  const c = hash2(m(x0, px), m(y0 + 1, py), seed);
  const d = hash2(m(x0 + 1, px), m(y0 + 1, py), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Tileable fBm over the unit square: u, v ∈ [0, 1). */
function fbm(u, v, px, py, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 1 << o;
    sum += amp * periodicNoise(u * px * f, v * py * f, px * f, py * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ramp(stops, t) {
  if (t <= stops[0][0]) return hexToRgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      const s = k * k * (3 - 2 * k);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// ---------------------------------------------------------------- textures

export const TORTOISE_PALETTES = {
  havana: [
    [0.0, '#140803'],
    [0.34, '#2c1205'],
    [0.47, '#5e2a0b'],
    [0.6, '#9c5317'],
    [0.78, '#c57a2a'],
    [1.0, '#dc9a45'],
  ],
  honey: [
    [0.0, '#3a1f08'],
    [0.3, '#6e4314'],
    [0.5, '#b97b2c'],
    [0.7, '#d9a256'],
    [1.0, '#efcf8f'],
  ],
};

/**
 * Tileable tortoiseshell. One tile maps to TORTOISE_TILE_MM of frame (planar UVs in mm / tile).
 * Blotches are elongated horizontally like real sheet acetate, with domain warping for the
 * characteristic swirls and a fine speckle layer.
 */
export function tortoiseTexture(palette, size = 512, seed = 7) {
  const px = new Uint8Array(size * size * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      // Domain-warped fBm: irregular blotches, mildly elongated horizontally (sheet acetate).
      const wx = fbm(u, v, 4, 5, 4, seed + 101);
      const wy = fbm(u, v, 4, 5, 4, seed + 202);
      let n = fbm((u + 0.45 * wx + 1) % 1, (v + 0.45 * wy + 1) % 1, 4, 6, 5, seed);
      n = Math.min(1, Math.max(0, (n - 0.5) * 2.6 + 0.5)); // contrast
      const speck = fbm(u, v, 28, 34, 2, seed + 303);
      n = Math.min(1, Math.max(0, n + (speck - 0.5) * 0.22));
      const c = ramp(palette, n);
      const o = (j * size + i) * 3;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
    }
  }
  return encodePNG(size, size, px, 3);
}

export const TORTOISE_TILE_MM = 45;

/** Vertical gradient, RGB. Row 0 (glTF v = 0) is the top colour. */
export function gradientTexture(topHex, bottomHex, height = 128) {
  const a = hexToRgb(topHex), b = hexToRgb(bottomHex);
  const px = new Uint8Array(2 * height * 3);
  for (let j = 0; j < height; j++) {
    const t = j / (height - 1);
    const s = t < 0.15 ? 0 : t > 0.85 ? 1 : (t - 0.15) / 0.7; // flat dark top band, flat light bottom band
    const e = s * s * (3 - 2 * s);
    for (let i = 0; i < 2; i++) {
      const o = (j * 2 + i) * 3;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(a[k] + (b[k] - a[k]) * e);
    }
  }
  return encodePNG(2, height, px, 3);
}
