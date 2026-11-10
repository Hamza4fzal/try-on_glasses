// 2D outlines: parametric lens shapes, contour utilities, signed distance fields and
// marching squares (used to grow an acetate front with organic fillets around the lenses).

/**
 * Parametric lens outline in LOCAL lens coordinates of the wearer's LEFT lens:
 * +x = temporal (towards the ear), −x = nasal, +y = up. Returned CCW, centred on its bounding
 * box, exactly `width` × `height` (boxing system: lens width = horizontal box size).
 *
 * spec: { width, height, nTop, nBottom, taper, nasalCut, drop, dropAt, catLift, topFlat }
 */
export function lensOutline(spec, samples = 720) {
  const s = {
    nTop: 2,
    nBottom: 2,
    taper: 0,
    nasalCut: 0,
    drop: 0,
    dropAt: -0.15,
    catLift: 0,
    topFlat: 0,
    ...spec,
  };
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const c = Math.cos(t), sn = Math.sin(t);
    const e = sn >= 0 ? s.nTop : s.nBottom;
    let x = Math.sign(c) * Math.abs(c) ** (2 / e);
    let y = Math.sign(sn) * Math.abs(sn) ** (2 / e);
    // Top wider than bottom (most frames are slightly trapezoidal).
    x *= 1 + s.taper * y;
    // Clear the nose: pull the lower nasal corner in.
    if (x < 0 && y < 0) x *= 1 - s.nasalCut * -y;
    // Aviator teardrop: deepen the bottom around `dropAt`.
    if (y < 0) y *= 1 + s.drop * Math.exp(-(((x - s.dropAt) / 0.65) ** 2));
    // Flatten the top edge (browline / panto top).
    if (y > 0) y *= 1 - s.topFlat * (1 - Math.abs(x)) * 0.25;
    // Cat-eye: lift the upper temporal corner.
    if (x > 0 && y > -0.3) y += s.catLift * smooth(0.15, 1, x) * ((y + 0.3) / 1.3);
    raw.push([x, y]);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of raw) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const sx = s.width / (maxX - minX), sy = s.height / (maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const pts = raw.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]);
  return resampleClosed(signedArea(pts) >= 0 ? pts : pts.reverse(), 256);
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Uniform arclength resampling of a closed polyline. */
export function resampleClosed(pts, count) {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const total = cum[n];
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * total;
    while (cum[seg + 1] < d) seg++;
    const p = pts[seg], q = pts[(seg + 1) % n];
    const t = (d - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

/** Laplacian smoothing of a closed polyline (removes marching-squares stair noise). */
export function smoothClosed(pts, iterations = 3, lambda = 0.5) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length;
    cur = cur.map((p, i) => {
      const a = cur[(i - 1 + n) % n], b = cur[(i + 1) % n];
      return [p[0] + lambda * ((a[0] + b[0]) / 2 - p[0]), p[1] + lambda * ((a[1] + b[1]) / 2 - p[1])];
    });
  }
  return cur;
}

/** Offset a CCW closed polyline outward by d (negative = inward). */
export function offsetClosed(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dy / l) * d, p[1] - (dx / l) * d];
  });
}

/** Mirror across x = 0 and keep CCW orientation. */
export function mirrorX(pts) {
  return pts.map(([x, y]) => [-x, y]).reverse();
}

export function translate2(pts, dx, dy) {
  return pts.map(([x, y]) => [x + dx, y + dy]);
}

// ------------------------------------------------------------------ SDF

/** Precompiled polygon for fast signed-distance queries (negative inside). */
export function compilePolygon(pts) {
  const n = pts.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  pts.forEach(([x, y], i) => {
    xs[i] = x;
    ys[i] = y;
  });
  return (px, py) => {
    let d2 = Infinity;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = xs[j], ay = ys[j], bx = xs[i], by = ys[i];
      const ex = bx - ax, ey = by - ay;
      const wx = px - ax, wy = py - ay;
      const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
      const dx = wx - ex * t, dy = wy - ey * t;
      const dd = dx * dx + dy * dy;
      if (dd < d2) d2 = dd;
      if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    }
    const d = Math.sqrt(d2);
    return inside ? -d : d;
  };
}

export function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r), qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Approximate ellipse distance (exact on the boundary sign; good enough for blending). */
export function sdEllipse(px, py, cx, cy, rx, ry, angle = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = (px - cx) * c + (py - cy) * s, y = -(px - cx) * s + (py - cy) * c;
  const k = Math.hypot(x / rx, y / ry);
  return (k - 1) * Math.min(rx, ry);
}

/** Polynomial smooth minimum (fillet radius ≈ k). */
export function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ------------------------------------------------------------------ marching squares

/**
 * Extracts the zero level set of `field(x, y)` over a box, returns closed loops (arrays of
 * [x, y]). The field must be positive on the box boundary.
 */
export function contours(field, x0, y0, x1, y1, h) {
  const nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1;
  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = field(x0 + i * h, y0 + j * h);
  const at = (i, j) => v[j * nx + i];
  const pts = new Map();
  // Edge keys: horizontal edge (i,j)-(i+1,j) → 'h' ; vertical (i,j)-(i,j+1) → 'v'
  const edgePoint = (key) => {
    if (pts.has(key)) return key;
    const [t, si, sj] = key.split(',');
    const i = +si, j = +sj;
    const a = at(i, j);
    const b = t === 'h' ? at(i + 1, j) : at(i, j + 1);
    const f = a / (a - b);
    pts.set(key, t === 'h' ? [x0 + (i + f) * h, y0 + j * h] : [x0 + i * h, y0 + (j + f) * h]);
    return key;
  };
  const links = new Map();
  const link = (a, b) => {
    edgePoint(a);
    edgePoint(b);
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b);
    links.get(b).push(a);
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const bl = at(i, j) < 0, br = at(i + 1, j) < 0, tr = at(i + 1, j + 1) < 0, tl = at(i, j + 1) < 0;
      const c = (bl ? 1 : 0) | (br ? 2 : 0) | (tr ? 4 : 0) | (tl ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const B = `h,${i},${j}`, T = `h,${i},${j + 1}`, L = `v,${i},${j}`, R = `v,${i + 1},${j}`;
      switch (c) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(R, T); break;
        case 6: case 9: link(B, T); break;
        case 7: case 8: link(L, T); break;
        case 5: case 10: {
          const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 < 0;
          if ((c === 5) === centre) {
            link(L, T);
            link(B, R);
          } else {
            link(L, B);
            link(R, T);
          }
          break;
        }
      }
    }
  }
  const loops = [];
  const visited = new Set();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      loop.push(pts.get(cur));
      const next = links.get(cur).find((k) => k !== prev && !visited.has(k));
      prev = cur;
      cur = next;
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}
