// In-game HUD: stats, commander abilities, wave control, radial menus, info panels, banners and floating texts.
import { h, svg, fmt, add } from './dom.js';
import {
  TOWERS, ENEMIES, ABILITIES, TARGET_LABEL, DAMAGE_TYPES, DAMAGE_ORDER, ARMOR_CLASSES, VETERANCY, POWER_NODE,
  towerInfo, damageType,
} from '../core/config.js';
import { earlyBonus } from '../core/waves.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const r0 = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

// Rows of [label, value] describing a tower's stats.
export function statRows(type, s) {
  const kind = s.attack || TOWERS[type].attack;
  const rows = [];
  if (kind === 'beam') {
    rows.push(['每秒傷害', `${Math.round(s.dpsMin)}→${Math.round(s.dpsMax)}`]);
    rows.push(['聚能時間', `${s.ramp}s`]);
    if (s.beams > 1) rows.push(['光束', `${s.beams} 道`]);
    if (s.lance) rows.push(['貫穿', pct(s.lance)]);
  } else if (kind === 'support') {
    rows.push(['傷害增幅', `+${pct(s.buffDamage)}`]);
    rows.push(['射程增幅', `+${pct(s.buffRange)}`]);
    if (s.buffRate) rows.push(['射速增幅', `+${pct(s.buffRate)}`]);
    if (s.income) rows.push(['每波收入', `+${s.income}`]);
    if (s.salvage) rows.push(['擊殺賞金', `+${pct(s.salvage)}`]);
    if (s.interest) rows.push(['利息率', `+${pct(s.interest)}`]);
  } else if (kind === 'aura') {
    rows.push(['每秒傷害', `${r0(s.damage)}`]);
    rows.push(['減速', pct(s.slow)]);
    rows.push(['易傷', `+${pct(s.vuln)}`]);
    if (s.noHeal) rows.push(['禁療', '是']);
  } else if (kind === 'flame') {
    rows.push(['每秒傷害', `${Math.round(s.dps)}`]);
    rows.push(['燃燒', `${Math.round(s.burn)}/秒 ×3層`]);
    rows.push(['噴射角', `${s.cone}°`]);
  } else if (kind === 'drones') {
    rows.push(['無人機', `${s.drones} 架`]);
    rows.push(['每架傷害', `${r0(s.damage)} × ${s.rate}/秒`]);
  } else if (kind === 'sensor') {
    rows.push(['標記易傷', `+${pct(s.mark)}`]);
    rows.push(['標記數量', s.marks >= 99 ? '全部' : `${s.marks}`]);
    if (s.jam) rows.push(['干擾減速', pct(s.jam)]);
    if (s.shred) rows.push(['削甲', pct(s.shred)]);
  } else if (kind === 'mines') {
    rows.push(['地雷傷害', `${Math.round(s.damage)}`]);
    rows.push(['佈雷速度', `${(1 / s.rate).toFixed(1)}s / 枚`]);
    rows.push(['最多', `${s.max} 枚`]);
  } else {
    rows.push(['傷害', `${r0(s.damage)}${s.missiles > 1 ? ' ×' + s.missiles : ''}`]);
    rows.push(['射速', `${s.rate.toFixed(1)}/秒`]);
    rows.push(['秒傷', `${Math.round(s.damage * s.rate * (s.missiles || 1))}`]);
  }
  if (kind !== 'support') rows.push([kind === 'drones' ? '巡航範圍' : kind === 'sensor' ? '偵測範圍' : '射程', s.range.toFixed(1)]);
  if (s.splash && kind !== 'aura') rows.push(['爆炸範圍', s.splash.toFixed(1)]);
  if (s.slow && kind !== 'aura') rows.push(['減速', `${pct(s.slow)} · ${s.slowTime}s`]);
  if (s.chain) rows.push(['連鎖', `${s.chain} 目標`]);
  if (s.freeze) rows.push(['凍結機率', pct(s.freeze)]);
  if (s.stun) rows.push(['癱瘓', `${s.stun}s`]);
  if (s.cluster) rows.push(['子彈', `${s.cluster} × ${Math.round(s.clusterDamage)}`]);
  if (s.well) rows.push(['奇點', `${s.well.time}s · ${Math.round(s.well.dps)}/秒`]);
  if (s.pool) rows.push(['火海', `${s.pool.time}s · ${Math.round(s.pool.dps)}/秒`]);
  return rows;
}

export function towerTags(type, s) {
  const def = TOWERS[type];
  const t = [];
  if (def.attack === 'support') return ['輔助'];
  if (def.ground) t.push('對地');
  if (def.air) t.push(def.airMul ? `對空 ×${def.airMul}` : '對空');
  if (s.armorPierce) t.push('無視裝甲');
  if (s.pierceResist) t.push('無視抗性');
  if (s.pierce) t.push('穿透');
  if (s.shieldMul > 1) t.push(`護盾 ×${2 * s.shieldMul}`);
  if (s.attack === 'sensor') t.push('偵測隱形');
  if (s.splash || s.attack === 'aura' || s.attack === 'flame') t.push('範圍');
  if (s.spinup) t.push('轉速提升');
  if (s.overcharge) t.push(`每${s.overcharge}發超載`);
  if (s.storm) t.push(`每${s.storm}次雷暴`);
  if (s.nuke) t.push(`每${s.nuke}發核彈`);
  if (s.mirv) t.push('分裂彈頭');
  if (s.spread) t.push('燃燒擴散');
  if (s.shatter) t.push('碎冰爆');
  if (s.chainMines) t.push('連鎖引爆');
  if (s.knockback) t.push('震退');
  if (s.well && s.well.pull) t.push('牽引');
  return t;
}

// Tower role tag in the tower's own signature color (e.g. 防空專精).
export function roleChip(type) {
  const d = TOWERS[type];
  const c = `#${d.color.toString(16).padStart(6, '0')}`;
  return h('span', { class: 'dchip role', style: { color: c, borderColor: c } }, d.role);
}

export function dmgChip(type, extra = '') {
  const d = DAMAGE_TYPES[type];
  return h('span', { class: `dchip ${extra}`, style: { color: d.color, borderColor: d.color } }, d.name);
}

export class Hud {
  constructor(session) {
    this.s = session;
    const app = session.app;
    this.app = app;
    this.icons = app.thumbs || { tower: {}, enemy: {} };
    this.cache = {};
    const root = (this.root = h('div', { class: 'hud layer fade-in' }));
    const g = session.game;
    // ---- top bar
    this.elLives = h('div', { class: 'stat lives panel num' }, svg('core'), h('span'));
    this.elCredits = h('div', { class: 'stat credits panel num' }, svg('credits'), h('span'));
    this.elWave = h('div', { class: 'stat wave panel num' }, h('small', {}, '波次'), h('span'));
    this.elSpeed = h('button', { class: 'icon-btn speed-btn', onclick: () => session.cycleSpeed() }, svg('play'), h('span', { class: 'num' }, '1×'));
    this.elPause = h('button', { class: 'icon-btn', onclick: () => session.openPause() }, svg('pause'));
    root.append(h('div', { class: 'hud-top' }, this.elLives, this.elCredits, this.elWave, h('div', { class: 'spacer' }), this.elSpeed, this.elPause));
    // ---- boss bar
    this.elBoss = h('div', { class: 'boss-bar', style: { display: 'none' } }, h('div', { class: 'bn' }), h('div', { class: 'bb' }, h('i'), h('b')));
    root.append(this.elBoss);
    // ---- bottom-left: commander abilities
    const left = h('div', { class: 'bottom-left' });
    this.abBtns = {};
    const ab = h('div', { class: 'abilities' });
    for (const id of g.level.abilities) {
      const b = h('button', { class: `ability ${id}`, onclick: () => session.pressAbility(id) }, h('div', { class: 'cd' }), svg(id), h('span', { class: 't num' }), h('span', { class: 'lbl' }, ABILITIES[id].name));
      this.abBtns[id] = b;
      ab.append(b);
    }
    left.append(ab);
    root.append(left);
    // ---- wave control
    this.elNext = h('button', { class: 'btn primary next-btn', onclick: () => session.callWave() });
    root.append(h('div', { class: 'wave-box' }, this.elNext));
    // ---- overlays
    this.elFloats = h('div', { class: 'floats' });
    this.vHurt = h('div', { class: 'vignette hurt' });
    this.vStasis = h('div', { class: 'vignette stasis' });
    this.vThunder = h('div', { class: 'vignette thunder' });
    root.prepend(this.vHurt, this.vStasis, this.vThunder, this.elFloats);
    this.radial = null;
    this.info = null;
    this.floatPool = [];
    this.lastFloat = 0;
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    const g = this.s.game;
    const c = this.cache;
    const lives = Math.max(0, Math.ceil(g.lives));
    if (c.lives !== lives) {
      if (c.lives !== undefined && lives < c.lives) this.bump(this.elLives);
      c.lives = lives;
      this.elLives.lastChild.textContent = lives;
      this.elLives.classList.toggle('low', lives / g.maxLives < 0.35);
    }
    const credits = Math.floor(g.credits);
    if (c.credits !== credits) {
      if (c.credits !== undefined && credits > c.credits + 20) this.bump(this.elCredits);
      c.credits = credits;
      this.elCredits.lastChild.textContent = fmt(credits);
      if (this.radial) this.refreshRadialAfford();
    }
    const waveTxt = g.endless ? `${g.wave}` : `${g.wave}/${g.totalWaves}`;
    if (c.wave !== waveTxt) { c.wave = waveTxt; this.elWave.lastChild.textContent = waveTxt; }
    const can = g.canCallWave();
    const early = can && g.enemies.length > 0 && g.wave > 0;
    const peek = g.peekWave();
    const nextKey = `${can}|${early}|${g.wave}|${g.state}`;
    if (c.next !== nextKey) {
      c.next = nextKey;
      this.elNext.textContent = '';
      if (!peek) {
        this.elNext.append(g.enemies.length ? '最終波進行中' : '完成');
        this.elNext.disabled = true;
      } else {
        this.elNext.disabled = !can;
        this.elNext.append(svg('play'), g.wave === 0 ? '開始波次' : can ? '下一波' : '敵軍來襲中');
        if (early) this.elNext.append(h('span', { class: 'bonus num' }, `+${earlyBonus(g.wave + 1)}`));
        this.elNext.classList.toggle('pulse', g.wave === 0);
      }
    }
    for (const id in this.abBtns) this.cooldown(this.abBtns[id], g.abilities[id].cd, g.abilities[id].max, false);
    let boss = null;
    for (const e of g.enemies) if (e.boss && (!boss || e.hp > boss.hp)) boss = e;
    if (boss) {
      if (this.elBoss.style.display === 'none' || this.bossType !== boss.type) { this.bossType = boss.type; this.elBoss.style.display = ''; this.elBoss.querySelector('.bn').textContent = `首領 · ${ENEMIES[boss.type].name}`; }
      this.elBoss.querySelector('i').style.width = `${(boss.hp / boss.maxHp) * 100}%`;
      this.elBoss.querySelector('b').style.width = boss.maxShield ? `${(boss.shield / boss.maxShield) * 100}%` : '0';
    } else if (this.elBoss.style.display !== 'none') this.elBoss.style.display = 'none';
    const spTxt = `${this.s.speed}×`;
    if (c.speed !== spTxt) { c.speed = spTxt; this.elSpeed.lastChild.textContent = spTxt; this.elSpeed.classList.toggle('fast', this.s.speed > 1); }
    this.vStasis.classList.toggle('on', g.stasisT > 0);
    if (this.radial && this.radial.anchor) this.placeRadial();
    if (this.enemyEl) this.updateEnemyCard();
  }

  cooldown(b, cd, max, locked) {
    const f = max > 0 ? cd / max : 0;
    const key = `${locked}|${cd > 0 ? Math.ceil(cd) : 'r'}|${Math.round(f * 60)}`;
    if (b._k === key) return;
    b._k = key;
    b.querySelector('.cd').style.background = cd > 0 && !locked ? `conic-gradient(rgba(5,6,16,0.82) ${f * 360}deg, transparent 0)` : 'none';
    b.querySelector('.t').textContent = cd > 0 && !locked ? Math.ceil(cd) : '';
    b.classList.toggle('cooling', cd > 0 || locked);
    b.classList.toggle('ready', cd <= 0 && !locked);
    b.classList.toggle('locked', locked);
  }

  bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }


  // ---------------------------------------------------------------- floating texts / banners / cards
  float(x, y, text, cls = '') {
    const now = performance.now();
    if (!cls && now - this.lastFloat < 40) return;
    this.lastFloat = now;
    let el = this.floatPool.pop();
    if (!el) el = h('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.elFloats.append(el);
    setTimeout(() => { el.remove(); if (this.floatPool.length < 30) this.floatPool.push(el); }, 900);
  }

  banner(title, sub, boss = false) {
    const b = h('div', { class: `banner${boss ? ' boss' : ''}` }, h('div', { class: 'b1' }, title), sub ? h('div', { class: 'b2' }, sub) : null);
    this.root.append(b);
    setTimeout(() => b.remove(), 2500);
  }

  newEnemy(type) {
    if (this.card) this.card.remove();
    const d = ENEMIES[type];
    const card = (this.card = h('div', { class: 'newcard panel pass' },
      this.icons.enemy[type] ? h('img', { src: this.icons.enemy[type] }) : null,
      h('div', {}, h('div', { class: 't1' }, d.boss ? '⚠ 首領出現' : `新敵人 · ${ARMOR_CLASSES[d.cls].name}`), h('div', { class: 't2' }, d.name), h('div', { class: 't3' }, d.desc))));
    this.root.append(card);
    setTimeout(() => { if (this.card === card) { card.remove(); this.card = null; } }, 7000);
  }

  hurt() {
    this.vHurt.classList.add('on');
    clearTimeout(this.hurtT);
    this.hurtT = setTimeout(() => this.vHurt.classList.remove('on'), 350);
  }

  // brief sky-flash for the full-field thunder strike (a CSS overlay, not an HDR light, so it can't white out the scene)
  thunderFlash() {
    this.vThunder.classList.add('on');
    clearTimeout(this.thunderT);
    this.thunderT = setTimeout(() => this.vThunder.classList.remove('on'), 160);
  }

  hint(html, ms = 0) {
    if (this.hintEl) this.hintEl.remove();
    this.hintEl = null;
    clearTimeout(this.hintT);
    if (!html) return;
    const el = (this.hintEl = h('div', { class: 'hint-bubble panel', html }));
    this.root.append(el);
    if (ms > 0) this.hintT = setTimeout(() => { if (this.hintEl === el) { el.remove(); this.hintEl = null; } }, ms);
  }

  toast(text, ms = 1800) {
    if (this.toastEl) this.toastEl.remove();
    const t = (this.toastEl = h('div', { class: 'toast panel' }, text));
    this.root.append(t);
    setTimeout(() => { if (this.toastEl === t) { t.remove(); this.toastEl = null; } }, ms);
  }

  // ---------------------------------------------------------------- enemy inspection card
  enemyCard(e) {
    this.closeEnemyCard();
    this.enemyTarget = e;
    const d = e.def;
    const cls = ARMOR_CLASSES[e.cls];
    const weak = [], strong = [];
    for (const k of DAMAGE_ORDER) {
      const m = cls.mul[k];
      const chip = h('span', { class: `dchip${m <= 0.85 ? ' dim' : ''}`, style: { color: DAMAGE_TYPES[k].color, borderColor: DAMAGE_TYPES[k].color } }, `${DAMAGE_TYPES[k].name} ×${m}`);
      if (m >= 1.15) weak.push(chip);
      else if (m <= 0.85) strong.push(chip);
    }
    const traits = [];
    if (d.air) traits.push('飛行');
    if (d.cloak) traits.push('隱形');
    if (d.ccImmune) traits.push('免疫控制');
    if (d.shield) traits.push('能量護盾');
    if (d.heal) traits.push('治療友軍');
    if (d.regen) traits.push('再生');
    if (d.blink) traits.push('瞬移');
    if (d.emp) traits.push('EMP');
    if (d.berserk) traits.push('狂暴');
    if (d.split) traits.push('分裂');
    if (d.summon) traits.push('召喚');
    if (d.boss) traits.push('首領');
    this.enemyEl = h('div', { class: 'enemy-card panel' },
      h('div', { class: 'ih' }, this.icons.enemy[e.type] ? h('img', { src: this.icons.enemy[e.type] }) : null,
        h('div', {}, h('div', { class: 'in' }, d.name), h('div', { class: 'lvl' }, `${cls.name}裝甲`), h('div', { class: 'ie' }, cls.desc))),
      h('div', { class: 'id' }, d.desc),
      h('table', {}, h('tr', {}, h('td', {}, '生命'), h('td', { class: 'num ehp' })), h('tr', {}, h('td', {}, '護甲'), h('td', { class: 'num' }, `${e.armor}`)),
        h('tr', {}, h('td', {}, '速度'), h('td', { class: 'num' }, `${e.speed.toFixed(2)}`))),
      weak.length ? h('div', { class: 'res' }, h('span', { class: 'rl good' }, '弱點'), ...weak) : null,
      strong.length ? h('div', { class: 'res' }, h('span', { class: 'rl bad' }, '抗性'), ...strong) : null,
      traits.length ? h('div', { class: 'tags' }, traits.map((t) => h('span', {}, t))) : null,
      h('button', { class: 'icon-btn close', onclick: () => this.closeEnemyCard() }, svg('close')));
    this.root.append(this.enemyEl);
    this.updateEnemyCard();
  }

  updateEnemyCard() {
    const e = this.enemyTarget;
    if (!e || e.dead) { this.closeEnemyCard(); return; }
    const el = this.enemyEl.querySelector('.ehp');
    const txt = `${Math.ceil(e.hp)}/${Math.ceil(e.maxHp)}${e.maxShield ? ` ⬡${Math.ceil(e.shield)}` : ''}`;
    if (el.textContent !== txt) el.textContent = txt;
  }

  closeEnemyCard() { if (this.enemyEl) { this.enemyEl.remove(); this.enemyEl = null; this.enemyTarget = null; } }

  // ---------------------------------------------------------------- radial menus
  closeRadial() {
    if (this.radial) { this.radial.el.remove(); this.radial = null; }
    this.closeInfo();
  }

  openBuild(col, row, sel) {
    this.closeRadial();
    const g = this.s.game;
    const types = g.loadout;
    const el = h('div', { class: 'radial' });
    const n = types.length;
    const R = n <= 3 ? 62 : n <= 5 ? 72 : 80;
    const btns = {};
    types.forEach((type, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const b = h('button', { class: 'rbtn', style: { left: `${Math.cos(a) * R}px`, top: `${Math.sin(a) * R}px`, animationDelay: `${i * 0.025}s` },
        onclick: (ev) => { ev.stopPropagation(); this.s.radialBuild(type); } },
      h('img', { src: this.icons.tower[type] }), h('span', { class: 'cost num' }, g.buildCost(type)));
      btns[type] = b;
      el.append(b);
    });
    this.radial = { el, kind: 'build', btns, anchor: sel, R, col, row };
    this.root.append(el);
    this.placeRadial();
    this.refreshRadialAfford();
    this.showInfo(null);
  }

  openTower(t) {
    this.closeRadial();
    const g = this.s.game;
    const el = h('div', { class: 'radial' });
    const R = 70;
    const btns = {};
    const at = (a, node, key) => {
      node.style.left = `${Math.cos(a) * R}px`;
      node.style.top = `${Math.sin(a) * R}px`;
      el.append(node);
      btns[key] = node;
    };
    const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };
    if (t.level < 3) {
      at(-Math.PI / 2, h('button', { class: 'rbtn', onclick: stop(() => this.s.radialUpgrade()) }, h('img', { src: this.icons.tower[`${t.type}-3`] }), svg('up'), h('span', { class: 'cost num' }, g.upgradeCostOf(t))), 'up');
      btns.up.querySelector('svg').classList.add('upmark');
    } else if (t.level === 3) {
      for (const [spec, a] of [['a', -Math.PI / 2 - 0.55], ['b', -Math.PI / 2 + 0.55]]) {
        at(a, h('button', { class: 'rbtn', onclick: stop(() => this.s.radialUpgrade(spec)) }, h('img', { src: this.icons.tower[`${t.type}-${spec}`] }), h('span', { class: 'cost num' }, g.upgradeCostOf(t, spec))), spec);
      }
    } else if (t.level === 4) {
      const unlocked = g.ultUnlocked(t.type);
      at(-Math.PI / 2, h('button', { class: `rbtn ult${unlocked ? '' : ' lockd'}`, onclick: stop(() => this.s.radialUpgrade()) },
        h('img', { src: this.icons.tower[`${t.type}-${t.spec}5`] || this.icons.tower[`${t.type}-${t.spec}`] }), svg(unlocked ? 'star' : 'lock'),
        h('span', { class: 'cost num' }, unlocked ? g.upgradeCostOf(t) : '需研究')), 'up');
      btns.up.querySelector('svg').classList.add('upmark');
    } else {
      at(-Math.PI / 2, h('button', { class: 'rbtn max' }, h('span', { class: 'maxlbl' }, 'MAX')), 'max');
    }
    at(Math.PI / 2, h('button', { class: 'rbtn sell', onclick: stop(() => this.s.radialSell()) }, svg('sell'), h('span', { class: 'cost num' }, `+${g.sellValue(t)}`)), 'sell');
    const kind = t.stats.attack;
    if (!['support', 'aura', 'sensor', 'mines', 'drones'].includes(kind)) {
      at(Math.PI, h('button', { class: 'rbtn target', onclick: stop(() => this.s.radialTarget()) }, svg('target'), h('span', { class: 'tl' }, TARGET_LABEL[t.targeting])), 'target');
    }
    this.radial = { el, kind: 'tower', btns, anchor: { col: t.col, row: t.row, x: t.x, z: t.z }, R, tower: t };
    this.root.append(el);
    this.placeRadial();
    this.refreshRadialAfford();
    this.showInfo(null);
  }

  openWreck(w) {
    this.closeRadial();
    const el = h('div', { class: 'radial' });
    const b = h('button', { class: 'rbtn wreck', style: { left: '0px', top: '-66px' }, onclick: (ev) => { ev.stopPropagation(); this.s.radialClear(); } },
      svg('wrench'), h('span', { class: 'cost num' }, this.s.game.wreckCost(w)));
    el.append(b);
    this.radial = { el, kind: 'wreck', btns: { clear: b }, anchor: w, R: 66, wreck: w };
    this.root.append(el);
    this.placeRadial();
    this.refreshRadialAfford();
    this.showWreckInfo(w, false);
  }

  placeRadial() {
    const r = this.radial;
    const p = this.s.view.screenOf(r.anchor.x, 0.45, r.anchor.z);
    const W = window.innerWidth, H = window.innerHeight;
    const m = r.R + 34;
    const x = Math.max(m, Math.min(W - m, p.x));
    const y = Math.max(m + 30, Math.min(H - m, p.y));
    r.el.style.left = `${x}px`;
    r.el.style.top = `${y}px`;
    r.sx = p.x;
  }

  setRadialSel(key) {
    if (!this.radial) return;
    for (const k in this.radial.btns) this.radial.btns[k].classList.toggle('sel', k === key);
  }

  refreshRadialAfford() {
    const r = this.radial;
    if (!r) return;
    const g = this.s.game;
    if (r.kind === 'build') {
      for (const type in r.btns) r.btns[type].classList.toggle('poor', g.credits < g.buildCost(type));
    } else if (r.kind === 'wreck') {
      r.btns.clear.classList.toggle('poor', g.credits < g.wreckCost(r.wreck));
    } else {
      const t = r.tower;
      for (const k of ['up', 'a', 'b']) if (r.btns[k]) r.btns[k].classList.toggle('poor', g.credits < g.upgradeCostOf(t, k === 'up' ? undefined : k));
    }
  }

  updateTargetLabel(t) {
    const b = this.radial && this.radial.btns.target;
    if (b) b.querySelector('.tl').textContent = TARGET_LABEL[t.targeting];
  }

  // ---------------------------------------------------------------- info panels
  closeInfo() { if (this.info) { this.info.remove(); this.info = null; } }

  infoPanel() {
    this.closeInfo();
    const side = this.radial && this.radial.sx > window.innerWidth / 2 ? 'left' : 'right';
    const el = h('div', { class: `info panel ${side}` });
    this.info = el;
    this.root.append(el);
    return el;
  }

  showWreckInfo(w, preview) {
    const g = this.s.game;
    const el = this.infoPanel();
    const cost = g.wreckCost(w);
    add(el, h('div', { class: 'in' }, '殘骸'), h('div', { class: 'id' }, '燒毀的機甲殘骸擋住了建造位置。付費清除後即可在此建造砲塔。'),
      g.map.isNode(w.col, w.row) ? h('div', { class: 'foot' }, h('span', { style: { color: '#ffc93d' } }, '◆ 殘骸下方偵測到能量節點！')) : null,
      h('div', { class: 'hint' }, preview ? (g.credits >= cost ? `再點一次清除（${cost}）` : `資金不足（需要 ${cost}）`) : `清除費用 ${cost}`));
  }

  // spec: {build:type, col, row} | {tower:t, preview?: 'up'|'a'|'b'|'sell'} | null (hint only)
  showInfo(spec) {
    const g = this.s.game;
    if (!spec && this.radial && this.radial.tower) return this.showInfo({ tower: this.radial.tower });
    const el = this.infoPanel();
    if (!spec) {
      const node = this.radial && g.map.isNode(this.radial.col, this.radial.row);
      add(el, h('div', { class: 'in' }, '建造砲塔'), h('div', { class: 'id' }, '點選一種砲塔預覽射程與能力，再點一次確認建造。'),
        node ? h('div', { class: 'foot' }, h('span', { style: { color: '#ffc93d' } }, `◆ 能量節點：傷害 +${pct(POWER_NODE.damage)}、射程 +${pct(POWER_NODE.range)}`)) : null);
      return;
    }
    if (spec.build) {
      const type = spec.build;
      const def = TOWERS[type];
      const probe = { type, x: 0, z: 0, rank: 0, node: g.map.isNode(spec.col, spec.row) };
      const s = g.computeStats(probe, 1, null, []).stats;
      el.append(this.infoHead(this.icons.tower[type], def.name, def.en, null, damageType(type, s), type),
        h('div', { class: 'id' }, def.desc), this.table(statRows(type, s)), this.tagRow(towerTags(type, s)),
        h('div', { class: 'hint' }, g.credits >= g.buildCost(type) ? `再點一次建造（${g.buildCost(type)}）` : `資金不足（需要 ${g.buildCost(type)}）`));
      return;
    }
    const t = spec.tower;
    const pv = spec.preview;
    let info = towerInfo(t.type, t.level, t.spec);
    let icon = this.iconFor(t.type, t.level, t.spec);
    let rows = statRows(t.type, t.stats);
    let tagStats = t.stats;
    let lvl = t.level >= 5 ? '★★ 終極型態' : t.level >= 4 ? '★ 專精' : `等級 ${t.level}`;
    let hint = null;
    let dtype = damageType(t.type, t.stats);
    if (pv === 'up' || pv === 'a' || pv === 'b') {
      const nl = t.level + 1, ns = pv === 'up' ? t.spec : pv;
      const next = this.s.previewStats(t, nl, ns);
      rows = this.diffRows(rows, statRows(t.type, next));
      tagStats = next;
      info = towerInfo(t.type, nl, ns);
      icon = this.iconFor(t.type, nl, ns);
      dtype = damageType(t.type, next);
      lvl = nl >= 5 ? '終極升級' : nl === 4 ? '專精升級' : `等級 ${t.level} → ${nl}`;
      const chk = g.canUpgrade(t, ns);
      const cost = g.upgradeCostOf(t, pv === 'up' ? undefined : pv);
      hint = chk.ok ? `再點一次升級（${cost}）` : chk.reason === '資金不足' ? `資金不足（需要 ${cost}）` : chk.reason;
    } else if (pv === 'sell') {
      hint = `再點一次出售，返還 ${g.sellValue(t)}`;
    } else if (t.level === 3) hint = '選擇一種專精方向';
    else if (t.level === 4 && !g.ultUnlocked(t.type)) hint = '在研究所研究「終極協議」後可升級為終極型態';
    el.append(this.infoHead(icon, info.name, info.en, lvl, dtype, t.type));
    // actionable hint sits right under the header so it never scrolls out of view on short screens
    if (hint) el.append(h('div', { class: 'hint top' }, hint));
    el.append(h('div', { class: 'id' }, info.desc), this.table(rows), this.tagRow(towerTags(t.type, tagStats)));
    const th = VETERANCY.thresholds;
    const lo = t.rank ? th[t.rank - 1] : 0;
    const vf = t.rank >= 3 ? 1 : (t.xp / t.invested - lo) / (th[t.rank] - lo);
    el.append(h('div', { class: 'vet' }, h('span', { class: 'vs' }, t.rank ? '★'.repeat(t.rank) : '新兵'), h('i', {}, h('b', { style: { width: `${Math.max(0, Math.min(1, vf)) * 100}%` } })), h('span', { class: 'vt' }, t.rank >= 3 ? '老兵滿級' : `晉升 ${Math.round(Math.max(0, vf) * 100)}%`)));
    el.append(h('div', { class: 'foot num' }, h('span', {}, `擊毀 ${t.kills}`), h('span', {}, `總傷害 ${fmt(t.damage)}`)));
    const notes = [];
    if (t.node) notes.push(h('span', { style: { color: '#ffc93d' } }, '◆ 能量節點'));
    if (t.buffBy) notes.push(h('span', { style: { color: '#45ffb0' } }, '◆ 信標增幅'));
    if (t.disabledT > 0) notes.push(h('span', { style: { color: '#ff8095' } }, '⚡ EMP 癱瘓中'));
    if (notes.length) el.append(h('div', { class: 'foot' }, ...notes));
  }

  iconFor(type, level, spec) {
    const I = this.icons.tower;
    if (spec && level >= 5) return I[`${type}-${spec}5`] || I[`${type}-${spec}`];
    if (spec && level >= 4) return I[`${type}-${spec}`];
    return level >= 3 ? I[`${type}-3`] : I[type];
  }

  infoHead(icon, name, en, lvl, dtype, type) {
    return h('div', { class: 'ih' }, icon ? h('img', { src: icon }) : null,
      h('div', {}, h('div', { class: 'in' }, name), h('div', { class: 'ie' }, en),
        h('div', { class: 'lvrow' }, lvl ? h('span', { class: 'lvl' }, lvl) : null, type ? roleChip(type) : null, dtype ? dmgChip(dtype) : null)));
  }

  table(rows) {
    return h('table', {}, rows.map(([k, v, cls]) => h('tr', {}, h('td', {}, k), h('td', { class: `num ${cls || ''}` }, v))));
  }

  tagRow(tags) { return h('div', { class: 'tags' }, tags.map((t) => h('span', {}, t))); }

  diffRows(cur, next) {
    const map = new Map(cur.map(([k, v]) => [k, v]));
    return next.map(([k, v]) => {
      const old = map.get(k);
      if (old === undefined) return [k, v, 'up'];
      if (old === v) return [k, v];
      return [k, `${old} → ${v}`, 'up'];
    });
  }

  dispose() { this.root.remove(); }
}
