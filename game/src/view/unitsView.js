// Carrier drones and mine-layer mines, one InstancedMesh per kind.
import * as THREE from 'three';
import * as Models from './models.js';
import { emissiveVertexMat } from './materials.js';
import { GeoBuilder, box, cyl } from './geo.js';
import { GROUND_Y } from './world.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

function withGlow(metal, glow) {
  const tag = (g, v) => { g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1)); return g; };
  const B = new GeoBuilder();
  B.addRaw(tag(metal, 0));
  B.addRaw(tag(glow, 1));
  return B.build();
}

// Fallbacks used until/unless models.js provides dedicated drone/mine models.
function fallbackDrone(kind) {
  const s = kind === 'gunship' ? 1.6 : kind === 'swarm' ? 0.7 : 1;
  const m = new GeoBuilder().add(box(0.12 * s, 0.05 * s, 0.18 * s), 0x3a4460).add(box(0.26 * s, 0.015 * s, 0.06 * s), 0x505b78).build();
  const g = new GeoBuilder().add(box(0.05 * s, 0.03 * s, 0.02 * s), 0x3dffea, [0, 0, -0.1 * s]).build();
  return withGlow(m, g);
}

function fallbackMine(kind) {
  const col = kind === 'emp' ? 0x7f9dff : kind === 'cluster' ? 0xff8a3d : 0xffe03d;
  const m = new GeoBuilder().add(cyl(0.1, 0.11, 0.05, 10), 0x2a3042, [0, 0.025, 0]).build();
  const g = new GeoBuilder().add(cyl(0.035, 0.035, 0.02, 8), col, [0, 0.055, 0]).build();
  return withGlow(m, g);
}

export class UnitsView {
  constructor(scene) {
    this.scene = scene;
    this.mat = emissiveVertexMat(2.1);
    this.drones = new Map();
    this.mines = new Map();
  }

  pool(map, kind, makeGeo) {
    let p = map.get(kind);
    if (!p) {
      const im = new THREE.InstancedMesh(makeGeo(kind), this.mat, 32);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      im.count = 0;
      this.scene.add(im);
      p = { im, n: 0, cap: 32 };
      map.set(kind, p);
    }
    return p;
  }

  grow(map, kind) {
    const old = map.get(kind);
    const cap = old.cap * 2;
    const im = new THREE.InstancedMesh(old.im.geometry, this.mat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = true;
    im.count = 0;
    im.instanceMatrix.array.set(old.im.instanceMatrix.array);
    this.scene.remove(old.im);
    old.im.dispose();
    this.scene.add(im);
    const p = { im, n: old.n, cap };
    map.set(kind, p);
    return p;
  }

  droneGeo(kind) { return Models.droneModel ? Models.droneModel(kind).geo : fallbackDrone(kind); }
  mineGeo(kind) { return Models.mineModel ? Models.mineModel(kind).geo : fallbackMine(kind); }

  update(game, dt, time) {
    for (const p of this.drones.values()) p.n = 0;
    for (const p of this.mines.values()) p.n = 0;
    for (const d of game.drones) {
      let p = this.pool(this.drones, d.kind, (k) => this.droneGeo(k));
      if (p.n >= p.cap) p = this.grow(this.drones, d.kind);
      if (d._yaw === undefined) d._yaw = d.aim;
      const want = Math.hypot(d.vx, d.vz) > 0.4 && !d.target ? Math.atan2(d.vx, d.vz) : d.aim;
      let dy = ((want - d._yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (dy < -Math.PI) dy += Math.PI * 2;
      d._yaw += dy * Math.min(1, dt * 8);
      _p.set(d.x, d.y, d.z);
      _e.set(0, d._yaw, -dy * 0.4);
      _q.setFromEuler(_e);
      _s.setScalar(1.15);
      _m.compose(_p, _q, _s);
      p.im.setMatrixAt(p.n++, _m);
    }
    for (const m of game.mines) {
      let p = this.pool(this.mines, m.kind, (k) => this.mineGeo(k));
      if (p.n >= p.cap) p = this.grow(this.mines, m.kind);
      const arm = m.armT > 0 ? 0.6 + 0.4 * (1 - m.armT / 0.8) : 1;
      _p.set(m.x, GROUND_Y + 0.005, m.z);
      _q.setFromAxisAngle(UP, (m.id % 7) * 0.9 + time * 0.5);
      _s.setScalar(arm * 1.2);
      _m.compose(_p, _q, _s);
      p.im.setMatrixAt(p.n++, _m);
    }
    for (const map of [this.drones, this.mines]) {
      for (const p of map.values()) {
        p.im.count = p.n;
        if (p.n) p.im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const map of [this.drones, this.mines]) for (const p of map.values()) { this.scene.remove(p.im); p.im.dispose(); }
  }
}
