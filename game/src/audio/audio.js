// NEON BASTION audio engine.
// Everything is synthesized procedurally (no sample files): sound effects and a cinematic adaptive
// score are rendered in the background with OfflineAudioContexts (see sfx.js / music.js), cached as
// PCM in IndexedDB, and played at runtime with plain buffer sources - so the runtime cost is tiny.
//
//   unlock()                 create/resume the single AudioContext (call from user gestures)
//   prepare(onProgress)      background rendering in priority order; resolves when complete
//   play(name, opts)         one-shot SFX { pan, size, pitch, gain } (throttled, voice-capped)
//   setLoop(name, level)     'laser' | 'flame' | 'charge' continuous loops (0 = off)
//   setMusic(mode)           'off' | 'menu' | 'build' | 'battle' | 'boss' (bar-quantized)
//   setIntensity(x)          0..1 battle pressure -> adaptive layers
//   stinger(name)            'victory' | 'defeat' | 'wave' | 'bossIntro'
//   setBgmChoice(choice)     'auto' (built-in adaptive score) | 'random' | a BGM_LIST id
//   beginMatch()             a match starts: resolves the choice (random picks per match)
//   preview(id | null)       settings preview ('auto' = the built-in battle theme)
//   bgmState(id)             { ready, progress, rendering, failed, playing } for the settings UI
import { SFX, ALIASES, STINGER_ALIASES, explodeTier } from './sfx.js';
import { TRACKS, STINGERS, renderTrack, renderStinger } from './music.js';
import { BGM_TRACKS, BGM_LIST, BGM_REV } from './bgm.js';
import { RenderPool, offlineSupported } from './render.js';
import { AudioCache } from './cache.js';
import { DspHost } from './jobs.js';
import { Budget, makeRng, hashStr, clamp, makeIR, toInt16, fromInt16, now as perfNow } from './dsp.js';

export { BGM_LIST };

// Cache key for rendered PCM in IndexedDB: bump it whenever any synthesis / arrangement / mixing
// code changes, otherwise players keep hearing the previously cached renders. (The selectable
// soundtrack has its own revision, BGM_REV in bgm.js, folded into its cache keys.)
export const ENGINE_VERSION = 'nb-audio-1.0.2';
const MODES = ['off', 'menu', 'build', 'battle', 'boss'];
const TRACK_OF = { off: null, menu: 'menu', build: 'battle', battle: 'battle', boss: 'boss' };
const ALL_TRACKS = { ...TRACKS, ...BGM_TRACKS };
const BGM_KEY = `bgm@${BGM_REV}:`;
// section energy (0 ambient .. 3 climax) -> Markov weight multipliers per situation
const ENERGY_BIAS = { boss: [0.2, 0.55, 1, 1.7], hot: [0.45, 0.8, 1, 1.3], build: [1.2, 1.1, 1, 0.8] };
const CATS = { weapons: 0.8, impacts: 1, enemies: 1, ui: 0.95, hero: 1, abilities: 1 };
const MAX_VOICES = 30;
const LOOKAHEAD = 1.2;
const MUSIC_TRIM = 0.9;
const MASTER_TRIM = 0.84; // compensates the master limiter's automatic makeup gain

// continuous loops: level -> { gain, cut, rate }
const LOOPS = {
  laser: { max: 10, asset: 'loop_laser', p: (l) => ({ gain: 0.45 + 0.55 * Math.sqrt(Math.min(l, 10) / 10), cut: 1600 + 520 * Math.min(l, 10) }) },
  flame: { max: 10, asset: 'loop_flame', p: (l) => ({ gain: 0.5 + 0.5 * Math.sqrt(Math.min(l, 10) / 10), cut: 1400 + 700 * Math.min(l, 10) }) },
  charge: { max: 1, asset: 'loop_charge', p: (l) => ({ gain: 0.25 + 0.75 * l, cut: 900 + 6000 * l, rate: 0.6 + 1.15 * l }) },
};

const PLAN = [
  { id: 'sfx0', kind: 'sfx', group: 0, w: 1.5 },
  { id: 'menu', kind: 'track', w: 4 },
  { id: 'battle', kind: 'track', w: 6 },
  { id: 'wave', kind: 'stinger', w: 0.6 },
  { id: 'sfx2', kind: 'sfx', group: 2, w: 2 },
  { id: 'boss', kind: 'track', w: 4 },
  { id: 'bossIntro', kind: 'stinger', w: 0.8 },
  { id: 'sfx3', kind: 'sfx', group: 3, w: 1 },
  { id: 'victory', kind: 'stinger', w: 1 },
  { id: 'defeat', kind: 'stinger', w: 1 },
];

let fallbackCtx = null;
function makeBuffer(chs, sr) {
  let b = null;
  try { b = new AudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: sr }); } catch (e) { b = null; }
  if (!b) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!fallbackCtx) fallbackCtx = new OAC(1, 128, 44100);
    b = fallbackCtx.createBuffer(chs.length, chs[0].length, sr);
  }
  for (let c = 0; c < chs.length; c++) {
    if (b.copyToChannel) b.copyToChannel(chs[c], c); else b.getChannelData(c).set(chs[c]);
  }
  return b;
}
function i16ToBuffer(list, sr) {
  let b = null;
  const n = list[0].length;
  try { b = new AudioBuffer({ numberOfChannels: list.length, length: n, sampleRate: sr }); } catch (e) { b = null; }
  if (!b) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!fallbackCtx) fallbackCtx = new OAC(1, 128, 44100);
    b = fallbackCtx.createBuffer(list.length, n, sr);
  }
  for (let c = 0; c < list.length; c++) fromInt16(list[c], b.getChannelData(c));
  return b;
}
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sfxVol = 0.8;
    this.musicVol = 0.55;
    this.paused = false;
    this.mode = 'off';
    this.intensity = 0.5;
    this.sfx = new Map();
    this.tracks = {};
    this.stingerBufs = {};
    this.voices = [];
    this.chains = {};
    this.burstT = -1;
    this.burstN = 0;
    this.lastPlay = Object.create(null);
    this.lastVar = Object.create(null);
    this.loops = {};
    this.cur = null;
    this.old = [];
    this.holdUntil = 0;
    this.pendingHit = null;
    this.lastMenuEnd = -1e9;
    this.rng = makeRng(0x5eed);
    this.ready = {};
    this.stats = { prepMs: 0, steps: {}, log: [], cacheHits: 0, cacheMisses: 0 };
    this._prep = null;
    this._progress = [];
    this.progress = 0;
    // selectable soundtrack: rendered lazily (only the tracks needed), one at a time
    this.bgmChoice = 'auto';
    this.inMatch = false;
    this.matchBgm = null;
    this.previewId = null;
    this.randomNext = null;
    this.lastRandom = null;
    this.bgmJob = null;
    this.bgmHost = null;
    this.bgmProgress = {};
    this.bgmFailed = {};
    // Offline rendering needs no user gesture: start soon after boot so sounds are ready early.
    this._autoPrep = setTimeout(() => this.prepare(), 700);
  }

  // ================================================================== context / graph
  unlock() {
    try {
      if (!this.ctx) this._createContext();
      const c = this.ctx;
      if (c && !this.paused && c.state !== 'running' && c.state !== 'closed') { const p = c.resume(); if (p && p.catch) p.catch(() => {}); }
    } catch (e) { /* audio unavailable */ }
    this.prepare();
  }

  _createContext() {
    if (this.ctxFailed) return;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { this.ctxFailed = true; return; }
    let ctx = null;
    try {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      this._buildGraph(ctx);
      this.ctx = ctx; // only once the whole graph exists
    } catch (e) {
      this.ctxFailed = true; // never retry: one AudioContext per app, ever
      try { if (ctx) ctx.close(); } catch (e2) { /* ignore */ }
      return;
    }
    ctx.onstatechange = () => { if (ctx.state === 'running') this._tick(); };
    this._timer = setInterval(() => this._tick(), 200);
    setTimeout(() => this._initReverb(), 30);
  }

  _buildGraph(ctx) {
    const g = (v = 1, to = null) => { const n = ctx.createGain(); n.gain.value = v; if (to) n.connect(to); return n; };
    // master: trim -> limiter -> out
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 1; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.16;
    lim.connect(ctx.destination);
    this.limiter = lim;
    this.master = g(MASTER_TRIM, lim);
    // music
    this.musicDuck = g(1, this.master);
    this.musicBus = g(this.musicVol * MUSIC_TRIM, this.musicDuck);
    this.stingerBus = g(this._stingerVol(), this.master);
    // sfx: categories -> glue comp -> sfx volume -> master; one shared reverb send
    this.sfxBus = g(this.sfxVol, this.master);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 2.5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.sfxPre = g(0.62, comp); // offsets the glue compressor's makeup gain
    comp.connect(this.sfxBus);
    this.cats = {};
    for (const k in CATS) this.cats[k] = g(CATS[k], this.sfxPre);
    this.revIn = g(1);
    this.revOut = g(0.55, this.sfxPre);
  }

  _initReverb() {
    const ctx = this.ctx;
    if (!ctx || this.reverb) return;
    try {
      const sr = ctx.sampleRate;
      const ir = makeIR(sr, { len: 1.5, rt60: 1.25, pre: 0.012, hf0: 7500, hf1: 1800, width: 0.15, seed: 99, early: 10, earlyLen: 0.05 });
      const b = makeBuffer(ir, sr);
      const cv = ctx.createConvolver();
      cv.normalize = false;
      cv.buffer = b;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 220; hp.Q.value = 0.6;
      this.revIn.connect(hp); hp.connect(cv); cv.connect(this.revOut);
      this.reverb = cv;
    } catch (e) { this.reverb = null; }
  }

  _stingerVol() { return Math.max(this.musicVol, this.sfxVol * 0.8) * MUSIC_TRIM; }

  setVolumes(sfx, music) {
    this.sfxVol = clamp(+sfx || 0, 0, 1);
    this.musicVol = clamp(+music || 0, 0, 1);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.sfxVol, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.musicVol * MUSIC_TRIM, t, 0.05);
    this.stingerBus.gain.setTargetAtTime(this._stingerVol(), t, 0.05);
  }

  pause() {
    this.paused = true;
    const c = this.ctx;
    if (c && c.state === 'running') { const p = c.suspend(); if (p && p.catch) p.catch(() => {}); }
  }

  resume() {
    this.paused = false;
    const c = this.ctx;
    if (c && c.state !== 'running' && c.state !== 'closed') { const p = c.resume(); if (p && p.catch) p.catch(() => {}); }
  }

  // ================================================================== preparation
  prepare(onProgress) {
    if (typeof onProgress === 'function') { this._progress.push(onProgress); try { onProgress(this.progress, 'audio'); } catch (e) { /* ignore */ } }
    if (this._prep) return this._prep;
    clearTimeout(this._autoPrep);
    this._prep = this._runPrep().catch((e) => { this.stats.error = String(e && e.message || e); });
    return this._prep;
  }

  _emit(p, label) {
    this.progress = p;
    for (const f of this._progress) { try { f(p, label); } catch (e) { /* ignore */ } }
  }

  // render pool, main-thread budget and PCM cache, shared by the base set and the soundtrack
  _setupInfra() {
    if (!this._infra) {
      this._infra = (async () => {
        const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        this.pool = new RenderPool(hc >= 10 ? 6 : clamp(hc - 2, 2, 4));
        this.budget = new Budget(6);
        this.pool.budget = this.budget;
        this.cache = new AudioCache(ENGINE_VERSION);
        if (!this.noCache) await this.cache.open();
        // renders of older soundtrack revisions are dead weight
        if (this.cache.db) this.cache.prune((k) => !k.startsWith('mus|bgm@') || k.startsWith(`mus|${BGM_KEY}`));
      })();
    }
    return this._infra;
  }

  async _runPrep() {
    if (!offlineSupported) { this._emit(1, 'unsupported'); return; }
    const T0 = perfNow();
    await this._setupInfra();
    // pure-JS DSP (normalization, sequencing, mastering, SFX finishing) runs in a Worker
    this.host = new DspHost(this.budget, !this.noWorker);
    const keep = !!this.cache.db; // produce Int16 PCM for the cache only when it is usable
    const queue = PLAN.slice();
    const total = queue.reduce((s, x) => s + x.w, 0);
    let done = 0;
    let order = 0;
    const run = async (step) => {
      const t0 = perfNow();
      const pool = this.pool.withPrio(order++);
      const exec = () => (step.kind === 'sfx' ? this._prepSfxGroup(step.group, pool, keep)
        : step.kind === 'track' ? this._prepTrack(step.id, pool, keep) : this._prepStinger(step.id, pool, keep));
      for (let attempt = 0; attempt < 2 && !this.ready[step.id]; attempt++) { // one retry (e.g. a worker died)
        try {
          await exec();
          this.ready[step.id] = true;
        } catch (e) {
          this.stats.log.push({ step: step.id, attempt, error: String(e && e.message || e) });
        }
      }
      this.stats.steps[step.id] = Math.round(perfNow() - t0);
      done += step.w;
      this._emit(Math.min(0.999, done / total), step.id);
      this._tick();
    };
    // Two steps in flight: while one does main-thread work (sequencing, mastering) the next one
    // keeps the render threads busy. The track the game currently wants always jumps the queue.
    const inflight = new Set();
    while (queue.length || inflight.size) {
      while (queue.length && inflight.size < 2) {
        const want = TRACK_OF[this.mode];
        let i = queue.findIndex((q) => q.kind === 'track' && q.id === want);
        if (i < 0 && this.mode === 'boss') i = queue.findIndex((q) => q.id === 'battle');
        if (i < 0) i = 0;
        const step = queue.splice(i, 1)[0];
        const p = run(step).then(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.race(inflight);
    }
    this._emit(1, 'done'); // exact 1.0 (the weight sum above is floating point)
    this.stats.prepMs = Math.round(perfNow() - T0);
    this.stats.memoryBytes = this.memoryBytes();
    this.stats.pool = this.pool.stats;
    this.stats.yields = this.budget.yields;
    this.stats.host = this.host.stats;
    this.stats.worker = !!this.host.worker;
    this.host.dispose();
  }

  async _prepSfxGroup(group, pool, keep) {
    const names = Object.keys(SFX).filter((n) => (SFX[n].group ?? 2) === group);
    await Promise.all(names.map((n) => this._prepSfx(n, pool, keep)));
  }

  async _prepSfx(name, pool = this.pool, keep = false) {
    const def = SFX[name];
    const sr = def.sr || 32000, ch = def.ch || 1;
    const key = `sfx|${name}`;
    const hit = await this.cache.get(key);
    let bufs = null;
    if (hit && hit.sr === sr && hit.v && hit.v.length === def.v) {
      try { bufs = hit.v.map((list) => i16ToBuffer(list, sr)); this.stats.cacheHits++; } catch (e) { bufs = null; }
    }
    if (!bufs) {
      this.stats.cacheMisses++;
      const vars = await Promise.all(Array.from({ length: def.v }, (_, vi) => pool.run({
        sr, ch, dur: def.dur, label: name,
        build: (ctx, dest) => { const out = ctx.createGain(); out.connect(dest); def.build(ctx, out, makeRng(hashStr(name) + vi * 7919), vi); },
      }).then((buf) => {
        const chs = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).slice());
        return this.host.call('sfx', { chs, sr, loop: def.loop || 0, xfade: def.xfade || 0.2, level: def.level, int16: keep });
      })));
      bufs = vars.map((r) => makeBuffer(r.chs, sr));
      if (keep) this.cache.put(key, { sr, v: vars.map((r) => r.pcm) });
    }
    this.sfx.set(name, { def, bufs });
  }

  // ctl (soundtrack renders): { cancelled, onProgress } - see renderTrack
  async _prepTrack(id, pool = this.pool, keep = false, ctl = null, host = this.host) {
    const T = ALL_TRACKS[id];
    const ck = BGM_TRACKS[id] ? `${BGM_KEY}${id}` : id; // soundtrack renders carry their revision
    const man = await this.cache.get(`mus|${ck}`);
    if (man && man.sr === T.sr && man.segs) {
      try {
        const segs = {};
        let n = 0;
        for (const s of man.segs) {
          const stems = {};
          for (const st of T.stems) {
            if (ctl && ctl.cancelled) throw new Error('cancelled');
            const rec = await this.cache.get(`mus|${ck}|${s.id}|${st}`);
            if (!rec || !rec.sr || !rec.pcm) throw new Error('miss');
            stems[st] = i16ToBuffer(rec.pcm, rec.sr);
            if (ctl && ctl.onProgress) ctl.onProgress(++n / (man.segs.length * T.stems.length));
            await this.budget.tick();
          }
          segs[s.id] = { bars: s.bars, stems };
        }
        this._installTrack(id, segs);
        this.stats.cacheHits++;
        return;
      } catch (e) { if (ctl && ctl.cancelled) throw e; /* else fall through: render */ }
    }
    this.stats.cacheMisses++;
    const r = await renderTrack(T, pool, this.budget, (info) => this.stats.log.push(info), host, keep, ctl);
    const segs = {};
    for (const s of r.segments) {
      const stems = {};
      for (const st of T.stems) { stems[st] = makeBuffer(s.stems[st], s.rates[st]); await this.budget.tick(); }
      segs[s.id] = { bars: s.bars, stems };
    }
    this._installTrack(id, segs); // even if superseded meanwhile: it is cached, the GC frees memory
    if (keep) { // serialized background writes; the manifest goes last so partial writes never count
      for (const s of r.segments) for (const st of T.stems) this.cache.put(`mus|${ck}|${s.id}|${st}`, { sr: s.rates[st], pcm: s.pcm[st] });
      this.cache.put(`mus|${ck}`, { sr: T.sr, segs: r.segments.map((s) => ({ id: s.id, bars: s.bars })) });
    }
  }

  _installTrack(id, segs) {
    const T = ALL_TRACKS[id];
    let energy = null;
    for (const s of T.sections) if (s.energy != null) (energy || (energy = {}))[s.id] = s.energy;
    this.tracks[id] = { id, bpm: T.bpm, barDur: 240 / T.bpm, stems: T.stems, segs, next: T.next, first: T.first, entry: T.entry || null, energy, bgm: !!BGM_TRACKS[id] };
  }

  async _prepStinger(name, pool = this.pool, keep = false) {
    const key = `stg|${name}`;
    const hit = await this.cache.get(key);
    if (hit && hit.sr && hit.pcm) {
      try { this.stingerBufs[name] = { buf: i16ToBuffer(hit.pcm, hit.sr), hit: STINGERS[name].hit }; this.stats.cacheHits++; return; } catch (e) { /* render */ }
    }
    this.stats.cacheMisses++;
    const r = await renderStinger(name, pool, this.budget, (info) => this.stats.log.push(info), this.host, keep);
    this.stingerBufs[name] = { buf: makeBuffer(r.chs, r.sr), hit: r.hit };
    if (keep) this.cache.put(key, { sr: r.sr, pcm: r.pcm });
  }

  memoryBytes() {
    let b = 0;
    const add = (x) => { if (x) b += x.length * x.numberOfChannels * 4; };
    for (const a of this.sfx.values()) a.bufs.forEach(add);
    for (const k in this.tracks) for (const s of Object.values(this.tracks[k].segs)) for (const st in s.stems) add(s.stems[st]);
    for (const k in this.stingerBufs) add(this.stingerBufs[k].buf);
    return b;
  }

  // ================================================================== SFX
  play(name, o = {}) {
    if (STINGER_ALIASES[name] && !SFX[name]) { this.stinger(STINGER_ALIASES[name]); return; }
    const ctx = this.ctx;
    if (!ctx || this.paused || this.sfxVol <= 0.001 || ctx.state !== 'running') return;
    let rate = 1, gmul = 1;
    if (name === 'explode') { const t = explodeTier(o.size); name = t.name; rate = t.rate; gmul = t.gain; }
    else if (ALIASES[name]) name = ALIASES[name];
    if (name === 'rail' && o.size > 1.2) { rate = 0.9; gmul = 1.25; }
    const a = this.sfx.get(name);
    if (!a) { if (SFX[name] && SFX[name].cat === 'ui') this._blip(name); return; }
    const def = a.def;
    const pri = def.pri || 0;
    const t = ctx.currentTime;
    const last = this.lastPlay[name];
    if (last !== undefined && t - last < def.th && t >= last) return;
    // per-frame start budget: a burst of low-priority events can't flood the audio graph
    if (t - this.burstT > 0.02 || t < this.burstT) { this.burstT = t; this.burstN = 0; }
    if (this.burstN >= 10 && pri < 2) return;
    this.burstN++;
    this.lastPlay[name] = t;
    this._reap(t);
    let same = 0, oldest = null;
    for (const v of this.voices) if (v.name === name) { same++; if (!oldest || v.start < oldest.start) oldest = v; }
    if (same >= def.max && oldest) { this._kill(oldest, t); same--; }
    if (this.voices.length >= MAX_VOICES) {
      let victim = null;
      for (const v of this.voices) if (v.pri <= pri && (!victim || v.pri < victim.pri || (v.pri === victim.pri && v.start < victim.start))) victim = v;
      if (!victim) return;
      this._kill(victim, t);
    }
    const bufs = a.bufs;
    let vi = bufs.length > 1 ? this.rng.int(bufs.length) : 0;
    if (bufs.length > 1 && vi === this.lastVar[name]) vi = (vi + 1) % bufs.length;
    this.lastVar[name] = vi;
    const src = ctx.createBufferSource();
    src.buffer = bufs[vi];
    const vary = def.vary || 0;
    const r = clamp(o.pitch || 1, 0.5, 2) * rate * (1 + (this.rng() * 2 - 1) * vary);
    src.playbackRate.value = r;
    // pooled gain -> panner -> (category bus + reverb send) chain: only the source is new
    const c = this._chain(def.cat);
    // density attenuation keeps a wall of identical shots from stacking up in loudness
    const gain = clamp(o.gain == null ? 1 : +o.gain, 0, 2) * gmul * (1 - this.rng() * 0.1) / (1 + 0.14 * same);
    if (c.auto) { c.g.gain.cancelScheduledValues(0); c.auto = false; } // a fade from a stolen voice
    c.g.gain.value = gain;
    const pan = clamp(+o.pan || 0, -1, 1) * 0.85;
    if (c.p && c.pan !== pan) { c.p.pan.value = pan; c.pan = pan; }
    const send = this.reverb ? def.send || 0 : 0;
    if (c.send !== send) { c.s.gain.value = send; c.send = send; }
    src.connect(c.g);
    src.start(t);
    const v = { name, src, c, start: t, end: t + bufs[vi].duration / r + 0.05, pri, done: false };
    src.onended = () => this._release(v);
    this.voices.push(v);
    if (def.duck) this._duck(this.cats.weapons.gain, 1 - def.duck, t, 0.12, 0.35);
  }

  _chain(cat) {
    const pool = this.chains[cat] || (this.chains[cat] = []);
    const c = pool.pop();
    if (c) return c;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const s = ctx.createGain();
    s.gain.value = 0;
    const out = this.cats[cat] || this.cats.impacts;
    if (p) { g.connect(p); p.connect(out); p.connect(s); } else { g.connect(out); g.connect(s); }
    s.connect(this.revIn);
    return { g, p, s, cat, pan: 0, send: 0, auto: false };
  }

  _release(v) {
    if (v.done) return;
    v.done = true;
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    try { v.src.disconnect(); } catch (e) { /* ignore */ }
    const pool = this.chains[v.c.cat];
    if (pool && pool.length < 48) pool.push(v.c);
  }

  _kill(v, t) {
    try { v.c.auto = true; v.c.g.gain.cancelScheduledValues(t); v.c.g.gain.setTargetAtTime(0, t, 0.008); v.src.stop(t + 0.05); } catch (e) { /* already stopped */ }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  _reap(t) {
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < t) this.voices.splice(i, 1);
  }

  _duck(param, level, t, hold, rel) {
    try { param.cancelScheduledValues(t); param.setTargetAtTime(level, t, 0.012); param.setTargetAtTime(1, t + hold, rel / 3); } catch (e) { /* ignore */ }
  }

  // tiny real-time fallback for UI feedback before the first renders are ready
  _blip(name) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (this.lastPlay[`blip:${name}`] > t - 0.05) return;
    this.lastPlay[`blip:${name}`] = t;
    const f = name === 'error' ? 180 : 900 + (hashStr(name) % 600);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (name === 'error' ? 0.8 : 1.25), t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.01, 0.02);
    o.connect(g); g.connect(this.cats.ui);
    o.start(t); o.stop(t + 0.15);
  }

  // ================================================================== loops
  setHum(level) { this.setLoop('laser', level); }

  setLoop(name, level) {
    const def = LOOPS[name];
    if (!def) return;
    const L = this.loops[name] || (this.loops[name] = { level: 0, applied: -1, node: null, stopAt: 0 });
    L.level = clamp(+level || 0, 0, def.max);
    this._updateLoop(name, L);
  }

  _updateLoop(name, L) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.cats) return;
    const lvl = this.paused ? 0 : L.level;
    const need = lvl > 0 && !L.node;
    if (!need && !L.node) { L.applied = lvl; return; } // silent and nothing playing: just record
    if (!need && Math.abs(lvl - L.applied) < 0.01) return;
    const def = LOOPS[name];
    const a = this.sfx.get(def.asset);
    if (!a) return;
    const t = ctx.currentTime;
    if (need) {
      const src = ctx.createBufferSource();
      src.buffer = a.bufs[0];
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 0.7; f.frequency.value = def.p(lvl).cut;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.cats[a.def.cat] || this.cats.weapons);
      src.start(t, this.rng() * a.bufs[0].duration);
      L.node = { src, f, g };
    }
    const p = def.p(Math.max(lvl, 0.0001));
    const n = L.node;
    n.g.gain.setTargetAtTime(lvl > 0 ? p.gain : 0, t, lvl > 0 ? 0.07 : 0.15);
    n.f.frequency.setTargetAtTime(p.cut, t, 0.12);
    if (p.rate) n.src.playbackRate.setTargetAtTime(p.rate, t, 0.09);
    L.stopAt = lvl > 0 ? 0 : t + 1.0;
    L.applied = lvl;
  }

  _tickLoops(t) {
    for (const name in this.loops) {
      const L = this.loops[name];
      if (L.level > 0 && !L.node) this._updateLoop(name, L);
      if (L.node && L.stopAt && t > L.stopAt) {
        try { L.node.src.stop(); L.node.src.disconnect(); L.node.g.disconnect(); } catch (e) { /* ignore */ }
        L.node = null; L.stopAt = 0; L.applied = -1;
      }
    }
  }

  // ================================================================== music
  setMusic(mode) {
    if (MODES.indexOf(mode) < 0) return;
    if (this.inMatch && (mode === 'menu' || mode === 'off')) { // the match is over
      this.inMatch = false;
      if (this.bgmChoice === 'random' && !this.randomNext) this.randomNext = this._pickRandom();
      this._bgmPlan();
    }
    this.mode = mode;
    this._tick();
  }

  // ================================================================== selectable soundtrack
  setBgmChoice(choice) {
    const c = choice === 'random' || BGM_TRACKS[choice] ? choice : 'auto';
    if (c === this.bgmChoice) return;
    this.bgmChoice = c;
    if (c === 'random' && !this.randomNext) this.randomNext = this._pickRandom();
    if (this.inMatch) this.matchBgm = this._resolveChoice(true); // applies to the running match
    this._bgmPlan();
    this._tick();
  }

  beginMatch() {
    this.inMatch = true;
    this.previewId = null; // a settings preview never outlives the menus
    this.matchBgm = this._resolveChoice(false);
    this._bgmPlan();
  }

  _resolveChoice(midMatch) {
    const c = this.bgmChoice;
    if (c !== 'random') return BGM_TRACKS[c] ? c : null;
    if (midMatch && this.matchBgm && BGM_TRACKS[this.matchBgm]) return this.matchBgm; // keep playing
    // the pick prepared in the menus; a restart without a menu visit replays the loaded one
    const id = this.randomNext && BGM_TRACKS[this.randomNext] ? this.randomNext
      : this.lastRandom && this.tracks[this.lastRandom] ? this.lastRandom : this._pickRandom();
    this.lastRandom = id;
    this.randomNext = null; // the next match gets a fresh pick (prepared once back in the menus)
    return id;
  }

  _pickRandom() {
    const all = BGM_LIST.map((x) => x.id);
    const ids = all.filter((id) => id !== this.lastRandom && !this.bgmFailed[id]);
    const from = ids.length ? ids : all;
    return from[Math.floor(Math.random() * from.length)] || null;
  }

  // Settings preview: plays the track (full arrangement) while the picker is open; null restores
  // whatever the game wants. 'auto' previews the built-in battle theme.
  preview(id) {
    const p = id === 'auto' ? 'battle' : id && (BGM_TRACKS[id] || id === 'battle') ? id : null;
    if (p === this.previewId) return;
    this.previewId = p;
    this._bgmPlan();
    this._tick();
  }

  bgmState(id) {
    const tid = id === 'auto' ? 'battle' : id;
    return {
      ready: !!this.tracks[tid], progress: this.bgmProgress[tid] || 0, failed: (this.bgmFailed[tid] || 0) >= 2,
      rendering: !!(this.bgmJob && this.bgmJob.id === tid), playing: !!(this.cur && this.cur.id === tid),
    };
  }

  // soundtrack tracks needed right now, most urgent first
  _bgmWanted() {
    const w = [];
    const add = (id, urgent) => { if (id && BGM_TRACKS[id] && !w.some((x) => x.id === id)) w.push({ id, urgent }); };
    add(this.previewId, true);
    if (this.inMatch) add(this.matchBgm, false);
    add(this.bgmChoice === 'random' ? (this.inMatch ? null : this.randomNext) : this.bgmChoice, false);
    return w;
  }

  _bgmPlan() {
    const wanted = this._bgmWanted();
    const job = this.bgmJob;
    if (job && !job.ctl.cancelled) {
      // drop a render nobody needs any more, or one that holds up a preview
      const top = wanted.find((x) => !this.tracks[x.id]);
      if (!wanted.some((x) => x.id === job.id) || (top && top.urgent && top.id !== job.id)) job.ctl.cancelled = true;
    }
    this._gcBgm(wanted);
    this._pumpBgm();
  }

  // keep only the soundtrack tracks that are wanted or still audible (memory)
  _gcBgm(wanted = this._bgmWanted()) {
    const keep = new Set(wanted.map((x) => x.id));
    if (this.cur) keep.add(this.cur.id);
    for (const o of this.old) keep.add(o.id);
    for (const id of Object.keys(this.tracks)) if (BGM_TRACKS[id] && !keep.has(id)) delete this.tracks[id];
  }

  // one soundtrack render at a time, in the background; previews jump the queue
  _pumpBgm() {
    if (this.bgmJob) return;
    const next = this._bgmWanted().find((x) => !this.tracks[x.id] && (this.bgmFailed[x.id] || 0) < 2);
    if (!next) {
      if (this.bgmHost) { this.bgmHost.dispose(); this.bgmHost = null; }
      return;
    }
    const ctl = { cancelled: false, onProgress: (p) => { this.bgmProgress[next.id] = Math.max(this.bgmProgress[next.id] || 0, p); } };
    const job = { id: next.id, ctl };
    this.bgmJob = job;
    this.bgmProgress[next.id] = 0;
    (async () => {
      try {
        if (!offlineSupported) throw new Error('unsupported');
        const base = this.prepare(); // the base set owns the shared render infrastructure
        await this._setupInfra();
        if (!next.urgent) await base; // background renders wait for SFX / menu / battle first
        if (ctl.cancelled) throw new Error('cancelled');
        if (!this.bgmHost) this.bgmHost = new DspHost(this.budget, !this.noWorker, 1);
        const t0 = perfNow();
        await this._prepTrack(next.id, this.pool.withPrio(next.urgent ? -1 : 50), !!this.cache.db, ctl, this.bgmHost);
        this.stats.steps[`bgm:${next.id}`] = Math.round(perfNow() - t0);
        this.bgmProgress[next.id] = 1;
      } catch (e) {
        this.bgmProgress[next.id] = 0;
        if (!ctl.cancelled) {
          this.bgmFailed[next.id] = (this.bgmFailed[next.id] || 0) + 1;
          this.stats.log.push({ step: `bgm:${next.id}`, error: String((e && e.message) || e) });
        }
      } finally {
        if (this.bgmJob === job) this.bgmJob = null;
        this._gcBgm();
        this._tick();
        this._pumpBgm();
      }
    })();
  }

  setIntensity(x) {
    this.intensity = clamp(+x || 0, 0, 1);
  }

  _nextBar(inst, from) {
    const k = Math.ceil((from - inst.origin) / inst.barDur - 1e-6);
    return inst.origin + Math.max(0, k) * inst.barDur;
  }
  _nextBeat(inst, from) {
    const bd = inst.barDur / 4;
    const k = Math.ceil((from - inst.origin) / bd - 1e-6);
    return inst.origin + Math.max(0, k) * bd;
  }

  _tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.paused) return;
    const t = ctx.currentTime;
    this._tickLoops(t);
    let want = this._want();
    if (t < this.holdUntil) want = null;
    const curId = this.cur ? this.cur.id : null;
    if (want !== curId) this._switch(want, t);
    if (this.cur) { this._schedule(t); this._mix(t, false); }
    if (this.old.length) this._reapOld(t);
  }

  // the track that should play: a settings preview, else the match's chosen soundtrack (build /
  // battle / boss), else the built-in score. Anything not rendered yet keeps the current music
  // (or the built-in fallback) until it is ready.
  _want() {
    const base = TRACK_OF[this.mode] || null;
    let want = base;
    const cur = this.cur ? this.cur.id : null;
    if (this.previewId) want = this.tracks[this.previewId] ? this.previewId : cur || base;
    else if (base && base !== 'menu' && this.inMatch && this.matchBgm) {
      // a newly chosen soundtrack still rendering: keep the soundtrack that plays, else the built-in
      if (this.tracks[this.matchBgm]) want = this.matchBgm;
      else if (cur && this.tracks[cur] && this.tracks[cur].bgm) want = cur;
    }
    if (want === 'boss' && !this.tracks.boss) want = 'battle';
    if (want && !this.tracks[want]) want = this.cur ? this.cur.id : null;
    return want;
  }

  _switch(to, t) {
    const from = this.cur;
    let T = t + 0.08;
    if (from) {
      if (from.id === 'menu') this.lastMenuEnd = t;
      if (this.hardStop) {
        T = t + 0.02;
        this._fadeOut(from, T, 0.12);
      } else {
        T = this._nextBar(from, t + 0.06);
        if (T - t > 2.3) T = this._nextBeat(from, t + 0.06);
        if (to === 'boss' && this.pendingHit && this.pendingHit > t && this.pendingHit - t < 2.5) T = this.pendingHit;
        const tau = !to ? 0.5 : to === 'boss' ? 0.05 : from.id === 'menu' ? 0.6 : to === 'menu' ? 0.7 : 0.25;
        this._fadeOut(from, T, tau);
      }
    }
    this.hardStop = false;
    this.cur = null;
    if (!to) return;
    const tr = this.tracks[to];
    const inst = this._instance(to, T);
    const fadeIn = !from ? (to === 'menu' ? 2.5 : 1.2) : to === 'boss' ? 0 : from.id === 'menu' || to === 'menu' ? 1.6 : 0.6;
    const p = inst.out.gain;
    if (fadeIn > 0) { p.setValueAtTime(0, T); p.linearRampToValueAtTime(1, T + fadeIn); } else p.setValueAtTime(1, T);
    // back to the menu soon after leaving it: skip the intro; a soundtrack that becomes ready in the
    // middle of a fight enters on a full section instead of its intro
    const fight = (this.mode === 'battle' || this.mode === 'boss') && to !== this.previewId;
    inst.nextSec = to === 'menu' && t - this.lastMenuEnd < 30 ? 'A' : tr.entry && fight ? tr.entry : tr.first;
    this.cur = inst;
    this._mix(t, true);
  }

  _instance(id, T) {
    const ctx = this.ctx;
    const tr = this.tracks[id];
    // out carries the fade-in ramp, fade the (setTarget-only) fade-out: cancelling automation on a
    // param with a pending ramp would drop the ramp and snap the gain, so they never share a param
    const fade = ctx.createGain();
    fade.connect(this.musicBus);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(fade);
    const stems = {};
    let bedFilter = null;
    for (const st of tr.stems) {
      const g = ctx.createGain();
      g.gain.value = 0;
      if (st === 'bed') {
        bedFilter = ctx.createBiquadFilter();
        bedFilter.type = 'lowpass'; bedFilter.Q.value = 0.5; bedFilter.frequency.value = 18000;
        g.connect(bedFilter); bedFilter.connect(out);
      } else g.connect(out);
      stems[st] = g;
    }
    return { id, out, fade, stems, bedFilter, origin: T, barDur: tr.barDur, nextT: T, nextSec: tr.first, sec: null, voices: [], mixMode: null, heat: -1 };
  }

  _pickNext(tr, sec) {
    const opts = tr.next[sec] || {};
    const keys = Object.keys(opts);
    if (!keys.length) return tr.first;
    // soundtrack sections carry an energy level: boss fights and heavy pressure lean toward the
    // big sections, calm build phases a little toward the lighter ones
    const E = tr.energy;
    const bias = !E || this.previewId === tr.id ? null : this.mode === 'boss' ? ENERGY_BIAS.boss
      : this.mode === 'battle' && this.intensity > 0.55 ? ENERGY_BIAS.hot : this.mode === 'build' ? ENERGY_BIAS.build : null;
    const w = keys.map((k) => opts[k] * (bias && E[k] != null ? bias[E[k]] : 1));
    let r = this.rng() * w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < keys.length; i++) { r -= w[i]; if (r <= 0) return keys[i]; }
    return keys[keys.length - 1];
  }

  _schedule(t) {
    const c = this.cur;
    const tr = this.tracks[c.id];
    if (c.nextT < t - 0.02) { // stalled (e.g. long main-thread hitch): restart the grid
      c.nextT = t + 0.05;
      c.origin = c.nextT;
    }
    while (c.nextT < t + LOOKAHEAD) {
      const seg = tr.segs[c.nextSec] || tr.segs[tr.first];
      for (const st of tr.stems) {
        const b = seg.stems[st];
        if (!b) continue;
        const src = this.ctx.createBufferSource();
        src.buffer = b;
        src.connect(c.stems[st]);
        src.start(c.nextT);
        const v = { src, t0: c.nextT, end: c.nextT + b.duration };
        src.onended = () => { try { src.disconnect(); } catch (e) { /* ignore */ } };
        c.voices.push(v);
      }
      c.sec = c.nextSec;
      c.nextT += seg.bars * c.barDur;
      c.nextSec = this._pickNext(tr, c.sec);
    }
    if (c.voices.length > 12) c.voices = c.voices.filter((v) => v.end > t);
  }

  // stem levels for the current mode (quantized to the next bar when the mode changes)
  _mix(t, immediate) {
    const c = this.cur;
    const tr = this.tracks[c.id];
    if (tr && tr.bgm && c.stems.bed && c.stems.drums && c.stems.heat) { this._mixBgm(c, t, immediate); return; }
    const mode = this.mode;
    const setAt = (p, v, T, tau) => { p.cancelScheduledValues(T); p.setTargetAtTime(v, T, tau); };
    if (c.id === 'battle') {
      const preview = this.previewId === 'battle'; // settings preview of the built-in score
      const battle = preview || (mode !== 'build' && mode !== 'menu');
      const key = preview ? 'preview' : battle ? 'battle' : 'build';
      const heat = preview ? 0.75 : battle ? smooth(0.06, 0.72, this.intensity) : 0;
      if (c.mixMode !== key) {
        // enter on the bar where a just-requested wave/boss stinger hits, else the next bar
        const hit = this.pendingHit;
        const T = immediate ? c.origin : hit && hit > t + 0.02 && hit - t < 2.5 ? hit : this._nextBar(c, t + 0.03);
        const S = c.stems;
        if (battle) {
          setAt(S.bed.gain, 1, T, 0.05);
          setAt(S.drums.gain, 1, T, 0.012);
          setAt(S.heat.gain, heat, T, 0.35);
          setAt(c.bedFilter.frequency, 18000, T, 0.25);
        } else {
          setAt(S.bed.gain, 0.72, T, immediate ? 0.01 : 0.6);
          setAt(S.drums.gain, 0, T, immediate ? 0.01 : 0.22);
          setAt(S.heat.gain, 0, T, immediate ? 0.01 : 0.5);
          setAt(c.bedFilter.frequency, 3000, T, immediate ? 0.01 : 0.7);
        }
        c.mixMode = key;
        c.modeT = T;
        c.heat = heat;
      } else if (battle && t > c.modeT + 0.5 && Math.abs(heat - c.heat) > 0.025) {
        c.stems.heat.gain.setTargetAtTime(heat, t, 0.9);
        c.heat = heat;
      }
    } else if (c.id === 'boss') {
      const heat = 0.5 + 0.5 * smooth(0, 0.8, this.intensity);
      if (c.mixMode !== 'boss') {
        setAt(c.stems.base.gain, 1, c.origin, 0.01);
        setAt(c.stems.heat.gain, heat, c.origin, 0.01);
        c.mixMode = 'boss'; c.modeT = c.origin; c.heat = heat;
      } else if (t > c.modeT + 0.5 && Math.abs(heat - c.heat) > 0.025) {
        c.stems.heat.gain.setTargetAtTime(heat, t, 0.9);
        c.heat = heat;
      }
    } else if (c.mixMode !== 'on') {
      for (const st in c.stems) setAt(c.stems[st].gain, 1, c.origin, 0.01);
      c.mixMode = 'on';
    }
  }

  // Soundtrack stems. build: the bed alone, low-passed (the kit enters with the wave on a bar);
  // battle: heat follows the pressure from an audible floor so the hook never vanishes; boss: near
  // full; preview: the whole arrangement.
  _mixBgm(c, t, immediate) {
    const T = ALL_TRACKS[c.id];
    const S = c.stems;
    const setAt = (p, v, at, tau) => { p.cancelScheduledValues(at); p.setTargetAtTime(v, at, tau); };
    const x = this.intensity;
    let key, bed = 1, drums = 1, heat, cut = 18000;
    if (this.previewId === c.id) { key = 'preview'; heat = 1; } else if (this.mode === 'boss') { key = 'boss'; heat = 0.7 + 0.3 * smooth(0, 0.8, x); } else if (this.mode === 'battle') {
      key = 'battle';
      const floor = T.heatFloor ?? 0.3;
      heat = floor + (1 - floor) * smooth(0.06, 0.72, x);
    } else { key = 'build'; bed = T.buildBed ?? 0.8; drums = 0; heat = 0; cut = T.buildCut ?? 3200; }
    if (c.mixMode !== key) {
      // enter on the bar where a just-requested wave/boss stinger hits, else the next bar
      const hit = this.pendingHit;
      const at = immediate ? c.origin : hit && hit > t + 0.02 && hit - t < 2.5 ? hit : this._nextBar(c, t + 0.03);
      const calm = key === 'build';
      setAt(S.bed.gain, bed, at, immediate ? 0.01 : calm ? 0.6 : 0.05);
      setAt(S.drums.gain, drums, at, immediate ? 0.01 : calm ? 0.22 : 0.012);
      setAt(S.heat.gain, heat, at, immediate ? 0.01 : calm ? 0.5 : 0.35);
      setAt(c.bedFilter.frequency, cut, at, immediate ? 0.01 : calm ? 0.7 : 0.25);
      c.mixMode = key; c.modeT = at; c.heat = heat;
    } else if ((key === 'battle' || key === 'boss') && t > c.modeT + 0.5 && Math.abs(heat - c.heat) > 0.025) {
      S.heat.gain.setTargetAtTime(heat, t, 0.9);
      c.heat = heat;
    }
  }

  _fadeOut(inst, T, tau) {
    const p = inst.fade.gain;
    try { p.cancelScheduledValues(T); p.setTargetAtTime(0, T, tau); } catch (e) { /* ignore */ }
    for (const v of inst.voices) {
      if (v.t0 >= T - 1e-4) { try { v.src.stop(T); v.src.disconnect(); } catch (e) { /* ignore */ } }
    }
    inst.dead = T + tau * 7 + 0.1;
    this.old.push(inst);
  }

  _reapOld(t) {
    const n = this.old.length;
    this.old = this.old.filter((inst) => {
      if (t < inst.dead) return true;
      for (const v of inst.voices) { try { v.src.stop(); v.src.disconnect(); } catch (e) { /* ignore */ } }
      try { inst.out.disconnect(); inst.fade.disconnect(); } catch (e) { /* ignore */ }
      return false;
    });
    if (this.old.length !== n) this._gcBgm(); // a soundtrack that just faded out may be dropped now
  }

  // ================================================================== stingers
  stinger(name) {
    name = STINGER_ALIASES[name] || name;
    if (!STINGERS[name]) return;
    const ctx = this.ctx;
    if (!ctx || this.paused || ctx.state !== 'running') return;
    this._tick();
    const t = ctx.currentTime;
    const s = this.stingerBufs[name];
    if (!s) { // graceful fallback while the cue is still rendering
      const fb = { wave: ['explode', { size: 1.2 }], bossIntro: ['bossPhase', {}], victory: ['upgrade', {}], defeat: ['leak', {}] }[name];
      if (fb) this.play(fb[0], fb[1]);
      if (name === 'victory' || name === 'defeat') { this.hardStop = true; this.holdUntil = t + 4; this._tick(); }
      return;
    }
    let hitT;
    const musical = name === 'wave' || name === 'bossIntro';
    if (musical && this.cur) {
      hitT = this._nextBar(this.cur, t + 0.15);
      if (hitT - t > 2.3) hitT = this._nextBeat(this.cur, t + 0.15);
    } else hitT = t + 0.03 + s.hit;
    const startT = hitT - s.hit;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    const g = ctx.createGain();
    if (startT < t + 0.02) {
      const off = t + 0.02 - startT;
      g.gain.setValueAtTime(0, t + 0.02);
      g.gain.linearRampToValueAtTime(1, t + 0.06);
      src.start(t + 0.02, off);
    } else src.start(startT);
    src.connect(g);
    g.connect(this.stingerBus);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    if (musical) {
      this._duck(this.musicDuck.gain, 0.5, Math.max(t, hitT - 0.12), 1.0, 1.6);
      this._duck(this.cats.weapons.gain, 0.55, Math.max(t, hitT - 0.05), 0.5, 0.6);
      this.pendingHit = hitT;
    } else {
      this.hardStop = true;
      this.holdUntil = t + s.buf.duration - 2.2;
      this._tick();
    }
  }
}

// The game calls these every frame from the very first frame (before any gesture, while muted,
// after disposal...): no public method may ever throw. State is recorded and applied once the
// context exists and assets are ready.
for (const k of ['unlock', 'pause', 'resume', 'setVolumes', 'play', 'setLoop', 'setHum', 'setMusic', 'setIntensity', 'stinger', '_tick',
  'setBgmChoice', 'beginMatch', 'preview', 'bgmState']) {
  const f = AudioEngine.prototype[k];
  AudioEngine.prototype[k] = function guarded(...args) {
    try { return f.apply(this, args); } catch (e) {
      this._errors = (this._errors || 0) + 1;
      if (this._errors <= 5 && typeof console !== 'undefined') console.warn(`[audio] ${k}:`, e);
      return undefined;
    }
  };
}
{
  const f = AudioEngine.prototype.prepare;
  AudioEngine.prototype.prepare = function guardedPrepare(...args) {
    try { return f.apply(this, args); } catch (e) { return Promise.resolve(); }
  };
}

let vibrationOn = true;
export function setVibration(on) { vibrationOn = !!on; }

export function vibrate(ms) {
  if (!vibrationOn) return;
  try {
    if (window.NativeBridge && window.NativeBridge.vibrate) window.NativeBridge.vibrate(ms);
    else if (navigator.vibrate) navigator.vibrate(ms);
  } catch (e) { /* ignore */ }
}
