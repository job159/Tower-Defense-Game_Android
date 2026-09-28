// Sound-effect recipes. Each entry renders offline (per variation) into a short buffer that is
// loudness-normalized to `level` (short-term LUFS) and then played by the runtime voice manager.
//   v: variations, dur: render length (s), ch: 1 mono (panned at runtime) | 2 stereo,
//   sr: render rate, cat: runtime bus, send: reverb send, th: per-name throttle (s),
//   max: max simultaneous voices of this name, pri: steal priority, vary: random pitch range,
//   duck: brief weapons-bus duck amount (big impacts), group: preparation priority group.
import { mtof, crackle, clamp } from './dsp.js';
import {
  gainNode, biquad, chain, osc, noise, perc, glide, shaper, bufferFrom, fmBell, supersaw, choir, braam,
  impact, crash, riser, pluck, leadNote,
} from './synth.js';

// ------------------------------------------------------------------ local building blocks
function chirp(ctx, out, t, o) {
  const { f0, f1 = f0, glideT = 0.05, decay = 0.1, gain = 0.5, ratio = 0, index = 0, idxDecay = 0.05, type = 'sine', attack = 0.001, hold = 0 } = o;
  const end = t + attack + hold + decay * 1.15 + 0.02;
  const nyq = ctx.sampleRate * 0.45;
  if (Math.max(f0, f1) > nyq) return end; // would only alias
  const c = osc(ctx, type, f0, t, end);
  glide(c.frequency, t, f0, f1, glideT);
  if (ratio > 0 && index > 0 && Math.max(f0, f1) * ratio * (1 + index) < nyq * 1.6) {
    const m = osc(ctx, 'sine', f0 * ratio, t, end);
    glide(m.frequency, t, f0 * ratio, f1 * ratio, glideT);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(index * f0 * ratio, t);
    mg.gain.setTargetAtTime(index * f1 * ratio * 0.05, t, Math.max(0.002, idxDecay / 3));
    m.connect(mg); mg.connect(c.frequency);
  }
  const g = ctx.createGain();
  perc(g.gain, t, gain, decay, attack, hold);
  c.connect(g); g.connect(out);
  return end;
}

function thump(ctx, out, t, { p0 = 120, p1 = 45, pt = 0.04, decay = 0.25, gain = 0.8 } = {}) {
  const end = t + decay * 1.1 + 0.02;
  const s = osc(ctx, 'sine', p0, t, end);
  s.frequency.setValueAtTime(p0, t);
  s.frequency.setTargetAtTime(p1, t + 0.001, pt / 2.3);
  const g = ctx.createGain();
  perc(g.gain, t, gain, decay, 0.0008);
  s.connect(g); g.connect(out);
  return end;
}

function burst(ctx, out, t, o) {
  const { kind = 'white', type = 'bandpass', f0 = 2000, f1 = f0, sweep = 0.1, q = 0.8, decay = 0.1, gain = 0.5, attack = 0.001, hold = 0, rng, hp = 0, rate = 1 } = o;
  const end = t + attack + hold + decay * 1.1 + 0.02;
  const n = noise(ctx, kind, t, end, rng, rate);
  const f = biquad(ctx, type, f0, q);
  if (f1 !== f0) glide(f.frequency, t, f0, f1, sweep);
  const g = ctx.createGain();
  perc(g.gain, t, gain, decay, attack, hold);
  if (hp) chain(n, biquad(ctx, 'highpass', hp, 0.7), f, g, out); else chain(n, f, g, out);
  return end;
}

const METAL = [[1, 1, 0.8], [2.76, 0.6, 0.5], [5.4, 0.4, 0.35], [8.93, 0.25, 0.2]];
function ring(ctx, out, t, { f = 400, parts = METAL, gain = 0.3, beat = 0.004, dscale = 1 } = {}) {
  let end = t;
  for (const [r, g, d0] of parts) {
    const fr = f * r, d = d0 * dscale;
    if (fr > ctx.sampleRate * 0.45) continue;
    for (const dt of [0, beat]) {
      const o = osc(ctx, 'sine', fr * (1 + dt), t, t + d * 1.1 + 0.02);
      const gg = ctx.createGain();
      perc(gg.gain, t, gain * g * 0.5, d, 0.001);
      o.connect(gg); gg.connect(out);
    }
    end = Math.max(end, t + d * 1.1);
  }
  return end;
}

function crackles(ctx, out, t, dur, rng, { rate = 80, decay = 0.0015, tone = 2500, q = 0.7, gain = 0.3, env = null, hp = 0 } = {}) {
  const sr = ctx.sampleRate;
  const d = crackle(Math.max(64, Math.floor(dur * sr)), sr, rng, { rate, decay, env });
  const s = ctx.createBufferSource();
  s.buffer = bufferFrom(ctx, [d], sr);
  s.start(t);
  const g = gainNode(ctx, gain);
  if (hp) chain(s, biquad(ctx, 'highpass', hp, 0.7), biquad(ctx, 'bandpass', tone, q), g, out);
  else chain(s, biquad(ctx, 'bandpass', tone, q), g, out);
  return t + dur;
}

function shards(ctx, out, t, dur, rng, { count = 16, fmin = 2500, fmax = 8000, dmin = 0.05, dmax = 0.25, gain = 0.15, spread = 1.6, rise = 0, attack = 0.001 } = {}) {
  for (let i = 0; i < count; i++) {
    const u = rng();
    const tt = t + Math.pow(u, spread) * dur;
    const pos = (tt - t) / dur;
    const f = (fmin + (fmax - fmin) * rng()) * (1 + rise * pos);
    const d = dmin + (dmax - dmin) * rng();
    chirp(ctx, out, tt, { f0: f, f1: f * (0.985 + rng() * 0.03), decay: d, gain: gain * (0.5 + rng() * 0.6), ratio: 1.3 + rng() * 0.9, index: 0.4 + rng() * 1.1, idxDecay: d * 0.5, attack });
  }
  return t + dur + dmax;
}

// resonant "crunch": noise through narrow band-passes with a stuttering gate
function crunch(ctx, out, t, rng, { freqs = [900, 2000, 4200], q = 9, decay = 0.14, gain = 0.5, steps = 7 } = {}) {
  const end = t + decay * 1.2 + 0.03;
  const n = noise(ctx, 'white', t, end, rng);
  const gate = ctx.createGain();
  const p = gate.gain;
  p.setValueAtTime(0, t);
  let tt = t;
  for (let i = 0; i < steps; i++) {
    const lvl = (1 - i / steps) * (0.4 + 0.6 * rng());
    p.setValueAtTime(lvl, tt);
    tt += 0.006 + rng() * 0.012;
  }
  p.setTargetAtTime(0, tt, decay / 5);
  n.connect(gate);
  const sum = gainNode(ctx, gain);
  for (const f of freqs) {
    const bp = biquad(ctx, 'bandpass', f * (0.85 + rng() * 0.3), q);
    gate.connect(bp); bp.connect(sum);
  }
  sum.connect(out);
  return end;
}

function whoosh(ctx, out, t, dur, rng, { f0 = 400, f1 = 2500, q = 1.2, gain = 0.5, attack = 0.05, kind = 'pink' } = {}) {
  const end = t + dur + 0.05;
  const n = noise(ctx, kind, t, end, rng);
  const bp = biquad(ctx, 'bandpass', f0, q);
  glide(bp.frequency, t, f0, f1, dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setTargetAtTime(0, t + attack, (dur - attack) / 3);
  chain(n, bp, g, out);
  return end;
}

function panned(ctx, out, pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(out); return p; }
function sat(ctx, out, drive = 2, asym = 0.03) { const s = shaper(ctx, drive, asym); s.connect(out); return s; }

// explosion tiers shared by several effects
function explosionSmall(ctx, out, t, rng, k = 1) {
  const s = sat(ctx, out, 2.4);
  thump(ctx, s, t, { p0: 115 * k, p1: 46 * k, pt: 0.04, decay: 0.28, gain: 0.9 });
  burst(ctx, s, t, { kind: 'pink', type: 'lowpass', f0: 5200, f1: 380, sweep: 0.3, q: 0.6, decay: 0.42, gain: 1.0, rng });
  crackles(ctx, s, t + 0.01, 0.4, rng, { rate: 120, tone: 2600, gain: 0.35, env: (x) => 1 - x });
  return t + 0.6;
}
function explosionMedium(ctx, out, t, rng, k = 1) {
  const s = sat(ctx, out, 2.5);
  thump(ctx, s, t, { p0: 80 * k, p1: 31 * k, pt: 0.07, decay: 0.9, gain: 1.0 });
  burst(ctx, s, t, { type: 'highpass', f0: 1500, q: 0.7, decay: 0.035, gain: 0.55, rng });
  burst(ctx, s, t, { kind: 'pink', type: 'lowpass', f0: 6500, f1: 260, sweep: 0.75, q: 0.5, decay: 1.05, gain: 1.0, rng });
  burst(ctx, s, t, { kind: 'brown', type: 'lowpass', f0: 240, q: 0.7, decay: 1.4, gain: 0.7, attack: 0.02, rng });
  crackles(ctx, s, t + 0.03, 1.2, rng, { rate: 90, tone: 1900, gain: 0.32, env: (x) => (1 - x) * (1 - x) });
  return t + 1.6;
}
function explosionLarge(ctx, out, t, rng, k = 1) { // stereo out
  const s = sat(ctx, out, 2.6);
  thump(ctx, s, t, { p0: 62 * k, p1: 24 * k, pt: 0.12, decay: 2.1, gain: 1.0 });
  thump(ctx, s, t + 0.12, { p0: 95 * k, p1: 40 * k, pt: 0.05, decay: 0.6, gain: 0.55 });
  burst(ctx, s, t, { type: 'highpass', f0: 1000, q: 0.7, decay: 0.05, gain: 0.7, rng });
  for (const pan of [-0.75, 0.75]) {
    const p = panned(ctx, s, pan);
    burst(ctx, p, t, { kind: 'pink', type: 'lowpass', f0: 7500, f1: 200, sweep: 1.25, q: 0.5, decay: 2.1, gain: 0.95, rng });
    burst(ctx, p, t, { kind: 'brown', type: 'lowpass', f0: 170, q: 0.7, decay: 3.0, gain: 0.75, attack: 0.04, rng });
    crackles(ctx, p, t + 0.05, 2.4, rng, { rate: 70, tone: 1600, gain: 0.3, env: (x) => (1 - x) * (1 - x) });
  }
  return t + 3.2;
}

// ------------------------------------------------------------------ the catalog
const W = 'weapons', I = 'impacts', E = 'enemies', U = 'ui', H = 'hero', A = 'abilities';

export const SFX = {
  // ---------------- weapons
  pulse: {
    v: 4, dur: 0.42, cat: W, level: -25, send: 0.12, th: 0.045, max: 5, pri: 1, vary: 0.05, group: 0,
    build(ctx, out, rng, v) {
      const k = 1 + (v - 1.5) * 0.045;
      const s = sat(ctx, out, 1.8);
      chirp(ctx, s, 0, { f0: 860 * k, f1: 250 * k, glideT: 0.075, decay: 0.16, gain: 0.55, ratio: 1.5, index: 2.6, idxDecay: 0.06 });
      const b = osc(ctx, 'sawtooth', 190 * k, 0, 0.2);
      glide(b.frequency, 0, 190 * k, 85 * k, 0.09);
      const bg = ctx.createGain(); perc(bg.gain, 0, 0.35, 0.12, 0.001);
      chain(b, biquad(ctx, 'lowpass', 1300, 1.2), bg, s);
      burst(ctx, s, 0, { f0: 3600, q: 1.1, decay: 0.022, gain: 0.55, rng });
      thump(ctx, s, 0, { p0: 135, p1: 55, decay: 0.13, gain: 0.55 });
      chirp(ctx, s, 0.01, { f0: 1700 * k, f1: 1150 * k, glideT: 0.15, decay: 0.2, gain: 0.08 });
    },
  },
  gatling: {
    v: 4, dur: 0.14, cat: W, level: -28, send: 0.05, th: 0.034, max: 4, pri: 0, vary: 0.06, group: 0,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.0);
      burst(ctx, s, 0, { f0: 2700 + v * 250, q: 0.8, decay: 0.032, gain: 0.8, rng });
      thump(ctx, s, 0, { p0: 200, p1: 85, pt: 0.012, decay: 0.045, gain: 0.6 });
      chirp(ctx, s, 0, { f0: 2400 + v * 90, decay: 0.022, gain: 0.22, ratio: 2.7, index: 1.4, idxDecay: 0.01 });
      burst(ctx, s, 0.004, { type: 'highpass', f0: 6000, decay: 0.012, gain: 0.3, rng });
    },
  },
  rail: {
    v: 2, dur: 1.9, cat: W, level: -17, send: 0.3, th: 0.09, max: 3, pri: 2, vary: 0.03, duck: 0.25, group: 0,
    build(ctx, out, rng, v) {
      const T = 0.2;
      // charge whine
      const w = osc(ctx, 'sawtooth', 300, 0, T + 0.02);
      glide(w.frequency, 0, 300, 2600 + v * 200, T);
      const wb = biquad(ctx, 'bandpass', 600, 4);
      glide(wb.frequency, 0, 600, 5200, T);
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.02, 0); wg.gain.exponentialRampToValueAtTime(0.4, T); wg.gain.linearRampToValueAtTime(0, T + 0.015);
      chain(w, wb, wg, out);
      chirp(ctx, out, 0, { f0: 700, f1: 5200, glideT: T, decay: 0.05, hold: T - 0.02, gain: 0.12, attack: 0.02 });
      // crack
      const s = sat(ctx, out, 2.4);
      burst(ctx, s, T, { type: 'highpass', f0: 700, q: 0.6, decay: 0.09, gain: 1.0, rng });
      burst(ctx, s, T, { type: 'lowpass', f0: 16000, decay: 0.006, gain: 0.8, rng });
      thump(ctx, s, T, { p0: 115, p1: 34, pt: 0.05, decay: 0.55, gain: 0.95 });
      burst(ctx, s, T, { f0: 6500, f1: 700, sweep: 0.45, q: 1.2, decay: 0.5, gain: 0.45, rng });
      // metallic ring tail
      ring(ctx, out, T, { f: 505 + v * 23, parts: [[1, 1, 1.5], [2.76, 0.7, 1.0], [5.4, 0.5, 0.7], [8.93, 0.35, 0.5], [13.3, 0.2, 0.3]], gain: 0.34, beat: 0.006 });
    },
  },
  mortar: {
    v: 3, dur: 0.75, cat: W, level: -21, send: 0.18, th: 0.05, max: 4, pri: 1, vary: 0.05, group: 0, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.1);
      thump(ctx, s, 0, { p0: 108 - v * 6, p1: 42, pt: 0.04, decay: 0.38, gain: 1.0 });
      burst(ctx, s, 0, { f0: 380 + v * 30, q: 2, decay: 0.09, gain: 0.7, rng });
      burst(ctx, s, 0, { kind: 'pink', type: 'lowpass', f0: 1500, f1: 400, sweep: 0.2, decay: 0.28, gain: 0.55, rng });
      burst(ctx, s, 0, { type: 'highpass', f0: 3000, decay: 0.012, gain: 0.35, rng });
      whoosh(ctx, out, 0.03, 0.45, rng, { f0: 900, f1: 400, q: 1.5, gain: 0.12, attack: 0.1 });
    },
  },
  frost: {
    v: 3, dur: 0.65, cat: W, level: -25, send: 0.25, th: 0.06, max: 4, pri: 1, vary: 0.04, group: 0,
    build(ctx, out, rng) {
      for (let i = 0; i < 4; i++) {
        const f = 2600 + rng() * 3600;
        chirp(ctx, out, i * 0.012 * rng(), { f0: f, f1: f * 1.01, decay: 0.15 + rng() * 0.2, gain: 0.16, ratio: 1.41, index: 0.9, idxDecay: 0.08 });
      }
      chirp(ctx, out, 0, { f0: 2300, f1: 1300, glideT: 0.12, decay: 0.16, gain: 0.22, ratio: 2, index: 0.5 });
      burst(ctx, out, 0, { type: 'highpass', f0: 5000, q: 0.7, decay: 0.26, gain: 0.25, attack: 0.004, rng });
      whoosh(ctx, out, 0, 0.25, rng, { f0: 1200, f1: 3200, q: 1.5, gain: 0.16, attack: 0.02, kind: 'white' });
      thump(ctx, out, 0, { p0: 300, p1: 150, pt: 0.02, decay: 0.05, gain: 0.25 });
    },
  },
  tesla: {
    v: 4, dur: 0.5, cat: W, level: -22, send: 0.15, th: 0.06, max: 4, pri: 1, vary: 0.04, group: 0,
    build(ctx, out, rng) {
      const s = sat(ctx, out, 3.0, 0.08);
      crackles(ctx, s, 0, 0.42, rng, { rate: 420, decay: 0.0004, tone: 3200, q: 0.8, gain: 1.2, hp: 1200, env: (x) => (x < 0.25 ? 1 : Math.max(0, 1 - (x - 0.25) * 1.4)) * (rng() < 0.8 ? 1 : 0.2) });
      const b = osc(ctx, 'sawtooth', 90 + rng() * 25, 0, 0.4);
      const m = osc(ctx, 'sine', 45 + rng() * 30, 0, 0.4);
      const mg = gainNode(ctx, 140);
      m.connect(mg); mg.connect(b.frequency);
      const gate = ctx.createGain();
      let tt = 0;
      gate.gain.setValueAtTime(0, 0);
      while (tt < 0.32) { gate.gain.setValueAtTime((0.25 + 0.75 * rng()) * (1 - tt / 0.36), tt); tt += 0.007 + rng() * 0.012; }
      gate.gain.setValueAtTime(0, tt);
      chain(b, biquad(ctx, 'lowpass', 3800, 0.8), gate, gainNode(ctx, 0.5), s);
      burst(ctx, s, 0, { type: 'highpass', f0: 2000, decay: 0.008, gain: 0.8, rng });
      chirp(ctx, s, 0, { f0: 4200, f1: 1800, glideT: 0.05, decay: 0.06, gain: 0.15, ratio: 0.51, index: 3 });
    },
  },
  missile: {
    v: 3, dur: 0.95, cat: W, level: -23, send: 0.15, th: 0.05, max: 4, pri: 1, vary: 0.05, group: 0, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 1.8);
      burst(ctx, s, 0, { f0: 950, q: 0.9, decay: 0.045, gain: 0.7, rng });
      thump(ctx, s, 0, { p0: 170, p1: 72, decay: 0.09, gain: 0.5 });
      whoosh(ctx, s, 0.01, 0.62, rng, { f0: 480 + v * 40, f1: 2700, q: 1.4, gain: 0.8, attack: 0.03 });
      burst(ctx, s, 0.01, { kind: 'brown', type: 'lowpass', f0: 380, q: 0.7, decay: 0.55, gain: 0.55, attack: 0.03, rng });
      burst(ctx, s, 0, { type: 'highpass', f0: 5000, decay: 0.25, gain: 0.15, attack: 0.01, rng });
    },
  },
  napalm: {
    v: 2, dur: 0.75, cat: W, level: -23, send: 0.15, th: 0.06, max: 3, pri: 1, vary: 0.05, group: 0, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 1.9);
      thump(ctx, s, 0, { p0: 145, p1: 70, pt: 0.03, decay: 0.16, gain: 0.9 });
      burst(ctx, s, 0, { f0: 1200, q: 1.5, decay: 0.03, gain: 0.5, rng });
      chirp(ctx, s, 0.005, { f0: 620 + v * 40, decay: 0.26, gain: 0.26, ratio: 1.41, index: 2.2, idxDecay: 0.1 });
      const n = noise(ctx, 'pink', 0.02, 0.6, rng);
      const bp = biquad(ctx, 'bandpass', 700, 1.4);
      bp.frequency.setValueAtTime(700, 0.02); bp.frequency.exponentialRampToValueAtTime(1500, 0.2); bp.frequency.exponentialRampToValueAtTime(850, 0.55);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, 0.02); g.gain.linearRampToValueAtTime(0.4, 0.07); g.gain.setTargetAtTime(0, 0.12, 0.12);
      chain(n, bp, g, out);
    },
  },
  drone: {
    v: 3, dur: 0.12, cat: W, level: -31, send: 0.05, th: 0.05, max: 3, pri: 0, vary: 0.06, group: 0,
    build(ctx, out, rng, v) {
      chirp(ctx, out, 0, { f0: 2700 + v * 150, f1: 1500, glideT: 0.04, decay: 0.06, gain: 0.5, ratio: 2, index: 0.8, idxDecay: 0.02 });
      burst(ctx, out, 0, { f0: 4200, q: 1.2, decay: 0.012, gain: 0.4, rng });
      thump(ctx, out, 0, { p0: 420, p1: 200, pt: 0.01, decay: 0.03, gain: 0.3 });
    },
  },
  droneRocket: {
    v: 2, dur: 0.55, cat: W, level: -26, send: 0.12, th: 0.06, max: 3, pri: 0, vary: 0.05, group: 2, sr: 24000,
    build(ctx, out, rng) {
      burst(ctx, out, 0, { f0: 1300, q: 1, decay: 0.03, gain: 0.6, rng });
      thump(ctx, out, 0, { p0: 220, p1: 100, decay: 0.06, gain: 0.35 });
      whoosh(ctx, out, 0.01, 0.38, rng, { f0: 800, f1: 2800, q: 1.6, gain: 0.6, attack: 0.02 });
    },
  },
  mineDrop: {
    v: 1, dur: 0.45, cat: W, level: -26, send: 0.1, th: 0.08, max: 3, pri: 1, group: 2,
    build(ctx, out, rng) {
      burst(ctx, out, 0, { f0: 2400, q: 3, decay: 0.025, gain: 0.8, rng });
      chirp(ctx, out, 0, { f0: 900, f1: 500, glideT: 0.02, decay: 0.035, gain: 0.3 });
      burst(ctx, out, 0.045, { f0: 1300, q: 3, decay: 0.03, gain: 0.6, rng });
      chirp(ctx, out, 0.16, { f0: 1760, decay: 0.08, gain: 0.2, ratio: 2, index: 0.5 });
      chirp(ctx, out, 0.26, { f0: 2349, decay: 0.1, gain: 0.2, ratio: 2, index: 0.5 });
    },
  },
  heroShot: {
    v: 3, dur: 0.6, cat: H, level: -20, send: 0.15, th: 0.05, max: 3, pri: 2, vary: 0.04, group: 2, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.3);
      thump(ctx, s, 0, { p0: 125, p1: 42, pt: 0.035, decay: 0.3, gain: 1.0 });
      burst(ctx, s, 0, { f0: 1600, q: 0.7, decay: 0.05, gain: 0.8, rng });
      chirp(ctx, s, 0, { f0: 540 + v * 30, f1: 180, glideT: 0.09, decay: 0.18, gain: 0.5, ratio: 1.5, index: 4, idxDecay: 0.08 });
      burst(ctx, s, 0.005, { kind: 'pink', type: 'lowpass', f0: 900, q: 0.7, decay: 0.3, gain: 0.35, rng });
      burst(ctx, s, 0, { type: 'highpass', f0: 4500, decay: 0.015, gain: 0.4, rng });
    },
  },

  // ---------------- impacts
  hit: {
    v: 4, dur: 0.15, cat: I, level: -29, send: 0.08, th: 0.03, max: 5, pri: 0, vary: 0.08, group: 0,
    build(ctx, out, rng, v) {
      burst(ctx, out, 0, { f0: 3200 + v * 300, q: 1.2, decay: 0.02, gain: 0.8, rng });
      chirp(ctx, out, 0, { f0: 3000 + rng() * 800, decay: 0.05, gain: 0.22, ratio: 1.37, index: 1, idxDecay: 0.02 });
      thump(ctx, out, 0, { p0: 230, p1: 120, pt: 0.01, decay: 0.035, gain: 0.35 });
    },
  },
  explode_s: {
    v: 3, dur: 0.8, cat: I, level: -21, send: 0.2, th: 0.04, max: 5, pri: 1, vary: 0.06, group: 0, sr: 24000,
    build(ctx, out, rng, v) { explosionSmall(ctx, out, 0, rng, 1 + (v - 1) * 0.06); },
  },
  explode_m: {
    v: 3, dur: 1.8, cat: I, level: -17, send: 0.25, th: 0.05, max: 5, pri: 2, vary: 0.05, duck: 0.3, group: 0, sr: 24000,
    build(ctx, out, rng, v) { explosionMedium(ctx, out, 0, rng, 1 + (v - 1) * 0.05); },
  },
  explode_l: {
    v: 2, dur: 3.3, ch: 2, cat: I, level: -13, send: 0.3, th: 0.12, max: 3, pri: 3, vary: 0.04, duck: 0.55, group: 0, sr: 24000,
    build(ctx, out, rng, v) { explosionLarge(ctx, out, 0, rng, 1 + (v - 0.5) * 0.05); },
  },
  bomblet: {
    v: 3, dur: 0.45, cat: I, level: -25, send: 0.15, th: 0.035, max: 5, pri: 0, vary: 0.07, group: 0, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.3);
      thump(ctx, s, 0, { p0: 150 + v * 10, p1: 62, pt: 0.03, decay: 0.13, gain: 0.9 });
      burst(ctx, s, 0, { kind: 'pink', type: 'lowpass', f0: 4200, f1: 500, sweep: 0.18, decay: 0.22, gain: 0.9, rng });
      crackles(ctx, s, 0, 0.2, rng, { rate: 100, tone: 2800, gain: 0.3, env: (x) => 1 - x });
    },
  },
  mineBoom: {
    v: 2, dur: 1.6, cat: I, level: -18, send: 0.25, th: 0.06, max: 4, pri: 2, vary: 0.04, duck: 0.3, group: 2, sr: 24000,
    build(ctx, out, rng, v) {
      explosionMedium(ctx, out, 0, rng, 1.08);
      ring(ctx, out, 0, { f: 290 + v * 30, parts: [[1, 1, 0.6], [2.3, 0.7, 0.45], [3.9, 0.5, 0.3], [5.6, 0.3, 0.2]], gain: 0.22 });
      burst(ctx, out, 0, { f0: 3000, q: 2, decay: 0.02, gain: 0.5, rng });
    },
  },
  shatter: {
    v: 3, dur: 0.95, cat: I, level: -21, send: 0.3, th: 0.06, max: 4, pri: 1, vary: 0.05, group: 2,
    build(ctx, out, rng) {
      burst(ctx, out, 0, { type: 'highpass', f0: 2500, decay: 0.03, gain: 0.7, rng });
      thump(ctx, out, 0, { p0: 190, p1: 90, decay: 0.1, gain: 0.4 });
      shards(ctx, out, 0.004, 0.38, rng, { count: 20, fmin: 2500, fmax: 8500, dmin: 0.06, dmax: 0.26, gain: 0.16, spread: 1.8 });
      burst(ctx, out, 0, { type: 'highpass', f0: 6000, decay: 0.32, gain: 0.2, attack: 0.003, rng });
    },
  },
  burn: {
    v: 2, dur: 0.95, cat: I, level: -24, send: 0.15, th: 0.08, max: 3, pri: 0, vary: 0.05, group: 2, sr: 24000,
    build(ctx, out, rng) {
      whoosh(ctx, out, 0, 0.75, rng, { f0: 250, f1: 1700, q: 0.8, gain: 0.8, attack: 0.12 });
      const n = noise(ctx, 'brown', 0, 0.8, rng);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.6, 0.08); g.gain.setTargetAtTime(0, 0.1, 0.18);
      chain(n, biquad(ctx, 'lowpass', 420, 0.7), g, out);
      crackles(ctx, out, 0.08, 0.75, rng, { rate: 55, decay: 0.001, tone: 3000, gain: 0.25, env: (x) => 1 - x });
    },
  },
  shieldHit: {
    v: 3, dur: 0.35, cat: I, level: -25, send: 0.18, th: 0.05, max: 4, pri: 0, vary: 0.05, group: 2,
    build(ctx, out, rng, v) {
      chirp(ctx, out, 0, { f0: 1350 + v * 120, f1: 1100, glideT: 0.08, decay: 0.16, gain: 0.5, ratio: 2.5, index: 3, idxDecay: 0.06 });
      const c = osc(ctx, 'sine', 3300, 0, 0.3);
      const am = gainNode(ctx, 0);
      const m = osc(ctx, 'sine', 70, 0, 0.3);
      m.connect(am.gain);
      const g = ctx.createGain(); perc(g.gain, 0, 0.25, 0.2);
      chain(c, am, g, out);
      burst(ctx, out, 0, { f0: 2500, q: 2, decay: 0.05, gain: 0.35, rng });
    },
  },
  shield: {
    v: 2, dur: 1.25, cat: I, level: -20, send: 0.3, th: 0.1, max: 3, pri: 2, vary: 0.04, group: 0,
    build(ctx, out, rng) {
      const w = osc(ctx, 'sawtooth', 2400, 0, 0.7);
      glide(w.frequency, 0, 2400, 300, 0.5);
      const bp = biquad(ctx, 'bandpass', 2400, 3);
      glide(bp.frequency, 0, 2400, 300, 0.5);
      const g = ctx.createGain(); perc(g.gain, 0, 0.35, 0.6);
      chain(w, bp, g, out);
      shards(ctx, out, 0, 0.45, rng, { count: 22, fmin: 3000, fmax: 9500, dmin: 0.08, dmax: 0.35, gain: 0.15 });
      thump(ctx, out, 0, { p0: 300, p1: 60, pt: 0.03, decay: 0.2, gain: 0.7 });
      burst(ctx, out, 0, { type: 'highpass', f0: 2000, decay: 0.04, gain: 0.6, rng });
      for (const f of [2093, 2637, 3136]) fmBell(ctx, out, 0.02, 69 + 12 * Math.log2(f / 440), { ratio: 3.5, index: 1, decay: 1.0, gain: 0.08, strike: 0 });
    },
  },
  freeze: {
    v: 2, dur: 1.05, cat: I, level: -23, send: 0.3, th: 0.08, max: 3, pri: 1, vary: 0.04, group: 2,
    build(ctx, out, rng) {
      shards(ctx, out, 0, 0.5, rng, { count: 18, fmin: 1800, fmax: 3200, rise: 1.6, dmin: 0.04, dmax: 0.14, gain: 0.14, spread: 0.8 });
      crackles(ctx, out, 0.02, 0.6, rng, { rate: 160, decay: 0.0005, tone: 4500, gain: 0.35, env: (x) => Math.sin(Math.PI * x) });
      whoosh(ctx, out, 0, 0.45, rng, { f0: 1500, f1: 5200, q: 2, gain: 0.25, attack: 0.1, kind: 'white' });
      thump(ctx, out, 0, { p0: 200, p1: 120, decay: 0.15, gain: 0.3 });
    },
  },

  // ---------------- enemies
  kill: {
    v: 4, dur: 0.8, cat: E, level: -22, send: 0.18, th: 0.03, max: 6, pri: 1, vary: 0.06, group: 0, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.2);
      thump(ctx, s, 0, { p0: 165 - v * 8, p1: 55, pt: 0.03, decay: 0.2, gain: 0.9 });
      burst(ctx, s, 0, { kind: 'pink', type: 'lowpass', f0: 3600, f1: 420, sweep: 0.18, decay: 0.26, gain: 0.8, rng });
      crunch(ctx, s, 0, rng, { freqs: [800 + v * 60, 2100, 4400], q: 10, decay: 0.13, gain: 0.7 });
      chirp(ctx, s, 0.01, { f0: 900 + v * 40, f1: 170, glideT: 0.12, decay: 0.15, gain: 0.3, ratio: 1.5, index: 1.6, idxDecay: 0.06 });
      crackles(ctx, s, 0.02, 0.4, rng, { rate: 70, tone: 2300, gain: 0.25, env: (x) => 1 - x });
    },
  },
  killHeavy: {
    v: 2, dur: 1.7, cat: E, level: -18, send: 0.25, th: 0.06, max: 4, pri: 2, vary: 0.04, duck: 0.3, group: 2, sr: 24000,
    build(ctx, out, rng, v) {
      explosionMedium(ctx, out, 0, rng, 0.9);
      crunch(ctx, out, 0, rng, { freqs: [500 + v * 50, 1300, 2900], q: 8, decay: 0.2, gain: 0.8, steps: 10 });
      const w = osc(ctx, 'sawtooth', 1200, 0.02, 0.9);
      glide(w.frequency, 0.02, 1200, 60, 0.8);
      const lp = biquad(ctx, 'lowpass', 2500, 1);
      glide(lp.frequency, 0.02, 2500, 200, 0.8);
      const g = ctx.createGain(); perc(g.gain, 0.02, 0.25, 0.85, 0.01);
      chain(w, lp, g, out);
    },
  },
  bosskill: {
    v: 1, dur: 5.0, ch: 2, cat: E, level: -11, send: 0.35, th: 0.5, max: 2, pri: 3, duck: 0.7, group: 2, sr: 24000,
    build(ctx, out, rng) {
      explosionLarge(ctx, out, 0, rng, 0.9);
      const sec = [[0.38, -0.55], [0.8, 0.6], [1.3, -0.2]];
      for (const [t, pan] of sec) explosionMedium(ctx, panned(ctx, out, pan), t, rng, 1.05);
      const merger = ctx.createChannelMerger(2);
      for (let i = 0; i < 3; i++) {
        const w = osc(ctx, 'sawtooth', 1500, 0.05, 2.8, (i - 1) * 15);
        glide(w.frequency, 0.05, 1500, 38, 2.5);
        w.connect(merger, 0, i % 2);
      }
      const lp = biquad(ctx, 'lowpass', 3000, 1.2);
      glide(lp.frequency, 0.05, 3000, 150, 2.5);
      const g = ctx.createGain(); perc(g.gain, 0.05, 0.25, 2.6, 0.02);
      chain(merger, lp, g, out);
      const m = osc(ctx, 'sine', 130, 0.5, 2.8);
      glide(m.frequency, 0.5, 130, 70, 2.2);
      const mm = osc(ctx, 'sine', 183, 0.5, 2.8);
      const mg = gainNode(ctx, 500);
      mm.connect(mg); mg.connect(m.frequency);
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0, 0.5); g2.gain.linearRampToValueAtTime(0.18, 0.9); g2.gain.setTargetAtTime(0, 1.3, 0.5);
      chain(m, biquad(ctx, 'lowpass', 1200), g2, out);
    },
  },
  heal: {
    v: 2, dur: 0.95, cat: E, level: -27, send: 0.3, th: 0.25, max: 2, pri: 0, vary: 0.02, group: 2, sr: 24000,
    build(ctx, out, rng, v) {
      fmBell(ctx, out, 0, 81 + v * 2, { ratio: 2, index: 1, decay: 0.75, gain: 0.3, a: 0.03, strike: 0 });
      fmBell(ctx, out, 0.05, 88 + v * 2, { ratio: 2, index: 1, decay: 0.7, gain: 0.2, a: 0.03, strike: 0 });
      chirp(ctx, out, 0, { f0: 600, f1: 900, glideT: 0.3, decay: 0.3, gain: 0.15, attack: 0.05 });
      whoosh(ctx, out, 0, 0.6, rng, { f0: 5000, f1: 7000, q: 3, gain: 0.1, attack: 0.2, kind: 'white' });
    },
  },
  blink: {
    v: 2, dur: 0.4, cat: E, level: -25, send: 0.2, th: 0.1, max: 3, pri: 0, vary: 0.05, group: 2,
    build(ctx, out, rng) {
      chirp(ctx, out, 0, { f0: 300, f1: 3200, glideT: 0.07, decay: 0.1, gain: 0.4, ratio: 2, index: 1.5, idxDecay: 0.05, hold: 0.04 });
      chirp(ctx, out, 0.09, { f0: 3000, f1: 500, glideT: 0.1, decay: 0.15, gain: 0.3, ratio: 2, index: 1 });
      const n = noise(ctx, 'white', 0, 0.3, rng);
      const bp = biquad(ctx, 'bandpass', 800, 5);
      bp.frequency.setValueAtTime(800, 0); bp.frequency.exponentialRampToValueAtTime(6000, 0.08); bp.frequency.exponentialRampToValueAtTime(1500, 0.22);
      const g = ctx.createGain(); perc(g.gain, 0, 0.35, 0.22, 0.01);
      chain(n, bp, g, out);
    },
  },
  summon: {
    v: 1, dur: 1.7, ch: 2, cat: E, level: -19, send: 0.3, th: 0.4, max: 2, pri: 2, group: 3, sr: 24000,
    build(ctx, out, rng) {
      const merger = ctx.createChannelMerger(2);
      for (let i = 0; i < 4; i++) {
        const s = osc(ctx, 'sawtooth', 55, 0, 1.5, (i - 1.5) * 14);
        glide(s.frequency, 0, 55, 82.4, 1.0);
        s.connect(merger, 0, i % 2);
      }
      const lp = biquad(ctx, 'lowpass', 200, 1.5);
      glide(lp.frequency, 0, 200, 1400, 1.0);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.6, 0.95); g.gain.setTargetAtTime(0, 1.0, 0.12);
      chain(merger, lp, shaper(ctx, 2), g, out);
      riser(ctx, out, 0, 0.95, { f0: 800, f1: 6000, q0: 1, q1: 4, gain: 0.25, rng });
      thump(ctx, out, 1.0, { p0: 130, p1: 45, decay: 0.35, gain: 0.8 });
      burst(ctx, out, 1.0, { kind: 'pink', type: 'lowpass', f0: 3000, f1: 300, sweep: 0.3, decay: 0.4, gain: 0.6, rng });
    },
  },
  emp: {
    v: 2, dur: 1.6, cat: E, level: -17, send: 0.25, th: 0.3, max: 2, pri: 2, duck: 0.35, group: 3, sr: 24000,
    build(ctx, out, rng, v) {
      const s = sat(ctx, out, 2.5);
      thump(ctx, s, 0, { p0: 95, p1: 30, pt: 0.06, decay: 0.8, gain: 1.0 });
      burst(ctx, s, 0, { kind: 'pink', type: 'lowpass', f0: 1400, q: 0.7, decay: 0.4, gain: 0.5, rng });
      crackles(ctx, s, 0, 0.9, rng, { rate: 700, decay: 0.0004, tone: 3000, gain: 0.6, hp: 1000, env: (x) => (x < 0.1 ? 1 : Math.exp(-(x - 0.1) * 5)) });
      const b = osc(ctx, 'sawtooth', 900, 0, 1.1);
      glide(b.frequency, 0, 900, 48, 0.9);
      const m = osc(ctx, 'sine', 60 + v * 7, 0, 1.1);
      const mg = gainNode(ctx, 240);
      m.connect(mg); mg.connect(b.frequency);
      const lp = biquad(ctx, 'lowpass', 2500, 1);
      glide(lp.frequency, 0, 2500, 300, 0.9);
      const g = ctx.createGain(); perc(g.gain, 0, 0.4, 1.0, 0.005);
      chain(b, lp, g, s);
      chirp(ctx, out, 0, { f0: 1100, f1: 700, glideT: 0.3, decay: 0.3, gain: 0.12 });
    },
  },
  reveal: {
    v: 1, dur: 0.8, cat: E, level: -24, send: 0.25, th: 0.15, max: 2, pri: 1, group: 3,
    build(ctx, out, rng) {
      for (let i = 0; i < 8; i++) {
        const f = 2000 + rng() * 5000;
        const a = 0.15 + rng() * 0.2;
        chirp(ctx, out, 0.02 * i * rng(), { f0: f, decay: 0.08, attack: a, gain: 0.1, ratio: 3.5, index: 0.8 });
      }
      for (const tt of [0.36, 0.4, 0.46, 0.51]) burst(ctx, out, tt, { f0: 2000 + rng() * 2000, q: 2, decay: 0.015, gain: 0.35, rng });
      fmBell(ctx, out, 0.38, 100, { ratio: 3.5, index: 1, decay: 0.35, gain: 0.2, strike: 0 });
    },
  },
  berserk: {
    v: 1, dur: 1.0, cat: E, level: -20, send: 0.2, th: 0.2, max: 2, pri: 1, group: 3, sr: 24000,
    build(ctx, out, rng) {
      const sum = gainNode(ctx, 0.3);
      for (let i = 0; i < 4; i++) {
        const s = osc(ctx, 'sawtooth', 70, 0, 0.8, (i - 1.5) * 18);
        glide(s.frequency, 0, 70, 145, 0.45);
        s.connect(sum);
      }
      const lp = biquad(ctx, 'lowpass', 300, 3);
      glide(lp.frequency, 0, 300, 2600, 0.35);
      const trem = gainNode(ctx, 0.7);
      const l = osc(ctx, 'sawtooth', 24, 0, 0.8);
      const lg = gainNode(ctx, 0.3);
      l.connect(lg); lg.connect(trem.gain);
      const g = ctx.createGain(); perc(g.gain, 0, 0.9, 0.65, 0.04, 0.12);
      chain(sum, lp, shaper(ctx, 4, 0.1), trem, g, out);
      burst(ctx, out, 0, { kind: 'pink', f0: 900, q: 1.5, decay: 0.6, gain: 0.4, attack: 0.04, hold: 0.1, rng });
    },
  },
  bossPhase: {
    v: 1, dur: 3.2, ch: 2, cat: E, level: -12, send: 0.35, th: 0.8, max: 1, pri: 3, duck: 0.6, group: 3, sr: 24000,
    build(ctx, out, rng) {
      braam(ctx, out, 0, 1.3, 33, { rng, drive: 3.2, gain: 0.6, cutPeak: 3000, r: 1.2 });
      braam(ctx, out, 0, 1.3, 34, { rng, drive: 3.2, gain: 0.35, cutPeak: 2400, r: 1.2, layers: [[0, 1, -0.5], [12, 0.7, 0.5]] });
      thump(ctx, out, 0, { p0: 95, p1: 24, pt: 0.4, decay: 1.8, gain: 1.0 });
      impact(ctx, out, 0, { rng, gain: 0.6, decay: 1.6 });
      const n = noise(ctx, 'white', 0.05, 1.6, rng);
      const sc = gainNode(ctx, 0.3);
      for (const f of [3000, 3900, 5100]) {
        const bp = biquad(ctx, 'bandpass', f, 15);
        glide(bp.frequency, 0.05, f, f * 0.28, 1.4);
        n.connect(bp); bp.connect(sc);
      }
      const g = ctx.createGain(); perc(g.gain, 0.05, 1, 1.4, 0.05);
      chain(sc, g, out);
      const merger = ctx.createChannelMerger(2);
      for (let i = 0; i < 2; i++) { const a = osc(ctx, 'sawtooth', 440, 0.3, 1.8, i ? 9 : -9); glide(a.frequency, 0.3, 440, 880, 1.2); a.connect(merger, 0, i); }
      const ag = ctx.createGain(); ag.gain.setValueAtTime(0, 0.3); ag.gain.linearRampToValueAtTime(0.14, 1.2); ag.gain.setTargetAtTime(0, 1.5, 0.1);
      chain(merger, biquad(ctx, 'bandpass', 1400, 1.5), ag, out);
    },
  },
  leak: {
    v: 1, dur: 1.35, cat: E, level: -15, send: 0.25, th: 0.25, max: 2, pri: 3, duck: 0.4, group: 0, sr: 24000,
    build(ctx, out, rng) {
      const s = sat(ctx, out, 2.4);
      thump(ctx, s, 0, { p0: 125, p1: 40, pt: 0.04, decay: 0.45, gain: 1.0 });
      crunch(ctx, s, 0, rng, { freqs: [600, 1500, 3200], q: 7, decay: 0.18, gain: 0.8 });
      burst(ctx, s, 0, { type: 'highpass', f0: 2500, decay: 0.03, gain: 0.5, rng });
      for (const [t0, n0, n1] of [[0.12, 81, 79], [0.47, 77, 75]]) {
        const merger = gainNode(ctx, 1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.32, t0 + 0.012); g.gain.setValueAtTime(0.32, t0 + 0.24); g.gain.setTargetAtTime(0, t0 + 0.24, 0.03);
        for (const [type, det] of [['sawtooth', -8], ['sawtooth', 8], ['square', 0]]) {
          const o = osc(ctx, type, mtof(n0), t0, t0 + 0.4, det);
          o.frequency.setValueAtTime(mtof(n0), t0 + 0.16);
          o.frequency.exponentialRampToValueAtTime(mtof(n1), t0 + 0.26);
          o.connect(merger);
        }
        chain(merger, biquad(ctx, 'lowpass', 2600, 1.2), biquad(ctx, 'peaking', 1300, 1.5, 5), g, out);
      }
    },
  },

  // ---------------- towers / UI
  build: {
    v: 1, dur: 1.15, cat: U, level: -20, send: 0.15, th: 0.1, max: 2, pri: 2, group: 0, sr: 24000,
    build(ctx, out, rng) {
      const w = osc(ctx, 'sawtooth', 180, 0, 0.35);
      glide(w.frequency, 0, 180, 430, 0.25);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.25, 0.03); g.gain.setTargetAtTime(0, 0.2, 0.05);
      chain(w, biquad(ctx, 'bandpass', 1200, 2), g, out);
      thump(ctx, out, 0.18, { p0: 150, p1: 70, decay: 0.13, gain: 0.8 });
      burst(ctx, out, 0.18, { f0: 900, q: 1.5, decay: 0.05, gain: 0.5, rng });
      burst(ctx, out, 0.3, { f0: 2200, q: 2, decay: 0.03, gain: 0.45, rng });
      thump(ctx, out, 0.3, { p0: 300, p1: 180, decay: 0.05, gain: 0.3 });
      burst(ctx, out, 0.36, { f0: 3500, q: 3, decay: 0.015, gain: 0.4, rng });
      burst(ctx, out, 0.3, { type: 'highpass', f0: 3000, decay: 0.2, gain: 0.1, attack: 0.02, rng });
      fmBell(ctx, out, 0.42, 81, { ratio: 2, index: 1.2, decay: 0.6, gain: 0.26, strike: 0.15 });
      fmBell(ctx, out, 0.47, 88, { ratio: 2, index: 1.2, decay: 0.6, gain: 0.2, strike: 0.15 });
    },
  },
  upgrade: {
    v: 1, dur: 1.25, cat: U, level: -19, send: 0.25, th: 0.1, max: 2, pri: 2, group: 0,
    build(ctx, out, rng) {
      [69, 73, 76, 81].forEach((n, i) => fmBell(ctx, out, i * 0.06, n, { ratio: 2, index: 1.5, decay: 0.5 + i * 0.1, gain: 0.25, strike: 0.2 }));
      riser(ctx, out, 0, 0.25, { f0: 800, f1: 6000, gain: 0.15, rng });
      const w = osc(ctx, 'sawtooth', 110, 0, 0.5);
      glide(w.frequency, 0, 110, 220, 0.3);
      const g = ctx.createGain(); perc(g.gain, 0, 0.2, 0.4, 0.02);
      chain(w, biquad(ctx, 'lowpass', 800), g, out);
      shards(ctx, out, 0.2, 0.5, rng, { count: 10, fmin: 4000, fmax: 8000, gain: 0.06, dmin: 0.1, dmax: 0.3 });
    },
  },
  ultimate: {
    v: 1, dur: 3.0, ch: 2, cat: U, level: -14, send: 0.35, th: 0.3, max: 1, pri: 3, duck: 0.5, group: 2, sr: 24000,
    build(ctx, out, rng) {
      impact(ctx, out, 0, { rng, gain: 0.55, decay: 1.4, metal: 0.2 });
      braam(ctx, out, 0, 0.9, 45, { rng, gain: 0.4, cutPeak: 3600, cutEnd: 900, r: 1.0 });
      for (const n of [57, 61, 64, 69]) supersaw(ctx, out, 0.02, 1.0, n, { rng, a: 0.03, d: 0.8, s: 0.7, r: 1.2, cut: 3200, gain: 0.35 });
      choir(ctx, out, 0.05, 1.2, 69, { rng, a: 0.2, r: 1.0, gain: 0.35 });
      choir(ctx, out, 0.05, 1.2, 76, { rng, a: 0.2, r: 1.0, gain: 0.3 });
      [81, 85, 88, 93].forEach((n, i) => fmBell(ctx, out, 0.1 + i * 0.09, n, { ratio: 3.5, index: 1.2, decay: 1.2, gain: 0.14 }));
      crash(ctx, out, 0, { rng, gain: 0.3, decay: 2.2 });
    },
  },
  sell: {
    v: 1, dur: 0.85, cat: U, level: -21, send: 0.2, th: 0.1, max: 2, pri: 2, group: 0, sr: 24000,
    build(ctx, out, rng) {
      const w = osc(ctx, 'sawtooth', 420, 0, 0.3);
      glide(w.frequency, 0, 420, 140, 0.25);
      const g = ctx.createGain(); perc(g.gain, 0, 0.2, 0.25, 0.01);
      chain(w, biquad(ctx, 'bandpass', 1000, 1.5), g, out);
      burst(ctx, out, 0.05, { f0: 2500, q: 3, decay: 0.02, gain: 0.35, rng });
      burst(ctx, out, 0.12, { f0: 2000, q: 3, decay: 0.02, gain: 0.3, rng });
      fmBell(ctx, out, 0.2, 83, { ratio: 3.5, index: 1.1, decay: 0.4, gain: 0.25, strike: 0.2 });
      fmBell(ctx, out, 0.27, 88, { ratio: 3.5, index: 1.1, decay: 0.5, gain: 0.25, strike: 0.2 });
    },
  },
  clearWreck: {
    v: 1, dur: 0.85, cat: U, level: -24, send: 0.2, th: 0.1, max: 2, pri: 1, group: 2, sr: 24000,
    build(ctx, out, rng) {
      for (let i = 0; i < 7; i++) burst(ctx, out, rng() * 0.4, { f0: 600 + rng() * 2600, q: 6, decay: 0.05 + rng() * 0.07, gain: 0.35, rng });
      whoosh(ctx, out, 0, 0.45, rng, { f0: 400, f1: 1600, q: 1, gain: 0.35, attack: 0.08 });
      thump(ctx, out, 0, { p0: 140, p1: 70, decay: 0.12, gain: 0.4 });
    },
  },
  click: {
    v: 2, dur: 0.09, cat: U, level: -26, send: 0, th: 0.03, max: 2, pri: 3, vary: 0.02, group: 0,
    build(ctx, out, rng, v) {
      chirp(ctx, out, 0, { f0: 1900 + v * 180, decay: 0.035, gain: 0.5, ratio: 2, index: 0.6, idxDecay: 0.01 });
      burst(ctx, out, 0, { f0: 5000, q: 1, decay: 0.005, gain: 0.3, rng });
    },
  },
  select: {
    v: 2, dur: 0.22, cat: U, level: -25, send: 0.05, th: 0.05, max: 2, pri: 3, group: 0,
    build(ctx, out, rng, v) {
      chirp(ctx, out, 0, { f0: 1318.5 - v * 80, decay: 0.09, gain: 0.4, ratio: 2, index: 0.6 });
      chirp(ctx, out, 0.045, { f0: 1760 - v * 100, decay: 0.12, gain: 0.35, ratio: 2, index: 0.6 });
    },
  },
  error: {
    v: 1, dur: 0.38, cat: U, level: -22, send: 0.05, th: 0.12, max: 2, pri: 3, group: 0,
    build(ctx, out) {
      for (const [t0, f] of [[0, 220], [0.11, 175]]) {
        const s = osc(ctx, 'sawtooth', f, t0, t0 + 0.2);
        const m = osc(ctx, 'sine', f * 1.5, t0, t0 + 0.2);
        const mg = gainNode(ctx, f * 1.2);
        m.connect(mg); mg.connect(s.frequency);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.4, t0 + 0.006); g.gain.setValueAtTime(0.4, t0 + 0.08); g.gain.setTargetAtTime(0, t0 + 0.08, 0.015);
        chain(s, biquad(ctx, 'lowpass', 1300, 1), g, out);
      }
      thump(ctx, out, 0, { p0: 120, p1: 70, decay: 0.08, gain: 0.3 });
    },
  },
  coin: {
    v: 2, dur: 0.55, cat: U, level: -23, send: 0.15, th: 0.06, max: 3, pri: 2, vary: 0.02, group: 0,
    build(ctx, out, rng, v) {
      fmBell(ctx, out, 0, 83 + v, { ratio: 3.5, index: 1.2, decay: 0.35, gain: 0.3, strike: 0.25 });
      fmBell(ctx, out, 0.055, 88 + v, { ratio: 3.5, index: 1.2, decay: 0.45, gain: 0.3, strike: 0.25 });
    },
  },
  interest: {
    v: 1, dur: 0.85, cat: U, level: -24, send: 0.2, th: 0.2, max: 2, pri: 2, group: 2,
    build(ctx, out, rng) {
      [88, 92, 95].forEach((n, i) => fmBell(ctx, out, i * 0.07, n, { ratio: 3.5, index: 1, decay: 0.4 + i * 0.1, gain: 0.22, strike: 0.2 }));
      shards(ctx, out, 0.1, 0.4, rng, { count: 8, fmin: 5000, fmax: 9000, gain: 0.05 });
    },
  },
  rankUp: {
    v: 1, dur: 1.0, cat: U, level: -21, send: 0.25, th: 0.2, max: 2, pri: 2, group: 2,
    build(ctx, out, rng) {
      leadNote(ctx, out, 0, 0.1, 76, { rng, a: 0.01, r: 0.08, cut: 4000, fa: 0.04, gain: 0.35, vib: 0 });
      leadNote(ctx, out, 0.12, 0.35, 81, { rng, a: 0.01, r: 0.3, cut: 4500, fa: 0.06, gain: 0.35, vibDelay: 0.1 });
      fmBell(ctx, out, 0, 88, { ratio: 2, index: 1, decay: 0.3, gain: 0.15 });
      fmBell(ctx, out, 0.12, 93, { ratio: 2, index: 1, decay: 0.6, gain: 0.18 });
      shards(ctx, out, 0.15, 0.4, rng, { count: 8, fmin: 4500, fmax: 9000, gain: 0.05 });
    },
  },
  disabled: {
    v: 1, dur: 0.95, cat: U, level: -22, send: 0.2, th: 0.15, max: 2, pri: 2, group: 3, sr: 24000,
    build(ctx, out, rng) {
      const s = osc(ctx, 'sawtooth', 900, 0, 0.6);
      glide(s.frequency, 0, 900, 70, 0.5);
      const si = osc(ctx, 'sine', 900, 0, 0.6);
      glide(si.frequency, 0, 900, 70, 0.5);
      const lp = biquad(ctx, 'lowpass', 3000, 1);
      glide(lp.frequency, 0, 3000, 200, 0.5);
      const g = ctx.createGain(); perc(g.gain, 0, 0.35, 0.55, 0.005);
      s.connect(lp); si.connect(lp); chain(lp, g, out);
      crackles(ctx, out, 0.08, 0.45, rng, { rate: 150, tone: 2000, gain: 0.3, env: (x) => (Math.sin(x * 40) > 0 ? 1 : 0.1) });
      thump(ctx, out, 0.5, { p0: 150, p1: 60, decay: 0.12, gain: 0.5 });
    },
  },
  radar: {
    v: 1, dur: 1.3, cat: U, level: -31, send: 0.3, th: 0.5, max: 1, pri: 0, group: 3, sr: 24000,
    build(ctx, out) {
      for (const [t0, g0] of [[0, 1], [0.3, 0.3], [0.6, 0.1]]) {
        const s = osc(ctx, 'sine', 1400, t0, t0 + 0.7);
        const s2 = osc(ctx, 'sine', 1404, t0, t0 + 0.7);
        const g = ctx.createGain(); perc(g.gain, t0, 0.3 * g0, 0.6, 0.003);
        s.connect(g); s2.connect(g); chain(g, biquad(ctx, 'lowpass', 2500), out);
      }
    },
  },

  // ---------------- hero
  heroMove: {
    v: 2, dur: 0.35, cat: H, level: -25, send: 0.1, th: 0.12, max: 2, pri: 2, group: 2,
    build(ctx, out, rng, v) {
      chirp(ctx, out, 0, { f0: 1200 + v * 100, f1: 1800 + v * 100, glideT: 0.03, decay: 0.06, gain: 0.35, ratio: 1.5, index: 1 });
      chirp(ctx, out, 0.07, { f0: 1600 + v * 100, f1: 2400 + v * 100, glideT: 0.03, decay: 0.08, gain: 0.35, ratio: 1.5, index: 1 });
      burst(ctx, out, 0, { f0: 3000, q: 2, decay: 0.01, gain: 0.3, rng });
      const w = osc(ctx, 'sawtooth', 300, 0.02, 0.15);
      glide(w.frequency, 0.02, 300, 500, 0.1);
      const g = ctx.createGain(); perc(g.gain, 0.02, 0.1, 0.1, 0.01);
      chain(w, biquad(ctx, 'bandpass', 1500, 2), g, out);
    },
  },
  heroBarrage: {
    v: 1, dur: 1.5, ch: 2, cat: H, level: -18, send: 0.2, th: 0.3, max: 2, pri: 2, group: 2, sr: 24000,
    build(ctx, out, rng) {
      for (let i = 0; i < 6; i++) {
        const t0 = i * 0.08 + rng() * 0.015;
        const p = panned(ctx, out, (i % 2 ? 1 : -1) * (0.25 + 0.1 * i));
        burst(ctx, p, t0, { f0: 1000, q: 1, decay: 0.03, gain: 0.6, rng });
        thump(ctx, p, t0, { p0: 180, p1: 80, decay: 0.06, gain: 0.45 });
        whoosh(ctx, p, t0, 0.4, rng, { f0: 700, f1: 2600, q: 1.5, gain: 0.45, attack: 0.02 });
      }
      burst(ctx, out, 0, { kind: 'brown', type: 'lowpass', f0: 250, decay: 1.0, gain: 0.5, attack: 0.05, rng });
    },
  },
  heroAegis: {
    v: 1, dur: 1.9, ch: 2, cat: H, level: -18, send: 0.3, th: 0.3, max: 1, pri: 2, group: 2, sr: 24000,
    build(ctx, out, rng) {
      for (const n of [45, 52]) supersaw(ctx, out, 0, 0.5, n, { rng, voices: 5, a: 0.3, d: 0.5, s: 0.6, r: 1.0, cut: 2500, cutStart: 300, gain: 0.35 });
      [81, 85, 88].forEach((n) => fmBell(ctx, out, 0.35, n, { ratio: 2, index: 1.2, decay: 1.2, gain: 0.15 }));
      whoosh(ctx, out, 0, 0.45, rng, { f0: 300, f1: 3000, q: 1, gain: 0.35, attack: 0.3 });
      thump(ctx, out, 0.38, { p0: 100, p1: 45, decay: 0.4, gain: 0.6 });
    },
  },
  heroLevel: {
    v: 1, dur: 1.9, ch: 2, cat: H, level: -18, send: 0.3, th: 0.5, max: 1, pri: 3, group: 2, sr: 24000,
    build(ctx, out, rng) {
      [69, 73, 76, 81, 85, 88].forEach((n, i) => {
        fmBell(ctx, out, i * 0.07, n, { ratio: 2, index: 1.4, decay: 0.8, gain: 0.2 });
        pluck(ctx, out, i * 0.07, n - 12, { rng, decay: 0.3, gain: 0.12, cut0: 5000 });
      });
      for (const n of [69, 73, 76]) choir(ctx, out, 0.3, 0.8, n, { rng, a: 0.25, r: 0.8, gain: 0.3 });
      shards(ctx, out, 0.4, 0.7, rng, { count: 12, fmin: 5000, fmax: 9500, gain: 0.05 });
      thump(ctx, out, 0.35, { p0: 90, p1: 45, decay: 0.5, gain: 0.5 });
    },
  },

  // ---------------- abilities
  strike: {
    v: 1, dur: 1.15, ch: 2, cat: A, level: -17, send: 0.2, th: 0.3, max: 1, pri: 3, group: 2, sr: 24000,
    build(ctx, out, rng) {
      const T = 0.9;
      const merger = ctx.createChannelMerger(2);
      for (let i = 0; i < 2; i++) {
        const s = osc(ctx, 'sawtooth', 180, 0, T + 0.05, i ? 7 : -7);
        glide(s.frequency, 0, 180, 1800, T);
        const m = osc(ctx, 'sine', 360, 0, T + 0.05);
        glide(m.frequency, 0, 360, 3600, T);
        const mg = ctx.createGain(); mg.gain.setValueAtTime(360, 0); mg.gain.linearRampToValueAtTime(7200, T);
        m.connect(mg); mg.connect(s.frequency);
        s.connect(merger, 0, i);
      }
      const bp = biquad(ctx, 'bandpass', 400, 3);
      glide(bp.frequency, 0, 400, 4000, T);
      const trem = gainNode(ctx, 0.6);
      const l = osc(ctx, 'square', 6, 0, T);
      l.frequency.setValueAtTime(6, 0); l.frequency.exponentialRampToValueAtTime(32, T);
      const lg = gainNode(ctx, 0.4);
      l.connect(lg); lg.connect(trem.gain);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.05, 0); g.gain.exponentialRampToValueAtTime(0.5, T); g.gain.linearRampToValueAtTime(0, T + 0.03);
      chain(merger, bp, trem, g, out);
      riser(ctx, out, 0, T, { f0: 1000, f1: 8000, q0: 1, q1: 3, gain: 0.3, rng });
      chirp(ctx, out, T, { f0: 2640, decay: 0.05, hold: 0.02, gain: 0.3, ratio: 2, index: 0.5 });
      chirp(ctx, out, T + 0.08, { f0: 2640, decay: 0.08, hold: 0.02, gain: 0.3, ratio: 2, index: 0.5 });
    },
  },
  stasis: {
    v: 1, dur: 1.9, ch: 2, cat: A, level: -16, send: 0.35, th: 0.3, max: 1, pri: 3, duck: 0.3, group: 2, sr: 24000,
    build(ctx, out, rng) {
      const merger = ctx.createChannelMerger(2);
      [57, 64, 69].forEach((n, i) => {
        for (let k = 0; k < 2; k++) {
          const s = osc(ctx, 'sawtooth', mtof(n), 0, 0.9, k ? 6 : -6);
          s.frequency.setValueAtTime(mtof(n), 0.05);
          s.frequency.exponentialRampToValueAtTime(mtof(n - 24), 0.75);
          s.connect(merger, 0, (i + k) % 2);
        }
      });
      const lp = biquad(ctx, 'lowpass', 5000, 1);
      glide(lp.frequency, 0.05, 5000, 250, 0.75);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.2, 0); g.gain.setValueAtTime(0.2, 0.3); g.gain.linearRampToValueAtTime(0, 0.85);
      chain(merger, lp, g, out);
      [81, 88, 95].forEach((n) => fmBell(ctx, out, 0.2, n, { ratio: 3.5, index: 1, decay: 0.3, a: 0.5, gain: 0.15, strike: 0 }));
      shards(ctx, out, 0.5, 0.7, rng, { count: 14, fmin: 3000, fmax: 8000, dmin: 0.1, dmax: 0.4, gain: 0.08, spread: 0.8 });
      impact(ctx, out, 0.72, { rng, gain: 0.5, decay: 1.0, metal: 0.1, noise: 0.4 });
      whoosh(ctx, out, 0, 0.8, rng, { f0: 6000, f1: 300, q: 1.2, gain: 0.3, attack: 0.05, kind: 'white' });
    },
  },
  overclock: {
    v: 1, dur: 1.45, ch: 2, cat: A, level: -17, send: 0.25, th: 0.3, max: 1, pri: 3, group: 2, sr: 24000,
    build(ctx, out, rng) {
      const merger = ctx.createChannelMerger(2);
      for (let i = 0; i < 2; i++) {
        const s = osc(ctx, 'sawtooth', 90, 0, 0.75, i ? 8 : -8);
        glide(s.frequency, 0, 90, 360, 0.6);
        const m = osc(ctx, 'sine', 180, 0, 0.75);
        glide(m.frequency, 0, 180, 720, 0.6);
        const mg = gainNode(ctx, 300);
        m.connect(mg); mg.connect(s.frequency);
        s.connect(merger, 0, i);
      }
      const lp = biquad(ctx, 'lowpass', 400, 2);
      glide(lp.frequency, 0, 400, 4500, 0.6);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.05, 0); g.gain.exponentialRampToValueAtTime(0.4, 0.6); g.gain.setTargetAtTime(0, 0.66, 0.04);
      chain(merger, lp, shaper(ctx, 2.2), g, out);
      crackles(ctx, out, 0, 0.65, rng, { rate: 250, decay: 0.0005, tone: 3500, gain: 0.35, env: (x) => x });
      [76, 81, 85, 88].forEach((n, i) => chirp(ctx, out, 0.45 + i * 0.07, { f0: mtof(n), decay: 0.12, gain: 0.25, ratio: 2, index: 0.8 }));
      fmBell(ctx, out, 0.75, 93, { ratio: 3.5, index: 1.2, decay: 0.6, gain: 0.25 });
      thump(ctx, out, 0.7, { p0: 85, p1: 40, decay: 0.4, gain: 0.6 });
    },
  },

  // ---------------- continuous loops (seamless; played by setLoop)
  loop_laser: {
    v: 1, dur: 2.3, loop: 2.0, xfade: 0.25, ch: 2, cat: W, level: -24, group: 0, sr: 24000,
    build(ctx, out, rng) {
      const end = 2.3;
      const merger = ctx.createChannelMerger(2);
      [[110, -1], [110.5, 1], [220.9, -1], [221.6, 1], [331.5, 0]].forEach(([f, side], i) => {
        const s = osc(ctx, 'sawtooth', f, 0, end);
        if (side <= 0) s.connect(merger, 0, 0);
        if (side >= 0) s.connect(merger, 0, 1);
        void i;
      });
      const lp = biquad(ctx, 'lowpass', 1300, 1.5);
      const lfo = osc(ctx, 'sine', 1.5, 0, end);
      const lg = gainNode(ctx, 350);
      lfo.connect(lg); lg.connect(lp.frequency);
      chain(merger, lp, gainNode(ctx, 0.3), out);
      const c = osc(ctx, 'sine', 880, 0, end);
      const m = osc(ctx, 'sine', 110, 0, end);
      const mg = gainNode(ctx, 220);
      m.connect(mg); mg.connect(c.frequency);
      chain(c, biquad(ctx, 'bandpass', 1500, 1), gainNode(ctx, 0.12), out);
      const n = noise(ctx, 'white', 0, end, rng);
      const am = gainNode(ctx, 0.5);
      const al = osc(ctx, 'sine', 11, 0, end);
      const alg = gainNode(ctx, 0.5);
      al.connect(alg); alg.connect(am.gain);
      chain(n, biquad(ctx, 'bandpass', 5200, 1), am, gainNode(ctx, 0.1), out);
    },
  },
  loop_flame: {
    v: 1, dur: 2.8, loop: 2.5, xfade: 0.3, ch: 2, cat: W, level: -23, group: 0, sr: 24000,
    build(ctx, out, rng) {
      const end = 2.8;
      for (const pan of [-0.6, 0.6]) {
        const p = panned(ctx, out, pan);
        const b = noise(ctx, 'brown', 0, end, rng);
        const trem = gainNode(ctx, 0.75);
        const l1 = osc(ctx, 'sine', 3.1 + rng(), 0, end), l2 = osc(ctx, 'sine', 5.3 + rng(), 0, end);
        const g1 = gainNode(ctx, 0.15), g2 = gainNode(ctx, 0.1);
        l1.connect(g1); l2.connect(g2); g1.connect(trem.gain); g2.connect(trem.gain);
        chain(b, biquad(ctx, 'lowpass', 750, 0.7), trem, gainNode(ctx, 0.7), p);
        const pk = noise(ctx, 'pink', 0, end, rng);
        chain(pk, biquad(ctx, 'bandpass', 1200, 0.7), gainNode(ctx, 0.3), p);
        crackles(ctx, p, 0, end, rng, { rate: 45, decay: 0.001, tone: 2500, gain: 0.3 });
      }
    },
  },
  loop_charge: {
    v: 1, dur: 1.75, loop: 1.5, xfade: 0.25, ch: 2, cat: A, level: -22, group: 2, sr: 24000,
    build(ctx, out, rng) {
      const end = 1.75;
      const merger = ctx.createChannelMerger(2);
      [-9, 0, 9].forEach((det, i) => { const s = osc(ctx, 'sawtooth', 220, 0, end, det); s.connect(merger, 0, i === 1 ? 0 : i >> 1); if (i === 1) s.connect(merger, 0, 1); });
      const c = osc(ctx, 'sine', 440, 0, end);
      const m = osc(ctx, 'sine', 880, 0, end);
      const mg = gainNode(ctx, 660);
      m.connect(mg); mg.connect(c.frequency);
      c.connect(merger, 0, 0); c.connect(merger, 0, 1);
      const trem = gainNode(ctx, 0.65);
      const l = osc(ctx, 'sine', 12, 0, end);
      const lg = gainNode(ctx, 0.35);
      l.connect(lg); lg.connect(trem.gain);
      chain(merger, biquad(ctx, 'bandpass', 1500, 1.2), trem, gainNode(ctx, 0.5), out);
      void rng;
    },
  },
};

// Names the game may call that map onto something else.
export const ALIASES = { explode: 'explode_s' };
export const STINGER_ALIASES = { wave: 'wave', boss: 'bossIntro', bossIntro: 'bossIntro', victory: 'victory', defeat: 'defeat' };

export function explodeTier(size) {
  const s = clamp(size == null ? 1 : +size || 1, 0.1, 4);
  if (s < 0.75) return { name: 'explode_s', rate: 1.12 - (s - 0.3) * 0.25, gain: 0.55 + s * 0.6 };
  if (s < 1.9) return { name: 'explode_m', rate: 1.08 - (s - 0.75) * 0.14, gain: 0.7 + (s - 0.75) * 0.3 };
  return { name: 'explode_l', rate: 1.04 - Math.min(1, (s - 1.9) / 1.2) * 0.1, gain: 0.85 + Math.min(1, (s - 1.9) / 1.1) * 0.25 };
}
