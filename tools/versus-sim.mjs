#!/usr/bin/env node
// Headless versus balance simulator: bot vs bot on the real VersusGame rules.
//   node tools/versus-sim.mjs [--matches 20] [--a balanced] [--b balanced] [--level hard] [--matrix] [--verbose]
// Reports win rate per side/style, match length, final eco, sends and leaks. Use it after changing VS_RULES,
// PACKS or neutral waves: mirror matches should stay near 50/50 and no single style should dominate.
import { parseArgs } from 'node:util';
import { VersusGame, DEFAULT_VS_LOADOUT } from '../game/src/core/versus.js';
import { VersusBot, BOT_STYLES } from '../game/src/core/versusBot.js';

const { values: args } = parseArgs({ options: {
  matches: { type: 'string', default: '20' }, a: { type: 'string', default: 'balanced' }, b: { type: 'string', default: 'balanced' },
  level: { type: 'string', default: 'normal' }, matrix: { type: 'boolean' }, verbose: { type: 'boolean' }, max: { type: 'string', default: '1500' },
} });

function play(styleA, styleB, seed, level) {
  const A = new VersusGame({ side: 0, seed, loadout: DEFAULT_VS_LOADOUT });
  const B = new VersusGame({ side: 1, seed, loadout: DEFAULT_VS_LOADOUT });
  const ba = new VersusBot(A, { style: styleA, level, seed: seed * 3 + 1 });
  const bb = new VersusBot(B, { style: styleB, level, seed: seed * 3 + 2 });
  const dt = 1 / 30, maxT = Number(args.max);
  let t = 0;
  const ecoLog = [];
  while (A.state === 'play' && B.state === 'play' && t < maxT) {
    ba.update(dt, B); bb.update(dt, A);
    A.update(dt); B.update(dt);
    for (const m of A.outbox.splice(0)) B.receive(m);
    for (const m of B.outbox.splice(0)) A.receive(m);
    A.events.length = 0; B.events.length = 0;
    t += dt;
    if (Math.abs(t % 60) < dt) ecoLog.push(`${Math.round(t / 60)}m:${A.eco}/${B.eco}`);
  }
  const winner = A.state === 'lost' && B.state === 'lost' ? 'draw' : A.state === 'lost' ? 'B' : B.state === 'lost' ? 'A' : 'timeout';
  return { winner, t, wave: A.wave, A, B, ecoLog };
}

function series(styleA, styleB, n, level) {
  const res = { A: 0, B: 0, draw: 0, timeout: 0, t: 0, wave: 0, ecoA: 0, ecoB: 0, sentA: 0, sentB: 0, towersA: 0, towersB: 0 };
  for (let i = 0; i < n; i++) {
    const r = play(styleA, styleB, 1000 + i * 17, level);
    res[r.winner]++;
    res.t += r.t; res.wave += r.wave;
    res.ecoA += r.A.eco; res.ecoB += r.B.eco; res.sentA += r.A.stats.sentValue; res.sentB += r.B.stats.sentValue;
    res.towersA += r.A.towers.length; res.towersB += r.B.towers.length;
    if (args.verbose) console.log(`  #${i} ${r.winner} ${Math.round(r.t)}s w${r.wave} lives ${r.A.lives}/${r.B.lives} eco ${r.A.eco}/${r.B.eco} sent ${r.A.stats.sentValue}/${r.B.stats.sentValue} towers ${r.A.towers.length}/${r.B.towers.length}  ${r.ecoLog.join(' ')}`);
  }
  const k = (v) => (v / n).toFixed(0);
  return { ...res, line: `${styleA.padEnd(8)} vs ${styleB.padEnd(8)}  A ${String(res.A).padStart(2)} · B ${String(res.B).padStart(2)} · draw ${res.draw} · t/o ${res.timeout}   avg ${k(res.t)}s w${(res.wave / n).toFixed(1)}  eco ${k(res.ecoA)}/${k(res.ecoB)}  sent ${k(res.sentA)}/${k(res.sentB)}  towers ${(res.towersA / n).toFixed(1)}/${(res.towersB / n).toFixed(1)}` };
}

const n = Number(args.matches);
if (args.matrix) {
  const styles = Object.keys(BOT_STYLES);
  for (const a of styles) for (const b of styles) if (a <= b) console.log(series(a, b, n, args.level).line);
} else {
  console.log(series(args.a, args.b, n, args.level).line);
}
