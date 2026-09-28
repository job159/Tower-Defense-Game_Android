// Pure-JS DSP for the offline renderer: RNG, noise, impulse responses, mixing, dynamics
// (compressor / soft clip / lookahead limiter), resampling, loops, loudness metrics.
// No AudioContext needed. The pure part lives in dspKernel() (Worker-safe); this module also holds
// the main-thread cooperative scheduling helpers.

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// optional profiling of long synchronous slices (QA only)
export const PROF = { on: false, list: [] };
export function prof(label, t0) { if (PROF.on) { const d = now() - t0; if (d > 3) PROF.list.push([label, Math.round(d * 10) / 10]); } }

// ------------------------------------------------------------------ the kernel
// Everything below is pure JS with NO references outside this function, so the same code can run on
// the main thread and - stringified - inside a Worker (see jobs.js).
export function dspKernel() {
  'use strict';
  const TAU = Math.PI * 2;
  const CHUNK = 4096;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const dbToGain = (d) => Math.pow(10, d / 20);
  const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));
  // Heavy loops are generators that `yield` every few thousand samples: run them synchronously
  // (worker, small buffers) or cooperatively on the main thread (see runAsync below).
  function runSync(gen) { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }
  // ------------------------------------------------------------------ random
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    const r = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.bi = () => r() * 2 - 1;
    r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
    r.int = (n) => Math.floor(r() * n) % n;
    return r;
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ------------------------------------------------------------------ noise
  function whiteNoise(n, rng) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
    return d;
  }
  function pinkNoise(n, rng) { // Paul Kellet (refined), ~unit peak
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return d;
  }
  function brownNoise(n, rng) {
    const d = new Float32Array(n);
    let l = 0;
    for (let i = 0; i < n; i++) { l = (l + 0.02 * (rng() * 2 - 1)) / 1.02; d[i] = l * 3.5; }
    return d;
  }

  // Sparse crackle: random decaying clicks (debris, electricity, fire).
  function crackle(n, sr, rng, { rate = 60, decay = 0.002, amp = 1, env = null } = {}) {
    const d = new Float32Array(n);
    const count = Math.floor(rate * n / sr);
    const dn = Math.max(1, Math.floor(decay * sr));
    for (let k = 0; k < count; k++) {
      const p = Math.floor(rng() * n);
      const e = env ? env(p / n) : 1;
      if (e <= 0) continue;
      let a = amp * e * (0.3 + 0.7 * rng()) * (rng() < 0.5 ? -1 : 1);
      const len = Math.min(n - p, dn * 6);
      const k2 = Math.exp(-1 / (dn * (0.5 + rng())));
      for (let i = 0; i < len; i++) { d[p + i] += a * (i & 1 ? -0.6 : 1); a *= k2; }
    }
    return d;
  }

  // ------------------------------------------------------------------ impulse responses
  // Stereo, decorrelated, exponentially decaying noise with early reflections and HF damping
  // that increases over time (air absorption). Normalized to unit energy per channel.
  function* makeIRGen(sr, o = {}) {
    const {
      len = 3, rt60 = 2.6, pre = 0.018, hf0 = 9000, hf1 = 1600, lf = 0, early = 12, earlyLen = 0.075,
      width = 0.12, seed = 7, fadeIn = 0.025, gain = 1,
    } = o;
    const n = Math.max(16, Math.floor(len * sr));
    const p = Math.floor(pre * sr);
    const rng = makeRng(seed);
    const out = [new Float32Array(n), new Float32Array(n)];
    const decayK = Math.pow(10, -3 / (rt60 * sr));
    for (let c = 0; c < 2; c++) {
      const d = out[c];
      let y = 0, y2 = 0, env = 1, a = 0, hp = 0;
      const fi = Math.max(1, Math.floor(fadeIn * sr));
      const span = n - p;
      for (let i0 = p; i0 < n; i0 += CHUNK) {
        const i1 = Math.min(n, i0 + CHUNK);
        for (let i = i0; i < i1; i++) {
          const k = i - p;
          if ((k & 63) === 0) {
            const fc = hf0 * Math.pow(hf1 / hf0, k / span);
            a = 1 - Math.exp(-TAU * fc / sr);
          }
          const w = rng() * 2 - 1;
          y += a * (w - y);
          y2 += a * (y - y2);
          let v = y2 * env * (k < fi ? k / fi : 1);
          if (lf) { hp += lf * (v - hp); v -= hp; }
          d[i] = v;
          env *= decayK;
        }
        yield;
      }
      // early reflections: sparse taps, stronger on one side
      for (let e = 0; e < early; e++) {
        const tt = pre + 0.004 + rng() * earlyLen;
        const idx = Math.floor(tt * sr);
        if (idx >= n) continue;
        const envAt = Math.pow(10, -3 * (tt - pre) / rt60);
        const side = (e + c) % 2 === 0 ? 1 : 0.35;
        const g = (0.9 - 0.5 * (e / early)) * envAt * side * (rng() < 0.5 ? -1 : 1) * 0.55;
        d[idx] += g;
        if (idx + 1 < n) d[idx + 1] += g * 0.5;
      }
    }
    if (width > 0) {
      const L = out[0], R = out[1];
      for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; L[i] = l + width * r; R[i] = r + width * l; }
      yield;
    }
    for (let c = 0; c < 2; c++) {
      const d = out[c];
      let e = 0;
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const sc = gain / Math.sqrt(e || 1);
      for (let i = 0; i < n; i++) d[i] *= sc;
      // tail fade (last 5%)
      const f = Math.floor(n * 0.05);
      for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
      yield;
    }
    return out;
  }
  // Stereo, decorrelated, exponentially decaying noise with early reflections and HF damping
  // that increases over time (air absorption). Normalized to unit energy per channel.
  const makeIR = (sr, o) => runSync(makeIRGen(sr, o));


  // Classic 80s gated reverb: dense, nearly flat burst then an abrupt (but click-free) cut.
  function makeGatedIR(sr, { len = 0.24, pre = 0.003, hf = 7500, seed = 3, tilt = 0.35 } = {}) {
    const n = Math.floor(len * sr), p = Math.floor(pre * sr);
    const rng = makeRng(seed);
    const out = [new Float32Array(n), new Float32Array(n)];
    const a = 1 - Math.exp(-TAU * hf / sr);
    const cut = Math.floor(0.012 * sr);
    for (let c = 0; c < 2; c++) {
      let y = 0;
      const d = out[c];
      for (let i = p; i < n; i++) {
        y += a * (rng() * 2 - 1 - y);
        const t = (i - p) / (n - p);
        let env = 1 - tilt * t;
        if (i - p < 64) env *= (i - p) / 64;
        if (n - i < cut) env *= (n - i) / cut;
        d[i] = y * env;
      }
      let e = 0;
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const s = 1 / Math.sqrt(e || 1);
      for (let i = 0; i < n; i++) d[i] *= s;
    }
    return out;
  }

  // ------------------------------------------------------------------ mixing
  function panGains(pan) {
    const th = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
    return [Math.cos(th) * Math.SQRT2, Math.sin(th) * Math.SQRT2]; // center = unity per side
  }

  // Adds `src` (array of 1 or 2 channels) into dst (2 channels) at sample offset `at`.
  function mixInto(dst, src, at, gain = 1, pan = 0) {
    const L = dst[0], R = dst[1];
    const n = src[0].length;
    const o = Math.round(at);
    let i0 = 0;
    if (o < 0) i0 = -o;
    const i1 = Math.min(n, L.length - o);
    if (i1 <= i0) return;
    if (src.length === 1) {
      const s = src[0];
      const [gl, gr] = panGains(pan);
      const a = gain * gl, b = gain * gr;
      for (let i = i0; i < i1; i++) { const v = s[i]; L[o + i] += v * a; R[o + i] += v * b; }
    } else {
      const s0 = src[0], s1 = src[1];
      const a = gain * (pan > 0 ? 1 - pan : 1), b = gain * (pan < 0 ? 1 + pan : 1);
      for (let i = i0; i < i1; i++) { L[o + i] += s0[i] * a; R[o + i] += s1[i] * b; }
    }
  }

  function reverseChannels(chs) {
    return chs.map((c) => { const r = new Float32Array(c.length); for (let i = 0, n = c.length; i < n; i++) r[i] = c[n - 1 - i]; return r; });
  }

  function channelsOf(buf) {
    const out = [];
    for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c));
    return out;
  }

  function scaleChannels(chs, g) {
    for (const d of chs) for (let i = 0, n = d.length; i < n; i++) d[i] *= g;
  }

  // Sidechain-style pump: multiply by an envelope that dips at each trigger time (seconds).
  function applyPump(chs, sr, times, { depth = 0.5, attack = 0.004, release = 0.18, from = 0, to = Infinity } = {}) {
    const n = chs[0].length;
    const env = new Float32Array(n).fill(1);
    const tau = release / 3;
    for (const t of times) {
      const s = Math.round(t * sr);
      const a = Math.max(1, Math.round(attack * sr));
      const len = Math.min(n - s, Math.round(release * 2.5 * sr));
      for (let i = 0; i < len; i++) {
        const k = s + i;
        if (k < 0 || k < from * sr || k > to * sr) continue;
        const tt = i / sr;
        const dip = i < a ? depth * (i / a) : depth * Math.exp(-(tt - attack) / tau);
        const g = 1 - dip;
        if (g < env[k]) env[k] = g;
      }
    }
    for (const d of chs) for (let i = 0; i < n; i++) d[i] *= env[i];
  }

  function fadeOut(chs, sr, secs) {
    const n = chs[0].length, f = Math.min(n, Math.floor(secs * sr));
    for (const d of chs) for (let i = 0; i < f; i++) { const g = i / f; d[n - 1 - i] *= g * g; }
  }
  function fadeIn(chs, sr, secs) {
    const f = Math.min(chs[0].length, Math.floor(secs * sr));
    for (const d of chs) for (let i = 0; i < f; i++) d[i] *= i / f;
  }

  // Removes DC with a gentle one-pole high-pass (~8 Hz).
  function dcBlock(chs, sr, fc = 8) {
    const R = Math.exp(-TAU * fc / sr);
    for (const d of chs) {
      let x1 = 0, y1 = 0;
      for (let i = 0, n = d.length; i < n; i++) { const x = d[i]; const y = x - x1 + R * y1; x1 = x; y1 = y; d[i] = y; }
    }
  }

  // Trims trailing near-silence (keeps a small margin) and applies a short end fade.
  function trimTail(chs, sr, thrDb = -72, margin = 0.02) {
    const thr = dbToGain(thrDb);
    let last = 0;
    for (const d of chs) for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > thr) { last = i; break; }
    const n = Math.min(chs[0].length, last + Math.floor(margin * sr) + 1);
    const out = chs.map((d) => d.slice(0, Math.max(16, n)));
    fadeOut(out, sr, Math.min(0.015, n / sr / 4));
    return out;
  }

  // ------------------------------------------------------------------ dynamics
  function peakOf(chs) {
    let p = 0;
    for (const d of chs) for (let i = 0, n = d.length; i < n; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > p) p = v; }
    return p;
  }

  // Feed-forward compressor, stereo-linked peak detector with attack/release smoothing. The gain
  // computer runs once per 16-sample block (linear gain interpolation inside the block), which is
  // ~10x cheaper than per-sample log/pow and inaudible at these time constants. `pre` = input gain.
  function* compressGen(chs, sr, { thr = -18, ratio = 3, attack = 0.01, release = 0.15, knee = 6, makeup = 0, pre = 1, clip = 0 } = {}) {
    const n = chs[0].length, nc = chs.length;
    const ca = Math.exp(-1 / (attack * sr)), cr = Math.exp(-1 / (release * sr));
    const mk = dbToGain(makeup) * pre;
    const slope = 1 - 1 / ratio, hk = knee / 2;
    const B = 16;
    let env = 0, gPrev = 1;
    const kc = clip, rc = 1 - clip;
    for (let c0 = 0; c0 < n; c0 += CHUNK) {
      const c1 = Math.min(n, c0 + CHUNK);
      for (let i0 = c0; i0 < c1; i0 += B) {
        const i1 = i0 + B < c1 ? i0 + B : c1;
        let em = 0;
        for (let i = i0; i < i1; i++) {
          let x = 0;
          for (let c = 0; c < nc; c++) { const v = chs[c][i]; const a = v < 0 ? -v : v; if (a > x) x = a; }
          x *= pre;
          env = x > env ? ca * env + (1 - ca) * x : cr * env + (1 - cr) * x;
          if (env > em) em = env;
        }
        const over = 20 * Math.log10(em + 1e-9) - thr;
        let gr = 0;
        if (over > hk) gr = over * slope;
        else if (over > -hk) { const t = over + hk; gr = (t * t) / (2 * knee) * slope; }
        const gT = gr > 0 ? Math.pow(10, -gr / 20) : 1;
        const inv = 1 / (i1 - i0);
        for (let i = i0; i < i1; i++) {
          const g = (gPrev + (gT - gPrev) * (i - i0 + 1) * inv) * mk;
          for (let c = 0; c < nc; c++) {
            let v = chs[c][i] * g;
            if (kc > 0) { const a = v < 0 ? -v : v; if (a > kc) { const y = kc + rc * Math.tanh((a - kc) / rc); v = v < 0 ? -y : y; } }
            chs[c][i] = v;
          }
        }
        gPrev = gT;
      }
      yield;
    }
  }
  // Feed-forward compressor, stereo-linked peak detector with attack/release smoothing. The gain
  // computer runs once per 16-sample block (linear gain interpolation inside the block), which is
  // ~10x cheaper than per-sample log/pow and inaudible at these time constants. `pre` = input gain,
  // `clip` > 0 fuses a soft clipper with that knee into the same pass.
  const compress = (chs, sr, o) => runSync(compressGen(chs, sr, o));


  // K-weighted mean-square energy in 100 ms bins of the SUM of several stereo stems (no allocations
  // besides the output). Four consecutive bins form one BS.1770 400 ms / 75 % overlap block.
  function* kBinsGen(stems, sr, out = []) {
    const n = stems[0][0].length;
    const hop = Math.max(1, Math.floor(0.1 * sr));
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / sr);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const b0 = (Vh + Vb * K / Q + K * K) / a0, b1 = 2 * (K * K - Vh) / a0, b2 = (Vh - Vb * K / Q + K * K) / a0;
    const a1 = 2 * (K * K - 1) / a0, a2 = (1 - K / Q + K * K) / a0;
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr);
    a0 = 1 + K / Q + K * K;
    const c1 = 2 * (K * K - 1) / a0, c2 = (1 - K / Q + K * K) / a0;
    const nb = Math.floor(n / hop);
    const bins = new Float64Array(nb);
    for (let ch = 0; ch < 2; ch++) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
      for (let b = 0; b < nb; b++) {
        let acc = 0;
        const e = (b + 1) * hop;
        for (let i = b * hop; i < e; i++) {
          let x = 0;
          for (let s = 0; s < stems.length; s++) x += stems[s][ch][i];
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          const z = y - 2 * u1 + u2 - c1 * z1 - c2 * z2;
          u2 = u1; u1 = y; z2 = z1; z1 = z;
          acc += z * z;
        }
        bins[b] += acc / hop;
        if ((b & 7) === 7) yield;
      }
    }
    for (let b = 0; b + 3 < nb; b++) out.push((bins[b] + bins[b + 1] + bins[b + 2] + bins[b + 3]) / 4);
    return out;
  }
  // K-weighted mean-square energy in 100 ms bins of the SUM of several stereo stems. Four
  // consecutive bins form one BS.1770 400 ms / 75 % overlap block (appended to `out`).
  const kBins = (stems, sr, out) => runSync(kBinsGen(stems, sr, out));


  // Windowed-sinc polyphase resampler for a rational ratio (e.g. 32 kHz -> 24 kHz = up 3, down 4).
  // Zero-phase (output sample j sits exactly at input position j*down/up).
  function* resampleGen(d, up, down, taps = 32, cut = 0.92) {
    const nOut = Math.floor((d.length * up) / down);
    const half = taps >> 1;
    const fc = 0.5 * Math.min(1, up / down) * cut;
    const H = [];
    for (let p = 0; p < up; p++) {
      const frac = p / up;
      const h = new Float32Array(taps);
      let s = 0;
      for (let k = 0; k < taps; k++) {
        const t = frac + half - 1 - k;
        const x = 2 * fc * t;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = Math.abs(t) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * t / half) + 0.08 * Math.cos(2 * Math.PI * t / half);
        h[k] = sinc * w;
        s += h[k];
      }
      for (let k = 0; k < taps; k++) h[k] /= s;
      H.push(h);
    }
    const out = new Float32Array(nOut);
    const n = d.length;
    for (let j0 = 0; j0 < nOut; j0 += CHUNK) {
      const j1 = Math.min(nOut, j0 + CHUNK);
      for (let j = j0; j < j1; j++) {
        const num = j * down;
        const base = Math.floor(num / up);
        const h = H[num - base * up];
        const i0 = base - half + 1;
        let acc = 0;
        if (i0 >= 0 && i0 + taps <= n) { for (let k = 0; k < taps; k++) acc += d[i0 + k] * h[k]; }
        else { for (let k = 0; k < taps; k++) { const i = i0 + k; if (i >= 0 && i < n) acc += d[i] * h[k]; } }
        out[j] = acc;
      }
      yield;
    }
    return out;
  }
  // Windowed-sinc polyphase resampler for a rational ratio (e.g. 32 kHz -> 24 kHz = up 3, down 4).
  // Zero-phase (output sample j sits exactly at input position j*down/up).
  const resample = (d, up, down, taps, cut) => runSync(resampleGen(d, up, down, taps, cut));


  // Smooth saturator: linear below `knee`, tanh-shaped approach to 1.0 above.
  function softClip(chs, knee = 0.7) {
    const k = knee, r = 1 - k;
    for (const d of chs) {
      for (let i = 0, n = d.length; i < n; i++) {
        const v = d[i], a = v < 0 ? -v : v;
        if (a > k) { const y = k + r * Math.tanh((a - k) / r); d[i] = v < 0 ? -y : y; }
      }
    }
  }

  // Lookahead brick-wall limiter (offline, zero added latency): forward sliding-min of the required
  // gain, box-smoothed over the lookahead window, exponential release. Ceiling in dBFS.
  function limit(chs, sr, opts = {}) {
    const g = limiterGain(chs, sr, opts);
    applyGain(chs, g);
    const c = dbToGain(opts.ceiling ?? -1);
    for (const d of chs) for (let i = 0, n = d.length; i < n; i++) { if (d[i] > c) d[i] = c; else if (d[i] < -c) d[i] = -c; }
  }
  function applyGain(chs, g, s = 1) {
    for (const d of chs) for (let i = 0, n = d.length; i < n; i++) d[i] *= g[i] * s;
  }
  // Gain curve that keeps max|chs| under the ceiling (use it to limit several stems identically).
  function* limiterGainGen(chs, sr, { ceiling = -1, lookahead = 0.004, release = 0.09 } = {}) {
    const n = chs[0].length, nc = chs.length;
    const c = dbToGain(ceiling);
    const L = Math.max(1, Math.round(lookahead * sr));
    const req = new Float32Array(n);
    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        let p = 0;
        for (let k = 0; k < nc; k++) { const v = chs[k][i]; const a = v < 0 ? -v : v; if (a > p) p = a; }
        req[i] = p > c ? c / p : 1;
      }
      yield;
    }
    // forward sliding minimum over [i, i+L] (monotonic deque)
    const m = new Float32Array(n);
    const dq = new Int32Array(n + L + 1);
    let h = 0, t = 0;
    for (let j = 0; j < Math.min(n, L + 1); j++) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        while (dq[h] < i) h++;
        m[i] = req[dq[h]];
        const j = i + L + 1;
        if (j < n) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
      }
      yield;
    }
    // box smoothing over the previous L samples + release
    const rel = Math.exp(-1 / (release * sr));
    let acc = 0, g = 1;
    const inv = 1 / (L + 1);
    const out = req; // reuse
    for (let i0 = 0; i0 < n; i0 += CHUNK) {
      const i1 = Math.min(n, i0 + CHUNK);
      for (let i = i0; i < i1; i++) {
        acc += m[i];
        if (i > L) acc -= m[i - L - 1];
        const s = i >= L ? acc * inv : Math.min(1, (acc + (L - i)) * inv);
        g = s < g ? s : rel * g + (1 - rel) * s;
        if (g > s) g = s;
        out[i] = g;
      }
      yield;
    }
    return out;
  }
  // Gain curve that keeps max|chs| under the ceiling (use it to limit several stems identically).
  const limiterGain = (chs, sr, o) => runSync(limiterGainGen(chs, sr, o));


  // Max short-window RMS (dBFS) - a level measure for sustained one-shots that ignores length.
  function shortRmsDb(chs, sr, win = 0.05) {
    const n = chs[0].length, W = Math.max(8, Math.floor(win * sr)), hop = Math.max(4, W >> 1);
    let best = 0;
    for (let s = 0; s + W <= n; s += hop) {
      let z = 0;
      for (const d of chs) for (let i = s; i < s + W; i++) z += d[i] * d[i];
      z /= W * chs.length;
      if (z > best) best = z;
    }
    return 10 * Math.log10(best + 1e-12);
  }

  // ------------------------------------------------------------------ loops
  // Equal-power crossfade of the region after `loopLen` back onto the start -> seamless loop.
  function makeLoop(chs, sr, loopSecs, xfadeSecs) {
    const L = Math.floor(loopSecs * sr), X = Math.floor(xfadeSecs * sr);
    return chs.map((d) => {
      const o = d.slice(0, L);
      for (let i = 0; i < X && L + i < d.length; i++) {
        const t = i / X;
        o[i] = d[i] * Math.sin(t * Math.PI / 2) + d[L + i] * Math.cos(t * Math.PI / 2);
      }
      return o;
    });
  }

  // ------------------------------------------------------------------ PCM packing
  function toInt16(f32) {
    const n = f32.length, o = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = f32[i] * 32767;
      o[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : (v + (v >= 0 ? 0.5 : -0.5)) | 0;
    }
    return o;
  }
  function fromInt16(i16, out) {
    const n = i16.length, o = out || new Float32Array(n);
    const k = 1 / 32768;
    for (let i = 0; i < n; i++) o[i] = i16[i] * k;
    return o;
  }

  // ------------------------------------------------------------------ metrics (also used by QA)
  function biquadRun(d, b0, b1, b2, a1, a2) {
    const o = new Float32Array(d.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0, n = d.length; i < n; i++) {
      const x = d[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; o[i] = y;
    }
    return o;
  }
  // ITU-R BS.1770 K-weighting for arbitrary sample rates.
  function kWeight(d, sr) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / sr);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const s1 = biquadRun(d, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr);
    a0 = 1 + K / Q + K * K;
    return biquadRun(s1, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  }
  // Integrated loudness (gated, LUFS) and max momentary loudness over `win` seconds.
  function loudness(chs, sr, win = 0.4) {
    const w = chs.map((d) => kWeight(d, sr));
    const n = chs[0].length;
    const B = Math.max(1, Math.floor(win * sr)), hop = Math.max(1, Math.floor(B / 4));
    const blocks = [];
    // prefix sums of squares per channel
    const ps = w.map((d) => { const p = new Float64Array(d.length + 1); for (let i = 0; i < d.length; i++) p[i + 1] = p[i] + d[i] * d[i]; return p; });
    if (n < B) {
      let z = 0;
      for (const p of ps) z += p[n] / Math.max(1, n);
      blocks.push(z);
    } else {
      for (let s = 0; s + B <= n; s += hop) { let z = 0; for (const p of ps) z += (p[s + B] - p[s]) / B; blocks.push(z); }
    }
    const lk = (z) => -0.691 + 10 * Math.log10(z + 1e-12);
    let maxM = -Infinity;
    for (const z of blocks) maxM = Math.max(maxM, lk(z));
    const abs = blocks.filter((z) => lk(z) > -70);
    if (!abs.length) return { integrated: -Infinity, momentaryMax: maxM };
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const rel = abs.filter((z) => lk(z) > lk(mean) - 10);
    const m2 = rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length);
    return { integrated: lk(m2), momentaryMax: maxM };
  }

  function stats(chs, sr) {
    const n = chs[0].length;
    let peak = 0, sum = 0, dc = 0, clips = 0;
    for (const d of chs) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const v = d[i], a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        if (a >= 0.999) clips++;
        sum += v * v; s += v;
      }
      dc = Math.max(dc, Math.abs(s / n));
    }
    return { dur: n / sr, peakDb: gainToDb(peak), rmsDb: gainToDb(Math.sqrt(sum / (n * chs.length))), dc, clips };
  }

  // ---------------------------------------------------------------- music pipeline stages
  // Gated integrated loudness (BS.1770) from 400 ms block powers.
  function gatedLoudness(blocks) {
    const lk = (z) => -0.691 + 10 * Math.log10(z + 1e-12);
    const abs = blocks.filter((z) => lk(z) > -70);
    if (!abs.length) return -Infinity;
    const m1 = abs.reduce((a, b) => a + b, 0) / abs.length;
    const rel = abs.filter((z) => lk(z) > lk(m1) - 10);
    return lk(rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length));
  }

  // Adds one note (1-2 channel one-shot) into a stereo bus with gain, pan, optional sidechain
  // pump (depth x dip curve D) and optional JS release (env.cut / env.rel seconds).
  function mixEvent(bus, src, at, g, pan, depth, D, env, sr) {
    const L = bus[0], R = bus[1];
    const o = Math.round(at);
    let n = src[0].length;
    let cutN = n, decay = 1;
    if (env && env.cut != null) {
      cutN = Math.max(0, Math.round(env.cut * sr));
      const rel = env.rel ?? 0.5;
      decay = Math.exp(-4.6 / (rel * sr)); // ~ -40 dB after `rel` seconds
      n = Math.min(n, cutN + Math.round(rel * 1.3 * sr));
    }
    const i0 = o < 0 ? -o : 0;
    const i1 = Math.min(n, L.length - o);
    if (i1 <= i0) return;
    const st = src.length > 1;
    let a, b;
    if (st) { a = g * (pan > 0 ? 1 - pan : 1); b = g * (pan < 0 ? 1 + pan : 1); } else { const pg = panGains(pan); a = g * pg[0]; b = g * pg[1]; }
    const s0 = src[0], s1 = st ? src[1] : src[0];
    const pumpOn = depth > 0 && D;
    let e = 1;
    for (let i = i0; i < i1; i++) {
      if (i >= cutN) e *= decay;
      const k = (pumpOn ? 1 - depth * D[o + i] : 1) * e;
      L[o + i] += s0[i] * a * k;
      R[o + i] += s1[i] * b * k;
    }
  }

  // Unit sidechain dip curve (0..1) from trigger times: one precomputed shape, max-merged.
  function pumpCurve(n, sr, times, release = 0.16, attack = 0.005) {
    const D = new Float32Array(n);
    const a = Math.max(1, Math.round(attack * sr)), tau = release / 3;
    const W = Math.round(release * 2.2 * sr);
    const shape = new Float32Array(W);
    for (let i = 0; i < W; i++) shape[i] = i < a ? i / a : Math.exp(-((i - a) / sr) / tau);
    for (const t of times) {
      const s = Math.round(t * sr);
      const len = Math.min(n - s, W);
      for (let i = 0; i < len; i++) { const v = shape[i]; if (v > D[s + i]) D[s + i] = v; }
    }
    return D;
  }

  // Fold the tail (samples after `len`) back onto the start with a complementary crossfade
  // overhang of `ov` samples, so a segment can follow any other segment seamlessly.
  function foldTail(chs, len, ov) {
    const total = chs[0].length;
    return chs.map((d) => {
      const o = new Float32Array(len + ov);
      o.set(d.subarray(0, Math.min(total, len + ov)));
      for (let i = 0; i < ov; i++) o[len + i] *= 1 - i / ov;
      for (let i = 0; len + i < total; i++) {
        const w = i < ov ? i / ov : 1;
        o[i % len] += d[len + i] * w;
      }
      return o;
    });
  }

  function sumStems(stemChs) {
    const n = stemChs[0][0].length;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (const [l, r] of stemChs) for (let i = 0; i < n; i++) { L[i] += l[i]; R[i] += r[i]; }
    return [L, R];
  }

  // Sound-effect finishing: DC removal, tail trim, loop crossfade, short-term loudness
  // normalization to `level` LUFS, peak safety limiter.
  function finishSfx(chs, sr, { loop = 0, xfade = 0.2, level = -24 } = {}) {
    dcBlock(chs, sr, 12);
    let out = loop ? chs.map((d) => d.slice(0)) : trimTail(chs, sr, -70);
    if (loop) out = makeLoop(out, sr, loop, xfade);
    const lu = loudness(out, sr, loop ? 0.4 : 0.1).momentaryMax;
    if (Number.isFinite(lu)) scaleChannels(out, dbToGain(clamp(level - lu, -30, 30)));
    if (peakOf(out) > dbToGain(-1)) limit(out, sr, { ceiling: -1, lookahead: 0.002, release: 0.06 });
    return out;
  }

  return { TAU, CHUNK, mtof, clamp, dbToGain, gainToDb, runSync, makeRng, hashStr,
    gatedLoudness, mixEvent, pumpCurve, foldTail, sumStems, finishSfx, whiteNoise, pinkNoise, brownNoise, crackle, makeIR, makeGatedIR, panGains, mixInto, reverseChannels, channelsOf, scaleChannels, applyPump, fadeOut, fadeIn, dcBlock, trimTail, peakOf, compress, kBins, resample, softClip, limit, applyGain, limiterGain, shortRmsDb, makeLoop, toInt16, fromInt16, kWeight, loudness, stats, makeIRGen, compressGen, kBinsGen, resampleGen, limiterGainGen };
}

const K = dspKernel();
export const {
  gatedLoudness, mixEvent, pumpCurve, foldTail, sumStems, finishSfx,
  TAU, CHUNK, mtof, clamp, dbToGain, gainToDb, runSync, makeRng, hashStr, whiteNoise, pinkNoise, brownNoise, crackle, makeIR, makeGatedIR, panGains, mixInto, reverseChannels, channelsOf, scaleChannels, applyPump, fadeOut, fadeIn, dcBlock, trimTail, peakOf, compress, kBins, resample, softClip, limit, applyGain, limiterGain, shortRmsDb, makeLoop, toInt16, fromInt16, kWeight, loudness, stats, makeIRGen, compressGen, kBinsGen, resampleGen, limiterGainGen,
} = K;

// ------------------------------------------------------------------ cooperative scheduling
// Long main-thread loops call `await budget.tick()` so no single slice exceeds a few ms.
let mc = null;
const waiting = [];
function yieldNow() {
  return new Promise((res) => {
    try {
      if (!mc && typeof MessageChannel !== 'undefined') {
        mc = new MessageChannel();
        mc.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
      }
    } catch (e) { mc = null; }
    if (mc) { waiting.push(res); mc.port2.postMessage(0); } else setTimeout(res, 0);
  });
}
export class Budget {
  constructor(ms = 6) { this.ms = ms; this.t = now(); this.yields = 0; }
  get over() { return now() - this.t > this.ms; }
  async tick() {
    if (now() - this.t > this.ms) { this.yields++; await yieldNow(); this.t = now(); }
  }
}
// Runs a kernel generator cooperatively on the main thread.
export async function runAsync(gen, budget) {
  let r = gen.next();
  while (!r.done) { if (budget.over) await budget.tick(); r = gen.next(); }
  return r.value;
}

export const makeIRAsync = (sr, o, budget) => runAsync(K.makeIRGen(sr, o), budget);
export const compressAsync = (chs, sr, o, budget) => runAsync(K.compressGen(chs, sr, o), budget);
export const kBinsAsync = (stems, sr, out, budget) => runAsync(K.kBinsGen(stems, sr, out), budget);
export const resampleAsync = (d, up, down, budget) => runAsync(K.resampleGen(d, up, down), budget);
export const limiterGainAsync = (chs, sr, o, budget) => runAsync(K.limiterGainGen(chs, sr, o), budget);
