/* Saltline multiplayer entry. The original single-player bundle stays intact. */
(() => {
  'use strict';
  if (window.__saltlineDuelLoader) return;
  window.__saltlineDuelLoader = true;
  const assetBase = new URL('.', document.currentScript.src);
  const query = new URLSearchParams(location.search);
  const invited = query.get('room');
  const autoOpen = invited || query.get('multiplayer') === '1';
  if (autoOpen) {
    query.set('seed', '4207');
    for (const key of ['show', 'shot', 'autostart', 'bench', 'cam', 'step', 'dt', 'noweapon']) query.delete(key);
    history.replaceState(null, '', location.pathname + '?' + query.toString());
  }
  let opening = false;
  let started = false;
  let autoAttempted = false;
  const showError = (message) => {
    let el = document.getElementById('saltline-duel-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'saltline-duel-error';
      el.style.cssText = 'position:fixed;left:5%;right:5%;bottom:18%;z-index:90;padding:16px;background:#14181b;color:#ffb347;border:1px solid #ffb347;font:15px/1.5 system-ui;pointer-events:auto';
      document.body.appendChild(el);
    }
    el.textContent = message;
  };
  async function open() {
    if (opening || started) return;
    if (location.protocol === 'file:') {
      showError('联机需要通过服务器打开。请在 multiplayer 目录运行 npm install 和 npm start，再打开 http://127.0.0.1:8787。');
      return;
    }
    if (window.__G.params.seed && +window.__G.params.seed !== 4207 || window.__G.showcase || window.__G.params.step || window.__G.params.dt) {
      const url = new URL(location.href);
      url.search = '?multiplayer=1&seed=4207';
      location.assign(url.href);
      return;
    }
    opening = true;
    const button = document.getElementById('saltline-duel-button');
    if (button) button.textContent = '正在连接联机服务…';
    try {
      const authored = query.get('soldier');
      if (authored === 'glb' || authored === 'gltf') {
        const { prepareSoldierGLTF } = await import(new URL('soldier-gltf.mjs', assetBase).href);
        await prepareSoldierGLTF(window.__G, new URL('assets/custom-soldier.' + authored, assetBase).href);
      }
      const module = await import(new URL('client.mjs', assetBase).href);
      await module.startMultiplayer(window.__G, { roomId: invited });
      started = true;
    } catch (error) {
      showError('联机未能启动：' + (error.message || String(error)));
      if (button) button.textContent = '双人对战';
    } finally {
      opening = false;
    }
  }
  const timer = setInterval(() => {
    const ctx = window.__G;
    if (!ctx || !ctx.game || !ctx.player || !ctx.weapon) return;
    const boot = document.getElementById('boot');
    if (boot && !boot.hidden && !boot.classList.contains('done')) return;
    const actions = document.querySelector('.m-title .m-actions');
    if (actions && !document.getElementById('saltline-duel-button')) {
      const button = document.createElement('button');
      button.id = 'saltline-duel-button';
      button.className = 'btn';
      button.textContent = '双人对战';
      button.addEventListener('click', open);
      actions.insertBefore(button, actions.children[1] || null);
    }
    if (autoOpen && !autoAttempted && !opening && !started) { autoAttempted = true; open(); }
    if (actions && (!autoOpen || started || autoAttempted && !opening)) clearInterval(timer);
  }, 100);
})();

