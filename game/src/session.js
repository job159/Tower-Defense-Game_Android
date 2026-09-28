// One play session: owns the simulation, its view and HUD; turns taps into game commands.
import { Game } from './core/sim.js';
import { GameView } from './view/gameView.js';
import { Hud } from './ui/hud.js';
import { TILE } from './core/path.js';
import { TOWERS, ENEMIES, TARGET_MODES } from './core/config.js';
import { vibrate } from './audio/audio.js';

const FIRE_SFX = { bullet: 'pulse', shell: 'mortar', frost: 'frost', missile: 'missile', tesla: 'tesla', napalm: 'napalm' };

export class Session {
  constructor(app, level, opts = {}) {
    this.app = app;
    this.level = level;
    this.opts = opts;
    this.game = new Game(level, {
      difficulty: opts.difficulty || 'normal', endless: !!opts.endless,
      research: app.save.data.research, snapshot: opts.snapshot, loadout: opts.loadout,
    });
    this.view = new GameView(app.renderer, this.game, { fxScale: app.fxScale });
    this.view.on((ev) => this.onEvent(ev));
    this.hud = new Hud(this);
    app.ui.prepend(this.hud.root);
    this.speed = 1;
    this.paused = false;
    this.sel = null;
    this.preview = null;
    this.over = false;
    this.intensity = 0;
    this.tut = level.id === 1 && !opts.endless && !app.save.data.tutorial ? 0 : -1;
    this.resize();
    if (opts.snapshot) this.hud.toast(`從第 ${this.game.wave + 1} 波繼續`);
    else if (this.game.mutators.length) this.hud.toast(`惡夢突變：${this.game.mutators.map((m) => this.app.mutatorName(m)).join('、')}`, 4200);
    else if (level.tip && this.tut < 0) this.hud.toast(level.tip, 4200);
  }

  resize() {
    const h = window.innerHeight;
    if (h < 2 || window.innerWidth < 2) return;
    this.view.resize(window.innerWidth, h, { top: Math.min(0.13, 46 / h), bottom: 0.01, left: 0.01, right: 0.01 });
    if (this.hud.radial) this.hud.placeRadial();
  }

  // ---------------------------------------------------------------- loop
  frame(rdt) {
    const g = this.game;
    if (!this.paused && !this.over) {
      let dt = rdt * this.speed;
      while (dt > 1e-6 && g.state === 'play') {
        const s = Math.min(dt, 1 / 60);
        g.update(s);
        dt -= s;
      }
    }
    const vdt = this.paused ? 0 : rdt;
    this.view.frame(vdt * this.speed, vdt);
    this.hud.update(rdt);
    this.updateAudio(rdt);
    if (this.tut >= 0) this.tutorial();
    if (g.state !== 'play' && !this.over) this.finish();
  }

  // Adaptive music: calm between waves, intensity follows the pressure on the field.
  updateAudio(rdt) {
    const g = this.game;
    const a = this.app.audio;
    if (this.over) {
      // finish() already queued the victory/defeat stinger and the menu music: keep hands off
      if (a.setLoop) { a.setLoop('laser', 0); a.setLoop('flame', 0); } else a.setHum(0);
      return;
    }
    let beams = 0, flames = 0;
    for (const t of g.towers) { beams += t.beams.length; if (t.flameOn) flames++; }
    if (a.setLoop) {
      a.setLoop('laser', this.paused ? 0 : beams);
      a.setLoop('flame', this.paused ? 0 : flames);
    } else a.setHum(this.paused ? 0 : beams);
    const boss = g.enemies.some((e) => e.boss);
    const busy = g.enemies.length > 0 || g.qi < g.queue.length;
    a.setMusic(boss ? 'boss' : g.wave === 0 || !busy ? 'build' : 'battle');
    const lost = 1 - g.lives / g.maxLives;
    const target = Math.min(1, g.enemies.length / 40 + lost * 0.8 + (boss ? 0.4 : 0));
    this.intensity += (target - this.intensity) * Math.min(1, rdt * 0.8);
    if (a.setIntensity) a.setIntensity(this.intensity);
  }

  // ---------------------------------------------------------------- events -> sound / HUD
  onEvent(ev) {
    const a = this.app.audio;
    const hw = this.level.cols / 2;
    const pan = (x) => (x || 0) / hw;
    switch (ev.type) {
      case 'fire':
        if (ev.kind !== 'rail') a.play(ev.kind === 'bullet' && ev.tower.spec === 'a' ? 'gatling' : FIRE_SFX[ev.kind], { pan: pan(ev.tower.x) });
        break;
      case 'rail': a.play('rail', { pan: pan(ev.x1), size: ev.over ? 2 : 1 }); break;
      case 'hit': if (ev.kind === 'bullet') a.play('hit', { pan: pan(ev.x) }); break;
      case 'explode':
        if (ev.kind === 'bomblet') a.play('bomblet', { pan: pan(ev.x) });
        else a.play('explode', { size: ev.kind === 'nuke' ? 3 : ev.kind === 'mortar' || ev.kind === 'napalm' ? 1 : 0.5, pan: pan(ev.x) });
        break;
      case 'mineBoom': a.play('mineBoom', { pan: pan(ev.x) }); break;
      case 'mineDrop': a.play('mineDrop', { pan: pan(ev.mine.x) }); break;
      case 'droneFire': a.play(ev.rocket ? 'droneRocket' : 'drone', { pan: pan(ev.drone.x) }); break;
      case 'shatter': a.play(ev.kind === 'fire' ? 'burn' : 'shatter', { pan: pan(ev.x) }); break;
      case 'kill': {
        const e = ev.enemy;
        a.play(e.boss ? 'bosskill' : e.def.radius >= 0.4 ? 'killHeavy' : 'kill', { pan: pan(e.x) });
        if (e.boss) vibrate(120);
        if (ev.reward > 0) {
          const p = this.view.screenOf(e.x, (e.air ? e.y : 0.3) + 0.3, e.z);
          this.hud.float(p.x, p.y, `+${ev.reward}`, e.boss ? 'big' : '');
        }
        break;
      }
      case 'leak': {
        a.play('leak');
        vibrate(ev.dmg > 2 ? 150 : 50);
        this.hud.hurt();
        const c = this.game.map.core;
        const p = this.view.screenOf(c.x, 1.3, c.z);
        this.hud.float(p.x, p.y, `-${ev.dmg}`, 'red');
        break;
      }
      case 'build': a.play('build'); break;
      case 'upgrade': a.play(ev.ultimate ? 'ultimate' : 'upgrade'); if (ev.ultimate) vibrate(60); break;
      case 'sell': a.play('sell'); break;
      case 'rankUp': {
        a.play('rankUp');
        const t = ev.tower;
        const p = this.view.screenOf(t.x, 1.4, t.z);
        this.hud.float(p.x, p.y, `老兵 ★${t.rank}`, 'gold');
        if (this.sel && this.sel.tower === t) this.hud.showInfo({ tower: t });
        break;
      }
      case 'clearWreck': a.play('clearWreck'); if (ev.node) this.hud.toast('發現能量節點！'); break;
      case 'heal': a.play('heal', { pan: pan(ev.x) }); break;
      case 'blink': a.play('blink', { pan: pan(ev.x1) }); break;
      case 'shieldBreak': a.play('shield', { pan: pan(ev.enemy.x) }); break;
      case 'freeze': a.play('freeze', { pan: pan(ev.enemy.x) }); break;
      case 'reveal': a.play('reveal', { pan: pan(ev.enemy.x) }); break;
      case 'emp': a.play('emp', { pan: pan(ev.x) }); if (ev.towers.length) { a.play('disabled'); vibrate(40); } break;
      case 'ping': a.play('radar', { pan: pan(ev.tower.x) }); break;
      case 'summon': a.play('summon', { pan: pan(ev.enemy.x) }); break;
      case 'bossPhase':
        a.play(ev.kind === 'enrage' ? 'berserk' : 'bossPhase');
        if (ev.kind === 'transform') { vibrate(250); this.hud.banner('終焉·升天', '首領進入第二型態！', true); }
        else if (ev.kind === 'enrage') this.hud.toast(`${ENEMIES[ev.enemy.type].name} 狂暴化！`);
        break;
      case 'spawn':
        if (ev.first && !ev.enemy.def.hidden) {
          const seen = this.app.save.data.seenEnemies;
          if (!seen.includes(ev.enemy.type)) { seen.push(ev.enemy.type); this.app.save.write(); this.hud.newEnemy(ev.enemy.type); }
        }
        break;
      case 'waveStart': {
        if (a.stinger) a.stinger(ev.boss ? 'bossIntro' : 'wave'); else a.play(ev.boss ? 'boss' : 'wave');
        if (ev.boss) vibrate(200);
        const extras = [];
        if (ev.interest) extras.push(`利息 +${ev.interest}`);
        if (ev.early) extras.push(`提早 +${ev.bonus}`);
        const sub = ev.boss ? `首領來襲 · ${ENEMIES[ev.boss].name}` : ev.theme ? `${ev.theme}波次` : extras.join('　');
        this.hud.banner(`第 ${ev.wave} 波`, sub, !!ev.boss);
        if (ev.interest) a.play('interest');
        if (ev.early) a.play('coin');
        if (this.game.lastSnapshot) this.app.save.setRun({ ...this.game.lastSnapshot, levelId: this.level.id });
        break;
      }
      case 'ability':
        if (ev.id === 'thunder') {
          // one big crack plus a few spread-out zaps; the engine caps overlapping voices
          a.play('strike', { size: 3 });
          a.play('emp');
          for (let i = 0; i < Math.min(4, ev.hits.length); i++) a.play('tesla', { pan: pan(ev.hits[i][0]) });
          this.hud.thunderFlash();
          vibrate(120);
        } else a.play(ev.id);
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- input
  tap(x, y) {
    if (this.over) return;
    this.app.audio.unlock();
    const p = this.view.pick(x, y);
    if (p.tower) {
      if (this.sel && this.sel.tower === p.tower) return this.deselect();
      return this.selectTower(p.tower);
    }
    if (p.tile === TILE.BUILD) {
      if (this.sel && !this.sel.tower && !this.sel.wreck && this.sel.col === p.col && this.sel.row === p.row) return this.deselect();
      return this.selectTile(p.col, p.row);
    }
    if (p.wreck) return this.selectWreck(p.wreck);
    const e = this.view.pickEnemy(x, y);
    if (e) { this.deselect(); this.hud.enemyCard(e); this.app.audio.play('select'); return; }
    this.deselect();
  }

  panStart() { if (this.sel) this.deselect(); }

  selectTile(col, row) {
    this.deselect();
    const x = col - (this.level.cols - 1) / 2, z = row - (this.level.rows - 1) / 2;
    this.sel = { col, row, x, z };
    this.view.setMarker(x, z, 0x22e6ff);
    this.hud.openBuild(col, row, this.sel);
    this.app.audio.play('select');
  }

  selectTower(t) {
    this.deselect();
    this.sel = { col: t.col, row: t.row, x: t.x, z: t.z, tower: t };
    this.view.selectedId = t.id;
    this.view.setMarker(t.x, t.z, TOWERS[t.type].color);
    this.view.showRange(t.x, t.z, t.stats.range, TOWERS[t.type].color);
    this.hud.openTower(t);
    this.app.audio.play('select');
  }

  selectWreck(w) {
    this.deselect();
    this.sel = { col: w.col, row: w.row, x: w.x, z: w.z, wreck: w };
    this.view.setMarker(w.x, w.z, 0xff8a3d);
    this.hud.openWreck(w);
    this.app.audio.play('select');
  }

  deselect() {
    this.sel = null;
    this.preview = null;
    this.view.selectedId = null;
    this.view.clearMarker();
    this.view.clearGhost();
    this.view.hideRange();
    this.hud.closeRadial();
    this.hud.closeEnemyCard();
  }

  radialBuild(type) {
    const g = this.game;
    const { col, row, x, z } = this.sel;
    if (this.preview && this.preview.build === type) {
      const t = g.build(col, row, type);
      if (!t) { this.app.audio.play('error'); this.hud.toast(g.canBuild(col, row, type).reason); return; }
      vibrate(20);
      this.deselect();
      return;
    }
    this.preview = { build: type };
    const ok = g.credits >= g.buildCost(type);
    this.view.setGhost(type, 1, null, x, z, ok);
    const node = g.map.isNode(col, row) && type !== 'amp' ? 1.12 : 1;
    const base = TOWERS[type].levels[0].range * (type === 'amp' ? 1 : g.mods.range) * node;
    this.view.showRange(x, z, base, ok ? TOWERS[type].color : 0xff3050);
    this.hud.setRadialSel(type);
    this.hud.showInfo({ build: type, col, row });
    this.app.audio.play('click');
  }

  radialUpgrade(spec) {
    const g = this.game;
    const t = this.sel.tower;
    const key = spec || 'up';
    const useSpec = spec || (t.level >= 4 ? t.spec : undefined);
    const chk = g.canUpgrade(t, useSpec);
    if (this.preview && this.preview.up === key) {
      if (!chk.ok) { this.app.audio.play('error'); this.hud.toast(chk.reason); return; }
      g.upgrade(t, useSpec);
      vibrate(25);
      this.selectTower(t);
      return;
    }
    this.preview = { up: key };
    const next = this.previewStats(t, t.level + 1, useSpec || t.spec);
    this.view.showRange(t.x, t.z, next.range, TOWERS[t.type].color);
    this.hud.setRadialSel(key);
    this.hud.showInfo({ tower: t, preview: key });
    this.app.audio.play(chk.ok || chk.reason === '資金不足' ? 'click' : 'error');
  }

  radialSell() {
    const t = this.sel.tower;
    if (this.preview && this.preview.sell) {
      this.game.sell(t);
      this.deselect();
      return;
    }
    this.preview = { sell: true };
    this.hud.setRadialSel('sell');
    this.hud.showInfo({ tower: t, preview: 'sell' });
    this.app.audio.play('click');
  }

  radialTarget() {
    const t = this.sel.tower;
    const i = TARGET_MODES.indexOf(t.targeting);
    this.game.setTargeting(t, TARGET_MODES[(i + 1) % TARGET_MODES.length]);
    this.hud.updateTargetLabel(t);
    this.app.audio.play('click');
  }

  radialClear() {
    const w = this.sel.wreck;
    if (this.preview && this.preview.clear) {
      if (!this.game.clearWreck(w.col, w.row)) { this.app.audio.play('error'); this.hud.toast('資金不足'); return; }
      vibrate(25);
      const col = w.col, row = w.row;
      this.deselect();
      this.selectTile(col, row);
      return;
    }
    this.preview = { clear: true };
    this.hud.setRadialSel('clear');
    this.hud.showWreckInfo(w, true);
    this.app.audio.play('click');
  }

  previewStats(t, level, spec) { return this.game.computeStats(t, level, spec).stats; }

  callWave() {
    this.app.audio.unlock();
    if (this.game.callWave()) vibrate(15);
  }

  cycleSpeed() {
    this.speed = this.speed >= 3 ? 1 : this.speed + 1;
    this.app.audio.play('click');
  }

  pressAbility(id) {
    const g = this.game;
    this.app.audio.unlock();
    const a = g.abilities[id];
    if (!a || a.cd > 0) { this.app.audio.play('error'); return; }
    g.useAbility(id);
    vibrate(30);
  }

  openPause() {
    if (this.over) return;
    this.paused = true;
    this.deselect();
    if (this.app.audio.setLoop) { this.app.audio.setLoop('laser', 0); this.app.audio.setLoop('flame', 0); }
    this.app.screens.pause(this);
  }

  resume() { this.paused = false; }

  // ---------------------------------------------------------------- tutorial
  tutorial() {
    const g = this.game;
    const steps = [
      ['點擊路徑旁 <b>有發光角標的空地</b> 來建造砲塔', () => !!this.sel || g.towers.length > 0],
      ['點選砲塔預覽射程，<b>再點一次</b> 確認建造', () => g.towers.length > 0],
      ['<b>◆ 金色能量節點</b> 上的砲塔更強。準備好就按右下角 <b>開始波次</b>', () => g.wave > 0],
      ['擊毀敵人獲得資金。點擊已建好的砲塔可以 <b>升級</b>；存下的資金每波會產生 <b>利息</b>', () => g.wave >= 3 || g.towers.some((t) => t.level > 1)],
      ['敵人還在場上時提早按 <b>下一波</b> 可獲得額外資金，但敵人會越疊越多', () => g.wave >= 5],
    ];
    if (this.tut >= steps.length) {
      this.tut = -1;
      this.hud.hint(null);
      this.app.save.data.tutorial = true;
      this.app.save.write();
      return;
    }
    const [text, done] = steps[this.tut];
    if (this.hudTut !== this.tut) { this.hudTut = this.tut; this.hud.hint(text, 0); }
    if (done()) { this.tut++; this.hud.hint(null); }
  }

  // ---------------------------------------------------------------- end of game
  finish() {
    this.over = true;
    this.deselect();
    this.hud.hint(null);
    const g = this.game;
    const save = this.app.save;
    const a = this.app.audio;
    if (a.setLoop) { a.setLoop('laser', 0); a.setLoop('flame', 0); }
    let result;
    if (g.state === 'won') {
      const stars = g.stars();
      const challenge = g.challengeMet();
      const firstChallenge = challenge && !save.challenge(this.level.id);
      save.recordWin(this.level.id, g.difficulty, stars, challenge);
      save.clearRun();
      if (a.stinger) a.stinger('victory'); else a.play('victory');
      result = { win: true, stars, challenge, firstChallenge };
    } else {
      if (a.stinger) a.stinger('defeat'); else a.play('defeat');
      vibrate(300);
      if (g.endless) { save.recordEndless(this.level.id, g.wave); save.clearRun(); }
      result = { win: false, wave: g.wave };
    }
    a.setMusic('menu');
    setTimeout(() => { if (this.app.session === this) this.app.screens.result(this, result); }, 1200);
  }

  // Quality changes alter scene lighting/shadows: rebuild the view from the live game state.
  rebuildView() {
    this.deselect();
    this.view.dispose();
    this.view = new GameView(this.app.renderer, this.game, { fxScale: this.app.fxScale });
    this.view.on((ev) => this.onEvent(ev));
    this.resize();
  }

  dispose() {
    this.hud.dispose();
    this.view.dispose();
  }
}
