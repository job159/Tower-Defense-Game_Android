// Tower meshes: base + yawing head (+ optional spinning part), recoil and idle animation.
import * as THREE from 'three';
import { towerModel } from './models.js';
import { emissiveVertexMat } from './materials.js';

const _v = new THREE.Vector3();

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class TowerView {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map();
    this.mat = emissiveVertexMat(2.1);
    this.offMat = emissiveVertexMat(0.15);
    this.ghostMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x22e6ff).multiplyScalar(0.9), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3050).multiplyScalar(0.9), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  // Build the object hierarchy for a tower config. ghost=true -> translucent preview materials.
  // Each part (base / head / spinner) is a single mesh: metal and neon share one material.
  build(type, level, spec, ghost = false, bad = false) {
    const md = towerModel(type, level, spec);
    const mat = ghost ? (bad ? this.ghostBad : this.ghostMat) : this.mat;
    const root = new THREE.Group();
    const mesh = (g, parent) => {
      if (!g) return null;
      const o = new THREE.Mesh(g, mat);
      o.castShadow = !ghost;
      parent.add(o);
      return o;
    };
    mesh(md.base.geo, root);
    const head = new THREE.Group();
    head.position.y = md.head.y;
    root.add(head);
    const recoil = new THREE.Group();
    head.add(recoil);
    mesh(md.head.geo, recoil);
    let spin = null;
    if (md.spin) {
      spin = new THREE.Group();
      spin.position.fromArray(md.spin.pos);
      recoil.add(spin);
      mesh(md.spin.geo, spin);
    }
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    return { root, head, recoil, spin, md, meshes, off: false };
  }

  add(t) {
    const it = this.build(t.type, t.level, t.spec);
    it.root.position.set(t.x, 0, t.z);
    it.root.scale.setScalar(TOWER_SCALE);
    it.head.rotation.y = t.aim;
    it.kick = 0;
    it.spinV = 0;
    it.pop = 0;
    this.scene.add(it.root);
    this.items.set(t.id, it);
    return it;
  }

  rebuild(t) {
    const old = this.items.get(t.id);
    const yaw = old ? old.head.rotation.y : t.aim;
    if (old) this.scene.remove(old.root);
    const it = this.add(t);
    it.head.rotation.y = yaw;
    it.pop = 1;
  }

  remove(t) {
    const it = this.items.get(t.id);
    if (it) { this.scene.remove(it.root); this.items.delete(t.id); }
  }

  clear() {
    for (const it of this.items.values()) this.scene.remove(it.root);
    this.items.clear();
  }

  fired(t) {
    const it = this.items.get(t.id);
    if (!it) return;
    it.kick = 1;
    it.spinV = Math.min(40, it.spinV + 12);
  }

  // World-space muzzle position of a tower.
  muzzle(t, out = new THREE.Vector3()) {
    const it = this.items.get(t.id);
    if (!it) return out.set(t.x, 0.8, t.z);
    it.recoil.updateWorldMatrix(true, false);
    return out.fromArray(it.md.head.muzzle).applyMatrix4(it.recoil.matrixWorld);
  }

  update(towers, dt, time) {
    for (const t of towers) {
      const it = this.items.get(t.id);
      if (!it) continue;
      // EMP'd towers go dark
      const off = t.disabledT > 0;
      if (off !== it.off) { it.off = off; for (const m of it.meshes) m.material = off ? this.offMat : this.mat; }
      if (off) continue;
      if (it.md.head.aims) it.head.rotation.y = angleLerp(it.head.rotation.y, t.aim, 1 - Math.exp(-dt * 14));
      else it.head.rotation.y += dt * 0.25;
      it.kick = Math.max(0, it.kick - dt * 7);
      it.recoil.position.z = -it.kick * 0.07;
      if (it.spin) {
        const sp = it.md.spin;
        if (sp.axis === 'z') {
          it.spinV = Math.max(0, it.spinV - dt * 20);
          it.spin.rotation.z += it.spinV * dt;
        } else it.spin.rotation.y += sp.speed * dt;
      }
      if (it.pop > 0) {
        it.pop = Math.max(0, it.pop - dt * 3);
        const s = 1 + Math.sin(it.pop * Math.PI) * 0.18;
        it.root.scale.set(s * TOWER_SCALE, (1 + (s - 1) * 1.5) * TOWER_SCALE, s * TOWER_SCALE);
      }
    }
  }
}

export const TOWER_SCALE = 1.2;

// Hologram-style range indicator ring on the ground.
export function makeRangeRing() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x22e6ff) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main(){ vec2 p = (vUv - 0.5) * 2.0; float r = length(p); if (r > 1.0) discard;
        float edge = smoothstep(0.955, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r));
        float ang = atan(p.y, p.x);
        float dash = step(0.35, fract(ang * 12.0 / 6.28318 + uTime * 0.15));
        float fill = 0.06 + 0.05 * smoothstep(0.4, 1.0, r);
        float sweep = pow(fract((ang / 6.28318) - uTime * 0.25), 6.0) * 0.18 * step(0.1, r);
        gl_FragColor = vec4(uColor * (edge * (0.6 + 0.9 * dash) * 2.0 + fill + sweep), 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.03;
  m.renderOrder = 6;
  m.visible = false;
  return m;
}
