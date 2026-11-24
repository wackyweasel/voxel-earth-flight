import * as THREE from 'three';

const LEVELS = 5;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function pass(fragment, uniforms, blending = THREE.NoBlending) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: fragment,
    depthTest: false,
    depthWrite: false,
    blending,
  });
}

// Night-time HDR path: the scene is rendered to a half-float target, bright emitters are blurred over a
// mip chain and added back before tone mapping. In daylight the scene goes straight to the canvas.
export class Bloom {
  constructor() {
    this.hdr = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      samples: 4,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.mips = [];
    for (let i = 0; i < LEVELS; i++) {
      this.mips.push(
        new THREE.WebGLRenderTarget(4, 4, {
          type: THREE.HalfFloatType,
          depthBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }),
      );
    }
    this.size = new THREE.Vector2();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);

    this.bright = pass(
      /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform float uThreshold;
      vec3 tap(vec2 o) {
        vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
        float l = max(c.r, max(c.g, c.b));
        float k = clamp((l - uThreshold) / (uThreshold * 0.6 + 1e-3), 0.0, 1.0);
        // average with a luminance weight so a single hot pixel can't flicker the whole halo
        return c * (k * k * (3.0 - 2.0 * k)) / (1.0 + l * 0.15);
      }
      void main() {
        vec3 c = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
        gl_FragColor = vec4(c * 0.25, 1.0);
      }`,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 } },
    );

    this.down = pass(
      /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c * 0.125, 1.0);
      }`,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );

    this.up = pass(
      /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c * 0.0625 * 0.85, 1.0);
      }`,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      THREE.AdditiveBlending,
    );

    this.composite = pass(
      /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform float uAmount;
      uniform float uTime;
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      vec3 acesTone(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      void main() {
        vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uAmount;
        c = pow(acesTone(c), vec3(1.0 / 2.2));
        c += (hash12(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
      { tScene: { value: null }, tBloom: { value: null }, uAmount: { value: 1 }, uTime: { value: 0 } },
    );
  }

  resize(renderer) {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(2, Math.floor(this.size.x));
    const h = Math.max(2, Math.floor(this.size.y));
    if (this.hdr.width === w && this.hdr.height === h) return;
    this.hdr.setSize(w, h);
    for (let i = 0; i < LEVELS; i++) this.mips[i].setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)));
  }

  fullscreen(renderer, material, target) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.quadCam);
  }

  // Renders the scene with bloom. `amount` (0-1) fades the glow in; `time` drives the output dither.
  render(renderer, scene, camera, amount, time) {
    this.resize(renderer);
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(this.hdr);
    renderer.render(scene, camera);

    renderer.autoClear = false;
    const { bright, down, up, composite, mips } = this;

    bright.uniforms.tSrc.value = this.hdr.texture;
    bright.uniforms.uTexel.value.set(1 / this.hdr.width, 1 / this.hdr.height);
    bright.uniforms.uThreshold.value = 3 - 2 * amount;
    renderer.setRenderTarget(mips[0]);
    renderer.clear();
    this.fullscreen(renderer, bright, mips[0]);

    for (let i = 1; i < LEVELS; i++) {
      down.uniforms.tSrc.value = mips[i - 1].texture;
      down.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      renderer.setRenderTarget(mips[i]);
      renderer.clear();
      this.fullscreen(renderer, down, mips[i]);
    }
    for (let i = LEVELS - 1; i > 0; i--) {
      up.uniforms.tSrc.value = mips[i].texture;
      up.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this.fullscreen(renderer, up, mips[i - 1]);
    }

    composite.uniforms.tScene.value = this.hdr.texture;
    composite.uniforms.tBloom.value = mips[0].texture;
    composite.uniforms.uAmount.value = 0.7 * amount;
    composite.uniforms.uTime.value = time;
    this.fullscreen(renderer, composite, null);
    renderer.autoClear = prevAuto;
  }
}
