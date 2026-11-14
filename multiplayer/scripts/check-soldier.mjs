#!/usr/bin/env node
/** Verify the procedural soldier and capture color and neutral orthographic views. */
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createGameServer } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.SALTLINE_SOLDIER_CAPTURE_DIR || resolve(here, '../test-artifacts/soldier-symmetry'));
const historicalBootstrap = process.env.SALTLINE_SOLDIER_HISTORICAL_BOOTSTRAP === '1';
const captures = {};
const app = createGameServer();
const errors = [];
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) {
  try { await access(localChrome); executablePath = localChrome; } catch {}
}

try {
  await mkdir(output, { recursive: true });
  const address = await app.listen(0, '127.0.0.1');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--enable-webgl', ...(process.env.SALTLINE_SOFTWARE_GL === '1'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  // Older snapshots called an optional import even when the fixture requested
  // their legacy character. Allow these snapshots to produce an isolated baseline.
  if (historicalBootstrap) {
    await page.route('**/multiplayer/character-bootstrap.mjs', route => route.fulfill({
      contentType: 'text/javascript', body: 'export async function loadCharacterArt() { return null; }',
    }));
  }
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(message.location().url)) return;
    errors.push(`${message.location().url || 'page'}: ${message.text()}`);
  });
  console.log('Soldier: loading existing engine and weapon shaders...');
  await page.goto(origin + '/?show=weapon&q=low&noaudio=1', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => window.__ready && window.__G?.THREE, undefined, { timeout: 180_000 });
  assert.equal(await page.evaluate(() => window.__fatal), null);
  const capture = async name => {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path });
    captures[name] = path;
  };
  const initial = await page.evaluate(async () => {
    const ctx = window.__G;
    ctx.renderer.setAnimationLoop(null);
    const T = ctx.THREE;
    const { createAvatar } = await import('/multiplayer/soldier.mjs');
    const { tracePlayerHit, sanitizeInput, RULES } = await import('/multiplayer/shared/simulation.mjs');
    const scene = new T.Scene();
    scene.background = new T.Color(0x242e31);
    const camera = new T.PerspectiveCamera(32, 1, 0.01, 150);
    camera.position.set(-2.1, 1.7, -3.4);
    camera.lookAt(0, 0.95, 0);
    scene.add(new T.HemisphereLight(0xdce8ef, 0x4d4939, 2.3));
    const sun = new T.DirectionalLight(0xffe9cc, 3.2);
    sun.position.set(-3, 6, -4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -2;
    sun.shadow.camera.right = sun.shadow.camera.top = 2;
    sun.shadow.normalBias = 0.025;
    scene.add(sun);
    const rim = new T.DirectionalLight(0x8bb8cf, 1.8);
    rim.position.set(2, 2.8, 2);
    scene.add(rim);
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1080, 1080);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshStandardMaterial({ color: 0x303a3d, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    scene.add(floor);
    renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:9999;width:100vw;height:100vh';
    document.body.appendChild(renderer.domElement);
    const constructionStart = performance.now();
    const avatar = createAvatar({ ...ctx, THREE: T, scene, camera, renderer });
    const constructionMs = performance.now() - constructionStart;
    if (avatar.debug.assetId || avatar.debug.authored) throw new Error('The turntable must use the procedural soldier and the original arms');
    const player = {
      alive: true, lifeId: 1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, crouching: false, sprinting: false, onGround: true,
      invulnerableFor: 0, reloadRemaining: 0, ads: 0,
    };
    // A fixed synthetic clock makes gait poses, recoil and pose comparisons repeatable.
    let poseTime = 10;
    const clock = () => poseTime;
    function advance(frames = 1) {
      for (let i = 0; i < frames; i++) avatar.update(player, poseTime += 1 / 60);
    }
    const render = () => {
      advance();
      renderer.render(scene, camera);
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    };
    const ortho = new T.OrthographicCamera(-1.04, 1.04, 1.04, -1.04, 0.01, 150);
    const orthoTarget = new T.Vector3(0, 0.93, 0);
    const orthoDistance = 4;
    const neutralMaterial = new T.MeshStandardMaterial({ color: 0xb9babd, roughness: 0.88, metalness: 0 });
    const orthoViews = { front: [0, 0, -1], side: [-1, 0, 0], back: [0, 0, 1] };
    function renderOrthographic(view, neutral, poseFraming = false) {
      const target = orthoTarget.clone();
      const halfHeight = poseFraming ? 1.45 : 1.04;
      if (poseFraming) target.y = 1.25;
      ortho.left = ortho.bottom = -halfHeight;
      ortho.right = ortho.top = halfHeight;
      ortho.updateProjectionMatrix();
      ortho.position.fromArray(orthoViews[view]).multiplyScalar(orthoDistance).add(target);
      ortho.lookAt(target);
      const originalMaterials = new Map(), originalLights = new Map();
      if (neutral) {
        avatar.root.traverseVisible(node => {
          if (!node.isMesh || !node.geometry.getAttribute('normal')) return;
          originalMaterials.set(node, node.material);
          node.material = Array.isArray(node.material) ? node.material.map(() => neutralMaterial) : neutralMaterial;
        });
        scene.traverse(node => {
          if (!node.isLight || !node.color) return;
          originalLights.set(node, [node.color.clone(), node.groundColor?.clone()]);
          node.color.setHex(0xffffff);
          node.groundColor?.setHex(0x515151);
        });
      }
      try { renderer.render(scene, ortho); }
      finally {
        for (const [node, material] of originalMaterials) node.material = material;
        for (const [light, [color, ground]] of originalLights) {
          light.color.copy(color);
          if (ground) light.groundColor.copy(ground);
        }
      }
    }
    // Static arm bounds intentionally cover the entire IK workspace. Measure
    // the actually posed skin, rather than treating that conservative box as art.
    const bounds = () => {
      avatar.root.updateMatrixWorld(true);
      const box = new T.Box3(), vertex = new T.Vector3();
      let minimumObject = null;
      avatar.root.traverseVisible(node => {
        if (!node.isMesh || node.material?.wireframe) return;
        const positions = node.geometry.getAttribute('position');
        if (node.isSkinnedMesh) node.skeleton.update();
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i);
          if (node.isSkinnedMesh) node.applyBoneTransform(i, vertex);
          vertex.applyMatrix4(node.matrixWorld);
          if (vertex.y < box.min.y) minimumObject = node.name;
          box.expandByPoint(vertex);
        }
      });
      return { min: box.min.toArray(), max: box.max.toArray(), height: box.max.y - box.min.y, minimumObject };
    };
    const hashArray = array => {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      let hash = 2166136261;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      return hash.toString(16).padStart(8, '0');
    };
    const geometryHash = geometry => Object.fromEntries([
      ...Object.entries(geometry.attributes).map(([name, attribute]) => [name, hashArray(attribute.array)]),
      ['index', geometry.index ? hashArray(geometry.index.array) : null],
    ]);
    const meshesOf = root => { const nodes = []; root.traverse(n => { if (n.isMesh) nodes.push(n); }); return nodes; };
    const localState = () => ({
      rifle: meshesOf(ctx.weapon.rigs.rifle.root).map(n => ({ geometry: geometryHash(n.geometry), position: n.position.toArray(), quaternion: n.quaternion.toArray(), visible: n.visible })),
      arms: ['right', 'left'].map(side => ctx.weapon.arms[side].bones.map(bone => ({ position: bone.position.toArray(), quaternion: bone.quaternion.toArray() }))),
    });
    const loadout = avatar.debug.loadout;
    if (!loadout?.rifle || !loadout?.arms?.right) throw new Error('Original world loadout factory was not integrated');
    const originalRifleMeshes = meshesOf(loadout.source.root);
    const rifleShared = meshesOf(loadout.rifle).map((mesh, i) => {
      const source = originalRifleMeshes[i];
      return { material: source.material.name || source.material.type,
        geometryShared: mesh.geometry === source.geometry,
        materialShared: mesh === loadout.flash || mesh.material === source.material,
        hashEqual: JSON.stringify(geometryHash(mesh.geometry)) === JSON.stringify(geometryHash(source.geometry)) };
    });
    const armShared = ['right', 'left'].map(side => {
      const arm = loadout.arms[side], original = ctx.weapon.arms[side];
      return { side, geometryShared: arm.mesh.geometry === original.mesh.geometry,
        // The world sleeve wraps the original arm shader with a uniform recolour.
        worldSleeveMaterial: arm.mesh.material !== original.mesh.material && arm.mesh.material.name === 'saltline_arm_world' &&
          arm.mesh.material === loadout.debug.armMaterial,
        independentSkeleton: arm.skeleton !== original.skeleton && arm.bones.every((bone, i) => bone !== original.bones[i]),
        boneNames: arm.bones.map(b => b.name), attributes: Object.keys(arm.mesh.geometry.attributes),
        triangles: arm.mesh.geometry.index.count / 3 };
    });
    const originalState = localState();
    render();
    let meshes = 0, vertices = 0, materialNames = new Set();
    avatar.root.traverse(node => {
      if (!node.isMesh) return;
      meshes++;
      const geometry = node.geometry, p = geometry.getAttribute('position');
      const n = geometry.getAttribute('normal');
      if (!p || (n && p.count !== n.count) || (!n && !node.material?.isShaderMaterial)) throw new Error('Position/normal attribute mismatch: ' + node.name);
      for (const value of p.array) if (!Number.isFinite(value)) throw new Error('Nonfinite vertex: ' + node.name);
      if (n) for (const value of n.array) if (!Number.isFinite(value)) throw new Error('Nonfinite normal: ' + node.name);
      vertices += p.count;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) materialNames.add(material.name || material.type);
    });
    const shot = { origin: { x: 0, y: 1.4, z: -3 }, dir: { x: 0, y: 0, z: 1 } };
    const hitBefore = tracePlayerHit({ boxes: [] }, shot, player);
    window.__soldierCheck = { T, scene, camera, renderer, avatar, player, advance, render, renderOrthographic, bounds, clock, tracePlayerHit, shot, hitBefore, createAvatar, templateContext: ctx, meshesOf, loadout, localState, originalState, neutralMaterial, aimLimit: sanitizeInput({ pitch: 10 }).pitch, runSpeed: RULES.sprint };
    const near = render();
    const standing = bounds();
    const rig = avatar.debug.rigs[avatar.debug.lod];
    const posedHead = new T.Box3().setFromObject(rig.head, true);
    const headModuleHeightM = posedHead.max.y - posedHead.min.y;
    const worldY = node => node.getWorldPosition(new T.Vector3()).y;
    const shoulderLeft = loadout.root.localToWorld(loadout.debug.shoulders.left.clone());
    const shoulderRight = loadout.root.localToWorld(loadout.debug.shoulders.right.clone());
    const symmetryDimensions = avatar.debug.symmetry?.dimensions;
    const proportions = {
      headModuleHeightM, fullHeightInHeadModules: standing.height / headModuleHeightM,
      helmetToMaskHeightM: (() => {
        const core = new T.Box3();
        rig.head.traverse(node => {
          if (node.isMesh && node.material?.name === 'soldier_composite_armor') core.union(new T.Box3().setFromBufferAttribute(node.geometry.attributes.position));
        });
        return core.max.y - core.min.y;
      })(),
      shoulderJointBindWidthM: symmetryDimensions ? 2 * symmetryDimensions.shoulderHalf : null,
      shoulderJointWidthM: Math.abs(shoulderLeft.x - shoulderRight.x),
      shoulderJointHeightM: (shoulderLeft.y + shoulderRight.y) / 2,
      kneeJointHeightM: { left: worldY(rig.leftLeg.knee), right: worldY(rig.rightLeg.knee) },
      notes: 'Measured in the posed standing model. The head module includes the helmet and its attached cloth. Shoulder measurements use the original arms’ IK shoulder targets.',
    };
    return {
      constructionMs, meshes, vertices, materialNames: [...materialNames], standing, proportions, near, hitBefore, rifleShared, armShared,
      orthographic: { viewport: [1080, 1080], frustumWidth: ortho.right - ortho.left, frustumHeight: ortho.top - ortho.bottom, target: orthoTarget.toArray(), distance: orthoDistance, directions: orthoViews },
    };
  });
  assert.ok(initial.meshes > 15, 'Expected a detailed articulated model');
  assert.ok(initial.materialNames.length >= 6, 'Expected separate fabric, armor, rubber, metal and optical surfaces');
  assert.ok(initial.standing.height >= 1.65 && initial.standing.height <= 1.88,
    'Standing height should match the existing 1.8m capsule: ' + initial.standing.height);
  assert.ok(initial.standing.min[1] >= -0.07, 'Feet should remain at the capsule origin');
  assert.ok(initial.hitBefore, 'Shared hit capsule must accept a body shot');
  assert.ok(initial.rifleShared.length >= 10, 'World rifle must retain the complete original PAC-9 mesh graph');
  assert.ok(initial.rifleShared.every(mesh => mesh.geometryShared && mesh.materialShared && mesh.hashEqual), 'World rifle must share the original buffers and materials, except independent flash uniforms');
  for (const arm of initial.armShared) {
    assert.ok(arm.geometryShared && arm.worldSleeveMaterial && arm.independentSkeleton, 'Original arm geometry must be shared with a world sleeve material and an independent skeleton: ' + arm.side);
    assert.equal(arm.boneNames.length, 35, 'Original hand/twist/helper skeleton must remain complete');
    for (const name of ['skinIndex', 'skinWeight', 'aRest', 'aHand']) assert.ok(arm.attributes.includes(name), 'Original arm attribute is missing: ' + name);
  }

  const symmetry = await page.evaluate(() => {
    const { T, avatar } = window.__soldierCheck;
    const metadata = avatar.debug.symmetry;
    if (!metadata?.anchors || !metadata?.pairs?.length || !metadata?.legs?.length) {
      throw new Error('The soldier must expose bind anchors, paired part descriptions and leg geometry for symmetry verification');
    }
    function matrixFor(part) {
      const quaternion = new T.Quaternion().setFromEuler(new T.Euler(...(part.rotation || [0, 0, 0])));
      return new T.Matrix4().compose(new T.Vector3(...(part.position || [0, 0, 0])), quaternion, new T.Vector3(...(part.scale || [1, 1, 1])));
    }
    function vertexOnRight(geometry, leftVertex) {
      if (geometry.index) return leftVertex;
      const triangle = Math.floor(leftVertex / 3) * 3;
      return triangle + [0, 2, 1][leftVertex % 3];
    }
    function compareGeometry(left, right, leftMatrix = new T.Matrix4(), rightMatrix = new T.Matrix4()) {
      const lp = left.getAttribute('position'), rp = right.getAttribute('position');
      const ln = left.getAttribute('normal'), rn = right.getAttribute('normal');
      if (!lp || !rp || lp.count !== rp.count || !ln || !rn || ln.count !== lp.count || rn.count !== rp.count || !!left.index !== !!right.index) {
        throw new Error('Mirrored geometry has incompatible position, normal or index buffers');
      }
      const leftNormalMatrix = new T.Matrix3().getNormalMatrix(leftMatrix);
      const rightNormalMatrix = new T.Matrix3().getNormalMatrix(rightMatrix);
      const leftPoint = new T.Vector3(), rightPoint = new T.Vector3();
      const leftNormal = new T.Vector3(), rightNormal = new T.Vector3();
      let positionErrorM = 0, normalError = 0, skinWeightError = 0, skinIndexMismatches = 0, windingMismatches = 0;
      const lw = left.getAttribute('skinWeight'), rw = right.getAttribute('skinWeight');
      const li = left.getAttribute('skinIndex'), ri = right.getAttribute('skinIndex');
      if (!!lw !== !!rw || !!li !== !!ri || lw && (lw.itemSize !== rw.itemSize || lw.count !== rw.count) || li && (li.itemSize !== ri.itemSize || li.count !== ri.count)) {
        throw new Error('Mirrored geometry has incompatible skinning buffers');
      }
      for (let vertex = 0; vertex < lp.count; vertex++) {
        const other = vertexOnRight(left, vertex);
        leftPoint.fromBufferAttribute(lp, vertex).applyMatrix4(leftMatrix);
        rightPoint.fromBufferAttribute(rp, other).applyMatrix4(rightMatrix);
        positionErrorM = Math.max(positionErrorM, Math.abs(leftPoint.x + rightPoint.x), Math.abs(leftPoint.y - rightPoint.y), Math.abs(leftPoint.z - rightPoint.z));
        leftNormal.fromBufferAttribute(ln, vertex).applyNormalMatrix(leftNormalMatrix);
        rightNormal.fromBufferAttribute(rn, other).applyNormalMatrix(rightNormalMatrix);
        normalError = Math.max(normalError, Math.abs(leftNormal.x + rightNormal.x), Math.abs(leftNormal.y - rightNormal.y), Math.abs(leftNormal.z - rightNormal.z));
        if (lw) for (let axis = 0; axis < lw.itemSize; axis++) {
          skinWeightError = Math.max(skinWeightError, Math.abs(lw.getComponent(vertex, axis) - rw.getComponent(other, axis)));
        }
        if (li) for (let axis = 0; axis < li.itemSize; axis++) {
          if (li.getComponent(vertex, axis) !== ri.getComponent(other, axis)) skinIndexMismatches++;
        }
      }
      if (left.index) {
        if (left.index.count !== right.index.count) throw new Error('Mirrored geometry has incompatible triangle counts');
        for (let triangle = 0; triangle < left.index.count; triangle += 3) {
          const expected = [left.index.getX(triangle), left.index.getX(triangle + 2), left.index.getX(triangle + 1)];
          const actual = [right.index.getX(triangle), right.index.getX(triangle + 1), right.index.getX(triangle + 2)];
          if (!actual.every((value, axis) => value === expected[axis])) windingMismatches++;
        }
      }
      return { vertices: lp.count, positionErrorM, normalError, skinWeightError, skinIndexMismatches, windingMismatches };
    }
    const { shoulderLeft: left, shoulderRight: right } = metadata.anchors;
    const anchors = {
      left: [...left], right: [...right],
      errorM: Math.max(Math.abs(left[0] + right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2])),
    };
    const legs = metadata.legs.map((pair, lod) => ({ lod, ...compareGeometry(pair.leftGeometry, pair.rightGeometry) }));
    const parts = metadata.pairs.map((pair, index) => ({
      index, name: pair.name, parent: pair.parent.name,
      sameMaterial: pair.left.material === pair.right.material,
      ...compareGeometry(pair.left.geometry, pair.right.geometry, matrixFor(pair.left), matrixFor(pair.right)),
    }));
    window.__soldierCheck.compareMirroredGeometry = compareGeometry;
    return { tolerance: 1e-6, anchors, dimensions: metadata.dimensions, legs, parts };
  });
  await writeFile(resolve(output, 'symmetry.json'), JSON.stringify(symmetry, null, 2) + '\n');
  assert.ok(symmetry.anchors.errorM < symmetry.tolerance, 'Shoulder bind anchors must mirror across the body center');
  assert.equal(symmetry.legs.length, 3, 'All three body LODs must expose mirrored trousers');
  for (const part of [...symmetry.legs, ...symmetry.parts]) {
    const label = part.name || `LOD ${part.lod} trousers`;
    assert.ok(part.positionErrorM < symmetry.tolerance, `${label} position mirror error ${part.positionErrorM}`);
    assert.ok(part.normalError < symmetry.tolerance, `${label} normal mirror error ${part.normalError}`);
    assert.ok(part.skinWeightError < symmetry.tolerance, `${label} skin weight mirror error ${part.skinWeightError}`);
    assert.equal(part.skinIndexMismatches, 0, `${label} skin bone correspondence`);
    assert.equal(part.windingMismatches, 0, `${label} reflected triangle winding`);
    if (part.name) assert.equal(part.sameMaterial, true, `${label} paired material identity`);
  }

  await capture('standing-three-quarter');
  for (const neutral of [false, true]) {
    for (const view of ['front', 'side', 'back']) {
      await page.evaluate(({ view, neutral }) => window.__soldierCheck.renderOrthographic(view, neutral), { view, neutral });
      await capture(`${neutral ? 'neutral' : 'color'}-${view}`);
    }
  }

  // The adapter provides a canonical pose for proportion review. Restore the
  // normal snapshot-driven pose before animation and gameplay verification.
  const reviewPose = await page.evaluate(() => {
    const s = window.__soldierCheck;
    const toggle = s.avatar.debug.setReviewPose || s.avatar.setReviewPose;
    if (typeof toggle !== 'function') throw new Error('The soldier must provide its canonical review pose');
    toggle(true);
    s.advance(2);
    s.avatar.root.updateMatrixWorld(true);
    const rig = s.avatar.debug.rigs[s.avatar.debug.lod];
    const localPoint = node => rig.group.worldToLocal(node.getWorldPosition(new s.T.Vector3()));
    const reflectedPair = (name, leftNode, rightNode) => {
      const left = localPoint(leftNode), right = localPoint(rightNode);
      return {
        name, left: left.toArray(), right: right.toArray(),
        errorM: Math.max(Math.abs(left.x + right.x), Math.abs(left.y - right.y), Math.abs(left.z - right.z)),
      };
    };
    const points = ['thigh', 'knee', 'boot', 'kneePad'].map(name => reflectedPair(name, rig.leftLeg[name], rig.rightLeg[name]));
    for (const [name, index] of [['shoulder', 0], ['elbow', 1], ['wrist', 4]]) {
      points.push(reflectedPair(name, s.loadout.arms.left.bones[index], s.loadout.arms.right.bones[index]));
    }
    const covers = s.loadout.debug.shoulderCovers;
    if (!covers?.left || !covers?.right) throw new Error('Canonical review requires the two mirrored sleeve-head geometries');
    return {
      points, rifleHidden: !s.loadout.pivot.visible,
      shoulderCovers: { name: 'original-arm-shoulder-covers', ...s.compareMirroredGeometry(covers.left, covers.right) },
      localUnchanged: JSON.stringify(s.localState()) === JSON.stringify(s.originalState),
    };
  });
  await writeFile(resolve(output, 'review-pose.json'), JSON.stringify(reviewPose, null, 2) + '\n');
  for (const point of reviewPose.points) assert.ok(point.errorM < symmetry.tolerance, `Canonical ${point.name} mirror error ${point.errorM}`);
  for (const key of ['positionErrorM', 'normalError', 'skinWeightError']) {
    assert.ok(reviewPose.shoulderCovers[key] < symmetry.tolerance, `Canonical shoulder cover ${key}: ${reviewPose.shoulderCovers[key]}`);
  }
  assert.equal(reviewPose.shoulderCovers.windingMismatches, 0, 'Mirrored shoulder covers must retain outward triangle winding');
  assert.equal(reviewPose.shoulderCovers.skinIndexMismatches, 0, 'Mirrored shoulder covers must use the same upper-arm skin slot');
  assert.equal(reviewPose.rifleHidden, true, 'Canonical review must expose the body and relaxed arms');
  assert.equal(reviewPose.localUnchanged, true, 'Canonical review must preserve the first-person weapon and arm pose');
  for (const view of ['front', 'side', 'back']) {
    await page.evaluate(view => window.__soldierCheck.renderOrthographic(view, true), view);
    await capture('anatomy-' + view);
  }
  await page.evaluate(() => {
    const s = window.__soldierCheck;
    const toggle = s.avatar.debug.setReviewPose || s.avatar.setReviewPose;
    toggle(false);
    s.advance(24);
    if (!s.loadout.pivot.visible) throw new Error('Canonical review did not restore the gameplay rifle');
  });

  const gripReach = [];
  for (const crouching of [false, true]) {
    for (const pitch of [0, 1.35, -1.35]) {
      const result = await page.evaluate(({ crouching, pitch }) => {
        const s = window.__soldierCheck;
        Object.assign(s.player, { alive: true, crouching, pitch, sprinting: false, onGround: true, reloadRemaining: 0, ammo: 30 });
        s.player.vel.x = s.player.vel.z = 0;
        s.player.lifeId++;
        s.advance(36);
        s.avatar.root.updateMatrixWorld(true);
        const hands = ['left', 'right'].map(side => {
          const arm = s.loadout.arms[side];
          const actual = s.loadout.root.worldToLocal(arm.hand.getWorldPosition(new s.T.Vector3()));
          const target = s.loadout.debug.wrists[side].p;
          return { side, actual: actual.toArray(), target: target.toArray(), errorM: actual.distanceTo(target), reachM: arm.ik.reach, leanM: arm.ik.lean };
        });
        s.renderOrthographic('side', false, true);
        return { stance: crouching ? 'kneeling' : 'standing', pitch, hands, sourceUnchanged: JSON.stringify(s.localState()) === JSON.stringify(s.originalState) };
      }, { crouching, pitch });
      gripReach.push(result);
      await writeFile(resolve(output, 'grip-reach.json'), JSON.stringify(gripReach, null, 2) + '\n');
      for (const hand of result.hands) {
        const label = `${result.stance} pitch ${pitch} ${hand.side}`;
        assert.ok(Number.isFinite(hand.errorM) && hand.errorM <= 0.003, `${label} wrist target error ${hand.errorM} m`);
        assert.ok(Number.isFinite(hand.reachM) && hand.reachM <= 0.003, `${label} residual IK reach ${hand.reachM} m`);
        assert.ok(Number.isFinite(hand.leanM) && hand.leanM >= 0 && hand.leanM <= 0.065001, `${label} clavicle adjustment ${hand.leanM} m`);
      }
      assert.equal(result.sourceUnchanged, true, 'World aim must preserve the original first-person source');
      await capture(`${result.stance}-pitch-${pitch === 0 ? 'level' : pitch > 0 ? 'up' : 'down'}`);
      const reviewRecovery = await page.evaluate(() => {
        const s = window.__soldierCheck;
        const toggle = s.avatar.debug.setReviewPose || s.avatar.setReviewPose;
        toggle(true);
        s.advance(2);
        const covers = s.loadout.debug.shoulderCovers;
        const result = {
          ...s.compareMirroredGeometry(covers.left, covers.right),
          leanM: Math.max(...Object.values(s.loadout.arms).map(arm => arm.ik.lean)),
        };
        toggle(false);
        s.advance(2);
        return result;
      });
      result.reviewRecovery = reviewRecovery;
      for (const key of ['positionErrorM', 'normalError', 'skinWeightError', 'leanM']) {
        assert.ok(reviewRecovery[key] < symmetry.tolerance, `Canonical review after ${result.stance} pitch ${pitch} failed to reset ${key}`);
      }
      await writeFile(resolve(output, 'grip-reach.json'), JSON.stringify(gripReach, null, 2) + '\n');
    }
  }
  await page.evaluate(() => {
    const s = window.__soldierCheck;
    s.player.crouching = false; s.player.pitch = 0; s.player.lifeId++;
    s.advance(24);
  });

  const motion = await page.evaluate(() => {
    const s = window.__soldierCheck;
    const rotations = () => {
      const values = [];
      s.avatar.root.traverse(n => values.push(n.rotation.x, n.rotation.y, n.rotation.z));
      return values;
    };
    s.player.vel.z = 4;
    s.advance(6);
    const a = rotations();
    s.advance(14);
    const b = rotations();
    s.player.vel.z = 0;
    s.player.pos.x = 0.8; s.player.pos.z = -0.4; s.player.yaw = 0.4;
    s.render();
    const result = { animated: a.some((value, index) => Math.abs(value - b[index]) > 1e-4), position: s.avatar.root.position.toArray(), yaw: s.avatar.root.rotation.y };
    s.player.pos.x = s.player.pos.z = 0; s.player.yaw = 0;
    s.player.crouching = true;
    s.advance(45);
    s.camera.position.set(-2, 1.4, -3.1); s.camera.lookAt(0, 0.65, 0);
    s.render(); result.crouching = s.bounds();
    const rig = s.avatar.debug.rigs[s.avatar.debug.lod];
    result.kneeling = {
      pelvisHeightM: rig.hip.position.y,
      rightKneeFlexionDeg: -rig.rightLeg.knee.rotation.x * 180 / Math.PI,
    };
    return result;
  });
  assert.equal(motion.animated, true, 'Moving state should animate the articulated joints');
  assert.deepEqual(motion.position, [0.8, 0, -0.4], 'Root should follow snapshot movement');
  assert.equal(motion.yaw, 0.4, 'Root should follow snapshot heading');
  assert.ok(motion.crouching.height <= 1.28 && motion.crouching.height > 0.9,
    'Crouch should fit the existing 1.15m capsule: ' + motion.crouching.height);
  assert.ok(motion.crouching.min[1] >= -0.012,
    `Crouch geometry crossed the foot plane: ${motion.crouching.min[1]} in ${motion.crouching.minimumObject}`);
  assert.ok(motion.kneeling.rightKneeFlexionDeg < 170,
    'Rear leg should leave volume for the thigh and calf instead of folding nearly flat');
  await capture('crouching');
  await page.evaluate(() => window.__soldierCheck.renderOrthographic('side', true));
  await capture('neutral-crouching-side');

  const running = await page.evaluate(() => {
    const s = window.__soldierCheck;
    const sampleBodySkin = () => {
      const result = [];
      s.avatar.root.updateMatrixWorld(true);
      s.avatar.root.traverseVisible(mesh => {
        if (!mesh.isSkinnedMesh || Object.values(s.loadout.arms).some(arm => arm.mesh === mesh)) return;
        mesh.skeleton.update();
        const { position } = mesh.geometry.attributes;
        const point = new s.T.Vector3();
        const sample = [];
        for (let i = 0; i < position.count; i += Math.max(1, Math.floor(position.count / 64))) {
          point.fromBufferAttribute(position, i);
          mesh.applyBoneTransform(i, point);
          sample.push(...point.toArray());
        }
        result.push(sample);
      });
      return result;
    };
    s.player.crouching = false;
    s.player.sprinting = true;
    s.player.vel.z = -s.runSpeed;
    s.advance(45);
    const before = sampleBodySkin();
    s.renderOrthographic('side', false);
    const bounds = s.bounds();
    s.advance(9);
    const after = sampleBodySkin();
    return {
      bounds, skinnedBodyMeshes: before.length,
      deformedBodyMeshes: before.filter((sample, i) => sample.some((value, j) => Math.abs(value - after[i][j]) > 0.001)).length,
    };
  });
  assert.ok(running.bounds.min.every(Number.isFinite) && running.bounds.max.every(Number.isFinite), 'Running pose produced invalid positions');
  if (running.skinnedBodyMeshes) assert.equal(running.deformedBodyMeshes, running.skinnedBodyMeshes, 'Every visible body skin must deform during the running stride');
  await capture('running-side');
  const extremeAim = {};
  for (const [label, sign] of [['up', 1], ['down', -1]]) {
    extremeAim[label] = await page.evaluate(sign => {
      const s = window.__soldierCheck;
      s.player.vel.z = 0;
      s.player.sprinting = false;
      s.player.pitch = sign * s.aimLimit;
      s.advance(16);
      s.renderOrthographic('side', false, true);
      const direction = new s.T.Vector3(0, 0, -1).applyQuaternion(s.loadout.rifle.getWorldQuaternion(new s.T.Quaternion()));
      return { pitch: s.player.pitch, direction: direction.toArray(), bounds: s.bounds() };
    }, sign);
    assert.ok(sign * extremeAim[label].direction[1] > 0.35, `Original rifle failed to point ${label} at the supported pitch limit`);
    assert.ok(extremeAim[label].bounds.min.every(Number.isFinite) && extremeAim[label].bounds.max.every(Number.isFinite), `Extreme ${label} pitch produced invalid positions`);
    await capture(`aim-${label}-side`);
  }

  const behavior = await page.evaluate(() => {
    const s = window.__soldierCheck;
    s.player.crouching = false; s.player.pitch = -0.5;
    s.advance(30);
    s.camera.position.set(-1.7, 1.7, -2.9); s.camera.lookAt(0, 1.05, 0); s.render();
    const before = [];
    before.push(s.loadout.flash.visible);
    s.avatar.shoot(s.clock()); s.render();
    const during = [];
    during.push(s.loadout.flash.visible);
    s.advance(6); s.render();
    const after = [];
    after.push(s.loadout.flash.visible);
    // Death plays a short collapse on the remote body, then hides it.
    s.player.alive = false; s.render(); const deathShown = s.avatar.root.visible;
    s.advance(60); s.render();
    const rig = s.avatar.debug.rigs[s.avatar.debug.lod];
    const collapsed = rig.group.rotation.x > 1.2;
    s.advance(80); s.render(); const deadHidden = !s.avatar.root.visible;
    s.player.alive = true; s.player.lifeId++; s.render();
    const revived = s.avatar.root.visible && Math.abs(rig.group.rotation.x) < 1e-6;
    const hitAfter = s.tracePlayerHit({ boxes: [] }, s.shot, s.player);
    s.player.crouching = true;
    const headMiss = s.tracePlayerHit({ boxes: [] }, { ...s.shot, origin: { x: 0, y: 1.65, z: -3 } }, s.player);
    const crouchHit = s.tracePlayerHit({ boxes: [] }, { ...s.shot, origin: { x: 0, y: 0.6, z: -3 } }, s.player);
    s.player.crouching = false; s.player.pitch = 0;
    return { flashActivated: before.some((v, i) => !v && during[i]), flashEnded: during.some((v, i) => v && !after[i]), deathShown, collapsed, deadHidden, revived, hitAfter, headMiss, crouchHit };
  });
  assert.equal(behavior.flashActivated, true, 'Remote shoot should activate muzzle flash');
  assert.equal(behavior.flashEnded, true, 'Muzzle flash should expire on the animation clock');
  assert.equal(behavior.deathShown, true, 'Death should begin with a visible collapse');
  assert.equal(behavior.collapsed, true, 'The body should fall within a second of death');
  assert.equal(behavior.deadHidden, true, 'Dead remote player must be hidden after the collapse');
  assert.equal(behavior.revived, true, 'Respawn must restore visibility');
  assert.deepEqual(behavior.hitAfter, initial.hitBefore, 'Visual animation must not change the authoritative capsule');
  assert.equal(behavior.headMiss, null, 'Crouched player should not retain a standing head hit region');
  assert.ok(behavior.crouchHit, 'Crouched body should remain hittable');
  await capture('aiming');

  const sharing = await page.evaluate(() => {
    const s = window.__soldierCheck, arm = s.loadout.arms.right;
    const indexBone = arm.bones.findIndex(bone => bone.name === 'index2');
    const weights = arm.mesh.geometry.getAttribute('skinWeight'), indices = arm.mesh.geometry.getAttribute('skinIndex');
    let vertexIndex = -1;
    for (let i = 0; i < weights.count && vertexIndex < 0; i++) for (let slot = 0; slot < 4; slot++) {
      if (indices.array[i * 4 + slot] === indexBone && weights.array[i * 4 + slot] > 0.4) vertexIndex = i;
    }
    if (vertexIndex < 0) throw new Error('Could not locate a genuinely skinned index-finger vertex');
    const sample = () => {
      s.loadout.root.updateMatrixWorld(true); arm.skeleton.update();
      const point = new s.T.Vector3().fromBufferAttribute(arm.mesh.geometry.attributes.position, vertexIndex);
      arm.mesh.applyBoneTransform(vertexIndex, point);
      return { point: point.toArray(), quaternion: arm.bones[indexBone].quaternion.toArray() };
    };
    const t = s.clock();
    for (let i = 0; i < 12; i++) s.loadout.update(1 / 60, t + i / 60, { kick: 0, trigger: 0 });
    const resting = sample();
    for (let i = 0; i < 12; i++) s.loadout.update(1 / 60, t + 0.2 + i / 60, { kick: 0, trigger: 1 });
    const firing = sample();
    for (let i = 0; i < 12; i++) s.loadout.update(1 / 60, t + 0.4 + i / 60, { kick: 0, trigger: 0 });
    const released = sample();
    const localUnchanged = JSON.stringify(s.localState()) === JSON.stringify(s.originalState);
    return { vertexIndex, resting, firing, released,
      skinnedVertexMoved: resting.point.some((v, i) => Math.abs(v - firing.point[i]) > 0.0001),
      fingerBoneMoved: resting.quaternion.some((v, i) => Math.abs(v - firing.quaternion[i]) > 0.0001), localUnchanged };
  });
  assert.equal(sharing.skinnedVertexMoved, true, 'Trigger must deform an original skinned finger vertex');
  assert.equal(sharing.fingerBoneMoved, true, 'Trigger must animate the original finger bone');
  assert.equal(sharing.localUnchanged, true, 'Remote animation must not change local gun parts, buffers or bone poses');

  // Compare complete original and world-held PAC-9 under the same camera/light.
  // Clones are scene nodes only: their geometry and materials stay shared.
  await page.evaluate(() => {
    const s = window.__soldierCheck;
    s.player.pitch = 0; s.player.crouching = false;
    s.camera.position.set(-1.05, 1.62, -2); s.camera.lookAt(0, 1.23, -0.25);
    s.render();
  });
  await capture('weapon-hands-closeup');
  await page.evaluate(() => {
    const s = window.__soldierCheck;
    const scene = new s.T.Scene(); scene.background = new s.T.Color(0x242e31);
    for (const child of s.scene.children) if (child.isLight) scene.add(child.clone());
    const camera = new s.T.PerspectiveCamera(32, 1, 0.01, 10);
    camera.position.set(1.25, 0.35, -0.9); camera.lookAt(0, -0.005, -0.16);
    const source = s.loadout.source.root.clone(true), world = s.loadout.rifle.clone(true);
    for (const rifle of [source, world]) {
      rifle.position.set(0, 0, 0); rifle.quaternion.identity(); rifle.scale.set(1, 1, 1); rifle.visible = true;
      rifle.traverse(node => { node.layers.set(0); });
      s.meshesOf(rifle).at(-1).visible = false;
    }
    // Match moving-part transforms as well as the camera; a paused local
    // showcase can otherwise leave its bolt halfway through a firing cycle.
    const originalNodes = [], worldNodes = [];
    source.traverse(node => originalNodes.push(node)); world.traverse(node => worldNodes.push(node));
    for (let i = 1; i < originalNodes.length; i++) {
      originalNodes[i].position.copy(worldNodes[i].position);
      originalNodes[i].quaternion.copy(worldNodes[i].quaternion);
      originalNodes[i].scale.copy(worldNodes[i].scale);
      originalNodes[i].visible = worldNodes[i].visible;
      originalNodes[i].castShadow = worldNodes[i].castShadow;
      originalNodes[i].receiveShadow = worldNodes[i].receiveShadow;
    }
    scene.add(source); s.renderer.render(scene, camera);
    s.comparison = { scene, camera, source, world, referencePixels: s.renderer.domElement.toDataURL() };
  });
  await capture('pac9-original-reference');
  const identicalReferenceRender = await page.evaluate(() => {
    const s = window.__soldierCheck, c = s.comparison;
    c.source.removeFromParent(); c.scene.add(c.world); s.renderer.render(c.scene, c.camera);
    return c.referencePixels === s.renderer.domElement.toDataURL();
  });
  assert.equal(identicalReferenceRender, true, 'The same original/world art at the same pose must produce identical pixels');
  await capture('pac9-world-reference');
  const lod = await page.evaluate(() => {
    const s = window.__soldierCheck;
    s.comparison.world.removeFromParent();
    s.renderer.shadowMap.enabled = false;
    const results = [];
    for (const distance of [3, 18, 50]) {
      s.camera.position.set(0, 1.4, -distance); s.camera.lookAt(0, 1, 0);
      s.advance(4);
      const full = s.render();
      s.loadout.root.visible = false; s.renderer.render(s.scene, s.camera);
      const body = { calls: s.renderer.info.render.calls - 1, triangles: s.renderer.info.render.triangles - 2 };
      s.loadout.root.visible = true;
      const worldMeshes = s.meshesOf(s.loadout.rifle), originalMeshes = s.meshesOf(s.loadout.source.root);
      results.push({ distance, ...full, body, loadoutVisible: s.loadout.root.visible && s.loadout.rifle.visible,
        rifleBuffersStillShared: worldMeshes.every((mesh, i) => mesh.geometry === originalMeshes[i].geometry) });
    }
    s.avatar.dispose(); s.renderer.render(s.scene, s.camera);
    const baseline = s.renderer.info.memory.geometries;
    const disposalCounts = [];
    s.camera.position.set(0, 1.4, -3);
    for (let i = 0; i < 3; i++) {
      const avatar = s.createAvatar({ ...s.templateContext, THREE: s.T, scene: s.scene, camera: s.camera, renderer: s.renderer });
      avatar.update(s.player, s.clock()); s.renderer.render(s.scene, s.camera);
      avatar.dispose(); s.renderer.render(s.scene, s.camera);
      disposalCounts.push(s.renderer.info.memory.geometries);
    }
    const localUnchangedAfterDisposal = JSON.stringify(s.localState()) === JSON.stringify(s.originalState);
    s.neutralMaterial.dispose();
    // Shared art still belongs to the live first-person rig after disposal.
    s.templateContext.render.frame(0);
    return { results, removed: !s.avatar.root.parent, baseline, disposalCounts, localUnchangedAfterDisposal, errors: window.__errors };
  });
  assert.ok(lod.results[2].body.triangles < lod.results[0].body.triangles * 0.7, 'Far body LOD should materially reduce triangles');
  assert.ok(lod.results[2].body.calls <= lod.results[0].body.calls, 'Far body LOD should not increase draw calls');
  assert.ok(lod.results.every(value => value.loadoutVisible && value.rifleBuffersStillShared), 'Every distance must retain the full original rifle and arms');
  assert.equal(lod.removed, true, 'Dispose should remove the model from its scene');
  assert.ok(lod.disposalCounts.every(count => count === lod.baseline), 'Repeated create/dispose should release owned GPU geometry');
  assert.equal(lod.localUnchangedAfterDisposal, true, 'Disposal must preserve the live first-person art and skeleton');
  assert.deepEqual(errors, [], 'WebGL or browser runtime errors');
  const report = { historicalBootstrap, initial, symmetry, reviewPose, gripReach, motion, running, extremeAim, behavior, sharing, identicalReferenceRender, lod, captures, errors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const mirroredGeometry = [...symmetry.legs, ...symmetry.parts];
  console.log(JSON.stringify({
    output, standingHeightM: initial.standing.height, crouchingHeightM: motion.crouching.height,
    symmetry: {
      legLods: symmetry.legs.length, pairedParts: symmetry.parts.length,
      positionErrorM: Math.max(...mirroredGeometry.map(part => part.positionErrorM)),
      normalError: Math.max(...mirroredGeometry.map(part => part.normalError)),
      skinWeightError: Math.max(...mirroredGeometry.map(part => part.skinWeightError)),
      reviewJointErrorM: Math.max(...reviewPose.points.map(point => point.errorM)),
      shoulderCoverErrorM: reviewPose.shoulderCovers.positionErrorM,
    },
    gripReachErrorM: Math.max(...gripReach.flatMap(pose => pose.hands.map(hand => hand.errorM))),
    identicalReferenceRender, lod: lod.results, errors,
  }, null, 2));
  console.log('Soldier WebGL checks passed. Captures: ' + output);
} finally {
  await browser?.close();
  await app.close();
}
