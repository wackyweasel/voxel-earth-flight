import * as THREE from 'three';
import { R, DEG, llToDir, dirToLat, dirToLon } from './geo.js';

const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function rotateAbout(v, axis, angle) {
  v.applyAxisAngle(axis, angle);
}

// Arcade flight in an Earth-centred frame. Position and orientation are kept in
// double precision; orientation follows the planet's curvature by parallel transport.
export class Flight {
  constructor() {
    this.p = new THREE.Vector3();
    this.f = new THREE.Vector3(1, 0, 0);
    this.u = new THREE.Vector3(0, 1, 0);
    this.r = new THREE.Vector3(0, 0, 1);
    this.throttle = 0.45; // 0..1, exponential mapping to m/s
    this.autoLevel = true;
    this.invertPitch = false;
    this.speed = 0;
    this.crashed = false;
    this.grounded = false;
    this.landed = false;
    this.crashTimer = 0;
  }

  spawn(lat, lon, alt, headingDeg = 0, pitchDeg = 0) {
    const d = llToDir(lat, lon);
    const n = new THREE.Vector3(d[0], d[1], d[2]);
    this.p.copy(n).multiplyScalar(R + alt);
    const lo = lon * DEG;
    const east = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
    const north = new THREE.Vector3().crossVectors(n, east).normalize();
    const h = headingDeg * DEG;
    this.f.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    this.u.copy(n);
    this.r.crossVectors(this.f, this.u).normalize();
    this.pitch(pitchDeg * DEG);
    this.grounded = false;
    this.landed = false;
  }

  pitch(a) {
    rotateAbout(this.f, this.r, a);
    rotateAbout(this.u, this.r, a);
  }

  roll(a) {
    rotateAbout(this.r, this.f, a);
    rotateAbout(this.u, this.f, a);
  }

  yaw(a) {
    rotateAbout(this.f, this.u, -a);
    rotateAbout(this.r, this.u, -a);
  }

  get throttleMps() {
    const t = this.throttle;
    const k = Math.min(1, Math.max(0, (t - 0.02) / 0.1));
    return 15 * Math.pow(30, t) * k * k * (3 - 2 * k);
  }

  get alt() {
    return this.p.length() - R;
  }

  get lat() {
    return dirToLat(this.p.x, this.p.y, this.p.z);
  }

  get lon() {
    return dirToLon(this.p.x, this.p.z);
  }

  get headingDeg() {
    const n = _tmp.copy(this.p).normalize();
    const lo = this.lon * DEG;
    const ex = -Math.sin(lo);
    const ez = -Math.cos(lo);
    const east = _n0.set(ex, 0, ez);
    const north = _n1.crossVectors(n, east);
    const h = Math.atan2(this.f.dot(east), this.f.dot(north)) / DEG;
    return (h + 360) % 360;
  }

  get pitchDeg() {
    return Math.asin(Math.max(-1, Math.min(1, this.f.dot(_tmp.copy(this.p).normalize())))) / DEG;
  }

  // input: {pitch, roll, yaw} in -1..1 (pitch>0 = nose up, roll>0 = right wing down)
  update(dt, input, scale, groundHeight, gearDrop = 2.2) {
    const n0 = _n0.copy(this.p).normalize();
    const sf = Math.pow(scale, 0.75);
    const grounded0 = this.grounded;

    if (input.pitch) this.pitch(input.pitch * (this.invertPitch ? -1 : 1) * 0.9 * dt);
    if (grounded0) {
      // on the wheels: roll input steers, the wings stay level
      if (input.roll && this.speed > 0.5) this.yaw(input.roll * 0.35 * Math.min(1, this.speed / 15) * dt);
      if (input.yaw && this.speed > 0.5) this.yaw(input.yaw * 0.35 * Math.min(1, this.speed / 15) * dt);
      const bank = Math.atan2(-this.r.dot(n0), this.u.dot(n0));
      this.roll(-bank * Math.min(1, dt * 6));
    } else {
      if (input.roll) this.roll(input.roll * 1.8 * dt);
      if (input.yaw) this.yaw(input.yaw * 0.5 * dt);
      const sinBank = -this.r.dot(n0);
      this.yaw(0.7 * sinBank * dt);
      if (this.autoLevel && !input.roll && Math.abs(this.f.dot(n0)) < 0.85) {
        const bank = Math.atan2(-this.r.dot(n0), this.u.dot(n0));
        this.roll(-bank * Math.min(1, dt * 1.2));
      }
    }

    const target = this.throttleMps * sf;
    const k = grounded0 ? 2.5 : 1.2;
    this.speed += (target - this.speed) * (1 - Math.exp(-k * dt));
    if (grounded0 && target < this.speed) this.speed = Math.max(target, this.speed - 5 * dt * sf);
    if (target === 0 && this.speed < 0.3) this.speed = 0;

    const step = this.speed * dt;
    const r0 = this.p.length();
    let climb = this.f.dot(n0) * step;
    // below flying speed the plane mushes down
    const agl0 = r0 - R - (groundHeight ?? 0);
    if (!grounded0 && agl0 < 5000 && this.speed < 40 * sf) climb -= (40 * sf - this.speed) * 0.6 * dt;
    this.p.addScaledVector(this.f, step);
    this.p.normalize().multiplyScalar(r0 + climb);

    // Parallel-transport the frame along the curved surface.
    const n1 = _n1.copy(this.p).normalize();
    _axis.crossVectors(n0, n1);
    const s = _axis.length();
    if (s > 1e-12) {
      _axis.divideScalar(s);
      const ang = Math.atan2(s, n0.dot(n1));
      rotateAbout(this.f, _axis, ang);
      rotateAbout(this.u, _axis, ang);
    }
    this.f.normalize();
    this.r.crossVectors(this.f, this.u).normalize();
    this.u.crossVectors(this.r, this.f).normalize();

    // Ground contact: roll on the wheels; only a fast steep arrival counts as a crash.
    const floor = (groundHeight ?? 0) + gearDrop * scale;
    const alt = this.p.length() - R;
    const touching = alt <= floor + 0.05;
    this.crashTimer = Math.max(0, (this.crashTimer || 0) - dt);
    if (touching) {
      const vsink = -this.f.dot(n1);
      if (!grounded0 && vsink > 0.25 && this.speed > 60 * sf) this.crashTimer = 1.5;
      this.p.normalize().multiplyScalar(R + floor);
      const lift = this.f.dot(n1);
      // nose can only come up once there is flying speed
      const maxUp = this.speed > 45 * sf ? 1 : 0.0;
      if (lift < 0 || lift > maxUp) {
        const want = lift < 0 ? 0 : maxUp;
        this.f.addScaledVector(n1, want - lift).normalize();
        this.r.crossVectors(this.f, this.u).normalize();
        this.u.crossVectors(this.r, this.f).normalize();
      }
      if (lift < 0 && lift > -0.02 && this.speed < 3) {
        // settle level
        this.f.addScaledVector(n1, -lift).normalize();
      }
    }
    this.grounded = touching && this.f.dot(n1) < 0.04;
    this.landed = this.grounded && this.speed < 2.5;
    this.crashed = this.crashTimer > 0;
  }

  // Parks the plane on the ground at direction/heading taken from a walker or spawn point.
  park(pos, fwd, up) {
    this.p.copy(pos);
    this.u.copy(up).normalize();
    this.f.copy(fwd).addScaledVector(this.u, -fwd.dot(this.u)).normalize();
    this.r.crossVectors(this.f, this.u).normalize();
    this.speed = 0;
    this.throttle = 0;
    this.grounded = true;
    this.landed = true;
  }

  basisQuaternion(out = new THREE.Quaternion()) {
    const m = new THREE.Matrix4().makeBasis(this.r, this.u, _tmp.copy(this.f).negate());
    return out.setFromRotationMatrix(m);
  }
}
