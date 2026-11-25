import * as THREE from 'three';
import { R } from './geo.js';
import { shared, CLOUD_PERIOD } from './materials.js';
import { createPrecip, Bolt } from './weatherfx.js';
import { WeatherAudio } from './weatheraudio.js';

// lo: cloud coverage threshold (lower = more cloud), oc: overcast lighting, H/T: cloud base and thickness (m),
// fogD/fogH: ground fog density per metre and scale height, wind in m/s, thunder: lightning activity.
const BASE = { lo: 0.51, oc: 0, storm: 0, rain: 0, snowfall: 0, wet: 0, snow: 0, fogD: 0, fogH: 1200, wind: 6, H: 2500, T: 300, thunder: 0 };
export const WEATHER = {
  'Clear': { ...BASE, lo: 0.74, wind: 3, H: 2800, T: 200 },
  'Partly cloudy': { ...BASE },
  'Cloudy': { ...BASE, lo: 0.36, oc: 0.3, wind: 8, H: 2000, T: 350, fogD: 0.00001 },
  'Overcast': { ...BASE, lo: 0.2, oc: 0.85, wind: 9, H: 1500, T: 500, fogD: 0.00003 },
  'Light rain': { ...BASE, lo: 0.2, oc: 0.85, rain: 0.35, wet: 0.65, wind: 9, H: 1300, T: 550, fogD: 0.00005 },
  'Rain': { ...BASE, lo: 0.1, oc: 1, storm: 0.3, rain: 0.8, wet: 1, wind: 12, H: 1000, T: 650, fogD: 0.00009 },
  'Thunderstorm': { ...BASE, lo: 0, oc: 1, storm: 1, rain: 1, wet: 1, wind: 18, H: 800, T: 800, fogD: 0.00012, thunder: 1 },
  'Snow': { ...BASE, lo: 0.2, oc: 0.85, snowfall: 0.9, snow: 1, wind: 5, H: 1200, T: 500, fogD: 0.00018, fogH: 700 },
  'Fog': { ...BASE, lo: 0.4, oc: 0.35, wind: 1.5, H: 1800, T: 300, fogD: 0.0011, fogH: 220 },
};
export const WEATHER_NAMES = ['Dynamic', ...Object.keys(WEATHER)];
export const DEFAULT_WEATHER = 'Partly cloudy';
const DYNAMIC_POOL = ['Clear', 'Partly cloudy', 'Partly cloudy', 'Cloudy', 'Overcast', 'Light rain', 'Rain', 'Thunderstorm', 'Snow', 'Fog'];

const FAST = ['lo', 'oc', 'storm', 'rain', 'snowfall', 'fogD', 'fogH', 'wind', 'H', 'T', 'thunder'];
const WIND_DIR = new THREE.Vector3(5, 1.5, 3).normalize();
const SUN_I = shared.uSunI.value;
const AMBIENT = shared.uAmbient.value;
const HAZE = shared.uHaze.value;

const smooth = THREE.MathUtils.smoothstep;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

// Reads the baked cloud volume on the CPU, mirroring cloudField() in the sky shader.
function cloudSampler(tex) {
  const d = tex.image.data;
  const N = tex.image.width;
  const at = (x, y, z, ch) => d[(((z & (N - 1)) * N + (y & (N - 1))) * N + (x & (N - 1))) * 2 + ch];
  const l = (a, b, t) => a + (b - a) * t;
  const tri = (u, v, w, ch) => {
    const fx = u * N - 0.5;
    const fy = v * N - 0.5;
    const fz = w * N - 0.5;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const z = Math.floor(fz);
    const tx = fx - x;
    const ty = fy - y;
    const tz = fz - z;
    const plane = (zz) => l(l(at(x, y, zz, ch), at(x + 1, y, zz, ch), tx), l(at(x, y + 1, zz, ch), at(x + 1, y + 1, zz, ch), tx), ty);
    return l(plane(z), plane(z + 1), tz) / 255;
  };
  return (x, y, z) => tri(x / 20000, y / 20000, z / 20000, 0) * 0.72 + tri(x / 5000 + 0.37, y / 5000 + 0.37, z / 5000 + 0.37, 1) * 0.28;
}

export class Weather {
  constructor(scene, sky) {
    this.sky = sky;
    this.cloudAt = cloudSampler(sky.userData.noise);
    this.name = DEFAULT_WEATHER;
    this.mode = DEFAULT_WEATHER; // a preset name or 'Dynamic'
    this.target = { ...WEATHER[DEFAULT_WEATHER] };
    this.s = { ...this.target };
    this.dynTimer = 0;
    this.drift = new THREE.Vector3();
    this.disp = { rain: new THREE.Vector3(), snow: new THREE.Vector3() };
    this.prevCam = new THREE.Vector3();
    this.camVel = new THREE.Vector3();
    this.havePrev = false;
    this.fogBase = 0;
    this.cloudFog = 0;

    this.rain = createPrecip('rain', 9000);
    this.snowfall = createPrecip('snow', 6000);
    this.bolt = new Bolt();
    scene.add(this.rain, this.snowfall, this.bolt.mesh);

    this.audio = new WeatherAudio();
    this.flash = { t: 99, dist: 1000, strength: 0, dir: new THREE.Vector3(0, 1, 0) };
    this.nextStrike = 3;
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
  }

  // 'Dynamic' wanders between presets; any other name holds that weather. instant skips the transition.
  set(mode, instant = false) {
    if (mode !== 'Dynamic' && !WEATHER[mode]) return;
    this.mode = mode;
    this.dynTimer = 0;
    if (mode === 'Dynamic') {
      this.pickDynamic();
    } else {
      this.name = mode;
      this.target = { ...WEATHER[mode] };
    }
    if (instant) this.s = { ...this.target };
  }

  pickDynamic() {
    let pick;
    do pick = DYNAMIC_POOL[Math.floor(Math.random() * DYNAMIC_POOL.length)];
    while (pick === this.name && Math.random() < 0.8);
    this.name = pick;
    this.target = { ...WEATHER[pick] };
    this.dynTimer = 100 + Math.random() * 120;
  }

  setSound(on) {
    this.audio.enabled = on;
  }

  get overcast() {
    return this.s.oc;
  }

  strike(ctx) {
    const s = this.s;
    const up = ctx.camUp;
    const dist = 700 + Math.random() * 4300;
    // prefer the half of the sky the player is looking at
    const fwd = _a.copy(ctx.forward).addScaledVector(up, -ctx.forward.dot(up));
    if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0).addScaledVector(up, -up.x);
    fwd.normalize().applyAxisAngle(up, (Math.random() - 0.5) * Math.PI * 1.5);
    const ground = ctx.ground ?? 0;
    const base = _c.copy(ctx.camPos).addScaledVector(fwd, dist).normalize().clone();
    const gh = ctx.groundAt ? ctx.groundAt(base.clone().multiplyScalar(R + ground)) ?? ground : ground;
    const bottom = base.clone().multiplyScalar(R + gh);
    const top = base.clone().multiplyScalar(R + s.H + 60 + Math.random() * 60);
    const f = this.flash;
    f.t = 0;
    f.dist = dist;
    f.strength = 0.7 + Math.random() * 0.3;
    f.dir.copy(base).multiplyScalar(R + (gh + s.H) * 0.5).sub(ctx.camPos).normalize();
    // a bolt is only visible from below the cloud deck; otherwise it is lightning inside the cloud
    if (ctx.camAlt < s.H - 10 && Math.random() < 0.85) {
      const b = this.bolt;
      b.origin.copy(ctx.camPos);
      const view = _a.copy(top).add(bottom).multiplyScalar(0.5).sub(ctx.camPos).normalize();
      b.build(top.clone().sub(b.origin), bottom.clone().sub(b.origin), view, base);
      b.mesh.visible = true;
    }
    this.audio.thunder(dist, dist / 343);
  }

  update(dt, ctx) {
    // --- weather state ---
    if (this.mode === 'Dynamic') {
      this.dynTimer -= dt;
      if (this.dynTimer <= 0) this.pickDynamic();
    }
    const s = this.s;
    const tg = this.target;
    const kf = 1 - Math.exp(-dt / 4);
    for (const k of FAST) s[k] += (tg[k] - s[k]) * kf;
    s.wet += (tg.wet - s.wet) * (1 - Math.exp(-dt / (tg.wet > s.wet ? 6 : 40)));
    s.snow += (tg.snow - s.snow) * (1 - Math.exp(-dt / (tg.snow > s.snow ? 10 : 30)));

    const { camPos, camUp, camAlt } = ctx;
    if (this.havePrev && dt > 0) {
      this.camVel.copy(camPos).sub(this.prevCam).divideScalar(dt);
      if (this.camVel.lengthSq() > 700 * 700) this.camVel.set(0, 0, 0);
    }
    this.prevCam.copy(camPos);
    this.havePrev = true;
    this.fogBase += ((ctx.ground ?? 0) - this.fogBase) * Math.min(1, dt * 2);

    // --- lighting ---
    const oc = s.oc;
    shared.uOvercast.value = oc;
    shared.uStorm.value = s.storm;
    shared.uWet.value = s.wet;
    shared.uSnow.value = s.snow;
    shared.uRain.value = s.rain;
    shared.uCloudLo.value = s.lo;
    shared.uCloudH.value = s.H;
    shared.uCloudT.value = s.T;
    shared.uFogD.value = s.fogD;
    shared.uFogH.value = s.fogH;
    shared.uFogBase.value = this.fogBase;
    shared.uSunI.value = SUN_I * (1 - 0.88 * oc);
    shared.uAmbient.value = AMBIENT * (1 + 0.9 * oc) * (1 - 0.4 * s.storm);
    shared.uHaze.value = HAZE * (1 + 0.5 * oc);

    // --- clouds ---
    this.drift.addScaledVector(WIND_DIR, s.wind * dt);
    const su = this.sky.material.uniforms;
    const wrap = (v) => ((v % CLOUD_PERIOD) + CLOUD_PERIOD) % CLOUD_PERIOD;
    su.uCloudO.value.set(wrap(camPos.x + this.drift.x), wrap(camPos.y + this.drift.y), wrap(camPos.z + this.drift.z));
    su.uCloud.value = 1 - smooth(camAlt, s.H - 60, s.H + 60);
    // inside the cloud layer the air turns into a white-out wherever the cloud is dense
    const band = smooth(camAlt, s.H - 60, s.H + 40) * (1 - smooth(camAlt, s.H + s.T - 40, s.H + s.T + 120));
    let fogTarget = 0;
    if (band > 0.001) {
      _a.copy(camUp).multiplyScalar(s.H - camAlt).add(su.uCloudO.value);
      const dn = this.cloudAt(_a.x, _a.y, _a.z);
      const cov = Math.max(smooth(dn, s.lo, s.lo + 0.15), oc * oc);
      fogTarget = band * cov * (0.011 + 0.008 * oc);
    }
    this.cloudFog += (fogTarget - this.cloudFog) * Math.min(1, dt * 3);
    shared.uFogIn.value = this.cloudFog;

    // --- precipitation ---
    const below = 1 - smooth(camAlt, s.H - 40, s.H + 40);
    const wdir = _a.copy(WIND_DIR).addScaledVector(camUp, -WIND_DIR.dot(camUp)).normalize().multiplyScalar(-1);
    const px = (2 * Math.tan(THREE.MathUtils.degToRad(ctx.fov) / 2)) / ctx.height;
    this.updatePrecip(this.rain, this.disp.rain, 60, s.rain, below, dt, camPos, camUp, wdir, s.wind * 0.45, 9.5, px);
    this.updatePrecip(this.snowfall, this.disp.snow, 44, s.snowfall, below, dt, camPos, camUp, wdir, s.wind * 0.8, 1.4, px);

    // --- lightning ---
    const f = this.flash;
    if (!ctx.paused && s.thunder > 0.5) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.strike(ctx);
        this.nextStrike = 3 + Math.random() * 9;
      }
    }
    f.t += dt;
    const t = f.t;
    let env = 0;
    if (t < 0.07) env = 1;
    else if (t < 0.13) env = 0.3;
    else if (t < 0.22) env = 0.85;
    else if (t < 1.1) env = 0.55 * Math.exp(-(t - 0.22) * 5);
    const reach = 1 / (1 + f.dist / 2500);
    shared.uFlash.value = env * f.strength * (0.3 + 1.2 * reach);
    shared.uFlashDir.value.copy(f.dir).lerp(camUp, 0.25).normalize();
    this.bolt.material.uniforms.uI.value = env * f.strength * (0.9 + 0.4 * Math.sin(t * 90));
    if (t > 1.1 && this.bolt.mesh.visible) this.bolt.mesh.visible = false;
    if (this.bolt.mesh.visible) this.bolt.mesh.position.copy(this.bolt.origin).sub(camPos);

    // --- sound ---
    this.audio.update({ rain: s.rain * below, wind: s.wind, storm: s.storm, outside: ctx.outside ?? 1, paused: ctx.paused });
  }

  updatePrecip(mesh, disp, box, amount, below, dt, camPos, camUp, wdir, windSpeed, fall, px) {
    const u = mesh.material.uniforms;
    const vis = amount > 0.01 && below > 0.01;
    mesh.visible = vis;
    if (!vis) return;
    const vel = _b.copy(camUp).multiplyScalar(-fall).addScaledVector(wdir, windSpeed);
    disp.addScaledVector(vel, dt);
    disp.x %= box;
    disp.y %= box;
    disp.z %= box;
    const w = (v) => (((v + box / 2) % box) + box) % box;
    u.uOff.value.set(w(disp.x - camPos.x), w(disp.y - camPos.y), w(disp.z - camPos.z));
    u.uRelVel.value.copy(vel).sub(this.camVel);
    u.uDensity.value = amount;
    u.uVis.value = below;
    u.uPx.value = px;
  }
}
