// A versus match: our lane (VersusGame, side 0) plus the opponent's lane rendered on the right half.
// The opponent is either a local AI (its own VersusGame driven by VersusBot) or a network mirror (see
// net/remoteSide.js); both expose the same lists so the view renders them alike.
import { Session } from './session.js';
import { VersusGame, PACK_BY_ID, DEFAULT_VS_LOADOUT } from './core/versus.js';
import { VersusBot } from './core/versusBot.js';
import { VersusHud } from './ui/versusHud.js';
import { vibrate } from './audio/audio.js';

export class VersusSession extends Session {
  // opts: { mode: 'ai' | 'online', seed, loadout, oppName,
  //         ai: { level, style, loadout } | online: { room, remote } }
  constructor(app, opts) {
    const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
    const game = new VersusGame({ side: 0, seed, loadout: opts.loadout || DEFAULT_VS_LOADOUT, variant: seed });
    super(app, game.level, { ...opts, game, hudClass: VersusHud });
    this.versus = true;
    this.mode = opts.mode;
    this.seed = seed;
    this.elapsed = 0;
    if (opts.mode === 'ai') {
      const ai = opts.ai || {};
      this.opp = new VersusGame({ side: 1, seed, loadout: ai.loadout || DEFAULT_VS_LOADOUT, variant: seed });
      this.bot = new VersusBot(this.opp, { level: ai.level || 'normal', style: ai.style || 'balanced', seed });
    } else {
      this.opp = opts.online.remote;
      this.room = opts.online.room;
      this.opp.attach(this);
    }
    this.view.addSource(this.opp);
    this.hud.toast(opts.mode === 'ai' ? '練習對戰開始！派兵可以提高收入' : '對戰開始！', 2600);
  }

  resize() {
    const h = window.innerHeight;
    if (h < 2 || window.innerWidth < 2) return;
    // keep the send bar (bottom) and the top bar clear of the map
    this.view.resize(window.innerWidth, h, { top: Math.min(0.14, 48 / h), bottom: Math.min(0.2, 76 / h), left: 0.01, right: 0.01 });
    if (this.hud.radial) this.hud.placeRadial();
  }

  // ---------------------------------------------------------------- loop
  frame(rdt) {
    const g = this.game, o = this.opp;
    if (!this.paused && !this.over) {
      let dt = rdt * this.speed;
      this.elapsed += dt;
      while (dt > 1e-6 && g.state === 'play') {
        const s = Math.min(dt, 1 / 60);
        if (this.bot) this.bot.update(s, g);
        g.update(s);
        if (this.mode === 'ai') {
          o.update(s);
          for (const m of o.outbox.splice(0)) g.receive(m);
        }
        for (const m of g.outbox.splice(0)) this.deliver(m);
        dt -= s;
      }
      if (this.mode === 'online') o.tick(rdt);
    }
    const vdt = this.paused ? 0 : rdt;
    this.view.frame(vdt * this.speed, vdt);
    this.hud.update(rdt);
    this.updateAudio(rdt);
    if (!this.over) {
      if (g.state === 'lost') this.finishVersus(false);
      else if (o.state === 'lost') this.finishVersus(true);
    }
  }

  deliver(msg) {
    if (this.mode === 'ai') this.opp.receive(msg);
    else this.opp.sendPack(msg);
  }

  // ---------------------------------------------------------------- input
  sendPack(id) {
    this.app.audio.unlock();
    const chk = this.game.canSend(id);
    if (!chk.ok) { this.app.audio.play('error'); this.hud.toast(chk.reason, 1200); return; }
    this.game.send(id);
    vibrate(15);
  }

  tap(x, y) {
    if (this.over) return;
    const p = this.view.pick(x, y);
    if (p.col >= 0 && !this.game.ownsCol(p.col)) {
      // the opponent's half: show their tower if there is one, otherwise explain
      const t = this.opp.towers.find((o) => o.col === p.col && o.row === p.row);
      this.deselect();
      if (t) this.hud.toast(`對手的 ${t.def ? t.def.name : '砲塔'}（等級 ${t.level}）`, 1500);
      else this.hud.toast('只能在自己的半場（左側）建造', 1300);
      return;
    }
    super.tap(x, y);
  }

  cycleSpeed() {
    if (this.mode !== 'ai') return;
    this.speed = this.speed >= 2 ? 1 : 2;
    this.app.audio.play('click');
  }

  openPause() {
    if (this.over) return;
    if (this.mode === 'ai') this.paused = true; // an online opponent keeps playing
    this.deselect();
    this.app.screens.versusPause(this);
  }

  resume() { this.paused = false; }

  surrender() {
    if (this.over) return;
    if (this.mode === 'online') this.opp.surrender();
    this.game.lives = 0;
    this.game.state = 'lost';
    this.finishVersus(false, true);
  }

  // ---------------------------------------------------------------- events
  onEvent(ev) {
    if (ev.remote) return; // the opponent's lane is drawn but stays quiet
    const a = this.app.audio;
    switch (ev.type) {
      case 'send': this.hud.sent(ev.pack); a.play('upgrade'); return;
      case 'incoming': this.hud.incoming(ev.pack); a.play('summon'); vibrate(40); return;
      case 'income': return;
      case 'ability': if (this.mode === 'online') this.opp.sendSkill(ev.id, ev.hits); super.onEvent(ev); return;
      default: super.onEvent(ev);
    }
  }

  // ---------------------------------------------------------------- end
  finishVersus(win, surrendered = false) {
    if (this.over) return;
    this.over = true;
    this.deselect();
    this.hud.hint(null);
    const a = this.app.audio;
    if (a.setLoop) { a.setLoop('laser', 0); a.setLoop('flame', 0); }
    if (a.stinger) a.stinger(win ? 'victory' : 'defeat'); else a.play(win ? 'victory' : 'defeat');
    vibrate(win ? 80 : 300);
    a.setMusic('menu');
    if (this.mode === 'online' && !surrendered) this.opp.matchOver(win);
    const g = this.game;
    const result = {
      win, surrendered, mode: this.mode, time: this.elapsed, wave: g.wave,
      forfeit: !!this.opp.forfeit, oppSurrendered: !!this.opp.surrendered,
      lives: Math.max(0, Math.ceil(g.lives)), oppLives: Math.max(0, Math.ceil(this.opp.lives)),
      kills: g.stats.kills, leaked: g.stats.leakedLives, sentValue: g.stats.sentValue, sent: g.stats.sent,
      ecoMax: g.stats.ecoMax, received: g.stats.received,
    };
    setTimeout(() => { if (this.app.session === this) this.app.screens.versusResult(this, result); }, 1200);
  }

  // quality changes rebuild the view: the opponent's lane must be attached again
  rebuildView() {
    super.rebuildView();
    this.view.addSource(this.opp);
  }

  dispose() {
    if (this.onLeaveResult) this.onLeaveResult();
    if (this.opp && this.opp.detach) this.opp.detach();
    if (this.room && !this.keepRoom) this.room.close('left');
    super.dispose();
  }
}

export { PACK_BY_ID };
