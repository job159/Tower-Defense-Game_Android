// Instanced effects: billboard particles, ground decals and energy beams — one draw call per system.
import * as THREE from 'three';

const QUAD = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QIDX = [0, 1, 2, 0, 2, 3];

function instGeo(attrs, max) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(QUV, 2));
  g.setIndex(QIDX);
  const out = {};
  for (const [name, size] of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(max * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    out[name] = a;
  }
  g.instanceCount = 0;
  return [g, out];
}

// ------------------------------------------------------------------ particles
export class Particles {
  constructor(scene, max = 2500, mode = 'add') {
    this.max = max;
    this.n = 0;
    // SoA state
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 4);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.stretch = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const [g, a] = instGeo([['iPos', 3], ['iVel', 3], ['iCol', 4], ['iSize', 2]], max + 600);
    this.geo = g;
    this.attr = a;
    this.cap = max + 600;
    const additive = mode === 'add';
    this.mat = new THREE.ShaderMaterial({
      vertexShader: `attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec2 iSize;
        varying vec2 vUv; varying vec4 vCol;
        void main(){
          vUv = uv; vCol = iCol;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec2 q = position.xy; float s = iSize.x;
          if (iSize.y > 0.0) {
            vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
            float len = length(vv.xy);
            vec2 d = len > 1e-4 ? vv.xy / len : vec2(0.0, 1.0);
            vec2 n = vec2(-d.y, d.x);
            mv.xy += d * q.y * (s + len * iSize.y) + n * q.x * s;
          } else { mv.xy += q * s; }
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: additive
        ? `varying vec2 vUv; varying vec4 vCol;
          void main(){ vec2 p = (vUv - 0.5) * 2.0; float d = dot(p, p); float a = max(0.0, exp(-d * 3.2) - 0.04);
            float core = exp(-d * 14.0); gl_FragColor = vec4((vCol.rgb + vec3(core) * 0.8) * a * vCol.a, 1.0); }`
        : `varying vec2 vUv; varying vec4 vCol;
          void main(){ vec2 p = (vUv - 0.5) * 2.0; float d = dot(p, p); float a = max(0.0, 1.0 - d); a *= a * vCol.a;
            gl_FragColor = vec4(vCol.rgb * a, a); }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.CustomBlending,
      ...(additive ? {} : { blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 10 : 9;
    scene.add(this.mesh);
    this.imm = 0;
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, drag = 0, grav = 0, stretch = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.c[i * 4] = r; this.c[i * 4 + 1] = g; this.c[i * 4 + 2] = b; this.c[i * 4 + 3] = a;
    this.life[i] = this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.drag[i] = drag; this.grav[i] = grav; this.stretch[i] = stretch;
  }

  // Sprite drawn for this frame only (projectiles). Staged, then appended after live particles in flush().
  sprite(x, y, z, vx, vy, vz, size, stretch, r, g, b, a = 1) {
    if (this.imm >= 600) return;
    const i = this.imm++;
    const S = this.stage || (this.stage = new Float32Array(600 * 12));
    const o = i * 12;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
    S[o + 6] = r; S[o + 7] = g; S[o + 8] = b; S[o + 9] = a; S[o + 10] = size; S[o + 11] = stretch;
  }

  update(dt) {
    const { p, v, c, life, maxLife } = this;
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const l = life[i] - dt;
      if (l <= 0) continue;
      if (j !== i) {
        p[j * 3] = p[i * 3]; p[j * 3 + 1] = p[i * 3 + 1]; p[j * 3 + 2] = p[i * 3 + 2];
        v[j * 3] = v[i * 3]; v[j * 3 + 1] = v[i * 3 + 1]; v[j * 3 + 2] = v[i * 3 + 2];
        c[j * 4] = c[i * 4]; c[j * 4 + 1] = c[i * 4 + 1]; c[j * 4 + 2] = c[i * 4 + 2]; c[j * 4 + 3] = c[i * 4 + 3];
        maxLife[j] = maxLife[i]; this.s0[j] = this.s0[i]; this.s1[j] = this.s1[i];
        this.drag[j] = this.drag[i]; this.grav[j] = this.grav[i]; this.stretch[j] = this.stretch[i];
      }
      life[j] = l;
      const k = Math.max(0, 1 - this.drag[j] * dt);
      v[j * 3] *= k; v[j * 3 + 1] = v[j * 3 + 1] * k - this.grav[j] * dt; v[j * 3 + 2] *= k;
      p[j * 3] += v[j * 3] * dt; p[j * 3 + 1] += v[j * 3 + 1] * dt; p[j * 3 + 2] += v[j * 3 + 2] * dt;
      j++;
    }
    this.n = j;
  }

  // Write live particles (+ this frame's immediate sprites) to GPU buffers.
  flush() {
    const A = this.attr;
    const ip = A.iPos.array, iv = A.iVel.array, ic = A.iCol.array, is = A.iSize.array;
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i] / this.maxLife[i];
      ip[i * 3] = this.p[i * 3]; ip[i * 3 + 1] = this.p[i * 3 + 1]; ip[i * 3 + 2] = this.p[i * 3 + 2];
      iv[i * 3] = this.v[i * 3]; iv[i * 3 + 1] = this.v[i * 3 + 1]; iv[i * 3 + 2] = this.v[i * 3 + 2];
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      ic[i * 4] = this.c[i * 4]; ic[i * 4 + 1] = this.c[i * 4 + 1]; ic[i * 4 + 2] = this.c[i * 4 + 2];
      ic[i * 4 + 3] = this.c[i * 4 + 3] * Math.max(0, fade);
      is[i * 2] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      is[i * 2 + 1] = this.stretch[i];
    }
    const S = this.stage;
    for (let k = 0; k < this.imm; k++) {
      const i = this.n + k, o = k * 12;
      ip[i * 3] = S[o]; ip[i * 3 + 1] = S[o + 1]; ip[i * 3 + 2] = S[o + 2];
      iv[i * 3] = S[o + 3]; iv[i * 3 + 1] = S[o + 4]; iv[i * 3 + 2] = S[o + 5];
      ic[i * 4] = S[o + 6]; ic[i * 4 + 1] = S[o + 7]; ic[i * 4 + 2] = S[o + 8]; ic[i * 4 + 3] = S[o + 9];
      is[i * 2] = S[o + 10]; is[i * 2 + 1] = S[o + 11];
    }
    const count = this.n + this.imm;
    this.geo.instanceCount = count;
    for (const k in A) { A[k].clearUpdateRanges(); A[k].addUpdateRange(0, count * A[k].itemSize); A[k].needsUpdate = true; }
    this.imm = 0;
  }

  clear() { this.n = 0; this.imm = 0; }
}

// ------------------------------------------------------------------ ground decals
// shape: 0 soft disc, 1 ring, 2 hex ring, 3 target reticle
export class Decals {
  constructor(scene, max = 400) {
    this.max = max;
    this.list = [];
    const [g, a] = instGeo([['iPos', 4], ['iCol', 4], ['iSize', 4]], max);
    this.geo = g;
    this.attr = a;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute vec4 iPos; attribute vec4 iCol; attribute vec4 iSize; varying vec2 vUv; varying vec4 vCol; varying vec2 vShape;
        void main(){ vUv = uv; vCol = iCol; vShape = iSize.zw;
          float c = cos(iPos.w), s = sin(iPos.w);
          vec2 q = position.xy * iSize.x; q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(iPos.x + q.x, iPos.y, iPos.z + q.y, 1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv; varying vec4 vCol; varying vec2 vShape;
        void main(){
          vec2 p = (vUv - 0.5) * 2.0; float r = length(p); float a = 0.0; float shape = vShape.x; float th = vShape.y;
          if (shape < 0.5) a = exp(-r * r * 3.5) * (1.0 - smoothstep(0.85, 1.0, r));
          else if (shape < 1.5) a = smoothstep(1.0 - th, 1.0 - th * 0.5, r) * (1.0 - smoothstep(1.0 - th * 0.5, 1.0, r)) + exp(-r * r * 3.0) * 0.08;
          else if (shape < 2.5) { float ang = atan(p.y, p.x); float hr = r * cos(3.14159/6.0) / cos(mod(ang, 3.14159/3.0) - 3.14159/6.0);
            a = smoothstep(1.0 - th, 1.0 - th * 0.5, hr) * (1.0 - smoothstep(1.0 - th * 0.5, 1.0, hr)); }
          else { float ring = smoothstep(0.88, 0.93, r) * (1.0 - smoothstep(0.95, 1.0, r));
            float ang = atan(p.y, p.x) + uTime * 2.0; float ticks = step(0.7, fract(ang / 6.28318 * 8.0)) * smoothstep(0.7, 0.75, r) * (1.0 - smoothstep(0.8, 0.84, r));
            float cross = (1.0 - smoothstep(0.02, 0.04, abs(p.x))) * step(r, 0.25) + (1.0 - smoothstep(0.02, 0.04, abs(p.y))) * step(r, 0.25);
            a = ring + ticks + cross + exp(-r * r * 4.0) * 0.15; }
          gl_FragColor = vec4(vCol.rgb * a * vCol.a, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  // life<=0 means persistent until removed
  add(o) {
    const d = {
      x: 0, y: 0.02, z: 0, rot: 0, spin: 0, size0: 1, size1: 1, r: 1, g: 1, b: 1, a: 1, shape: 0, thick: 0.15,
      life: 0.5, t: 0, fadeIn: 0, ease: 1, ...o,
    };
    if (this.list.length < this.max) this.list.push(d);
    return d;
  }

  remove(d) { const i = this.list.indexOf(d); if (i >= 0) this.list.splice(i, 1); }

  update(dt, time) {
    this.mat.uniforms.uTime.value = time;
    const A = this.attr;
    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      d.t += dt;
      if (d.life > 0 && d.t >= d.life) { this.list.splice(i--, 1); continue; }
      const u = d.life > 0 ? d.t / d.life : 0;
      const e = d.ease === 1 ? 1 - (1 - u) * (1 - u) : u;
      const size = d.size0 + (d.size1 - d.size0) * e;
      let a = d.a * (d.life > 0 ? 1 - u : 1);
      if (d.fadeIn > 0 && d.t < d.fadeIn) a *= d.t / d.fadeIn;
      if (d.pulse) a *= 0.75 + 0.25 * Math.sin(time * d.pulse);
      d.rot += d.spin * dt;
      A.iPos.array.set([d.x, d.y, d.z, d.rot], n * 4);
      A.iCol.array.set([d.r, d.g, d.b, a], n * 4);
      A.iSize.array.set([size, 0, d.shape, d.thick], n * 4);
      n++;
    }
    this.geo.instanceCount = n;
    for (const k in A) { A[k].clearUpdateRanges(); A[k].addUpdateRange(0, n * A[k].itemSize); A[k].needsUpdate = true; }
  }
}

// ------------------------------------------------------------------ beams
export class Beams {
  constructor(scene, max = 700) {
    this.max = max;
    this.n = 0;
    const [g, a] = instGeo([['iA', 3], ['iB', 3], ['iCol', 4], ['iW', 2]], max);
    // quad: x in [0,1] along, y in [-0.5,0.5] across
    const along = new Float32Array([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(along, 3));
    this.geo = g;
    this.attr = a;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: `attribute vec3 iA; attribute vec3 iB; attribute vec4 iCol; attribute vec2 iW; varying vec2 vUv; varying vec4 vCol; varying float vCore;
        void main(){ vCol = iCol; vCore = iW.y;
          vec4 a = modelViewMatrix * vec4(iA, 1.0); vec4 b = modelViewMatrix * vec4(iB, 1.0);
          vec2 d = b.xy - a.xy; float len = length(d); d = len > 1e-5 ? d / len : vec2(1.0, 0.0); vec2 n = vec2(-d.y, d.x);
          float ext = iW.x * 0.5;
          vec4 p = mix(a, b, position.x); p.xy += n * position.y * iW.x + d * (position.x * 2.0 - 1.0) * ext;
          vUv = vec2(position.x, position.y + 0.5);
          gl_Position = projectionMatrix * p; }`,
      fragmentShader: `varying vec2 vUv; varying vec4 vCol; varying float vCore;
        void main(){ float y = (vUv.y - 0.5) * 2.0; float glow = exp(-y * y * 3.0); float core = exp(-y * y * 28.0) * vCore;
          gl_FragColor = vec4((vCol.rgb * glow + vec3(core)) * vCol.a, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    scene.add(this.mesh);
  }

  begin() { this.n = 0; }

  line(ax, ay, az, bx, by, bz, width, r, g, b, a = 1, core = 1) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const A = this.attr;
    A.iA.array[i * 3] = ax; A.iA.array[i * 3 + 1] = ay; A.iA.array[i * 3 + 2] = az;
    A.iB.array[i * 3] = bx; A.iB.array[i * 3 + 1] = by; A.iB.array[i * 3 + 2] = bz;
    A.iCol.array[i * 4] = r; A.iCol.array[i * 4 + 1] = g; A.iCol.array[i * 4 + 2] = b; A.iCol.array[i * 4 + 3] = a;
    A.iW.array[i * 2] = width; A.iW.array[i * 2 + 1] = core;
  }

  end() {
    this.geo.instanceCount = this.n;
    const A = this.attr;
    for (const k in A) { A[k].clearUpdateRanges(); A[k].addUpdateRange(0, this.n * A[k].itemSize); A[k].needsUpdate = true; }
  }
}

// Jagged lightning between points (writes into Beams); pts = [x,y,z,...]
export function lightning(beams, pts, width, r, g, b, a, jitter = 0.12, subdiv = 5) {
  for (let i = 0; i + 5 < pts.length + 0; i += 3) {
    const ax = pts[i], ay = pts[i + 1], az = pts[i + 2], bx = pts[i + 3], by = pts[i + 4], bz = pts[i + 5];
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= subdiv; k++) {
      const t = k / subdiv;
      let x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      if (k < subdiv) { x += (Math.random() - 0.5) * jitter * 2; y += (Math.random() - 0.5) * jitter * 2; z += (Math.random() - 0.5) * jitter * 2; }
      beams.line(px, py, pz, x, y, z, width, r, g, b, a, 1);
      px = x; py = y; pz = z;
    }
  }
}
