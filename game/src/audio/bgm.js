// Selectable background music (settings -> 背景音樂). Each track is a procedural score rendered by
// the same pipeline as the built-in themes (music.js renderTrack): one-shot sample bank -> stems ->
// bus EQ / hall / ping-pong delay -> mastering -> bar-exact sections joined by a Markov chain.
// Every track has the adaptive stems of the battle theme:
//   bed   - bass, chords, pads, arps (alone and low-passed while building between waves)
//   drums - the kit (enters when a wave starts)
//   heat  - hooks / leads and the big layers, scaled by battle intensity
// Sections carry an energy level (0 intro/ambient .. 3 climax); the engine biases the Markov chain
// toward high-energy sections in boss fights.
import { INS } from './music.js';
import { epiano, reese, growl, pulse, chipNoise, flute, pluckStr, horn, voxHit, anvil, ride, rim, vinyl } from './synth.js';

// Bump when any arrangement / instrument used by these tracks changes (cache key of the renders).
export const BGM_REV = 2;

// ------------------------------------------------------------------ extra one-shots
const js = (o) => JSON.stringify(o || {});
const spec = (key, ch, dur, norm, build) => [key, { ch, dur, norm, build }];
const epDecay = (m, o) => o.decay ?? Math.max(1.2, 3.4 - (m - 48) * 0.045);
const V = {
  ep: (m, len, o = {}) => spec(`ep|${m}|${len.toFixed(3)}|${js(o)}`, 2, Math.min(len + (o.r ?? 0.22) * 1.5, epDecay(m, o) * 1.25) + 0.12, ['peak', -3], (c, out, rng) => epiano(c, out, 0, len, m, { ...o, rng })),
  reese: (m, len, o = {}) => spec(`reese|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 0.1) * 1.5 + 0.08, ['rms', -16], (c, out, rng) => reese(c, out, 0, len, m, { ...o, rng })),
  growl: (m, len, o = {}) => spec(`growl|${m}|${len.toFixed(3)}|${js(o)}`, 1, len + (o.r ?? 0.08) * 1.5 + 0.08, ['rms', -16], (c, out, rng) => growl(c, out, 0, len, m, { ...o, rng })),
  pulse: (m, len, o = {}) => spec(`pulse|${m}|${len.toFixed(3)}|${js(o)}`, 1, len + (o.r ?? 0.05) * 1.5 + 0.08, ['rms', -18], (c, out) => pulse(c, out, 0, len, m, o)),
  noise8: (o = {}) => spec(`noise8|${js(o)}`, 1, (o.dur ?? 0.25) + 0.02, ['peak', -1], (c, out, rng) => chipNoise(c, out, 0, { ...o, rng })),
  flute: (m, len, o = {}) => spec(`flute|${m}|${len.toFixed(3)}|${js(o)}`, 1, len + (o.r ?? 0.3) * 1.5 + 0.08, ['rms', -18], (c, out, rng) => flute(c, out, 0, len, m, { ...o, rng })),
  koto: (m, o = {}) => spec(`koto|${m}|${js(o)}`, 1, (o.decay ?? 1.4) + 0.12, ['peak', -3], (c, out, rng) => pluckStr(c, out, 0, m, { ...o, rng })),
  horn: (m, len, o = {}) => spec(`horn|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 0.35) * 1.5 + 0.08, ['rms', -16], (c, out, rng) => horn(c, out, 0, len, m, { ...o, rng })),
  vox: (m, len, o = {}) => spec(`vox|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 0.12) * 1.5 + 0.08, ['peak', -3], (c, out, rng) => voxHit(c, out, 0, len, m, { ...o, rng })),
  anvil: (o = {}) => spec(`anvil|${js(o)}`, 2, (o.decay ?? 1) + 0.12, ['peak', -1], (c, out, rng) => anvil(c, out, 0, { ...o, rng })),
  ride: (o = {}) => spec(`ride|${js(o)}`, 1, (o.decay ?? 1.6) + 0.12, ['peak', -1], (c, out, rng) => ride(c, out, 0, { ...o, rng })),
  rim: (o = {}) => spec(`rim|${js(o)}`, 1, 0.26, ['peak', -1], (c, out, rng) => rim(c, out, 0, { ...o, rng })),
  vinyl: (dur, o = {}) => spec(`vinyl|${dur.toFixed(3)}|${js(o)}`, 2, dur + 0.02, ['peak', -1], (c, out, rng) => vinyl(c, out, 0, dur, { ...o, rng })),
};

// ------------------------------------------------------------------ notes, melodies, chords
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function nm(s) {
  const m = /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/.exec(s);
  if (!m) throw new Error(`bgm: bad note "${s}"`);
  const acc = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
  return 12 * (+m[3] + 1) + PC[m[1]] + acc;
}
// 'C#5:6 B4:2 r:4 | ...' -> [[step, midi, len], ...] in 16th steps; '|' asserts a bar line
export function M(str) {
  const out = [];
  let pos = 0;
  for (const tok of str.trim().split(/\s+/)) {
    if (tok === '|') { if (pos % 16) throw new Error(`bgm: bar check failed at step ${pos}: ${str}`); continue; }
    const [n, l] = tok.split(':');
    const len = +l;
    if (!(len > 0)) throw new Error(`bgm: bad token "${tok}"`);
    if (n !== 'r') out.push([pos, nm(n), len]);
    pos += len;
  }
  return out;
}
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7], dim: [0, 3, 6], sus2: [0, 2, 7], sus4: [0, 5, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 13: [0, 4, 7, 10, 14, 21], '7b9': [0, 4, 7, 10, 13],
};
const pcOf = (s) => (((PC[s[0]] + (s[1] === '#' ? 1 : s[1] === 'b' ? -1 : 0)) % 12) + 12) % 12;
export function chordOf(sym) {
  const [main, slash] = sym.split('/');
  const m = /^([A-G][#b]?)(.*)$/.exec(main);
  const iv = m && QUAL[m[2]];
  if (!iv) throw new Error(`bgm: bad chord "${sym}"`);
  const root = pcOf(m[1]);
  return { sym, root, iv, bass: slash ? pcOf(slash) : root };
}
// 'F#m Dmaj7 A E' = one chord per bar; 'Cm9,C7b9' splits a bar
export function prog(str) {
  const out = [];
  str.trim().split(/\s+/).forEach((tok, b) => {
    const parts = tok.split(',');
    parts.forEach((p, i) => out.push({ ...chordOf(p), s0: b * 16 + (i * 16) / parts.length, len: 16 / parts.length, bar: b }));
  });
  return out;
}
// Close-position voicings with the least total motion from chord to chord (pads/keys). Chords with
// more tones than voices drop the root first (5+ tones: the bass has it), then the fifth.
export function voiceLead(chords, { lo = 54, hi = 77, n = 4, center = 65, cluster = 8 } = {}) {
  let prev = null;
  return chords.map((c) => {
    let pcs = [...new Set(c.iv.map((i) => (c.root + i) % 12))];
    const five = (c.root + 7) % 12;
    let first = true;
    while (pcs.length > n) {
      const drop = first && pcs.length >= 5 ? c.root : pcs.includes(five) && five !== c.root ? five : c.root;
      pcs = pcs.filter((p) => p !== drop);
      first = false;
    }
    let best = null, bestScore = Infinity;
    for (let L = lo; L < lo + 12; L++) {
      if (!pcs.includes(L % 12)) continue;
      const v = [L];
      for (let m = L + 1; v.length < n && m <= hi + 12; m++) if (pcs.includes(m % 12)) v.push(m);
      if (v.length < n) continue;
      const mean = v.reduce((x, y) => x + y, 0) / n;
      let sc = 0.25 * Math.abs(mean - center) + 3 * Math.max(0, v[n - 1] - hi);
      for (let i = 1; i < n; i++) if (v[i] - v[i - 1] === 1 && v[i - 1] < 72) sc += cluster; // low semitone clusters get muddy
      if (prev) for (let i = 0; i < n; i++) sc += Math.abs(v[i] - prev[i]);
      if (sc < bestScore) { bestScore = sc; best = v; }
    }
    if (!best) best = pcs.slice(0, n).map((p) => lo + ((((p - lo) % 12) + 12) % 12));
    prev = best;
    return best;
  });
}
const bassRoot = (pc, lo = 28) => { let m = lo; while (m % 12 !== pc) m++; return m; };
// move `steps` scale degrees (scale = 7 ascending pitch classes); chromatic notes double an octave down
function diatonic(m, steps, scale) {
  let i = scale.indexOf(((m % 12) + 12) % 12);
  if (i < 0) return m - 12;
  const dir = Math.sign(steps);
  for (let k = 0; k < Math.abs(steps); k++) {
    const j = (i + dir + 7) % 7;
    let d = scale[j] - scale[i];
    if (dir > 0 && d <= 0) d += 12;
    if (dir < 0 && d >= 0) d -= 12;
    m += d; i = j;
  }
  return m;
}
const E_MAJOR = [4, 6, 8, 9, 11, 1, 3];

// sections: parse progressions / melodies once, voice the chords
function sections(list, voicing) {
  return list.map((s) => {
    const P = s.prog ? prog(s.prog) : [];
    return { ...s, P, V: s.voicings || (P.length ? voiceLead(P, voicing) : []), mel: s.mel ? M(s.mel) : null };
  });
}
// melodic line: legato notes (touching) glide from the previous pitch
function line(X, stem, bus, notes, mk, db, { pan = 0, legato = true, hum = 0.002, vel = 0.6, oct = 0, gap = 0.96, pump = 0 } = {}) {
  let prev = null, prevEnd = -1;
  for (const [st, m0, len] of notes) {
    const m = m0 + oct;
    const from = legato && prevEnd === st ? prev : null;
    X.add(stem, bus, mk(m, len * X.step * gap, from, len), st * X.step + (hum ? X.hum(hum) : 0), X.vel(db, vel), pan, pump);
    prev = m; prevEnd = st + len;
  }
}

// drum helper: kit table entries { ins(rng), bus, db, pan, pump, hum, stem, vel }
function kit(X, table, swing = 0) {
  return (name, step, db = 0, pan) => {
    const k = table[name];
    const sw = swing && Number.isInteger(step) && step % 2 === 1 ? swing * X.step : 0;
    X.add(k.stem || 'drums', k.bus || 'dry', k.ins(X.rng), step * X.step + sw + (k.hum ? X.hum(k.hum) : 0), X.vel((k.db ?? 0) + db, k.vel ?? 1), pan ?? k.pan ?? 0, k.pump ?? 0);
  };
}
const pick = (arr) => (rng) => arr[Math.floor(rng() * arr.length) % arr.length];
const HATS = (o = {}) => [{ v: 101, ...o }, { v: 102, tune: 1.03, ...o }, { v: 103, tune: 0.97, decay: 0.04, ...o }];

// ================================================================== 1. 霓虹公路 · Synthwave
// 108 BPM, F# minor. 80s outrun: gated snare, octave-pumping bass, supersaw pads, 16th arps,
// CS-80-style lead with delay. Verse / verse' / chorus / bridge (V7 pull) / breakdown.
const SW = {
  pad: { a: 0.12, d: 0.9, s: 0.85, r: 0.6, cut: 2300, cutPeak: 3500, cutStart: 700, spread: 18, hp: 150 },
  arp: { decay: 0.28, cut0: 5200, cut1: 750, fdecay: 0.1, q: 1.6, detune: 7 },
  bass: { cut: 360, accCut: 1300, q: 3, drive: 1.6, sub: 0.6, len: 0.17 },
  lead: { sq: 0.18, cut: 3800, cut0: 700, fa: 0.06, detune: 9, vib: 14, vibDelay: 0.22, a: 0.02, r: 0.35, gain: 0.3, q: 1.8 },
  kick: [{ v: 111, p0: 130, p1: 48, decay: 0.42, click: 0.22, knock: 0.35, drive: 1.9 }, { v: 112, p0: 126, p1: 47, decay: 0.44, click: 0.2, knock: 0.35, drive: 1.9 }],
  snare: { v: 111, decay: 0.3, gate: 0.95, tone: 2000, f1: 200, body: 0.75, noise: 0.85 },
  tom: { h: 53, m: 48, l: 43 },
};
function synthwave(X, sec) {
  const S = X.step, id = sec.id;
  const big = id === 'C', brk = id === 'E', intro = id === 'I', bridge = id === 'D';
  const nb = sec.bars;
  for (let q = 0; q < nb * 4; q++) X.pumpTimes.push(q * X.beat);
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const root = bassRoot(c.bass, 30);
    const v = sec.V[i];
    const padO = big ? { ...SW.pad, cut: 2800, cutPeak: 4200 } : brk ? { ...SW.pad, a: 0.5, cut: 1700 } : SW.pad;
    for (const m of v) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, padO), t0, big ? -9 : -10, 0, 0.45);
    X.add('bed', 'dry', INS.sub(root, X.bar * 0.97, { a: 0.02, r: 0.2 }), t0, intro || brk ? -17 : -15, 0, 0.5);
    if (brk) {
      for (const s of [0, 8]) X.add('bed', 'dry', INS.bass(root + 12, { ...SW.bass, len: 0.45, accent: s ? 0.2 : 0.5, cut: 300 }), t0 + s * S, s ? -10.5 : -9, 0, 0.3);
    } else {
      for (let s = 0; s < 16; s += 2) {
        if (intro && s % 4) continue;
        const acc = s % 8 === 0;
        const m = root + 12 + (s % 4 === 2 ? 12 : 0);
        X.add('bed', 'dry', INS.bass(m, { ...SW.bass, accent: acc ? 1 : 0.35 }), t0 + s * S, acc ? -6 : -8.5, 0, 0.3);
      }
      if (big && b % 2 === 1) X.add('bed', 'dry', INS.bass(root + 22, { ...SW.bass, accent: 0.6 }), t0 + 15 * S, -9, 0, 0.3);
    }
    const tones = [...v.map((m) => m + 12), v[0] + 24];
    const pat = big ? [0, 2, 4, 2, 1, 3, 4, 3, 0, 2, 4, 2, 1, 3, 4, 3] : [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1];
    const arpO = intro ? { ...SW.arp, cut0: b === 0 ? 2200 : 3400 } : brk ? { ...SW.arp, cut0: 2800, decay: 0.42 } : SW.arp;
    for (let s = 0; s < 16; s += bridge ? 2 : 1) {
      X.add('bed', 'delay', INS.pluck(tones[pat[s] % tones.length], arpO), t0 + s * S, s % 4 === 0 ? -12.5 : -15, s % 2 ? 0.35 : -0.35, 0.3);
    }
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: pick(SW.kick.map((o) => INS.kick(o))), db: -1.5, vel: 0.6 },
    SN: { ins: () => INS.snare(SW.snare), db: -2.5, hum: 0.002, vel: 0.8 },
    CL: { ins: () => INS.clap({ v: 111, tone: 1300 }), db: -12, pan: 0.1 },
    HC: { ins: pick(HATS().map((o) => INS.hat(o))), db: 0, pan: 0.25, hum: 0.003, vel: 1.5 },
    HO: { ins: () => INS.hat({ v: 111, decay: 0.3, gain: 0.55 }), db: -16, pan: 0.25 },
    TH: { ins: () => INS.tom(SW.tom.h, { v: 111, decay: 0.6 }), bus: 'hall', pan: -0.4, hum: 0.002 },
    TM: { ins: () => INS.tom(SW.tom.m, { v: 111, decay: 0.6 }), bus: 'hall', pan: 0, hum: 0.002 },
    TL: { ins: () => INS.tom(SW.tom.l, { v: 111, decay: 0.7 }), bus: 'hall', pan: 0.4, hum: 0.002 },
    CR: { ins: () => INS.crash({ v: 111, decay: 2.4 }), bus: 'hall', db: -9, pan: -0.25 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      d('K', o, -4);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -22 : -19);
      if (last) { d('K', o + 8, -5); [['TH', -12], ['TH', -11], ['TM', -10], ['TM', -9], ['TL', -8], ['TL', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 8 + i, db)); }
      continue;
    }
    if (brk) {
      d('K', o, b % 2 ? -7 : -4.5);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -24 : -21);
      if (last) for (let i = 0; i < 16; i++) X.add('drums', 'dry', INS.snare(SW.snare), (o + i) * S, -26 + i * 1.2);
      continue;
    }
    if (b === 0) d('CR', o);
    if (big && b === 2) d('CR', o);
    if (big) { for (const s of [0, 4, 8, 12]) d('K', o + s); } else if (bridge) { for (const s of [0, 6, 8]) d('K', o + s); if (b % 2) d('K', o + 14, -4); } else { d('K', o); d('K', o + 8); if (b % 2) d('K', o + 11, -4); }
    d('SN', o + 4); d('SN', o + 12);
    d('CL', o + 4); d('CL', o + 12);
    const fill = last && !big;
    for (let s = 0; s < 16; s++) {
      if (fill && s >= 12) break;
      if (big ? s % 4 === 2 : s === 14) continue;
      d('HC', o + s, s % 4 === 0 ? -14 : s % 2 ? -20 : -16.5);
    }
    if (big) for (const s of [2, 6, 10, 14]) d('HO', o + s); else if (!fill) d('HO', o + 14);
    if (fill) [['TH', -8], ['TM', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 12 + i, db));
    if (last && big) for (let i = 0; i < 8; i++) d('SN', o + 8 + i, -14 + i * 1.4);
  }
  // ---------------- heat
  if (sec.mel) {
    line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...SW.lead, from, glide: 0.06 }), -8);
    if (big) line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...SW.lead, from, glide: 0.06, cut: 4500 }), -16, { oct: 12, hum: 0 });
  }
  if (big) {
    sec.P.forEach((c, i) => { for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m + 12, X.bar * 0.95, { vowel: 'a', a: 0.3, r: 0.9 }), c.s0 * S, -15, 0, 0.25); });
    sec.P.forEach((c) => { for (const s of [2, 6, 10, 14]) for (const m of sec.V[c.bar].slice(1)) X.add('heat', 'hall', INS.pad(m + 12, 0.14, { a: 0.004, d: 0.12, s: 0.3, r: 0.18, cut: 3600, cutPeak: 6500, cutStart: 1800, spread: 15, hp: 200 }), c.s0 * S + s * S, -19, 0, 0.3); });
  }
  if (bridge) sec.P.forEach((c, i) => { for (const m of sec.V[i]) X.add('heat', 'hall', INS.pad(m + 12, X.bar * 0.97, { ...SW.pad, a: 0.6, cut: 2600, spread: 22 }), c.s0 * S, -16, 0, 0.3); });
  if (brk) {
    const bells = M('r:4 F#5:2 E5:2 F#5:4 A5:4 | G#5:8 r:8 | r:4 E5:2 C#5:2 E5:4 G#5:4 | F#5:16');
    for (const [st, m] of bells) X.add('heat', 'delay', INS.bell(m, { ratio: 3.5, index: 2.2, decay: 2.6, idxDecay: 0.5, gain: 0.3, strike: 0.2 }), st * S, -13, (X.rng() - 0.5) * 0.5);
    X.add('heat', 'hall', INS.riser(X.bar, { f0: 350, f1: 7000, q0: 0.8, q1: 3, gain: 0.5, saws: 0.25, note: 54 }), X.t(nb - 1), -13);
    X.addRev('heat', 'hall', INS.revCrash({ v: 112, decay: 1.8 }), X.t(nb), -11, 0.2);
  }
  if (intro) {
    X.add('heat', 'hall', INS.riser(X.bar * 2, { f0: 250, f1: 6500, q0: 0.7, q1: 3, gain: 0.5, saws: 0.25, note: 54, rise: 1200 }), 0, -14);
    X.addRev('heat', 'hall', INS.revCrash({ v: 113, decay: 2 }), X.t(nb), -12, -0.2);
  }
  if (id === 'B') X.add('heat', 'hall', INS.riser(X.bar, { f0: 400, f1: 7500, q0: 0.8, q1: 3, gain: 0.5, saws: 0.2, note: 54 }), X.t(nb - 1), -14);
}

// ================================================================== 2. 暗夜追獵 · Darksynth
// 116 BPM, C minor (Phrygian bII, harmonic-minor V). Distorted 16th bass, punchy kick, tresillo
// riff lead, Andalusian lament (i-VII-VI-V), braams and dark choir.
const DS = {
  pad: { a: 0.08, d: 0.8, s: 0.85, r: 0.6, cut: 1300, cutPeak: 2200, cutStart: 450, spread: 20, hp: 100 },
  arp: { decay: 0.22, cut0: 3800, cut1: 500, fdecay: 0.08, q: 3, detune: 6, sq: 0.25 },
  bass: { len: 0.1, drive: 3.2, cut: 380, accCut: 1800, q: 6, sub: 0.45 },
  lead: { sq: 0.45, cut: 3400, cut0: 500, fa: 0.05, detune: 11, vib: 22, vibHz: 5.8, vibDelay: 0.15, a: 0.012, r: 0.3, gain: 0.3, q: 2.4 },
  kick: [{ v: 121, p0: 170, p1: 46, decay: 0.38, click: 0.35, drive: 2.6, knock: 0.4 }, { v: 122, p0: 165, p1: 45, decay: 0.4, click: 0.32, drive: 2.6, knock: 0.4 }],
  snare: { v: 121, decay: 0.26, gate: 0.8, tone: 1900, f1: 190, body: 0.8, drive: 2.0 },
  tom: { h: 49, m: 44, l: 40 },
  ost: {
    run: { n: [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 12, 10, 7], acc: [0, 3, 6, 8, 11, 14] },
    phr: { n: [0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 12, 0, 1], acc: [0, 3, 6, 8, 11, 14] },
    drive: { n: [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0], acc: [0, 2, 4, 6, 8, 10, 12, 14] },
    gallop: { n: [0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 12], acc: [0, 3, 6, 8, 11, 14] },
  },
};
function darksynth(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const intro = id === 'I', half = id === 'D', four = id === 'C' || id === 'E';
  for (let q = 0; q < nb * 4; q++) X.pumpTimes.push(q * X.beat);
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const root = bassRoot(c.bass, 31);
    for (const m of sec.V[i]) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, half ? { ...DS.pad, a: 0.4, cut: 1100 } : DS.pad), t0, -10.5, 0, 0.5);
    X.add('bed', 'dry', INS.sub(root, X.bar * 0.97, { a: 0.02, r: 0.2, drive: 1.5 }), t0, -15, 0, 0.6);
    if (half) {
      for (const s of [0, 8]) X.add('bed', 'dry', INS.bass(root, { ...DS.bass, len: 0.5, accent: 0.6 }), t0 + s * S, -8, 0, 0.3);
    } else if (intro) {
      for (let s = 0; s < 16; s += 2) X.add('bed', 'dry', INS.bass(root, { ...DS.bass, accent: s % 8 ? 0.2 : 0.8, cut: 260 }), t0 + s * S, s % 8 ? -11 : -8, 0, 0.3);
    } else {
      const ost = DS.ost[id === 'B' ? (c.sym === 'Cm' ? 'phr' : 'run') : id === 'E' ? 'gallop' : four ? 'drive' : 'run'];
      // the b7-5 pickup of the run belongs to C minor; other chords turn around on 5-8
      const tail = ost === DS.ost.run && c.root !== 0 ? [7, 12] : null;
      for (let s = 0; s < 16; s++) {
        const acc = ost.acc.includes(s);
        const off = tail && s >= 14 ? tail[s - 14] : ost.n[s];
        X.add('bed', 'dry', INS.bass(root + off, { ...DS.bass, accent: acc ? 1 : 0.3 }), t0 + s * S, acc ? -5.5 : -8.5, 0, 0.3);
      }
    }
    if (!intro && !half && id !== 'B') {
      const tones = [...sec.V[i].map((m) => m + 12), sec.V[i][0] + 24];
      const pat = [0, 2, 4, 2, 1, 3, 4, 3, 0, 2, 4, 2, 1, 3, 4, 3];
      for (let s = 0; s < 16; s++) X.add('bed', 'delay', INS.pluck(tones[pat[s] % tones.length], DS.arp), t0 + s * S, s % 4 === 0 ? -13 : -16, s % 2 ? 0.3 : -0.3, 0.35);
    }
    void b;
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: pick(DS.kick.map((o) => INS.kick(o))), db: -1.5, vel: 0.5 },
    SN: { ins: () => INS.snare(DS.snare), db: -2.5, hum: 0.002, vel: 0.8 },
    CL: { ins: () => INS.clap({ v: 121, tone: 1100 }), db: -11, pan: -0.1 },
    HC: { ins: pick(HATS({ tune: 0.95 }).map((o) => INS.hat(o))), pan: 0.3, hum: 0.003, vel: 1.5 },
    HO: { ins: () => INS.hat({ v: 121, decay: 0.28, gain: 0.55, tune: 0.95 }), db: -16, pan: 0.3 },
    TH: { ins: () => INS.tom(DS.tom.h, { v: 121, decay: 0.55, drive: 2.2 }), bus: 'hall', pan: -0.4 },
    TM: { ins: () => INS.tom(DS.tom.m, { v: 121, decay: 0.6, drive: 2.2 }), bus: 'hall' },
    TL: { ins: () => INS.tom(DS.tom.l, { v: 121, decay: 0.7, drive: 2.2 }), bus: 'hall', pan: 0.4 },
    CR: { ins: () => INS.crash({ v: 121, decay: 2.2 }), bus: 'hall', db: -9, pan: 0.25 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      d('K', o, -3); d('K', o + 3, -7);
      for (let s = 2; s < 16; s += 4) d('HC', o + s, -21);
      if (last) for (let i = 0; i < 8; i++) d('SN', o + 8 + i, -20 + i * 1.8);
      continue;
    }
    if (half) {
      d('K', o); if (b % 2) d('K', o + 10, -4);
      d('SN', o + 8, -1.5);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -22 : -18);
      if (last) [['TH', -12], ['TH', -11], ['TM', -10], ['TM', -9], ['TL', -8], ['TL', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 8 + i, db));
      continue;
    }
    if (b === 0 || (four && b === 2)) d('CR', o);
    if (four) { for (const s of [0, 4, 8, 12]) d('K', o + s); } else if (id === 'B') { for (const s of [0, 3, 8, 11]) d('K', o + s, s % 8 ? -3 : 0); } else { d('K', o); d('K', o + 8); if (b % 2) d('K', o + 10, -4); if (last) d('K', o + 14, -3); }
    d('SN', o + 4); d('SN', o + 12);
    d('CL', o + 4); d('CL', o + 12);
    if (id === 'E') d('SN', o + 15, -15);
    const fill = last && (id === 'A' || id === 'B');
    for (let s = 0; s < 16; s += id === 'B' ? 2 : 1) {
      if (fill && s >= 12) break;
      if (four && s % 4 === 2) continue;
      d('HC', o + s, s % 4 === 0 ? -14 : s % 2 ? -20 : -16.5);
    }
    if (four) for (const s of [2, 6, 10, 14]) d('HO', o + s); else if (!fill) { d('HO', o + 6, -2); d('HO', o + 14); }
    if (fill && id === 'A') [['TH', -8], ['TM', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 12 + i, db));
    if (fill && id === 'B') for (let i = 0; i < 4; i++) d('SN', o + 12 + i, -12 + i * 2);
  }
  // ---------------- heat
  if (sec.mel) {
    const slow = half;
    line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...DS.lead, from, glide: slow ? 0.12 : 0.05, ...(slow ? { vib: 18, vibDelay: 0.35, a: 0.05, r: 0.6 } : {}) }), slow ? -9 : -8);
    if (id === 'C') line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...DS.lead, from, glide: 0.05, cut: 4200 }), -16, { oct: 12, hum: 0 });
  }
  if (id === 'B') {
    const bells = { Cm: [[0, 84], [2, 85], [4, 84], [8, 79]], Db: [[0, 85], [2, 84], [4, 80], [8, 77]], G: [[0, 83], [2, 84], [4, 83], [8, 79], [12, 74]] };
    sec.P.forEach((c) => { for (const [s, m] of bells[c.sym] || []) X.add('heat', 'delay', INS.bell(m, { ratio: 3.5, index: 1.6, decay: 1.6, idxDecay: 0.4, gain: 0.3, strike: 0.2 }), (c.s0 + s) * S, -14, s % 4 ? 0.3 : -0.3); });
    X.add('heat', 'hall', INS.riser(X.bar, { f0: 300, f1: 6500, q0: 0.8, q1: 3, gain: 0.5, saws: 0.3, note: 48 }), X.t(nb - 1), -13);
  }
  if (id !== 'I' && id !== 'A') {
    const vowel = half ? 'o' : 'a';
    sec.P.forEach((c, i) => { for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel, a: 0.35, r: 0.9, vib: 16 }), c.s0 * S, half ? -12 : -14, 0, 0.25); });
  }
  if (id === 'C' || id === 'E') {
    sec.P.forEach((c) => {
      if (id === 'C' && c.bar % 2) return;
      X.add('heat', 'hall', INS.braam(bassRoot(c.bass, 31) + 12, X.bar * 0.75, { a: 0.06, drive: 3, cutPeak: 2800, cutEnd: 560, r: 1.0, rasp: 0.3 }), c.s0 * S, c.bar === 0 ? -8 : -10, 0, 0.2);
    });
  }
  if (intro) {
    X.add('heat', 'hall', INS.riser(X.bar * 2, { f0: 200, f1: 6000, q0: 0.7, q1: 3, gain: 0.5, saws: 0.3, note: 48, rise: 1200 }), 0, -13);
    X.add('heat', 'hall', INS.scrape(1.6, { ring: 620 }), X.t(1), -13);
  }
  if (half) X.addRev('heat', 'hall', INS.revCrash({ v: 122, decay: 2 }), X.t(nb), -11, 0.2);
}

// ================================================================== 3. 靜謐星圖 · Lo-fi
// 82 BPM swung, E-flat major. Suitcase e-piano in rootless jazz voicings (ii-V-I-vi, borrowed
// bVII), warm round bass, dusty boom-bap, vinyl, breathy flute lead, glass bells.
const LF = {
  swing: 0.22,
  ep: { vel: 0.5, trem: 0.18, index: 1.15 },
  kick: { v: 131, p0: 110, p1: 52, decay: 0.32, click: 0.08, knock: 0.2, tone: 2500, drive: 1.4 },
  snare: { v: 131, decay: 0.2, gate: 0.25, tone: 1700, f1: 220, body: 0.7, noise: 0.6, crack: 0.15, drive: 1.3 },
  flute: { breath: 0.22, chiff: 0.35, vib: 16, lp: 4200, a: 0.07, r: 0.35, gain: 0.3 },
};
const LFV = {
  Fm9: [56, 60, 63, 67], Bb13: [56, 60, 62, 67], Ebmaj9: [55, 58, 62, 65], Cm9: [55, 58, 62, 63], Abmaj9: [60, 63, 67, 70],
  Gm9: [58, 62, 65, 69], C7b9: [58, 61, 64, 67], Dbmaj9: [56, 60, 63, 65], 'Abmaj9:lo': [55, 58, 60, 63], 'C7b9:lo': [55, 58, 61, 64],
};
function lofi(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const sw = (s) => (s % 2 === 1 ? LF.swing * S : 0);
  const brk = id === 'D';
  // ---------------- bed: e-piano comping, bass, vinyl, (pad)
  const comp = [[[0, 7], [10, 6]], [[0, 5], [6, 3], [10, 6]], [[0, 7], [11, 5]], [[0, 14]]];
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const v = sec.V[i];
    const hits = brk ? [[0, 14]] : comp[b % 4];
    for (const [s, len] of hits) {
      v.forEach((m, k) => X.add('bed', 'hall', V.ep(m, X.bar * 0.9, LF.ep), t0 + s * S + sw(s) + k * 0.009 + X.hum(0.004), X.vel(s ? -12 : -10, 1.2), (k - 1.5) * 0.12, 0, { cut: len * S, rel: 0.28 }));
    }
    const root = bassRoot(c.bass, 36);
    const next = sec.P[i + 1] ? bassRoot(sec.P[i + 1].bass, 36) : null;
    const notes = brk ? [[0, root, 14]] : [[0, root, 6], [7, root, 2], [10, root + 7, 3], [14, next != null ? next - 1 : root + 12, 2]];
    for (const [s, m, len] of notes) X.add('bed', 'dry', INS.sub(m, len * S * 0.9, { a: 0.012, r: 0.1, harm: 0.32, drive: 1.7 }), t0 + s * S + sw(s), s ? -11 : -9.5, 0, 0.15);
    if (brk || id === 'C') for (const m of v) X.add('bed', 'hall', INS.pad(m + 12, X.bar * 0.97, { a: 0.9, d: 1.2, s: 0.9, r: 1.4, cut: 1300, cutPeak: 1800, cutStart: 500, spread: 14, voices: 5, hp: 250 }), t0, -20, 0, 0);
  });
  X.add('bed', 'dry', V.vinyl(nb * X.bar, { rate: 9, pops: 0.5 }), 0, -27);
  // ---------------- drums
  const d = kit(X, {
    K: { ins: () => INS.kick(LF.kick), db: -3, vel: 0.8 },
    SN: { ins: () => INS.snare(LF.snare), db: -5, hum: 0.004, vel: 1 },
    RM: { ins: () => V.rim({ f: 1650, click: 0.25 }), db: -14, pan: -0.15, hum: 0.004 },
    HC: { ins: pick(HATS({ decay: 0.03, air: 0.1, tune: 0.96, bp: 7500, hp: 5500 }).map((o) => INS.hat(o))), pan: 0.3, hum: 0.005, vel: 2 },
    HO: { ins: () => INS.hat({ v: 131, decay: 0.22, air: 0.1, gain: 0.5, tune: 0.96 }), db: -19, pan: 0.3 },
    SH: { ins: () => INS.shaker({ v: 131, tone: 5500 }), db: -26, pan: -0.35, hum: 0.006, vel: 2 },
  }, LF.swing);
  for (let b = 0; b < nb; b++) {
    const o = b * 16;
    if (brk) {
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -25 : -22);
      if (b % 2) d('RM', o + 12, -2);
      continue;
    }
    d('K', o); d('K', o + 10, -2); if (b % 2) d('K', o + 7, -5);
    d('SN', o + 4); d('SN', o + 12);
    for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -21 : -18);
    for (const s of [3, 11]) d('HC', o + s, -27);
    if (b % 2 === 0) d('RM', o + 14); else d('RM', o + 6, -3);
    if (b === nb - 1) d('HO', o + 15);
  }
  // ---------------- heat
  if (sec.mel) {
    if (id === 'B') {
      for (const [st, m, len] of sec.mel) X.add('heat', 'delay', V.ep(m + 12, X.bar * 0.9, { ...LF.ep, vel: 0.65 }), st * S + sw(st) + X.hum(0.004), X.vel(-16, 1), 0, 0, { cut: len * S, rel: 0.3 });
    } else {
      line(X, 'heat', 'delay', sec.mel, (m, len, from) => V.flute(m, len, { ...LF.flute, bend: from == null ? 0.4 : 0 }), -9, { legato: false });
    }
  }
  if (brk) {
    const bells = M('G5:6 Bb5:6 D6:4 | C6:8 Eb6:8 | Bb5:6 G5:6 D6:4 | E6:8 Db6:8');
    for (const [st, m] of bells) X.add('heat', 'delay', INS.bell(m, { ratio: 3.5, index: 1.2, decay: 2.2, idxDecay: 0.4, gain: 0.3, strike: 0.15 }), st * S + sw(st), -15, (X.rng() - 0.5) * 0.6);
  }
  for (let b = 0; b < nb; b++) for (let s = 0; s < 16; s++) if (!brk) X.add('heat', 'dry', INS.shaker({ v: 132, tone: 6000 }), (b * 16 + s) * S + sw(s) + X.hum(0.006), X.vel(s % 2 ? -27 : -24, 2), -0.35);
}

// ================================================================== 4. 量子脈衝 · Drum & Bass
// 172 BPM, G minor. Two-step breaks with ghost notes, reese over a mono sub, atmospheric pads,
// liquid Rhodes, neuro growl stabs and vocal chops, a syncopated pluck hook, half-time break.
const DB = {
  pad: { a: 0.6, d: 1.2, s: 0.9, r: 1.2, cut: 1700, cutPeak: 2400, cutStart: 400, spread: 22, hp: 160, drift: 5 },
  kick: [{ v: 141, p0: 190, p1: 55, pt: 0.03, decay: 0.26, click: 0.4, knock: 0.25, drive: 2.0 }, { v: 142, p0: 185, p1: 54, pt: 0.03, decay: 0.27, click: 0.38, knock: 0.25, drive: 2.0 }],
  snare: { v: 141, decay: 0.2, gate: 0.35, tone: 3200, f1: 250, body: 0.6, crack: 0.65, noise: 0.85, drive: 1.8 },
  ghost: { v: 142, decay: 0.12, gate: 0, tone: 3000, f1: 260, body: 0.4, crack: 0.4, noise: 0.7 },
  reese: {
    A: { det: 16, cut: 1100, lfo: 0.72, lfoDepth: 1200, drive: 2.6 },
    B: { det: 20, cut: 900, sweep: [400, 2600], drive: 2.8 },
    C: { det: 14, cut: 1300, lfo: 2.87, lfoDepth: 1000, drive: 3 },
  },
  rhythm: {
    A: [[0, 0, 10], [10, 0, 6]],
    B: [[0, 0, 3], [3, 0, 3], [6, 12, 2], [8, 0, 6], [14, 10, 2]],
    C: [[0, 0, 6], [6, 0, 2], [8, 7, 4], [12, 0, 4]],
  },
  pluck: { decay: 0.3, cut0: 6000, cut1: 1200, fdecay: 0.12, q: 2, detune: 10, sq: 0.3 },
  ep: { vel: 0.55, trem: 0.15, index: 1.2 },
  bell: { ratio: 3.5, index: 1.8, decay: 2.2, idxDecay: 0.45, gain: 0.3, strike: 0.2 },
};
function dnb(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const drop = id === 'A' || id === 'B' || id === 'C';
  for (let b = 0; b < nb; b++) X.pumpTimes.push(X.t(b), X.t(b, id === 'D' ? 8 : 10));
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S;
    const reeseRoot = bassRoot(c.bass, 38), subRoot = bassRoot(c.bass, 29);
    if (drop) {
      for (const [s, off, len] of DB.rhythm[id]) {
        X.add('bed', 'dry', V.reese(reeseRoot + off, len * S * 0.95, DB.reese[id]), t0 + s * S, -7, 0, 0.2);
        X.add('bed', 'dry', INS.sub(subRoot + (off === 12 ? 0 : off === 10 ? -2 : off), len * S * 0.92, { a: 0.008, r: 0.06 }), t0 + s * S, -11, 0, 0);
      }
    } else {
      X.add('bed', 'dry', INS.sub(subRoot, X.bar * (id === 'I' ? 0.97 : 0.97), { a: id === 'I' ? 0.8 : 0.03, r: 0.3 }), t0, id === 'I' ? -15 : -12, 0, 0.2);
    }
    for (const m of sec.V[i]) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, DB.pad), t0, drop ? -16 : -13, 0, 0.3);
    if (id === 'D' || id === 'E') {
      for (const [s, len] of [[0, 9], [10, 6]]) sec.V[i].forEach((m, k) => X.add('bed', 'hall', V.ep(m, X.bar * 0.9, DB.ep), t0 + s * S + k * 0.006 + X.hum(0.003), X.vel(s ? -15.5 : -14, 1), (k - 1.5) * 0.12, 0.2, { cut: len * S, rel: 0.3 }));
    }
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: pick(DB.kick.map((o) => INS.kick(o))), db: -1, vel: 0.5 },
    SN: { ins: () => INS.snare(DB.snare), db: -2, hum: 0.002, vel: 0.6 },
    GS: { ins: () => INS.snare(DB.ghost), db: -17, hum: 0.004, vel: 2 },
    RM: { ins: () => V.rim({ f: 1800 }), db: -13, pan: -0.2, hum: 0.003 },
    HC: { ins: pick(HATS({ decay: 0.035, tune: 1.06 }).map((o) => INS.hat(o))), pan: 0.25, hum: 0.003, vel: 1.5 },
    HO: { ins: () => INS.hat({ v: 141, decay: 0.18, gain: 0.5, tune: 1.06 }), db: -17, pan: 0.25 },
    RD: { ins: () => V.ride({ decay: 1.2, tune: 0.86 }), db: -18, pan: -0.3, hum: 0.003 },
    CR: { ins: () => INS.crash({ v: 141, decay: 2 }), bus: 'hall', db: -10, pan: 0.25 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (id === 'I') {
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -24 : -21);
      d('RM', o + 4); d('RM', o + 12);
      if (b >= 2) { d('K', o, -6); d('K', o + 10, -8); }
      if (last) for (let i = 0; i < 8; i++) d('SN', o + 8 + i, -22 + i * 2);
      continue;
    }
    if (id === 'D') {
      d('K', o); if (b % 2) d('K', o + 11, -4);
      d('SN', o + 8);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -22 : -19);
      d('RM', o + 14, -2);
      if (last) for (let i = 0; i < 4; i++) d('SN', o + 12 + i, -14 + i * 2.5);
      continue;
    }
    if (b === 0) d('CR', o);
    d('K', o); d('K', o + 10); if (b % 2) d('K', o + 7, -5);
    d('SN', o + 4); d('SN', o + 12);
    if (id !== 'E') { d('GS', o + 7); d('GS', o + 9, -2); if (b % 2) d('GS', o + 15); } else { d('RM', o + 7); d('RM', o + 15, -3); }
    for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -17 : -15);
    for (const s of [3, 11]) d('HC', o + s, -22);
    if (id === 'B' || id === 'C') { for (const s of [0, 4, 8, 12]) d('RD', o + s); } else d('HO', o + 6);
    if (last && id !== 'E') for (const [s, db] of [[13, -10], [14, -8], [15, -6]]) d('SN', o + s, db);
  }
  // ---------------- heat
  if (id === 'C') {
    for (const [st, m] of sec.mel) {
      X.add('heat', 'delay', INS.pluck(m, DB.pluck), st * S + X.hum(0.002), X.vel(-8, 0.8), 0);
      X.add('heat', 'delay', INS.bell(m + 12, DB.bell), st * S, -19, 0.2);
    }
  } else if (sec.mel) {
    for (const [st, m] of sec.mel) X.add('heat', 'delay', INS.bell(m, { ...DB.bell, decay: 2.8 }), st * S, -17, (X.rng() - 0.5) * 0.4);
  }
  if (id === 'A' || id === 'B') {
    sec.P.forEach((c) => {
      const root = bassRoot(c.bass, 38) + 12;
      const at = c.bar % 2 ? 6 : 14;
      X.add('heat', 'dry', V.growl(root, S * 2.5, { rate: 11.5, cut0: 250, cut1: 3200, q: 5, drive: 3 }), (c.s0 + at) * S, -7, c.bar % 2 ? 0.25 : -0.25);
    });
    for (const b of [1, 3]) X.add('heat', 'hall', V.vox(sec.V[b][3], S * 1.6, { vowel: 'o', drop: 2 }), X.t(b, 6), -11, 0.3);
  }
  if (id === 'I' || id === 'D' || id === 'E') sec.P.forEach((c, i) => { for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'u', a: 0.5, r: 1.0 }), c.s0 * S, -15, 0, 0.2); });
  if (id === 'I' || id === 'D') X.add('heat', 'hall', INS.riser(X.bar, { f0: 300, f1: 8000, q0: 0.8, q1: 3, gain: 0.5, saws: 0.25, note: 55 }), X.t(nb - 1), -12);
  if (id === 'C') X.addRev('heat', 'hall', INS.revCrash({ v: 141, decay: 1.4 }), X.t(nb), -13, -0.2);
}

// ================================================================== 5. 鋼鐵熔爐 · Industrial
// 132 BPM, E minor / Phrygian. Palm-muted distorted chug, anvil-layered backbeat, power-chord
// stabs, overdriven lead, tritone siren breakdown.
const IN = {
  pad: { a: 0.3, d: 1, s: 0.85, r: 0.8, cut: 1000, cutPeak: 1600, cutStart: 400, spread: 24, hp: 120 },
  bass: { drive: 3.6, cut: 420, accCut: 2200, q: 5, sub: 0.5, len: 0.07 },
  lead: { sq: 0.5, cut: 3600, cut0: 600, fa: 0.04, detune: 13, vib: 26, vibHz: 6.2, vibDelay: 0.12, a: 0.01, r: 0.25, gain: 0.3, q: 2.6, drive: 2.5 },
  kick: [{ v: 151, p0: 160, p1: 44, decay: 0.4, click: 0.45, knock: 0.45, drive: 3.4 }, { v: 152, p0: 155, p1: 43, decay: 0.42, click: 0.42, knock: 0.45, drive: 3.4 }],
  snare: { v: 151, decay: 0.24, gate: 0.6, tone: 2300, f1: 210, body: 0.65, crack: 0.6, drive: 2.4 },
  stab: { a: 0.005, drive: 3, cutPeak: 3000, cutEnd: 800, r: 0.25, layers: [[0, 1, 0], [7, 0.7, -0.4], [12, 0.6, 0.4]], rasp: 0.2 },
  tom: { h: 50, m: 45, l: 40 },
};
function industrial(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const half = id === 'D';
  for (let b = 0; b < nb; b++) for (const s of half ? [0, 10] : [0, 4, 8, 12]) X.pumpTimes.push(X.t(b, s));
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const root = bassRoot(c.bass, 36);
    for (const m of sec.V[i]) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, IN.pad), t0, -13, 0, 0.4);
    X.add('bed', 'dry', INS.sub(bassRoot(c.bass, 28), X.bar * 0.97, { a: 0.02, r: 0.2, drive: 1.8 }), t0, half ? -13 : -15, 0, 0.5);
    let on, acc;
    if (id === 'I') { on = [0, 3, 6, 8, 11, 14]; acc = [0, 8]; } else if (id === 'B') { on = [0, 2, 4, 6, 8, 10, 12, 14]; acc = [0, 4, 8, 12]; } else if (id === 'C') { on = [...Array(16).keys()]; acc = [0, 2, 4, 6, 8, 10, 12, 14]; } else if (half) { on = [0, 8]; acc = [0]; } else if (id === 'E') { on = [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15]; acc = [0, 4, 8, 12]; } else { on = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]; acc = [0, 3, 6, 8, 11, 14]; }
    for (const s of on) {
      const a = acc.includes(s);
      const m = root + (id === 'A' && b === 1 && s >= 13 ? [12, 13, 10][s - 13] || 0 : 0); // E-F Phrygian lick
      X.add('bed', 'dry', INS.bass(m, { ...IN.bass, accent: a ? 1 : 0.3, ...(half ? { len: 0.5 } : id === 'I' ? { cut: 200, accCut: 500 } : {}) }), t0 + s * S, a ? -5.5 : -8.5, 0, 0.35);
    }
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: pick(IN.kick.map((o) => INS.kick(o))), db: -1.5, vel: 0.5 },
    SN: { ins: () => INS.snare(IN.snare), db: -2.5, hum: 0.002, vel: 0.6 },
    AN: { ins: () => V.anvil({ f: 620, decay: 0.5, drive: 2 }), bus: 'hall', db: -12, pan: 0.15 },
    CK: { ins: pick([V.anvil({ f: 1240, decay: 0.3, strike: 0.5 }), V.anvil({ f: 1480, decay: 0.25, strike: 0.5 }), V.anvil({ f: 990, decay: 0.35, strike: 0.5 })]), bus: 'hall', db: -16, pan: -0.3, hum: 0.003 },
    HC: { ins: pick(HATS({ tune: 0.86, decay: 0.045, bp: 7000 }).map((o) => INS.hat(o))), pan: 0.25, hum: 0.003, vel: 1.5 },
    HO: { ins: () => INS.hat({ v: 151, decay: 0.26, gain: 0.55, tune: 0.86 }), db: -16, pan: 0.25 },
    TH: { ins: () => INS.tom(IN.tom.h, { v: 151, decay: 0.5, drive: 2.4 }), bus: 'hall', pan: -0.4 },
    TM: { ins: () => INS.tom(IN.tom.m, { v: 151, decay: 0.55, drive: 2.4 }), bus: 'hall' },
    TL: { ins: () => INS.tom(IN.tom.l, { v: 151, decay: 0.6, drive: 2.4 }), bus: 'hall', pan: 0.4 },
    CR: { ins: () => INS.crash({ v: 151, decay: 2 }), bus: 'hall', db: -9, pan: -0.25 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (id === 'I') {
      for (const [s, db] of [[0, -2], [3, -5], [6, -4], [10, -3], [12, -6]]) d('CK', o + s, db);
      if (b >= 2) { d('K', o, -4); d('K', o + 8, -6); }
      if (b === 3) for (let s = 8; s < 16; s++) d('HC', o + s, -24 + (s - 8));
      continue;
    }
    if (b === 0) d('CR', o);
    if (half) {
      d('K', o); d('K', o + 10, -3);
      d('SN', o + 8); d('AN', o + 8);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, -20);
      for (const s of [3, 7, 13]) d('CK', o + s, -2);
      if (last) [['TH', -10], ['TH', -9], ['TM', -8], ['TM', -7], ['TL', -6], ['TL', -5], ['TL', -4], ['TL', -3]].forEach(([k, db], i) => d(k, o + 8 + i, db));
      continue;
    }
    const kicks = id === 'A' ? [0, 3, 8, 11] : id === 'B' ? (b % 2 ? [0, 6, 8, 10] : [0, 8]) : id === 'C' ? [0, 4, 8, 10, 12] : [0, 2, 4, 8, 10, 12];
    for (const s of kicks) d('K', o + s, s % 4 ? -3 : 0);
    if (last && id === 'A') d('K', o + 14, -2);
    d('SN', o + 4); d('SN', o + 12); d('AN', o + 4); d('AN', o + 12);
    if (id === 'C' && b === 2) d('CR', o);
    const fill = last && (id === 'A' || id === 'B');
    for (let s = 0; s < 16; s += id === 'A' ? 2 : 1) {
      if (fill && s >= 12) break;
      if ((id === 'C' || id === 'E') && s % 4 === 2) continue;
      d('HC', o + s, s % 4 === 0 ? -14 : s % 2 ? -20 : -16.5);
    }
    if (id === 'C') for (const s of [2, 6, 10, 14]) d('HO', o + s); else if (id === 'E') { d('HO', o + 6); d('HO', o + 14); } else if (!fill) d('HO', o + 14);
    if (id === 'B') for (const s of [2, 10]) d('CK', o + s, -2);
    if (fill) [['TH', -8], ['TM', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 12 + i, db));
  }
  // ---------------- heat
  if (sec.mel) {
    const siren = half;
    line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...IN.lead, from, glide: siren ? 0.45 : 0.04, ...(siren ? { vib: 30, vibHz: 4.5, vibDelay: 0.6, a: 0.25, r: 0.8, sq: 0.3, cut: 2600 } : {}) }), siren ? -12 : id === 'B' ? -6.5 : -8);
    if (id === 'C' || id === 'E') line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { ...IN.lead, from, glide: 0.04, cut: 2400 }), -15, { oct: -12, hum: 0 });
  }
  if (id === 'A') {
    sec.P.forEach((c) => {
      const root = bassRoot(c.bass, 40);
      for (const s of c.bar === 3 ? [0, 3, 6, 8, 10, 12, 14] : [0, 3, 6, 10]) X.add('heat', 'hall', INS.braam(root + 12, 0.16, IN.stab), (c.s0 + s) * S, s ? -11.5 : -9, 0, 0.2);
    });
    X.add('heat', 'hall', INS.scrape(1.4, { ring: 520, to: 0.3 }), X.t(nb - 1, 8), -14);
  }
  if (id === 'C' || id === 'E') {
    sec.P.forEach((c, i) => {
      X.add('heat', 'hall', INS.braam(bassRoot(c.bass, 40), X.bar * 0.8, { a: 0.05, drive: 3.2, cutPeak: 3000, cutEnd: 600, r: 1.0, rasp: 0.3 }), c.s0 * S, c.bar === 0 ? -8 : -10, 0, 0.15);
      for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'a', a: 0.25, r: 0.8, vib: 18 }), c.s0 * S, -14, 0, 0.2);
    });
    if (id === 'C') X.add('heat', 'hall', INS.impact({ v: 151, decay: 1.6, metal: 0.4 }), 0, -9);
  }
  if (half) sec.P.forEach((c, i) => { for (const m of sec.V[i].slice(0, 2)) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'o', a: 0.6, r: 1.0 }), c.s0 * S, -14, 0, 0.1); });
  if (id === 'I') {
    X.add('heat', 'hall', INS.riser(X.bar * 2, { f0: 200, f1: 6000, q0: 1, q1: 4, gain: 0.5, saws: 0.3, note: 52, rise: 1200 }), X.t(2), -13);
    X.add('heat', 'hall', INS.scrape(1.8, { ring: 700 }), X.t(1), -15);
  }
  if (id === 'B') X.add('heat', 'hall', INS.riser(X.bar, { f0: 400, f1: 7000, gain: 0.5, saws: 0.25, note: 52 }), X.t(nb - 1), -13);
}

// ================================================================== 6. 星際遠征 · Hybrid epic
// 90 BPM half-time, D minor. Spiccato string ostinato, taiko ensemble and booms, brass theme
// (statement -> heroic climax), choir, braams, Neapolitan-coloured bridge, piano motif.
const EP = {
  spic: { a: 0.004, d: 0.1, s: 0.25, r: 0.12, cut: 2400, cutPeak: 4200, cutStart: 1400, spread: 12, voices: 5, hp: 120 },
  low: { a: 0.3, d: 1, s: 0.9, r: 1.0, cut: 1300, cutPeak: 1900, cutStart: 400, spread: 16, hp: 60 },
  horn: { cut: 1500, a: 0.06, r: 0.4, vib: 8 },
  taikoBig: { v: 161, f: 50, decay: 1.4, skin: 0.6, slap: 0.3 },
  taiko: [{ v: 162 }, { v: 163, f: 58 }, { v: 164, f: 66, decay: 0.85 }],
  boom: { v: 162, p0: 120, p1: 42, pt: 0.07, decay: 0.9, click: 0.25, drive: 2.2 },
  snare: { v: 161, decay: 0.34, gate: 0.85, tone: 2100, f1: 210, body: 0.7 },
  ost: [0, 0, 1, 0, 2, 0, 1, 0, 0, 0, 1, 0, 2, 1, 0, 3],
};
function epic(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const climax = id === 'C', bridge = id === 'D', intro = id === 'I';
  for (let b = 0; b < nb; b++) X.pumpTimes.push(X.t(b), X.t(b, 8));
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S;
    const root = bassRoot(c.bass, 38);
    const v = sec.V[i];
    X.add('bed', 'dry', INS.sub(bassRoot(c.bass, 31), X.bar * 0.97, { a: intro ? 1 : 0.05, r: 0.4 }), t0, -14, 0, 0.3);
    for (const m of [root, root + 7]) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, EP.low), t0, -12, 0, 0.3);
    for (const m of v) X.add('bed', 'hall', INS.pad(m + 12, X.bar * 0.97, { ...EP.low, cut: 1900, a: 0.5 }), t0, intro || bridge ? -14 : -17, 0, 0.2);
    if (!intro) {
      const tones = [v[0], v[1], v[2], v[3] ?? v[0] + 12];
      for (let s = 0; s < 16; s += bridge ? 2 : 1) {
        const acc = s % 4 === 0;
        X.add('bed', 'hall', INS.pad(tones[EP.ost[s]], 0.13, EP.spic), t0 + s * S + X.hum(0.003), X.vel(acc ? -9.5 : -12.5, 0.8), s % 2 ? 0.25 : -0.25, 0.3);
      }
    }
  });
  if (intro || bridge) {
    const motif = intro ? M('A4:4 D5:4 E5:4 F5:4 | E5:8 D5:8') : M('D5:4 F5:4 G5:4 Bb5:4 | G5:8 Eb5:8 | F5:4 D5:4 Bb4:8 | A4:8 C#5:8');
    for (const [st, m, len] of motif) X.add('bed', 'hall', V.ep(m, 2.5, { vel: 0.4, trem: 0, index: 0.8, decay: 3 }), st * S, -11, 0, 0, { cut: len * S, rel: 0.9 });
  }
  // ---------------- drums
  const d = kit(X, {
    BIG: { ins: () => INS.taiko(EP.taikoBig), bus: 'hall', db: -3, hum: 0.004 },
    TK: { ins: pick(EP.taiko.map((o) => INS.taiko(o))), bus: 'hall', db: -8, hum: 0.005, vel: 1.5 },
    BM: { ins: () => INS.kick(EP.boom), db: -4 },
    SN: { ins: () => INS.snare(EP.snare), bus: 'hall', db: -3.5, vel: 0.6 },
    TH: { ins: () => INS.tom(52, { v: 161, decay: 0.7 }), bus: 'hall', pan: -0.4, hum: 0.003 },
    TM: { ins: () => INS.tom(47, { v: 161, decay: 0.75 }), bus: 'hall', hum: 0.003 },
    TL: { ins: () => INS.tom(42, { v: 161, decay: 0.85 }), bus: 'hall', pan: 0.4, hum: 0.003 },
    SH: { ins: () => INS.shaker({ v: 161 }), db: -24, pan: -0.3, hum: 0.004, vel: 1.5 },
    HC: { ins: pick(HATS().map((o) => INS.hat(o))), db: -20, pan: 0.3, hum: 0.003, vel: 1.5 },
    CR: { ins: () => INS.crash({ v: 161, decay: 3 }), bus: 'hall', db: -9, pan: -0.2 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      d('BIG', o, b ? -5 : -2);
      if (last) for (let i = 0; i < 8; i++) d('TK', o + 8 + i, -16 + i * 1.6, i % 2 ? 0.35 : -0.35);
      continue;
    }
    if (bridge) {
      if (b % 2 === 0) { d('BIG', o, -2); d('BM', o, -2); }
      d('TK', o + 10, -4, 0.3);
      if (last) [['TH', -12], ['TH', -11], ['TM', -10], ['TM', -9], ['TL', -8], ['TL', -7], ['TL', -6], ['TL', -5]].forEach(([k, db], i) => d(k, o + 8 + i, db));
      continue;
    }
    if (b === 0) d('CR', o);
    if (climax && b === 2) d('CR', o);
    d('BIG', o); d('BIG', o + 10, -3);
    if (id !== 'A' || b % 2) d('BM', o, climax ? 0 : -2);
    if (climax) d('BM', o + 8, -3);
    d('SN', o + 8);
    if (climax) { d('SN', o + 4, -8); d('SN', o + 12, -7); }
    const hits = id === 'A' ? [3, 6, 11, 14] : [0, 3, 6, 8, 10, 11, 14];
    if (!(last && climax)) hits.forEach((s, k) => d('TK', o + s, s % 8 === 0 ? -2 : 0, k % 2 ? 0.35 : -0.35));
    for (let s = 0; s < 16; s++) d('SH', o + s, s % 2 ? 0 : 2);
    if (id !== 'A') for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -2 : 0);
    if (last && !climax) [['TH', -9], ['TM', -8], ['TL', -7], ['TL', -6]].forEach(([k, db], i) => d(k, o + 12 + i, db));
    if (last && climax) for (let i = 0; i < 16; i++) d('TK', o + i, -12 + i * 0.7, i % 2 ? 0.35 : -0.35);
  }
  // ---------------- heat
  if (sec.mel && !bridge) {
    line(X, 'heat', 'hall', sec.mel, (m, len, from) => V.horn(m, len, { ...EP.horn, from, glide: 0.07 }), climax ? -7 : -8);
    line(X, 'heat', 'hall', sec.mel, (m, len, from) => V.horn(m, len, { ...EP.horn, from, glide: 0.07, cut: 1100 }), climax ? -12 : -13, { oct: -12, hum: 0 });
    if (climax) line(X, 'heat', 'hall', sec.mel, (m, len) => INS.choir(m, len, { vowel: 'a', a: 0.12, r: 0.6, vib: 16 }), -12, { legato: false, hum: 0 });
  }
  if (bridge) line(X, 'heat', 'hall', sec.mel, (m, len) => INS.choir(m, len, { vowel: 'o', a: 0.5, r: 1.2 }), -6, { legato: false, hum: 0 });
  if (id === 'A') {
    sec.P.forEach((c) => {
      const r0 = bassRoot(c.bass, 38);
      X.add('heat', 'hall', V.horn(r0, 3 * S, { ...EP.horn, cut: 1000, a: 0.02 }), c.s0 * S, -10, 0, 0.1);
      X.add('heat', 'hall', V.horn(r0, 12 * S, { ...EP.horn, cut: 900, a: 0.05 }), (c.s0 + 3) * S, -11, 0, 0.1);
    });
    X.add('heat', 'hall', INS.riser(X.bar, { f0: 300, f1: 7000, q0: 0.8, q1: 3, gain: 0.5, saws: 0.25, note: 50 }), X.t(nb - 1), -13);
  }
  if (id !== 'A' && !intro) sec.P.forEach((c, i) => { for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m + 12, X.bar * 0.95, { vowel: climax ? 'a' : 'o', a: 0.4, r: 1.0 }), c.s0 * S, climax ? -14 : -16, 0, 0.15); });
  if (climax) {
    X.add('heat', 'hall', INS.impact({ v: 161, decay: 2.4 }), 0, -6);
    sec.P.forEach((c) => X.add('heat', 'hall', INS.braam(bassRoot(c.bass, 38), X.bar * 0.8, { a: 0.08, cutPeak: 2600, cutEnd: 560, r: 1.4, drive: 2.4 }), c.s0 * S, c.bar % 2 ? -10 : -8, 0, 0.15));
  }
  if (intro) X.addRev('heat', 'hall', INS.revCrash({ v: 161, decay: 2.4 }), X.t(nb), -11, 0.2);
  if (id === 'B') X.addRev('heat', 'hall', INS.revCrash({ v: 162, decay: 1.8 }), X.t(nb), -12, -0.2);
}

// ================================================================== 7. 超光速躍遷 · Trance
// 138 BPM, B minor. Four-on-the-floor, rolling sidechained bass, 3-against-4 pluck arps, piano
// breakdown, snare-roll build, supersaw anthem lead with trance-gated pads.
const TR = {
  kick: { v: 171, p0: 160, p1: 47, pt: 0.05, decay: 0.48, click: 0.38, knock: 0.3, drive: 2.0 },
  bass: { cut: 520, accCut: 900, q: 2.5, drive: 1.8, sub: 0.75, len: 0.08 },
  pad: { a: 0.4, d: 1, s: 0.9, r: 1, cut: 2200, cutPeak: 3200, cutStart: 600, spread: 22, hp: 160 },
  arp: { decay: 0.24, cut0: 5000, cut1: 800, fdecay: 0.09, q: 1.8, detune: 8 },
  lead: { a: 0.006, d: 0.25, s: 0.75, r: 0.3, cut: 5200, cutPeak: 8000, cutStart: 3000, spread: 24, voices: 7, hp: 220, gain: 0.3 },
  gate: { a: 0.003, d: 0.06, s: 0.5, r: 0.05, cut: 3800, cutPeak: 6000, cutStart: 2500, spread: 20, hp: 250 },
  hook: 'D6:3 C#6:3 B5:2 F#5:4 B5:2 C#6:2 | D6:3 C#6:3 B5:2 G5:4 B5:2 D6:2 | E6:3 D6:3 C#6:2 A5:4 F#5:2 A5:2 | C#6:6 B5:2 A5:4 C#6:4',
};
function trance(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const brk = id === 'B', build = id === 'C', peak = id === 'D' || id === 'E';
  const kickOn = (b) => !brk && !(build && b >= 2);
  for (let b = 0; b < nb; b++) if (kickOn(b)) for (let q = 0; q < 4; q++) X.pumpTimes.push(X.t(b, q * 4));
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const root = bassRoot(c.bass, 31);
    const v = sec.V[i];
    if (brk) {
      X.add('bed', 'dry', INS.sub(root, c.len * S * 0.97, { a: 0.4, r: 0.6 }), t0, -14, 0, 0);
      for (const m of v) X.add('bed', 'hall', INS.pad(m, c.len * S * 0.97, TR.pad), t0, -10.5, 0, 0);
    } else {
      for (let s = 0; s < c.len; s++) {
        if (s % 4 === 0) continue;
        if (build && b >= 2 && s % 2) continue;
        X.add('bed', 'dry', INS.bass(root, { ...TR.bass, accent: s % 4 === 2 ? 1 : 0.45 }), t0 + s * S, s % 4 === 2 ? -6 : -8, 0, 0.7);
      }
      for (const m of v) X.add('bed', 'hall', INS.pad(m, c.len * S * 0.97, TR.pad), t0, peak ? -17 : -15, 0, 0.6);
    }
    if (!brk) {
      const tones = [v[1] + 12, v[2] + 12, v[3] + 12];
      const cut0 = id === 'I' ? [1600, 2400, 3400, 5000][b] : build ? 3000 + b * 900 : TR.arp.cut0;
      for (let s = 0; s < c.len; s++) X.add('bed', 'delay', INS.pluck(tones[s % 3], { ...TR.arp, cut0 }), t0 + s * S, s % 4 === 0 ? (peak ? -16 : -13) : (peak ? -18 : -15.5), s % 2 ? 0.3 : -0.3, 0.5);
    }
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: () => INS.kick(TR.kick), db: -1, vel: 0.4 },
    CL: { ins: () => INS.clap({ v: 171, tone: 1350, decay: 0.2 }), db: -6, pan: 0.05 },
    SL: { ins: () => INS.snare({ v: 171, decay: 0.18, gate: 0.3, tone: 2600 }), db: -12 },
    HC: { ins: pick(HATS({ decay: 0.04 }).map((o) => INS.hat(o))), pan: 0.25, hum: 0.002, vel: 1.2 },
    HO: { ins: () => INS.hat({ v: 171, decay: 0.2, gain: 0.55 }), db: -13.5, pan: 0.2 },
    RD: { ins: () => V.ride({ decay: 1.4, tune: 0.9 }), db: -17, pan: -0.3 },
    CR: { ins: () => INS.crash({ v: 171, decay: 2.6 }), bus: 'hall', db: -8.5, pan: -0.2 },
    RL: { ins: pick([0, 1, 2, 3].map((k) => INS.snare({ v: 172 + k, decay: 0.14, gate: 0.4, tone: 2400 + k * 300, f1: 220 + k * 25 }))), db: 0, hum: 0.002, vel: 0.8 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (brk) {
      if (last) for (let s = 8; s < 16; s += 2) d('RL', o + s, -22 + (s - 8) * 1.5);
      continue;
    }
    if (kickOn(b)) for (const s of [0, 4, 8, 12]) d('K', o + s);
    if (id === 'I') {
      if (b >= 1) for (let s = 0; s < 16; s += 2) d('HC', o + s, -22);
      if (b >= 2) for (const s of [2, 6, 10, 14]) d('HO', o + s, -3);
      continue;
    }
    if (build) {
      const div = [4, 2, 1, 1][b];
      for (let s = 0; s < 16; s += div) {
        const t = o + s;
        const prog = (b * 16 + s) / (nb * 16);
        d('RL', t, -20 + prog * 16);
        if (b === 3 && s >= 8) d('RL', t + 0.5, -20 + prog * 16);
      }
      for (let s = 0; s < 16; s++) d('HC', o + s, s % 2 ? -22 : -19);
      continue;
    }
    if (b === 0) d('CR', o);
    d('CL', o + 4); d('CL', o + 12); d('SL', o + 4); d('SL', o + 12);
    for (let s = 0; s < 16; s++) if (s % 4 !== 2) d('HC', o + s, s % 4 === 0 ? -16 : -20);
    for (const s of [2, 6, 10, 14]) d('HO', o + s);
    if (peak) for (const s of [0, 4, 8, 12]) d('RD', o + s);
    if (last && id === 'A') for (const s of [13, 14, 15]) d('CL', o + s, -4 + (s - 13));
  }
  // ---------------- heat
  if (id === 'A') for (const [st, m] of sec.mel) X.add('heat', 'delay', INS.pluck(m, { ...TR.arp, decay: 0.32, cut0: 6500, cut1: 1100, sq: 0.2 }), st * S + X.hum(0.002), X.vel(-5, 0.6), 0, 0.3);
  if (peak) {
    line(X, 'heat', 'delay', sec.mel, (m, len, from, steps) => INS.pad(m, steps * S * 0.94, TR.lead), -5, { legato: false, pump: 0.25 });
    line(X, 'heat', 'delay', sec.mel, (m, len, from, steps) => INS.pad(m, steps * S * 0.94, { ...TR.lead, cut: 6500 }), -12.5, { legato: false, oct: 12, hum: 0, pump: 0.25 });
    sec.P.forEach((c, i) => {
      for (const s of [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15]) for (const m of sec.V[i]) X.add('heat', 'hall', INS.pad(m + 12, 0.09, TR.gate), (c.s0 + s) * S, s % 4 === 0 ? -17 : -19.5, 0, 0.5);
      for (const m of sec.V[i].slice(-2)) X.add('heat', 'hall', INS.choir(m + 12, X.bar * 0.95, { vowel: 'a', a: 0.3, r: 0.8 }), c.s0 * S, -17, 0, 0.4);
    });
  }
  if (brk) {
    for (const [st, m, len] of sec.mel) {
      X.add('heat', 'delay', V.ep(m + 12, 2.6, { vel: 0.5, trem: 0, index: 0.9, decay: 3.2 }), st * S, -15, 0, 0, { cut: len * S, rel: 0.8 });
      X.add('heat', 'delay', INS.bell(m + 24, { ratio: 3.5, index: 1.4, decay: 2.4, idxDecay: 0.5, gain: 0.3, strike: 0.15 }), st * S, -25, 0.25);
    }
    X.addRev('heat', 'hall', INS.revCrash({ v: 171, decay: 2.4 }), X.t(nb), -10, 0.2);
  }
  if (build) {
    X.add('heat', 'hall', INS.riser(X.bar * 4, { f0: 200, f1: 9000, q0: 0.7, q1: 4, gain: 0.5, saws: 0.3, note: 59, rise: 2400 }), 0, -11);
    sec.P.forEach((c, i) => { for (const m of sec.V[i]) X.add('heat', 'hall', INS.pad(m + 12, c.len * S * 0.97, { ...TR.pad, cut: 1200 + c.bar * 900, cutPeak: 1600 + c.bar * 1200 }), c.s0 * S, -15, 0, 0.3); });
  }
  if (id === 'I') X.addRev('heat', 'hall', INS.revCrash({ v: 172, decay: 2 }), X.t(nb), -12, -0.2);
}

// ================================================================== 8. 像素突擊 · Chiptune
// 150 BPM, E major. NES-style 2A03 voices: 25% pulse lead with vibrato, 50% pulse harmony,
// 4-bit triangle bass, LFSR noise drums, 50 Hz arpeggiated chords; minor bridge, bVI-bVII-I lift.
const CH = {
  lead: { duty: 0.25, vib: 22, vibDelay: 0.14, vibHz: 6, a: 0.003, d: 0.15, s: 0.65, r: 0.06, lp: 9000 },
  harm: { duty: 0.5, a: 0.003, d: 0.2, s: 0.55, r: 0.06, lp: 6000 },
  tri: { tri: true, a: 0.002, d: 0.01, s: 1, r: 0.015, gain: 0.35 },
  arp: { duty: 0.125, arpStep: 1 / 50, a: 0.003, d: 0.25, s: 0.55, r: 0.05, lp: 7000 },
};
const CHIPDRUM = {
  kick: () => spec('chip|kick', 1, 0.2, ['peak', -1], (c, out, rng) => { pulse(c, out, 0, 0.09, 52, { tri: true, drop: 28, dropT: 0.07, a: 0.001, s: 1, d: 0.05, r: 0.02, gain: 0.6 }); chipNoise(c, out, 0, { rate: 30000, decay: 0.03, dur: 0.05, gain: 0.25, rng }); }),
  snare: () => spec('chip|snare', 1, 0.24, ['peak', -1], (c, out, rng) => { chipNoise(c, out, 0, { rate: 16000, decay: 0.15, dur: 0.2, gain: 0.5, rng }); pulse(c, out, 0, 0.05, 57, { tri: true, drop: 12, dropT: 0.05, a: 0.001, s: 1, d: 0.03, r: 0.02, gain: 0.35 }); }),
  hat: () => V.noise8({ rate: 80000, decay: 0.035, dur: 0.05, hp: 5000, gain: 0.5 }),
  ohat: () => V.noise8({ rate: 80000, decay: 0.2, dur: 0.25, hp: 4000, gain: 0.5 }),
  tink: () => V.noise8({ short: true, rate: 40000, decay: 0.06, dur: 0.08, hp: 2000, gain: 0.5 }),
  crash: () => V.noise8({ rate: 50000, decay: 0.9, dur: 1.0, hp: 2500, gain: 0.5 }),
};
function chip(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const intro = id === 'I', brk = id === 'E', heroic = id === 'D';
  // ---------------- bed: triangle bass + arpeggiated chords
  sec.P.forEach((c) => {
    const t0 = c.s0 * S;
    const root = bassRoot(c.bass, 36);
    const pat = brk ? [0, 7, 12, 7] : heroic ? [0, 12, 0, 12, 0, 12, 7, 12] : [0, 12, 0, 12, 0, 12, 7, 12];
    const every = brk ? 4 : 2;
    for (let s = 0, k = 0; s < c.len; s += every, k++) X.add('bed', 'dry', V.pulse(root + pat[k % pat.length], every * S * 0.85, CH.tri), t0 + s * S, s % 8 === 0 ? -6 : -8, 0);
    const iv = c.iv.length > 3 ? c.iv.slice(0, 4) : c.iv;
    const top = bassRoot(c.root, 64);
    const half = Math.min(8, c.len);
    for (let s = 0; s < c.len; s += half) X.add('bed', 'delay', V.pulse(top, half * S * 0.92, { ...CH.arp, arp: iv }), t0 + s * S, brk ? -15 : -16.5, (s / half) % 2 ? 0.3 : -0.3);
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: CHIPDRUM.kick, db: -2 },
    SN: { ins: CHIPDRUM.snare, db: -4, vel: 0.6 },
    HC: { ins: CHIPDRUM.hat, db: -15, pan: 0.2, vel: 1 },
    HO: { ins: CHIPDRUM.ohat, db: -17, pan: 0.2 },
    TK: { ins: CHIPDRUM.tink, db: -18, pan: -0.25 },
    CR: { ins: CHIPDRUM.crash, db: -14, pan: -0.2 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      const div = b === 0 ? 2 : 1;
      for (let s = 0; s < 16; s += div) d('SN', o + s, -16 + (b * 16 + s) * 0.45);
      if (b === 0) d('K', o);
      continue;
    }
    if (brk) {
      for (let s = 0; s < 16; s += 2) d('HC', o + s, s % 4 ? -4 : -2);
      if (b % 2 === 0) d('K', o, -3);
      if (last) for (let s = 8; s < 16; s++) d('SN', o + s, -14 + (s - 8));
      continue;
    }
    if (b === 0) d('CR', o);
    const kicks = heroic ? [0, 4, 8, 12] : id === 'C' ? [0, 6, 8] : [0, 8, 10];
    for (const s of kicks) d('K', o + s);
    d('SN', o + 4); d('SN', o + 12);
    const fill = last && id !== 'D';
    for (let s = 0; s < 16; s += heroic || id === 'C' ? 1 : 2) { if (fill && s >= 12) break; d('HC', o + s, s % 4 === 0 ? 0 : -3); }
    if (!fill) d('HO', o + 14);
    if (id === 'C') for (const s of [3, 11]) d('TK', o + s);
    if (fill) for (let s = 12; s < 16; s++) d('SN', o + s, -8 + (s - 12) * 1.5);
    if (heroic && last) d('CR', o + 8, 2);
  }
  // ---------------- heat: lead + harmony
  if (sec.mel) {
    line(X, 'heat', 'delay', sec.mel, (m, len, from) => V.pulse(m, len, { ...CH.lead, from, glide: 0.03 }), brk ? -11 : -8, { hum: 0 });
    const harm = (m) => (id === 'C' || brk || heroic ? m - 12 : diatonic(m, -2, E_MAJOR));
    line(X, 'heat', 'delay', sec.mel.map(([st, m, len]) => [st, harm(m), len]), (m, len, from) => V.pulse(m, len, { ...CH.harm, from, glide: 0.03 }), brk ? -18 : -15.5, { hum: 0, pan: 0.2 });
  }
}

// ================================================================== 9. 戰鼓雷霆 · Cyber taiko
// 96 BPM, D in-scale (miyako-bushi: D Eb G A Bb). O-daiko / nagado / shime ensemble with kakegoe
// shouts and atarigane, koto ostinato, shakuhachi with meri bends, drones; choir and braams at
// the climax, a synth pulse underneath for the sci-fi edge.
const TK = {
  drone: { a: 0.8, d: 1, s: 0.9, r: 1.2, cut: 900, cutPeak: 1300, cutStart: 300, spread: 14, hp: 70, voices: 5 },
  koto: { decay: 1.3, pos: 0.18, twang: 22, gain: 0.5 },
  flute: { breath: 0.38, chiff: 0.7, vib: 26, a: 0.1, r: 0.35, gain: 0.3 },
  odaiko: { v: 181, f: 46, decay: 1.6, skin: 0.65, slap: 0.25, drive: 2.0 },
  nagado: [{ v: 182, f: 64, decay: 0.85, skin: 0.5 }, { v: 183, f: 67, decay: 0.8, skin: 0.45 }],
  bass: { cut: 260, accCut: 700, q: 3, drive: 2, sub: 0.8, len: 0.14 },
  pat: { 2: [62, 69, 74, 75, 74, 69, 67, 69], 3: [63, 70, 75, 74, 70, 67, 63, 67], 7: [67, 70, 74, 75, 74, 70, 69, 70] },
};
function taikoTrack(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const intro = id === 'I', brk = id === 'D', climax = id === 'C';
  for (let b = 0; b < nb; b++) X.pumpTimes.push(X.t(b), X.t(b, 8));
  // ---------------- bed
  sec.P.forEach((c) => {
    const t0 = c.s0 * S;
    const root = bassRoot(c.bass, 38);
    for (const m of [root, root + 7, root + 12]) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, TK.drone), t0, -13, 0, 0.2);
    X.add('bed', 'dry', INS.sub(bassRoot(c.bass, 31), X.bar * 0.97, { a: 0.3, r: 0.5 }), t0, -14, 0, 0.3);
    if (!intro && !brk) for (let s = 0; s < 16; s += 2) X.add('bed', 'dry', INS.bass(root, { ...TK.bass, accent: s % 4 ? 0.3 : 1 }), t0 + s * S, s % 4 ? -12 : -9.5, 0, 0.3);
    const pat = TK.pat[c.root] || TK.pat[2];
    if (brk) {
      for (let s = 0; s < 16; s++) X.add('bed', 'hall', V.koto(pat[0] + 12, { ...TK.koto, decay: 0.6 }), t0 + s * S + X.hum(0.004), -22 + s * 0.6, 0.2);
    } else if (!intro) {
      pat.forEach((m, k) => X.add('bed', 'hall', V.koto(m, TK.koto), t0 + k * 2 * S + X.hum(0.004), X.vel(k % 4 === 0 ? -8.5 : -11, 0.8), k % 2 ? 0.3 : -0.3));
    }
  });
  // ---------------- drums
  const d = kit(X, {
    OD: { ins: () => INS.taiko(TK.odaiko), bus: 'hall', db: -1, hum: 0.004 },
    NG: { ins: pick(TK.nagado.map((o) => INS.taiko(o))), bus: 'hall', db: -6, hum: 0.006, vel: 1.5 },
    SM: { ins: () => INS.tom(66, { v: 181, decay: 0.16, stick: 0.85 }), db: -10, pan: 0.2, hum: 0.004, vel: 1.5 },
    BB: { ins: () => INS.shaker({ v: 181, tone: 7200 }), db: -25, pan: -0.35, hum: 0.005, vel: 2 },
    AT: { ins: () => V.anvil({ f: 2100, decay: 0.18, partials: [[1, 1, 1], [2.7, 0.5, 0.6], [5.1, 0.3, 0.4]], hp: 900, strike: 0.4 }), db: -12, pan: -0.3, hum: 0.004 },
    CL: { ins: () => INS.clap({ v: 181, tone: 1200 }), bus: 'hall', db: -11 },
    HA: { ins: () => V.vox(52, 0.2, { vowel: 'a', drop: 3, breath: 0.4 }), bus: 'hall', db: -11 },
    YO: { ins: () => V.vox(57, 0.55, { vowel: 'o', drop: 5, breath: 0.35 }), bus: 'hall', db: -12 },
  });
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      d('OD', o); d('OD', o + 8, -5);
      if (last) { for (let i = 0; i < 12; i++) d('NG', o + 4 + i, -16 + i * 1.1, i % 2 ? 0.3 : -0.3); d('YO', o + 12); }
      continue;
    }
    if (brk) {
      if (b % 2 === 0) d('OD', o);
      d('NG', o + 10, -4, 0.3);
      for (let s = 0; s < 16; s += 2) d('SM', o + s, -9);
      for (const s of [0, 4, 8, 12]) d('AT', o + s, -3);
      if (last) { for (let i = 0; i < 8; i++) d('NG', o + 8 + i, -14 + i * 1.5, i % 2 ? 0.3 : -0.3); d('HA', o + 15); }
      continue;
    }
    if (climax) {
      for (const s of [0, 4, 8, 12]) d('OD', o + s, s ? -3 : 0);
      if (b === 0) d('YO', o);
      if (b === 2) d('HA', o + 14);
      d('CL', o + 4); d('CL', o + 12);
    } else {
      d('OD', o + (b % 2 ? 10 : 0));
      if (b === 0) d('HA', o + 14, -2);
    }
    const ng = id === 'A' ? [0, 4, 6, 7, 8, 12, 14, 15] : [0, 3, 4, 6, 8, 10, 11, 12, 14];
    if (!(last && climax)) ng.forEach((s, k) => d('NG', o + s, s % 4 === 0 ? 0 : -3, k % 2 ? 0.3 : -0.3));
    else for (let i = 0; i < 16; i++) d('NG', o + i, -10 + i * 0.6, i % 2 ? 0.3 : -0.3);
    for (let s = 0; s < 16; s += climax ? 1 : 2) d('SM', o + s, s % 4 === 0 ? 0 : -3);
    if (!climax) for (const s of [3, 11]) d('SM', o + s, -6);
    for (const s of [2, 6, 10, 14]) d('AT', o + s, -2);
    for (let s = 0; s < 16; s++) d('BB', o + s, s % 4 === 2 ? 2 : s % 2 ? -2 : 0);
  }
  // ---------------- heat
  if (sec.mel) {
    line(X, 'heat', 'hall', sec.mel, (m, len) => V.flute(m, len, { ...TK.flute, bend: len > 0.8 ? 1 : 0.35, fall: len > 1.5 ? 1 : 0 }), intro ? -7 : -5, { legato: false });
    if (climax) line(X, 'heat', 'delay', sec.mel, (m, len, from) => INS.lead(m, len, { from, glide: 0.08, cut: 2600, detune: 8, vib: 18, a: 0.04, r: 0.4, gain: 0.3 }), -15, { oct: -12 });
  }
  if (climax) {
    sec.P.forEach((c) => {
      const root = bassRoot(c.bass, 38);
      X.add('heat', 'hall', INS.braam(root, X.bar * 0.8, { a: 0.07, cutPeak: 2400, cutEnd: 520, r: 1.3, drive: 2.6 }), c.s0 * S, c.bar % 2 ? -13 : -11, 0, 0.15);
      for (const m of [root + 12, root + 19]) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'a', a: 0.3, r: 0.9 }), c.s0 * S, -15, 0, 0.15);
      const sc = TK.pat[c.root] || TK.pat[2];
      for (let s = 0; s < 16; s++) X.add('heat', 'delay', INS.pluck(sc[s % 8] + 12, { decay: 0.2, cut0: 4200, cut1: 600, fdecay: 0.08, q: 2.2, detune: 6 }), (c.s0 + s) * S, -19, s % 2 ? 0.35 : -0.35, 0.2);
    });
  }
  if (id === 'A') sec.P.forEach((c) => { const root = bassRoot(c.bass, 38); for (const m of [root + 24, root + 31]) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'u', a: 0.7, r: 1.0 }), c.s0 * S, -17, 0, 0.1); });
  if (id === 'B' || brk || intro) X.add('heat', 'hall', INS.riser(X.bar, { f0: 250, f1: 6000, q0: 0.8, q1: 3, gain: 0.5, saws: 0.2, note: 50 }), X.t(nb - 1), -14);
}

// ================================================================== 10. 故障電路 · Glitch-hop
// 104 BPM swung, F minor. Funky 16th bass and e-piano stabs, half-time drop with an LFO-synced
// talking growl, pulse lead, vocal-chop riff, stutter rolls and tape-stop drops.
const GH = {
  swing: 0.12,
  ep: { vel: 0.6, trem: 0.1, index: 1.4 },
  bass: { cut: 600, accCut: 1500, q: 4, drive: 2.2, sub: 0.7, len: 0.12 },
  growl: { rate: (104 / 60) * 2, cut0: 160, cut1: 2600, q: 5, drive: 3 },
  lead: { duty: 0.25, vib: 18, vibDelay: 0.16, vibHz: 5.5, a: 0.004, d: 0.12, s: 0.7, r: 0.08, lp: 6000 },
  kick: { v: 191, p0: 150, p1: 50, decay: 0.34, click: 0.3, knock: 0.35, drive: 2.0 },
  snare: { v: 191, decay: 0.18, gate: 0.4, tone: 2400, f1: 230, body: 0.65, crack: 0.5, drive: 1.7 },
  funk: [[0, 0, 1], [3, 0, 0], [6, 12, 1], [7, 0, 0], [10, 0, 1], [12, 10, 0], [14, 12, 0]],
};
const TAPESTOP = (m) => spec(`tapestop|${m}`, 2, 0.75, ['peak', -3], (c, out) => {
  const f = 440 * Math.pow(2, (m - 69) / 12);
  const merger = c.createChannelMerger(2);
  [-8, 8].forEach((det, side) => {
    const o = c.createOscillator();
    o.type = 'sawtooth'; o.detune.value = det;
    o.frequency.setValueAtTime(f, 0); o.frequency.exponentialRampToValueAtTime(f / 6, 0.6);
    o.start(0); o.stop(0.7);
    o.connect(merger, 0, side);
  });
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(3200, 0); lp.frequency.exponentialRampToValueAtTime(220, 0.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.3, 0); g.gain.setTargetAtTime(0, 0.45, 0.06);
  merger.connect(lp); lp.connect(g); g.connect(out);
});
function glitch(X, sec) {
  const S = X.step, id = sec.id, nb = sec.bars;
  const sw = (s) => (Number.isInteger(s) && s % 2 === 1 ? GH.swing * S : 0);
  const drop = id === 'C', brk = id === 'D', intro = id === 'I';
  for (let b = 0; b < nb; b++) for (const s of [0, 10]) X.pumpTimes.push(X.t(b, s));
  // ---------------- bed
  sec.P.forEach((c, i) => {
    const t0 = c.s0 * S, b = c.bar;
    const root = bassRoot(c.bass, 29);
    const v = sec.V[i];
    X.add('bed', 'dry', INS.sub(root, c.len * S * 0.96, { a: 0.02, r: 0.15 }), t0, drop ? -12 : -15, 0, 0.4);
    if (drop) {
      for (const [s, len] of [[0, 6], [6, 2], [8, 4], [12, 4]]) X.add('bed', 'dry', V.growl(root + 12, len * S * 0.95, GH.growl), t0 + s * S, -8, 0, 0.2);
    } else if (!brk && !intro) {
      for (const [s, off, acc] of GH.funk) {
        if (s >= c.len) continue;
        X.add('bed', 'dry', INS.bass(root + 12 + off, { ...GH.bass, accent: acc ? 1 : 0.35 }), t0 + s * S + sw(s), acc ? -6.5 : -9, 0, 0.3);
      }
    }
    const hits = brk ? [[0, 14]] : intro ? [[0, 3], [6, 3], [10, 4]] : drop ? [[0, 2], [6, 2]] : [[0, 2], [3, 2], [6, 2], [10, 3]];
    for (const [s, len] of hits) v.forEach((m, k) => X.add('bed', 'hall', V.ep(m, X.bar * 0.9, GH.ep), t0 + s * S + sw(s) + k * 0.005 + X.hum(0.003), X.vel(drop ? -14 : -11.5, 1), (k - 1.5) * 0.1, 0.25, { cut: len * S, rel: 0.12 }));
    if (brk) for (const m of v) X.add('bed', 'hall', INS.pad(m + 12, X.bar * 0.97, { a: 0.6, d: 1, s: 0.85, r: 1.2, cut: 1800, cutPeak: 2600, cutStart: 500, spread: 18, hp: 200 }), t0, -14, 0, 0);
    void b;
  });
  // ---------------- drums
  const d = kit(X, {
    K: { ins: () => INS.kick(GH.kick), db: -1.5, vel: 0.6 },
    SN: { ins: () => INS.snare(GH.snare), db: -2, hum: 0.002, vel: 0.6 },
    CL: { ins: () => INS.clap({ v: 191, tone: 1400 }), db: -9, pan: 0.08 },
    GS: { ins: () => INS.snare({ ...GH.snare, v: 192, decay: 0.1, gate: 0 }), db: -18, hum: 0.003, vel: 2 },
    RM: { ins: () => V.rim({ f: 1750 }), db: -12, pan: -0.2, hum: 0.003 },
    HC: { ins: pick(HATS({ decay: 0.04 }).map((o) => INS.hat(o))), pan: 0.25, hum: 0.003, vel: 1.5 },
    HO: { ins: () => INS.hat({ v: 191, decay: 0.24, gain: 0.55 }), db: -16, pan: 0.25 },
    ST: { ins: () => INS.snare({ ...GH.snare, v: 193, decay: 0.09, gate: 0 }), db: -10 },
    SH: { ins: () => INS.hat({ v: 192, decay: 0.03, tune: 1.12 }), db: -14, pan: -0.25 },
    CR: { ins: () => INS.crash({ v: 191, decay: 2 }), bus: 'hall', db: -10, pan: -0.2 },
  }, GH.swing);
  for (let b = 0; b < nb; b++) {
    const o = b * 16, last = b === nb - 1;
    if (intro) {
      d('K', o, -4); d('K', o + 10, -6);
      d('RM', o + 4); d('RM', o + 12);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, -20);
      if (last) for (let k = 0; k < 8; k++) d('SH', o + 12 + k * 0.5, -k * 1.2);
      continue;
    }
    if (brk) {
      if (b % 2 === 0) d('K', o, -5);
      d('RM', o + 4, -2); d('RM', o + 12, -2);
      for (let s = 0; s < 16; s += 2) d('HC', o + s, -21);
      continue;
    }
    if (b === 0) d('CR', o);
    if (drop) {
      d('K', o); d('K', o + 10); if (b % 2) d('K', o + 14, -3);
      d('SN', o + 8); d('CL', o + 8);
      for (let s = 0; s < 16; s++) d('HC', o + s, s % 4 === 0 ? -15 : s % 2 ? -21 : -18);
      if (b % 2 === 1) for (let k = 0; k < 4; k++) d('SH', o + 6 + k * 0.5, -k);
    } else {
      const kicks = id === 'B' ? [0, 3, 10] : [0, 6, 10];
      for (const s of kicks) d('K', o + s, s % 4 ? -3 : 0);
      d('SN', o + 4); d('SN', o + 12); d('CL', o + 4); d('CL', o + 12);
      for (const s of [7, 15]) d('GS', o + s);
      for (let s = 0; s < 16; s += id === 'B' ? 2 : 1) d('HC', o + s, s % 4 === 0 ? -15 : s % 2 ? -21 : -18);
      if (id === 'B') { d('HO', o + 6); d('HO', o + 14); d('RM', o + 9); }
      if (b === 1) for (let k = 0; k < 4; k++) d('SH', o + 14 + k * 0.5, -k);
    }
    if (last) for (let k = 0; k < 8; k++) d('ST', o + 12 + k * 0.5, -10 + k * 1.2);
  }
  // ---------------- heat
  if (sec.mel) {
    if (brk) {
      for (const [st, m, len] of sec.mel) X.add('heat', 'delay', V.ep(m, X.bar * 0.9, { ...GH.ep, vel: 0.5 }), st * S + sw(st), -16, 0, 0, { cut: len * S, rel: 0.3 });
    } else {
      line(X, 'heat', 'delay', sec.mel, (m, len, from) => V.pulse(m, len, { ...GH.lead, from, glide: 0.035 }), -8, { hum: 0 });
      if (drop) line(X, 'heat', 'delay', sec.mel, (m, len, from) => V.pulse(m, len, { ...GH.lead, duty: 0.5, from, glide: 0.035 }), -15, { hum: 0, oct: -12, pan: 0.2 });
    }
  }
  if (id === 'B' || intro) {
    sec.P.forEach((c, i) => {
      const v = sec.V[i];
      const notes = [v[3] + 12, v[2] + 12, v[3] + 12, v[1] + 12];
      [0, 3, 6, 10].forEach((s, k) => X.add('heat', 'hall', V.vox(notes[k], S * 1.4, { vowel: k % 2 ? 'o' : 'a', drop: 1 }), (c.s0 + s) * S + sw(s), intro ? -13 : -8.5, k % 2 ? 0.3 : -0.3, 0.2));
    });
  }
  if (id === 'A' || drop) X.add('heat', 'hall', TAPESTOP(nm('F4')), X.t(nb - 1, 12), -12);
  if (id === 'A' || id === 'B') X.addRev('heat', 'hall', INS.revCrash({ v: 191, decay: 1.6 }), X.t(nb), -13, 0.2);
  if (intro) X.add('heat', 'hall', INS.riser(X.bar, { f0: 300, f1: 7000, gain: 0.5, saws: 0.25, note: 53 }), X.t(nb - 1), -13);
}

// ================================================================== track table
const MIX3 = (o = {}) => ({
  bed: { comp: { thr: -13, ratio: 2, attack: 0.02, release: 0.2, knee: 6 }, clip: 0.8, revHp: 220, ...(o.bed || {}),
    buses: { dry: { eq: [['highpass', 28, 0.7], ['peaking', 90, 0.9, 1.2]], rev: 0.03 }, hall: { eq: [['peaking', 350, 1, -2.5], ['highshelf', 7000, 0.7, 1.5]], rev: 0.32 }, delay: { eq: [['highpass', 300, 0.6]], rev: 0.25, dly: 0.32 }, ...((o.bed && o.bed.buses) || {}) } },
  drums: { comp: { thr: -10, ratio: 2.5, attack: 0.008, release: 0.12, knee: 4 }, clip: 0.8, ...(o.drums || {}),
    buses: { dry: { eq: [['highpass', 30, 0.7], ['highshelf', 6500, 0.7, -2.5]], rev: 0.1 }, hall: { eq: [['highpass', 45, 0.7], ['highshelf', 6000, 0.7, -2]], rev: 0.34 }, ...((o.drums && o.drums.buses) || {}) } },
  heat: { comp: { thr: -12, ratio: 2, attack: 0.015, release: 0.18, knee: 6 }, clip: 0.8, ...(o.heat || {}),
    buses: { hall: { eq: [['highpass', 110, 0.6], ['peaking', 400, 1, -2]], rev: 0.38 }, delay: { eq: [['highpass', 220, 0.6], ['highshelf', 7000, 0.7, -1.5]], rev: 0.26, dly: 0.4 }, dry: { eq: [['highpass', 200, 0.7]], rev: 0.05 }, ...((o.heat && o.heat.buses) || {}) } },
});
const BASE = { sr: 32000, stems: ['bed', 'drums', 'heat'], rates: { bed: 24000, heat: 24000 }, target: -15, parts: 2 };

const DEFS = [
  {
    id: 'synthwave', name: '霓虹公路', tag: 'Synthwave', desc: '80 年代霓虹夜駛，閘門軍鼓與合成器主旋律', key: 'F# 小調',
    bpm: 108, tail: 2.2, first: 'I', entry: 'A', stemDb: { bed: -0.5, drums: 1, heat: 7 },
    ir: { len: 3.0, rt60: 2.6, pre: 0.025, hf0: 8500, hf1: 1600, width: 0.14, seed: 51 },
    delay: (60 / 108) * 0.75, delayFb: 0.38, delayLp: 4200,
    mix: MIX3(),
    voicing: { lo: 54, hi: 76, n: 4, center: 64, cluster: 18 },
    sections: [
      { id: 'I', bars: 2, energy: 0, nofold: true, prog: 'F#m E' },
      { id: 'A', bars: 4, energy: 2, prog: 'F#m Dmaj7 A E', mel: 'C#5:6 B4:2 A4:4 C#5:4 | D5:6 C#5:2 A4:8 | E5:6 D5:2 C#5:4 E5:4 | B4:10 G#4:2 A4:2 B4:2' },
      { id: 'B', bars: 4, energy: 2, prog: 'F#m Dmaj7 A E', mel: 'C#5:6 B4:2 A4:4 F#5:4 | F#5:6 E5:2 C#5:4 D5:4 | E5:4 F#5:4 G#5:4 A5:4 | G#5:8 E5:4 B4:4' },
      { id: 'C', bars: 4, energy: 3, prog: 'D E C#m F#m', mel: 'F#5:4 F#5:2 E5:2 F#5:4 A5:4 | G#5:6 F#5:2 E5:4 B4:4 | C#5:4 E5:4 G#5:6 F#5:2 | F#5:12 C#5:2 E5:2' },
      { id: 'D', bars: 4, energy: 2, prog: 'Bm D E C#7', mel: 'D5:8 C#5:4 B4:4 | A4:8 B4:4 C#5:4 | E5:6 D5:2 B4:8 | G#4:4 B4:4 E#5:4 G#5:4' },
      { id: 'E', bars: 4, energy: 1, prog: 'D A E F#m' },
    ],
    next: { I: { A: 1 }, A: { B: 0.5, C: 0.3, D: 0.2 }, B: { C: 0.75, D: 0.25 }, C: { A: 0.35, D: 0.3, E: 0.2, C: 0.15 }, D: { C: 0.6, A: 0.4 }, E: { A: 0.5, C: 0.5 } },
    arrange: synthwave,
  },
  {
    id: 'darksynth', name: '暗夜追獵', tag: 'Darksynth', desc: '失真低音與弗里吉亞音階，壓迫感十足的追擊', key: 'C 小調',
    bpm: 116, tail: 2.0, first: 'I', entry: 'A', stemDb: { drums: 0.5, heat: 8.5 },
    ir: { len: 2.6, rt60: 2.2, pre: 0.02, hf0: 7000, hf1: 1200, width: 0.12, seed: 61 },
    delay: (60 / 116) * 0.75, delayFb: 0.34, delayLp: 3600,
    mix: MIX3({ drums: { comp: { thr: -10, ratio: 3, attack: 0.006, release: 0.1, knee: 4 } } }),
    voicing: { lo: 50, hi: 72, n: 4, center: 61 },
    sections: [
      { id: 'I', bars: 2, energy: 0, nofold: true, prog: 'Cm G' },
      { id: 'A', bars: 4, energy: 2, prog: 'Cm Cm Ab G', mel: 'C5:3 C5:3 Eb5:2 D5:2 C5:2 G4:4 | C5:3 C5:3 Eb5:2 F5:2 Eb5:2 D5:4 | C5:3 C5:3 Eb5:2 Ab5:4 G5:2 F5:2 | D5:6 Eb5:2 D5:4 B4:4' },
      { id: 'B', bars: 4, energy: 2, prog: 'Cm Db Cm G' },
      { id: 'C', bars: 4, energy: 3, prog: 'Ab Eb Fm G', mel: 'C5:4 Eb5:4 Ab5:6 G5:2 | G5:6 F5:2 Eb5:4 Bb4:4 | Ab4:4 C5:4 F5:6 Eb5:2 | D5:6 Eb5:2 D5:4 B4:4' },
      { id: 'D', bars: 4, energy: 1, prog: 'Ab Fm Db G', mel: 'Eb5:12 C5:4 | C5:8 Ab4:8 | F5:12 Db5:4 | D5:8 B4:8' },
      { id: 'E', bars: 4, energy: 3, prog: 'Cm Bb Ab G', mel: 'G5:6 Eb5:2 C5:4 Eb5:4 | F5:6 D5:2 Bb4:4 D5:4 | Eb5:6 C5:2 Ab4:4 C5:4 | D5:6 B4:2 G4:4 B4:4' },
    ],
    next: { I: { A: 1 }, A: { B: 0.4, C: 0.35, E: 0.25 }, B: { C: 0.6, E: 0.4 }, C: { A: 0.3, D: 0.3, E: 0.4 }, D: { C: 0.5, E: 0.5 }, E: { A: 0.35, C: 0.35, D: 0.3 } },
    arrange: darksynth,
  },
  {
    id: 'lofi', name: '靜謐星圖', tag: 'Lo-fi', desc: '慵懶搖擺的電鋼琴與黑膠底噪，適合慢慢佈陣', key: '降 E 大調',
    bpm: 82, tail: 2.0, first: 'D', entry: 'A', stemDb: { bed: -1, drums: 6, heat: 8 }, buildCut: 4200, buildBed: 0.85, heatFloor: 0.4,
    ir: { len: 2.2, rt60: 1.9, pre: 0.02, hf0: 6000, hf1: 1500, width: 0.14, seed: 101 },
    delay: (60 / 82) * 0.75, delayFb: 0.32, delayLp: 3200,
    mix: MIX3({
      bed: { buses: { hall: { eq: [['highpass', 90, 0.6], ['peaking', 300, 1, -1.5], ['highshelf', 6000, 0.7, -3]], rev: 0.22 } } },
      drums: { comp: { thr: -12, ratio: 2, attack: 0.012, release: 0.15, knee: 6 }, buses: { dry: { eq: [['highpass', 35, 0.7], ['lowpass', 9000, 0.6], ['highshelf', 5000, 0.7, -3]], rev: 0.08 } } },
      heat: { buses: { delay: { eq: [['highpass', 250, 0.6], ['lowpass', 7500, 0.6]], rev: 0.3, dly: 0.35 }, dry: { eq: [['highpass', 300, 0.7], ['lowpass', 8000, 0.6]], rev: 0.1 } } },
    }),
    sections: [
      { id: 'A', bars: 4, energy: 2, prog: 'Fm9 Bb13 Ebmaj9 Cm9', voicings: [LFV.Fm9, LFV.Bb13, LFV.Ebmaj9, LFV.Cm9], mel: 'r:2 C5:2 Eb5:4 r:2 F5:2 G5:4 | F5:6 D5:2 C5:8 | r:2 Bb4:2 D5:2 F5:2 G5:8 | Eb5:6 D5:2 Bb4:8' },
      { id: 'B', bars: 4, energy: 2, prog: 'Abmaj9 Gm9 Fm9 C7b9', voicings: [LFV.Abmaj9, LFV.Gm9, LFV.Fm9, LFV.C7b9], mel: 'Eb5:4 G5:4 Bb5:6 G5:2 | F5:4 A5:4 D5:8 | Ab5:4 G5:2 Eb5:2 C5:8 | Db5:6 E5:2 G5:4 Bb5:4' },
      { id: 'C', bars: 4, energy: 2, prog: 'Dbmaj9 Cm9 Fm9 Bb13', voicings: [LFV.Dbmaj9, LFV.Cm9, LFV.Fm9, LFV.Bb13], mel: 'F5:6 Eb5:2 C5:4 Ab4:4 | G5:6 F5:2 Eb5:4 D5:4 | C5:4 Eb5:4 G5:4 Ab5:4 | G5:12 F5:4' },
      { id: 'D', bars: 4, energy: 1, prog: 'Ebmaj9 Abmaj9 Ebmaj9 C7b9', voicings: [LFV.Ebmaj9, LFV['Abmaj9:lo'], LFV.Ebmaj9, LFV['C7b9:lo']] },
    ],
    next: { A: { B: 0.4, C: 0.35, D: 0.25 }, B: { A: 0.7, C: 0.3 }, C: { D: 0.6, B: 0.4 }, D: { A: 1 } },
    arrange: lofi,
  },
  {
    id: 'dnb', name: '量子脈衝', tag: 'Drum & Bass', desc: '172 BPM 碎拍與 Reese 低音，高速突破防線', key: 'G 小調',
    bpm: 172, tail: 1.8, first: 'I', entry: 'A', stemDb: { drums: 2.5, heat: 6 },
    ir: { len: 2.2, rt60: 1.8, pre: 0.015, hf0: 9000, hf1: 2000, width: 0.14, seed: 71 },
    delay: (60 / 172) * 0.75, delayFb: 0.36, delayLp: 4500,
    mix: MIX3({ drums: { comp: { thr: -11, ratio: 3, attack: 0.005, release: 0.08, knee: 4 } } }),
    voicing: { lo: 55, hi: 76, n: 4, center: 65, cluster: 18 },
    sections: [
      { id: 'I', bars: 4, energy: 0, nofold: true, prog: 'Gm9 Gm9 Ebmaj7 Ebmaj7' },
      { id: 'A', bars: 4, energy: 3, prog: 'Gm Gm Eb D' },
      { id: 'B', bars: 4, energy: 3, prog: 'Gm Bb Cm D' },
      { id: 'C', bars: 4, energy: 3, prog: 'Cm Eb Gm F', mel: 'G5:3 Bb5:3 C6:4 Bb5:2 G5:4 | G5:3 Bb5:3 Eb6:4 D6:2 Bb5:4 | G5:3 Bb5:3 D6:4 C6:2 Bb5:2 A5:2 | F5:6 G5:2 A5:4 C6:4' },
      { id: 'D', bars: 4, energy: 1, prog: 'Ebmaj7 Cm9 Gm9 D7sus4,D7', mel: 'G5:6 Bb5:2 D6:8 | Eb6:6 D6:2 Bb5:8 | D6:6 C6:2 Bb5:4 A5:4 | A5:8 F#5:8' },
      { id: 'E', bars: 4, energy: 2, prog: 'Gm9 Ebmaj7 Bb F/A', mel: 'Bb5:4 A5:2 G5:6 D5:4 | Eb5:4 D5:2 Bb4:6 G5:4 | F5:4 D5:4 Bb4:4 F5:4 | E5:8 C5:4 A4:4' },
    ],
    next: { I: { A: 1 }, A: { B: 0.45, C: 0.35, A: 0.2 }, B: { C: 0.45, A: 0.3, D: 0.25 }, C: { A: 0.35, B: 0.25, D: 0.2, E: 0.2 }, D: { A: 0.5, E: 0.5 }, E: { A: 0.4, C: 0.6 } },
    arrange: dnb,
  },
  {
    id: 'industrial', name: '鋼鐵熔爐', tag: 'Industrial', desc: '鐵砧與失真悶音，冷硬的機械工業節奏', key: 'E 小調',
    bpm: 132, tail: 1.8, first: 'I', entry: 'A', stemDb: { heat: 6 },
    ir: { len: 2.0, rt60: 1.6, pre: 0.012, hf0: 7500, hf1: 2500, width: 0.1, seed: 81 },
    delay: (60 / 132) * 0.5, delayFb: 0.3, delayLp: 3800,
    mix: MIX3({ drums: { comp: { thr: -11, ratio: 3, attack: 0.006, release: 0.1, knee: 4 } } }),
    voicing: { lo: 47, hi: 72, n: 4, center: 58 },
    sections: [
      { id: 'I', bars: 4, energy: 0, nofold: true, prog: 'E5 E5 E5 E5' },
      { id: 'A', bars: 4, energy: 2, prog: 'E5 E5 F5 G5' },
      { id: 'B', bars: 4, energy: 2, prog: 'Em C Am B', mel: 'B4:4 E5:4 G5:6 F#5:2 | E5:6 D5:2 C5:4 G4:4 | A4:4 C5:4 E5:6 D5:2 | D#5:8 F#5:4 B5:4' },
      { id: 'C', bars: 4, energy: 3, prog: 'C D Em Em', mel: 'G5:6 E5:2 G5:4 C6:4 | B5:6 A5:2 F#5:4 D5:4 | E5:4 G5:4 B5:4 E6:4 | D6:6 B5:2 B5:8' },
      { id: 'D', bars: 4, energy: 1, prog: 'E5 Bb5 C5 B5', mel: 'E5:16 | F5:16 | G5:16 | F#5:16' },
      { id: 'E', bars: 4, energy: 3, prog: 'Am Em F B', mel: 'A5:4 G5:4 E5:4 C5:4 | B4:4 E5:4 G5:4 B5:4 | A5:6 G5:2 F5:4 C5:4 | D#5:8 B4:8' },
    ],
    next: { I: { A: 1 }, A: { B: 0.45, C: 0.3, A: 0.25 }, B: { C: 0.7, E: 0.3 }, C: { A: 0.3, D: 0.3, E: 0.4 }, D: { A: 0.5, C: 0.5 }, E: { C: 0.5, A: 0.5 } },
    arrange: industrial,
  },
  {
    id: 'epic', name: '星際遠征', tag: 'Epic Hybrid', desc: '太鼓、銅管與合唱的史詩遠征，越戰越激昂', key: 'D 小調',
    bpm: 90, tail: 2.6, first: 'I', entry: 'A', stemDb: { bed: 2, heat: 5 },
    ir: { len: 3.6, rt60: 3.2, pre: 0.03, hf0: 8000, hf1: 1300, width: 0.12, seed: 91 },
    delay: (60 / 90) * 0.75, delayFb: 0.3, delayLp: 3500,
    mix: MIX3({ drums: { buses: { hall: { eq: [['highpass', 35, 0.7], ['highshelf', 6000, 0.7, -2]], rev: 0.3 } } } }),
    voicing: { lo: 50, hi: 70, n: 4, center: 60 },
    sections: [
      { id: 'I', bars: 2, energy: 0, nofold: true, prog: 'Dm Bb/D' },
      { id: 'A', bars: 4, energy: 2, prog: 'Dm Bb Gm A' },
      { id: 'B', bars: 4, energy: 2, prog: 'Dm F C Bb', mel: 'D5:6 E5:2 F5:8 | F5:6 E5:2 C5:8 | D5:6 C5:2 G4:8 | D5:6 C5:2 Bb4:8' },
      { id: 'C', bars: 4, energy: 3, prog: 'Bb F/A Gm A', mel: 'D5:6 F5:2 Bb5:8 | A5:6 G5:2 F5:8 | G5:6 F5:2 D5:8 | C#5:8 E5:8' },
      { id: 'D', bars: 4, energy: 1, prog: 'Gm Eb Bb A', mel: 'Bb4:16 | G4:16 | F4:16 | E4:8 C#5:8' },
    ],
    next: { I: { A: 1 }, A: { B: 0.6, C: 0.25, D: 0.15 }, B: { C: 0.7, D: 0.3 }, C: { A: 0.4, D: 0.35, B: 0.25 }, D: { C: 0.6, A: 0.4 } },
    arrange: epic,
  },
  {
    id: 'trance', name: '超光速躍遷', tag: 'Trance', desc: '四拍底鼓與超鋸齒主旋律，一路加速到光速', key: 'B 小調',
    bpm: 138, tail: 2.2, first: 'I', entry: 'A', stemDb: { bed: 2, heat: 5 },
    ir: { len: 3.2, rt60: 2.8, pre: 0.02, hf0: 9000, hf1: 1800, width: 0.15, seed: 111 },
    delay: (60 / 138) * 0.75, delayFb: 0.4, delayLp: 4500,
    mix: MIX3(),
    voicing: { lo: 54, hi: 76, n: 4, center: 65 },
    sections: [
      { id: 'I', bars: 4, energy: 1, nofold: true, prog: 'Bm G D A' },
      { id: 'A', bars: 4, energy: 2, prog: 'Bm G D A', mel: TR.hook },
      { id: 'B', bars: 4, energy: 0, prog: 'G D A Bm', mel: 'B4:6 A4:2 G4:8 | F#4:6 E4:2 D4:4 A4:4 | C#5:8 E5:8 | D5:12 C#5:4' },
      { id: 'C', bars: 4, energy: 2, prog: 'Em G A F#sus4,F#' },
      { id: 'D', bars: 4, energy: 3, prog: 'Bm G D A', mel: TR.hook },
      { id: 'E', bars: 4, energy: 3, prog: 'G A F#m Bm', mel: 'B5:6 A5:2 B5:4 D6:4 | C#6:6 B5:2 A5:4 E5:4 | F#5:6 A5:2 C#6:4 E6:4 | D6:8 C#6:4 B5:4' },
    ],
    next: { I: { A: 1 }, A: { B: 0.4, D: 0.35, C: 0.25 }, B: { C: 1 }, C: { D: 1 }, D: { E: 0.55, A: 0.25, D: 0.2 }, E: { A: 0.35, B: 0.3, D: 0.35 } },
    arrange: trance,
  },
  {
    id: 'chip', name: '像素突擊', tag: 'Chiptune', desc: '8-bit 方波與三角波，懷舊街機的熱血衝刺', key: 'E 大調',
    bpm: 150, tail: 1.4, first: 'I', entry: 'A', stemDb: { bed: 5, drums: -1, heat: 4 },
    ir: { len: 1.6, rt60: 1.1, pre: 0.01, hf0: 9000, hf1: 3000, width: 0.1, seed: 121 },
    delay: (60 / 150) * 0.75, delayFb: 0.3, delayLp: 5000,
    mix: MIX3({
      bed: { buses: { dry: { eq: [['highpass', 35, 0.7]], rev: 0.04 }, delay: { eq: [['highpass', 250, 0.6], ['highshelf', 6000, 0.7, -3]], rev: 0.15, dly: 0.25 } } },
      heat: { buses: { delay: { eq: [['highpass', 180, 0.6], ['highshelf', 6000, 0.7, -3]], rev: 0.15, dly: 0.3 } } },
      drums: { buses: { dry: { eq: [['highpass', 35, 0.7]], rev: 0.06 } } },
    }),
    sections: [
      { id: 'I', bars: 2, energy: 1, nofold: true, prog: 'A B', mel: 'E5:2 E5:2 E5:2 F#5:2 G#5:4 A5:4 | B5:2 B5:2 B5:2 C#6:2 D#6:8' },
      { id: 'A', bars: 4, energy: 2, prog: 'E B C#m A', mel: 'B5:2 B5:2 G#5:2 B5:2 E6:4 D#6:2 E6:2 | F#6:4 D#6:2 B5:2 F#5:4 B5:2 C#6:2 | E6:4 C#6:2 G#5:2 C#6:4 B5:2 C#6:2 | A5:6 B5:2 C#6:4 B5:4' },
      { id: 'B', bars: 4, energy: 2, prog: 'E B C#m A,B', mel: 'B5:2 B5:2 G#5:2 B5:2 E6:4 D#6:2 E6:2 | F#6:4 D#6:2 B5:2 F#5:4 B5:2 C#6:2 | E6:4 G#6:2 E6:2 C#6:4 E6:2 C#6:2 | A5:4 C#6:4 D#6:4 F#6:4' },
      { id: 'C', bars: 4, energy: 2, prog: 'C#m A F#m G#7', mel: 'G#5:6 C#6:2 E6:8 | E6:6 C#6:2 A5:8 | F#5:4 A5:4 C#6:4 F#6:4 | D#6:4 B#5:4 G#5:4 B#5:4' },
      { id: 'D', bars: 4, energy: 3, prog: 'C D E E', mel: 'G5:2 C6:2 E6:4 D6:2 C6:2 G5:4 | A5:2 D6:2 F#6:4 E6:2 D6:2 A5:4 | B5:2 E6:2 G#6:4 F#6:2 G#6:2 B6:4 | G#6:8 E6:8' },
      { id: 'E', bars: 4, energy: 1, prog: 'A E/G# F#m B', mel: 'C#6:8 E6:8 | B5:8 G#5:8 | A5:8 C#6:4 F#6:4 | D#6:16' },
    ],
    next: { I: { A: 1 }, A: { B: 0.6, C: 0.25, D: 0.15 }, B: { C: 0.4, D: 0.45, A: 0.15 }, C: { D: 0.5, A: 0.3, E: 0.2 }, D: { A: 0.45, E: 0.3, B: 0.25 }, E: { D: 0.5, A: 0.5 } },
    arrange: chip,
  },
  {
    id: 'taiko', name: '戰鼓雷霆', tag: 'Taiko', desc: '和太鼓群與尺八，帶電子脈衝的東方戰陣', key: 'D 都節調式',
    bpm: 96, tail: 2.4, first: 'I', entry: 'A', stemDb: { heat: 9 },
    ir: { len: 3.2, rt60: 2.6, pre: 0.025, hf0: 9000, hf1: 1600, width: 0.12, seed: 131 },
    delay: (60 / 96) * 0.75, delayFb: 0.3, delayLp: 3500,
    mix: MIX3({ drums: { buses: { hall: { eq: [['highpass', 32, 0.7], ['highshelf', 6000, 0.7, -2]], rev: 0.3 }, dry: { eq: [['highpass', 40, 0.7]], rev: 0.15 } } } }),
    sections: [
      { id: 'I', bars: 2, energy: 0, nofold: true, prog: 'D5 D5', mel: 'D5:12 Eb5:4 | D5:16' },
      { id: 'A', bars: 4, energy: 2, prog: 'D5 D5 Eb5 D5' },
      { id: 'B', bars: 4, energy: 2, prog: 'D5 G5 Eb5 D5', mel: 'A4:8 Bb4:4 A4:4 | G4:8 A4:4 Bb4:4 | Eb5:6 D5:2 Eb5:4 Bb4:4 | A4:16' },
      { id: 'C', bars: 4, energy: 3, prog: 'G5 Eb5 D5 D5', mel: 'D5:6 Eb5:2 G5:8 | Bb5:6 A5:2 G5:8 | A5:4 G5:4 Eb5:4 D5:4 | D5:16' },
      { id: 'D', bars: 4, energy: 1, prog: 'Eb5 G5 D5 D5', mel: 'Bb4:16 | D5:8 Bb4:8 | A4:12 G4:4 | A4:16' },
    ],
    next: { I: { A: 1 }, A: { B: 0.6, C: 0.25, A: 0.15 }, B: { C: 0.65, D: 0.35 }, C: { A: 0.4, D: 0.35, B: 0.25 }, D: { C: 0.55, A: 0.45 } },
    arrange: taikoTrack,
  },
  {
    id: 'glitch', name: '故障電路', tag: 'Glitch Hop', desc: '搖擺切分、故障斷音與會說話的低音', key: 'F 小調',
    bpm: 104, tail: 1.8, first: 'I', entry: 'A', stemDb: { drums: 2.5, heat: 5 },
    ir: { len: 2.4, rt60: 2.0, pre: 0.015, hf0: 8500, hf1: 2000, width: 0.14, seed: 141 },
    delay: (60 / 104) * 0.5, delayFb: 0.35, delayLp: 4200,
    mix: MIX3(),
    voicing: { lo: 53, hi: 72, n: 4, center: 62 },
    sections: [
      { id: 'I', bars: 2, energy: 0, nofold: true, prog: 'Fm7 Fm7' },
      { id: 'A', bars: 4, energy: 2, prog: 'Fm7 Fm7 Dbmaj7 C7', mel: 'C5:2 r:1 Eb5:1 F5:2 r:1 Ab5:2 G5:2 F5:2 Eb5:3 | F5:6 r:2 C5:2 r:1 Eb5:2 F5:3 | Ab5:3 F5:3 Db5:2 C5:2 Db5:2 F5:4 | E5:6 G5:2 Bb5:4 C6:4' },
      { id: 'B', bars: 4, energy: 2, prog: 'Bbm7 Eb7 Abmaj7 C7' },
      { id: 'C', bars: 4, energy: 3, prog: 'Fm Fm Db C', mel: 'F5:2 F5:1 F5:1 Ab5:2 F5:2 C6:3 Bb5:3 Ab5:2 | F5:6 r:2 Eb5:2 F5:2 Ab5:4 | Db6:3 C6:3 Ab5:2 F5:4 Db5:4 | C5:2 C5:1 C5:1 E5:2 G5:2 Bb5:4 C6:4' },
      { id: 'D', bars: 4, energy: 1, prog: 'Dbmaj9 Cm7 Bbm9 C7sus4,C7', mel: 'Ab5:6 F5:2 C5:8 | G5:6 Eb5:2 Bb4:8 | F5:6 Db5:2 Ab4:4 C5:4 | G5:8 E5:8' },
    ],
    next: { I: { A: 1 }, A: { B: 0.45, C: 0.4, A: 0.15 }, B: { C: 0.6, A: 0.25, D: 0.15 }, C: { A: 0.35, D: 0.3, C: 0.2, B: 0.15 }, D: { C: 0.6, A: 0.4 } },
    arrange: glitch,
  },
];

export const BGM_TRACKS = {};
export const BGM_LIST = [];
for (const d of DEFS) {
  try { // a broken definition must never take the game down at load time
    BGM_TRACKS[d.id] = { ...BASE, ...d, sections: sections(d.sections, d.voicing) };
    BGM_LIST.push({ id: d.id, name: d.name, tag: d.tag, desc: d.desc, bpm: d.bpm, key: d.key });
  } catch (e) {
    if (typeof console !== 'undefined') console.warn(`[bgm] ${d.id}:`, e);
  }
}
