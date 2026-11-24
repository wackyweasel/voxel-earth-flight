import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { R, DEG, dirToLat, dirToLon } from './geo.js';
import { boxGeometry } from './plane.js';

const G = 9.8;
const VT_FALL = 55; // terminal velocity belly-to-earth at sea level, m/s
const OPEN_TIME = 2.2; // seconds from pull to a fully open canopy
const MAX_DECEL = 30; // opening shock limit, m/s²
const AAD_AGL = 220; // automatic activation height above ground, m
const CANOPY_H = 6.6; // wing height above the risers, m
const ANCHOR = 0.7; // risers attach this far above the hip, m
export const HIP = 1.0; // soles to hip

const smooth = (x) => x * x * (3 - 2 * x);
const sstep = (x, a, b) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const SUIT = [214, 62, 44];
const SUIT2 = [176, 40, 32];
const PANTS = [40, 50, 92];
const RIG = [28, 28, 32];
const SKIN = [232, 190, 156];
const HELM = [236, 236, 240];
const BOOT = [26, 26, 30];

const part = (boxes) => mergeGeometries(boxes.map((b) => boxGeometry(b)));

// Hip at the origin, upright, facing -Z (the back, and the pack, are +Z).
const TORSO = part([
  [-0.22, 0.22, -0.12, 0.28, -0.14, 0.14, PANTS],
  [-0.26, 0.26, 0.28, 0.72, -0.16, 0.16, SUIT],
  [-0.27, 0.27, 0.52, 0.58, -0.165, 0.165, SUIT2],
  [-0.06, 0.06, 0.72, 0.8, -0.06, 0.06, SKIN],
  // harness: shoulder straps, chest and leg straps, pack
  [-0.2, -0.13, 0.3, 0.72, -0.175, -0.16, RIG],
  [0.13, 0.2, 0.3, 0.72, -0.175, -0.16, RIG],
  [-0.2, 0.2, 0.5, 0.54, -0.18, -0.16, RIG],
  [-0.24, 0.24, -0.02, 0.04, -0.15, -0.13, RIG],
  [-0.2, 0.2, 0.06, 0.7, 0.14, 0.4, RIG],
  [-0.14, 0.14, 0.7, 0.76, 0.16, 0.36, [200, 70, 40]],
  [-0.2, 0.2, 0.06, 0.2, 0.4, 0.44, [214, 62, 44]],
]);
const HEAD = part([
  [-0.14, 0.14, 0.0, 0.14, -0.14, 0.13, SKIN],
  [-0.17, 0.17, 0.12, 0.3, -0.17, 0.17, HELM],
  [-0.175, 0.175, 0.2, 0.25, -0.172, 0.172, [214, 54, 46]],
  [-0.15, 0.15, 0.08, 0.17, -0.2, -0.16, [30, 60, 120]],
  [-0.16, 0.16, 0.0, 0.16, 0.1, 0.17, HELM],
]);
const UPPER = (c) => part([[-0.075, 0.075, -0.3, 0.05, -0.075, 0.075, c]]);
const FORE = (c) =>
  part([
    [-0.065, 0.065, -0.28, 0.04, -0.065, 0.065, c],
    [-0.07, 0.07, -0.36, -0.26, -0.07, 0.07, RIG],
  ]);
const THIGH = part([[-0.1, 0.1, -0.46, 0.06, -0.1, 0.1, PANTS]]);
const SHIN = part([
  [-0.09, 0.09, -0.44, 0.04, -0.09, 0.09, PANTS],
  [-0.095, 0.095, -0.52, -0.4, -0.12, 0.1, BOOT],
]);

// A rectangular ram-air wing: arced cells, nose-down trim, lines down to the risers.
function canopyGeometry() {
  const parts = [];
  const N = 11;
  const W = 9.0;
  const C = 3.0;
  const w = W / N;
  const arc = 0.05;
  const tilt = new THREE.Matrix4().makeRotationX(-0.14);
  const cells = [];
  for (let i = 0; i < N; i++) {
    const xc = -W / 2 + (i + 0.5) * w;
    const edge = Math.abs(xc) / (W / 2);
    const t = 0.52 - 0.22 * edge; // thinner near the tips
    const y = CANOPY_H - arc * xc * xc;
    const ang = Math.atan(-2 * arc * xc);
    const col = i === 5 ? [40, 90, 200] : i % 2 === 0 ? [222, 52, 44] : [246, 246, 248];
    const m = new THREE.Matrix4()
      .multiplyMatrices(tilt, new THREE.Matrix4().makeTranslation(xc, y, 0).multiply(new THREE.Matrix4().makeRotationZ(ang)));
    parts.push(boxGeometry([-w / 2 - 0.01, w / 2 + 0.01, -t / 2, t / 2, -C / 2, C / 2, col], m));
    // dark air intakes along the leading edge, and a darker trailing edge
    parts.push(boxGeometry([-w / 2 + 0.05, w / 2 - 0.05, -t * 0.32, t * 0.32, -C / 2 - 0.03, -C / 2 + 0.05, [24, 26, 34]], m));
    parts.push(boxGeometry([-w / 2 - 0.01, w / 2 + 0.01, -t / 2 + 0.03, t / 2 - 0.06, C / 2 - 0.1, C / 2, [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7]], m));
    cells.push({ xc, y, ang, t, m });
  }
  // suspension lines: three rows, every other cell, gathered into one riser per side
  const upv = new THREE.Vector3(1, 0, 0);
  const lineCol = [222, 210, 150];
  for (const c of cells) {
    if (cells.indexOf(c) % 2 !== 0 && Math.abs(c.xc) > 0.1) continue;
    for (const z of [-1.0, 0.0, 1.0]) {
      const top = new THREE.Vector3(0, -c.t / 2, z).applyMatrix4(c.m);
      const side = Math.sign(c.xc) || 1;
      const bot = new THREE.Vector3(0.2 * side, 0.12, z * 0.05);
      const len = top.distanceTo(bot);
      const m = new THREE.Matrix4().lookAt(top, bot, upv);
      m.setPosition(top.clone().add(bot).multiplyScalar(0.5));
      parts.push(boxGeometry([-0.014, 0.014, -0.014, 0.014, -len / 2, len / 2, lineCol], m));
    }
  }
  // the risers themselves
  for (const sx of [-1, 1]) parts.push(boxGeometry([0.17 * sx - 0.03, 0.17 * sx + 0.03, 0, 0.22, -0.04, 0.04, [60, 60, 70]]));
  return mergeGeometries(parts);
}

const _r = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _bk = new THREE.Vector3();
const _s = new THREE.Vector3();
const _h = new THREE.Vector3();
const _e = new THREE.Euler();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);

function pivot(parent, x, y, z, geom, material) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (geom) {
    const m = new THREE.Mesh(geom, material);
    m.frustumCulled = false;
    g.add(m);
  }
  parent.add(g);
  return g;
}

// Free-fall and parachute flight on the sphere, position in double precision (metres from the planet centre).
export class Skydiver {
  constructor(material) {
    this.p = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.f = new THREE.Vector3(1, 0, 0);
    this.hv = new THREE.Vector3();
    this.vy = 0;
    this.reset();

    // articulated rig: every joint is a group so poses are just rotations
    this.body = new THREE.Group();
    const b = this.body;
    pivot(b, 0, 0, 0, TORSO, material);
    this.head = pivot(b, 0, 0.78, 0, HEAD, material);
    this.arm = [-1, 1].map((s) => {
      const sh = pivot(b, 0.34 * s, 0.64, 0, UPPER(SUIT), material);
      const el = pivot(sh, 0, -0.28, 0, FORE(SUIT), material);
      return { sh, el };
    });
    this.leg = [-1, 1].map((s) => {
      const hp = pivot(b, 0.12 * s, 0.0, 0, THIGH, material);
      const kn = pivot(hp, 0, -0.44, 0, SHIN, material);
      return { hp, kn };
    });
    this.canopy = new THREE.Mesh(canopyGeometry(), material);
    this.canopy.frustumCulled = false;
    this.body.visible = false;
    this.canopy.visible = false;
  }

  reset() {
    this.deployed = false;
    this.deployT = 0;
    this.open = 0;
    this.agl = 1e9;
    this.t = 0;
    // smoothed controls
    this.steer = 0;
    this.spd = 0;
    this.flare = 0;
    this.brake = 0;
    // camera orbit relative to the heading
    this.camYaw = 0;
    this.camPitch = -0.42;
    this.lookIdle = 9;
    // visual dynamics
    this.swingZ = 0;
    this.swingZv = 0;
    this.swingX = 0;
    this.swingXv = 0;
    this.bank = 0;
    this.tilt = 0; // free-fall dive angle
    this.kick = 0;
    this.shake = 0;
    this.jolted = false;
    this.autoFlag = false;
    this.landed = false;
    this.landT = 0;
    this.hard = false;
    this.legPhase = 0;
  }

  start(pos, fwd, vel) {
    this.p.copy(pos);
    this.up.copy(pos).normalize();
    this.f.copy(fwd).addScaledVector(this.up, -fwd.dot(this.up)).normalize();
    this.vy = vel.dot(this.up);
    this.hv.copy(vel).addScaledVector(this.up, -this.vy);
    this.reset();
  }

  velocity(out) {
    return out.copy(this.hv).addScaledVector(this.up, this.vy);
  }

  deploy(auto = false) {
    if (!this.deployed && !this.landed) {
      this.deployed = true;
      this.deployT = 0;
      this.autoFlag = auto;
    }
  }

  get alt() {
    return this.p.length() - R;
  }
  get lat() {
    return dirToLat(this.up.x, this.up.y, this.up.z);
  }
  get lon() {
    return dirToLon(this.up.x, this.up.z);
  }
  get headingDeg() {
    const lo = this.lon * DEG;
    const east = _r.set(-Math.sin(lo), 0, -Math.cos(lo));
    const north = _bk.crossVectors(this.up, east);
    return ((Math.atan2(this.f.dot(east), this.f.dot(north)) / DEG) + 360) % 360;
  }
  // Canopy fully inflated.
  get flying() {
    return this.open >= 1;
  }
  get finished() {
    return this.landed && this.landT > (this.hard ? 2.4 : 1.6);
  }
  get fov() {
    const v = Math.hypot(this.vy, this.hv.length());
    return 68 + 12 * sstep(v, 15, 70) + 12 * this.kick;
  }

  // Orbit the camera around the diver; it eases back behind them when released.
  lookBy(yaw, pitch) {
    this.camYaw = clamp(this.camYaw + yaw, -Math.PI, Math.PI);
    this.camPitch = clamp(this.camPitch + pitch, -1.35, 0.55);
    this.lookIdle = 0;
  }

  // input: {steer, speed, flare} in -1..1; ground: {h, water} under the diver.
  // Returns null in flight, or {speed, hspeed, water} once at touchdown.
  update(dt, input, ground) {
    this.t += dt;
    this.up.copy(this.p).normalize();
    this.f.addScaledVector(this.up, -this.f.dot(this.up)).normalize();

    this.lookIdle += dt;
    if (this.lookIdle > 1.6) {
      const k = Math.exp(-dt * 1.8);
      this.camYaw *= k;
      this.camPitch += (-0.42 - this.camPitch) * (1 - k);
    }
    this.kick *= Math.exp(-dt * 1.6);
    this.shake *= Math.exp(-dt * 3);

    const alt = this.alt;
    this.agl = alt - HIP - ground.h;
    if (this.landed) return this.rollOut(dt, ground);

    if (!this.deployed && this.agl < AAD_AGL && this.vy < -10) this.deploy(true);
    if (this.deployed) {
      this.deployT += dt;
      this.open = Math.min(1, this.deployT / OPEN_TIME);
      if (!this.jolted && this.open > 0.55) {
        // the canopy snaps open: the rig swings back and the camera lurches
        this.jolted = true;
        this.swingXv -= 2.6;
        this.kick = 1;
        this.shake = 0.7;
      }
    }
    const e = smooth(this.open);
    const under = e > 0.5;

    // smoothed controls: A/D steer, W/S speed (toggles/speed bar), Space flare
    this.steer += (clamp(input.steer, -1, 1) - this.steer) * (1 - Math.exp(-dt / (under ? 0.38 : 0.25)));
    this.spd += (clamp(input.speed, -1, 1) - this.spd) * (1 - Math.exp(-dt / 0.3));
    this.flare += ((input.flare ? 1 : 0) - this.flare) * (1 - Math.exp(-dt / 0.28));
    const fast = Math.max(0, this.spd);
    const auto = this.open >= 1 ? sstep(-this.agl, -9, -1.5) * 0.42 : 0; // gentle round-out if you never flare
    this.brake = clamp(Math.max(this.flare, -this.spd, auto), 0, 1);

    // steering
    const turnRate = under ? this.steer * (0.75 + 0.3 * fast) : this.steer * 1.2;
    this.f.applyAxisAngle(this.up, -turnRate * dt);

    // vertical: quadratic drag whose terminal speed eases from free-fall to canopy
    const thin = 1 / Math.sqrt(Math.max(Math.exp(-Math.max(alt, 0) / 8500), 0.1));
    const fw = this.spd;
    const vtFall = (VT_FALL + 14 * fw) * thin;
    let sink = 5.0 + 2.2 * fast - 1.7 * this.brake + 2.6 * sstep(Math.abs(this.steer), 0.55, 1);
    if (this.brake > 0.9 && this.agl > 8) sink += 2.4; // held on the brakes too high up: mushing
    sink = Math.max(1.2, sink);
    const flareBite = sstep(this.brake, 0.5, 0.95) * sstep(-this.agl, -7, -1);
    sink += (1.3 - sink) * flareBite;
    const vtCan = sink * thin;
    const vt = vtFall + (vtCan - vtFall) * e;
    const drag = (G / (vt * vt)) * this.vy * Math.abs(this.vy);
    this.vy += Math.min(-G - drag, MAX_DECEL) * dt;

    // horizontal: relax toward the commanded glide
    const spdT = e > 0.5 ? 11 + 4.2 * fast - 7 * this.brake * (1 - 0.3 * flareBite) : 10 + (fw > 0 ? 22 * fw : 10 * fw);
    _r.copy(this.f).multiplyScalar(Math.max(2.5, spdT));
    this.hv.lerp(_r, 1 - Math.exp(-dt * (e > 0.3 ? 1.4 : 0.7)));
    this.hv.addScaledVector(this.up, -this.hv.dot(this.up));

    this.p.addScaledVector(this.hv, dt).addScaledVector(this.up, this.vy * dt);
    this.agl = this.alt - HIP - ground.h;
    this.animate(dt);
    if (this.agl <= 0) {
      this.p.setLength(R + ground.h + HIP);
      const res = { speed: Math.max(0, -this.vy), hspeed: this.hv.length(), water: !!ground.water };
      return res;
    }
    return null;
  }

  // Called by the game when the touchdown is survivable; the diver then runs it out and the canopy collapses.
  land(speed) {
    this.landed = true;
    this.landT = 0;
    this.hard = speed > 6.5;
    this.vy = 0;
    this.deployed = true;
    if (this.hard) this.shake = 1;
    else this.shake = 0.25;
  }

  rollOut(dt, ground) {
    this.landT += dt;
    this.p.setLength(R + ground.h + HIP);
    this.hv.multiplyScalar(Math.exp(-dt * (this.hard ? 3.2 : 2.2)));
    this.hv.addScaledVector(this.up, -this.hv.dot(this.up));
    this.p.addScaledVector(this.hv, dt);
    this.legPhase += dt * Math.min(12, this.hv.length() * 1.6);
    this.animate(dt);
    return null;
  }

  // spring-damped swing of the rig under the wing and the free-fall dive angle
  animate(dt) {
    const under = this.open >= 0.5;
    const tz = under ? -this.steer * 0.2 : 0;
    const tx = under ? this.brake * 0.22 - Math.max(0, this.spd) * 0.1 : 0;
    const k = 16;
    const c = 2.4;
    this.swingZv += (-k * (this.swingZ - tz) - c * this.swingZv) * dt;
    this.swingZ += this.swingZv * dt;
    this.swingXv += (-k * (this.swingX - tx) - c * this.swingXv) * dt;
    this.swingX += this.swingXv * dt;
    const bankT = under ? this.steer * 0.42 * (1 + 0.3 * Math.max(0, this.spd)) : this.steer * 0.55;
    this.bank += (bankT - this.bank) * (1 - Math.exp(-dt * 3.5));
    // head-down when diving, flared out when slowing
    const tiltT = this.spd > 0 ? 0.62 * this.spd : 0.22 * this.spd;
    this.tilt += (tiltT - this.tilt) * (1 - Math.exp(-dt * 3));
  }

  // Third-person camera orbiting the diver; gh keeps it off the ground.
  cameraRig(camPos, quat, gh) {
    const e = smooth(this.open);
    const cp = Math.cos(this.camPitch);
    const sp = Math.sin(this.camPitch);
    _h.copy(this.f).applyAxisAngle(this.up, -this.camYaw);
    const dist = 8.5 + 5 * e + 2.5 * this.kick;
    _s.copy(this.p).addScaledVector(this.up, 0.9 + 2.6 * e);
    camPos.copy(_s).addScaledVector(_h, -cp * dist).addScaledVector(this.up, -sp * dist);
    const minR = R + gh + 0.7;
    const r = camPos.length();
    if (r < minR) camPos.multiplyScalar(minR / r);
    _bk.copy(this.up).multiplyScalar(cp).addScaledVector(_h, -sp); // camera up
    _r.crossVectors(_h, this.up).normalize();
    _s.copy(_h).multiplyScalar(cp).addScaledVector(this.up, sp).negate();
    quat.setFromRotationMatrix(_m.makeBasis(_r, _bk, _s));
    if (this.shake > 0.01) {
      const a = this.shake * 0.014;
      _e.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a * 1.5);
      quat.multiply(_q2.setFromEuler(_e));
    }
  }

  pose() {
    const e = smooth(this.open);
    const [al, ar] = this.arm;
    const [ll, lr] = this.leg;
    const fall = 1 - e;
    const spread = fall * clamp(1 - Math.max(0, this.spd) * 1.1, 0, 1); // spread-eagle unless diving
    const slow = fall * Math.max(0, -this.spd);
    const rest = this.landed ? 0 : 1;
    // hanging pose: hands up on the toggles; pulling down with the brakes or the turn side
    const pullL = clamp(this.brake + Math.max(0, -this.steer) * 0.9, 0, 1);
    const pullR = clamp(this.brake + Math.max(0, this.steer) * 0.9, 0, 1);
    const hang = e * rest;
    const armUp = (pull) => 2.55 - 0.9 * pull;
    const run = this.landed ? 1 : 0;
    const sw = Math.sin(this.legPhase) * 0.9 * Math.min(1, this.hv.length() / 4) * run;

    // arms
    for (const [a, s, pull] of [
      [al, -1, pullL],
      [ar, 1, pullR],
    ]) {
      const swing = run * (-sw * s) * 0.9;
      a.sh.rotation.set(hang * armUp(pull) + swing, 0, s * (spread * 1.15 + (1 - hang) * 0.12 * (1 - spread) + hang * 0.28));
      a.el.rotation.set(-hang * (0.9 - 0.4 * pull) - run * 0.7 * (1 - Math.abs(swing)), 0, s * (spread * 1.45 + slow * 0.6));
    }
    // legs
    for (const [l, s] of [
      [ll, -1],
      [lr, 1],
    ]) {
      const kick = run * sw * s;
      l.hp.rotation.set(hang * 0.22 + kick * 0.8 + run * 0.12, 0, s * (spread * 0.34 + slow * 0.25));
      l.kn.rotation.set(-(spread * 0.9 + slow * 0.55 + hang * 0.5 + (kick < 0 ? -kick * 1.1 : 0)), 0, 0);
    }
    // head: looks forward in free-fall (upright relative to the horizon), slight dip while braking
    this.head.rotation.set(fall * (0.9 - 0.5 * Math.max(0, this.spd)) - 0.15 * hang, -this.bank * 0.4, 0);
  }

  syncMeshes(camPos, dt) {
    const e = smooth(this.open);
    _r.crossVectors(this.f, this.up).normalize();
    _bq.setFromRotationMatrix(_m.makeBasis(_r, this.up, _bk.copy(this.f).negate()));
    this.pose();

    // dive pitch: belly-to-earth in free-fall (head forward), upright once the canopy has opened
    const hard = this.landed && this.hard ? Math.max(0, Math.min(1, this.landT / 0.35)) * (1 - sstep(this.landT, 1.1, 2.2)) : 0;
    const fallAngle = -Math.PI / 2 * (1 - e) - this.tilt * (1 - e) - hard * 1.35;
    const swingScale = e;
    // rig orientation about the shoulder anchor: swing + bank
    const rig = _q3.copy(_bq);
    _q2.setFromAxisAngle(AZ, this.swingZ * swingScale - this.bank * 0.45 * e);
    rig.multiply(_q2);
    _q2.setFromAxisAngle(AX, this.swingX * swingScale + fallAngle);
    rig.multiply(_q2);
    this.body.quaternion.copy(rig);
    // pivot about the anchor (shoulders) while hanging, about the hip in free-fall
    _s.copy(this.p);
    this.body.position.copy(_s).sub(camPos);
    this.body.visible = true;

    this.canopy.visible = this.deployed;
    if (this.deployed) {
      const col = this.landed ? sstep(this.landT, 0, 1.2) : 0;
      const fade = this.landed ? 1 - sstep(this.landT, this.hard ? 1.8 : 1.1, this.hard ? 2.3 : 1.55) : 1;
      // anchor point (shoulders) in world space
      _h.set(0, ANCHOR, 0).applyQuaternion(rig);
      _s.copy(this.p).add(_h);
      // while opening the wing trails behind (up axis tipped back), then swings overhead
      const trail = 1 - e;
      this.canopy.quaternion
        .copy(_bq)
        .multiply(_q2.setFromAxisAngle(AZ, this.swingZ * e - this.bank * 0.7 * e))
        .multiply(_q2.setFromAxisAngle(AX, this.swingX * e + trail * (Math.PI / 2 - this.tilt * 0.3) - col * 1.35 + (hard * 0)));
      const surge = this.open >= 1 && !this.landed ? 1 + 0.1 * Math.exp(-(this.deployT - OPEN_TIME) * 2.5) * Math.sin((this.deployT - OPEN_TIME) * 12) : 1;
      const sx = (0.12 + 0.88 * e) * surge;
      const sy = (0.18 + 0.82 * e) * (1 - 0.75 * col);
      const sz = (0.3 + 0.7 * e) * (1 + 0.5 * col);
      this.canopy.scale.set(sx, sy, sz).multiplyScalar(Math.max(0.001, fade));
      this.canopy.position.copy(_s).sub(camPos);
    }
  }

  hide() {
    this.body.visible = false;
    this.canopy.visible = false;
  }
}
