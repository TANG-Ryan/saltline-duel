import { panelVolume, profileLoft, strapMesh } from './soldier-meshes.mjs';
import { BODY_DIMENSIONS } from './soldier-symmetry.mjs';

export const LEG = Object.freeze({ hipHeight: BODY_DIMENSIONS.hipY, halfStance: BODY_DIMENSIONS.hipHalf, thigh: BODY_DIMENSIONS.thigh, shin: BODY_DIMENSIONS.shin, sole: 0.09 });
const { hipHeight, halfStance, thigh: thighLength, shin: shinLength } = LEG;
const kneeCenter = -thighLength;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const oval = (x, y, rx, ry, count) => Array.from({ length: count }, (_, i) => {
  const a = i / count * Math.PI * 2;
  return [x + rx * Math.cos(a), y + ry * Math.sin(a)];
});

export function buildSoldierWaist(hip, api) {
  const { T, M, high, equipped, own, part, box, buckle, symmetryPair } = api;
  const n = high ? 32 : equipped ? 20 : 12;
  const loft = (mat, rings, fold) => part(hip, own(profileLoft(T, rings, { segments: n, steps: high ? 18 : 9, fold })), mat);
  loft(M.fabric, [
    // Round the seat into the crotch rather than ending a broad shell on a
    // shallow, flat underside. The upper rings remain inside the belt.
    { y: -.140, rx: .025, rz: .018 }, { y: -.115, rx: .090, rz: .065 },
    { y: -.085, rx: .142, rz: .102 }, { y: -.045, rx: .171, rz: .120, power: .96 },
    { y: .001, rx: .176, rz: .125, power: .96 }, { y: .045, rx: .167, rz: .117 },
    { y: .085, rx: .154, rz: .104 },
  ]);
  const beltShape = [
    { y: -.022, rx: .172, rz: .118, power: .7 }, { y: -.017, rx: .179, rz: .125, power: .7 },
    { y: .019, rx: .176, rz: .123, power: .7 }, { y: .022, rx: .171, rz: .119, power: .7 },
  ];
  part(hip, own(profileLoft(T, beltShape, { segments: n, steps: 5, cap: false })), M.rubber);
  buckle(hip, 0, 0, -.128, .061);
  if (!equipped) return;
  const pouch = [[-.04, -.06], [.032, -.06], [.044, -.041], [.04, .055], [.025, .066], [-.033, .061], [-.043, .044]];
  symmetryPair(hip, own(panelVolume(T, pouch, { depth: .045, bevel: .008, bulge: .011 })), M.webbing,
    [.175, -.048, .025], [0, -Math.PI * .47, -.05], undefined, 'belt-utility-pouch');
  if (high) for (const x of [-.13, -.078, .078, .13]) {
    const z = -.125 * Math.sqrt(1 - (x / .21) ** 2);
    box(hip, M.webbing, [.016, .064, .008], [x, 0, z - .006], .002, [0, -x * 2, x * .4]);
    box(hip, M.stitch, [.006, .0018, .0016], [x, .026, z - .011], .0006);
  }
}

// One deforming cloth sleeve per leg from hip to boot cuff. The two original
// IK pivots now also drive the skin; no detached rigid knee sphere or cut edge.
export function buildSoldierLeg(model, sign, api) {
  const { T, M, high, equipped, own, skeletons, symmetry } = api;
  const left = sign < 0;
  // Every source below is authored once in the right-leg frame. Reflect the
  // complete local surface and SRS transform, never its fold phase or dimensions.
  const part = (parent, geometry, material, position = [0, 0, 0], rotation, scale) => api.part(parent,
    left ? symmetry.reflectGeometry(geometry) : geometry, material,
    left ? symmetry.mirrorPoint(position) : position,
    left ? symmetry.mirrorRotation(rotation) : rotation, scale);
  const box = (parent, material, size, position, radius = .015, rotation) => {
    // Match the existing weapon/soldier three-interval chamfer construction.
    const r = Math.max(.00001, Math.min(radius, ...size.map(d => d / 2 - .00001)));
    const geometry = own(new T.BoxGeometry(...size, 3, 3, 3));
    const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv;
    const half = size.map(d => d / 2), direction = new T.Vector3();
    for (let i = 0; i < p.count; i++) {
      const value = [p.getX(i), p.getY(i), p.getZ(i)].map((v, a) =>
        Math.sign(v) * (Math.abs(v) > half[a] - .000001 ? half[a] : half[a] - r));
      const core = value.map((v, a) => T.MathUtils.clamp(v, -half[a] + r, half[a] - r));
      direction.set(value[0] - core[0], value[1] - core[1], value[2] - core[2]).normalize();
      p.setXYZ(i, core[0] + direction.x * r, core[1] + direction.y * r, core[2] + direction.z * r);
      n.setXYZ(i, direction.x, direction.y, direction.z);
      const a = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
      uv.setXY(i, a[0] >= a[1] && a[0] >= a[2] ? value[2] : value[0],
        a[1] >= a[0] && a[1] >= a[2] ? value[2] : value[1]);
    }
    part(parent, geometry, material, position, rotation);
  };
  const tube = (parent, material, points, radius) => {
    const curve = new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p)), false, 'centripetal');
    const length = curve.getLength();
    const geometry = own(new T.TubeGeometry(curve, Math.max(2, Math.min(96, Math.ceil(length / .025))), radius, high ? 6 : 4, false));
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * length, uv.getY(i) * Math.PI * 2 * radius);
    part(parent, geometry, material);
  };
  const buckle = (parent, x, y, z, width = .032) => {
    box(parent, M.polymer, [width, .025, .012], [x, y, z], .005);
    if (high) box(parent, M.metal, [width * .6, .004, .015], [x, y, z - .005], .001);
  };
  const group = (parent, name, y, bone = false) => {
    const node = bone ? new T.Bone() : new T.Group();
    node.name = name; node.position.y = y; parent.add(node); return node;
  };
  const thigh = group(model, sign < 0 ? 'left-thigh' : 'right-thigh', hipHeight, true);
  thigh.position.x = sign * halfStance;
  const knee = group(thigh, 'knee', kneeCenter, true);
  const boot = group(knee, 'ankle', -shinLength);
  const kneePad = group(thigh, 'floating-knee-pad', kneeCenter);
  const n = high ? 36 : equipped ? 22 : 12;
  const pantsBottom = -.656, pantsTop = .032;
  const kneeT = (kneeCenter - pantsBottom) / (pantsTop - pantsBottom);
  const fold = (t, a) => {
    const strength = high ? 1 : equipped ? .7 : .38;
    const front = .5 - .5 * Math.sin(a);
    const kneeBand = Math.exp(-(((t - kneeT) / .095) ** 2));
    const cuffStack = Math.exp(-(((t - .085) / .09) ** 2));
    const thighDrape = Math.exp(-(((t - .76) / .22) ** 2));
    // The bent knee gathers fabric behind the hinge while its front stays taut.
    // The cuff stacks above the boot; the upper thigh has only a broad drape.
    return strength * (
      .008 * kneeBand * Math.sin(58 * (t - kneeT) + .75 * Math.cos(2 * a)) * (.16 + .84 * (1 - front)) +
      .0065 * cuffStack * Math.sin(81 * t + 1.2 * Math.sin(a)) * (.85 + .15 * Math.cos(2 * a)) -
      .002 * thighDrape * Math.cos(2 * a));
  };
  const canonicalPants = own(profileLoft(T, [
    { y: -.656, rx: .056, rz: .055, z: .005 }, { y: -.618, rx: .072, rz: .066, z: .012 },
    { y: -.548, rx: .074, rz: .077, z: .017 }, { y: -.465, rx: .077, rz: .078, z: .004 },
    { y: -.392, rx: .074, rz: .080, z: -.014 }, { y: -.318, rx: .084, rz: .089 },
    { y: -.227, rx: .093, rz: .098, z: .002 }, { y: -.139, rx: .103, rz: .107, x: .009 },
    { y: -.052, rx: .106, rz: .111, x: -.004 }, { y: .032, rx: .096, rz: .097, x: -.027 },
  // Both hems are covered by the pelvis and boot. Internal flat caps become
  // visible intersecting fans when this continuous cloth bends deeply.
  ], { segments: n, steps: high ? 44 : equipped ? 23 : 11, cap: false, fold }));
  const position = canonicalPants.attributes.position;
  const indices = new Uint16Array(position.count * 4), weights = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) {
    // The hinge sits inside the smooth 14 cm fabric blend zone.
    const lower = 1 - smooth(kneeCenter - .074, kneeCenter + .066, position.getY(i));
    // Attach only the waistband to the pelvis. Extending this influence far
    // down the thigh pulls a flat cloth fan behind the hip in a deep kneel.
    const waist = smooth(-.055, .015, position.getY(i));
    indices[i * 4 + 1] = 1; indices[i * 4 + 2] = 2;
    weights[i * 4] = (1 - lower) * (1 - waist);
    weights[i * 4 + 1] = lower * (1 - waist); weights[i * 4 + 2] = waist;
  }
  canonicalPants.setAttribute('skinIndex', new T.BufferAttribute(indices, 4));
  canonicalPants.setAttribute('skinWeight', new T.BufferAttribute(weights, 4));
  canonicalPants.userData = { canonical: 'right-trousers', kneeY: kneeCenter, kneeBlend: [-.074, .066] };
  const pantsGeometry = left ? symmetry.reflectGeometry(canonicalPants) : canonicalPants;
  pantsGeometry.translate(sign * halfStance, hipHeight, 0);
  const pants = new T.SkinnedMesh(pantsGeometry, M.fabric);
  pants.name = `continuous-trousers-${sign < 0 ? 'left' : 'right'}`;
  pants.castShadow = pants.receiveShadow = true;
  pants.frustumCulled = false; // IK moves vertices beyond the static bind bounds.
  model.add(pants);
  model.updateWorldMatrix(true, true);
  // A waist attachment bone keeps the top hem on the pelvis during deep bends;
  // the original thigh/knee IK pivots and lengths are unchanged.
  const skeleton = new T.Skeleton([thigh, knee, api.waistBone]);
  pants.bind(skeleton, pants.matrixWorld);
  skeletons.add(skeleton);

  const pad = [[-.046, -.087], [.046, -.087], [.062, -.06], [.066, -.015], [.061, .033], [.043, .058],
    [-.043, .058], [-.061, .033], [-.066, -.015], [-.062, -.06]];
  const padBase = pad.map(([x, y]) => [x * 1.15, y * 1.12]);
  part(kneePad, own(panelVolume(T, padBase, { depth: .029, bevel: .009, bulge: .009, steps: 4 })), M.webbing, [0, -.012, -.093]);
  part(kneePad, own(panelVolume(T, pad, { depth: .013, bevel: .005, bulge: .020, steps: high ? 7 : 4 })), M.armor, [0, -.012, -.102]);
  if (equipped) {
    for (const y of [-.049, .023]) for (const side of [-1, 1]) {
      part(kneePad, own(strapMesh(T, [[side * .048, y, -.102], [side * .069, y, -.076],
        [side * .075, y + .004, -.053]], .023, { thickness: .004, steps: high ? 9 : 5, across: [0, 1, 0] })), M.rubber);
      if (high && side === 1) buckle(kneePad, side * .065, y, -.071, .024);
    }
    if (high) for (const [x, y] of [[-.036, .019], [.036, .019], [-.034, -.062], [.034, -.062]]) {
      part(kneePad, own(panelVolume(T, oval(x, y, .005, .005, 8), { depth: .003, bevel: .001, bulge: .001, steps: 2 })), M.metal, [0, -.012, -.121]);
    }
    const cargo = [[-.057, -.072], [.044, -.073], [.057, -.052], [.060, .04], [.039, .065], [-.047, .062], [-.059, .04]];
    part(thigh, own(panelVolume(T, cargo, { depth: .028, bevel: .012, bulge: .014, steps: 4 })), M.fabric, [.094, -.189, .014], [0, -1.28, -.12]);
    const flap = [[-.058, -.02], [.049, -.02], [.061, -.01], [.052, .024], [-.05, .022]];
    part(thigh, own(panelVolume(T, flap, { depth: .014, bevel: .006, bulge: .008, steps: 3 })), M.webbing, [.106, -.135, .009], [0, -1.28, -.12]);
  }

  // A last-shaped boot: broad toe, narrower heel/arch, raised instep and
  // cylindrical cuff in the *same* surface. Separate sole retains its crease.
  const bootRings = [
    { y: -.061, rx: .072, rz: .139, z: -.056, power: .63 }, { y: -.036, rx: .074, rz: .138, z: -.056, power: .65 },
    { y: -.011, rx: .069, rz: .129, z: -.047, power: .7 }, { y: .016, rx: .066, rz: .100, z: -.021, power: .82 },
    { y: .042, rx: .059, rz: .074, z: .003 }, { y: .074, rx: .060, rz: .063, z: .010 },
    { y: .109, rx: .068, rz: .068, z: .010 }, { y: .132, rx: .068, rz: .069, z: .010 },
  ];
  const soleRings = [
    { y: -.090, rx: .066, rz: .135, z: -.057, power: .64 }, { y: -.083, rx: .075, rz: .145, z: -.057, power: .66 },
    { y: -.064, rx: .076, rz: .145, z: -.057, power: .64 }, { y: -.059, rx: .072, rz: .140, z: -.056, power: .65 },
  ];
  part(boot, own(profileLoft(T, bootRings, { segments: n, steps: high ? 26 : equipped ? 14 : 8 })), M.leather);
  part(boot, own(profileLoft(T, soleRings, { segments: n, steps: 5 })), M.rubber);
  if (equipped) {
    part(boot, own(profileLoft(T, [{ y: .118, rx: .069, rz: .071, z: .010 }, { y: .133, rx: .070, rz: .071, z: .010 }], { segments: n, steps: 3, cap: false })), M.rubber);
    const y = [-.015, .004, .025, .046, .065, .084], z = [-.164, -.139, -.108, -.071, -.056, -.053];
    if (high) {
      for (let i = 0; i < y.length - 1; i++) {
        const w = .036 - i * .0025;
        tube(boot, M.webbing, [[-w, y[i], z[i]], [0, (y[i] + y[i + 1]) * .5, (z[i] + z[i + 1]) * .5 - .004], [w - .002, y[i + 1], z[i + 1]]], .0021);
        tube(boot, M.webbing, [[w, y[i], z[i]], [0, (y[i] + y[i + 1]) * .5 + .002, (z[i] + z[i + 1]) * .5 - .004], [-w + .002, y[i + 1], z[i + 1]]], .0021);
      }
      for (let i = 0; i < 6; i++) for (const side of [-1, 1]) {
        const zz = -.166 + i * .040, xx = side * (i === 2 || i === 3 ? .059 : .064);
        box(boot, M.rubber, [.024, .010, .022], [xx, -.085, zz], .003, [0, side * .27, 0]);
      }
      part(boot, own(strapMesh(T, [[0, .099, .071], [0, .137, .076], [0, .144, .058], [0, .12, .054]], .019, { thickness: .004, steps: 9 })), M.webbing);
    }
  }
  return { thigh, knee, boot, kneePad, pants };
}
