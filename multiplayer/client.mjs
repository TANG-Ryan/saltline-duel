import { RULES, createWorld, simulatePlayer, raycastWorld, tracePlayerHit } from './shared/simulation.mjs';
import { captureWorld, fingerprintWorld } from './shared/map-utils.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const credentialKey = roomId => 'saltline.duel.' + roomId;
const roomReason = code => ({
  'disconnect-timeout': '重连超时，本局已结束，请重新创建房间。',
  'player-left': '有玩家退出，本局已结束，请重新创建房间。',
  'room-expired': '房间长时间未开始或未重赛，已关闭，请重新创建。',
  'server-restart': '联机服务已重启，请重新创建房间。'
})[code] || '房间已结束，请重新创建。';
const finite = value => Number.isFinite(value) ? value : 0;
const css = [
'body.sl-duel .menu,body.sl-duel .h-obj,body.sl-duel .h-marks,body.sl-duel .comms,body.sl-duel .h-compass,body.sl-duel .h-ammo{display:none!important}',
'#sl-duel{position:fixed;inset:0;z-index:65;pointer-events:none;color:#e8e4da;font:15px/1.5 "IBM Plex Mono",system-ui;text-shadow:0 1px 3px #000}',
'#sl-duel *{box-sizing:border-box}#sl-duel button,#sl-duel input{font:inherit}#sl-duel button{cursor:pointer;color:#e8e4da;border:1px solid #777;background:#14181b;padding:11px 16px;min-height:44px}#sl-duel button.primary{background:#ffb347;color:#0b0d0f;border-color:#ffb347}#sl-duel button:disabled{opacity:.4;cursor:default}',
'#sl-duel .sl-score{position:absolute;top:max(14px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:#0b0d0fe6;border-top:2px solid #ffb347;padding:8px 24px;text-align:center;min-width:230px}#sl-duel .sl-score b{font-size:27px;letter-spacing:4px}#sl-duel .sl-score small{display:block;color:#ffb347;font-size:11px}',
'#sl-duel .sl-panel{pointer-events:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(530px,calc(100vw - 32px));max-height:calc(100dvh - 130px);overflow:auto;background:#0b0d0ff2;border:1px solid #58626a;border-top:3px solid #ffb347;padding:24px}#sl-duel h2{margin:4px 0 12px;font:700 34px/1.1 "Barlow Condensed",system-ui}#sl-duel p{margin:10px 0;color:#bbc1c4}#sl-duel .sl-kicker{color:#ffb347;letter-spacing:.16em;font-size:12px}#sl-duel .sl-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}',
'#sl-duel .sl-invite{display:flex;gap:6px;margin-top:14px}#sl-duel input{min-width:0;width:100%;color:#e8e4da;background:#14181b;border:1px solid #58626a;padding:10px;user-select:text}#sl-duel .sl-notice{color:#ffb347;font-size:12px;min-height:20px}',
'#sl-duel .sl-count{position:absolute;left:50%;top:39%;transform:translate(-50%,-50%);text-align:center;font-size:28px;background:#0b0d0fc9;padding:10px 22px;border-top:2px solid #ffb347}#sl-duel .sl-bottom{position:absolute;bottom:max(14px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);text-align:center;font-size:11px;color:#bbc1c4;background:#0b0d0f99;padding:5px 10px;white-space:nowrap}',
'#sl-duel .sl-ammo{position:absolute;right:max(20px,env(safe-area-inset-right));bottom:max(30px,env(safe-area-inset-bottom));font-size:36px}#sl-duel .sl-ammo small{font-size:13px;color:#bbc1c4}#sl-duel.sl-touch .sl-ammo{bottom:auto;top:95px}#sl-duel .sl-feed{position:absolute;right:20px;top:30%;text-align:right;font-size:13px;color:#ffb347;max-width:60vw}#sl-duel .sl-feed div{margin:6px 0;background:#0b0d0fa8;padding:3px 8px}',
'body.sl-duel.sl-duel-settings .menu{display:block!important;pointer-events:auto}body.sl-duel.sl-duel-settings .menu>.m-screen,body.sl-duel.sl-duel-settings .menu>.m-veil,body.sl-duel.sl-duel-settings .menu>.m-bars,body.sl-duel.sl-duel-settings .menu>.loc-card{display:none!important}body.sl-duel.sl-duel-settings .menu .panel{pointer-events:auto}',
'#sl-duel [hidden]{display:none!important}@media(max-width:600px){#sl-duel .sl-panel{padding:18px}#sl-duel .sl-score{min-width:190px;padding:6px 12px}#sl-duel .sl-score b{font-size:23px}#sl-duel .sl-bottom{white-space:normal;width:70%}}'
].join('\n');

function createUI() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'sl-duel';
  root.innerHTML = [
    '<div class="sl-score"><b data-el="score">0 : 0</b><small data-el="status">SALTLINE · 好友对战 · 10 杀获胜</small></div>',
    '<section class="sl-panel" data-el="panel" role="dialog" aria-label="好友对战房间">',
    '<div class="sl-kicker">SALTLINE / 好友对战</div><h2 data-el="title">正在连接</h2>',
    '<p data-el="description">正在启动联机服务，免费服务首次启动可能需要约一分钟。</p>',
    '<div class="sl-invite" data-el="invite"><input data-el="link" readonly aria-label="房间邀请链接"><button data-act="copy">复制链接</button></div>',
    '<p class="sl-notice" data-el="notice" aria-live="polite"></p><div class="sl-actions">',
    '<button class="primary" data-act="ready" hidden>准备就绪</button>',
    '<button class="primary" data-act="resume" hidden>返回对战</button>',
    '<button class="primary" data-act="rematch" hidden>再来一局</button>',
    '<button data-act="settings">设置与操作</button>',
    '<button data-act="leave">退出房间</button></div></section>',
    '<div class="sl-count" data-el="count" hidden></div>',
    '<div class="sl-ammo" data-el="ammo">30 <small>/ ∞</small></div>',
    '<div class="sl-feed" data-el="feed" aria-live="polite"></div>',
    '<div class="sl-bottom">先击杀 10 次获胜 · Esc 打开菜单（对战继续）</div>'
  ].join('');
  document.body.appendChild(root);
  const elements = {};
  root.querySelectorAll('[data-el]').forEach(el => { elements[el.dataset.el] = el; });
  root.querySelectorAll('[data-act]').forEach(el => { elements[el.dataset.act] = el; });
  return { root, elements };
}

function createAvatar(ctx) {
  const T = ctx.THREE;
  const root = new T.Group();
  const body = new T.Group();
  root.add(body);
  const cloth = new T.MeshStandardMaterial({ color: 0x435b62, roughness: 0.85 });
  const armor = new T.MeshStandardMaterial({ color: 0x18262c, roughness: 0.55, metalness: 0.3 });
  const stripe = new T.MeshStandardMaterial({ color: 0xffb347, roughness: 0.5 });
  const gunMat = new T.MeshStandardMaterial({ color: 0x11181b, roughness: 0.45, metalness: 0.65 });
  const add = (geometry, material, x, y, z, parent = body) => {
    const mesh = new T.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  add(new T.BoxGeometry(0.47, 0.65, 0.27), cloth, 0, 1.13, 0);
  add(new T.BoxGeometry(0.49, 0.41, 0.12), armor, 0, 1.18, -0.15);
  add(new T.BoxGeometry(0.28, 0.06, 0.02), stripe, 0, 1.29, -0.22);
  add(new T.SphereGeometry(0.16, 12, 8), armor, 0, 1.61, 0);
  add(new T.BoxGeometry(0.25, 0.07, 0.05), stripe, 0, 1.63, -0.145);
  const leftLeg = new T.Group(), rightLeg = new T.Group();
  leftLeg.position.set(-0.13, 0.77, 0); rightLeg.position.set(0.13, 0.77, 0);
  body.add(leftLeg, rightLeg);
  add(new T.BoxGeometry(0.17, 0.65, 0.19), cloth, 0, -0.32, 0, leftLeg);
  add(new T.BoxGeometry(0.17, 0.65, 0.19), cloth, 0, -0.32, 0, rightLeg);
  add(new T.BoxGeometry(0.19, 0.13, 0.3), armor, 0, -0.7, -0.04, leftLeg);
  add(new T.BoxGeometry(0.19, 0.13, 0.3), armor, 0, -0.7, -0.04, rightLeg);
  const arms = new T.Group();
  arms.position.set(0, 1.26, -0.05);
  body.add(arms);
  add(new T.BoxGeometry(0.14, 0.14, 0.45), cloth, -0.25, -0.06, -0.15, arms);
  add(new T.BoxGeometry(0.14, 0.14, 0.4), cloth, 0.23, -0.07, -0.15, arms);
  add(new T.BoxGeometry(0.08, 0.13, 0.54), gunMat, 0.1, -0.07, -0.39, arms);
  const flash = add(new T.SphereGeometry(0.075, 8, 6), new T.MeshBasicMaterial({ color: 0xffd28a }), 0.1, -0.07, -0.7, arms);
  flash.visible = false;
  const shield = new T.Mesh(new T.CapsuleGeometry(0.4, 1.05, 4, 8), new T.MeshBasicMaterial({ color: 0xffb347, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false }));
  shield.position.y = 0.92;
  body.add(shield);
  ctx.scene.add(root);
  let flashUntil = 0;
  return {
    root,
    shoot() { flashUntil = performance.now() + 55; },
    update(p, clock) {
      root.visible = !!p && p.alive;
      if (!p) return;
      root.position.set(p.pos.x, p.pos.y, p.pos.z);
      root.rotation.y = p.yaw;
      body.scale.y = p.crouching ? 1.15 / 1.8 : 1;
      const speed = Math.hypot(p.vel.x, p.vel.z);
      leftLeg.rotation.x = Math.sin(clock * 10) * Math.min(0.55, speed * 0.09);
      rightLeg.rotation.x = -leftLeg.rotation.x;
      arms.rotation.x = p.pitch;
      flash.visible = clock * 1000 < flashUntil;
      shield.visible = p.invulnerableFor > 0;
    },
    dispose() {
      root.removeFromParent();
      root.traverse(mesh => {
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
      });
    }
  };
}

class DuelClient {
  constructor(ctx, manifest, roomId, credentials) {
    this.ctx = ctx;
    this.isLocalOnly = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(new URL(location.href).hostname);
    this.manifest = manifest;
    this.world = createWorld(manifest);
    this.roomId = roomId;
    this.credentials = credentials;
    this.playerId = credentials && credentials.playerId;
    this.state = { phase: 'connecting', players: [], countdown: 0 };
    this.predicted = null;
    this.pending = [];
    this.remoteHistory = [];
    this.seq = 0;
    this.accumulator = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.menuOpen = false;
    this.settingsOpen = false;
    this.jumpQueued = false;
    this.reloadQueued = false;
    this.soloMenus = ctx.game.menus;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0;
    this.seenEvents = new Set();
    this.feed = [];
    this.lastShot = null;
    this.lastShotAt = -1;
    this.cosmetic = { pitch: 0, yaw: 0, shake: 0, hurt: 0 };
    this.ui = createUI();
    this.avatar = createAvatar(ctx);
    this.installEngineAdapter();
    this.installControls();
    this.updateUI();
  }

  installEngineAdapter() {
    const ctx = this.ctx;
    // Enter/leave the old controller once so its private state is paused, not title.
    // Its global Enter listener therefore cannot accidentally start a solo mission.
    ctx.game.start({ skipIntro: true });
    ctx.game.pause();
    ctx.enemies.clear();
    ctx.enemies.update = () => {};
    if (ctx.explosives) ctx.explosives.update = () => {};
    ctx.hud.reset();
    ctx.hud.clearRadio();
    ctx.hud.setMarkers([]);
    ctx.hud.setPrompt(null);
    ctx.hud.setObjective('');
    document.body.classList.add('sl-duel');
    if (ctx.input.touch) this.ui.root.classList.add('sl-touch');
    const T = ctx.THREE;
    const oldPlayer = ctx.player;
    const player = {
      pos: new T.Vector3(), vel: new T.Vector3(), eye: new T.Vector3(),
      forward: new T.Vector3(0, 0, -1), lastSafe: new T.Vector3(),
      yaw: 0, pitch: 0, health: 100, maxHealth: 100, alive: true, onGround: true,
      sprinting: false, crouching: false, ads: 0, speed: 0, enabled: false,
      invulnerable: false, baseFov: oldPlayer.baseFov || 74, hurtPulse: 0,
      lookScale: 1, tuning: oldPlayer.tuning,
      reset() {}, damage() {}, heal() {},
      addRecoil: (pitch = 0, yaw = 0) => {
        this.cosmetic.pitch = clamp(this.cosmetic.pitch + pitch * 0.4, -0.12, 0.12);
        this.cosmetic.yaw = clamp(this.cosmetic.yaw + yaw * 0.4, -0.06, 0.06);
      },
      addShake: amount => { this.cosmetic.shake = Math.min(1, this.cosmetic.shake + amount); },
      setFov: fov => { player.baseFov = clamp(+fov || 74, 55, 100); },
      update: dt => this.renderPlayer(dt)
    };
    player.pos.copy(oldPlayer.pos);
    player.eye.copy(oldPlayer.eye);
    ctx.player = player;
    ctx.combat = {
      stats: { shots: 0, hits: 0, kills: 0 },
      reset() {}, enemyShot() { return false; }, explode() {},
      playerShot: () => {
        const shot = this.lastShot;
        if (!shot || performance.now() - this.lastShotAt > 160) return null;
        const other = this.otherPlayer();
        const hit = other && tracePlayerHit(this.world, shot, other);
        if (hit) return { ...hit, surface: 'enemy' };
        const mapHit = raycastWorld(this.world, shot.origin, shot.dir, RULES.range);
        if (!mapHit) return null;
        return mapHit;
      }
    };
    const visualUpdate = ctx.weapon.update.bind(ctx.weapon);
    ctx.weapon.update = dt => {
      const active = this.canPlay();
      const savedFire = ctx.input.fire;
      const savedPressed = ctx.input.pressed;
      if (savedPressed) ctx.input.pressed = action =>
        ['swap', 'weapon1', 'weapon2'].includes(action) ? false : savedPressed.call(ctx.input, action);
      ctx.input.fire = active && savedFire;
      // The existing weapon only predicts animation/sound. All gameplay state is
      // computed by the shared simulation and ultimately accepted by the server.
      ctx.weapon.reserve = 1000000;
      const visualState = ctx.weapon.debug && ctx.weapon.debug.S;
      if (visualState && this.predicted) {
        const remaining = this.predicted.reloadRemaining;
        if (remaining > 0) {
          if (!visualState.reload && ctx.weapon.reloadNow) {
            ctx.weapon.ammo = this.predicted.ammo;
            ctx.weapon.reloadNow();
          }
          if (visualState.reload) {
            const reload = visualState.reload;
            reload.T = reload.empty ? RULES.reloadEmpty : RULES.reloadTactical;
            reload.t = Math.max(0, reload.T - remaining - dt);
            reload.fresh = false;
          }
        } else if (visualState.reload) {
          // Let the original rig finish its visual state on this frame.
          visualState.reload.t = visualState.reload.T;
          visualState.reload.fresh = false;
        }
      }
      try { visualUpdate(dt); } finally {
        ctx.input.fire = savedFire;
        ctx.input.pressed = savedPressed;
        if (this.predicted) ctx.weapon.ammo = this.predicted.ammo;
      }
    };
    ctx.game = {
      state: 'multiplayer', start() {}, pause: () => this.openMenu(),
      resume: () => this.closeMenu(), update: dt => this.frame(dt)
    };
    if (ctx.render.post) {
      ctx.render.post.fade = 0;
      ctx.render.post.saturation = 1;
    }
    ctx.hud.show(true);
    if (ctx.weapon.equip) ctx.weapon.equip('rifle');
    ctx.weapon.setVisible(true);
    if (ctx.audio.setPaused) ctx.audio.setPaused(false);
    if (ctx.audio.setIntensity) ctx.audio.setIntensity(0.3);
    this.setGameplay(false);
  }

  installControls() {
    const el = this.ui.elements;
    el.copy.onclick = async () => {
      if (this.isLocalOnly) return;
      try {
        await navigator.clipboard.writeText(el.link.value);
        el.notice.textContent = '邀请链接已复制，发给朋友即可加入。';
      } catch {
        el.link.focus(); el.link.select();
        el.notice.textContent = '请复制已选中的邀请链接。';
      }
    };
    el.ready.onclick = () => {
      const me = this.localServerPlayer();
      this.send({ type: 'ready', ready: !(me && me.ready) });
      this.resumeAudioAndLock();
    };
    el.rematch.onclick = () => { this.send({ type: 'rematch' }); this.resumeAudioAndLock(); };
    el.settings.onclick = () => this.openSettings();
    el.resume.onclick = () => this.closeMenu();
    el.leave.onclick = () => this.leave();
    this.ctx.events.on('input:lock', event => {
      if (event.locked) { this.hadLock = true; return; }
      if (this.hadLock && this.canPlay()) this.openMenu();
      this.hadLock = false;
    });
    addEventListener('blur', () => this.openMenu());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.openMenu();
    });
    addEventListener('pagehide', () => {
      // A page refresh must be reconnectable. Do not send a permanent leave here.
      this.neutral();
    });
  }

  resumeAudioAndLock() {
    try { this.ctx.audio.resume(); } catch {}
    try { this.ctx.input.requestLock(); } catch {}
  }

  setGameplay(enabled) {
    if (this.gameplayEnabled === enabled) return;
    this.gameplayEnabled = enabled;
    if (this.ctx.input.setGameplay) this.ctx.input.setGameplay(enabled);
    this.ctx.player.enabled = enabled;
  }

  neutral() {
    this.send({ type: 'neutral' });
    this.pending.length = 0;
    this.jumpQueued = this.reloadQueued = false;
    this.accumulator = 0;
    const input = this.ctx.input;
    input.fire = input.ads = input.sprint = false;
    if (input.move) input.move.x = input.move.y = 0;
    this.setGameplay(false);
  }

  openMenu() {
    if (!this.predicted || this.state.phase !== 'playing') return;
    this.menuOpen = true;
    this.neutral();
    this.ctx.input.exitLock();
    this.updateUI();
  }

  openSettings() {
    this.menuOpen = this.state.phase === 'playing' || this.menuOpen;
    this.neutral();
    this.ctx.input.exitLock();
    if (!this.soloMenus) return;
    this.settingsOpen = true;
    document.body.classList.add('sl-duel-settings');
    this.ui.root.appendChild(this.soloMenus.root);
    const button = this.soloMenus.root.querySelector('[data-act="settings"]');
    if (button) button.click();
    this.updateUI();
  }

  closeMenu() {
    this.menuOpen = false;
    this.resumeAudioAndLock();
    this.setGameplay(this.canPlay());
    this.updateUI();
  }

  localServerPlayer() { return this.state.players.find(p => p.id === this.playerId); }
  otherPlayer() { return this.state.players.find(p => p.id !== this.playerId); }
  canPlay() {
    return this.connected && this.state.phase === 'playing' && !this.menuOpen && !this.settingsOpen &&
      !document.hidden && !!this.predicted && this.predicted.alive;
  }

  connect() {
    if (this.stopped) return;
    const url = new URL('/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.send({
        type: 'join', roomId: this.roomId,
        ...(this.credentials || {}),
        version: this.manifest.version, mapHash: this.manifest.hash
      });
    };
    socket.onmessage = message => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data.type === 'joined') {
        this.connected = true;
        this.playerId = data.playerId;
        this.credentials = { playerId: data.playerId, reconnectToken: data.reconnectToken };
        try { sessionStorage.setItem(credentialKey(this.roomId), JSON.stringify(this.credentials)); } catch {}
        if (data.state) this.receiveSnapshot(data.state);
      } else if (data.type === 'snapshot') {
        this.receiveSnapshot(data.state);
      } else if (data.type === 'event') {
        this.receiveEvent(data.event);
      } else if (data.type === 'error') {
        this.fail(data.message || '连接房间失败。');
      }
    };
    socket.onerror = () => {}; // close controls bounded reconnect attempts.
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.connected = false;
      this.neutral();
      this.updateUI();
      this.attempt++;
      if (this.attempt > 12) {
        this.fail('联机服务暂不可用，请退出后重新创建房间。');
        return;
      }
      const delay = Math.min(8000, 500 * 2 ** Math.min(4, this.attempt - 1));
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  receiveSnapshot(state) {
    if (!state || !Array.isArray(state.players)) return;
    const previousPhase = this.state.phase;
    const previousLife = this.predicted && this.predicted.lifeId;
    const previousAlive = this.predicted && this.predicted.alive;
    this.state = state;
    const me = this.localServerPlayer();
    if (me) {
      this.seq = Math.max(this.seq, me.ackSeq || 0);
      const lifeChanged = previousLife !== me.lifeId;
      if (lifeChanged || state.phase !== 'playing' || !me.alive) {
        this.pending.length = 0;
        this.predicted = clone(me);
        if (lifeChanged) {
          this.aimYaw = me.yaw;
          this.aimPitch = me.pitch;
          this.cosmetic.pitch = this.cosmetic.yaw = 0;
          this.ctx.weapon.reset();
          if (this.ctx.weapon.equip) this.ctx.weapon.equip('rifle');
        }
      } else {
        this.pending = this.pending.filter(input => input.seq > (me.ackSeq || 0) && input.lifeId === me.lifeId);
        this.predicted = clone(me);
        for (const input of this.pending) {
          simulatePlayer(this.predicted, input, RULES.step, this.world, { authority: false, allowAttack: true });
        }
      }
      if (previousAlive && !me.alive || previousPhase === 'playing' && state.phase !== 'playing') this.neutral();
      this.ctx.weapon.ammo = this.predicted.ammo;
    }
    const other = this.otherPlayer();
    if (other) {
      this.remoteHistory.push({ time: performance.now(), player: clone(other) });
      if (this.remoteHistory.length > 12) this.remoteHistory.shift();
    }
    if (state.phase === 'ended') {
      this.stopped = true;
      clearTimeout(this.retryTimer);
    }
    this.setGameplay(this.canPlay());
    this.updateUI();
  }

  receiveEvent(event) {
    if (!event || this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 2048) this.seenEvents.delete(this.seenEvents.values().next().value);
    const ctx = this.ctx;
    if (event.type === 'shot' && event.shooterId !== this.playerId) {
      this.avatar.shoot();
      const start = new ctx.THREE.Vector3(event.origin.x, event.origin.y, event.origin.z);
      const hit = raycastWorld(this.world, event.origin, event.dir, RULES.range);
      const end = hit ? new ctx.THREE.Vector3(hit.point.x, hit.point.y, hit.point.z) :
        start.clone().addScaledVector(new ctx.THREE.Vector3(event.dir.x, event.dir.y, event.dir.z), RULES.range);
      if (ctx.fx.tracer) ctx.fx.tracer(start, end);
      // Reuse spatial audio without feeding an opponent shot into the local gun.
      ctx.events.emit('weapon:fire', { origin: start, muzzle: start, dir: new ctx.THREE.Vector3(event.dir.x, event.dir.y, event.dir.z), remote: true });
    } else if (event.type === 'hit') {
      if (event.shooterId === this.playerId && ctx.hud.hitmarker) ctx.hud.hitmarker('hit');
      if (event.targetId === this.playerId) {
        this.cosmetic.hurt = 1;
        if (event.origin) ctx.events.emit('player:hit', { amount: event.amount, fromPos: new ctx.THREE.Vector3(event.origin.x, event.origin.y, event.origin.z) });
      }
    } else if (event.type === 'kill') {
      const text = event.shooterId ? (event.shooterId === this.playerId ? '你击败了朋友' : '朋友击败了你') : '意外死亡，不计击杀分';
      this.feed.unshift({ text, until: performance.now() + 4500 });
      if (event.shooterId === this.playerId && ctx.hud.hitmarker) ctx.hud.hitmarker('kill');
    } else if (event.type === 'respawn' && event.playerId === this.playerId) {
      this.ctx.weapon.reset();
      if (this.ctx.weapon.equip) this.ctx.weapon.equip('rifle');
    } else if (event.type === 'ended') {
      this.state.phase = 'ended';
      this.state.reason = event.reason;
      this.stopped = true;
      this.neutral();
    }
    this.updateUI();
  }

  frame(dt) {
    if (this.settingsOpen && !this.soloMenus.panelOpen) {
      this.settingsOpen = false;
      document.body.classList.remove('sl-duel-settings');
    }
    if (this.ctx.input.pressed && this.ctx.input.pressed('pause')) {
      if (this.menuOpen) this.closeMenu(); else this.openMenu();
    }
    const active = this.canPlay();
    this.setGameplay(active);
    if (active) {
      const input = this.ctx.input;
      const lookScale = 1 - (this.predicted.ads || 0) * 0.4;
      this.aimYaw -= finite(input.look.dx) * lookScale;
      this.aimPitch = clamp(this.aimPitch - finite(input.look.dy) * lookScale, -1.5, 1.5);
      this.accumulator = Math.min(this.accumulator + dt, 0.1);
      this.jumpQueued ||= !!(input.pressed && input.pressed('jump'));
      this.reloadQueued ||= !!(input.pressed && input.pressed('reload'));
      while (this.accumulator >= RULES.step) {
        this.accumulator -= RULES.step;
        const command = {
          seq: ++this.seq, lifeId: this.predicted.lifeId,
          moveX: finite(input.move.x), moveY: finite(input.move.y),
          yaw: this.aimYaw, pitch: this.aimPitch, fire: !!input.fire,
          ads: !!input.ads, sprint: !!input.sprint, crouch: !!input.crouch,
          jump: this.jumpQueued, reload: this.reloadQueued
        };
        this.jumpQueued = this.reloadQueued = false;
        const output = simulatePlayer(this.predicted, command, RULES.step, this.world, { authority: false, allowAttack: true });
        this.pending.push(command);
        if (this.pending.length > 180) {
          this.openMenu();
          this.ui.elements.notice.textContent = '连接延迟较高，已停止本地操作，等待服务器同步。';
          break;
        }
        for (const shot of output.shots) {
          this.lastShot = shot;
          this.lastShotAt = performance.now();
        }
        this.send({ type: 'input', input: command });
      }
    } else {
      this.accumulator = 0;
    }
    const now = performance.now();
    this.feed = this.feed.filter(item => item.until > now);
    const entries = this.ui.elements.feed.children;
    if (entries.length !== this.feed.length || this.lastFeed !== this.feed.map(f => f.text).join('|')) {
      this.ui.elements.feed.replaceChildren(...this.feed.slice(0, 4).map(item => {
        const el = document.createElement('div'); el.textContent = item.text; return el;
      }));
      this.lastFeed = this.feed.map(f => f.text).join('|');
    }
    this.renderRemote(now);
    this.updateUI();
    return true;
  }

  renderPlayer(dt) {
    const p = this.predicted;
    if (!p) return;
    const ctx = this.ctx, player = ctx.player, camera = ctx.camera;
    player.pos.set(p.pos.x, p.pos.y, p.pos.z);
    player.vel.set(p.vel.x, p.vel.y, p.vel.z);
    player.lastSafe.set(p.lastSafe.x, p.lastSafe.y, p.lastSafe.z);
    player.yaw = p.yaw;
    player.pitch = p.pitch;
    player.health = p.health;
    player.alive = p.alive;
    player.onGround = p.onGround;
    player.crouching = p.crouching;
    player.sprinting = p.sprinting;
    player.ads = p.ads || 0;
    player.lookScale = 1 - player.ads * 0.4;
    player.speed = Math.hypot(p.vel.x, p.vel.z);
    player.invulnerable = p.invulnerableFor > 0;
    this.cosmetic.pitch *= Math.exp(-7 * dt);
    this.cosmetic.yaw *= Math.exp(-7 * dt);
    this.cosmetic.shake = Math.max(0, this.cosmetic.shake - dt * 1.7);
    this.cosmetic.hurt = Math.max(0, this.cosmetic.hurt - dt * 1.9);
    const eye = p.eyeHeight || (p.crouching ? 1.05 : 1.68);
    const bob = p.alive && p.onGround ? Math.sin(ctx.time.t * 11) * Math.min(0.018, player.speed * 0.004) * (1 - player.ads * 0.8) : 0;
    player.eye.set(p.pos.x, p.pos.y + (p.alive ? eye : 0.45) + bob, p.pos.z);
    camera.position.copy(player.eye);
    const shake = this.cosmetic.shake;
    camera.rotation.set(
      p.pitch + (p.recoilPitch || 0) + this.cosmetic.pitch + Math.sin(ctx.time.t * 49) * shake * 0.007,
      p.yaw + (p.recoilYaw || 0) + this.cosmetic.yaw,
      Math.sin(ctx.time.t * 37) * shake * 0.004, 'YXZ'
    );
    player.forward.set(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
    const targetFov = player.baseFov + (p.sprinting ? 6 : 0);
    camera.fov += ((targetFov * (1 - player.ads) + 52 * player.ads) - camera.fov) * (1 - Math.exp(-12 * dt));
    camera.updateProjectionMatrix();
    if (ctx.render.post) {
      ctx.render.post.damage = this.cosmetic.hurt;
      ctx.render.post.lowHealth = clamp((55 - p.health) / 43, 0, 1);
      ctx.render.post.ads = player.ads;
    }
    player.hurtPulse = this.cosmetic.hurt;
  }

  renderRemote(now) {
    const history = this.remoteHistory;
    if (!history.length) { this.avatar.root.visible = false; return; }
    const targetTime = now - 100;
    let a = history[0], b = history[history.length - 1];
    for (let i = 1; i < history.length; i++) {
      if (history[i].time >= targetTime) { a = history[i - 1]; b = history[i]; break; }
      a = history[i];
    }
    let p = clone(b.player);
    if (a.player.lifeId === b.player.lifeId && a.player.alive && b.player.alive && b.time > a.time) {
      const alpha = clamp((targetTime - a.time) / (b.time - a.time), 0, 1);
      for (const axis of ['x', 'y', 'z']) p.pos[axis] = a.player.pos[axis] + (b.player.pos[axis] - a.player.pos[axis]) * alpha;
      let delta = b.player.yaw - a.player.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      p.yaw = a.player.yaw + delta * alpha;
      p.pitch = a.player.pitch + (b.player.pitch - a.player.pitch) * alpha;
    }
    this.avatar.update(p, now / 1000);
  }

  updateUI() {
    const el = this.ui.elements, me = this.localServerPlayer(), other = this.otherPlayer();
    const phase = this.state.phase;
    el.score.textContent = '你 ' + (me ? me.score : 0) + ' : ' + (other ? other.score : 0) + ' 朋友';
    el.status.textContent = !this.connected && !this.stopped ? '正在连接联机服务…' : 'SALTLINE · 10 杀获胜';
    const inviteURL = new URL(location.pathname, location.origin);
    inviteURL.searchParams.set('room', this.roomId);
    if (el.link.value !== inviteURL.href) el.link.value = inviteURL.href;
    el.copy.disabled = this.isLocalOnly;
    el.copy.textContent = this.isLocalOnly ? '仅本机测试' : '复制链接';
    if (this.isLocalOnly) el.notice.textContent = '当前地址仅本机可用，朋友需要公网游戏地址。';
    el.panel.hidden = this.settingsOpen || phase === 'playing' && !this.menuOpen && this.connected || phase === 'countdown' && this.connected;
    el.invite.hidden = !['waiting', 'connecting'].includes(phase);
    el.ready.hidden = phase !== 'waiting' || !this.connected;
    el.ready.textContent = me && me.ready ? '取消准备' : '准备就绪';
    el.resume.hidden = !this.menuOpen || phase !== 'playing' || !this.connected;
    el.rematch.hidden = phase !== 'finished';
    el.rematch.disabled = !!(me && me.rematch);
    el.rematch.textContent = me && me.rematch ? '等待朋友同意…' : '再来一局';
    let title = '正在连接', description = '正在启动联机服务，首次打开可能需要约一分钟。';
    if (phase === 'waiting') {
      title = this.isLocalOnly ? '本机测试房间' : other && other.connected ? '朋友已加入' : '等待朋友加入';
      description = (this.isLocalOnly
        ? '这是本机测试房间。请从公网游戏地址创建房间，再邀请不同网络的朋友。'
        : '复制邀请链接发给朋友。双方准备后开始，先击杀对手 10 次获胜。') + (me && me.ready ? ' 你已准备。' : '') + (other && other.ready ? ' 对方已准备。' : '');
    } else if (phase === 'reconnecting') {
      title = '等待重新连接';
      description = '对战已暂停，保留当前比分和位置。剩余 ' + Math.ceil(this.state.reconnectRemaining || 0) + ' 秒。';
    } else if (phase === 'finished') {
      title = this.state.winnerId === this.playerId ? '你赢得了最终胜利' : '朋友赢得了最终胜利';
      description = '本场已结束。双方选择再来一局即可重新开始。';
    } else if (phase === 'ended') {
      title = '房间已结束';
      description = this.failureMessage || roomReason(this.state.reason);
    } else if (this.menuOpen && phase === 'playing') {
      title = '对战仍在进行';
      description = '菜单只停止你的操作，对手仍可行动。点击返回对战继续。';
    }
    if (!this.connected && !this.stopped && phase !== 'connecting') {
      title = '正在重新连接';
      description = '连接中断，正在尝试返回原房间。服务器重启后需要重新创建房间。';
      el.panel.hidden = false;
    }
    el.title.textContent = title;
    el.description.textContent = description;
    el.count.hidden = true;
    if (phase === 'countdown') {
      el.count.hidden = false; el.count.textContent = Math.max(1, Math.ceil(this.state.countdown || 0)) + ' 秒后开始';
    } else if (phase === 'playing' && this.predicted && !this.predicted.alive && !this.menuOpen) {
      el.count.hidden = false;
      el.count.textContent = Math.max(1, Math.ceil(RULES.respawnSeconds - this.predicted.deadFor)) + ' 秒后复活';
    } else if (phase === 'playing' && this.predicted && this.predicted.invulnerableFor > 0) {
      el.count.hidden = false; el.count.textContent = '出生保护 · 开枪后解除';
    }
    const p = this.predicted;
    const ammo = p ? p.ammo : RULES.magSize;
    el.ammo.textContent = ammo + ' / ∞' + (p && p.reloadRemaining > 0 ? ' 换弹中' : '');
  }

  fail(message) {
    this.failureMessage = message;
    this.state.phase = 'ended';
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retryTimer);
    this.neutral();
    if (this.socket) this.socket.close();
    this.updateUI();
  }

  leave() {
    this.send({ type: 'leave' });
    this.stopped = true;
    this.neutral();
    clearTimeout(this.retryTimer);
    if (this.socket) this.socket.close();
    try { sessionStorage.removeItem(credentialKey(this.roomId)); } catch {}
    const url = new URL(location.href);
    url.searchParams.delete('room');
    url.searchParams.delete('multiplayer');
    location.assign(url.href);
  }
}

export async function startMultiplayer(ctx, options = {}) {
  if (window.__saltlineDuel) return window.__saltlineDuel;
  const response = await fetch(new URL('./shared/map.json', import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error('无法加载联机地图数据，请检查服务器是否已启动。');
  const manifest = await response.json();
  const actual = fingerprintWorld(captureWorld(ctx));
  if (actual !== manifest.hash) throw new Error('当前游戏地图与联机服务版本不一致，请重新导出地图或更新游戏。');
  let roomId = options.roomId;
  let credentials;
  if (!roomId) {
    const created = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await created.json();
    if (!created.ok) throw new Error(data.message || '无法创建房间。');
    roomId = data.roomId;
    credentials = { playerId: data.playerId, reconnectToken: data.reconnectToken };
    try { sessionStorage.setItem(credentialKey(roomId), JSON.stringify(credentials)); } catch {}
    const url = new URL(location.href);
    url.searchParams.delete('multiplayer');
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url.href);
  } else {
    try { credentials = JSON.parse(sessionStorage.getItem(credentialKey(roomId)) || 'null'); } catch {}
  }
  const client = new DuelClient(ctx, manifest, roomId, credentials);
  window.__saltlineDuel = client;
  client.connect();
  return client;
}

