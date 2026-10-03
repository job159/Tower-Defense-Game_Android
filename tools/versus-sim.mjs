#!/usr/bin/env node
// Headless versus balance simulator: bot vs bot on the real VersusGame rules.
//   node tools/versus-sim.mjs [--matches 20] [--a balanced] [--b balanced] [--level hard] [--matrix] [--verbose]
//                             [--sent hp,armor,speed,reward,sd] [--map <id|name|all>]
// Reports win rate per side/style, match length (avg and range), final eco, sends, towers and the share of lives
// lost to sent units (the rest leaked from neutral waves). Use it after changing VS_RULES, PACKS or neutral
// waves: mirror matches should stay near 50/50 (check a few seed sets — 16–40 matches still swing ±15%), every
// style must beat 'turtle', near-zero defence must lose, and matches should end in roughly 7–10 minutes.
// Maps: by default match i is played on map i % N (round-robin over all versus maps, so every series covers
// them all); --map 905 / --map "quantum leap" / --map 量子躍遷 plays one map; --map all prints one series per
// map (after adding or editing maps: lengths and mirror win rates should be alike across maps).
import { parseArgs } from 'node:util';
import { VersusGame, DEFAULT_VS_LOADOUT, VS_RULES, VS_MAPS } from '../game/src/core/versus.js';
import { VersusBot, BOT_STYLES } from '../game/src/core/versusBot.js';

const { values: args } = parseArgs({ options: {
  matches: { type: 'string', default: '20' }, a: { type: 'string', default: 'balanced' }, b: { type: 'string', default: 'balanced' },
  level: { type: 'string', default: 'normal' }, matrix: { type: 'boolean' }, verbose: { type: 'boolean' }, max: { type: 'string', default: '1500' },
  sent: { type: 'string' }, // try other sent-unit buffs without editing the rules: --sent hp,armor,speed,reward,sd
  map: { type: 'string' },
} });
if (args.sent) {
  const [hp, armor, speed, reward, sd = VS_RULES.sent.sd] = args.sent.split(',').map(Number);
  Object.assign(VS_RULES.sent, { hp, armor, speed, reward, sd });
}

function play(styleA, styleB, seed, level, map) {
  const A = new VersusGame({ side: 0, seed, loadout: DEFAULT_VS_LOADOUT, map });
  const B = new VersusGame({ side: 1, seed, loadout: DEFAULT_VS_LOADOUT, map });
  const ba = new VersusBot(A, { style: styleA, level, seed: seed * 3 + 1 });
  const bb = new VersusBot(B, { style: styleB, level, seed: seed * 3 + 2 });
  const dt = 1 / 30, maxT = Number(args.max);
  let t = 0;
  const ecoLog = [];
  // lives lost to the opponent's sends vs to neutral waves
  const lost = { A: { sent: 0, neutral: 0 }, B: { sent: 0, neutral: 0 } };
  while (A.state === 'play' && B.state === 'play' && t < maxT) {
    ba.update(dt, B); bb.update(dt, A);
    A.update(dt); B.update(dt);
    for (const m of A.outbox.splice(0)) B.receive(m);
    for (const m of B.outbox.splice(0)) A.receive(m);
    for (const [G, L] of [[A, lost.A], [B, lost.B]]) for (const ev of G.events) if (ev.type === 'leak') L[ev.enemy.sent ? 'sent' : 'neutral'] += ev.dmg;
    A.events.length = 0; B.events.length = 0;
    t += dt;
    if (Math.abs(t % 60) < dt) ecoLog.push(`${Math.round(t / 60)}m:${A.eco}/${B.eco}`);
  }
  const winner = A.state === 'lost' && B.state === 'lost' ? 'draw' : A.state === 'lost' ? 'B' : B.state === 'lost' ? 'A' : 'timeout';
  return { winner, t, wave: A.wave, A, B, ecoLog, lost };
}

function series(styleA, styleB, n, level, maps = VS_MAPS) {
  const res = { A: 0, B: 0, draw: 0, timeout: 0, t: 0, wave: 0, ecoA: 0, ecoB: 0, sentA: 0, sentB: 0, towersA: 0, towersB: 0, bySent: 0, byNeutral: 0, tMin: Infinity, tMax: 0 };
  for (let i = 0; i < n; i++) {
    const r = play(styleA, styleB, 1000 + i * 17, level, maps[i % maps.length]);
    res[r.winner]++;
    res.t += r.t; res.wave += r.wave;
    res.ecoA += r.A.eco; res.ecoB += r.B.eco; res.sentA += r.A.stats.sentValue; res.sentB += r.B.stats.sentValue;
    res.towersA += r.A.towers.length; res.towersB += r.B.towers.length;
    res.bySent += r.lost.A.sent + r.lost.B.sent; res.byNeutral += r.lost.A.neutral + r.lost.B.neutral;
    res.tMin = Math.min(res.tMin, r.t); res.tMax = Math.max(res.tMax, r.t);
    if (args.verbose) console.log(`  #${i} ${r.winner} ${Math.round(r.t)}s w${r.wave} lives ${r.A.lives}/${r.B.lives} (sends ${r.lost.A.sent}/${r.lost.B.sent}) eco ${r.A.eco}/${r.B.eco} sent ${r.A.stats.sentValue}/${r.B.stats.sentValue} towers ${r.A.towers.length}/${r.B.towers.length}  ${r.ecoLog.join(' ')}`);
  }
  const k = (v) => (v / n).toFixed(0);
  return { ...res, line: `${styleA.padEnd(8)} vs ${styleB.padEnd(8)}  A ${String(res.A).padStart(2)} · B ${String(res.B).padStart(2)} · draw ${res.draw} · t/o ${res.timeout}   avg ${k(res.t)}s w${(res.wave / n).toFixed(1)}  eco ${k(res.ecoA)}/${k(res.ecoB)}  sent ${k(res.sentA)}/${k(res.sentB)}  towers ${(res.towersA / n).toFixed(1)}/${(res.towersB / n).toFixed(1)}  ${Math.round(res.tMin)}-${Math.round(res.tMax)}s  lives lost to sends ${Math.round((100 * res.bySent) / Math.max(1, res.bySent + res.byNeutral))}%` };
}

// --map: an id, an English or Chinese name (case/space-insensitive, a prefix is enough) or 'all'
function findMap(q) {
  const k = String(q).toLowerCase().replace(/\s+/g, '');
  const m = VS_MAPS.find((x) => String(x.id) === k || x.name === q || x.en.toLowerCase().replace(/\s+/g, '').startsWith(k));
  if (!m) { console.error(`unknown map "${q}"; maps: ${VS_MAPS.map((x) => `${x.id} ${x.en} ${x.name}`).join(' | ')}`); process.exit(1); }
  return m;
}
const runAll = (maps, prefix = '') => {
  if (args.matrix) {
    const styles = Object.keys(BOT_STYLES);
    for (const a of styles) for (const b of styles) if (a <= b) console.log(prefix + series(a, b, n, args.level, maps).line);
  } else {
    console.log(prefix + series(args.a, args.b, n, args.level, maps).line);
  }
};

const n = Number(args.matches);
if (args.map === 'all') for (const m of VS_MAPS) runAll([m], `${m.id} ${m.en.padEnd(15)} `);
else if (args.map) { const m = findMap(args.map); console.log(`map ${m.id} ${m.name} ${m.en}`); runAll([m]); }
else runAll(VS_MAPS);
