// Geometry helpers: merge many primitive parts (with per-part vertex colors) into one mesh.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

export class GeoBuilder {
  constructor(keepUV = false) {
    this.parts = [];
    this.keepUV = keepUV;
  }

  // add(geometry, color, [x,y,z], [rx,ry,rz], [sx,sy,sz])
  add(geo, color = 0xffffff, pos = null, rot = null, scale = null) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
    _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
    _q.setFromEuler(_e);
    if (typeof scale === 'number') _s.set(scale, scale, scale);
    else _s.set(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1);
    _m.compose(_p, _q, _s);
    g.applyMatrix4(_m);
    _c.set(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!this.keepUV) g.deleteAttribute('uv');
    else if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    this.parts.push(g);
    geo.dispose?.();
    return this;
  }

  // add a pre-transformed geometry as-is (keeps its own color attribute if present)
  addRaw(g) {
    this.parts.push(g);
    return this;
  }

  get empty() { return this.parts.length === 0; }

  build() {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

// Primitive shortcuts (fresh geometry each call; GeoBuilder disposes them).
export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt, rb, h, seg = 8, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
export const cone = (r, h, seg = 8) => new THREE.ConeGeometry(r, h, seg);
export const sphere = (r, ws = 10, hs = 8) => new THREE.SphereGeometry(r, ws, hs);
export const torus = (r, t, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc);
export const octa = (r) => new THREE.OctahedronGeometry(r, 0);
export const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);

// Beveled slab: top face at y=0, chamfer b, bottom at -h. UVs 0..1 on the top face.
export function bevelSlab(w, h, d, b) {
  const hw = w / 2, hd = d / 2, iw = hw - b, id = hd - b;
  const pos = [], nor = [], uv = [];
  const quad = (a, bq, c, dq, n, ua, ub, uc, ud) => {
    pos.push(...a, ...bq, ...c, ...a, ...c, ...dq);
    for (let i = 0; i < 6; i++) nor.push(...n);
    uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  const u = (x, z) => [(x + hw) / w, 1 - (z + hd) / d];
  // top
  quad([-iw, 0, id], [iw, 0, id], [iw, 0, -id], [-iw, 0, -id], [0, 1, 0], u(-iw, id), u(iw, id), u(iw, -id), u(-iw, -id));
  const s = Math.SQRT1_2;
  // chamfers (+z, -z, +x, -x)
  quad([-hw, -b, hd], [hw, -b, hd], [iw, 0, id], [-iw, 0, id], [0, s, s], u(-hw, hd), u(hw, hd), u(iw, id), u(-iw, id));
  quad([hw, -b, -hd], [-hw, -b, -hd], [-iw, 0, -id], [iw, 0, -id], [0, s, -s], u(hw, -hd), u(-hw, -hd), u(-iw, -id), u(iw, -id));
  quad([hw, -b, hd], [hw, -b, -hd], [iw, 0, -id], [iw, 0, id], [s, s, 0], u(hw, hd), u(hw, -hd), u(iw, -id), u(iw, id));
  quad([-hw, -b, -hd], [-hw, -b, hd], [-iw, 0, id], [-iw, 0, -id], [-s, s, 0], u(-hw, -hd), u(-hw, hd), u(-iw, id), u(-iw, -id));
  // sides
  const e = [0.02, 0.02];
  quad([-hw, -h, hd], [hw, -h, hd], [hw, -b, hd], [-hw, -b, hd], [0, 0, 1], e, e, e, e);
  quad([hw, -h, -hd], [-hw, -h, -hd], [-hw, -b, -hd], [hw, -b, -hd], [0, 0, -1], e, e, e, e);
  quad([hw, -h, hd], [hw, -h, -hd], [hw, -b, -hd], [hw, -b, hd], [1, 0, 0], e, e, e, e);
  quad([-hw, -h, -hd], [-hw, -h, hd], [-hw, -b, hd], [-hw, -b, -hd], [-1, 0, 0], e, e, e, e);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// Hexagonal prism "pad" used by tower bases.
export function hexPrism(r, h) {
  const g = new THREE.CylinderGeometry(r, r, h, 6);
  g.rotateY(Math.PI / 6);
  return g;
}
