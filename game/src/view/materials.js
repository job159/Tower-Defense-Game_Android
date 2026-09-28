// Shared materials and procedurally generated textures (no image assets needed).
import * as THREE from 'three';

export const COLORS = {
  cyan: 0x22e6ff,
  magenta: 0xff2fd0,
  violet: 0x8a5cff,
  orange: 0xff7a1a,
  red: 0xff2d4a,
  lime: 0x7dff5a,
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

// Sci-fi floor panel (albedo) + matching emissive "slot" markers.
function makePanelTextures() {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#8d97ad';
  g.fillRect(0, 0, S, S);
  // speckle noise
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // subtle vertical brushed streaks
  g.globalAlpha = 0.06;
  for (let i = 0; i < 90; i++) {
    g.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
    g.fillRect(Math.random() * S, 0, 1 + Math.random() * 2, S);
  }
  g.globalAlpha = 1;
  // inner panel grooves
  g.strokeStyle = 'rgba(20,24,36,0.85)';
  g.lineWidth = 3;
  g.strokeRect(22, 22, S - 44, S - 44);
  g.beginPath();
  g.moveTo(22, S * 0.62); g.lineTo(S - 22, S * 0.62);
  g.moveTo(S * 0.38, 22); g.lineTo(S * 0.38, S * 0.62);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 1;
  g.strokeRect(24, 24, S - 48, S - 48);
  // bolts
  for (const [x, y] of [[36, 36], [S - 36, 36], [36, S - 36], [S - 36, S - 36]]) {
    g.fillStyle = 'rgba(15,18,28,0.9)';
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.arc(x - 1, y - 1, 2, 0, Math.PI * 2); g.fill();
  }
  // vent slits
  g.fillStyle = 'rgba(15,18,28,0.75)';
  for (let i = 0; i < 6; i++) g.fillRect(S * 0.5 + i * 14, S * 0.72, 7, 30);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  const [e, eg] = canvas(S, S);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, S, S);
  eg.strokeStyle = '#fff';
  eg.lineWidth = 4;
  const L = 34, m = 10;
  // corner brackets = "buildable slot" markers
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [S - m, m, -1, 1], [m, S - m, 1, -1], [S - m, S - m, -1, -1]]) {
    eg.beginPath();
    eg.moveTo(x, y + sy * L); eg.lineTo(x, y); eg.lineTo(x + sx * L, y);
    eg.stroke();
  }
  eg.fillStyle = '#fff';
  eg.fillRect(S * 0.5, S * 0.68, 18, 3);
  const emi = new THREE.CanvasTexture(e);
  emi.colorSpace = THREE.SRGBColorSpace;
  return { map, emi };
}

let _panel = null;
export function panelTextures() {
  if (!_panel) _panel = makePanelTextures();
  return _panel;
}

// Radial glow texture for decals / sprites fallback.
let _glow = null;
export function glowTexture() {
  if (_glow) return _glow;
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}

// Metal for towers, enemies and props: tinted by vertex colors.
export const metalMat = new THREE.MeshStandardMaterial({
  vertexColors: true, metalness: 0.75, roughness: 0.38, flatShading: true, envMapIntensity: 1.1,
});
export const darkMetalMat = new THREE.MeshStandardMaterial({
  color: 0x151a2a, metalness: 0.7, roughness: 0.55, envMapIntensity: 0.7,
});

// Lit metal whose vertices can also glow: per-vertex attribute aGlow (0 = metal, 1 = neon) adds
// vertexColor * intensity as emission. Lets a whole tower part render in a single draw call.
const emissiveCache = new Map();
export function emissiveVertexMat(intensity = 2.2) {
  let m = emissiveCache.get(intensity);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.38, flatShading: true, envMapIntensity: 1.1 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vColor.rgb * vGlow * ${intensity.toFixed(2)};
          diffuseColor.rgb *= 1.0 - vGlow * 0.7;`);
    };
    m.customProgramCacheKey = () => `emissiveVertex${intensity}`;
    emissiveCache.set(intensity, m);
  }
  return m;
}

const glowCache = new Map();
// Unlit emissive material; intensity > 1 pushes it above the bloom threshold.
export function glowMat(color, intensity = 3, opts = {}) {
  const key = `${color}|${intensity}|${opts.transparent ? 1 : 0}|${opts.opacity || 1}`;
  let m = glowCache.get(key);
  if (!m) {
    const c = new THREE.Color(color).multiplyScalar(intensity);
    m = new THREE.MeshBasicMaterial({ color: c, fog: true, ...opts });
    glowCache.set(key, m);
  }
  return m;
}

// Emissive material that supports per-vertex color (merged glow meshes with several colors).
export function glowVertexMat(intensity = 3) {
  const key = `vc|${intensity}`;
  let m = glowCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(intensity, intensity, intensity) });
    glowCache.set(key, m);
  }
  return m;
}

export function isSharedMaterial(m) {
  if (m === metalMat || m === darkMetalMat) return true;
  for (const v of emissiveCache.values()) if (v === m) return true;
  for (const v of glowCache.values()) if (v === m) return true;
  return false;
}

// Neon environment for metallic reflections (rendered once into a PMREM cube).
export function buildEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03040a);
  const strip = (color, intensity, w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    if (ry) m.rotation.z += ry;
    scene.add(m);
  };
  strip(0x6a74a0, 0.7, 30, 30, 0, 18, 0);          // cool sky panel
  strip(COLORS.cyan, 3.0, 26, 1.2, 0, 5, -14);      // horizon strips
  strip(COLORS.magenta, 3.0, 26, 1.2, 0, 4, 14);
  strip(COLORS.violet, 2.5, 1.2, 20, -14, 3, 0);
  strip(COLORS.orange, 2.0, 1.2, 14, 14, 2, 0);
  strip(0xffffff, 2.0, 6, 6, -6, 14, -6);           // key highlight
  strip(0x220a33, 1, 40, 40, 0, -12, 0);            // dark purple floor bounce
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.035).texture;
  pmrem.dispose();
  scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return tex;
}
