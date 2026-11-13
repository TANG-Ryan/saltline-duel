#!/usr/bin/env node
/**
 * Optional end-to-end smoke test with the original WebGL game and two browsers.
 * npm run smoke-browser
 * npm run smoke-browser -- --screenshots
 * Requires: npx playwright install chromium
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createGameServer } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, '../test-artifacts/browser-smoke');
const saveScreenshots = process.argv.includes('--screenshots');
const manifest = JSON.parse(await readFile(resolve(here, '../shared/map.json'), 'utf8'));
const app = createGameServer({ manifest });
const timeout = 180_000;
const browserErrors = [];
const contexts = [];
let browser;
let host;
let friend;

async function until(predicate, message, waitMs = 10_000) {
  const expires = Date.now() + waitMs;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

function recordErrors(page, label) {
  page.on('pageerror', error => browserErrors.push(label + ': ' + error.stack));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    // External font availability does not affect the game or collision data.
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(source)) return;
    browserErrors.push(label + ': ' + message.text() + (source ? ' (' + source + ')' : ''));
  });
}

async function screenshot(page, name) {
  if (!saveScreenshots) return;
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: resolve(artifactDir, name + '.png') });
}

async function loaded(page) {
  await page.waitForFunction(() => window.__ready && window.__G?.game, undefined, { timeout });
  assert.equal(await page.evaluate(() => window.__fatal), null, 'Original game failed to initialize');
}

async function duelConnected(page) {
  await page.waitForFunction(
    () => window.__saltlineDuel?.connected && window.__saltlineDuel.roomId,
    undefined,
    { timeout },
  );
  const mapHash = await page.evaluate(() => window.__saltlineDuel.manifest.hash);
  assert.equal(mapHash, manifest.hash, 'Browser and server use different collision maps');
}

async function playing(page) {
  await page.waitForFunction(
    () => window.__saltlineDuel?.state.phase === 'playing' && window.__saltlineDuel.predicted?.alive,
    undefined,
    { timeout: 30_000 },
  );
}

try {
  const address = await app.listen(0, '127.0.0.1');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ['--enable-webgl', ...(process.env.SALTLINE_SOFTWARE_GL === '1'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  });

  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const friendContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(hostContext, friendContext);
  host = await hostContext.newPage();
  recordErrors(host, 'host');
  console.log('Browser smoke: loading the host...');
  await host.goto(origin + '/?q=low', { waitUntil: 'domcontentloaded', timeout });
  await loaded(host);
  await host.getByRole('button', { name: '双人对战', exact: true }).click({ timeout });
  await duelConnected(host);
  await screenshot(host, 'waiting');
  // Two copies of this procedural scene are expensive on software-rendered CI.
  // Suspend only the waiting host's draw calls while the friend's shaders load.
  await host.evaluate(() => {
    window.__smokeOriginalFrame = window.__G.render.frame;
    window.__G.render.frame = () => {};
  });
  const { roomId, playerId } = await host.evaluate(() => ({
    roomId: window.__saltlineDuel.roomId,
    playerId: window.__saltlineDuel.playerId,
  }));

  friend = await friendContext.newPage();
  recordErrors(friend, 'friend');
  console.log('Browser smoke: loading the invited friend...');
  const invite = new URL(origin);
  invite.searchParams.set('room', roomId);
  invite.searchParams.set('q', 'low');
  await friend.goto(invite.href, { waitUntil: 'domcontentloaded', timeout });
  await loaded(friend);
  await duelConnected(friend);
  const friendIdentity = await friend.evaluate(() => ({
    roomId: window.__saltlineDuel.roomId,
    playerId: window.__saltlineDuel.playerId,
  }));
  assert.equal(friendIdentity.roomId, roomId, 'Invite did not join the same room');
  assert.notEqual(friendIdentity.playerId, playerId, 'Contexts shared a player identity');
  await host.evaluate(() => {
    window.__G.render.frame = window.__smokeOriginalFrame;
    delete window.__smokeOriginalFrame;
  });
  console.log('Browser smoke: both players joined; starting the match...');

  await host.locator('#sl-duel [data-act="ready"]').click();
  await friend.locator('#sl-duel [data-act="ready"]').click();
  await Promise.all([playing(host), playing(friend)]);
  assert.equal(app.state(app.rooms.get(roomId)).players.length, 2);

  // Foreground the player receiving keyboard/mouse events. A blur may have
  // opened the legitimate in-game menu while the other context was prepared.
  await host.bringToFront();
  if (await host.evaluate(() => window.__saltlineDuel.menuOpen)) {
    await host.locator('#sl-duel [data-act="resume"]').click();
  }
  await host.waitForFunction(() => window.__saltlineDuel.canPlay(), undefined, { timeout: 10_000 });
  const before = await host.evaluate(() => {
    const duel = window.__saltlineDuel;
    return { ...duel.state.players.find(player => player.id === duel.playerId).pos };
  });
  await host.keyboard.down('w');
  await delay(450);
  await host.keyboard.up('w');
  await host.waitForFunction(
    ({ playerId, before }) => {
      const player = window.__saltlineDuel.state.players.find(value => value.id === playerId);
      return player && Math.hypot(player.pos.x - before.x, player.pos.z - before.z) > 0.05;
    },
    { playerId, before },
    { timeout: 10_000 },
  );
  await friend.waitForFunction(
    ({ playerId, before }) => {
      const player = window.__saltlineDuel.state.players.find(value => value.id === playerId);
      return player && Math.hypot(player.pos.x - before.x, player.pos.z - before.z) > 0.05;
    },
    { playerId, before },
    { timeout: 10_000 },
  );
  await friend.bringToFront();
  await friend.waitForFunction(
    () => {
      const duel = window.__saltlineDuel;
      const remote = duel.state.players.find(player => player.id !== duel.playerId);
      const mesh = duel.avatar.root;
      return remote && mesh.visible &&
        Math.hypot(mesh.position.x - remote.pos.x, mesh.position.z - remote.pos.z) < 0.5;
    },
    undefined,
    { timeout: 10_000 },
  );
  await screenshot(host, 'playing-host');
  await screenshot(friend, 'playing-friend');
  console.log('Browser smoke: checking held-fire cancellation...');

  // Keep the real mouse button held while opening the existing menu adapter.
  // Calling openMenu avoids headless Chromium's special handling of Escape
  // while pointer lock is active, while still testing the real neutral message.
  await host.bringToFront();
  if (await host.evaluate(() => window.__saltlineDuel.menuOpen)) {
    await host.locator('#sl-duel [data-act="resume"]').click();
  }
  await host.waitForFunction(() => window.__saltlineDuel.canPlay(), undefined, { timeout: 10_000 });
  await host.mouse.move(640, 360);
  await host.mouse.down({ button: 'left' });
  await host.waitForFunction(() => window.__saltlineDuel.ctx.input.fire, undefined, { timeout: 10_000 });
  const room = app.rooms.get(roomId);
  const slot = room.slots.get(playerId);
  await until(() => slot.input.fire === true, 'Server did not receive held fire');
  await host.evaluate(() => window.__saltlineDuel.openMenu());
  await host.waitForFunction(() => {
    const duel = window.__saltlineDuel;
    return duel.menuOpen && !duel.ctx.input.fire &&
      duel.ctx.input.move.x === 0 && duel.ctx.input.move.y === 0;
  }, undefined, { timeout: 10_000 });
  await until(
    () => slot.input.fire === false && slot.pendingInputs.length === 0 && slot.lastInputAt === -Infinity,
    'Opening the menu did not neutralize authoritative input',
  );
  assert.equal(app.state(room).phase, 'playing', 'One player opening a menu paused the entire match');
  await host.mouse.up({ button: 'left' });

  // Release the two heavy WebGL scenes before loading the solo regression page.
  await hostContext.close();
  await friendContext.close();
  const soloContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(soloContext);
  const solo = await soloContext.newPage();
  recordErrors(solo, 'solo');
  console.log('Browser smoke: checking the original solo entry...');
  await solo.goto(origin + '/?q=low', { waitUntil: 'domcontentloaded', timeout });
  await loaded(solo);
  const soloState = await solo.evaluate(() => ({
    state: window.__G.game.state,
    duelStarted: Boolean(window.__saltlineDuel),
  }));
  assert.deepEqual(soloState, { state: 'title', duelStarted: false }, 'Solo entry no longer opens the original title');
  await screenshot(solo, 'solo');
  assert.deepEqual(browserErrors, [], 'Unexpected browser errors');
  console.log('Browser smoke passed: original WebGL map, private invite, two players ready, movement, remote avatar, neutral fire, and solo title.');
  if (saveScreenshots) console.log('Screenshots: ' + artifactDir);
} catch (error) {
  for (const page of [host, friend]) {
    if (page && !page.isClosed()) {
      try {
        console.error('Browser state:', await page.evaluate(() => ({
          fatal: window.__fatal,
          ready: window.__ready,
          duel: window.__saltlineDuel && {
            connected: window.__saltlineDuel.connected,
            phase: window.__saltlineDuel.state.phase,
            menuOpen: window.__saltlineDuel.menuOpen,
            notice: window.__saltlineDuel.ui.elements.notice.textContent,
          },
        })));
      } catch {}
    }
  }
  if (browserErrors.length) console.error('Browser errors:', browserErrors);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const context of contexts) {
    try { await context.close(); } catch {}
  }
  if (browser) await browser.close();
  await app.close();
}

