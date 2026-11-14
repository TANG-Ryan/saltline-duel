import { gridSurface, panelVolume, profileLoft, strapMesh } from './soldier-meshes.mjs';
import { BODY_DIMENSIONS, symmetricOutline } from './soldier-symmetry.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const bell = (distance, width) => Math.exp(-((distance / width) ** 2));
const signedPow = (v, power) => Math.sign(v) * Math.abs(v) ** power;

// All attachments sample the actual garment sections and the outward face of
// their preceding layer. Coordinates and thicknesses are in the spine frame.
export function buildSoldierTorso(spine, api) {
  const { T, M, high, equipped, segments, own, part, symmetryPair } = api;
  const canvas = M.webbing, trim = M.webbingDark ?? M.armor;
  const thread = M.stitch, fabric = M.fabric;
  const clearance = BODY_DIMENSIONS.layerClearance;
  const panelSteps = high ? 5 : equipped ? 3 : 2;
  const emit = (mesh, material, { at = [0, 0, 0], rotation, pair = false, name } = {}) => {
    own(mesh);
    if (pair) symmetryPair(spine, mesh, material, at, rotation, undefined, name);
    else part(spine, mesh, material, at, rotation);
    return mesh;
  };
  const cord = (points, radius, material, pair = false, name) => emit(new T.TubeGeometry(
    new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p)), false, 'centripetal'),
    high ? 28 : 14, radius, high ? 6 : 4, false), material, { pair, name });
  const strap = (points, width, material = canvas, { thickness = .004, across = [1, 0, 0], pair = false, name } = {}) =>
    emit(strapMesh(T, points, width, { thickness, across, steps: high ? 16 : equipped ? 10 : 5 }), material, { pair, name });

  const uniform = [
    // Tuck the hidden shirt hem inside the pelvis shell. A full-width, closed
    // hem rotated out through the seat when the spine leaned into a kneel.
    { y: -.078, rx: .105, rz: .055, z: 0, power: 1.04 },
    { y: -.033, rx: .148, rz: .087, z: 0, power: 1.04 },
    { y: .044, rx: .180, rz: .108, z: .006, power: 1.05 },
    { y: .132, rx: .206, rz: .119, z: .003, power: 1.10 },
    { y: .224, rx: .220, rz: .126, z: -.004, power: 1.10 },
    { y: .332, rx: .234, rz: .138, z: -.001, power: 1.11 },
    { y: .434, rx: .247, rz: .125, z: .008, power: 1.11 },
    { y: .482, rx: .250, rz: .118, z: .010, power: 1.07 },
    { y: .530, rx: .250, rz: .110, z: .010, power: 1.05 },
    { y: .570, rx: .238, rz: .100, z: .006 },
    { y: .600, rx: .190, rz: .090, z: .002 },
    { y: .628, rx: .110, rz: .074, z: -.006 },
    { y: .645, rx: .074, rz: .064, z: -.010 },
  ];
  // The same monotone Hermite sections are used by profileLoft and fitting.
  function section(y, field) {
    y = clamp(y, uniform[0].y, uniform.at(-1).y);
    const value = i => uniform[i][field] ?? (field === 'power' ? 1 : 0);
    const slope = i => (value(i + 1) - value(i)) / (uniform[i + 1].y - uniform[i].y);
    const tangent = (a, b) => a * b <= 0 ? 0 : 2 * a * b / (a + b);
    let i = 0;
    while (i + 2 < uniform.length && y > uniform[i + 1].y) i++;
    const d = slope(i), h = uniform[i + 1].y - uniform[i].y;
    const a = i ? tangent(slope(i - 1), d) : d;
    const b = i + 2 < uniform.length ? tangent(d, slope(i + 1)) : d;
    const t = (y - uniform[i].y) / h, q = t * t, c = q * t;
    return (2 * c - 3 * q + 1) * value(i) + (c - 2 * q + t) * h * a +
      (-2 * c + 3 * q) * value(i + 1) + (c - q) * h * b;
  }
  function uniformFolds(t, angle) {
    const side = Math.abs(Math.cos(angle)), front = Math.sin(angle);
    const waist = bell(t - .22, .15) * (.48 + .52 * side * side);
    const underarm = bell(t - .68, .13) * side ** 6;
    const shoulder = bell(t - .86, .15) * (.3 + .7 * side ** 4);
    return waist * (.006 * Math.sin(t * 52 + 1.65 * front * side) + .0025 * Math.sin(front * 4 + t * 21)) +
      underarm * (.006 * Math.sin(t * 49 - side * 5) + .003 * Math.cos(front * 9 + t * 18)) +
      shoulder * .0032 * Math.sin(side * 6 + t * 25 + front);
  }
  const foldAt = (y, angle) => equipped ? uniformFolds((y - uniform[0].y) / (uniform.at(-1).y - uniform[0].y), angle) : 0;
  function crossPoint(angle, y) {
    const fold = foldAt(y, angle), power = section(y, 'power');
    return new T.Vector3((section(y, 'rx') + fold) * signedPow(Math.cos(angle), power), y,
      section(y, 'z') + (section(y, 'rz') + fold) * signedPow(Math.sin(angle), power));
  }
  function surfaceZ(side, x, y) {
    let lo = 0, hi = Math.PI;
    for (let i = 0; i < 23; i++) {
      const mid = (lo + hi) / 2;
      if (crossPoint(side * mid, y).x > x) lo = mid;
      else hi = mid;
    }
    return crossPoint(side * (lo + hi) / 2, y).z;
  }
  const surfacePoint = (side, x, y, offset = 0) => [x, y, surfaceZ(side, x, y) + side * offset];
  function normalPoint(angle, y, offset) {
    const p = crossPoint(angle, y), e = .0001;
    const along = crossPoint(angle + e, y).sub(crossPoint(angle - e, y));
    const vertical = crossPoint(angle, y + e).sub(crossPoint(angle, y - e));
    return p.addScaledVector(vertical.cross(along).normalize(), offset).toArray();
  }
  emit(profileLoft(T, uniform, { segments: high ? 44 : equipped ? 28 : segments * 2,
    steps: high ? 45 : equipped ? 27 : 17, cap: false, fold: equipped ? uniformFolds : null }), fabric);

  // panelVolume's radial front rings are also its contact field. The next
  // piece samples this exact rolled face, including bevel and dome thickness.
  function faceSampler(outline, depth, bevel, bulge) {
    const cx = outline.reduce((n, p) => n + p[0], 0) / outline.length;
    const cy = outline.reduce((n, p) => n + p[1], 0) / outline.length;
    const span = Math.min(...outline.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const rounded = Math.min(.38, bevel / Math.max(.001, span));
    const rings = [[0, -bulge], ...Array.from({ length: panelSteps }, (_, i) => {
      const t = (i + 1) / panelSteps;
      return [t * (1 - rounded), -bulge * (1 - t * t)];
    }), [1 - rounded * .23, bevel * .25], [1, bevel * .85]];
    return (x, y) => {
      const dx = x - cx, dy = y - cy;
      let radius = 0;
      for (let i = 0; i < outline.length; i++) {
        const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % outline.length];
        const ex = bx - ax, ey = by - ay;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
        const s = ((ax - cx) * dy - (ay - cy) * dx) / den;
        if (t > 0 && s >= -1e-7 && s <= 1 + 1e-7) radius = Math.max(radius, 1 / t);
      }
      if (radius > 1.00001) return null;
      let i = 0;
      while (i + 2 < rings.length && radius > rings[i + 1][0]) i++;
      const a = rings[i], b = rings[i + 1];
      return depth - mix(a[1], b[1], clamp((radius - a[0]) / (b[0] - a[0]), 0, 1));
    };
  }
  function fittedPanel(outline, material, { x = 0, y = 0, side = -1, base = 0, depth = .02,
    bevel = .006, bulge = .008, pair = false, name } = {}) {
    const baseAt = typeof base === 'function' ? base : () => base;
    const localFace = faceSampler(outline, depth, bevel, bulge);
    const geometry = panelVolume(T, outline, { depth, bevel, bulge, steps: panelSteps });
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const gx = x + p.getX(i), gy = y + p.getY(i), localZ = p.getZ(i);
      p.setXYZ(i, gx, gy, surfaceZ(side, gx, gy) + side * (baseAt(gx, gy) + depth - localZ));
    }
    if (side > 0) {
      const index = geometry.index;
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, b);
      }
    }
    geometry.computeVertexNormals();
    emit(geometry, material, { pair, name });
    return (gx, gy) => {
      const outward = localFace(gx - x, gy - y);
      return outward === null ? null : baseAt(gx, gy) + outward;
    };
  }
  const combine = (...faces) => (x, y) => Math.max(0, ...faces.map(f => f(x, y) ?? 0));
  const trace = (side, points, face, gap = clearance) => points.map(([x, y]) => surfacePoint(side, x, y, face(x, y) + gap));

  const collar = [
    { y: .600, rx: .092, rz: .080, z: -.006 }, { y: .628, rx: .090, rz: .077, z: -.007 },
    { y: .652, rx: .083, rz: .072, z: -.008 }, { y: .668, rx: .075, rz: .065, z: -.012 },
  ];
  emit(profileLoft(T, collar, { segments: high ? 34 : equipped ? 20 : 12, steps: high ? 18 : 8,
    fold: equipped ? (t, angle) => .0018 * Math.sin(t * 9 + 1.3 * Math.sin(angle)) : null }), M.fabricDark ?? M.rubber);

  const softOutline = symmetricOutline([[0, .101], [.157, .101], [.190, .128], [.198, .295],
    [.169, .400], [.129, .454], [.080, .473], [0, .473]]);
  const plateOutline = symmetricOutline([[0, .113], [.151, .113], [.178, .147], [.181, .300],
    [.155, .394], [.120, .439], [.078, .454], [0, .454]]);
  const rearOutline = symmetricOutline([[0, .119], [.155, .119], [.181, .161], [.181, .351],
    [.135, .451], [.086, .470], [0, .470]]);
  const frontSoft = fittedPanel(softOutline, trim, { base: .004, depth: .011, bevel: .007, bulge: .005 });
  const rearSoft = fittedPanel(softOutline, trim, { side: 1, base: .004, depth: .011, bevel: .007, bulge: .005 });
  const frontPlate = fittedPanel(plateOutline, M.armor, { base: (x, y) => (frontSoft(x, y) ?? .004) + clearance,
    depth: .016, bevel: .007, bulge: .008 });
  const rearPlate = fittedPanel(rearOutline, M.armor, { side: 1, base: (x, y) => (rearSoft(x, y) ?? .004) + clearance,
    depth: .015, bevel: .007, bulge: .007 });
  const apronOutline = symmetricOutline([[0, .102], [.175, .102], [.201, .128], [.207, .245], [.181, .281], [0, .281]]);
  const apron = fittedPanel(apronOutline, canvas, { base: (x, y) => Math.max(frontSoft(x, y) ?? 0, frontPlate(x, y) ?? 0) + clearance,
    depth: .008, bevel: .004, bulge: .003 });
  const frontCarrier = combine(frontSoft, frontPlate, apron), rearCarrier = combine(rearSoft, rearPlate);

  // One canonical right half wraps the ribs, then the symmetry system emits
  // its exact counterpart, including corrected winding and tangent signs.
  const wrap = (y, offset) => Array.from({ length: 10 }, (_, i) => normalPoint(mix(-1.05, 1.05, i / 9), y, offset));
  strap(wrap(.190, .009), .115, trim, { thickness: .012, across: [0, 1, 0], pair: true, name: 'cummerbund' });
  if (equipped) {
    for (const y of [.153, .190, .227]) {
      strap(wrap(y, .020), .018, canvas, { thickness: .004, across: [0, 1, 0], pair: true, name: 'cummerbund-webbing' });
      strap(trace(-1, [[-.183, y], [-.12, y], [0, y], [.12, y], [.183, y]], frontCarrier),
        .019, canvas, { thickness: .004, across: [0, 1, 0] });
    }
  }

  function shoulderTop(x) {
    let lo = .570, hi = .645;
    for (let i = 0; i < 22; i++) {
      const y = (lo + hi) / 2;
      if (crossPoint(0, y).x > x) lo = y; else hi = y;
    }
    return (lo + hi) / 2;
  }
  function shoulderBase(x, t) {
    const floor = mix(.335, .360, t), crest = shoulderTop(x);
    const y = floor + (crest - floor) * Math.sin(Math.PI * t) ** .85;
    return new T.Vector3(x, y, t === .5 ? section(y, 'z') : surfaceZ(t < .5 ? -1 : 1, x, y));
  }
  function shoulderPoint(x, t, lift = 0) {
    const e = .0001, p = shoulderBase(x, t);
    const across = shoulderBase(x + e, t).sub(shoulderBase(x - e, t));
    const along = shoulderBase(x, clamp(t + e, 0, 1)).sub(shoulderBase(x, clamp(t - e, 0, 1)));
    const normal = along.cross(across).normalize();
    const face = t < .5 ? frontCarrier : rearCarrier;
    const attachment = (face(x, p.y) + clearance) * Math.max(0, 1 - Math.sin(Math.PI * t) ** 1.3);
    return p.addScaledVector(normal, attachment + .004 + lift).toArray();
  }
  function shoulderRibbon(width, thickness, lift, material, name) {
    const ring = [[1, -.5], [1, .5], [.9, 1], [-.9, 1], [-1, .5], [-1, -.5], [-.9, -1], [.9, -1]];
    const mesh = gridSurface(T, 8, high ? 40 : equipped ? 24 : 14, (u, t) => {
      const [a, b] = ring[Math.round(u * 8) % 8];
      return shoulderPoint(.142 + a * width / 2, t, lift + b * thickness / 2);
    }, { wrap: true });
    emit(mesh, material, { pair: true, name });
  }
  shoulderRibbon(.052, .008, 0, trim, 'shoulder-pad');
  shoulderRibbon(.040, .004, .006, canvas, 'shoulder-webbing');
  if (high) {
    for (const x of [.127, .157]) cord(Array.from({ length: 18 }, (_, i) => shoulderPoint(x, i / 17, .009)),
      .0011, thread, true, 'shoulder-seam');
  }

  const adminOutline = symmetricOutline([[0, -.049], [.112, -.049], [.125, -.032], [.125, .040], [.113, .053], [0, .053]]);
  const admin = fittedPanel(adminOutline, trim, { y: .358, base: (x, y) => frontCarrier(x, y) + clearance,
    depth: .019, bevel: .006, bulge: .008 });
  const adminFlap = adminOutline.map(([x, y]) => [x * .96, y * .55]);
  const adminFlapFace = fittedPanel(adminFlap, canvas, { y: .383, base: (x, y) => (admin(x, y) ?? frontCarrier(x, y)) + clearance,
    depth: .008, bevel: .003, bulge: .003 });
  const patch = symmetricOutline([[0, -.012], [.048, -.012], [.053, -.007], [.053, .007], [.048, .012], [0, .012]]);
  fittedPanel(patch, M.accent, { y: .394, base: (x, y) => (adminFlapFace(x, y) ?? admin(x, y) ?? frontCarrier(x, y)) + clearance,
    depth: .002, bevel: .001, bulge: .001 });

  const pocket = symmetricOutline([[0, -.078], [.024, -.078], [.034, -.066], [.037, -.051],
    [.037, .047], [.032, .068], [.020, .078], [0, .078]]);
  const flap = symmetricOutline([[0, -.025], [.025, -.025], [.034, -.013], [.034, .009], [.025, .023], [0, .027]]);
  const pitch = BODY_DIMENSIONS.pocketPitch, pocketY = .192;
  const pouchCenters = [-2, -1, 0, 1, 2].map(i => [i * pitch, pocketY]);
  for (const column of [0, 1, 2]) {
    const x = column * pitch, pair = column > 0;
    const pouch = fittedPanel(pocket, canvas, { x, y: pocketY, pair, name: 'magazine-pouch-' + column,
      base: (gx, gy) => frontCarrier(gx, gy) + .008, depth: .058, bevel: .006, bulge: .009 });
    const flapFace = fittedPanel(flap, trim, { x, y: pocketY + .047, pair, name: 'magazine-flap-' + column,
      base: (gx, gy) => (pouch(gx, gy) ?? frontCarrier(gx, gy)) + clearance,
      depth: .010, bevel: .004, bulge: .003 });
    if (equipped) {
      const retention = [[x, pocketY + .070], [x, pocketY + .044], [x, pocketY + .020], [x, pocketY - .030]];
      const face = combine(pouch, flapFace);
      strap(trace(-1, retention, face), .013, canvas, { thickness: .003, pair, name: 'magazine-retention-' + column });
      const buckleOutline = symmetricOutline([[0, -.011], [.010, -.011], [.012, -.007], [.012, .007], [.010, .011], [0, .011]]);
      fittedPanel(buckleOutline, M.polymer, { x, y: pocketY + .013, pair, name: 'magazine-buckle-' + column,
        base: (gx, gy) => (pouch(gx, gy) ?? 0) + .007, depth: .005, bevel: .002, bulge: .001 });
    }
    if (high) cord(trace(-1, [[x - .026, pocketY - .048], [x - .020, pocketY - .064],
      [x, pocketY - .069], [x + .020, pocketY - .064], [x + .026, pocketY - .048]], pouch, .0018),
    .0011, trim, pair, 'magazine-seam-' + column);
  }

  // Auxiliary pockets use arc coordinates on the rib cage, keeping their back
  // surfaces against cloth while giving each mirrored pair its own space.
  function sidePanel(outline, material, angle, y, under, depth, name) {
    const face = faceSampler(outline, depth, .006, .008);
    const mesh = panelVolume(T, outline, { depth, bevel: .006, bulge: .008, steps: panelSteps });
    const positions = mesh.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const lx = positions.getX(i), gy = y + positions.getY(i);
      const theta = angle + lx / section(gy, 'rx');
      positions.setXYZ(i, ...normalPoint(theta, gy, under + depth - positions.getZ(i)));
    }
    mesh.computeVertexNormals();
    emit(mesh, material, { pair: true, name });
    return (lx, ly) => normalPoint(angle + lx / section(y + ly, 'rx'), y + ly, under + (face(lx, ly) ?? depth));
  }
  if (equipped) {
    const utility = symmetricOutline([[0, -.061], [.030, -.061], [.039, -.049], [.039, .045], [.030, .060], [0, .060]]);
    sidePanel(utility, trim, -.10, .183, .008, .062, 'flank-utility-pouch');
    const radio = symmetricOutline([[0, -.057], [.023, -.057], [.028, -.048], [.028, .049], [.022, .057], [0, .057]]);
    const radioFace = sidePanel(radio, M.polymer, .55, .287, .012, .042, 'rear-radio');
    const antenna = radioFace(.010, .057);
    emit(new T.CylinderGeometry(.0042, .0048, .143, high ? 10 : 6), M.rubber,
      { at: [antenna[0], antenna[1] + .070, antenna[2]], pair: true, name: 'radio-antenna' });
  }

  const packOutline = symmetricOutline([[0, .080], [.107, .080], [.137, .099], [.153, .135], [.160, .279],
    [.150, .391], [.135, .435], [.103, .475], [.056, .489], [0, .489]]);
  const pack = fittedPanel(packOutline, trim, { side: 1, base: (x, y) => rearCarrier(x, y) + clearance,
    depth: .100, bevel: .014, bulge: .026 });
  const packPanel = packOutline.map(([x, y]) => [x * .86, .280 + (y - .280) * .86]);
  const outerPack = fittedPanel(packPanel, canvas, { side: 1, base: (x, y) => (pack(x, y) ?? 0) + .002,
    depth: .011, bevel: .007, bulge: .004 });
  const packSurface = combine(pack, outerPack);
  if (equipped) {
    const packPocket = symmetricOutline([[0, -.052], [.102, -.052], [.113, -.032], [.113, .044], [.100, .060], [0, .060]]);
    fittedPanel(packPocket, trim, { y: .381, side: 1, base: (x, y) => packSurface(x, y) + clearance,
      depth: .018, bevel: .007, bulge: .008 });
    const compression = [[.096, .113], [.102, .169], [.106, .249], [.102, .343], [.092, .418], [.075, .463]];
    strap(trace(1, compression, packSurface), .018, trim, { thickness: .004, pair: true, name: 'pack-compression' });
    const zipper = [[.073, .103], [.129, .136], [.146, .212], [.146, .313], [.132, .396], [.101, .447], [.058, .473]];
    cord(trace(1, zipper, pack, .001), high ? .003 : .004, M.rubber, true, 'pack-zipper');
    const rows = high ? 5 : 3;
    for (let row = 0; row < rows; row++) {
      const y = .145 + row * .173 / (rows - 1);
      strap(trace(1, [[-.111, y], [-.065, y], [0, y], [.065, y], [.111, y]], packSurface),
        .019, canvas, { thickness: .004, across: [0, 1, 0] });
      if (high) for (let col = -2; col <= 2; col++) {
        const x = col * .042;
        strap(trace(1, [[x, y - .007], [x, y + .007]], packSurface, .0055),
          .0017, thread, { thickness: .001, across: [1, 0, 0] });
      }
    }
    const [leftAnchor, rightAnchor] = trace(1, [[-.053, .470], [.053, .470]], pack, .007);
    // The intentional free grip spans its two fitted anchors.
    const handle = [[0, 0], [.11, .030], [.30, .048], [.70, .048], [.89, .030], [1, 0]]
      .map(([t, lift]) => [mix(leftAnchor[0], rightAnchor[0], t), leftAnchor[1] + lift,
        mix(leftAnchor[2], rightAnchor[2], t) + Math.sin(Math.PI * t) * .008]);
    strap(handle, .016, trim, { thickness: .006, across: [0, 0, 1] });
  }
  spine.userData.torsoFit = {
    uniform: 'monotone continuous sections', layers: ['uniform', 'softcarrier', 'plate', 'webbing', 'pouches'],
    clearance, pouchCenters, pouchPitch: pitch, pouchWidth: BODY_DIMENSIONS.pocketWidth,
    pouchGap: pitch - BODY_DIMENSIONS.pocketWidth, pouchProjection: 'common garment curvature',
  };
}
