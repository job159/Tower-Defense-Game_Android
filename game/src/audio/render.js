// Offline render pool: runs OfflineAudioContext jobs with bounded concurrency (each context renders
// on its own audio thread, so a few in parallel use spare cores without blocking the main thread).
import { now, prof } from './dsp.js';

const OAC = typeof window !== 'undefined' ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
export const offlineSupported = !!OAC;

function startRendering(ctx) {
  return new Promise((res, rej) => {
    let done = false;
    ctx.oncomplete = (e) => { if (!done) { done = true; res(e.renderedBuffer); } };
    let p;
    try { p = ctx.startRendering(); } catch (e) { rej(e); return; }
    if (p && p.then) p.then((b) => { if (!done) { done = true; res(b); } }, rej);
  });
}

export class RenderPool {
  constructor(n = 3) {
    this.n = n;
    this.active = 0;
    this.q = [];
    this.stats = { jobs: 0, buildMs: 0, audioSecs: 0 };
  }

  // job: { sr, ch, dur, build(ctx, destination), prio? } -> Promise<AudioBuffer>
  // Lower prio runs first (FIFO within the same prio); defaults to the pool's current prio.
  run(job) {
    return new Promise((res, rej) => {
      const prio = job.prio ?? this.prio ?? 0;
      const item = { job, res, rej, prio };
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].prio > prio) i--;
      this.q.splice(i, 0, item);
      this.pump();
    });
  }

  // a view of the pool whose jobs carry a fixed priority
  withPrio(prio) {
    return { run: (job) => this.run({ ...job, prio }), stats: this.stats, n: this.n };
  }

  pump() {
    while (this.active < this.n && this.q.length) {
      const { job, res, rej } = this.q.shift();
      this.active++;
      this.exec(job).then(res, rej).then(() => { this.active--; this.pump(); }, () => { this.active--; this.pump(); });
    }
  }

  async exec({ sr, ch, dur, build, label }) {
    if (!OAC) throw new Error('OfflineAudioContext unavailable');
    // graph construction runs on the main thread: never build several graphs in one task. The
    // check must happen right before building (after jobs started earlier have built theirs).
    if (this.budget) { await null; while (this.budget.over) await this.budget.tick(); }
    const len = Math.max(256, Math.ceil(dur * sr));
    const ctx = new OAC(ch, len, sr);
    const t0 = now();
    build(ctx, ctx.destination);
    this.stats.buildMs += now() - t0;
    prof(`build:${label || '?'}`, t0);
    const buf = await startRendering(ctx);
    this.stats.jobs++;
    this.stats.audioSecs += dur;
    return buf;
  }
}
