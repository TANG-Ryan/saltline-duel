// Shared deterministic gameplay rules. No browser or Node-only dependencies.
export const RULES = Object.freeze({
  step: 1 / 60, snapshotHz: 20, health: 100, respawnSeconds: 3,
  spawnShieldSeconds: 2, magSize: 30, rpm: 720, damage: 26, range: 300,
  reloadTactical: 2.1, reloadEmpty: 2.72, regenDelay: 4, regenRate: 25,
  maxInputAge: 0.25, walk: 3.8, sprint: 6.4, crouch: 1.9, ads: 2.4,
  radius: 0.32, height: 1.8, crouchHeight: 1.15, eye: 1.68,
  crouchEye: 1.05, gravity: 21, stepHeight: 0.42, jumpSpeed: Math.sqrt(42),
  autoReloadDelay: 0.32
});

const EPS = 1e-8;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback = 0) => typeof n === 'number' && Number.isFinite(n) ? n : fallback;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (n) => { n = clamp(n, 0, 1); return n * n * n * (n * (n * 6 - 15) + 10); };
const vec = (value, fallback = { x: 0, y: 0, z: 0 }) => ({
  x: finite(Array.isArray(value) ? value[0] : value?.x, fallback.x),
  y: finite(Array.isArray(value) ? value[1] : value?.y, fallback.y),
  z: finite(Array.isArray(value) ? value[2] : value?.z, fallback.z)
});
const distanceSq = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const pointAt = (origin, dir, t) => ({ x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t });

export function createWorld(manifest = {}) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('A collision manifest is required');
  const boxes = (manifest.boxes || []).map((box) => {
    const a = vec(box.min), b = vec(box.max);
    return {
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
      surface: typeof box.surface === 'string' ? box.surface : 'concrete',
      tag: typeof box.tag === 'string' ? box.tag : '',
      bulletOnly: !!box.bulletOnly, playerOnly: !!box.playerOnly
    };
  });
  const defaults = [{ pos: [-32, 0, 6], yaw: -Math.PI / 2 }, { pos: [22, 0, 20], yaw: Math.PI / 2 }];
  return {
    version: manifest.version || 'saltline-1', hash: manifest.hash || '', seed: 4207,
    bounds: { min: vec(manifest.bounds?.min, { x: -40, y: 0, z: -30 }), max: vec(manifest.bounds?.max, { x: 40, y: 30, z: 30 }) },
    groundY: finite(manifest.groundY), seaY: finite(manifest.seaY, -1.6),
    quayX: finite(manifest.quayX, 30), boxes,
    spawnPoints: (manifest.spawnPoints?.length ? manifest.spawnPoints : defaults).map((spawn) => ({ pos: vec(spawn.pos), yaw: finite(spawn.yaw) }))
  };
}

export function createPlayer(id, spawn = { pos: { x: -32, y: 0, z: 6 }, yaw: -Math.PI / 2 }) {
  const p = { id: String(id), score: 0, lifeId: 0, shotSequence: 0, ackSeq: 0 };
  return resetPlayer(p, spawn);
}

export function resetPlayer(p, spawn) {
  const pos = vec(spawn?.pos);
  Object.assign(p, {
    pos, vel: { x: 0, y: 0, z: 0 }, yaw: finite(spawn?.yaw), pitch: 0,
    health: RULES.health, alive: true, ammo: RULES.magSize, reloadRemaining: 0,
    invulnerableFor: RULES.spawnShieldSeconds, lifeId: (p.lifeId || 0) + 1, deadFor: 0,
    score: finite(p.score), shotSequence: p.shotSequence || 0, ackSeq: p.ackSeq || 0,
    lastSafe: { ...pos }, onGround: true, crouching: false, sprinting: false,
    ads: 0, eyeHeight: RULES.eye, recoilPitch: 0, recoilYaw: 0,
    regenAfter: 0, shotCooldown: 0, autoReloadFor: -1, adsProgress: 0,
    spread: 0.0125, bloom: 0, burst: 0, timeSinceShot: 99,
    jumpBuffer: 0, coyote: 0.12, airTime: 0, fallSpeed: 0,
    lastEdgeSeq: -1
  });
  return p;
}

export function sanitizeInput(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  let x = clamp(finite(raw.moveX), -1, 1), y = clamp(finite(raw.moveY), -1, 1);
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  const yaw = finite(raw.yaw);
  return {
    seq: clamp(Math.floor(finite(raw.seq)), 0, 0x7fffffff),
    lifeId: clamp(Math.floor(finite(raw.lifeId)), 0, 0x7fffffff),
    moveX: x, moveY: y, yaw: ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: clamp(finite(raw.pitch), -1.5, 1.5),
    fire: raw.fire === true, ads: raw.ads === true, sprint: raw.sprint === true,
    crouch: raw.crouch === true, jump: raw.jump === true, reload: raw.reload === true
  };
}

export function applyDamage(p, amount, { ignoreShield = false } = {}) {
  amount = finite(amount);
  if (!p.alive || amount <= 0 || (!ignoreShield && p.invulnerableFor > 0)) return false;
  p.health = Math.max(0, p.health - amount);
  p.regenAfter = 0;
  if (p.health > 0) return false;
  p.alive = false;
  p.deadFor = 0;
  p.sprinting = false;
  p.reloadRemaining = 0;
  p.autoReloadFor = -1;
  return true;
}

function canStand(p, world) {
  const r = RULES.radius * 0.9;
  return !world.boxes.some((box) => !box.bulletOnly &&
    p.pos.x + r >= box.min.x && p.pos.x - r <= box.max.x &&
    p.pos.z + r >= box.min.z && p.pos.z - r <= box.max.z &&
    box.min.y < p.pos.y + RULES.height && box.max.y > p.pos.y + RULES.crouchHeight - 0.05);
}

// The original Saltline capsule/AABB movement, including the 0.42m step allowance.
function moveCapsule(p, dt, world, height, wasGround) {
  const pos = p.pos, vel = p.vel, r = RULES.radius;
  const result = { onGround: false };
  const dx = vel.x * dt, dz = vel.z * dt;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (r * 0.6)));
  const oldY = pos.y;
  for (let step = 0; step < steps; step++) {
    pos.x += dx / steps; pos.z += dz / steps;
    for (let pass = 0; pass < 3; pass++) {
      let collided = false;
      for (const box of world.boxes) {
        if (box.bulletOnly || box.max.y <= pos.y + (wasGround ? RULES.stepHeight : 0.08) || box.min.y >= pos.y + height) continue;
        const nx = clamp(pos.x, box.min.x, box.max.x), nz = clamp(pos.z, box.min.z, box.max.z);
        let x = pos.x - nx, z = pos.z - nz;
        const squared = x * x + z * z;
        if (squared >= r * r) continue;
        if (squared > 1e-10) {
          const len = Math.sqrt(squared), push = r - len;
          x /= len; z /= len; pos.x += x * push; pos.z += z * push;
          const into = vel.x * x + vel.z * z;
          if (into < 0) { vel.x -= x * into; vel.z -= z * into; }
        } else {
          const distances = [pos.x - box.min.x, box.max.x - pos.x, pos.z - box.min.z, box.max.z - pos.z];
          const side = distances.indexOf(Math.min(...distances));
          if (side === 0) { pos.x = box.min.x - r; if (vel.x > 0) vel.x = 0; }
          else if (side === 1) { pos.x = box.max.x + r; if (vel.x < 0) vel.x = 0; }
          else if (side === 2) { pos.z = box.min.z - r; if (vel.z > 0) vel.z = 0; }
          else { pos.z = box.max.z + r; if (vel.z < 0) vel.z = 0; }
        }
        collided = true;
      }
      if (!collided) break;
    }
  }
  const nextY = pos.y + vel.y * dt, supportRadius = r * 0.7;
  let floor = pos.x <= world.quayX + supportRadius ? world.groundY : -50;
  let ceiling = Infinity;
  const stepTop = oldY + (wasGround ? RULES.stepHeight : 0.08) + 1e-4;
  for (const box of world.boxes) {
    if (box.bulletOnly || pos.x + supportRadius < box.min.x || pos.x - supportRadius > box.max.x ||
      pos.z + supportRadius < box.min.z || pos.z - supportRadius > box.max.z) continue;
    if (box.max.y <= stepTop && box.max.y > floor) floor = box.max.y;
    if (box.min.y >= oldY + height - 0.05 && box.min.y < ceiling) ceiling = box.min.y;
  }
  if (vel.y > 0 && nextY + height > ceiling) { pos.y = ceiling - height; vel.y = 0; }
  else if (nextY <= floor || (wasGround && vel.y <= 0 && nextY - floor < RULES.stepHeight)) {
    pos.y = floor; if (vel.y < 0) vel.y = 0; result.onGround = true;
  } else pos.y = nextY;
  return result;
}

function shotRandom(id, sequence) {
  let value = 2166136261;
  const text = String(id) + ':' + sequence;
  for (let j = 0; j < text.length; j++) value = Math.imul(value ^ text.charCodeAt(j), 16777619);
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let n = Math.imul(value ^ value >>> 15, 1 | value);
    n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n;
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

function beginReload(p, events) {
  if (p.reloadRemaining > 0 || p.ammo >= RULES.magSize) return;
  p.reloadRemaining = p.ammo === 0 ? RULES.reloadEmpty : RULES.reloadTactical;
  p.autoReloadFor = -1;
  events.push({ type: 'reload', duration: p.reloadRemaining });
}

export function simulatePlayer(p, raw, dt, world, { authority = true, allowAttack = true } = {}) {
  const result = { shots: [], events: [] };
  dt = clamp(finite(dt), 0, 0.05);
  if (dt <= 0) return result;
  p.invulnerableFor = Math.max(0, p.invulnerableFor - dt);
  if (!p.alive) { p.deadFor += dt; return result; }
  const input = sanitizeInput(raw);
  // Packets for the preceding life cannot move or shoot a newly respawned player.
  const valid = input.lifeId === p.lifeId;
  const active = valid ? input : sanitizeInput({ lifeId: p.lifeId, yaw: p.yaw, pitch: p.pitch });
  if (valid) p.ackSeq = Math.max(p.ackSeq, input.seq);
  const newEdges = valid && input.seq > p.lastEdgeSeq;
  if (newEdges) p.lastEdgeSeq = input.seq;
  p.yaw = active.yaw; p.pitch = active.pitch;
  p.timeSinceShot += dt;
  if (p.timeSinceShot > 0.09) {
    const decay = Math.exp(-6.5 * dt); p.recoilPitch *= decay; p.recoilYaw *= decay;
  }
  if (p.timeSinceShot > 0.24) p.burst = 0;
  p.bloom = Math.max(0, p.bloom - dt * 1.5);
  p.crouching = active.crouch || (p.crouching && !canStand(p, world));
  const height = p.crouching ? RULES.crouchHeight : RULES.height;
  p.eyeHeight = p.crouching ? RULES.crouchEye : RULES.eye;
  const wantsAds = active.ads && p.reloadRemaining <= 0;
  p.adsProgress = clamp(p.adsProgress + (wantsAds ? 1 : -1) * dt / 0.18, 0, 1);
  p.ads = smooth(p.adsProgress);
  const wantsSprint = active.sprint && active.moveY > 0.55 && Math.abs(active.moveX) < 0.6 &&
    !p.crouching && p.ads < 0.35 && !active.fire;
  const oldSpeed = Math.hypot(p.vel.x, p.vel.z);
  p.sprinting = wantsSprint && (p.onGround ? oldSpeed > RULES.walk * 0.6 : p.sprinting);
  let speed = p.crouching ? RULES.crouch : wantsSprint ? RULES.sprint : RULES.walk;
  speed = lerp(speed, Math.min(speed, RULES.ads), p.ads);
  if (active.moveY < 0) speed *= lerp(1, 0.82, -active.moveY);
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  const tx = (active.moveX * cy - active.moveY * sy) * speed;
  const tz = (-active.moveX * sy - active.moveY * cy) * speed;
  const moving = active.moveX * active.moveX + active.moveY * active.moveY > 0.01;
  const acceleration = p.onGround ? moving ? 34 : 26 : moving ? 9 : 0.6;
  const dx = tx - p.vel.x, dz = tz - p.vel.z, difference = Math.hypot(dx, dz), change = acceleration * dt;
  if (difference <= change || difference < 1e-6) {
    if (p.onGround || moving) { p.vel.x = tx; p.vel.z = tz; }
  } else { p.vel.x += dx / difference * change; p.vel.z += dz / difference * change; }
  p.coyote = p.onGround ? 0.12 : Math.max(0, p.coyote - dt);
  p.jumpBuffer = newEdges && active.jump ? 0.13 : Math.max(0, p.jumpBuffer - dt);
  if (p.jumpBuffer > 0 && p.coyote > 0 && (!p.crouching || canStand(p, world))) {
    p.vel.y = RULES.jumpSpeed; p.jumpBuffer = p.coyote = 0; p.onGround = false;
    p.crouching = false; p.eyeHeight = RULES.eye;
    result.events.push({ type: 'jump' });
  }
  const wasGround = p.onGround;
  p.vel.y = Math.max(-40, p.vel.y - RULES.gravity * dt * 0.5);
  const downSpeed = p.vel.y;
  const collision = moveCapsule(p, dt, world, p.crouching ? RULES.crouchHeight : RULES.height, wasGround);
  if (!collision.onGround) p.vel.y -= RULES.gravity * dt * 0.5;
  p.pos.x = clamp(p.pos.x, world.bounds.min.x + 0.4, world.bounds.max.x - 0.4);
  p.pos.z = clamp(p.pos.z, world.bounds.min.z + 0.4, world.bounds.max.z - 0.4);
  p.onGround = collision.onGround;
  if (p.onGround) {
    if (!wasGround && p.airTime > 0.12) {
      const impact = Math.max(0, -downSpeed, p.fallSpeed);
      if (impact > 13 && authority) {
        const amount = (impact - 13) * 7;
        const killed = applyDamage(p, amount);
        result.events.push({ type: 'fall', amount });
        if (killed) result.events.push({ type: 'death', cause: 'fall' });
      }
      result.events.push({ type: 'land' });
    }
    p.airTime = p.fallSpeed = 0;
    if (p.pos.x <= world.quayX - 1.2 && p.pos.y > world.groundY - 0.5) p.lastSafe = { ...p.pos };
  } else { p.airTime += dt; p.fallSpeed = Math.max(p.fallSpeed, -p.vel.y); }
  if (p.pos.y < world.seaY - 2.2) {
    p.pos = { ...p.lastSafe }; p.vel = { x: 0, y: 0, z: 0 }; p.onGround = true;
    p.airTime = p.fallSpeed = 0;
    if (authority) {
      const killed = applyDamage(p, 12);
      if (killed) result.events.push({ type: 'death', cause: 'water' });
    }
    result.events.push({ type: 'rescued' });
  }
  if (!p.alive) return result;
  if (authority) {
    p.regenAfter += dt;
    if (p.regenAfter > RULES.regenDelay) p.health = Math.min(RULES.health, p.health + RULES.regenRate * dt);
  }
  if (p.reloadRemaining > 0) {
    p.reloadRemaining = Math.max(0, p.reloadRemaining - dt);
    if (p.reloadRemaining <= EPS) {
      p.reloadRemaining = 0; p.ammo = RULES.magSize;
      result.events.push({ type: 'reloaded' });
    }
  }
  if (p.autoReloadFor >= 0) {
    p.autoReloadFor -= dt;
    if (p.autoReloadFor <= 0) beginReload(p, result.events);
  }
  if (newEdges && active.reload) beginReload(p, result.events);
  p.shotCooldown = Math.max(0, p.shotCooldown - dt);
  const movement = clamp(Math.hypot(p.vel.x, p.vel.z) / 6, 0, 1);
  const spread = lerp(0.0125, 0.0012, p.ads) + movement * lerp(0.013, 0.004, p.ads) +
    p.bloom * lerp(0.0065, 0.0022, p.ads) + (p.onGround ? 0 : 0.022) -
    (p.crouching ? 0.002 * (1 - p.ads) : 0);
  p.spread += (spread - p.spread) * (1 - Math.exp(-18 * dt));
  if (allowAttack && active.fire && !p.sprinting && p.reloadRemaining <= 0 && p.ammo > 0 && p.shotCooldown <= EPS) {
    p.shotSequence++; p.ammo--; p.shotCooldown = 60 / RULES.rpm;
    p.invulnerableFor = 0; p.timeSinceShot = 0; p.burst++;
    const random = shotRandom(p.id, p.shotSequence);
    const yaw = p.yaw + p.recoilYaw, pitch = clamp(p.pitch + p.recoilPitch, -1.5, 1.5);
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw), sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
    const angle = random() * Math.PI * 2, radius = Math.tan(p.spread) * Math.sqrt(random());
    const right = Math.cos(angle) * radius, up = Math.sin(angle) * radius;
    let x = -sinYaw * cosPitch + cosYaw * right + sinYaw * sinPitch * up;
    let y = sinPitch + cosPitch * up;
    let z = -cosYaw * cosPitch - sinYaw * right + cosYaw * sinPitch * up;
    const len = Math.hypot(x, y, z); x /= len; y /= len; z /= len;
    result.shots.push({
      origin: { x: p.pos.x, y: p.pos.y + p.eyeHeight, z: p.pos.z }, dir: { x, y, z },
      shotId: p.id + ':' + p.shotSequence, lifeId: p.lifeId
    });
    const scale = lerp(1, 0.55, p.ads) * (p.crouching ? 0.85 : 1);
    p.recoilPitch = Math.min(0.3, p.recoilPitch + 0.0068 * (p.burst <= 9 ? 1 : 0.38) * scale * (0.85 + random() * 0.3));
    p.recoilYaw = clamp(p.recoilYaw + (random() - 0.5) * 0.0022 * scale, -0.2, 0.2);
    p.bloom = Math.min(1, p.bloom + 0.17);
    if (p.ammo === 0) p.autoReloadFor = RULES.autoReloadDelay;
  }
  return result;
}

export function raycastWorld(world, rawOrigin, rawDir, maxDist = RULES.range) {
  const origin = vec(rawOrigin), dir = vec(rawDir);
  let best = Math.max(0, finite(maxDist, RULES.range)), found = null;
  if (dir.y < -1e-6) {
    let t = (world.groundY - origin.y) / dir.y;
    if (t >= 0 && t <= best) {
      if (origin.x + dir.x * t <= world.quayX) {
        best = t; found = { dist: t, point: pointAt(origin, dir, t), surface: 'concrete' };
      } else {
        t = (world.seaY - origin.y) / dir.y;
        if (t >= 0 && t <= best) { best = t; found = { dist: t, point: pointAt(origin, dir, t), surface: 'water' }; }
      }
    }
  }
  for (const box of world.boxes) {
    if (box.playerOnly) continue;
    let near = 0, far = best, hit = true;
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(dir[axis]) < EPS) {
        if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) { hit = false; break; }
      } else {
        let a = (box.min[axis] - origin[axis]) / dir[axis], b = (box.max[axis] - origin[axis]) / dir[axis];
        if (a > b) [a, b] = [b, a];
        near = Math.max(near, a); far = Math.min(far, b);
        if (near > far) { hit = false; break; }
      }
    }
    if (hit && near >= 0 && near <= best) {
      best = near; found = { dist: near, point: pointAt(origin, dir, near), surface: box.surface };
    }
  }
  return found;
}

function sphereHit(origin, dir, center, radius) {
  const x = origin.x - center.x, y = origin.y - center.y, z = origin.z - center.z;
  const b = x * dir.x + y * dir.y + z * dir.z, c = x * x + y * y + z * z - radius * radius;
  if (c <= 0) return 0;
  const discriminant = b * b - c;
  if (discriminant < 0) return Infinity;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : Infinity;
}

function capsuleHit(origin, dir, p) {
  const r = RULES.radius, height = p.crouching ? RULES.crouchHeight : RULES.height;
  const bottom = p.pos.y + r, top = p.pos.y + height - r;
  let best = Math.min(sphereHit(origin, dir, { x: p.pos.x, y: bottom, z: p.pos.z }, r),
    sphereHit(origin, dir, { x: p.pos.x, y: top, z: p.pos.z }, r));
  const ox = origin.x - p.pos.x, oz = origin.z - p.pos.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (ox * ox + oz * oz <= r * r && origin.y >= bottom && origin.y <= top) return 0;
  if (a > EPS) {
    const b = ox * dir.x + oz * dir.z, c = ox * ox + oz * oz - r * r, discriminant = b * b - a * c;
    if (discriminant >= 0) {
      const t = (-b - Math.sqrt(discriminant)) / a, y = origin.y + dir.y * t;
      if (t >= 0 && y >= bottom && y <= top) best = Math.min(best, t);
    }
  }
  return best;
}

export function tracePlayerHit(world, shot, target) {
  if (!target?.alive || !shot?.origin || !shot?.dir) return null;
  const origin = vec(shot.origin), dir = vec(shot.dir), length = Math.hypot(dir.x, dir.y, dir.z);
  if (length < EPS) return null;
  dir.x /= length; dir.y /= length; dir.z /= length;
  const hit = capsuleHit(origin, dir, target);
  if (!Number.isFinite(hit) || hit > RULES.range) return null;
  const blocker = raycastWorld(world, origin, dir, RULES.range);
  if (blocker && blocker.dist <= hit + 1e-5) return null;
  return { dist: hit, point: pointAt(origin, dir, hit) };
}

function validSpawn(world, spawn) {
  const p = spawn.pos, r = RULES.radius + 0.05;
  return p.x >= world.bounds.min.x + r && p.x <= Math.min(world.bounds.max.x - r, world.quayX - r) &&
    p.z >= world.bounds.min.z + r && p.z <= world.bounds.max.z - r &&
    !world.boxes.some((box) => !box.bulletOnly && box.max.y > p.y + RULES.stepHeight &&
      box.min.y < p.y + RULES.height && p.x + r > box.min.x && p.x - r < box.max.x &&
      p.z + r > box.min.z && p.z - r < box.max.z);
}

export function selectSpawn(world, opponent, slot = 0) {
  const candidates = world.spawnPoints.filter((spawn) => validSpawn(world, spawn));
  if (!candidates.length) throw new Error('The map has no safe spawn point');
  const offset = Math.abs(Math.floor(finite(slot))) % candidates.length;
  if (!opponent?.pos) {
    const chosen = candidates[offset];
    return { pos: { ...chosen.pos }, yaw: chosen.yaw };
  }
  let chosen = candidates[offset], best = -Infinity;
  for (let j = 0; j < candidates.length; j++) {
    const candidate = candidates[(offset + j) % candidates.length];
    const origin = { x: candidate.pos.x, y: candidate.pos.y + RULES.eye, z: candidate.pos.z };
    const target = { x: opponent.pos.x, y: opponent.pos.y + (opponent.eyeHeight || RULES.eye), z: opponent.pos.z };
    const distance = Math.sqrt(distanceSq(origin, target));
    const dir = { x: (target.x - origin.x) / (distance || 1), y: (target.y - origin.y) / (distance || 1), z: (target.z - origin.z) / (distance || 1) };
    const hidden = raycastWorld(world, origin, dir, distance);
    const score = distance + (hidden ? 12 : 0);
    if (score > best) { best = score; chosen = candidate; }
  }
  return { pos: { ...chosen.pos }, yaw: chosen.yaw };
}

