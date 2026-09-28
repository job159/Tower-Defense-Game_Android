// Menus: title, level select, deploy (loadout + intel), codex, research lab, settings, pause, results and dialogs.
import { h, svg, add } from './dom.js';
import { LEVELS } from '../core/levels.js';
import {
  RESEARCH, RESEARCH_GROUPS, TOWERS, TOWER_ORDER, ENEMIES, ARMOR_CLASSES, DAMAGE_TYPES, DAMAGE_ORDER, UNLOCK_AT, LOADOUT_SIZE, ABILITIES, towerBaseStats,
} from '../core/config.js';
import { TILE, buildMap } from '../core/path.js';
import { DIFFICULTY, DIFFICULTY_ORDER, MUTATORS, levelMutators, levelThreats } from '../core/waves.js';
import { unlockedTowers, defaultLoadout } from '../core/sim.js';
import { setVibration } from '../audio/audio.js';
import { statRows, towerTags, dmgChip, roleChip } from './hud.js';

const stars = (n, max = 3) => h('span', { class: 'stars' }, ...Array.from({ length: max }, (_, i) => h('span', { class: `star${i < n ? ' on' : ''}` }, '★')));
const DIFF_CLASS = { normal: '', hard: 'hard', nightmare: 'nightmare' };

export class Screens {
  constructor(app) {
    this.app = app;
    this.current = null;
    this.name = null;
    this.modals = [];
    this.diff = 'normal';
  }

  get root() { return this.app.ui; }

  show(name, el) {
    if (this.current) this.current.remove();
    this.current = el;
    this.name = name;
    if (el) this.root.append(el);
  }

  clear() { this.show(null, null); }

  click() { this.app.audio.unlock(); this.app.audio.play('click'); }

  // ---------------------------------------------------------------- modal plumbing
  modal(content, { onBack, cls = '' } = {}) {
    const back = h('div', { class: 'modal-back' }, h('div', { class: `modal panel ${cls}` }, content));
    const m = { el: back, onBack: onBack || (() => this.closeModal(m)) };
    this.modals.push(m);
    this.root.append(back);
    return m;
  }

  closeModal(m) {
    const i = this.modals.indexOf(m);
    if (i >= 0) this.modals.splice(i, 1);
    m.el.remove();
  }

  closeAllModals() { while (this.modals.length) this.closeModal(this.modals[this.modals.length - 1]); }

  confirm(title, text, onYes, yesLabel = '確定') {
    const m = this.modal([
      h('h2', {}, title),
      text ? h('p', {}, text) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => { this.click(); this.closeModal(m); } }, '取消'),
        h('button', { class: 'btn magenta', onclick: () => { this.click(); this.closeModal(m); onYes(); } }, yesLabel)),
    ]);
    return m;
  }

  // Android back button. Returns true when handled.
  back() {
    if (this.modals.length) { this.modals[this.modals.length - 1].onBack(); return true; }
    const s = this.app.session;
    if (s) {
      if (s.over) return true;
      if (s.sel) { s.deselect(); return true; }
      s.openPause();
      return true;
    }
    if (this.name === 'deploy') { this.levels(); return true; }
    if (this.name === 'levels' || this.name === 'research' || this.name === 'codex') { this.title(); return true; }
    if (this.name === 'title') {
      if (window.NativeBridge) {
        this.confirm('離開遊戲？', null, () => window.NativeBridge.exitApp(), '離開');
        return true;
      }
      return false;
    }
    return false;
  }

  // ---------------------------------------------------------------- title
  title() {
    const app = this.app;
    const save = app.save;
    app.ensureMenuScene();
    const run = save.data.run;
    const runLevel = run && LEVELS.find((l) => l.id === run.levelId);
    const col = h('div', { class: 'title-col' },
      h('div', { class: 'logo' }, '霓虹防線'),
      h('div', { class: 'logo-sub' }, 'NEON BASTION'),
      run && runLevel ? h('button', { class: 'btn primary', onclick: () => { this.click(); app.resumeRun(); } }, svg('play'),
        `繼續 · ${run.endless ? '無盡' : runLevel.name} 第 ${run.wave + 1} 波`) : null,
      h('button', { class: `btn ${run ? '' : 'primary'}`, onclick: () => { this.click(); this.levels(); } }, svg('wave'), '戰役'),
      h('button', { class: 'btn', onclick: () => { this.click(); this.research(); } }, svg('research'), '研究所',
        save.freeStars() > 0 ? h('span', { class: 'chip', style: { marginLeft: 'auto', color: '#ffd23d' } }, `★ ${save.freeStars()}`) : null),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn', style: { flex: 1 }, onclick: () => { this.click(); this.codex(); } }, svg('codex'), '圖鑑'),
        h('button', { class: 'btn', style: { flex: 1 }, onclick: () => { this.click(); this.settings(); } }, svg('gear'), '設定')),
      h('div', { class: 'title-stars' }, `已獲得 ★ ${save.totalStars()} / ${save.maxStars()}`));
    const prep = h('div', { class: 'prep' });
    app.onAudioProgress = (p) => { prep.textContent = p < 1 ? `音軌合成中 ${Math.round(p * 100)}%` : ''; };
    app.onAudioProgress(app.audioProgress);
    const el = h('div', { class: 'layer title-screen fade-in' }, col,
      h('div', { class: 'title-foot' }, `v${app.version}`, h('br'), '點擊畫面以啟用音效', prep));
    el.addEventListener('pointerdown', () => app.audio.unlock(), { once: true });
    this.show('title', el);
    app.audio.setMusic('menu');
    if (save.data.news !== 2) {
      // one-time "what's new" for players coming from v1 (fresh installs just skip it)
      const returning = save.totalStars() > 0;
      save.data.news = 2;
      save.write();
      if (returning) this.whatsNew();
    }
  }

  whatsNew() {
    const items = [
      ['4 種新砲塔', '焚化者、感測陣列、無人機母艦、地雷佈設器'],
      ['第 5 級終極型態', '每個專精都有終極升級，在研究所「終極協議」解鎖'],
      ['兩種全場技能', '雷霆審判轟擊全場所有敵人，時停力場讓全場減速'],
      ['傷害剋制系統', '6 種傷害 × 5 種裝甲，點敵人即可查看弱點'],
      ['新敵人與首領', '隱形幽影、EMP 干擾者、鏡面機、蜂巢艦……終焉會二階段升天'],
      ['10 關・3 種難度', '惡夢難度與突變、每關挑戰任務，每關最多 10 顆星'],
      ['出擊編成與圖鑑', '每關挑 6 種砲塔上場，圖鑑收錄全部資料與剋制表'],
      ['全新音樂與音效', '動態配樂隨戰況推進，音效全面重製'],
    ];
    const list = h('div', { class: 'news' }, items.map(([t, d]) => h('div', { class: 'news-item' }, h('b', {}, t), h('span', {}, d))));
    const m = this.modal([
      h('h2', {}, '霓虹防線 2.0'),
      list,
      this.app.save.refunded ? h('p', { style: { color: '#ffd23d' } }, '研究所已重新設計，先前投入的星星已全數退還。') : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => { this.click(); this.closeModal(m); } }, '開始')),
    ], { cls: 'wide' });
  }

  diffSeg(level, onPick) {
    const save = this.app.save;
    const seg = h('div', { class: 'seg' });
    for (const d of DIFFICULTY_ORDER) {
      const ok = !level || save.diffUnlocked(level.id, d);
      seg.append(h('button', { class: `${this.diff === d ? 'on' : ''} ${DIFF_CLASS[d]}`, style: ok ? null : { opacity: 0.4 }, onclick: () => {
        this.click();
        if (!ok) { this.app.toast(d === 'hard' ? '先以普通難度通關此關' : '先以困難難度通關此關'); return; }
        this.diff = d;
        onPick(d);
      } }, DIFFICULTY[d].name));
    }
    return seg;
  }

  // ---------------------------------------------------------------- level select
  levels() {
    const app = this.app;
    const save = app.save;
    app.ensureMenuScene();
    const cards = h('div', { class: 'cards' });
    const segWrap = h('div');
    const render = () => {
      cards.textContent = '';
      segWrap.textContent = '';
      segWrap.append(this.diffSeg(null, render));
      for (const lv of LEVELS) {
        const unlocked = save.unlocked(lv.id);
        const diffOk = save.diffUnlocked(lv.id, this.diff);
        const locked = !unlocked || !diffOk;
        const newTowers = TOWER_ORDER.filter((t) => UNLOCK_AT[t] === lv.id);
        const cv = h('canvas', { width: 320, height: 180 });
        drawMinimap(cv, lv);
        const card = h('button', { class: `card panel${locked ? ' locked' : ''}`, onclick: () => {
          this.click();
          if (!unlocked) return app.toast('先通過上一關');
          if (!diffOk) return app.toast(this.diff === 'hard' ? '先以普通難度通關此關' : '先以困難難度通關此關');
          this.deploy(lv.id, this.diff);
        } },
        h('div', { class: 'lv' }, `關卡 ${lv.id}`),
        cv,
        h('div', {}, h('div', { class: 'nm' }, lv.name), h('div', { class: 'en' }, lv.en)),
        h('div', { class: 'meta' }, h('span', {}, `${lv.waves} 波 · ${lv.paths.length} 路`), stars(save.stars(lv.id, this.diff))),
        h('div', { class: 'dstars' }, ...DIFFICULTY_ORDER.map((d) => h('span', {}, `${DIFFICULTY[d].name} ${'★'.repeat(save.stars(lv.id, d)) || '—'}`)), h('span', { class: 'cs' }, save.challenge(lv.id) ? '◆挑戰' : '')),
        h('div', { class: 'unl' }, newTowers.length ? h('span', { style: { fontSize: '11px', color: '#8a96bd', marginRight: '4px' } }, '新砲塔') : null,
          ...newTowers.map((t) => h('img', { src: app.thumbs.tower[t], title: TOWERS[t].name }))),
        locked ? h('div', { class: 'lock' }, svg('lock')) : null);
        cards.append(card);
      }
      const eu = save.endlessUnlocked();
      cards.append(h('button', { class: `card panel endless${eu ? '' : ' locked'}`, onclick: () => { this.click(); if (!eu) return app.toast('通過關卡 3 後解鎖'); this.endlessPicker(); } },
        h('div', { class: 'lv', style: { color: '#ff2fd0' } }, '挑戰'),
        h('div', { style: { aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,47,208,.3)', background: '#0a0612' } },
          h('span', { style: { width: '64px', height: '64px', color: '#ff2fd0', filter: 'drop-shadow(0 0 8px #ff2fd0)' } }, svg('infinity'))),
        h('div', {}, h('div', { class: 'nm' }, '無盡模式'), h('div', { class: 'en' }, 'ENDLESS')),
        h('div', { class: 'meta' }, h('span', {}, '全砲塔開放'), h('span', { class: 'num', style: { color: '#ffd23d' } }, `最佳 ${save.bestEndless()}`)),
        h('div', { class: 'unl' }),
        eu ? null : h('div', { class: 'lock' }, svg('lock'))));
    };
    render();
    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); this.title(); } }, svg('back')),
        h('h1', {}, '戰役'), segWrap,
        h('span', { class: 'chip num', style: { color: '#ffd23d' } }, `★ ${save.totalStars()}`)),
      cards);
    this.show('levels', el);
    const idx = LEVELS.filter((l) => save.unlocked(l.id)).length - 1;
    requestAnimationFrame(() => { const c = cards.children[idx]; if (c) cards.scrollLeft = c.offsetLeft - cards.clientWidth / 2 + c.clientWidth / 2; });
  }

  endlessPicker() {
    const save = this.app.save;
    const m = this.modal([
      h('h2', {}, '無盡模式'),
      h('p', {}, '選擇戰場。所有砲塔與技能開放，每 10 波出現首領，敵軍無限增強。'),
      h('div', { class: 'row' }, ...LEVELS.filter((l) => save.unlocked(l.id)).map((l) => h('button', { class: 'btn small', onclick: () => { this.click(); this.closeModal(m); this.deploy(l.id, 'normal', true); } },
        `${l.name}${save.data.endless[l.id] ? ` · ${save.data.endless[l.id]}` : ''}`))),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost small', onclick: () => { this.click(); this.closeModal(m); } }, '取消')),
    ]);
  }

  // ---------------------------------------------------------------- deploy: intel + loadout
  deploy(levelId, difficulty = 'normal', endless = false) {
    const app = this.app;
    const save = app.save;
    // reached from the results screen too: make sure the menu backdrop + menu music are back
    if (!app.session) { app.ensureMenuScene(); app.audio.setMusic('menu'); }
    const lv = LEVELS.find((l) => l.id === levelId);
    this.diff = difficulty;
    const pool = unlockedTowers(levelId, endless);
    let loadout = (save.loadout(endless ? `e${levelId}` : levelId) || defaultLoadout(levelId, endless)).filter((t) => pool.includes(t));
    if (!loadout.length) loadout = defaultLoadout(levelId, endless);
    const left = h('div', { class: 'col' });
    const right = h('div', { class: 'col' });
    const countEl = h('span', { class: 'chip num' });
    const segWrap = h('div');
    const go = h('button', { class: 'btn primary go', onclick: () => {
      this.click();
      if (!loadout.length) return app.toast('至少編入 1 種砲塔');
      save.setLoadout(endless ? `e${levelId}` : levelId, loadout);
      app.startLevel(levelId, endless ? 'normal' : this.diff, endless, null, loadout);
    } }, svg('deploy'), '出擊');
    const renderLeft = () => {
      left.textContent = '';
      const cv = h('canvas', { width: 480, height: 270, class: 'mini' });
      drawMinimap(cv, lv);
      const threats = levelThreats(lv, endless);
      const seen = save.data.seenEnemies;
      const intel = h('div', { class: 'intel' });
      for (const t of [...threats.types, ...threats.bosses]) {
        const d = ENEMIES[t];
        const known = seen.includes(t);
        intel.append(h('button', { class: `${d.boss ? 'boss' : ''}${known ? '' : ' unseen'}`, onclick: () => { this.click(); this.enemyDetail(t, known); } }, h('img', { src: app.thumbs.enemy[t] })));
      }
      segWrap.textContent = '';
      if (!endless) segWrap.append(this.diffSeg(lv, () => { renderLeft(); }));
      add(left, cv,
        h('div', { class: 'sect' }, '敵情情報（點擊查看）'), intel,
        !endless && lv.challenge ? h('div', { class: 'chall' }, `◆ 挑戰：${lv.challenge.text}${save.challenge(lv.id) ? '（已完成）' : ''}`) : null,
        ...levelMutators(lv, this.diff).map((m) => h('div', { class: 'mut' }, `☢ 惡夢突變「${MUTATORS[m].name}」：${MUTATORS[m].desc}`)),
        h('div', { class: 'sect' }, '地圖特性'),
        h('div', { style: { fontSize: '12px', color: '#b9c6ea', lineHeight: 1.5 } },
          [lv.nodes && lv.nodes.length ? `◆ 能量節點 ×${lv.nodes.length}` : null, lv.wrecks && lv.wrecks.length ? `▲ 可清除殘骸 ×${lv.wrecks.length}` : null,
            lv.paths.some((p) => p.some((w) => w[2] === 'w')) ? '◎ 量子傳送門' : null, lv.airWaves ? '✈ 大量空襲' : null].filter(Boolean).join('　') || '標準戰場'));
    };
    const renderRight = () => {
      right.textContent = '';
      countEl.textContent = `編成 ${loadout.length}/${LOADOUT_SIZE}`;
      const grid = h('div', { class: 'loadout' });
      for (const t of TOWER_ORDER) {
        const unl = pool.includes(t);
        const on = loadout.includes(t);
        const def = TOWERS[t];
        grid.append(h('button', { class: `lcard${on ? ' on' : ''}${unl ? '' : ' locked'}`, onclick: () => {
          this.click();
          if (!unl) return app.toast(`關卡 ${UNLOCK_AT[t]} 解鎖`);
          if (on) loadout = loadout.filter((x) => x !== t);
          else if (loadout.length >= LOADOUT_SIZE) return app.toast(`最多編入 ${LOADOUT_SIZE} 種砲塔`);
          else loadout = TOWER_ORDER.filter((x) => x === t || loadout.includes(x));
          renderRight();
        }, oncontextmenu: (ev) => { ev.preventDefault(); this.towerDetail(t); } },
        h('img', { src: app.thumbs.tower[t] }), h('span', { class: 'ln' }, def.name), roleChip(t), h('span', { class: 'lrow' }, h('span', { class: 'lc num' }, `${def.cost}`), dmgChip(def.type)),
        unl ? null : h('span', { class: 'lk' }, `關卡 ${UNLOCK_AT[t]}`)));
      }
      go.disabled = loadout.length === 0;
      right.append(h('div', { class: 'sect' }, '砲塔編成（每關最多 6 種）'), grid,
        h('div', { class: 'tipline' }, '隱形敵人需要感測陣列偵測；飛行敵人只有對空砲塔能攻擊。長按砲塔可查看圖鑑。'));
    };
    renderLeft();
    renderRight();
    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); this.levels(); } }, svg('back')),
        h('h1', {}, endless ? `無盡 · ${lv.name}` : `${lv.id}. ${lv.name}`), segWrap, countEl,
        h('span', { class: 'chip' }, endless ? '∞ 波' : `${lv.waves} 波`), go),
      h('div', { class: 'deploy' }, left, right));
    this.show('deploy', el);
  }

  // ---------------------------------------------------------------- codex
  codex(tab = 'tower') {
    const app = this.app;
    const save = app.save;
    const list = h('div', { class: 'list' });
    const detail = h('div', { class: 'detail panel' });
    const tabs = h('div', { class: 'tabs' });
    let sel = null;
    const showTower = (t) => {
      const def = TOWERS[t];
      const s = towerBaseStats(t, 1, null);
      detail.textContent = '';
      detail.append(h('div', { class: 'dh' }, h('img', { src: app.thumbs.tower[t] }), h('div', {}, h('h3', {}, def.name), h('div', { class: 'en' }, def.en), h('div', { style: { display: 'flex', gap: '4px' } }, roleChip(t), dmgChip(def.type)))),
        h('p', { style: { color: `#${def.color.toString(16).padStart(6, '0')}` } }, `定位：${def.roleDesc}`), h('p', {}, def.desc), h('table', {}, statRows(t, s).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v)))),
        h('div', { class: 'tags', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' } }, towerTags(t, s).map((x) => h('span', { class: 'chip' }, x))));
      for (const k of ['a', 'b']) {
        const sp = def.specs[k];
        detail.append(h('div', { class: 'spec' },
          h('div', {}, h('b', {}, `專精 ${k.toUpperCase()}：${sp.name}`), ` ${sp.en}`), h('div', {}, sp.desc),
          h('div', {}, h('span', { class: 'u' }, `終極：${sp.ult.name}`), ` — ${sp.ult.desc}`)));
      }
      detail.append(h('p', { style: { fontSize: '11px' } }, `關卡 ${UNLOCK_AT[t]} 解鎖 · 終極型態需研究「終極協議」`));
    };
    const showEnemy = (t, known) => {
      detail.textContent = '';
      if (!known) { detail.append(h('h3', {}, '？？？'), h('p', {}, '尚未遭遇的敵人。')); return; }
      this.fillEnemy(detail, t);
    };
    const showChart = () => {
      detail.textContent = '';
      const head = h('tr', {}, h('th', {}, '裝甲＼傷害'), ...DAMAGE_ORDER.map((d) => h('th', { style: { color: DAMAGE_TYPES[d].color } }, DAMAGE_TYPES[d].name)));
      const rows = Object.entries(ARMOR_CLASSES).map(([k, c]) => h('tr', {}, h('td', {}, c.name), ...DAMAGE_ORDER.map((d) => h('td', { class: c.mul[d] >= 1.15 ? 'w' : c.mul[d] <= 0.85 ? 's' : '' }, `×${c.mul[d]}`))));
      detail.append(h('h3', {}, '傷害剋制表'), h('p', {}, '綠色＝弱點（受到更多傷害），紅色＝抗性。重裝單位另有「護甲值」，會從每一發命中扣除（持續傷害與無視裝甲攻擊不受影響）。'),
        h('table', { class: 'chart' }, head, ...rows),
        h('p', {}, '護盾：電磁 ×2、能量 ×0.7、冷凍與熱能 ×0.5。'),
        h('h3', { style: { marginTop: '10px' } }, '狀態連鎖'),
        h('p', {}, '熱衝擊：燃燒中的敵人被冰凍（或被冰凍的敵人被點燃）會立即受到最大生命 8% 的爆發傷害。'),
        h('p', {}, '凍結：受到所有傷害 +40%。標記：受到傷害增加。燃燒：阻止再生。範圍攻擊會暴露隱形單位。'),
        h('h3', { style: { marginTop: '10px' } }, '指揮官技能'),
        h('p', {}, `${ABILITIES.thunder.name}：${ABILITIES.thunder.desc}`),
        h('p', {}, `${ABILITIES.stasis.name}：${ABILITIES.stasis.desc}`));
    };
    const render = () => {
      list.textContent = '';
      tabs.textContent = '';
      for (const [k, label] of [['tower', '砲塔'], ['enemy', '敵人'], ['chart', '剋制表']]) tabs.append(h('button', { class: tab === k ? 'on' : '', onclick: () => { this.click(); tab = k; render(); } }, label));
      if (tab === 'tower') {
        for (const t of TOWER_ORDER) list.append(h('button', { class: sel === t ? 'on' : '', onclick: () => { this.click(); sel = t; render(); } }, h('img', { src: app.thumbs.tower[t] })));
        showTower(sel && TOWERS[sel] ? sel : (sel = TOWER_ORDER[0]));
        for (const b of list.children) b.classList.toggle('on', b === list.children[TOWER_ORDER.indexOf(sel)]);
      } else if (tab === 'enemy') {
        const types = Object.keys(ENEMIES).filter((t) => !ENEMIES[t].hidden || t === 'omega2');
        if (!ENEMIES[sel]) sel = types[0];
        for (const t of types) {
          const known = save.data.seenEnemies.includes(t);
          list.append(h('button', { class: `${sel === t ? 'on' : ''}${known ? '' : ' unknown'}`, onclick: () => { this.click(); sel = t; render(); } }, h('img', { src: app.thumbs.enemy[t] })));
        }
        showEnemy(sel, save.data.seenEnemies.includes(sel));
      } else {
        showChart();
      }
    };
    render();
    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); if (this.app.session) this.show(null, null); else this.title(); } }, svg('back')),
        h('h1', {}, '圖鑑'), tabs),
      h('div', { class: 'codex' }, list, detail));
    this.show('codex', el);
  }

  fillEnemy(el, t) {
    const d = ENEMIES[t];
    const cls = ARMOR_CLASSES[d.cls];
    el.append(h('div', { class: 'dh' }, h('img', { src: this.app.thumbs.enemy[t] }), h('div', {}, h('h3', {}, d.name), h('div', { class: 'en' }, `${cls.name}裝甲 · ${cls.desc}`))),
      h('p', {}, d.desc),
      h('table', {}, h('tr', {}, h('td', {}, '基礎生命'), h('td', { class: 'num' }, `${d.hp}${d.shield ? ` + 護盾 ${d.shield}` : ''}`)),
        h('tr', {}, h('td', {}, '護甲'), h('td', { class: 'num' }, `${d.armor}`)), h('tr', {}, h('td', {}, '速度'), h('td', { class: 'num' }, `${d.speed}`)),
        h('tr', {}, h('td', {}, '核心傷害'), h('td', { class: 'num' }, `${d.dmg}`)), h('tr', {}, h('td', {}, '賞金'), h('td', { class: 'num' }, `${d.reward}`))),
      h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' } }, ...DAMAGE_ORDER.map((k) => {
        const m = cls.mul[k];
        return h('span', { class: `dchip${m <= 0.85 ? ' dim' : ''}`, style: { color: DAMAGE_TYPES[k].color, borderColor: DAMAGE_TYPES[k].color } }, `${DAMAGE_TYPES[k].name} ×${m}`);
      })));
  }

  enemyDetail(t, known) {
    const box = h('div', { class: 'codex', style: { display: 'block' } });
    const detail = h('div', { class: 'detail', style: { padding: 0 } });
    if (known) this.fillEnemy(detail, t); else detail.append(h('h3', {}, '？？？'), h('p', {}, `尚未遭遇的敵人（${ARMOR_CLASSES[ENEMIES[t].cls].name}裝甲）。`));
    box.append(detail);
    const m = this.modal([box, h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => { this.click(); this.closeModal(m); } }, '了解'))]);
  }

  towerDetail(t) {
    this.codex('tower');
  }

  // ---------------------------------------------------------------- research
  research() {
    const app = this.app;
    const save = app.save;
    app.ensureMenuScene();
    const grid = h('div', { class: 'research-grid' });
    const free = h('span', { class: 'chip num', style: { color: '#ffd23d' } });
    const render = () => {
      free.textContent = `可用 ★ ${save.freeStars()}`;
      grid.textContent = '';
      for (const g of Object.keys(RESEARCH_GROUPS)) {
        grid.append(h('div', { class: 'rgroup' }, RESEARCH_GROUPS[g]));
        for (const r of RESEARCH.filter((x) => x.group === g)) {
          const lv = save.data.research[r.id] || 0;
          const maxed = lv >= r.costs.length;
          const cost = maxed ? 0 : r.costs[lv];
          const can = !maxed && save.freeStars() >= cost;
          const btn = h('button', { class: `btn small ${can ? 'gold' : ''}`, disabled: !can, onclick: () => { if (save.buyResearch(r.id)) { app.audio.play('upgrade'); render(); } } }, maxed ? '已完成' : `研究 ★${cost}`);
          if (g === 'ult') {
            grid.append(h('div', { class: 'rnode panel ultn' }, h('img', { src: app.thumbs.tower[`${r.tower}-a5`] || app.thumbs.tower[r.tower] }),
              h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' } }, h('div', { class: 'rn' }, TOWERS[r.tower].name), h('div', { class: 'rd' }, `${TOWERS[r.tower].specs.a.ult.name} / ${TOWERS[r.tower].specs.b.ult.name}`), btn)));
          } else {
            grid.append(h('div', { class: 'rnode panel' },
              h('div', { class: 'rn' }, r.name),
              h('div', { class: 'pips' }, ...r.costs.map((_, i) => h('i', { class: i < lv ? 'on' : '' }))),
              h('div', { class: 'rd' }, r.desc), btn));
          }
        }
      }
    };
    render();
    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); this.title(); } }, svg('back')),
        h('h1', {}, '研究所'), free,
        h('button', { class: 'btn small ghost', onclick: () => { this.click(); this.confirm('重置研究？', '退還所有已花費的星星，可以重新分配。', () => { save.resetResearch(); render(); }, '重置'); } }, svg('restart'), '重置')),
      h('div', { style: { fontSize: '12px', color: '#8a96bd', margin: '2px 0 4px' } }, '每關可獲得：普通 3★、困難 3★、惡夢 3★ 與挑戰 1★。星星用於永久強化與解鎖砲塔的第 5 級終極型態。'),
      grid);
    this.show('research', el);
  }

  // ---------------------------------------------------------------- settings
  settings(onClose) {
    const app = this.app;
    const st = app.save.settings;
    const seg = (options, value, onPick) => {
      const el = h('div', { class: 'seg' });
      const draw = (v) => {
        el.textContent = '';
        for (const [k, label] of options) el.append(h('button', { class: v === k ? 'on' : '', onclick: () => { this.click(); onPick(k); draw(k); } }, label));
      };
      draw(value);
      return el;
    };
    const slider = (value, onInput) => {
      const s = h('input', { type: 'range', min: 0, max: 100, value: Math.round(value * 100) });
      s.addEventListener('input', () => onInput(s.value / 100));
      s.addEventListener('change', () => app.save.write());
      return s;
    };
    const m = this.modal([
      h('h2', {}, '設定'),
      h('div', { class: 'set-row' }, h('label', {}, '畫質'), seg([['auto', '自動'], ['low', '低'], ['medium', '中'], ['high', '高']], st.quality, (k) => { st.quality = k; app.save.write(); app.applyQuality(); })),
      h('div', { class: 'set-row' }, h('label', {}, '音效'), slider(st.sfx, (v) => { st.sfx = v; app.audio.setVolumes(st.sfx, st.music); })),
      h('div', { class: 'set-row' }, h('label', {}, '音樂'), slider(st.music, (v) => { st.music = v; app.audio.setVolumes(st.sfx, st.music); })),
      h('div', { class: 'set-row' }, h('label', {}, '震動'), seg([[true, '開'], [false, '關']], st.vibrate, (k) => { st.vibrate = k; setVibration(k); app.save.write(); })),
      h('div', { class: 'set-row' }, h('label', {}, '遊戲進度'), h('button', { class: 'btn small magenta', onclick: () => {
        this.click();
        this.confirm('重設所有進度？', '星星、關卡、研究都會清除，無法復原。', () => { app.save.resetAll(); app.toast('進度已重設'); if (!app.session) this.title(); }, '重設');
      } }, '重設')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { this.click(); this.closeModal(m); if (onClose) onClose(); } }, '完成')),
      h('p', { style: { fontSize: '11px', color: '#6b7699', marginTop: '10px' } }, `霓虹防線 NEON BASTION v${app.version}`),
    ], { onBack: () => { this.closeModal(m); if (onClose) onClose(); } });
  }

  // ---------------------------------------------------------------- pause
  pause(session) {
    const app = this.app;
    const resume = () => { this.closeModal(m); session.resume(); };
    const g = session.game;
    const m = this.modal([
      h('h2', {}, '暫停'),
      h('p', {}, `${g.endless ? '無盡模式' : session.level.name} · 第 ${g.wave} 波 · ${DIFFICULTY[g.difficulty].name}`),
      !g.endless && session.level.challenge ? h('p', { style: { fontSize: '12px', color: '#ffe9a0' } }, `◆ 挑戰：${session.level.challenge.text}`) : null,
      h('div', { class: 'row', style: { flexDirection: 'column', alignItems: 'stretch' } },
        h('button', { class: 'btn primary', onclick: () => { this.click(); resume(); } }, svg('play'), '繼續'),
        h('button', { class: 'btn', onclick: () => { this.click(); this.settings(); } }, svg('gear'), '設定'),
        h('button', { class: 'btn', onclick: () => { this.click(); this.confirm('重新開始？', '目前的進度會遺失。', () => { this.closeModal(m); app.restart(); }, '重新開始'); } }, svg('restart'), '重新開始'),
        h('button', { class: 'btn magenta', onclick: () => { this.click(); this.closeModal(m); app.quitToMenu(); } }, svg('home'), '儲存並離開')),
    ], { onBack: resume });
  }

  // ---------------------------------------------------------------- results
  result(session, res) {
    const app = this.app;
    const g = session.game;
    let mvp = null;
    for (const t of g.towers) if (!mvp || t.damage > mvp.damage) mvp = t;
    const statsGrid = h('div', { class: 'stats num' },
      h('div', {}, h('span', {}, '擊毀'), h('span', {}, g.stats.kills)),
      h('div', {}, h('span', {}, '漏網'), h('span', {}, g.stats.leaked)),
      h('div', {}, h('span', {}, '核心耐久'), h('span', {}, `${Math.max(0, Math.ceil(g.lives))}/${g.maxLives}`)),
      h('div', {}, h('span', {}, '獲得資金'), h('span', {}, Math.round(g.stats.earned))),
      h('div', {}, h('span', {}, '利息收入'), h('span', {}, Math.round(g.stats.interest))),
      h('div', {}, h('span', {}, '技能使用'), h('span', {}, g.stats.abilityUses)));
    const mvpIcon = mvp ? (mvp.spec ? app.thumbs.tower[`${mvp.type}-${mvp.spec}${mvp.level >= 5 ? '5' : ''}`] || app.thumbs.tower[`${mvp.type}-${mvp.spec}`] : app.thumbs.tower[mvp.level >= 3 ? `${mvp.type}-3` : mvp.type]) : null;
    const mvpName = mvp ? (mvp.spec ? (mvp.level >= 5 ? mvp.def.specs[mvp.spec].ult.name : mvp.def.specs[mvp.spec].name) : mvp.def.name) : '';
    const mvpEl = mvp && mvp.damage > 0 ? h('div', { class: 'mvp' }, h('img', { src: mvpIcon }),
      h('span', {}, `MVP · ${mvpName}${mvp.rank ? ' ' + '★'.repeat(mvp.rank) : ''} — ${Math.round(mvp.damage).toLocaleString()} 傷害 / ${mvp.kills} 擊毀`)) : null;
    const next = LEVELS.find((l) => l.id === session.level.id + 1);
    const menu = () => { this.closeModal(m); app.quitToMenu(true); };
    let m;
    if (res.win) {
      const starEls = [0, 1, 2].map((i) => h('span', { class: `star${i < res.stars ? ' on' : ''}`, style: { animationDelay: `${0.3 + i * 0.25}s` } }, '★'));
      const chall = session.level.challenge && !g.endless
        ? h('p', { style: { color: res.challenge ? '#ffe9a0' : '#8a96bd' } }, `◆ 挑戰「${session.level.challenge.text}」${res.challenge ? (res.firstChallenge ? '達成！+1★' : '達成') : '未達成'}`) : null;
      m = this.modal([
        h('h2', {}, '防線守住了！'),
        h('div', { class: 'bigstars' }, ...starEls),
        h('p', {}, `${session.level.name} · ${DIFFICULTY[g.difficulty].name}${res.stars < 3 ? ' — 核心損失越少，星星越多' : ''}`),
        chall, statsGrid, mvpEl,
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => { this.click(); menu(); } }, svg('home'), '選單'),
          h('button', { class: 'btn', onclick: () => { this.click(); this.closeModal(m); app.restart(); } }, svg('restart'), '重玩'),
          next && !g.endless ? h('button', { class: 'btn primary', onclick: () => { this.click(); this.closeModal(m); app.endSession(); this.deploy(next.id, 'normal'); } }, svg('play'), '下一關') : null),
      ], { cls: 'result', onBack: menu });
    } else {
      const snap = g.lastSnapshot;
      m = this.modal([
        h('h2', {}, g.endless ? '防線終究淪陷' : '核心淪陷'),
        h('p', {}, g.endless ? `撐到第 ${res.wave} 波（最佳紀錄 ${app.save.data.endless[session.level.id] || res.wave}）` : `在第 ${res.wave} 波失守。調整編成、利用剋制關係再試一次！`),
        statsGrid, mvpEl,
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => { this.click(); menu(); } }, svg('home'), '選單'),
          h('button', { class: 'btn', onclick: () => { this.click(); this.closeModal(m); app.endSession(); this.deploy(session.level.id, g.difficulty, g.endless); } }, svg('restart'), '重新編成'),
          snap && !g.endless ? h('button', { class: 'btn primary', onclick: () => { this.click(); this.closeModal(m); app.startLevel(session.level.id, g.difficulty, false, snap, snap.loadout); } }, svg('play'), `從第 ${snap.wave + 1} 波重來`) : null),
      ], { cls: 'result lose', onBack: menu });
    }
  }
}

// Stylized level preview drawn from map data.
export function drawMinimap(cv, lv) {
  const map = buildMap(lv);
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.fillStyle = '#070913';
  g.fillRect(0, 0, W, H);
  const s = Math.min((W - 16) / lv.cols, (H - 16) / lv.rows);
  const ox = (W - s * lv.cols) / 2, oy = (H - s * lv.rows) / 2;
  for (let r = 0; r < lv.rows; r++) for (let c = 0; c < lv.cols; c++) {
    const t = map.at(c, r);
    if (t === TILE.VOID) continue;
    const x = ox + c * s, y = oy + r * s;
    g.fillStyle = t === TILE.BUILD ? '#1b2236' : t === TILE.DECOR ? '#0d1019' : t === TILE.WRECK ? '#3a2a1c' : '#0a1a24';
    g.fillRect(x + 0.5, y + 0.5, s - 1, s - 1);
    if (map.isNode(c, r)) {
      g.strokeStyle = '#ffc93d';
      g.lineWidth = Math.max(1, s * 0.08);
      g.strokeRect(x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6);
    }
  }
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [i, path] of map.paths.entries()) {
    g.strokeStyle = 'rgba(34,230,255,0.9)';
    g.shadowColor = '#22e6ff';
    g.shadowBlur = 8;
    g.lineWidth = s * 0.28;
    g.beginPath();
    const P = { x: 0, z: 0 };
    let pen = false;
    for (let d = 0; d <= path.length; d += 0.2) {
      if (path.inWarp(d)) { pen = false; continue; }
      path.sample(d, P);
      const x = ox + (P.x + (lv.cols - 1) / 2 + 0.5) * s, y = oy + (P.z + (lv.rows - 1) / 2 + 0.5) * s;
      if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
    }
    g.stroke();
    const sp = map.spawns[i];
    g.fillStyle = '#ff2fd0';
    g.shadowColor = '#ff2fd0';
    g.beginPath();
    g.arc(ox + (sp.col + 0.5) * s, oy + (sp.row + 0.5) * s, s * 0.32, 0, Math.PI * 2);
    g.fill();
  }
  for (const gt of map.gates) {
    g.strokeStyle = '#b08aff';
    g.shadowColor = '#8a5cff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(ox + (gt.col + 0.5) * s, oy + (gt.row + 0.5) * s, s * 0.35, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#bff8ff';
  g.shadowColor = '#22e6ff';
  g.shadowBlur = 14;
  g.beginPath();
  g.arc(ox + (map.core.col + 0.5) * s, oy + (map.core.row + 0.5) * s, s * 0.4, 0, Math.PI * 2);
  g.fill();
  g.shadowBlur = 0;
}
