import * as THREE from 'three';
import { shared, ATM_COMMON } from './materials.js';

// Final colour stage shared by the weather shaders: same exposure, tone mapping and HDR hand-off as the voxel shader.
const OUTPUT = /* glsl */ `
  col *= uExposure;
  if (uOutHDR > 0.5) {
    gl_FragColor = vec4(col, alpha);
  } else {
    gl_FragColor = vec4(pow(acesTone(col), vec3(1.0 / 2.2)), alpha);
  }
`;

const BOX = { rain: 60, snow: 44 };

// Rain streaks and snowflakes: instanced quads that live in a camera-centred box which wraps around, so the
// precipitation is fixed in the world and stays dense wherever the camera goes. All positions are computed on the GPU.
export function createPrecip(kind, count) {
  const snow = kind === 'snow';
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    defines: snow ? { SNOW: 1 } : {},
    uniforms: {
      ...shared,
      uOff: { value: new THREE.Vector3() },
      uRelVel: { value: new THREE.Vector3(0, -9, 0) },
      uBox: { value: BOX[kind] },
      uDensity: { value: 0 },
      uVis: { value: 0 },
      uPx: { value: 0.001 },
      uLenT: { value: snow ? 0.02 : 0.035 },
      uSize: { value: snow ? new THREE.Vector2(0.03, 0.07) : new THREE.Vector2(0.008, 0.016) },
      uAlpha: { value: snow ? 0.85 : 0.5 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aSeed;
      uniform vec3 uOff;
      uniform vec3 uRelVel;
      uniform vec3 uUpC;
      uniform float uBox;
      uniform float uDensity;
      uniform float uVis;
      uniform float uPx;
      uniform float uLenT;
      uniform float uTime;
      uniform vec2 uSize;
      varying vec2 vC;
      varying float vA;
      void main() {
        vec3 r = mod(aSeed.xyz * uBox + uOff, uBox) - 0.5 * uBox;
        float sz = mix(uSize.x, uSize.y, fract(aSeed.w * 37.1));
        #ifdef SNOW
        vec3 e = cross(uUpC, vec3(0.0, 1.0, 0.0));
        e = length(e) > 1e-3 ? normalize(e) : vec3(1.0, 0.0, 0.0);
        vec3 nn = cross(uUpC, e);
        float ph = aSeed.w * 80.0;
        r += (e * sin(uTime * 0.9 + ph) + nn * cos(uTime * 0.7 + ph * 1.3)) * 0.45 * (0.5 + fract(aSeed.w * 13.7));
        #endif
        float dist = length(r);
        float sp = length(uRelVel);
        vec3 dv = uRelVel / max(sp, 1e-3);
        float w = max(sz, dist * uPx);
        #ifdef SNOW
        float len = max(w * 1.6, min(sp * uLenT, 1.5));
        #else
        float len = min(sp * uLenT, 2.5);
        #endif
        vec3 cr = cross(dv, r);
        vec3 side = length(cr) > 1e-4 ? normalize(cr) : vec3(1.0, 0.0, 0.0);
        vec3 p = r - dv * len * position.y + side * w * position.x;
        float fade = (1.0 - smoothstep(0.28 * uBox, 0.5 * uBox, dist)) * smoothstep(0.3, 1.6, dist);
        vA = step(aSeed.w, uDensity) * uVis * fade;
        vC = position.xy;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      ${ATM_COMMON}
      uniform float uExposure;
      uniform float uOutHDR;
      uniform float uAlpha;
      uniform float uCamAlt;
      varying vec2 vC;
      varying float vA;
      void main() {
        if (vA < 0.003) discard;
        #include <logdepthbuf_fragment>
        float mu = dot(uUpC, uSun);
        #ifdef SNOW
        vec2 q = vec2(vC.x, vC.y * 2.0 - 1.0);
        float prof = smoothstep(1.0, 0.25, length(q));
        float tail = 1.0;
        vec3 col = hazeColor() * 1.5 + skyAmbient(mu, 1.0) * 0.8 + sunTransmit(mu, uCamAlt) * uSunI * 0.25;
        #else
        float prof = 1.0 - vC.x * vC.x;
        float tail = 1.0 - 0.8 * vC.y;
        vec3 col = hazeColor() * 1.15 + sunTransmit(mu, uCamAlt) * uSunI * 0.12;
        #endif
        float alpha = vA * prof * tail * uAlpha;
        ${OUTPUT}
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(1); // keeps it out of the shadow pass
  mesh.renderOrder = 10;
  mesh.visible = false;
  return mesh;
}

const MAX_SEG = 420;
const _h1 = new THREE.Vector3();
const _h2 = new THREE.Vector3();
const _side = new THREE.Vector3();

// A forked lightning bolt drawn as glowing ribbons; positions are stored relative to where the strike happened.
export class Bolt {
  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_SEG * 4 * 3);
    this.info = new Float32Array(MAX_SEG * 4 * 2);
    const idx = new Uint32Array(MAX_SEG * 6);
    for (let i = 0; i < MAX_SEG; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uI: { value: 0 }, uOutHDR: shared.uOutHDR },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec2 aInfo;
        varying vec2 vI;
        void main() {
          vI = aInfo;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>
        uniform float uI;
        uniform float uOutHDR;
        varying vec2 vI;
        void main() {
          #include <logdepthbuf_fragment>
          float k = 1.0 - vI.x * vI.x;
          float v = vI.y < 0.5 ? k * k * k * 1.4 : k * k * 0.18;
          vec3 col = mix(vec3(0.55, 0.65, 1.0), vec3(1.0), vI.y < 0.5 ? k * k : 0.0) * v * uI;
          if (uOutHDR > 0.5) col *= 6.0;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.origin = new THREE.Vector3();
    this.seg = 0;
  }

  // top/bottom are relative to this.origin; view is the unit direction from the camera to the bolt.
  build(top, bottom, view, up) {
    this.seg = 0;
    _side.crossVectors(view, up).normalize();
    const len = top.distanceTo(bottom);
    _h1.crossVectors(up, _side).normalize();
    _h2.copy(_side);
    const main = [top.clone()];
    this.jag(top, bottom, len * 0.16, 6, main);
    const width = Math.max(1.5, len * 0.006);
    this.addPolyline(main, width, 1);
    const forks = 4 + Math.floor(Math.random() * 4);
    for (let f = 0; f < forks; f++) {
      const i = 6 + Math.floor(Math.random() * (main.length - 20));
      const a = main[i];
      const out = _h1.clone().multiplyScalar(Math.random() - 0.5).addScaledVector(_h2, Math.random() - 0.5).normalize();
      const b = a.clone().addScaledVector(up, -len * (0.12 + Math.random() * 0.2)).addScaledVector(out, len * (0.1 + Math.random() * 0.2));
      const br = [a.clone()];
      this.jag(a, b, len * 0.05, 4, br);
      this.addPolyline(br, width * 0.5, 0.6);
    }
    this.geo.setDrawRange(0, this.seg * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aInfo.needsUpdate = true;
  }

  jag(a, b, off, depth, out) {
    if (depth === 0) {
      out.push(b.clone());
      return;
    }
    const m = a.clone().add(b).multiplyScalar(0.5);
    m.addScaledVector(_h1, (Math.random() - 0.5) * off).addScaledVector(_h2, (Math.random() - 0.5) * off);
    this.jag(a, m, off * 0.58, depth - 1, out);
    this.jag(m, b, off * 0.58, depth - 1, out);
  }

  addPolyline(pts, w) {
    for (let i = 0; i + 1 < pts.length; i++) {
      this.addSeg(pts[i], pts[i + 1], w, 0);
      this.addSeg(pts[i], pts[i + 1], w * 7, 1);
    }
  }

  addSeg(a, b, w, type) {
    if (this.seg >= MAX_SEG) return;
    const o = this.seg * 12;
    const q = this.seg * 8;
    const pts = [a, b];
    for (let k = 0; k < 2; k++) {
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const j = o + (k * 2 + s) * 3;
        this.pos[j] = pts[k].x + _side.x * w * sign;
        this.pos[j + 1] = pts[k].y + _side.y * w * sign;
        this.pos[j + 2] = pts[k].z + _side.z * w * sign;
        const m = q + (k * 2 + s) * 2;
        this.info[m] = sign;
        this.info[m + 1] = type;
      }
    }
    this.seg++;
  }
}
