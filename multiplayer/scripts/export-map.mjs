#!/usr/bin/env node
/**
 * Re-export trusted collision data from the original game in real Chromium.
 * Run from multiplayer: npm run export-map
 * Verification without modifying map.json: npm run export-map -- --check
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fingerprintWorld } from '../shared/map-utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const gameRoot = resolve(scriptDir, '../..');
const target = resolve(scriptDir, '../shared/map.json');
const checkOnly = process.argv.includes('--check');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const filePath = resolve(gameRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filePath.startsWith(gameRoot + sep) || !contentTypes[extname(filePath)]) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)],
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});

let browser;
try {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  async function capture(quality) {
    console.log('Capturing collision map (' + quality + ')...');
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      // Font/network errors do not change collision geometry.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        errors.push(message.text());
      }
    });
    try {
      await page.goto(origin + '/?seed=4207&q=' + quality + '&noaudio=1', {
        waitUntil: 'domcontentloaded',
        timeout: 180_000,
      });
      await page.waitForFunction(
        () => window.__ready && window.__G?.physics?.boxes?.length > 100,
        undefined,
        { timeout: 180_000 },
      );
      const manifest = await page.evaluate(async () => {
        const { captureWorld, fingerprintWorld } = await import('/multiplayer/shared/map-utils.mjs');
        const ctx = window.__G;
        const world = captureWorld(ctx);
        const candidates = [
          ctx.level.playerStart,
          ...ctx.level.enemySpawns
            .filter(spawn => spawn.type === 'ground')
            .map(spawn => ({ pos: spawn.pos, yaw: 0 })),
        ];
        const round = value => Number(value.toFixed(6));
        const spawnPoints = [];
        for (const candidate of candidates) {
          const pos = candidate.pos.clone();
          pos.y = ctx.physics.groundHeight(pos.x, pos.z, Math.max(pos.y + 1, 1));
          const radius = 0.32;
          const height = 1.8;
          const obstructed = ctx.physics.boxes.some(box => {
            if (box.bulletOnly || box.max.y <= pos.y + 0.01 || box.min.y >= pos.y + height) {
              return false;
            }
            const nearX = Math.max(box.min.x, Math.min(box.max.x, pos.x));
            const nearZ = Math.max(box.min.z, Math.min(box.max.z, pos.z));
            return (pos.x - nearX) ** 2 + (pos.z - nearZ) ** 2 < radius ** 2;
          });
          if (
            obstructed || pos.y < 0 ||
            pos.x > 29.68 || pos.x < -39.68 || pos.z < -29.68 || pos.z > 29.68
          ) continue;
          spawnPoints.push({
            pos: { x: round(pos.x), y: round(pos.y), z: round(pos.z) },
            yaw: round(candidate.yaw || 0),
          });
        }
        if (spawnPoints.length < 2) throw new Error('Fewer than two safe player spawns');
        return {
          version: 'saltline-port-2',
          hash: fingerprintWorld(world),
          ...world,
          spawnPoints,
        };
      });
      assert.deepEqual(errors, [], quality + ' game initialization reported errors');
      return manifest;
    } finally {
      await page.close();
    }
  }

  const low = await capture('low');
  const high = await capture('high');
  assert.equal(high.hash, low.hash, 'Collision geometry changes with graphics quality');
  assert.deepEqual(high.spawnPoints, low.spawnPoints, 'Player spawns change with graphics quality');

  if (checkOnly) {
    const saved = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(saved.hash, low.hash, 'Saved map differs from the original game');
    assert.equal(fingerprintWorld(saved), saved.hash, 'Saved map fingerprint is invalid');
    assert.deepEqual(saved.spawnPoints, low.spawnPoints, 'Saved spawn points differ');
    console.log('Map verified: ' + low.hash + ', ' + low.boxes.length + ' boxes, ' + low.spawnPoints.length + ' spawns');
  } else {
    const temporary = target + '.tmp';
    await writeFile(temporary, JSON.stringify(low, null, 2) + '\n');
    await rename(temporary, target);
    console.log('Map exported: ' + low.hash + ', ' + low.boxes.length + ' boxes, ' + low.spawnPoints.length + ' spawns');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(accept => server.close(accept));
}

