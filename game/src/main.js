// App shell: boot, menu backdrop, session lifecycle, input, quality and Android integration.
import { Renderer, PerfMonitor } from './view/renderer.js';
import { GameView } from './view/gameView.js';
import { renderThumbnails } from './view/thumbs.js';
import { Game } from './core/sim.js';
import { LEVELS, getLevel } from './core/levels.js';
import { TOWER_ORDER, ABILITY_ORDER } from './core/config.js';
import { Save } from './core/save.js';
import { MUTATORS } from './core/waves.js';
import { AudioEngine, setVibration } from './audio/audio.js';
import { Screens } from './ui/screens.js';
import { Session } from './session.js';
import { h } from './ui/dom.js';

const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
const IS_MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || !!window.NativeBridge;
const QUALITY_STEPS = ['high', 'medium', 'low'];

class App {
  constructor() {
    this.version = VERSION;
    this.canvas = document.getElementById('gl');
    this.ui = document.getElementById('ui');
    this.save = new Save();
    this.audio = new AudioEngine();
    this.audioProgress = 0;
    this.audio.setVolumes(this.save.settings.sfx, this.save.settings.music);
    setVibration(this.save.settings.vibrate);
    this.screens = new Screens(this);
    this.session = null;
    this.menu = null;
    this.perf = new PerfMonitor();
    this.autoQuality = null;
  }

  async boot() {
    const bar = document.querySelector('#boot .boot-bar i');
    const msg = document.querySelector('#boot .boot-msg');
    const step = async (p, text) => { bar.style.width = `${p}%`; msg.textContent = text; await new Promise((r) => setTimeout(r, 30)); };
    await step(10, '啟動渲染核心…');
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (e) {
      msg.textContent = '此裝置不支援 WebGL2，無法執行遊戲。';
      return;
    }
    this.renderer.width = window.innerWidth;
    this.renderer.height = window.innerHeight;
    this.applyQuality(true);
    await step(35, '生成全像圖示…');
    this.thumbs = renderThumbnails(112);
    await step(65, '建構霓虹都市…');
    this.ensureMenuScene();
    this.menu.view.frame(0.016, 0.016);
    await step(100, '連線完成');
    this.bindInput();
    this.bindPlatform();
    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    this.screens.title();
    // the audio engine renders its sounds/score in the background (first launch only; later cached)
    this.audio.prepare((p) => { this.audioProgress = p; if (this.onAudioProgress) this.onAudioProgress(p); });
    document.getElementById('boot').classList.add('hide');
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------------------------------------------------------------- quality
  resolveQuality() {
    const q = this.save.settings.quality;
    if (q !== 'auto') return q;
    if (!this.autoQuality) this.autoQuality = IS_MOBILE ? 'medium' : 'high';
    return this.autoQuality;
  }

  applyQuality(initial = false) {
    const q = this.resolveQuality();
    this.fxScale = q === 'low' ? 0.5 : q === 'medium' ? 0.8 : 1;
    if (this.renderer.quality === q && !initial) return;
    this.renderer.setQuality(q);
    if (initial) return;
    // shadow settings are baked into scene lights: rebuild the active view
    if (this.session) this.session.rebuildView();
    if (this.menu) { this.disposeMenu(); if (!this.session) this.ensureMenuScene(); }
    this.onResize();
  }

  // ---------------------------------------------------------------- menu backdrop (demo battle)
  ensureMenuScene() {
    if (this.menu || this.session) return;
    const unlocked = LEVELS.filter((l) => this.save.unlocked(l.id));
    const lv = unlocked[Math.floor(Math.random() * unlocked.length)] || LEVELS[0];
    const level = { ...lv, towers: TOWER_ORDER, abilities: [] };
    const game = new Game(level, { demo: true, seed: Math.floor(Math.random() * 1e6) });
    game.credits = 1e9;
    // decorate with a plausible defense: towers on tiles next to the path
    const spots = [];
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      if (!game.canBuild(c, r, 'pulse').ok) continue;
      let near = 0;
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const t = game.map.at(c + dc, r + dr); if (t === 1) near++; }
      if (near) spots.push([c, r, Math.random()]);
    }
    spots.sort((a, b) => a[2] - b[2]);
    spots.slice(0, Math.min(14, spots.length)).forEach(([c, r], i) => {
      const type = TOWER_ORDER[i % TOWER_ORDER.length];
      const t = game.build(c, r, type);
      const lvl = 1 + ((i * 7) % 4);
      for (let u = 1; u < lvl; u++) game.upgrade(t, u === 3 ? (i % 2 ? 'a' : 'b') : undefined);
    });
    game.events.length = 0;
    game.callWave();
    const view = new GameView(this.renderer, game, { fxScale: this.fxScale * 0.8 });
    view.rig.pitch = 0.78;
    view.rig.yaw = Math.random() * Math.PI * 2;
    view.rig.menuShift = 0.16;
    this.menu = { game, view, t: 0 };
    this.onResize();
  }

  disposeMenu() {
    if (!this.menu) return;
    this.menu.view.dispose();
    this.menu = null;
  }

  // ---------------------------------------------------------------- sessions
  levelDef(id, endless) {
    const lv = getLevel(id);
    return endless ? { ...lv, towers: TOWER_ORDER, abilities: ABILITY_ORDER } : lv;
  }

  startLevel(id, difficulty = 'normal', endless = false, snapshot = null, loadout = null) {
    this.endSession();
    this.disposeMenu();
    this.screens.clear();
    this.screens.closeAllModals();
    this.lastStart = { id, difficulty, endless, loadout };
    this.session = new Session(this, this.levelDef(id, endless), { difficulty, endless, snapshot, loadout: loadout || (snapshot && snapshot.loadout) || null });
    if (!snapshot) this.save.clearRun();
  }

  resumeRun() {
    const run = this.save.data.run;
    if (!run) return;
    this.startLevel(run.levelId, run.difficulty, run.endless, run, run.loadout);
  }

  restart() {
    const s = this.lastStart;
    if (s) this.startLevel(s.id, s.difficulty, s.endless, null, s.loadout);
  }

  endSession() {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
    this.audio.setHum(0);
  }

  quitToMenu(toLevels = false) {
    this.endSession();
    this.screens.closeAllModals();
    this.ensureMenuScene();
    if (toLevels) this.screens.levels(); else this.screens.title();
    this.audio.setMusic('menu');
  }

  mutatorName(m) { return (MUTATORS[m] && MUTATORS[m].name) || m; }

  toast(text) {
    const t = h('div', { class: 'toast panel', style: { zIndex: 5 } }, text);
    this.ui.append(t);
    setTimeout(() => t.remove(), 1700);
  }

  // ---------------------------------------------------------------- loop
  loop(now) {
    const rdt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.session) {
      this.session.frame(rdt);
    } else if (this.menu) {
      const m = this.menu;
      m.t += rdt;
      const rig = m.view.rig;
      rig.yaw += rdt * 0.045;
      rig.goal.set(0, 0, 0);
      rig.goalDist = Math.hypot(m.game.level.cols, m.game.level.rows) * 0.98;
      let dt = rdt;
      while (dt > 1e-6) { const s = Math.min(dt, 1 / 60); m.game.update(s); dt -= s; }
      if (m.game.wave >= 8) { m.game.wave = 1; }
      m.view.frame(rdt, rdt);
    }
    // automatic quality: step down on sustained slow frames
    if (this.save.settings.quality === 'auto' && !document.hidden) {
      this.perf.push(rdt);
      if (this.perf.check(rdt) < 0) {
        const i = QUALITY_STEPS.indexOf(this.autoQuality);
        if (i >= 0 && i < QUALITY_STEPS.length - 1) {
          this.autoQuality = QUALITY_STEPS[i + 1];
          this.applyQuality();
        }
      }
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  onResize() {
    const w = window.innerWidth, hgt = window.innerHeight;
    if (w < 2 || hgt < 2) return; // hidden / collapsed window: keep the last good size
    if (this.session) this.session.resize();
    else if (this.menu) this.menu.view.resize(w, hgt, { top: 0.02, bottom: 0.02, left: 0.02, right: 0.02 });
    else this.renderer.resize(w, hgt);
  }

  // ---------------------------------------------------------------- input (tap / drag-pan / pinch-zoom)
  bindInput() {
    const c = this.canvas;
    const pts = new Map();
    let drag = false, pinch = null, downT = 0, startX = 0, startY = 0;
    const active = () => this.session && !this.screens.modals.length && !this.session.paused;
    c.addEventListener('pointerdown', (e) => {
      this.audio.unlock();
      if (!active()) return;
      c.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { drag = false; downT = performance.now(); startX = e.clientX; startY = e.clientY; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (!drag) { drag = true; this.session.panStart(); }
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p || !active()) return;
      const rig = this.session.view.rig;
      const W = window.innerWidth, H = window.innerHeight;
      if (pts.size === 1) {
        if (!drag && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) { drag = true; this.session.panStart(); }
        if (drag) rig.panPixels(p.x, p.y, e.clientX, e.clientY, W, H);
        p.x = e.clientX; p.y = e.clientY;
      } else if (pts.size === 2 && pinch) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (d > 10) rig.zoomAt(pinch.d / d, mx, my, W, H);
        rig.panPixels(pinch.x, pinch.y, mx, my, W, H);
        pinch = { d, x: mx, y: my };
      }
    });
    const up = (e) => {
      const had = pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!had || !active()) return;
      if (pts.size === 0 && !drag && performance.now() - downT < 500) this.session.tap(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = null; drag = true; });
    c.addEventListener('wheel', (e) => {
      if (!active()) return;
      e.preventDefault();
      this.session.panStart();
      this.session.view.rig.zoomAt(e.deltaY > 0 ? 1.1 : 0.9, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    }, { passive: false });
    c.addEventListener('dblclick', () => { if (active()) this.session.view.rig.reset(); });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.back();
      if (!this.session || !active()) return;
      if (e.key === ' ') { e.preventDefault(); this.session.callWave(); }
      if (e.key === 'f') this.session.cycleSpeed();
      if (e.key === '1') this.session.pressAbility('thunder');
      if (e.key === '2') this.session.pressAbility('stasis');
    });
  }

  back() { return this.screens.back(); }

  // ---------------------------------------------------------------- platform hooks (Android WebView + browser)
  bindPlatform() {
    window.__nativeBack = () => this.back();
    window.__nativePause = () => this.onHide();
    window.__nativeResume = () => this.onShow();
    window.__setSafeInsets = () => this.onResize();
    document.addEventListener('visibilitychange', () => (document.hidden ? this.onHide() : this.onShow()));
    if (window.__safeInsets) this.onResize();
  }

  onHide() {
    if (this.session && !this.session.paused && !this.session.over) this.session.openPause();
    this.audio.pause();
  }

  onShow() {
    this.audio.resume();
    this.last = performance.now();
  }
}

const app = new App();
window.__app = app;
app.boot();
