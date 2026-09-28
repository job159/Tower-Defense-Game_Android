// Tilted perspective camera that frames the map; supports drag-pan, pinch/wheel zoom and screen shake.
import * as THREE from 'three';

const _ray = new THREE.Raycaster();
const _v2 = new THREE.Vector2();
const _v3 = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class CameraRig {
  constructor(level) {
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.pitch = THREE.MathUtils.degToRad(53);
    this.yaw = 0;
    this.target = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.dist = 14;
    this.goalDist = 14;
    this.fitDist = 14;
    this.fitCenter = new THREE.Vector3();
    this.shakeT = 0;
    this.shakeAmp = 0;
    this.setLevel(level);
  }

  setLevel(level) {
    this.halfW = level.cols / 2;
    this.halfH = level.rows / 2;
  }

  apply(target, dist) {
    const c = this.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    c.position.set(target.x + Math.sin(this.yaw) * cp * dist, target.y + sp * dist, target.z + Math.cos(this.yaw) * cp * dist);
    c.lookAt(target);
    c.updateMatrixWorld();
  }

  // Frame the whole map inside the viewport minus UI margins (fractions of the screen).
  fit(aspect, margins = { top: 0.1, bottom: 0.08, left: 0.04, right: 0.04 }) {
    const c = this.camera;
    c.aspect = aspect;
    c.updateProjectionMatrix();
    const corners = [];
    for (const x of [-this.halfW - 0.1, this.halfW + 0.1]) for (const z of [-this.halfH - 0.1, this.halfH + 0.35]) for (const y of [0, 0.7]) corners.push(new THREE.Vector3(x, y, z));
    const target = new THREE.Vector3();
    let dist = 14;
    const yMin = -1 + margins.bottom * 2, yMax = 1 - margins.top * 2;
    const xMin = -1 + margins.left * 2, xMax = 1 - margins.right * 2;
    for (let iter = 0; iter < 6; iter++) {
      // binary search distance so everything fits
      let lo = 3, hi = 80;
      for (let k = 0; k < 28; k++) {
        const mid = (lo + hi) / 2;
        this.apply(target, mid);
        let ok = true;
        for (const p of corners) {
          const q = _v3.copy(p).project(c);
          if (q.x < xMin || q.x > xMax || q.y < yMin || q.y > yMax) { ok = false; break; }
        }
        if (ok) hi = mid; else lo = mid;
      }
      dist = hi;
      // re-center vertically/horizontally
      this.apply(target, dist);
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const p of corners) {
        const q = _v3.copy(p).project(c);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      }
      const offY = (minY + maxY) / 2 - (yMin + yMax) / 2;
      const offX = (minX + maxX) / 2 - (xMin + xMax) / 2;
      target.z -= offY * dist * 0.35;
      target.x += offX * dist * 0.35;
    }
    this.fitDist = dist;
    this.fitCenter.copy(target);
    this.goal.copy(target);
    this.target.copy(target);
    this.dist = this.goalDist = dist;
    this.minDist = dist * 0.42;
    this.maxDist = dist * 1.05;
    this.apply(this.target, this.dist);
  }

  screenToGround(sx, sy, w, h, y = 0, out = new THREE.Vector3()) {
    _v2.set((sx / w) * 2 - 1, -(sy / h) * 2 + 1);
    _ray.setFromCamera(_v2, this.camera);
    _plane.constant = -y;
    return _ray.ray.intersectPlane(_plane, out) || out.set(0, 0, 0);
  }

  worldToScreen(v, w, h, out = { x: 0, y: 0, behind: false }) {
    _v3.copy(v).project(this.camera);
    out.x = (_v3.x * 0.5 + 0.5) * w;
    out.y = (-_v3.y * 0.5 + 0.5) * h;
    out.behind = _v3.z > 1;
    return out;
  }

  // Drag: move so the ground point under the finger follows it.
  panPixels(x0, y0, x1, y1, w, h) {
    this.snap();
    const a = this.screenToGround(x0, y0, w, h, 0, new THREE.Vector3());
    const b = this.screenToGround(x1, y1, w, h, 0, new THREE.Vector3());
    this.goal.x += a.x - b.x;
    this.goal.z += a.z - b.z;
    this.clampGoal();
    this.target.copy(this.goal);
    this.apply(this.target, this.dist);
  }

  zoomAt(factor, sx, sy, w, h) {
    this.snap();
    const before = this.screenToGround(sx, sy, w, h, 0, new THREE.Vector3());
    this.goalDist = THREE.MathUtils.clamp(this.goalDist * factor, this.minDist, this.maxDist);
    this.dist = this.goalDist;
    this.apply(this.target, this.dist);
    const after = this.screenToGround(sx, sy, w, h, 0, new THREE.Vector3());
    this.goal.x += before.x - after.x;
    this.goal.z += before.z - after.z;
    this.clampGoal();
    this.target.copy(this.goal);
    this.apply(this.target, this.dist);
  }

  snap() { this.target.copy(this.goal); this.dist = this.goalDist; }

  clampGoal() {
    // the more we zoom in, the further we may pan (never past the map edges)
    const z = 1 - (this.goalDist - this.minDist) / Math.max(0.01, this.fitDist - this.minDist);
    const ex = this.halfW * THREE.MathUtils.clamp(z, 0, 1) * 0.9;
    const ez = this.halfH * THREE.MathUtils.clamp(z, 0, 1) * 0.9;
    this.goal.x = THREE.MathUtils.clamp(this.goal.x, this.fitCenter.x - ex, this.fitCenter.x + ex);
    this.goal.z = THREE.MathUtils.clamp(this.goal.z, this.fitCenter.z - ez, this.fitCenter.z + ez);
  }

  reset() { this.goal.copy(this.fitCenter); this.goalDist = this.fitDist; }

  shake(amount) {
    this.shakeAmp = Math.min(0.35, Math.max(this.shakeAmp, amount));
    this.shakeT = 0.35;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 10);
    this.target.lerp(this.goal, k);
    this.dist += (this.goalDist - this.dist) * k;
    this.apply(this.target, this.dist);
    if (this.menuShift) {
      // off-center projection so the backdrop sits beside the menu column
      const c = this.camera, w = 1000, hgt = w / c.aspect;
      c.setViewOffset(w, hgt, -w * this.menuShift, 0, w, hgt);
    }
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const a = this.shakeAmp * Math.max(0, this.shakeT / 0.35);
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }
  }
}
