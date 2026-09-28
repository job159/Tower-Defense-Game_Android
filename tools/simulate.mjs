// Headless balance check: a scripted bot plays every level. Usage:
//   node tools/simulate.mjs [--level 3] [--diff normal|hard|nightmare|all] [--research auto|none|full] [--verbose] [--seeds 3]
import { Game, unlockedTowers } from '../game/src/core/sim.js';
import { LEVELS } from '../game/src/core/levels.js';
import { TOWERS, RESEARCH, LOADOUT_SIZE } from '../game/src/core/config.js';
import { TILE } from '../game/src/core/path.js';
import { levelThreats } from '../game/src/core/waves.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const onlyLevel = opt('level', null);
const diffArg = opt('diff', 'normal');
const difficulties = diffArg === 'all' ? ['normal', 'hard', 'nightmare'] : [diffArg];
const researchMode = opt('research', 'auto');
const verbose = !!opt('verbose', false);
const seeds = Number(opt('seeds', 1));

const SPEC = { pulse: 'a', mortar: 'a', cryo: 'b', tesla: 'a', laser: 'b', sam: 'a', amp: 'a', inferno: 'a', carrier: 'a', sensor: 'a', mines: 'b' };
const MIX = { pulse: 3, mortar: 2, cryo: 1, tesla: 1.6, laser: 2, inferno: 1.6, sam: 1.5, sensor: 0.5, amp: 0.6, carrier: 1.4, mines: 1 };
const RESEARCH_ORDER = ['credits', 'damage', 'lives', 'ult_pulse', 'interest', 'range', 'ult_laser', 'credits', 'damage', 'ult_mortar', 'bounty', 'discount', 'thunder', 'ult_tesla', 'cooldown', 'damage', 'range', 'ult_sam', 'ult_inferno', 'ult_carrier', 'ult_cryo', 'ult_amp', 'veteran', 'refund', 'credits', 'thunder', 'interest', 'bounty', 'discount', 'lives', 'cooldown', 'veteran', 'refund', 'ult_sensor', 'ult_mines'];

function researchFor(levelId, mode) {
  if (mode === 'none') return {};
  const budget = mode === 'full' ? 999 : Math.round((levelId - 1) * 3.2);
  const res = {};
  let left = budget;
  for (const id of RESEARCH_ORDER) {
    const r = RESEARCH.find((x) => x.id === id);
    const lv = res[id] || 0;
    if (lv >= r.costs.length) continue;
    if (r.costs[lv] > left) break;
    left -= r.costs[lv];
    res[id] = lv + 1;
  }
  return res;
}

function chooseLoadout(level) {
  const pool = unlockedTowers(level.id);
  const { types, bosses } = levelThreats(level);
  const has = (t) => types.includes(t) || bosses.includes(t);
  const want = ['pulse', 'mortar'];
  if (has('flyer') || has('hive') || has('mothership') || has('queen')) want.push('sam');
  if (has('phantom') || has('queen')) want.push('sensor');
  want.push('laser', 'tesla', 'inferno', 'carrier', 'cryo', 'mines', 'amp');
  return [...new Set(want)].filter((t) => pool.includes(t)).slice(0, LOADOUT_SIZE);
}

const RANGES = [1.6, 1.9, 2.1, 2.4, 2.6, 2.8, 3.0, 3.4, 3.8, 4.0, 4.6];
const rangeKey = (range) => RANGES.reduce((a, b) => (Math.abs(b - range) < Math.abs(a - range) ? b : a));

function coverageMap(game) {
  const { level, map } = game;
  const cov = new Map();
  const lanes = [...map.paths, ...map.airPaths].map((p) => {
    const out = [];
    for (let d = 0; d < p.length; d += 0.25) { if (p.inWarp(d)) continue; const q = p.sample(d, { x: 0, z: 0 }); out.push([q.x, q.z, d / p.length]); }
    return out;
  });
  for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
    const t = map.at(c, r);
    if (t !== TILE.BUILD && t !== TILE.WRECK) continue;
    const x = c - (level.cols - 1) / 2, z = r - (level.rows - 1) / 2;
    const byRange = {};
    for (const R of RANGES) {
      byRange[R] = lanes.map((samples) => {
        let n = 0;
        for (const [sx, sz, f] of samples) if ((sx - x) ** 2 + (sz - z) ** 2 <= R * R) n += 1 + f * 0.5;
        return n;
      });
    }
    cov.set(r * level.cols + c, { c, r, x, z, byRange, node: map.isNode(c, r) });
  }
  return cov;
}

function laneWeights(game, type) {
  const def = TOWERS[type];
  const ng = game.map.paths.length;
  const airShare = game.level.airWaves ? 0.8 : game.level.pool.flyer ? 0.35 : 0;
  return [...game.map.paths, ...game.map.airPaths].map((_, i) => {
    const air = i >= ng;
    if (air) return def.air ? airShare * (type === 'sam' ? 3 : 1) : 0;
    return def.ground ? (type === 'sam' ? 0.4 : 1) : 0;
  });
}

function laneStrength(game, cov) {
  const n = game.map.paths.length + game.map.airPaths.length;
  const str = new Array(n).fill(0);
  for (const t of game.towers) {
    if (t.type === 'amp' || t.type === 'sensor') continue;
    const cv = cov.get(t.row * game.level.cols + t.col);
    if (!cv) continue;
    const lanes = cv.byRange[rangeKey(t.stats.range)];
    const w = laneWeights(game, t.type);
    for (let i = 0; i < n; i++) str[i] += lanes[i] * t.invested * w[i];
  }
  return str;
}

function bestTile(game, cov, type) {
  const range = TOWERS[type].levels[0].range || 2.4;
  const key = rangeKey(range);
  const str = laneStrength(game, cov);
  const total = str.reduce((a, b) => a + b, 0) || 1;
  let best = null, bs = -1;
  for (const [i, t] of cov) {
    if (game.towerAt.has(i) || game.map.at(t.c, t.r) !== TILE.BUILD) continue;
    let s = 0;
    if (type === 'amp') {
      for (const o of game.towers) if (o.type !== 'amp' && Math.hypot(o.x - t.x, o.z - t.z) <= 1.5) s += o.invested;
    } else if (type === 'sensor') {
      s = t.byRange[rangeKey(3.2)].reduce((a, b) => a + b, 0);
      for (const o of game.towers) if (o.type === 'sensor') s -= 30 / (0.5 + Math.hypot(o.x - t.x, o.z - t.z));
    } else {
      const lanes = t.byRange[key];
      const w = laneWeights(game, type);
      for (let k = 0; k < lanes.length; k++) s += lanes[k] * w[k] * (1.5 - str[k] / total);
    }
    if (t.node) s *= 1.25;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

function botStep(game, cov, st) {
  const enemies = game.enemies;
  if (enemies.length) {
    const nearCore = enemies.some((e) => e.path.length - e.dist < 5);
    if (game.abilities.stasis && game.abilities.stasis.cd <= 0 && nearCore && enemies.length >= 6) game.useAbility('stasis');
    // thunder: wait for a crowd (or a boss / a leak about to happen) so one cast hits as much as possible
    const boss = enemies.some((e) => e.boss);
    if (game.abilities.thunder && game.abilities.thunder.cd <= 0 && (enemies.length >= 14 || (nearCore && enemies.length >= 6) || boss)) game.useAbility('thunder');
  }
  const counts = {};
  for (const t of game.towers) counts[t.type] = (counts[t.type] || 0) + 1;
  // sensors before cloaked enemies arrive
  const bossWaves = Object.entries(game.level.bosses);
  const cloakSoon = (game.level.pool.phantom || 99) <= game.wave + 1 || bossWaves.some(([w, b]) => (b.type === 'queen' || b.extra === 'queen') && +w <= game.wave + 1);
  if (cloakSoon && game.loadout.includes('sensor') && (counts.sensor || 0) < game.map.paths.length && game.credits >= game.buildCost('sensor')) {
    const tile = bestTile(game, cov, 'sensor');
    if (tile) game.build(tile.c, tile.r, 'sensor');
  }
  // clear wrecks that hide power nodes when rich
  for (const w of [...game.map.wrecks.values()]) if (game.credits > game.wreckCost(w) + 350 && (game.map.isNode(w.col, w.row) || game.wave > 8)) game.clearWreck(w.col, w.row);
  for (let guard = 0; guard < 6; guard++) {
    const target = 3 + game.wave * 0.55 + (game.map.paths.length - 1) * 2;
    const wantBuild = game.towers.length < target;
    let did = false;
    if (wantBuild) {
      let bestType = null, need = -Infinity;
      for (const type of game.loadout) {
        if (type === 'sensor') continue;
        if (type === 'amp' && game.towers.length < 8) continue;
        const score = -(counts[type] || 0) / (MIX[type] || 1);
        if (score > need) { need = score; bestType = type; }
      }
      if (bestType && game.credits < game.buildCost(bestType) && game.towers.length < target - 2) bestType = 'pulse';
      if (bestType && game.credits >= game.buildCost(bestType)) {
        const tile = bestTile(game, cov, bestType);
        if (tile && game.build(tile.c, tile.r, bestType)) { did = true; counts[bestType] = (counts[bestType] || 0) + 1; }
      } else if (bestType) break;
    }
    if (!did) {
      let pick = null, pc = Infinity;
      for (const t of game.towers) {
        const spec = t.level >= 3 ? (t.spec || SPEC[t.type]) : undefined;
        const chk = game.canUpgrade(t, spec);
        if (!chk.ok && chk.reason !== '資金不足') continue;
        const c = game.upgradeCostOf(t, spec);
        if (c < pc) { pc = c; pick = [t, spec]; }
      }
      if (pick && game.credits >= pc && (!wantBuild || game.credits > pc + 150)) { game.upgrade(pick[0], pick[1]); did = true; }
    }
    if (!did) break;
  }
  if (game.canCallWave() && (game.wave === 0 || game.enemies.length === 0)) game.callWave();
}

function run(level, difficulty, seed) {
  const research = researchFor(level.id, researchMode);
  const lo = opt('loadout', null);
  const game = new Game(level, { difficulty, research, seed, loadout: lo ? lo.split(',') : chooseLoadout(level) });
  const cov = coverageMap(game);
  const dt = 1 / 30;
  let t = 0, nextBot = 0;
  let maxEnemies = 0;
  const livesLog = [];
  const st = {};
  while (game.state === 'play' && t < 4000) {
    if (t >= nextBot) { botStep(game, cov, st); nextBot = t + 0.25; }
    game.update(dt);
    t += dt;
    maxEnemies = Math.max(maxEnemies, game.enemies.length);
    for (const ev of game.events) if (ev.type === 'waveStart' && verbose) livesLog.push(`w${ev.wave}:${Math.ceil(game.lives)}/${Math.round(game.credits)}${ev.interest ? '+' + ev.interest : ''}`);
    game.events.length = 0;
  }
  return { game, t, maxEnemies, livesLog };
}

const levels = onlyLevel ? LEVELS.filter((l) => l.id === Number(onlyLevel)) : LEVELS;
for (const difficulty of difficulties) {
  for (const level of levels) {
    for (let sd = 0; sd < seeds; sd++) {
      const t0 = performance.now();
      const { game, t, maxEnemies, livesLog } = run(level, difficulty, 12345 + sd * 101);
      const ms = performance.now() - t0;
      const res = game.state === 'won' ? `WIN ${game.stars()}★${game.challengeMet() ? '+C' : ''}` : game.state === 'lost' ? `LOSE @w${game.wave}` : 'TIMEOUT';
      console.log(`L${String(level.id).padEnd(2)} ${difficulty.padEnd(9)} ${res.padEnd(12)} lives ${String(Math.ceil(game.lives)).padStart(2)}/${game.maxLives} towers ${String(game.towers.length).padStart(2)} kills ${String(game.stats.kills).padStart(4)} max ${String(maxEnemies).padStart(3)} skills ${game.stats.abilityUses}  ${Math.round(t)}s/${Math.round(ms)}ms  [${game.loadout.join(',')}]`);
      if (verbose) {
        const counts = {};
        for (const tw of game.towers) counts[tw.type + tw.level] = (counts[tw.type + tw.level] || 0) + 1;
        console.log('   ', Object.entries(counts).map(([k, v]) => `${k}x${v}`).join(' '));
        console.log('   ', livesLog.join(' '));
        const dmg = {}, inv = {};
        for (const tw of game.towers) { dmg[tw.type] = (dmg[tw.type] || 0) + tw.damage; inv[tw.type] = (inv[tw.type] || 0) + tw.invested; }
        console.log('    dmg/credit', Object.entries(dmg).map(([k, v]) => `${k}:${Math.round(v / 1000)}k${inv[k] ? '/' + (v / inv[k]).toFixed(1) : ''}`).join(' '));
      }
    }
  }
}
