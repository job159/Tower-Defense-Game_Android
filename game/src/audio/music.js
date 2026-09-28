// Procedural score. Pipeline per track:
//   1. arrangement -> note events (instrument one-shot + time + gain + pan + sidechain depth)
//   2. every distinct one-shot is synthesized once (OfflineAudioContext, parallel pool) = "sample bank"
//   3. events are mixed into a few stereo buses per stem (dry / hall / delay); all sections of a
//      stem share one timeline (separated by tail-length gaps)
//   4. one mixdown context per stem timeline: bus EQ, hall convolution, ping-pong delay
//   5. mastering: loudness target, glue compression + soft clip, linked limiter across stems
//   6. reverb tails are folded onto the segment start (with a short crossfade overhang) so every
//      segment is exactly N bars and can be butt-joined in any order, sample-accurately.
// Steps 2 (normalization), 3, 5 and 6 are pure JS and run in a Worker (jobs.js); the main thread
// only builds Web Audio graphs and moves buffers.
import { mtof, makeRng, hashStr, dbToGain, makeIR, now } from './dsp.js';
import {
  bufferFrom, gainNode, biquad, chain, osc, noise, perc, glide, supersaw, choir, fmBell, pluck, bassNote,
  subNote, leadNote, braam, kick, snare, clap, tom, taiko, hat, crash, shaker, impact, riser,
} from './synth.js';

// ------------------------------------------------------------------ instrument one-shots
const js = (o) => JSON.stringify(o || {});
const spec = (key, ch, dur, norm, build) => [key, { ch, dur, norm, build }];
export const INS = {
  pad: (m, len, o = {}) => spec(`pad|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 1) * 1.2 + 0.08, ['rms', -18], (c, out, rng) => supersaw(c, out, 0, len, m, { ...o, rng })),
  choir: (m, len, o = {}) => spec(`choir|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 1.4) * 1.2 + 0.08, ['rms', -18], (c, out, rng) => choir(c, out, 0, len, m, { ...o, rng })),
  bell: (m, o = {}) => spec(`bell|${m}|${js(o)}`, 2, (o.decay ?? 2.4) * 1.05 + 0.05, ['peak', -3], (c, out, rng) => fmBell(c, out, 0, m, { ...o, rng })),
  pluck: (m, o = {}) => spec(`pluck|${m}|${js(o)}`, 2, (o.decay ?? 0.35) * 1.15 + 0.05, ['peak', -3], (c, out, rng) => pluck(c, out, 0, m, { ...o, rng })),
  bass: (m, o = {}) => spec(`bass|${m}|${js(o)}`, 1, (o.len ?? 0.11) + 0.14, ['peak', -3], (c, out) => bassNote(c, out, 0, m, o)),
  sub: (m, len, o = {}) => spec(`sub|${m}|${len.toFixed(3)}|${js(o)}`, 1, len + (o.r ?? 0.25) * 1.2 + 0.06, ['peak', -3], (c, out) => subNote(c, out, 0, len, m, o)),
  lead: (m, len, o = {}) => spec(`lead|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 0.5) * 1.2 + 0.06, ['rms', -18], (c, out, rng) => leadNote(c, out, 0, len, m, { ...o, rng })),
  braam: (m, len, o = {}) => spec(`braam|${m}|${len.toFixed(3)}|${js(o)}`, 2, len + (o.r ?? 1.6) * 1.2 + 0.08, ['rms', -14], (c, out, rng) => braam(c, out, 0, len, m, { ...o, rng })),
  kick: (o = {}) => spec(`kick|${js(o)}`, 1, (o.decay ?? 0.5) * 1.1 + 0.06, ['peak', -1], (c, out, rng) => kick(c, out, 0, { ...o, rng })),
  snare: (o = {}) => spec(`snare|${js(o)}`, 2, Math.max(o.decay ?? 0.22, 0.3) + 0.32, ['peak', -1], (c, out, rng) => snare(c, out, 0, { ...o, rng })),
  clap: (o = {}) => spec(`clap|${js(o)}`, 1, 0.5, ['peak', -1], (c, out, rng) => clap(c, out, 0, { ...o, rng })),
  tom: (m, o = {}) => spec(`tom|${m}|${js(o)}`, 1, (o.decay ?? 0.55) + 0.1, ['peak', -1], (c, out, rng) => tom(c, out, 0, m, { ...o, rng })),
  taiko: (o = {}) => spec(`taiko|${js(o)}`, 1, (o.decay ?? 1) + 0.1, ['peak', -1], (c, out, rng) => taiko(c, out, 0, { ...o, rng })),
  hat: (o = {}) => spec(`hat|${js(o)}`, 1, (o.decay ?? 0.05) * 1.3 + 0.04, ['peak', -1], (c, out, rng) => hat(c, out, 0, { ...o, rng })),
  crash: (o = {}) => spec(`crash|${js(o)}`, 1, (o.decay ?? 2.2) + 0.1, ['peak', -1], (c, out, rng) => crash(c, out, 0, { ...o, rng })),
  revCrash: (o = {}) => spec(`revcrash|${js(o)}`, 1, (o.decay ?? 1.6) + 0.02, ['peak', -1], (c, out, rng) => crash(c, out, 0, { ...o, rng })),
  shaker: (o = {}) => spec(`shaker|${js(o)}`, 1, 0.16, ['peak', -1], (c, out, rng) => shaker(c, out, 0, { ...o, rng })),
  impact: (o = {}) => spec(`impact|${js(o)}`, 1, (o.decay ?? 1.8) + 0.2, ['peak', -1], (c, out, rng) => impact(c, out, 0, { ...o, rng })),
  riser: (dur, o = {}) => spec(`riser|${dur.toFixed(3)}|${js(o)}`, 2, dur + 0.06, ['peak', -1], (c, out, rng) => {
    const m = c.createChannelMerger(2);
    m.connect(out);
    const l = gainNode(c, 1), r = gainNode(c, 1);
    l.connect(m, 0, 0); r.connect(m, 0, 1);
    riser(c, l, 0, dur, { ...o, rng, saws: 0 });
    riser(c, r, 0, dur, { ...o, rng, saws: 0 });
    if (o.saws) riser(c, out, 0, dur, { ...o, rng, gain: 0 });
  }),
  scrape: (dur, o = {}) => spec(`scrape|${dur.toFixed(3)}|${js(o)}`, 2, dur + 0.1, ['peak', -1], (c, out, rng) => {
    const m = c.createChannelMerger(2);
    m.connect(out);
    [0, 1].forEach((side) => {
      const n = noise(c, 'white', 0, dur, rng);
      const sum = gainNode(c, 1);
      for (const f of [2900, 3800, 5200]) {
        const bp = biquad(c, 'bandpass', f * (side ? 1.03 : 0.97), o.q ?? 16);
        glide(bp.frequency, 0, f * (side ? 1.03 : 0.97), f * (o.to ?? 0.25), dur * 0.9);
        n.connect(bp); bp.connect(sum);
      }
      const g = c.createGain();
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.03); g.gain.setTargetAtTime(0, dur * 0.35, dur * 0.25);
      const ring = osc(c, 'sine', o.ring ?? 740, 0, dur);
      const rg = c.createGain(); perc(rg.gain, 0, 0.15, dur * 0.8, 0.02);
      glide(ring.frequency, 0, o.ring ?? 740, (o.ring ?? 740) * 0.7, dur * 0.8);
      ring.connect(rg); rg.connect(sum);
      sum.connect(g);
      g.connect(m, 0, side);
    });
  }),
};

// ------------------------------------------------------------------ sample bank
// One-shots are rendered here (OfflineAudioContext = main thread + audio threads) and handed to the
// DSP host (worker), which normalizes and keeps them for sequencing.
class Bank {
  constructor(pool, sr, budget, host) {
    this.pool = pool; this.sr = sr; this.budget = budget; this.host = host;
    this.specs = new Map(); this.done = new Set();
  }
  want([key, sp]) { if (!this.done.has(key) && !this.specs.has(key)) this.specs.set(key, sp); return key; }
  async renderPending() {
    const jobs = [...this.specs.entries()];
    this.specs.clear();
    await Promise.all(jobs.map(async ([key, sp]) => {
      let chs;
      try {
        const buf = await this.pool.run({
          sr: this.sr, ch: sp.ch, dur: sp.dur, label: key.slice(0, 14),
          build: (ctx, dest) => { const o = gainNode(ctx, 1); o.connect(dest); sp.build(ctx, o, makeRng(hashStr(key))); },
        });
        chs = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).slice());
      } catch (e) {
        chs = [new Float32Array(16)];
      }
      await this.host.call('bankPut', { key, chs, norm: sp.norm || null, reverse: !!sp.reverse, sr: this.sr });
      this.done.add(key);
      await this.budget.tick();
    }));
  }
}

// ------------------------------------------------------------------ arrangement context
class Arr {
  constructor(track, sec, bank) {
    this.track = track; this.sec = sec; this.bank = bank;
    this.beat = 60 / track.bpm; this.bar = this.beat * 4; this.step = this.beat / 4;
    this.events = [];
    this.pumpTimes = [];
    this.rng = makeRng(hashStr(`${track.id}:${sec.id}`));
  }
  t(bar, step = 0) { return bar * this.bar + step * this.step; }
  // env: { cut, rel } shortens a longer rendered note (JS release after `cut` seconds)
  add(stem, bus, ins, t, db = 0, pan = 0, pump = 0, env = null) {
    const key = this.bank.want(ins);
    this.events.push({ stem, bus, key, t, g: dbToGain(db), pan, pump, env });
  }
  // reversed one-shot that ENDS at time t
  addRev(stem, bus, ins, t, db = 0, pan = 0) {
    const [key0, sp] = ins;
    const key = `rev:${key0}`;
    if (!this.bank.done.has(key) && !this.bank.specs.has(key)) this.bank.specs.set(key, { ...sp, reverse: true });
    this.events.push({ stem, bus, key, t, g: dbToGain(db), pan, pump: 0, endAt: true });
  }
  hum(amount = 0.004) { return (this.rng() - 0.5) * 2 * amount; }
  vel(db, spread = 1.5) { return db + (this.rng() - 0.5) * 2 * spread; }
}

function emptyBuffer(ch, n, sr) {
  let b = null;
  try { b = new AudioBuffer({ numberOfChannels: ch, length: n, sampleRate: sr }); } catch (e) { b = null; }
  if (!b) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    b = new OAC(1, 128, sr).createBuffer(ch, n, sr);
  }
  return b;
}
function bufferOf(chs, sr) {
  const b = emptyBuffer(chs.length, chs[0].length, sr);
  for (let c = 0; c < chs.length; c++) { if (b.copyToChannel) b.copyToChannel(chs[c], c); else b.getChannelData(c).set(chs[c]); }
  return b;
}

// ------------------------------------------------------------------ mixdown (one context per stem timeline)
const irCache = new Map();
async function ensureIR(sr, ir, host) {
  const key = `${sr}|${js(ir)}`;
  if (irCache.has(key)) return;
  const chs = await host.call('ir', { sr, ir });
  irCache.set(key, bufferOf(chs, sr));
}
function irBuffer(ctx, ir) {
  const key = `${ctx.sampleRate}|${js(ir)}`;
  let b = irCache.get(key);
  if (!b) { b = bufferFrom(ctx, makeIR(ctx.sampleRate, ir), ctx.sampleRate); irCache.set(key, b); }
  return b;
}

function pingPong(ctx, time, fb, lp, out) {
  const input = ctx.createGain();
  input.channelCount = 1; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
  const dA = ctx.createDelay(2), dB = ctx.createDelay(2);
  dA.delayTime.value = time; dB.delayTime.value = time;
  const fA = biquad(ctx, 'lowpass', lp, 0.5), fB = biquad(ctx, 'lowpass', lp * 0.85, 0.5);
  const g = gainNode(ctx, fb);
  const m = ctx.createChannelMerger(2);
  chain(input, biquad(ctx, 'highpass', 280, 0.6), dA, fA);
  fA.connect(m, 0, 0);
  chain(fA, dB, fB);
  fB.connect(m, 0, 1);
  chain(fB, g, dA);
  m.connect(out);
  return input;
}

// Bus EQ -> sum, sends -> hall convolver / ping-pong delay, subsonic high-pass on the stem output.
function mixdownStem(track, stem, bs, n, pool) {
  return pool.run({
    sr: track.sr, ch: 2, dur: n / track.sr, label: `mix:${track.id}:${stem}`,
    build: (ctx, dest) => {
      const P = track.mix[stem] || {};
      const sum = gainNode(ctx, 1);
      // 24 dB/oct (Butterworth pair) subsonic high-pass: nothing useful lives below ~28 Hz
      const hpA = biquad(ctx, 'highpass', 28, 0.54), hpB = biquad(ctx, 'highpass', 28, 1.31);
      hpA.connect(hpB);
      hpB.connect(dest);
      if (P.filter) { // stem-level filter automation (e.g. the closing low-pass of the defeat cue)
        const f = biquad(ctx, 'lowpass', P.filter[0][1], 0.6);
        f.frequency.setValueAtTime(P.filter[0][1], 0);
        for (const [t, v] of P.filter) f.frequency.exponentialRampToValueAtTime(v, Math.max(0.001, t));
        sum.connect(f);
        f.connect(hpA);
      } else sum.connect(hpA);
      const revIn = gainNode(ctx, 1);
      const rev = ctx.createConvolver();
      rev.normalize = false;
      rev.buffer = irBuffer(ctx, track.ir);
      chain(revIn, biquad(ctx, 'highpass', P.revHp ?? 200, 0.6), rev, biquad(ctx, 'lowpass', P.revLp ?? 9000, 0.6), gainNode(ctx, P.revGain ?? 1), sum);
      let dlyIn = null;
      for (const name of Object.keys(bs)) {
        const B = (P.buses && P.buses[name]) || {};
        const src = ctx.createBufferSource();
        src.buffer = bs[name];
        src.start(0);
        let node = src;
        for (const [type, f, q, gdb] of B.eq || []) { const e = biquad(ctx, type, f, q ?? 0.7, gdb ?? 0); node.connect(e); node = e; }
        const bg = gainNode(ctx, dbToGain(B.gain ?? 0));
        node.connect(bg);
        bg.connect(sum);
        if (B.rev) { const s = gainNode(ctx, B.rev); bg.connect(s); s.connect(revIn); }
        if (B.dly) {
          if (!dlyIn) { const dOut = gainNode(ctx, 1); dOut.connect(sum); const ds = gainNode(ctx, P.dlyRev ?? 0.35); dOut.connect(ds); ds.connect(revIn); dlyIn = pingPong(ctx, track.delay, track.delayFb ?? 0.38, track.delayLp ?? 3800, dOut); }
          const s = gainNode(ctx, B.dly); bg.connect(s); s.connect(dlyIn);
        }
      }
    },
  });
}

// ------------------------------------------------------------------ track rendering
// host: DspHost (jobs.js). With `int16`, segments also come back as Int16 PCM for the cache.
export async function renderTrack(track, pool, budget, log, dsp, int16 = false) {
  const T0 = now();
  const sr = track.sr;
  const host = dsp.lane ? dsp.lane(track.id) : dsp; // the track's sample bank lives in one worker
  const bank = new Bank(pool, sr, budget, host);
  // 1) arrangement
  const arrs = [];
  for (const sec of track.sections) {
    const X = new Arr(track, sec, bank);
    track.arrange(X, sec);
    arrs.push(X);
    await budget.tick();
  }
  // 2) synthesize all distinct one-shots (and the hall impulse response)
  const nIns = bank.specs.size;
  await Promise.all([bank.renderPending(), ensureIR(sr, track.ir, host)]);
  const T1 = now();
  // 3+4) per stem (and part): the worker sequences all sections of the stem onto one timeline
  //    (each section followed by a tail-length gap), then ONE mixdown context renders it.
  const tailN = Math.round(track.tail * sr);
  const slot = arrs.map((X) => Math.round(X.sec.bars * X.bar * sr) + tailN);
  const raw = arrs.map(() => new Array(track.stems.length));
  const parts = Math.max(1, Math.min(arrs.length, track.parts || 1));
  const per = Math.ceil(arrs.length / parts);
  const jobs = [];
  for (let si = 0; si < track.stems.length; si++) for (let p = 0; p < parts; p++) {
    const ks = [];
    for (let k = p * per; k < Math.min(arrs.length, (p + 1) * per); k++) ks.push(k);
    if (ks.length) jobs.push({ si, ks });
  }
  let nextJob = 0;
  const worker = async () => {
    while (nextJob < jobs.length) {
      const { si, ks } = jobs[nextJob++];
      const stem = track.stems[si];
      const offs = {};
      let total = 0;
      for (const k of ks) { offs[k] = total; total += slot[k]; }
      const partList = ks.map((k) => ({
        off: offs[k], slot: slot[k], pumpTimes: arrs[k].pumpTimes, pumpRelease: track.pumpRelease ?? 0.16,
        events: arrs[k].events.filter((ev) => ev.stem === stem),
      }));
      const gain = track.stemDb && track.stemDb[stem] ? dbToGain(track.stemDb[stem]) : 1;
      const busArrays = await host.call('sequence', { sr, total, gain, parts: partList });
      const buses = {};
      for (const name of Object.keys(busArrays)) { buses[name] = bufferOf(busArrays[name], sr); await budget.tick(); }
      const out = Object.keys(buses).length ? await mixdownStem(track, stem, buses, total, pool) : null;
      for (const k of ks) {
        raw[k][si] = out ? [out.getChannelData(0).slice(offs[k], offs[k] + slot[k]), out.getChannelData(1).slice(offs[k], offs[k] + slot[k])]
          : [new Float32Array(slot[k]), new Float32Array(slot[k])];
        await budget.tick();
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  host.call('bankClear', {});
  const T2 = now();
  // 5+6) mastering in the worker: loudness pre-gain, glue compression + soft clip per stem, tail
  //    folding, linked limiter on the stem sum, storage-rate conversion
  const resampled = track.stems.some((st) => track.rates && track.rates[st] && track.rates[st] !== sr);
  const ceiling = (track.ceiling ?? -1.2) - (resampled ? 0.5 : 0);
  const stemsCfg = track.stems.map((st) => {
    const P = track.mix[st] || {};
    return { comp: P.comp || null, clip: P.clip ?? 0.8, rate: (track.rates && track.rates[st]) || sr };
  });
  const sections = arrs.map((X, k) => ({ lenN: Math.round(X.sec.bars * X.bar * sr), nofold: !!X.sec.nofold, stems: raw[k] }));
  const m = await host.call('master', { sr, target: track.target, ceiling, ov: Math.round(0.045 * sr), stems: stemsCfg, sections, int16 });
  const segments = track.sections.map((sec, k) => {
    const s = m.segments[k];
    const stems = {}, rates = {}, pcm = {};
    track.stems.forEach((st, si) => { stems[st] = s.stems[si]; rates[st] = s.rates[si]; if (s.pcm) pcm[st] = s.pcm[si]; });
    return { id: sec.id, bars: sec.bars, stems, rates, pcm: s.pcm ? pcm : null, nofold: !!sec.nofold };
  });
  const T3 = now();
  if (log) log({ track: track.id, instruments: nIns, loudness: m.loudness.map((x) => +(+x).toFixed(2)), ms: { bank: Math.round(T1 - T0), mix: Math.round(T2 - T1), master: Math.round(T3 - T2), total: Math.round(T3 - T0) } });
  return { id: track.id, bpm: track.bpm, sr, stems: track.stems, segments, next: track.next, first: track.first };
}

// ================================================================== shared presets
const PAD_B = { a: 0.07, d: 0.7, s: 0.85, r: 0.55, cut: 2300, cutPeak: 3600, spread: 17, hp: 140 };
const PAD_M = { a: 1.0, d: 1.2, s: 0.9, r: 1.6, cut: 1900, cutPeak: 2700, cutStart: 500, spread: 19, drift: 4, hp: 110 };
const STAB = { a: 0.004, d: 0.14, s: 0.3, r: 0.22, cut: 3400, cutPeak: 6500, cutStart: 1800, spread: 15, hp: 180 };
const ARP = { decay: 0.32, cut0: 5600, cut1: 820, fdecay: 0.11, q: 1.7, detune: 8 };
const MBELL = { ratio: 3.5, index: 2.6, decay: 3.0, idxDecay: 0.6, gain: 0.3, strike: 0.2 };
const KICK = [{ v: 1, p1: 50, decay: 0.38 }, { v: 2, p0: 160, p1: 52, decay: 0.34 }, { v: 3, p0: 145, p1: 48, decay: 0.42 }];
const BOOMK = { v: 9, p0: 120, p1: 42, pt: 0.07, decay: 0.9, click: 0.25, drive: 2.2 };
const SNARE = [{ v: 1 }, { v: 2, tone: 2400, f1: 230 }, { v: 3, tone: 2900, decay: 0.26 }];
const BIGSNARE = { v: 7, decay: 0.34, gate: 0.85, tone: 2100, f1: 210, body: 0.7 };
const HATC = [{ v: 1 }, { v: 2, tune: 1.03 }, { v: 3, tune: 0.97, decay: 0.04 }];
const HATO = { v: 1, decay: 0.32, gain: 0.55 };
const TOMS = { h: 52, m: 47, l: 42 };
const TAIKO = [{ v: 1 }, { v: 2, f: 58 }, { v: 3, f: 66, decay: 0.85 }];

// ================================================================== BATTLE / BUILD (122 BPM)
const BC = {
  Am: { r: 33, pad: [57, 60, 64, 69], arp: [57, 60, 64, 69, 72, 76], top: [69, 72] },
  F: { r: 29, pad: [57, 60, 65, 69], arp: [57, 60, 65, 69, 72, 77], top: [69, 72] },
  G: { r: 31, pad: [59, 62, 67, 71], arp: [55, 59, 62, 67, 71, 74], top: [67, 71] },
  E: { r: 28, pad: [56, 59, 64, 68], arp: [56, 59, 64, 68, 71, 76], top: [68, 71] },
  Bb: { r: 34, pad: [58, 62, 65, 70], arp: [58, 62, 65, 70, 74, 77], top: [70, 74] },
  Dm: { r: 38, pad: [57, 62, 65, 69], arp: [57, 62, 65, 69, 74, 77], top: [69, 74] },
};
const OST = {
  a: { n: [0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12], acc: [0, 3, 6, 8, 11, 14] },
  b: { n: [0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 7, 0], acc: [0, 3, 6, 10, 12] },
  c: { n: [0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12, 0], acc: [0, 3, 4, 8, 11, 12] },
  d: { n: [0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 7, 12], acc: [0, 4, 8, 12, 14] },
};
const ARPPAT = {
  up: [0, 1, 2, 3, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3, 2, 3],
  wave: [0, 2, 1, 3, 2, 4, 3, 5, 4, 3, 2, 4, 1, 3, 0, 2],
  gallop: [0, 3, 5, 3, 1, 3, 5, 3, 2, 4, 5, 4, 1, 4, 5, 4],
};

function bedBattle(X, sec) {
  const S = X.step;
  sec.chords.forEach((cn, b) => {
    const c = BC[cn], t0 = X.t(b);
    const pat = OST[sec.ost];
    for (let s = 0; s < 16; s++) {
      const acc = pat.acc.includes(s);
      X.add('bed', 'dry', INS.bass(c.r + pat.n[s], { accent: acc ? 1 : 0.25, len: acc ? 0.1 : 0.085, sub: 0.5 }), t0 + s * S, acc ? -5 : -8.5, 0, 0.3);
    }
    X.add('bed', 'dry', INS.sub(c.r, X.bar * 0.97, { a: 0.02, r: 0.2 }), t0, -15, 0, 0.6);
    for (const m of c.pad) X.add('bed', 'hall', INS.pad(m, X.bar * 0.97, PAD_B), t0, -7.5, 0, 0.6);
    for (let q = 0; q < 4; q++) X.pumpTimes.push(t0 + q * X.beat);
  });
}

function drumsBattle(X, style) {
  const S = X.step, r = X.rng;
  const K = (t, db) => X.add('drums', 'dry', INS.kick(KICK[r.int(3)]), t, X.vel(db - 1, 0.6));
  const SN = (t, db, big) => X.add('drums', 'dry', INS.snare(big ? BIGSNARE : SNARE[r.int(3)]), t + X.hum(0.002), X.vel(db, 0.8));
  const CL = (t, db) => X.add('drums', 'dry', INS.clap({ v: 1 + r.int(2) }), t + 0.004, X.vel(db, 1), 0.1);
  const HC = (t, db) => X.add('drums', 'dry', INS.hat(HATC[r.int(3)]), t + X.hum(0.003), X.vel(db, 1.5), 0.28);
  const HO = (t, db) => X.add('drums', 'dry', INS.hat(HATO), t, X.vel(db, 1), 0.32);
  const TM = (t, k, db) => X.add('drums', 'hall', INS.tom(TOMS[k], { v: r.int(2) }), t + X.hum(0.003), X.vel(db, 1), k === 'h' ? -0.45 : k === 'l' ? 0.45 : 0);
  const TK = (t, db, pan = 0) => X.add('drums', 'hall', INS.taiko(TAIKO[r.int(3)]), t + X.hum(0.004), X.vel(db, 1), pan);
  const CR = (t, db) => X.add('drums', 'hall', INS.crash({ v: 1 }), t, db, -0.2);
  const REV = (db) => X.addRev('drums', 'hall', INS.revCrash({ v: 2, decay: 1.6 }), X.t(4), db, 0.2);
  const SH = (t, db) => X.add('drums', 'dry', INS.shaker({ v: 1 }), t + X.hum(0.003), X.vel(db, 1.5), -0.3);
  for (let b = 0; b < 4; b++) {
    const t0 = X.t(b), fill = b === 3;
    if (style === 'drive' || style === 'drive2') {
      for (const s of [0, 4, 8, 12]) K(t0 + s * S, -1.5);
      if (fill) K(t0 + 10 * S, -5);
      SN(t0 + 4 * S, -2.5); SN(t0 + 12 * S, -2.5);
      CL(t0 + 4 * S, -11); CL(t0 + 12 * S, -11);
      for (let s = 0; s < (fill ? 8 : 16); s++) if (s % 4 !== 2) HC(t0 + s * S, s % 4 === 0 ? -14 : s % 2 ? -20 : -16);
      for (const s of [2, 6, 10, 14]) if (!fill || s < 8) HO(t0 + s * S, -16);
      if (style === 'drive2') { TK(t0, -8, -0.3); TK(t0 + 10 * S, -10, 0.3); if (!fill) { TM(t0 + 7 * S, 'l', -11); TM(t0 + 15 * S, 'm', -12); } }
      if (fill) {
        [['h', -8], ['h', -7], ['m', -6.5], ['m', -6], ['l', -5], ['l', -4.5], ['l', -4], ['l', -3.5]].forEach(([k, db], i) => TM(t0 + (8 + i) * S, k, db));
        if (style === 'drive2') REV(-9);
      }
    } else if (style === 'trailer') {
      K(t0, -1);
      X.add('drums', 'dry', INS.kick(BOOMK), t0, b === 0 ? -5 : -9);
      K(t0 + 7 * S, -5); K(t0 + 10 * S, -4);
      SN(t0 + 8 * S, -2.5, true);
      for (const [s, k, db] of [[0, 'l', -7], [3, 'm', -10], [6, 'l', -9], [11, 'm', -10], [14, 'l', -9]]) {
        if (fill && s >= 8) continue;
        TM(t0 + s * S, k, db);
        TM(t0 + s * S + 0.011, k, db - 3);
      }
      for (let s = 0; s < 16; s += 2) HC(t0 + s * S, s % 4 === 0 ? -16 : -19);
      for (let s = 0; s < 16; s++) SH(t0 + s * S, s % 2 ? -24 : -21);
      if (fill) { for (let i = 0; i < 8; i++) TK(t0 + (8 + i) * S, -13 + i * 1.3, (i % 2 ? 0.3 : -0.3)); REV(-8); }
    } else { // pulse
      for (const s of [0, 4, 8, 12]) K(t0 + s * S, -1.5);
      if (b % 2 === 1) K(t0 + 14 * S, -7);
      SN(t0 + 4 * S, -4); SN(t0 + 12 * S, -4);
      CL(t0 + 4 * S, -9); CL(t0 + 12 * S, -9);
      for (let s = 0; s < (fill ? 8 : 16); s++) { if (s === 6 || s === 14) continue; HC(t0 + s * S, s % 4 === 0 ? -15 : s % 2 ? -21 : -17); SH(t0 + s * S, -25); }
      if (!fill) { HO(t0 + 6 * S, -15); HO(t0 + 14 * S, -15); }
      if (b === 1) { TM(t0 + 13 * S, 'm', -9); TM(t0 + 14 * S, 'm', -8); TM(t0 + 15 * S, 'l', -7); }
      if (fill) { for (let i = 0; i < 8; i++) SN(t0 + (8 + i) * S, -16 + i * 1.6); REV(-9); }
    }
    if (b === 0) CR(t0, -8);
  }
}

function heatBattle(X, sec) {
  const S = X.step;
  const kind = sec.heat;
  sec.chords.forEach((cn, b) => {
    const c = BC[cn], t0 = X.t(b);
    // arpeggio (A, C lower, D)
    if (kind === 'arpA' || kind === 'leadC' || kind === 'stabsD' || (kind === 'stabsB' && b >= 2)) {
      const pat = ARPPAT[sec.arp || 'up'];
      const oct = kind === 'leadC' ? -12 : 0;
      for (let s = 0; s < 16; s++) {
        const m = c.arp[pat[s] % c.arp.length] + oct;
        X.add('heat', 'delay', INS.pluck(m, ARP), t0 + s * S, s % 4 === 0 ? -11 : -14, s % 2 ? 0.3 : -0.3);
      }
    }
    // offbeat supersaw stabs (B, D)
    if (kind === 'stabsB' || kind === 'stabsD') {
      for (const s of [2, 5, 10, 13]) for (const m of c.pad) X.add('heat', 'hall', INS.pad(m + 12, 0.16, STAB), t0 + s * S, -13.5, 0, 0.3);
    }
    // choir
    const vowel = kind === 'arpA' ? 'u' : 'a';
    for (const m of c.top) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel, a: 0.35, r: 0.9, vib: 14 }), t0, kind === 'arpA' ? -12 : -10.5, 0, 0.3);
  });
  // braams
  const braamBars = kind === 'arpA' ? [0, 2] : kind === 'leadC' ? [0, 2] : [0, 1, 3];
  for (const b of braamBars) {
    const c = BC[sec.chords[b]];
    X.add('heat', 'hall', INS.braam(c.r + 12, X.bar * 0.8, { a: 0.07, cutPeak: 2700, cutEnd: 560, r: 1.1 }), X.t(b), b === 0 ? -7 : -9.5, 0, 0.2);
  }
  // heroic lead (C)
  if (kind === 'leadC') {
    const mel = [[0, 72, 8], [8, 69, 4], [12, 72, 4], [16, 74, 8], [24, 71, 4], [28, 74, 4], [32, 76, 8], [40, 68, 4], [44, 71, 4], [48, 72, 4], [52, 71, 4], [56, 69, 8]];
    let prev = null;
    for (const [st, m, len] of mel) {
      X.add('heat', 'delay', INS.lead(m, len * S * 0.96, { from: prev, glide: 0.06, cut: 3600, vib: 16, a: 0.025, r: 0.35, gain: 0.3 }), st * S, -8, 0);
      prev = m;
    }
  }
  if (kind === 'stabsD') X.add('heat', 'hall', INS.riser(X.bar, { f0: 400, f1: 7500, q0: 0.8, q1: 3, gain: 0.5, saws: 0.25, note: 57 }), X.t(3), -12);
}

// ================================================================== BOSS (122 BPM)
const XC = {
  Am: { r: 33, pad: [45, 52, 57, 60], ch: [57, 60] },
  Bb: { r: 34, pad: [46, 53, 58, 62], ch: [58, 62] },
  F: { r: 29, pad: [45, 53, 57, 60], ch: [57, 60] },
  E: { r: 28, pad: [44, 52, 56, 59], ch: [56, 59] },
  Dm: { r: 38, pad: [45, 50, 57, 62], ch: [57, 62] },
  G: { r: 31, pad: [43, 50, 55, 59], ch: [55, 59] },
};
const PAD_X = { a: 0.08, d: 0.8, s: 0.85, r: 0.6, cut: 1300, cutPeak: 2200, spread: 20, hp: 90 };

function bossSection(X, sec) {
  const S = X.step, r = X.rng;
  sec.chords.forEach((cn, b) => {
    const c = XC[cn], t0 = X.t(b), fill = b === 3;
    // base: distorted ostinato, sub, dark pad
    for (let s = 0; s < 16; s++) {
      const acc = [0, 3, 6, 8, 11, 14].includes(s);
      const m = c.r + (s === 7 || s === 15 ? 12 : 0);
      X.add('base', 'dry', INS.bass(m, { accent: acc ? 1 : 0.35, len: acc ? 0.1 : 0.08, drive: 3.4, cut: 460, accCut: 1900, q: 6, sub: 0.5 }), t0 + s * S, acc ? -4.5 : -7.5, 0, 0.3);
    }
    X.add('base', 'dry', INS.sub(c.r, X.bar * 0.97, { a: 0.02, r: 0.2, drive: 1.6 }), t0, -14, 0, 0.6);
    for (const m of c.pad) X.add('base', 'hall', INS.pad(m, X.bar * 0.97, PAD_X), t0, -9.5, 0, 0.55);
    for (let q = 0; q < 4; q++) X.pumpTimes.push(t0 + q * X.beat);
    // drums
    for (const s of [0, 6, 8, 14]) X.add('base', 'dry', INS.kick(KICK[r.int(3)]), t0 + s * S, s === 0 ? -1 : -3.5);
    if (b === 0 || b === 2) X.add('base', 'dry', INS.kick(BOOMK), t0, -5);
    X.add('base', 'dry', INS.snare(BIGSNARE), t0 + 8 * S, -2.5);
    for (let s = 0; s < 16; s += 2) {
      if (fill && s >= 8) break;
      X.add('base', 'hall', INS.taiko(TAIKO[r.int(3)]), t0 + s * S + X.hum(0.004), X.vel(s % 8 === 0 ? -5 : -10, 1), s % 4 ? 0.35 : -0.35);
    }
    for (let s = 0; s < 16; s++) X.add('base', 'dry', INS.hat(HATC[r.int(3)]), t0 + s * S + X.hum(0.003), X.vel(s % 4 === 0 ? -17 : -22, 1.5), 0.3);
    if (fill) for (let i = 0; i < 8; i++) X.add('base', 'hall', INS.tom(TOMS[i < 3 ? 'h' : i < 6 ? 'm' : 'l'], { v: i % 2 }), t0 + (8 + i) * S, -9 + i * 0.8, i < 3 ? -0.4 : i < 6 ? 0 : 0.4);
    if (b === 0) X.add('base', 'hall', INS.crash({ v: 1 }), t0, -8, -0.2);
    // heat: braams, choir, alarm
    const braamLen = sec.id === 'Z' ? X.bar * 0.5 : X.bar * 0.85;
    if (sec.id !== 'Y' || b < 2) X.add('heat', 'hall', INS.braam(c.r + 12, braamLen, { a: 0.05, drive: 3.2, cutPeak: 3000, cutEnd: 600, r: 1.0, rasp: 0.3 }), t0, b % 2 ? -8 : -6, 0, 0.15);
    for (const m of c.ch) X.add('heat', 'hall', INS.choir(m, X.bar * 0.95, { vowel: 'a', a: 0.25, r: 0.8, vib: 18 }), t0, -10, 0, 0.25);
  });
  // alarm motif
  const al = sec.id === 'X' ? [[0, 76], [8, 77], [16, 76], [24, 77], [32, 76], [40, 77], [48, 76], [56, 77]]
    : sec.id === 'Y' ? [[0, 77], [8, 76], [16, 77], [24, 76], [32, 77], [40, 76], [48, 80], [56, 76]]
      : [[0, 81], [16, 79], [32, 77], [48, 76]];
  const len = sec.id === 'Z' ? 16 : 8;
  let prev = null;
  for (const [st, m] of al) {
    X.add('heat', 'delay', INS.lead(m, len * S * 0.95, { from: prev, glide: 0.05, sq: 0.35, cut: 3200, vib: 28, vibHz: 6.4, vibDelay: 0.08, a: 0.02, r: 0.3 }), st * S, -12, 0);
    prev = m;
  }
  if (sec.id === 'X') X.add('heat', 'hall', INS.scrape(1.6, { ring: 700 }), X.t(3), -10);
  if (sec.id === 'Y') X.add('heat', 'hall', INS.riser(X.bar, { f0: 300, f1: 6000, gain: 0.5, saws: 0.3, note: 57 }), X.t(3), -11);
}

// ================================================================== MENU "Neon Horizon" (84 BPM)
const MC = {
  Am9: { r: 33, pad: [57, 60, 64, 67, 71], arp: [64, 67, 69, 71, 72, 76], ch: [64, 69] },
  Fmaj7: { r: 29, pad: [53, 57, 60, 64], arp: [60, 64, 65, 69, 72, 76], ch: [60, 65] },
  Cadd9: { r: 36, pad: [55, 60, 62, 64], arp: [60, 62, 64, 67, 72, 74], ch: [60, 64] },
  G6b: { r: 35, pad: [55, 59, 62, 64], arp: [59, 62, 64, 67, 71, 74], ch: [59, 62] },
  Dm9: { r: 38, pad: [53, 57, 60, 64], arp: [57, 60, 62, 64, 65, 69], ch: [57, 62] },
  Dm6: { r: 38, pad: [53, 57, 59, 62], arp: [57, 59, 62, 65, 69, 71], ch: [57, 62] },
  E7s4: { r: 28, pad: [57, 59, 62, 64], arp: [59, 62, 64, 69, 71, 76], ch: [59, 64] },
  E7: { r: 28, pad: [56, 59, 62, 64], arp: [56, 59, 62, 64, 68, 71], ch: [59, 64] },
  Em7: { r: 28, pad: [55, 59, 62, 64], arp: [59, 62, 64, 67, 71, 74], ch: [59, 67] },
  G6: { r: 31, pad: [55, 59, 62, 64], arp: [59, 62, 64, 67, 71, 74], ch: [62, 67] },
};
const MLEAD = {
  A: [[0, 76, 8], [8, 79, 4], [12, 76, 4], [16, 81, 12], [28, 79, 4], [32, 76, 8], [40, 74, 4], [44, 72, 4], [48, 74, 16]],
  B: [[0, 77, 8], [8, 76, 4], [12, 74, 4], [16, 71, 8], [24, 74, 8], [32, 72, 8], [40, 76, 4], [44, 81, 4], [48, 81, 8], [56, 80, 8]],
  C: [[0, 81, 8], [8, 84, 8], [16, 83, 12], [28, 86, 4], [32, 83, 8], [40, 79, 4], [44, 76, 4], [48, 81, 16]],
};
const MBELLS = {
  I: [[0, 76], [6, 83], [10, 81], [16, 79], [24, 76], [32, 77], [38, 84], [42, 81], [48, 79], [56, 76], [60, 72]],
  B: [[26, 81], [28, 83], [30, 86], [58, 83], [60, 81], [62, 80]],
};

function menuSection(X, sec) {
  const S = X.step, id = sec.id, r = X.rng;
  const big = id === 'C';
  for (const [cn, b0, bl] of sec.chords) {
    const c = MC[cn], t0 = X.t(b0), len = bl * X.bar;
    // one rendered pad note per pitch (1 bar); shorter chords use a JS release. The intro
    // sustains 2-bar chords with a slower swell.
    const intro = id === 'I';
    const padLen = intro ? 2 * X.bar * 0.98 : X.bar * 0.98;
    const padO = intro ? { ...PAD_M, a: 2.2, cut: 1300 } : PAD_M;
    const cut = len * 0.98 < padLen - 0.01 ? { cut: len * 0.98, rel: 1.2 } : null;
    for (const m of c.pad) X.add('mix', 'hall', INS.pad(m, padLen, padO), t0, big ? -8 : -9, 0, 0.18, cut);
    X.add('mix', 'dry', INS.sub(c.r, len * 0.97, { a: intro ? 1.4 : 0.25, r: 0.8 }), t0, intro ? -16 : -16, 0, 0.1);
    // choir
    if (!intro) {
      const vowel = id === 'A' ? 'u' : 'a';
      const ccut = len < X.bar * 0.9 ? { cut: len * 0.95, rel: 1.0 } : null;
      for (const m of c.ch) X.add('mix', 'hall', INS.choir(m, X.bar * 0.95, { vowel, a: 0.8, r: 1.3 }), t0, big ? -9.5 : -11.5, 0, 0.1, ccut);
      if (big) X.add('mix', 'hall', INS.choir(c.ch[1] + 12, X.bar * 0.95, { vowel: 'a', a: 0.6, r: 1.3 }), t0, -13, 0, 0.1);
    }
    // pulse bass (8ths) in A and C, quarter pulses in B
    if (id === 'A' || big || id === 'B') {
      const every = id === 'B' ? 4 : 2;
      for (let s = 0; s < bl * 16; s += every) X.add('mix', 'dry', INS.bass(c.r + 12, { cut: 260, accCut: 520, accent: s % 8 === 0 ? 1 : 0.3, len: 0.2, q: 2.5, drive: 1.3, sub: 0.3 }), t0 + s * S, s % 8 === 0 ? -11 : -14, 0, 0.3);
    }
    // arps (A, C)
    if (id === 'A' || big) {
      const pat = ARPPAT.wave;
      for (let s = 0; s < bl * 16; s++) X.add('mix', 'delay', INS.bell(c.arp[pat[s % 16] % 6] + 12, { ratio: 2, index: 1.6, decay: 0.6, idxDecay: 0.2, gain: 0.3, strike: 0.1 }), t0 + s * S, big ? -21 : -23, s % 2 ? 0.35 : -0.35);
    }
  }
  // bells
  const bells = MBELLS[id] || (big ? null : null);
  if (bells) for (const [st, m] of bells) X.add('mix', 'delay', INS.bell(m, MBELL), st * S, -12, (r() - 0.5) * 0.6);
  if (big) for (let b = 0; b < 4; b++) X.add('mix', 'delay', INS.bell(88, MBELL), X.t(b), -18, 0.3);
  // lead melody
  const mel = MLEAD[id];
  if (mel) {
    let prev = null, prevEnd = -1;
    for (const [st, m, len] of mel) {
      X.add('mix', 'delay', INS.lead(m, len * S * 0.97, { from: prevEnd === st ? prev : null, glide: 0.09, a: 0.07, r: 0.8, cut: big ? 3200 : 2600, fa: 0.25, vib: 17, vibDelay: 0.3, q: 1.8, gain: 0.3 }), st * S, big ? -7 : -8.5, 0);
      prev = m; prevEnd = st + len;
    }
  }
  // percussion
  for (let b = 0; b < 4; b++) {
    const t0 = X.t(b);
    for (const s of [0, 8]) X.add('mix', 'hall', INS.taiko({ v: 5, f: 58, decay: 0.9, skin: 0.35, slap: 0.18 }), t0 + s * S, id === 'I' ? -15 : big ? -8 : -12, 0);
    X.pumpTimes.push(t0, t0 + 8 * S);
    if (id === 'A' || big) for (let s = 0; s < 16; s += 2) X.add('mix', 'dry', INS.shaker({ v: 2, tone: 7000 }), t0 + s * S + X.hum(0.004), X.vel(s % 4 ? -26 : -23, 1.5), 0.35);
    if (big) {
      for (const [s, db] of [[3, -12], [6, -9], [11, -12], [14, -10]]) X.add('mix', 'hall', INS.taiko(TAIKO[r.int(3)]), t0 + s * S + X.hum(0.004), X.vel(db, 1), s % 2 ? 0.35 : -0.35);
      X.add('mix', 'dry', INS.snare(BIGSNARE), t0 + 8 * S, -8);
      X.add('mix', 'dry', INS.kick(BOOMK), t0, -9);
    }
  }
  if (big) {
    X.add('mix', 'hall', INS.impact({ v: 1, decay: 2.2 }), 0, -5);
    X.add('mix', 'hall', INS.crash({ v: 3, decay: 3 }), 0, -9, -0.2);
    X.add('mix', 'hall', INS.braam(41, X.bar * 1.2, { a: 0.18, cutPeak: 2300, cutEnd: 600, r: 2.2, drive: 2.2 }), 0, -7);
    X.add('mix', 'hall', INS.braam(40, X.bar * 0.9, { a: 0.18, cutPeak: 2000, cutEnd: 500, r: 2.2, drive: 2.2 }), X.t(2), -10);
    for (let i = 0; i < 6; i++) X.add('mix', 'hall', INS.tom(TOMS[i < 2 ? 'h' : i < 4 ? 'm' : 'l'], { v: 5, decay: 0.8 }), X.t(3, 10 + i), -12 + i, i < 2 ? -0.4 : i < 4 ? 0 : 0.4);
  }
  if (id === 'B') {
    X.add('mix', 'hall', INS.braam(38, X.bar * 1.1, { a: 0.35, cutPeak: 1500, cutEnd: 450, r: 2.2, drive: 2.0 }), 0, -12);
    for (let i = 0; i < 8; i++) X.add('mix', 'hall', INS.tom(TOMS[i < 3 ? 'l' : i < 6 ? 'm' : 'h'], { v: 6, decay: 0.8 }), X.t(3, 8 + i), -18 + i * 1.2, (i % 2 ? 0.35 : -0.35));
    X.add('mix', 'hall', INS.riser(X.bar * 2, { f0: 250, f1: 7000, q0: 0.7, q1: 3, gain: 0.5, saws: 0.3, note: 57, rise: 1200 }), X.t(2), -13);
    X.addRev('mix', 'hall', INS.revCrash({ v: 4, decay: 2.2 }), X.t(4), -10, 0.2);
  }
  if (id === 'I') X.addRev('mix', 'hall', INS.revCrash({ v: 5, decay: 2.4 }), X.t(4), -13, -0.2);
}

// ================================================================== track table
export const TRACKS = {
  menu: {
    id: 'menu', bpm: 84, sr: 32000, tail: 2.8, stems: ['mix'], parts: 2, ceiling: -1.3, target: -17, first: 'I',
    ir: { len: 3.8, rt60: 3.4, pre: 0.03, hf0: 8500, hf1: 1300, width: 0.1, seed: 11 },
    delay: (60 / 84) * 0.75, delayFb: 0.45, delayLp: 3600, pumpRelease: 0.35,
    mix: {
      mix: {
        comp: { thr: -13, ratio: 1.8, attack: 0.03, release: 0.3, knee: 8 }, clip: 0.85, revHp: 180, revLp: 8000,
        buses: { dry: { eq: [['highpass', 26, 0.7]], rev: 0.06 }, hall: { eq: [['highpass', 60, 0.6], ['peaking', 320, 1, -2]], rev: 0.42 }, delay: { eq: [['highpass', 200, 0.6]], rev: 0.35, dly: 0.55 } },
      },
    },
    sections: [
      { id: 'I', bars: 4, nofold: true, chords: [['Am9', 0, 2], ['Fmaj7', 2, 2]] },
      { id: 'A', bars: 4, chords: [['Am9', 0, 1], ['Fmaj7', 1, 1], ['Cadd9', 2, 1], ['G6b', 3, 1]] },
      { id: 'B', bars: 4, chords: [['Dm9', 0, 1], ['Dm6', 1, 1], ['Fmaj7', 2, 1], ['E7s4', 3, 0.5], ['E7', 3.5, 0.5]] },
      { id: 'C', bars: 4, chords: [['Fmaj7', 0, 1], ['G6', 1, 1], ['Em7', 2, 1], ['Am9', 3, 1]] },
    ],
    next: { I: { A: 1 }, A: { B: 0.65, C: 0.35 }, B: { C: 0.75, A: 0.25 }, C: { A: 0.6, B: 0.4 } },
    arrange: menuSection,
  },
  battle: {
    id: 'battle', bpm: 122, sr: 32000, tail: 1.8, stems: ['bed', 'drums', 'heat'], rates: { bed: 24000, heat: 24000 }, stemDb: { heat: 8 }, target: -15, first: 'A',
    ir: { len: 2.6, rt60: 2.2, pre: 0.02, hf0: 9000, hf1: 1700, width: 0.12, seed: 21 },
    delay: (60 / 122) * 0.75, delayFb: 0.36, delayLp: 4200,
    mix: {
      bed: { comp: { thr: -13, ratio: 2, attack: 0.02, release: 0.2, knee: 6 }, clip: 0.8, revHp: 220,
        buses: { dry: { eq: [['highpass', 28, 0.7], ['peaking', 110, 0.9, 1.5]], rev: 0.03 }, hall: { eq: [['peaking', 380, 1, -2.5], ['highshelf', 7000, 0.7, 2]], rev: 0.3 } } },
      drums: { comp: { thr: -10, ratio: 2.5, attack: 0.008, release: 0.12, knee: 4 }, clip: 0.8,
        buses: { dry: { eq: [['highpass', 30, 0.7], ['highshelf', 6500, 0.7, -3.5]], rev: 0.1 }, hall: { eq: [['highpass', 45, 0.7], ['highshelf', 6000, 0.7, -3]], rev: 0.32 } } },
      heat: { comp: { thr: -12, ratio: 2, attack: 0.015, release: 0.18, knee: 6 }, clip: 0.8,
        buses: { hall: { eq: [['highpass', 70, 0.6], ['peaking', 400, 1, -2], ['highshelf', 7000, 0.7, -2]], rev: 0.36 }, delay: { eq: [['highpass', 220, 0.6], ['highshelf', 6000, 0.7, -2.5]], rev: 0.2, dly: 0.42 } } },
    },
    sections: [
      { id: 'A', bars: 4, chords: ['Am', 'Am', 'F', 'G'], ost: 'a', drums: 'drive', heat: 'arpA', arp: 'up' },
      { id: 'B', bars: 4, chords: ['Am', 'Bb', 'Am', 'E'], ost: 'b', drums: 'trailer', heat: 'stabsB', arp: 'gallop' },
      { id: 'C', bars: 4, chords: ['F', 'G', 'E', 'Am'], ost: 'c', drums: 'pulse', heat: 'leadC', arp: 'wave' },
      { id: 'D', bars: 4, chords: ['Dm', 'Bb', 'F', 'E'], ost: 'd', drums: 'drive2', heat: 'stabsD', arp: 'gallop' },
    ],
    next: { A: { B: 0.4, C: 0.35, D: 0.25 }, B: { A: 0.35, C: 0.4, D: 0.25 }, C: { A: 0.4, B: 0.3, D: 0.3 }, D: { A: 0.6, B: 0.2, C: 0.2 } },
    arrange: (X, sec) => { bedBattle(X, sec); drumsBattle(X, sec.drums); heatBattle(X, sec); },
  },
  boss: {
    id: 'boss', bpm: 122, sr: 32000, tail: 2.0, stems: ['base', 'heat'], parts: 2, rates: { heat: 24000 }, stemDb: { heat: 8 }, target: -14.5, first: 'X',
    ir: { len: 2.8, rt60: 2.5, pre: 0.02, hf0: 7000, hf1: 1200, width: 0.12, seed: 31 },
    delay: (60 / 122) * 0.75, delayFb: 0.33, delayLp: 3600,
    mix: {
      base: { comp: { thr: -11, ratio: 2.5, attack: 0.008, release: 0.12, knee: 4 }, clip: 0.8, revHp: 200,
        buses: { dry: { eq: [['highpass', 28, 0.7], ['peaking', 100, 0.9, 1.5], ['highshelf', 6500, 0.7, -3]], rev: 0.06 }, hall: { eq: [['highpass', 40, 0.7], ['peaking', 350, 1, -2], ['highshelf', 6000, 0.7, -2]], rev: 0.3 } } },
      heat: { comp: { thr: -12, ratio: 2, attack: 0.015, release: 0.2, knee: 6 }, clip: 0.8,
        buses: { hall: { eq: [['highpass', 60, 0.6], ['peaking', 420, 1, -2]], rev: 0.38 }, delay: { eq: [['highpass', 250, 0.6]], rev: 0.25, dly: 0.35 } } },
    },
    sections: [
      { id: 'X', bars: 4, chords: ['Am', 'Bb', 'Am', 'Bb'] },
      { id: 'Y', bars: 4, chords: ['F', 'E', 'Dm', 'E'] },
      { id: 'Z', bars: 4, chords: ['Am', 'G', 'F', 'E'] },
    ],
    next: { X: { Y: 0.5, Z: 0.5 }, Y: { X: 0.6, Z: 0.4 }, Z: { X: 0.7, Y: 0.3 } },
    arrange: bossSection,
  },
};

// ================================================================== STINGERS (one-shot cues)
function stingerArr(name) {
  return (X) => {
    const add = (bus, ins, t, db, pan = 0) => X.add('mix', bus, ins, t, db, pan);
    if (name === 'victory') {
      const H = 0.86;
      [[0, [53, 57, 60, 65]], [0.43, [55, 59, 62, 67]]].forEach(([t, ch]) => {
        for (const m of ch) add('hall', INS.pad(m, 0.36, { ...STAB, r: 0.35, cut: 3000, cutPeak: 5500 }), t, -8);
        add('hall', INS.tom(TOMS.l, { v: 8 }), t, -7);
      });
      add('hall', INS.riser(H, { f0: 500, f1: 8000, gain: 0.5, saws: 0.2, note: 57 }), 0, -11);
      X.addRev('mix', 'hall', INS.revCrash({ v: 7, decay: 1.2 }), H, -9);
      add('hall', INS.impact({ v: 3, decay: 2.4 }), H, -2);
      add('dry', INS.kick(BOOMK), H, -6);
      add('hall', INS.crash({ v: 6, decay: 3.2 }), H, -8, -0.2);
      for (const m of [57, 61, 64, 69, 73]) add('hall', INS.pad(m, 4.0, { a: 0.05, d: 1.5, s: 0.8, r: 2.2, cut: 3000, cutPeak: 5200, spread: 18, voices: 7 }), H, -8);
      add('hall', INS.braam(45, 1.6, { a: 0.05, layers: [[0, 1, 0], [12, 0.8, 0.45], [16, 0.5, -0.45], [19, 0.35, 0.6]], drive: 1.8, cutPeak: 3400, cutEnd: 900, r: 1.8, rasp: 0.1 }), H, -9);
      for (const m of [69, 73, 76]) add('hall', INS.choir(m, 3.6, { vowel: 'a', a: 0.35, r: 2.0 }), H, -8);
      add('dry', INS.sub(33, 3.8, { a: 0.02, r: 1.5 }), H, -14);
      [81, 85, 88, 93, 97, 100].forEach((m, i) => add('delay', INS.bell(m, MBELL), H + 0.08 + i * 0.09, -12, i % 2 ? 0.4 : -0.4));
      for (let i = 0; i < 6; i++) add('hall', INS.taiko(TAIKO[i % 3]), H + 2.6 + i * 0.07, -18 + i * 1.5, i % 2 ? 0.3 : -0.3);
      add('hall', INS.taiko({ v: 4, f: 55, decay: 1.6 }), H + 3.05, -6);
    } else if (name === 'defeat') {
      add('hall', INS.impact({ v: 4, p0: 70, p1: 26, decay: 2.8 }), 0, -2);
      add('hall', INS.braam(33, 1.3, { a: 0.06, cutPeak: 2000, cutEnd: 420, r: 1.8, drive: 2.8 }), 0, -5);
      add('hall', INS.braam(29, 1.3, { a: 0.1, cutPeak: 1500, cutEnd: 380, r: 1.8, drive: 2.6 }), 1.4, -6);
      add('hall', INS.braam(26, 2.6, { a: 0.15, cutPeak: 1000, cutEnd: 300, r: 2.4, drive: 2.4 }), 2.8, -6);
      [[69, 0, 1.4], [67, 1.4, 1.4], [65, 2.8, 1.4], [64, 4.2, 2.2]].forEach(([m, t, l]) => add('hall', INS.pad(m, l, { a: 0.3, d: 1, s: 0.85, r: 1.5, cut: 1500, spread: 16 }), t, -11));
      for (const m of [57, 60, 64]) add('hall', INS.choir(m, 5.5, { vowel: 'o', a: 1.0, r: 2.0 }), 0.2, -12);
      add('dry', INS.sub(33, 6.0, { a: 0.3, r: 1.2 }), 0, -15);
      add('hall', INS.taiko({ v: 6, f: 48, decay: 2.0 }), 4.2, -5);
    } else if (name === 'wave') {
      const H = 1.0;
      X.addRev('mix', 'hall', INS.revCrash({ v: 8, decay: 1.1 }), H, -10);
      add('hall', INS.riser(H, { f0: 700, f1: 9000, gain: 0.5, saws: 0.25, note: 57, rise: 700 }), 0, -14);
      for (const m of [57, 64]) X.addRev('mix', 'hall', INS.choir(m, 0.9, { vowel: 'a', a: 0.05, r: 0.3 }), H, -16);
      add('hall', INS.impact({ v: 5, decay: 1.6 }), H, -2);
      add('dry', INS.kick(BOOMK), H, -6);
      add('hall', INS.braam(45, 0.6, { a: 0.03, cutPeak: 3200, cutEnd: 700, r: 1.0, drive: 2.8 }), H, -6);
      add('hall', INS.taiko({ v: 7 }), H, -5);
      add('hall', INS.crash({ v: 9, decay: 1.4 }), H, -10, 0.2);
    } else if (name === 'bossIntro') {
      const H = 0.35;
      add('hall', INS.riser(H, { f0: 1500, f1: 9000, gain: 0.5, note: 57 }), 0, -10);
      add('hall', INS.braam(33, 1.5, { a: 0.03, drive: 3.4, cutPeak: 3300, cutEnd: 600, r: 1.8, rasp: 0.32 }), H, -3);
      add('hall', INS.braam(34, 1.5, { a: 0.03, drive: 3.4, cutPeak: 2600, cutEnd: 500, r: 1.8, layers: [[0, 1, -0.5], [12, 0.7, 0.5]] }), H, -8);
      add('hall', INS.impact({ v: 6, p0: 105, p1: 24, pt: 0.35, decay: 2.6, metal: 0.35 }), H, -2);
      add('hall', INS.scrape(1.8, { ring: 820, to: 0.22 }), H, -8);
      add('hall', INS.taiko({ v: 8, f: 55, decay: 1.3 }), H, -5);
      add('hall', INS.crash({ v: 10, decay: 2.6 }), H, -10, -0.2);
    }
  };
}

export const STINGERS = {
  victory: { dur: 7.2, hit: 0.86, target: -15, filter: null },
  defeat: { dur: 6.6, hit: 0.0, target: -16, rate: 24000, filter: [[0, 12000], [1.2, 9000], [6.5, 600]] },
  wave: { dur: 2.7, hit: 1.0, target: -15, filter: null },
  bossIntro: { dur: 4.4, hit: 0.35, target: -14, filter: null },
};

export async function renderStinger(name, pool, budget, log, host, int16 = false) {
  const st = STINGERS[name];
  const track = {
    id: `stinger:${name}`, bpm: 120, sr: 32000, tail: 0, stems: ['mix'], target: st.target, ceiling: -1, rates: st.rate ? { mix: st.rate } : null,
    ir: { len: 4.0, rt60: 3.5, pre: 0.03, hf0: 8000, hf1: 1500, width: 0.1, seed: 41 },
    delay: 0.25, delayFb: 0.4, delayLp: 4500,
    mix: {
      mix: {
        comp: { thr: -9, ratio: 1.6, attack: 0.02, release: 0.3, knee: 6 }, clip: 0.9, filter: st.filter, revHp: 150,
        buses: { dry: { eq: [['highpass', 26, 0.7]], rev: 0.08 }, hall: { eq: [['highpass', 35, 0.7]], rev: 0.42 }, delay: { eq: [['highpass', 300, 0.6]], rev: 0.3, dly: 0.5 } },
      },
    },
    sections: [{ id: name, bars: st.dur / 2, nofold: true }],
    arrange: stingerArr(name),
  };
  const r = await renderTrack(track, pool, budget, log, host, int16);
  const s = r.segments[0];
  return { name, sr: s.rates.mix, chs: s.stems.mix, pcm: s.pcm ? s.pcm.mix : null, hit: st.hit };
}
