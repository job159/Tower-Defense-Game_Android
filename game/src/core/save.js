// Persistent progress (localStorage). All reads/writes are guarded: storage may be unavailable.
// v1 saves ({normal, hard} stars per level) load unchanged; v2 adds nightmare stars, challenge stars and loadouts.
import { LEVELS } from './levels.js';
import { RESEARCH } from './config.js';

const KEY = 'neonbastion.save.v1';

const DEFAULT = () => ({
  v: 2,
  levels: {},            // id -> { normal, hard, nightmare: stars 0..3, challenge: bool }
  endless: {},           // map id -> best wave
  research: {},          // research id -> level
  loadouts: {},          // level id -> [tower types]
  settings: { quality: 'auto', sfx: 0.8, music: 0.6, vibrate: true, bgm: 'auto' }, // bgm: 'auto' | 'random' | track id
  tutorial: false,
  run: null,             // snapshot of an unfinished game (taken at wave start)
  seenEnemies: [],
});

export class Save {
  constructor() {
    this.data = DEFAULT();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        this.data = { ...DEFAULT(), ...d, v: 2, settings: { ...DEFAULT().settings, ...(d.settings || {}) } };
        if (typeof this.data.settings.bgm !== 'string') this.data.settings.bgm = 'auto'; // unknown ids fall back to auto in the audio engine
        // snapshots from v1 can't be resumed by the v2 simulation
        if (this.data.run && this.data.run.v !== 2) this.data.run = null;
        // research costs changed in v2: if old allocations now exceed the stars earned, refund them
        if (this.freeStars() < 0) { this.data.research = {}; this.refunded = true; }
      }
    } catch (e) { /* private mode or corrupted: start fresh */ }
  }

  write() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  }

  get settings() { return this.data.settings; }

  stars(id, diff = 'normal') { return (this.data.levels[id] && this.data.levels[id][diff]) || 0; }
  challenge(id) { return !!(this.data.levels[id] && this.data.levels[id].challenge); }

  levelStars(id) {
    const l = this.data.levels[id];
    if (!l) return 0;
    return (l.normal || 0) + (l.hard || 0) + (l.nightmare || 0) + (l.challenge ? 1 : 0);
  }

  totalStars() {
    let n = 0;
    for (const id in this.data.levels) n += this.levelStars(id);
    return n;
  }

  maxStars() { return LEVELS.length * 10; }

  spentStars() {
    let n = 0;
    for (const r of RESEARCH) {
      const lv = this.data.research[r.id] || 0;
      for (let i = 0; i < lv && i < r.costs.length; i++) n += r.costs[i];
    }
    return n;
  }

  freeStars() { return this.totalStars() - this.spentStars(); }

  unlocked(id) { return id === 1 || this.stars(id - 1) > 0; }
  diffUnlocked(id, diff) {
    if (diff === 'normal') return this.unlocked(id);
    if (diff === 'hard') return this.stars(id) > 0;
    return this.stars(id, 'hard') > 0;
  }
  hardUnlocked(id) { return this.diffUnlocked(id, 'hard'); }
  endlessUnlocked() { return this.stars(3) > 0; }
  highestUnlocked() { let n = 1; for (const l of LEVELS) if (this.unlocked(l.id)) n = l.id; return n; }

  recordWin(id, diff, stars, challenge = false) {
    const l = this.data.levels[id] || (this.data.levels[id] = {});
    l[diff] = Math.max(l[diff] || 0, stars);
    if (challenge) l.challenge = true;
    this.write();
  }

  recordEndless(mapId, wave) {
    this.data.endless[mapId] = Math.max(this.data.endless[mapId] || 0, wave);
    this.write();
  }

  bestEndless() {
    let best = 0;
    for (const k in this.data.endless) best = Math.max(best, this.data.endless[k]);
    return best;
  }

  loadout(id) { return this.data.loadouts[id] || null; }
  setLoadout(id, types) { this.data.loadouts[id] = types.slice(); this.write(); }

  buyResearch(id) {
    const r = RESEARCH.find((x) => x.id === id);
    const lv = this.data.research[id] || 0;
    if (!r || lv >= r.costs.length || this.freeStars() < r.costs[lv]) return false;
    this.data.research[id] = lv + 1;
    this.write();
    return true;
  }

  resetResearch() { this.data.research = {}; this.write(); }

  setRun(snap) { this.data.run = snap; this.write(); }
  clearRun() { if (this.data.run) { this.data.run = null; this.write(); } }

  resetAll() {
    const settings = this.data.settings;
    this.data = DEFAULT();
    this.data.settings = settings;
    this.write();
  }
}

export const LEVEL_COUNT = LEVELS.length;
