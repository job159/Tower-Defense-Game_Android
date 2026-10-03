// Versus AI: defends its lane and sends packs. Used by the practice mode and the balance simulator.
//
// Each think step it compares its tower investment with how much defence the match calls for (time,
// incoming sends, recent leaks). Short of that it builds/upgrades; otherwise it invests in sends, picking
// packs the opponent's towers handle worst. Styles shift the defence/eco balance; levels set reaction speed
// and how well it reads the opponent.
import { TOWERS } from './config.js';
import { TILE } from './path.js';
import { PACKS, PACK_BY_ID, VS_LEVEL, VS_RULES } from './versus.js';
import { mulberry32 } from './rng.js';

// share: fraction of everything earned that goes into towers (the rest funds sends)
export const BOT_STYLES = {
  balanced: { defense: 1.0, share: 0.62, reserve: 60, pressure: 0.5 },
  eco:      { defense: 0.88, share: 0.5, reserve: 30, pressure: 0.2 },
  turtle:   { defense: 1.3, share: 0.85, reserve: 120, pressure: 0.4 },
  rush:     { defense: 0.82, share: 0.48, reserve: 20, pressure: 1.0 },
};
// income: practice-AI income multiplier (a handicap for easy, a bonus for hard); sloppy: placement noise
export const BOT_LEVELS = {
  easy:   { think: 2.4, read: 0.0, defense: 0.9, sendGap: 6, income: 0.75, sloppy: 0.6 },
  normal: { think: 0.8, read: 0.6, defense: 1.0, sendGap: 2.5, income: 1, sloppy: 0.1 },
  hard:   { think: 0.35, read: 1.0, defense: 1.05, sendGap: 1, income: 1.15, sloppy: 0 },
};
// preferred specialisation per tower (level 4) — the strongest general pick of each
const SPEC = { pulse: 'a', mortar: 'a', cryo: 'b', tesla: 'a', laser: 'b', inferno: 'a', sam: 'a', sensor: 'a', amp: 'a', carrier: 'b', mines: 'b' };
const RANGE_GUESS = (type) => (TOWERS[type].levels[0].range || 2.5) + 0.3;
const VS_START = VS_RULES.startCredits;

export class VersusBot {
  constructor(game, { style = 'balanced', level = 'normal', seed = 1 } = {}) {
    this.g = game;
    this.style = BOT_STYLES[style] || BOT_STYLES.balanced;
    this.lv = BOT_LEVELS[level] || BOT_LEVELS.normal;
    this.rand = mulberry32(seed * 131 + 7);
    game.incomeMul = this.lv.income;
    this.t = 0;
    this.next = 0.5 + this.rand() * 0.5;
    this.lastSend = -99;
    this.leakLog = [];
    this.lastLives = game.lives;
    this.recv = [];
    this.recvValue = 0;
    this.tiles = this.scoreTiles();
  }

  // Coverage of this lane (ground and air route) from every buildable tile of our half, per range.
  scoreTiles() {
    const g = this.g, lv = g.level, out = [];
    const ground = g.map.paths[g.side], air = g.map.airPaths[g.side];
    const sampleRoute = (path) => { const pts = []; const P = { x: 0, z: 0, dx: 0, dz: 0 }; for (let d = 0.8; d < path.length; d += 0.25) { path.sample(d, P); pts.push([P.x, P.z, d / path.length]); } return pts; };
    const gs = sampleRoute(ground), as = sampleRoute(air);
    for (let r = 0; r < lv.rows; r++) for (let c = 0; c < lv.cols; c++) {
      if (!g.ownsCol(c) || g.map.at(c, r) !== TILE.BUILD) continue;
      const x = c - (lv.cols - 1) / 2, z = r - (lv.rows - 1) / 2;
      const cov = (pts, range) => { let n = 0; for (const [px, pz, f] of pts) if ((px - x) ** 2 + (pz - z) ** 2 <= range * range) n += 0.6 + f * 0.8; return n; };
      out.push({ c, r, node: g.map.isNode(c, r), cov: (type) => {
        const range = RANGE_GUESS(type);
        const def = TOWERS[type];
        let s = def.ground !== false ? cov(gs, range) : 0;
        if (def.air) s += cov(as, range) * (type === 'sam' ? 1.6 : 0.5);
        if (type === 'amp') s = 0;
        return s * (g.map.isNode(c, r) && type !== 'amp' ? 1.25 : 1);
      } });
    }
    return out;
  }

  invested() { let s = 0; for (const t of this.g.towers) s += t.invested; return s; }

  // How much tower value the bot wants right now.
  defenseNeed() {
    const g = this.g;
    const w = Math.max(1, g.wave + (g.timeToNextWave() < 10 ? 1 : 0));
    const recent = this.recv.filter((r) => r.t > this.t - 45).reduce((s, r) => s + r.value, 0);
    const leaks = this.leakLog.filter((x) => x.t > this.t - 30).reduce((s, x) => s + x.n, 0);
    // enemies already deep in our lane mean the defence is not keeping up
    const deep = g.enemies.filter((e) => e.dist / e.path.length > 0.6).length;
    let need = (120 + 120 * Math.pow(w, 1.15)) + recent * 0.9;
    need *= this.style.defense * this.lv.defense * (1 + Math.min(0.6, leaks * 0.06) + Math.min(0.4, deep * 0.04));
    // a good player turns extra income into defence too: keep a fixed share of everything earned in towers
    const earned = g.stats.earned + VS_START;
    return Math.max(need, earned * this.style.share * this.lv.defense);
  }

  // Which tower type to add next given what we have and what is coming.
  nextTowerType() {
    const g = this.g, have = {};
    for (const t of g.towers) have[t.type] = (have[t.type] || 0) + 1;
    const L = g.loadout;
    const want = [];
    const airSoon = g.wave >= 2;
    const cloakSoon = g.wave >= 4;
    if (L.includes('sensor') && cloakSoon && !have.sensor) return 'sensor';
    if (L.includes('sam') && airSoon && (have.sam || 0) < 1 + Math.floor(g.wave / 7)) return 'sam';
    for (const t of L) if (t !== 'sensor' && t !== 'amp') want.push(t);
    want.sort((a, b) => (have[a] || 0) - (have[b] || 0) || L.indexOf(a) - L.indexOf(b));
    return want[0];
  }

  bestTile(type) {
    let best = null, bs = 0;
    for (const t of this.tiles) {
      if (this.g.towerOn(t.c, t.r) || !this.g.canBuild(t.c, t.r, type).ok) continue;
      const s = t.cov(type) * (1 + (this.rand() - 0.5) * 2 * this.lv.sloppy);
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  }

  tryDefend() {
    const g = this.g;
    const count = g.towers.length;
    const maxTowers = 4 + Math.floor(g.wave * 0.6); // favour upgrades over sprawl (also keeps phones fast)
    // upgrade the best-placed affordable tower when we already have enough of them
    const upgradable = g.towers.filter((t) => t.level < 5 && g.canUpgrade(t, t.level === 3 ? SPEC[t.type] : t.spec).ok);
    if (count >= maxTowers && upgradable.length) {
      upgradable.sort((a, b) => a.level - b.level || b.damage - a.damage);
      const t = upgradable[0];
      return !!g.upgrade(t, t.level === 3 ? SPEC[t.type] : t.spec);
    }
    const type = this.nextTowerType();
    if (type && g.credits >= g.buildCost(type)) {
      const tile = this.bestTile(type);
      if (tile) return !!g.build(tile.c, tile.r, type);
    }
    if (upgradable.length) {
      upgradable.sort((a, b) => a.level - b.level || b.damage - a.damage);
      const t = upgradable[0];
      return !!g.upgrade(t, t.level === 3 ? SPEC[t.type] : t.spec);
    }
    return false;
  }

  // Score each available pack: eco efficiency plus how badly the opponent's towers handle it.
  choosePack(opp) {
    const g = this.g;
    const oppTypes = new Set((opp && opp.towers || []).map((t) => t.type));
    const weak = {
      flyer: !oppTypes.has('sam') && !oppTypes.has('carrier'),
      hive: !oppTypes.has('sam'),
      phantom: !oppTypes.has('sensor'),
      shield: !oppTypes.has('tesla'),
      tank: !oppTypes.has('laser') && !oppTypes.has('inferno'),
      juggernaut: !oppTypes.has('laser'),
    };
    let best = null, bs = -1;
    for (const p of PACKS) {
      if (!g.canSend(p.id).ok) continue;
      const eco = p.eco / p.cost;
      let s = eco * 100 * (1 - this.style.pressure) + (p.cost / 300) * this.style.pressure;
      if (weak[p.id]) s *= 1 + 0.9 * this.lv.read;
      s *= 0.85 + this.rand() * 0.3;
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  useSkills() {
    const g = this.g;
    if (!g.enemies.length) return;
    const nearCore = g.enemies.filter((e) => e.path.length - e.dist < 6).length;
    if (g.abilities.thunder && g.abilities.thunder.cd <= 0 && (g.enemies.length >= 16 || nearCore >= 6 || g.enemies.some((e) => e.boss))) g.useAbility('thunder');
    if (g.abilities.stasis && g.abilities.stasis.cd <= 0 && nearCore >= 5) g.useAbility('stasis');
  }

  // opp: the opponent's game (or any object exposing `towers`) for reading their defence.
  update(dt, opp) {
    const g = this.g;
    if (g.state !== 'play') return;
    this.t += dt;
    if (g.lives < this.lastLives) this.leakLog.push({ t: this.t, n: this.lastLives - g.lives });
    this.lastLives = g.lives;
    // remember packs received (what the opponent is throwing at us)
    if (g.stats.receivedValue > this.recvValue) { this.recv.push({ t: this.t, value: g.stats.receivedValue - this.recvValue }); this.recvValue = g.stats.receivedValue; }
    if (this.t < this.next) return;
    this.next = this.t + this.lv.think * (0.8 + this.rand() * 0.4);
    this.useSkills();
    for (let guard = 0; guard < 4; guard++) {
      const short = this.invested() < this.defenseNeed();
      if (short) { if (!this.tryDefend()) break; continue; }
      if (g.credits < this.style.reserve || this.t - this.lastSend < this.lv.sendGap * (1 - this.style.pressure * 0.5)) break;
      const p = this.choosePack(opp);
      if (!p || g.credits - p.cost < this.style.reserve) break;
      g.send(p.id);
      this.lastSend = this.t;
    }
  }
}

export { PACK_BY_ID, VS_LEVEL };
