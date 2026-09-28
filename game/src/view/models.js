// Procedural low-poly models. Every model is a few merged geometries (metal + glow) to keep draw calls low.
import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { GeoBuilder, box, cyl, cone, sphere, torus, octa, ico } from './geo.js';
import { TOWERS } from '../core/config.js';

const M0 = 0x151a26, M1 = 0x232a3c, M2 = 0x343d55, M3 = 0x505b78, M4 = 0x7e89a6;
const PI = Math.PI;
const WHITE = 0xffffff;

// A tower's signature neon color (TOWERS[type].color) drives its whole look.
const towerAccent = (type) => (TOWERS[type] && TOWERS[type].color) || 0x22c8ff;

// ---------------------------------------------------------------- helpers
const rx = (a) => [a, 0, 0];
const ry = (a) => [0, a, 0];
const rz = (a) => [0, 0, a];
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _Y = new THREE.Vector3(0, 1, 0);
const _mm = new THREE.Matrix4(), _sv = new THREE.Vector3(), _pv = new THREE.Vector3();

// XYZ Euler that turns local +Y toward the direction a -> b.
function aimY(a, b) {
  _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  _q.setFromUnitVectors(_Y, _v);
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}
// Bar between two points (box, or n-sided round bar when round > 0).
function strut(b, a, c, w, color, round = 0) {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
  b.add(round ? cyl(w / 2, w / 2, len, round) : box(w, len, w), color, mid, aimY(a, c));
}
// Part plus its mirror image across x = 0 (the geometry must be symmetric in its own frame).
function sym(b, mk, color, pos, rot = null, scale = null) {
  b.add(mk(), color, pos, rot, scale);
  b.add(mk(), color, [-pos[0], pos[1], pos[2]], rot ? [rot[0], -rot[1], -rot[2]] : null, scale);
}
// Intrinsic yaw (Y) -> pitch (local X) -> roll (local Z) as an XYZ Euler for GeoBuilder.
function ypr(yaw, pitch = 0, roll = 0) {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}
// pos + R(rot) * local
function xf(pos, rot, local) {
  _v.set(local[0], local[1], local[2]);
  if (rot) _v.applyEuler(_e.set(rot[0], rot[1], rot[2], 'XYZ'));
  return [pos[0] + _v.x, pos[1] + _v.y, pos[2] + _v.z];
}
// Local frame at (ox, oy, oz) turned by yaw (local +x -> world (cos yaw, 0, -sin yaw)).
function frame(m, g, ox, oy, oz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const qy = new THREE.Quaternion().setFromAxisAngle(_Y, yaw);
  const P = (p) => [ox + p[0] * c + p[2] * s, oy + p[1], oz - p[0] * s + p[2] * c];
  const R = (r) => {
    _q.setFromEuler(_e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'XYZ')).premultiply(qy);
    _e.setFromQuaternion(_q, 'XYZ');
    return [_e.x, _e.y, _e.z];
  };
  return {
    m(geo, col, p = [0, 0, 0], r = null, sc = null) { m.add(geo, col, P(p), R(r), sc); return this; },
    g(geo, col, p = [0, 0, 0], r = null, sc = null) { g.add(geo, col, P(p), R(r), sc); return this; },
    raw(b, geo, p, yawLocal = 0, sc = 1) { placeRaw(b, geo, P(p), yaw + yawLocal, sc); return this; },
    P,
  };
}
// Add an already-colored geometry (e.g. a drone) with a transform.
function placeRaw(b, geo, pos, yaw = 0, s = 1) {
  const g = geo.clone();
  _q.setFromAxisAngle(_Y, yaw);
  _mm.compose(_pv.set(pos[0], pos[1], pos[2]), _q, _sv.set(s, s, s));
  g.applyMatrix4(_mm);
  b.addRaw(g);
}
// Capsule along y (open cylinder + two hemispheres; avoids CapsuleGeometry's zero-area pole triangles).
function capsule(r, len, cap = 2, seg = 8) {
  const c = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const t = new THREE.SphereGeometry(r, seg, cap, 0, PI * 2, 0, PI / 2).translate(0, len / 2, 0);
  const b = new THREE.SphereGeometry(r, seg, cap, 0, PI * 2, PI / 2, PI / 2).translate(0, -len / 2, 0);
  const g = BGU.mergeGeometries([c, t, b], false);
  c.dispose(); t.dispose(); b.dispose();
  return g;
}
// Upper half of a sphere (dome), open at the bottom.
const dome = (r, ws = 16, hs = 5) => new THREE.SphereGeometry(r, ws, hs, 0, PI * 2, 0, PI / 2);

// Metal + neon parts in one geometry, tagged with the aGlow attribute (see emissiveVertexMat).
function mergeGlow(metal, glow) {
  const tag = (g, v) => {
    if (!g) return null;
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1));
    return g;
  };
  const parts = [tag(metal, 0), tag(glow, 1)].filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const g = BGU.mergeGeometries(parts, false);
  metal.dispose();
  glow.dispose();
  g.computeBoundingSphere();
  return g;
}


// ---------------------------------------------------------------- towers
// Returns { base:{geo}, head:{geo,y,muzzle,aims}, spin:{geo,pos,axis,speed}|null, accent }
// level 1..3 = base tiers, 4 = specialization (spec 'a'|'b'), 5 = ultimate of that spec.
// Every tower type has its own footprint, height class and metal tint, and its TOWERS color is the dominant neon;
// an ultimate is the brightest, most elaborate version of that same tower in that same color.
const towerCache = new Map();

export function towerModel(type, level, spec) {
  const key = `${type}|${level}|${spec || ''}`;
  let m = towerCache.get(key);
  if (!m) { m = buildTower(type, level, spec); towerCache.set(key, m); }
  return m;
}

function buildTower(type, level, spec) {
  const accent = towerAccent(type);
  const bm = new GeoBuilder(), bg = new GeoBuilder();
  const hm = new GeoBuilder(), hg = new GeoBuilder();
  const sm = new GeoBuilder(), sg = new GeoBuilder();
  const sp = level >= 4 ? spec || null : null;
  const out = { accent, base: {}, head: { y: 0.15, muzzle: [0, 0.12, 0.45], aims: true }, spin: null };
  const ctx = {
    bm, bg, hm, hg, sm, sg, out, accent,
    L: Math.min(level, 3), spec: sp, E: !!sp, U: level >= 5 && !!sp,
    P: palette(accent, TINT[type] ?? 0.4, METALS[type]),
  };
  (BUILDERS[type] || BUILDERS.pulse)(ctx);
  out.base.geo = mergeGlow(bm.build(), bg.build());
  out.head.geo = mergeGlow(hm.build(), hg.build());
  if (out.spin) out.spin.geo = mergeGlow(sm.build(), sg.build());
  return out;
}

// Per-tower metal livery: the dark greys shifted toward the tower's hue at equal luminance (cryo: pale frosted steel).
const TINT = { pulse: 0.5, mortar: 0.6, cryo: 0.3, tesla: 0.55, laser: 0.55, inferno: 0.6, sam: 0.7, sensor: 0.55, amp: 0.55, carrier: 0.6, mines: 0.55 };
const METALS = { cryo: [0x2a3548, 0x48586f, 0x6c7d98, 0x97a8c2, 0xc4d2e6] };
const _white = new THREE.Color(1, 1, 1);
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
// Colors are THREE.Color in linear space (GeoBuilder.add accepts them) so they can be mixed. Neon tones are
// normalized by luminance so every hue reads equally bright: A stays under the bloom threshold (crisp colored
// lines), G blooms in the tower's own hue (key features, ultimates), W is a tiny white-hot core.
function palette(accent, k, metals) {
  const a = new THREE.Color(accent);
  // ACES tone mapping desaturates bright emission, so the neon hue is pre-saturated (per-channel power) and its
  // channels are capped; otherwise violets, blues and reds wash out to pastel on screen.
  const m0 = Math.max(a.r, a.g, a.b, 1e-3);
  const sat = new THREE.Color((a.r / m0) ** 1.4, (a.g / m0) ** 1.4, (a.b / m0) ** 1.4);
  const hue = (L, cap) => {
    const c = sat.clone().multiplyScalar(L / lum(sat));
    const m = Math.max(c.r, c.g, c.b);
    return m > cap ? c.multiplyScalar(cap / m) : c;
  };
  const tint = (hex, kk) => { const c = new THREE.Color(hex); return c.lerp(a.clone().multiplyScalar(lum(c) / lum(a)), kk); };
  const [d, kc, p, l, h] = metals || [M0, M1, M2, M3, M4];
  const A = hue(0.4, 1.1);
  return {
    A,                                                                 // neon accent lines
    G: hue(0.62, 1.45),                                                // glare: blooms in the tower's hue
    S: A.clone().multiplyScalar(0.42),                                 // soft lit panels (large colored areas)
    T: A.clone().multiplyScalar(0.6),                                  // dimmer second tone of the same hue
    W: _white.clone().lerp(a.clone().multiplyScalar(1 / Math.max(a.r, a.g, a.b)), 0.3), // white-hot core
    D: tint(d, k), K: tint(kc, k), P: tint(p, k), L: tint(l, k * 0.8), H: tint(h, k * 0.6),
  };
}

const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
// Neon outline inlaid in the top face (height y) of a regular n-prism: a glow slab under a slightly smaller metal cap.
function inlay(m, g, n, r, y, w, mc, gc, rot = 0) {
  g.add(cyl(r, r, 0.012, n), gc, [0, y + 0.004, 0], ry(rot));
  m.add(cyl(r - w, r - w, 0.012, n), mc, [0, y + 0.01, 0], ry(rot));
}
function inlayBox(m, g, wx, wz, y, w, mc, gc) {
  g.add(box(wx, 0.012, wz), gc, [0, y + 0.004, 0]);
  m.add(box(wx - 2 * w, 0.012, wz - 2 * w), mc, [0, y + 0.01, 0]);
}
// Neon band hugging the side of an n-prism (open tube).
const band = (g, n, r, y, h, col, rot = 0) => g.add(cyl(r, r, h, n, true), col, [0, y, 0], ry(rot));
// Point on a circle of radius r at angle a (a = 0 -> +z, toward the camera), height y.
const polar = (a, r, y = 0) => [Math.sin(a) * r, y, Math.cos(a) * r];
// Closed n-gon outline of thin bars (visible from every side, unlike an open band). Same vertex layout as cyl(r, r, h, n).
function polyFrame(g, n, r, y, w, h, col, rot = 0) {
  const side = 2 * r * Math.sin(PI / n), ir = r * Math.cos(PI / n);
  for (let i = 0; i < n; i++) {
    const a = rot + (i + 0.5) * ((2 * PI) / n);
    g.add(box(side + w, h, w), col, polar(a, ir, y), ry(a));
  }
}

// ---- shared tower sub-builders
// Launch bay in a local frame (local +x = radially outward): dark recessed pad, glowing corner brackets,
// low side rails with runway lights and a parked drone. Returns the launch point above the pad.
function launchPad(F, m, g, s, P, deck, drone, droneScale, tint) {
  F.g(box(s, 0.014, s), P.S, [0, deck + 0.007, 0]);
  const e = s / 2 - 0.018;
  for (const [sx, sz] of CORNERS) F.g(box(0.03, 0.006, 0.03), P.A, [sx * e, deck + 0.017, sz * e]);
  for (const sz of [-1, 1]) {
    F.m(box(s + 0.02, 0.035, 0.026), P.P, [0, deck + 0.0175, sz * (s / 2 + 0.013)]);
    F.g(box(s * 0.7, 0.008, 0.012), P.A, [0, deck + 0.037, sz * (s / 2 + 0.013)]);
  }
  if (drone) {
    const d = droneParts(drone, tint);
    F.raw(m, d.metal, [0, deck + 0.03, 0], PI / 2, droneScale);
    F.raw(g, d.glow, [0, deck + 0.03, 0], PI / 2, droneScale);
  }
  return F.P([0, deck + 0.12, 0]);
}

// Small spinning radar bar (spin part, origin at its pivot).
function radarBar(sm, sg, P, s = 1) {
  sm.add(cyl(0.016, 0.02, 0.05, 6), P.L, [0, 0.025, 0]);
  sm.add(box(0.2 * s, 0.045 * s, 0.018), P.L, [0, 0.065, 0], rx(-0.3));
  sg.add(box(0.18 * s, 0.012, 0.005), P.A, xf([0, 0.065, 0], rx(-0.3), [0, 0, 0.011]), rx(-0.3));
  for (const x of [-0.1 * s, 0.1 * s]) sg.add(sphere(0.013, 6, 4), P.W, [x, 0.065, 0]);
}

// Parabolic radar dish on a yoke (spin part). Returns the face frame for decals.
function radarDish(sm, sg, r, P) {
  const tilt = 0.5;
  sm.add(cyl(0.02, 0.028, 0.06, 6), P.L, [0, 0.03, 0]);
  sm.add(box(0.06, 0.03, 0.05), P.L, [0, 0.065, 0]);
  const c = [0, 0.07 + r * 0.55, 0.0];
  const rot = [PI / 2 - tilt, 0, 0];
  strut(sm, [0, 0.07, 0], c, 0.03, P.L);
  sm.add(cyl(r, r * 0.35, r * 0.3, 14), P.L, c, rot);
  const ax = [0, Math.sin(tilt), Math.cos(tilt)];
  const face = [0, c[1] + ax[1] * r * 0.15, c[2] + ax[2] * r * 0.15];
  const on = (d) => [face[0], face[1] + ax[1] * d, face[2] + ax[2] * d];
  sg.add(cyl(r * 0.8, r * 0.8, 0.008, 14), P.S, on(0.003), rot);
  sm.add(cyl(r * 0.3, r * 0.3, 0.01, 10), P.P, on(0.006), rot);
  sg.add(torus(r * 0.9, 0.012, 3, 24), P.A, on(0.006), rx(-tilt));
  const tipP = on(r * 0.62);
  strut(sm, on(0), tipP, 0.012, P.H, 4);
  for (const x of [-1, 1]) strut(sm, [x * r * 0.75, face[1], face[2]], tipP, 0.007, P.H, 3);
  sg.add(sphere(0.024, 6, 4), P.W, tipP);
  return { face, ax, tilt, on, center: c };
}

const BUILDERS = {
  // PULSE CANNON - square stepped plinth, boxy gun turret. Medium height, azure.
  pulse({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, out }) {
    const top = L >= 3 ? 0.2 : 0.15;
    bm.add(box(0.58, 0.06, 0.58), P.D, [0, 0.03, 0]);
    bg.add(box(0.594, 0.018, 0.594), P.A, [0, 0.036, 0]);
    bm.add(box(0.5, 0.09, 0.5), P.P, [0, 0.105, 0]);
    if (L >= 3) bm.add(box(0.44, 0.05, 0.44), P.K, [0, 0.175, 0]);
    const iw = L >= 3 ? 0.42 : 0.48;
    inlayBox(bm, bg, iw, iw, top, 0.03, P.L, P.A);
    if (L >= 2) for (const [sx, sz] of CORNERS) {
      const h = top + 0.03, x = sx * 0.245, z = sz * 0.245;
      bm.add(box(0.09, h, 0.09), P.K, [x, h / 2, z]);
      bm.add(box(0.1, 0.02, 0.1), P.L, [x, h + 0.01, z]);
      bg.add(box(0.06, 0.012, 0.06), U ? P.W : P.A, [x, h + 0.022, z]);
      if (L >= 3) bg.add(box(0.016, h * 0.7, 0.016), P.A, [sx * 0.29, h * 0.45, sz * 0.29]);
    }
    if (E) {
      if (spec === 'a') for (const s of [-1, 1]) { // ammo belt feeds along the flanks
        bm.add(box(0.07, 0.1, 0.26), P.P, [s * 0.3, 0.09, 0]);
        bg.add(box(0.05, 0.012, 0.22), P.A, [s * 0.3, 0.146, 0]);
      } else for (const s of [-1, 1]) for (const z of [-0.08, 0.08]) { // capacitor cells
        bm.add(cyl(0.04, 0.04, 0.14, 8), P.P, [s * 0.3, 0.07, z]);
        bg.add(cyl(0.043, 0.043, 0.02, 8, true), P.A, [s * 0.3, 0.1, z]);
        bg.add(cyl(0.028, 0.028, 0.012, 8), U ? P.W : P.A, [s * 0.3, 0.146, z]);
      }
    }
    if (U) {
      bg.add(box(0.612, 0.012, 0.612), P.A, [0, 0.008, 0]);
      for (const [sx, sz] of CORNERS) bg.add(octa(0.036), P.G, [sx * 0.245, top + 0.15, sz * 0.245], null, [1, 1.8, 1]);
    }

    out.head.y = top;
    if (spec === 'a') {
      // gatling: spinning barrel cluster fed from side drum(s)
      const w = U ? 0.36 : 0.32;
      hm.add(box(w, 0.2, 0.3), P.K, [0, 0.11, -0.04]);
      hm.add(box(w - 0.06, 0.05, 0.24), P.L, [0, 0.235, -0.05]);
      hg.add(box(w - 0.1, 0.012, 0.18), P.S, [0, 0.262, -0.05]);
      hm.add(box(w - 0.04, 0.12, 0.05), P.P, [0, 0.12, 0.12]);
      sym(hg, () => box(0.012, 0.04, 0.22), P.A, [w / 2 + 0.004, 0.13, -0.04]);
      const dx = w / 2 + 0.065;
      for (const s of U ? [-1, 1] : [-1]) {
        hm.add(cyl(0.1, 0.1, 0.11, 12), P.P, [s * dx, 0.12, -0.05], rz(PI / 2));
        hg.add(cyl(0.103, 0.103, 0.03, 12, true), P.A, [s * dx, 0.12, -0.05], rz(PI / 2));
        hg.add(cyl(0.055, 0.055, 0.116, 10), P.S, [s * dx, 0.12, -0.05], rz(PI / 2));
      }
      const n = U ? 8 : 6, rr = U ? 0.074 : 0.06, bl = U ? 0.5 : 0.42;
      const bz = 0.18 + (bl - 0.42) / 2, fz = 0.39 + (bl - 0.42);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        sm.add(cyl(0.022, 0.022, bl, 6), P.H, [Math.cos(a) * rr, Math.sin(a) * rr, bz], rx(PI / 2));
        if (U) sg.add(cyl(0.0235, 0.0235, 0.04, 6), P.W, [Math.cos(a) * rr, Math.sin(a) * rr, bz + bl / 2 - 0.02], rx(PI / 2));
      }
      sm.add(cyl(rr + 0.035, rr + 0.035, 0.04, 12), P.L, [0, 0, 0.05], rx(PI / 2));
      sm.add(cyl(rr + 0.03, rr + 0.03, 0.03, 12), P.L, [0, 0, 0.3 + (bl - 0.42) * 0.6], rx(PI / 2));
      sg.add(cyl(rr + 0.038, rr + 0.038, 0.022, 12, true), P.A, [0, 0, 0.05], rx(PI / 2));
      sg.add(cyl(rr + 0.04, rr + 0.04, 0.02, 12, true), P.A, [0, 0, fz], rx(PI / 2));
      if (U) {
        for (const z of [0.16, 0.24]) sg.add(torus(rr + 0.062, 0.012, 4, 20), P.G, [0, 0, z + (bl - 0.42)]);
        for (const x of [-0.08, 0, 0.08]) {
          hm.add(box(0.022, 0.07, 0.2), P.L, [x, 0.29, -0.06]);
          hg.add(box(0.024, 0.012, 0.18), P.A, [x, 0.328, -0.06]);
        }
      }
      out.spin = { pos: [0, 0.12, 0.14], axis: 'z', speed: 0 };
      out.head.muzzle = [0, 0.12, 0.14 + fz + 0.06];
      return;
    }
    if (spec === 'b') {
      // railgun: long twin rails lined with glowing coil plates
      const bw = U ? 0.34 : 0.3;
      hm.add(box(bw, 0.18, 0.34), P.K, [0, 0.1, -0.06]);
      hm.add(box(bw - 0.08, 0.07, 0.28), P.L, [0, 0.225, -0.08]);
      hg.add(box(bw - 0.12, 0.012, 0.22), P.S, [0, 0.262, -0.08]);
      const rl = U ? 0.9 : 0.82, rz0 = 0.38 + (rl - 0.82) / 2, front = rz0 + rl / 2;
      for (const x of [-0.075, 0.075]) hm.add(box(0.045, 0.08, rl), P.H, [x, 0.1, rz0]);
      hm.add(box(0.2, 0.04, 0.06), P.P, [0, 0.1, front - 0.04]);
      const np = U ? 6 : 4, step = (rl - 0.22) / (np - 1);
      for (let i = 0; i < np; i++) hg.add(box(0.19, U ? 0.11 : 0.1, 0.024), U && i % 2 ? P.G : P.A, [0, 0.1, rz0 - rl / 2 + 0.12 + i * step]);
      sym(hg, () => box(0.014, 0.1, 0.24), P.A, [bw / 2 + 0.005, 0.1, -0.08]);
      if (U) {
        hm.add(box(0.32, 0.14, 0.1), P.P, [0, 0.12, -0.28]);
        for (const x of [-0.09, 0, 0.09]) {
          hg.add(cyl(0.03, 0.03, 0.13, 8), P.A, [x, 0.17, -0.29]);
          hm.add(cyl(0.036, 0.036, 0.02, 8), P.H, [x, 0.245, -0.29]);
        }
        hg.add(torus(0.12, 0.013, 4, 20), P.G, [0, 0.1, front + 0.05]);
        hg.add(torus(0.085, 0.011, 4, 16), P.W, [0, 0.1, front + 0.11]);
      }
      out.head.muzzle = [0, 0.1, U ? front + 0.12 : front + 0.02];
      return;
    }
    const w = L >= 2 ? 0.34 : 0.3;
    hm.add(box(w, 0.18, 0.3), P.K, [0, 0.1, -0.03]);
    hm.add(box(w - 0.06, 0.05, 0.22), P.L, [0, 0.215, -0.05]);
    hg.add(box(w - 0.1, 0.012, 0.16), P.S, [0, 0.242, -0.05]);
    hm.add(box(w - 0.02, 0.1, 0.07), P.P, [0, 0.1, 0.13], rx(-0.45));
    sym(hg, () => box(0.012, 0.035, 0.22), P.A, [w / 2 + 0.004, 0.1, -0.03]);
    const barrels = L >= 2 ? [-0.075, 0.075] : [0];
    const len = L >= 3 ? 0.42 : 0.36, br = L >= 3 ? 0.048 : 0.042;
    for (const x of barrels) {
      hm.add(cyl(br, br * 1.12, len, 8), P.H, [x, 0.1, 0.14 + len / 2], rx(PI / 2));
      hg.add(cyl(br + 0.008, br + 0.008, 0.035, 8, true), P.A, [x, 0.1, 0.14 + len - 0.02], rx(PI / 2));
      if (L >= 3) {
        hm.add(box(0.1, 0.065, 0.06), P.P, [x, 0.1, 0.14 + len - 0.08]);
        hg.add(torus(br + 0.012, 0.009, 3, 10), P.A, [x, 0.1, 0.14 + len * 0.45]);
      }
    }
    if (L >= 2) {
      sym(hm, () => box(0.06, 0.14, 0.22), P.P, [w / 2 + 0.03, 0.1, -0.05]);
      sym(hg, () => box(0.064, 0.014, 0.16), P.A, [w / 2 + 0.03, 0.172, -0.05]);
    }
    if (L >= 3) {
      hm.add(cyl(0.008, 0.008, 0.16, 4), P.H, [0.1, 0.32, -0.12]);
      hg.add(sphere(0.022, 6, 4), P.W, [0.1, 0.41, -0.12]);
      for (let i = 0; i < 3; i++) hm.add(box(w - 0.08, 0.014, 0.04), P.H, [0, 0.07 + i * 0.045, -0.19]);
    }
    out.head.muzzle = [0, 0.1, 0.14 + len + 0.02];
  },

  // PLASMA MORTAR - round squat bunker, a fat stubby barrel whose glowing bore faces the sky. Low & wide, orange.
  mortar({ bm, bg, hm, hg, L, spec, E, U, P, out }) {
    bm.add(cyl(0.37, 0.405, 0.1, 18), P.K, [0, 0.05, 0]);
    bm.add(cyl(0.28, 0.37, 0.05, 18), P.P, [0, 0.125, 0]);
    bm.add(cyl(0.235, 0.25, 0.02, 18), P.D, [0, 0.16, 0]);
    const top = 0.17;
    band(bg, 18, 0.4, 0.03, 0.026, P.A);
    const slits = L >= 2 ? 8 : 6;
    for (let i = 0; i < slits; i++) {
      const a = (i / slits) * PI * 2 + PI / slits;
      bg.add(box(0.085, 0.022, 0.014), P.A, polar(a, 0.382, 0.07), ry(a));
    }
    if (L >= 2) for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2 + PI / 4;
      bm.add(box(0.11, 0.13, 0.09), P.P, polar(a, 0.37, 0.065), ry(a));
      bg.add(box(0.07, 0.016, 0.093), P.A, polar(a, 0.37, 0.115), ry(a));
    }
    bg.add(torus(0.31, L >= 3 ? 0.013 : 0.008, 3, 30), P.A, [0, 0.135, 0], rx(PI / 2));
    if (E) {
      if (spec === 'a') {
        // shell racks on the bunker roof, behind the turret
        const n = U ? 6 : 3;
        for (let i = 0; i < n; i++) {
          const p = polar(PI + (i - (n - 1) / 2) * (U ? 0.36 : 0.42), 0.325);
          bm.add(cyl(0.028, 0.028, 0.08, 8), P.H, [p[0], 0.165, p[2]]);
          bg.add(cone(0.028, 0.05, 8), U ? P.G : P.A, [p[0], 0.23, p[2]]);
        }
      } else for (let i = 0; i < 3; i++) {
        // gravity pylons with glowing collars
        const a = (i / 3) * PI * 2 + PI / 3, h = U ? 0.22 : 0.17;
        bm.add(cyl(0.02, 0.035, h, 6), P.L, polar(a, 0.34, 0.1 + h / 2));
        bg.add(torus(0.036, 0.009, 3, 10), P.A, polar(a, 0.34, 0.1 + h * 0.55), rx(PI / 2));
        if (U) {
          bm.add(sphere(0.034, 8, 6), P.D, polar(a, 0.34, 0.1 + h + 0.05));
          bg.add(torus(0.052, 0.008, 3, 14), P.G, polar(a, 0.34, 0.1 + h + 0.05), [PI / 2 - 0.5, 0, a]);
        } else bg.add(sphere(0.022, 6, 4), P.A, polar(a, 0.34, 0.1 + h + 0.02));
      }
    }
    if (U) bg.add(torus(0.415, 0.011, 3, 40), P.G, [0, 0.012, 0], rx(PI / 2));

    out.head.y = top;
    hm.add(cyl(0.21, 0.235, 0.06, 14), P.P, [0, 0.03, 0]);
    hg.add(cyl(0.237, 0.237, 0.016, 14, true), P.A, [0, 0.04, 0]);
    hm.add(box(0.26, 0.09, 0.24), P.K, [0, 0.1, -0.05]);
    hm.add(box(0.2, 0.1, 0.12), P.K, [0, 0.11, -0.19]);
    hg.add(box(0.15, 0.012, 0.09), P.S, [0, 0.166, -0.19]);
    const tilt = 0.55; // ~58 degrees above the horizon: the glowing bore faces the camera from any heading
    const ax = [0, Math.cos(tilt), Math.sin(tilt)];
    const at = (p, t) => [p[0], p[1] + ax[1] * t, p[2] + ax[2] * t];
    const hot = L >= 3 || spec ? P.G : P.A;
    const barrel = (x, r, len, p0 = [x, 0.12, 0.02], bands = 1) => {
      hm.add(cyl(r, r * 1.14, len, 10), P.H, at(p0, len / 2), rx(tilt));
      hm.add(cyl(r * 1.3, r * 1.3, 0.07, 10), P.P, at(p0, 0.04), rx(tilt));
      for (let k = 0; k < bands; k++) hg.add(cyl(r * 1.07, r * 1.07, 0.028, 10, true), P.A, at(p0, len * (0.42 + k * 0.22)), rx(tilt));
      hm.add(cyl(r * 1.24, r * 1.14, 0.05, 10), P.L, at(p0, len - 0.02), rx(tilt));
      hg.add(cyl(r * 0.86, r * 0.86, 0.012, 10), hot, at(p0, len + 0.003), rx(tilt));
      hg.add(cyl(r * 0.4, r * 0.4, 0.012, 8), P.W, at(p0, len + 0.008), rx(tilt));
      return at(p0, len + 0.02);
    };
    if (spec === 'a') {
      // cluster: honeycomb of barrels (3, then 5 at the ultimate)
      sym(hm, () => box(0.05, 0.19, 0.2), P.L, [U ? 0.19 : 0.17, 0.13, 0]);
      const r = 0.058;
      let mz = barrel(0, r, 0.3, [0, 0.12, 0.04]);
      barrel(-0.125, r, 0.28, [-0.125, 0.12, 0.04]);
      barrel(0.125, r, 0.28, [0.125, 0.12, 0.04]);
      if (U) {
        const m2 = barrel(-0.063, r, 0.3, [-0.063, 0.18, -0.07]);
        barrel(0.063, r, 0.3, [0.063, 0.18, -0.07]);
        mz = [0, (mz[1] + m2[1]) / 2, (mz[2] + m2[2]) / 2];
        sym(hg, () => box(0.012, 0.05, 0.16), P.A, [0.217, 0.15, 0]);
      }
      hm.add(box(U ? 0.34 : 0.3, 0.05, 0.08), P.P, at([0, 0.12, 0.04], 0.1), rx(tilt));
      out.head.muzzle = mz;
      return;
    }
    if (spec === 'b') {
      // singularity: one huge barrel with a black core hovering over the bore, wrapped in accretion rings
      sym(hm, () => box(0.05, 0.2, 0.22), P.L, [0.18, 0.14, 0]);
      const r = U ? 0.14 : 0.125;
      const mz = barrel(0, r, 0.28, [0, 0.12, 0.02], 2);
      const c = at(mz, U ? 0.09 : 0.07);
      hm.add(sphere(U ? 0.08 : 0.066, 12, 8), P.D, c);
      const r0 = tilt + PI / 2;
      hg.add(torus(U ? 0.15 : 0.125, 0.014, 4, 28), P.G, c, [r0 - 0.35, 0.3, 0]);
      hg.add(torus(U ? 0.105 : 0.092, 0.01, 4, 24), P.W, c, [r0 + 0.25, -0.4, 0]);
      if (U) {
        hg.add(torus(0.2, 0.008, 3, 36), P.A, c, [r0 + 0.1, 0.9, 0]);
        for (const s of [-1, 1]) {
          hm.add(box(0.03, 0.18, 0.14), P.P, [s * 0.215, 0.25, -0.02], [0.25, 0, -s * 0.35]);
          hg.add(box(0.034, 0.15, 0.02), P.A, xf([s * 0.215, 0.25, -0.02], [0.25, 0, -s * 0.35], [0, 0, 0.07]), [0.25, 0, -s * 0.35]);
        }
      }
      out.head.muzzle = c;
      return;
    }
    sym(hm, () => box(0.05, 0.16, 0.2), P.L, [0.15, 0.13, 0]);
    const r = L >= 3 ? 0.12 : L >= 2 ? 0.105 : 0.095;
    out.head.muzzle = barrel(0, r, L >= 3 ? 0.3 : L >= 2 ? 0.28 : 0.26, [0, 0.12, 0.02], L >= 3 ? 2 : 1);
    if (L >= 2) for (const s of [-1, 1]) strut(hm, [s * 0.1, 0.09, -0.07], at([s * 0.065, 0.12, 0.02], 0.16), 0.022, P.H, 6);
    if (L >= 3) for (const s of [-1, 1]) {
      hm.add(box(0.07, 0.09, 0.14), P.P, [s * 0.2, 0.075, -0.12]);
      hg.add(box(0.072, 0.014, 0.1), P.A, [s * 0.2, 0.122, -0.12]);
    }
  },

  // CRYO EMITTER - hexagonal plinth in pale frosted steel with ice spikes, a big faceted crystal on top. Medium-tall, ice white.
  cryo({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, out }) {
    const HX = PI / 6;
    const ICE = P.A, ICE2 = P.A.clone().multiplyScalar(0.75), CORE = L >= 3 || spec ? P.G : P.A;
    bm.add(cyl(0.36, 0.36, 0.07, 6), P.K, [0, 0.035, 0], ry(HX));
    band(bg, 6, 0.364, 0.038, 0.018, P.A, HX);
    bm.add(cyl(0.29, 0.345, 0.035, 6), P.P, [0, 0.0875, 0], ry(HX));
    bm.add(cyl(0.27, 0.27, 0.05, 6), P.L, [0, 0.13, 0], ry(HX));
    const top = 0.155;
    inlay(bm, bg, 6, 0.255, top, 0.026, P.P, P.A, HX);
    const nCr = U ? 6 : L >= 3 ? 6 : L >= 2 ? 3 : 0;
    for (let i = 0; i < nCr; i++) {
      const a = HX + (nCr === 3 ? i * 2 : i) * (PI / 3);
      const big = U ? 1.35 : L >= 3 ? 1.1 : 1;
      bg.add(octa(0.042 * big), i % 2 && nCr === 6 ? ICE2 : ICE, polar(a, 0.315, 0.1 + 0.04 * big), aimY([0, 0, 0], [Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4]), [1, 2.5, 1]);
    }
    if (E) for (let i = 0; i < 3; i++) {
      // frost vents (a) / field emitters (b) on the three back faces
      const a = PI + (i - 1) * (PI / 3) * 1.0 + (spec === 'b' ? PI / 3 : 0);
      const p = polar(a, 0.265, 0.12);
      bm.add(cyl(0.035, 0.045, 0.1, 6), P.H, p);
      bg.add(cyl(0.028, 0.028, 0.012, 6), P.A, [p[0], 0.176, p[2]]);
    }
    if (U) {
      bg.add(torus(0.4, 0.01, 3, 36), P.A, [0, 0.014, 0], rx(PI / 2));
      for (let i = 0; i < 6; i++) {
        const a = i * (PI / 3);
        bg.add(octa(0.03), P.G, polar(a, 0.38, 0.34 + (i % 2) * 0.06), aimY([0, 0, 0], [Math.sin(a) * 0.5, 1, Math.cos(a) * 0.5]), [1, 2.2, 1]);
      }
    }
    out.head.y = top;
    const crystal = (b, s, p, rot = null, col = ICE) => {
      b.add(octa(0.09 * s), col, p, rot, [1, 2.2, 1]);
      b.add(octa(0.034 * s), P.W, xf(p, rot, [0, 0.15 * s, 0]), rot, [1, 2.2, 1]);
    };
    if (spec === 'b') {
      // frost field: crystal spire ringed by frost pylons; a halo of shards orbits it
      out.head.aims = false;
      hm.add(cyl(0.15, 0.2, 0.1, 6), P.P, [0, 0.05, 0], ry(HX));
      hm.add(cyl(0.2, 0.2, 0.03, 6), P.L, [0, 0.115, 0], ry(HX));
      hg.add(cyl(0.204, 0.204, 0.014, 6, true), P.A, [0, 0.115, 0], ry(HX));
      const s = U ? 1.8 : 1.5;
      crystal(hg, s, [0, 0.13 + 0.09 * s * 2.2, 0], null, CORE);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * PI * 2;
        crystal(hg, U ? 0.8 : 0.65, polar(a, 0.13, 0.21), aimY([0, 0, 0], [Math.sin(a) * 0.5, 1, Math.cos(a) * 0.5]), ICE2);
      }
      const n = U ? 8 : 6, R = U ? 0.33 : 0.3;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        sg.add(octa(0.055), U && i % 2 ? P.W : ICE, polar(a, R, 0), rz(0.3), [1, 2, 1]);
      }
      sg.add(torus(R, 0.012, 4, 36), P.A, [0, 0, 0], rx(PI / 2));
      if (U) sg.add(torus(R - 0.09, 0.009, 3, 30), P.A, [0, 0.05, 0], rx(PI / 2));
      out.spin = { pos: [0, 0.3, 0], axis: 'y', speed: 1.2 };
      out.head.muzzle = [0, 0.13 + 0.09 * s * 2.2, 0];
      return;
    }
    // frost cannon: hex emitter body, flared nozzle forward, crystal on top
    const big = spec === 'a' ? (U ? 1.55 : 1.4) : L >= 3 ? 1.2 : L >= 2 ? 1.1 : 1;
    hm.add(cyl(0.15, 0.18, 0.15, 6), P.P, [0, 0.075, -0.02], ry(HX));
    hm.add(cyl(0.12, 0.15, 0.05, 6), P.L, [0, 0.175, -0.02], ry(HX));
    hg.add(cyl(0.183, 0.183, 0.016, 6, true), P.A, [0, 0.03, -0.02], ry(HX));
    const nr = spec === 'a' ? 0.1 : 0.085;
    hm.add(cyl(nr, 0.05, 0.18, 6), P.H, [0, 0.09, 0.2], [PI / 2, HX, 0]);
    hg.add(cyl(nr * 0.8, nr * 0.8, 0.012, 6), P.A, [0, 0.09, 0.291], [PI / 2, HX, 0]);
    if (L >= 3 || spec) hg.add(cyl(nr * 0.75 + 0.012, nr * 0.75 + 0.012, 0.02, 6, true), P.A, [0, 0.09, 0.22], [PI / 2, HX, 0]);
    const cy = 0.2 + 0.09 * big * 2.2;
    crystal(hg, big, [0, cy, -0.02], null, CORE);
    if (L >= 2 || spec) {
      const ss = spec === 'a' ? (U ? 0.85 : 0.7) : 0.55;
      for (const s of [-1, 1]) crystal(hg, ss, [s * 0.13, 0.2 + 0.05 * ss * 2.2, -0.05], [0, 0, -s * 0.45], ICE2);
    }
    if (L >= 3 || spec) hg.add(torus(0.19, 0.012, 4, 24), P.A, [0, 0.21, -0.02], rx(PI / 2));
    if (spec === 'a') {
      crystal(hg, 0.6, [0, 0.26, -0.17], [-0.5, 0, 0], ICE2);
      if (U) {
        // shatter storm: a spinning ring of ice shards around the crystal
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * PI * 2, c = Math.cos(a), s = Math.sin(a);
          sg.add(octa(0.04), i % 2 ? P.W : ICE, [c * 0.27, (i % 3) * 0.035 - 0.03, s * 0.27], aimY([0, 0, 0], [-s * 0.6, 1, c * 0.6]), [1, 2.3, 1]);
        }
        sg.add(torus(0.27, 0.008, 3, 40), P.A, [0, 0, 0], rx(PI / 2));
        out.spin = { pos: [0, cy, -0.02], axis: 'y', speed: 2.2 };
      }
    }
    out.head.muzzle = [0, 0.09, 0.3];
  },

  // TESLA COIL - round stepped (tiered) plinth with insulators, a tall column of violet coils, orb or toroid crown. Tall & thin.
  tesla({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, out }) {
    out.head.aims = false;
    bm.add(cyl(0.3, 0.3, 0.05, 16), P.D, [0, 0.025, 0]);
    band(bg, 16, 0.304, 0.028, 0.016, P.A);
    bm.add(cyl(0.235, 0.27, 0.05, 16), P.K, [0, 0.075, 0]);
    bm.add(cyl(0.2, 0.2, 0.04, 16), P.P, [0, 0.12, 0]);
    band(bg, 16, 0.204, 0.12, 0.014, P.A);
    bm.add(cyl(0.15, 0.18, 0.03, 16), P.L, [0, 0.155, 0]);
    const top = 0.17;
    const posts = L >= 3 ? 6 : L >= 2 ? 3 : 0;
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * PI * 2 + PI / 6;
      const h = U ? 0.2 : 0.14;
      bm.add(cyl(0.018, 0.024, h, 5), P.L, polar(a, 0.265, 0.05 + h / 2));
      bm.add(cyl(0.034, 0.034, 0.014, 8), P.H, polar(a, 0.265, 0.09));
      bg.add(octa(0.024), E ? P.G : P.A, polar(a, 0.265, 0.05 + h + 0.02), null, [1, 1.4, 1]);
    }
    if (U) {
      bg.add(torus(0.35, 0.011, 3, 30), P.A, [0, 0.3, 0], rx(PI / 2));
      for (let i = 0; i < 6; i++) bg.add(octa(0.028), P.G, polar((i / 6) * PI * 2, 0.35, 0.3), null, [1, 1.7, 1]);
    }
    out.head.y = top;
    const coils = spec ? (U ? 6 : 5) : L + 2;
    const step = 0.12, h = 0.1 + coils * step;
    hm.add(cyl(0.05, 0.085, h, 8), P.L, [0, h / 2, 0]);
    for (let i = 0; i < coils; i++) {
      const r = 0.165 - i * 0.01, y = 0.08 + i * step;
      hg.add(torus(r, U ? 0.024 : 0.021, 3, 14), i % 2 ? P.T : P.A, [0, y, 0], rx(PI / 2));
      hm.add(cyl(r * 0.72, r * 0.72, 0.03, 8), P.P, [0, y, 0]);
    }
    if (spec === 'b') {
      // EMP overload: classic toroid crown with a discharge ball
      const tr = U ? 0.21 : 0.18;
      hm.add(cyl(0.06, 0.04, 0.06, 8), P.P, [0, h + 0.02, 0]);
      hm.add(torus(tr, 0.06, 5, 18), P.H, [0, h + 0.08, 0], rx(PI / 2));
      hg.add(torus(tr + 0.052, 0.011, 3, 24), P.A, [0, h + 0.08, 0], rx(PI / 2));
      hg.add(torus(tr, 0.011, 3, 22), P.A, [0, h + 0.14, 0], rx(PI / 2));
      hm.add(cyl(0.018, 0.018, 0.14, 6), P.H, [0, h + 0.16, 0]);
      hg.add(sphere(U ? 0.075 : 0.06, 8, 6), P.G, [0, h + 0.26, 0]);
      if (U) {
        hm.add(torus(tr * 0.7, 0.04, 4, 16), P.H, [0, h + 0.33, 0], rx(PI / 2));
        hg.add(torus(tr * 0.7 + 0.036, 0.009, 3, 24), P.A, [0, h + 0.33, 0], rx(PI / 2));
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * PI * 2;
          sm.add(cone(0.016, 0.1, 4), P.H, polar(a, 0.3, 0), [0, 0, 0]);
          sg.add(octa(0.02), i % 2 ? P.W : P.A, polar(a, 0.3, 0.065), null, [1, 1.6, 1]);
        }
        sg.add(torus(0.3, 0.008, 3, 32), P.A, [0, -0.04, 0], rx(PI / 2));
        out.spin = { pos: [0, h + 0.08, 0], axis: 'y', speed: 2.2 };
      }
      out.head.muzzle = [0, h + 0.26, 0];
      return;
    }
    const orb = spec === 'a' ? (U ? 0.19 : 0.165) : 0.1 + L * 0.015;
    const oy = h + orb * 0.8;
    hm.add(cyl(orb * 0.55, 0.05, 0.05, 8), P.P, [0, h + 0.01, 0]);
    hg.add(ico(orb, 1), L >= 3 || spec ? P.G : P.A, [0, oy, 0]);
    if (spec === 'a') {
      // storm core: claw cradle and orbiting lightning nodes
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + PI / 4;
        strut(hm, polar(a, 0.05, h), polar(a, orb + 0.03, oy - 0.02), 0.022, P.H);
        hg.add(octa(0.026), P.A, polar(a, orb + 0.045, oy + 0.02), null, [1, 1.6, 1]);
      }
      const n = U ? 6 : 3, R = U ? 0.34 : 0.3;
      for (let i = 0; i < n; i++) sg.add(sphere(U ? 0.042 : 0.038, 6, 4), i % 2 ? P.W : P.G, polar((i / n) * PI * 2, R, 0));
      sg.add(torus(R, U ? 0.012 : 0.008, 3, 32), P.A, [0, 0, 0], rx(PI / 2));
      if (U) sg.add(torus(R - 0.06, 0.008, 3, 36), P.T, [0, 0, 0], [PI / 2 + 0.45, 0, 0]);
      out.spin = { pos: [0, oy, 0], axis: 'y', speed: U ? 1.8 : 1.4 };
    }
    out.head.muzzle = [0, oy, 0];
  },

  // FOCUS LASER - triangular plinth with glowing vertex prisms, long lens barrel ending in a big pink lens. Medium.
  laser({ bm, bg, hm, hg, L, spec, E, U, P, out }) {
    const TR = PI / 3; // a vertex away from the camera, a flat side facing it
    bm.add(cyl(0.415, 0.415, 0.06, 3), P.D, [0, 0.03, 0], ry(TR));
    band(bg, 3, 0.422, 0.036, 0.018, P.A, TR);
    if (L >= 3) band(bg, 3, 0.422, 0.012, 0.01, P.A, TR);
    bm.add(cyl(0.33, 0.39, 0.04, 3), P.K, [0, 0.08, 0], ry(TR));
    bm.add(cyl(0.29, 0.29, 0.05, 3), P.P, [0, 0.125, 0], ry(TR));
    const top = 0.15;
    inlay(bm, bg, 3, 0.275, top, 0.034, P.L, P.A, TR);
    if (L >= 2) for (let i = 0; i < 3; i++) {
      // vertex prisms (kept low: the barrel sweeps over them)
      const a = TR + i * (2 * PI / 3);
      const h = L >= 3 ? 0.12 : 0.09;
      bm.add(cyl(0.032, 0.05, h, 3), P.L, polar(a, 0.335, 0.06 + h / 2), ry(a + PI));
      bg.add(cyl(0.024, 0.034, 0.03, 3), E ? P.G : P.A, polar(a, 0.335, 0.06 + h + 0.012), ry(a + PI));
    }
    if (U) {
      for (let i = 0; i < 3; i++) {
        const a = TR + PI / 3 + i * (2 * PI / 3); // over the middle of each side, just outside the plinth
        bg.add(octa(0.03), P.G, polar(a, 0.27, 0.13), null, [1, 1.6, 1]);
      }
    }
    out.head.y = top;
    hm.add(cyl(0.16, 0.19, 0.06, 12), P.P, [0, 0.03, 0]);
    hg.add(cyl(0.192, 0.192, 0.014, 12, true), P.A, [0, 0.04, 0]);
    const long = spec === 'b' ? (U ? 0.68 : 0.6) : spec === 'a' ? 0.48 : L >= 3 ? 0.52 : L >= 2 ? 0.46 : 0.4;
    // triangular prism housing (apex up) with triangular focusing bands and a neon ridge
    const by = 0.15, z0 = -0.16, z1 = z0 + long, rb = 0.14, rf = spec === 'b' ? 0.11 : 0.1;
    const triR = [PI / 2, PI, 0];
    const rAt = (z) => rb + (rf - rb) * ((z - z0) / long);
    hm.add(cyl(rf, rb, long, 3), P.K, [0, by, (z0 + z1) / 2], triR);
    strut(hg, [0, by + rb + 0.002, z0 + 0.02], [0, by + rf + 0.002, z1 - 0.02], 0.022, P.A);
    for (const s of [-1, 1]) {
      const zm = (z0 + z1) / 2, r = rAt(zm);
      hg.add(box(0.012, r * 0.55, long * 0.7), P.S, [s * r * 0.44, by + r * 0.24, zm], [0, 0, s * (PI / 6)]);
    }
    const rings = spec === 'b' ? (U ? 4 : 3) : Math.min(L, 3);
    for (let i = 0; i < rings; i++) {
      const z = z0 + long * (0.3 + (i / Math.max(1, rings)) * 0.6);
      hg.add(cyl(rAt(z) + 0.014, rAt(z) + 0.014, 0.03, 3, true), P.A, [0, by, z], triR);
    }
    sym(hm, () => box(0.05, 0.1, 0.24), P.P, [0.15, by - 0.01, -0.06]);
    sym(hg, () => box(0.052, 0.022, 0.18), P.A, [0.15, by + 0.035, -0.06]);
    if (L >= 3 || spec) for (let i = 0; i < 3; i++) hm.add(box(0.012, 0.07, 0.14), P.H, [-0.04 + i * 0.04, by + 0.14, -0.06]);
    if (spec === 'a') {
      if (U) {
        // prism matrix: pentagonal prism ringed by five splayed emitter lenses
        hm.add(cyl(0.13, 0.13, 0.05, 5), P.P, [0, by, z1 + 0.02], [PI / 2, 0, 0]);
        hg.add(cyl(0.092, 0.092, 0.17, 5), P.A, [0, by, z1 + 0.1], [PI / 2, 0, 0]);
        hg.add(cyl(0.045, 0.045, 0.02, 5), P.W, [0, by, z1 + 0.19], [PI / 2, 0, 0]);
        hg.add(torus(0.2, 0.01, 3, 30), P.A, [0, by, z1 + 0.035]);
        hm.add(torus(0.172, 0.02, 4, 20), P.L, [0, by, z1 + 0.02]);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * PI * 2 + PI / 2, c = Math.cos(a), sn = Math.sin(a);
          const p = [c * 0.172, by + sn * 0.172, z1 + 0.05], r = aimY([0, 0, 0], [c * 0.3, sn * 0.3, 1]);
          hm.add(cyl(0.028, 0.036, 0.09, 8), P.P, p, r);
          hg.add(cyl(0.024, 0.024, 0.016, 8), P.W, xf(p, r, [0, 0.048, 0]), r);
        }
        out.head.muzzle = [0, by, z1 + 0.2];
      } else {
        // prism split: a triangular crystal in a ring mount
        hm.add(torus(0.12, 0.022, 4, 12), P.L, [0, by, z1]);
        hg.add(cyl(0.1, 0.1, 0.16, 3), P.A, [0, by, z1 + 0.08], [PI / 2, 0, 0]);
        hg.add(cyl(0.045, 0.045, 0.165, 3), P.W, [0, by, z1 + 0.08], [PI / 2, 0, 0]);
        out.head.muzzle = [0, by, z1 + 0.16];
      }
      return;
    }
    // lens assembly
    const lr = spec === 'b' ? (U ? 0.14 : 0.13) : 0.08 + L * 0.012;
    hm.add(cyl(lr + 0.03, lr + 0.03, 0.06, 12), P.H, [0, by, z1], [PI / 2, 0, 0]);
    hg.add(cyl(lr, lr, 0.07, 12), L >= 3 || spec ? P.G : P.A, [0, by, z1 + 0.005], [PI / 2, 0, 0]);
    hg.add(cyl(lr * 0.45, lr * 0.45, 0.074, 10), P.W, [0, by, z1 + 0.005], [PI / 2, 0, 0]);
    if (spec === 'b') {
      hg.add(torus(0.19, 0.014, 4, 24), P.A, [0, by, z1 + 0.08]);
      hg.add(torus(0.155, 0.012, 4, 24), P.A, [0, by, z1 + 0.16]);
      if (U) {
        // piercing lance: third focusing ring, white-hot lance tip, capacitor fins on the roof
        hg.add(torus(0.12, 0.012, 4, 20), P.T, [0, by, z1 + 0.24]);
        hm.add(cone(0.035, 0.12, 8), P.H, [0, by, z1 + 0.1], [PI / 2, 0, 0]);
        hg.add(sphere(0.032, 8, 6), P.W, [0, by, z1 + 0.2]);
        for (const x of [-0.065, 0.065]) {
          hm.add(box(0.022, 0.12, 0.32), P.L, [x, by + 0.17, -0.04]);
          hg.add(box(0.024, 0.02, 0.28), P.A, [x, by + 0.235, -0.04]);
        }
      }
      out.head.muzzle = [0, by, z1 + (U ? 0.24 : 0.06)];
      return;
    }
    out.head.muzzle = [0, by, z1 + 0.05];
  },

  // INFERNO - heavy square slab with four fuel tanks at the corners, squat flamer hull. Low & wide, red.
  inferno({ bm, bg, hm, hg, L, spec, E, U, P, out }) {
    bm.add(box(0.58, 0.09, 0.58), P.K, [0, 0.045, 0]);
    bg.add(box(0.594, 0.02, 0.594), P.A, [0, 0.05, 0]);
    bm.add(box(0.46, 0.04, 0.46), P.P, [0, 0.11, 0]);
    const top = 0.13;
    if (L >= 2) for (const s of [-1, 1]) for (const [ax, az] of [[1, 0], [0, 1]]) {
      // heat grilles on the four sides
      for (let k = 0; k < 3; k++) {
        const o = (k - 1) * 0.06;
        bg.add(box(ax ? 0.012 : 0.03, 0.05, az ? 0.012 : 0.03), P.S, [ax ? s * 0.292 : o, 0.045, az ? s * 0.292 : o]);
      }
    }
    const th = L >= 3 ? 0.18 : L >= 2 ? 0.15 : 0.12, tr = 0.068;
    for (const [sx, sz] of CORNERS) {
      const x = sx * 0.24, z = sz * 0.24;
      bm.add(cyl(tr, tr, th, 10), P.P, [x, th / 2, z]);
      bm.add(cyl(tr * 0.7, tr, 0.025, 10), P.L, [x, th + 0.0125, z]);
      for (let k = 0; k < (L >= 2 ? 2 : 1); k++) bg.add(cyl(tr + 0.004, tr + 0.004, 0.02, 10, true), P.A, [x, th * (0.45 + k * 0.33), z]);
      bg.add(cyl(tr * 0.5, tr * 0.5, 0.012, 8), E ? P.G : P.A, [x, th + 0.026, z]);
      if (U) {
        bg.add(cone(0.042, 0.1, 6), P.G, [x, th + 0.085, z]);
        bg.add(cone(0.02, 0.06, 6), P.W, [x, th + 0.066, z]);
      }
    }
    if (L >= 3) for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const e = 0.262;
      strut(bm, [sx ? sx * e : -0.18, 0.104, sz ? sz * e : -0.18], [sx ? sx * e : 0.18, 0.104, sz ? sz * e : 0.18], 0.026, P.H, 6);
    }
    if (U) bg.add(box(0.604, 0.012, 0.604), P.G, [0, 0.008, 0]);
    out.head.y = top;
    const hw = L >= 2 || spec ? 0.34 : 0.3;
    hm.add(box(hw, 0.14, 0.28), P.K, [0, 0.07, -0.05]);
    hm.add(box(hw - 0.04, 0.09, 0.12), P.P, [0, 0.1, 0.1], rx(-0.6));
    hm.add(box(hw - 0.1, 0.04, 0.18), P.L, [0, 0.16, -0.08]);
    hg.add(box(hw - 0.14, 0.012, 0.14), P.S, [0, 0.182, -0.08]);
    sym(hg, () => box(0.012, 0.03, 0.22), P.A, [hw / 2 + 0.004, 0.08, -0.05]);
    const drum = (y, z, len, r = 0.058) => {
      hm.add(capsule(r, len), P.P, [0, y, z], rz(PI / 2));
      for (const dx of [-len * 0.3, len * 0.3]) hg.add(cyl(r + 0.004, r + 0.004, 0.018, 8, true), P.A, [dx, y, z], rz(PI / 2));
    };
    if (spec === 'b') {
      // napalm lobber: stubby mortar tube(s) fed by sticky-fuel canisters
      const tilt = 0.8;
      const lob = (x, r, len) => {
        const cy = 0.12 + Math.cos(tilt) * len * 0.5, cz = 0.02 + Math.sin(tilt) * len * 0.5;
        hm.add(cyl(r, r * 1.15, len, 10), P.L, [x, cy, cz], rx(tilt));
        hm.add(cyl(r * 1.3, r * 1.3, 0.07, 10), P.P, [x, 0.14, 0.03], rx(tilt));
        const ty = 0.12 + Math.cos(tilt) * len, tz = 0.02 + Math.sin(tilt) * len;
        hm.add(cyl(r * 1.25, r * 1.08, 0.05, 10), P.H, [x, ty - Math.cos(tilt) * 0.02, tz - Math.sin(tilt) * 0.02], rx(tilt));
        hg.add(cyl(r * 0.9, r * 0.9, 0.012, 10), U ? P.G : P.A, [x, ty + Math.cos(tilt) * 0.006, tz + Math.sin(tilt) * 0.006], rx(tilt));
        hg.add(cyl(r * 1.18, r * 1.18, 0.022, 10, true), P.A, [x, cy, cz], rx(tilt));
        return [x, ty + Math.cos(tilt) * 0.03, tz + Math.sin(tilt) * 0.03];
      };
      const can = (x, z, ch) => {
        hm.add(cyl(0.05, 0.05, ch, 8), P.L, [x, 0.14 + ch / 2, z]);
        hm.add(sphere(0.05, 8, 4), P.H, [x, 0.14 + ch, z], null, [1, 0.6, 1]);
        for (const f of [0.35, 0.7]) hg.add(cyl(0.053, 0.053, 0.018, 8, true), P.A, [x, 0.14 + ch * f, z]);
      };
      if (!U) {
        out.head.muzzle = lob(0, 0.085, 0.26);
        drum(0.19, -0.2, hw - 0.12);
      } else {
        const m = [];
        for (const x of [-0.11, 0, 0.11]) m.push(lob(x, 0.062, x === 0 ? 0.3 : 0.26));
        out.head.muzzle = m[1];
        for (const s of [-1, 1]) can(s * 0.13, -0.17, 0.16);
        drum(0.2, -0.19, 0.12, 0.05);
        hg.add(box(0.22, 0.014, 0.012), P.W, [0, 0.13, 0.155]);
      }
      return;
    }
    drum(0.19, -0.2, hw - 0.1, L >= 2 || spec ? 0.064 : 0.058);
    if (spec === 'a') {
      // plasma jet: long focused nozzle with magnetic coil rings
      const nl = U ? 0.5 : 0.44, z0 = 0.13;
      hm.add(cyl(0.036, 0.046, nl, 8), P.H, [0, 0.1, z0 + nl / 2], rx(PI / 2));
      const nc = U ? 4 : 3, cr = U ? 0.085 : 0.07;
      for (let i = 0; i < nc; i++) {
        const z = z0 + 0.08 + i * ((nl - 0.16) / (nc - 1));
        hm.add(cyl(cr, cr, 0.034, 10), P.P, [0, 0.1, z], rx(PI / 2));
        hg.add(torus(cr + 0.002, U ? 0.015 : 0.012, 4, 16), i === nc - 1 ? P.W : P.A, [0, 0.1, z]);
      }
      const tipZ = z0 + nl;
      hm.add(cyl(0.028, 0.044, 0.05, 8), P.H, [0, 0.1, tipZ + 0.02], rx(PI / 2));
      hg.add(sphere(0.03, 8, 6), P.W, [0, 0.1, tipZ + 0.05]);
      if (U) {
        // solar flare: a burning sun-disc crest behind the hull
        const hc = [0, 0.38, -0.2];
        hm.add(box(0.045, 0.2, 0.045), P.L, [0, 0.24, -0.2]);
        hm.add(torus(0.17, 0.024, 4, 32), P.P, hc);
        hg.add(torus(0.17, 0.012, 4, 32), P.G, [hc[0], hc[1], hc[2] + 0.02]);
        hg.add(sphere(0.07, 10, 8), P.W, hc);
        hg.add(torus(0.11, 0.012, 4, 24), P.A, hc);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * PI * 2, ln = i % 2 ? 0.07 : 0.12, rr = 0.2 + ln / 2;
          hg.add(cone(0.024, ln, 4), i % 2 ? P.T : P.A, [hc[0] + Math.cos(a) * rr, hc[1] + Math.sin(a) * rr, hc[2]], rz(a - PI / 2));
        }
      }
      out.head.muzzle = [0, 0.1, tipZ + 0.07];
      return;
    }
    // feed pipe + wide fan nozzle with a glowing throat
    const pl = L >= 3 ? 0.18 : 0.14;
    hm.add(cyl(0.04, 0.05, pl, 8), P.H, [0, 0.09, 0.14 + pl / 2], rx(PI / 2));
    const nz = 0.14 + pl + 0.035;
    hm.add(cyl(0.095, 0.056, 0.09, 8), P.L, [0, 0.09, nz], rx(PI / 2), [1.45, 1, 0.8]);
    hg.add(cyl(0.08, 0.08, 0.012, 8), L >= 3 ? P.G : P.A, [0, 0.09, nz + 0.041], rx(PI / 2), [1.45, 1, 0.8]);
    hg.add(cyl(0.04, 0.04, 0.014, 8), P.W, [0, 0.09, nz + 0.042], rx(PI / 2), [1.45, 1, 0.8]);
    hg.add(cyl(0.098, 0.098, 0.014, 8, true), P.A, [0, 0.09, nz - 0.02], rx(PI / 2), [1.45, 1, 0.8]);
    if (L >= 2) {
      sym(hm, () => box(0.05, 0.12, 0.24), P.P, [hw / 2 + 0.03, 0.08, -0.04]);
      sym(hg, () => box(0.052, 0.02, 0.14), P.A, [hw / 2 + 0.03, 0.12, -0.04]);
    }
    if (L >= 3) {
      for (const z of [0.18, 0.26]) hm.add(torus(0.054, 0.013, 4, 10), P.H, [0, 0.09, z]);
      hm.add(box(0.18, 0.025, 0.12), P.L, [0, 0.15, 0.22]);
      hg.add(box(0.1, 0.012, 0.012), P.A, [0, 0.165, 0.28]);
    }
    out.head.muzzle = [0, 0.09, nz + 0.07];
  },

  // SAM LAUNCHER - oblong rectangular pad with vertical missile racks, tilted box launcher. Medium, yellow.
  sam({ bm, bg, hm, hg, L, spec, E, U, P, out }) {
    bm.add(box(0.7, 0.07, 0.44), P.D, [0, 0.035, 0]);
    bg.add(box(0.712, 0.018, 0.452), P.A, [0, 0.04, 0]);
    bm.add(box(0.62, 0.06, 0.36), P.K, [0, 0.1, 0]);
    inlayBox(bm, bg, 0.58, 0.32, 0.13, 0.028, P.P, P.A);
    bm.add(cyl(0.19, 0.21, 0.03, 16), P.L, [0, 0.155, 0]);
    const top = 0.17;
    // vertical missile racks at the short ends
    const racks = L >= 3 || E ? [-1, 1] : L >= 2 ? [1] : [];
    for (const s of racks) {
      const rows = U ? 3 : 2, cols = L >= 3 || E ? 3 : 2;
      bm.add(box(0.1, 0.06, 0.3), P.P, [s * 0.285, 0.16, 0]);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const x = s * (0.26 + i * 0.035 - (rows - 1) * 0.0175), z = (j - (cols - 1) / 2) * 0.085;
        bm.add(cyl(0.015, 0.015, 0.09, 6), P.H, [x, 0.235, z]);
        bg.add(cone(0.015, 0.035, 6), P.A, [x, 0.297, z]);
      }
    }
    if (U) for (const [sx, sz] of CORNERS) {
      // warning beacons on the corners
      bm.add(cyl(0.008, 0.01, 0.2, 4), P.H, [sx * 0.33, 0.17, sz * 0.2]);
      bg.add(sphere(0.022, 6, 4), P.G, [sx * 0.33, 0.28, sz * 0.2]);
    }
    if (U) bg.add(box(0.72, 0.012, 0.46), P.G, [0, 0.008, 0]);
    out.head.y = top;
    hm.add(cyl(0.15, 0.17, 0.05, 12), P.P, [0, 0.025, 0]);
    hg.add(cyl(0.172, 0.172, 0.014, 12, true), P.A, [0, 0.03, 0]);
    hm.add(box(0.1, 0.2, 0.12), P.L, [0, 0.14, -0.05]);
    const pitch = -0.28;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    if (spec === 'b') {
      // heavy warhead on a rail: one big missile (tactical nuke at the ultimate)
      const mr = U ? 0.09 : 0.075, ml = U ? 0.5 : 0.46, my = 0.36;
      const ax = [0, -sp, cp];
      const at = (t, dx = 0, dy = 0) => [dx, my + dy + ax[1] * t, 0.02 + ax[2] * t];
      hm.add(box(U ? 0.13 : 0.1, 0.08, U ? 0.64 : 0.6), P.K, [0, 0.28, 0.02], rx(pitch));
      hg.add(box(U ? 0.132 : 0.102, 0.014, U ? 0.5 : 0.46), P.S, xf([0, 0.28, 0.02], rx(pitch), [0, -0.04, 0]), rx(pitch));
      hm.add(cyl(mr, mr, ml, 10), P.H, [0, my, 0.02], rx(PI / 2 + pitch));
      hg.add(cone(mr, 0.16, 10), P.G, at(ml / 2 + 0.08), rx(PI / 2 + pitch));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + PI / 4;
        hm.add(box(0.012, 0.1, 0.12), P.L, [Math.cos(a) * mr, my + Math.sin(a) * mr, 0], [pitch, 0, a]);
      }
      if (U) {
        // radiation bands, white-hot tip, twin boosters
        for (const t of [-0.1, 0.0, 0.1]) hg.add(torus(mr + 0.004, 0.013, 4, 16), P.A, at(t), rx(pitch));
        hg.add(sphere(0.034, 8, 6), P.W, at(ml / 2 + 0.16));
        for (const s of [-1, 1]) {
          const bx = s * (mr + 0.05);
          hm.add(cyl(0.034, 0.034, 0.3, 8), P.L, at(-0.02, bx, -0.03), rx(PI / 2 + pitch));
          hm.add(cone(0.034, 0.07, 8), P.H, at(0.165, bx, -0.03), rx(PI / 2 + pitch));
          hg.add(cyl(0.037, 0.037, 0.02, 8, true), P.A, at(0.06, bx, -0.03), rx(PI / 2 + pitch));
          hg.add(cyl(0.026, 0.026, 0.012, 8), P.W, at(-0.176, bx, -0.03), rx(PI / 2 + pitch));
        }
        out.head.muzzle = at(ml / 2 + 0.18);
      } else {
        hg.add(torus(mr + 0.004, 0.011, 4, 16), P.A, at(-0.05), rx(pitch));
        out.head.muzzle = at(ml / 2 + 0.17);
      }
      return;
    }
    // missile pod(s): a grid of glowing missile tips on the front face
    const pod = (ox, cols, rows, cell, rails = 'both') => {
      const bw = cols * cell + 0.08, bh = rows * cell + 0.08;
      const cy = 0.27 + bh / 2 - 0.05;
      hm.add(box(bw, bh, 0.34), P.P, [ox, cy, 0], rx(pitch));
      hg.add(box(bw + 0.004, 0.02, 0.05), P.A, xf([ox, cy, 0], rx(pitch), [0, bh / 2 - 0.009, 0.145]), rx(pitch));
      hg.add(box(bw - 0.05, 0.012, 0.24), P.S, xf([ox, cy, 0], rx(pitch), [0, bh / 2 + 0.002, -0.03]), rx(pitch));
      for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
        const p = xf([ox + s * (bw / 2 + 0.003), cy, 0], rx(pitch), [0, 0, -0.1 + k * 0.08]);
        hg.add(box(0.008, bh * 0.75, 0.03), P.A, p, [pitch + 0.5, 0, 0]);
      }
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const x = ox + (i - (cols - 1) / 2) * cell, ly = (j - (rows - 1) / 2) * cell, lz = 0.171;
        const py = cy + ly * cp - lz * sp, pz = ly * sp + lz * cp;
        hm.add(cyl(cell * 0.4, cell * 0.4, 0.02, 8), P.D, [x, py, pz], rx(PI / 2 + pitch));
        hg.add(cone(cell * 0.27, 0.05, 6), spec ? P.G : P.A, [x, py - 0.01 * sp, pz + 0.012], rx(PI / 2 + pitch));
      }
      const sides = rails === 'both' ? [-1, 1] : rails === 'left' ? [-1] : [1];
      for (const s of sides) hm.add(box(0.04, 0.12, 0.26), P.L, [ox + s * (bw / 2 + 0.03), cy - 0.04, -0.02], rx(pitch));
      return { cy, bw, bh };
    };
    if (spec === 'a' && U) {
      // MIRV: twin 3x3 pods on a yoke with a guidance mast
      hm.add(box(0.2, 0.14, 0.22), P.P, [0, 0.27, -0.03]);
      const p = pod(-0.158, 3, 3, 0.068, 'left');
      pod(0.158, 3, 3, 0.068, 'right');
      hm.add(box(0.66, 0.035, 0.07), P.L, [0, p.cy - p.bh / 2 - 0.02, 0.1], rx(pitch));
      hm.add(cyl(0.014, 0.014, 0.2, 6), P.H, [0, 0.46, -0.1]);
      hg.add(octa(0.03), P.W, [0, 0.58, -0.1], null, [1, 1.6, 1]);
      hg.add(torus(0.045, 0.008, 3, 12), P.A, [0, 0.52, -0.1], rx(PI / 2));
      out.head.muzzle = [0, p.cy, 0.2];
      return;
    }
    const grid = spec === 'a' ? [3, 3] : L >= 3 ? [3, 2] : L >= 2 ? [2, 2] : [2, 1];
    const p = pod(0, grid[0], grid[1], spec === 'a' ? 0.085 : 0.11);
    if (spec === 'a') hm.add(box(p.bw + 0.1, 0.03, 0.06), P.L, [0, p.cy - p.bh / 2 - 0.02, 0.1], rx(pitch));
    out.head.muzzle = [0, p.cy, 0.2];
  },

  // SENSOR ARRAY - three-legged mast with lime light bands and sensor pods, spinning dish or jammer crown. Tall & thin.
  sensor({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, out }) {
    out.head.aims = false;
    const H = spec ? (U ? 0.86 : 0.8) : 0.62 + (L - 1) * 0.08;
    for (let i = 0; i < 3; i++) {
      const a = PI + (i / 3) * PI * 2;
      const foot = polar(a, 0.32, 0.03), knee = polar(a, 0.2, 0.2), hip = polar(a, 0.05, 0.34);
      strut(bm, foot, knee, 0.036, P.K);
      strut(bm, knee, hip, 0.03, P.P);
      bm.add(cyl(0.055, 0.068, 0.035, 6), P.P, polar(a, 0.32, 0.0175));
      bg.add(cyl(0.042, 0.042, 0.01, 6), P.A, polar(a, 0.32, 0.038));
      bm.add(sphere(0.026, 6, 4), P.L, knee);
      if (L >= 3 || E) strut(bg, polar(a, 0.316, 0.07), polar(a, 0.226, 0.198), 0.012, P.A);
    }
    bm.add(cyl(0.065, 0.08, 0.1, 6), P.P, [0, 0.33, 0]);
    bm.add(cyl(0.032, 0.05, H - 0.3, 6), P.L, [0, 0.3 + (H - 0.3) / 2, 0]);
    const nb = Math.floor((H - 0.38) / 0.12);
    for (let k = 0; k < nb; k++) {
      const y = 0.42 + k * 0.12, r = 0.05 - (0.018 * (y - 0.3)) / (H - 0.3);
      bg.add(cyl(r + 0.008, r + 0.008, 0.018, 6, true), P.A, [0, y, 0]);
    }
    const pods = spec ? 3 : L;
    for (let i = 0; i < pods; i++) {
      const a = i * 2.3 + 0.5, y = 0.44 + i * (H - 0.5) * 0.3;
      bm.add(box(0.07, 0.016, 0.016), P.H, polar(a, 0.065, y), [0, a - PI / 2, 0]);
      bm.add(sphere(0.042, 8, 6), P.P, polar(a, 0.1, y));
      bg.add(sphere(0.022, 6, 4), P.A, polar(a, 0.137, y));
    }
    if (L >= 2 || spec) {
      bm.add(cyl(0.005, 0.006, 0.3, 4), P.H, [0.12, 0.47, -0.08]);
      bm.add(box(0.1, 0.012, 0.012), P.H, [0.08, 0.34, -0.06], [0, 0.6, 0]);
      bg.add(sphere(0.016, 6, 4), L >= 3 || spec ? P.W : P.A, [0.12, 0.625, -0.08]);
    }
    if (spec === 'a' && U) {
      // kill-order reticle floating around the mast
      bg.add(torus(0.34, 0.012, 3, 44), P.G, [0, 0.36, 0], rx(PI / 2));
      bg.add(torus(0.27, 0.007, 3, 40), P.A, [0, 0.36, 0], rx(PI / 2));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * PI * 2 + PI / 4; bg.add(box(0.1, 0.014, 0.022), P.W, polar(a, 0.33, 0.36), [0, a + PI / 2, 0]); }
    }
    if (spec === 'b') for (const s of [-1, 1]) {
      // jammer emitter panels on the mast
      bm.add(box(0.016, 0.17, 0.11), P.P, [s * 0.08, 0.52, 0]);
      strut(bm, [s * 0.02, 0.52, 0], [s * 0.072, 0.52, 0], 0.015, P.H);
      for (let k = 0; k < 3; k++) bg.add(box(0.02, 0.014, 0.088), P.A, [s * 0.08, 0.46 + k * 0.055, 0]);
      if (U) {
        bm.add(box(0.11, 0.17, 0.016), P.P, [0, 0.62, s * 0.08]);
        for (let k = 0; k < 3; k++) bg.add(box(0.088, 0.014, 0.02), P.T, [0, 0.56 + k * 0.055, s * 0.08]);
      }
    }
    out.head.y = H;
    hm.add(cyl(0.085, 0.06, 0.035, 8), P.P, [0, 0.0175, 0]);
    hg.add(cyl(0.087, 0.087, 0.012, 8, true), P.A, [0, 0.03, 0]);
    const spinY = 0.035;
    out.spin = { pos: [0, spinY, 0], axis: 'y', speed: 1.6 };
    if (spec === 'b') {
      // spinning crown of emitter spikes
      sm.add(cyl(0.03, 0.04, 0.05, 6), P.L, [0, 0.025, 0]);
      sm.add(cyl(0.05, 0.05, 0.03, 8), P.P, [0, 0.06, 0]);
      const ring = (R, n, col, tipCol, h, y0) => {
        sg.add(torus(R, 0.011, 3, 32), col, [0, y0, 0], rx(PI / 2));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * PI * 2 + (n === 8 ? PI / 8 : 0), c = Math.cos(a) * R, s = Math.sin(a) * R;
          sm.add(cone(0.022, h, 4), P.H, [c, y0 + h / 2, s]);
          sg.add(octa(0.027), tipCol, [c, y0 + h + 0.014, s], null, [1, 1.6, 1]);
          sg.add(box(0.009, h * 0.6, 0.009), col, [c * 1.12, y0 + h * 0.35, s * 1.12]);
          strut(sm, [0, 0.06, 0], [c, y0, s], 0.014, P.L);
        }
      };
      ring(0.15, 6, P.A, U ? P.G : P.A, 0.21, 0.075);
      sm.add(cyl(0.014, 0.014, 0.28, 4), P.H, [0, 0.2, 0]);
      sg.add(sphere(0.032, 6, 4), P.G, [0, 0.35, 0]);
      if (U) {
        ring(0.25, 8, P.A, P.T, 0.12, 0.06);
        sg.add(torus(0.19, 0.008, 3, 30), P.T, [0, 0.14, 0], rx(PI / 2 + 0.3));
      }
      out.head.muzzle = [0, spinY + 0.22, 0];
      return;
    }
    const dishR = spec ? (U ? 0.22 : 0.2) : 0.13 + L * 0.02;
    const dish = radarDish(sm, sg, dishR, P);
    if (spec === 'a') {
      // target painter: laser designators on arms + crosshair on the dish
      const rot = rx(-dish.tilt);
      sg.add(box(dishR * 1.5, 0.01, 0.004), P.W, dish.on(0.01), rot);
      sg.add(box(0.01, dishR * 1.5, 0.004), P.W, dish.on(0.01), rot);
      const n = U ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2 + 0.3, c = Math.cos(a), s = Math.sin(a), y = -0.3 + (i % 2) * 0.07;
        strut(hm, [c * 0.03, y, s * 0.03], [c * 0.16, y, s * 0.16], 0.018, P.H);
        const F = frame(hm, hg, c * 0.19, y, s * 0.19, -a);
        F.m(box(0.08, 0.05, 0.05), P.P, [0, 0, 0], rz(-0.4));
        F.g(cyl(0.02, 0.02, 0.012, 8), P.W, xf([0, 0, 0], rz(-0.4), [0.041, 0, 0]), [0, 0, -0.4 - PI / 2]);
        F.g(box(0.06, 0.01, 0.052), P.A, xf([0, 0, 0], rz(-0.4), [0, 0.026, 0]), rz(-0.4));
      }
    }
    out.head.muzzle = [0, spinY + dish.center[1], 0];
  },

  // AMPLIFIER - stepped diamond pyramid (square turned 45 degrees), obelisk crowned by a floating crystal core. Tall, green.
  amp({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, out }) {
    out.head.aims = false;
    bm.add(cyl(0.4, 0.42, 0.06, 4), P.D, [0, 0.03, 0]);
    band(bg, 4, 0.424, 0.034, 0.016, P.A);
    bm.add(cyl(0.3, 0.37, 0.07, 4), P.K, [0, 0.095, 0]);
    bm.add(cyl(0.22, 0.26, 0.06, 4), P.P, [0, 0.16, 0]);
    const top = 0.19;
    inlay(bm, bg, 4, 0.21, top, 0.026, P.L, P.A);
    if (L >= 3) inlay(bm, bg, 4, 0.36, 0.06, 0.02, P.K, P.A);
    if (L >= 2) for (let i = 0; i < 4; i++) {
      // beacons on the diamond's points
      const a = (i / 4) * PI * 2;
      bm.add(cyl(0.03, 0.04, 0.05, 4), P.L, polar(a, 0.37, 0.085));
      bg.add(octa(0.03), E ? P.G : P.A, polar(a, 0.37, 0.14), null, [1, 1.7, 1]);
    }
    if (U) {
      // a floating diamond frame around the obelisk
      polyFrame(bg, 4, 0.42, 0.34, 0.018, 0.018, P.A);
      polyFrame(bg, 4, 0.36, 0.42, 0.01, 0.01, P.T);
    }
    out.head.y = top;
    const oh = 0.44;
    hm.add(cyl(0.055, 0.1, oh, 4), P.L, [0, oh / 2, 0]);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2;
      strut(hg, polar(a, 0.1, 0.02), polar(a, 0.055, oh - 0.02), 0.014, P.A);
    }
    hm.add(cyl(0.12, 0.06, 0.05, 4), P.P, [0, oh + 0.025, 0]);
    hg.add(cyl(0.122, 0.122, 0.012, 4, true), P.A, [0, oh + 0.044, 0]);
    const fins = L >= 2 || spec ? 4 : 0;
    for (let i = 0; i < fins; i++) {
      const a = (i / 4) * PI * 2 + PI / 4;
      hm.add(box(0.03, 0.2, 0.08), P.P, polar(a, 0.1, 0.1), [0, a, 0]);
      hg.add(box(0.034, 0.14, 0.02), P.S, polar(a, 0.1, 0.11), [0, a, 0]);
    }
    const sy = oh + 0.2;
    out.spin = { pos: [0, sy, 0], axis: 'y', speed: 1.4 };
    const core = spec === 'a' ? (U ? 0.14 : 0.12) : 0.08 + L * 0.012;
    sg.add(octa(core), L >= 3 || spec ? P.G : P.A, [0, 0, 0], null, [1, 1.7, 1]);
    sg.add(octa(core * 0.3), P.W, [0, core * 1.7 + 0.03, 0], null, [1, 1.7, 1]);
    sg.add(octa(core * 0.3), P.W, [0, -core * 1.7 - 0.03, 0], null, [1, 1.7, 1]);
    const rings = spec ? (U ? 4 : 3) : L;
    for (let i = 0; i < rings; i++) {
      sg.add(torus(0.17 + i * 0.055, i === 3 ? 0.009 : 0.012, 4, 30), i % 2 ? P.T : P.A, [0, 0, 0], [PI / 2 + (i - 1) * 0.5, i * 0.7, 0]);
    }
    if (spec === 'a') {
      const n = U ? 6 : 4, R = U ? 0.4 : 0.33;
      for (let i = 0; i < n; i++) sg.add(octa(U ? 0.045 : 0.038), i % 2 ? P.G : P.A, polar((i / n) * PI * 2, R, 0), null, [1, 1.7, 1]);
      if (U) for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + PI / 4;
        hm.add(cone(0.024, 0.1, 4), P.H, polar(a, 0.1, oh + 0.09), aimY([0, 0, 0], [Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4]));
        hg.add(octa(0.018), P.W, polar(a, 0.12, oh + 0.15));
      }
    }
    if (spec === 'b') {
      // salvage: a collector funnel under the core with orbiting resource cubes
      hm.add(cyl(U ? 0.24 : 0.2, 0.06, U ? 0.12 : 0.1, 12), P.L, [0, oh + 0.1, 0]);
      hg.add(torus(U ? 0.24 : 0.2, 0.012, 3, 30), P.A, [0, oh + (U ? 0.16 : 0.15), 0], rx(PI / 2));
      const n = U ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2 + PI / n;
        sg.add(box(0.05, 0.05, 0.05), i % 2 ? P.T : P.A, polar(a, U ? 0.4 : 0.34, i % 2 ? 0.04 : -0.04), [0.6, a, 0.6]);
      }
      if (U) sg.add(torus(0.4, 0.008, 3, 40), P.A, [0, 0, 0], rx(PI / 2));
    }
    out.head.muzzle = [0, sy, 0];
  },

  // DRONE CARRIER - the widest footprint: an octagonal flight deck with launch bays, a small control tower. Low, royal blue.
  carrier({ bm, bg, hm, hg, sm, sg, L, spec, E, U, P, accent, out }) {
    out.head.aims = false;
    const OC = PI / 8, deck = 0.1;
    bm.add(cyl(0.42, 0.43, 0.06, 8), P.D, [0, 0.03, 0], ry(OC));
    band(bg, 8, 0.434, 0.034, 0.016, P.A, OC);
    bm.add(cyl(0.39, 0.42, 0.04, 8), P.K, [0, 0.08, 0], ry(OC));
    polyFrame(bg, 8, 0.375, deck + 0.004, 0.024, 0.012, P.A, OC);
    if (U) {
      bg.add(cyl(0.433, 0.433, 0.012, 8, true), P.G, [0, 0.008, 0], ry(OC));
      for (let i = 0; i < 8; i++) bg.add(box(0.03, 0.014, 0.03), P.W, polar(OC + (i * PI) / 4, 0.375, deck + 0.006), ry(OC + (i * PI) / 4));
    }
    if (spec === 'a') {
      // swarm bay: honeycomb hangar of hex cells with glowing open tops, swarm darts perched on the rim
      const r = 0.07, d = r * Math.sqrt(3);
      const cells = [[0, 0, 0.14]];
      for (let i = 0; i < 6; i++) { const a = PI / 6 + (i * PI) / 3; cells.push([Math.sin(a) * d, Math.cos(a) * d, 0.08 + (i % 2) * 0.025]); }
      if (U) for (let i = 0; i < 6; i++) { const a = (i * PI) / 3; cells.push([Math.sin(a) * d * 1.72, Math.cos(a) * d * 1.72, 0.05]); }
      for (const [x, z, h] of cells) {
        bm.add(cyl(r * 0.96, r * 0.96, h, 6), P.P, [x, deck + h / 2, z]);
        bm.add(cyl(r * 0.985, r * 0.985, 0.014, 6, true), P.L, [x, deck + h - 0.007, z]);
        bg.add(cyl(r * 0.64, r * 0.64, 0.01, 6), U ? P.G : P.A, [x, deck + h + 0.001, z]);
      }
      const sw = droneParts('swarm', accent);
      for (const k of U ? [1, 2, 3, 4, 5, 6] : [1, 4]) {
        const [x, z, h] = cells[k], yaw = Math.atan2(x, z);
        placeRaw(bm, sw.metal, [x, deck + h + 0.018, z], yaw, 1.05);
        placeRaw(bg, sw.glow, [x, deck + h + 0.018, z], yaw, 1.05);
      }
      const top = deck + 0.14;
      out.head.y = top;
      hm.add(cyl(0.022, 0.03, 0.1, 6), P.H, [0, 0.05, 0]);
      hg.add(cyl(0.034, 0.034, 0.012, 6, true), P.A, [0, 0.04, 0]);
      radarBar(sm, sg, P, U ? 1.2 : 1);
      if (U) {
        // nano swarm: orbiting particle ring rides on the spinner
        sg.add(torus(0.33, 0.006, 3, 48), P.A, [0, -0.08, 0], rx(PI / 2));
        for (let i = 0; i < 12; i++) { const a = (i / 12) * PI * 2; sg.add(octa(0.022), i % 3 ? P.A : P.W, polar(a, 0.33, -0.08 + (i % 2 ? 0.024 : -0.024))); }
      }
      out.spin = { pos: [0, 0.1, 0], axis: 'y', speed: 2.4 };
      out.head.muzzle = [0, 0.1, 0];
      return;
    }
    if (spec === 'b') {
      // gunship dock: landing pad with the docked gunship (idles on the pad), clamp towers and a crane
      const py = deck + 0.04, pz = 0.0;
      bm.add(cyl(0.2, 0.22, 0.04, 8), P.P, [0, deck + 0.02, pz], ry(OC));
      bg.add(cyl(0.165, 0.165, 0.006, 8), P.S, [0, py + 0.003, pz], ry(OC));
      bg.add(torus(0.18, 0.008, 3, 32), P.A, [0, py + 0.004, pz], rx(PI / 2));
      for (let i = 0; i < 8; i++) bg.add(box(0.02, 0.008, 0.02), i % 2 ? P.W : P.A, polar((i / 8) * PI * 2, 0.145, py + 0.008).map((v, k) => (k === 2 ? v + pz : v)));
      for (let i = 0; i < 4; i++) {
        const a = PI / 4 + (i * PI) / 2;
        const F = frame(bm, bg, Math.sin(a) * 0.26, 0, pz + Math.cos(a) * 0.26, a - PI / 2);
        const th = U ? 0.26 : 0.17;
        F.m(box(0.07, th, 0.08), P.K, [0, deck + th / 2, 0]);
        F.m(box(0.12, 0.035, 0.05), P.P, [-0.045, deck + th - 0.01, 0]);
        F.g(box(0.02, 0.02, 0.052), P.A, [-0.105, deck + th - 0.01, 0]);
        F.g(box(0.012, th * 0.6, 0.012), P.A, [0.036, deck + th * 0.5, 0]);
        if (U) F.g(octa(0.026), P.W, [0, deck + th + 0.04, 0], null, [1, 1.5, 1]);
      }
      const ch = U ? 0.48 : 0.4, cz = -0.285;
      bm.add(box(0.06, ch, 0.06), P.L, [0, deck + ch / 2, cz]);
      bm.add(box(0.045, 0.045, 0.24), P.L, [0, deck + ch - 0.03, cz + 0.1]);
      bg.add(box(0.012, 0.012, 0.2), P.A, [0, deck + ch - 0.004, cz + 0.1]);
      if (U) {
        bm.add(box(0.045, 0.045, 0.24), P.L, [0, deck + ch - 0.11, cz + 0.1]);
        bg.add(box(0.012, 0.012, 0.2), P.A, [0, deck + ch - 0.084, cz + 0.1]);
        bg.add(sphere(0.022, 6, 4), P.W, [0, deck + ch + 0.02, cz]);
      }
      // the gunship is the (slowly turning) head, parked just above the pad
      out.head.y = py + 0.07;
      const gs = droneParts('gunship', accent);
      placeRaw(hm, gs.metal, [0, 0, 0], 0, U ? 1.2 : 1.05);
      placeRaw(hg, gs.glow, [0, 0, 0], 0, U ? 1.2 : 1.05);
      out.head.muzzle = [0, 0.08, 0];
      return;
    }
    // launch bays with parked drones around a control tower
    const n = L + 1, R = n >= 4 ? 0.2 : 0.19, s = n >= 4 ? 0.135 : n === 3 ? 0.145 : 0.155;
    const phase = n === 4 ? PI / 4 : n === 3 ? 0 : PI / 2;
    let first = null;
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * PI * 2;
      const F = frame(bm, bg, Math.sin(a) * R, 0, Math.cos(a) * R, a - PI / 2);
      const t = launchPad(F, bm, bg, s, P, deck, 'drone', n >= 4 ? 0.85 : 0.95, accent);
      if (!first) first = t;
    }
    out.head.y = deck;
    const th = 0.22 + L * 0.04;
    hm.add(cyl(0.05, 0.078, th, 6), P.L, [0, th / 2, 0]);
    hm.add(cyl(0.09, 0.07, 0.07, 6), P.P, [0, th - 0.025, 0]);
    hg.add(cyl(0.088, 0.081, 0.026, 6), P.A, [0, th - 0.02, 0]);
    hm.add(cyl(0.055, 0.09, 0.03, 6), P.L, [0, th + 0.025, 0]);
    for (let i = 0; i < 3; i++) { const a = (i / 3) * PI * 2 + PI / 6; hg.add(box(0.014, th * 0.5, 0.014), P.A, polar(a, 0.066, th * 0.4), [0, a, 0]); }
    if (L >= 3) {
      hm.add(cyl(0.005, 0.005, 0.16, 4), P.H, [0.05, th + 0.1, 0]);
      hg.add(sphere(0.014, 6, 4), P.W, [0.05, th + 0.185, 0]);
    }
    radarBar(sm, sg, P, 1);
    out.spin = { pos: [0, th + 0.04, 0], axis: 'y', speed: 2.4 };
    out.head.muzzle = [first[0], first[1] - deck, first[2]];
  },

  // MINE LAYER - the lowest tower: a round dome with glowing mine hatches and contact horns, a stubby launcher. Aqua.
  mines({ bm, bg, hm, hg, L, spec, E, U, P, out }) {
    const R = 0.34, SY = 0.4;
    bm.add(cyl(R + 0.025, R + 0.04, 0.03, 20), P.D, [0, 0.015, 0]);
    band(bg, 20, R + 0.043, 0.018, 0.014, P.A);
    bm.add(dome(R, 20, 5), P.P, [0, 0.03, 0], null, [1, SY, 1]);
    const top = 0.03 + R * SY;
    bg.add(torus(R * 0.93, 0.008, 3, 28), P.A, [0, 0.03 + R * SY * Math.cos(Math.asin(0.93)) + 0.002, 0], rx(PI / 2));
    // a point on the dome at polar angle th (from the top) and heading a, with its surface normal
    const onDome = (a, th, lift = 0) => {
      const n = [Math.sin(th) * Math.sin(a), Math.cos(th) / SY, Math.sin(th) * Math.cos(a)];
      const l = Math.hypot(n[0], n[1], n[2]);
      const nn = [n[0] / l, n[1] / l, n[2] / l];
      const p = [R * Math.sin(th) * Math.sin(a), 0.03 + R * SY * Math.cos(th), R * Math.sin(th) * Math.cos(a)];
      return { p: [p[0] + nn[0] * lift, p[1] + nn[1] * lift, p[2] + nn[2] * lift], n: nn };
    };
    const hatches = L >= 3 ? 6 : L >= 2 ? 4 : 3;
    for (let i = 0; i < hatches; i++) {
      const a = (i / hatches) * PI * 2 + PI / hatches;
      const h = onDome(a, 1.0, 0.004);
      const rot = aimY([0, 0, 0], h.n);
      bm.add(cyl(0.052, 0.056, 0.012, 8), P.K, h.p, rot);
      bg.add(cyl(0.036, 0.036, 0.016, 8), P.A, h.p, rot);
    }
    if (L >= 2) {
      const horns = L >= 3 ? 6 : 4;
      for (let i = 0; i < horns; i++) {
        const a = (i / horns) * PI * 2;
        const h = onDome(a, 1.32, 0.02);
        const rot = aimY([0, 0, 0], h.n);
        bm.add(cyl(0.012, 0.018, 0.05, 6), P.L, h.p, rot);
        bg.add(sphere(0.017, 5, 3), E ? P.G : P.A, xf(h.p, rot, [0, 0.03, 0]));
      }
    }
    if (U) {
      if (spec === 'a') {
        // chain grid: floating mines linked by a glowing net around the dome
        const pts = [];
        for (let i = 0; i < 6; i++) pts.push(polar((i / 6) * PI * 2 + PI / 6, 0.385, 0.13 + (i % 2) * 0.04));
        for (let i = 0; i < 6; i++) {
          bm.add(cyl(0.034, 0.038, 0.018, 6), P.K, pts[i]);
          bg.add(cyl(0.04, 0.04, 0.008, 6, true), P.A, pts[i]);
          bg.add(octa(0.014), P.W, [pts[i][0], pts[i][1] + 0.016, pts[i][2]]);
          strut(bg, pts[i], pts[(i + 1) % 6], 0.008, P.G);
        }
      } else for (const r of [0.398, 0.425]) bg.add(torus(r, 0.007, 3, 44), P.G, [0, 0.012, 0], rx(PI / 2));
    }
    out.head.y = top - 0.012;
    hm.add(cyl(0.155, 0.175, 0.035, 14), P.P, [0, 0.0175, 0]);
    hg.add(cyl(0.177, 0.177, 0.012, 14, true), P.A, [0, 0.022, 0]);
    const elev = 0.3;
    const tube = (x, len, w, y = 0.075, z = 0.04) => {
      const c = [x, y, z], rot = rx(-elev);
      hm.add(box(w, w, len), P.K, c, rot);
      hm.add(box(w + 0.016, w + 0.016, 0.03), P.H, xf(c, rot, [0, 0, len / 2 - 0.015]), rot);
      hg.add(cyl(w * 0.36, w * 0.36, 0.01, 8), P.A, xf(c, rot, [0, 0, len / 2 + 0.001]), rx(PI / 2 - elev));
      hg.add(box(w * 0.5, 0.01, len * 0.5), P.A, xf(c, rot, [0, w / 2 + 0.003, -0.03]), rot);
      return { c, rot, mouth: xf(c, rot, [0, 0, len / 2 + 0.03]) };
    };
    const stack = (x, z, n) => {
      for (let i = 0; i < n; i++) {
        const y = 0.047 + 0.026 * i;
        hm.add(cyl(0.05, 0.05, 0.02, 8), P.L, [x, y, z]);
        hg.add(cyl(0.052, 0.052, 0.007, 8, true), P.A, [x, y, z]);
      }
      hg.add(sphere(0.02, 6, 3), P.W, [x, 0.047 + 0.026 * (n - 1) + 0.012, z], null, [1, 0.5, 1]);
      for (const dx of [-0.06, 0.06]) hm.add(box(0.012, 0.026 * n + 0.03, 0.012), P.H, [x + dx, 0.035 + 0.013 * n, z]);
    };
    if (spec === 'a') {
      // EMP mines: coil-wrapped tube(s) and tesla prongs
      const tubes = U ? [-0.06, 0.06] : [0];
      const ms = tubes.map((x) => {
        const w = U ? 0.07 : 0.09;
        const t = tube(x, 0.28, w);
        for (const d of [-0.06, 0.04]) hg.add(torus(w * 0.64, 0.01, 4, 12), P.A, xf(t.c, t.rot, [0, 0, d]), t.rot);
        return t.mouth;
      });
      out.head.muzzle = U ? [0, ms[0][1], ms[0][2]] : ms[0];
      stack(-0.09, -0.1, 3);
      stack(0.09, -0.1, 3);
      const prong = (x, z, h) => {
        hm.add(cyl(0.008, 0.013, h, 5), P.H, [x, 0.035 + h / 2, z]);
        hm.add(torus(0.022, 0.006, 3, 8), P.H, [x, 0.035 + h * 0.7, z], rx(PI / 2));
        hg.add(sphere(0.026, 6, 4), P.W, [x, 0.035 + h + 0.01, z]);
        return [x, 0.035 + h + 0.01, z];
      };
      if (U) {
        const A = prong(-0.17, -0.05, 0.2), B = prong(0.17, -0.05, 0.2);
        const mids = [[-0.06, A[1] + 0.05, -0.05], [0.05, A[1] - 0.04, -0.05]];
        strut(hg, A, mids[0], 0.012, P.A);
        strut(hg, mids[0], mids[1], 0.012, P.W);
        strut(hg, mids[1], B, 0.012, P.A);
      } else prong(0.15, 0.0, 0.17);
      return;
    }
    if (spec === 'b') {
      // cluster / seismic: revolver drum magazine (glowing chambers) feeding a fat tube
      const t = tube(0, U ? 0.32 : 0.28, U ? 0.12 : 0.1, U ? 0.09 : 0.08, U ? 0.07 : 0.05);
      out.head.muzzle = t.mouth;
      const dc = [0, 0.08, -0.13], dr = U ? 0.11 : 0.095;
      hm.add(cyl(dr, dr, 0.08, 12), P.P, dc);
      hm.add(cyl(dr * 0.4, dr * 0.4, 0.1, 8), P.H, dc);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * PI * 2;
        hg.add(cyl(0.022, 0.022, 0.01, 8), P.A, [dc[0] + Math.cos(a) * dr * 0.62, dc[1] + 0.041, dc[2] + Math.sin(a) * dr * 0.62]);
      }
      hg.add(cyl(dr + 0.003, dr + 0.003, 0.014, 12, true), P.A, dc);
      if (U) {
        // seismic charges: drill-tipped charge in the mouth, thumper piston
        hg.add(cone(0.04, 0.09, 8), P.W, xf(t.c, t.rot, [0, 0, 0.18]), rx(PI / 2 - elev));
        hm.add(cyl(0.045, 0.045, 0.1, 8), P.L, [0, 0.17, -0.13]);
        hm.add(cyl(0.026, 0.026, 0.08, 8), P.H, [0, 0.26, -0.13]);
        for (const y of [0.14, 0.2]) hg.add(cyl(0.048, 0.048, 0.012, 8, true), P.A, [0, y, -0.13]);
        hg.add(sphere(0.022, 6, 4), P.W, [0, 0.31, -0.13]);
      } else stack(0.13, -0.1, 2);
      return;
    }
    let mouth;
    if (L >= 3) {
      const a = tube(-0.055, 0.28, 0.072), b = tube(0.055, 0.28, 0.072);
      mouth = [0, (a.mouth[1] + b.mouth[1]) / 2, a.mouth[2]];
      hm.add(cyl(0.005, 0.005, 0.16, 4), P.H, [-0.13, 0.13, -0.1]);
      hg.add(sphere(0.015, 6, 4), P.W, [-0.13, 0.215, -0.1]);
    } else mouth = tube(0, 0.28, 0.082).mouth;
    out.head.muzzle = mouth;
    if (L >= 2) { stack(-0.09, -0.1, 3); stack(0.09, -0.1, 3); }
    else stack(0, -0.11, 3);
  },
};

// ---------------------------------------------------------------- drones & mines (instanced by the view)
const TEAL = 0x3dffea;
const droneCache = new Map();
// Per-kind metal/glow geometries (colors baked). Nose toward +z, centered at the origin.
// tint (optional) recolors the neon parts, e.g. drones parked on a carrier deck in the carrier's color.
function droneParts(kind, tint = null) {
  const key = tint === null ? kind : `${kind}|${tint}`;
  let d = droneCache.get(key);
  if (d) return d;
  const T = tint ?? TEAL, T2 = tint ?? 0xbffcff, T3 = tint ?? 0xffc070;
  const m = new GeoBuilder(), g = new GeoBuilder();
  if (kind === 'swarm') {
    m.add(cone(0.03, 0.11, 4), M4, [0, 0, 0.012], rx(PI / 2), [1, 1, 0.5]);
    m.add(box(0.12, 0.006, 0.032), M3, [0, 0, -0.02]);
    sym(m, () => box(0.006, 0.026, 0.03), M3, [0.058, 0.008, -0.026]);
    g.add(sphere(0.017, 6, 4), T, [0, 0, -0.048]);
    g.add(sphere(0.008, 4, 3), WHITE, [0, 0, -0.058]);
    sym(g, () => box(0.014, 0.008, 0.016), WHITE, [0.06, 0, -0.018]);
    g.add(box(0.008, 0.006, 0.03), T, [0, 0.008, 0.03]);
  } else if (kind === 'gunship') {
    m.add(box(0.09, 0.07, 0.2), M2, [0, 0, -0.01]);
    m.add(cone(0.06, 0.11, 4), M3, [0, 0, 0.14], [PI / 2, 0, 0], [1, 1, 0.65]);
    m.add(box(0.07, 0.03, 0.12), M3, [0, 0.045, -0.02]);
    m.add(box(0.25, 0.016, 0.07), M1, [0, -0.008, 0.0]);
    sym(m, () => cyl(0.026, 0.026, 0.11, 6), M3, [0.1, -0.03, 0.03], rx(PI / 2));
    sym(m, () => torus(0.04, 0.01, 3, 10), M2, [0.14, 0, -0.035], rx(PI / 2));
    m.add(box(0.012, 0.07, 0.07), M2, [0, 0.05, -0.1]);
    sym(m, () => box(0.06, 0.012, 0.05), M2, [0.035, 0.02, -0.11]);
    g.add(box(0.05, 0.022, 0.05), T2, [0, 0.03, 0.09], rx(-0.35));
    sym(g, () => cyl(0.018, 0.018, 0.01, 8), T3, [0.1, -0.03, 0.087], rx(PI / 2));
    sym(g, () => cyl(0.032, 0.032, 0.006, 10), T, [0.14, 0, -0.035]);
    sym(g, () => cyl(0.016, 0.016, 0.01, 6), WHITE, [0.028, 0, -0.112], rx(PI / 2));
    g.add(box(0.2, 0.006, 0.01), T, [0, 0.002, 0.036]);
  } else {
    // quad fighter drone
    m.add(octa(0.045), M4, [0, 0, 0.005], null, [1, 0.55, 1.9]);
    m.add(box(0.2, 0.012, 0.018), M2, [0, 0, -0.005], ry(0.7));
    m.add(box(0.2, 0.012, 0.018), M2, [0, 0, -0.005], ry(-0.7));
    for (const [x, z] of [[0.076, 0.059], [-0.076, 0.059], [0.076, -0.069], [-0.076, -0.069]]) {
      m.add(cyl(0.012, 0.012, 0.02, 4), M3, [x, 0.005, z]);
      g.add(torus(0.03, 0.006, 3, 9), T, [x, 0.012, z], rx(PI / 2));
    }
    g.add(octa(0.018), WHITE, [0, 0.016, 0.05]);
    g.add(cyl(0.014, 0.014, 0.02, 6), T, [0, 0, -0.085], rx(PI / 2));
  }
  d = { metal: m.build(), glow: g.build() };
  droneCache.set(key, d);
  return d;
}

const droneModelCache = new Map();
// kind: 'drone' | 'swarm' | 'gunship' -> { geo } (position/normal/color/aGlow; use emissiveVertexMat)
export function droneModel(kind = 'drone') {
  let d = droneModelCache.get(kind);
  if (!d) {
    const p = droneParts(kind === 'swarm' || kind === 'gunship' ? kind : 'drone');
    d = { geo: mergeGlow(p.metal.clone(), p.glow.clone()) };
    droneModelCache.set(kind, d);
  }
  return d;
}

const mineCache = new Map();
// kind: 'std' | 'emp' | 'cluster' -> { geo }  (~0.22 wide, bottom at y = 0)
export function mineModel(kind = 'std') {
  let d = mineCache.get(kind);
  if (d) return d;
  const m = new GeoBuilder(), g = new GeoBuilder();
  const col = kind === 'emp' ? 0x7f9dff : kind === 'cluster' ? 0xff8a1f : 0xffe03d;
  m.add(cyl(0.098, 0.11, 0.036, 8), M1, [0, 0.018, 0], ry(PI / 8));
  m.add(cyl(0.07, 0.09, 0.016, 8), M2, [0, 0.044, 0], ry(PI / 8));
  g.add(cyl(0.106, 0.106, 0.008, 8, true), col, [0, 0.022, 0], ry(PI / 8));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI / 4, c = Math.cos(a), s = Math.sin(a);
    m.add(box(0.036, 0.018, 0.024), M3, [c * 0.082, 0.046, s * 0.082], [0, -a, 0]);
    g.add(box(0.012, 0.006, 0.016), col, [c * 0.1, 0.052, s * 0.1], [0, -a, 0]);
  }
  if (kind === 'cluster') {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * PI * 2 + PI / 2, c = Math.cos(a), s = Math.sin(a);
      m.add(sphere(0.024, 6, 4), M3, [c * 0.042, 0.058, s * 0.042]);
      g.add(sphere(0.01, 4, 3), col, [c * 0.042, 0.08, s * 0.042]);
    }
    g.add(sphere(0.016, 6, 3), WHITE, [0, 0.058, 0]);
  } else {
    g.add(sphere(0.03, 8, 4), col, [0, 0.052, 0], null, [1, 0.6, 1]);
    g.add(sphere(0.012, 6, 3), WHITE, [0, 0.068, 0]);
    if (kind === 'emp') {
      g.add(torus(0.055, 0.007, 3, 16), col, [0, 0.058, 0], rx(PI / 2));
      m.add(cyl(0.004, 0.005, 0.05, 4), M4, [0.035, 0.078, -0.02]);
      g.add(sphere(0.009, 4, 3), WHITE, [0.035, 0.105, -0.02]);
    }
  }
  d = { geo: mergeGlow(m.build(), g.build()) };
  mineCache.set(kind, d);
  return d;
}

// ---------------------------------------------------------------- enemies
// parts: [{ geo, mat: 'metal'|'glow'|'shield', anim, pivot:[x,y,z] }]  (geo built around its pivot)
// anims: static | legL | legR | spinY | spinX | spinZ | flapL | flapR | pulse
//   flapL = left wing (+x side), flapR = right wing (-x side): rotate about local z at the pivot, mirrored (+a / -a).
const enemyCache = new Map();
export function enemyModel(type) {
  let m = enemyCache.get(type);
  if (!m) { m = (ENEMY_BUILDERS[type] || ENEMY_BUILDERS.walker)(); enemyCache.set(type, m); }
  return m;
}

function part(builderFn, mat, anim = 'static', pivot = [0, 0, 0]) {
  const b = new GeoBuilder();
  builderFn(b);
  return { geo: b.build(), mat, anim, pivot };
}

// Metal + glow parts from one builder function (same anim / pivot).
function parts2(fn, anim = 'static', pivot = [0, 0, 0]) {
  const m = new GeoBuilder(), g = new GeoBuilder();
  fn(m, g);
  const out = [];
  if (!m.empty) out.push({ geo: m.build(), mat: 'metal', anim, pivot });
  if (!g.empty) out.push({ geo: g.build(), mat: 'glow', anim, pivot });
  return out;
}

// Titan palette + shared upper body (chest, layered pauldrons, crowned head) for omega / omega2.
const TW1 = 0xd3d8e3, TW2 = 0xa3abbe, TW3 = 0x6a7286, TD = 0x2a2230, TG = 0xc9a24a, TR = 0xff2d4a, TRC = 0xff4a2e;
function titanUpper(m, g, cy) {
  m.add(box(0.92, 0.46, 0.54), TW1, [0, cy, 0]);
  const vp = (sx) => [sx * 0.2, cy + 0.02, 0.3];
  sym(m, () => box(0.34, 0.34, 0.08), TW1, vp(1), ry(0.35));
  sym(m, () => box(0.32, 0.03, 0.03), TG, xf(vp(1), ry(0.35), [0, 0.17, 0.03]), ry(0.35));
  m.add(torus(0.17, 0.035, 5, 16), TG, [0, cy, 0.33]);
  m.add(box(0.5, 0.08, 0.46), TD, [0, cy + 0.26, 0]);
  m.add(box(0.94, 0.05, 0.56), TG, [0, cy - 0.21, 0]);
  for (const s of [-1, 1]) {
    const tp = [s * 0.67, cy + 0.37, 0], tr = rz(-s * 0.32);
    m.add(box(0.4, 0.3, 0.5), TW2, [s * 0.64, cy + 0.2, 0], rz(-s * 0.15));
    m.add(box(0.46, 0.07, 0.56), TW1, tp, tr);
    m.add(box(0.47, 0.03, 0.57), TG, xf(tp, tr, [0, -0.048, 0]), tr);
    m.add(box(0.3, 0.06, 0.4), TW1, xf(tp, tr, [s * -0.02, 0.06, 0]), tr);
    m.add(cone(0.075, 0.32, 4), TW1, [s * 0.74, cy + 0.56, -0.08], rz(-s * 0.3));
    m.add(cone(0.05, 0.2, 4), TG, [s * 0.52, cy + 0.52, -0.14], rz(-s * 0.15));
    g.add(box(0.022, 0.022, 0.5), TR, xf(tp, tr, [s * 0.235, 0, 0]), tr);
  }
  m.add(box(0.24, 0.22, 0.26), TW1, [0, cy + 0.4, 0.04]);
  m.add(box(0.2, 0.08, 0.05), TD, [0, cy + 0.38, 0.165]);
  m.add(box(0.26, 0.06, 0.28), TG, [0, cy + 0.52, 0.04]);
  for (let i = 0; i < 5; i++) m.add(cone(0.03, 0.18 - Math.abs(i - 2) * 0.03, 4), TG, [(i - 2) * 0.055, cy + 0.62 - Math.abs(i - 2) * 0.015, 0.06], rz(-(i - 2) * 0.15));
  g.add(sphere(0.14, 12, 8), TRC, [0, cy, 0.31]);
  g.add(sphere(0.07, 8, 6), WHITE, [0, cy, 0.42]);
  g.add(box(0.16, 0.03, 0.01), TR, [0, cy + 0.385, 0.191]);
  sym(g, () => box(0.014, 0.3, 0.014), TR, xf(vp(1), ry(0.35), [-0.12, 0, 0.045]), ry(0.35));
  for (let i = 0; i < 5; i++) g.add(octa(0.016), 0xfff0c0, [(i - 2) * 0.055, cy + 0.72 - Math.abs(i - 2) * 0.045, 0.06]);
}

const E1 = 0x2a2230, E2 = 0x3d3344, E3 = 0x5c5064, RED = 0xff2d4a, ORG = 0xff7a2a;

const ENEMY_BUILDERS = {
  scout() {
    return { hover: 0.36, scale: 1.5, parts: [
      part((b) => {
        b.add(sphere(0.15, 10, 6), E2, [0, 0, 0], null, [1, 0.55, 1.2]);
        b.add(box(0.1, 0.06, 0.16), E1, [0.16, 0, -0.02]);
        b.add(box(0.1, 0.06, 0.16), E1, [-0.16, 0, -0.02]);
        b.add(box(0.06, 0.02, 0.14), E3, [0, 0.07, -0.02]);
      }, 'metal'),
      part((b) => {
        b.add(box(0.1, 0.03, 0.02), RED, [0, 0.02, 0.17]);
        b.add(cyl(0.05, 0.05, 0.02, 8), ORG, [0.16, -0.04, -0.02]);
        b.add(cyl(0.05, 0.05, 0.02, 8), ORG, [-0.16, -0.04, -0.02]);
      }, 'glow'),
      part((b) => { b.add(torus(0.2, 0.01, 3, 16), RED, [0, 0, 0], rx(PI / 2)); }, 'glow', 'spinY', [0, 0.05, 0]),
    ] };
  },
  mini() {
    const m = ENEMY_BUILDERS.scout();
    return { ...m, scale: 0.95, hover: 0.3 };
  },
  walker() {
    return { hover: 0, scale: 1.42, walk: 9, parts: [
      part((b) => {
        b.add(box(0.3, 0.2, 0.24), E2, [0, 0.44, 0]);
        b.add(box(0.2, 0.1, 0.18), E3, [0, 0.58, 0.02]);
        b.add(box(0.07, 0.07, 0.2), E1, [0.2, 0.44, 0.06]);
        b.add(box(0.07, 0.07, 0.2), E1, [-0.2, 0.44, 0.06]);
        b.add(box(0.24, 0.06, 0.12), E1, [0, 0.33, 0]);
      }, 'metal'),
      part((b) => {
        b.add(box(0.14, 0.035, 0.02), ORG, [0, 0.59, 0.112]);
        b.add(box(0.03, 0.03, 0.02), RED, [0.2, 0.44, 0.165]);
        b.add(box(0.03, 0.03, 0.02), RED, [-0.2, 0.44, 0.165]);
      }, 'glow'),
      part((b) => { b.add(box(0.07, 0.3, 0.08), E1, [0, -0.15, 0]); b.add(box(0.1, 0.03, 0.14), E3, [0, -0.3, 0.03]); }, 'metal', 'legL', [0.09, 0.33, 0]),
      part((b) => { b.add(box(0.07, 0.3, 0.08), E1, [0, -0.15, 0]); b.add(box(0.1, 0.03, 0.14), E3, [0, -0.3, 0.03]); }, 'metal', 'legR', [-0.09, 0.33, 0]),
    ] };
  },
  flyer() {
    return { hover: 0, scale: 1.42, bank: true, parts: [
      part((b) => {
        b.add(cyl(0.07, 0.1, 0.5, 6), E2, [0, 0, 0], rx(PI / 2));
        b.add(cone(0.07, 0.16, 6), E3, [0, 0, 0.32], rx(PI / 2));
        b.add(box(0.62, 0.025, 0.18), E1, [0, 0, -0.04]);
        b.add(box(0.2, 0.02, 0.1), E1, [0, 0.03, -0.24]);
        b.add(box(0.02, 0.12, 0.1), E3, [0, 0.07, -0.22]);
        b.add(cyl(0.05, 0.05, 0.16, 6), E1, [0.26, -0.02, -0.06], rx(PI / 2));
        b.add(cyl(0.05, 0.05, 0.16, 6), E1, [-0.26, -0.02, -0.06], rx(PI / 2));
      }, 'metal'),
      part((b) => {
        b.add(cyl(0.035, 0.035, 0.02, 6), ORG, [0.26, -0.02, -0.145], rx(PI / 2));
        b.add(cyl(0.035, 0.035, 0.02, 6), ORG, [-0.26, -0.02, -0.145], rx(PI / 2));
        b.add(box(0.05, 0.03, 0.1), RED, [0, 0.05, 0.12]);
        b.add(box(0.6, 0.008, 0.02), RED, [0, 0.014, 0.05]);
      }, 'glow'),
    ] };
  },
  shield() {
    return { hover: 0.42, scale: 1.42, parts: [
      part((b) => {
        b.add(ico(0.14, 0), E2, [0, 0, 0]);
        b.add(cyl(0.2, 0.2, 0.04, 8), E1, [0, -0.02, 0]);
        b.add(box(0.04, 0.2, 0.04), E3, [0, -0.16, 0]);
      }, 'metal'),
      part((b) => {
        b.add(sphere(0.06, 8, 6), 0x6aa8ff, [0, 0.02, 0.12]);
        b.add(cyl(0.205, 0.205, 0.015, 8, true), 0x6a8cff, [0, -0.02, 0]);
      }, 'glow'),
      part((b) => { b.add(torus(0.24, 0.012, 3, 20), 0x6a8cff, [0, 0, 0], rx(PI / 2 + 0.4)); }, 'glow', 'spinY', [0, 0, 0]),
      part((b) => { b.add(sphere(0.4, 16, 10), 0xffffff, [0, 0, 0]); }, 'shield'),
    ] };
  },
  stalker() {
    return { hover: 0, scale: 1.42, walk: 14, parts: [
      part((b) => {
        b.add(sphere(0.12, 8, 6), E2, [0, 0.26, 0], null, [1, 0.7, 2]);
        b.add(box(0.1, 0.06, 0.12), E3, [0, 0.3, 0.2]);
        for (const s of [1, -1]) for (const z of [0.12, -0.12]) b.add(box(0.025, 0.28, 0.025), E1, [s * 0.14, 0.14, z], [0, 0, s * 0.6]);
      }, 'metal'),
      part((b) => {
        b.add(box(0.05, 0.02, 0.3), 0xb04dff, [0, 0.35, -0.02]);
        b.add(box(0.07, 0.025, 0.02), 0xe070ff, [0, 0.31, 0.262]);
      }, 'glow'),
    ] };
  },
  medic() {
    return { hover: 0.4, scale: 1.42, parts: [
      part((b) => {
        b.add(box(0.18, 0.12, 0.18), E2, [0, 0, 0]);
        for (let i = 0; i < 4; i++) { const a = (i / 4) * PI * 2; b.add(box(0.2, 0.04, 0.06), E1, [Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16], [0, -a, 0]); }
      }, 'metal'),
      part((b) => {
        b.add(box(0.1, 0.02, 0.03), 0x3dff8a, [0, 0.07, 0]);
        b.add(box(0.03, 0.02, 0.1), 0x3dff8a, [0, 0.07, 0]);
        for (let i = 0; i < 4; i++) { const a = (i / 4) * PI * 2; b.add(sphere(0.03, 6, 4), 0x3dff8a, [Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26]); }
      }, 'glow'),
      part((b) => { b.add(torus(0.3, 0.01, 3, 24), 0x3dff8a, [0, 0, 0], rx(PI / 2)); }, 'glow', 'spinY', [0, -0.08, 0]),
    ] };
  },
  splitter() {
    return { hover: 0.3, scale: 1.42, parts: [
      part((b) => {
        b.add(cyl(0.3, 0.26, 0.18, 6), E2, [0, 0, 0]);
        b.add(cyl(0.2, 0.3, 0.08, 6), E1, [0, -0.12, 0]);
        for (let i = 0; i < 3; i++) { const a = (i / 3) * PI * 2 + 0.5; b.add(sphere(0.08, 8, 6), E3, [Math.cos(a) * 0.17, 0.12, Math.sin(a) * 0.17]); }
      }, 'metal'),
      part((b) => {
        b.add(cyl(0.305, 0.305, 0.02, 6, true), 0xffd23d, [0, 0.02, 0]);
        for (let i = 0; i < 3; i++) { const a = (i / 3) * PI * 2 + 0.5; b.add(sphere(0.03, 6, 4), 0xffd23d, [Math.cos(a) * 0.17, 0.18, Math.sin(a) * 0.17]); }
        b.add(box(0.12, 0.03, 0.02), RED, [0, 0.02, 0.28]);
      }, 'glow'),
    ] };
  },
  tank() {
    return { hover: 0, scale: 1.42, parts: [
      part((b) => {
        b.add(box(0.46, 0.14, 0.64), E2, [0, 0.16, 0]);
        b.add(box(0.13, 0.16, 0.7), E1, [0.26, 0.1, 0]);
        b.add(box(0.13, 0.16, 0.7), E1, [-0.26, 0.1, 0]);
        b.add(box(0.28, 0.12, 0.3), E3, [0, 0.29, -0.04]);
        b.add(cyl(0.035, 0.04, 0.4, 6), E1, [0, 0.3, 0.3], rx(PI / 2));
        b.add(box(0.36, 0.05, 0.1), E1, [0, 0.2, 0.33]);
      }, 'metal'),
      part((b) => {
        b.add(box(0.3, 0.02, 0.02), RED, [0, 0.19, 0.325]);
        b.add(box(0.02, 0.02, 0.5), ORG, [0.195, 0.2, 0]);
        b.add(box(0.02, 0.02, 0.5), ORG, [-0.195, 0.2, 0]);
        b.add(box(0.1, 0.03, 0.02), RED, [0, 0.31, 0.112]);
      }, 'glow'),
    ] };
  },
  colossus() {
    return { hover: 0, scale: 1, walk: 4, parts: [
      part((b) => {
        b.add(box(0.8, 0.5, 0.56), E2, [0, 1.05, 0]);
        b.add(box(0.5, 0.26, 0.4), E3, [0, 1.38, 0.04]);
        b.add(box(0.26, 0.26, 0.5), E1, [0.56, 1.14, 0.04]);
        b.add(box(0.26, 0.26, 0.5), E1, [-0.56, 1.14, 0.04]);
        b.add(cyl(0.06, 0.07, 0.5, 6), E3, [0.56, 1.14, 0.44], rx(PI / 2));
        b.add(cyl(0.06, 0.07, 0.5, 6), E3, [-0.56, 1.14, 0.44], rx(PI / 2));
        b.add(box(0.6, 0.2, 0.4), E1, [0, 0.74, 0]);
        b.add(box(0.2, 0.3, 0.2), E1, [0, 1.3, -0.3]);
      }, 'metal'),
      part((b) => {
        b.add(box(0.36, 0.06, 0.02), RED, [0, 1.42, 0.242]);
        b.add(sphere(0.1, 10, 8), 0xff3a20, [0, 1.06, 0.29]);
        b.add(cyl(0.075, 0.075, 0.02, 8), ORG, [0.56, 1.14, 0.7], rx(PI / 2));
        b.add(cyl(0.075, 0.075, 0.02, 8), ORG, [-0.56, 1.14, 0.7], rx(PI / 2));
        b.add(box(0.82, 0.03, 0.02), ORG, [0, 0.86, 0.285]);
      }, 'glow'),
      part((b) => { b.add(box(0.2, 0.62, 0.24), E1, [0, -0.31, 0]); b.add(box(0.28, 0.08, 0.38), E3, [0, -0.62, 0.06]); b.add(box(0.21, 0.04, 0.1), ORG, [0, -0.2, 0.12]); }, 'metal', 'legL', [0.24, 0.66, 0]),
      part((b) => { b.add(box(0.2, 0.62, 0.24), E1, [0, -0.31, 0]); b.add(box(0.28, 0.08, 0.38), E3, [0, -0.62, 0.06]); b.add(box(0.21, 0.04, 0.1), ORG, [0, -0.2, 0.12]); }, 'metal', 'legR', [-0.24, 0.66, 0]),
    ] };
  },
  mothership() {
    return { hover: 0, scale: 1, parts: [
      part((b) => {
        b.add(cyl(0.85, 0.6, 0.2, 16), E2, [0, 0, 0]);
        b.add(cyl(0.45, 0.8, 0.12, 16), E1, [0, 0.16, 0]);
        b.add(sphere(0.34, 14, 8), E3, [0, 0.22, 0], null, [1, 0.5, 1]);
        b.add(cyl(0.4, 0.3, 0.14, 12), E1, [0, -0.16, 0]);
        for (let i = 0; i < 4; i++) { const a = (i / 4) * PI * 2 + PI / 4; b.add(box(0.2, 0.08, 0.4), E3, [Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8], [0, -a, 0]); }
      }, 'metal'),
      part((b) => {
        b.add(cyl(0.852, 0.852, 0.03, 16, true), RED, [0, 0.03, 0]);
        b.add(sphere(0.12, 10, 8), 0xff3a60, [0, 0.36, 0]);
        for (let i = 0; i < 12; i++) { const a = (i / 12) * PI * 2; b.add(box(0.05, 0.03, 0.05), ORG, [Math.cos(a) * 0.62, 0.2, Math.sin(a) * 0.62]); }
      }, 'glow'),
      part((b) => {
        b.add(torus(0.36, 0.03, 4, 24), 0xff2d6f, [0, 0, 0], rx(PI / 2));
        for (let i = 0; i < 6; i++) { const a = (i / 6) * PI * 2; b.add(box(0.06, 0.04, 0.06), 0xffd0e0, [Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36]); }
      }, 'glow', 'spinY', [0, -0.25, 0]),
    ] };
  },

  // ---- new enemies
  // Cloaked assassin: slim spectral stalker with energy-blade arms and cyan-white glow lines.
  phantom() {
    const P1 = 0x1f2338, P2 = 0x363d62, P3 = 0x5a6490, CY = 0x8ff0ff, CW = 0xe6fdff;
    const leg = (b) => {
      b.add(box(0.044, 0.2, 0.052), P2, [0, -0.1, 0]);
      b.add(box(0.038, 0.15, 0.042), P1, [0, -0.25, -0.015], rx(-0.18));
      b.add(box(0.046, 0.022, 0.11), P2, [0, -0.322, 0.03]);
    };
    const legGlow = (b) => { b.add(box(0.009, 0.08, 0.009), CY, [0, -0.22, 0.014], rx(-0.18)); };
    return { hover: 0, scale: 1.42, walk: 12, parts: [
      part((b) => {
        b.add(octa(0.11), P2, [0, 0.47, 0], rx(0.25), [0.95, 1.6, 0.6]);
        b.add(octa(0.07), P3, [0, 0.53, 0.035], rx(0.25), [1.1, 0.9, 0.6]);
        b.add(box(0.12, 0.05, 0.07), P1, [0, 0.335, 0]);
        b.add(octa(0.055), P3, [0, 0.69, 0.07], null, [0.8, 1.05, 1.5]);
        b.add(box(0.012, 0.05, 0.13), P1, [0, 0.735, 0.03], rx(0.35));
        sym(b, () => cone(0.035, 0.1, 4), P3, [0.11, 0.6, 0.02], rz(-1.1));
        sym(b, () => box(0.05, 0.24, 0.012), P1, [0.045, 0.37, -0.075], [0.35, 0, 0.12]);
        for (const s of [-1, 1]) {
          strut(b, [s * 0.1, 0.58, 0.02], [s * 0.15, 0.46, 0.1], 0.032, P2);
          strut(b, [s * 0.15, 0.46, 0.1], [s * 0.145, 0.41, 0.2], 0.04, P3);
        }
      }, 'metal'),
      part((b) => {
        for (const s of [-1, 1]) strut(b, [s * 0.145, 0.405, 0.21], [s * 0.132, 0.33, 0.42], 0.016, CY);
        b.add(box(0.01, 0.16, 0.01), CY, [0, 0.49, 0.068], rx(0.25));
        b.add(box(0.055, 0.014, 0.014), CW, [0, 0.695, 0.15]);
      }, 'glow'),
      part(leg, 'metal', 'legL', [0.06, 0.335, 0]),
      part(leg, 'metal', 'legR', [-0.06, 0.335, 0]),
      part(legGlow, 'glow', 'legL', [0.06, 0.335, 0]),
      part(legGlow, 'glow', 'legR', [-0.06, 0.335, 0]),
    ] };
  },

  // Reflective drone: chrome bipyramid with a white core and a spinning ring of mirror panels.
  mirror() {
    const C1 = 0xb8c4d8, C2 = 0x8e9ab2, C0 = 0x404860, CH = 0xdde4f0;
    return { hover: 0.4, scale: 1.42, parts: [
      part((b) => {
        b.add(cyl(0.06, 0.17, 0.11, 6), C1, [0, 0.075, 0]);
        b.add(cone(0.17, 0.15, 6), C2, [0, -0.095, 0], rx(PI));
        b.add(cyl(0.13, 0.13, 0.024, 6), C0, [0, 0.008, 0]);
        b.add(cyl(0.064, 0.064, 0.02, 6), C0, [0, 0.135, 0]);
      }, 'metal'),
      part((b) => {
        b.add(octa(0.048), WHITE, [0, 0.16, 0], null, [1, 1.3, 1]);
        b.add(cyl(0.148, 0.148, 0.012, 12), 0xbfe8ff, [0, 0.008, 0]);
      }, 'glow'),
      part((b) => {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * PI * 2;
          b.add(box(0.14, 0.12, 0.012), i % 2 ? C1 : CH, [Math.sin(a) * 0.26, 0, Math.cos(a) * 0.26], ypr(a, -0.45));
          b.add(box(0.03, 0.03, 0.03), C0, [Math.sin(a) * 0.2, -0.02, Math.cos(a) * 0.2], ry(a));
        }
      }, 'metal', 'spinY', [0, 0.01, 0]),
      part((b) => {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * PI * 2;
          b.add(box(0.1, 0.008, 0.016), i % 2 ? 0xbfe8ff : WHITE, xf([Math.sin(a) * 0.26, 0, Math.cos(a) * 0.26], ypr(a, -0.45), [0, 0.062, 0.004]), ypr(a, -0.45));
        }
      }, 'glow', 'spinY', [0, 0.01, 0]),
    ] };
  },

  // Heavy CC-immune crawler: tracked hull behind a wedge of shield plates, dark red metal, orange glow slits.
  juggernaut() {
    const J1 = 0x2c1317, J2 = 0x471a21, J3 = 0x66262f, JO = 0xff7a2a, JY = 0xffa640;
    const fp = [0, 0.25, 0.45], fr = rx(-0.3);
    const wings = [[0.3, 0.23, 0.39], [-0.3, 0.23, 0.39]];
    const wr = (s) => [-0.25, s * 0.55, 0];
    return { hover: 0, scale: 1.42, parts: [
      part((b) => {
        b.add(box(0.48, 0.2, 0.66), J2, [0, 0.22, -0.03]);
        sym(b, () => box(0.15, 0.2, 0.84), J1, [0.3, 0.12, -0.02]);
        sym(b, () => box(0.17, 0.05, 0.78), J3, [0.3, 0.245, -0.04]);
        b.add(box(0.36, 0.15, 0.36), J3, [0, 0.39, -0.12]);
        b.add(box(0.3, 0.1, 0.14), J2, [0, 0.39, 0.1], rx(-0.55));
        b.add(box(0.48, 0.36, 0.07), J3, fp, fr);
        for (const s of [-1, 1]) b.add(box(0.26, 0.3, 0.06), J3, wings[s > 0 ? 0 : 1], wr(s));
        sym(b, () => box(0.1, 0.13, 0.34), J2, [0.2, 0.38, -0.12]);
        sym(b, () => cyl(0.04, 0.05, 0.16, 6), J1, [0.12, 0.49, -0.33]);
        b.add(box(0.26, 0.05, 0.2), J1, [0, 0.49, -0.14]);
      }, 'metal'),
      part((b) => {
        for (const ly of [-0.07, 0.03, 0.11]) b.add(box(0.36, 0.018, 0.01), ly > 0.1 ? JY : JO, xf(fp, fr, [0, ly, 0.037]), fr);
        for (const s of [-1, 1]) b.add(box(0.16, 0.016, 0.01), JO, xf(wings[s > 0 ? 0 : 1], wr(s), [0, 0.02, 0.032]), wr(s));
        sym(b, () => box(0.01, 0.018, 0.5), JO, [0.386, 0.2, -0.03]);
        b.add(box(0.2, 0.022, 0.01), JY, xf([0, 0.39, 0.1], rx(-0.55), [0, 0, 0.072]), rx(-0.55));
        sym(b, () => cyl(0.032, 0.032, 0.01, 6), JY, [0.12, 0.572, -0.33]);
        b.add(box(0.2, 0.012, 0.012), JO, [0, 0.52, -0.14]);
      }, 'glow'),
    ] };
  },

  // EMP support drone: squat body, tesla antenna with coil rings, blue-white glows, spinning ring.
  disruptor() {
    const BW = 0x9fdcff, BL = 0x5aa2ff;
    return { hover: 0.46, scale: 1.42, parts: [
      part((b) => {
        b.add(sphere(0.12, 8, 5), E2, [0, 0, 0], null, [1, 0.72, 1]);
        b.add(cyl(0.07, 0.15, 0.05, 8), E1, [0, -0.085, 0]);
        b.add(cyl(0.03, 0.05, 0.06, 6), E3, [0, 0.1, 0]);
        b.add(cyl(0.009, 0.013, 0.2, 5), E3, [0, 0.22, 0]);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * PI * 2 + PI / 2;
          b.add(box(0.13, 0.03, 0.05), E1, [Math.cos(a) * 0.14, -0.01, Math.sin(a) * 0.14], [0, -a, 0]);
        }
      }, 'metal'),
      part((b) => {
        b.add(torus(0.045, 0.008, 3, 10), BL, [0, 0.17, 0], rx(PI / 2));
        b.add(torus(0.032, 0.007, 3, 10), BL, [0, 0.235, 0], rx(PI / 2));
        b.add(sphere(0.032, 6, 4), WHITE, [0, 0.33, 0]);
        b.add(box(0.1, 0.02, 0.01), BW, [0, 0.02, 0.116]);
        for (let i = 0; i < 3; i++) { const a = (i / 3) * PI * 2 + PI / 2; b.add(sphere(0.022, 6, 4), BW, [Math.cos(a) * 0.21, -0.01, Math.sin(a) * 0.21]); }
        b.add(cyl(0.121, 0.121, 0.012, 8, true), BL, [0, -0.02, 0]);
      }, 'glow'),
      part((b) => {
        b.add(torus(0.25, 0.011, 3, 28), BL, [0, 0, 0], rx(PI / 2));
        for (let i = 0; i < 4; i++) { const a = (i / 4) * PI * 2; b.add(box(0.05, 0.022, 0.022), BW, [Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25], [0, -a, 0]); }
      }, 'glow', 'spinY', [0, -0.02, 0]),
    ] };
  },

  // Bulbous armored bot on stubby legs; green regeneration cells (in dark sockets) pulse.
  regenerator() {
    const G = 0x3dff8a, GW = 0xb8ffd8;
    const cells = [[0.19, 0.04, 0.05], [-0.19, 0.04, 0.05], [0.16, 0.1, -0.1], [-0.16, 0.1, -0.1], [0, 0.1, -0.18], [0.09, 0.15, 0.1], [-0.09, 0.15, 0.1], [0.13, -0.06, -0.14], [-0.13, -0.06, -0.14]];
    const nrm = (c) => { const l = Math.hypot(c[0], c[1] / 0.85, c[2] / 1.05); return [c[0] / l, c[1] / 0.85 / l, c[2] / 1.05 / l]; };
    const leg = (b) => { b.add(box(0.08, 0.14, 0.1), E1, [0, -0.07, 0]); b.add(box(0.12, 0.04, 0.16), E3, [0, -0.16, 0.02]); };
    return { hover: 0, scale: 1.42, walk: 7, parts: [
      part((b) => {
        b.add(sphere(0.2, 10, 7), E2, [0, 0.34, 0], null, [1, 0.85, 1.05]);
        b.add(cyl(0.11, 0.17, 0.07, 8), E3, [0, 0.49, 0]);
        b.add(box(0.24, 0.08, 0.1), E3, [0, 0.36, 0.17]);
        b.add(box(0.34, 0.05, 0.3), E1, [0, 0.22, 0]);
        sym(b, () => box(0.07, 0.11, 0.12), E3, [0.2, 0.27, 0.07]);
        for (const c of cells) {
          const n = nrm(c);
          b.add(cyl(0.047, 0.047, 0.03, 5), E1, [c[0] * 0.97, 0.34 + c[1] * 0.97, c[2] * 0.97], aimY([0, 0, 0], n));
        }
      }, 'metal'),
      part((b) => {
        b.add(box(0.17, 0.024, 0.01), GW, [0, 0.37, 0.221]);
        b.add(cyl(0.112, 0.112, 0.012, 8, true), G, [0, 0.52, 0]);
      }, 'glow'),
      part((b) => {
        for (const c of cells) { const n = nrm(c); b.add(sphere(0.034, 5, 4), G, [c[0] + n[0] * 0.012, c[1] + n[1] * 0.012, c[2] + n[2] * 0.012]); }
      }, 'glow', 'pulse', [0, 0.34, 0]),
      part(leg, 'metal', 'legL', [0.1, 0.18, 0]),
      part(leg, 'metal', 'legR', [-0.1, 0.18, 0]),
    ] };
  },

  // Spiky, hunched aggressive biped with red glow; fast legs.
  berserker() {
    const B1 = 0x35202a, B2 = 0x4d2a37, B3 = 0x6e3a48, R = 0xff2d4a, RO = 0xff5a3a;
    const leg = (b) => {
      b.add(box(0.07, 0.17, 0.08), B1, [0, -0.08, 0.02], rx(-0.25));
      b.add(box(0.06, 0.15, 0.07), B2, [0, -0.22, 0.0], rx(0.2));
      b.add(box(0.08, 0.025, 0.13), B3, [0, -0.29, 0.03]);
      b.add(cone(0.02, 0.07, 4), B3, [0, -0.13, 0.07], rx(1.1));
    };
    return { hover: 0, scale: 1.42, walk: 16, parts: [
      part((b) => {
        b.add(box(0.26, 0.2, 0.2), B2, [0, 0.42, 0.02], rx(0.4));
        b.add(box(0.2, 0.1, 0.14), B3, [0, 0.52, -0.05], rx(0.4));
        b.add(box(0.1, 0.08, 0.12), B1, [0, 0.47, 0.18]);
        sym(b, () => cone(0.02, 0.1, 4), B3, [0.04, 0.53, 0.2], [0.9, 0, -0.3]);
        for (let i = 0; i < 4; i++) b.add(cone(0.03, 0.15 - i * 0.015, 4), B3, [0, 0.6 - i * 0.045, -0.03 - i * 0.07], rx(-0.5 - i * 0.15));
        sym(b, () => cone(0.035, 0.16, 4), B3, [0.16, 0.58, -0.02], rz(-0.7));
        for (const s of [-1, 1]) {
          strut(b, [s * 0.15, 0.5, 0.04], [s * 0.2, 0.36, 0.1], 0.07, B1);
          strut(b, [s * 0.2, 0.36, 0.1], [s * 0.19, 0.3, 0.25], 0.075, B2);
          for (const dx of [-0.025, 0.025]) b.add(cone(0.014, 0.08, 4), B3, [s * 0.19 + dx, 0.29, 0.31], rx(PI / 2 + 0.3));
        }
      }, 'metal'),
      part((b) => {
        sym(b, () => box(0.035, 0.018, 0.012), R, [0.027, 0.48, 0.242]);
        for (const ly of [-0.035, 0.015]) b.add(box(0.18, 0.018, 0.012), RO, xf([0, 0.42, 0.02], rx(0.4), [0, ly, 0.102]), rx(0.4));
        b.add(box(0.016, 0.016, 0.22), R, [0, 0.59, -0.1], rx(0.35));
        for (let i = 0; i < 4; i++) { const h = 0.15 - i * 0.015, r = rx(-0.5 - i * 0.15); b.add(octa(0.016), RO, xf([0, 0.6 - i * 0.045, -0.03 - i * 0.07], r, [0, h / 2, 0])); }
        sym(b, () => octa(0.018), RO, xf([0.16, 0.58, -0.02], rz(-0.7), [0, 0.08, 0]));
        for (const s of [-1, 1]) {
          strut(b, [s * 0.232, 0.37, 0.11], [s * 0.225, 0.315, 0.24], 0.014, RO);
          b.add(sphere(0.018, 4, 3), R, [s * 0.19, 0.305, 0.27]);
        }
      }, 'glow'),
      part(leg, 'metal', 'legL', [0.09, 0.3, 0]),
      part(leg, 'metal', 'legR', [-0.09, 0.3, 0]),
    ] };
  },

  // Air carrier: bulbous body with four pods (yellow glow). Banks.
  hive() {
    const Y = 0xffd23d, YO = 0xffa82a;
    const pods = [[0.3, 0.14], [-0.3, 0.14], [0.29, -0.17], [-0.29, -0.17]];
    return { hover: 0, scale: 1.42, bank: true, parts: [
      part((b) => {
        b.add(sphere(0.2, 10, 7), E2, [0, 0.02, 0], null, [1, 0.75, 1.35]);
        b.add(sphere(0.16, 8, 5), E1, [0, -0.06, -0.02], null, [1, 0.6, 1.3]);
        b.add(box(0.12, 0.06, 0.1), E3, [0, 0.03, 0.27]);
        b.add(box(0.03, 0.08, 0.3), E3, [0, 0.17, -0.04]);
        for (const [x, z] of pods) {
          b.add(box(0.16, 0.035, 0.05), E1, [x * 0.6, 0.0, z]);
          b.add(sphere(0.092, 7, 5), E3, [x, 0.0, z], null, [0.9, 0.8, 1.25]);
        }
      }, 'metal'),
      part((b) => {
        for (const [x, z] of pods) {
          b.add(cyl(0.09, 0.09, 0.022, 7, true), Y, [x, 0.0, z], rx(PI / 2), [1, 1, 0.92]);
          b.add(box(0.05, 0.012, 0.05), YO, [x, 0.073, z]);
        }
        b.add(box(0.016, 0.01, 0.24), YO, [0, 0.172, -0.03]);
        sym(b, () => sphere(0.018, 4, 3), RED, [0.035, 0.045, 0.32]);
        b.add(box(0.1, 0.012, 0.01), Y, [0, 0.0, 0.321]);
      }, 'glow'),
    ] };
  },

  // Tiny air drone with flapping energy wings.
  swarmling() {
    const Y = 0xffc83d, W = 0x7a5e1c;
    return { hover: 0, scale: 1.42, bank: true, parts: [
      part((b) => {
        b.add(sphere(0.038, 6, 4), E2, [0, 0, -0.01], null, [1, 0.8, 1.7]);
        b.add(sphere(0.026, 5, 4), E3, [0, 0.005, 0.06]);
        b.add(cone(0.014, 0.05, 4), E1, [0, 0, -0.095], rx(-PI / 2));
      }, 'metal'),
      part((b) => {
        sym(b, () => box(0.012, 0.01, 0.01), Y, [0.012, 0.012, 0.085]);
        b.add(sphere(0.016, 5, 3), Y, [0, 0.022, -0.035]);
      }, 'glow'),
      part((b) => { b.add(sphere(1, 6, 3), W, [0.042, 0, -0.008], ry(0.35), [0.044, 0.004, 0.02]); }, 'glow', 'flapL', [0.02, 0.025, 0]),
      part((b) => { b.add(sphere(1, 6, 3), W, [-0.042, 0, -0.008], ry(-0.35), [0.044, 0.004, 0.02]); }, 'glow', 'flapR', [-0.02, 0.025, 0]),
    ] };
  },

  // BOSS: tracked fortress with a dome shield generator, twin cannons and an energy shield bubble.
  dreadnought() {
    const SH = 0x4da6ff, SW = 0xa8dcff;
    return { hover: 0, scale: 1, parts: [
      part((b) => {
        b.add(box(0.84, 0.3, 1.26), E2, [0, 0.33, -0.02]);
        b.add(box(0.8, 0.2, 0.3), E3, [0, 0.36, 0.68], rx(-0.55));
        sym(b, () => box(0.24, 0.32, 1.5), E1, [0.54, 0.17, 0]);
        sym(b, () => box(0.28, 0.06, 1.42), E3, [0.54, 0.35, -0.02]);
        for (const s of [-1, 1]) for (let i = 0; i < 5; i++) b.add(cyl(0.1, 0.1, 0.04, 8), E3, [s * 0.665, 0.15, -0.56 + i * 0.28], rz(PI / 2));
        b.add(box(0.6, 0.16, 0.72), E3, [0, 0.56, -0.16]);
        b.add(box(0.36, 0.2, 0.3), E2, [0, 0.72, -0.42]);
        b.add(sphere(0.24, 12, 6), E3, [0, 0.66, 0.08], null, [1, 0.7, 1]);
        b.add(cyl(0.28, 0.3, 0.06, 12), E1, [0, 0.64, 0.08]);
        for (let i = 0; i < 4; i++) { const a = PI / 4 + (i * PI) / 2; b.add(box(0.05, 0.26, 0.05), E1, [Math.cos(a) * 0.34, 0.72, 0.08 + Math.sin(a) * 0.34]); }
        b.add(cyl(0.2, 0.22, 0.12, 8), E2, [0, 0.5, 0.44]);
        sym(b, () => cyl(0.045, 0.05, 0.46, 8), E1, [0.08, 0.53, 0.72], rx(PI / 2));
        sym(b, () => box(0.14, 0.12, 0.2), E2, [0.45, 0.47, 0.22]);
        sym(b, () => cyl(0.03, 0.035, 0.32, 6), E1, [0.5, 0.48, 0.42], rx(PI / 2));
        sym(b, () => cyl(0.06, 0.07, 0.24, 8), E1, [0.2, 0.64, -0.62]);
      }, 'metal'),
      part((b) => {
        b.add(torus(0.23, 0.012, 4, 28), SH, [0, 0.7, 0.08], rx(PI / 2));
        b.add(torus(0.17, 0.01, 4, 24), SW, [0, 0.76, 0.08], rx(PI / 2));
        b.add(sphere(0.07, 8, 6), SW, [0, 0.83, 0.08]);
        for (let i = 0; i < 4; i++) { const a = PI / 4 + (i * PI) / 2; b.add(sphere(0.04, 6, 4), SW, [Math.cos(a) * 0.34, 0.87, 0.08 + Math.sin(a) * 0.34]); }
        sym(b, () => cyl(0.052, 0.052, 0.02, 8, true), RED, [0.08, 0.53, 0.94], rx(PI / 2));
        sym(b, () => cyl(0.037, 0.037, 0.02, 6, true), ORG, [0.5, 0.48, 0.57], rx(PI / 2));
        for (const ly of [-0.03, 0.04]) b.add(box(0.6, 0.02, 0.01), RED, xf([0, 0.36, 0.68], rx(-0.55), [0, ly, 0.152]), rx(-0.55));
        sym(b, () => box(0.01, 0.022, 1.1), SH, [0.681, 0.3, -0.02]);
        b.add(box(0.28, 0.03, 0.01), SW, [0, 0.76, -0.268]);
        sym(b, () => cyl(0.05, 0.05, 0.01, 8), ORG, [0.2, 0.765, -0.62]);
      }, 'glow'),
      part((b) => {
        b.add(torus(0.36, 0.014, 4, 36), SH, [0, 0, 0], rx(PI / 2));
        for (let i = 0; i < 6; i++) { const a = (i / 6) * PI * 2; b.add(box(0.06, 0.03, 0.03), SW, [Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36], [0, -a, 0]); }
      }, 'glow', 'spinY', [0, 0.95, 0.08]),
      part((b) => { b.add(sphere(1.1, 20, 12), 0xffffff, [0, 0, 0]); }, 'shield', 'static', [0, 0.45, 0]),
    ] };
  },

  // BOSS (air): insectoid queen with flapping wings, magenta/purple glow.
  queen() {
    const Q = 0xff3ddf, QP = 0xb04dff, QW = 0xffc0f4, WM = 0x3d2c5c;
    const wing = (s) => (b) => {
      b.add(sphere(1, 8, 4), WM, [s * 0.36, 0, -0.02], ry(s * 0.28), [0.36, 0.012, 0.13]);
      b.add(sphere(1, 8, 4), WM, [s * 0.26, -0.015, -0.2], ry(s * 0.6), [0.27, 0.01, 0.09]);
    };
    const veins = (s) => (b) => {
      strut(b, [0, 0.008, 0.03], [s * 0.7, 0.008, -0.17], 0.012, Q);
      strut(b, [0, 0.008, 0.0], [s * 0.55, 0.008, -0.05], 0.008, QP);
      strut(b, [0, -0.006, -0.12], [s * 0.49, -0.006, -0.4], 0.009, Q);
      strut(b, [s * 0.1, 0.004, -0.1], [s * 0.66, 0.004, -0.27], 0.007, QW);
    };
    return { hover: 0, scale: 1, bank: true, parts: [
      part((b) => {
        b.add(sphere(0.13, 10, 7), E2, [0, 0.03, 0.52], null, [1, 0.8, 1.1]);
        b.add(sphere(0.19, 10, 7), E2, [0, 0.05, 0.2], null, [1, 0.85, 1.3]);
        b.add(sphere(0.3, 12, 8), E2, [0, 0.0, -0.38], null, [0.95, 0.72, 1.45]);
        b.add(cone(0.05, 0.2, 6), E3, [0, -0.02, -0.88], rx(-PI / 2));
        b.add(box(0.22, 0.05, 0.3), E3, [0, 0.2, 0.2]);
        for (let i = 0; i < 3; i++) b.add(box(0.36 - i * 0.06, 0.04, 0.07), E3, [0, 0.21 - i * 0.02, -0.2 - i * 0.2]);
        for (let i = 0; i < 5; i++) {
          const x = (i - 2) * 0.05;
          b.add(cone(0.022, 0.16 - Math.abs(i - 2) * 0.03, 4), E3, [x, 0.17, 0.5 - Math.abs(i - 2) * 0.02], [-0.5, 0, -x * 2.5]);
        }
        sym(b, () => cone(0.03, 0.14, 4), E3, [0.06, -0.02, 0.66], aimY([0, 0, 0], [-0.35, 0, 1]));
        for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
          const z = 0.28 - i * 0.12, k = [s * 0.18, -0.08, z], f = [s * 0.3, -0.22, z + 0.06];
          strut(b, [s * 0.08, -0.04, z], k, 0.022, E1);
          strut(b, k, f, 0.018, E1);
        }
      }, 'metal'),
      part((b) => {
        sym(b, () => sphere(0.055, 6, 4), Q, [0.075, 0.075, 0.6]);
        for (let i = 0; i < 5; i++) { const x = (i - 2) * 0.05; b.add(octa(0.016), QW, [x, 0.26 - Math.abs(i - 2) * 0.03, 0.47 - Math.abs(i - 2) * 0.02]); }
        for (let i = 0; i < 3; i++) b.add(box(0.3 - i * 0.06, 0.012, 0.018), Q, [0, 0.235 - i * 0.02, -0.2 - i * 0.2]);
        for (const s of [-1, 1]) for (let i = 0; i < 4; i++) b.add(sphere(0.032, 6, 4), QP, [s * 0.2, 0.1, -0.2 - i * 0.14]);
        b.add(sphere(0.05, 8, 6), QW, [0, 0.13, 0.28]);
      }, 'glow'),
      part(wing(1), 'metal', 'flapL', [0.12, 0.16, 0.22]),
      part(wing(-1), 'metal', 'flapR', [-0.12, 0.16, 0.22]),
      part(veins(1), 'glow', 'flapL', [0.12, 0.16, 0.22]),
      part(veins(-1), 'glow', 'flapR', [-0.12, 0.16, 0.22]),
    ] };
  },

  // FINAL BOSS: colossal white/gold armored titan with a glowing chest core, cannon arm and great blade.
  omega() {
    const cy = 1.58;
    const leg = (b) => {
      b.add(box(0.26, 0.5, 0.3), TD, [0, -0.25, 0]);
      b.add(box(0.3, 0.2, 0.08), TW2, [0, -0.2, 0.14]);
      b.add(box(0.3, 0.16, 0.2), TW1, [0, -0.5, 0.1]);
      b.add(box(0.3, 0.05, 0.21), TG, [0, -0.43, 0.1]);
      b.add(box(0.28, 0.42, 0.32), TW1, [0, -0.72, 0]);
      b.add(box(0.4, 0.1, 0.56), TW2, [0, -0.9, 0.08]);
      b.add(box(0.36, 0.03, 0.5), TG, [0, -0.84, 0.08]);
    };
    const legGlow = (b) => { b.add(box(0.14, 0.02, 0.01), TR, [0, -0.68, 0.162]); b.add(box(0.14, 0.02, 0.01), TR, [0, -0.76, 0.162]); };
    return { hover: 0, scale: 1, walk: 3.4, parts: [
      ...parts2((m, g) => {
        titanUpper(m, g, cy);
        m.add(box(0.62, 0.24, 0.42), TD, [0, 1.02, 0]);
        m.add(box(0.5, 0.3, 0.06), TW1, [0, 0.92, 0.23], rx(0.2));
        m.add(box(0.5, 0.035, 0.065), TG, [0, 1.06, 0.215], rx(0.2));
        sym(m, () => box(0.06, 0.32, 0.38), TW1, [0.35, 0.92, 0], rz(0.2));
        m.add(box(0.64, 0.28, 0.42), TW3, [0, 1.25, 0]);
        for (let k = 0; k < 3; k++) m.add(box(0.44, 0.06, 0.05), TW2, [0, 1.16 + k * 0.085, 0.215]);
        sym(m, () => box(0.2, 0.4, 0.24), TD, [0.62, 1.38, 0]);
        // left arm: triple-barrel cannon
        m.add(box(0.26, 0.26, 0.5), TW2, [0.66, 1.08, 0.16]);
        m.add(box(0.28, 0.05, 0.52), TG, [0.66, 1.23, 0.16]);
        for (const [dx, dy] of [[-0.07, 0.05], [0.07, 0.05], [0, -0.07]]) m.add(cyl(0.05, 0.05, 0.5, 8), TW3, [0.66 + dx, 1.08 + dy, 0.62], rx(PI / 2));
        m.add(cyl(0.15, 0.15, 0.06, 8), TG, [0.66, 1.08, 0.44], rx(PI / 2));
        // right arm: great blade
        m.add(box(0.22, 0.22, 0.42), TW2, [-0.66, 1.08, 0.12]);
        m.add(box(0.06, 0.14, 0.95), TW1, [-0.7, 1.0, 0.72], rx(0.12));
        m.add(box(0.1, 0.2, 0.08), TG, [-0.7, 1.05, 0.3]);
        // reactor fins on the back
        sym(m, () => box(0.08, 0.7, 0.3), TW2, [0.3, 1.95, -0.36], [-0.3, 0, -0.25]);
        for (const [dx, dy] of [[-0.07, 0.05], [0.07, 0.05], [0, -0.07]]) g.add(cyl(0.056, 0.056, 0.02, 8, true), TR, [0.66 + dx, 1.08 + dy, 0.87], rx(PI / 2));
        g.add(box(0.014, 0.024, 0.9), TR, xf([-0.7, 1.0, 0.72], rx(0.12), [0, -0.075, 0]), rx(0.12));
        sym(g, () => box(0.02, 0.6, 0.02), TR, xf([0.3, 1.95, -0.36], [-0.3, 0, -0.25], [0, 0, 0.16]), [-0.3, 0, -0.25]);
        for (let k = 0; k < 2; k++) g.add(box(0.3, 0.014, 0.01), TR, [0, 1.2 + k * 0.085, 0.24]);
        g.add(torus(0.3, 0.018, 4, 32), 0xffd08a, [0, 2.12, -0.2]);
      }),
      part(leg, 'metal', 'legL', [0.3, 0.95, 0]),
      part(leg, 'metal', 'legR', [-0.3, 0.95, 0]),
      part(legGlow, 'glow', 'legL', [0.3, 0.95, 0]),
      part(legGlow, 'glow', 'legR', [-0.3, 0.95, 0]),
    ] };
  },

  // FINAL BOSS phase 2 (air): the titan's upper body as a flying war-core with fanned blade wings and rotating rings.
  omega2() {
    const cy = 0.12;
    return { hover: 0, scale: 1, bank: true, parts: [
      ...parts2((m, g) => {
        titanUpper(m, g, cy);
        m.add(box(0.5, 0.18, 0.4), TD, [0, cy - 0.32, 0]);
        m.add(cone(0.3, 0.8, 8), TW2, [0, cy - 0.8, 0], rx(PI));
        m.add(cyl(0.33, 0.33, 0.06, 8), TG, [0, cy - 0.42, 0]);
        for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
          const len = 0.86 - k * 0.12, w = 0.15 - k * 0.02;
          const rot = [0.08, s * (0.3 + k * 0.28), s * (0.42 - k * 0.3)];
          const pos = xf([s * 0.34, cy + 0.26 - k * 0.12, -0.24], rot, [s * len / 2, 0, 0]);
          m.add(box(len, 0.035, w), k === 1 ? TW2 : TW1, pos, rot);
          m.add(box(len * 0.9, 0.045, 0.03), TG, xf(pos, rot, [0, 0, -w / 2]), rot);
          g.add(box(len * 0.95, 0.022, 0.02), TR, xf(pos, rot, [0, 0, w / 2 + 0.007]), rot);
        }
        for (const y of [-0.48, -0.72]) g.add(torus((0.3 * (y - cy + 1.2)) / 0.8 + 0.012, 0.014, 4, 20), TR, [0, y, 0], rx(PI / 2));
        g.add(octa(0.05), WHITE, [0, cy - 1.22, 0], null, [1, 1.6, 1]);
      }),
      part((b) => {
        b.add(torus(0.95, 0.03, 4, 48), TG, [0, 0, 0], rx(PI / 2));
        for (let i = 0; i < 6; i++) { const a = (i / 6) * PI * 2; b.add(box(0.12, 0.08, 0.1), TW2, [Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95], [0, -a, 0]); }
      }, 'metal', 'spinY', [0, -0.25, 0]),
      part((b) => {
        b.add(torus(0.9, 0.01, 3, 48), TR, [0, 0.01, 0], rx(PI / 2));
        for (let i = 0; i < 6; i++) { const a = (i / 6) * PI * 2; b.add(box(0.05, 0.03, 0.105), i % 2 ? WHITE : TR, [Math.cos(a) * 1.0, 0.0, Math.sin(a) * 1.0], [0, -a, 0]); }
      }, 'glow', 'spinY', [0, -0.25, 0]),
      part((b) => {
        b.add(torus(0.52, 0.02, 4, 40), 0xffd08a, [0, 0, 0]);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * PI * 2;
          b.add(box(0.26, 0.016, 0.016), i % 2 ? 0xffd08a : TR, [Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0], rz(a));
        }
      }, 'glow', 'spinZ', [0, cy + 0.2, -0.4]),
    ] };
  },
};
