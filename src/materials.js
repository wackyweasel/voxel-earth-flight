import * as THREE from 'three';
import { R } from './geo.js';

export const env = {
  sun: new THREE.Vector3(1, 0, 0),
  moon: new THREE.Vector3(-1, 0, 0),
  camPos: new THREE.Vector3(),
};

// Uniforms shared by every material, updated once per frame from main.js.
export const shared = {
  uSun: { value: env.sun },
  uMoon: { value: env.moon },
  uCamPos: { value: env.camPos },
  uSkyLUT: { value: null },
  uUpC: { value: new THREE.Vector3(0, 1, 0) },
  uSunH: { value: new THREE.Vector3(1, 0, 0) },
  uSunE: { value: new THREE.Vector3(0, 0, 1) },
  uHaze: { value: 1.5 },
  uSkyGain: { value: 1.6 },
  uSunI: { value: 3.4 },
  uAmbient: { value: 1 },
  uExposure: { value: 0.9 },
  uOutHDR: { value: 0 },
  uTime: { value: 0 },
  uCamAlt: { value: 0 },
  uUseTrue: { value: 0 },
  uShadowOn: { value: 0 },
  uSh0: { value: null },
  uSh1: { value: null },
  uSh2: { value: null },
  uShM: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
  uShExt: { value: new THREE.Vector3(50, 200, 800) },
  uShRange: { value: new THREE.Vector3(3000, 3000, 3000) },
  uShSize: { value: 2048 },
};

export const KIND = { terrain: 0, wall: 1, roof: 2, water: 3, tree: 4, road: 5, plane: 6, lattice: 7 };

const LUT_W = 256;
const LUT_H = 128;
const R_KM = R / 1000;

// Atmosphere helpers shared by the voxel and sky fragment shaders.
const ATM_COMMON = /* glsl */ `
  uniform sampler2D uSkyLUT;
  uniform vec3 uSun;
  uniform vec3 uMoon;
  uniform vec3 uUpC;
  uniform vec3 uSunH;
  uniform vec3 uSunE;
  uniform float uHaze;
  uniform float uSunI;
  uniform float uAmbient;
  const float PI = 3.14159265;
  const vec3 BETA_R = vec3(5.8e-3, 13.5e-3, 33.1e-3);
  const float BETA_M_EXT = 4.44e-3;

  // Sky-view LUT: x = angle from the sun's azimuth (0..pi), y = elevation (sqrt-warped around the horizon).
  vec4 skyLookup(vec3 d) {
    float s = clamp(dot(d, uUpC), -1.0, 1.0);
    float l = asin(s) / 1.5707963;
    float v = 0.5 + 0.5 * sign(l) * sqrt(abs(l));
    float psi = atan(abs(dot(d, uSunE)), dot(d, uSunH));
    float u = psi / PI;
    return textureLod(uSkyLUT, vec2((0.5 + u * ${LUT_W - 1}.0) / ${LUT_W}.0, (0.5 + v * ${LUT_H - 1}.0) / ${LUT_H}.0), 0.0);
  }

  // Direct sun transmittance (Kasten-Young airmass) at altitude altM.
  vec3 sunTransmit(float mu, float altM) {
    float m0 = clamp(mu, 0.0, 1.0);
    float z = degrees(acos(m0));
    float m = 1.0 / (m0 + 0.50572 * pow(96.07995 - z, -1.6364));
    float hk = max(altM, 0.0) * 0.001;
    vec3 tau = (BETA_R * 8.0 * exp(-hk / 8.0) + vec3(BETA_M_EXT * 1.2 * uHaze * exp(-hk / 1.2))) * m;
    return exp(-tau) * smoothstep(-0.04, 0.0, mu);
  }

  vec3 skyAmbient(float mu, float nUp) {
    float day = smoothstep(-0.14, 0.3, mu);
    vec3 zen = vec3(0.24, 0.35, 0.60) * (0.5 + 0.5 * smoothstep(0.0, 0.6, mu));
    float tw = exp(-pow((mu - 0.02) / 0.13, 2.0));
    vec3 hi = (zen * day + vec3(0.36, 0.17, 0.16) * tw * 0.5) * uAmbient + vec3(0.02, 0.028, 0.055);
    vec3 lo = hi * vec3(0.50, 0.47, 0.42) + vec3(0.8, 0.7, 0.55) * max(mu, 0.0) * 0.06 * uAmbient;
    return mix(lo, hi, clamp(0.5 + 0.5 * nUp, 0.0, 1.0));
  }

  // Full moon opposite the sun: cool light, no shadows.
  vec3 moonLight(float mu, vec3 up) {
    float night = 1.0 - smoothstep(-0.16, 0.02, mu);
    float vis = smoothstep(-0.06, 0.14, dot(up, uMoon));
    return vec3(0.55, 0.68, 1.0) * 0.12 * night * vis;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }

  vec3 acesTone(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
`;

export function createVoxelMaterial(side = THREE.FrontSide, fade = false) {
  return new THREE.ShaderMaterial({
    side,
    vertexColors: true,
    defines: fade ? { FADE: 1 } : {},
    uniforms: { ...shared, ...(fade ? { uFade: { value: new THREE.Vector2(1, 1) } } : {}) },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aux;
      attribute vec2 wuv;
      uniform vec3 uCamPos;
      varying vec3 vColor;
      varying vec3 vRel;
      varying vec3 vRadial;
      varying float vAlt;
      varying float vAo;
      varying vec2 vWuv;
      flat varying vec3 vKind;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * wp;
        vColor = color;
        vRel = wp.xyz;
        vec3 abs3 = wp.xyz + uCamPos;
        float r = length(abs3);
        vRadial = abs3 / r;
        vAlt = r - ${R}.0;
        vAo = aux.y / 255.0;
        vWuv = wuv;
        vKind = vec3(aux.x, aux.z, aux.w);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      ${ATM_COMMON}
      uniform vec3 uCamPos;
      uniform float uSkyGain;
      uniform float uExposure;
      uniform float uOutHDR;
      uniform float uTime;
      uniform float uCamAlt;
      uniform float uUseTrue;
      uniform float uShadowOn;
      uniform sampler2D uSh0;
      uniform sampler2D uSh1;
      uniform sampler2D uSh2;
      uniform mat4 uShM[3];
      uniform vec3 uShExt;
      uniform vec3 uShRange;
      uniform float uShSize;
      varying vec3 vColor;
      varying vec3 vRel;
      varying vec3 vRadial;
      varying float vAlt;
      varying float vAo;
      varying vec2 vWuv;
      flat varying vec3 vKind;
      #ifdef FADE
      uniform vec2 uFade; // x: dither level, y: +1 keeps pixels below it (fading in), -1 keeps the rest (fading out)
      #endif

      float shadowCascade(sampler2D tex, mat4 M, float ext, float rng, vec3 rel, vec3 n, float NoL, out float edge) {
        float texel = 2.0 * ext / uShSize;
        vec3 p = rel + n * texel * 2.5;
        vec4 c = M * vec4(p, 1.0);
        vec2 uv = c.xy * 0.5 + 0.5;
        float z = c.z * 0.5 + 0.5;
        edge = max(abs(c.x), abs(c.y));
        float tanT = sqrt(max(1.0 - NoL * NoL, 0.0)) / max(NoL, 0.05);
        z -= (texel * (1.5 + tanT) + 0.08) / rng;
        float ang = hash12(gl_FragCoord.xy) * 6.2832;
        vec2 cs = vec2(cos(ang), sin(ang));
        float s = 0.0;
        for (int i = 0; i < 9; i++) {
          float fi = float(i);
          float rr = sqrt((fi + 0.5) / 9.0);
          float th = fi * 2.4;
          vec2 o = vec2(cos(th), sin(th)) * rr;
          o = vec2(o.x * cs.x - o.y * cs.y, o.x * cs.y + o.y * cs.x) * texel * 1.5;
          s += step(z, textureLod(tex, uv + o, 0.0).r);
        }
        return s / 9.0;
      }

      float getShadow(vec3 rel, vec3 n, float NoL) {
        if (uShadowOn <= 0.0 || NoL <= 0.0) return 1.0;
        float e;
        float s = shadowCascade(uSh0, uShM[0], uShExt.x, uShRange.x, rel, n, NoL, e);
        if (e < 0.94) return mix(1.0, s, uShadowOn);
        s = shadowCascade(uSh1, uShM[1], uShExt.y, uShRange.y, rel, n, NoL, e);
        if (e < 0.94) return mix(1.0, s, uShadowOn);
        s = shadowCascade(uSh2, uShM[2], uShExt.z, uShRange.z, rel, n, NoL, e);
        return mix(1.0, s, (1.0 - smoothstep(0.75, 0.97, e)) * uShadowOn);
      }

      // Reflection direction nudged above the horizon so the LUT lookup stays in the sky.
      vec3 skyDir(vec3 d) {
        float e = dot(d, uUpC);
        return normalize(d + uUpC * max(0.03 - e, 0.0));
      }

      float boxMask(vec2 f, vec2 lo, vec2 hi, vec2 e) {
        vec2 a = smoothstep(lo - e, lo + e, f) * (1.0 - smoothstep(hi - e, hi + e, f));
        return a.x * a.y;
      }

      void main() {
        #ifdef FADE
        float fd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (uFade.y > 0.0 ? fd >= uFade.x : fd < uFade.x) discard;
        #endif
        #include <logdepthbuf_fragment>
        float kind = floor(vKind.x + 0.5);
        float variant = vKind.y;
        float rnd = vKind.z;
        vec3 n = normalize(cross(dFdx(vRel), dFdy(vRel)));
        float dist = length(vRel);
        vec3 V = -vRel / dist;
        if (dot(n, V) < 0.0) n = -n;
        vec3 up = normalize(vRadial);
        float mu = dot(up, uSun);
        float fp = fwidth(vWuv.x) + fwidth(vWuv.y);

        if (kind > 6.5 && kind < 7.5) {
          // steel lattice: X-braced panels, thickening into a solid face with distance
          vec2 lc = vWuv / 7.0;
          vec2 lf = fract(lc);
          float lw = max(fwidth(lc.x), fwidth(lc.y));
          float lt = mix(0.09, 0.6, smoothstep(0.1, 0.45, lw));
          float brace = min(abs(lf.x - lf.y), abs(lf.x + lf.y - 1.0)) * 0.7071;
          float frame = min(min(lf.x, 1.0 - lf.x), min(lf.y, 1.0 - lf.y));
          if (min(brace, frame * 0.9) > lt) discard;
        }
        vec3 alb = pow(vColor, vec3(2.2));
        vec3 sunRad = sunTransmit(mu, vAlt) * uSunI;
        float NoL = max(dot(n, uSun), 0.0);
        float sh = getShadow(vRel, n, NoL);
        float ao = vAo;
        vec3 amb = skyAmbient(mu, dot(n, up));
        vec3 moonC = moonLight(mu, up);
        float NoM = max(dot(n, uMoon), 0.0);
        float night = 1.0 - smoothstep(-0.16, 0.02, mu);
        vec3 emis = vec3(0.0);
        vec3 col;

        if (kind == 3.0) {
          // water: fresnel sky reflection, sun glint, animated normals
          vec3 t1 = normalize(cross(up, vec3(0.267, 0.536, 0.801)));
          vec3 t2 = cross(up, t1);
          vec2 w = vWuv * 0.33 + vec2(uTime * 0.31, uTime * 0.17);
          vec2 g = vec2(vnoise2(w + vec2(1.7, 9.2)), vnoise2(w * 1.9 + vec2(8.3, 2.8) + uTime * 0.2)) - 0.5;
          float amp = 0.5 * (1.0 - smoothstep(6.0, 60.0, fp));
          vec3 nw = normalize(up + (t1 * g.x + t2 * g.y) * amp);
          vec3 rd = reflect(-V, nw);
          float NoV = clamp(dot(nw, V), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
          vec3 refl = skyLookup(skyDir(rd)).rgb * uSkyGain;
          vec3 body = alb * (amb + sunRad * max(dot(up, uSun), 0.0) * 0.25);
          float glint = pow(max(dot(rd, uSun), 0.0), 700.0) * 40.0;
          col = mix(body, refl, fres) + sunRad * glint;
          col += alb * moonC * 0.5 + moonC * pow(max(dot(rd, uMoon), 0.0), 400.0) * 14.0;
        } else {
          if (kind == 0.0 || kind == 4.0 || kind == 5.0) {
            float amt = 0.12 * (1.0 - smoothstep(0.3, 1.5, fp));
            alb *= 1.0 + (hash12(floor(vWuv / 0.35)) - 0.5) * amt * 2.0;
            if (kind == 4.0) {
              float lf = 0.78 + 0.5 * vnoise2(vWuv / 0.9);
              alb *= mix(1.0, lf, 1.0 - smoothstep(0.6, 3.0, fp));
            }
          } else if (kind == 2.0) {
            float seam = smoothstep(0.04, 0.0, abs(fract(vWuv.x / 2.2) - 0.5) - 0.46);
            alb *= 1.0 - 0.1 * seam * (1.0 - smoothstep(0.4, 1.5, fp));
          }

          float aoD = mix(0.55, 1.0, ao);
          // the sun-coloured fill stands in for light bounced between buildings
          col = alb * (sunRad * NoL * sh * aoD + amb * ao + sunRad * 0.09 * mix(0.35, 1.0, ao));
          col += alb * moonC * (NoM * aoD + 0.3 * ao);

          if (kind == 5.0 && night > 0.01) {
            // street lamps: soft warm pools scattered over the roads; averaged out when seen from far away
            vec2 lc = vWuv / 26.0;
            vec2 li = floor(lc);
            float lamp = 0.0;
            for (int a = -1; a <= 1; a++) {
              for (int b = -1; b <= 1; b++) {
                vec2 c = li + vec2(float(a), float(b));
                vec2 dp = (lc - c - vec2(hash12(c * 1.7 + 3.1), hash12(c * 2.3 + 7.7))) * 26.0;
                lamp += exp(-dot(dp, dp) / 50.0);
              }
            }
            lamp = mix(lamp, 0.3, smoothstep(2.0, 12.0, fp));
            col += (alb * 0.7 + 0.04) * vec3(1.0, 0.72, 0.42) * lamp * 3.0 * night;
          }

          if (kind == 1.0) {
            float style = mod(variant, 4.0);
            float fw = style == 1.0 ? 3.6 : (style == 3.0 ? 2.0 : 2.7);
            float fh = style == 2.0 ? 3.6 : 3.3;
            vec2 cell = vec2(vWuv.x / fw + rnd / 255.0 * 11.0, vWuv.y / fh);
            vec2 f = fract(cell);
            vec2 id = floor(cell);
            vec2 e = max(fwidth(cell), vec2(0.0005));
            vec2 lo = style == 2.0 ? vec2(-0.2, 0.16) : vec2(0.2, 0.26);
            vec2 hi = style == 2.0 ? vec2(1.2, 0.84) : vec2(0.8, 0.78);
            float coarse = smoothstep(0.3, 0.9, max(e.x, e.y));
            float cov = (min(hi.x, 1.0) - max(lo.x, 0.0)) * (hi.y - lo.y);
            float mask = mix(boxMask(f, lo, hi, e), cov, coarse);
            float slab = smoothstep(0.1, 0.0, f.y) * (1.0 - coarse);
            col *= 1.0 - 0.14 * slab;
            col *= 1.0 + (hash12(id + variant) - 0.5) * 0.12 * (1.0 - coarse);
            float NoV = clamp(dot(n, V), 0.0, 1.0);
            float fres = mix(0.10, 1.0, pow(1.0 - NoV, 4.0));
            vec3 rd = reflect(-V, n);
            vec3 refl = skyLookup(skyDir(rd)).rgb * uSkyGain;
            float glint = pow(max(dot(rd, uSun), 0.0), 120.0) * 6.0 * sh;
            vec3 glass = refl * fres * 0.7 + alb * 0.05 * amb + sunRad * glint;
            float day = smoothstep(-0.14, 0.1, mu);
            // each building has its own occupancy; some light whole floors at once
            float dens = mix(0.1, 0.6, hash12(vec2(rnd, 5.0) * 1.37 + 4.1));
            float rows = step(0.5, hash12(vec2(rnd, 9.0) * 0.73 + 1.9));
            float hw = hash12(id * 7.31 + rnd);
            float hf = hash12(vec2(id.y * 3.1, rnd * 1.7));
            float litRaw = step(1.0 - dens, mix(hw, hf, 0.55 * rows));
            float lit = mix(litRaw, dens, coarse) * (1.0 - day);
            float tint = hash12(id + 3.7);
            vec3 warm = tint < 0.55 ? vec3(1.0, 0.70, 0.38) : (tint < 0.8 ? vec3(1.0, 0.90, 0.76) : (tint < 0.94 ? vec3(0.72, 0.86, 1.0) : vec3(0.55, 0.62, 1.0)));
            warm = mix(warm, vec3(1.0, 0.78, 0.5), coarse);
            glass += warm * lit * 1.1 * (0.55 + 0.45 * hash12(id + rnd));
            col = mix(col, glass, mask);
          } else if (kind == 6.0) {
            vec3 rd = reflect(-V, n);
            col += sunRad * pow(max(dot(rd, uSun), 0.0), 40.0) * 0.12 * sh;
          } else if (kind > 6.5 && kind < 7.5) {
            // floodlit open-frame structures
            col += alb * vec3(1.0, 0.6, 0.22) * 2.4 * night * mix(0.5, 1.0, ao);
          }
        }

        // aerial perspective: analytic haze near the ground, sky-view LUT in space
        vec3 dirV = -V;
        float s = dot(dirV, uUpC);
        float hc = uCamAlt;
        float hf = max(vAlt, 0.0);
        float dh = hf - hc;
        float k8 = abs(dh) > 1.0 ? 8000.0 * (exp(-hc / 8000.0) - exp(-hf / 8000.0)) / dh : exp(-hc / 8000.0);
        float k1 = abs(dh) > 0.5 ? 1200.0 * (exp(-hc / 1200.0) - exp(-hf / 1200.0)) / dh : exp(-hc / 1200.0);
        vec3 tau = (BETA_R * k8 + vec3(BETA_M_EXT * uHaze * k1)) * dist * 0.001;
        vec3 T = exp(-tau);
        float eh = max(s, 0.015);
        vec3 hz = dirV - uUpC * s;
        hz = normalize(hz + vec3(1e-6)) * sqrt(1.0 - eh * eh) + uUpC * eh;
        vec3 Lh = skyLookup(hz).rgb * uSkyGain;
        vec3 colH = col * T + Lh * (1.0 - T);
        vec4 lut = skyLookup(dirV);
        vec3 colT = col * lut.a + lut.rgb * uSkyGain;
        col = mix(colH, colT, uUseTrue);

        col *= uExposure;
        if (uOutHDR > 0.5) {
          gl_FragColor = vec4(col, 1.0); // tone mapping happens in the bloom composite
          return;
        }
        col = acesTone(col);
        col = pow(col, vec3(1.0 / 2.2));
        col += (hash12(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Depth-only material for the shadow cascades.
export function createDepthMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 2,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      void main() {
        gl_FragColor = vec4(1.0);
      }
    `,
  });
}

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

// Renders a single-scattering Rayleigh + Mie sky-view LUT for the current camera altitude and sun elevation.
export function createSkyLUT() {
  const target = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const mat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uAlt: { value: 0 },
      uMu: { value: 0.5 },
      uHaze: shared.uHaze,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      uniform float uAlt;
      uniform float uMu;
      uniform float uHaze;
      const float PI = 3.14159265;
      const float RG = ${R_KM};
      const float RA = ${R_KM + 100};
      const float HR = 8.0;
      const float HM = 1.2;
      const vec3 BR = vec3(5.8e-3, 13.5e-3, 33.1e-3);
      const float BMS = 3.996e-3;
      const float BME = 4.44e-3;
      const float SUN_I = 20.0;

      float phaseM(float c) {
        const float g = 0.76;
        return 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + c * c) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * c, 1.5));
      }

      void main() {
        float iu = (gl_FragCoord.x - 0.5) / ${LUT_W - 1}.0;
        float iv = (gl_FragCoord.y - 0.5) / ${LUT_H - 1}.0;
        float psi = iu * PI;
        float vv = (iv - 0.5) * 2.0;
        float el = sign(vv) * vv * vv * 0.5 * PI;
        vec3 d = vec3(cos(el) * cos(psi), sin(el), cos(el) * sin(psi));
        vec3 sunD = vec3(sqrt(max(0.0, 1.0 - uMu * uMu)), uMu, 0.0);
        float rc = RG + uAlt;
        float dy = d.y;
        float rc2dy2 = rc * rc * dy * dy;
        float discA = (RA - rc) * (RA + rc) + rc2dy2;
        float discG = (RG - rc) * (RG + rc) + rc2dy2;
        float tMin = 0.0;
        float tMax = 0.0;
        bool valid = discA > 0.0;
        if (valid) {
          float sa = sqrt(discA);
          tMax = -rc * dy + sa;
          if (rc > RA) {
            tMin = -rc * dy - sa;
            valid = tMin > 0.0 || false;
            if (dy >= 0.0) valid = false;
          }
        }
        if (dy < 0.0 && discG > 0.0) tMax = -rc * dy - sqrt(discG);
        if (!valid || tMax <= tMin) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }
        float len = tMax - tMin;
        float pw = mix(1.0, 3.0, clamp(len / 300.0, 0.0, 1.0));
        float cph = dot(d, sunD);
        float phR = 3.0 / (16.0 * PI) * (1.0 + cph * cph);
        float phMv = phaseM(cph);
        vec3 L = vec3(0.0);
        vec3 tau = vec3(0.0);
        for (int i = 0; i < 40; i++) {
          float a = float(i) / 40.0;
          float b = float(i + 1) / 40.0;
          float ta = tMin + len * pow(a, pw);
          float tb = tMin + len * pow(b, pw);
          float ds = tb - ta;
          float tm = 0.5 * (ta + tb);
          vec3 pos = vec3(0.0, rc, 0.0) + d * tm;
          float r = length(pos);
          float h = max(r - RG, 0.0);
          float dR = exp(-h / HR);
          float dM = exp(-h / HM);
          vec3 ext = BR * dR + vec3(BME * uHaze * dM);
          float cs = dot(pos, sunD) / r;
          float sunVis = 1.0;
          if (cs < 0.0 && r * sqrt(max(1.0 - cs * cs, 0.0)) < RG) sunVis = 0.0;
          float odR = 0.0;
          float odM = 0.0;
          if (sunVis > 0.0) {
            float discS = (RA - r) * (RA + r) + r * r * cs * cs;
            float tS = -r * cs + sqrt(max(discS, 0.0));
            for (int j = 0; j < 6; j++) {
              float fa = float(j) / 6.0;
              float fb = float(j + 1) / 6.0;
              float sa2 = tS * fa * fa;
              float sb2 = tS * fb * fb;
              vec3 ps = pos + sunD * (0.5 * (sa2 + sb2));
              float hs = max(length(ps) - RG, 0.0);
              odR += exp(-hs / HR) * (sb2 - sa2);
              odM += exp(-hs / HM) * (sb2 - sa2);
            }
          }
          vec3 tauS = BR * odR + vec3(BME * uHaze * odM);
          vec3 Ts = exp(-tauS) * sunVis;
          vec3 scat = (BR * dR * phR + vec3(BMS * uHaze * dM * phMv)) * Ts;
          vec3 ms = (BR * dR + vec3(BMS * uHaze * dM)) * 0.0796 * 0.3 * exp(-0.3 * tauS) * sunVis;
          vec3 Tv = exp(-(tau + 0.5 * ext * ds));
          L += Tv * (scat + ms) * ds * SUN_I;
          tau += ext * ds;
        }
        gl_FragColor = vec4(L, exp(-tau.y));
      }
    `,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.Camera();
  shared.uSkyLUT.value = target.texture;

  return {
    target,
    render(renderer, altM, mu) {
      mat.uniforms.uAlt.value = Math.min(Math.max(altM, 1) / 1000, 400);
      mat.uniforms.uMu.value = mu;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
    },
  };
}

// Tileable value-noise fbm volume; R is a coarse cloud shape, G finer erosion detail.
const NOISE_N = 64;
function bakeCloudNoise() {
  const N = NOISE_N;
  const data = new Uint8Array(N * N * N * 2);
  let seed = 1234567;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 8) / 16777216;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const channel = (ch, f0) => {
    const field = new Float32Array(N * N * N);
    let amp = 1;
    for (let o = 0; o < 4; o++, amp *= 0.5) {
      const f = f0 << o;
      const lat = new Float32Array(f * f * f);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      const at = (x, y, z) => lat[((z % f) * f + (y % f)) * f + (x % f)];
      for (let z = 0; z < N; z++) {
        const uz = (z / N) * f, z0 = Math.floor(uz), fz = fade(uz - z0);
        for (let y = 0; y < N; y++) {
          const uy = (y / N) * f, y0 = Math.floor(uy), fy = fade(uy - y0);
          for (let x = 0; x < N; x++) {
            const ux = (x / N) * f, x0 = Math.floor(ux), fx = fade(ux - x0);
            const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
            const a = at(x0, y0, z0) + (at(x1, y0, z0) - at(x0, y0, z0)) * fx;
            const b = at(x0, y1, z0) + (at(x1, y1, z0) - at(x0, y1, z0)) * fx;
            const c = at(x0, y0, z1) + (at(x1, y0, z1) - at(x0, y0, z1)) * fx;
            const d = at(x0, y1, z1) + (at(x1, y1, z1) - at(x0, y1, z1)) * fx;
            const ab = a + (b - a) * fy;
            const cd = c + (d - c) * fy;
            field[(z * N + y) * N + x] += amp * (ab + (cd - ab) * fz);
          }
        }
      }
    }
    // fbm clusters around 0.5, so stretch it to the full range to get usable cloud/clear contrast
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      lo = Math.min(lo, field[i]);
      hi = Math.max(hi, field[i]);
    }
    for (let i = 0; i < field.length; i++) data[i * 2 + ch] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
  };
  channel(0, 2);
  channel(1, 4);
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
// Period of the baked volume in metres; the camera origin is wrapped by this to keep float precision.
export const CLOUD_PERIOD = 20000;

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...shared,
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uSpace: { value: 0 },
      uCloud: { value: 1 },
      uCloudO: { value: new THREE.Vector3() },
      uNoise: { value: bakeCloudNoise() },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      ${ATM_COMMON}
      varying vec2 vUv;
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos;
      uniform float uSkyGain;
      uniform float uExposure;
      uniform float uOutHDR;
      uniform float uTime;
      uniform float uCamAlt;
      uniform float uSpace;
      uniform float uCloud;

      float hash13(vec3 p3) {
        p3 = fract(p3 * 0.1031);
        p3 += dot(p3, p3.zyx + 31.32);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vnoise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y);
        float b = mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y);
        return mix(a, b, f.z);
      }
      uniform sampler3D uNoise;
      uniform vec3 uCloudO;
      // macro shape at a 20 km period plus erosion detail at 5 km, both from one baked tileable volume
      float cloudField(vec3 p) {
        float m = texture(uNoise, p * (1.0 / 20000.0)).r;
        float d = texture(uNoise, p * (1.0 / 5000.0) + 0.37).g;
        return m * 0.72 + d * 0.28;
      }

      void main() {
        // Built from the x/y scale terms: unprojecting at the far plane is degenerate with a 1e8 far distance.
        vec3 vd = vec3(vUv.x * uInvProj[0][0], vUv.y * uInvProj[1][1], -1.0);
        vec3 dir = normalize((uCamWorld * vec4(vd, 0.0)).xyz);
        float mu = dot(uUpC, uSun);
        float el = dot(dir, uUpC);
        float sd = dot(dir, uSun);

        vec4 lut = skyLookup(dir);
        vec3 sky = lut.rgb * uSkyGain * (1.0 - uSpace);

        // clouds: a single world-fixed layer at 2.5 km, only seen from below it
        if (uCloud > 0.001) {
          const float Rm = ${R}.0;
          const float Hc = 2500.0;
          // flat control flow keeps texture derivatives valid, so mip selection stays smooth at the horizon
          float elc = max(el, 0.02);
          float rc = Rm + uCamAlt;
          float b = rc * elc;
          float c = (uCamAlt - Hc) * (2.0 * Rm + uCamAlt + Hc);
          float disc = (Rm + Hc - rc) * (Rm + Hc + rc) + rc * rc * elc * elc;
          float t = -c / (b + sqrt(max(disc, 0.0)));
          vec3 dirc = normalize(dir + uUpC * (elc - el));
          vec3 P = uCloudO + dirc * t;
          float dn = cloudField(P);
          float cov = smoothstep(0.51, 0.66, dn);
          float a = cov * smoothstep(0.0, 0.12, el) * uCloud * 0.96;
          // one tap towards the sun gives self-shadowing, a second tap bright rims where the cloud thins out
          float occ = smoothstep(0.51, 0.66, cloudField(P + uSun * 500.0));
          vec3 up = normalize(uCamPos + dirc * t);
          vec3 sT = sunTransmit(dot(up, uSun), Hc) * uSunI;
          float fwd = pow(max(sd, 0.0), 6.0);
          float rim = (1.0 - cov) * cov * 4.0;
          vec3 cc = vec3(0.93, 0.95, 1.0) * (sT * (0.5 * (1.0 - 0.8 * occ) + 0.6 * fwd * rim) + skyAmbient(mu, 1.0) * (1.1 + 0.4 * (1.0 - cov))) * 0.8;
          vec3 hz = skyLookup(normalize(dir - uUpC * el + uUpC * 0.02)).rgb * uSkyGain;
          cc = mix(cc, hz, 1.0 - exp(-t / 90000.0));
          sky = mix(sky, cc, a);
        }

        vec3 col = sky;
        float nightS = 1.0 - smoothstep(-0.2, 0.0, mu);
        float md = dot(dir, uMoon);
        float moonVis = smoothstep(-0.08, 0.1, dot(uUpC, uMoon)) * (1.0 - uSpace);
        // faint airglow near the horizon and a soft halo around the moon
        col += vec3(0.004, 0.007, 0.016) * nightS * (1.0 + 2.5 * pow(1.0 - abs(el), 4.0)) * (1.0 - uSpace);
        col += vec3(0.45, 0.58, 1.0) * (pow(max(md, 0.0), 90.0) * 0.05 + pow(max(md, 0.0), 12.0) * 0.004) * nightS * moonVis;
        // stars, hidden by any bright sky
        vec3 q = dir * 260.0;
        vec3 id = floor(q);
        float h = hash13(id);
        float d = length(fract(q) - 0.5);
        float star = step(0.992, h) * smoothstep(0.32, 0.05, d) * (0.4 + 0.6 * hash13(id + 3.1));
        float skyL = dot(col, vec3(0.3, 0.6, 0.1)) * uExposure;
        col += vec3(star) * lut.a * clamp(1.0 - skyL * 12.0, 0.0, 1.0) * 1.5;

        // sun disc
        float sunT = skyLookup(uSun).a * step(-0.04, mu);
        col += vec3(1.0, 0.92, 0.80) * smoothstep(0.99999, 0.999995, sd) * 60.0 * sunT;

        // moon disc with a few shaded maria
        if (md > 0.99994) {
          vec3 mt = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0)));
          vec3 mb = cross(uMoon, mt);
          vec2 mp = vec2(dot(dir, mt), dot(dir, mb)) / 0.0111;
          float maria = vnoise3(vec3(mp * 2.6, 3.3)) * 0.6 + vnoise3(vec3(mp * 7.0, 9.1)) * 0.4;
          float lum = 0.55 + 0.45 * smoothstep(0.35, 0.65, maria);
          float disc = smoothstep(0.99994, 0.999955, md);
          col = mix(col, vec3(0.80, 0.84, 0.92) * lum * 1.5, disc * moonVis * skyLookup(uMoon).a);
        }

        gl_FragColor = vec4(col, 1.0);
        gl_FragColor.rgb = uOutHDR > 0.5 ? col * uExposure : pow(acesTone(col * uExposure), vec3(1.0 / 2.2));
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.layers.set(1);
  return mesh;
}

// Additive limb glow, only visible from high altitude (the LUT covers the rest).
export function createAtmosphere() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSun: { value: env.sun },
      uFade: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vW;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vW = normalize(position);
        vV = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun;
      uniform float uFade;
      varying vec3 vN;
      varying vec3 vW;
      varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        float d = dot(normalize(vN), normalize(vV));
        float i = pow(clamp(d / 0.2, 0.0, 1.0), 2.0);
        float lit = smoothstep(-0.25, 0.35, dot(vW, uSun));
        vec3 c = mix(vec3(0.25, 0.5, 1.0), vec3(1.0, 0.55, 0.3), (1.0 - abs(lit * 2.0 - 1.0)) * 0.6);
        vec3 o = c * i * lit * 1.3 * uFade;
        gl_FragColor = vec4(pow(o, vec3(0.8)), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R * 1.015, 128, 64), mat);
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  return mesh;
}
