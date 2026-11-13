import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../loader.js', import.meta.url), 'utf8');

function setup(search = '', protocol = 'http:') {
  const elements = new Map();
  let bootDone = false, callback, normalizedURL;
  const actions = {
    children: [],
    insertBefore(button) { this.children.push(button); elements.set(button.id, button); },
  };
  const document = {
    currentScript: { src: 'http://localhost/multiplayer/loader.js' },
    body: { appendChild(el) { elements.set(el.id, el); } },
    getElementById(id) {
      if (id === 'boot') return { hidden: false, classList: { contains: () => bootDone } };
      return elements.get(id) || null;
    },
    querySelector() { return actions; },
    createElement() {
      return { style: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    },
  };
  const window = { __ready: false, __G: { game: {}, player: {}, weapon: {}, params: {} } };
  vm.runInNewContext(source, {
    URL, URLSearchParams, window, document,
    location: { search, protocol, pathname: '/', href: 'http://localhost/' + search },
    history: { replaceState(_, __, url) { normalizedURL = url; } },
    setInterval(fn) { callback = fn; return 1; }, clearInterval() {},
  });
  return {
    window, elements, actions, tick: () => callback(),
    bootComplete: () => { bootDone = true; },
    normalizedURL: () => normalizedURL,
  };
}

test('the multiplayer entry waits for boot but does not require foreground animation frames', () => {
  const env = setup();
  env.tick();
  assert.equal(env.actions.children.length, 0);
  env.bootComplete();
  env.tick();
  assert.equal(env.window.__ready, false);
  assert.equal(env.elements.get('saltline-duel-button').textContent, '双人对战');
  env.tick();
  assert.equal(env.actions.children.length, 1);
});

test('invite links force the shared seed and discard frame/debug overrides', () => {
  const env = setup('?room=friend&seed=7&show=weapon&step=1&dt=5&noweapon=1');
  const query = new URL(env.normalizedURL(), 'http://localhost').searchParams;
  assert.equal(query.get('room'), 'friend');
  assert.equal(query.get('seed'), '4207');
  for (const key of ['show', 'step', 'dt', 'noweapon']) assert.equal(query.has(key), false);
});

test('opening the original HTML directly gives a usable server-start explanation', async () => {
  const env = setup('', 'file:');
  env.bootComplete();
  env.tick();
  await env.elements.get('saltline-duel-button').listeners.click();
  assert.match(env.elements.get('saltline-duel-error').textContent, /联机需要通过服务器打开/);
});
