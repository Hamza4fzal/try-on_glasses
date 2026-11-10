// Geometry kernel for the parametric eyewear generator. All authoring is in millimetres.
//
// Every builder emits explicit per-vertex normals (smooth where the real object is smooth),
// then `fixWinding()` makes each triangle's winding agree with its normals, so builders never
// have to reason about index order.
import { Matrix3, ShapeUtils, Vector2, Vector3 } from 'three';

export class Mesh {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.i = [];
  }

  get count() {
    return this.p.length / 3;
  }

  v(x, y, z, nx, ny, nz, u = 0, w = 0) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z);
    this.n.push(nx / l, ny / l, nz / l);
    this.uv.push(u, w);
    return this.count - 1;
  }

  tri(a, b, c) {
    this.i.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  }

  append(m) {
    const o = this.count;
    for (const x of m.p) this.p.push(x);
    for (const x of m.n) this.n.push(x);
    for (const x of m.uv) this.uv.push(x);
    for (const k of m.i) this.i.push(k + o);
    return this;
  }

  /** Applies a three.js Matrix4 to positions and its normal matrix to normals. */
  applyMatrix4(m) {
    const nm = new Matrix3().getNormalMatrix(m);
    const v = new Vector3();
    for (let k = 0; k < this.p.length; k += 3) {
      v.set(this.p[k], this.p[k + 1], this.p[k + 2]).applyMatrix4(m);
      this.p[k] = v.x;
      this.p[k + 1] = v.y;
      this.p[k + 2] = v.z;
      v.set(this.n[k], this.n[k + 1], this.n[k + 2]).applyMatrix3(nm).normalize();
      this.n[k] = v.x;
      this.n[k + 1] = v.y;
      this.n[k + 2] = v.z;
    }
    return this;
  }

  translate(x, y, z) {
    for (let k = 0; k < this.p.length; k += 3) {
      this.p[k] += x;
      this.p[k + 1] += y;
      this.p[k + 2] += z;
    }
    return this;
  }

  /** z' = z + f(x, y); normals transformed exactly via the inverse-transpose Jacobian. */
  deformZ(f, grad) {
    const g = [0, 0];
    for (let k = 0; k < this.p.length; k += 3) {
      const x = this.p[k], y = this.p[k + 1];
      grad(x, y, g);
      this.p[k + 2] += f(x, y);
      const nx = this.n[k], ny = this.n[k + 1], nz = this.n[k + 2];
      const ax = nx - g[0] * nz, ay = ny - g[1] * nz;
      const l = Math.hypot(ax, ay, nz) || 1;
      this.n[k] = ax / l;
      this.n[k + 1] = ay / l;
      this.n[k + 2] = nz / l;
    }
    return this;
  }

  /** uvFn(x, y, z, nx, ny, nz) → [u, v] */
  setUV(uvFn) {
    for (let k = 0, t = 0; k < this.p.length; k += 3, t += 2) {
      const [u, v] = uvFn(this.p[k], this.p[k + 1], this.p[k + 2], this.n[k], this.n[k + 1], this.n[k + 2]);
      this.uv[t] = u;
      this.uv[t + 1] = v;
    }
    return this;
  }

  /** Make every triangle's geometric normal agree with its vertex normals. */
  fixWinding() {
    const P = this.p, N = this.n, I = this.i;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
      const sx = N[a] + N[b] + N[c], sy = N[a + 1] + N[b + 1] + N[c + 1], sz = N[a + 2] + N[b + 2] + N[c + 2];
      if (gx * sx + gy * sy + gz * sz < 0) {
        const tmp = I[t + 1];
        I[t + 1] = I[t + 2];
        I[t + 2] = tmp;
      }
    }
    return this;
  }

  /** Drop zero-area triangles (e.g. at degenerate cap tips). */
  removeDegenerate(eps = 1e-10) {
    const P = this.p, I = this.i, out = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const area2 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      if (area2 > eps) out.push(I[t], I[t + 1], I[t + 2]);
    }
    this.i = out;
    return this;
  }

  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < this.p.length; k++) {
      const a = k % 3;
      if (this.p[k] < min[a]) min[a] = this.p[k];
      if (this.p[k] > max[a]) max[a] = this.p[k];
    }
    return { min, max };
  }

  /** Export for the glTF builder, converting mm → m. */
  toGeometry(scale = 0.001) {
    return {
      positions: this.p.map((x) => x * scale),
      normals: this.n.slice(),
      uvs: this.uv.slice(),
      indices: this.i.slice(),
    };
  }
}

// ------------------------------------------------------------------ profiles (2D cross-sections)
// A profile is an array of { a, b, na, nb }: point and outward normal in the sweep's (N, B) plane.

export function circleProfile(r, segments = 12) {
  const out = [];
  for (let j = 0; j < segments; j++) {
    const t = (j / segments) * Math.PI * 2;
    out.push({ a: r * Math.cos(t), b: r * Math.sin(t), na: Math.cos(t), nb: Math.sin(t) });
  }
  return out;
}

export function ellipseProfile(ra, rb, segments = 16) {
  const out = [];
  for (let j = 0; j < segments; j++) {
    const t = (j / segments) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    out.push({ a: ra * c, b: rb * s, na: c / ra, nb: s / rb });
  }
  return out;
}

/** Rounded rectangle with half extents (ha, hb) and corner radius rc. */
export function roundedRectProfile(ha, hb, rc, perCorner = 4) {
  rc = Math.min(rc, ha * 0.999, hb * 0.999);
  const out = [];
  const corners = [
    [ha - rc, hb - rc, 0],
    [-(ha - rc), hb - rc, Math.PI / 2],
    [-(ha - rc), -(hb - rc), Math.PI],
    [ha - rc, -(hb - rc), (3 * Math.PI) / 2],
  ];
  for (const [ca, cb, start] of corners) {
    for (let k = 0; k <= perCorner; k++) {
      const t = start + (k / perCorner) * (Math.PI / 2);
      out.push({ a: ca + rc * Math.cos(t), b: cb + rc * Math.sin(t), na: Math.cos(t), nb: Math.sin(t) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ sweep

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function rotateAbout(v, axis, angle) {
  // Rodrigues
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = axis, kv = cross(k, v), kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

/**
 * Sweep a cross-section along a polyline.
 * opts:
 *   closed      loop path
 *   profile     (t ∈ [0,1]) → profile array; all rings must have the same length
 *   frame       'transport' (rotation-minimising, initial N from `up`) | 'planarZ' (N in the XY plane, B = +Z)
 *   up          initial N hint for 'transport'
 *   capStart/capEnd  null | 'flat' | 'round'
 *   uv          (x, y, z, nx, ny, nz) → [u, v]; default: arclength / profile angle
 */
export function sweep(path, opts) {
  const { closed = false, profile, frame = 'transport', up = [0, 1, 0], capStart = null, capEnd = null, uv } = opts;
  const n = path.length;
  const T = [];
  for (let i = 0; i < n; i++) {
    let a, b;
    if (closed) {
      a = path[(i - 1 + n) % n];
      b = path[(i + 1) % n];
    } else {
      a = path[Math.max(0, i - 1)];
      b = path[Math.min(n - 1, i + 1)];
    }
    T.push(norm(sub(b, a)));
  }
  const N = [], B = [];
  if (frame === 'planarZ') {
    for (let i = 0; i < n; i++) {
      const Ni = norm(cross(T[i], [0, 0, 1]));
      N.push(Ni);
      B.push(norm(cross(Ni, T[i])));
    }
  } else {
    let n0 = sub(up, T[0].map((t) => t * dot(up, T[0])));
    if (Math.hypot(...n0) < 1e-6) n0 = Math.abs(T[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    N.push(norm(n0));
    for (let i = 1; i < n; i++) {
      const ax = cross(T[i - 1], T[i]);
      const s = Math.hypot(...ax);
      let Ni = N[i - 1];
      if (s > 1e-9) Ni = rotateAbout(Ni, norm(ax), Math.atan2(s, dot(T[i - 1], T[i])));
      Ni = norm(sub(Ni, T[i].map((t) => t * dot(Ni, T[i]))));
      N.push(Ni);
    }
    for (let i = 0; i < n; i++) B.push(norm(cross(T[i], N[i])));
  }

  const mesh = new Mesh();
  const rings = [];
  let arc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) arc += Math.hypot(...sub(path[i], path[i - 1]));
    const prof = profile(closed ? i / n : i / (n - 1), i);
    const ring = [];
    prof.forEach((pt, j) => {
      const P = path[i];
      const x = P[0] + N[i][0] * pt.a + B[i][0] * pt.b;
      const y = P[1] + N[i][1] * pt.a + B[i][1] * pt.b;
      const z = P[2] + N[i][2] * pt.a + B[i][2] * pt.b;
      const nx = N[i][0] * pt.na + B[i][0] * pt.nb;
      const ny = N[i][1] * pt.na + B[i][1] * pt.nb;
      const nz = N[i][2] * pt.na + B[i][2] * pt.nb;
      ring.push(mesh.v(x, y, z, nx, ny, nz, arc / 20, j / prof.length));
    });
    rings.push({ ring, prof, i });
  }
  const segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const r0 = rings[s].ring, r1 = rings[(s + 1) % n].ring;
    const m = r0.length;
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      mesh.quad(r0[j], r0[j1], r1[j1], r1[j]);
    }
  }

  const addCap = (end, kind) => {
    const i = end ? n - 1 : 0;
    const dir = end ? T[i] : T[i].map((t) => -t);
    const P = path[i];
    const prof = rings[i].prof;
    if (kind === 'flat') {
      const c = mesh.v(P[0], P[1], P[2], dir[0], dir[1], dir[2]);
      const ring = prof.map((pt) =>
        mesh.v(
          P[0] + N[i][0] * pt.a + B[i][0] * pt.b,
          P[1] + N[i][1] * pt.a + B[i][1] * pt.b,
          P[2] + N[i][2] * pt.a + B[i][2] * pt.b,
          dir[0], dir[1], dir[2],
        ),
      );
      for (let j = 0; j < ring.length; j++) mesh.tri(c, ring[j], ring[(j + 1) % ring.length]);
    } else if (kind === 'round') {
      const rc = prof.reduce((s, pt) => s + Math.hypot(pt.a, pt.b), 0) / prof.length;
      const K = 4;
      let prev = rings[i].ring;
      for (let k = 1; k <= K; k++) {
        const phi = (k / K) * (Math.PI / 2);
        const c = Math.cos(phi), s = Math.sin(phi);
        const ring = prof.map((pt) => {
          const x = P[0] + (N[i][0] * pt.a + B[i][0] * pt.b) * c + dir[0] * rc * s;
          const y = P[1] + (N[i][1] * pt.a + B[i][1] * pt.b) * c + dir[1] * rc * s;
          const z = P[2] + (N[i][2] * pt.a + B[i][2] * pt.b) * c + dir[2] * rc * s;
          const nx = (N[i][0] * pt.na + B[i][0] * pt.nb) * c + dir[0] * s;
          const ny = (N[i][1] * pt.na + B[i][1] * pt.nb) * c + dir[1] * s;
          const nz = (N[i][2] * pt.na + B[i][2] * pt.nb) * c + dir[2] * s;
          return mesh.v(x, y, z, nx, ny, nz);
        });
        for (let j = 0; j < ring.length; j++) {
          const j1 = (j + 1) % ring.length;
          mesh.quad(prev[j], prev[j1], ring[j1], ring[j]);
        }
        prev = ring;
      }
    }
  };
  if (!closed) {
    if (capStart) addCap(false, capStart);
    if (capEnd) addCap(true, capEnd);
  }
  if (uv) mesh.setUV(uv);
  return mesh.removeDegenerate().fixWinding();
}

/** Straight cylinder between two points (flat caps). */
export function cylinder(a, b, r, segments = 16) {
  const steps = 2;
  const path = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  const prof = circleProfile(r, segments);
  const T = norm(sub(b, a));
  const up = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return sweep(path, { profile: () => prof, up, capStart: 'flat', capEnd: 'flat' });
}

/** Ellipsoid centred at the origin. */
export function ellipsoid(rx, ry, rz, wSeg = 20, hSeg = 12) {
  const m = new Mesh();
  const rows = [];
  for (let y = 0; y <= hSeg; y++) {
    const th = (y / hSeg) * Math.PI;
    const row = [];
    for (let x = 0; x <= wSeg; x++) {
      const ph = (x / wSeg) * Math.PI * 2;
      const ux = Math.sin(th) * Math.cos(ph), uy = Math.cos(th), uz = Math.sin(th) * Math.sin(ph);
      row.push(m.v(ux * rx, uy * ry, uz * rz, ux / rx, uy / ry, uz / rz, x / wSeg, y / hSeg));
    }
    rows.push(row);
  }
  for (let y = 0; y < hSeg; y++) {
    for (let x = 0; x < wSeg; x++) m.quad(rows[y][x], rows[y][x + 1], rows[y + 1][x + 1], rows[y + 1][x]);
  }
  return m.removeDegenerate().fixWinding();
}

// ------------------------------------------------------------------ 2D helpers

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export const ccw = (pts) => (signedArea(pts) >= 0 ? pts.slice() : pts.slice().reverse());
export const cw = (pts) => (signedArea(pts) < 0 ? pts.slice() : pts.slice().reverse());

/** Per-vertex unit normals pointing to the RIGHT of travel (= outward for CCW, into the hole for CW). */
export function contourNormals(pts) {
  const n = pts.length;
  return pts.map((_, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  });
}

// ------------------------------------------------------------------ rounded extrusion

/**
 * Extrudes a 2D region (outer contour + holes) from z = 0 (back) to z = depth (front) with fully
 * rounded edges of radius r — the profile of a polished acetate front. Smooth normals everywhere.
 */
export function roundedExtrude(outer, holes, depth, r, segs = 5) {
  const contours = [ccw(outer), ...holes.map(cw)];
  const normals = contours.map(contourNormals);
  const m = new Mesh();

  // Edge band: back quarter-arc, straight wall, front quarter-arc.
  const steps = [];
  for (let k = 0; k <= segs; k++) {
    const th = (k / segs) * (Math.PI / 2);
    steps.push({ off: -r + r * Math.sin(th), z: r - r * Math.cos(th), ns: Math.sin(th), nz: -Math.cos(th) });
  }
  for (let k = 0; k <= segs; k++) {
    const th = Math.PI / 2 + (k / segs) * (Math.PI / 2);
    steps.push({ off: -r + r * Math.sin(th), z: depth - r - r * Math.cos(th), ns: Math.sin(th), nz: -Math.cos(th) });
  }
  contours.forEach((C, ci) => {
    const Nn = normals[ci];
    const rings = steps.map((st) =>
      C.map((p, i) =>
        m.v(p[0] + Nn[i][0] * st.off, p[1] + Nn[i][1] * st.off, st.z, Nn[i][0] * st.ns, Nn[i][1] * st.ns, st.nz),
      ),
    );
    for (let s = 0; s < rings.length - 1; s++) {
      const r0 = rings[s], r1 = rings[s + 1];
      for (let i = 0; i < C.length; i++) {
        const i1 = (i + 1) % C.length;
        m.quad(r0[i], r0[i1], r1[i1], r1[i]);
      }
    }
  });

  // Flat caps on the inset contours.
  const inset = contours.map((C, ci) => C.map((p, i) => new Vector2(p[0] - normals[ci][i][0] * r, p[1] - normals[ci][i][1] * r)));
  const faces = ShapeUtils.triangulateShape(inset[0], inset.slice(1));
  const flat = inset.flat();
  for (const [z, nz] of [[0, -1], [depth, 1]]) {
    const base = m.count;
    for (const p of flat) m.v(p.x, p.y, z, 0, 0, nz);
    for (const f of faces) m.tri(base + f[0], base + f[1], base + f[2]);
  }
  return m.removeDegenerate().fixWinding();
}

// ------------------------------------------------------------------ lens

/**
 * Lens blank: front and back surfaces meshed as concentric rings (so a later sag deformation
 * curves them smoothly) plus the edge band. Outline must be star-shaped about `centre`.
 */
export function lensMesh(outline, centre, zMid, thickness, rings = 10) {
  const C = ccw(outline);
  const Nn = contourNormals(C);
  const m = new Mesh();
  for (const [z, nz] of [[zMid + thickness / 2, 1], [zMid - thickness / 2, -1]]) {
    const c = m.v(centre[0], centre[1], z, 0, 0, nz);
    let prev = null;
    for (let k = 1; k <= rings; k++) {
      const t = k / rings;
      const ring = C.map((p) => m.v(centre[0] + (p[0] - centre[0]) * t, centre[1] + (p[1] - centre[1]) * t, z, 0, 0, nz));
      for (let i = 0; i < C.length; i++) {
        const i1 = (i + 1) % C.length;
        if (prev) m.quad(prev[i], prev[i1], ring[i1], ring[i]);
        else m.tri(c, ring[i], ring[i1]);
      }
      prev = ring;
    }
  }
  const top = C.map((p, i) => m.v(p[0], p[1], zMid + thickness / 2, Nn[i][0], Nn[i][1], 0));
  const bot = C.map((p, i) => m.v(p[0], p[1], zMid - thickness / 2, Nn[i][0], Nn[i][1], 0));
  for (let i = 0; i < C.length; i++) {
    const i1 = (i + 1) % C.length;
    m.quad(top[i], top[i1], bot[i1], bot[i]);
  }
  return m.removeDegenerate().fixWinding();
}
