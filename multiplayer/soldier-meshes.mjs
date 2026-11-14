// Surface builders use metres in a right-handed frame. A panel's front is -Z.
const tau = 2 * Math.PI;
const lerp = (a, b, t) => a + (b - a) * t;
const signedPow = (x, p) => Math.sign(x) * Math.abs(x) ** p;

function mesh(T, positions, uv, indices) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export function gridSurface(T, columns, rows, point, { flip = false, wrap = false } = {}) {
  const positions = [], uv = [], indices = [];
  const stride = columns + 1;
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) {
    const u = i / columns, v = j / rows;
    positions.push(...point(u, v)); uv.push(u, v);
    if (i < columns && j < rows) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      indices.push(...(flip ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
    }
  }
  const g = mesh(T, positions, uv, indices);
  if (wrap) {
    const n = g.attributes.normal, a = new T.Vector3(), b = new T.Vector3();
    for (let row = 0; row <= rows; row++) {
      const i = row * stride, j = i + columns;
      a.fromBufferAttribute(n, i).add(b.fromBufferAttribute(n, j)).normalize();
      n.setXYZ(i, a.x, a.y, a.z); n.setXYZ(j, a.x, a.y, a.z);
    }
  }
  return g;
}

// Monotone cubic interpolation between measured sections. Hard sections (e.g.
// sole layers) can use separate lofts and thereby retain an intentional crease.
function interpolate(rings, field, y) {
  const value = i => rings[i][field] ?? (field === 'power' ? 1 : 0);
  const slope = i => (value(i + 1) - value(i)) / (rings[i + 1].y - rings[i].y);
  let i = 0;
  while (i + 2 < rings.length && y > rings[i + 1].y) i++;
  const d = slope(i), h = rings[i + 1].y - rings[i].y;
  const tangent = (a, b) => a * b <= 0 ? 0 : 2 * a * b / (a + b);
  const m0 = i ? tangent(slope(i - 1), d) : d;
  const m1 = i + 2 < rings.length ? tangent(d, slope(i + 1)) : d;
  const t = (y - rings[i].y) / h, q = t * t, c = q * t;
  return (2 * c - 3 * q + 1) * value(i) + (c - 2 * q + t) * h * m0 +
    (-2 * c + 3 * q) * value(i + 1) + (c - q) * h * m1;
}

export function profileLoft(T, rings, { segments = 24, steps = 24, cap = true, fold = null } = {}) {
  const start = rings[0].y, end = rings.at(-1).y;
  const sections = Array.from({ length: steps + 1 }, (_, i) => {
    const y = lerp(start, end, i / steps);
    return [y, ...['rx', 'rz', 'x', 'z', 'power'].map(field => interpolate(rings, field, y))];
  });
  const point = (u, v) => {
    const [y, rx, rz, x, z, p] = sections[Math.round(v * steps)];
    const angle = u * tau, delta = fold?.(v, angle) || 0;
    return [x + Math.max(0.0002, rx + delta) * signedPow(Math.cos(angle), p), y,
      z + Math.max(0.0002, rz + delta) * signedPow(Math.sin(angle), p)];
  };
  const shell = gridSurface(T, segments, steps, point, { flip: true, wrap: true });
  if (!cap) return shell;
  const p = Array.from(shell.attributes.position.array), uv = Array.from(shell.attributes.uv.array);
  const n = Array.from(shell.attributes.normal.array), ix = Array.from(shell.index.array);
  for (const v of [0, 1]) {
    const [y, , , x, z] = sections[v * steps], center = p.length / 3, normal = v ? 1 : -1;
    p.push(x, y, z); uv.push(0.5, 0.5); n.push(0, normal, 0);
    for (let j = 0; j <= segments; j++) {
      const u = j / segments;
      p.push(...point(u, v)); uv.push(0.5 + 0.5 * Math.cos(u * tau), 0.5 + 0.5 * Math.sin(u * tau)); n.push(0, normal, 0);
      if (j < segments) ix.push(center, center + j + (v ? 2 : 1), center + j + (v ? 1 : 2));
    }
  }
  shell.dispose();
  const result = mesh(T, p, uv, ix);
  result.setAttribute('normal', new T.Float32BufferAttribute(n, 3));
  return result;
}

// Convex contoured panel: graduated front rings form the dome and rolled
// rim; a separate reverse cap closes the back. Outline may be CW or CCW.
export function panelVolume(T, outline, { depth = 0.02, bevel = 0.006, bulge = 0.012, steps = 5 } = {}) {
  let edge = outline.map(p => p.slice());
  const area = edge.reduce((sum, [x, y], i) => {
    const [a, b] = edge[(i + 1) % edge.length]; return sum + x * b - y * a;
  }, 0);
  if (area < 0) edge = edge.reverse();
  const count = edge.length;
  const cx = edge.reduce((a, p) => a + p[0], 0) / count;
  const cy = edge.reduce((a, p) => a + p[1], 0) / count;
  const span = Math.min(...edge.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const rounded = Math.min(0.38, bevel / Math.max(0.001, span));
  const rings = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return [t * (1 - rounded), -bulge * (1 - t * t)];
  });
  rings.push([1 - rounded * 0.23, bevel * 0.25], [1, bevel * 0.85], [1, Math.max(bevel, depth - bevel)], [1 - rounded * 0.6, depth]);
  const p = [cx, cy, -bulge], uv = [0.5, 0.5], ix = [];
  const minX = Math.min(...edge.map(v => v[0])), maxX = Math.max(...edge.map(v => v[0]));
  const minY = Math.min(...edge.map(v => v[1])), maxY = Math.max(...edge.map(v => v[1]));
  const append = (x, y, z) => {
    p.push(x, y, z); uv.push((x - minX) / (maxX - minX), (y - minY) / (maxY - minY));
  };
  rings.forEach(([r, z], j) => {
    edge.forEach(([x, y]) => append(lerp(cx, x, r), lerp(cy, y, r), z));
    for (let i = 0; i < count; i++) {
      const k = (i + 1) % count, c = 1 + j * count + i, d = 1 + j * count + k;
      if (j === 0) ix.push(0, d, c);
      else { const a = c - count, b = d - count; ix.push(a, b, c, b, d, c); }
    }
  });
  const back = p.length / 3;
  append(cx, cy, depth);
  edge.forEach(([x, y]) => append(lerp(cx, x, rings.at(-1)[0]), lerp(cy, y, rings.at(-1)[0]), depth));
  for (let i = 0; i < count; i++) ix.push(back, back + 1 + i, back + 1 + (i + 1) % count);
  return mesh(T, p, uv, ix);
}

// Tensioned rectangular ribbon swept over a spline. Eight perimeter sections
// preserve the edge thickness without representing a strap as a cylinder.
export function strapMesh(T, points, width, { thickness = 0.004, steps = 16, across = [1, 0, 0] } = {}) {
  const path = new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p)), false, 'centripetal');
  const ref = new T.Vector3(...across).normalize();
  const ring = [[1, -0.5], [1, 0.5], [0.9, 1], [-0.9, 1], [-1, 0.5], [-1, -0.5], [-0.9, -1], [0.9, -1]];
  const frames = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, p = path.getPoint(t), dir = path.getTangent(t).normalize();
    const x = ref.clone().addScaledVector(dir, -ref.dot(dir));
    if (x.lengthSq() < 0.001) x.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).addScaledVector(dir, -(Math.abs(dir.y) < 0.9 ? dir.y : dir.x));
    x.normalize();
    return [p, x, new T.Vector3().crossVectors(dir, x).normalize()];
  });
  return gridSurface(T, ring.length, steps, (u, v) => {
    const [p, x, n] = frames[Math.round(v * steps)], [a, b] = ring[Math.round(u * ring.length) % ring.length];
    return p.clone().addScaledVector(x, a * width / 2).addScaledVector(n, b * thickness / 2).toArray();
  }, { wrap: true });
}
