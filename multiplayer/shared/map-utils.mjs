/** Canonical collision data shared by the server, exporter and browser. */
const MAP_SEED = 4207;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Invalid collision coordinate: ' + name);
  }
  // Ignore differences below a micrometre across browser math implementations.
  return Number(value.toFixed(6));
}

function point(value, name) {
  if (!value) throw new TypeError('Missing collision point: ' + name);
  return {
    x: finite(value.x, name + '.x'),
    y: finite(value.y, name + '.y'),
    z: finite(value.z, name + '.z'),
  };
}

function normalizeWorld(world) {
  if (!world?.bounds || !Array.isArray(world.boxes) || world.boxes.length === 0) {
    throw new TypeError('Collision world is unavailable');
  }
  return {
    bounds: {
      min: point(world.bounds.min, 'bounds.min'),
      max: point(world.bounds.max, 'bounds.max'),
    },
    groundY: finite(world.groundY, 'groundY'),
    seaY: finite(world.seaY, 'seaY'),
    quayX: finite(world.quayX, 'quayX'),
    boxes: world.boxes.map((box, index) => ({
      min: point(box.min, 'boxes[' + index + '].min'),
      max: point(box.max, 'boxes[' + index + '].max'),
      surface: String(box.surface || 'concrete'),
      tag: String(box.tag || ''),
      noNav: Boolean(box.noNav),
      bulletOnly: Boolean(box.bulletOnly),
      playerOnly: Boolean(box.playerOnly),
    })),
  };
}

/** Capture only trusted map geometry, never render quality or player state. */
export function captureWorld(ctx) {
  if (!ctx?.physics) throw new TypeError('The original game has not loaded');
  return {
    seed: MAP_SEED,
    ...normalizeWorld({
      bounds: ctx.physics.bounds,
      groundY: 0,
      seaY: -1.6,
      quayX: 30,
      boxes: ctx.physics.boxes,
    }),
  };
}

/** Deterministic fingerprint; this detects map mismatch, not malicious tampering. */
export function fingerprintWorld(manifest) {
  const canonical = JSON.stringify(normalizeWorld(manifest));
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193);
  }
  return 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0');
}

