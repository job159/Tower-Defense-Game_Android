// Versus mode (2 players): rules, the mirrored map, send packs and the per-player game.
//
// Each player defends one lane of a mirror-symmetric map and may only build on their own half. Identical
// neutral waves hit both lanes on a shared clock; on top of that each player can SEND packs of enemies into
// the opponent's lane. Sending costs credits now but permanently raises your income ("eco", paid every few
// seconds) — the classic Bloons TD Battles / Legion TD tension between pressure, economy and defence.
// Units you receive pay a reduced bounty. Lose all lives and you lose the match.
//
// A VersusGame simulates one player's lane only. The opponent is either another VersusGame (practice vs AI,
// balance simulator) or a network mirror; `side` 0 is the left lane, 1 the right lane.
import { Game } from './sim.js';
import { generateWave, waveSpawns } from './waves.js';
import { ENEMIES, TOWER_ORDER } from './config.js';

export const VS_RULES = {
  lives: 40,
  startCredits: 600,
  baseEco: 25,           // income paid every `incomeEvery` seconds
  maxEco: 300,           // income cap: beyond it sends are pure pressure
  incomeEvery: 6,
  firstWave: 15,         // seconds of setup before neutral wave 1
  waveEvery: 25,         // seconds between neutral waves
  sendDelay: 1.6,        // seconds before a sent pack appears at the opponent's gate
  sentRewardMul: 0.5,    // bounty paid to the defender for sent units
  suddenDeathWave: 14,   // after this wave, neutral waves harden quickly so matches end
  suddenDeathHp: 0.4,    // +40% neutral hp per wave beyond suddenDeathWave
};

// Send packs: [unit] x count for `cost`, adds `eco` income per tick; available from neutral wave `unlock`.
// Three tiers: cheap packs grow eco best, specialists test the opponent's counters (air / shields / stealth),
// heavy packs hit hardest per credit but add little eco.
export const PACKS = [
  { id: 'scout',      type: 'scout',      count: 8, cost: 110, eco: 5,  unlock: 1,  cd: 1.5, tier: 'eco' },
  { id: 'walker',     type: 'walker',     count: 6, cost: 160, eco: 7,  unlock: 1,  cd: 2,   tier: 'eco' },
  { id: 'flyer',      type: 'flyer',      count: 5, cost: 180, eco: 6,  unlock: 2,  cd: 2.5, tier: 'spec' },
  { id: 'shield',     type: 'shield',     count: 4, cost: 190, eco: 6,  unlock: 3,  cd: 3,   tier: 'spec' },
  { id: 'phantom',    type: 'phantom',    count: 4, cost: 210, eco: 7,  unlock: 4,  cd: 3,   tier: 'spec' },
  { id: 'tank',       type: 'tank',       count: 3, cost: 240, eco: 6,  unlock: 6,  cd: 4,   tier: 'heavy' },
  { id: 'hive',       type: 'hive',       count: 2, cost: 230, eco: 5,  unlock: 8,  cd: 4,   tier: 'heavy' },
  { id: 'juggernaut', type: 'juggernaut', count: 2, cost: 300, eco: 7,  unlock: 10, cd: 6,   tier: 'heavy' },
  { id: 'colossus',   type: 'colossus',   count: 1, cost: 850, eco: 18, unlock: 14, cd: 20,  tier: 'heavy' },
];
export const PACK_BY_ID = Object.fromEntries(PACKS.map((p) => [p.id, p]));

// ---------------------------------------------------------------- map: 22 x 9, mirror-symmetric around x = 0
const COLS = 22, ROWS = 9;
const mirror = (wp) => wp.map(([c, r, f]) => (f ? [COLS - 1 - c, r, f] : [COLS - 1 - c, r]));
const LEFT = [[10, 0], [10, 1], [2, 1], [2, 4], [8, 4], [8, 7], [1, 7]];
const LEFT_AIR = [[10, 0], [6, 3], [3, 5], [1, 7]];
const mirrorTiles = (list) => [...list, ...list.map(([c, r, x]) => (x === undefined ? [COLS - 1 - c, r] : [COLS - 1 - c, r, x]))];

export const VS_POOL = { walker: 1, scout: 1, flyer: 3, shield: 4, berserker: 5, stalker: 6, phantom: 7, tank: 8, medic: 9, mirror: 10, regenerator: 11, splitter: 12, hive: 13, disruptor: 14, juggernaut: 16 };
export const VS_BOSSES = { 10: { type: 'colossus', hp: 0.45 }, 20: { type: 'mothership', hp: 0.6 } };

export const VS_LEVEL = {
  id: 900, name: '雙子要塞', en: 'TWIN BASTION', cols: COLS, rows: ROWS,
  versus: true, half: COLS / 2,
  paths: [LEFT, mirror(LEFT)],
  airPaths: [LEFT_AIR, mirror(LEFT_AIR)],
  voids: mirrorTiles([[0, 0], [0, 8]]),
  decor: mirrorTiles([[4, 8]]),
  nodes: mirrorTiles([[6, 2], [5, 6]]),
  waves: Infinity, credits: VS_RULES.startCredits, hp: 1,
  abilities: ['thunder', 'stasis'],
  pool: VS_POOL, bosses: VS_BOSSES, budget: 0.8,
};

export const DEFAULT_VS_LOADOUT = ['pulse', 'mortar', 'tesla', 'laser', 'sam', 'sensor'];

// Neutral wave composition: generated per match variant so both lanes get exactly the same waves.
function waveLevel(variant) {
  return { id: 900 + (variant % 97), paths: [LEFT], pool: VS_POOL, bosses: VS_BOSSES, budget: VS_LEVEL.budget };
}

export class VersusGame extends Game {
  constructor({ side = 0, seed = 1, loadout = DEFAULT_VS_LOADOUT, variant = seed } = {}) {
    super(VS_LEVEL, { difficulty: 'normal', seed: seed * 2 + side, loadout, research: {} });
    this.side = side;
    this.versus = true;
    this.variant = variant;
    if (side === 1) this.nextId = 1_000_000; // keep ids unique when both lanes are rendered together
    this.mods.ult = new Set(TOWER_ORDER); // standardised rules: every ultimate available, no research
    this.maxLives = this.lives = this.baseLives = VS_RULES.lives;
    this.credits = VS_RULES.startCredits;
    this.eco = VS_RULES.baseEco;
    this.ecoT = VS_RULES.incomeEvery;
    this.incomeMul = 1; // practice-AI handicap / bonus only; players are always 1
    this.nextWaveAt = VS_RULES.firstWave;
    this.packCd = {};
    this.outbox = [];
    Object.assign(this.stats, { sent: 0, sentValue: 0, received: 0, receivedValue: 0, income: 0, ecoMax: this.eco, leakedLives: 0 });
  }

  // ---------------------------------------------------------------- rules
  ownsCol(col) { return this.side === 0 ? col < VS_LEVEL.half : col >= VS_LEVEL.half; }

  canBuild(col, row, type) {
    if (!this.ownsCol(col)) return { ok: false, reason: '只能在自己的半場建造' };
    return super.canBuild(col, row, type);
  }

  canCallWave() { return false; }
  callWave() { return false; }
  peekWave() { return null; }
  timeToNextWave() { return Math.max(0, this.nextWaveAt - this.time); }

  waveHpMul(w) { return w > VS_RULES.suddenDeathWave ? 1 + VS_RULES.suddenDeathHp * (w - VS_RULES.suddenDeathWave) : 1; }

  enqueue(list) {
    const pending = this.queue.slice(this.qi).concat(list);
    pending.sort((a, b) => a.t - b.t);
    this.queue = pending;
    this.qi = 0;
  }

  startNeutralWave() {
    const t0 = this.nextWaveAt;
    this.wave++;
    this.nextWaveAt += VS_RULES.waveEvery;
    const wave = generateWave(waveLevel(this.variant), this.wave, 'normal');
    const hpMul = this.waveHpMul(this.wave);
    this.enqueue(waveSpawns(wave, 1).map((s) => ({ t: t0 + s.t, type: s.type, path: this.side, wave: this.wave, hp: s.hp * hpMul })));
    this.emit('waveStart', { wave: this.wave, boss: wave.boss, theme: wave.theme, neutral: true, interest: 0, early: false });
  }

  update(dt) {
    if (this.state !== 'play') return;
    const t = this.time + dt;
    while (t >= this.nextWaveAt) this.startNeutralWave();
    this.ecoT -= dt;
    while (this.ecoT <= 0) {
      this.ecoT += VS_RULES.incomeEvery;
      const pay = Math.round(this.eco * this.incomeMul);
      this.credits += pay;
      this.stats.earned += pay;
      this.stats.income += pay;
      this.emit('income', { amount: pay });
    }
    for (const id in this.packCd) if (this.packCd[id] > 0) this.packCd[id] = Math.max(0, this.packCd[id] - dt);
    const lives = this.lives;
    super.update(dt);
    if (this.lives < lives) this.stats.leakedLives += lives - this.lives;
  }

  // ---------------------------------------------------------------- sending
  packUnlocked(p) { return this.wave >= p.unlock; }

  canSend(id) {
    const p = PACK_BY_ID[id];
    if (!p || this.state !== 'play') return { ok: false, reason: '無法派兵' };
    if (!this.packUnlocked(p)) return { ok: false, reason: `第 ${p.unlock} 波解鎖` };
    if ((this.packCd[id] || 0) > 0) return { ok: false, reason: '冷卻中' };
    if (this.credits < p.cost) return { ok: false, reason: '資金不足' };
    return { ok: true };
  }

  // Pays for a pack and raises eco; returns the message to deliver to the opponent (also kept in outbox).
  send(id) {
    if (!this.canSend(id).ok) return null;
    const p = PACK_BY_ID[id];
    this.credits -= p.cost;
    this.eco = Math.min(VS_RULES.maxEco, this.eco + p.eco);
    this.packCd[id] = p.cd;
    this.stats.sent++;
    this.stats.sentValue += p.cost;
    this.stats.ecoMax = Math.max(this.stats.ecoMax, this.eco);
    const msg = { pack: id, wave: Math.max(1, this.wave) };
    this.outbox.push(msg);
    this.emit('send', { pack: p });
    return msg;
  }

  // Spawns a pack sent by the opponent at this lane's gate.
  receive({ pack, wave }) {
    const p = PACK_BY_ID[pack];
    if (!p || this.state !== 'play') return;
    const def = ENEMIES[p.type];
    const t0 = this.time + VS_RULES.sendDelay;
    const step = Math.max(0.3, def.interval * 0.45);
    const list = [];
    for (let i = 0; i < p.count; i++) {
      list.push({ t: t0 + i * step, type: p.type, path: this.side, wave: Math.max(1, wave | 0), hp: 1, sent: true, rewardMul: VS_RULES.sentRewardMul });
    }
    this.enqueue(list);
    this.stats.received++;
    this.stats.receivedValue += p.cost;
    this.emit('incoming', { pack: p });
  }
}
