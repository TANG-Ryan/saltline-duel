import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, createWorld, createPlayer, resetPlayer, sanitizeInput, simulatePlayer,
  applyDamage, selectSpawn, raycastWorld, tracePlayerHit
} from '../shared/simulation.mjs';

const emptyWorld = () => createWorld({ boxes: [] });
const spawn = (x = 0, y = 0, z = 0) => ({ pos: { x, y, z }, yaw: 0 });
const inputFor = (p, values = {}) => ({ lifeId: p.lifeId, seq: 1, yaw: p.yaw, pitch: p.pitch, ...values });
const run = (p, world, ticks, values = {}, options) => {
  const shots = [], events = [];
  for (let j = 0; j < ticks; j++) {
    const result = simulatePlayer(p, inputFor(p, { seq: j + 1, ...values }), RULES.step, world, options);
    shots.push(...result.shots); events.push(...result.events);
  }
  return { shots, events };
};
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, String(actual) + ' differs from ' + expected);

test('input bounds reject non-finite values and normalize diagonal movement', () => {
  const raw = sanitizeInput({ seq: Infinity, lifeId: -4, moveX: 20, moveY: -20, yaw: NaN, pitch: 9, fire: 'true', jump: true });
  near(Math.hypot(raw.moveX, raw.moveY), 1);
  assert.equal(raw.seq, 0); assert.equal(raw.lifeId, 0); assert.equal(raw.yaw, 0);
  assert.equal(raw.pitch, 1.5); assert.equal(raw.fire, false); assert.equal(raw.jump, true);
  assert.equal(sanitizeInput(null).fire, false);
});

test('movement uses bounded diagonal speed and cannot traverse tall walls', () => {
  const world = createWorld({ boxes: [{ min: [1, 0, -10], max: [2, 3, 10] }] });
  const p = createPlayer('wall', spawn());
  run(p, world, 120, { moveX: 1 });
  assert.ok(p.pos.x <= 1 - RULES.radius + 1e-6);
  near(p.pos.y, 0); assert.equal(p.onGround, true);
  const q = createPlayer('diagonal', spawn());
  run(q, emptyWorld(), 120, { moveX: 1, moveY: 1 });
  assert.ok(Math.hypot(q.vel.x, q.vel.z) <= RULES.walk + 1e-6);
});

test('low steps remain traversable and bulletOnly geometry does not block walking', () => {
  const step = createWorld({ boxes: [{ min: [1, 0, -2], max: [2, 0.3, 2] }] });
  const p = createPlayer('steps', spawn()); run(p, step, 100, { moveX: 1 });
  assert.ok(p.pos.x > 3);
  const bulletOnly = createWorld({ boxes: [{ min: [1, 0, -2], max: [2, 4, 2], bulletOnly: true }] });
  const q = createPlayer('bullet-only', spawn()); run(q, bulletOnly, 100, { moveX: 1 });
  assert.ok(q.pos.x > 3);
});

test('crouching cannot stand inside a low ceiling', () => {
  const world = createWorld({ boxes: [{ min: [-2, 1.3, -2], max: [2, 2, 2] }] });
  const p = createPlayer('crouch', spawn()); p.crouching = true;
  simulatePlayer(p, inputFor(p, { crouch: false }), RULES.step, world);
  assert.equal(p.crouching, true); assert.equal(p.eyeHeight, RULES.crouchEye);
});

test('held jump edges are consumed once, including across repeated simulation ticks', () => {
  const p = createPlayer('jump', spawn()), world = emptyWorld();
  let jumps = 0;
  for (let j = 0; j < 180; j++) {
    const result = simulatePlayer(p, inputFor(p, { seq: 7, jump: true }), RULES.step, world);
    jumps += result.events.filter((event) => event.type === 'jump').length;
  }
  assert.equal(jumps, 1); near(p.pos.y, 0);
});

test('720 RPM produces twelve shots per second and each shot breaks spawn protection', () => {
  const p = createPlayer('fire', spawn());
  const result = run(p, emptyWorld(), 60, { fire: true });
  assert.equal(result.shots.length, 12); assert.equal(p.ammo, 18);
  assert.equal(p.invulnerableFor, 0);
  assert.equal(new Set(result.shots.map((shot) => shot.shotId)).size, 12);
  for (const shot of result.shots) near(Math.hypot(shot.dir.x, shot.dir.y, shot.dir.z), 1);
});

test('server attack gate prevents shots without mutating ammunition', () => {
  const p = createPlayer('gate', spawn());
  const result = run(p, emptyWorld(), 30, { fire: true }, { allowAttack: false });
  assert.equal(result.shots.length, 0); assert.equal(p.ammo, RULES.magSize);
  assert.ok(p.invulnerableFor > 0);
});

test('reload blocks shots until completion and empty reload takes longer', () => {
  const p = createPlayer('reload', spawn()), world = emptyWorld(); p.ammo = 4;
  simulatePlayer(p, inputFor(p, { reload: true, fire: true }), RULES.step, world);
  near(p.reloadRemaining, RULES.reloadTactical);
  const during = run(p, world, 125, { seq: 2, fire: true });
  assert.equal(during.shots.length, 0); assert.equal(p.ammo, 4);
  const end = simulatePlayer(p, inputFor(p, { seq: 3 }), RULES.step, world);
  assert.ok(end.events.some((event) => event.type === 'reloaded')); assert.equal(p.ammo, 30);
  p.ammo = 0;
  simulatePlayer(p, inputFor(p, { seq: 4, reload: true }), RULES.step, world);
  near(p.reloadRemaining, RULES.reloadEmpty);
  run(p, world, 162, { seq: 4 }); assert.equal(p.ammo, 0);
  run(p, world, 2, { seq: 4 }); assert.equal(p.ammo, 30);
});

test('empty magazine automatically reloads using infinite reserve without bypassing the timer', () => {
  const p = createPlayer('auto', spawn()), world = emptyWorld(); p.ammo = 1;
  simulatePlayer(p, inputFor(p, { fire: true }), RULES.step, world);
  assert.equal(p.ammo, 0);
  run(p, world, 20, { seq: 2 }); assert.ok(p.reloadRemaining > 2.6);
  assert.equal(p.ammo, 0);
  run(p, world, 164, { seq: 3 }); assert.equal(p.ammo, RULES.magSize);
});

test('damage ignores shielded targets and death can occur only once', () => {
  const p = createPlayer('damage', spawn());
  assert.equal(applyDamage(p, 26), false); assert.equal(p.health, 100);
  assert.equal(applyDamage(p, 26, { ignoreShield: true }), false); assert.equal(p.health, 74);
  assert.equal(applyDamage(p, 100, { ignoreShield: true }), true);
  assert.equal(applyDamage(p, 100, { ignoreShield: true }), false);
  assert.equal(p.health, 0); assert.equal(p.alive, false);
});

test('health regeneration is authoritative and begins after four seconds', () => {
  const p = createPlayer('regen', spawn()), world = emptyWorld(); p.invulnerableFor = 0;
  applyDamage(p, 50); run(p, world, 240);
  near(p.health, 50); run(p, world, 30);
  assert.ok(p.health > 60 && p.health < 65);
  const q = createPlayer('prediction', spawn()); q.health = 50;
  run(q, world, 600, {}, { authority: false }); assert.equal(q.health, 50);
});

test('fall deaths and water rescue alter health only on the authority', () => {
  const world = emptyWorld(), p = createPlayer('fall', spawn(0, 20, 0)); p.invulnerableFor = 0;
  const result = run(p, world, 150);
  assert.equal(p.alive, false); assert.ok(result.events.some((event) => event.type === 'death' && event.cause === 'fall'));
  const q = createPlayer('sea', spawn()); q.invulnerableFor = 0; q.pos = { x: 32, y: -5, z: 0 };
  simulatePlayer(q, inputFor(q), RULES.step, world); near(q.pos.x, 0); near(q.health, 88);
  const predicted = createPlayer('sea-predict', spawn()); predicted.pos = { x: 32, y: -5, z: 0 };
  predicted.health = 35;
  simulatePlayer(predicted, inputFor(predicted), RULES.step, world, { authority: false }); assert.equal(predicted.health, 35);
});

test('respawn preserves score and shot IDs, increments life, and rejects old-life input', () => {
  const p = createPlayer('reset', spawn()); p.score = 9; p.shotSequence = 21; const oldLife = p.lifeId;
  resetPlayer(p, spawn(5));
  assert.equal(p.score, 9); assert.equal(p.lifeId, oldLife + 1); assert.equal(p.shotSequence, 21);
  assert.equal(p.health, 100); assert.equal(p.ammo, 30);
  const result = simulatePlayer(p, { lifeId: oldLife, seq: 99, moveX: 1, fire: true }, RULES.step, emptyWorld());
  assert.equal(result.shots.length, 0); near(p.pos.x, 5);
});

test('player capsules follow crouch height and include body and lower limbs', () => {
  const world = emptyWorld(), target = createPlayer('target', spawn(0, 0, -5));
  const shot = (y) => ({ origin: { x: 0, y, z: 0 }, dir: { x: 0, y: 0, z: -1 } });
  assert.ok(tracePlayerHit(world, shot(1.6), target)); assert.ok(tracePlayerHit(world, shot(0.2), target));
  target.crouching = true;
  assert.equal(tracePlayerHit(world, shot(1.6), target), null); assert.ok(tracePlayerHit(world, shot(0.8), target));
  target.alive = false; assert.equal(tracePlayerHit(world, shot(0.8), target), null);
});

test('map obstruction beats player hits, preserving bulletOnly and playerOnly semantics', () => {
  const box = { min: [-1, 0, -3], max: [1, 3, -2] };
  const target = createPlayer('target', spawn(0, 0, -5));
  const shot = { origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 } };
  assert.equal(tracePlayerHit(createWorld({ boxes: [box] }), shot, target), null);
  assert.equal(tracePlayerHit(createWorld({ boxes: [{ ...box, bulletOnly: true }] }), shot, target), null);
  assert.ok(tracePlayerHit(createWorld({ boxes: [{ ...box, playerOnly: true }] }), shot, target));
  near(raycastWorld(createWorld({ boxes: [box] }), shot.origin, shot.dir).dist, 2);
  assert.equal(raycastWorld(createWorld({ boxes: [box] }), shot.origin, { x: 1, y: 0, z: 0 }), null);
});

test('shared prediction is deterministic with independent shot RNG', () => {
  const a = createPlayer('same-id', spawn()), b = createPlayer('same-id', spawn());
  const input = { fire: true, ads: true, moveX: 0.4, moveY: 0.7 };
  const first = run(a, emptyWorld(), 120, input), second = run(b, emptyWorld(), 120, input, { authority: false });
  assert.deepEqual(first.shots, second.shots); assert.deepEqual(a.pos, b.pos);
  near(a.recoilPitch, b.recoilPitch); near(a.recoilYaw, b.recoilYaw);
});

test('spawn selection filters blocked positions and favors distance from the opponent', () => {
  const world = createWorld({
    boxes: [{ min: [-1, 0, -1], max: [1, 3, 1] }],
    spawnPoints: [spawn(0), spawn(5), spawn(-20)]
  });
  assert.equal(selectSpawn(world, null, 0).pos.x, 5);
  assert.equal(selectSpawn(world, createPlayer('opponent', spawn(4)), 0).pos.x, -20);
  assert.throws(() => selectSpawn(createWorld({ boxes: world.boxes, spawnPoints: [spawn(0)] }), null), /no safe spawn/);
});

