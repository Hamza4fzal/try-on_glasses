// Parametric eyewear builders + the dev catalogue's frame designs.
//
// Glasses space (see docs/MODEL_SPEC.md): millimetres here (converted to metres on export),
// +X = wearer's LEFT, +Y = up, +Z = forward (out of the face). After building, everything is
// translated so the ORIGIN is the nose-rest point.
import { CatmullRomCurve3, Matrix4, Vector3 } from 'three';
import {
  Mesh,
  circleProfile,
  cylinder,
  ellipseProfile,
  ellipsoid,
  lensMesh,
  roundedExtrude,
  roundedRectProfile,
  sweep,
} from './mesh.mjs';
import {
  compilePolygon,
  contours,
  lensOutline,
  mirrorX,
  offsetClosed,
  resampleClosed,
  sdEllipse,
  sdRoundBox,
  signedArea,
  smin,
  smoothClosed,
  translate2,
} from './outline.mjs';
import { TORTOISE_TILE_MM } from './textures.mjs';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ shared pieces

/**
 * Front curvature: each lens is a spherical cap (radius R about its own centre) and the two
 * halves are rotated by the face-form wrap angle, so the temporal sides sweep back toward the
 * head. z' = z + f(x, y).
 */
function frontDeform(xc, R, wrapDeg) {
  const s = Math.tan(wrapDeg * DEG);
  return {
    f: (x, y) => {
      const cx = x >= 0 ? xc : -xc;
      return -((x - cx) ** 2 + y * y) / (2 * R) - s * (Math.abs(x) - xc);
    },
    grad: (x, y, g) => {
      const cx = x >= 0 ? xc : -xc;
      g[0] = -(x - cx) / R - s * (x >= 0 ? 1 : -1);
      g[1] = -y / R;
    },
  };
}

const acetateUV = (x, y) => [x / TORTOISE_TILE_MM, -y / TORTOISE_TILE_MM];
const templeUV = (x, y, z) => [-z / TORTOISE_TILE_MM, -y / TORTOISE_TILE_MM];

function lensUV(cx, W, H) {
  return (x, y) => [(x - cx) / W + 0.5, 0.5 - y / H];
}

function nearestOn(poly, x, y) {
  let best = poly[0], bd = Infinity;
  for (const p of poly) {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function curve(points, samples) {
  return new CatmullRomCurve3(points.map((p) => new Vector3(...p)), false, 'centripetal')
    .getPoints(samples)
    .map((v) => [v.x, v.y, v.z]);
}

function mirrorMesh(m) {
  const out = new Mesh();
  out.append(m);
  for (let k = 0; k < out.p.length; k += 3) {
    out.p[k] = -out.p[k];
    out.n[k] = -out.n[k];
  }
  return out.fixWinding();
}

/** Temple centreline in temple-local space (pivot at origin), pointing −Z, bending down at L1. */
function templePath(t) {
  const pts = [];
  const step = 2;
  for (let z = 0; z > -t.L1; z -= step) pts.push([0, 0, z]);
  pts.push([0, 0, -t.L1]);
  const a = t.bendDeg * DEG;
  for (let k = 1; k <= 12; k++) {
    const ang = (k / 12) * a;
    pts.push([0, -t.bendR + t.bendR * Math.cos(ang), -t.L1 - t.bendR * Math.sin(ang)]);
  }
  const yb = -t.bendR + t.bendR * Math.cos(a), zb = -t.L1 - t.bendR * Math.sin(a);
  const tail = t.length - t.L1 - t.bendR * a;
  const nTail = Math.max(4, Math.round(tail / step));
  for (let k = 1; k <= nTail; k++) {
    const d = (k / nTail) * tail;
    pts.push([0, yb - Math.sin(a) * d, zb - Math.cos(a) * d]);
  }
  // Arclength + inward hug behind the ear.
  const arc = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = arc[arc.length - 1];
  for (let i = 0; i < pts.length; i++) {
    const u = (arc[i] - t.L1 + 10) / (total - t.L1 + 10);
    pts[i][0] -= t.inward * smooth(u);
  }
  return { pts, arc, total };
}

/**
 * Barrel hinge on the vertical axis through the pivot: the front knuckle sits above the pivot,
 * the temple knuckle below it, plus a screw head on top. Returns { front, temple } in
 * pivot-relative coordinates.
 */
function barrelHinge(r = 1.0, h = 2.5) {
  const front = cylinder([0, 0.15, 0], [0, 0.15 + h, 0], r, 16);
  front.append(cylinder([0, 0.15 + h, 0], [0, 0.55 + h, 0], r * 0.78, 16)); // screw head
  const slot = cylinder([0, 0.5 + h, 0], [0, 0.6 + h, 0], r * 0.2, 8); // tiny screw-slot cap
  front.append(slot);
  const temple = cylinder([0, -0.15, 0], [0, -0.15 - h, 0], r, 16);
  return { front, temple };
}

// ------------------------------------------------------------------ acetate builder

export function buildAcetate(d) {
  const W = d.lens.width, H = d.lens.height;
  const xc = d.dbl / 2 + W / 2;
  const local = lensOutline(d.lens);
  const lensL = translate2(local, xc, 0);
  const lensR = translate2(mirrorX(local), -xc, 0);
  const sdL = compilePolygon(resampleClosed(lensL, 160));
  const sdR = compilePolygon(resampleClosed(lensR, 160));
  const rim = d.rim;
  const rimW = (dx, dy) => {
    const l2 = dx * dx + dy * dy || 1;
    return (dx * dx * (dx > 0 ? rim.temporal : rim.nasal) + dy * dy * (dy > 0 ? rim.top : rim.bottom)) / l2;
  };
  const hingeY = d.hingeY;
  const field = (x, y) => {
    let F = smin(sdL(x, y) - rimW(x - xc, y), sdR(x, y) - rimW(-(x + xc), y), 2);
    const b = d.bridge;
    F = smin(F, sdRoundBox(x, y, 0, (b.bottom + b.top) / 2, d.dbl / 2 + 3, (b.top - b.bottom) / 2, b.radius), b.fillet);
    for (const sx of [1, -1]) {
      const e = d.endpiece;
      F = smin(F, sdRoundBox(x, y, sx * (xc + W / 2 + rim.temporal - e.inset), hingeY + e.dy, e.hx, e.hy, e.r), e.fillet);
      if (d.wing) {
        const w = d.wing;
        F = smin(F, sdEllipse(x, y, sx * (xc + w.x), w.y, w.rx, w.ry, sx * w.angle), w.k);
      }
    }
    return F;
  };
  const X = xc + W / 2 + 22, Y0 = -H / 2 - 16, Y1 = H / 2 + 22;
  const loops = contours(field, -X, Y0, X, Y1, 0.3);
  const outerRaw = loops.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
  const perimeter = outerRaw.reduce((s, p, i) => s + Math.hypot(p[0] - outerRaw[(i + 1) % outerRaw.length][0], p[1] - outerRaw[(i + 1) % outerRaw.length][1]), 0);
  let outer = resampleClosed(outerRaw, Math.round(perimeter / 0.6));
  outer = smoothClosed(outer, 4, 0.5);
  if (signedArea(outer) < 0) outer.reverse();

  const t = d.front.thickness;
  const frame = roundedExtrude(outer, [lensL, lensR], t, d.front.edgeR, 5).setUV(acetateUV);

  // Nose rest: lowest solid point of the bridge on the symmetry plane.
  let yArch = -H / 2;
  while (field(0, yArch) > 0 && yArch < H) yArch += 0.05;

  const lensT = d.lensThickness ?? 1.8;
  const lenses = [lensL, lensR].map((L, i) =>
    lensMesh(offsetClosed(L, 0.7), [i === 0 ? xc : -xc, 0], t * 0.5, lensT, 10).setUV(lensUV(i === 0 ? xc : -xc, W, H)),
  );

  // Outer edge at hinge height → temple placement.
  let xEdge = 0;
  for (const p of outer) if (Math.abs(p[1] - hingeY) < 1.2 && p[0] > xEdge) xEdge = p[0];

  const hinge = barrelHinge(0.95, 2.4);
  const tw = d.temple.w0;
  const pivotLocal = [xEdge - tw - 1.0, hingeY, -0.9]; // undeformed; z behind the back face
  const metalBits = new Mesh();
  metalBits.append(hinge.front).translate(...pivotLocal);
  const mirroredFrontHinge = mirrorMesh(metalBits);
  metalBits.append(mirroredFrontHinge);
  if (d.rivets) {
    for (const sx of [1, -1]) {
      for (const dy of [-2.2, 2.2]) {
        const r = ellipsoid(0.85, 0.85, 0.35, 12, 8);
        r.translate(sx * (xEdge - 4.2), hingeY + dy + d.endpiece.dy, t + 0.02);
        metalBits.append(r);
      }
    }
  }

  const def = frontDeform(xc, d.baseR, d.wrapDeg);
  for (const m of [frame, ...lenses, metalBits]) m.deformZ(def.f, def.grad);
  const zBackBridge = def.f(0, yArch);
  const origin = [0, yArch, zBackBridge];
  const pivot = [pivotLocal[0], pivotLocal[1], pivotLocal[2] + def.f(pivotLocal[0], pivotLocal[1])];

  // Temple (left), local to pivot. Body starts beside the hinge axis (outer side).
  const path = templePath(d.temple);
  const tp = d.temple;
  const off = [tw / 2 + 1.0, 0, 0.6];
  const body = sweep(
    path.pts.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]),
    {
      profile: (_, i) => {
        const s = path.arc[i];
        const u = s / tp.L1;
        const h = s <= tp.L1 ? lerp(tp.h0, tp.h1, smooth(u * 1.4)) : lerp(tp.h1, tp.h2, smooth((s - tp.L1) / (path.total - tp.L1)));
        const w = s <= tp.L1 ? lerp(tp.w0, tp.w1, smooth(u)) : lerp(tp.w1, tp.w2, smooth((s - tp.L1) / (path.total - tp.L1)));
        return roundedRectProfile(h / 2, w / 2, Math.min(1.3, w * 0.42), 4);
      },
      up: [0, 1, 0],
      capStart: 'flat',
      capEnd: 'round',
    },
  ).setUV(templeUV);
  const templeHinge = hinge.temple;

  return finish({
    d,
    origin,
    xc,
    lensT,
    lensZ: t * 0.5,
    front: [
      { name: 'frame', slot: 'frame', mesh: frame },
      { name: 'lens_L', slot: 'lens', mesh: lenses[0] },
      { name: 'lens_R', slot: 'lens', mesh: lenses[1] },
      { name: 'hardware', slot: 'hinge', mesh: metalBits },
    ],
    temple: {
      pivot,
      parts: [
        { name: 'body', slot: 'temple', mesh: body },
        { name: 'hinge', slot: 'hinge', mesh: templeHinge },
      ],
      earBend: [off[0] - tp.inward * 0.1, 0, -tp.L1 + off[2]],
    },
    def,
  });
}

// ------------------------------------------------------------------ metal builder

export function buildMetal(d) {
  const W = d.lens.width, H = d.lens.height;
  const xc = d.dbl / 2 + W / 2;
  const local = lensOutline(d.lens);
  const lensL = translate2(local, xc, 0);
  const lensR = translate2(mirrorX(local), -xc, 0);
  const r = d.rim;

  const metal = new Mesh();
  // Rims: wire swept around each lens, B = +Z (planar frame → no twist).
  for (const L of [lensL, lensR]) {
    const c = offsetClosed(L, r.ra * 0.55).map(([x, y]) => [x, y, 0]);
    const prof = ellipseProfile(r.ra, r.rb, 12);
    metal.append(sweep(c, { closed: true, frame: 'planarZ', profile: () => prof }));
  }
  const rimL = offsetClosed(lensL, r.ra * 0.55);

  // Bridges (left half defined, mirrored for symmetry).
  const bridgeProf = ellipseProfile(d.bridge.ra, d.bridge.rb, 12);
  for (const br of d.bridges) {
    const a = nearestOn(rimL, xc + br.from[0], br.from[1]);
    const pts = curve(
      [[-a[0], a[1], 0], ...br.via.slice().reverse().map(([x, y, z]) => [-x, y, z]), ...br.apex.map((p) => p), ...br.via, [a[0], a[1], 0]],
      64,
    );
    metal.append(sweep(pts, { profile: () => bridgeProf, up: [0, 0, 1], capStart: 'round', capEnd: 'round' }));
  }

  // End pieces → hinge, left then mirrored.
  const hy = d.hingeY;
  const xh = xc + W / 2 + d.endpiece.len;
  const zh = -d.endpiece.back;
  const e0 = nearestOn(rimL, xc + W / 2 + 2, hy);
  const endPts = curve([[e0[0] - 0.8, e0[1], 0], [e0[0] + 1.5, hy, -0.2], [xh - 1.2, hy, zh * 0.6], [xh, hy, zh + 0.4]], 24);
  const endProf = ellipseProfile(d.endpiece.ra, d.endpiece.rb, 12);
  const endpiece = sweep(endPts, { profile: () => endProf, up: [0, 1, 0], capStart: 'round', capEnd: 'round' });
  metal.append(endpiece);
  metal.append(mirrorMesh(endpiece));

  const hinge = barrelHinge(0.95, 2.3);
  const frontHinge = new Mesh().append(hinge.front).translate(xh, hy, zh);
  metal.append(frontHinge);
  metal.append(mirrorMesh(frontHinge));

  // Nose pads: silicone pads facing the sides of the nose, on wire arms from the rims.
  const p = d.pads;
  const padAngle = p.faceDeg * DEG; // pad face normal (outward, away from nose) = (sin, 0, cos)
  const padNormal = [Math.sin(padAngle), 0, Math.cos(padAngle)];
  const padsMesh = new Mesh();
  const armsMesh = new Mesh();
  {
    // Thin along X, then rotated about Y so X → padNormal (the face lies along the nose side).
    const pad = ellipsoid(p.thickness / 2, p.h / 2, p.w / 2, 18, 12);
    pad.applyMatrix4(new Matrix4().makeRotationY(padAngle - Math.PI / 2));
    pad.translate(p.x, p.y, p.z);
    padsMesh.append(pad);
    padsMesh.append(mirrorMesh(pad));
    const a0 = nearestOn(rimL, xc - W / 2 + 1.5, p.y + p.armRise);
    const back = [p.x + padNormal[0] * (p.thickness * 0.6), p.y, p.z + padNormal[2] * (p.thickness * 0.6)];
    const armPts = curve(
      [[a0[0] - 0.5, a0[1], -0.3], [a0[0] - 1.6, a0[1] - 1.5, -3.2], [back[0] + 1.6, back[1] + 0.8, back[2] + 3.4], [back[0] + 0.3, back[1], back[2] + 0.5]],
      28,
    );
    const arm = sweep(armPts, { profile: () => circleProfile(0.42, 8), up: [0, 1, 0], capStart: 'round', capEnd: 'round' });
    // Pad box (the little cup the pad clicks into).
    const cup = ellipsoid(0.8, 2.2, 1.6, 12, 8);
    cup.applyMatrix4(new Matrix4().makeRotationY(padAngle - Math.PI / 2));
    cup.translate(back[0] + padNormal[0] * 0.3, back[1], back[2] + padNormal[2] * 0.3);
    arm.append(cup);
    armsMesh.append(arm);
    armsMesh.append(mirrorMesh(arm));
  }
  metal.append(armsMesh);

  const lensT = d.lensThickness ?? 1.6;
  const lenses = [lensL, lensR].map((L, i) =>
    lensMesh(offsetClosed(L, 0.45), [i === 0 ? xc : -xc, 0], 0, lensT, 10).setUV(lensUV(i === 0 ? xc : -xc, W, H)),
  );

  const def = frontDeform(xc, d.baseR, d.wrapDeg);
  for (const m of [metal, padsMesh, ...lenses]) m.deformZ(def.f, def.grad);
  const pivot = [xh, hy, zh + def.f(xh, hy)];
  // Origin: the nose-ridge point at pad height — pads touch the nose sides; the ridge between
  // them sits ≈ 0.9 × pad half-gap in front of the pad faces (nose side slope ≈ 42°).
  const padFaceX = p.x - p.thickness / 2;
  const padZ = p.z + def.f(p.x, p.y);
  const origin = [0, p.y, padZ + padFaceX * 0.9];

  // Temple (left), local to pivot: hinge knuckle, wire, acetate tip sleeve.
  const tp = d.temple;
  const path = templePath(tp);
  const off = [0, 0, -0.2];
  const pts = path.pts.map((q) => [q[0] + off[0], q[1] + off[1], q[2] + off[2]]);
  const wire = sweep(pts, { profile: () => circleProfile(tp.wire, 10), up: [0, 1, 0], capStart: 'flat', capEnd: 'round' });
  const tipStart = pts.findIndex((_, i) => path.arc[i] >= tp.tipFrom);
  const tipPts = pts.slice(tipStart);
  const tipArc = path.arc.slice(tipStart);
  const sleeve = sweep(tipPts, {
    profile: (_, i) => {
      const s = tipArc[i] - tipArc[0];
      const k = lerp(0.35, 1, smooth(s / 8));
      return ellipseProfile(tp.tipH / 2 * k, tp.tipW / 2 * k, 14);
    },
    up: [0, 1, 0],
    capStart: 'round',
    capEnd: 'round',
  }).setUV(templeUV);
  // Knuckle block that carries the temple onto the barrel.
  const block = sweep(
    [[0, 0, 0.4], [0, 0, -1.5], [0, 0, -4]],
    { profile: () => roundedRectProfile(1.4, 1.0, 0.6, 3), up: [0, 1, 0], capStart: 'round', capEnd: 'flat' },
  );
  const templeMetal = new Mesh().append(wire).append(block).append(hinge.temple);

  return finish({
    d,
    origin,
    xc,
    lensT,
    lensZ: 0,
    front: [
      { name: 'frame', slot: 'metal', mesh: metal },
      { name: 'lens_L', slot: 'lens', mesh: lenses[0] },
      { name: 'lens_R', slot: 'lens', mesh: lenses[1] },
      { name: 'nose_pads', slot: 'pad', mesh: padsMesh },
    ],
    temple: {
      pivot,
      parts: [
        { name: 'body', slot: 'metal', mesh: templeMetal },
        { name: 'tip', slot: 'tip', mesh: sleeve },
      ],
      earBend: [-tp.inward * 0.1, 0, -tp.L1 + off[2]],
    },
    def,
  });
}

// ------------------------------------------------------------------ finishing

/** Translate to the nose-rest origin, mirror the temple, compute metadata. */
function finish({ d, origin: origin0, xc, lensT, lensZ, front, temple, def }) {
  // Pantoscopic tilt is built into the front like on a real frame: the front leans (lower rim
  // towards the cheeks) about the hinge axis, while the temples stay level.
  const [, py, pz] = temple.pivot;
  const tilt = new Matrix4()
    .makeTranslation(0, py, pz)
    .multiply(new Matrix4().makeRotationX((d.pantoDeg ?? 8) * DEG))
    .multiply(new Matrix4().makeTranslation(0, -py, -pz));
  for (const part of front) part.mesh.applyMatrix4(tilt);
  const origin = new Vector3(...origin0).applyMatrix4(tilt).toArray();
  const lensC = new Vector3(xc, 0, lensZ + def.f(xc, 0)).applyMatrix4(tilt);

  const [ox, oy, oz] = origin;
  for (const part of front) part.mesh.translate(-ox, -oy, -oz);
  const pivotL = [temple.pivot[0] - ox, temple.pivot[1] - oy, temple.pivot[2] - oz];
  const pivotR = [-pivotL[0], pivotL[1], pivotL[2]];
  const partsR = temple.parts.map((p) => ({ ...p, mesh: mirrorMesh(p.mesh) }));
  const earBendR = [-temple.earBend[0], temple.earBend[1], temple.earBend[2]];

  let minX = Infinity, maxX = -Infinity;
  for (const part of front) {
    const b = part.mesh.bounds();
    minX = Math.min(minX, b.min[0]);
    maxX = Math.max(maxX, b.max[0]);
  }
  const lc = [lensC.x / 1000, (lensC.y - oy) / 1000, (lensC.z - oz) / 1000].map((v) => +v.toFixed(5));
  return {
    front,
    temples: [
      { name: 'temple_L', pivot: pivotL, parts: temple.parts, earBend: temple.earBend },
      { name: 'temple_R', pivot: pivotR, parts: partsR, earBend: earBendR },
    ],
    meta: {
      lensWidthMm: d.lens.width,
      lensHeightMm: d.lens.height,
      bridgeMm: d.dbl,
      templeLengthMm: d.temple.length,
      frameWidthMm: +(maxX - minX).toFixed(1),
      lensThicknessMm: lensT,
      // Glasses-space lens centres (m) — used by fit checks and the debug view.
      pantoscopicDeg: d.pantoDeg ?? 8,
      lensCenters: [lc, [-lc[0], lc[1], lc[2]]],
    },
  };
}

// ------------------------------------------------------------------ the dev catalogue

const ACETATE_TEMPLE = { L1: 100, length: 145, bendR: 22, bendDeg: 34, inward: 3.5, h0: 8.5, h1: 5.2, h2: 4.2, w0: 4.2, w1: 3.4, w2: 3.3 };
const METAL_TEMPLE = { L1: 100, length: 145, bendR: 20, bendDeg: 36, inward: 3.5, wire: 0.72, tipFrom: 78, tipH: 4.2, tipW: 3.2 };

export const STYLES = {
  aria: {
    kind: 'acetate',
    title: 'Aria — soft-square acetate',
    lens: { width: 52, height: 40, nTop: 4.2, nBottom: 3.0, taper: 0.1, nasalCut: 0.14 },
    dbl: 18,
    rim: { top: 6.5, bottom: 4.6, nasal: 3.2, temporal: 5.2 },
    front: { thickness: 5.4, edgeR: 1.5 },
    bridge: { bottom: 6.8, top: 24, radius: 3, fillet: 3 },
    endpiece: { hx: 4, hy: 6.5, r: 2.5, inset: 1.5, dy: 0, fillet: 2.5 },
    hingeY: 15,
    wrapDeg: 5,
    baseR: 170,
    rivets: true,
    temple: ACETATE_TEMPLE,
  },
  mira: {
    kind: 'acetate',
    title: 'Mira — cat-eye acetate',
    lens: { width: 51, height: 38, nTop: 3.2, nBottom: 2.5, taper: 0.16, nasalCut: 0.12, catLift: 0.28 },
    dbl: 19,
    rim: { top: 6, bottom: 4.4, nasal: 3.1, temporal: 5.4 },
    front: { thickness: 5.6, edgeR: 1.6 },
    bridge: { bottom: 6.2, top: 22, radius: 3, fillet: 3 },
    endpiece: { hx: 4, hy: 6, r: 2.5, inset: 1.5, dy: 1, fillet: 2.5 },
    wing: { x: 26 + 1.5, y: 16.5, rx: 9, ry: 4.6, angle: 0.38, k: 3.5 },
    hingeY: 15,
    wrapDeg: 6,
    baseR: 160,
    rivets: false,
    temple: { ...ACETATE_TEMPLE, length: 140, L1: 97 },
  },
  orbit: {
    kind: 'metal',
    title: 'Orbit — round metal panto',
    lens: { width: 49, height: 44, nTop: 2.5, nBottom: 2.05, taper: 0.03, nasalCut: 0.06, topFlat: 0.3 },
    dbl: 21,
    rim: { ra: 0.95, rb: 1.1 },
    bridge: { ra: 1.05, rb: 0.95 },
    bridges: [{ from: [-W2(49) + 3.5, 44 * 0.3], via: [[6, 44 * 0.39, 0.7]], apex: [[0, 44 * 0.41, 0.9]] }],
    endpiece: { len: 5, back: 2.0, ra: 1.0, rb: 0.8 },
    hingeY: 44 * 0.16,
    pantoDeg: 7,
    pads: { x: 7.6, y: 44 * 0.1, z: -8.5, w: 4.8, h: 7.6, thickness: 1.4, faceDeg: 42, armRise: 6 },
    wrapDeg: 3,
    baseR: 200,
    temple: METAL_TEMPLE,
  },
  pilot: {
    kind: 'metal',
    title: 'Pilot — aviator sunglasses',
    lens: { width: 58, height: 50, nTop: 3.0, nBottom: 2.2, taper: 0.12, nasalCut: 0.2, drop: 0.22, dropAt: -0.25, topFlat: 0.4 },
    dbl: 14,
    rim: { ra: 0.85, rb: 1.05 },
    bridge: { ra: 1.0, rb: 0.85 },
    bridges: [
      { from: [-W2(58) + 9, 25.5], via: [[8, 26.6, 0.4]], apex: [[0, 26.9, 0.5]] },
      { from: [-W2(58) + 1.2, 50 * 0.17], via: [[4.5, 50 * 0.24, 0.7]], apex: [[0, 50 * 0.27, 0.9]] },
    ],
    endpiece: { len: 3.2, back: 2.0, ra: 1.0, rb: 0.75 },
    hingeY: 50 * 0.34,
    pantoDeg: 6,
    pads: { x: 7.2, y: 50 * 0.15, z: -8.5, w: 4.8, h: 7.8, thickness: 1.4, faceDeg: 42, armRise: 5 },
    wrapDeg: 6,
    baseR: 120,
    lensThickness: 1.8,
    temple: { ...METAL_TEMPLE, length: 140, L1: 97 },
  },
};

function W2(w) {
  return w / 2;
}

export function buildStyle(id) {
  const d = STYLES[id];
  return d.kind === 'acetate' ? buildAcetate(d) : buildMetal(d);
}
