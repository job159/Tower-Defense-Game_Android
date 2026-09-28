// Tower-defense simulation. Pure logic (no rendering) so it can also run headless for balancing.
// The renderer reads the entity lists directly and consumes `events` every frame.
import {
  TOWERS, ENEMIES, ABILITIES, RESEARCH, ECONOMY, VETERANCY, POWER_NODE, ARMOR_CLASSES, SHIELD_MUL,
  THERMAL_SHOCK, FROZEN_BONUS, BURN, UNLOCK_AT, TOWER_ORDER, LOADOUT_SIZE, towerBaseStats, upgradeCost, damageType,
} from './config.js';
import { buildMap, TILE, tileToWorld, AIR_HEIGHT } from './path.js';
import { generateWave, waveSpawns, waveSummary, hpScale, waveIncome, earlyBonus, DIFFICULTY, levelMutators } from './waves.js';
import { mulberry32 } from './rng.js';

const TMP = { x: 0, z: 0, dx: 0, dz: 0 };
const NO = {};
const THUNDER_HIT = { aoe: true, armorPierce: true };
const AOE = { aoe: true };
const DOT = { dot: true };

export function researchMods(research = {}) {
  const val = (id) => {
    const r = RESEARCH.find((x) => x.id === id);
    const lv = research[id] || 0;
    return r && lv > 0 ? r.values[lv - 1] : 0;
  };
  const ult = new Set(TOWER_ORDER.filter((t) => (research[`ult_${t}`] || 0) > 0));
  return {
    credits: val('credits'), lives: val('lives'), bounty: 1 + val('bounty'),
    refund: Math.max(ECONOMY.refund, val('refund')), damage: 1 + val('damage'), range: 1 + val('range'),
    cost: 1 - val('discount'), cooldown: 1 - val('cooldown'),
    interest: val('interest'), veteran: 1 + val('veteran'),
    thunder: 1 + val('thunder'), ult,
  };
}

// Towers available for a campaign level (loadout pool).
export function unlockedTowers(levelId, endless = false) {
  return TOWER_ORDER.filter((t) => endless || UNLOCK_AT[t] <= levelId);
}

export function defaultLoadout(levelId, endless = false) {
  return unlockedTowers(levelId, endless).slice(0, LOADOUT_SIZE);
}

export class Game {
  constructor(level, opts = {}) {
    this.level = level;
    this.difficulty = opts.difficulty || 'normal';
    this.endless = !!opts.endless;
    this.demo = !!opts.demo;
    this.diff = DIFFICULTY[this.difficulty];
    this.mods = researchMods(opts.research);
    this.mutators = this.endless ? [] : levelMutators(level, this.difficulty);
    this.map = buildMap(level);
    this.rand = mulberry32(opts.seed ?? level.id * 31 + 7);
    const pool = unlockedTowers(level.id, this.endless || this.demo);
    this.loadout = (opts.loadout || defaultLoadout(level.id, this.endless || this.demo)).filter((t) => pool.includes(t));
    if (this.demo) this.loadout = pool;
    this.totalWaves = this.endless ? Infinity : level.waves;
    this.baseLives = this.diff.lives;
    this.maxLives = this.diff.lives + this.mods.lives;
    this.lives = this.maxLives;
    this.credits = Math.round(level.credits * this.diff.credits) + this.mods.credits;
    this.wave = 0;
    this.time = 0;
    this.state = 'play';
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.wells = [];
    this.zones = [];
    this.drones = [];
    this.mines = [];
    this.queue = [];
    this.qi = 0;
    this.events = [];
    this.nextId = 1;
    this.towerAt = new Map();
    this.abilities = {};
    for (const id of level.abilities) this.abilities[id] = { cd: 0, max: ABILITIES[id].cooldown * this.mods.cooldown };
    this.stasisT = 0;
    this.autoTimer = 0;
    this.stats = { kills: 0, leaked: 0, leakedAir: 0, earned: 0, spent: 0, sold: 0, interest: 0, maxTowers: 0, abilityUses: 0, thunders: 0, built: [] };
    this.seen = new Set();
    this.cleared = [];
    this._peek = null;
    this.lastSnapshot = null;
    if (opts.snapshot) this.restore(opts.snapshot);
  }

  emit(type, data) {
    if (data) data.type = type;
    this.events.push(data || { type });
  }

  // ---------------------------------------------------------------- queries
  tileIndex(col, row) { return row * this.level.cols + col; }
  towerOn(col, row) { return this.towerAt.get(this.tileIndex(col, row)) || null; }
  buildCost(type) { return Math.round(TOWERS[type].cost * this.mods.cost); }
  upgradeCostOf(t, spec) { return Math.round(upgradeCost(t.type, t.level, spec || t.spec) * this.mods.cost); }
  sellValue(t) { return Math.floor(t.invested * this.mods.refund); }
  canCallWave() { return this.state === 'play' && this.wave < this.totalWaves && this.qi >= this.queue.length; }
  ultUnlocked(type) { return this.demo || this.mods.ult.has(type); }
  wreckCost(w) { return Math.round(w.cost * this.mods.cost); }

  canBuild(col, row, type) {
    if (!this.loadout.includes(type)) return { ok: false, reason: '未編入本關部隊' };
    if (this.map.at(col, row) !== TILE.BUILD) return { ok: false, reason: '無法在此建造' };
    if (this.towerOn(col, row)) return { ok: false, reason: '已有砲塔' };
    if (this.credits < this.buildCost(type)) return { ok: false, reason: '資金不足' };
    return { ok: true };
  }

  canUpgrade(t, spec) {
    if (t.level >= 5) return { ok: false, reason: '已達最高等級' };
    if (t.level === 3 && !spec) return { ok: false, reason: '請選擇專精' };
    if (t.level === 4 && !this.ultUnlocked(t.type)) return { ok: false, reason: '需要研究「終極協議」' };
    if (this.credits < this.upgradeCostOf(t, spec)) return { ok: false, reason: '資金不足' };
    return { ok: true };
  }

  peekWave() {
    const w = this.wave + 1;
    if (w > this.totalWaves) return null;
    if (!this._peek || this._peek.w !== w) {
      const wave = generateWave(this.level, w, this.difficulty, this.endless);
      this._peek = { w, wave, summary: waveSummary(wave) };
    }
    return this._peek;
  }

  stars() {
    if (this.state !== 'won') return 0;
    const lost = this.maxLives - this.lives;
    if (lost <= Math.ceil(this.baseLives * 0.1)) return 3;
    if (lost <= Math.ceil(this.baseLives * 0.5)) return 2;
    return 1;
  }

  // Did the run satisfy the level's bonus challenge?
  challengeMet() {
    const c = this.level.challenge;
    if (!c || this.endless || this.state !== 'won') return false;
    const s = this.stats;
    switch (c.id) {
      case 'only': return s.built.every((t) => c.types.includes(t));
      case 'noAbility': return s.abilityUses === 0;
      case 'maxTowers': return s.maxTowers <= c.max;
      case 'noAirLeak': return s.leakedAir === 0;
      case 'noSell': return s.sold === 0;
      case 'noType': return !s.built.includes(c.type);
      case 'maxSpent': return s.spent <= c.max;
      case 'noThunder': return s.thunders === 0;
      case 'noLeak': return s.leaked === 0;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- commands
  build(col, row, type) {
    if (!this.canBuild(col, row, type).ok) return null;
    const cost = this.buildCost(type);
    this.credits -= cost;
    this.stats.spent += cost;
    if (!this.stats.built.includes(type)) this.stats.built.push(type);
    return this._addTower(type, col, row, cost);
  }

  _addTower(type, col, row, invested) {
    const { x, z } = tileToWorld(this.level, col, row);
    const t = {
      id: this.nextId++, type, def: TOWERS[type], level: 1, spec: null, col, row, x, z,
      targeting: 'first', cooldown: 0.3, aim: this._facePath(x, z), target: null, beams: [],
      invested, kills: 0, damage: 0, xp: 0, rank: 0, stats: null, buffBy: null, auraT: 0, disabledT: 0,
      shots: 0, spin: 0, flameOn: false, drones: [], mineT: 1, node: this.map.isNode(col, row),
    };
    this.towers.push(t);
    this.towerAt.set(this.tileIndex(col, row), t);
    this.stats.maxTowers = Math.max(this.stats.maxTowers, this.towers.length);
    this.recomputeStats();
    this.emit('build', { tower: t });
    return t;
  }

  upgrade(t, spec) {
    if (!this.canUpgrade(t, spec).ok) return false;
    const cost = this.upgradeCostOf(t, spec);
    this.credits -= cost;
    this.stats.spent += cost;
    t.invested += cost;
    if (t.level === 3) t.spec = spec;
    t.level++;
    t.beams.length = 0;
    t.shots = 0;
    this.recomputeStats();
    this.emit('upgrade', { tower: t, ultimate: t.level === 5 });
    return true;
  }

  sell(t) {
    const refund = this.sellValue(t);
    this.credits += refund;
    this.stats.sold++;
    t.sold = true;
    this.towers.splice(this.towers.indexOf(t), 1);
    this.towerAt.delete(this.tileIndex(t.col, t.row));
    for (const d of t.drones) d.dead = true;
    this.mines = this.mines.filter((m) => m.owner !== t);
    this.recomputeStats();
    this.emit('sell', { tower: t, refund });
    return refund;
  }

  clearWreck(col, row) {
    const w = this.map.wreckAt(col, row);
    if (!w) return false;
    const cost = this.wreckCost(w);
    if (this.credits < cost) return false;
    this.credits -= cost;
    this.stats.spent += cost;
    this.map.clearWreck(col, row);
    this.cleared.push([col, row]);
    this.emit('clearWreck', { col, row, x: w.x, z: w.z, node: this.map.isNode(col, row) });
    return true;
  }

  setTargeting(t, mode) { t.targeting = mode; t.target = null; t.beams.length = 0; }

  callWave() {
    if (!this.canCallWave()) return false;
    this.lastSnapshot = this.snapshot();
    const early = this.enemies.length > 0 && this.wave > 0;
    const { wave } = this.peekWave();
    this.wave++;
    const spawns = waveSpawns(wave, this.map.paths.length);
    this.queue = [];
    this.qi = 0;
    for (const s of spawns) this.queue.push({ ...s, t: this.time + s.t, wave: this.wave });
    // economy: interest on banked credits, then wave income
    let interest = 0;
    if (!this.demo && this.wave > 1) {
      let rate = ECONOMY.interest + this.mods.interest;
      for (const t of this.towers) if (t.stats.interest) rate += t.stats.interest;
      interest = Math.floor(Math.min(this.credits * Math.min(rate, 0.08), ECONOMY.interestCapBase + ECONOMY.interestCapPerWave * this.wave));
    }
    const income = this.demo ? 0 : waveIncome(this.wave);
    const bonus = early ? earlyBonus(this.wave) : 0;
    let salvage = 0;
    for (const t of this.towers) if (t.stats.income) salvage += t.stats.income;
    this.credits += income + bonus + interest + salvage;
    this.stats.earned += income + bonus + interest + salvage;
    this.stats.interest += interest;
    this.autoTimer = 0;
    this.emit('waveStart', { wave: this.wave, early, income, bonus, interest, salvage, boss: wave.boss, theme: wave.theme });
    return true;
  }

  useAbility(id) {
    const a = this.abilities[id];
    if (!a || a.cd > 0 || this.state !== 'play') return false;
    const def = ABILITIES[id];
    let hits = null;
    if (id === 'stasis') this.stasisT = def.time;
    else if (id === 'thunder') { hits = this.thunder(def); this.stats.thunders++; }
    a.cd = a.max;
    this.stats.abilityUses++;
    this.emit('ability', { id, hits });
    return true;
  }

  // 雷霆審判: a lightning strike on every enemy on the field. Damage follows the wave HP curve.
  thunder(def) {
    const dmg = def.damage * hpScale(Math.max(1, this.wave)) * this.mods.thunder;
    const hits = [];
    for (const e of this.enemies) {
      if (e.dead || e.inWarp) continue;
      hits.push([e.x, e.h, e.z, e.boss ? 1 : 0]);
      if (this.cloaked(e)) e.revealedT = Math.max(e.revealedT, 3);
      this.damage(e, dmg * (e.boss ? def.bossMul : 1), null, 'electric', THUNDER_HIT);
      if (!e.dead) this.applyStun(e, def.stun);
    }
    return hits;
  }

  // ---------------------------------------------------------------- stats / buffs
  recomputeStats() {
    const amps = this.towers.filter((t) => t.type === 'amp');
    for (const t of this.towers) {
      const { stats, by } = this.computeStats(t, t.level, t.spec, amps);
      t.stats = stats;
      t.buffBy = by;
      t.buffAmp = by ? amps.find((a) => a.id === by) : null;
    }
  }

  // Effective stats for tower t at a (possibly hypothetical) level/spec: research, amp buff, power node, rank.
  computeStats(t, level, spec, amps = this.towers.filter((o) => o.type === 'amp')) {
    const s = towerBaseStats(t.type, level, spec);
    let buff = null, by = null;
    if (t.type !== 'amp') {
      for (const a of amps) {
        if (a === t) continue;
        const as = towerBaseStats('amp', a.level, a.spec);
        const bd = as.buffDamage + 0.03 * a.rank;
        if (Math.hypot(a.x - t.x, a.z - t.z) <= as.range + 0.01 && (!buff || bd > buff.buffDamage)) { buff = { ...as, buffDamage: bd }; by = a.id; }
      }
    }
    const node = t.node ? POWER_NODE : null;
    const dm = this.mods.damage * (1 + (buff ? buff.buffDamage : 0)) * (1 + (node ? node.damage : 0)) * (1 + VETERANCY.damage * t.rank);
    for (const k of ['damage', 'clusterDamage', 'dpsMin', 'dpsMax', 'dps', 'burn']) if (s[k]) s[k] *= dm;
    if (s.well) s.well = { ...s.well, dps: s.well.dps * dm };
    if (s.pool) s.pool = { ...s.pool, dps: s.pool.dps * dm };
    if (t.type === 'amp') s.buffDamage += 0.03 * t.rank;
    else if (t.type === 'sensor') s.mark += 0.03 * t.rank;
    if (t.type !== 'amp') s.range *= this.mods.range * (1 + (buff ? buff.buffRange : 0)) * (1 + (node ? node.range : 0)) * (1 + VETERANCY.range * t.rank);
    if (s.rate) s.rate *= 1 + (buff && buff.buffRate ? buff.buffRate : 0);
    s.attack = s.attack || TOWERS[t.type].attack;
    return { stats: s, by };
  }

  addXp(src, dealt) {
    if (!src.def || !src.invested) return;
    src.xp += dealt * this.mods.veteran;
    if (src.rank < 3 && src.xp / src.invested >= VETERANCY.thresholds[src.rank]) {
      src.rank++;
      this.recomputeStats();
      this.emit('rankUp', { tower: src });
    }
  }

  // ---------------------------------------------------------------- main update
  update(dt) {
    if (this.state !== 'play') return;
    this.time += dt;
    for (const id in this.abilities) { const a = this.abilities[id]; if (a.cd > 0) a.cd = Math.max(0, a.cd - dt); }
    if (this.stasisT > 0) this.stasisT -= dt;

    while (this.qi < this.queue.length && this.queue[this.qi].t <= this.time) {
      const s = this.queue[this.qi++];
      this.spawnEnemy(s.type, s.path, s.wave, 0, s.hp);
    }

    this.updateDetection();
    this.updateEnemies(dt);
    this.updateTowers(dt);
    this.updateDrones(dt);
    this.updateMines(dt);
    this.updateProjectiles(dt);
    this.updateEffects(dt);

    let j = 0;
    for (let i = 0; i < this.enemies.length; i++) { const e = this.enemies[i]; if (!e.dead) this.enemies[j++] = e; }
    this.enemies.length = j;

    if (this.lives <= 0 && !this.demo) {
      this.lives = 0;
      this.state = 'lost';
      this.emit('defeat');
      return;
    }
    const idle = this.qi >= this.queue.length && this.enemies.length === 0;
    if (idle && !this.endless && this.wave >= this.totalWaves && !this.demo) {
      this.state = 'won';
      this.emit('victory', { stars: this.stars(), challenge: this.challengeMet() });
      return;
    }
    // the menu backdrop battle keeps itself going
    if (this.demo && idle && this.wave > 0 && this.wave < this.totalWaves) {
      this.autoTimer += dt;
      if (this.autoTimer > 1.5) this.callWave();
    }
  }

  // ---------------------------------------------------------------- enemies
  spawnEnemy(type, pathIndex, wave, dist = 0, hpMul = 1) {
    const def = ENEMIES[type];
    const air = !!def.air;
    const paths = air ? this.map.airPaths : this.map.paths;
    const pi = pathIndex % paths.length;
    const scale = hpScale(wave) * (this.level.hp || 1) * this.diff.hp * hpMul;
    const mut = this.mutators;
    const e = {
      id: this.nextId++, type, def, air, boss: !!def.boss, cls: def.cls,
      maxHp: def.hp * scale, hp: def.hp * scale,
      maxShield: (def.shield || 0) * scale, shield: (def.shield || 0) * scale,
      armor: def.armor + this.diff.armor + (mut.includes('armored') ? 2 : 0), radius: def.radius,
      speed: def.speed * this.diff.speed * (mut.includes('swift') ? 1.12 : 1) * (0.94 + this.rand() * 0.12),
      curSpeed: 0, path: paths[pi], pathIndex: pi, dist,
      offset: def.boss ? 0 : (this.rand() - 0.5) * 0.36,
      x: 0, y: air ? (def.boss ? AIR_HEIGHT + 0.35 : AIR_HEIGHT) : 0, z: 0, dirX: 1, dirZ: 0,
      h: air ? (def.boss ? AIR_HEIGHT + 0.35 : AIR_HEIGHT) : def.radius * 1.1,
      slowAmt: 0, slowTime: 0, stunTime: 0, frozen: false, vulnAmt: 0, vulnTime: 0, empTime: 0, shieldDelay: 0,
      markAmt: 0, markT: 0, markBy: null, markShred: 0, revealedT: 0, detected: !def.cloak, cloakT: 0,
      burnStacks: 0, burnT: 0, burnDps: 0, burnSrc: null, burnApplyT: 0, chilledT: 0, chillSrc: null, thermalCd: 0,
      regenDelay: 0, jammedT: 0, jamSlow: 0, noHealT: 0, noShieldT: 0, inWarp: false,
      healCd: def.heal ? def.heal.every * (0.5 + this.rand() * 0.5) : 0,
      blinkCd: def.blink ? def.blink.every * (0.6 + this.rand() * 0.4) : 0,
      summonCd: def.summon ? def.summon.every : 0,
      summon2Cd: 0, empCd: def.emp ? def.emp.every * (0.6 + this.rand() * 0.3) : 0, cloakCd: 0,
      enraged: false, phase2Done: false,
      reward: def.reward * (1 + 0.02 * (wave - 1)), wave,
      dead: false, leaked: false, hitT: 0, phase: this.rand() * 6.283,
    };
    if (mut.includes('shielded') && !def.shield) { e.maxShield = e.maxHp * 0.25; e.shield = e.maxShield; }
    this.placeEnemy(e);
    this.enemies.push(e);
    const first = !this.seen.has(type);
    this.seen.add(type);
    this.emit('spawn', { enemy: e, first });
    return e;
  }

  placeEnemy(e) {
    const p = e.path.sample(e.dist, TMP);
    e.dirX = p.dx;
    e.dirZ = p.dz;
    e.x = p.x - p.dz * e.offset;
    e.z = p.z + p.dx * e.offset;
  }

  cloaked(e) { return !!(e.def.cloak || e.cloakT > 0); }
  targetable(e) { return !e.dead && !e.inWarp && (e.detected || !this.cloaked(e)); }

  // Which cloaked enemies are currently visible to sensor towers.
  updateDetection() {
    const det = [];
    for (const t of this.towers) if (t.stats.attack === 'sensor' && t.disabledT <= 0) det.push([t.x, t.z, t.stats.range * t.stats.range]);
    for (const e of this.enemies) {
      if (!this.cloaked(e)) { e.detected = true; continue; }
      let seen = e.revealedT > 0;
      for (let i = 0; !seen && i < det.length; i++) {
        const [x, z, r2] = det[i];
        if ((e.x - x) ** 2 + (e.z - z) ** 2 <= r2) seen = true;
      }
      if (seen && !e.detected) this.emit('reveal', { enemy: e });
      e.detected = seen;
    }
  }

  updateEnemies(dt) {
    const stasis = this.stasisT > 0 ? ABILITIES.stasis : null;
    const regenMut = this.mutators.includes('regen');
    // jammers: suppress abilities, slow, block shield regeneration
    for (const t of this.towers) {
      const s = t.stats;
      if (t.disabledT > 0 || !s.jam) continue;
      const r2 = s.range * s.range;
      for (const e of this.enemies) {
        if (e.dead || (e.x - t.x) ** 2 + (e.z - t.z) ** 2 > r2) continue;
        e.jammedT = 0.25;
        e.jamSlow = Math.max(e.jamSlow, e.def.ccImmune ? 0 : s.jam);
        if (s.noShield) e.noShieldT = 0.25;
      }
    }
    for (const e of this.enemies) {
      if (e.dead) continue;
      const def = e.def;
      if (e.hitT > 0) e.hitT -= dt;
      if (e.slowTime > 0) { e.slowTime -= dt; if (e.slowTime <= 0) e.slowAmt = 0; }
      if (e.stunTime > 0) { e.stunTime -= dt; if (e.stunTime <= 0) e.frozen = false; }
      if (e.vulnTime > 0) { e.vulnTime -= dt; if (e.vulnTime <= 0) e.vulnAmt = 0; }
      if (e.markT > 0) { e.markT -= dt; if (e.markT <= 0) { e.markAmt = 0; e.markShred = 0; e.markBy = null; } }
      if (e.empTime > 0) e.empTime -= dt;
      if (e.revealedT > 0) e.revealedT -= dt;
      if (e.chilledT > 0) e.chilledT -= dt;
      if (e.thermalCd > 0) e.thermalCd -= dt;
      if (e.noHealT > 0) e.noHealT -= dt;
      if (e.noShieldT > 0) e.noShieldT -= dt;
      if (e.cloakT > 0) e.cloakT -= dt;
      const jammed = e.jammedT > 0;
      if (jammed) e.jammedT -= dt; else e.jamSlow = 0;
      if (e.burnT > 0) {
        e.burnT -= dt;
        this.damage(e, e.burnDps * e.burnStacks * dt, e.burnSrc, 'thermal', DOT);
        if (e.dead) continue;
        if (e.burnT <= 0) { e.burnStacks = 0; e.burnDps = 0; }
      }
      // regeneration is blocked by burning and deep freeze
      if ((def.regen || regenMut) && e.burnT <= 0 && e.noHealT <= 0) {
        e.regenDelay -= dt;
        if (e.regenDelay <= 0) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * ((def.regen ? def.regen.rate : 0) + (regenMut ? 0.01 : 0)) * dt);
      }
      if (e.maxShield > 0) {
        if (e.shieldDelay > 0) e.shieldDelay -= dt;
        else if (e.empTime <= 0 && e.noShieldT <= 0 && e.noHealT <= 0 && e.shield < e.maxShield) e.shield = Math.min(e.maxShield, e.shield + e.maxShield * (def.shieldRegen || 0.25) * dt);
      }
      e.inWarp = e.path.warps.length > 0 && e.path.inWarp(e.dist);
      let mul = e.stunTime > 0 && !e.inWarp ? 0 : 1 - e.slowAmt;
      if (stasis && !def.ccImmune) mul *= 1 - (e.boss ? stasis.bossSlow : stasis.slow);
      mul *= 1 - e.jamSlow;
      if (def.berserk) mul *= 1 + def.berserk * (1 - e.hp / e.maxHp);
      if (e.enraged) mul *= def.enrage.speed;
      if (e.inWarp) mul = 5;
      e.curSpeed = e.speed * mul;
      e.dist += e.curSpeed * dt;
      const tick = jammed ? (e.boss ? 0.5 : 0) : 1;
      if (tick > 0) this.enemyAbilities(e, dt * tick);
      if (e.dead) continue;
      if (e.dist >= e.path.length) {
        e.dead = true;
        e.leaked = true;
        if (!this.demo) this.lives -= e.def.dmg;
        this.stats.leaked++;
        if (e.air) this.stats.leakedAir++;
        this.emit('leak', { enemy: e, dmg: e.def.dmg });
        continue;
      }
      this.placeEnemy(e);
    }
  }

  enemyAbilities(e, dt) {
    const def = e.def;
    if (def.heal && (e.healCd -= dt) <= 0) {
      e.healCd = def.heal.every;
      const r2 = def.heal.radius * def.heal.radius;
      for (const o of this.enemies) {
        if (o.dead || o.boss || o.noHealT > 0) continue;
        const dx = o.x - e.x, dz = o.z - e.z;
        if (dx * dx + dz * dz <= r2) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * def.heal.amount);
      }
      this.emit('heal', { x: e.x, z: e.z, r: def.heal.radius });
    }
    if (def.blink && e.stunTime <= 0 && (e.blinkCd -= dt) <= 0) {
      e.blinkCd = def.blink.every;
      const x0 = e.x, z0 = e.z;
      e.dist = Math.min(e.path.length - 0.4, e.dist + def.blink.dist);
      this.placeEnemy(e);
      this.emit('blink', { x0, z0, x1: e.x, z1: e.z, y: e.y });
    }
    if (def.summon && (e.summonCd -= dt) <= 0) {
      e.summonCd = def.summon.every;
      this.summon(e, def.summon);
    }
    if (e.enraged && def.enrage.summon && (e.summon2Cd -= dt) <= 0) {
      e.summon2Cd = def.enrage.summon.every;
      this.summon(e, def.enrage.summon);
    }
    if (def.emp && (e.empCd -= dt) <= 0) {
      e.empCd = def.emp.every;
      this.enemyEmp(e.x, e.z, def.emp.radius, def.emp.time);
    }
    const frac = e.hp / e.maxHp;
    if (def.enrage && !e.enraged && frac < def.enrage.at) {
      e.enraged = true;
      e.summon2Cd = 1;
      this.emit('bossPhase', { enemy: e, kind: 'enrage' });
    }
    if (def.burst && !e.phase2Done && frac < def.burst.at) {
      e.phase2Done = true;
      this.summon(e, { type: def.burst.type, count: def.burst.count });
      this.emit('bossPhase', { enemy: e, kind: 'burst' });
    }
    if (def.cloakPulse && frac < def.cloakPulse.at && (e.cloakCd -= dt) <= 0) {
      e.cloakCd = def.cloakPulse.every;
      e.cloakT = def.cloakPulse.time;
      this.emit('bossPhase', { enemy: e, kind: 'cloak' });
    }
    if (def.phase2 && !e.phase2Done && frac < def.phase2.at) this.transform(e, def.phase2.into);
  }

  summon(e, s) {
    const def = ENEMIES[s.type];
    const paths = def.air ? this.map.airPaths : this.map.paths;
    const p = paths[e.pathIndex % paths.length];
    const base = !!def.air === e.air ? e.dist : p.nearestDist(e.x, e.z);
    for (let i = 0; i < s.count; i++) {
      const m = this.spawnEnemy(s.type, e.pathIndex, e.wave, Math.max(0, base - 0.5 - i * 0.45), 0.8);
      m.offset = (i % 2 ? 1 : -1) * 0.22;
      this.placeEnemy(m);
    }
    this.emit('summon', { enemy: e });
  }

  // Boss phase change (omega -> flying omega2): keep hp, move onto the air route.
  transform(e, into) {
    const def = ENEMIES[into];
    e.phase2Done = true;
    e.type = into;
    e.def = def;
    e.cls = def.cls;
    e.air = !!def.air;
    const paths = e.air ? this.map.airPaths : this.map.paths;
    const p = paths[e.pathIndex % paths.length];
    e.dist = p.nearestDist(e.x, e.z);
    e.path = p;
    e.y = e.air ? AIR_HEIGHT + 0.35 : 0;
    e.h = e.y || def.radius * 1.1;
    e.armor = def.armor + this.diff.armor;
    e.speed = def.speed * this.diff.speed;
    e.summonCd = 3;
    e.empCd = 4;
    e.stunTime = 0;
    e.frozen = false;
    e.maxShield = 0;
    e.shield = 0;
    this.placeEnemy(e);
    this.seen.add(into);
    this.emit('bossPhase', { enemy: e, kind: 'transform' });
  }

  enemyEmp(x, z, r, time) {
    const r2 = r * r;
    const hit = [];
    for (const t of this.towers) {
      if ((t.x - x) ** 2 + (t.z - z) ** 2 > r2) continue;
      t.disabledT = Math.max(t.disabledT, time);
      t.beams.length = 0;
      hit.push(t);
    }
    this.emit('emp', { x, z, r, towers: hit });
  }

  // ---------------------------------------------------------------- damage & statuses
  damage(e, amount, src, type = 'kinetic', o = NO) {
    if (e.dead || amount <= 0) return 0;
    let mul = ARMOR_CLASSES[e.cls].mul[type];
    if (mul === undefined) mul = 1;
    if (o.pierceResist && mul < 1) mul = 1;
    let dmg = amount * mul * (1 + e.vulnAmt + e.markAmt + (e.frozen ? FROZEN_BONUS : 0));
    const before = e.hp + e.shield;
    if (e.shield > 0) {
      const sm = SHIELD_MUL[type] * (o.shieldMul || 1);
      const eff = dmg * sm;
      if (eff < e.shield) { e.shield -= eff; dmg = 0; }
      else { dmg -= e.shield / sm; e.shield = 0; this.emit('shieldBreak', { enemy: e }); }
    }
    if (e.maxShield > 0) e.shieldDelay = e.boss ? 3 : 2.5;
    if (dmg > 0) {
      if (!o.dot && !o.armorPierce && e.armor > 0) dmg = Math.max(dmg * 0.2, dmg - e.armor * (1 - e.markShred));
      e.hp -= dmg;
    }
    if (!o.dot) e.hitT = 0.08;
    e.regenDelay = e.def.regen ? e.def.regen.delay : 1;
    if (o.aoe && e.def.cloak) e.revealedT = Math.max(e.revealedT, 1.5);
    const dealt = before - Math.max(0, e.hp) - e.shield;
    if (src) {
      src.damage += dealt;
      this.addXp(src, dealt);
      if (src.buffAmp && !src.buffAmp.sold) this.addXp(src.buffAmp, dealt * 0.2);
    }
    if (e.markBy && e.markBy !== src && !e.markBy.sold) this.addXp(e.markBy, dealt * 0.15);
    if (e.hp <= 0) this.kill(e, src);
    return dealt;
  }

  kill(e, src) {
    e.dead = true;
    e.hp = 0;
    let mul = this.mods.bounty;
    for (const t of this.towers) {
      const s = t.stats;
      if (s.salvage && Math.hypot(t.x - e.x, t.z - e.z) <= s.salvageRange) { mul *= 1 + s.salvage; break; }
    }
    const reward = this.demo ? 0 : Math.max(1, Math.round(e.reward * mul));
    this.credits += reward;
    this.stats.earned += reward;
    this.stats.kills++;
    if (src) src.kills++;
    this.emit('kill', { enemy: e, reward });
    const split = e.def.split;
    if (split) {
      for (let i = 0; i < split.count; i++) {
        const m = this.spawnEnemy(split.type, e.pathIndex, e.wave, Math.max(0, e.dist + (i - 1) * 0.25));
        m.offset = (i - 1) * 0.2;
        this.placeEnemy(m);
      }
    }
    // solar flare: burning deaths ignite neighbours
    const bs = e.burnSrc && e.burnSrc.stats;
    if (e.burnT > 0 && bs && bs.spread) {
      for (const o of this.enemiesNear(e.x, e.z, bs.spread)) if (!o.air) this.applyBurn(o, bs.burn, e.burnSrc);
      this.emit('shatter', { x: e.x, y: 0.3, z: e.z, r: bs.spread, kind: 'fire' });
    }
    // shatter storm: frozen / chilled deaths explode into ice
    const cs = e.chillSrc && e.chillSrc.stats;
    if ((e.frozen || e.chilledT > 0) && cs && cs.shatter) {
      const dmg = Math.min(500, e.maxHp * cs.shatter);
      for (const o of this.enemiesNear(e.x, e.z, 1.1)) this.damage(o, dmg, e.chillSrc, 'cryo', AOE);
      this.emit('shatter', { x: e.x, y: e.h, z: e.z, r: 1.1, kind: 'ice' });
    }
  }

  applySlow(e, amt, time, src = null) {
    if (e.dead || e.def.ccImmune) return;
    if (e.boss) amt *= 0.5;
    if (amt >= e.slowAmt - 1e-6) {
      if (amt > e.slowAmt + 1e-6) e.slowTime = time;
      else e.slowTime = Math.max(e.slowTime, time);
      e.slowAmt = amt;
    }
    if (src && src.type === 'cryo') {
      e.chilledT = Math.max(e.chilledT, time);
      e.chillSrc = src;
      if (e.burnT > 0) this.thermalShock(e, src);
    }
  }

  applyStun(e, time) {
    if (e.dead || e.def.ccImmune) return;
    e.stunTime = Math.max(e.stunTime, e.boss ? time * 0.25 : time);
  }

  applyBurn(e, dps, src) {
    if (e.dead || e.air) return;
    if (e.burnApplyT > this.time) { e.burnT = BURN.time; return; }
    e.burnApplyT = this.time + 0.45;
    e.burnStacks = Math.min(BURN.maxStacks, e.burnStacks + 1);
    e.burnDps = Math.max(e.burnDps, dps);
    e.burnT = BURN.time;
    e.burnSrc = src;
    if (e.chilledT > 0) this.thermalShock(e, src);
  }

  // Heat meets cold: instant burst damage, consumes both states.
  thermalShock(e, src) {
    if (e.thermalCd > 0 || e.dead) return;
    e.thermalCd = THERMAL_SHOCK.cooldown;
    const dmg = Math.min(THERMAL_SHOCK.cap, e.maxHp * (e.boss ? THERMAL_SHOCK.bossPct : THERMAL_SHOCK.pct));
    e.burnStacks = 0;
    e.burnT = 0;
    e.chilledT = 0;
    this.emit('shatter', { x: e.x, y: e.h, z: e.z, r: 0.6, kind: 'thermal' });
    this.damage(e, dmg, src, 'thermal', { armorPierce: true });
  }

  mark(e, amt, time, src, shred = 0) {
    if (amt >= e.markAmt) { e.markAmt = amt; e.markBy = src; e.markShred = Math.max(e.markShred, shred); }
    e.markT = Math.max(e.markT, time);
  }

  // ---------------------------------------------------------------- towers
  canHit(t, e) { return e.air ? t.def.air : t.def.ground; }

  findTarget(t, range, exclude) {
    let best = null, bestScore = -Infinity;
    const r2 = range * range;
    const mode = t.targeting;
    const min2 = t.def.minRange ? t.def.minRange * t.def.minRange : 0;
    const preferAir = t.def.preferAir || t.stats.preferAir;
    for (const e of this.enemies) {
      if (!this.targetable(e) || !this.canHit(t, e)) continue;
      if (exclude && exclude.includes(e)) continue;
      const dx = e.x - t.x, dz = e.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < min2) continue;
      let s;
      if (mode === 'first') s = e.dist - e.path.length;
      else if (mode === 'last') s = e.path.length - e.dist;
      else if (mode === 'strong') s = e.hp + e.shield;
      else s = -d2;
      if (preferAir && e.air) s += 1e7;
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  }

  inRange(t, e, range) {
    if (!this.targetable(e) || !this.canHit(t, e)) return false;
    const dx = e.x - t.x, dz = e.z - t.z;
    return dx * dx + dz * dz <= range * range;
  }

  rateMul(t) {
    let m = 1;
    if (t.stats.spinup) m *= 1 + t.stats.spinup * t.spin;
    return m;
  }

  updateTowers(dt) {
    for (const t of this.towers) {
      const s = t.stats;
      if (t.disabledT > 0) { t.disabledT -= dt; t.flameOn = false; t.beams.length = 0; continue; }
      const kind = s.attack;
      const rm = this.rateMul(t);
      if (kind === 'support') continue;
      if (kind === 'beam') { this.updateBeam(t, s, dt, rm); continue; }
      if (kind === 'flame') { this.updateFlame(t, s, dt, rm); continue; }
      if (kind === 'drones' || kind === 'mines') { this.updateLauncher(t, s, dt, rm); continue; }
      if (kind === 'aura' || kind === 'sensor') {
        t.auraT -= dt * (kind === 'aura' ? rm : 1);
        if (t.auraT <= 0) {
          t.auraT += kind === 'aura' ? 1 / s.rate : 2;
          if (kind === 'aura') this.auraPulse(t, s); else this.sensorPulse(t, s);
        }
        continue;
      }
      t.cooldown -= dt * rm;
      if (s.spinup && !t.target) t.spin = Math.max(0, t.spin - dt / 1.5);
      if (t.cooldown > 0) continue;
      const target = this.findTarget(t, s.range);
      if (!target) { t.cooldown = 0; t.target = null; continue; }
      t.target = target;
      t.aim = Math.atan2(target.x - t.x, target.z - t.z);
      t.cooldown += 1 / s.rate;
      if (t.cooldown < 0) t.cooldown = 0;
      if (s.spinup) t.spin = Math.min(1, t.spin + 1 / (s.rate * 3));
      this.fire(t, s, kind, target);
    }
  }

  fire(t, s, kind, target) {
    const muzzleY = 0.8;
    const dtype = damageType(t.type, s);
    t.shots++;
    if (kind === 'bullet' || kind === 'frost') {
      this.projectiles.push({
        id: this.nextId++, kind, tower: t, target, x: t.x + Math.sin(t.aim) * 0.35, y: muzzleY, z: t.z + Math.cos(t.aim) * 0.35,
        tx: target.x, ty: target.h, tz: target.z, speed: t.def.projSpeed, dmg: s.damage, s, dtype, dead: false,
      });
    } else if (kind === 'rail') {
      const over = s.overcharge && t.shots % s.overcharge === 0;
      const len = s.range + 0.5;
      const dx = Math.sin(t.aim), dz = Math.cos(t.aim);
      const x1 = t.x + dx * 0.4, z1 = t.z + dz * 0.4, x2 = t.x + dx * len, z2 = t.z + dz * len;
      for (const e of this.enemies) {
        if (e.dead || e.inWarp) continue;
        const px = e.x - x1, pz = e.z - z1;
        const along = px * dx + pz * dz;
        if (along < 0 || along > len) continue;
        if (Math.abs(px * dz - pz * dx) > 0.3 + e.radius * 0.5) continue;
        this.damage(e, s.damage * (over ? 3 : 1), t, dtype, { armorPierce: true, pierceResist: true, aoe: true });
        if (over) this.applyStun(e, 1);
      }
      this.emit('rail', { tower: t, x1, z1, x2, z2, y: 0.85, over });
    } else if (kind === 'shell' || kind === 'napalm') {
      const T = 0.75 + Math.hypot(target.x - t.x, target.z - t.z) * 0.07;
      const p = this.predict(target, T);
      this.projectiles.push({
        id: this.nextId++, kind, tower: t, sx: t.x, sy: 1.0, sz: t.z, x: t.x, y: 1.0, z: t.z,
        tx: p.x, tz: p.z, T, t: 0, arc: 1.6 + T, dmg: s.damage, s, dtype, dead: false,
      });
    } else if (kind === 'missile') {
      const n = s.missiles || 1;
      const nuke = s.nuke && t.shots % s.nuke === 0;
      const targets = n > 1 ? this.topTargets(t, s.range, n) : [target];
      for (let i = 0; i < n; i++) {
        const tg = targets[i % targets.length];
        const side = (i % 2 ? 1 : -1) * (0.3 + 0.5 * this.rand());
        this.projectiles.push({
          id: this.nextId++, kind: 'missile', tower: t, target: tg, x: t.x, y: 0.9, z: t.z,
          vx: Math.cos(t.aim) * side * 2, vy: 3 + this.rand() * 1.5, vz: -Math.sin(t.aim) * side * 2,
          speed: 3, life: 4, tx: tg.x, ty: tg.h, tz: tg.z, dmg: s.damage * (nuke ? 3 : 1), s, dtype,
          airMul: t.def.airMul || 1, groundMul: t.def.groundMul || 1, dead: false, delay: i * 0.06, nuke, mirv: s.mirv || 0,
        });
      }
    } else if (kind === 'tesla') {
      const storm = s.storm && t.shots % s.storm === 0;
      const hit = [];
      const pts = [t.x, 1.55, t.z];
      if (storm) {
        const r2 = s.range * s.range;
        for (const e of this.enemies) if (this.targetable(e) && this.canHit(t, e) && (e.x - t.x) ** 2 + (e.z - t.z) ** 2 <= r2) hit.push(e);
      } else {
        hit.push(target);
        let cur = target;
        const cr2 = t.def.chainRange * t.def.chainRange;
        for (let i = 1; i < s.chain; i++) {
          let best = null, bd = cr2;
          for (const e of this.enemies) {
            if (!this.targetable(e) || hit.includes(e) || !this.canHit(t, e)) continue;
            const dx = e.x - cur.x, dz = e.z - cur.z, d2 = dx * dx + dz * dz;
            if (d2 < bd) { bd = d2; best = e; }
          }
          if (!best) break;
          hit.push(best);
          cur = best;
        }
      }
      for (const e of hit) pts.push(e.x, e.h, e.z);
      const shieldMul = s.shieldMul || 1;
      for (let i = 0; i < hit.length; i++) {
        const e = hit[i];
        if (s.stun) this.applyStun(e, s.stun);
        if (s.emp) e.empTime = Math.max(e.empTime, s.emp);
        const f = storm ? 1.5 : Math.pow(s.falloff, i);
        this.damage(e, s.damage * f, t, dtype, { shieldMul });
      }
      this.emit('tesla', { tower: t, pts, storm });
    }
    this.emit('fire', { tower: t, kind });
  }

  topTargets(t, range, n) {
    const list = [];
    const r2 = range * range;
    for (const e of this.enemies) {
      if (!this.targetable(e) || !this.canHit(t, e)) continue;
      const dx = e.x - t.x, dz = e.z - t.z;
      if (dx * dx + dz * dz <= r2) list.push(e);
    }
    list.sort((a, b) => (b.air - a.air) || ((a.path.length - a.dist) - (b.path.length - b.dist)));
    return list.slice(0, n);
  }

  predict(e, T) {
    const p = e.path.sample(e.dist + e.curSpeed * T, TMP);
    return { x: p.x - p.dz * e.offset, z: p.z + p.dx * e.offset };
  }

  updateBeam(t, s, dt, rm) {
    const n = s.beams || 1;
    for (let i = t.beams.length - 1; i >= 0; i--) if (!this.inRange(t, t.beams[i].e, s.range)) t.beams.splice(i, 1);
    while (t.beams.length < n) {
      const e = this.findTarget(t, s.range, t.beams.length ? t.beams.map((b) => b.e) : null);
      if (!e) break;
      t.beams.push({ e, time: 0 });
    }
    for (const b of t.beams) {
      b.time += dt * (rm > 1 ? rm * 1.4 : 1);
      const f = Math.min(1, b.time / s.ramp);
      const dps = s.dpsMin + (s.dpsMax - s.dpsMin) * f * f;
      this.damage(b.e, dps * dt, t, 'energy', DOT);
      if (s.lance) {
        // piercing lance: everything on the line from tower to target
        const dx = b.e.x - t.x, dz = b.e.z - t.z, len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len;
        for (const e of this.enemies) {
          if (e === b.e || !this.targetable(e) || !this.canHit(t, e)) continue;
          const px = e.x - t.x, pz = e.z - t.z, along = px * ux + pz * uz;
          if (along < 0.3 || along > s.range) continue;
          if (Math.abs(px * uz - pz * ux) <= 0.28 + e.radius * 0.4) this.damage(e, dps * s.lance * dt, t, 'energy', DOT);
        }
      }
    }
    if (t.beams.length) { const e = t.beams[0].e; t.aim = Math.atan2(e.x - t.x, e.z - t.z); }
  }

  updateFlame(t, s, dt, rm) {
    const target = this.findTarget(t, s.range);
    t.flameOn = !!target;
    if (!target) return;
    const want = Math.atan2(target.x - t.x, target.z - t.z);
    let d = ((want - t.aim + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    t.aim += d * Math.min(1, dt * 10);
    const cosHalf = Math.cos((s.cone * Math.PI) / 360);
    const r2 = s.range * s.range;
    const dps = s.dps * rm;
    const ax = Math.sin(t.aim), az = Math.cos(t.aim);
    const o = s.armorPierce ? { dot: true, armorPierce: true, aoe: true } : { dot: true, aoe: true };
    for (const e of this.enemies) {
      if (e.dead || e.inWarp || e.air) continue;
      const dx = e.x - t.x, dz = e.z - t.z, d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const len = Math.sqrt(d2) || 1;
      if ((dx * ax + dz * az) / len < cosHalf && len > 0.45) continue;
      this.damage(e, dps * dt, t, 'thermal', o);
      if (!e.dead) this.applyBurn(e, s.burn, t);
    }
  }

  // Drone carriers and mine layers manage their own entities.
  updateLauncher(t, s, dt, rm) {
    if (s.attack === 'drones') {
      while (t.drones.length < s.drones) {
        const d = { id: this.nextId++, owner: t, kind: s.kind, x: t.x, y: 0.8, z: t.z, vx: 0, vz: 0, target: null, cd: this.rand() * 0.5, orbit: this.rand() * 6.28, aim: 0, dead: false };
        t.drones.push(d);
        this.drones.push(d);
      }
      while (t.drones.length > s.drones) t.drones.pop().dead = true;
      for (const d of t.drones) d.kind = s.kind;
      return;
    }
    t.mineT -= dt * rm;
    if (t.mineT > 0) return;
    let mine = 0;
    for (const m of this.mines) if (m.owner === t) mine++;
    if (mine >= s.max) { t.mineT = 0; return; }
    t.mineT = 1 / s.rate;
    const spot = this.mineSpot(t, s.range);
    if (!spot) return;
    const m = { id: this.nextId++, owner: t, kind: s.kind, x: spot.x, z: spot.z, armT: 0.8, dead: false };
    this.mines.push(m);
    t.aim = Math.atan2(spot.x - t.x, spot.z - t.z);
    this.emit('mineDrop', { mine: m, tower: t });
  }

  mineSpot(t, range) {
    const r2 = range * range;
    const cands = [];
    for (const p of this.map.paths) {
      for (let d = 0.8; d < p.length - 0.5; d += 0.3) {
        if (p.inWarp(d)) continue;
        const q = p.sample(d, TMP);
        if ((q.x - t.x) ** 2 + (q.z - t.z) ** 2 > r2) continue;
        let ok = true;
        for (const m of this.mines) if ((m.x - q.x) ** 2 + (m.z - q.z) ** 2 < 0.3) { ok = false; break; }
        if (ok) cands.push({ x: q.x + (this.rand() - 0.5) * 0.25, z: q.z + (this.rand() - 0.5) * 0.25 });
      }
    }
    return cands.length ? cands[Math.floor(this.rand() * cands.length)] : null;
  }

  updateDrones(dt) {
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.dead) { this.drones.splice(i, 1); continue; }
      const t = d.owner;
      const s = t.stats;
      const disabled = t.disabledT > 0;
      const leash = s.range;
      if (d.target && (!this.targetable(d.target) || !this.canHit(t, d.target) || Math.hypot(d.target.x - t.x, d.target.z - t.z) > leash * 1.15)) d.target = null;
      if (!d.target && !disabled) {
        let best = null, bd = Infinity;
        for (const e of this.enemies) {
          if (!this.targetable(e) || !this.canHit(t, e)) continue;
          if ((e.x - t.x) ** 2 + (e.z - t.z) ** 2 > leash * leash) continue;
          const dd = (e.x - d.x) ** 2 + (e.z - d.z) ** 2 - (s.preferAir && e.air ? 100 : 0);
          if (dd < bd) { bd = dd; best = e; }
        }
        d.target = best;
      }
      d.orbit += dt * (d.kind === 'gunship' ? 1.2 : 2.4);
      const r = d.kind === 'gunship' ? 0.9 : 0.55;
      let gx, gz;
      if (d.target && !disabled) { gx = d.target.x + Math.cos(d.orbit) * r; gz = d.target.z + Math.sin(d.orbit) * r; }
      else { gx = t.x + Math.cos(d.orbit) * 0.7; gz = t.z + Math.sin(d.orbit) * 0.7; }
      const speed = d.kind === 'gunship' ? 3.6 : d.kind === 'swarm' ? 6 : 5;
      const dx = gx - d.x, dz = gz - d.z, dist = Math.hypot(dx, dz) || 1;
      const k = Math.min(1, dt * 4);
      d.vx += ((dx / dist) * Math.min(speed, dist * 4) - d.vx) * k;
      d.vz += ((dz / dist) * Math.min(speed, dist * 4) - d.vz) * k;
      d.x += d.vx * dt;
      d.z += d.vz * dt;
      d.y = (d.kind === 'gunship' ? 1.25 : 1.0) + Math.sin(d.orbit * 1.7) * 0.08;
      d.cd -= dt * this.rateMul(t);
      const e = d.target;
      if (!e || disabled) continue;
      d.aim = Math.atan2(e.x - d.x, e.z - d.z);
      if (d.cd > 0 || (e.x - d.x) ** 2 + (e.z - d.z) ** 2 > 2.2) continue;
      d.cd = 1 / s.rate;
      if (d.kind === 'gunship') {
        this.projectiles.push({
          id: this.nextId++, kind: 'missile', tower: t, target: e, x: d.x, y: d.y, z: d.z, vx: 0, vy: 0.5, vz: 0,
          speed: 6, life: 2.5, tx: e.x, ty: e.h, tz: e.z, dmg: s.damage, s, dtype: 'explosive', airMul: 1, groundMul: 1, dead: false, rocket: true,
        });
        this.emit('droneFire', { drone: d, rocket: true });
      } else {
        this.damage(e, s.damage, t, 'kinetic');
        if (s.droneMark && !e.dead) this.mark(e, s.droneMark, 2, t);
        this.emit('droneFire', { drone: d, target: e });
      }
    }
  }

  updateMines(dt) {
    for (const m of this.mines) {
      if (m.dead) continue;
      if (m.armT > 0) { m.armT -= dt; continue; }
      for (const e of this.enemies) {
        if (e.dead || e.air || e.inWarp) continue;
        if ((e.x - m.x) ** 2 + (e.z - m.z) ** 2 <= 0.16) { this.detonate(m); break; }
      }
    }
    let j = 0;
    for (let i = 0; i < this.mines.length; i++) if (!this.mines[i].dead) this.mines[j++] = this.mines[i];
    this.mines.length = j;
  }

  detonate(m) {
    if (m.dead) return;
    m.dead = true;
    const t = m.owner;
    const s = t.stats;
    const dtype = s.dtype || 'explosive';
    for (const e of this.enemiesNear(m.x, m.z, s.splash)) {
      if (e.air) continue;
      if (s.stun) this.applyStun(e, s.stun);
      this.damage(e, s.damage, t, dtype, { aoe: true, shieldMul: s.shieldMul || 1 });
      if (s.knockback && !e.dead && !e.boss) { e.dist = Math.max(0, e.dist - s.knockback); this.placeEnemy(e); }
    }
    this.emit('mineBoom', { x: m.x, z: m.z, r: s.splash, kind: m.kind });
    if (s.chainMines) {
      const r2 = s.chainMines * s.chainMines;
      for (const o of this.mines) if (!o.dead && o.armT <= 0 && (o.x - m.x) ** 2 + (o.z - m.z) ** 2 <= r2) this.detonate(o);
    }
  }

  auraPulse(t, s) {
    const r2 = s.range * s.range;
    let any = false;
    for (const e of this.enemies) {
      if (e.dead || e.inWarp) continue;
      const dx = e.x - t.x, dz = e.z - t.z;
      if (dx * dx + dz * dz > r2) continue;
      any = true;
      this.applySlow(e, s.slow, s.slowTime, t);
      e.vulnAmt = Math.max(e.vulnAmt, s.vuln);
      e.vulnTime = Math.max(e.vulnTime, s.slowTime);
      if (s.noHeal) { e.noHealT = 0.6; e.noShieldT = 0.6; }
      this.damage(e, s.damage / s.rate, t, 'cryo', { dot: true, aoe: true });
    }
    t.auraActive = any;
  }

  sensorPulse(t, s) {
    const r2 = s.range * s.range;
    const list = [];
    for (const e of this.enemies) {
      if (e.dead || e.inWarp) continue;
      if ((e.x - t.x) ** 2 + (e.z - t.z) ** 2 <= r2) list.push(e);
    }
    if (!list.length) return;
    if (s.marks < list.length) list.sort((a, b) => b.hp + b.shield - (a.hp + a.shield));
    for (let i = 0; i < Math.min(s.marks, list.length); i++) this.mark(list[i], s.mark, 3, t, s.shred || 0);
    this.emit('ping', { tower: t });
  }

  // ---------------------------------------------------------------- projectiles
  updateProjectiles(dt) {
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.dead) continue;
      if (p.kind === 'bullet' || p.kind === 'frost') this.stepHoming(p, dt);
      else if (p.kind === 'shell' || p.kind === 'bomblet' || p.kind === 'napalm') this.stepShell(p, dt);
      else if (p.kind === 'missile') this.stepMissile(p, dt);
    }
    let j = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead) list[j++] = list[i];
    list.length = j;
  }

  stepHoming(p, dt) {
    const e = p.target;
    if (!e.dead) { p.tx = e.x; p.ty = e.h; p.tz = e.z; }
    const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z;
    const d = Math.hypot(dx, dy, dz);
    const step = p.speed * dt;
    if (d <= step + 0.06) {
      p.dead = true;
      if (e.dead || e.inWarp) return;
      const s = p.s;
      if (p.kind === 'bullet') {
        this.damage(e, p.dmg, p.tower, p.dtype || 'kinetic');
        this.emit('hit', { x: p.tx, y: p.ty, z: p.tz, kind: 'bullet', color: p.tower.def.color });
      } else {
        const targets = s.splash ? this.enemiesNear(p.tx, p.tz, s.splash) : [e];
        for (const o of targets) {
          if (!this.canHit(p.tower, o)) continue;
          this.applySlow(o, s.slow, s.slowTime, p.tower);
          if (s.freeze && !o.boss && !o.def.ccImmune && this.rand() < s.freeze) {
            o.stunTime = Math.max(o.stunTime, s.freezeTime);
            o.frozen = true;
            this.emit('freeze', { enemy: o });
          }
          this.damage(o, o === e ? p.dmg : p.dmg * 0.5, p.tower, 'cryo', s.splash ? AOE : NO);
        }
        this.emit('hit', { x: p.tx, y: p.ty, z: p.tz, kind: 'frost', splash: s.splash || 0 });
      }
      return;
    }
    p.x += (dx / d) * step;
    p.y += (dy / d) * step;
    p.z += (dz / d) * step;
  }

  stepShell(p, dt) {
    p.t += dt;
    const u = Math.min(1, p.t / p.T);
    p.x = p.sx + (p.tx - p.sx) * u;
    p.z = p.sz + (p.tz - p.sz) * u;
    p.y = p.sy * (1 - u) + p.arc * 4 * u * (1 - u);
    if (u < 1) return;
    p.dead = true;
    const s = p.s;
    const radius = p.kind === 'bomblet' ? 0.6 : s.splash;
    const dtype = p.kind === 'napalm' ? 'thermal' : 'explosive';
    this.splash(p.tx, 0, p.tz, radius, p.dmg, p.tower, false, true, 1, 1, dtype);
    this.emit('explode', { x: p.tx, y: 0.05, z: p.tz, r: radius, kind: p.kind === 'bomblet' ? 'bomblet' : p.kind === 'napalm' ? 'napalm' : 'mortar' });
    if (p.kind === 'napalm') {
      const pool = s.pool;
      this.zones.push({ kind: 'fire', x: p.tx, z: p.tz, r: pool.radius, time: pool.time, max: pool.time, dps: pool.dps, slow: pool.slow, burn: pool.dps * 0.3, src: p.tower });
      return;
    }
    if (p.kind === 'shell' && s.cluster) {
      for (let i = 0; i < s.cluster; i++) {
        const a = (i / s.cluster) * Math.PI * 2 + this.rand() * 0.6;
        const r = 0.7 + this.rand() * (0.9 + s.cluster * 0.04);
        this.projectiles.push({
          id: this.nextId++, kind: 'bomblet', tower: p.tower, sx: p.tx, sy: 0.1, sz: p.tz, x: p.tx, y: 0.1, z: p.tz,
          tx: p.tx + Math.cos(a) * r, tz: p.tz + Math.sin(a) * r, T: 0.35 + this.rand() * 0.2, t: 0, arc: 0.9,
          dmg: s.clusterDamage, s, dead: false,
        });
      }
    }
    if (p.kind === 'shell' && s.well) {
      this.wells.push({ x: p.tx, z: p.tz, time: s.well.time, max: s.well.time, r: s.well.radius, slow: s.well.slow, dps: s.well.dps, pull: s.well.pull, tower: p.tower });
      this.emit('well', { x: p.tx, z: p.tz, r: s.well.radius, time: s.well.time });
    }
  }

  stepMissile(p, dt) {
    if (p.delay > 0) { p.delay -= dt; return; }
    let e = p.target;
    if (!e || e.dead || e.inWarp) {
      const nt = this.nearestEnemy(p.x, p.z, 2.5, p.tower);
      if (nt) p.target = e = nt;
    }
    if (e && !e.dead) { p.tx = e.x; p.ty = e.h; p.tz = e.z; }
    p.life -= dt;
    p.speed = Math.min(p.rocket ? 9 : 11, p.speed + 14 * dt);
    const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(1, 7 * dt);
    p.vx += ((dx / d) * p.speed - p.vx) * k;
    p.vy += ((dy / d) * p.speed - p.vy) * k;
    p.vz += ((dz / d) * p.speed - p.vz) * k;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (d < 0.28 || p.life <= 0 || ((!e || e.dead) && d < 0.5)) {
      p.dead = true;
      const s = p.s;
      const air = p.ty > 0.8;
      const r = p.nuke ? 2.6 : s.splash;
      this.splash(p.x, p.y, p.z, r, p.dmg, p.tower, air || p.nuke, !air || p.nuke, p.airMul, p.groundMul, p.dtype || 'explosive');
      this.emit('explode', { x: p.x, y: p.y, z: p.z, r, kind: p.nuke ? 'nuke' : p.sub ? 'bomblet' : 'missile' });
      if (p.nuke) this.zones.push({ kind: 'rad', x: p.x, z: p.z, r: 1.6, time: 4, max: 4, dps: p.dmg * 0.04, src: p.tower });
      if (p.mirv) {
        for (let i = 0; i < p.mirv; i++) {
          const a = (i / p.mirv) * Math.PI * 2 + this.rand();
          const tg = this.nearestEnemy(p.x + Math.cos(a) * 1.2, p.z + Math.sin(a) * 1.2, 2, p.tower);
          this.projectiles.push({
            id: this.nextId++, kind: 'missile', tower: p.tower, target: tg, x: p.x, y: p.y + 0.2, z: p.z,
            vx: Math.cos(a) * 3, vy: 2, vz: Math.sin(a) * 3, speed: 4, life: 1.6,
            tx: tg ? tg.x : p.x + Math.cos(a), ty: tg ? tg.h : 0, tz: tg ? tg.z : p.z + Math.sin(a),
            dmg: p.dmg * 0.4, s: { splash: 0.5 }, dtype: p.dtype, airMul: p.airMul, groundMul: p.groundMul, dead: false, sub: true,
          });
        }
      }
    }
  }

  nearestEnemy(x, z, range, t) {
    let best = null, bd = range * range;
    for (const e of this.enemies) {
      if (!this.targetable(e) || (t && t.def && !this.canHit(t, e))) continue;
      const dx = e.x - x, dz = e.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  enemiesNear(x, z, r) {
    const out = [];
    for (const e of this.enemies) {
      if (e.dead || e.inWarp) continue;
      const dx = e.x - x, dz = e.z - z, rr = r + e.radius * 0.5;
      if (dx * dx + dz * dz <= rr * rr) out.push(e);
    }
    return out;
  }

  // 3D splash with linear falloff (100% at center, 50% at edge). Splash hits cloaked units and reveals them.
  splash(x, y, z, r, dmg, src, air, ground, airMul = 1, groundMul = 1, dtype = 'explosive') {
    for (const e of this.enemies) {
      if (e.dead || e.inWarp || (e.air ? !air : !ground)) continue;
      const dx = e.x - x, dy = (e.air ? e.h : 0) - y, dz = e.z - z;
      const rr = r + e.radius * 0.5;
      const d2 = dx * dx + dy * dy * 0.5 + dz * dz;
      if (d2 > rr * rr) continue;
      const f = 1 - 0.5 * Math.min(1, Math.sqrt(d2) / rr);
      this.damage(e, dmg * f * (e.air ? airMul : groundMul), src, dtype, AOE);
      if (dtype === 'thermal' && !e.dead && src && src.stats) this.applyBurn(e, src.stats.pool ? src.stats.pool.dps * 0.3 : 10, src);
    }
  }

  updateEffects(dt) {
    for (let i = this.wells.length - 1; i >= 0; i--) {
      const w = this.wells[i];
      w.time -= dt;
      if (w.time <= 0) { this.wells.splice(i, 1); continue; }
      const r2 = w.r * w.r;
      for (const e of this.enemies) {
        if (e.dead || e.air || e.inWarp) continue;
        const dx = e.x - w.x, dz = e.z - w.z;
        if (dx * dx + dz * dz > r2) continue;
        this.applySlow(e, w.slow, 0.25);
        this.damage(e, w.dps * dt, w.tower, 'explosive', DOT);
        if (w.pull && !e.boss && !e.def.ccImmune && !e.dead) e.dist = Math.max(0, e.dist - w.pull * dt);
      }
    }
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.time -= dt;
      if (z.time <= 0) { this.zones.splice(i, 1); continue; }
      const r2 = z.r * z.r;
      for (const e of this.enemies) {
        if (e.dead || e.inWarp) continue;
        if (z.kind === 'fire' && e.air) continue;
        const dx = e.x - z.x, dz = e.z - z.z;
        if (dx * dx + dz * dz > r2) continue;
        if (z.kind === 'fire') {
          this.damage(e, z.dps * dt, z.src, 'thermal', DOT);
          if (!e.dead) this.applyBurn(e, z.burn, z.src);
          if (z.slow) this.applySlow(e, z.slow, 0.3);
        } else if (z.kind === 'rad') {
          this.damage(e, z.dps * dt, z.src, 'explosive', DOT);
        }
      }
    }
  }

  _facePath(x, z) {
    let best = 0, bd = Infinity;
    for (const p of this.map.paths) {
      for (let d = 0; d < p.length; d += 0.5) {
        const q = p.sample(d, TMP);
        const dd = (q.x - x) ** 2 + (q.z - z) ** 2;
        if (dd < bd) { bd = dd; best = Math.atan2(q.x - x, q.z - z); }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- save / resume (taken at wave start)
  snapshot() {
    return {
      v: 2, level: this.level.id, difficulty: this.difficulty, endless: this.endless, loadout: this.loadout.slice(),
      wave: this.wave, credits: this.credits, lives: this.lives, cleared: this.cleared.slice(),
      towers: this.towers.map((t) => ({ type: t.type, level: t.level, spec: t.spec, col: t.col, row: t.row, targeting: t.targeting, invested: t.invested, kills: t.kills, damage: t.damage, xp: t.xp, rank: t.rank })),
      stats: { ...this.stats, built: this.stats.built.slice() }, seen: [...this.seen],
    };
  }

  restore(snap) {
    this.wave = snap.wave;
    this.credits = snap.credits;
    this.lives = snap.lives;
    this.stats = { ...this.stats, ...snap.stats, built: (snap.stats && snap.stats.built) || [] };
    this.seen = new Set(snap.seen || []);
    for (const [c, r] of snap.cleared || []) { this.map.clearWreck(c, r); this.cleared.push([c, r]); }
    for (const s of snap.towers) {
      const t = this._addTower(s.type, s.col, s.row, s.invested);
      t.level = s.level;
      t.spec = s.spec;
      t.targeting = s.targeting;
      t.kills = s.kills;
      t.damage = s.damage;
      t.xp = s.xp || 0;
      t.rank = s.rank || 0;
    }
    this.recomputeStats();
    this.events.length = 0;
  }
}
