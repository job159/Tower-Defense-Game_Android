// Deterministic wave composer. A wave is a list of spawn groups built from a threat budget.
import { ENEMIES } from './config.js';
import { mulberry32, pickWeighted, pick } from './rng.js';

export const DIFFICULTY = {
  // hp trimmed when player power was removed: orbital strike / overclock (v2.0.1), commander mech (v2.1)
  normal:    { name: '普通', hp: 0.84, speed: 1, budget: 1, lives: 20, credits: 1, armor: 0, mutators: 0 },
  hard:      { name: '困難', hp: 1.1, speed: 1.08, budget: 1.12, lives: 12, credits: 1.1, armor: 1, mutators: 0 },
  nightmare: { name: '惡夢', hp: 1.26, speed: 1.12, budget: 1.2, lives: 10, credits: 1.25, armor: 1, mutators: 2 },
};
export const DIFFICULTY_ORDER = ['normal', 'hard', 'nightmare'];

// Nightmare adds seeded mutators per level.
export const MUTATORS = {
  regen:    { name: '自我修復', desc: '所有敵人每秒回復 1% 生命' },
  shielded: { name: '能量護甲', desc: '所有敵人附加 25% 生命值的護盾' },
  swift:    { name: '急行軍', desc: '敵人速度 +12%' },
  armored:  { name: '強化裝甲', desc: '敵人護甲 +2' },
};

export function levelMutators(level, difficulty) {
  const n = DIFFICULTY[difficulty].mutators;
  if (!n) return [];
  const rand = mulberry32(level.id * 131 + 17);
  const keys = Object.keys(MUTATORS);
  const out = [];
  while (out.length < n) {
    const k = pick(rand, keys);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function hpScale(w) {
  return 1 + 0.1 * (w - 1) + 0.004 * (w - 1) * (w - 1);
}

export function waveBudget(w) {
  return 11 + 4.6 * w + 0.12 * w * w;
}

export function waveIncome(w) {
  return 12 + 2 * w;
}

export function earlyBonus(w) {
  return 6 + w;
}

const GROUP_CAP = 30;

const ENDLESS_POOL = { walker: 1, scout: 1, berserker: 2, flyer: 3, shield: 4, phantom: 5, medic: 6, mirror: 6, stalker: 7, tank: 8, disruptor: 9, regenerator: 10, splitter: 10, hive: 12, juggernaut: 14 };
const ENDLESS_BOSSES = ['colossus', 'mothership', 'dreadnought', 'queen', 'omega'];

const THEMES = {
  swarm:   { name: '蜂群', types: ['scout', 'stalker', 'berserker', 'walker'], budget: 1.15 },
  armor:   { name: '重甲', types: ['tank', 'juggernaut', 'shield', 'walker', 'regenerator'], budget: 1.0 },
  air:     { name: '空襲', types: ['flyer', 'hive'], budget: 0.95 },
  stealth: { name: '潛行', types: ['phantom', 'stalker', 'scout'], budget: 1.0 },
  siege:   { name: '攻城', types: ['disruptor', 'juggernaut', 'medic', 'regenerator'], budget: 1.05 },
  mirror:  { name: '鏡陣', types: ['mirror', 'shield', 'medic'], budget: 1.0 },
};

// Returns { groups: [{type, count, interval, delay, path, hp}], theme, boss }
export function generateWave(level, w, difficulty = 'normal', endless = false) {
  const rand = mulberry32(level.id * 7919 + w * 104729 + (endless ? 13 : 0) + (difficulty === 'nightmare' ? 7 : 0));
  const diff = DIFFICULTY[difficulty];
  const pool = endless ? ENDLESS_POOL : level.pool;
  const nPaths = level.paths.length;
  const available = Object.keys(pool).filter((t) => pool[t] <= w);
  let budget = waveBudget(w) * diff.budget * (endless ? 1 + w * 0.004 : level.budget || 1);
  const groups = [];
  let theme = null;
  let boss = null;

  const bossDef = endless
    ? (w % 10 === 0 ? { type: ENDLESS_BOSSES[(w / 10 - 1) % ENDLESS_BOSSES.length], hp: 0.7 + w * 0.012 } : null)
    : level.bosses[w];

  if (bossDef) {
    boss = bossDef.type;
    groups.push({ type: bossDef.type, count: 1, interval: 3, delay: 4, path: 0, hp: bossDef.hp });
    if (bossDef.extra) groups.push({ type: bossDef.extra, count: 1, interval: 3, delay: 14, path: nPaths > 1 ? 1 : 0, hp: bossDef.hp });
    budget *= 0.45;
  } else if (w >= 5 && w % 5 === 0) {
    const options = Object.keys(THEMES).filter((k) => {
      const ok = THEMES[k].types.filter((t) => available.includes(t));
      if (k === 'air') return ok.length && w - pool.flyer >= 3;
      return ok.length >= 2;
    });
    if (options.length) {
      theme = level.airWaves && options.includes('air') && w % 10 === 0 ? 'air' : pick(rand, options);
      budget *= THEMES[theme].budget;
    }
  }

  // Choose group types; a freshly unlocked type is introduced as a smaller share of the wave.
  let types;
  let fresh = null;
  if (theme) {
    types = THEMES[theme].types.filter((t) => available.includes(t));
  } else {
    const k = Math.min(available.length, w <= 1 ? 1 : w < 7 ? 2 : rand() < 0.55 ? 3 : 2);
    types = [];
    const freshList = available.filter((t) => pool[t] > 1 && w - pool[t] <= 1);
    if (freshList.length) { fresh = freshList[0]; types.push(fresh); }
    while (types.length < k) {
      const rest = available.filter((x) => !types.includes(x));
      if (!rest.length) break;
      types.push(pickWeighted(rand, rest, (x) => 1 + (w - pool[x]) * 0.05));
    }
  }

  const weights = types.map((t) => (t === fresh && types.length > 1 ? 0.45 : 0.7 + rand() * 0.8));
  const wsum = weights.reduce((a, b) => a + b, 0);
  let delay = groups.length ? 0.5 : 1;
  const density = Math.max(0.5, 1 - w * 0.012);
  types.forEach((type, i) => {
    const def = ENEMIES[type];
    let count = Math.max(1, Math.round((budget * weights[i]) / wsum / def.threat));
    // keep entity counts phone-friendly: excess budget becomes tougher (elite) units
    let hp = 1;
    if (count > GROUP_CAP) { hp = count / GROUP_CAP; count = GROUP_CAP; }
    const interval = def.interval * density * (0.85 + rand() * 0.3);
    const path = nPaths > 1 ? (i + w) % nPaths : 0;
    groups.push({ type, count, interval, delay, path, split: nPaths > 1 && count >= 6, hp });
    delay += count * interval * 0.55 + 1.5;
  });

  return { groups, theme: theme ? THEMES[theme].name : null, boss };
}

// Flatten a wave into time-sorted spawn events relative to wave start.
export function waveSpawns(wave, nPaths) {
  const list = [];
  for (const g of wave.groups) {
    for (let i = 0; i < g.count; i++) {
      const path = g.split ? (g.path + i) % nPaths : g.path;
      list.push({ t: g.delay + i * g.interval, type: g.type, path, hp: g.hp || 1 });
    }
  }
  list.sort((a, b) => a.t - b.t);
  return list;
}

// Summary for the "next wave" preview: [{type, count}]
export function waveSummary(wave) {
  const map = new Map();
  for (const g of wave.groups) map.set(g.type, (map.get(g.type) || 0) + g.count);
  return [...map.entries()].map(([type, count]) => ({ type, count }));
}

// Every enemy type that can appear in a level (for the pre-battle intel screen).
export function levelThreats(level, endless = false) {
  const pool = endless ? ENDLESS_POOL : level.pool;
  const types = Object.keys(pool).sort((a, b) => pool[a] - pool[b]);
  const bosses = endless ? ENDLESS_BOSSES : [...new Set(Object.values(level.bosses).flatMap((b) => [b.type, b.extra].filter(Boolean)))];
  return { types, bosses };
}
