// Versus HUD: the standard HUD plus income, opponent status, the next-wave clock and the send bar.
import { Hud } from './hud.js';
import { h, svg, fmt } from './dom.js';
import { PACKS, VS_RULES } from '../core/versus.js';
import { ENEMIES } from '../core/config.js';

// one-line counter hint shown on long-press
const PACK_TIPS = {
  scout: '數量多、速度快：範圍攻擊與連鎖閃電最有效',
  walker: '均衡的步兵，最划算的收入投資',
  flyer: '飛行單位：對手需要能對空的砲塔',
  shield: '護盾：電磁傷害（特斯拉）可加倍擊破',
  phantom: '隱形：對手沒有感測陣列就打不到',
  tank: '重裝甲：雷射、焚化者才剋得住',
  hive: '飛行母艦，擊落後再放出一群蜂群機',
  juggernaut: '免疫控場的重甲巨獸',
  colossus: '首領級：高裝甲並持續召喚援軍',
};

export class VersusHud extends Hud {
  constructor(session) {
    super(session);
    const o = session.opts;
    // top bar: income (ring = time to the next payout) and the opponent's lives
    this.elEco = h('div', { class: 'stat eco panel num' }, h('i', { class: 'ring' }), h('small', {}, '收入'), h('span'));
    this.elCredits.after(this.elEco);
    this.elOpp = h('div', { class: 'stat opp panel num' }, h('small', {}, o.oppName || '對手'), svg('core'), h('span'));
    this.elWave.after(this.elOpp);
    this.elWave.querySelector('small').textContent = '下一波';
    if (o.mode === 'online') { this.elSpeed.remove(); this.elSpeed = null; }
    // neutral waves run on the shared clock: no "next wave" button
    this.root.querySelector('.wave-box').remove();
    this.elNext = null;
    // send bar: [monster icon] x count, cost (+eco)
    const bar = h('div', { class: 'send-bar' });
    this.sendBtns = {};
    for (const p of PACKS) {
      const b = h('button', { class: 'send' },
        h('div', { class: 'cd' }),
        h('span', { class: 'eco num' }, `+${p.eco}`),
        this.icons.enemy[p.type] ? h('img', { src: this.icons.enemy[p.type] }) : h('span', { class: 'ph' }, ENEMIES[p.type].name.slice(0, 2)),
        h('span', { class: 'cnt num' }, `×${p.count}`),
        h('span', { class: 'cost num' }, p.cost),
        h('span', { class: 'lk num' }, `第${p.unlock}波`));
      this.bindPress(b, () => session.sendPack(p.id), () => this.packInfo(p));
      this.sendBtns[p.id] = b;
      bar.append(b);
    }
    this.root.append(bar);
    this.alerts = h('div', { class: 'vs-alerts' });
    this.root.append(this.alerts);
  }

  // tap = send, long-press = details (sending must be one quick tap during a fight)
  bindPress(el, onTap, onLong) {
    let timer = 0, long = false;
    el.addEventListener('pointerdown', () => { long = false; clearTimeout(timer); timer = setTimeout(() => { long = true; onLong(); }, 420); });
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('click', (ev) => { ev.stopPropagation(); if (long) { long = false; return; } onTap(); });
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  packInfo(p) {
    const d = ENEMIES[p.type];
    this.hint(`<b>${d.name} ×${p.count}</b>　花費 ${p.cost}　收入 +${p.eco}/${VS_RULES.incomeEvery}秒<br>${PACK_TIPS[p.id] || d.desc}`, 3200);
  }

  waveText(g) {
    const t = Math.ceil(g.timeToNextWave());
    return g.wave === 0 ? `${t}s` : `${g.wave + 1} · ${t}s`;
  }

  update(dt) {
    super.update(dt);
    const g = this.s.game, o = this.s.opp, c = this.cache;
    const eco = `+${g.eco}`;
    if (c.eco !== eco) { c.eco = eco; this.elEco.lastChild.textContent = eco; this.bump(this.elEco); }
    const f = 1 - g.ecoT / VS_RULES.incomeEvery;
    this.elEco.querySelector('.ring').style.background = `conic-gradient(#45ffb0 ${Math.round(f * 360)}deg, rgba(69,255,176,0.15) 0)`;
    const ol = Math.max(0, Math.ceil(o.lives));
    if (c.opp !== ol) {
      if (c.opp !== undefined && ol < c.opp) this.bump(this.elOpp);
      c.opp = ol;
      this.elOpp.lastChild.textContent = ol;
      this.elOpp.classList.toggle('low', ol / o.maxLives < 0.35);
    }
    for (const p of PACKS) {
      const b = this.sendBtns[p.id];
      const locked = !g.packUnlocked(p);
      const cd = g.packCd[p.id] || 0;
      const poor = g.credits < p.cost;
      const key = `${locked}|${poor}|${Math.round((cd / p.cd) * 30)}`;
      if (b._k === key) continue;
      b._k = key;
      b.classList.toggle('locked', locked);
      b.classList.toggle('poor', poor && !locked);
      b.classList.toggle('ready', !locked && !poor && cd <= 0);
      b.querySelector('.cd').style.background = cd > 0 && !locked ? `conic-gradient(rgba(5,6,16,0.8) ${(cd / p.cd) * 360}deg, transparent 0)` : 'none';
    }
  }

  // online: show when the opponent's connection is shaky
  netStatus(st) {
    if (st === 'connected') { if (this.elNet) { this.elNet.remove(); this.elNet = null; } return; }
    if (!this.elNet) { this.elNet = h('div', { class: 'vs-net' }); this.root.append(this.elNet); }
    this.elNet.textContent = st === 'lagging' ? '對手連線不穩，等待中…' : st === 'lost' ? '對手已斷線' : '連線中…';
  }

  // red line under the top bar when the opponent sends something at us
  incoming(p) {
    const d = ENEMIES[p.type];
    // repeats of the same pack fold into one line with a batch counter
    let a = this.alertMap && this.alertMap.get(p.id);
    if (!this.alertMap) this.alertMap = new Map();
    if (a && a.el.isConnected) {
      a.n++;
      a.txt.textContent = `敵方派出 ${d.name} ×${p.count} · ${a.n}批`;
      a.el.classList.remove('bump'); void a.el.offsetWidth; a.el.classList.add('bump');
    } else {
      const txt = h('span', {}, `敵方派出 ${d.name} ×${p.count}`);
      a = { n: 1, txt, el: h('div', { class: 'vs-alert' }, this.icons.enemy[p.type] ? h('img', { src: this.icons.enemy[p.type] }) : null, txt) };
      this.alertMap.set(p.id, a);
      this.alerts.prepend(a.el);
      while (this.alerts.children.length > 2) this.alerts.lastChild.remove();
    }
    clearTimeout(a.timer);
    a.timer = setTimeout(() => { a.el.remove(); this.alertMap.delete(p.id); }, 2600);
  }

  sent(p) {
    const b = this.sendBtns[p.id];
    if (!b) return;
    b.classList.remove('fired');
    void b.offsetWidth;
    b.classList.add('fired');
    const r = b.getBoundingClientRect(), root = this.root.getBoundingClientRect();
    this.float(r.left - root.left + r.width / 2, r.top - root.top - 6, `收入 +${p.eco}`, 'gold');
  }
}

export { fmt };
