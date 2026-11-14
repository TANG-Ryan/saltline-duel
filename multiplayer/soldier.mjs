import { createSoldierSurfaceKit } from './soldier-surfaces.mjs';
import { createWorldLoadout } from './world-loadout.mjs';
import { buildSoldierHead } from './soldier-head.mjs';
import { buildSoldierTorso } from './soldier-torso.mjs';
import { buildSoldierLeg, buildSoldierWaist, LEG } from './soldier-lower.mjs';
import { RULES } from './shared/simulation.mjs';
import { createSoldierGLTFBody } from './soldier-gltf.mjs';
import { BODY_DIMENSIONS, createSymmetrySystem } from './soldier-symmetry.mjs';

const { hipHeight, halfStance, thigh: thighLength, shin: shinLength, sole } = LEG;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// Body landmarks in the spine's frame (metres, forward -Z). The rifle butt sits
// in the right shoulder pocket just in front of the carrier strap.
export const SPINE_ANCHORS = Object.freeze({
  shoulderRight: [BODY_DIMENSIONS.shoulderHalf, BODY_DIMENSIONS.shoulderY, BODY_DIMENSIONS.shoulderZ],
  shoulderLeft: [-BODY_DIMENSIONS.shoulderHalf, BODY_DIMENSIONS.shoulderY, BODY_DIMENSIONS.shoulderZ],
  buttReady: [0.155, 0.56, -0.055],
  buttLow: [0.07, 0.45, -0.17],
  magPouch: [-0.07, 0.25, -0.27],
  head: [0, 0.803, -0.005],
});

// Stance tuning. Angles in radians; negative blade brings the left shoulder forward.
const STANCE = Object.freeze({
  blade: -0.45, kneelBlade: -0.45, sprintBlade: -0.1,
  pelvisShare: 0.45, cheekRoll: 0, cheekDrop: 0.07, headShift: 0,
  pitchToSpine: 0.24, lowReadyPitch: -0.72, lowReadyYaw: 0.32,
  crouchDrop: 0.56, crouchLean: 0.4, sprintLean: 0.16,
});

// Articulated hierarchy in metres. Feet are the origin and forward is -Z, matching
// the snapshot adapter and the authoritative capsule. Rendering never affects
// collision or damage.
export function createAvatar(ctx) {
  const T = ctx.THREE;
  const kit = createSoldierSurfaceKit(T);
  const M = kit.materials;
  const root = new T.Group();
  root.name = 'tactical-soldier';
  root.visible = false;
  const ownedGeometry = new Set(), skeletons = new Set();
  const own = geometry => { ownedGeometry.add(geometry); return geometry; };
  const symmetry = createSymmetrySystem(T, own);
  const group = (parent, name, x = 0, y = 0, z = 0) => {
    const node = new T.Group();
    node.name = name;
    node.position.set(x, y, z);
    parent.add(node);
    return node;
  };

  function buildRig(detail) {
    const high = detail === 2, equipped = detail > 0;
    const segments = high ? 16 : equipped ? 10 : 6;
    const model = group(root, ['soldier-far', 'soldier-medium', 'soldier-near'][detail]);
    const hip = group(model, 'pelvis', 0, hipHeight, 0);
    hip.rotation.order = 'YXZ';
    const spine = group(hip, 'spine');
    spine.rotation.order = 'YXZ';
    const waistBone = new T.Bone();
    waistBone.name = 'trouser-waist-anchor'; waistBone.position.y = hipHeight; model.add(waistBone);
    const head = group(spine, 'head', ...SPINE_ANCHORS.head);
    head.rotation.order = 'YXZ';
    const anchors = {};
    for (const name of ['shoulderRight', 'shoulderLeft', 'buttReady', 'buttLow', 'magPouch']) {
      anchors[name] = group(spine, 'anchor-' + name, ...SPINE_ANCHORS[name]);
    }
    const batches = new Map();
    const parts = parent => {
      if (!batches.has(parent)) batches.set(parent, []);
      return batches.get(parent);
    };
    const part = (parent, geometry, material, position = [0, 0, 0], rotation, scale) => {
      parts(parent).push({ geometry, material, position, rotation, scale });
    };
    const box = (parent, material, size, position, radius = 0.015, rotation) =>
      part(parent, kit.rounded(...size, radius), material, position, rotation);
    const loft = (parent, material, rings, position = [0, 0, 0], rotation) =>
      part(parent, kit.loft(rings, segments), material, position, rotation);
    const tube = (parent, material, points, radius = 0.004) =>
      part(parent, kit.tube(points, radius, high ? 6 : 4), material);
    const cylinder = (parent, material, r, length, position, rotation = [Math.PI / 2, 0, 0]) => {
      part(parent, own(new T.CylinderGeometry(r, r, length, high ? 12 : 6)), material, position, rotation);
    };
    const buckle = (parent, x, y, z, width = 0.032) => {
      box(parent, M.polymer, [width, 0.025, 0.012], [x, y, z], 0.005);
      if (high) box(parent, M.metal, [width * 0.6, 0.004, 0.015], [x, y, z - 0.005], 0.001);
    };
    const seam = (parent, x, y, z, length, horizontal = true) => {
      if (!high) return;
      for (let i = 0; i < Math.round(length / 0.011); i++) {
        const d = -length / 2 + i * 0.011;
        box(parent, M.stitch, horizontal ? [0.006, 0.0018, 0.0016] : [0.0018, 0.006, 0.0016],
          [x + (horizontal ? d : 0), y + (horizontal ? 0 : d), z], 0.0006);
      }
    };

    const symmetryPair = (parent, geometry, material, position, rotation, scale, name) =>
      symmetry.pair(part, parent, geometry, material, position, rotation, scale, `lod-${detail}:${name || 'part'}`);
    const api = { T, M, high, equipped, segments, own, part, box, loft, tube, cylinder, buckle, seam, skeletons, waistBone, symmetry, symmetryPair };
    buildSoldierTorso(spine, api);
    buildSoldierHead(head, api);
    buildSoldierWaist(hip, api);
    const leftLeg = buildSoldierLeg(model, -1, api), rightLeg = buildSoldierLeg(model, 1, api);
    for (const leg of [leftLeg, rightLeg]) leg.thigh.rotation.order = 'ZXY';

    for (const [parent, list] of batches) kit.batch(parent, list, parent.name + '-surfaces');
    return { group: model, hip, spine, head, waistBone, anchors, leftLeg, rightLeg };
  }

  // Repeated geometry within this avatar shares cached buffers. Material batches
  // are per rigid joint; no per-stitch/per-buckle draw calls.
  const rigs = [buildRig(2), buildRig(1), buildRig(0)];
  const authored = createSoldierGLTFBody(ctx);
  if (authored) {
    root.add(authored.root);
    for (const rig of rigs) rig.group.traverse(node => { if (node.isMesh) node.visible = false; });
  }
  const loadout = createWorldLoadout(ctx, { sleeveColor: M.fabric.color.getHex(), bandColor: M.webbingDark.color.getHex(), shoulderMaterial: M.fabric });
  const shieldMaterial = new T.MeshBasicMaterial({ color: 0xffb347, wireframe: true, transparent: true, opacity: 0.16, depthWrite: false });
  const shield = new T.Mesh(own(new T.CapsuleGeometry(0.34, 1.08, 4, 10)), shieldMaterial);
  shield.name = 'spawn-shield';
  shield.position.y = 0.9;
  shield.visible = false;
  root.add(shield);
  ctx.scene.add(root);

  const stats = rigs.map(rig => {
    let triangles = 0, draws = 0;
    rig.group.traverse(node => {
      if (node.isMesh) { draws++; triangles += (node.geometry.index?.count || node.geometry.attributes.position.count) / 3; }
    });
    return { triangles, draws };
  });

  // Smoothed animation state. Everything is derived from the interpolated
  // snapshot, so both clients reconstruct the same pose from the same data.
  const state = {
    crouch: 0, kneel: 0, sprint: 0, air: 0, phase: 0, speed: 0,
    lx: 0, lz: 0, flinch: 0, flinchSide: 0, deathAt: -Infinity, deathLife: null,
    landAt: -Infinity, reloadStart: null, reloadTotal: 0,
  };
  let flashUntil = -Infinity, shotAt = -Infinity, lastClock, previousLife, previousAlive = false, disposed = false, lod = 0;
  let reviewPose = false, reviewFingers = null;
  const debug = { rigs, materials: M, stats, loadout, state, authored, symmetry: {
    anchors: { shoulderLeft: SPINE_ANCHORS.shoulderLeft, shoulderRight: SPINE_ANCHORS.shoulderRight },
    dimensions: BODY_DIMENSIONS, pairs: symmetry.pairs,
    legs: rigs.map(rig => ({ leftGeometry: rig.leftLeg.pants.geometry, rightGeometry: rig.rightLeg.pants.geometry })),
  }, get lod() { return lod; } };
  debug.setReviewPose = enabled => {
    if (!!enabled === reviewPose) return;
    reviewPose = !!enabled;
    if (reviewPose) reviewFingers = Object.values(loadout.arms).map(arm => [arm, arm.pose.slice()]);
    else {
      for (const [arm, pose] of reviewFingers || []) arm.setFingers(pose);
      reviewFingers = null; loadout.pivot.visible = true;
    }
  };

  const v = new T.Vector3(), pouch = new T.Vector3(), shoulderR = new T.Vector3(), shoulderL = new T.Vector3(), butt = new T.Vector3(), buttLow = new T.Vector3();
  const inModel = (rig, node, out) => rig.group.worldToLocal(node.getWorldPosition(out));

  // Analytic two-bone leg IK in 3D. Abduction about Z, then hip flexion and knee
  // flexion in the abducted plane; the boot stays level unless a toe pitch is set.
  function solveLeg(leg, hip, foot, toePitch = 0) {
    leg.thigh.position.copy(hip);
    const dx = foot.x - hip.x, dz = foot.z - hip.z;
    const drop = Math.max(0.005, hip.y - foot.y);
    const abduct = Math.atan2(dx, drop);
    const down = Math.hypot(dx, drop);
    const reach = Math.max(0.03, Math.min(thighLength + shinLength - 0.001, Math.hypot(down, dz)));
    const hipAngle = Math.atan2(-dz, down) + Math.acos(clamp((thighLength ** 2 + reach ** 2 - shinLength ** 2) / (2 * thighLength * reach), -1, 1));
    const kneeAngle = -(Math.PI - Math.acos(clamp((thighLength ** 2 + shinLength ** 2 - reach ** 2) / (2 * thighLength * shinLength), -1, 1)));
    leg.thigh.rotation.set(hipAngle, 0, abduct);
    leg.knee.rotation.x = kneeAngle;
    // Level the boot in the model frame (cancelling hip abduction as well as
    // flexion) so the sole meets the floor flat; then apply the toe pitch.
    leg.thigh.updateMatrix(); leg.knee.updateMatrix();
    bootParent.copy(leg.thigh.quaternion).multiply(leg.knee.quaternion).invert();
    leg.boot.quaternion.copy(bootParent).multiply(bootPitch.setFromAxisAngle(xAxis, toePitch));
    // Track the same LBS point on the continuous trouser surface. Keeping the
    // shell at the raw hinge caused it to float away when the knee folded.
    leg.kneePad.rotation.x = kneeAngle * 0.5;
    const t = clamp((.074 - .012) / (.074 + .066), 0, 1);
    const lower = 1 - t * t * (3 - 2 * t);
    padPoint.set(0, -.012, -.093);
    padLower.copy(padPoint).applyAxisAngle(xAxis, kneeAngle).add(new T.Vector3(0, -thighLength, 0));
    padPoint.y -= thighLength;
    padPoint.lerp(padLower, lower);
    padLocal.set(0, -.012, -.093).applyAxisAngle(xAxis, kneeAngle * .5);
    leg.kneePad.position.copy(padPoint).sub(padLocal);
  }

  const hipPoint = new T.Vector3(), footPoint = new T.Vector3();
  const bootParent = new T.Quaternion(), bootPitch = new T.Quaternion(), xAxis = new T.Vector3(1, 0, 0);
  const padPoint = new T.Vector3(), padLower = new T.Vector3(), padLocal = new T.Vector3();
  const euler = new T.Euler(), qPelvis = new T.Quaternion(), qSpine = new T.Quaternion(), qHead = new T.Quaternion();
  function poseLegs(rig, hipY, hipZ, pelvisYaw) {
    const { speed, lx, lz, phase, crouch, kneel, sprint, air } = state;
    const moving = smooth(speed / 1.1);
    const cycle = 0.75 + 0.23 * speed;
    const dirX = speed > 0.01 ? lx / speed : 0, dirZ = speed > 0.01 ? lz / speed : -1;
    const amplitude = cycle * 0.24 * moving * (1 - 0.35 * crouch);
    const liftHeight = (0.075 + 0.07 * sprint) * moving * (1 - 0.4 * crouch);
    for (const [leg, sign] of [[rig.leftLeg, -1], [rig.rightLeg, 1]]) {
      const phi = phase + (sign < 0 ? 0 : Math.PI);
      const swing = Math.cos(phi), lift = Math.max(0, -Math.sin(phi));
      // Pelvis yaw carries the hip sockets around the vertical axis.
      const hx = sign * halfStance * Math.cos(pelvisYaw), hz = hipZ - sign * halfStance * Math.sin(pelvisYaw);
      hipPoint.set(hx, hipY, hz);
      const width = sign * (halfStance + 0.02 * crouch + 0.015 * Math.abs(dirX) * moving);
      let fx = width + dirX * amplitude * 0.62 * swing;
      let fz = (crouch ? -0.04 * crouch : 0) + dirZ * amplitude * swing;
      // Strafing feet pass without crossing the centre line.
      fx = sign < 0 ? Math.min(fx, -0.045) : Math.max(fx, 0.045);
      let fy = sole + lift * liftHeight;
      let toe = -0.35 * lift * moving * (dirZ < 0 ? 1 : -0.5);
      // Air: knees tuck, feet trail slightly.
      fy += air * (0.16 + 0.05 * sign);
      fz += air * 0.06;
      // Kneeling: right knee down sitting on its heel, left foot planted forward.
      if (kneel > 0) {
        // Leave real thigh/calf volume between the seat and rear heel. Putting
        // the ankle at pelvis height folded the knee almost 180 degrees and
        // made the two thick cloth surfaces occupy the same space.
        const kx = sign < 0 ? -0.17 : 0.13, kz = sign < 0 ? hipZ - 0.33 : hipZ + 0.035;
        const ky = sign < 0 ? sole : 0.18;
        fx = mix(fx, kx, kneel); fz = mix(fz, kz, kneel); fy = mix(fy, ky, kneel);
        toe = mix(toe, sign < 0 ? 0 : -0.45, kneel);
      }
      footPoint.set(fx, fy, fz);
      solveLeg(leg, hipPoint, footPoint, toe);
    }
  }

  function poseBody(rig, p, dt, clock) {
    const { crouch, kneel, sprint, speed, phase, air, flinch } = state;
    const moving = smooth(speed / 1.1);
    const ready = 1 - sprint;
    const dying = !p.alive && Number.isFinite(state.deathAt) ? clamp((clock - state.deathAt) / 0.75, 0, 1) : 0;

    // Pelvis height: crouch, gait bob (two per cycle), landing compression.
    const bob = moving * (0.012 + 0.018 * sprint) * (0.5 - 0.5 * Math.cos(2 * phase));
    const land = Math.exp(-Math.max(0, clock - state.landAt) * 9) * 0.06 * (1 - crouch);
    const hipY = hipHeight - crouch * STANCE.crouchDrop - bob - land - dying * 0.28;
    const hipZ = crouch * 0.15 + kneel * 0.01;
    rig.hip.position.set(0, hipY, hipZ);

    const blade = mix(mix(STANCE.blade, STANCE.kneelBlade, kneel), STANCE.sprintBlade, sprint);
    const sway = moving * Math.sin(phase) * (0.05 + 0.06 * sprint);
    const pelvisYaw = blade * STANCE.pelvisShare + sway;
    const forwardLean = -crouch * (STANCE.crouchLean - 0.08 * (1 - kneel)) - sprint * STANCE.sprintLean - moving * 0.04 * Math.max(0, -state.lz / Math.max(speed, 0.01));
    // Aiming up leans the chest back; kneeling keeps it small to stay in the capsule.
    const pitchLean = clamp(p.pitch, -1.2, 1.2) * STANCE.pitchToSpine * ready * (1 - 0.9 * crouch);
    const flinchLean = flinch * 0.16;
    // Orientations are composed in the model frame so the torso always leans
    // along the aim direction, whatever its twist: the head stays over the
    // authoritative capsule instead of swinging sideways with the blade.
    qPelvis.setFromEuler(euler.set(0, pelvisYaw, moving * Math.sin(phase) * 0.025, 'YXZ'));
    qSpine.setFromEuler(euler.set(forwardLean + pitchLean + flinchLean - dying * 0.3, blade, -sway * 0.4 + flinch * state.flinchSide * 0.08, 'XYZ'));
    rig.hip.quaternion.copy(qPelvis);
    rig.spine.quaternion.copy(qPelvis).invert().multiply(qSpine);
    rig.waistBone.position.copy(rig.hip.position); rig.waistBone.quaternion.copy(rig.hip.quaternion);

    // Head looks down the sights: faces the aim, follows pitch, then drops and
    // rolls onto the stock in the ready position.
    rig.head.position.set(SPINE_ANCHORS.head[0] + STANCE.headShift * ready, SPINE_ANCHORS.head[1], SPINE_ANCHORS.head[2] - 0.01 * ready);
    qHead.setFromEuler(euler.set(
      p.pitch * mix(0.9, 0.5, sprint) - STANCE.cheekDrop * ready + flinch * 0.2,
      -blade * 0.1,
      STANCE.cheekRoll * ready, 'YXZ'));
    rig.head.quaternion.copy(qSpine).invert().multiply(qHead);
    poseLegs(rig, hipY, hipZ, pelvisYaw);
    return { ready, dying };
  }

  function poseDeath(rig, clock) {
    const t = clamp((clock - state.deathAt) / 0.9, 0, 1);
    // Collapse about the feet, accelerating like a fall, with a small sideways roll.
    const fall = t * t * (3 - 2 * t) * t;
    rig.group.rotation.set(fall * 1.38, 0, fall * 0.22 * state.flinchSide);
    rig.group.position.y = -Math.max(0, (clock - state.deathAt) - 1.3) * 0.35;
  }

  function poseSymmetryReview(rig) {
    rig.group.rotation.set(0, 0, 0); rig.group.position.y = 0;
    rig.hip.position.set(0, hipHeight, 0);
    rig.hip.quaternion.identity(); rig.spine.quaternion.identity(); rig.head.quaternion.identity();
    rig.waistBone.position.copy(rig.hip.position); rig.waistBone.quaternion.identity();
    rig.head.position.fromArray(SPINE_ANCHORS.head);
    const savedCrouch = state.crouch; state.crouch = 0;
    for (const [leg, sign] of [[rig.leftLeg, -1], [rig.rightLeg, 1]]) {
      solveLeg(leg, new T.Vector3(sign * halfStance, hipHeight, 0), new T.Vector3(sign * halfStance, sole, 0));
    }
    state.crouch = savedCrouch;
    rig.group.updateMatrixWorld(true);
    loadout.pivot.visible = false;
    for (const [side, arm] of Object.entries(loadout.arms)) {
      const sign = side === 'right' ? 1 : -1;
      const shoulder = new T.Vector3(sign * BODY_DIMENSIONS.shoulderHalf, hipHeight + BODY_DIMENSIONS.shoulderY, BODY_DIMENSIONS.shoulderZ);
      const wrist = new T.Vector3(sign * .305, .96, BODY_DIMENSIONS.shoulderZ);
      const orientation = new T.Quaternion().setFromEuler(new T.Euler(-Math.PI / 2, 0, sign * .12));
      const pole = arm.findPole(shoulder, wrist, orientation, new T.Vector3(sign * .8, -.5, .1));
      loadout.debug.shoulders[side].copy(shoulder);
      arm.setFingers('relaxed'); arm.setTrigger(0); arm.solve(shoulder, wrist, orientation, pole);
    }
    loadout.syncShoulderCovers();
    root.updateMatrixWorld(true);
  }

  return {
    root, debug,
    shoot(clock = performance.now() / 1000) {
      shotAt = clock;
      flashUntil = clock + 0.055;
      loadout.shoot(clock);
    },
    /** Visual reaction for a confirmed hit on this player. */
    hit(from) {
      state.flinch = 1;
      if (from && Number.isFinite(from.x)) {
        v.set(from.x - root.position.x, 0, from.z - root.position.z).applyAxisAngle(new T.Vector3(0, 1, 0), -root.rotation.y);
        state.flinchSide = Math.sign(v.x) || 1;
      } else state.flinchSide = Math.random() < 0.5 ? -1 : 1;
    },
    update(p, clock) {
      if (disposed) return;
      if (!p) { root.visible = false; flashUntil = shotAt = -Infinity; return; }
      const newLife = previousLife !== p.lifeId;
      const dt = lastClock === undefined ? 1 / 60 : Math.max(0, Math.min(0.05, clock - lastClock));
      lastClock = clock;
      if (newLife) {
        previousLife = p.lifeId;
        state.deathAt = -Infinity;
        state.phase = 0; state.flinch = 0;
      }
      // Death: keep the body for the collapse, then hide it.
      if (!p.alive && previousAlive && !newLife) state.deathAt = clock;
      previousAlive = p.alive;
      const dead = !p.alive;
      const deathAge = clock - state.deathAt;
      root.visible = p.alive || (dead && deathAge < 1.9);
      if (!root.visible) { flashUntil = shotAt = -Infinity; return; }
      if (dead) flashUntil = shotAt = -Infinity;

      // Local velocity relative to facing; smoothing hides 20 Hz snapshot steps.
      const vx = p.vel?.x ?? 0, vz = p.vel?.z ?? 0;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const lx = dead ? 0 : vx * c - vz * s, lz = dead ? 0 : vx * s + vz * c;
      const k = newLife ? 1 : 1 - Math.exp(-12 * dt);
      state.lx = mix(state.lx, lx, k); state.lz = mix(state.lz, lz, k);
      state.speed = Math.hypot(state.lx, state.lz);
      // Distance-driven cadence: one cycle per stride length, so feet do not skate.
      state.phase = (state.phase + TAU * state.speed * dt / (0.75 + 0.23 * state.speed)) % (TAU * 64);
      const blend = (key, goal, rate) => { state[key] = newLife ? goal : mix(state[key], goal, 1 - Math.exp(-rate * dt)); };
      const wasAir = state.air > 0.5;
      blend('crouch', p.crouching ? 1 : 0, 14);
      blend('sprint', p.sprinting && !p.crouching && state.speed > 2 ? 1 : 0, 9);
      blend('air', p.onGround === false ? 1 : 0, 12);
      blend('kneel', p.crouching && state.speed < 0.35 ? 1 : 0, 7);
      if (wasAir && state.air < 0.5) state.landAt = clock;
      state.flinch *= Math.exp(-7 * dt);

      root.position.set(p.pos.x, p.pos.y, p.pos.z);
      root.rotation.y = p.yaw;
      const distance = ctx.camera ? root.position.distanceTo(ctx.camera.position) : 0;
      // Hysteresis avoids switching geometry repeatedly at a threshold.
      if (lod === 0 && distance > 15) lod = distance > 34 ? 2 : 1;
      else if (lod === 1 && distance < 13) lod = 0;
      else if (lod === 1 && distance > 34) lod = 2;
      else if (lod === 2 && distance < 30) lod = distance < 13 ? 0 : 1;
      rigs.forEach((rig, i) => { rig.group.visible = i === lod; });
      const rig = rigs[lod];
      if (loadout.root.parent !== rig.group) rig.group.add(loadout.root);

      const { ready } = poseBody(rig, p, dt, clock);
      if (dead) poseDeath(rig, clock);
      else { rig.group.rotation.set(0, 0, 0); rig.group.position.y = 0; }
      rig.group.updateMatrixWorld(true);
      inModel(rig, rig.anchors.shoulderRight, shoulderR);
      inModel(rig, rig.anchors.shoulderLeft, shoulderL);
      inModel(rig, rig.anchors.buttReady, butt);
      inModel(rig, rig.anchors.buttLow, buttLow);
      inModel(rig, rig.anchors.magPouch, pouch);
      if (authored) {
        authored.root.position.copy(rig.group.position);
        authored.root.quaternion.copy(rig.group.quaternion);
        authored.update(p, dt);
        const socket = (name, out) => rig.group.worldToLocal(authored.sockets[name].getWorldPosition(out));
        socket('Shoulder_R', shoulderR); socket('Shoulder_L', shoulderL);
        socket('WeaponSocket', butt); socket('MagSocket', pouch);
        buttLow.copy(butt).add(new T.Vector3(0, -.1, -.06));
      }
      // Reload progress from the authoritative remaining time, run on the local
      // clock between 20 Hz snapshots and re-synchronised if it drifts.
      let reload = -1;
      if (p.alive && p.reloadRemaining > 0) {
        const total = p.ammo === 0 ? RULES.reloadEmpty : RULES.reloadTactical;
        const start = clock - (total - p.reloadRemaining);
        if (state.reloadStart === null || Math.abs(state.reloadStart - start) > 0.15 || state.reloadTotal !== total) {
          state.reloadStart = start; state.reloadTotal = total;
        }
        reload = clamp((clock - state.reloadStart) / total, 0, 1);
      } else state.reloadStart = null;
      butt.lerp(buttLow, 1 - ready);

      const kick = dead ? 0 : Math.exp(-Math.max(0, clock - shotAt) * 26) * 0.03;
      const deathDrop = dead ? smooth(deathAge / 0.8) : 0;
      const pitch = mix(mix(clamp(p.pitch, -1.35, 1.35), STANCE.lowReadyPitch, 1 - ready), -1.5, deathDrop);
      loadout.update(dt, clock, {
        kick, pitch,
        yaw: STANCE.lowReadyYaw * (1 - ready),
        cant: 0,
        butt, pouch, reload, shoulders: { right: shoulderR, left: shoulderL },
        trigger: p.alive && clock < flashUntil ? 1 : 0,
      });
      if (reviewPose && !authored) poseSymmetryReview(rig);
      loadout.flash.visible = p.alive && clock < flashUntil;
      shield.visible = p.alive && p.invulnerableFor > 0;
      shield.scale.y = p.crouching ? 1.15 / 1.8 : 1;
      shield.position.y = p.crouching ? 0.575 : 0.9;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      kit.dispose();
      ownedGeometry.forEach(geometry => geometry.dispose());
      skeletons.forEach(skeleton => skeleton.dispose());
      authored?.dispose();
      loadout.dispose();
      shieldMaterial.dispose();
    }
  };
}
