import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { createGameServer, addMultiplayerEntry } from '../server.mjs';

const manifest = {
  version: 'test-map', hash: 'test-hash', seed: 4207,
  bounds: { min: { x: -40, y: 0, z: -30 }, max: { x: 40, y: 30, z: 30 } },
  groundY: 0, seaY: -1.6, quayX: 30, boxes: [],
  spawnPoints: [
    { pos: { x: 0, y: 0, z: 5 }, yaw: 0 },
    { pos: { x: 0, y: 0, z: -5 }, yaw: Math.PI },
  ],
};

async function setup(t, extra = {}) {
  let now = 0;
  const app = createGameServer({
    manifest, autoTick: false, clock: () => now,
    heartbeatMs: 60000, ...extra,
  });
  const address = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port;
  const wsBase = base.replace('http:', 'ws:');
  t.after(() => app.close());
  return {
    app, base, wsBase,
    advance(seconds) {
      const count = Math.ceil(seconds * 60);
      for (let n = 0; n < count; n++) {
        now += 1000 / 60;
        app.tick(1 / 60, now);
      }
    },
    setNow(value) { now = value; },
  };
}

async function createRoom(env) {
  const response = await fetch(env.base + '/api/rooms', { method: 'POST' });
  assert.equal(response.status, 201);
  return response.json();
}

async function connect(env, room, credentials = {}, overrides = {}) {
  const socket = new WebSocket(env.wsBase + '/ws');
  const messages = [];
  const waiters = new Set();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (messages.length - 1 >= waiter.after && waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  await new Promise((done, reject) => {
    socket.once('open', done);
    socket.once('error', reject);
  });
  function wait(predicate, after = 0) {
    const existing = messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('Expected WebSocket message; received ' + JSON.stringify(messages.slice(after))));
      }, 2000);
      waiters.add(waiter);
    });
  }
  function send(value) { socket.send(JSON.stringify(value)); }
  send({
    type: 'join', roomId: room.roomId,
    version: manifest.version, mapHash: manifest.hash,
    ...credentials, ...overrides,
  });
  const first = await wait((message) => message.type === 'joined' || message.type === 'error');
  return { socket, messages, wait, send, joined: first };
}

async function flush(client) {
  const after = client.messages.length;
  client.send({ type: 'ping' });
  await client.wait((message) => message.type === 'pong', after);
}

async function pair(env) {
  const room = await createRoom(env);
  const a = await connect(env, room, { playerId: room.playerId, reconnectToken: room.reconnectToken });
  const b = await connect(env, room);
  assert.equal(a.joined.type, 'joined');
  assert.equal(b.joined.type, 'joined');
  return { room, a, b };
}

async function start(env, a, b) {
  a.send({ type: 'ready', ready: true });
  b.send({ type: 'ready', ready: true });
  await flush(a);
  await flush(b);
  env.advance(3.05);
  const room = env.app.rooms.get(a.joined.roomId);
  assert.equal(room.phase, 'playing');
  return room;
}

function command(player, seq, values = {}) {
  return {
    type: 'input',
    input: {
      seq, lifeId: player.lifeId, moveX: 0, moveY: 0,
      yaw: player.yaw, pitch: player.pitch, fire: false,
      ads: false, sprint: false, crouch: false, jump: false, reload: false,
      ...values,
    },
  };
}

test('loader injection preserves the doctype and is idempotent', () => {
  for (const html of ['<!doctype html><html><head><title>Game</title></head></html>', '<title>Saltline</title>\n<style></style>']) {
    const result = addMultiplayerEntry(html);
    assert.equal(result.match(/src="\/multiplayer\/loader.js"/g).length, 1);
    assert.equal(addMultiplayerEntry(result), result);
    if (html.startsWith('<!doctype')) assert.ok(result.startsWith('<!doctype'));
  }
});

test('serving the multiplayer entry leaves the original game file untouched', async (t) => {
  const original = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const env = await setup(t);
  const response = await fetch(env.base + '/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /multiplayer\/loader\.js/);
  assert.equal(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), original);
});

test('health, same-origin creation and static file allowlist', async (t) => {
  const env = await setup(t);
  const health = await (await fetch(env.base + '/healthz')).json();
  assert.equal(health.ready, true);
  assert.equal(health.version, manifest.version);
  assert.equal(health.mapHash, manifest.hash);
  const forbidden = await fetch(env.base + '/api/rooms', {
    method: 'POST', headers: { Origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await fetch(env.base + '/multiplayer/server.mjs')).status, 404);
  assert.equal((await fetch(env.base + '/multiplayer/package.json')).status, 404);
  assert.equal((await fetch(env.base + '/.env')).status, 404);
  for (const module of ['soldier.mjs', 'soldier-surfaces.mjs', 'soldier-meshes.mjs', 'soldier-symmetry.mjs', 'soldier-head.mjs', 'soldier-torso.mjs', 'soldier-lower.mjs', 'soldier-gltf.mjs', 'world-loadout.mjs']) {
    const response = await fetch(env.base + '/multiplayer/' + module);
    assert.equal(response.status, 200, 'The browser must be able to import the avatar modules');
    assert.match(response.headers.get('content-type'), /javascript/);
  }
});

test('invite creates exactly two slots, requires both ready, rejects a third visitor', async (t) => {
  const env = await setup(t);
  const { room, a, b } = await pair(env);
  assert.equal(new URL(room.inviteUrl).searchParams.get('room'), room.roomId);
  assert.ok(!room.inviteUrl.includes(room.reconnectToken));
  a.send({ type: 'ready', ready: true });
  await flush(a);
  env.advance(4);
  assert.equal(env.app.rooms.get(room.roomId).phase, 'waiting');
  const third = await connect(env, room);
  assert.equal(third.joined.code, 'ROOM_FULL');
  await start(env, a, b);
});

test('map version, unknown room and invalid reconnect token fail clearly', async (t) => {
  const env = await setup(t);
  const room = await createRoom(env);
  const wrongVersion = await connect(env, room, {}, { version: 'different' });
  assert.equal(wrongVersion.joined.code, 'VERSION_MISMATCH');
  const missing = await connect(env, { roomId: 'does-not-exist' });
  assert.equal(missing.joined.code, 'ROOM_NOT_FOUND');
  const invalid = await connect(env, room, { playerId: room.playerId, reconnectToken: 'incorrect' });
  assert.equal(invalid.joined.code, 'INVALID_TOKEN');
});

test('inputs are acknowledged only after simulation and duplicates or old-life inputs are ignored', async (t) => {
  const env = await setup(t);
  const { a, b } = await pair(env);
  const room = await start(env, a, b);
  const slot = room.slots.get(a.joined.playerId);
  const p = slot.player;
  a.send(command(p, 1, { moveY: 1 }));
  await flush(a);
  assert.notEqual(p.ackSeq, 1);
  env.advance(1 / 60);
  assert.equal(p.ackSeq, 1);
  a.send(command(p, 1, { fire: true, moveY: -1 }));
  a.send(command(p, 2, { lifeId: p.lifeId - 1, fire: true }));
  a.send({ type: 'damage', amount: 999999, targetId: b.joined.playerId });
  await flush(a);
  env.advance(1 / 60);
  assert.equal(slot.lastSeq, 1);
  assert.equal(slot.input.fire, false);
  assert.equal(room.slots.get(b.joined.playerId).player.health, 100);
});

test('neutral and 250ms input expiry stop held movement and fire', async (t) => {
  const env = await setup(t);
  const { a, b } = await pair(env);
  const room = await start(env, a, b);
  const slot = room.slots.get(a.joined.playerId);
  const p = slot.player;
  a.send(command(p, 1, { fire: true, moveY: 1 }));
  await flush(a);
  env.advance(0.1);
  assert.ok(p.shotSequence > 0);
  a.send({ type: 'neutral' });
  await flush(a);
  const shotsAfterNeutral = p.shotSequence;
  env.advance(0.2);
  assert.equal(p.shotSequence, shotsAfterNeutral);
  a.send(command(p, 2, { fire: true, moveY: 1 }));
  await flush(a);
  env.advance(0.5);
  const expiredShots = p.shotSequence;
  const expiredPosition = { ...p.pos };
  env.advance(0.5);
  assert.equal(p.shotSequence, expiredShots);
  assert.ok(Math.hypot(p.pos.x - expiredPosition.x, p.pos.z - expiredPosition.z) < 0.05);
});

test('the tenth kill locks results once and rematch requires both votes', async (t) => {
  const env = await setup(t);
  const { a, b } = await pair(env);
  const room = await start(env, a, b);
  const shooter = room.slots.get(a.joined.playerId).player;
  const victim = room.slots.get(b.joined.playerId).player;
  Object.assign(shooter, { score: 9, invulnerableFor: 0, yaw: 0, pitch: 0 });
  Object.assign(victim, { health: 26, invulnerableFor: 0, regenAfter: 0 });
  shooter.pos = { x: 0, y: 0, z: 5 };
  victim.pos = { x: 0, y: 0, z: -2 };
  a.send(command(shooter, 1, { fire: true, yaw: 0, pitch: 0 }));
  await flush(a);
  env.advance(0.1);
  assert.equal(room.phase, 'finished');
  assert.equal(shooter.score, 10);
  assert.equal(room.winnerId, shooter.id);
  const fixedAmmo = shooter.ammo;
  env.advance(5);
  await flush(a);
  assert.equal(shooter.ammo, fixedAmmo);
  assert.equal(victim.alive, false);
  assert.equal(a.messages.filter((message) => message.type === 'event' && message.event.type === 'finished').length, 1);
  a.send({ type: 'rematch' });
  await flush(a);
  assert.equal(room.phase, 'finished');
  b.send({ type: 'rematch' });
  await flush(b);
  assert.equal(room.phase, 'countdown');
  assert.equal(shooter.score, 0);
  assert.equal(victim.score, 0);
  env.advance(3.05);
  assert.equal(room.phase, 'playing');
  assert.equal(victim.alive, true);
});

test('ordinary kills respawn only the victim and preserve the live player position', async (t) => {
  const env = await setup(t);
  const { a, b } = await pair(env);
  const room = await start(env, a, b);
  const shooter = room.slots.get(a.joined.playerId).player;
  const victim = room.slots.get(b.joined.playerId).player;
  Object.assign(shooter, { invulnerableFor: 0, yaw: 0, pitch: 0 });
  Object.assign(victim, { health: 26, invulnerableFor: 0, regenAfter: 0 });
  shooter.pos = { x: 0, y: 0, z: 5 };
  victim.pos = { x: 0, y: 0, z: -2 };
  const life = victim.lifeId;
  a.send(command(shooter, 1, { fire: true, yaw: 0, pitch: 0 }));
  await flush(a);
  env.advance(0.1);
  a.send({ type: 'neutral' });
  await flush(a);
  assert.equal(shooter.score, 1);
  assert.equal(victim.alive, false);
  env.advance(2.8);
  assert.equal(victim.alive, false);
  env.advance(0.3);
  assert.equal(victim.alive, true);
  assert.equal(victim.lifeId, life + 1);
  assert.equal(victim.health, 100);
  assert.equal(victim.ammo, 30);
  assert.ok(victim.invulnerableFor > 1.7);
  assert.equal(shooter.pos.z, 5);
});

test('disconnect freezes the room and reserves its slot for authenticated reconnect', async (t) => {
  const env = await setup(t);
  const { room: credentials, a, b } = await pair(env);
  const room = await start(env, a, b);
  const p = room.slots.get(a.joined.playerId).player;
  p.score = 4;
  p.health = 72;
  const detached = new Promise((done) => a.socket.once('close', done));
  a.socket.close();
  await detached;
  await flush(b);
  assert.equal(room.phase, 'reconnecting');
  const before = room.matchTime;
  env.advance(4);
  assert.equal(room.matchTime, before);
  const stranger = await connect(env, credentials);
  assert.equal(stranger.joined.code, 'ROOM_FULL');
  const again = await connect(env, credentials, {
    playerId: a.joined.playerId, reconnectToken: a.joined.reconnectToken,
  });
  assert.equal(again.joined.type, 'joined');
  assert.equal(room.phase, 'countdown');
  assert.equal(p.score, 4);
  assert.equal(p.health, 72);
  env.advance(3.05);
  assert.equal(room.phase, 'playing');
});

test('disconnect timeout ends with no winner and does not restart on reconnect', async (t) => {
  const env = await setup(t);
  const { room: credentials, a, b } = await pair(env);
  const room = await start(env, a, b);
  const detached = new Promise((done) => a.socket.once('close', done));
  a.socket.close();
  await detached;
  await flush(b);
  env.advance(30.1);
  assert.equal(room.phase, 'ended');
  assert.equal(room.winnerId, null);
  const again = await connect(env, credentials, {
    playerId: a.joined.playerId, reconnectToken: a.joined.reconnectToken,
  });
  assert.equal(again.joined.code, 'ROOM_ENDED');
});

test('explicit leave ends a waiting room and informs the other player', async (t) => {
  const env = await setup(t);
  const { room: credentials, a, b } = await pair(env);
  const room = env.app.rooms.get(credentials.roomId);
  assert.equal(room.phase, 'waiting');
  const after = b.messages.length;
  const left = new Promise((done) => a.socket.once('close', done));
  a.send({ type: 'leave' });
  const ended = await b.wait((message) =>
    message.type === 'snapshot' && message.state.phase === 'ended', after);
  await left;
  assert.equal(ended.state.reason, 'player-left');
  assert.equal(room.phase, 'ended');
  assert.equal(room.winnerId, null);
  const again = await connect(env, credentials);
  assert.equal(again.joined.code, 'ROOM_ENDED');
});


