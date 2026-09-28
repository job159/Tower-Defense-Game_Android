// WebGL renderer + post-processing chain (HDR render -> bloom -> tone mapping -> FXAA), with quality tiers.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

export const QUALITY = {
  low:    { label: '低', dpr: 1, shadows: 0, msaa: 0, fxaa: false, bloom: 0.5 },
  medium: { label: '中', dpr: 1.5, shadows: 1024, msaa: 0, fxaa: true, bloom: 1 },
  high:   { label: '高', dpr: 2, shadows: 2048, msaa: 4, fxaa: false, bloom: 1 },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.setClearColor(0x05040d, 1);
    const ext = this.gl.extensions;
    this.hdr = !!(ext.get('EXT_color_buffer_float') || ext.get('EXT_color_buffer_half_float'));
    this.composer = null;
    this.quality = null;
    this.scene = null;
    this.camera = null;
    this.width = 1;
    this.height = 1;
  }

  // (Re)build the post chain. Shadow map size changes require scene materials to recompile (handled by three).
  setQuality(name) {
    const q = QUALITY[name] || QUALITY.medium;
    this.quality = name;
    this.q = q;
    this.gl.shadowMap.enabled = q.shadows > 0;
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) p.dispose?.();
    }
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    this.dpr = dpr;
    this.gl.setPixelRatio(dpr);
    const rt = new THREE.WebGLRenderTarget(this.width * dpr, this.height * dpr, {
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: this.hdr ? q.msaa : 0,
    });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width * q.bloom, this.height * q.bloom), 0.7, 0.45, this.hdr ? 1.0 : 0.75);
    // Safety net: a single NaN/Inf pixel (e.g. flat-shading derivatives on a sliver triangle) would be
    // smeared across the screen by the bloom blur. Sanitize the bloom input.
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );',
      'vec4 texel = texture2D( tDiffuse, vUv ); if (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0); texel = min(texel, vec4(64.0));');
    hp.needsUpdate = true;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (q.fxaa) this.composer.addPass(new FXAAPass());
    this.resize(this.width, this.height);
  }

  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    if (this.renderPass) { this.renderPass.scene = scene; this.renderPass.camera = camera; }
  }

  resize(w, h) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.gl.setSize(this.width, this.height, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.dpr);
      this.composer.setSize(this.width, this.height);
      if (this.q.bloom < 1) this.bloom.setSize(this.width * this.dpr * this.q.bloom, this.height * this.dpr * this.q.bloom);
    }
    if (this.camera) {
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
  }

  render() {
    if (!this.scene || !this.camera) return;
    this.composer.render();
  }
}

// Frame-time monitor used by "auto" quality to step down on slow devices.
export class PerfMonitor {
  constructor() { this.samples = []; this.cooldown = 4; }
  push(dt) {
    this.samples.push(dt);
    if (this.samples.length > 90) this.samples.shift();
  }
  // returns -1 to lower quality, 0 otherwise
  check(dt) {
    this.cooldown -= dt;
    if (this.cooldown > 0 || this.samples.length < 60) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.cooldown = 3;
    if (median > 1 / 38) { this.samples.length = 0; this.cooldown = 5; return -1; }
    return 0;
  }
}
