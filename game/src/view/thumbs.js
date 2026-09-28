// Renders tower / enemy icons once at startup with a throwaway WebGL context -> data URLs for the UI.
import * as THREE from 'three';
import * as Models from './models.js';
import { emissiveVertexMat, buildEnvironment } from './materials.js';
import { TOWER_ORDER, ENEMIES } from '../core/config.js';

const _box = new THREE.Box3();
const _sph = new THREE.Sphere();

export function renderThumbnails(size = 112) {
  const out = { tower: {}, enemy: {} };
  let r;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (e) {
    return out;
  }
  r.setPixelRatio(1);
  r.setSize(size, size, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.7;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.environment = buildEnvironment(r);
  scene.add(new THREE.HemisphereLight(0xb8c4ff, 0x332244, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 3.6);
  key.position.set(-2, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5fe8ff, 2.6);
  rim.position.set(3, 2, -3);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  // brighter metal than in-game so small icons read well
  const tmat = emissiveVertexMat(1.3).clone();
  tmat.onBeforeCompile = emissiveVertexMat(1.3).onBeforeCompile;
  tmat.customProgramCacheKey = () => 'thumbTower';
  tmat.color = new THREE.Color(1.8, 1.8, 2);

  // Frame any object automatically from its bounding sphere.
  const shoot = (root, zoom = 1) => {
    scene.add(root);
    root.updateMatrixWorld(true);
    _box.setFromObject(root);
    _box.getBoundingSphere(_sph);
    const dist = (_sph.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 0.92 * zoom;
    const dir = new THREE.Vector3(0.62, 0.62, 0.8).normalize();
    cam.position.copy(_sph.center).addScaledVector(dir, dist);
    cam.lookAt(_sph.center);
    r.render(scene, cam);
    const url = r.domElement.toDataURL('image/png');
    scene.remove(root);
    return url;
  };

  const towerRoot = (md) => {
    const root = new THREE.Group();
    const add = (g, parent) => { if (g) parent.add(new THREE.Mesh(g, tmat)); };
    add(md.base.geo, root);
    const head = new THREE.Group();
    head.position.y = md.head.y;
    head.rotation.y = md.head.aims ? 0.55 : 0;
    root.add(head);
    add(md.head.geo, head);
    if (md.spin) {
      const sp = new THREE.Group();
      sp.position.fromArray(md.spin.pos);
      head.add(sp);
      add(md.spin.geo, sp);
    }
    return root;
  };

  for (const type of TOWER_ORDER) {
    for (const [lv, spec, keySuffix] of [[1, null, ''], [3, null, '-3'], [4, 'a', '-a'], [4, 'b', '-b'], [5, 'a', '-a5'], [5, 'b', '-b5']]) {
      try {
        out.tower[type + keySuffix] = shoot(towerRoot(Models.towerModel(type, lv, spec)), 0.95);
      } catch (e) { /* model not available yet */ }
    }
  }
  const emat = new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color(2.4, 2.4, 2.6), metalness: 0.55, roughness: 0.4, flatShading: true });
  const eglow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.6, 1.6, 1.6) });
  for (const type of Object.keys(ENEMIES)) {
    try {
      const md = Models.enemyModel(type);
      const root = new THREE.Group();
      for (const p of md.parts) {
        if (p.mat === 'shield') continue;
        const m = new THREE.Mesh(p.geo, p.mat === 'metal' ? emat : eglow);
        m.position.fromArray(p.pivot);
        root.add(m);
      }
      root.rotation.y = 0.6;
      out.enemy[type] = shoot(root, 0.9);
    } catch (e) { /* model not available yet */ }
  }
  r.dispose();
  r.forceContextLoss();
  return out;
}
