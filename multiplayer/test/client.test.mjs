import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RULES, createWorld, createPlayer, simulatePlayer, raycastWorld, tracePlayerHit } from '../shared/simulation.mjs';

const clientSource = readFileSync(new URL('../client.mjs', import.meta.url), 'utf8');
const noop = () => {};
class Vec {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vec(this.x, this.y, this.z); }
  addScaledVector(v, scale) { this.x += v.x * scale; this.y += v.y * scale; this.z += v.z * scale; return this; }
}
class Node {
  constructor(geometry, material) {
    this.position = new Vec(); this.rotation = { set: noop, x: 0, y: 0, z: 0 };
    this.scale = new Vec(1, 1, 1); this.children = []; this.geometry = geometry;
    this.material = material; this.visible = true;
  }
  add(...nodes) { this.children.push(...nodes); return this; }
  removeFromParent() {}
  traverse(fn) { fn(this); for (const child of this.children) child.traverse(fn); }
}
class Material { constructor(options) { Object.assign(this, options); } dispose() {} }
class Geometry { dispose() {} }
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.value = ''; this.textContent = '';
    this.style = {}; this.hidden = false;
    this.classList = { add: noop, remove: noop, toggle: noop };
  }
  set innerHTML(html) {
    this.children = [];
    for (const match of html.matchAll(/data-(el|act)="([^"]+)"/g)) {
      const el = new Element(); el.dataset[match[1]] = match[2]; this.children.push(el);
    }
  }
  querySelectorAll(selector) {
    const key = selector === '[data-el]' ? 'el' : 'act';
    return this.children.filter(el => el.dataset[key]);
  }
  querySelector(selector) { return this.children.find(el => selector.includes(el.dataset.act)) || null; }
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren(...children) { this.children = children; }
  click() { if (this.onclick) this.onclick(); }
  focus() {}
  select() {}
}
function setup() {
  const listeners = new Map(), windowListeners = new Map(), timers = [];
  const events = new Map();
  const map = {
    version: 'test-map', hash: 'test-hash', seed: 4207,
    bounds: { min: { x: -40, y: 0, z: -30 }, max: { x: 40, y: 30, z: 30 } },
    groundY: 0, seaY: -1.6, quayX: 30, boxes: [],
    spawnPoints: [{ pos: { x: 0, y: 0, z: 0 }, yaw: 0 }, { pos: { x: 10, y: 0, z: 10 }, yaw: 3.14 }]
  };
  const document = {
    hidden: false, head: new Element(), body: new Element(), createElement: () => new Element(),
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const storage = new Map();
  const location = new URL('https://example.test/');
  location.assign = url => { location.assigned = url; };
  const window = {};
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.latest = this; }
    open() { this.readyState = 1; this.onopen(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    message(data) { this.onmessage({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const menus = { root: new Element(), panelOpen: false };
  const settingsButton = new Element();
  settingsButton.dataset.act = 'settings';
  settingsButton.onclick = () => { menus.panelOpen = true; };
  menus.root.children.push(settingsButton);
  const input = {
    move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, fire: false, ads: false, sprint: false,
    crouch: false, touch: false, locked: false, keys: new Set(),
    pressed(action) { return this.keys.has(action); },
    setGameplay(enabled) { this.enabled = enabled; },
    requestLock() { this.locked = true; }, exitLock() { this.locked = false; }
  };
  const calls = { start: 0, pause: 0, weaponReset: 0 };
  const ctx = {
    THREE: { Group: Node, Mesh: Node, Vector3: Vec, MeshStandardMaterial: Material, MeshBasicMaterial: Material, BoxGeometry: Geometry, SphereGeometry: Geometry, CapsuleGeometry: Geometry },
    input, time: { t: 1 },
    scene: new Node(), camera: { position: new Vec(), rotation: { set: noop }, fov: 74, updateProjectionMatrix: noop },
    player: { pos: new Vec(), eye: new Vec(0, 1.68, 0), baseFov: 74, tuning: {} },
    weapon: { update: noop, reset() { calls.weaponReset++; }, setVisible: noop },
    enemies: { clear: noop, update: noop },
    hud: { reset: noop, clearRadio: noop, setMarkers: noop, setPrompt: noop, setObjective: noop, show: noop, hitmarker: noop },
    game: { menus, start() { calls.start++; }, pause() { calls.pause++; } },
    audio: { resume: noop, setPaused: noop, setIntensity: noop },
    render: { post: {} }, fx: { tracer: noop },
    events: { on: (type, fn) => events.set(type, fn), emit: (type, data) => { if (events.has(type)) events.get(type)(data); } }
  };
  const sandbox = {
    // Rendering has a separate real Three/WebGL check (scripts/check-soldier).
    // Keep these tests focused on network prediction and engine integration.
    createAvatar: () => ({ root: new Node(), shoot: noop, update: noop, dispose: noop }),
    RULES, createWorld, simulatePlayer, raycastWorld, tracePlayerHit,
    captureWorld: () => map, fingerprintWorld: value => value.hash,
    URL, URLSearchParams, document, window, location, performance: { now: () => 1000 },
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState: (_, __, url) => { sandbox.lastURL = url; } },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    WebSocket: Socket, setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: noop,
    addEventListener: (type, fn) => windowListeners.set(type, fn),
    fetch: async url => ({
      ok: true,
      json: async () => String(url).includes('map.json') ? map : { roomId: 'room-123', playerId: 'p1', reconnectToken: 'secret' }
    })
  };
  const source = clientSource.replace(/^import .+;\n/gm, '').replace('import.meta.url', JSON.stringify('https://example.test/multiplayer/client.mjs')).replace(/^export /gm, '');
  const api = vm.runInNewContext('(() => {' + source + '\nreturn {DuelClient,startMultiplayer};})()', sandbox);
  const player = (id, x = 0) => createPlayer(id, { pos: { x, y: 0, z: 0 }, yaw: 0 });
  const client = () => {
    const result = new api.DuelClient(ctx, map, 'room-123', { playerId: 'p1', reconnectToken: 'secret' });
    result.connected = true;
    result.socket = new Socket('wss://example.test/ws');
    result.socket.readyState = Socket.OPEN;
    return result;
  };
  return { api, ctx, client, player, calls, menus, map, Socket, sandbox, storage, listeners, windowListeners, timers, document };
}
function play(env, client) {
  const a = env.player('p1'), b = env.player('p2', 10);
  a.invulnerableFor = b.invulnerableFor = 0;
  client.receiveSnapshot({ phase: 'playing', players: [a, b], countdown: 0 });
  return { a, b };
}

test('creating a room connects with version and private credentials', async () => {
  const env = setup();
  const client = await env.api.startMultiplayer(env.ctx);
  env.Socket.latest.open();
  const join = env.Socket.latest.sent[0];
  assert.equal(join.type, 'join');
  assert.equal(join.mapHash, env.map.hash);
  assert.equal(join.reconnectToken, 'secret');
  assert.match(env.sandbox.lastURL, /room=room-123/);
  assert.equal(env.sandbox.lastURL.includes('secret'), false);
  assert.equal(env.calls.start, 1);
  assert.equal(env.calls.pause, 1);
  assert.equal(client.ctx.game.state, 'multiplayer');
});

test('a mismatched map rejects entry before changing the solo controller', async () => {
  const env = setup();
  env.sandbox.captureWorld = () => ({ hash: 'wrong-version' });
  await assert.rejects(env.api.startMultiplayer(env.ctx), /地图.*版本不一致/);
  assert.equal(env.calls.start, 0);
});

test('high refresh rate does not lose a jump edge before the next fixed step', () => {
  const env = setup(), client = env.client();
  play(env, client);
  env.ctx.input.keys.add('jump');
  client.frame(1 / 144);
  env.ctx.input.keys.clear();
  client.frame(1 / 144);
  client.frame(1 / 144);
  const commands = client.socket.sent.filter(message => message.type === 'input');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].input.jump, true);
  client.frame(1 / 60);
  assert.equal(client.socket.sent.filter(message => message.type === 'input')[1].input.jump, false);
});

test('menus synchronously clear held input and keep the network game alive', () => {
  const env = setup(), client = env.client();
  play(env, client);
  env.ctx.input.fire = true; env.ctx.input.move.y = 1;
  client.openMenu();
  assert.equal(env.ctx.input.fire, false);
  assert.equal(env.ctx.input.move.y, 0);
  assert.equal(client.socket.sent.at(-1).type, 'neutral');
  assert.equal(client.canPlay(), false);
  assert.equal(env.ctx.game.state, 'multiplayer');
  assert.equal(client.frame(1 / 60), true);
});

test('visibility loss clears held fire without waiting for another render frame', () => {
  const env = setup(), client = env.client();
  play(env, client);
  env.ctx.input.fire = true;
  env.document.hidden = true;
  env.listeners.get('visibilitychange')();
  assert.equal(env.ctx.input.fire, false);
  assert.equal(client.socket.sent.at(-1).type, 'neutral');
});

test('settings remain reachable and suppress input across the match start', () => {
  const env = setup(), client = env.client();
  client.openSettings();
  assert.equal(env.menus.panelOpen, true);
  play(env, client);
  assert.equal(client.canPlay(), false);
  env.menus.panelOpen = false;
  client.frame(1 / 60);
  assert.equal(client.settingsOpen, false);
});

test('snapshot reconciliation replays only unacknowledged input without resending it', () => {
  const env = setup(), client = env.client();
  const { a, b } = play(env, client);
  env.ctx.input.move.y = 1;
  client.frame(1 / 60);
  client.frame(1 / 60);
  assert.equal(client.pending.length, 2);
  const sent = client.socket.sent.length;
  a.ackSeq = client.pending[0].seq;
  client.receiveSnapshot({ phase: 'playing', players: [a, b] });
  assert.equal(client.pending.length, 1);
  assert.equal(client.socket.sent.length, sent);
});

test('new lives discard old input and reset the visual weapon', () => {
  const env = setup(), client = env.client();
  const { a, b } = play(env, client);
  client.frame(1 / 60);
  assert.equal(client.pending.length, 1);
  a.lifeId++; a.pos.x = 20;
  client.receiveSnapshot({ phase: 'playing', players: [a, b] });
  assert.equal(client.pending.length, 0);
  assert.equal(client.predicted.pos.x, 20);
  assert.ok(env.calls.weaponReset >= 2);
});

test('duplicate kill events produce one feed item', () => {
  const env = setup(), client = env.client();
  play(env, client);
  const event = { id: 1, type: 'kill', shooterId: 'p1', targetId: 'p2' };
  client.receiveEvent(event);
  client.receiveEvent(event);
  assert.equal(client.feed.length, 1);
});

test('refresh sends neutral but preserves room membership and reconnect credentials', () => {
  const env = setup(), client = env.client();
  play(env, client);
  env.windowListeners.get('pagehide')();
  assert.equal(client.socket.sent.at(-1).type, 'neutral');
  assert.equal(client.socket.sent.some(message => message.type === 'leave'), false);
  assert.equal(client.stopped, false);
});

test('the camera adapter accepts complete server snapshots', () => {
  const env = setup(), client = env.client();
  play(env, client);
  client.renderPlayer(1 / 60);
  assert.equal(env.ctx.player.pos.x, client.predicted.pos.x);
  assert.ok(env.ctx.player.eye.y > 1.5);
  assert.ok(Number.isFinite(env.ctx.camera.fov));
});

test('server errors stop retries and display a readable room error', () => {
  const env = setup(), client = env.client();
  play(env, client);
  client.fail('房间已满');
  assert.equal(client.stopped, true);
  assert.equal(client.ui.elements.description.textContent, '房间已满');
});

test('PvP locks the rifle while preserving the solo weapon input function', () => {
  const env = setup();
  let equipped, sawSwap;
  env.ctx.weapon.equip = value => { equipped = value; };
  env.ctx.weapon.update = () => { sawSwap = env.ctx.input.pressed('swap'); };
  const client = env.client();
  play(env, client);
  env.ctx.input.keys.add('swap');
  env.ctx.weapon.update(1 / 60);
  assert.equal(equipped, 'rifle');
  assert.equal(sawSwap, false);
  assert.equal(env.ctx.input.pressed('swap'), true);
});

test('reload animation follows shared timing instead of the solo rig duration', () => {
  const env = setup();
  const state = {};
  env.ctx.weapon.debug = { S: state };
  env.ctx.weapon.reloadNow = () => { state.reload = { empty: false, T: 2.24, t: 0, fresh: true }; };
  env.ctx.weapon.update = dt => { if (state.reload) state.reload.t += dt; };
  const client = env.client();
  play(env, client);
  client.predicted.ammo = 20;
  client.predicted.reloadRemaining = 1;
  env.ctx.weapon.update(1 / 60);
  assert.equal(state.reload.T, RULES.reloadTactical);
  assert.ok(Math.abs(state.reload.t - (RULES.reloadTactical - 1)) < 1e-8);
});

test('loopback addresses cannot be copied as an Internet invitation', async () => {
  const env = setup();
  env.sandbox.location.hostname = '127.0.0.1';
  let copies = 0;
  env.sandbox.navigator.clipboard.writeText = async () => { copies++; };
  const client = env.client();
  const a = env.player('p1');
  client.receiveSnapshot({ phase: 'waiting', players: [a] });
  assert.equal(client.ui.elements.copy.disabled, true);
  assert.equal(client.ui.elements.copy.textContent, '仅本机测试');
  assert.match(client.ui.elements.description.textContent, /公网游戏地址/);
  await client.ui.elements.copy.onclick();
  assert.equal(copies, 0);
});

test('an authored character choice follows the private invite without adding credentials', () => {
  const env = setup();
  env.sandbox.location.search = '?soldier=glb';
  const client = env.client();
  const invite = new URL(client.ui.elements.link.value);
  assert.equal(invite.searchParams.get('soldier'), 'glb');
  assert.equal(invite.searchParams.get('room'), 'room-123');
  assert.equal(invite.href.includes('secret'), false);
});

