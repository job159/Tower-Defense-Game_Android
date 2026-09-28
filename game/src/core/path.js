// Map geometry shared by the simulation and the renderer: tile grid + arc-length sampled paths.

export const TILE = { BUILD: 0, PATH: 1, DECOR: 2, VOID: 3, CORE: 4, SPAWN: 5, WRECK: 6 };
export const AIR_HEIGHT = 1.35;

export function tileToWorld(level, col, row) {
  return { x: col - (level.cols - 1) / 2, z: row - (level.rows - 1) / 2 };
}

export function worldToTile(level, x, z) {
  return { col: Math.round(x + (level.cols - 1) / 2), row: Math.round(z + (level.rows - 1) / 2) };
}

// Path sampled at uniform arc length so lookups are O(1). `warps` = [[d0, d1], ...] tunnel intervals.
export class Path {
  constructor(points, cornerRadius, step = 0.05) {
    const dense = roundCorners(points, cornerRadius);
    const cum = [0];
    for (let i = 1; i < dense.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
    }
    this.length = cum[cum.length - 1];
    this.step = step;
    const n = Math.max(2, Math.ceil(this.length / step) + 1);
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(this.length, i * step);
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = (d - cum[j]) / seg;
      this.xs[i] = dense[j].x + (dense[j + 1].x - dense[j].x) * t;
      this.zs[i] = dense[j].z + (dense[j + 1].z - dense[j].z) * t;
    }
    this.n = n;
    this.warps = [];
  }

  // Writes position + unit direction at distance d into out {x, z, dx, dz}.
  sample(d, out) {
    const f = Math.max(0, Math.min(this.length, d)) / this.step;
    let i = Math.floor(f);
    if (i >= this.n - 1) i = this.n - 2;
    const t = f - i;
    const x0 = this.xs[i], z0 = this.zs[i], x1 = this.xs[i + 1], z1 = this.zs[i + 1];
    out.x = x0 + (x1 - x0) * t;
    out.z = z0 + (z1 - z0) * t;
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    out.dx = (x1 - x0) / len;
    out.dz = (z1 - z0) / len;
    return out;
  }

  nearestDist(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (d < bd) { bd = d; best = i * this.step; }
    }
    return Math.min(best, this.length);
  }

  inWarp(d) {
    for (const [a, b] of this.warps) if (d > a && d < b) return true;
    return false;
  }
}

// Replace each interior corner by a quadratic Bezier of the given radius.
function roundCorners(points, radius) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const d2 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 1e-3) { out.push(p1); continue; }
    const a = { x: p1.x - ((p1.x - p0.x) / d1) * r, z: p1.z - ((p1.z - p0.z) / d1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * r, z: p1.z + ((p2.z - p1.z) / d2) * r };
    const segs = 10;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs, u = 1 - t;
      out.push({
        x: u * u * a.x + 2 * u * t * p1.x + t * t * b.x,
        z: u * u * a.z + 2 * u * t * p1.z + t * t * b.z,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z) > 1e-5);
}

// Catmull-Rom smoothing for free-form air routes.
function smoothRoute(points, samplesPerSeg = 12) {
  const out = [];
  const P = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < samplesPerSeg; k++) {
      const t = k / samplesPerSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// Prepend a point 0.6 tiles outside the platform so units emerge from the edge.
function withApproach(pts) {
  const first = pts[0], second = pts[1];
  const dl = Math.hypot(second.x - first.x, second.z - first.z) || 1;
  return [{ x: first.x - ((second.x - first.x) / dl) * 0.6, z: first.z - ((second.z - first.z) / dl) * 0.6 }, ...pts];
}

// Builds the (mutable) tile grid and path objects for a level definition.
export function buildMap(level) {
  const { cols, rows } = level;
  const grid = new Uint8Array(cols * rows);
  const idx = (c, r) => r * cols + c;
  for (const [c, r] of level.voids || []) grid[idx(c, r)] = TILE.VOID;
  for (const [c, r] of level.decor || []) grid[idx(c, r)] = TILE.DECOR;

  const paths = [];
  const spawns = [];
  const gates = [];
  let core = null;
  for (const wp of level.paths) {
    for (let i = 0; i < wp.length - 1; i++) {
      const [c0, r0] = wp[i], [c1, r1, flag] = wp[i + 1];
      if (flag === 'w') { // tunnel: only the two gate tiles are path
        grid[idx(c0, r0)] = TILE.PATH;
        grid[idx(c1, r1)] = TILE.PATH;
        gates.push({ ...tileToWorld(level, c0, r0), col: c0, row: r0 }, { ...tileToWorld(level, c1, r1), col: c1, row: r1 });
        continue;
      }
      const steps = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
      for (let s = 0; s <= steps; s++) grid[idx(c0 + Math.sign(c1 - c0) * s, r0 + Math.sign(r1 - r0) * s)] = TILE.PATH;
    }
    const pts = wp.map(([c, r]) => tileToWorld(level, c, r));
    const path = new Path(withApproach(pts), 0.5);
    for (let i = 1; i < wp.length; i++) {
      if (wp[i][2] !== 'w') continue;
      const a = tileToWorld(level, wp[i - 1][0], wp[i - 1][1]), b = tileToWorld(level, wp[i][0], wp[i][1]);
      path.warps.push([path.nearestDist(a.x, a.z) + 0.15, path.nearestDist(b.x, b.z) - 0.15]);
    }
    paths.push(path);
    const [sc, sr] = wp[0];
    const first = pts[0], second = pts[1];
    const dl = Math.hypot(second.x - first.x, second.z - first.z) || 1;
    spawns.push({ col: sc, row: sr, x: first.x, z: first.z, dirX: (second.x - first.x) / dl, dirZ: (second.z - first.z) / dl });
    const [cc, cr] = wp[wp.length - 1];
    core = { col: cc, row: cr, ...tileToWorld(level, cc, cr) };
  }
  for (const s of spawns) grid[idx(s.col, s.row)] = TILE.SPAWN;
  grid[idx(core.col, core.row)] = TILE.CORE;

  const nodes = new Set((level.nodes || []).map(([c, r]) => idx(c, r)));
  const wrecks = new Map();
  for (const [c, r, cost] of level.wrecks || []) {
    grid[idx(c, r)] = TILE.WRECK;
    wrecks.set(idx(c, r), { col: c, row: r, cost, ...tileToWorld(level, c, r) });
  }

  // Air routes: explicit smooth routes, otherwise the ground route with wide corners (flyers ignore tunnels).
  const airPaths = (level.airPaths || level.paths).map((wp) => {
    const pts = withApproach(wp.map(([c, r]) => tileToWorld(level, c, r)));
    return level.airPaths ? new Path(smoothRoute(pts), 0) : new Path(pts, 1.6);
  });

  return {
    cols, rows, grid, paths, airPaths, spawns, core, gates, nodes, wrecks,
    at(c, r) { return c < 0 || r < 0 || c >= cols || r >= rows ? TILE.VOID : grid[idx(c, r)]; },
    isNode(c, r) { return nodes.has(idx(c, r)); },
    wreckAt(c, r) { return wrecks.get(idx(c, r)) || null; },
    clearWreck(c, r) { wrecks.delete(idx(c, r)); grid[idx(c, r)] = TILE.BUILD; },
  };
}
