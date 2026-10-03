// The opponent's lane in an online match, rebuilt from their network messages and drawn on the right half.
//
// Each client simulates only its own lane (always the left one locally) and streams compact snapshots of it;
// we mirror theirs (x -> -x, col -> cols-1-col) into tower/enemy objects shaped like the simulation's, so the
// view renders both halves the same way. The mirror is visual only: towers aim and fire cosmetically at the
// mirrored enemies. Gameplay crosses over only through sends, lives and the end of the match.
import { TOWERS, ENEMIES, towerBaseStats } from '../core/config.js';
import { VS_RULES, VS_LEVEL } from '../core/versus.js';
import { tileToWorld } from '../core/path.js';

const ENEMY_KEYS = Object.keys(ENEMIES);
const TOWER_KEYS = Object.keys(TOWERS);
const SPEC_CODE = { a: 1, b: 2 };
const SPEC_OF = [null, 'a', 'b'];
const SNAP_EVERY = 0.2;   // s: enemy snapshot rate
const TOWERS_EVERY = 1;   // s: tower list rate (also sent right after any change)
const ID_OFFSET = 2_000_000;
const MAX_SNAP_ENEMIES = 140; // keeps a snapshot well under the room's 15 KB message cap
// flags in enemy snapshots
const F_AIR = 1, F_HIDDEN = 2, F_FROZEN = 4, F_BURN = 8, F_STUN = 16, F_WARP = 32;
const FIRE_KIND = { bullet: 'bullet', shell: 'shell', frost: 'frost', missile: 'missile', napalm: 'napalm' };

export class RemoteSide {
  constructor(room, { name = '對手', loadout = [] } = {}) {
    this.room = room;
    this.name = name;
    this.loadout = loadout;
    this.side = 1;
    this.towers = []; this.enemies = []; this.drones = []; this.mines = [];
    this.projectiles = []; this.wells = []; this.zones = []; this.events = [];
    this.lives = VS_RULES.lives; this.maxLives = VS_RULES.lives;
    this.eco = VS_RULES.baseEco; this.wave = 0; this.state = 'play';
    this.towerMap = new Map();
    this.enemyMap = new Map();
    this.snapT = 0; this.towersT = 0; this.towerSig = '';
    this.peerStatus = 'connected';
    this.handlers = [];
  }

  // ---------------------------------------------------------------- wiring
  attach(session) {
    this.session = session;
    this.game = session.game;
    const on = (ev, fn) => { this.room.on(ev, fn); this.handlers.push([ev, fn]); };
    on('message', (m) => this.onMessage(m));
    on('status', (st) => { this.peerStatus = st; this.session.hud.netStatus && this.session.hud.netStatus(st); });
    on('closed', (reason) => {
      // the opponent vanished mid-match: they forfeit
      if (this.state === 'play' && !this.session.over && reason !== 'local') { this.state = 'lost'; this.forfeit = true; }
    });
  }

  detach() { for (const [ev, fn] of this.handlers) this.room.off(ev, fn); this.handlers.length = 0; }

  sendPack(msg) { this.room.send('send', msg); }
  // our commander skills, so the opponent sees the strike land on our half
  sendSkill(id, hits) { this.room.send('skill', { id, h: (hits || []).slice(0, 40).map(([x, y, z, b]) => [Math.round(x * 100), Math.round(y * 100), Math.round(z * 100), b]) }, { reliable: false }); }
  surrender() { this.room.send('lost', { surrender: true }); }
  matchOver(win) { if (!win) this.room.send('lost', {}); }

  // ---------------------------------------------------------------- outgoing: our lane, every frame
  tick(dt) {
    const g = this.game;
    this.snapT -= dt;
    this.towersT -= dt;
    if (this.snapT <= 0) {
      this.snapT = SNAP_EVERY;
      const en = [];
      let list = g.enemies;
      // huge waves: send the ones that matter most (bosses, then the furthest along)
      if (list.length > MAX_SNAP_ENEMIES) list = list.slice().sort((a, b) => (b.boss - a.boss) || (b.dist / b.path.length - a.dist / a.path.length)).slice(0, MAX_SNAP_ENEMIES);
      for (const e of list) {
        if (e.dead) continue;
        let f = 0;
        if (e.air) f |= F_AIR;
        if ((e.def.cloak || e.cloakT > 0) && !e.detected) f |= F_HIDDEN;
        if (e.frozen) f |= F_FROZEN;
        if (e.burnT > 0) f |= F_BURN;
        if (e.stunTime > 0) f |= F_STUN;
        if (e.inWarp) f |= F_WARP;
        en.push([e.id, ENEMY_KEYS.indexOf(e.type), Math.round(e.x * 100), Math.round(e.z * 100), Math.round((e.hp / e.maxHp) * 100), f]);
      }
      this.room.send('snap', { l: Math.max(0, Math.ceil(g.lives)), e: g.eco, w: g.wave, en }, { reliable: false });
    }
    const sig = g.towers.map((t) => `${t.id}.${t.level}.${t.spec || ''}.${t.rank}`).join(',');
    if (sig !== this.towerSig || this.towersT <= 0) {
      this.towerSig = sig;
      this.towersT = TOWERS_EVERY;
      this.room.send('towers', { tw: g.towers.map((t) => [t.id, TOWER_KEYS.indexOf(t.type), t.level, SPEC_CODE[t.spec] || 0, t.col, t.row, t.rank]) }, { reliable: false });
    }
    this.animate(dt);
  }

  // ---------------------------------------------------------------- incoming
  onMessage({ type, data }) {
    switch (type) {
      case 'send': this.game.receive(data); break;
      case 'snap': this.applySnap(data); break;
      case 'towers': this.applyTowers(data.tw || []); break;
      case 'lost': this.state = 'lost'; this.surrendered = !!data.surrender; break;
      case 'skill': this.events.push({ type: 'ability', id: data.id, hits: (data.h || []).map(([x, y, z, b]) => [-x / 100, y / 100, z / 100, b]) }); break;
      default: break;
    }
  }

  applySnap(d) {
    if (d.l < this.lives) this.events.push({ type: 'leak', dmg: this.lives - d.l });
    this.lives = d.l; this.eco = d.e; this.wave = d.w;
    const seen = new Set();
    for (const [rid, ti, x100, z100, hp, f] of d.en) {
      const id = rid + ID_OFFSET;
      seen.add(id);
      const type = ENEMY_KEYS[ti];
      if (!type) continue;
      let e = this.enemyMap.get(id);
      const tx = -x100 / 100, tz = z100 / 100;
      if (!e) {
        const def = ENEMIES[type];
        const air = !!(f & F_AIR);
        e = {
          id, type, def, air, boss: !!def.boss, cls: def.cls, remote: true,
          x: tx, z: tz, tx, tz, y: air ? 0.9 : 0, h: air ? 0.9 : def.radius * 1.1,
          dirX: 0, dirZ: 1, curSpeed: def.speed, hp: 1, maxHp: 1, shield: 0, maxShield: 0,
          phase: Math.random() * 6.28, frozen: false, stunTime: 0, slowAmt: 0, burnT: 0, burnStacks: 0, hitT: 0,
          cloakT: 0, detected: true, inWarp: false, markAmt: 0, revealedT: 0, radius: def.radius, dead: false,
        };
        this.enemyMap.set(id, e);
        this.enemies.push(e);
      }
      e.tx = tx; e.tz = tz;
      e.hp = hp / 100; e.maxHp = 1;
      e.frozen = !!(f & F_FROZEN);
      e.stunTime = f & F_STUN ? 0.2 : 0;
      e.burnT = f & F_BURN ? 0.3 : 0; e.burnStacks = e.burnT ? 1 : 0;
      e.detected = !(f & F_HIDDEN); e.cloakT = f & F_HIDDEN ? 1 : 0;
      e.inWarp = !!(f & F_WARP);
    }
    // vanished: killed (or leaked) on their side
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (seen.has(e.id)) continue;
      this.enemies.splice(i, 1);
      this.enemyMap.delete(e.id);
      e.dead = true;
      if (e.hp < 0.5) this.events.push({ type: 'kill', enemy: e, reward: 0 });
    }
  }

  applyTowers(list) {
    const seen = new Set();
    for (const [rid, ti, level, sc, col, row, rank] of list) {
      const id = rid + ID_OFFSET;
      seen.add(id);
      const type = TOWER_KEYS[ti];
      if (!type) continue;
      const spec = SPEC_OF[sc] || null;
      let t = this.towerMap.get(id);
      if (!t) {
        const c = VS_LEVEL.cols - 1 - col;
        const { x, z } = tileToWorld(VS_LEVEL, c, row);
        t = { id, type, def: TOWERS[type], level, spec, col: c, row, x, z, aim: Math.PI, rank: rank || 0, beams: [], flameOn: false,
          disabledT: 0, cd: Math.random(), stats: towerBaseStats(type, level, spec), remote: true, kills: 0, damage: 0 };
        t.stats.attack = t.stats.attack || TOWERS[type].attack;
        this.towerMap.set(id, t);
        this.towers.push(t);
        this.events.push({ type: 'build', tower: t });
      } else if (t.level !== level || t.spec !== spec) {
        t.level = level; t.spec = spec;
        t.stats = towerBaseStats(type, level, spec);
        t.stats.attack = t.stats.attack || TOWERS[type].attack;
        this.events.push({ type: 'upgrade', tower: t, ultimate: level >= 5 });
      }
      t.rank = rank || 0;
    }
    for (let i = this.towers.length - 1; i >= 0; i--) {
      const t = this.towers[i];
      if (seen.has(t.id)) continue;
      this.towers.splice(i, 1);
      this.towerMap.delete(t.id);
      this.events.push({ type: 'sell', tower: t });
    }
  }

  // ---------------------------------------------------------------- cosmetic motion & fire
  animate(dt) {
    const k = Math.min(1, dt * 7);
    for (const e of this.enemies) {
      const dx = e.tx - e.x, dz = e.tz - e.z, d = Math.hypot(dx, dz);
      if (d > 2.5) { e.x = e.tx; e.z = e.tz; continue; } // teleports (blink, warp exits)
      e.x += dx * k; e.z += dz * k;
      if (d > 0.01) { e.dirX = dx / d; e.dirZ = dz / d; }
      e.curSpeed = Math.min(1.6, (d * 7) / Math.max(0.2, e.def.speed));
      if (e.hitT > 0) e.hitT -= dt;
    }
    for (const t of this.towers) {
      const s = t.stats, range = (s.range || 2.5) + 0.2;
      let best = null, bd = range * range;
      for (const e of this.enemies) {
        if (e.inWarp || !e.detected) continue;
        if (e.air ? !t.def.air : !t.def.ground) continue;
        const d2 = (e.x - t.x) ** 2 + (e.z - t.z) ** 2;
        if (d2 < bd) { bd = d2; best = e; }
      }
      const attack = s.attack;
      t.flameOn = attack === 'flame' && !!best;
      if (attack === 'beam') {
        if (best) { if (!t.beams.length || t.beams[0].e !== best) t.beams = [{ e: best, time: 0 }]; t.beams[0].time += dt; } else t.beams.length = 0;
      }
      if (!best) continue;
      t.aim = Math.atan2(best.x - t.x, best.z - t.z);
      const kind = FIRE_KIND[attack];
      if (!kind || !s.rate) continue;
      t.cd -= dt;
      if (t.cd > 0) continue;
      t.cd = 1 / s.rate;
      this.events.push({ type: 'fire', tower: t, kind });
      best.hitT = 0.08;
      this.events.push({ type: 'hit', x: best.x, y: best.h, z: best.z, kind: kind === 'bullet' ? 'bullet' : 'shell', color: t.def.color });
    }
  }
}
