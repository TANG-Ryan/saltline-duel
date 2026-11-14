#!/usr/bin/env node
/**
 * Soldier lab: fast visual iteration on the procedural duel soldier.
 *
 *   node scripts/soldier-lab.mjs --out <dir> [--shots shots.json] [--probe probe.js] [--sheet 3x480]
 *
 * shots.json is an array of { name, pose?, camera?, frames?, neutral?, lod? }.
 *   pose   : fields merged into the snapshot player (pitch, crouching, vel, sprinting, onGround ...)
 *   camera : { preset: 'front'|'side'|'back'|'three'|'close'|'hands'|'top', fov?, pos?, target? }
 *   frames : simulated 60 Hz frames before capture (default 90)
 * probe.js is evaluated in the page with `lab` in scope; its JSON result is printed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGameServer } from '../server.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((list, value, i, all) =>
  value.startsWith('--') ? [...list, [value.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : list, []));
const out = resolve(args.out || 'test-artifacts/soldier-lab');
const shots = args.shots ? JSON.parse(await readFile(args.shots, 'utf8')) : [
  { name: 'front', camera: { preset: 'front' } },
  { name: 'side', camera: { preset: 'side' } },
  { name: 'back', camera: { preset: 'back' } },
  { name: 'three', camera: { preset: 'three' } },
  { name: 'crouch', pose: { crouching: true }, camera: { preset: 'three' } },
  { name: 'run', pose: { vel: { x: 0, y: 0, z: -6.4 }, sprinting: true }, frames: 47, camera: { preset: 'side' } },
];
const probe = args.probe ? await readFile(args.probe, 'utf8') : null;
const [cols, size] = String(args.sheet || '3x480').split('x').map(Number);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const app = createGameServer();
const errors = [];
let browser;
try {
  await mkdir(out, { recursive: true });
  const { port } = await app.listen(0, '127.0.0.1');
  browser = await chromium.launch({ headless: true, executablePath, args: ['--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error' && !/fonts\.g/.test(message.location().url)) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?show=weapon&q=low&noaudio=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => window.__ready && window.__G?.THREE, undefined, { timeout: 180_000 });
  await page.evaluate(async () => {
    const ctx = window.__G, T = ctx.THREE;
    ctx.renderer.setAnimationLoop(null);
    const { createAvatar } = await import('/multiplayer/soldier.mjs');
    const scene = new T.Scene();
    scene.background = new T.Color(0x242e31);
    scene.add(new T.HemisphereLight(0xdce8ef, 0x4d4939, 2.3));
    const sun = new T.DirectionalLight(0xffe9cc, 3.2);
    sun.position.set(-3, 6, -4); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -2;
    sun.shadow.camera.right = sun.shadow.camera.top = 2;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const rim = new T.DirectionalLight(0x8bb8cf, 1.8);
    rim.position.set(2, 2.8, 2); scene.add(rim);
    const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshStandardMaterial({ color: 0x303a3d, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1080, 1080); renderer.setPixelRatio(1);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:9999;width:100vw;height:100vh';
    document.body.appendChild(renderer.domElement);
    const camera = new T.PerspectiveCamera(30, 1, 0.01, 150);
    const avatar = createAvatar({ ...ctx, scene, camera, renderer });
    const base = () => ({ alive: true, lifeId: 1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      crouching: false, sprinting: false, onGround: true, invulnerableFor: 0, reloadRemaining: 0, ads: 0 });
    let clock = 10, player = base();
    const presets = {
      front: { pos: [0, 1.0, -5.2], target: [0, 0.95, 0] },
      side: { pos: [-5.2, 1.0, 0], target: [0, 0.95, 0] },
      back: { pos: [0, 1.0, 5.2], target: [0, 0.95, 0] },
      three: { pos: [-2.4, 1.7, -3.8], target: [0, 0.95, 0] },
      close: { pos: [-1.0, 1.55, -1.5], target: [0.02, 1.32, -0.1] },
      hands: { pos: [-0.75, 1.45, -1.1], target: [0.05, 1.3, -0.35] },
      head: { pos: [-0.55, 1.68, -0.85], target: [0, 1.6, 0] },
      top: { pos: [0.01, 4.5, 0], target: [0, 1, 0] },
    };
    window.lab = {
      ctx, T, scene, renderer, camera, avatar, get player() { return player; },
      reset() { player = base(); clock = 10; avatar.update(player, clock); },
      pose(fields = {}, frames = 90) {
        player = { ...base(), ...fields, pos: { ...base().pos, ...fields.pos }, vel: { ...base().vel, ...fields.vel } };
        for (let i = 0; i < frames; i++) {
          clock += 1 / 60;
          if (player.vel) { player.pos.x += player.vel.x / 60; player.pos.z += player.vel.z / 60; }
          avatar.update(player, clock);
        }
      },
      view(spec = {}) {
        const preset = presets[spec.preset || 'three'];
        const o = player.pos;
        const at = (spec.target || preset.target), from = (spec.pos || preset.pos);
        camera.fov = spec.fov || 30; camera.updateProjectionMatrix();
        camera.position.set(from[0] + o.x, from[1] + o.y, from[2] + o.z);
        camera.lookAt(at[0] + o.x, at[1] + o.y, at[2] + o.z);
        renderer.render(scene, camera);
        return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      },
    };
    window.lab.reset();
  });
  const report = { shots: {}, errors };
  for (const shot of shots) {
    report.shots[shot.name] = await page.evaluate(({ pose, frames, camera, lod }) => {
      lab.pose(pose, frames ?? 90);
      return lab.view(camera);
    }, shot);
    await page.screenshot({ path: resolve(out, shot.name + '.png') });
  }
  if (probe) report.probe = await page.evaluate(code => (0, eval)(`(async () => { ${code} })()`), probe);
  if (shots.length) {
    const images = await Promise.all(shots.map(async s => [s.name, (await readFile(resolve(out, s.name + '.png'))).toString('base64')]));
    const rows = Math.ceil(images.length / cols);
    await page.setViewportSize({ width: cols * size, height: rows * size });
    await page.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${size}px)">${images.map(([n, b]) =>
      `<div style="position:relative"><img style="width:${size}px;height:${size}px;display:block" src="data:image/png;base64,${b}"><span style="position:absolute;left:6px;top:4px;color:#fff;font:13px sans-serif">${n}</span></div>`).join('')}</body>`);
    await page.screenshot({ path: resolve(out, 'sheet.png') });
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ probe: report.probe, errors, out }, null, 2));
} finally {
  await browser?.close();
  await app.close?.();
  process.exit(errors.length ? 1 : 0);
}
