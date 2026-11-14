import { gridSurface, profileLoft, strapMesh } from './soldier-meshes.mjs';

const TAU = 2 * Math.PI;

// Angle zero is the forehead, pi is the nape. The shell's cut clears the
// headset at both ears and slopes down across the occiput at the back.
function helmetPoint(u, v) {
  const angle = u * TAU;
  const fore = Math.cos(angle);
  const side = Math.abs(Math.sin(angle));
  const earClearance = 0.030 * side ** 10;
  const rim = 0.009 - 0.030 * Math.max(0, -fore) ** 1.7 + earClearance;
  const latitude = v * Math.PI / 2;
  const height = Math.sin(latitude);
  const radius = Math.cos(latitude) * (1 + 0.045 * Math.sin(Math.PI * v));
  const x = 0.116 * Math.sin(angle) * radius;
  const z = 0.006 - 0.131 * fore * radius + 0.011 * height;
  return [x, rim + (0.112 - rim) * height, z];
}

function rimStrip(T, columns, uStart, uWidth, minY, maxY, radiusOffset) {
  return gridSurface(T, columns, 3, (u, v) => {
    const t = uStart + u * uWidth;
    const angle = t * TAU;
    const [x, y, z] = helmetPoint(t, 0);
    const middle = 1 - Math.abs(2 * v - 1);
    const taper = uWidth === 1 ? 1 : Math.min(1, 8 * u, 8 * (1 - u));
    const thickness = radiusOffset * taper + 0.002 * middle;
    return [x + Math.sin(angle) * thickness, y + minY + (maxY - minY) * v * (0.45 + 0.55 * taper),
      z - Math.cos(angle) * thickness];
  }, { flip: true, wrap: uWidth === 1 });
}

// Shape coordinates are face-plane metres. A curved projection carries the
// end of the goggles around the temples instead of laying a flat bar on them.
function faceContour(T, outline) {
  return new T.CatmullRomCurve3(outline.map(([x, y]) => new T.Vector3(x, y, 0)), true, 'centripetal');
}

function facePatch(T, curve, columns, rows, depth, yCenter) {
  return gridSurface(T, columns, rows, (u, v) => {
    const point = curve.getPoint(u);
    const x = point.x * v;
    const y = yCenter + (point.y - yCenter) * v;
    return [x, y, depth(x, y)];
  }, { wrap: true });
}

function faceReturn(T, curve, columns, depth, thickness, yCenter) {
  return gridSurface(T, columns, 3, (u, v) => {
    const point = curve.getPoint(u);
    const roll = Math.sin(v * Math.PI / 2);
    const x = point.x * (1 - roll * 0.09);
    const y = yCenter + (point.y - yCenter) * (1 - roll * 0.12);
    return [x, y, depth(point.x, point.y) + thickness * v];
  }, { wrap: true });
}

function earCup(T, side, columns, rings, center, height, depth) {
  return gridSurface(T, columns, rings.length - 1, (u, v) => {
    const angle = u * TAU;
    const [radius, x] = rings[Math.round(v * (rings.length - 1))];
    // Rounded trapezoid earpiece with a shallower lower/front corner.
    const y = Math.cos(angle), z = Math.sin(angle);
    const width = 1 - 0.15 * Math.max(0, -y);
    return [side * x, center[0] + height * radius * y,
      center[1] + depth * radius * z * width - 0.005 * radius * y];
  }, { flip: side > 0, wrap: true });
}

function contour(outline, scaleX, scaleY, centerY) {
  return outline.map(([x, y]) => [x * scaleX, centerY + (y - centerY) * scaleY]);
}

const goggleOutline = [
  [-0.109, -0.017], [-0.105, -0.031], [-0.091, -0.041], [-0.069, -0.045],
  [-0.037, -0.046], [-0.025, -0.044], [-0.016, -0.031], [-0.008, -0.024],
  [0.008, -0.024], [0.016, -0.031], [0.025, -0.044], [0.037, -0.046],
  [0.069, -0.045], [0.091, -0.041], [0.105, -0.031], [0.109, -0.017],
  [0.106, -0.003], [0.092, 0.009], [0.066, 0.012], [0.024, 0.011],
  [0, 0.009], [-0.024, 0.011], [-0.066, 0.012], [-0.092, 0.009], [-0.106, -0.003],
];

const maskOutline = [
  [-0.071, -0.071], [-0.064, -0.087], [-0.045, -0.101], [-0.020, -0.111],
  [0, -0.115], [0.020, -0.111], [0.045, -0.101], [0.064, -0.087], [0.071, -0.071],
  [0.065, -0.060], [0.045, -0.053], [0.024, -0.053], [0.013, -0.044],
  [0, -0.040], [-0.013, -0.044], [-0.024, -0.053], [-0.045, -0.053], [-0.065, -0.060],
];

export function buildSoldierHead(head, api) {
  const { T, M, high, equipped, box, tube, cylinder, part, own, symmetryPair } = api;
  const columns = high ? 44 : equipped ? 30 : 18;
  const faceColumns = high ? 52 : equipped ? 34 : 22;
  const faceRows = high ? 7 : equipped ? 5 : 3;
  const add = (geometry, material, position, rotation, scale) =>
    part(head, own(geometry), material, position, rotation, scale);

  // Cloth head and gathered throat sit behind the hard equipment. Off-centre
  // folds keep the neck from reading as a uniform rubber cylinder.
  add(profileLoft(T, [
    { y: -0.174, rx: 0.080, rz: 0.072, z: 0.004 },
    { y: -0.156, rx: 0.080, rz: 0.077, z: 0.006 },
    { y: -0.132, rx: 0.069, rz: 0.079, z: 0.010 },
    { y: -0.110, rx: 0.070, rz: 0.077, z: 0.005 },
    { y: -0.089, rx: 0.080, rz: 0.082, z: 0.004 },
    { y: -0.044, rx: 0.089, rz: 0.096, z: 0.005 },
    { y: 0.005, rx: 0.091, rz: 0.101, z: 0.005 },
    { y: 0.049, rx: 0.076, rz: 0.092, z: 0.012 },
    { y: 0.067, rx: 0.031, rz: 0.045, z: 0.017 },
  ], {
    segments: columns, steps: high ? 30 : equipped ? 18 : 12,
    fold: (t, angle) => {
      const neck = Math.exp(-(((t - 0.105) / 0.19) ** 2));
      return neck * (0.0035 * Math.sin(56 * t + 1.75 * Math.sin(angle + t * 5)) +
        0.0026 * Math.cos(38 * t - 2 * angle));
    },
  }), M.fabric);

  add(gridSurface(T, columns, high ? 15 : equipped ? 11 : 8, helmetPoint,
    { flip: true, wrap: true }), M.armor);
  add(rimStrip(T, columns, 0, 1, -0.007, 0.004, 0.0025), M.rubber);
  add(rimStrip(T, columns, 0, 1, 0.003, 0.010, 0.002), M.polymer);

  const lensDepth = (x, y) => -0.132 + 3.38 * x * x + 1.4 * (y + 0.017) ** 2;
  const lensEdge = faceContour(T, contour(goggleOutline, 1.045, 1.18, -0.016));
  const frameDepth = (x, y) => lensDepth(x, y) + 0.003;
  add(facePatch(T, lensEdge, faceColumns, faceRows, frameDepth, -0.015), M.rubber);
  add(faceReturn(T, lensEdge, faceColumns, frameDepth, 0.026, -0.015), M.rubber);
  add(facePatch(T, faceContour(T, contour(goggleOutline, 0.976, 0.91, -0.015)),
    faceColumns, faceRows, lensDepth, -0.015), M.lens);

  const maskDepth = (x, y) => -0.132 + 5.45 * x * x + 5.2 * (y + 0.069) ** 2;
  const maskEdge = faceContour(T, contour(maskOutline, 1.05, 1.08, -0.077));
  const backingDepth = (x, y) => maskDepth(x, y) + 0.003;
  add(facePatch(T, maskEdge, faceColumns, faceRows, backingDepth, -0.072), M.rubber);
  add(faceReturn(T, maskEdge, faceColumns, backingDepth, 0.024, -0.072), M.rubber);
  add(facePatch(T, faceContour(T, contour(maskOutline, 0.95, 0.91, -0.077)),
    faceColumns, faceRows, maskDepth, -0.072), M.armor);

  // All paired equipment is constructed from one positive-X source. The
  // reflection system owns the opposite buffers, winding and local transforms.
  const paired = (g, mat, at, rot, scale, name) => symmetryPair(head, own(g), mat, at, rot, scale, name);
  const boxPair = (mat, size, at, rot, name) => paired(new T.BoxGeometry(...size), mat, at, rot, undefined, name);
  const cylinderPair = (mat, radius, length, at, rot, name) => paired(new T.CylinderGeometry(radius, radius, length, high ? 12 : 8), mat, at, rot, undefined, name);
  const tubePair = (mat, points, radius, name) => paired(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p))), high ? 24 : 12, radius, high ? 6 : 4, false), mat, undefined, undefined, undefined, name);
  const earColumns = high ? 28 : equipped ? 20 : 14;
  paired(earCup(T, 1, earColumns, [[0, .132], [.82, .132], [1, .122], [1, .109], [.87, .094]],
    [-.029, .018], .045, .036), M.rubber, undefined, undefined, undefined, 'headset-cushion');
  paired(earCup(T, 1, earColumns, [[0, .143], [.55, .143], [.79, .140], [.94, .134], [1, .126]],
    [-.029, .018], .039, .031), M.polymer, undefined, undefined, undefined, 'headset-shell');
  if (equipped) {
    paired(rimStrip(T, high ? 22 : 12, .168, .163, .005, .021, .007), M.polymer, undefined, undefined, undefined, 'helmet-side-rail');
    paired(strapMesh(T, [[.098, -.015, -.082], [.105, -.012, -.050], [.105, .007, -.011]], .016,
      { across: [0, 1, 0], steps: high ? 12 : 6 }), M.webbing, undefined, undefined, undefined, 'goggle-side-strap');
    paired(strapMesh(T, [[.080, -.072, .035], [.078, -.099, -.008], [.049, -.114, -.088]], .012,
      { across: [0, 1, 0], steps: high ? 10 : 5 }), M.webbing, undefined, undefined, undefined, 'chin-strap');
    boxPair(M.polymer, [.014, .016, .023], [.110, -.010, -.061], [0, -.38, 0], 'strap-adjuster');
    if (high) {
      for (const z of [-.038, .033, .062]) {
        const turn = Math.acos((.006 - z) / .131) / TAU;
        const [x, y] = helmetPoint(turn, 0);
        cylinderPair(M.metal, .0034, .003, [x + .008, y + .011, z], [0, 0, Math.PI / 2], 'rail-screw');
      }
      tubePair(M.rubber, [[.132, -.002, .039], [.117, .027, .039], [.107, .037, .028]], .0034, 'headset-wire');
    }
  }
  if (!equipped) return;

  // A low-profile night-vision socket follows the forehead, with a recessed
  // cavity and separate fastening points rather than a tall mount block.
  box(head, M.polymer, [0.047, 0.044, 0.015], [0, 0.039, -0.120], 0.007, [-0.20, 0, 0]);
  box(head, M.metal, [0.030, 0.033, 0.009], [0, 0.041, -0.130], 0.004, [-0.20, 0, 0]);
  box(head, M.rubber, [0.018, 0.020, 0.003], [0, 0.042, -0.136], 0.003, [-0.20, 0, 0]);
  cylinderPair(M.metal, .0024, .002, [.015, .034, -.136], [Math.PI / 2, 0, 0], 'nvg-screw');

  const slotCount = high ? 7 : 5;
  for (let i = 0; i < slotCount; i++) {
    const x = (i - (slotCount - 1) / 2) * (high ? 0.011 : 0.014);
    const y = -0.067 + Math.abs(x) * 0.16;
    box(head, M.rubber, [0.0043, 0.015 - Math.abs(x) * 0.08, 0.0024],
      [x, y, maskDepth(x, y) - 0.0012], 0.001, [0, 10.9 * x, -2.5 * x]);
  }
  cylinderPair(M.polymer, .004, .002, [.057, -.079, maskDepth(.057, -.079) - .0015], [Math.PI / 2, -.54, 0], 'mask-attachment');
  tubePair(M.rubber, [[.125, -.038, -.002], [.125, -.056, -.027], [.109, -.078, -.058], [.070, -.091, -.099], [.043, -.096, -.119]], .0027, 'headset-boom');
  boxPair(M.polymer, [.019, .009, .009], [.042, -.096, -.120], [0, .35, 0], 'boom-end');

  if (high) {
    add(gridSurface(T, 11, 7, (u, v) => {
      const angle = 0.429 + u * 0.142;
      const [x, y, z] = helmetPoint(angle, 0.29 + 0.24 * v);
      return [x * 1.024, y + 0.001, z + 0.0026];
    }, { flip: true }), M.webbing);
    const stitchPoints = [[-0.039, -0.117, -0.058], [-0.016, -0.122, -0.073],
      [0.016, -0.122, -0.073], [0.039, -0.117, -0.058]].map(point => new T.Vector3(...point));
    const stitchCurve = new T.CatmullRomCurve3(stitchPoints);
    for (let i = 0; i < 11; i++) {
      const from = stitchCurve.getPoint((i + 0.15) / 11).toArray();
      const to = stitchCurve.getPoint((i + 0.63) / 11).toArray();
      tube(head, M.stitch, [from, to], 0.00075);
    }
  }
}
