// Heavy pure-JS render stages run in a Web Worker so they never compete with the game loop:
// bank normalization, note sequencing, mastering (loudness, glue compression, linked limiting,
// tail folding, resampling), impulse responses, SFX finishing.
// jobKernel(K) is self-contained (only uses its argument), so it is stringified into a blob
// Worker together with dspKernel(). Without Worker support the very same generators run on the
// main thread, cooperatively (runAsync + Budget).
import { dspKernel, runAsync } from './dsp.js';

export function jobKernel(K) {
  'use strict';
  const bank = new Map();
  const jobs = {
    // store a rendered one-shot, normalized to its reference level
    * bankPut({ key, chs, norm, reverse, sr }) {
      if (norm) {
        const lvl = norm[0] === 'peak' ? K.gainToDb(K.peakOf(chs)) : K.shortRmsDb(chs, sr);
        if (lvl > -120) K.scaleChannels(chs, K.dbToGain(norm[1] - lvl));
      }
      K.fadeOut(chs, sr, 0.02);
      if (reverse) { chs = K.reverseChannels(chs); K.fadeOut(chs, sr, 0.004); }
      bank.set(key, chs);
      yield;
      return true;
    },
    * bankClear() { bank.clear(); return true; },
    * ping() { return true; },
    // mix note events of one stem into stereo buses laid out on one timeline
    * sequence({ sr, total, gain, parts }) {
      const buses = {};
      let count = 0;
      for (const p of parts) {
        const D = p.pumpTimes && p.pumpTimes.length ? K.pumpCurve(p.slot, sr, p.pumpTimes, p.pumpRelease) : null;
        for (const ev of p.events) {
          const src = bank.get(ev.key);
          if (!src) continue;
          let bus = buses[ev.bus];
          if (!bus) bus = buses[ev.bus] = [new Float32Array(total), new Float32Array(total)];
          const view = [bus[0].subarray(p.off, p.off + p.slot), bus[1].subarray(p.off, p.off + p.slot)];
          const at = (ev.endAt ? ev.t - src[0].length / sr : ev.t) * sr;
          K.mixEvent(view, src, at, ev.g * gain, ev.pan, ev.pump, D, ev.env, sr);
          if ((++count & 15) === 0) yield;
        }
      }
      return buses;
    },
    // loudness pre-gain, glue compression + soft clip per stem, tail folding, linked limiter on
    // the stem sum (including the crossfade overhang heard at a self-join), storage resampling
    * master({ sr, target, ceiling, ov, stems, sections, int16 }) {
      const loud = function* () {
        const blocks = [];
        for (const sec of sections) yield* K.kBinsGen(sec.stems, sr, blocks);
        return K.gatedLoudness(blocks);
      };
      const L0 = yield* loud();
      const g0 = K.dbToGain(Math.max(-24, Math.min(24, target - L0)));
      for (const sec of sections) {
        for (let si = 0; si < stems.length; si++) {
          const P = stems[si];
          if (P.comp) yield* K.compressGen(sec.stems[si], sr, Object.assign({}, P.comp, { pre: g0, clip: P.clip }));
          else { K.scaleChannels(sec.stems[si], g0); K.softClip(sec.stems[si], P.clip); yield; }
        }
      }
      const L1 = yield* loud();
      const g1 = K.dbToGain(Math.max(-12, Math.min(12, target - L1)));
      const out = [];
      for (const sec of sections) {
        const lenN = sec.lenN;
        const folded = sec.stems.map((st) => (sec.nofold ? st : K.foldTail(st, lenN, ov)));
        yield;
        const sum = K.sumStems(folded);
        K.scaleChannels(sum, g1);
        if (!sec.nofold) for (const d of sum) for (let i = 0; i < ov; i++) d[i] += d[lenN + i];
        const g = yield* K.limiterGainGen(sum, sr, { ceiling, lookahead: 0.004, release: 0.12 });
        if (!sec.nofold) for (let i = 0; i < ov; i++) g[lenN + i] = Math.min(g[lenN + i], g[i]);
        const res = { stems: [], rates: [], pcm: int16 ? [] : null };
        for (let si = 0; si < folded.length; si++) {
          K.applyGain(folded[si], g, g1);
          const rate = stems[si].rate || sr;
          let chs = folded[si];
          if (rate !== sr) {
            const gcd = (a, b) => (b ? gcd(b, a % b) : a);
            const k = gcd(rate, sr);
            const r = [];
            for (const d of chs) r.push(yield* K.resampleGen(d, rate / k, sr / k));
            chs = r;
          } else yield;
          res.stems.push(chs);
          res.rates.push(rate);
          if (int16) res.pcm.push(chs.map(K.toInt16));
        }
        out.push(res);
        sec.stems = null;
      }
      return { segments: out, loudness: [L0, L1] };
    },
    * sfx({ chs, sr, loop, xfade, level, int16 }) {
      const out = K.finishSfx(chs, sr, { loop, xfade, level });
      yield;
      return { chs: out, pcm: int16 ? out.map(K.toInt16) : null };
    },
    * ir({ sr, ir }) { return yield* K.makeIRGen(sr, ir); },
  };
  return jobs;
}

// Worker bootstrap (stringified). Transfers every typed array found in the result.
function workerMain(makeJobs, makeKernel) {
  const K = makeKernel();
  const J = makeJobs(K);
  const collect = (v, list, seen) => {
    if (!v || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v)) { if (!seen.has(v.buffer)) { seen.add(v.buffer); list.push(v.buffer); } return; }
    for (const k in v) collect(v[k], list, seen);
  };
  self.onmessage = (e) => {
    const { id, op, args } = e.data;
    try {
      const r = K.runSync(J[op](args));
      const list = [];
      collect(r, list, new Set());
      self.postMessage({ id, ok: true, r }, list);
    } catch (err) {
      self.postMessage({ id, ok: false, err: String((err && err.stack) || err) });
    }
  };
}

function transferList(v, list = [], seen = new Set()) {
  if (!v || typeof v !== 'object') return list;
  if (ArrayBuffer.isView(v)) { if (!seen.has(v.buffer)) { seen.add(v.buffer); list.push(v.buffer); } return list; }
  for (const k in v) transferList(v[k], list, seen);
  return list;
}

// A few independent workers ("lanes"): all jobs of one track go to the same lane (its sample
// bank lives there), stateless jobs (SFX, impulse responses) are spread round-robin.
export class DspHost {
  constructor(budget, useWorker = true, lanes = 2) {
    this.lanes = [];
    for (let i = 0; i < Math.max(1, lanes); i++) this.lanes.push(new DspLane(budget, useWorker));
    this.rr = 0;
    this.assigned = new Map();
    this.nextLane = 0;
  }
  // tracks are assigned lanes round-robin in the order they start (menu and battle, which render
  // concurrently, land on different workers)
  lane(key) {
    let i = this.assigned.get(key);
    if (i === undefined) { i = this.nextLane++ % this.lanes.length; this.assigned.set(key, i); }
    return this.lanes[i];
  }
  call(op, args) { return this.lanes[this.rr++ % this.lanes.length].call(op, args); }
  get worker() { return this.lanes.some((l) => !!l.worker); }
  get stats() {
    const s = { calls: 0, workerCalls: 0, localCalls: 0, lanes: this.lanes.length };
    for (const l of this.lanes) { s.calls += l.stats.calls; s.workerCalls += l.stats.workerCalls; s.localCalls += l.stats.localCalls; }
    return s;
  }
  dispose() { for (const l of this.lanes) l.dispose(); }
}

class DspLane {
  constructor(budget, useWorker = true) {
    this.budget = budget;
    this.seq = 0;
    this.wait = new Map();
    this.worker = null;
    this.local = null;
    this.stats = { calls: 0, workerCalls: 0, localCalls: 0 };
    if (useWorker && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      try {
        const src = `(${workerMain.toString()})(${jobKernel.toString()}, ${dspKernel.toString()});`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = (e) => this._done(e.data);
        w.onerror = (e) => this._broken(e && e.message);
        this.worker = w;
      } catch (e) {
        this.worker = null;
      }
    }
    // handshake: no real job (whose buffers get transferred) is sent before the worker answered
    this.ready = !this.worker ? Promise.resolve() : new Promise((res) => {
      const timer = setTimeout(() => { this._broken('startup timeout'); res(); }, 4000);
      this._send('ping', {}).then(() => { clearTimeout(timer); res(); }, () => { clearTimeout(timer); res(); });
    });
  }

  // Runs a job; `args` typed arrays are transferred (callers must not reuse them).
  async call(op, args) {
    this.stats.calls++;
    await this.ready;
    if (!this.worker) return this._local(op, args);
    this.stats.workerCalls++;
    return this._send(op, args);
  }

  _send(op, args) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.wait.set(id, { res, rej });
      try { this.worker.postMessage({ id, op, args }, transferList(args)); } catch (e) { this.wait.delete(id); this._broken(e && e.message); this._local(op, args).then(res, rej); }
    });
  }

  _local(op, args) {
    this.stats.localCalls++;
    if (!this.local) this.local = jobKernel(dspKernel());
    return runAsync(this.local[op](args), this.budget);
  }

  _done({ id, ok, r, err }) {
    const w = this.wait.get(id);
    if (!w) return;
    this.wait.delete(id);
    if (ok) w.res(r); else w.rej(new Error(err));
  }

  // A broken worker fails its pending jobs; later jobs run on the main thread.
  _broken(msg) {
    try { if (this.worker) this.worker.terminate(); } catch (e) { /* ignore */ }
    this.worker = null;
    for (const w of this.wait.values()) w.rej(new Error(`audio worker failed: ${msg || '?'}`));
    this.wait.clear();
  }

  dispose() { try { if (this.worker) this.worker.terminate(); } catch (e) { /* ignore */ } this.worker = null; }
}
