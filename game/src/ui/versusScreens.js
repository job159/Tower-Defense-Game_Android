// Versus menus: mode select, practice (vs AI) setup, loadout picker, in-match menu and results.
// Mixed into Screens (see screens.js), so `this` is the Screens instance.
import { h, svg } from './dom.js';
import { TOWERS, TOWER_ORDER, LOADOUT_SIZE } from '../core/config.js';
import { VS_RULES, PACKS, DEFAULT_VS_LOADOUT } from '../core/versus.js';
import { roleChip, dmgChip } from './hud.js';
import { RemoteSide } from '../net/remoteSide.js';

const AI_LEVELS = [['easy', '簡單'], ['normal', '普通'], ['hard', '困難']];
const AI_NAMES = { easy: '電腦（簡單）', normal: '電腦（普通）', hard: '電腦（困難）' };
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export const versusScreens = {
  // ---------------------------------------------------------------- mode select
  versusMenu() {
    const app = this.app;
    app.ensureMenuScene();
    app.audio.setMusic('menu');
    const rules = h('div', { class: 'vs-rules panel' },
      h('h3', {}, '對戰規則'),
      h('ul', {},
        h('li', {}, '雙方守護同一張地圖的左右兩半，只能在', h('b', {}, '自己的半場'), '建造砲塔。'),
        h('li', {}, `每 ${VS_RULES.waveEvery} 秒雙方同時迎來一模一樣的系統波次。`),
        h('li', {}, '用下方的', h('b', {}, '派兵列'), '把怪物送進對手的路線：花錢派兵，同時', h('b', {}, '永久提高收入'), `（每 ${VS_RULES.incomeEvery} 秒入帳）。`),
        h('li', {}, '便宜兵種收入回報最好；空軍、護盾、隱形專打對手的弱點；重裝與首領壓力最大。'),
        h('li', {}, `核心耐久 ${VS_RULES.lives}，先歸零的一方落敗。第 ${VS_RULES.suddenDeathWave} 波後進入驟死期，系統波次急速增強。`)));
    const card = (cls, icon, title, sub, onClick, extra) => h('button', { class: `vs-card panel ${cls}`, onclick: () => { this.click(); onClick(); } },
      h('span', { class: 'ic' }, svg(icon)), h('span', { class: 't' }, title), h('span', { class: 's' }, sub), extra || null);
    const el = h('div', { class: 'layer screen vs-menu fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); this.title(); } }, svg('back')),
        h('h1', {}, '雙人對戰')),
      h('div', { class: 'vs-body' },
        h('div', { class: 'vs-cards' },
          card('online', 'wave', '線上對戰', '輸入相同的房間號碼，和朋友即時對戰（任何網路皆可）', () => this.versusOnline()),
          card('ai', 'target', '練習對戰', '和電腦對戰，熟悉派兵與收入的節奏', () => this.versusPractice())),
        rules));
    this.show('versus', el);
  },

  // ---------------------------------------------------------------- loadout picker (all towers, pick 6)
  loadoutPicker(initial, onChange) {
    let loadout = initial.slice();
    const grid = h('div', { class: 'loadout vs-loadout' });
    const count = h('span', { class: 'chip num' });
    const render = () => {
      grid.textContent = '';
      count.textContent = `編成 ${loadout.length}/${LOADOUT_SIZE}`;
      for (const t of TOWER_ORDER) {
        const on = loadout.includes(t);
        const def = TOWERS[t];
        grid.append(h('button', { class: `lcard${on ? ' on' : ''}`, onclick: () => {
          this.click();
          if (on) loadout = loadout.filter((x) => x !== t);
          else if (loadout.length >= LOADOUT_SIZE) { this.app.toast(`最多編入 ${LOADOUT_SIZE} 種砲塔`); return; }
          else loadout = TOWER_ORDER.filter((x) => x === t || loadout.includes(x));
          render();
          onChange(loadout);
        } },
        h('img', { src: this.app.thumbs.tower[t] }), h('span', { class: 'ln' }, def.name), roleChip(t),
        h('span', { class: 'lrow' }, h('span', { class: 'lc num' }, `${def.cost}`), dmgChip(def.type))));
      }
    };
    render();
    return { el: grid, count, get: () => loadout };
  },

  savedVersusLoadout() {
    const l = this.app.save.data.vsLoadout;
    return Array.isArray(l) && l.length ? l.filter((t) => TOWER_ORDER.includes(t)).slice(0, LOADOUT_SIZE) : DEFAULT_VS_LOADOUT.slice();
  },

  rememberVersusLoadout(l) {
    this.app.save.data.vsLoadout = l.slice();
    this.app.save.write();
  },

  // ---------------------------------------------------------------- practice vs AI
  versusPractice() {
    const app = this.app;
    app.ensureMenuScene();
    let level = app.save.data.vsAiLevel || 'normal';
    const seg = h('div', { class: 'seg' });
    const renderSeg = () => {
      seg.textContent = '';
      for (const [id, name] of AI_LEVELS) seg.append(h('button', { class: level === id ? 'on' : '', onclick: () => { this.click(); level = id; renderSeg(); } }, name));
    };
    renderSeg();
    const go = h('button', { class: 'btn primary go' }, svg('deploy'), '開戰');
    const picker = this.loadoutPicker(this.savedVersusLoadout(), (l) => { go.disabled = l.length === 0; });
    go.onclick = () => {
      this.click();
      const loadout = picker.get();
      if (!loadout.length) return;
      this.rememberVersusLoadout(loadout);
      app.save.data.vsAiLevel = level;
      app.save.write();
      app.startVersus({ mode: 'ai', loadout, oppName: AI_NAMES[level], ai: { level, style: 'balanced' } });
    };
    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); this.versusMenu(); } }, svg('back')),
        h('h1', {}, '練習對戰'), seg, picker.count, go),
      h('div', { class: 'vs-setup' },
        h('div', { class: 'sect' }, '砲塔編成（選 6 種帶上場；對手看得到你的編成）'),
        picker.el,
        h('div', { class: 'tipline' }, '提示：至少帶一種對空砲塔與感測陣列，對手的空軍與隱形兵種才擋得住。')));
    this.show('versusPractice', el);
  },

  // ---------------------------------------------------------------- in-match menu
  versusPause(session) {
    const app = this.app;
    const online = session.mode === 'online';
    const resume = () => { this.closeModal(m); session.resume(); };
    const m = this.modal([
      h('h2', {}, online ? '選單' : '暫停'),
      h('p', {}, online ? '線上對戰不會暫停，對手仍在進行中。' : `練習對戰 · ${session.opts.oppName}`),
      h('div', { class: 'row', style: { flexDirection: 'column', alignItems: 'stretch' } },
        h('button', { class: 'btn primary', onclick: () => { this.click(); resume(); } }, svg('play'), '繼續'),
        h('button', { class: 'btn', onclick: () => { this.click(); this.settings(); } }, svg('gear'), '設定'),
        h('button', { class: 'btn magenta', onclick: () => { this.click(); this.confirm('投降？', '這場對戰會判定為落敗。', () => { this.closeModal(m); session.surrender(); }, '投降'); } }, svg('home'), '投降')),
    ], { onBack: resume });
  },

  // ---------------------------------------------------------------- online rematch: both press, host restarts
  versusRematch(session, btn, note, closeModal) {
    const app = this.app, room = session.room;
    let mine = false, theirs = false, done = false;
    const offs = [];
    const on = (ev, fn) => { room.on(ev, fn); offs.push([ev, fn]); };
    const cleanup = () => { for (const [ev, fn] of offs) room.off(ev, fn); offs.length = 0; };
    const start = (seed, delay) => {
      if (done) return;
      done = true;
      cleanup();
      note.textContent = '即將開始…';
      setTimeout(() => {
        if (app.session !== session) return;
        session.keepRoom = true;
        closeModal();
        const o = session.opts;
        app.startVersus({ mode: 'online', seed, loadout: o.loadout, oppName: o.oppName,
          online: { room, remote: new RemoteSide(room, { name: o.oppName }) } });
      }, delay);
    };
    const maybeStart = () => {
      if (!mine || !theirs || !room.isHost) return;
      const seed = Math.floor(Math.random() * 1e9);
      room.send('start', { seed, delay: 1500, rematch: true });
      start(seed, 1500);
    };
    on('message', ({ type, data }) => {
      if (type === 'rematch') { theirs = true; note.textContent = mine ? '雙方都同意，準備開始…' : '對手想再來一場！'; maybeStart(); }
      if (type === 'start' && data.rematch && !room.isHost) start(data.seed, Math.max(300, (data.delay || 1500) - (room.rtt || 0) / 2));
    });
    on('closed', () => { cleanup(); btn.disabled = true; note.textContent = '對手已離開房間'; });
    if (room.status === 'closed' || session.opp.forfeit) { cleanup(); btn.disabled = true; note.textContent = '對手已離開房間'; return; }
    btn.onclick = () => {
      this.click();
      if (mine) return;
      mine = true;
      btn.disabled = true;
      room.send('rematch', {});
      note.textContent = theirs ? '雙方都同意，準備開始…' : '已送出邀請，等待對手…';
      maybeStart();
    };
    session.onLeaveResult = cleanup;
  },

  // ---------------------------------------------------------------- result
  versusResult(session, res) {
    const app = this.app;
    const toMenu = () => { this.closeModal(m); app.endSession(); this.versusMenu(); };
    const statsGrid = h('div', { class: 'stats num' },
      h('div', {}, h('span', {}, '對戰時間'), h('span', {}, mmss(res.time))),
      h('div', {}, h('span', {}, '撐到'), h('span', {}, `第 ${res.wave} 波`)),
      h('div', {}, h('span', {}, '核心耐久'), h('span', {}, `${res.lives} : ${res.oppLives}`)),
      h('div', {}, h('span', {}, '擊毀'), h('span', {}, res.kills)),
      h('div', {}, h('span', {}, '派兵'), h('span', {}, `${res.sent} 次 · ${res.sentValue}`)),
      h('div', {}, h('span', {}, '最高收入'), h('span', {}, `+${res.ecoMax}/${VS_RULES.incomeEvery}s`)));
    const note = h('p', { class: 'vs-status wait', style: { textAlign: 'center' } });
    const again = res.mode === 'ai'
      ? h('button', { class: 'btn primary', onclick: () => { this.click(); this.closeModal(m); app.startVersus({ ...app.lastVersus, seed: undefined }); } }, svg('restart'), '再來一場')
      : h('button', { class: 'btn primary' }, svg('restart'), '再來一場');
    if (res.mode === 'online') this.versusRematch(session, again, note, () => this.closeModal(m));
    const title = res.win ? '勝利！' : res.surrendered ? '已投降' : '落敗';
    const sub = res.win
      ? (res.mode === 'ai' ? `擊敗了${session.opts.oppName}` : res.forfeit ? '對手已斷線，判定勝利' : res.oppSurrendered ? '對手投降了' : '對手的核心已被攻破')
      : (res.surrendered ? '下次再接再厲' : '多派兵提高收入、補上對手會針對的弱點，再試一次！');
    const m = this.modal([
      h('h2', {}, title), h('p', {}, sub), statsGrid, res.mode === 'online' ? note : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => { this.click(); toMenu(); } }, svg('home'), '返回'),
        again),
    ], { cls: `result${res.win ? '' : ' lose'}`, onBack: toMenu });
  },
};

export { PACKS };
