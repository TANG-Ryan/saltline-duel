import { gridSurface } from './soldier-meshes.mjs';
import { createSymmetrySystem } from './soldier-symmetry.mjs';

/**
 * The original PAC-9 and original articulated arms in world space.
 * Geometry and the rifle's materials stay shared with the first-person weapon;
 * transforms, skeletons, the flash uniforms and the world sleeve material are
 * owned per instance.
 *
 * Frame: the loadout root lives in the soldier's model frame (feet origin,
 * forward -Z). Each frame the body supplies the shoulder joints and the butt
 * pocket in that frame; the rifle pivots about the butt so the bore follows the
 * snapshot pitch exactly while the torso, stance and recoil move around it.
 */
export const RIFLE_BUTT_Z = 0.347;
const MAG_REST = Object.freeze([0, -0.02, -0.0665]);
// Wrist target on the magazine body in rifle space; the palm wraps the
// magazine from the support side with the fingers toward the muzzle.
const MAG_GRIP = Object.freeze([-0.052, -0.19, -0.02]);
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Support-hand keyframes over reload progress t (0..1): where the left wrist
 * is ('fore' | 'mag' | 'pouch') and whether the hand carries a magazine.
 */
export function reloadKeys(t) {
  if (t < 0) return { from: 'fore', to: 'fore', k: 0, carry: false, magIn: true, tilt: 0 };
  const tilt = smoothstep(0, 0.12, t) * (1 - smoothstep(0.88, 1, t));
  if (t < 0.14) return { from: 'fore', to: 'mag', k: smoothstep(0.02, 0.14, t), carry: false, magIn: true, tilt };
  if (t < 0.4) return { from: 'mag', to: 'pouch', k: smoothstep(0.16, 0.4, t), carry: t < 0.24, magIn: false, tilt };
  if (t < 0.5) return { from: 'pouch', to: 'pouch', k: 0, carry: false, magIn: false, tilt };
  if (t < 0.74) return { from: 'pouch', to: 'mag', k: smoothstep(0.5, 0.74, t), carry: true, magIn: false, tilt };
  if (t < 0.8) return { from: 'mag', to: 'mag', k: 0, carry: false, magIn: true, tilt };
  return { from: 'mag', to: 'fore', k: smoothstep(0.8, 0.92, t), carry: false, magIn: true, tilt };
}

const SLEEVE_PATCH = `
  if (vArmRest.w > 0.5) {
    // Third-person garment: the sleeve takes the uniform's fabric. The hi-vis
    // band becomes a subdued elastic arm band; the knit cuff stays darker.
    float slA = vArmHand.x;
    float slHem = 1.0 - smoothstep(0.0655, 0.0675, slA);
    float slBand = aBand(slA, 0.128, 0.172, 0.0012);
    float slEdge = aBand(slA, 0.1268, 0.1292, 0.0006) + aBand(slA, 0.1708, 0.1732, 0.0006);
    float slAng = atan(vArmHand.z, vArmHand.w);
    float slSeam = exp(-pow(atan(sin(slAng + 1.9), cos(slAng + 1.9)) / 0.045, 2.0));
    vec3 slBase = uSleeveColor * (0.84 + 0.24 * smoothstep(-0.9, 0.6, vArmHand.y));
    armCol = mix(slBase, uSleeveBand, slBand);
    armCol *= 1.0 - 0.32 * slEdge - 0.18 * slSeam * (1.0 - slHem);
    armCol = mix(armCol, uSleeveColor * 0.58 * (0.7 + 0.45 * (0.5 + 0.5 * cos(slAng * 44.0))), slHem);
    armRough = mix(mix(0.9, 0.86, slBand), 0.9, slHem);
    armKind = mix(mix(0.0, 0.0, slBand), 3.0, slHem);
    armH = 0.00025 * slBand + 0.0004 * slEdge + armH * slHem;
  }
  armCol = armMicro(`;

/** World-only copy of the original arm material with a recoloured sleeve. */
function createWorldArmMaterial(T, original, sleeveColor, bandColor) {
  const material = new T.MeshStandardMaterial();
  material.copy(original);
  material.name = 'saltline_arm_world';
  const sleeve = { value: new T.Color(sleeveColor) }, band = { value: new T.Color(bandColor) };
  material.onBeforeCompile = (shader, renderer) => {
    original.onBeforeCompile(shader, renderer);
    shader.uniforms.uSleeveColor = sleeve;
    shader.uniforms.uSleeveBand = band;
    const marker = 'armCol = armMicro(';
    if (!shader.fragmentShader.includes(marker)) throw new Error('Original arm shader layout changed');
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform float uArmWet;', 'uniform float uArmWet; uniform vec3 uSleeveColor; uniform vec3 uSleeveBand;')
      .replace(marker, SLEEVE_PATCH);
  };
  material.customProgramCacheKey = () => 'saltline-arm-world-1';
  return material;
}

export function createWorldLoadout(ctx, { sleeveColor = 0x4a4b46, bandColor = 0x3a3b35, shoulderMaterial } = {}) {
  const T = ctx.THREE;
  const source = ctx.weapon?.rigs?.rifle;
  if (!source?.root || !source.holds?.grip || !source.holds?.fore) {
    throw new Error('The original PAC-9 rig is required for the soldier loadout');
  }
  if (typeof ctx.modelFactories?.createArm !== 'function') {
    throw new Error('The original arm factory is required for the soldier loadout');
  }
  const originalArmMaterial = ctx.weapon?.arms?.right?.mesh?.material;
  if (!originalArmMaterial?.onBeforeCompile) throw new Error('The original arm material is required for the soldier loadout');

  const root = new T.Group();
  root.name = 'original-pac9-loadout';
  // The pivot sits on the butt pocket; the rifle hangs forward of it.
  const pivot = new T.Group();
  pivot.name = 'rifle-butt-pivot';
  root.add(pivot);
  const rifle = source.root.clone(true);
  rifle.name = 'world-pac9-original';
  rifle.position.set(0, 0, -RIFLE_BUTT_Z);
  rifle.quaternion.identity();
  rifle.scale.set(1, 1, 1);
  rifle.visible = true;
  pivot.add(rifle);

  // A parallel traversal maps the exact source objects onto their clones.
  const originals = [], copies = [];
  source.root.traverse(node => originals.push(node));
  rifle.traverse(node => copies.push(node));
  const copied = node => copies[originals.indexOf(node)];
  const flash = copied(source.flash);
  if (!flash?.material?.isShaderMaterial) throw new Error('Original PAC-9 flash is unavailable');
  const flashMaterial = source.flash.material.clone();
  flash.name = 'muzzle-flash';
  flash.material = flashMaterial;
  flash.visible = false;
  flash.rotation.set(0, 0, 0);
  flash.scale.setScalar(1);
  flashMaterial.uniforms.uInt.value = 0;
  flashMaterial.uniforms.uHeat.value = 0;
  flashMaterial.uniforms.uJet.value = 1;

  // wS() creates four fixed material batches, the bolt, then the magazine.
  // Restore their bind poses even when the source was cloned during a reload.
  const bolt = rifle.children[4];
  const magazine = rifle.children[5];
  const round = magazine?.children[1];
  if (!bolt?.isMesh || !magazine?.isGroup || !round?.isMesh) {
    flashMaterial.dispose();
    throw new Error('Original PAC-9 part layout changed');
  }
  bolt.name = 'world-pac9-bolt';
  magazine.name = 'world-pac9-magazine';
  round.name = 'world-pac9-chamber-round';
  bolt.position.set(0, 0, 0);
  magazine.position.set(0, -0.02, -0.0665);
  magazine.quaternion.identity();
  magazine.scale.set(1, 1, 1);
  magazine.visible = round.visible = true;
  rifle.traverse(node => {
    node.layers.set(0);
    if (node.isMesh) {
      node.frustumCulled = true;
      node.receiveShadow = true;
      node.castShadow = !node.material.transparent;
    }
  });
  flash.castShadow = flash.receiveShadow = false;

  const armMaterial = createWorldArmMaterial(T, originalArmMaterial, sleeveColor, bandColor);
  const arms = {
    right: ctx.modelFactories.createArm({ side: 'right', layer: 0, material: armMaterial }),
    left: ctx.modelFactories.createArm({ side: 'left', layer: 0, material: armMaterial }),
  };
  const shoulderCovers = [];
  const coverState = new Map();
  const coverSymmetry = createSymmetrySystem(T, geometry => shoulderCovers.push(geometry));
  let canonicalCover;
  if (shoulderMaterial) for (const arm of Object.values(arms)) {
    // A tailored sleeve-head bridges the garment armhole and original sleeve.
    // It follows the original upper-arm bone rather than leaving a static cap
    // behind when the weapon raises. The original arm buffers stay untouched.
    const buildCover = () => gridSurface(T, 24, 10, (u, v) => {
      const a = u * Math.PI * 2, z = -.105 + v * .138;
      const r = .001 + .061 * Math.sin(Math.PI * (.15 + .85 * v));
      return [Math.cos(a) * r, Math.sin(a) * r * 1.06, .57 + z];
    }, { wrap: true });
    if (!canonicalCover) { canonicalCover = buildCover(); shoulderCovers.push(canonicalCover); }
    const geometry = arm.side === 'right' ? canonicalCover : coverSymmetry.reflectGeometry(canonicalCover);
    const count = geometry.attributes.position.count;
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute('skinIndex', new T.BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new T.BufferAttribute(weights, 4));
    const cover = new T.SkinnedMesh(geometry, shoulderMaterial);
    cover.name = 'sleeve-head-' + arm.side;
    cover.castShadow = cover.receiveShadow = true;
    cover.frustumCulled = false;
    arm.group.add(cover); cover.bind(arm.skeleton, arm.mesh.bindMatrix);
    coverState.set(arm.side, { geometry, bind: geometry.attributes.position.array.slice(), lastDelta: new T.Vector3(Infinity, 0, 0) });
  }
  const shoulders = { right: new T.Vector3(0.19, 1.43, 0.09), left: new T.Vector3(-0.19, 1.43, -0.09) };
  const poles = { right: null, left: null };
  const poleKeys = { right: null, left: null };
  const poleHints = {
    right: new T.Vector3(0.35, -0.93, 0.1),
    left: new T.Vector3(-0.45, -0.88, 0),
  };
  const hold = { right: source.holds.grip, left: source.holds.fore };
  const wrists = {
    right: { p: new T.Vector3(), q: new T.Quaternion() },
    left: { p: new T.Vector3(), q: new T.Quaternion() },
  };
  for (const [side, arm] of Object.entries(arms)) {
    arm.group.position.set(0, 0, 0);
    arm.group.quaternion.identity();
    arm.group.scale.set(1, 1, 1);
    arm.setLayer(0);
    arm.setVisible(true);
    arm.mesh.castShadow = arm.mesh.receiveShadow = true;
    arm.setFingers(side === 'right' ? (source.holds.trigger?.pose || hold.right.pose) : hold.left.pose);
    root.add(arm.group);
  }

  const rifleMatrix = new T.Matrix4(), rifleQuaternion = new T.Quaternion();
  const pitchQuaternion = new T.Quaternion(), yawQuaternion = new T.Quaternion(), rollQuaternion = new T.Quaternion();
  const X = new T.Vector3(1, 0, 0), Y = new T.Vector3(0, 1, 0), Z = new T.Vector3(0, 0, 1);
  const butt = new T.Vector3(0.12, 1.4, -0.1);
  const pouch = new T.Vector3(-0.07, 1.1, -0.27);
  const magRest = new T.Vector3(...MAG_REST), magGrip = new T.Vector3(...MAG_GRIP);
  const inverseRifle = new T.Matrix4();
  const targets = {
    fore: { p: new T.Vector3(), q: new T.Quaternion() },
    mag: { p: new T.Vector3(), q: new T.Quaternion() },
    pouch: { p: new T.Vector3(), q: new T.Quaternion() },
  };
  const magTwist = new T.Quaternion().setFromEuler(new T.Euler(0.15, 0, -1.2));
  const pouchTwist = new T.Quaternion().setFromEuler(new T.Euler(-0.9, 0.3, -1.4));
  const sourceParent = source.root.parent;
  const sharedsame = {
    rifleGeometry: originals.every((node, i) => !node.isMesh || node.geometry === copies[i].geometry),
    rifleMaterials: originals.every((node, i) => !node.isMesh || node === source.flash || node.material === copies[i].material),
    flashMaterialIndependent: flashMaterial !== source.flash.material,
    rightArmGeometry: !ctx.weapon.arms?.right || arms.right.mesh.geometry === ctx.weapon.arms.right.mesh.geometry,
    leftArmGeometry: !ctx.weapon.arms?.left || arms.left.mesh.geometry === ctx.weapon.arms.left.mesh.geometry,
    // The world sleeve is a separate material instance by design.
    armMaterialIndependent: arms.right.mesh.material === armMaterial && armMaterial !== originalArmMaterial,
  };
  const debug = {
    sharedsame, shoulders, butt, poles, wrists, bolt, magazine, round, pivot, armMaterial,
    sourceParentUnchanged: () => source.root.parent === sourceParent,
    muzzle: source.muzzle.slice(),
    triangles: source.info.tris + arms.right.triCount + arms.left.triCount,
    shoulderCovers: Object.fromEntries([...coverState].map(([side, value]) => [side, value.geometry])),
  };
  let shotAt = -Infinity, disposed = false;

  /**
   * pose.butt / pose.shoulders.{left,right} are model-frame points from the body.
   * pose.pitch is the bore elevation; yaw and cant are small stance offsets.
   */
  function syncShoulderCovers() {
    for (const [side, arm] of Object.entries(arms)) {
      const cover = coverState.get(side);
      if (cover) {
        const delta = shoulders[side].clone().sub(arm.ik.shoulder)
          .applyQuaternion(arm.bone.upperArm.quaternion.clone().invert());
        if (cover.lastDelta.distanceToSquared(delta) > 1e-12) {
          const positions = cover.geometry.attributes.position;
          for (let vertex = 0; vertex < positions.count; vertex++) {
            const v = Math.floor(vertex / 25) / 10;
            const blend = smoothstep(.45, 1, v), i = vertex * 3;
            positions.setXYZ(vertex, cover.bind[i] + delta.x * blend,
              cover.bind[i + 1] + delta.y * blend, cover.bind[i + 2] + delta.z * blend);
          }
          positions.needsUpdate = true; cover.geometry.computeVertexNormals();
          cover.lastDelta.copy(delta);
        }
      }
    }
  }

  function update(dt, clock, { kick = 0, trigger = 0, pitch = 0, yaw = 0, cant = 0, butt: buttAt, shoulders: from, pouch: pouchAt, reload = -1 } = {}) {
    if (disposed) return;
    const elapsed = Math.max(0, clock - shotAt);
    if (buttAt) butt.copy(buttAt);
    if (pouchAt) pouch.copy(pouchAt);
    const keys = reloadKeys(reload);
    // Roll the magazine well toward the support hand and dip the muzzle.
    cant += -0.5 * keys.tilt;
    pitch += (-0.32 - pitch * 0.5) * keys.tilt;
    if (from) { shoulders.right.copy(from.right); shoulders.left.copy(from.left); }
    // Recoil drives the butt straight back into the shoulder and lifts the muzzle.
    pitchQuaternion.setFromAxisAngle(X, pitch + kick * 0.35);
    yawQuaternion.setFromAxisAngle(Y, yaw);
    rollQuaternion.setFromAxisAngle(Z, cant);
    pivot.quaternion.copy(yawQuaternion).multiply(pitchQuaternion).multiply(rollQuaternion);
    pivot.position.copy(butt).addScaledVector(Z.clone().applyQuaternion(pivot.quaternion), kick * 0.45);
    pivot.updateMatrix();
    rifle.updateMatrix();
    rifleMatrix.multiplyMatrices(pivot.matrix, rifle.matrix);
    rifleQuaternion.copy(pivot.quaternion);
    targets.fore.p.copy(hold.left.p).applyMatrix4(rifleMatrix);
    targets.fore.q.copy(rifleQuaternion).multiply(hold.left.q);
    targets.mag.p.copy(magGrip).applyMatrix4(rifleMatrix);
    targets.mag.q.copy(rifleQuaternion).multiply(magTwist);
    targets.pouch.p.copy(pouch);
    targets.pouch.q.copy(pivot.quaternion).multiply(pouchTwist);
    for (const side of ['right', 'left']) {
      const arm = arms[side], wrist = wrists[side];
      if (side === 'left') {
        const a = targets[keys.from], b = targets[keys.to];
        wrist.p.copy(a.p).lerp(b.p, keys.k);
        wrist.q.copy(a.q).slerp(b.q, keys.k);
      } else {
        wrist.p.copy(hold[side].p).applyMatrix4(rifleMatrix);
        wrist.q.copy(rifleQuaternion).multiply(hold[side].q);
      }
      // findPole samples 24 IK solutions; refresh it only when the reach changes.
      const reach = wrist.p.clone().sub(shoulders[side]);
      const key = poleKeys[side];
      if (!poles[side] || !key || key.distanceToSquared(reach) > 0.0009) {
        poles[side] = arm.findPole(shoulders[side], wrist.p, wrist.q, poleHints[side]);
        poleKeys[side] = reach;
      }
      // The clavicle may protract for extreme aim, while the bind dimensions
      // stay mirrored and the original .30/.27 m limb lengths stay fixed.
      arm.solve(shoulders[side], wrist.p, wrist.q, poles[side], { lean: .065 });
      arm.setTrigger(side === 'right' ? trigger : 0);
      arm.update(dt);
    }
    syncShoulderCovers();
    // The magazine rides in the support hand while carried; the spent one
    // is dropped (hidden) between leaving the well and the fresh one appearing.
    if (keys.carry) {
      inverseRifle.copy(rifleMatrix).invert();
      magazine.position.copy(wrists.left.p).applyMatrix4(inverseRifle).sub(magGrip).add(magRest);
      magazine.visible = true;
    } else {
      magazine.position.copy(magRest);
      magazine.visible = keys.magIn;
    }
    round.visible = keys.magIn;
    // The same original bolt timing and flash shader profile, with independent clocks.
    bolt.position.z = elapsed < 0.072 ? 0.062 * 0.95 * Math.sin(Math.PI * elapsed / 0.072) : 0;
    const flashLife = 0.055;
    flashMaterial.uniforms.uInt.value = elapsed < flashLife ? 9.5 * Math.sqrt(1 - elapsed / flashLife) : 0;
    flashMaterial.uniforms.uHeat.value = 0;
    flash.visible = elapsed < flashLife;
  }

  update(0, performance.now() / 1000);
  return {
    root, pivot, rifle, source, arms, flash, update, debug, syncShoulderCovers,
    shoot(clock = performance.now() / 1000) {
      if (disposed) return;
      shotAt = clock;
      flashMaterial.uniforms.uSeed.value = Math.random() * 100;
      flashMaterial.uniforms.uJet.value = 0.6 + Math.random() * 0.6;
      flash.rotation.z = (Math.random() - 0.5) * 0.4;
      arms.right.impulse(0.55);
      arms.left.impulse(0.35);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      arms.right.dispose();
      arms.left.dispose();
      flashMaterial.dispose();
      armMaterial.dispose();
      shoulderCovers.forEach(geometry => geometry.dispose());
    },
  };
}
