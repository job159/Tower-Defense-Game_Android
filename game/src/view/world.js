// Static level scenery: floating platform, neon lanes, props, spawn portals, the core, and the city far below.
import * as THREE from 'three';
import { TILE, tileToWorld } from '../core/path.js';
import { mulberry32 } from '../core/rng.js';
import { GeoBuilder, bevelSlab, box, cyl, cone, sphere, torus, octa } from './geo.js';
import { panelTextures, metalMat, darkMetalMat, glowMat, glowVertexMat, glowTexture, isSharedMaterial, COLORS } from './materials.js';

export const GROUND_Y = -0.1; // path floor height where ground units walk

const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };

export class World {
  constructor(level, map, scene, opts = {}) {
    this.level = level;
    this.map = map;
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = { uTime: { value: 0 } };
    this.anims = [];
    this.rand = mulberry32(level.id * 977 + 3);
    this.buildLights(opts.shadows);
    this.buildPlatform();
    this.buildLanes();
    this.buildDecor();
    this.buildPortals();
    this.buildGates();
    this.buildNodes();
    this.buildWrecks();
    this.buildCore();
    this.buildUnderside();
    this.buildCity();
    this.buildDust();
  }

  add(obj) { this.group.add(obj); return obj; }

  buildLights(shadows) {
    const { cols, rows } = this.level;
    const hemi = new THREE.HemisphereLight(0x6f7fd8, 0x1a0b26, 0.55);
    this.add(hemi);
    const sun = new THREE.DirectionalLight(0xc8d4ff, 1.7);
    sun.position.set(-5, 12, 7);
    sun.target.position.set(0, 0, 0);
    this.add(sun);
    this.add(sun.target);
    if (shadows) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(shadows, shadows);
      const cam = sun.shadow.camera;
      const ext = Math.max(cols, rows) / 2 + 1.5;
      cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
      cam.near = 1; cam.far = 30;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      sun.shadow.radius = 3;
    }
    this.sun = sun;
    const rim = new THREE.DirectionalLight(0xff4fd8, 0.9);
    rim.position.set(6, 4, -8);
    this.add(rim);
  }

  buildPlatform() {
    const { level, map } = this;
    const { map: panelMap, emi } = panelTextures();
    const slab = bevelSlab(0.95, 0.16, 0.95, 0.035);
    const buildB = new GeoBuilder(true), oppB = new GeoBuilder(true), otherB = new GeoBuilder(true), pathB = new GeoBuilder(true);
    const oppHalf = (c) => level.versus && c >= level.half;
    const sideB = new GeoBuilder(), trimB = new GeoBuilder();
    const wreckSlabs = [];
    const rand = this.rand;
    const isSolid = (c, r) => map.at(c, r) !== TILE.VOID;
    for (let r = 0; r < level.rows; r++) {
      for (let c = 0; c < level.cols; c++) {
        const t = map.at(c, r);
        if (t === TILE.VOID) continue;
        const { x, z } = tileToWorld(level, c, r);
        const rot = [0, (Math.floor(rand() * 4) * Math.PI) / 2, 0];
        if (t === TILE.BUILD) {
          const v = 0.88 + rand() * 0.12;
          (oppHalf(c) ? oppB : buildB).add(slab.clone(), new THREE.Color(0.2 * v, 0.215 * v, 0.27 * v), [x, 0, z], rot);
        } else if (t === TILE.DECOR) {
          otherB.add(slab.clone(), 0x1a1e2a, [x, 0, z], rot);
        } else if (t === TILE.WRECK) {
          wreckSlabs.push([c, r, x, z, rot]);
        } else {
          // path / spawn / core floor: full-size low plate
          pathB.add(bevelSlab(1.0, 0.1, 1.0, 0.01), 0x10131d, [x, GROUND_Y, z], rot);
        }
        // exposed platform sides
        for (const [dc, dr, nx, nz] of [[0, 1, 0, 1], [0, -1, 0, -1], [1, 0, 1, 0], [-1, 0, -1, 0]]) {
          if (isSolid(c + dc, r + dr)) continue;
          const px = x + nx * 0.5, pz = z + nz * 0.5;
          const ry = Math.atan2(nx, nz);
          sideB.add(new THREE.PlaneGeometry(1.0, 0.76), 0x3a4360, [px, -0.52, pz], [0, ry, 0]);
          trimB.add(new THREE.PlaneGeometry(1.0, 0.035), COLORS.magenta, [px + nx * 0.004, -0.2, pz + nz * 0.004], [0, ry, 0]);
          trimB.add(new THREE.PlaneGeometry(1.0, 0.02), COLORS.cyan, [px + nx * 0.004, -0.86, pz + nz * 0.004], [0, ry, 0]);
          if ((c + r) % 3 === 0) trimB.add(new THREE.PlaneGeometry(0.04, 0.5), COLORS.cyan, [px + nx * 0.004, -0.52, pz + nz * 0.004], [0, ry, 0]);
        }
      }
    }
    this.tileMat = new THREE.MeshStandardMaterial({
      map: panelMap, vertexColors: true, metalness: 0.55, roughness: 0.46,
      emissiveMap: emi, emissive: new THREE.Color(COLORS.cyan).multiplyScalar(0.8), envMapIntensity: 1.2,
    });
    const plainMat = new THREE.MeshStandardMaterial({ map: panelMap, vertexColors: true, metalness: 0.6, roughness: 0.5, envMapIntensity: 0.8 });
    const pathMat = new THREE.MeshStandardMaterial({ map: panelMap, vertexColors: true, metalness: 0.7, roughness: 0.35, envMapIntensity: 1.0 });
    const mk = (b, mat, recv = true) => {
      const g = b.build();
      if (!g) return null;
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = recv;
      return this.add(m);
    };
    this.buildMesh = mk(buildB, this.tileMat);
    if (level.versus) {
      this.oppTileMat = this.tileMat.clone();
      this.oppTileMat.emissive = new THREE.Color(0xff3d8a).multiplyScalar(0.55);
      mk(oppB, this.oppTileMat);
    }
    mk(otherB, plainMat);
    this.wreckSlabs = new Map();
    for (const [c, r, x, z, rot] of wreckSlabs) {
      const g = new GeoBuilder(true).add(slab.clone(), 0x1d2130, [x, 0, z], rot).build();
      const m = new THREE.Mesh(g, plainMat);
      m.receiveShadow = true;
      this.wreckSlabs.set(`${c},${r}`, this.add(m));
    }
    mk(pathB, pathMat);
    slab.dispose();
    const sides = mk(sideB, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.6, side: THREE.DoubleSide }), false);
    mk(trimB, glowVertexMat(2.4), false);
    // dark underlay visible in the gaps between tiles
    const under = new GeoBuilder();
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      if (!isSolid(c, r)) continue;
      const { x, z } = tileToWorld(level, c, r);
      under.add(new THREE.PlaneGeometry(1, 1), 0x05070d, [x, -0.14, z], [-Math.PI / 2, 0, 0]);
    }
    mk(under, new THREE.MeshBasicMaterial({ vertexColors: true }), false);
  }

  // Glowing channel borders + animated flow chevrons along each route.
  buildLanes() {
    const { level, map } = this;
    const lines = new GeoBuilder();
    const isLane = (c, r) => { const t = map.at(c, r); return t === TILE.PATH || t === TILE.SPAWN || t === TILE.CORE; };
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      if (!isLane(c, r)) continue;
      const { x, z } = tileToWorld(level, c, r);
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const n = map.at(c + dc, r + dr);
        if (isLane(c + dc, r + dr) || n === TILE.VOID) continue;
        const horiz = dc === 0;
        const ox = dc * 0.43, oz = dr * 0.43;
        lines.add(new THREE.PlaneGeometry(horiz ? 1.0 : 0.035, horiz ? 0.035 : 1.0), level.versus && c >= level.half ? 0xff3d8a : COLORS.cyan, [x + ox, GROUND_Y + 0.004, z + oz], [-Math.PI / 2, 0, 0]);
      }
    }
    const g = lines.build();
    if (g) this.add(new THREE.Mesh(g, glowVertexMat(2.2)));

    const flowMat = (color) => new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(color).multiplyScalar(0.9) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float y = abs(vUv.y - 0.5) * 2.0;
          float f = fract(vUv.x * 1.25 + y * 0.32 - uTime * 0.9);
          float chev = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.14, 0.26, f));
          float a = chev * (1.0 - smoothstep(0.65, 1.0, y)) * 0.55;
          gl_FragColor = vec4(uColor * a, 1.0);
        }`,
      ...additive,
    });
    this.map.paths.forEach((path, pi) => {
      const pos = [], uv = [], idx = [];
      const w = 0.2, P = { x: 0, z: 0, dx: 0, dz: 0 };
      let i = 0;
      for (let d = 0.6; d <= path.length; d += 0.1) {
        if (path.inWarp(d)) { i = 0; continue; } // no arrows inside warp tunnels
        path.sample(d, P);
        const nx = -P.dz * w, nz = P.dx * w;
        const base = pos.length / 3;
        pos.push(P.x + nx, GROUND_Y + 0.006, P.z + nz, P.x - nx, GROUND_Y + 0.006, P.z - nz);
        uv.push(d, 0, d, 1);
        if (i > 0) { const a = base - 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        i++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, flowMat(level.versus && pi === 1 ? 0xff3d8a : COLORS.cyan));
      m.renderOrder = 2;
      this.add(m);
    });
    if (level.versus) this.buildDivider();
  }

  // Versus: a glowing seam down the middle of the platform between the two halves.
  buildDivider() {
    const { level } = this;
    const g = new GeoBuilder();
    for (let r = 0; r < level.rows; r++) {
      const z = r - (level.rows - 1) / 2;
      if (this.map.at(level.half - 1, r) === TILE.VOID) continue;
      g.add(new THREE.PlaneGeometry(0.05, 0.98), 0xffffff, [0, 0.085, z], [-Math.PI / 2, 0, 0]);
    }
    const m = new THREE.Mesh(g.build(), new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; varying vec3 vP;
        void main(){ float p = 0.55 + 0.45 * sin(vP.z * 2.5 - uTime * 3.0); gl_FragColor = vec4(vec3(0.6, 0.55, 1.0) * (1.4 + p), 1.0); }`,
      ...additive,
    }));
    m.renderOrder = 3;
    this.add(m);
  }

  buildDecor() {
    const { level, map, rand } = this;
    const metal = new GeoBuilder(), glow = new GeoBuilder();
    const accents = [COLORS.cyan, COLORS.magenta, COLORS.violet, COLORS.orange];
    const blinkers = [];
    for (let r = 0; r < level.rows; r++) for (let c = 0; c < level.cols; c++) {
      if (map.at(c, r) !== TILE.DECOR) continue;
      const { x, z } = tileToWorld(level, c, r);
      const kind = Math.floor(rand() * 4);
      const acc = accents[Math.floor(rand() * accents.length)];
      if (kind === 0) {
        // server rack cluster
        for (const [ox, oz, h] of [[-0.2, -0.15, 0.7], [0.18, -0.12, 0.95], [0, 0.22, 0.5]]) {
          metal.add(box(0.3, h, 0.3), 0x2b3348, [x + ox, h / 2, z + oz]);
          for (let k = 0; k < 3; k++) glow.add(box(0.31, 0.025, 0.31), acc, [x + ox, 0.15 + k * (h - 0.2) / 3, z + oz]);
        }
      } else if (kind === 1) {
        // antenna mast with blinking beacon
        metal.add(cyl(0.2, 0.28, 0.18, 8), 0x2b3348, [x, 0.09, z]);
        metal.add(cyl(0.035, 0.05, 1.5, 6), 0x5a6480, [x, 0.9, z]);
        metal.add(box(0.5, 0.03, 0.03), 0x5a6480, [x, 1.2, z]);
        metal.add(box(0.03, 0.03, 0.4), 0x5a6480, [x, 1.4, z]);
        blinkers.push([x, 1.68, z]);
      } else if (kind === 2) {
        // energy cell
        metal.add(cyl(0.32, 0.36, 0.14, 10), 0x2b3348, [x, 0.07, z]);
        metal.add(cyl(0.22, 0.22, 0.7, 10), 0x3c4660, [x, 0.49, z]);
        glow.add(cyl(0.225, 0.225, 0.08, 10, true), acc, [x, 0.35, z]);
        glow.add(cyl(0.225, 0.225, 0.08, 10, true), acc, [x, 0.6, z]);
        metal.add(cyl(0.12, 0.22, 0.12, 10), 0x5a6480, [x, 0.9, z]);
      } else {
        // cargo crates + holo sign
        metal.add(box(0.42, 0.34, 0.42), 0x3a3230, [x - 0.12, 0.17, z + 0.1], [0, 0.3, 0]);
        metal.add(box(0.3, 0.26, 0.3), 0x2f3a45, [x + 0.2, 0.13, z - 0.18], [0, -0.2, 0]);
        metal.add(box(0.28, 0.24, 0.28), 0x3a3230, [x - 0.1, 0.46, z + 0.08], [0, 0.6, 0]);
        glow.add(box(0.43, 0.02, 0.43), COLORS.orange, [x - 0.12, 0.3, z + 0.1], [0, 0.3, 0]);
      }
    }
    const mg = metal.build(), gg = glow.build();
    if (mg) { const m = this.add(new THREE.Mesh(mg, metalMat)); m.castShadow = true; m.receiveShadow = true; }
    if (gg) this.add(new THREE.Mesh(gg, glowVertexMat(2.6)));
    if (blinkers.length) {
      const bm = glowMat(COLORS.red, 5).clone();
      const bg = new GeoBuilder();
      for (const p of blinkers) bg.add(sphere(0.05, 8, 6), 0xffffff, p);
      const mesh = this.add(new THREE.Mesh(bg.build(), bm));
      this.anims.push((t) => { mesh.visible = Math.sin(t * 3.2) > 0.2; });
    }
  }

  makePortal(color, color2, scale = 1) {
    const portalMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(color) }, uColor2: { value: new THREE.Color(color2) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform vec3 uColor2; varying vec2 vUv;
        void main(){
          vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
          float a = atan(p.y, p.x);
          float sw = sin(a * 3.0 + r * 9.0 - uTime * 5.0) * 0.5 + 0.5;
          float sw2 = sin(a * 5.0 - r * 6.0 + uTime * 3.0) * 0.5 + 0.5;
          float core = pow(max(0.0, 1.0 - r), 2.5);
          vec3 c = mix(uColor, uColor2, sw2) * (sw * 0.9 + 0.25) * (1.0 - smoothstep(0.8, 1.0, r)) + vec3(1.0, 0.8, 1.0) * core * 1.6;
          gl_FragColor = vec4(c * 1.4, 1.0);
        }`,
      side: THREE.DoubleSide,
      ...additive,
    });
    const g = new THREE.Group();
    const frame = new GeoBuilder();
    frame.add(box(1.0, 0.1, 0.34), 0x2b3348, [0, 0.05, 0]);
    frame.add(box(0.12, 0.9, 0.2), 0x3a4460, [-0.5, 0.5, 0]);
    frame.add(box(0.12, 0.9, 0.2), 0x3a4460, [0.5, 0.5, 0]);
    frame.add(box(1.12, 0.12, 0.22), 0x3a4460, [0, 0.98, 0]);
    const fm = new THREE.Mesh(frame.build(), metalMat);
    fm.castShadow = true;
    g.add(fm);
    const ring = new THREE.Mesh(torus(0.4, 0.035, 6, 32), glowMat(color, 4));
    ring.position.y = 0.5;
    g.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.38, 32), portalMat);
    disc.position.y = 0.5;
    g.add(disc);
    for (const sx of [-0.5, 0.5]) {
      const strip = new THREE.Mesh(box(0.13, 0.03, 0.21), glowMat(color, 3));
      strip.position.set(sx, 0.3, 0);
      g.add(strip);
    }
    g.scale.setScalar(scale);
    this.anims.push((t) => { ring.rotation.z = t * 0.8; ring.scale.setScalar(1 + Math.sin(t * 4) * 0.03); });
    return g;
  }

  buildPortals() {
    this.portals = [];
    for (const s of this.map.spawns) {
      const g = this.makePortal(COLORS.magenta, 0xff4d80);
      g.position.set(s.x, GROUND_Y, s.z);
      g.rotation.y = Math.atan2(s.dirX, s.dirZ);
      this.add(g);
      this.portals.push({ group: g, x: s.x, z: s.z });
    }
  }

  // Warp tunnel gates: violet portals where enemies vanish and re-emerge.
  buildGates() {
    this.gates = [];
    const P = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const path of this.map.paths) {
      for (const [d0, d1] of path.warps) {
        for (const d of [d0 - 0.15, d1 + 0.15]) {
          path.sample(d, P);
          const g = this.makePortal(COLORS.violet, 0x5ad8ff, 0.85);
          g.position.set(P.x, GROUND_Y, P.z);
          g.rotation.y = Math.atan2(P.dx, P.dz);
          this.add(g);
          this.gates.push({ group: g, x: P.x, z: P.z });
        }
      }
    }
  }

  // Power nodes: glowing hex sigil on the tile (dimmed while still buried under wreckage).
  buildNodes() {
    if (!this.nodeMat) {
      this.nodeMat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(0xffc93d) } },
        vertexShader: `attribute float aDim; varying vec2 vUv; varying float vDim; void main(){ vUv = uv; vDim = aDim; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv; varying float vDim;
          void main(){
            vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
            float ang = atan(p.y, p.x);
            float hr = r * cos(3.14159/6.0) / cos(mod(ang, 3.14159/3.0) - 3.14159/6.0);
            float ring = smoothstep(0.78, 0.84, hr) * (1.0 - smoothstep(0.88, 0.94, hr));
            float inner = smoothstep(0.42, 0.46, hr) * (1.0 - smoothstep(0.5, 0.54, hr));
            float spokes = (1.0 - smoothstep(0.02, 0.05, abs(sin(ang * 3.0)))) * step(0.5, hr) * (1.0 - step(0.8, hr)) * 0.6;
            float core = exp(-r * r * 12.0) * 0.8;
            float pulse = 0.65 + 0.35 * sin(uTime * 2.4 + vDim * 9.0);
            float a = (ring * 1.4 + inner + spokes + core) * pulse * mix(1.0, 0.25, vDim);
            gl_FragColor = vec4(uColor * a * 1.6, 1.0);
          }`,
        ...additive,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
    }
    const merged = new GeoBuilder(true);
    for (const idx of this.map.nodes) {
      const c = idx % this.level.cols, r = Math.floor(idx / this.level.cols);
      const { x, z } = tileToWorld(this.level, c, r);
      const g = new THREE.PlaneGeometry(0.92, 0.92).toNonIndexed();
      g.rotateX(-Math.PI / 2);
      g.translate(x, 0.004, z);
      const dim = this.map.at(c, r) === TILE.WRECK ? 1 : 0;
      g.setAttribute('aDim', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(dim), 1));
      merged.addRaw(g);
    }
    if (merged.empty) return;
    this.nodeMesh = new THREE.Mesh(merged.build(), this.nodeMat);
    this.nodeMesh.renderOrder = 3;
    this.add(this.nodeMesh);
  }

  refreshNodes() {
    if (this.nodeMesh) {
      this.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      this.nodeMesh = null;
    }
    this.buildNodes();
  }

  remove(obj) { this.group.remove(obj); }

  // Wreckage: burnt-out debris piles with sparking wires; cleared for credits.
  buildWrecks() {
    this.wreckProps = new Map();
    for (const w of this.map.wrecks.values()) {
      const rand = mulberry32(w.col * 31 + w.row * 7);
      const metal = new GeoBuilder(), glow = new GeoBuilder();
      for (let i = 0; i < 5; i++) {
        const sx = 0.14 + rand() * 0.22, sy = 0.05 + rand() * 0.12, sz = 0.14 + rand() * 0.3;
        metal.add(box(sx, sy, sz), rand() < 0.5 ? 0x2a2622 : 0x3a3430, [(rand() - 0.5) * 0.5, sy / 2 + rand() * 0.08, (rand() - 0.5) * 0.5], [(rand() - 0.5) * 0.8, rand() * 3, (rand() - 0.5) * 0.8]);
      }
      metal.add(cyl(0.03, 0.03, 0.62, 6), 0x4a4038, [0.05, 0.16, 0], [0.4, 0.3, 1.1]);
      metal.add(box(0.5, 0.04, 0.08), 0x3a3430, [-0.05, 0.2, 0.12], [0.2, 0.8, 0.35]);
      glow.add(box(0.03, 0.03, 0.3), 0xff5a2a, [0.1, 0.14, -0.12], [0.3, 0.6, 0]);
      glow.add(sphere(0.035, 6, 4), 0xff8a3d, [-0.16, 0.12, 0.1]);
      const grp = new THREE.Group();
      const mm = new THREE.Mesh(metal.build(), metalMat);
      mm.castShadow = true;
      grp.add(mm);
      const spark = new THREE.Mesh(glow.build(), glowVertexMat(2.4));
      grp.add(spark);
      // hazard ring so the tile reads as "clearable"
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.44, 24), glowMat(0xff8a3d, 1.4, { ...additive, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.006;
      grp.add(ring);
      grp.position.set(w.x, 0, w.z);
      this.add(grp);
      this.wreckProps.set(`${w.col},${w.row}`, grp);
      this.anims.push((t) => { spark.visible = Math.sin(t * 13 + w.col) > -0.3 || Math.random() < 0.1; });
    }
  }

  clearWreck(col, row) {
    const key = `${col},${row}`;
    const prop = this.wreckProps.get(key);
    if (prop) { this.remove(prop); this.wreckProps.delete(key); }
    const slab = this.wreckSlabs.get(key);
    if (slab) slab.material = this.tileMat;
    this.refreshNodes();
  }

  buildCore() {
    // versus maps have one core per lane: ours (cyan) and the opponent's (red/magenta)
    const palettes = [{ main: COLORS.cyan, ring: COLORS.magenta, crystal: 0x7ff4ff }, { main: 0xff3d6e, ring: 0xffb03d, crystal: 0xff8fb0 }];
    this.cores = this.map.cores.map((c, i) => this.makeCore(c.x, c.z, palettes[this.level.versus ? i : 0]));
    this.core = this.cores[0];
  }

  makeCore(x, z, pal) {
    const g = new THREE.Group();
    g.position.set(x, GROUND_Y, z);
    const base = new GeoBuilder();
    base.add(cyl(0.5, 0.56, 0.12, 8), 0x2b3348, [0, 0.06, 0]);
    base.add(cyl(0.4, 0.46, 0.12, 8), 0x3c4660, [0, 0.18, 0]);
    base.add(cyl(0.18, 0.28, 0.2, 8), 0x55607a, [0, 0.34, 0]);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      base.add(box(0.1, 0.55, 0.1), 0x3c4660, [Math.cos(a) * 0.42, 0.4, Math.sin(a) * 0.42], [0, -a, 0]);
    }
    const bm = new THREE.Mesh(base.build(), metalMat);
    bm.castShadow = true;
    bm.receiveShadow = true;
    g.add(bm);
    const tips = new GeoBuilder();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      tips.add(octa(0.06), 0xffffff, [Math.cos(a) * 0.42, 0.72, Math.sin(a) * 0.42]);
    }
    tips.add(cyl(0.47, 0.47, 0.03, 8, true), 0xffffff, [0, 0.245, 0]);
    g.add(new THREE.Mesh(tips.build(), new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(pal.main).multiplyScalar(3.5) })));

    const crystalMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.crystal).multiplyScalar(4) });
    const crystal = new THREE.Mesh(octa(0.2), crystalMat);
    crystal.scale.set(1, 1.7, 1);
    crystal.position.y = 1.05;
    g.add(crystal);
    const shellMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.main).multiplyScalar(0.6), ...additive, opacity: 1 });
    const shell = new THREE.Mesh(octa(0.32), shellMat);
    shell.scale.set(1, 1.6, 1);
    shell.position.y = 1.05;
    g.add(shell);
    const beam = new THREE.Mesh(cyl(0.05, 0.08, 0.7, 8, true), glowMat(pal.main, 2.2, { ...additive }));
    beam.position.y = 0.72;
    g.add(beam);
    const r1 = new THREE.Mesh(torus(0.46, 0.018, 6, 40), glowMat(pal.ring, 3.5));
    const r2 = new THREE.Mesh(torus(0.36, 0.014, 6, 40), glowMat(pal.main, 3.5));
    r1.position.y = r2.position.y = 1.05;
    g.add(r1, r2);
    // shield dome
    const shieldUniforms = { uTime: this.uniforms.uTime, uHit: { value: 0 }, uColor: { value: new THREE.Color(pal.main) } };
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.78, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: shieldUniforms,
      vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime; uniform float uHit; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){
          float fr = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.5);
          vec2 h = vec2(atan(vP.z, vP.x) * 6.0, vP.y * 14.0);
          float hex = smoothstep(0.85, 1.0, abs(sin(h.x)) ) + smoothstep(0.9, 1.0, abs(sin(h.y + uTime)));
          float scan = smoothstep(0.96, 1.0, sin(vP.y * 9.0 - uTime * 3.0));
          vec3 c = mix(uColor, vec3(1.0, 0.25, 0.3), uHit) * (fr * 0.9 + hex * 0.12 + scan * 0.25) * (0.6 + uHit * 2.5);
          gl_FragColor = vec4(c, 1.0);
        }`,
      ...additive, side: THREE.DoubleSide,
    }));
    g.add(dome);
    this.add(g);
    const core = { group: g, crystal, shell, r1, r2, dome, hit: 0, danger: 0 };
    const crystalBase = new THREE.Color(pal.crystal);
    const hurt = new THREE.Color(0xff3050);
    this.anims.push((t, dt) => {
      crystal.rotation.y = t * 0.9;
      shell.rotation.y = -t * 0.5;
      const bob = Math.sin(t * 1.6) * 0.05;
      crystal.position.y = shell.position.y = 1.05 + bob;
      r1.rotation.set(Math.PI / 2 + Math.sin(t * 0.7) * 0.5, t * 0.6, 0);
      r2.rotation.set(Math.PI / 2 + Math.cos(t * 0.9) * 0.6, -t * 0.8, 0.4);
      r1.position.y = r2.position.y = 1.05 + bob;
      core.hit = Math.max(0, core.hit - dt * 2.2);
      shieldUniforms.uHit.value = Math.min(1, core.hit + core.danger * (0.25 + 0.25 * Math.sin(t * 6)));
      crystalMat.color.copy(crystalBase).lerp(hurt, Math.min(1, core.hit + core.danger * 0.6)).multiplyScalar(4);
      g.position.x = x + (core.hit > 0.3 ? (Math.random() - 0.5) * 0.04 * core.hit : 0);
    });
    return core;
  }

  hitCore(amount = 1, i = 0) { const c = this.cores[i] || this.core; c.hit = Math.min(1.5, c.hit + 0.6 + amount * 0.2); }
  setDanger(v, i = 0) { (this.cores[i] || this.core).danger = v; }

  // Support pillars and thrusters under the floating platform.
  buildUnderside() {
    const { level } = this;
    const b = new GeoBuilder(), gl = new GeoBuilder();
    const hx = level.cols / 2 - 1.5, hz = level.rows / 2 - 1.5;
    const spots = [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz], [0, hz + 0.5], [0, -hz - 0.5]];
    for (const [x, z] of spots) {
      b.add(cyl(0.45, 0.35, 1.2, 8), 0x1d2336, [x, -1.4, z]);
      b.add(cyl(0.28, 0.28, 22, 8), 0x161b2a, [x, -13, z]);
      for (let k = 0; k < 6; k++) gl.add(cyl(0.3, 0.3, 0.06, 8, true), k % 2 ? COLORS.magenta : COLORS.cyan, [x, -3 - k * 3.2, z]);
      gl.add(cyl(0.32, 0.4, 0.05, 12), COLORS.cyan, [x, -2.02, z]);
    }
    this.add(new THREE.Mesh(b.build(), darkMetalMat));
    this.add(new THREE.Mesh(gl.build(), glowVertexMat(2.2)));
    // under-glow plane so the platform reads as floating
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(level.cols + 6, level.rows + 6), new THREE.MeshBasicMaterial({
      map: glowTexture(), color: new THREE.Color(0x5a2cff).multiplyScalar(0.6), ...additive,
    }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -3.5;
    this.add(glow);
  }

  // Neon city far below: glowing street grid + instanced towers with procedural windows.
  buildCity() {
    const Y = -42;
    const fogU = THREE.UniformsLib.fog;
    const groundMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogU, { uTime: { value: 0 } }]),
      vertexShader: `varying vec2 vW;
        #include <fog_pars_vertex>
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `varying vec2 vW; uniform float uTime;
        #include <fog_pars_fragment>
        void main(){
          vec2 g = abs(fract(vW / 6.0) - 0.5);
          float line = smoothstep(0.47, 0.5, max(g.x, g.y));
          vec2 g2 = abs(fract(vW / 1.5) - 0.5);
          float fine = smoothstep(0.485, 0.5, max(g2.x, g2.y)) * 0.25;
          float pulse = 0.6 + 0.4 * sin(vW.x * 0.05 + uTime * 0.7);
          vec3 c = vec3(0.9, 0.18, 0.8) * line * 1.2 * pulse + vec3(0.1, 0.8, 1.0) * fine * 0.6;
          gl_FragColor = vec4(c + vec3(0.01, 0.005, 0.03), 1.0);
          #include <fog_fragment>
        }`,
      fog: true,
    });
    this.cityGround = groundMat;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = Y;
    this.add(ground);

    const N = 520;
    const bmat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogU, {}]),
      vertexShader: `varying vec3 vW; varying vec3 vL; varying vec3 vN; varying float vSeed;
        #include <fog_pars_vertex>
        void main(){
          vec4 wp = modelMatrix * instanceMatrix * vec4(position,1.0);
          vW = wp.xyz; vL = position; vN = normal;
          vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898,78.233))) * 43758.5453);
          vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `varying vec3 vW; varying vec3 vL; varying vec3 vN; varying float vSeed;
        #include <fog_pars_fragment>
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        void main(){
          vec3 base = vec3(0.02, 0.022, 0.045);
          vec3 tint = vSeed < 0.33 ? vec3(0.2,0.9,1.0) : (vSeed < 0.66 ? vec3(1.0,0.3,0.85) : vec3(1.0,0.75,0.4));
          vec3 c = base;
          if (abs(vN.y) < 0.5) {
            float u = abs(vN.x) > 0.5 ? vW.z : vW.x;
            vec2 cell = floor(vec2(u * 1.6, vW.y * 2.2));
            vec2 f = fract(vec2(u * 1.6, vW.y * 2.2));
            float lit = step(0.7, h(cell + vSeed * 17.0));
            float win = step(0.2, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.75);
            c += tint * lit * win * 0.9;
          } else {
            vec2 e = abs(vL.xz);
            float edge = smoothstep(0.46, 0.5, max(e.x, e.y));
            c += tint * edge * 0.8;
          }
          gl_FragColor = vec4(c, 1.0);
          #include <fog_fragment>
        }`,
      fog: true,
    });
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bmat, N);
    const m = new THREE.Matrix4();
    const rand = mulberry32(99);
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const gx = Math.round((rand() - 0.5) * 40) * 3, gz = Math.round((rand() - 0.5) * 40) * 3;
      if (Math.abs(gx) < 12 && Math.abs(gz) < 9) continue; // keep directly-below clear
      const w = 1.2 + rand() * 1.4, d = 1.2 + rand() * 1.4, h = 2 + Math.pow(rand(), 2) * 22;
      m.makeScale(w, h, d).setPosition(gx + (rand() - 0.5), Y + h / 2, gz + (rand() - 0.5));
      inst.setMatrixAt(n++, m);
    }
    inst.count = n;
    inst.frustumCulled = false;
    this.add(inst);

    // air traffic: glowing dots streaming along avenues
    const T = 90;
    const tp = new Float32Array(T * 3), td = new Float32Array(T * 4);
    for (let i = 0; i < T; i++) {
      const alongX = rand() < 0.5;
      const lane = Math.round((rand() - 0.5) * 20) * 6;
      tp.set(alongX ? [-120, Y + 4 + rand() * 10, lane] : [lane, Y + 4 + rand() * 10, -120], i * 3);
      td.set([alongX ? 1 : 0, alongX ? 0 : 1, 6 + rand() * 10, rand() * 240], i * 4);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    tg.setAttribute('aDir', new THREE.BufferAttribute(td, 4));
    this.trafficMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime },
      vertexShader: `attribute vec4 aDir; uniform float uTime; varying float vA;
        void main(){ vec3 p = position; float s = mod(aDir.w + uTime * aDir.z, 240.0); p.x += aDir.x * s; p.z += aDir.y * s;
          vec4 mv = modelViewMatrix * vec4(p,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = 90.0 / -mv.z; vA = clamp(1.4 - (-mv.z) / 90.0, 0.0, 1.0); }`,
      fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d,d) * 18.0); gl_FragColor = vec4(vec3(1.0,0.8,0.5) * a * 2.0 * vA, 1.0); }`,
      ...additive,
    });
    const traffic = new THREE.Points(tg, this.trafficMat);
    traffic.frustumCulled = false;
    this.add(traffic);
  }

  // Slowly rising motes of light around the platform for depth.
  buildDust() {
    const N = 160;
    const p = new Float32Array(N * 3), s = new Float32Array(N);
    const { cols, rows } = this.level;
    for (let i = 0; i < N; i++) {
      p[i * 3] = (Math.random() - 0.5) * (cols + 12);
      p[i * 3 + 1] = -8 + Math.random() * 12;
      p[i * 3 + 2] = (Math.random() - 0.5) * (rows + 10);
      s[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(s, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime },
      vertexShader: `attribute float aSeed; uniform float uTime; varying float vA; varying float vS;
        void main(){ vec3 q = position; q.y = -8.0 + mod(q.y + 8.0 + uTime * (0.25 + aSeed * 0.4), 12.0);
          q.x += sin(uTime * 0.3 + aSeed * 30.0) * 0.4;
          vec4 mv = modelViewMatrix * vec4(q,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = (18.0 + aSeed * 20.0) / -mv.z * 6.0; vA = smoothstep(-8.0, -5.0, q.y) * (1.0 - smoothstep(1.0, 4.0, q.y)); vS = aSeed; }`,
      fragmentShader: `varying float vA; varying float vS; void main(){ vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d,d) * 22.0) * vA;
          vec3 c = vS < 0.5 ? vec3(0.3,0.9,1.0) : vec3(1.0,0.35,0.9); gl_FragColor = vec4(c * a * 0.9, 1.0); }`,
      ...additive,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.add(pts);
  }

  update(t, dt) {
    this.uniforms.uTime.value = t;
    this.cityGround.uniforms.uTime.value = t;
    for (const a of this.anims) a(t, dt);
  }

  dispose() {
    this.scene.remove(this.group);
    const mats = new Set();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !isSharedMaterial(o.material)) mats.add(o.material);
    });
    for (const m of mats) m.dispose();
  }
}
