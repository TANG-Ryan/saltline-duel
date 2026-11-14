/** Optional, explicitly selected authored body. The original gun/arms stay in use. */
const CLIPS = ['Idle', 'Walk', 'Run', 'Crouch', 'CrouchWalk', 'Jump', 'Land'];
const SOCKETS = ['Shoulder_R', 'Shoulder_L', 'WeaponSocket', 'MagSocket'];
const pending = new WeakMap();

function documentOf(bytes) {
  const data = new DataView(bytes);
  if (bytes.byteLength >= 20 && data.getUint32(0, true) === 0x46546c67) {
    if (data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== bytes.byteLength || data.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid GLB 2.0 header');
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, data.getUint32(12, true))));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function releaseScene(scene) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
  scene?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.skeleton) skeletons.add(node.skeleton);
    for (const m of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) materials.add(m);
  });
  for (const m of materials) for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
  skeletons.forEach(s => s.dispose()); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  textures.forEach(t => { t.dispose(); t.source?.data?.close?.(); });
}

export async function prepareSoldierGLTF(ctx, url) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !/\.(glb|gltf)$/i.test(target.pathname)) throw new Error('Choose a same-origin GLB/glTF character');
  if (ctx.soldierGLTF) {
    if (ctx.soldierGLTF.url !== target.href) throw new Error('Dispose the current authored character before switching assets');
    return ctx.soldierGLTF;
  }
  if (pending.has(ctx)) return pending.get(ctx);
  const job = (async () => {
    const response = await fetch(target.href, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Character model failed to load: ${response.status} ${target.pathname}`);
    const bytes = await response.arrayBuffer(), document = documentOf(bytes);
    if (document.asset?.version !== '2.0') throw new Error('The character must be glTF 2.0');
    for (const resource of [...(document.buffers || []), ...(document.images || [])]) {
      if (resource.uri && !resource.uri.startsWith('data:')) throw new Error('Export a self-contained GLB or glTF with embedded buffers and textures');
    }
    // These decoders are deliberately not downloaded at runtime.
    if ((document.extensionsRequired || []).some(name => /draco|meshopt|basisu/i.test(name))) throw new Error('Export uncompressed mesh data and PNG/JPEG textures for this character adapter');
    const [{ GLTFLoader }, { clone }] = await Promise.all([
      import('./vendor/three-r180/GLTFLoader.mjs'), import('./vendor/three-r180/SkeletonUtils.mjs'),
    ]);
    const gltf = await new GLTFLoader().parseAsync(bytes, new URL('.', target.href).href);
    try {
      let meshes = 0;
      gltf.scene.traverse(n => { if (n.isSkinnedMesh) meshes++; });
      if (!meshes) throw new Error('The authored character requires a real SkinnedMesh');
      for (const name of SOCKETS) if (!gltf.scene.getObjectByName(name)) throw new Error(`Missing character socket: ${name}`);
      for (const name of CLIPS) if (!gltf.animations.some(clip => clip.name === name)) throw new Error(`Missing character animation: ${name}`);
      const bounds = new ctx.THREE.Box3().setFromObject(gltf.scene);
      if (bounds.max.y - bounds.min.y < 1.6 || bounds.max.y - bounds.min.y > 1.95 || Math.abs(bounds.min.y) > .1) throw new Error('Export in metres with feet at Y=0 and standing height near 1.8m');
      ctx.soldierGLTF = { url: target.href, gltf, clone, actors: 0 };
      return ctx.soldierGLTF;
    } catch (error) { releaseScene(gltf.scene); throw error; }
  })();
  pending.set(ctx, job);
  try { return await job; } finally { pending.delete(ctx); }
}

export function createSoldierGLTFBody(ctx) {
  const asset = ctx.soldierGLTF;
  if (!asset) return null;
  const root = asset.clone(asset.gltf.scene), mixer = new ctx.THREE.AnimationMixer(root);
  root.name = 'authored-soldier-body';
  root.traverse(n => { if (n.isMesh) { n.castShadow = n.receiveShadow = true; n.frustumCulled = false; } });
  const actions = Object.fromEntries(asset.gltf.animations.map(clip => [clip.name, mixer.clipAction(clip)]));
  const sockets = Object.fromEntries(SOCKETS.map(name => [name, root.getObjectByName(name)]));
  let active = '', wasGrounded = true, landing = 0, disposed = false;
  asset.actors++;
  return { root, sockets,
    update(p, dt) {
      const speed = Math.hypot(p.vel?.x || 0, p.vel?.z || 0), grounded = p.onGround !== false;
      if (grounded && !wasGrounded) landing = .16;
      landing = Math.max(0, landing - dt); wasGrounded = grounded;
      const next = !grounded ? 'Jump' : landing > 0 ? 'Land' : p.crouching ? speed > .2 ? 'CrouchWalk' : 'Crouch' : p.sprinting && speed > 2 ? 'Run' : speed > .2 ? 'Walk' : 'Idle';
      if (next !== active) {
        const previous = actions[active]; active = next;
        actions[next].reset().setEffectiveWeight(1).play();
        if (previous) actions[next].crossFadeFrom(previous, .12, false);
      }
      mixer.update(dt); root.updateMatrixWorld(true);
    },
    dispose() {
      if (disposed) return; disposed = true;
      mixer.stopAllAction(); mixer.uncacheRoot(root);
      root.traverse(n => { if (n.isSkinnedMesh) n.skeleton.dispose(); });
      root.removeFromParent(); asset.actors--;
    },
  };
}

export function disposeSoldierGLTF(ctx) {
  const asset = ctx.soldierGLTF;
  if (!asset) return;
  if (asset.actors) throw new Error('Dispose live character instances before their shared GLTF assets');
  releaseScene(asset.gltf.scene); delete ctx.soldierGLTF;
}
