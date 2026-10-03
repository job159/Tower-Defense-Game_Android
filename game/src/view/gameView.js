// Renders a running Game: scenery, towers, enemies, units, projectiles and all event-driven effects.
import * as THREE from 'three';
import { World, GROUND_Y } from './world.js';
import { CameraRig } from './camera.js';
import { TowerView, makeRangeRing } from './towerView.js';
import { EnemyView } from './enemyView.js';
import { UnitsView } from './unitsView.js';
import { Particles, Decals, Beams, lightning } from './fx.js';
import { buildEnvironment } from './materials.js';
import { TOWERS } from '../core/config.js';
import { TILE, worldToTile } from '../core/path.js';

const _v = new THREE.Vector3();
const _c = new THREE.Color();
let envTex = null;

const hex = (h) => _c.set(h);

const DEATH_COLOR = {
  shield: 0x6a8cff, medic: 0x3dff8a, stalker: 0xb04dff, splitter: 0xffd23d, phantom: 0x9fe8ff, mirror: 0xe8f0ff,
  regenerator: 0x3dff8a, disruptor: 0x7fb8ff, hive: 0xffd23d, swarmling: 0xffd23d, queen: 0xff4fd8, dreadnought: 0x6aa8ff, omega: 0xffd0a0, omega2: 0xffd0a0,
};

export class GameView {
  constructor(renderer, game, opts = {}) {
    this.renderer = renderer;
    this.game = game;
    this.level = game.level;
    this.fxScale = opts.fxScale ?? 1;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x05040d);
    scene.fog = new THREE.FogExp2(0x0a0620, 0.016);
    if (!envTex) envTex = buildEnvironment(renderer.gl);
    scene.environment = envTex;
    this.rig = new CameraRig(this.level);
    this.world = new World(this.level, game.map, scene, { shadows: renderer.q.shadows });
    for (const [c, r] of game.cleared) this.world.clearWreck(c, r);
    this.towers = new TowerView(scene);
    this.enemies = new EnemyView(scene);
    this.units = new UnitsView(scene);
    this.parts = new Particles(scene, Math.round(3000 * Math.max(0.5, this.fxScale)), 'add');
    this.smoke = new Particles(scene, 600, 'alpha');
    this.decals = new Decals(scene, 500);
    this.beams = new Beams(scene, 1600); // roomy: a full-field thunder strike draws ~20 segments per enemy
    this.range = makeRangeRing();
    scene.add(this.range);
    this.bolts = [];
    this.rails = [];
    this.auraDecals = new Map();
    this.wellDecals = new Map();
    this.zoneDecals = new Map();
    this.pools = new Map();
    this.marker = null;
    this.ghost = null;
    this.time = 0;
    this.listeners = [];
    this.selectedId = null;
    // Everything drawn comes from `sources`: the player's game, plus the opponent's lane in versus (a local AI
    // game or a network mirror exposing the same lists). Ids are unique across sources.
    this.sources = [game];
    renderer.setScene(scene, this.rig.camera);
    for (const t of game.towers) { this.towers.add(t); this.addPool(t); this.addAura(t); }
  }

  addSource(src) {
    this.sources.push(src);
    src.events.length = 0; // its current towers are added directly below; stale events would replay
    for (const t of src.towers) { this.towers.add(t); this.addPool(t); this.addAura(t); }
  }

  on(fn) { this.listeners.push(fn); }

  resize(w, h, margins) {
    this.renderer.resize(w, h);
    this.rig.fit(w / h, margins);
  }

  // Colored light pool under a tower (instanced decal instead of a mesh per tower).
  addPool(t) {
    this.removePool(t);
    const c = _c.set(TOWERS[t.type].color);
    this.pools.set(t.id, this.decals.add({ x: t.x, z: t.z, y: 0.012, shape: 0, size0: 1.5, size1: 1.5, r: c.r * 0.55, g: c.g * 0.55, b: c.b * 0.55, a: 1, life: 0 }));
  }

  removePool(t) {
    const d = this.pools.get(t.id);
    if (d) { this.decals.remove(d); this.pools.delete(t.id); }
  }

  addAura(t) {
    const old = this.auraDecals.get(t.id);
    if (old) { this.decals.remove(old); this.auraDecals.delete(t.id); }
    if (t.stats.attack === 'aura') {
      this.auraDecals.set(t.id, this.decals.add({ x: t.x, z: t.z, shape: 1, thick: 0.05, size0: t.stats.range * 2, size1: t.stats.range * 2, r: 0.4, g: 0.9, b: 1.4, a: 0.5, life: 0, pulse: 2 }));
    } else if (t.stats.jam) {
      this.auraDecals.set(t.id, this.decals.add({ x: t.x, z: t.z, shape: 2, thick: 0.03, size0: t.stats.range * 2, size1: t.stats.range * 2, r: 0.9, g: 0.4, b: 1.6, a: 0.45, life: 0, pulse: 3, spin: 0.2 }));
    }
  }

  // ---------------------------------------------------------------- picking & selection
  pick(sx, sy) {
    const w = this.renderer.width, h = this.renderer.height;
    const p = this.rig.screenToGround(sx, sy, w, h, 0, _v);
    const { col, row } = worldToTile(this.level, p.x, p.z);
    const tile = this.game.map.at(col, row);
    const x = p.x, z = p.z;
    return { col, row, tile, x, z, tower: tile === TILE.BUILD ? this.game.towerOn(col, row) : null, wreck: tile === TILE.WRECK ? this.game.map.wreckAt(col, row) : null };
  }

  // Enemy closest to a screen position (within a finger's reach).
  pickEnemy(sx, sy, maxPx = 34) {
    let best = null, bd = maxPx * maxPx;
    for (const src of this.sources) for (const e of src.enemies) {
      if (e.dead || e.inWarp || ((e.def.cloak || e.cloakT > 0) && !e.detected)) continue;
      const p = this.screenOf(e.x, (e.air ? e.y : 0.25) + 0.2, e.z);
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  screenOf(x, y, z) {
    _v.set(x, y, z);
    return this.rig.worldToScreen(_v, this.renderer.width, this.renderer.height);
  }

  showRange(x, z, r, color = 0x22e6ff) {
    this.range.visible = true;
    this.range.position.set(x, 0.03, z);
    this.range.scale.set(r, r, 1);
    this.range.material.uniforms.uColor.value.set(color);
  }

  hideRange() { this.range.visible = false; }

  setMarker(x, z, color = 0x22e6ff) {
    this.clearMarker();
    const c = _c.set(color);
    this.marker = this.decals.add({ x, z, y: 0.025, shape: 2, thick: 0.1, size0: 1.0, size1: 1.0, r: c.r * 2, g: c.g * 2, b: c.b * 2, a: 1, life: 0, pulse: 6, spin: 0.6 });
  }

  clearMarker() { if (this.marker) { this.decals.remove(this.marker); this.marker = null; } }

  setGhost(type, level, spec, x, z, ok = true) {
    this.clearGhost();
    const g = this.towers.build(type, level, spec, true, !ok);
    g.root.position.set(x, 0, z);
    g.head.rotation.y = this.game._facePath(x, z);
    this.scene.add(g.root);
    this.ghost = g;
  }

  clearGhost() { if (this.ghost) { this.scene.remove(this.ghost.root); this.ghost = null; } }


  // ---------------------------------------------------------------- event effects
  handle(ev, src = this.game) {
    const s = this.fxScale;
    switch (ev.type) {
      case 'build': {
        const t = ev.tower;
        this.towers.rebuild(t);
        this.addPool(t);
        this.ring(t.x, t.z, TOWERS[t.type].color, 0.2, 1.3, 0.5, 2);
        this.burst(t.x, 0.3, t.z, TOWERS[t.type].color, 16 * s, 2.2, 0.5, 0.06, 3);
        break;
      }
      case 'upgrade': {
        const t = ev.tower;
        this.towers.rebuild(t);
        this.addAura(t);
        const col = ev.ultimate ? 0xffd66b : TOWERS[t.type].color;
        this.ring(t.x, t.z, col, 0.2, ev.ultimate ? 2.6 : 1.6, 0.6, 2);
        this.ring(t.x, t.z, 0xffffff, 0.1, 1.0, 0.4, 1);
        for (let i = 0; i < (ev.ultimate ? 60 : 24) * s; i++) {
          const a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.25;
          hex(i % 3 === 0 && ev.ultimate ? 0xffffff : col);
          this.parts.spawn(t.x + Math.cos(a) * r, 0.1, t.z + Math.sin(a) * r, 0, 1.5 + Math.random() * (ev.ultimate ? 4 : 2), 0, 0.7, 0.08, 0.02, _c.r * 2, _c.g * 2, _c.b * 2, 1, 1.5, -0.5, 0.05);
        }
        if (ev.ultimate) { this.flash(t.x, 1.2, t.z, 0xfff0c0, 3, 0.4); this.rails.push({ x1: t.x, y1: 12, z1: t.z, x2: t.x, y2: 0, z2: t.z, t: 0, color: 0xffd66b, w: 0.35, life: 0.5 }); this.rig.shake(0.08); }
        break;
      }
      case 'sell': {
        const t = ev.tower;
        this.towers.remove(t);
        this.removePool(t);
        const d = this.auraDecals.get(t.id);
        if (d) { this.decals.remove(d); this.auraDecals.delete(t.id); }
        this.ring(t.x, t.z, 0xffd23d, 0.2, 1.2, 0.5, 1);
        this.burst(t.x, 0.3, t.z, 0xffd23d, 14 * s, 2, 0.5, 0.05, 3);
        break;
      }
      case 'rankUp': {
        const t = ev.tower;
        this.ring(t.x, t.z, 0xffd66b, 0.3, 1.6, 0.6, 2);
        for (let i = 0; i < 18 * s; i++) this.parts.spawn(t.x + (Math.random() - 0.5) * 0.5, 0.4, t.z + (Math.random() - 0.5) * 0.5, 0, 2 + Math.random() * 2, 0, 0.8, 0.1, 0.02, 3, 2.4, 0.8, 1, 1.2, -0.3);
        break;
      }
      case 'fire': this.onFire(ev.tower, ev.kind); break;
      case 'rail': {
        const m = this.towers.muzzle(ev.tower, new THREE.Vector3());
        this.rails.push({ x1: m.x, y1: m.y, z1: m.z, x2: ev.x2, y2: 0.4, z2: ev.z2, t: 0, w: ev.over ? 0.34 : 0.14, color: ev.over ? 0xd0f8ff : 0x7ff4ff, life: ev.over ? 0.45 : 0.28 });
        this.flash(m.x, m.y, m.z, 0x9ff8ff, ev.over ? 1.6 : 0.8, 0.12);
        this.rig.shake(ev.over ? 0.08 : 0.03);
        break;
      }
      case 'tesla': {
        const pts = ev.pts.slice();
        const m = this.towers.muzzle(ev.tower, _v);
        pts[0] = m.x; pts[1] = m.y; pts[2] = m.z;
        if (ev.storm) {
          for (let i = 3; i < pts.length; i += 3) this.bolts.push({ pts: [pts[i], pts[i + 1] + 4, pts[i + 2], pts[i], pts[i + 1], pts[i + 2]], t: 0, storm: true });
          this.flash(m.x, m.y + 0.3, m.z, 0xd0a0ff, 2, 0.3);
          this.rig.shake(0.05);
        } else this.bolts.push({ pts, t: 0, emp: !!ev.tower.stats.stun });
        for (let i = 3; i < pts.length; i += 3) this.flash(pts[i], pts[i + 1], pts[i + 2], ev.tower.stats.stun ? 0x7ff4ff : 0xc080ff, 0.55, 0.12);
        break;
      }
      case 'hit':
        if (ev.kind === 'bullet') {
          this.flash(ev.x, ev.y, ev.z, ev.color, 0.3, 0.06);
          this.sparks(ev.x, ev.y, ev.z, ev.color, 3 * s, 2.5, 0.25);
        } else {
          this.flash(ev.x, ev.y, ev.z, 0x9fe8ff, 0.5 + ev.splash * 0.6, 0.12);
          this.sparks(ev.x, ev.y, ev.z, 0xbff6ff, 6 * s, 2, 0.35);
          if (ev.splash) this.ring(ev.x, ev.z, 0x7fd8ff, 0.1, ev.splash * 2, 0.35, 1);
        }
        break;
      case 'explode': this.explode(ev); break;
      case 'mineBoom': this.explode({ ...ev, y: 0.05, kind: ev.kind === 'emp' ? 'empMine' : ev.kind === 'cluster' ? 'mortar' : 'bomblet' }); break;
      case 'mineDrop': {
        const m = ev.mine;
        this.towers.fired(ev.tower);
        this.flash(m.x, 0.15, m.z, 0xffe03d, 0.4, 0.1);
        this.ring(m.x, m.z, 0xffe03d, 0.05, 0.5, 0.3, 1);
        break;
      }
      case 'droneFire': {
        const d = ev.drone;
        if (ev.target) {
          const e = ev.target;
          this.rails.push({ x1: d.x, y1: d.y, z1: d.z, x2: e.x, y2: e.h, z2: e.z, t: 0, w: 0.035, color: 0x3dffea, life: 0.06 });
          if (Math.random() < 0.5) this.sparks(e.x, e.h, e.z, 0x9ffff0, 2, 2, 0.2);
        } else this.flash(d.x, d.y, d.z, 0xffd23d, 0.3, 0.08);
        break;
      }
      case 'ping': {
        const t = ev.tower;
        this.decals.add({ x: t.x, z: t.z, y: 0.03, shape: 1, thick: 0.04, size0: 0.3, size1: t.stats.range * 2, r: 0.6, g: 1.8, b: 0.4, a: 0.7, life: 0.9 });
        break;
      }
      case 'well': break;
      case 'kill': this.death(ev.enemy); break;
      case 'leak': {
        const ci = src.side || 0;
        const c = this.game.map.cores[ci] || this.game.map.core;
        this.world.hitCore(ev.dmg, ci);
        this.flash(c.x, 1, c.z, 0xff3050, 2.2, 0.25);
        this.sparks(c.x, 0.8, c.z, 0xff4060, 20 * s, 4, 0.6);
        this.rig.shake(0.08 + ev.dmg * 0.02);
        break;
      }
      case 'spawn': {
        const e = ev.enemy;
        if (!e.air && !(e.def.cloak)) this.ring(e.x, e.z, 0xff2fd0, 0.1, 0.9, 0.35, 1);
        break;
      }
      case 'heal':
        this.ring(ev.x, ev.z, 0x3dff8a, 0.2, ev.r * 2, 0.6, 1);
        for (let i = 0; i < 8 * s; i++) this.parts.spawn(ev.x + (Math.random() - 0.5) * ev.r, 0.2, ev.z + (Math.random() - 0.5) * ev.r, 0, 1 + Math.random(), 0, 0.6, 0.1, 0.02, 0.3, 2, 0.8, 1, 1);
        break;
      case 'blink':
        this.flash(ev.x0, 0.35, ev.z0, 0xc060ff, 0.9, 0.18);
        this.flash(ev.x1, 0.35, ev.z1, 0xe090ff, 1.1, 0.22);
        this.rails.push({ x1: ev.x0, y1: 0.3, z1: ev.z0, x2: ev.x1, y2: 0.3, z2: ev.z1, t: 0, color: 0xb04dff, w: 0.18 });
        break;
      case 'shieldBreak': {
        const e = ev.enemy;
        this.flash(e.x, e.h, e.z, 0x6aa8ff, e.boss ? 3 : 1.2, 0.15);
        this.sparks(e.x, e.h, e.z, 0x8ab8ff, (e.boss ? 40 : 14) * s, 3, 0.5);
        break;
      }
      case 'freeze': {
        const e = ev.enemy;
        this.sparks(e.x, e.h, e.z, 0xdffbff, 8 * s, 1.5, 0.5);
        this.ring(e.x, e.z, 0xbff6ff, 0.1, 0.9, 0.4, 1);
        break;
      }
      case 'shatter': {
        const col = ev.kind === 'ice' ? 0xbff6ff : ev.kind === 'fire' ? 0xff7a2a : 0xffd0a0;
        this.flash(ev.x, ev.y, ev.z, col, 1.2 + ev.r, 0.2);
        this.sparks(ev.x, ev.y, ev.z, col, (ev.kind === 'thermal' ? 22 : 14) * s, 4, 0.5);
        if (ev.kind === 'thermal') { this.sparks(ev.x, ev.y, ev.z, 0x7fe8ff, 10 * s, 3, 0.4); this.ring(ev.x, ev.z, 0xffffff, 0.1, 1.2, 0.3, 1); }
        this.ring(ev.x, ev.z, col, 0.1, ev.r * 2, 0.4, 1);
        break;
      }
      case 'reveal': {
        const e = ev.enemy;
        this.ring(e.x, e.z, 0x9dff3d, 0.1, 1.0, 0.5, 3);
        this.flash(e.x, e.h, e.z, 0xc8ff9a, 0.7, 0.2);
        break;
      }
      case 'emp': {
        this.decals.add({ x: ev.x, z: ev.z, y: 0.04, shape: 1, thick: 0.1, size0: 0.3, size1: ev.r * 2, r: 0.8, g: 1.6, b: 3, a: 1, life: 0.6 });
        this.decals.add({ x: ev.x, z: ev.z, y: 0.04, shape: 0, size0: ev.r * 2, size1: ev.r * 2.2, r: 0.2, g: 0.45, b: 1, a: 1, life: 0.8 });
        this.flash(ev.x, 0.6, ev.z, 0x9fd8ff, 2, 0.25);
        for (const t of ev.towers) {
          this.bolts.push({ pts: [ev.x, 0.6, ev.z, t.x, 0.8, t.z], t: 0, emp: true });
          this.sparks(t.x, 0.7, t.z, 0x9fd8ff, 10 * s, 2.5, 0.5);
        }
        break;
      }
      case 'summon': {
        const e = ev.enemy;
        this.ring(e.x, e.z, 0xff3050, 0.3, 2.4, 0.7, 1);
        this.flash(e.x, e.air ? e.y : 1, e.z, 0xff3050, 1.6, 0.25);
        break;
      }
      case 'bossPhase': {
        const e = ev.enemy;
        if (ev.kind === 'transform') {
          this.flash(e.x, 1.5, e.z, 0xffffff, 6, 0.6);
          this.ring(e.x, e.z, 0xffd0a0, 0.5, 8, 1.2, 1);
          this.sparks(e.x, 1.2, e.z, 0xffd0a0, 60 * s, 7, 1.2);
          this.rig.shake(0.35);
        } else if (ev.kind === 'enrage') {
          this.ring(e.x, e.z, 0xff3050, 0.4, 3.5, 0.9, 2);
          this.flash(e.x, 1.2, e.z, 0xff3050, 3, 0.4);
          this.rig.shake(0.15);
        } else if (ev.kind === 'cloak') {
          this.flash(e.x, e.y || 1, e.z, 0xc080ff, 2.5, 0.4);
        } else {
          this.ring(e.x, e.z, 0xffd23d, 0.4, 3, 0.8, 1);
        }
        break;
      }
      case 'waveStart':
        for (const p of this.world.portals) {
          this.ring(p.x, p.z, 0xff2fd0, 0.3, 2.6, 0.8, 1);
          this.flash(p.x, 0.5, p.z, 0xff2fd0, 1.6, 0.3);
        }
        break;
      case 'ability':
        if (ev.id === 'stasis') {
          // versus: the ripple covers only the caster's half
          const vs = this.level.versus, cx = vs ? ((src.side || 0) ? 1 : -1) * this.level.cols / 4 : 0;
          this.decals.add({ x: cx, z: 0, shape: 1, thick: 0.08, size0: 0.5, size1: vs ? this.level.cols * 0.9 : Math.max(this.level.cols, this.level.rows) * 2, r: 0.5, g: 1.2, b: 2.4, a: 1, life: 1.2 });
          for (const e of src.enemies) this.ring(e.x, e.z, 0x6ad8ff, 0.1, 0.9, 0.6, 1);
        } else if (ev.id === 'thunder') {
          // 雷霆審判: a bolt from the sky onto every enemy, slightly staggered, plus a field-wide flash
          for (const [x, y, z, boss] of ev.hits) {
            const jx = (Math.random() - 0.5) * 1.2, jz = (Math.random() - 0.5) * 1.2;
            this.bolts.push({ pts: [x + jx, 7, z + jz, x + jx * 0.4, (y + 7) / 2, z + jz * 0.4, x, y, z], t: -Math.random() * 0.22, thunder: true, boss });
            this.flash(x, y + 0.2, z, 0xfff0a0, boss ? 1.5 : 0.75, 0.25);
            this.sparks(x, y, z, 0xffe680, (boss ? 16 : 6) * s, 3, 0.45);
            this.decals.add({ x, z, shape: 0, size0: 0.9, size1: 1.2, r: 1.6, g: 1.4, b: 0.5, a: 1, life: 0.6 });
          }
          this.rig.shake(0.28);
        }
        break;
      // versus: a pack leaves through the sender's side and arrives at the receiver's gate
      case 'send':
      case 'incoming': {
        const ps = this.world.portals;
        const p = ps[ev.type === 'incoming' ? (src.side || 0) : 1 - (src.side || 0)] || ps[0];
        if (!p) break;
        const col = ev.type === 'incoming' ? 0xff3d6e : 0x22e6ff;
        this.ring(p.x, p.z, col, 0.2, 2.2, 0.7, 2);
        this.flash(p.x, 0.6, p.z, col, 1.6, 0.3);
        break;
      }
      case 'clearWreck': {
        this.world.clearWreck(ev.col, ev.row);
        this.puff(ev.x, 0.2, ev.z, 8, 1);
        this.sparks(ev.x, 0.3, ev.z, 0xffb060, 20 * s, 3, 0.6);
        if (ev.node) { this.ring(ev.x, ev.z, 0xffc93d, 0.2, 2.2, 0.9, 2); this.flash(ev.x, 0.5, ev.z, 0xffd66b, 2, 0.4); }
        break;
      }
      default: break;
    }
    ev.remote = src !== this.game;
    for (const fn of this.listeners) fn(ev, src);
  }

  onFire(t, kind) {
    this.towers.fired(t);
    const m = this.towers.muzzle(t, _v);
    const col = TOWERS[t.type].color;
    if (kind === 'bullet') this.flash(m.x, m.y, m.z, col, t.spec === 'a' ? 0.35 : 0.45, 0.05);
    else if (kind === 'shell' || kind === 'napalm') { this.flash(m.x, m.y, m.z, kind === 'napalm' ? 0xffb02e : 0xff9a3d, 0.7, 0.1); this.puff(m.x, m.y, m.z, 3, 0.4); }
    else if (kind === 'frost') this.flash(m.x, m.y, m.z, 0x9fe8ff, 0.45, 0.08);
    else if (kind === 'missile') this.puff(m.x, m.y, m.z, 4, 0.5);
    else if (kind === 'tesla') this.flash(m.x, m.y, m.z, 0xd0a0ff, 0.9, 0.1);
  }

  explode(ev) {
    const s = this.fxScale;
    const { x, y, z, r } = ev;
    switch (ev.kind) {
      case 'nuke':
        this.flash(x, 0.8, z, 0xffffff, 7, 0.5);
        this.flash(x, 0.4, z, 0xffd060, 9, 0.8);
        this.ring(x, z, 0xffe070, 0.3, r * 3, 1.1, 1);
        this.ring(x, z, 0xffffff, 0.3, r * 1.8, 0.5, 1);
        this.sparks(x, 0.4, z, 0xffe0a0, 70 * s, 9, 1.2);
        this.puff(x, 0.4, z, 16, 2.2);
        this.rig.shake(0.35);
        break;
      case 'mortar':
        this.flash(x, 0.25, z, 0xffa040, 1.4 * r + 0.4, 0.18);
        this.ring(x, z, 0xff8a2a, 0.2, r * 2.2, 0.45, 1);
        this.sparks(x, 0.2, z, 0xffb060, 14 * s, 4, 0.55);
        this.puff(x, 0.2, z, 5, 0.9);
        this.decals.add({ x, z, shape: 0, size0: r * 1.4, size1: r * 1.6, r: 0.5, g: 0.18, b: 0.04, a: 0.8, life: 1.2 });
        this.rig.shake(0.035);
        break;
      case 'napalm':
        this.flash(x, 0.25, z, 0xffb02e, 1.6, 0.2);
        this.sparks(x, 0.2, z, 0xff8a2a, 16 * s, 3, 0.6);
        this.puff(x, 0.2, z, 4, 0.8);
        break;
      case 'empMine':
        this.flash(x, 0.25, z, 0x9fb8ff, 1.4 * r + 0.4, 0.2);
        this.ring(x, z, 0x7f9dff, 0.2, r * 2.2, 0.45, 1);
        this.bolts.push({ pts: [x, 0.1, z, x + (Math.random() - 0.5) * r * 2, 0.1, z + (Math.random() - 0.5) * r * 2], t: 0, emp: true });
        this.sparks(x, 0.2, z, 0xb0c8ff, 12 * s, 4, 0.5);
        break;
      case 'bomblet':
        this.flash(x, 0.2, z, 0xffa040, 0.8, 0.12);
        this.sparks(x, 0.2, z, 0xffb060, 5 * s, 3, 0.4);
        this.ring(x, z, 0xff8a2a, 0.1, 1.2, 0.3, 1);
        break;
      case 'missile':
      default:
        this.flash(x, y, z, 0xffe070, 1.1 * r + 0.4, 0.15);
        this.sparks(x, y, z, 0xffd060, 10 * s, 3.5, 0.45);
        this.puff(x, y, z, 3, 0.6);
        if (y < 0.6) this.ring(x, z, 0xffd23d, 0.1, r * 2, 0.35, 1);
        break;
    }
  }

  death(e) {
    const s = this.fxScale;
    const big = e.boss ? 3 : Math.max(0.6, e.def.radius / 0.3);
    const col = DEATH_COLOR[e.type] || 0xff6a3a;
    const y = e.air ? e.y : 0.3;
    this.flash(e.x, y, e.z, col, 0.9 * big, 0.18);
    this.flash(e.x, y, e.z, 0xffffff, 0.45 * big, 0.08);
    this.sparks(e.x, y, e.z, col, (8 + 6 * big) * s, 3 + big, 0.6);
    for (let i = 0; i < 4 * big * s; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2.5;
      this.smoke.spawn(e.x, y, e.z, Math.cos(a) * sp, 2 + Math.random() * 2.5, Math.sin(a) * sp, 0.7, 0.07, 0.05, 0.08, 0.08, 0.1, 1, 0.5, 9);
    }
    this.puff(e.x, y, e.z, 2 + big, 0.5 * big);
    if (!e.air) this.decals.add({ x: e.x, z: e.z, shape: 0, size0: 0.5 * big, size1: 0.7 * big, r: 0.25, g: 0.08, b: 0.04, a: 0.8, life: 1.5 });
    this.ring(e.x, e.z, col, 0.1, 1.1 * big, 0.4, 1);
    if (e.boss) { this.rig.shake(0.35); this.ring(e.x, e.z, 0xffffff, 0.3, 6, 1, 1); this.flash(e.x, y + 0.5, e.z, 0xffffff, 5, 0.5); }
  }

  // ---------------------------------------------------------------- fx primitives
  flash(x, y, z, color, size, life) {
    hex(color);
    this.parts.spawn(x, y, z, 0, 0, 0, life, size, size * 1.3, _c.r * 2.2, _c.g * 2.2, _c.b * 2.2, 1);
  }

  sparks(x, y, z, color, n, speed, life) {
    hex(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, sp = speed * (0.4 + Math.random() * 0.8);
      const k = Math.sqrt(1 - u * u);
      this.parts.spawn(x, y, z, Math.cos(a) * k * sp, Math.abs(u) * sp * 0.8 + 0.5, Math.sin(a) * k * sp, life * (0.5 + Math.random() * 0.6), 0.05, 0.02, _c.r * 2.5, _c.g * 2.5, _c.b * 2.5, 1, 2.5, 5, 0.05);
    }
  }

  burst(x, y, z, color, n, speed, life, size, grav) {
    hex(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = speed * (0.5 + Math.random() * 0.6);
      this.parts.spawn(x, y, z, Math.cos(a) * sp, 1 + Math.random() * 2, Math.sin(a) * sp, life, size, size * 0.3, _c.r * 2, _c.g * 2, _c.b * 2, 1, 2, grav);
    }
  }

  ring(x, z, color, s0, s1, life, shape = 1) {
    hex(color);
    this.decals.add({ x, z, y: 0.03, shape, thick: 0.18, size0: s0, size1: s1, r: _c.r * 2, g: _c.g * 2, b: _c.b * 2, a: 1, life });
  }

  puff(x, y, z, n, size) {
    for (let i = 0; i < n; i++) {
      const g = 0.05 + Math.random() * 0.05;
      this.smoke.spawn(x + (Math.random() - 0.5) * size * 0.4, y, z + (Math.random() - 0.5) * size * 0.4, (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.6, size * 0.5, size * 1.2, g, g, g * 1.4, 0.55, 1.2, -0.1);
    }
  }

  // ---------------------------------------------------------------- per-frame
  frame(dt, rdt) {
    this.time += rdt;
    const t = this.time;
    const fx = this.fxScale;
    const srcs = this.sources;
    for (const src of srcs) {
      for (const ev of src.events) this.handle(ev, src);
      src.events.length = 0;
    }
    const all = (k) => (srcs.length === 1 ? srcs[0][k] : srcs.flatMap((src) => src[k]));
    const towers = all('towers'), enemies = all('enemies');

    this.world.update(t, rdt);
    for (const src of srcs) this.world.setDanger(src.lives / src.maxLives < 0.35 ? 1 : 0, src.side || 0);
    this.towers.update(towers, rdt, t);
    this.enemies.update(enemies, rdt, t);
    this.units.update(srcs.length === 1 ? srcs[0] : { drones: all('drones'), mines: all('mines') }, rdt, t);
    this.range.material.uniforms.uTime.value = t;

    // projectiles
    for (const p of all('projectiles')) {
      if (p.kind === 'bullet') {
        hex(TOWERS[p.tower.type].color);
        const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        this.parts.sprite(p.x, p.y, p.z, dx / d * 2, dy / d * 2, dz / d * 2, 0.11, 0.08, _c.r * 3, _c.g * 3, _c.b * 3, 1);
      } else if (p.kind === 'frost') {
        const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        this.parts.sprite(p.x, p.y, p.z, dx / d, dy / d, dz / d, 0.15, 0.1, 1.2, 2.6, 3.2, 1);
        if (Math.random() < 0.5 * fx) this.parts.spawn(p.x, p.y, p.z, 0, 0, 0, 0.25, 0.08, 0.02, 0.6, 1.6, 2.2, 0.8);
      } else if (p.kind === 'shell' || p.kind === 'bomblet' || p.kind === 'napalm') {
        const big = p.kind !== 'bomblet';
        const well = p.s && p.s.well;
        const nap = p.kind === 'napalm';
        this.parts.sprite(p.x, p.y, p.z, 0, 0, 0, big ? 0.24 : 0.14, 0, well ? 1.6 : 3, well ? 0.8 : nap ? 1.8 : 1.4, well ? 3.2 : 0.2, 1);
        if (Math.random() < 0.8 * fx) this.parts.spawn(p.x, p.y, p.z, 0, 0, 0, 0.3, big ? 0.14 : 0.08, 0.02, well ? 1 : 2, well ? 0.4 : 0.8, well ? 2 : 0.2, 0.8);
      } else if (p.kind === 'missile' && !(p.delay > 0)) {
        const nuke = p.nuke;
        this.parts.sprite(p.x, p.y, p.z, p.vx * 0.05, p.vy * 0.05, p.vz * 0.05, nuke ? 0.22 : 0.1, 0.12, 3, nuke ? 1.2 : 2.6, nuke ? 0.6 : 1.4, 1);
        if (Math.random() < 0.9 * fx) this.parts.spawn(p.x, p.y, p.z, -p.vx * 0.1, -p.vy * 0.1, -p.vz * 0.1, 0.25, nuke ? 0.18 : 0.09, 0.03, 2.6, 1.2, 0.3, 0.9);
        if (Math.random() < 0.35 * fx) this.smoke.spawn(p.x, p.y, p.z, 0, 0.2, 0, 0.6, 0.06, 0.2, 0.08, 0.08, 0.1, 0.45, 1, -0.2);
      }
    }

    // beams: lasers, rails, tesla bolts, amp links
    const B = this.beams;
    B.begin();
    for (const tw of towers) {
      if (tw.beams && tw.beams.length) {
        const m = this.towers.muzzle(tw, _v);
        const ann = tw.spec === 'b';
        for (const b of tw.beams) {
          const f = Math.min(1, b.time / tw.stats.ramp);
          const e = b.e;
          const w = (ann ? 0.07 : 0.045) + f * (ann ? 0.16 : 0.08) + (tw.level >= 5 ? 0.03 : 0);
          const flick = 0.85 + Math.random() * 0.3;
          let ex = e.x, ey = e.h, ez = e.z;
          if (tw.stats.lance) { const dx = e.x - tw.x, dz = e.z - tw.z, l = Math.hypot(dx, dz) || 1; ex = tw.x + (dx / l) * tw.stats.range; ez = tw.z + (dz / l) * tw.stats.range; ey = 0.4; }
          B.line(m.x, m.y, m.z, ex, ey, ez, w * flick, 2.2, 0.35 + f * 0.4, 0.9, 1, 0.6 + f * 0.8);
          if (Math.random() < 0.5 * fx) this.parts.spawn(e.x, e.h, e.z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, 0.2, 0.05, 0.01, 3, 0.6, 1.2, 1, 3, 4, 0.05);
          this.parts.sprite(e.x, e.h, e.z, 0, 0, 0, 0.25 + f * 0.35, 0, 2.5, 0.5 + f, 1.2, 0.8);
          this.parts.sprite(m.x, m.y, m.z, 0, 0, 0, 0.2 + f * 0.2, 0, 2.5, 0.8, 1.4, 0.9);
        }
      }
      if (tw.buffBy && this.selectedId && (this.selectedId === tw.id || this.selectedId === tw.buffBy)) {
        const amp = tw.buffAmp;
        if (amp) B.line(amp.x, 0.8, amp.z, tw.x, 0.5, tw.z, 0.04, 0.3, 1.6, 0.9, 0.5 + 0.3 * Math.sin(t * 6), 0.3);
      }
    }
    for (let i = this.rails.length - 1; i >= 0; i--) {
      const r = this.rails[i];
      const life = r.life || 0.28;
      r.t += rdt;
      if (r.t >= life) { this.rails.splice(i, 1); continue; }
      const u = 1 - r.t / life;
      hex(r.color || 0x7ff4ff);
      B.line(r.x1, r.y1, r.z1, r.x2, r.y2, r.z2, (r.w || 0.14) * (0.4 + u), _c.r * 2, _c.g * 2, _c.b * 2, u, 1);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += rdt;
      if (b.t < 0) continue; // staggered start
      const life = b.thunder ? 0.42 : b.storm ? 0.3 : 0.18;
      if (b.t >= life) { this.bolts.splice(i, 1); continue; }
      const a = 1 - b.t / life;
      if (b.thunder) lightning(B, b.pts, b.boss ? 0.2 : 0.13, 2.8, 2.5, 1.1, a, 0.35, 7);
      else if (b.emp) lightning(B, b.pts, 0.06, 0.6, 1.8, 2.4, a, 0.14, 5);
      else lightning(B, b.pts, b.storm ? 0.1 : 0.06, 1.5, 0.7, 2.6, a, b.storm ? 0.3 : 0.14, 5);
      lightning(B, b.pts, 0.02, 2, 2, 2, a * 0.8, 0.1, 4);
    }

    // gravity wells
    const wells = all('wells'), zones = all('zones');
    for (const w of wells) {
      let d = this.wellDecals.get(w);
      if (!d) {
        d = this.decals.add({ x: w.x, z: w.z, shape: 2, thick: 0.25, size0: w.r * 2, size1: w.r * 1.6, r: 1.2, g: 0.5, b: 2.4, a: 1, life: w.max, spin: w.pull ? -5 : 3, ease: 0 });
        this.wellDecals.set(w, d);
        this.decals.add({ x: w.x, z: w.z, shape: 0, size0: w.r * 3.2, size1: w.r * 2.4, r: 0.6, g: 0.2, b: 1.2, a: 1, life: w.max, ease: 0 });
      }
      if (Math.random() < 0.9 * fx) {
        const a = Math.random() * Math.PI * 2, rr = w.r;
        this.parts.spawn(w.x + Math.cos(a) * rr, 0.15, w.z + Math.sin(a) * rr, -Math.cos(a) * rr * 2.4 + Math.sin(a) * 1.5, 0.3, -Math.sin(a) * rr * 2.4 - Math.cos(a) * 1.5, 0.4, 0.08, 0.02, 1.4, 0.6, 2.8, 1, 0, 0, 0.05);
      }
    }
    if (this.wellDecals.size > wells.length) for (const k of this.wellDecals.keys()) if (!wells.includes(k)) this.wellDecals.delete(k);
    // zones: napalm fire, radiation
    for (const z of zones) {
      let d = this.zoneDecals.get(z);
      if (!d) {
        if (z.kind === 'fire') d = this.decals.add({ x: z.x, z: z.z, shape: 0, size0: z.r * 2.2, size1: z.r * 2, r: 1.6, g: 0.5, b: 0.08, a: 1, life: z.max, ease: 0 });
        else d = this.decals.add({ x: z.x, z: z.z, shape: 2, thick: 0.2, size0: z.r * 2, size1: z.r * 2, r: 1.2, g: 1.6, b: 0.2, a: 0.8, life: z.max, spin: 0.5, pulse: 8, ease: 0 });
        this.zoneDecals.set(z, d);
      }
      const n = z.kind === 'fire' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        if (Math.random() > 0.8 * fx) continue;
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * z.r;
        const x = z.x + Math.cos(a) * rr, zz = z.z + Math.sin(a) * rr;
        if (z.kind === 'fire') this.parts.spawn(x, 0.05, zz, 0, 0.8 + Math.random(), 0, 0.5, 0.14, 0.03, 2.6, 0.8 + Math.random() * 0.5, 0.15, 1, 0.5, -0.5);
        else this.parts.spawn(x, 0.05, zz, 0, 0.6, 0, 0.6, 0.08, 0.02, 1.2, 2, 0.3, 1, 0.5, -0.2);
      }
    }
    if (this.zoneDecals.size > zones.length) for (const k of this.zoneDecals.keys()) if (!zones.includes(k)) this.zoneDecals.delete(k);

    // per-tower continuous effects
    for (const tw of towers) {
      if (tw.flameOn) {
        const m = this.towers.muzzle(tw, _v);
        const s = tw.stats;
        const plasma = tw.spec === 'a';
        const n = Math.ceil(3 * fx);
        for (let i = 0; i < n; i++) {
          const spread = ((Math.random() - 0.5) * s.cone * Math.PI) / 180;
          const a = tw.aim + spread;
          const sp = s.range * (2.6 + Math.random() * 1.2);
          this.parts.spawn(m.x, m.y - 0.05, m.z, Math.sin(a) * sp, (Math.random() - 0.2) * 0.8, Math.cos(a) * sp, 0.3 + Math.random() * 0.12, 0.08, plasma ? 0.28 : 0.4,
            plasma ? 0.9 : 2.8, plasma ? 1.8 : 0.9 + Math.random() * 0.5, plasma ? 3 : 0.15, 1, 2.2, -1.2);
        }
        if (Math.random() < 0.3 * fx) this.smoke.spawn(m.x + Math.sin(tw.aim) * s.range * 0.8, 0.3, m.z + Math.cos(tw.aim) * s.range * 0.8, 0, 0.6, 0, 0.8, 0.2, 0.5, 0.06, 0.05, 0.05, 0.4, 1, -0.3);
      }
      if (tw.disabledT > 0 && Math.random() < 0.35 * fx) this.sparks(tw.x + (Math.random() - 0.5) * 0.5, 0.6 + Math.random() * 0.4, tw.z + (Math.random() - 0.5) * 0.5, 0x9fd8ff, 2, 2, 0.3);
      if (tw.auraActive && tw.stats.attack === 'aura' && Math.random() < 0.6 * fx) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * tw.stats.range;
        this.parts.spawn(tw.x + Math.cos(a) * rr, 0.05, tw.z + Math.sin(a) * rr, 0, 0.5, 0, 0.8, 0.07, 0.02, 0.8, 1.8, 2.4, 0.8);
      }
      // veterancy stars
      for (let k = 0; k < tw.rank; k++) this.parts.sprite(tw.x + (k - (tw.rank - 1) / 2) * 0.16, 1.45, tw.z, 0, 0, 0, 0.1, 0, 3, 2.3, 0.6, 0.9);
      // power node pulse under towers
    }
    // enemy statuses: burning, marked
    for (const e of enemies) {
      if (e.inWarp) continue;
      if (e.burnT > 0 && Math.random() < 0.5 * fx * e.burnStacks) this.parts.spawn(e.x + (Math.random() - 0.5) * 0.25, 0.2 + Math.random() * 0.3, e.z + (Math.random() - 0.5) * 0.25, 0, 0.9, 0, 0.35, 0.1, 0.03, 2.8, 1, 0.2, 1, 1, -0.6);
      if (e.markAmt > 0 && e.detected !== false) {
        const y = (e.air ? e.y : 0.3) + (e.boss ? 1.9 : 0.75);
        this.parts.sprite(e.x, y, e.z, 0, 0, 0, 0.12, 0, 3, 0.4, 0.6, 0.9);
      }
    }
    B.end();

    this.parts.update(rdt);
    this.smoke.update(rdt);
    this.parts.flush();
    this.smoke.flush();
    this.decals.update(rdt, t);
    this.rig.update(rdt);
    this.renderer.render();
  }

  dispose() {
    this.world.dispose();
    this.units.dispose();
    for (const sys of [this.parts, this.smoke, this.decals, this.beams]) { sys.geo.dispose(); sys.mat.dispose(); }
    this.range.geometry.dispose();
    this.range.material.dispose();
    this.scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
}
