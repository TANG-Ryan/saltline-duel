import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import {
  RULES, createWorld, createPlayer, resetPlayer, sanitizeInput,
  simulatePlayer, applyDamage, selectSpawn, tracePlayerHit,
} from './shared/simulation.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAP_PATH = fileURLToPath(new URL('./shared/map.json', import.meta.url));
const STEP = RULES.step || 1 / 60;
const SNAPSHOT_EVERY = Math.max(1, Math.round(1 / STEP / (RULES.snapshotHz || 20)));
const MAX_INPUT_AGE = (RULES.maxInputAge || 0.25) * 1000;
const WAIT_TTL = 10 * 60 * 1000;
const END_TTL = 60 * 1000;
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const neutral = (p) => ({
  seq: p.ackSeq ?? -1, lifeId: p.lifeId, moveX: 0, moveY: 0,
  yaw: p.yaw || 0, pitch: p.pitch || 0,
  fire: false, ads: false, sprint: false, crouch: false, jump: false, reload: false,
});

/** Keep the user's original HTML unchanged; add the entry only when served. */
export function addMultiplayerEntry(html) {
  if (/<script\b[^>]*\bsrc=["'][^"']*multiplayer\/loader\.js["']/i.test(html)) return html;
  const loader = '<script src="/multiplayer/loader.js"></script>';
  for (const anchor of [/<head(?:\s[^>]*)?>/i, /<\/title\s*>/i, /^\s*<!doctype[^>]*>/i]) {
    if (anchor.test(html)) return html.replace(anchor, '$&\n' + loader);
  }
  return loader + '\n' + html;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

/**
 * One process owns all room state. Tests can inject a trusted manifest, disable
 * the timer and advance tick(dt) explicitly; callers never supply world data.
 */
export function createGameServer(options = {}) {
  const manifest = options.manifest || JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  if (!manifest.version || !manifest.hash || manifest.seed !== 4207) {
    throw new Error('缺少有效的固定地图版本，请先生成 shared/map.json。');
  }
  const world = createWorld(manifest);
  const clock = options.clock || (() => performance.now());
  const staticRoot = options.staticRoot || ROOT;
  const graceMs = options.disconnectGraceMs ?? 30000;
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const maxRooms = options.maxRooms ?? 100;
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
  const rooms = new Map();
  const createLimits = new Map();
  let frame = 0;
  let timer = null;
  let heartbeat = null;
  let closing = false;
  let lastClock = clock();
  let accumulated = 0;

  function originFor(req) {
    if (publicOrigin) return new URL(publicOrigin).origin;
    const host = req.headers.host;
    if (!host || /[\s\\/@]/.test(host)) throw new Error('Invalid host');
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = req.socket.encrypted || forwarded === 'https' ? 'https:' : 'http:';
    return new URL(protocol + '//' + host).origin;
  }

  function validOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // Non-browser clients still require a room token to reconnect.
    try { return new URL(origin).origin === originFor(req); } catch { return false; }
  }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  function error(ws, code, message, closeCode) {
    send(ws, { type: 'error', code, message });
    if (closeCode && ws.readyState === WebSocket.OPEN) ws.close(closeCode, code.slice(0, 100));
  }

  function send(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      ws.close(4008, 'slow connection');
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function players(room) { return [...room.slots.values()]; }

  function state(room) {
    return {
      roomId: room.id,
      phase: room.phase,
      countdown: Math.max(0, room.countdown || 0),
      matchTime: room.matchTime,
      winnerId: room.winnerId || null,
      reason: room.reason || null,
      reconnectRemaining: room.phase === 'reconnecting'
        ? Math.max(0, (room.disconnectDeadline - clock()) / 1000) : 0,
      players: players(room).map((slot) => ({
        ...slot.player,
        connected: slot.connected,
        ready: slot.ready,
        rematch: slot.rematch,
      })),
    };
  }

  function broadcast(room, message) {
    for (const slot of room.slots.values()) send(slot.socket, message);
  }

  function snapshot(room) {
    broadcast(room, { type: 'snapshot', state: state(room), serverTime: clock() });
  }

  function event(room, data) {
    const record = { id: room.id + ':' + (++room.eventSeq), ...data };
    broadcast(room, { type: 'event', event: record, serverTime: clock() });
    return record;
  }

  function clearInput(slot) {
    slot.player.ackSeq = slot.lastSeq;
    slot.input = neutral(slot.player);
    slot.pendingInputs.length = 0;
    slot.lastInputAt = -Infinity;
    slot.edgeSeq = slot.lastSeq;
  }

  function makeSlot(id, spawn) {
    const p = createPlayer(id, spawn);
    p.score = 0;
    p.ackSeq = -1;
    const slot = {
      player: p, token: token(), socket: null, connected: false,
      ready: false, rematch: false, everConnected: false,
      lastSeq: -1, edgeSeq: -1, lastInputAt: -Infinity, input: neutral(p), pendingInputs: [],
    };
    return slot;
  }

  function makeRoom() {
    const id = token(18);
    const host = makeSlot(token(12), selectSpawn(world, null, 0));
    const room = {
      id, phase: 'waiting', slots: new Map([[host.player.id, host]]),
      createdAt: clock(), touchedAt: clock(), eventSeq: 0, matchTime: 0,
      countdown: 0, countdownKind: 'start', winnerId: null, reason: null,
      disconnectDeadline: 0, endedAt: 0,
    };
    rooms.set(id, room);
    return { room, host };
  }

  function beginCountdown(room, kind = 'start') {
    room.phase = 'countdown';
    room.countdown = 3;
    room.countdownKind = kind;
    room.winnerId = null;
    room.reason = null;
    room.disconnectDeadline = 0;
    if (kind === 'start') {
      room.matchTime = 0;
      const slots = players(room);
      for (let n = 0; n < slots.length; n++) {
        const slot = slots[n];
        slot.player.score = 0;
        resetPlayer(slot.player, selectSpawn(world, n ? slots[0].player : null, n));
        slot.player.ackSeq = slot.lastSeq;
        slot.rematch = false;
      }
    }
    for (const slot of room.slots.values()) clearInput(slot);
    snapshot(room);
  }

  function finish(room, winnerId) {
    if (room.phase !== 'playing') return;
    room.phase = 'finished';
    room.countdown = 0;
    room.winnerId = winnerId;
    room.touchedAt = clock();
    for (const slot of room.slots.values()) {
      slot.ready = false;
      slot.rematch = false;
      clearInput(slot);
    }
    event(room, { type: 'finished', winnerId });
    snapshot(room);
  }

  function end(room, reason = 'disconnect-timeout') {
    if (room.phase === 'ended') return;
    room.phase = 'ended';
    room.reason = reason;
    room.winnerId = null;
    room.countdown = 0;
    room.endedAt = clock();
    for (const slot of room.slots.values()) clearInput(slot);
    event(room, { type: 'ended', reason });
    snapshot(room);
    for (const slot of room.slots.values()) {
      if (slot.socket?.readyState === WebSocket.OPEN) slot.socket.close(4004, reason);
    }
  }

  function detach(ws, explicit = false) {
    const attached = ws.saltline;
    if (!attached?.slot || attached.slot.socket !== ws) return;
    const { room, slot } = attached;
    slot.socket = null;
    slot.connected = false;
    slot.ready = false;
    clearInput(slot);
    room.touchedAt = clock();
    if (room.phase === 'ended') return;
    if (explicit) {
      end(room, 'player-left');
      return;
    }
    if (room.phase === 'playing' || room.phase === 'countdown') {
      room.phase = 'reconnecting';
      room.disconnectDeadline = clock() + graceMs;
      room.countdown = 0;
      for (const entry of room.slots.values()) clearInput(entry);
    }
    snapshot(room);
  }

  function join(ws, data) {
    if (ws.saltline?.slot) return error(ws, 'ALREADY_JOINED', '已经加入房间。');
    if (data.version !== manifest.version || data.mapHash !== manifest.hash) {
      return error(ws, 'VERSION_MISMATCH', '游戏版本不一致，请刷新页面。', 4002);
    }
    if (typeof data.roomId !== 'string' || data.roomId.length > 64) {
      return error(ws, 'INVALID_ROOM', '邀请链接无效。', 4002);
    }
    const room = rooms.get(data.roomId);
    if (!room) return error(ws, 'ROOM_NOT_FOUND', '房间不存在或联机服务已重启，请重新创建房间。', 4004);
    if (room.phase === 'reconnecting' && clock() >= room.disconnectDeadline) end(room);
    if (room.phase === 'ended') return error(ws, 'ROOM_ENDED', '本局已结束，请重新创建房间。', 4004);

    let slot;
    if (data.playerId || data.reconnectToken) {
      slot = room.slots.get(data.playerId);
      if (!slot || !sameToken(data.reconnectToken, slot.token)) {
        return error(ws, 'INVALID_TOKEN', '重连凭证无效。', 4003);
      }
    } else {
      if (room.slots.size >= 2 || room.phase !== 'waiting') {
        return error(ws, 'ROOM_FULL', '房间已满，最多允许两名玩家。', 4003);
      }
      const other = players(room)[0]?.player;
      slot = makeSlot(token(12), selectSpawn(world, other, 1));
      room.slots.set(slot.player.id, slot);
    }

    const previous = slot.socket;
    slot.socket = ws;
    slot.connected = true;
    slot.everConnected = true;
    slot.ready = false;
    clearInput(slot);
    ws.saltline.slot = slot;
    ws.saltline.room = room;
    room.touchedAt = clock();
    if (previous && previous !== ws) previous.close(4001, 'connection replaced');
    send(ws, {
      type: 'joined', roomId: room.id, playerId: slot.player.id,
      reconnectToken: slot.token,
      manifest: { version: manifest.version, hash: manifest.hash, seed: manifest.seed },
      state: state(room), serverTime: clock(),
    });
    if (room.phase === 'reconnecting' && players(room).every((entry) => entry.connected)) {
      beginCountdown(room, 'resume');
    } else snapshot(room);
  }

  function handleMessage(ws, raw, binary) {
    if (binary) return error(ws, 'INVALID_MESSAGE', '不支持二进制消息。', 4002);
    const meta = ws.saltline;
    const now = clock();
    if (now - meta.windowStart >= 1000) { meta.windowStart = now; meta.messages = 0; }
    if (++meta.messages > 180) return error(ws, 'RATE_LIMIT', '操作发送过于频繁。', 4008);
    let data;
    try { data = JSON.parse(raw.toString()); } catch {
      return error(ws, 'INVALID_MESSAGE', '消息格式错误。', 4002);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return error(ws, 'INVALID_MESSAGE', '消息格式错误。', 4002);
    }
    if (data.type === 'join') return join(ws, data);
    if (!meta.slot) return error(ws, 'JOIN_REQUIRED', '请先加入房间。', 4002);
    const { slot, room } = meta;
    if (slot.socket !== ws) return;
    room.touchedAt = now;
    switch (data.type) {
      case 'ready': {
        if (room.phase !== 'waiting') return;
        slot.ready = data.ready === true;
        if (room.slots.size === 2 && players(room).every((entry) => entry.connected && entry.ready)) {
          beginCountdown(room, 'start');
        } else snapshot(room);
        return;
      }
      case 'input': {
        if (room.phase !== 'playing' || !slot.player.alive) return;
        const input = sanitizeInput(data.input);
        if (!input || input.seq <= slot.lastSeq || input.lifeId !== slot.player.lifeId) return;
        slot.lastSeq = input.seq;
        slot.pendingInputs.push(input);
        if (slot.pendingInputs.length > 32) slot.pendingInputs.shift();
        slot.lastInputAt = now;
        return;
      }
      case 'neutral':
        clearInput(slot);
        return;
      case 'rematch':
        if (room.phase !== 'finished') return;
        slot.rematch = true;
        if (room.slots.size === 2 && players(room).every((entry) => entry.connected && entry.rematch)) {
          beginCountdown(room, 'start');
        } else snapshot(room);
        return;
      case 'leave':
        detach(ws, true);
        ws.close(1000, 'left room');
        return;
      case 'ping':
        send(ws, { type: 'pong', serverTime: now });
        return;
      default:
        return error(ws, 'UNKNOWN_MESSAGE', '不支持此操作。');
    }
  }

  function tick(dt = STEP, now = clock()) {
    if (!(dt > 0) || dt > 0.25 || !Number.isFinite(dt)) return;
    frame++;
    for (const [id, room] of rooms) {
      if (room.phase === 'ended') {
        if (now - room.endedAt > END_TTL) rooms.delete(id);
        continue;
      }
      if (room.phase === 'reconnecting') {
        if (now >= room.disconnectDeadline) end(room);
      } else if (room.phase === 'countdown') {
        if (!players(room).every((slot) => slot.connected)) continue;
        room.countdown = Math.max(0, room.countdown - dt);
        if (room.countdown <= 1e-8) {
          room.countdown = 0;
          room.phase = 'playing';
          for (const slot of room.slots.values()) clearInput(slot);
          snapshot(room);
        }
      } else if (room.phase === 'playing') {
        room.matchTime += dt;
        const slots = players(room);
        const shots = [];
        for (const slot of slots) {
          const p = slot.player;
          const wasAlive = p.alive;
          const fresh = now - slot.lastInputAt <= MAX_INPUT_AGE;
          if (!fresh) slot.pendingInputs.length = 0;
          if (fresh && slot.pendingInputs.length) slot.input = slot.pendingInputs.shift();
          let input = fresh ? { ...slot.input } : neutral(p);
          if (!fresh || slot.edgeSeq === input.seq) {
            input.jump = false;
            input.reload = false;
          }
          slot.edgeSeq = input.seq;
          const result = simulatePlayer(p, input, dt, world, { authority: true, allowAttack: true });
          p.ackSeq = Math.max(p.ackSeq ?? -1, input.seq);
          for (const shot of result.shots || []) shots.push({ slot, shot });
          if (wasAlive && !p.alive) {
            event(room, { type: 'kill', shooterId: null, targetId: p.id, cause: 'environment', score: null });
          }
          if (!p.alive && p.deadFor >= (RULES.respawnSeconds || 3)) {
            const other = slots.find((entry) => entry !== slot)?.player;
            resetPlayer(p, selectSpawn(world, other, slots.indexOf(slot)));
            p.ackSeq = slot.lastSeq;
            clearInput(slot);
            event(room, { type: 'respawn', playerId: p.id, lifeId: p.lifeId, pos: { ...p.pos } });
          }
        }
        for (const { slot, shot } of shots) {
          if (room.phase !== 'playing') break;
          // A shot already fired in this step remains valid if its shooter was
          // killed later in the same step, until the first winning kill locks it.
          const shooter = slot.player;
          event(room, {
            type: 'shot', shooterId: shooter.id, shotId: shot.shotId, lifeId: shot.lifeId,
            origin: shot.origin, dir: shot.dir,
          });
          const other = slots.find((entry) => entry !== slot);
          if (!other?.player.alive) continue;
          const target = other.player;
          const hit = tracePlayerHit(world, shot, target);
          if (!hit) continue;
          const before = target.health;
          const killed = applyDamage(target, RULES.damage || 26);
          if (target.health === before) continue;
          event(room, {
            type: 'hit', shooterId: shooter.id, targetId: target.id,
            health: target.health, amount: before - target.health,
            point: hit.point, origin: shot.origin, shotId: shot.shotId,
          });
          if (killed) {
            shooter.score++;
            clearInput(other);
            event(room, { type: 'kill', shooterId: shooter.id, targetId: target.id, score: shooter.score });
            if (shooter.score >= 10) finish(room, shooter.id);
          }
        }
      }
      if ((room.phase === 'waiting' || room.phase === 'finished') && now - room.touchedAt > WAIT_TTL) {
        end(room, 'room-expired');
      }
      if (frame % SNAPSHOT_EVERY === 0 && room.phase !== 'ended') snapshot(room);
    }
    for (const [key, value] of createLimits) if (now - value.start > 120000) createLimits.delete(key);
  }

  const server = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', originFor(req));
      if (parsed.pathname === '/healthz' && req.method === 'GET') {
        return json(res, 200, {
          ok: true, ready: !closing,
          version: manifest.version, mapHash: manifest.hash, seed: manifest.seed,
        });
      }
      if (parsed.pathname === '/api/rooms' && req.method === 'POST') {
        if (closing) return json(res, 503, { code: 'SERVER_STARTING', message: '联机服务正在启动，请稍候。' });
        if (!validOrigin(req)) return json(res, 403, { code: 'INVALID_ORIGIN', message: '请从游戏页面创建房间。' });
        const ip = req.socket.remoteAddress || 'unknown';
        const now = clock();
        let limit = createLimits.get(ip);
        if (!limit || now - limit.start > 60000) {
          limit = { start: now, count: 0 };
          createLimits.set(ip, limit);
        }
        if (++limit.count > 10) return json(res, 429, { code: 'RATE_LIMIT', message: '创建过于频繁，请稍后重试。' });
        if (rooms.size >= maxRooms) return json(res, 503, { code: 'SERVER_BUSY', message: '联机服务繁忙，请稍后重试。' });
        if (Number(req.headers['content-length'] || 0) > 1024) {
          return json(res, 413, { code: 'TOO_LARGE', message: '请求过大。' });
        }
        let total = 0;
        for await (const chunk of req) {
          total += chunk.length;
          if (total > 1024) return json(res, 413, { code: 'TOO_LARGE', message: '请求过大。' });
        }
        const { room, host } = makeRoom();
        return json(res, 201, {
          roomId: room.id, playerId: host.player.id, reconnectToken: host.token,
          inviteUrl: originFor(req) + '/?room=' + encodeURIComponent(room.id),
          version: manifest.version, mapHash: manifest.hash,
        });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '不支持此请求方式。' });
      }
      if (parsed.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const allowed = new Map([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/index.html', ['index.html', 'text/html; charset=utf-8']],
        ['/multiplayer/loader.js', ['multiplayer/loader.js', 'text/javascript; charset=utf-8']],
        ['/multiplayer/client.mjs', ['multiplayer/client.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier.mjs', ['multiplayer/soldier.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-surfaces.mjs', ['multiplayer/soldier-surfaces.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-meshes.mjs', ['multiplayer/soldier-meshes.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-symmetry.mjs', ['multiplayer/soldier-symmetry.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-torso.mjs', ['multiplayer/soldier-torso.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-head.mjs', ['multiplayer/soldier-head.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-lower.mjs', ['multiplayer/soldier-lower.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/soldier-gltf.mjs', ['multiplayer/soldier-gltf.mjs', 'text/javascript; charset=utf-8']],
        ...['GLTFLoader', 'SkeletonUtils', 'BufferGeometryUtils', 'three-bridge'].map(name => ['/multiplayer/vendor/three-r180/' + name + '.mjs', ['multiplayer/vendor/three-r180/' + name + '.mjs', 'text/javascript; charset=utf-8']]),
        ['/multiplayer/assets/custom-soldier.glb', ['multiplayer/assets/custom-soldier.glb', 'model/gltf-binary']],
        ['/multiplayer/assets/custom-soldier.gltf', ['multiplayer/assets/custom-soldier.gltf', 'model/gltf+json']],
        ['/multiplayer/world-loadout.mjs', ['multiplayer/world-loadout.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/shared/simulation.mjs', ['multiplayer/shared/simulation.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/shared/map-utils.mjs', ['multiplayer/shared/map-utils.mjs', 'text/javascript; charset=utf-8']],
        ['/multiplayer/shared/map.json', ['multiplayer/shared/map.json', 'application/json; charset=utf-8']],
      ]);
      const asset = allowed.get(parsed.pathname);
      if (!asset) return json(res, 404, { code: 'NOT_FOUND', message: '页面不存在。' });
      const file = resolve(staticRoot, asset[0]);
      let body = await new Promise((done, reject) => readFile(file, (err, value) => err ? reject(err) : done(value)));
      if (asset[0] === 'index.html') body = Buffer.from(addMultiplayerEntry(body.toString('utf8')), 'utf8');
      res.writeHead(200, {
        'Content-Type': asset[1], 'Content-Length': body.length,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      if (!res.headersSent) json(res, err.code === 'ENOENT' ? 404 : 500, {
        code: 'REQUEST_FAILED', message: '请求未完成，请刷新后重试。',
      });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let path;
    try { path = new URL(req.url || '/', originFor(req)).pathname; } catch {}
    if (closing || path !== '/ws' || !validOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    const now = clock();
    ws.saltline = { slot: null, room: null, windowStart: now, messages: 0, openedAt: now, pong: true };
    ws.on('pong', () => { ws.saltline.pong = true; });
    ws.on('message', (data, binary) => handleMessage(ws, data, binary));
    ws.on('close', () => detach(ws));
    ws.on('error', () => {});
  });

  function startTimers() {
    if (!timer && options.autoTick !== false) {
      lastClock = clock();
      timer = setInterval(() => {
        const now = clock();
        accumulated += Math.min(0.25, Math.max(0, (now - lastClock) / 1000));
        lastClock = now;
        let steps = 0;
        while (accumulated >= STEP && steps++ < 15) {
          tick(STEP, now);
          accumulated -= STEP;
        }
      }, 1000 / 60);
      timer.unref();
    }
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
          const meta = ws.saltline;
          if (!meta.pong || (!meta.slot && clock() - meta.openedAt > 8000)) {
            ws.terminate();
            continue;
          }
          meta.pong = false;
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }
      }, heartbeatMs);
      heartbeat.unref();
    }
  }

  async function listen(port = Number(process.env.PORT || 8787), host = '0.0.0.0') {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        done();
      });
    });
    startTimers();
    return server.address();
  }

  async function close(reason = 'server-restart') {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const room of rooms.values()) end(room, reason);
    // close frames are best-effort during shutdown; free the actual sockets too.
    for (const ws of wss.clients) ws.terminate();
    await new Promise((done) => wss.close(() => done()));
    if (server.listening) await new Promise((done) => server.close(() => done()));
  }

  return { server, wss, rooms, world, manifest, tick, listen, close, snapshot, state };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createGameServer();
  const address = await app.listen();
  console.log('Saltline: http://localhost:' + address.port + ' (online 1v1 ready)');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

