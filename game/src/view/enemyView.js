// Enemies rendered with one InstancedMesh per model part, plus instanced billboard health bars.
import * as THREE from 'three';
import { enemyModel } from './models.js';
import { GROUND_Y } from './world.js';

const BAR_Y = {
  scout: 0.25, mini: 0.22, walker: 0.8, flyer: 0.3, shield: 0.48, stalker: 0.5, medic: 0.26, splitter: 0.36, tank: 0.5, colossus: 1.7, mothership: 0.55,
  phantom: 0.85, mirror: 0.28, juggernaut: 0.65, disruptor: 0.42, regenerator: 0.6, berserker: 0.75, hive: 0.28, swarmling: 0.1,
  dreadnought: 1.6, queen: 0.35, omega: 2.55, omega2: 0.95,
};

const _m = new THREE.Matrix4(), _b = new THREE.Matrix4(), _l = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _c = new THREE.Color();

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class EnemyView {
  constructor(scene) {
    this.scene = scene;
    this.kinds = new Map();
    this.metal = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.4, flatShading: true, envMapIntensity: 1.1 });
    this.glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(3.6, 3.6, 3.6) });
    this.shield = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(0.8, 0.8, 0.8) });
    this.shield.onBeforeCompile = (sh) => {
      // fresnel rim so the bubble reads as a sphere
      sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n vNrm = normalize(normalMatrix * mat3(instanceMatrix) * normal); vView = normalize(-mvPosition.xyz);')
        .replace('void main() {', 'varying vec3 vNrm; varying vec3 vView;\nvoid main() {');
      sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying vec3 vNrm; varying vec3 vView;\nvoid main() {')
        .replace('#include <opaque_fragment>', 'float fr = pow(clamp(1.0 - abs(dot(normalize(vNrm), normalize(vView))), 0.0, 1.0), 2.0); outgoingLight *= 0.15 + fr * 1.6;\n#include <opaque_fragment>');
    };
    this.cap = 0;
    // health bars
    this.barCap = 256;
    const bg = new THREE.PlaneGeometry(0.46, 0.065);
    this.barAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.barCap * 4), 4);
    this.barAttr.setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('aHp', this.barAttr);
    this.bars = new THREE.InstancedMesh(bg, new THREE.ShaderMaterial({
      vertexShader: `attribute vec4 aHp; varying vec2 vUv; varying vec4 vHp;
        void main(){ vUv = uv; vHp = aHp;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * vec2(aHp.z, aHp.z > 1.5 ? 1.6 : 1.0);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec2 vUv; varying vec4 vHp;
        void main(){
          float x = vUv.x; vec3 c = vec3(0.04, 0.04, 0.07);
          if (x < vHp.x) c = mix(vec3(1.0, 0.15, 0.2), mix(vec3(1.0, 0.8, 0.2), vec3(0.3, 1.0, 0.45), smoothstep(0.5, 0.9, vHp.x)), smoothstep(0.1, 0.5, vHp.x)) * 1.6;
          if (vUv.y > 0.5 && x < vHp.y) c = vec3(0.45, 0.75, 1.8);
          float border = step(vUv.y, 0.14) + step(0.86, vUv.y) + step(x, 0.015) + step(0.985, x);
          c = mix(c, vec3(0.0), min(1.0, border));
          gl_FragColor = vec4(c, vHp.w); }`,
      transparent: true, depthTest: false, depthWrite: false,
    }), this.barCap);
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 20;
    this.bars.count = 0;
    scene.add(this.bars);
  }

  kind(type) {
    let k = this.kinds.get(type);
    if (!k) {
      const model = enemyModel(type);
      k = { model, meshes: [], cap: 0 };
      this.kinds.set(type, k);
      this.grow(k, 16);
    }
    return k;
  }

  grow(k, cap) {
    for (const m of k.meshes) { this.scene.remove(m); m.dispose(); }
    k.meshes = k.model.parts.map((p) => {
      const mat = p.mat === 'metal' ? this.metal : p.mat === 'glow' ? this.glow : this.shield;
      const im = new THREE.InstancedMesh(p.geo, mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, _c.setRGB(1, 1, 1));
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = p.mat === 'metal';
      im.frustumCulled = false;
      im.count = 0;
      if (p.mat === 'shield') im.renderOrder = 8;
      this.scene.add(im);
      return im;
    });
    k.cap = cap;
  }

  update(enemies, dt, time) {
    for (const k of this.kinds.values()) k.n = 0;
    let nb = 0;
    const bars = this.barAttr.array;
    for (const e of enemies) {
      const k = this.kind(e.type);
      if (k.n >= k.cap) this.grow(k, k.cap * 2);
      const i = k.n++;
      const md = k.model;
      // view-only state
      if (e._age === undefined) { e._age = 0; e._yaw = Math.atan2(e.dirX, e.dirZ); e._walk = Math.random() * 6; e._bank = 0; }
      e._age += dt;
      const ty = Math.atan2(e.dirX, e.dirZ);
      const prevYaw = e._yaw;
      e._yaw = angleLerp(e._yaw, ty, 1 - Math.exp(-dt * 9));
      e._walk += dt * (md.walk || 6) * Math.min(1.6, e.curSpeed + 0.05);
      if (md.bank) e._bank += (THREE.MathUtils.clamp((e._yaw - prevYaw) / Math.max(dt, 1e-3) * -0.35, -0.6, 0.6) - e._bank) * Math.min(1, dt * 6);
      const spawnS = Math.min(1, e._age / 0.35);
      const sc = md.scale * (0.3 + 0.7 * spawnS) * (e.frozen ? 0.96 : 1);
      const bob = (md.hover ? Math.sin(time * 3 + e.phase) * 0.04 : 0) + (md.walk && e.curSpeed > 0.01 ? Math.abs(Math.sin(e._walk)) * 0.025 : 0);
      const y = (e.air ? e.y : GROUND_Y + md.hover) + bob;
      _p.set(e.x, y, e.z);
      _e.set(0, e._yaw, e._bank);
      _q.setFromEuler(_e);
      _s.set(sc, sc, sc);
      _b.compose(_p, _q, _s);
      // tint: hit flash / frozen / slowed
      const hit = e.hitT > 0 ? 1 : 0;
      let mr = 1, mg = 1, mb = 1;
      if (e.frozen) { mr = 0.55; mg = 0.95; mb = 1.6; }
      else if (e.stunTime > 0) { mr = 1.2; mg = 1.2; mb = 1.6; }
      else if (e.slowAmt > 0) { mr = 0.75; mg = 0.95; mb = 1.3; }
      if (e.burnT > 0) { mr *= 1.5; mg *= 0.9; mb *= 0.6; }
      if (hit) { mr += 1.2; mg += 1.2; mb += 1.2; }
      // cloaked & undetected: a faint shimmering silhouette; tunnelling units are invisible
      const cloaked = (e.def.cloak || e.cloakT > 0) && !e.detected;
      const hidden = e.inWarp;
      const ghost = cloaked ? 0.12 + 0.08 * Math.sin(time * 9 + e.phase) : 1;
      if (cloaked) { mr = mg = mb = ghost; }
      const rage = e.def.berserk ? 1 + (1 - e.hp / e.maxHp) * 1.5 : 1;
      for (let p = 0; p < md.parts.length; p++) {
        const part = md.parts[p];
        const im = k.meshes[p];
        const pv = part.pivot;
        const an = part.anim;
        if (an === 'legL' || an === 'legR') {
          const a = Math.sin(e._walk) * 0.55 * (an === 'legL' ? 1 : -1);
          _l.makeRotationX(a).setPosition(pv[0], pv[1], pv[2]);
          _m.multiplyMatrices(_b, _l);
        } else if (an === 'spinY' || an === 'spinX' || an === 'spinZ') {
          const a = time * 3 + e.phase;
          if (an === 'spinY') _l.makeRotationY(a); else if (an === 'spinX') _l.makeRotationX(a); else _l.makeRotationZ(a);
          _l.setPosition(pv[0], pv[1], pv[2]);
          _m.multiplyMatrices(_b, _l);
        } else if (an === 'flapL' || an === 'flapR') {
          // big wings beat slower and shallower than a swarmling's
          const a = Math.sin(time * (e.boss ? 6 : 18) + e.phase) * (e.boss ? 0.32 : 0.6) * (an === 'flapL' ? 1 : -1);
          _l.makeRotationZ(a).setPosition(pv[0], pv[1], pv[2]);
          _m.multiplyMatrices(_b, _l);
        } else if (an === 'pulse') {
          const k2 = 1 + Math.sin(time * 5 + e.phase) * 0.12;
          _l.makeScale(k2, k2, k2).setPosition(pv[0], pv[1], pv[2]);
          _m.multiplyMatrices(_b, _l);
        } else if (pv[0] || pv[1] || pv[2]) {
          _l.makeTranslation(pv[0], pv[1], pv[2]);
          _m.multiplyMatrices(_b, _l);
        } else _m.copy(_b);
        if (hidden) _m.makeScale(0, 0, 0);
        im.setMatrixAt(i, _m);
        if (part.mat === 'shield') {
          const f = e.maxShield > 0 ? e.shield / e.maxShield : 0;
          const flick = e.empTime > 0 ? 0.3 + Math.random() * 0.3 : 1;
          _c.setRGB(0.35 * f * flick * (1 + hit), 0.6 * f * flick * (1 + hit), 1.2 * f * flick * (1 + hit));
        } else if (part.mat === 'glow') {
          const pulse = (e.boss ? 1 + 0.25 * Math.sin(time * 5) : 1) * (cloaked ? ghost * 1.6 : 1);
          const h2 = hit ? 2 : 1;
          _c.setRGB(pulse * h2 * (e.frozen ? 0.6 : rage), pulse * h2 * (e.frozen ? 1.2 : 1 / rage), pulse * h2 * (e.frozen ? 1.8 : 1 / rage));
        } else _c.setRGB(mr, mg, mb);
        im.setColorAt(i, _c);
      }
      // health bar
      const showBar = !cloaked && !hidden && (e.boss || e.hp < e.maxHp - 0.01 || (e.maxShield > 0 && e.shield < e.maxShield - 0.01));
      if (showBar && nb < this.barCap) {
        const by = y + (BAR_Y[e.type] || 0.7) * sc;
        _m.makeTranslation(e.x, by, e.z);
        this.bars.setMatrixAt(nb, _m);
        bars[nb * 4] = Math.max(0, e.hp / e.maxHp);
        bars[nb * 4 + 1] = e.maxShield > 0 ? e.shield / e.maxShield : 0;
        bars[nb * 4 + 2] = e.boss ? 3 : 1;
        bars[nb * 4 + 3] = 0.95;
        nb++;
      }
    }
    for (const k of this.kinds.values()) {
      for (const im of k.meshes) {
        im.count = k.n;
        if (k.n) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
      }
    }
    this.bars.count = nb;
    if (nb) { this.bars.instanceMatrix.needsUpdate = true; this.barAttr.needsUpdate = true; }
  }

  clear() {
    for (const k of this.kinds.values()) for (const im of k.meshes) im.count = 0;
    this.bars.count = 0;
  }
}
