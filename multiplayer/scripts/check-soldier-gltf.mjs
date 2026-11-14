#!/usr/bin/env node
/** Real loader integration using an in-memory test mesh, never shipped as art. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createGameServer } from '../server.mjs';

function fixture() {
  const parts = [], bufferViews = [], accessors = [];
  let byteLength = 0;
  const add = (values, Type, type, componentType, extra = {}) => {
    const bytes = Buffer.from(new Type(values).buffer), pad = (4 - bytes.length % 4) % 4;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
    parts.push(bytes, Buffer.alloc(pad)); byteLength += bytes.length + pad;
    accessors.push({ bufferView: bufferViews.length - 1, componentType, type,
      count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type], ...extra });
    return accessors.length - 1;
  };
  const p = add([-.1, 0, 0, .1, 0, 0, 0, 1.8, 0], Float32Array, 'VEC3', 5126, { min: [-.1, 0, 0], max: [.1, 1.8, 0] });
  const n = add([0, 0, 1, 0, 0, 1, 0, 0, 1], Float32Array, 'VEC3', 5126);
  const j = add(Array(12).fill(0), Uint16Array, 'VEC4', 5123);
  const w = add([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], Float32Array, 'VEC4', 5126);
  const inv = add([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], Float32Array, 'MAT4', 5126);
  const time = add([0, 1], Float32Array, 'SCALAR', 5126, { min: [0], max: [1] });
  const q = add([0, 0, 0, 1, 0, 0, 0, 1], Float32Array, 'VEC4', 5126);
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Fixture', children: [1, 2] }, { name: 'Hips', children: [3, 4, 5, 6] }, { name: 'SkinnedFixture', mesh: 0, skin: 0 },
      ...['Shoulder_R', 'Shoulder_L', 'WeaponSocket', 'MagSocket'].map((name, i) => ({ name, translation: [[.2, 1.43, 0], [-.2, 1.43, 0], [.11, 1.4, -.08], [-.07, 1.1, -.27]][i] }))],
    skins: [{ joints: [1], inverseBindMatrices: inv }],
    meshes: [{ primitives: [{ attributes: { POSITION: p, NORMAL: n, JOINTS_0: j, WEIGHTS_0: w }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.3, .3, .3, 1], metallicFactor: 0, roughnessFactor: .85 } }],
    buffers: [{ byteLength }], bufferViews, accessors,
    animations: ['Idle', 'Walk', 'Run', 'Crouch', 'CrouchWalk', 'Jump', 'Land'].map(name => ({ name,
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }], samplers: [{ input: time, output: q }] })),
  };
  const bin = Buffer.concat(parts);
  const gltf = JSON.stringify({ ...doc, buffers: [{ byteLength, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }] });
  const json = Buffer.from(JSON.stringify(doc)), pad = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
  const h = Buffer.alloc(20), b = Buffer.alloc(8);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + json.length + pad.length + bin.length, 8);
  h.writeUInt32LE(json.length + pad.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  b.writeUInt32LE(bin.length, 0); b.writeUInt32LE(0x004e4942, 4);
  return { gltf, glb: Buffer.concat([h, json, pad, b, bin]) };
}
const assets = fixture(), app = createGameServer();
let browser;
try {
  const { port } = await app.listen(0, '127.0.0.1');
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/multiplayer/assets/custom-soldier.*', route => {
    const type = new URL(route.request().url()).pathname.endsWith('.glb') ? 'glb' : 'gltf';
    return route.fulfill({ contentType: type === 'glb' ? 'model/gltf-binary' : 'model/gltf+json', body: assets[type] });
  });
  await page.goto(`http://127.0.0.1:${port}/?show=weapon&q=low&noaudio=1`);
  await page.waitForFunction(() => window.__ready && window.__G?.weapon?.rigs?.rifle, undefined, { timeout: 180000 });
  const result = await page.evaluate(async () => {
    const ctx = window.__G; ctx.renderer.setAnimationLoop(null);
    const { prepareSoldierGLTF, disposeSoldierGLTF } = await import('/multiplayer/soldier-gltf.mjs');
    const { createAvatar } = await import('/multiplayer/soldier.mjs');
    const results = [];
    for (const type of ['glb', 'gltf']) {
      const asset = await prepareSoldierGLTF(ctx, '/multiplayer/assets/custom-soldier.' + type), actor = createAvatar(ctx);
      const p = { lifeId: 1, alive: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, z: 0 }, pitch: 0, yaw: 0, onGround: true };
      actor.update(p, 10); actor.update(p, 10.016); ctx.render.frame(0);
      const body = actor.debug.authored;
      if (!body?.root.visible) throw new Error('Authored branch did not instantiate');
      const a = asset.gltf.scene.getObjectByName('SkinnedFixture'), b = body.root.getObjectByName('SkinnedFixture');
      results.push({ type, skeletonIndependent: a.skeleton !== b.skeleton, geometryShared: a.geometry === b.geometry,
        actors: asset.actors, originalGun: actor.debug.loadout.debug.sharedsame.rifleGeometry });
      actor.dispose();
      if (asset.actors !== 0) throw new Error('Actor lifecycle leaked');
      disposeSoldierGLTF(ctx);
    }
    try { await prepareSoldierGLTF(ctx, 'https://example.org/foreign.glb'); throw new Error('Unexpected acceptance'); }
    catch (e) { if (!e.message.includes('same-origin')) throw e; }
    return results;
  });
  assert.ok(result.every(r => r.skeletonIndependent && r.geometryShared && r.actors === 1 && r.originalGun));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results: result, errors }, null, 2));
} finally { await browser?.close(); await app.close(); }
