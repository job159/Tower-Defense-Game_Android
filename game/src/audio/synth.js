// Offline synthesis building blocks (Web Audio node graphs rendered in OfflineAudioContexts).
// Every instrument builder has the shape fn(ctx, out, t, ..., opts) and returns its end time.
import { mtof, makeRng, hashStr, whiteNoise, pinkNoise, brownNoise, clamp, dbToGain, makeGatedIR } from './dsp.js';

// ------------------------------------------------------------------ buffers
export function bufferFrom(ctx, chs, sr) {
  let b = null;
  try { b = new AudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr }); } catch (e) { b = null; }
  if (!b) b = ctx.createBuffer(chs.length, chs[0].length, sr);
  for (let c = 0; c < chs.length; c++) {
    if (b.copyToChannel) b.copyToChannel(chs[c], c); else b.getChannelData(c).set(chs[c]);
  }
  return b;
}

const shared = new Map();
function cached(key, make) { let v = shared.get(key); if (!v) { v = make(); shared.set(key, v); } return v; }

export function noiseBuffer(ctx, kind = 'white') {
  const sr = ctx.sampleRate;
  return cached(`noise:${kind}:${sr}`, () => {
    const n = Math.floor(sr * 3);
    const r = makeRng(hashStr(kind + sr));
    const d = kind === 'pink' ? pinkNoise(n, r) : kind === 'brown' ? brownNoise(n, r) : whiteNoise(n, r);
    // make the loop seam click-free
    const x = Math.floor(sr * 0.02);
    for (let i = 0; i < x; i++) { const g = i / x; d[i] = d[i] * g + d[n - x + i] * (1 - g); }
    return bufferFrom(ctx, [d.subarray(0, n - x).slice()], sr);
  });
}

export function gatedIRBuffer(ctx) {
  const sr = ctx.sampleRate;
  return cached(`gated:${sr}`, () => bufferFrom(ctx, makeGatedIR(sr, { len: 0.22, tilt: 0.3 }), sr));
}

export function releaseShared() { shared.clear(); curves.clear(); }

// ------------------------------------------------------------------ node helpers
export function gainNode(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
export function biquad(ctx, type, freq, Q = 0.7071, gainDb = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  f.gain.value = gainDb;
  return f;
}
export function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}
export function osc(ctx, type, freq, t0, t1, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.start(Math.max(0, t0));
  o.stop(Math.max(t0 + 0.01, t1));
  return o;
}
export function noise(ctx, kind, t0, t1, rng, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, kind);
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(Math.max(0, t0), (rng ? rng() : Math.random()) * 2.5);
  s.stop(Math.max(t0 + 0.01, t1));
  return s;
}
export function bufSrc(ctx, buffer, t0, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = rate;
  s.start(Math.max(0, t0));
  return s;
}

const curves = new Map();
// Saturation curve: tanh with optional asymmetry (even harmonics), unity small-signal gain-ish.
export function satCurve(drive = 2, asym = 0) {
  const key = `${drive.toFixed(2)}:${asym.toFixed(3)}`;
  let c = curves.get(key);
  if (c) return c;
  const n = 2048;
  c = new Float32Array(n);
  const norm = Math.tanh(drive);
  const off = Math.tanh(drive * asym);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(drive * (x + asym)) - off) / norm;
  }
  curves.set(key, c);
  return c;
}
export function shaper(ctx, drive = 2, asym = 0, oversample = '2x') {
  const w = ctx.createWaveShaper();
  w.curve = satCurve(drive, asym);
  w.oversample = oversample;
  return w;
}

// ------------------------------------------------------------------ envelopes
export function perc(p, t, peak, decay, attack = 0.001, hold = 0) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
  p.setTargetAtTime(0, t + attack + hold, decay / 6.9);
}
export function adsr(p, t, dur, { a = 0.01, d = 0.2, s = 0.7, r = 0.3, peak = 1 } = {}) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(peak * s, t + a, Math.max(0.001, d / 3));
  p.setTargetAtTime(0, Math.max(t + a, t + dur), Math.max(0.001, r / 4.6));
}
export function swell(p, t, peak, a, hold, r) { // exponential-ish swell in, hold, release
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(peak, t + a);
  if (hold > 0) p.setValueAtTime(peak, t + a + hold);
  p.setTargetAtTime(0, t + a + hold, r / 4.6);
}
export function glide(p, t, from, to, dur, exp = true) {
  p.setValueAtTime(from, t);
  if (exp && from > 0 && to > 0) p.exponentialRampToValueAtTime(to, t + dur);
  else p.linearRampToValueAtTime(to, t + dur);
}

// ------------------------------------------------------------------ tonal instruments
// Supersaw ("strings"/pads/stabs): detuned saw stack spread across the stereo field,
// random phases, slow drift, 24 dB low-pass with its own envelope.
export function supersaw(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const voices = o.voices || 7, spread = o.spread ?? 16, width = o.width ?? 0.9;
  const a = o.a ?? 0.35, d = o.d ?? 1.0, s = o.s ?? 0.8, r = o.r ?? 1.0;
  const cut = o.cut ?? 2400, cutPeak = o.cutPeak ?? cut * 1.7, cutStart = o.cutStart ?? cut * 0.35;
  const f = mtof(midi);
  const end = t + dur + r * 1.5 + 0.05;
  const lp1 = biquad(ctx, 'lowpass', cutStart, o.q ?? 0.6), lp2 = biquad(ctx, 'lowpass', cutStart, 0.55);
  for (const lp of [lp1, lp2]) {
    const p = lp.frequency;
    p.setValueAtTime(cutStart, t);
    p.exponentialRampToValueAtTime(cutPeak, t + Math.max(0.006, a * 0.85));
    p.setTargetAtTime(cut, t + Math.max(0.006, a * 0.85), Math.max(0.01, d / 3));
    p.setTargetAtTime(Math.max(90, cutStart * 0.8), t + dur, Math.max(0.01, r / 3));
  }
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d, s, r, peak: (o.gain ?? 0.3) / Math.sqrt(voices) });
  chain(lp1, lp2, biquad(ctx, 'highpass', o.hp ?? 40, 0.6), amp, out);
  const drift = o.drift ?? 3.5;
  const lfo = osc(ctx, 'sine', 0.1 + rng() * 0.2, t, end);
  const lpos = gainNode(ctx, drift), lneg = gainNode(ctx, -drift);
  lfo.connect(lpos); lfo.connect(lneg);
  // voices alternate hard left / hard right (center voice on both): wide, mono-safe and cheaper
  // than one panner per voice
  const merger = ctx.createChannelMerger(2);
  merger.connect(lp1);
  void width;
  for (let v = 0; v < voices; v++) {
    const k = voices === 1 ? 0 : -1 + (2 * v) / (voices - 1);
    const det = Math.sign(k) * Math.pow(Math.abs(k), 1.25) * spread + (rng() - 0.5) * spread * 0.18;
    const o1 = osc(ctx, 'sawtooth', f, t + rng() / f, end, det);
    (v % 2 ? lpos : lneg).connect(o1.detune);
    const mid = (voices - 1) / 2;
    if (Math.abs(k) < 1e-6) { o1.connect(merger, 0, 0); o1.connect(merger, 0, 1); } else o1.connect(merger, 0, v < mid ? v % 2 : (v + 1) % 2);
  }
  if (o.sub) { // octave-down body, center
    const so = osc(ctx, 'sawtooth', f / 2, t + rng() / f, end, 0);
    const sg = gainNode(ctx, o.sub);
    so.connect(sg);
    sg.connect(merger, 0, 0); sg.connect(merger, 0, 1);
  }
  return end;
}

// Formant "choir": saw singers with vibrato through parallel band-passes at vowel formants.
const VOWELS = {
  sop_a: [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130], [4950, -50, 140]],
  sop_o: [[450, 0, 70], [800, -11, 80], [2830, -22, 100], [3800, -22, 130], [4950, -50, 135]],
  sop_u: [[325, 0, 50], [700, -16, 60], [2700, -35, 170], [3800, -40, 180], [4950, -60, 200]],
  alto_a: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
  alto_o: [[450, 0, 70], [800, -9, 80], [2830, -16, 100], [3500, -28, 130], [4950, -55, 135]],
  alto_u: [[325, 0, 50], [700, -12, 60], [2530, -30, 170], [3500, -40, 180], [4950, -64, 200]],
  ten_a: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
  ten_o: [[400, 0, 40], [800, -10, 80], [2600, -12, 100], [2800, -12, 120], [3000, -26, 120]],
  ten_u: [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
  bass_a: [[600, 0, 60], [1040, -7, 70], [2250, -9, 110], [2450, -9, 120], [2750, -20, 130]],
  bass_o: [[400, 0, 40], [750, -11, 80], [2400, -21, 100], [2600, -20, 120], [2900, -40, 120]],
  bass_u: [[350, 0, 40], [600, -20, 80], [2400, -32, 100], [2675, -28, 120], [2950, -36, 120]],
};
function vowelSet(midi, v) {
  const reg = midi < 50 ? 'bass' : midi < 58 ? 'ten' : midi < 67 ? 'alto' : 'sop';
  return VOWELS[`${reg}_${v}`] || VOWELS[`alto_${v}`] || VOWELS.alto_a;
}
export function choir(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const singers = o.singers ?? 3, a = o.a ?? 0.7, r = o.r ?? 1.4;
  const f = mtof(midi);
  const end = t + dur + r * 1.5 + 0.05;
  const v1 = vowelSet(midi, o.vowel || 'a');
  const v2 = o.vowel2 ? vowelSet(midi, o.vowel2) : null;
  const src = gainNode(ctx, 1 / Math.sqrt(singers));
  const merger = ctx.createChannelMerger(2);
  merger.connect(src);
  for (let s = 0; s < singers; s++) {
    const k = singers === 1 ? 0 : -1 + (2 * s) / (singers - 1);
    const o1 = osc(ctx, 'sawtooth', f, t + rng() / f, end, k * (o.spread ?? 9) + (rng() - 0.5) * 5);
    const vib = osc(ctx, 'sine', 4.6 + rng() * 1.0, t, end);
    const vd = ctx.createGain();
    vd.gain.setValueAtTime(0, t);
    vd.gain.linearRampToValueAtTime(o.vib ?? 15, t + 0.45 + rng() * 0.5);
    vib.connect(vd);
    vd.connect(o1.detune);
    if (Math.abs(k) < 1e-6) { o1.connect(merger, 0, 0); o1.connect(merger, 0, 1); } else o1.connect(merger, 0, k < 0 ? 0 : 1);
  }
  const nz = noise(ctx, 'white', t, end, rng);
  chain(nz, biquad(ctx, 'highpass', 1400, 0.5), gainNode(ctx, o.breath ?? 0.05), src);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 1.5, s: o.s ?? 0.9, r, peak: 1 });
  src.connect(amp);
  const sum = gainNode(ctx, (o.gain ?? 0.5) * 4);
  const morph = o.morph ?? a * 1.4;
  v1.forEach(([F, dB, bw], i) => {
    const bp = biquad(ctx, 'bandpass', F, F / bw);
    if (v2) {
      const [F2, , bw2] = v2[i];
      bp.frequency.setValueAtTime(F, t);
      bp.frequency.linearRampToValueAtTime(F2, t + morph);
      bp.Q.setValueAtTime(F / bw, t);
      bp.Q.linearRampToValueAtTime(F2 / bw2, t + morph);
    }
    const g = gainNode(ctx, dbToGain(dB));
    amp.connect(bp);
    bp.connect(g);
    g.connect(sum);
  });
  chain(sum, biquad(ctx, 'lowpass', o.lp ?? 6000, 0.5), biquad(ctx, 'highpass', o.hp ?? 120, 0.6), out);
  return end;
}

// FM bell / glass: sine carrier pair (slightly detuned L/R) + decaying modulation index,
// plus a fast-decaying strike partial. Index is capped so sidebands stay below Nyquist.
export function fmBell(ctx, out, t, midi, o = {}) {
  const f = mtof(midi);
  const ratio = o.ratio ?? 3.5, decay = o.decay ?? 2.4, peak = o.gain ?? 0.3;
  const nyq = ctx.sampleRate * 0.46;
  const maxI = Math.max(0.25, (nyq - f) / (f * ratio) - 1);
  const I = f * ratio < nyq ? Math.min(o.index ?? 3, maxI) : 0; // modulator above Nyquist: plain sine
  const end = t + decay * 1.1 + 0.05;
  const mod = osc(ctx, 'sine', Math.min(f * ratio, nyq), t, end);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(I * f * ratio, t);
  mg.gain.setTargetAtTime(I * f * ratio * (o.idxSustain ?? 0.06), t, (o.idxDecay ?? 0.45) / 3);
  mod.connect(mg);
  const merger = ctx.createChannelMerger(2);
  const det = o.detune ?? 0.0017;
  const cL = osc(ctx, 'sine', f * (1 - det / 2), t, end), cR = osc(ctx, 'sine', f * (1 + det / 2), t, end);
  mg.connect(cL.frequency);
  mg.connect(cR.frequency);
  cL.connect(merger, 0, 0);
  cR.connect(merger, 0, 1);
  const amp = ctx.createGain();
  perc(amp.gain, t, peak, decay, o.a ?? 0.002);
  merger.connect(amp);
  amp.connect(out);
  const strike = o.strike ?? 0.25;
  if (strike > 0) {
    const pf = f * (o.partial ?? 4.02);
    if (pf < nyq) {
      const p1 = osc(ctx, 'sine', pf, t, t + 0.8);
      const pg = ctx.createGain();
      perc(pg.gain, t, peak * strike, o.strikeDecay ?? 0.35, 0.001);
      p1.connect(pg);
      pg.connect(out);
    }
  }
  return end;
}

// Saw pluck with a snappy filter envelope (arps, stabs). Stereo from detuned L/R saws.
export function pluck(ctx, out, t, midi, o = {}) {
  const f = mtof(midi);
  const dec = o.decay ?? 0.35, peak = o.gain ?? 0.3, det = o.detune ?? 9;
  const end = t + dec * 1.2 + 0.05;
  const merger = ctx.createChannelMerger(2);
  const rng = o.rng || Math.random;
  const sL = osc(ctx, 'sawtooth', f, t + rng() * 0.3 / f, end, -det), sR = osc(ctx, 'sawtooth', f, t + rng() * 0.3 / f, end, det);
  sL.connect(merger, 0, 0);
  sR.connect(merger, 0, 1);
  if (o.sq) { const q = osc(ctx, 'square', f / 2, t, end); const qg = gainNode(ctx, o.sq); q.connect(qg); qg.connect(merger, 0, 0); qg.connect(merger, 0, 1); }
  const lp = biquad(ctx, 'lowpass', o.cut0 ?? 6000, o.q ?? 1.4);
  lp.frequency.setValueAtTime(o.cut0 ?? 6000, t);
  lp.frequency.setTargetAtTime(o.cut1 ?? 500, t + 0.002, (o.fdecay ?? 0.12) / 3);
  const amp = ctx.createGain();
  perc(amp.gain, t, peak, dec, o.a ?? 0.0015, o.hold ?? 0);
  chain(merger, lp, amp, out);
  return end;
}

// Mono synth-bass note for 16th ostinatos: saw + pulse through a resonant low-pass with a
// fast envelope, plus a clean sine sub; soft saturation.
export function bassNote(ctx, out, t, midi, o = {}) {
  const f = mtof(midi);
  const len = o.len ?? 0.11, acc = o.accent ?? 0;
  const end = t + len + 0.15;
  const lp = biquad(ctx, 'lowpass', 300, o.q ?? 5);
  const c0 = (o.cut ?? 380) + acc * (o.accCut ?? 1500);
  lp.frequency.setValueAtTime(c0, t);
  lp.frequency.setTargetAtTime(o.cutEnd ?? 120, t + 0.004, (o.fdecay ?? 0.07) / 3);
  const s1 = osc(ctx, 'sawtooth', f, t, end), s2 = osc(ctx, 'square', f, t, end, 7);
  const g1 = gainNode(ctx, 0.55), g2 = gainNode(ctx, 0.25);
  s1.connect(g1); s2.connect(g2); g1.connect(lp); g2.connect(lp);
  const sub = osc(ctx, 'sine', f, t, end);
  const sg = gainNode(ctx, o.sub ?? 0.8);
  sub.connect(sg);
  const mix = gainNode(ctx, 1);
  lp.connect(mix); sg.connect(mix);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(1, t + 0.003);
  amp.gain.setValueAtTime(1, t + len);
  amp.gain.setTargetAtTime(0, t + len, 0.012);
  chain(mix, amp, shaper(ctx, o.drive ?? 1.8, 0.05), biquad(ctx, 'highpass', 28, 0.7), gainNode(ctx, o.gain ?? 0.6), out);
  return end;
}

// Sustained sine sub with a touch of 2nd/3rd harmonic so it survives phone speakers.
export function subNote(ctx, out, t, dur, midi, o = {}) {
  const f = mtof(midi);
  const a = o.a ?? 0.04, r = o.r ?? 0.25;
  const end = t + dur + r * 1.5 + 0.05;
  const s = osc(ctx, 'sine', f, t, end);
  const h2 = osc(ctx, 'sine', f * 2, t, end);
  const hg = gainNode(ctx, o.harm ?? 0.12);
  h2.connect(hg);
  const mix = gainNode(ctx, 1);
  s.connect(mix); hg.connect(mix);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 0.3, s: 1, r, peak: 1 });
  chain(mix, amp, shaper(ctx, o.drive ?? 1.3, 0), gainNode(ctx, o.gain ?? 0.6), out);
  return end;
}

// CS-80-style lead: two detuned saws, slow filter swell, delayed vibrato, optional glide.
export function leadNote(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const a = o.a ?? 0.06, r = o.r ?? 0.5;
  const end = t + dur + r * 1.5 + 0.05;
  const merger = ctx.createChannelMerger(2);
  const vib = osc(ctx, 'sine', o.vibHz ?? 5.3, t, end);
  const vd = ctx.createGain();
  vd.gain.setValueAtTime(0, t);
  vd.gain.setValueAtTime(0, t + (o.vibDelay ?? 0.25));
  vd.gain.linearRampToValueAtTime(o.vib ?? 18, t + (o.vibDelay ?? 0.25) + 0.4);
  vib.connect(vd);
  const oscs = [];
  for (let i = 0; i < 2; i++) {
    const s = osc(ctx, 'sawtooth', f, t + rng() / f, end, (i ? 1 : -1) * (o.detune ?? 7));
    if (o.from != null) { const f0 = mtof(o.from); s.frequency.setValueAtTime(f0, t); s.frequency.exponentialRampToValueAtTime(f, t + (o.glide ?? 0.08)); }
    vd.connect(s.detune);
    s.connect(merger, 0, i);
    oscs.push(s);
  }
  if (o.sq) { const q = osc(ctx, 'square', f, t, end, 3); vd.connect(q.detune); const qg = gainNode(ctx, o.sq); q.connect(qg); qg.connect(merger, 0, 0); qg.connect(merger, 0, 1); }
  const lp = biquad(ctx, 'lowpass', 400, o.q ?? 2.2);
  lp.frequency.setValueAtTime(o.cut0 ?? 500, t);
  lp.frequency.exponentialRampToValueAtTime(o.cut ?? 3200, t + (o.fa ?? 0.18));
  lp.frequency.setTargetAtTime((o.cut ?? 3200) * 0.6, t + (o.fa ?? 0.18), 0.4);
  lp.frequency.setTargetAtTime(400, t + dur, r / 3);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 0.4, s: 0.85, r, peak: o.gain ?? 0.3 });
  chain(merger, lp, amp, out);
  return end;
}

// Braam: octave/fifth-stacked detuned saws + pulse, fast swell, brassy resonant filter blat that
// closes over time, "rasp" tremolo, oversampled saturation, sub layer.
export function braam(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const a = o.a ?? 0.09, r = o.r ?? 1.6;
  const end = t + dur + r * 1.5 + 0.05;
  const sum = gainNode(ctx, 1);
  const merger = ctx.createChannelMerger(2);
  merger.connect(sum);
  const layers = o.layers || [[0, 1, 0], [12, 0.8, 0.45], [7, 0.5, -0.45], [19, 0.28, 0.7], [-12, 0.45, 0]];
  const spread = o.spread ?? 11;
  for (const [iv, g, pan] of layers) {
    const f = mtof(midi + iv);
    for (let v = 0; v < 3; v++) {
      const type = v === 1 && iv >= 12 ? 'square' : 'sawtooth';
      const o1 = osc(ctx, type, f, t + rng() / f, end, (v - 1) * spread + (rng() - 0.5) * 4);
      const p = clamp(pan + (v - 1) * 0.35, -1, 1);
      const gg = gainNode(ctx, (g / 3) * (type === 'square' ? 0.6 : 1));
      o1.connect(gg);
      if (Math.abs(p) < 0.2) { gg.connect(merger, 0, 0); gg.connect(merger, 0, 1); } else gg.connect(merger, 0, p < 0 ? 0 : 1);
    }
  }
  const rasp = o.rasp ?? 0.25;
  const trem = gainNode(ctx, 1 - rasp / 2);
  const tl = osc(ctx, 'sawtooth', o.raspHz ?? 36, t, end);
  const tg = gainNode(ctx, rasp / 2);
  tl.connect(tg); tg.connect(trem.gain);
  sum.connect(trem);
  const c0 = o.cut0 ?? 140, cp = o.cutPeak ?? 2600, ce = o.cutEnd ?? 480;
  const lp1 = biquad(ctx, 'lowpass', c0, o.q ?? 2.4), lp2 = biquad(ctx, 'lowpass', c0, 0.7);
  for (const lp of [lp1, lp2]) {
    const p = lp.frequency;
    p.setValueAtTime(c0, t);
    p.exponentialRampToValueAtTime(cp, t + a + 0.1);
    p.setTargetAtTime(ce, t + a + 0.12, Math.max(0.05, (dur * 0.55) / 3));
    p.setTargetAtTime(110, t + dur, r / 3);
  }
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: dur * 0.8, s: o.s ?? 0.7, r, peak: 1 });
  chain(trem, lp1, lp2, amp, shaper(ctx, o.drive ?? 2.6, 0.06, '2x'), biquad(ctx, 'peaking', o.honk ?? 1150, 1.1, o.honkDb ?? 4),
    biquad(ctx, 'highpass', 30, 0.7), gainNode(ctx, o.gain ?? 0.5), out);
  if ((o.sub ?? 0.6) > 0) {
    const sm = midi >= 36 ? midi - 12 : midi;
    const so = osc(ctx, 'sine', mtof(sm), t, end);
    const sa = ctx.createGain();
    adsr(sa.gain, t, dur, { a: a * 0.7, d: dur, s: 0.8, r: r * 0.8, peak: (o.sub ?? 0.6) * (o.gain ?? 0.5) });
    so.connect(sa); sa.connect(out);
  }
  return end;
}

// ------------------------------------------------------------------ percussion
export function kick(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const p0 = o.p0 ?? 150, p1 = o.p1 ?? 47, dec = o.decay ?? 0.5;
  const end = t + dec * 1.1 + 0.05;
  const body = osc(ctx, 'sine', p0, t, end);
  body.frequency.setValueAtTime(p0, t);
  body.frequency.setTargetAtTime(p1, t + 0.001, (o.pt ?? 0.045) / 2.3);
  const bg = ctx.createGain();
  perc(bg.gain, t, 1, dec, 0.0008);
  body.connect(bg);
  const sum = gainNode(ctx, 1);
  bg.connect(sum);
  const nz = noise(ctx, 'white', t, t + 0.06, rng);
  const cg = ctx.createGain();
  perc(cg.gain, t, o.click ?? 0.3, o.clickDecay ?? 0.018, 0.0004);
  chain(nz, biquad(ctx, 'highpass', 1600, 0.7), biquad(ctx, 'lowpass', o.tone ?? 7000, 0.7), cg, sum);
  const kn = osc(ctx, 'triangle', o.knockF ?? 300, t, t + 0.12);
  kn.frequency.setTargetAtTime(110, t, 0.014);
  const kg = ctx.createGain();
  perc(kg.gain, t, o.knock ?? 0.3, 0.07, 0.0005);
  kn.connect(kg); kg.connect(sum);
  chain(sum, shaper(ctx, o.drive ?? 1.7, 0.04), biquad(ctx, 'highpass', 24, 0.7), gainNode(ctx, o.gain ?? 0.9), out);
  return end;
}

export function snare(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const dec = o.decay ?? 0.22;
  const end = t + Math.max(dec, 0.3) + 0.3;
  const sum = gainNode(ctx, 1);
  const b1 = osc(ctx, 'triangle', o.f1 ?? 245, t, t + 0.4);
  b1.frequency.setTargetAtTime((o.f1 ?? 245) * 0.76, t, 0.02);
  const g1 = ctx.createGain(); perc(g1.gain, t, o.body ?? 0.55, 0.16, 0.0008);
  b1.connect(g1); g1.connect(sum);
  const b2 = osc(ctx, 'sine', (o.f1 ?? 245) * 1.36, t, t + 0.3);
  b2.frequency.setTargetAtTime((o.f1 ?? 245) * 1.18, t, 0.02);
  const g2 = ctx.createGain(); perc(g2.gain, t, (o.body ?? 0.55) * 0.5, 0.09, 0.0008);
  b2.connect(g2); g2.connect(sum);
  const nz = noise(ctx, o.kind || 'pink', t, end, rng);
  const ng = ctx.createGain(); perc(ng.gain, t, o.noise ?? 0.9, dec, 0.001);
  chain(nz, biquad(ctx, 'bandpass', o.tone ?? 2600, 0.45), biquad(ctx, 'highpass', 650, 0.6), ng, sum);
  const nz2 = noise(ctx, 'white', t, t + 0.1, rng);
  const cg = ctx.createGain(); perc(cg.gain, t, o.crack ?? 0.45, 0.035, 0.0004);
  chain(nz2, biquad(ctx, 'highpass', 4200, 0.7), cg, sum);
  const post = shaper(ctx, o.drive ?? 1.5, 0.02);
  sum.connect(post);
  post.connect(out);
  if ((o.gate ?? 0.5) > 0) {
    const cv = ctx.createConvolver();
    cv.normalize = false;
    cv.buffer = gatedIRBuffer(ctx);
    chain(post, cv, biquad(ctx, 'highpass', 300, 0.6), gainNode(ctx, o.gate ?? 0.5), out);
  }
  return end;
}

export function clap(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const end = t + 0.5;
  const nz = noise(ctx, 'white', t, end, rng);
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0, t);
  const offs = [0, 0.011, 0.021, 0.033];
  for (const d of offs) { p.setValueAtTime(0, t + d); p.linearRampToValueAtTime(1, t + d + 0.001); p.setTargetAtTime(0.1, t + d + 0.001, 0.004); }
  p.setTargetAtTime(0, t + 0.04, (o.decay ?? 0.18) / 5);
  chain(nz, biquad(ctx, 'bandpass', o.tone ?? 1250, 1.1), biquad(ctx, 'highpass', 500), g, gainNode(ctx, o.gain ?? 0.9), out);
  return end;
}

export function tom(ctx, out, t, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi), dec = o.decay ?? 0.55;
  const end = t + dec + 0.1;
  const sum = gainNode(ctx, 1);
  const b = osc(ctx, 'sine', f * 1.55, t, end);
  b.frequency.setTargetAtTime(f, t, 0.03);
  const bg = ctx.createGain(); perc(bg.gain, t, 1, dec, 0.001);
  b.connect(bg); bg.connect(sum);
  const ov = osc(ctx, 'triangle', f * 2.4, t, t + 0.3);
  ov.frequency.setTargetAtTime(f * 1.9, t, 0.03);
  const og = ctx.createGain(); perc(og.gain, t, 0.18, 0.14, 0.001);
  ov.connect(og); og.connect(sum);
  const nz = noise(ctx, 'white', t, t + 0.08, rng);
  const ng = ctx.createGain(); perc(ng.gain, t, o.stick ?? 0.28, 0.035, 0.0005);
  chain(nz, biquad(ctx, 'bandpass', 1500, 0.9), ng, sum);
  chain(sum, shaper(ctx, o.drive ?? 1.6, 0.03), gainNode(ctx, o.gain ?? 0.8), out);
  return end;
}

export function taiko(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const f = o.f ?? 62, dec = o.decay ?? 1.0;
  const end = t + dec + 0.1;
  const sum = gainNode(ctx, 1);
  const b = osc(ctx, 'sine', f * 1.9, t, end);
  b.frequency.setTargetAtTime(f, t, 0.028);
  const bg = ctx.createGain(); perc(bg.gain, t, 1, dec, 0.0015);
  b.connect(bg); bg.connect(sum);
  const b2 = osc(ctx, 'sine', f * 2.75, t, t + 0.5);
  b2.frequency.setTargetAtTime(f * 2.3, t, 0.03);
  const b2g = ctx.createGain(); perc(b2g.gain, t, 0.22, 0.35, 0.0015);
  b2.connect(b2g); b2g.connect(sum);
  const sk = noise(ctx, 'pink', t, t + 0.6, rng);
  const skg = ctx.createGain(); perc(skg.gain, t, o.skin ?? 0.5, 0.3, 0.002);
  chain(sk, biquad(ctx, 'lowpass', 850, 0.8), skg, sum);
  const sl = noise(ctx, 'white', t, t + 0.05, rng);
  const slg = ctx.createGain(); perc(slg.gain, t, o.slap ?? 0.35, 0.02, 0.0005);
  chain(sl, biquad(ctx, 'bandpass', 1900, 1.2), slg, sum);
  chain(sum, shaper(ctx, o.drive ?? 1.9, 0.05), biquad(ctx, 'highpass', 28, 0.7), gainNode(ctx, o.gain ?? 0.8), out);
  return end;
}

const HAT_F = [205.3, 304.4, 369.6, 522.7, 540, 800];
export function metal(ctx, out, t, dur, o = {}) { // 808-style metallic square cluster
  const tune = o.tune ?? 1;
  const sum = gainNode(ctx, 0.16);
  for (const hf of HAT_F) { const q = osc(ctx, 'square', hf * tune, t, t + dur); q.connect(sum); }
  return sum;
}
export function hat(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const dec = o.decay ?? 0.05;
  const end = t + dec * 1.3 + 0.03;
  const m = metal(ctx, out, t, end - t, o);
  const env = ctx.createGain(); perc(env.gain, t, o.gain ?? 0.6, dec, 0.0005);
  chain(m, biquad(ctx, 'bandpass', o.bp ?? 9000, 0.7), biquad(ctx, 'highpass', o.hp ?? 6500, 0.7), env, out);
  const nz = noise(ctx, 'white', t, end, rng);
  const ng = ctx.createGain(); perc(ng.gain, t, (o.gain ?? 0.6) * (o.air ?? 0.22), dec * 0.8, 0.0005);
  chain(nz, biquad(ctx, 'highpass', 8000, 0.7), biquad(ctx, 'lowpass', 13000, 0.7), ng, out);
  return end;
}
export function crash(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const dec = o.decay ?? 2.2;
  const end = t + dec + 0.1;
  const m = metal(ctx, out, t, end - t, { tune: o.tune ?? 1.45 });
  const env = ctx.createGain(); perc(env.gain, t, (o.gain ?? 0.5) * 0.8, dec, 0.002);
  chain(m, biquad(ctx, 'bandpass', 7500, 0.5), biquad(ctx, 'highpass', 3200, 0.7), env, out);
  const nz = noise(ctx, 'white', t, end, rng);
  const ng = ctx.createGain(); perc(ng.gain, t, o.gain ?? 0.5, dec * 0.85, 0.002);
  chain(nz, biquad(ctx, 'highpass', 4500, 0.6), biquad(ctx, 'peaking', 9000, 0.8, 4), ng, out);
  return end;
}
export function shaker(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const end = t + 0.15;
  const nz = noise(ctx, 'white', t, end, rng);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.gain ?? 0.4, t + 0.012);
  g.gain.setTargetAtTime(0, t + 0.012, 0.02);
  chain(nz, biquad(ctx, 'bandpass', o.tone ?? 6500, 1.4), g, out);
  return end;
}

// Cinematic impact: sub boom + filtered noise burst + inharmonic metal ring.
export function impact(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const dec = o.decay ?? 1.8;
  const end = t + dec + 0.2;
  const sum = gainNode(ctx, 1);
  const b = osc(ctx, 'sine', o.p0 ?? 95, t, end);
  b.frequency.setTargetAtTime(o.p1 ?? 31, t, o.pt ?? 0.09);
  const bg = ctx.createGain(); perc(bg.gain, t, 1, dec, 0.002);
  b.connect(bg); bg.connect(sum);
  const nz = noise(ctx, 'pink', t, t + 1.2, rng);
  const lp = biquad(ctx, 'lowpass', 6000, 0.6);
  lp.frequency.setValueAtTime(o.nz0 ?? 7000, t);
  lp.frequency.exponentialRampToValueAtTime(180, t + (o.nzDur ?? 0.7));
  const ng = ctx.createGain(); perc(ng.gain, t, o.noise ?? 0.9, o.nzDur ?? 0.7, 0.001);
  chain(nz, lp, ng, sum);
  if ((o.metal ?? 0.25) > 0) {
    for (const [ratio, dd] of [[1, 1.4], [2.76, 0.9], [5.4, 0.6], [8.93, 0.35]]) {
      const m = osc(ctx, 'sine', (o.ring ?? 190) * ratio, t, t + dd + 0.1);
      const mg = ctx.createGain(); perc(mg.gain, t, (o.metal ?? 0.25) / ratio ** 0.4, dd, 0.001);
      m.connect(mg); mg.connect(sum);
    }
  }
  chain(sum, shaper(ctx, o.drive ?? 2.0, 0.05), biquad(ctx, 'highpass', 22, 0.7), gainNode(ctx, o.gain ?? 0.8), out);
  return end;
}

// Noise riser / whoosh: band-pass sweep with exponential swell (+ optional rising saws).
export function riser(ctx, out, t, dur, o = {}) {
  const rng = o.rng || Math.random;
  const end = t + dur + (o.tail ?? 0.05);
  if ((o.gain ?? 0.5) > 0) {
    const nz = noise(ctx, o.kind || 'white', t, end, rng);
    const bp = biquad(ctx, 'bandpass', o.f0 ?? 300, o.q0 ?? 0.8);
    bp.frequency.setValueAtTime(o.f0 ?? 300, t);
    bp.frequency.exponentialRampToValueAtTime(o.f1 ?? 7000, t + dur);
    bp.Q.setValueAtTime(o.q0 ?? 0.8, t);
    bp.Q.linearRampToValueAtTime(o.q1 ?? 3, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.5, t + dur);
    g.gain.setTargetAtTime(0, t + dur, o.release ?? 0.01);
    chain(nz, bp, g, out);
  }
  if (o.saws) {
    const merger = ctx.createChannelMerger(2);
    for (let i = 0; i < 4; i++) {
      const s = osc(ctx, 'sawtooth', mtof(o.note ?? 57), t, end, (i - 1.5) * 12);
      s.detune.setValueAtTime((i - 1.5) * 12, t);
      s.detune.linearRampToValueAtTime((i - 1.5) * 12 + (o.rise ?? 1200), t + dur);
      s.connect(merger, 0, i % 2);
    }
    const lp = biquad(ctx, 'lowpass', 400, 1.5);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(o.saws, t + dur);
    sg.gain.setTargetAtTime(0, t + dur, 0.01);
    chain(merger, lp, sg, out);
  }
  return end;
}
