// Online versus lobby: create a room (5-digit code) or join one, then start both clients together.
// Mixed into Screens (see screens.js), so `this` is the Screens instance.
import { h, svg } from './dom.js';
import { createRoom, joinRoom } from '../net/room.js';
import { RemoteSide } from '../net/remoteSide.js';

const START_DELAY = 3000; // ms countdown after the handshake so both sides start together
const GAME_URL = 'https://job159.github.io/Tower-Defense-Game_Android/';

const ERRORS = {
  'bad-code': '房間號碼是 5 位數字',
  'not-found': '找不到這個房間（號碼錯誤或房主已離開）',
  full: '這個房間已經有兩位玩家了',
  version: '雙方遊戲版本不同，請兩人都更新到最新版',
  network: '連線失敗，請確認網路後再試一次',
  timeout: '連線逾時，請再試一次',
};

export const versusOnline = {
  versusOnline(opts = {}) {
    const app = this.app;
    app.ensureMenuScene();
    const save = app.save;
    if (!save.data.vsName) { save.data.vsName = `指揮官${Math.floor(100 + Math.random() * 900)}`; save.write(); }
    const lobby = { room: null, offs: [], timer: 0, closed: false };
    this.lobby = lobby;
    const picker = this.loadoutPicker(this.savedVersusLoadout(), () => {});
    const name = h('input', { class: 'vs-name', maxlength: 10, value: save.data.vsName, 'aria-label': '暱稱' });
    name.addEventListener('change', () => { save.data.vsName = name.value.trim().slice(0, 10) || save.data.vsName; save.write(); });
    const status = h('div', { class: 'vs-status' }, '建立房間，或輸入朋友給你的房間號碼。');
    const codeBox = h('div', { class: 'vs-code num' });
    const codeIn = h('input', { class: 'vs-code-in num', inputmode: 'numeric', maxlength: 5, placeholder: '房間號碼', 'aria-label': '房間號碼' });
    if (opts.join) codeIn.value = opts.join;
    const createBtn = h('button', { class: 'btn primary' }, svg('wave'), '建立房間');
    const joinBtn = h('button', { class: 'btn' }, svg('play'), '加入');
    const shareBtn = h('button', { class: 'btn ghost small', style: { display: 'none' } }, '分享號碼');
    const setStatus = (t, cls = '') => { status.textContent = t; status.className = `vs-status ${cls}`; };
    const busy = (on) => { createBtn.disabled = joinBtn.disabled = on; codeIn.disabled = on; };
    const myInfo = () => ({ name: (name.value.trim() || save.data.vsName).slice(0, 10), loadout: picker.get() });
    const on = (ev, fn) => { lobby.room.on(ev, fn); lobby.offs.push([ev, fn]); };
    const unhook = () => { if (lobby.room) for (const [ev, fn] of lobby.offs) lobby.room.off(ev, fn); lobby.offs.length = 0; };
    lobby.leave = () => { unhook(); clearTimeout(lobby.timer); lobby.closed = true; if (lobby.room && !lobby.inMatch) lobby.room.close('left'); };

    // both sides count down to the same moment, then the match starts
    const launch = (seed, peer, delay) => {
      unhook();
      const me = myInfo();
      this.rememberVersusLoadout(me.loadout);
      busy(true);
      const at = performance.now() + delay;
      const tick = () => {
        if (lobby.closed) return;
        const ms = at - performance.now();
        if (ms > 0) { setStatus(`對手：${peer.name}　${Math.ceil(ms / 1000)}…`, 'go'); lobby.timer = setTimeout(tick, Math.min(250, ms)); return; }
        lobby.inMatch = true;
        app.startVersus({ mode: 'online', seed, loadout: me.loadout, oppName: peer.name,
          online: { room: lobby.room, remote: new RemoteSide(lobby.room, { name: peer.name, loadout: peer.loadout }) } });
      };
      tick();
    };

    createBtn.onclick = async () => {
      this.click();
      if (!picker.get().length) { app.toast('至少編入一種砲塔'); return; }
      busy(true);
      try {
        lobby.room = await createRoom({ version: app.version, name: myInfo().name, onStatus: (t) => setStatus(t) });
      } catch (e) { busy(false); setStatus(ERRORS[e.code] || ERRORS.network, 'err'); return; }
      if (lobby.closed) { lobby.room.close('left'); return; }
      const code = lobby.room.code;
      codeBox.textContent = code.split('').join(' ');
      codeBox.style.display = '';
      shareBtn.style.display = '';
      shareBtn.onclick = () => this.shareRoom(code);
      setStatus('把房間號碼告訴朋友，等待對手加入…', 'wait');
      on('message', ({ type, data }) => {
        if (type !== 'hello') return;
        const seed = Math.floor(Math.random() * 1e9);
        const me = myInfo();
        lobby.room.send('start', { seed, name: me.name, loadout: me.loadout, delay: START_DELAY });
        launch(seed, { name: data.name || '對手', loadout: data.loadout || [] }, START_DELAY);
      });
      on('peer-left', () => setStatus('對手離開了，房間重新開放，等待新的對手…', 'wait'));
    };

    joinBtn.onclick = async () => {
      this.click();
      const code = codeIn.value.replace(/\D/g, '');
      if (code.length !== 5) { setStatus(ERRORS['bad-code'], 'err'); return; }
      if (!picker.get().length) { app.toast('至少編入一種砲塔'); return; }
      busy(true);
      try {
        lobby.room = await joinRoom(code, { version: app.version, name: myInfo().name, onStatus: (t) => setStatus(t) });
      } catch (e) {
        busy(false);
        setStatus(e.code === 'version' && e.hostVersion ? `${ERRORS.version}（房主 v${e.hostVersion}，你 v${app.version}）` : ERRORS[e.code] || ERRORS.network, 'err');
        return;
      }
      if (lobby.closed) { lobby.room.close('left'); return; }
      setStatus('已加入房間，等待房主開始…', 'wait');
      on('message', ({ type, data }) => {
        if (type !== 'start') return;
        const delay = Math.max(500, (data.delay || START_DELAY) - (lobby.room.rtt || 0) / 2);
        launch(data.seed, { name: data.name || '對手', loadout: data.loadout || [] }, delay);
      });
      on('closed', () => { if (!lobby.inMatch) { lobby.closed = true; busy(false); setStatus('房主關閉了房間', 'err'); } });
      lobby.room.send('hello', myInfo());
    };

    const el = h('div', { class: 'layer screen fade-in' },
      h('div', { class: 'screen-head' },
        h('button', { class: 'icon-btn', onclick: () => { this.click(); lobby.leave(); this.versusMenu(); } }, svg('back')),
        h('h1', {}, '線上對戰'), h('span', { class: 'chip' }, '暱稱'), name, picker.count),
      h('div', { class: 'vs-online' },
        h('div', { class: 'vs-setup' }, h('div', { class: 'sect' }, '砲塔編成（選 6 種；開戰時對手看得到）'), picker.el),
        h('div', { class: 'vs-room panel' },
          h('div', { class: 'sect' }, '建立房間'),
          createBtn,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' } }, codeBox, shareBtn),
          h('div', { class: 'sect' }, '加入房間'),
          h('div', { class: 'vs-join' }, codeIn, joinBtn),
          status)));
    codeBox.style.display = 'none';
    this.show('versusOnline', el);
    if (opts.join && opts.join.length === 5) setTimeout(() => joinBtn.click(), 200);
  },

  async shareRoom(code) {
    const text = `來玩霓虹防線雙人對戰！房間號碼：${code}`;
    try {
      if (navigator.share) { await navigator.share({ title: '霓虹防線', text, url: `${GAME_URL}play/?room=${code}` }); return; }
    } catch (e) { /* cancelled */ }
    try { await navigator.clipboard.writeText(`${text}\n${GAME_URL}`); this.app.toast('已複製房間號碼'); } catch (e) { this.app.toast(`房間號碼：${code}`); }
  },
};
