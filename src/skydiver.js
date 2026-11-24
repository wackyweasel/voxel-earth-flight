import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { R, DEG, dirToLat, dirToLon } from './geo.js';
import { boxGeometry } from './plane.js';

const G = 9.8;
const VT_FALL = 55; // terminal velocity belly-to-earth at sea level, m/s
const VT_CANOPY = 5.2; // steady sink rate under canopy, m/s
const OPEN_TIME = 2.4; // seconds from pull to a fully open canopy
const MAX_DECEL = 30; // opening shock limit, m/s²
const AAD_AGL = 220; // automatic activation height above ground, m
const CANOPY_H = 7.0; // canopy centre above the hip, m
export const HIP = 1.0; // soles to hip

const smooth = (x) => x * x * (3 - 2 * x);

// Hip at the origin, upright, facing -Z.
const BODY = [
  [-0.22, -0.02, -1.0, 0, -0.12, 0.12, [48, 58, 92]],
  [0.02, 0.22, -1.0, 0, -0.12, 0.12, [48, 58, 92]],
  [-0.24, -0.0, -1.0, -0.8, -0.2, 0.12, [30, 30, 34]],
  [0.0, 0.24, -1.0, -0.8, -0.2, 0.12, [30, 30, 34]],
  [-0.28, 0.28, 0, 0.75, -0.16, 0.16, [215, 60, 40]],
  [-0.22, 0.22, 0.1, 0.65, 0.16, 0.42, [40, 40, 48]],
  [-0.46, -0.28, 0.2, 0.7, -0.1, 0.1, [215, 60, 40]],
  [0.28, 0.46, 0.2, 0.7, -0.1, 0.1, [215, 60, 40]],
  [-0.16, 0.16, 0.75, 1.03, -0.16, 0.16, [235, 195, 160]],
  [-0.18, 0.18, 0.88, 1.08, -0.18, 0.18, [230, 230, 235]],
];

function canopyGeometry() {
  const parts = [];
  const N = 9;
  const W = 8.8;
  const w = W / N;
  const yAt = (x) => -0.055 * x * x;
  for (let i = 0; i < N; i++) {
    const xc = -W / 2 + (i + 0.5) * w;
    const y = yAt(xc);
    const c = i === 4 ? [45, 95, 205] : i % 2 === 0 ? [214, 54, 46] : [244, 244, 246];
    parts.push(boxGeometry([xc - w / 2, xc + w / 2, y - 0.25, y + 0.25, -1.4, 1.4, c]));
  }
  // suspension lines from the canopy to the shoulders
  const shoulder = (sx) => new THREE.Vector3(0.25 * sx, -CANOPY_H + 0.7, 0);
  const upv = new THREE.Vector3(1, 0, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = new THREE.Vector3(3.2 * sx, yAt(3.2) - 0.25, 1.0 * sz);
      const b = shoulder(sx);
      const len = a.distanceTo(b);
      const m = new THREE.Matrix4().lookAt(a, b, upv);
      m.setPosition(a.clone().add(b).multiplyScalar(0.5));
      parts.push(boxGeometry([-0.025, 0.025, -0.025, 0.025, -len / 2, len / 2, [225, 215, 130]], m));
    }
  }
  return mergeGeometries(parts);
}

const _r = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _bk = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);
const AZ = new THREE.Vector3(0, 0, 1);

// Free-fall and parachute flight on the sphere, position in double precision (metres from the planet centre).
export class Skydiver {
  constructor(material) {
    this.p = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.f = new THREE.Vector3(1, 0, 0);
    this.hv = new THREE.Vector3();
    this.vy = 0;
    this.deployed = false;
    this.deployT = 0;
    this.open = 0;
    this.look = -0.45;
    this.roll = 0;
    this.t = 0;
    this.agl = 1e9;

    this.body = new THREE.Mesh(mergeGeometries(BODY.map((b) => boxGeometry(b))), material);
    this.canopy = new THREE.Mesh(canopyGeometry(), material);
    for (const m of [this.body, this.canopy]) {
      m.frustumCulled = false;
      m.visible = false;
    }
  }

  start(pos, fwd, vel) {
    this.p.copy(pos);
    this.up.copy(pos).normalize();
    this.f.copy(fwd).addScaledVector(this.up, -fwd.dot(this.up)).normalize();
    this.vy = vel.dot(this.up);
    this.hv.copy(vel).addScaledVector(this.up, -this.vy);
    this.deployed = false;
    this.deployT = 0;
    this.open = 0;
    this.look = -0.45;
    this.roll = 0;
    this.t = 0;
    this.agl = 1e9;
  }

  deploy() {
    if (!this.deployed) {
      this.deployed = true;
      this.deployT = 0;
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

  turn(yaw, pitch) {
    this.f.applyAxisAngle(this.up, -yaw).normalize();
    this.look = Math.max(-1.35, Math.min(0.55, this.look + pitch));
  }

  // input: {fwd}; ground: {h, water} under the diver. Returns null in flight, or {speed, water} at touchdown.
  update(dt, input, ground) {
    this.t += dt;
    this.up.copy(this.p).normalize();
    this.f.addScaledVector(this.up, -this.f.dot(this.up)).normalize();

    const alt = this.alt;
    this.agl = alt - HIP - ground.h;
    if (!this.deployed && this.agl < AAD_AGL && this.vy < -10) this.deploy();
    if (this.deployed) {
      this.deployT += dt;
      this.open = Math.min(1, this.deployT / OPEN_TIME);
    }
    const e = smooth(this.open);
    const fw = input.fwd;

    // vertical: quadratic drag whose terminal speed eases from free-fall to canopy
    const thin = 1 / Math.sqrt(Math.max(Math.exp(-Math.max(alt, 0) / 8500), 0.1));
    const vtFall = (VT_FALL + 14 * fw) * thin;
    const vtCan = (VT_CANOPY + (fw > 0 ? 2.2 * fw : 1.6 * fw)) * thin;
    let vt = vtFall + (vtCan - vtFall) * e;
    if (this.open >= 1 && this.agl < 8) vt = Math.min(vt, 2.4 + this.agl * 0.3); // flare
    const drag = (G / (vt * vt)) * this.vy * Math.abs(this.vy);
    this.vy += Math.min(-G - drag, MAX_DECEL) * dt;

    // horizontal: relax toward the commanded glide
    const spd = e > 0.5 ? 10 + 6 * fw : 10 + (fw > 0 ? 22 * fw : 10 * fw);
    _r.copy(this.f).multiplyScalar(spd);
    this.hv.lerp(_r, 1 - Math.exp(-dt * (e > 0.3 ? 1.4 : 0.7)));
    this.hv.addScaledVector(this.up, -this.hv.dot(this.up));

    this.p.addScaledVector(this.hv, dt).addScaledVector(this.up, this.vy * dt);
    this.agl = this.alt - HIP - ground.h;
    if (this.agl <= 0) return { speed: -this.vy, water: !!ground.water };
    return null;
  }

  // Third-person camera behind and above; gh keeps it off the ground.
  cameraRig(camPos, quat, gh) {
    const cp = Math.cos(this.look);
    const sp = Math.sin(this.look);
    const e = smooth(this.open);
    const dist = 8.5 + 3 * e;
    camPos.copy(this.p).addScaledVector(this.up, 0.9 + 2.2 * e);
    camPos.addScaledVector(this.f, -cp * dist).addScaledVector(this.up, -sp * dist);
    const minR = R + gh + 0.7;
    const r = camPos.length();
    if (r < minR) camPos.multiplyScalar(minR / r);
    _bk.copy(this.up).multiplyScalar(cp).addScaledVector(this.f, -sp); // camera up
    _r.crossVectors(this.f, this.up).normalize();
    const fwd = this.f.clone().multiplyScalar(cp).addScaledVector(this.up, sp).negate();
    quat.setFromRotationMatrix(_m.makeBasis(_r, _bk, fwd));
  }

  syncMeshes(camPos, turnInput, dt) {
    const e = smooth(this.open);
    _r.crossVectors(this.f, this.up).normalize();
    _bq.setFromRotationMatrix(_m.makeBasis(_r, this.up, _bk.copy(this.f).negate()));

    // belly-down in free-fall, upright once the canopy opens
    this.body.quaternion.copy(_bq).multiply(_q2.setFromAxisAngle(AX, -Math.PI / 2 * (1 - e)));
    this.body.position.copy(this.p).sub(camPos);
    this.body.visible = true;

    this.roll += (-turnInput * 0.28 - this.roll) * Math.min(1, dt * 2.5);
    this.canopy.visible = this.deployed;
    const s = Math.max(0.02, e);
    this.canopy.scale.setScalar(s);
    this.canopy.quaternion.copy(_bq).multiply(_q2.setFromAxisAngle(AZ, this.roll));
    this.canopy.position
      .copy(this.p)
      .addScaledVector(this.up, CANOPY_H * s)
      .sub(camPos);
  }

  hide() {
    this.body.visible = false;
    this.canopy.visible = false;
  }
}
