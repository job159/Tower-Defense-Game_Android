// Offline synthesis building blocks (Web Audio node graphs rendered in OfflineAudioContexts).
// Every instrument builder has the shape fn(ctx, out, t, ..., opts) and returns its end time.
import { mtof, makeRng, hashStr, whiteNoise, pinkNoise, brownNoise, clamp, dbToGain, makeGatedIR, crackle } from './dsp.js';

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
  if (o.drive) chain(merger, lp, amp, shaper(ctx, o.drive, 0.05), biquad(ctx, 'highpass', 120, 0.7), out);
  else chain(merger, lp, amp, out);
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

// ================================================================== selectable BGM voices (v2.3)
// Electric piano, reese / growl basses, chip voices, shakuhachi, plucked string, brass, vocal hits,
// metal percussion, vinyl. Same contract as above; none of the earlier instruments changed.
const coefCache = new Map();
function customWave(ctx, key, make) {
  let c = coefCache.get(key);
  if (!c) { c = make(); coefCache.set(key, c); }
  return ctx.createPeriodicWave(c[0], c[1], { disableNormalization: false });
}
// band-limited pulse, duty d (the browser drops partials above Nyquist per note)
function pulseCoefs(d, N = 96) {
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) re[n] = (4 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
  return [re, im];
}
// 4-bit stepped triangle (NES): exact Fourier series of the 32-step staircase
function stepTriCoefs(N = 96) {
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  const v = [];
  for (let k = 0; k < 32; k++) v.push((k < 16 ? 15 - k : k - 16) / 7.5 - 1);
  for (let n = 1; n <= N; n++) {
    const w = 2 * Math.PI * n;
    let a = 0, b = 0;
    for (let k = 0; k < 32; k++) {
      const t0 = k / 32, t1 = (k + 1) / 32;
      a += (2 * v[k] * (Math.sin(w * t1) - Math.sin(w * t0))) / w;
      b += (2 * v[k] * (Math.cos(w * t0) - Math.cos(w * t1))) / w;
    }
    re[n] = a; im[n] = b;
  }
  return [re, im];
}
const cosCoefs = () => [new Float32Array([0, 1]), new Float32Array([0, 0])];

// Suitcase-style electric piano: 1:1 FM pair (body + bark, brighter with velocity), tine "ding"
// partial, struck decay while held + damper release, stereo tremolo.
export function epiano(ctx, out, t, dur, midi, o = {}) {
  const f = mtof(midi);
  const nyq = ctx.sampleRate * 0.45;
  const vel = o.vel ?? 0.7;
  const dec = o.decay ?? Math.max(1.2, 3.4 - (midi - 48) * 0.045);
  const r = o.r ?? 0.22;
  const end = t + Math.min(dur + r * 1.5, dec * 1.25) + 0.08;
  const mod = osc(ctx, 'sine', f * (o.ratio ?? 1), t, end);
  const mg = ctx.createGain();
  const I = (o.index ?? 1.3) * (0.45 + vel);
  mg.gain.setValueAtTime(I * f, t);
  mg.gain.setTargetAtTime(I * f * (o.idxSus ?? 0.22), t, o.idxT ?? 0.25);
  mod.connect(mg);
  const merger = ctx.createChannelMerger(2);
  const det = o.det ?? 2.5;
  [-det, det].forEach((d, side) => { const c = osc(ctx, 'sine', f, t, end, d); mg.connect(c.frequency); c.connect(merger, 0, side); });
  const sum = gainNode(ctx, 1);
  merger.connect(sum);
  const tf = f * (o.tine ?? 13.9);
  if (tf < nyq) {
    const tn = osc(ctx, 'sine', tf, t, t + 0.3);
    const tg = ctx.createGain();
    perc(tg.gain, t, (o.ding ?? 0.12) * (0.4 + vel), 0.07, 0.0005);
    tn.connect(tg); tg.connect(sum);
  }
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(1, t + 0.0025);
  amp.gain.setTargetAtTime(0, t + 0.0025, dec / 4.6);
  amp.gain.setTargetAtTime(0, t + dur, r / 4.6);
  const split = ctx.createChannelSplitter(2), m2 = ctx.createChannelMerger(2);
  const tr = o.trem ?? 0.2;
  const gl = gainNode(ctx, 1 - tr), gr = gainNode(ctx, 1 - tr);
  if (tr > 0) {
    const l = osc(ctx, 'sine', o.tremHz ?? 4.3, t, end);
    const a1 = gainNode(ctx, tr), a2 = gainNode(ctx, -tr);
    l.connect(a1); l.connect(a2); a1.connect(gl.gain); a2.connect(gr.gain);
  }
  chain(sum, amp, shaper(ctx, o.drive ?? 1.25, 0.03), split);
  split.connect(gl, 0); split.connect(gr, 1);
  gl.connect(m2, 0, 0); gr.connect(m2, 0, 1);
  chain(m2, biquad(ctx, 'lowpass', o.lp ?? 6500, 0.6), gainNode(ctx, o.gain ?? 0.4), out);
  return end;
}

// Reese: four detuned saws split L/R, moving low-pass, saturation. High-passed: pair it with a
// mono sub (subNote) for the fundamental.
export function reese(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const a = o.a ?? 0.01, r = o.r ?? 0.1;
  const end = t + dur + r * 1.5 + 0.05;
  const merger = ctx.createChannelMerger(2);
  const det = o.det ?? 16;
  for (const [d, side] of [[-det, 0], [det * 0.45, 0], [det, 1], [-det * 0.45, 1]]) {
    const s = osc(ctx, 'sawtooth', f, t + rng() / f, end, d + (rng() - 0.5) * 2);
    const g = gainNode(ctx, 0.5);
    s.connect(g); g.connect(merger, 0, side);
  }
  const lp = biquad(ctx, 'lowpass', o.cut ?? 700, o.q ?? 1.4);
  if (o.sweep) { lp.frequency.setValueAtTime(o.sweep[0], t); lp.frequency.exponentialRampToValueAtTime(o.sweep[1], t + Math.max(0.05, dur)); }
  if (o.lfo) {
    const l = ctx.createOscillator();
    l.setPeriodicWave(customWave(ctx, 'cos', cosCoefs));
    l.frequency.value = o.lfo;
    l.start(t); l.stop(end);
    const lg = gainNode(ctx, -(o.lfoDepth ?? 900));
    l.connect(lg); lg.connect(lp.detune);
  }
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 0.2, s: 0.9, r, peak: 1 });
  chain(merger, lp, shaper(ctx, o.drive ?? 2.2, 0.04), biquad(ctx, 'highpass', o.hp ?? 120, 0.7),
    biquad(ctx, 'peaking', o.honk ?? 520, 1, o.honkDb ?? 2), amp, gainNode(ctx, o.gain ?? 0.5), out);
  return end;
}

// Wobble / "talking" bass: saws + sub-octave square through an LFO-swept resonant low-pass and two
// moving formant peaks (cosine-phase LFO: every note starts closed), drive. Mono, high-passed.
export function growl(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const a = o.a ?? 0.005, r = o.r ?? 0.08;
  const end = t + dur + r * 1.5 + 0.05;
  const sum = gainNode(ctx, 0.5);
  for (const d of [-(o.det ?? 9), o.det ?? 9]) osc(ctx, 'sawtooth', f, t + rng() / f, end, d).connect(sum);
  const sq = osc(ctx, 'square', f / 2, t, end);
  const sg = gainNode(ctx, o.sq ?? 0.5);
  sq.connect(sg); sg.connect(sum);
  const lfo = ctx.createOscillator();
  lfo.setPeriodicWave(customWave(ctx, 'cos', cosCoefs));
  lfo.frequency.value = o.rate ?? 4;
  lfo.start(t); lfo.stop(end);
  const c0 = o.cut0 ?? 180, c1 = o.cut1 ?? 2400;
  const lp = biquad(ctx, 'lowpass', Math.sqrt(c0 * c1), o.q ?? 4);
  const lg = gainNode(ctx, -600 * Math.log2(c1 / c0));
  lfo.connect(lg); lg.connect(lp.detune);
  const f1 = biquad(ctx, 'peaking', o.fA ?? 650, 3, o.fDb ?? 8), f2 = biquad(ctx, 'peaking', o.fB ?? 1400, 4, (o.fDb ?? 8) * 0.8);
  const fg = gainNode(ctx, -(o.formDepth ?? 700));
  lfo.connect(fg); fg.connect(f1.detune); fg.connect(f2.detune);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 0.1, s: 0.95, r, peak: 1 });
  chain(sum, lp, f1, f2, shaper(ctx, o.drive ?? 2.6, 0.08), biquad(ctx, 'highpass', o.hp ?? 85, 0.7), amp, gainNode(ctx, o.gain ?? 0.5), out);
  return end;
}

// Chip voice: band-limited pulse (duty) or 4-bit triangle (o.tri) with optional slide-in, fast
// arpeggio (semitone list), pitch drop and delayed vibrato. Mono.
export function pulse(ctx, out, t, dur, midi, o = {}) {
  const f = mtof(midi);
  const a = o.a ?? 0.003, r = o.r ?? 0.05;
  const end = t + dur + r * 1.5 + 0.05;
  const s = ctx.createOscillator();
  const duty = o.duty ?? 0.25;
  s.setPeriodicWave(o.tri ? customWave(ctx, 'tri4', stepTriCoefs) : customWave(ctx, `pulse${duty}`, () => pulseCoefs(duty)));
  s.frequency.value = f;
  if (o.from != null) { s.frequency.setValueAtTime(mtof(o.from), t); s.frequency.exponentialRampToValueAtTime(f, t + (o.glide ?? 0.05)); }
  if (o.arp) {
    const step = o.arpStep ?? 1 / 30;
    let i = 0;
    for (let tt = t; tt < t + dur + r; tt += step, i++) s.frequency.setValueAtTime(f * Math.pow(2, o.arp[i % o.arp.length] / 12), tt);
  }
  if (o.drop) { s.frequency.setValueAtTime(f, t); s.frequency.exponentialRampToValueAtTime(f * Math.pow(2, -o.drop / 12), t + (o.dropT ?? 0.08)); }
  if (o.vib) {
    const v = osc(ctx, 'triangle', o.vibHz ?? 6, t, end);
    const vg = ctx.createGain();
    const vd = o.vibDelay ?? 0.18;
    vg.gain.setValueAtTime(0, t); vg.gain.setValueAtTime(0, t + vd); vg.gain.linearRampToValueAtTime(o.vib, t + vd + 0.12);
    v.connect(vg); vg.connect(s.detune);
  }
  s.start(t); s.stop(end);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: o.d ?? 0.12, s: o.s ?? 0.7, r, peak: o.gain ?? 0.3 });
  chain(s, amp, biquad(ctx, 'lowpass', o.lp ?? 12000, 0.5), out);
  return end;
}

// Chip noise channel: 15-bit LFSR (long or short/metallic mode) clocked at `rate` (gliding to
// rate1), 4-bit stepped volume decay. Mono.
export function chipNoise(ctx, out, t, o = {}) {
  const sr = ctx.sampleRate;
  const dur = o.dur ?? 0.25;
  const n = Math.max(32, Math.ceil(dur * sr));
  const d = new Float32Array(n);
  const rng = o.rng || Math.random;
  let reg = 1 + Math.floor(rng() * 32766);
  const tap = o.short ? 6 : 1;
  const r0 = o.rate ?? 12000, r1 = o.rate1 ?? r0, rt = o.rateT ?? 0.05;
  const dec = o.decay ?? 0.12;
  let ph = 0, v = 1;
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    const rate = r1 !== r0 ? r0 * Math.pow(r1 / r0, Math.min(1, tt / rt)) : r0;
    ph += rate / sr;
    while (ph >= 1) { ph -= 1; const fb = (reg ^ (reg >> tap)) & 1; reg = (reg >> 1) | (fb << 14); v = reg & 1 ? -1 : 1; }
    let e = Math.exp((-tt * 6.9) / dec);
    if (o.steps !== false) e = Math.round(e * 15) / 15;
    d[i] = v * e * (i < 24 ? i / 24 : 1);
  }
  const src = ctx.createBufferSource();
  src.buffer = bufferFrom(ctx, [d], sr);
  chain(src, biquad(ctx, 'highpass', o.hp ?? 90, 0.7), biquad(ctx, 'lowpass', o.lp ?? 13000, 0.6), gainNode(ctx, o.gain ?? 0.5), out);
  src.start(t);
  return t + dur;
}

// Shakuhachi-like flute: mellow harmonic tone, meri/kari bend into the note, slow "yuri" vibrato,
// tonal breath + air noise, chiff on the attack. Mono.
const fluteCoefs = () => [new Float32Array(8), new Float32Array([0, 1, 0.3, 0.13, 0.06, 0.03, 0.018, 0.01])];
export function flute(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const a = o.a ?? 0.09, r = o.r ?? 0.3;
  const end = t + dur + r * 1.5 + 0.05;
  const s = ctx.createOscillator();
  s.setPeriodicWave(customWave(ctx, 'flute', fluteCoefs));
  const bend = o.bend ?? 0;
  s.frequency.setValueAtTime(f * Math.pow(2, -bend / 12), t);
  if (bend) s.frequency.setTargetAtTime(f, t + 0.02, (o.bendT ?? 0.12) / 3);
  if (o.fall) s.frequency.setTargetAtTime(f * Math.pow(2, -o.fall / 12), t + dur * 0.92, 0.05);
  s.start(t); s.stop(end);
  const v = osc(ctx, 'sine', o.vibHz ?? 5.2, t, end);
  const vg = ctx.createGain();
  vg.gain.setValueAtTime(0, t);
  vg.gain.setValueAtTime(0, t + Math.min(dur * 0.4, 0.35));
  vg.gain.linearRampToValueAtTime(o.vib ?? 22, t + Math.max(0.25, dur * 0.9));
  v.connect(vg); vg.connect(s.detune);
  const tone = gainNode(ctx, 1);
  s.connect(tone);
  const nz = noise(ctx, 'white', t, end, rng);
  const br = o.breath ?? 0.35;
  chain(nz, biquad(ctx, 'bandpass', Math.min(f * 2, 9000), 3), gainNode(ctx, br), tone);
  chain(nz, biquad(ctx, 'highpass', 3200, 0.6), gainNode(ctx, br * 0.22), tone);
  const cg = ctx.createGain();
  perc(cg.gain, t, o.chiff ?? 0.6, 0.07, 0.004);
  chain(nz, biquad(ctx, 'bandpass', Math.min(f * 3, 6500), 1.2), cg, tone);
  const amp = ctx.createGain();
  const pk = o.gain ?? 0.3;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(pk, t + a);
  amp.gain.setTargetAtTime(pk * (o.s ?? 0.82), t + a, 0.18);
  amp.gain.setTargetAtTime(0, t + dur, r / 4.6);
  chain(tone, amp, biquad(ctx, 'lowpass', o.lp ?? 7000, 0.5), biquad(ctx, 'highpass', 140, 0.6), out);
  return end;
}

// Plucked string (koto / guitar-ish), additive: partials weighted by the pluck position, higher
// partials decay faster, slight stiffness, sharp attack settling ("twang"), optional press-bend.
export function pluckStr(ctx, out, t, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const dec = o.decay ?? 1.4;
  const nyq = ctx.sampleRate * 0.45;
  const pos = o.pos ?? 0.2;
  const K = Math.max(1, Math.min(o.partials ?? 10, Math.floor(nyq / f)));
  const end = t + dec + 0.1;
  const sum = gainNode(ctx, 1);
  const B = o.inharm ?? 0.0003;
  const tw = o.twang ?? 18;
  for (let k = 1; k <= K; k++) {
    const fk = f * k * Math.sqrt(1 + B * k * k);
    if (fk >= nyq) break;
    const amp = Math.abs(Math.sin(k * Math.PI * pos)) / Math.pow(k, o.tilt ?? 1.15);
    if (amp < 0.004) continue;
    const s = osc(ctx, 'sine', fk, t, end);
    if (tw) { s.detune.setValueAtTime(tw, t); s.detune.setTargetAtTime(0, t, 0.015); }
    if (o.bendTo != null) {
      s.frequency.setValueAtTime(fk, t + o.bendAt);
      s.frequency.exponentialRampToValueAtTime(fk * Math.pow(2, (o.bendTo - midi) / 12), t + o.bendAt + (o.bendT ?? 0.12));
    }
    const g = ctx.createGain();
    perc(g.gain, t, amp, dec / (1 + (k - 1) * (o.damp ?? 0.45)), 0.0015);
    s.connect(g); g.connect(sum);
  }
  const nz = noise(ctx, 'white', t, t + 0.03, rng);
  const ng = ctx.createGain();
  perc(ng.gain, t, o.pick ?? 0.2, 0.012, 0.0005);
  chain(nz, biquad(ctx, 'bandpass', o.pickF ?? 3200, 0.9), ng, sum);
  chain(sum, biquad(ctx, 'peaking', o.body ?? 380, 1.2, o.bodyDb ?? 3), biquad(ctx, 'highpass', 60, 0.7), gainNode(ctx, o.gain ?? 0.5), out);
  return end;
}

// Brass / horn: three detuned saws, filter "blat" on the attack settling lower, slight scoop into
// pitch, delayed vibrato, brass formant, gentle drive. Stereo from the outer saws.
export function horn(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const a = o.a ?? 0.05, r = o.r ?? 0.35;
  const end = t + dur + r * 1.5 + 0.05;
  const merger = ctx.createChannelMerger(2);
  const vib = osc(ctx, 'sine', o.vibHz ?? 5, t, end);
  const vd = ctx.createGain();
  vd.gain.setValueAtTime(0, t); vd.gain.setValueAtTime(0, t + 0.3); vd.gain.linearRampToValueAtTime(o.vib ?? 9, t + 0.8);
  vib.connect(vd);
  [[-(o.det ?? 6), 0], [0, 2], [o.det ?? 6, 1]].forEach(([d, side]) => {
    const s = osc(ctx, 'sawtooth', f, t + rng() / f, end, d);
    s.detune.setValueAtTime(d - (o.scoop ?? 35), t);
    s.detune.linearRampToValueAtTime(d, t + 0.06);
    vd.connect(s.detune);
    if (o.from != null) { s.frequency.setValueAtTime(mtof(o.from), t); s.frequency.exponentialRampToValueAtTime(f, t + (o.glide ?? 0.08)); }
    if (side === 2) { s.connect(merger, 0, 0); s.connect(merger, 0, 1); } else s.connect(merger, 0, side);
  });
  const cut = o.cut ?? 1500;
  const lp = biquad(ctx, 'lowpass', 300, o.q ?? 1.1);
  lp.frequency.setValueAtTime(o.cut0 ?? 280, t);
  lp.frequency.exponentialRampToValueAtTime(cut * (o.blat ?? 1.7), t + a + 0.05);
  lp.frequency.setTargetAtTime(cut, t + a + 0.05, 0.15);
  lp.frequency.setTargetAtTime(300, t + dur, r / 3);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a, d: 0.3, s: o.s ?? 0.85, r, peak: 1 });
  chain(merger, lp, biquad(ctx, 'peaking', o.formant ?? 1150, 1.2, 3), amp, shaper(ctx, o.drive ?? 1.5, 0.04), biquad(ctx, 'highpass', 60, 0.7), gainNode(ctx, o.gain ?? 0.4), out);
  return end;
}

// Vocal hit / chop: three saw voices through vowel formants with a pitch fall (shouts, kakegoe,
// glitch chops); lots of breath. Stereo.
export function voxHit(ctx, out, t, dur, midi, o = {}) {
  const rng = o.rng || Math.random;
  const f = mtof(midi);
  const r = o.r ?? 0.12;
  const end = t + dur + r * 1.5 + 0.05;
  const merger = ctx.createChannelMerger(2);
  const src = gainNode(ctx, 0.6);
  merger.connect(src);
  for (let s = 0; s < 3; s++) {
    const o1 = osc(ctx, 'sawtooth', f, t + rng() / f, end, (s - 1) * 12 + (rng() - 0.5) * 6);
    if (o.drop) o1.frequency.setTargetAtTime(f * Math.pow(2, -o.drop / 12), t + dur * 0.3, dur * 0.5);
    if (s === 1) { o1.connect(merger, 0, 0); o1.connect(merger, 0, 1); } else o1.connect(merger, 0, s ? 1 : 0);
  }
  const nz = noise(ctx, 'white', t, end, rng);
  chain(nz, biquad(ctx, 'highpass', 900, 0.5), gainNode(ctx, o.breath ?? 0.25), src);
  const amp = ctx.createGain();
  adsr(amp.gain, t, dur, { a: o.a ?? 0.006, d: dur * 0.6, s: o.s ?? 0.6, r, peak: 1 });
  src.connect(amp);
  const sum = gainNode(ctx, (o.gain ?? 0.5) * 4);
  for (const [F, dB, bw] of vowelSet(midi, o.vowel || 'a')) {
    const bp = biquad(ctx, 'bandpass', F, F / bw);
    const g = gainNode(ctx, dbToGain(dB));
    amp.connect(bp); bp.connect(g); g.connect(sum);
  }
  chain(sum, shaper(ctx, o.drive ?? 1.3, 0.02), biquad(ctx, 'highpass', o.hp ?? 160, 0.6), out);
  return end;
}

// Anvil / metal clang: inharmonic bar modes (slightly detuned L/R), noise strike, drive.
export function anvil(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const f0 = o.f ?? 780, dec = o.decay ?? 1.0;
  const end = t + dec + 0.1;
  const merger = ctx.createChannelMerger(2);
  const sum = gainNode(ctx, 1);
  merger.connect(sum);
  const nyq = ctx.sampleRate * 0.45;
  const P = o.partials || [[1, 1, 1], [2.32, 0.7, 0.75], [4.25, 0.5, 0.5], [6.63, 0.35, 0.35], [9.38, 0.22, 0.22]];
  for (const [ratio, amp, dk] of P) {
    for (let side = 0; side < 2; side++) {
      const fr = f0 * ratio * (side ? 1.0025 : 0.9975);
      if (fr >= nyq) continue;
      const s = osc(ctx, 'sine', fr, t, end);
      const g = ctx.createGain();
      perc(g.gain, t, amp, dec * dk, 0.0008);
      s.connect(g); g.connect(merger, 0, side);
    }
  }
  const nz = noise(ctx, 'white', t, t + 0.05, rng);
  const ng = ctx.createGain();
  perc(ng.gain, t, o.strike ?? 0.6, 0.02, 0.0004);
  chain(nz, biquad(ctx, 'highpass', 2500, 0.7), ng, sum);
  chain(sum, shaper(ctx, o.drive ?? 1.5, 0.02), biquad(ctx, 'highpass', o.hp ?? 200, 0.7), gainNode(ctx, o.gain ?? 0.5), out);
  return end;
}

// Ride cymbal: low metallic cluster + sizzle + bell partials.
export function ride(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const dec = o.decay ?? 1.6;
  const tune = o.tune ?? 0.82;
  const end = t + dec + 0.1;
  const m = metal(ctx, out, t, end - t, { tune });
  const env = ctx.createGain();
  perc(env.gain, t, (o.gain ?? 0.5) * 0.55, dec, 0.001);
  chain(m, biquad(ctx, 'bandpass', o.bp ?? 5200, 0.6), biquad(ctx, 'highpass', 2800, 0.7), env, out);
  const nz = noise(ctx, 'white', t, end, rng);
  const ng = ctx.createGain();
  perc(ng.gain, t, (o.gain ?? 0.5) * 0.45, dec * 0.8, 0.001);
  chain(nz, biquad(ctx, 'highpass', 6000, 0.6), biquad(ctx, 'peaking', 9500, 0.8, 3), ng, out);
  const bell = o.bell ?? 0.25;
  for (const [fr, a] of [[2400, 1], [3610, 0.6], [5080, 0.35]]) {
    const s = osc(ctx, 'sine', (fr * tune) / 0.82, t, t + 0.8);
    const g = ctx.createGain();
    perc(g.gain, t, (o.gain ?? 0.5) * bell * a, 0.5, 0.0008);
    s.connect(g); g.connect(out);
  }
  return end;
}

// Rimshot / side-stick click.
export function rim(ctx, out, t, o = {}) {
  const rng = o.rng || Math.random;
  const end = t + 0.25;
  const f = o.f ?? 1700, dec = o.decay ?? 0.045;
  const sum = gainNode(ctx, 1);
  const a = osc(ctx, 'triangle', f, t, end);
  const ag = ctx.createGain(); perc(ag.gain, t, 0.5, dec, 0.0004);
  a.connect(ag); ag.connect(sum);
  const b = osc(ctx, 'sine', f * 0.31, t, end);
  const bg = ctx.createGain(); perc(bg.gain, t, 0.6, dec * 1.6, 0.0004);
  b.connect(bg); bg.connect(sum);
  const nz = noise(ctx, 'white', t, t + 0.03, rng);
  const ng = ctx.createGain(); perc(ng.gain, t, o.click ?? 0.4, 0.008, 0.0003);
  chain(nz, biquad(ctx, 'bandpass', 4000, 1), ng, sum);
  chain(sum, shaper(ctx, o.drive ?? 1.4, 0.03), biquad(ctx, 'highpass', 250, 0.7), gainNode(ctx, o.gain ?? 0.7), out);
  return end;
}

// Vinyl bed: sparse crackle + rare pops (independent per channel) and a little hiss.
export function vinyl(ctx, out, t, dur, o = {}) {
  const rng = o.rng || Math.random;
  const sr = ctx.sampleRate;
  const n = Math.ceil(dur * sr);
  const chs = [0, 1].map(() => {
    const d = crackle(n, sr, rng, { rate: o.rate ?? 9, decay: 0.0004, amp: 1 });
    const p = crackle(n, sr, rng, { rate: o.pops ?? 0.5, decay: 0.002, amp: 1.6 });
    for (let i = 0; i < n; i++) d[i] += p[i];
    return d;
  });
  const src = ctx.createBufferSource();
  src.buffer = bufferFrom(ctx, chs, sr);
  chain(src, biquad(ctx, 'highpass', 900, 0.6), biquad(ctx, 'lowpass', 7000, 0.6), gainNode(ctx, o.crackle ?? 0.6), out);
  src.start(t);
  const h = noise(ctx, 'pink', t, t + dur, rng);
  chain(h, biquad(ctx, 'highpass', 2500, 0.6), biquad(ctx, 'lowpass', 9000, 0.6), gainNode(ctx, o.hiss ?? 0.05), out);
  return t + dur;
}
