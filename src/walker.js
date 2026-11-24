import * as THREE from 'three';
import { R, DEG, dirToLat, dirToLon, llToMerc } from './geo.js';

export const EYE = 1.7;
const STEP = 1.05; // tallest ledge climbed automatically
const RADIUS = 0.35;
const GRAVITY = 9.8;
const JUMP_V = 5.2;
const PROBES = [
  [0, 0],
  [RADIUS, 0],
  [-RADIUS, 0],
  [0, RADIUS],
  [0, -RADIUS],
];

const _c = new THREE.Vector3();
const _w = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _res = { h: 0, water: false, ok: false };

// First-person walker on the sphere. Position is a unit direction plus feet altitude, in double precision.
export class Walker {
  constructor() {
    this.n = new THREE.Vector3(0, 1, 0);
    this.f = new THREE.Vector3(1, 0, 0);
    this.foot = 0;
    this.vy = 0;
    this.grounded = false;
    this.look = 0; // pitch, radians
    this.eyeOffset = 0; // smoothed difference between eye and feet height
    this.smoothFoot = 0;
    this.blocked = false;
  }

  place(pos, fwd, foot) {
    this.n.copy(pos).normalize();
    this.f.copy(fwd).addScaledVector(this.n, -fwd.dot(this.n)).normalize();
    this.foot = foot;
    this.smoothFoot = foot;
    this.vy = 0;
    this.look = 0;
    this.grounded = false;
  }

  get right() {
    return _w.crossVectors(this.f, this.n).normalize();
  }

  get lat() {
    return dirToLat(this.n.x, this.n.y, this.n.z);
  }

  get lon() {
    return dirToLon(this.n.x, this.n.z);
  }

  get headingDeg() {
    const lo = this.lon * DEG;
    const east = _c.set(-Math.sin(lo), 0, -Math.cos(lo));
    const north = _ax.crossVectors(this.n, east);
    return ((Math.atan2(this.f.dot(east), this.f.dot(north)) / DEG) + 360) % 360;
  }

  eyePosition(out) {
    return out.copy(this.n).multiplyScalar(R + this.smoothFoot + EYE);
  }

  turn(yaw, pitch) {
    this.f.applyAxisAngle(this.n, -yaw).normalize();
    this.look = Math.max(-1.5, Math.min(1.5, this.look + pitch));
  }

  basisQuaternion(out) {
    const r = new THREE.Vector3().crossVectors(this.f, this.n).normalize();
    const cp = Math.cos(this.look);
    const sp = Math.sin(this.look);
    const f2 = this.f.clone().multiplyScalar(cp).addScaledVector(this.n, sp);
    const u2 = this.n.clone().multiplyScalar(cp).addScaledVector(this.f, -sp);
    return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u2, f2.negate()));
  }

  // Highest ground under the body at direction dir, and whether it is water. Sets _res.ok=false when tiles are missing.
  probe(world, dir, f, r) {
    let h = -Infinity;
    let water = false;
    _res.ok = true;
    for (const [a, b] of PROBES) {
      _c.copy(dir).addScaledVector(f, a / R).addScaledVector(r, b / R).normalize();
      const m = llToMerc(dirToLat(_c.x, _c.y, _c.z), dirToLon(_c.x, _c.z));
      const s = world.sample(m.u, m.v);
      if (!s) {
        _res.ok = false;
        return _res;
      }
      const sh = s.water ? Math.max(s.h, 0) : s.h;
      if (sh > h) h = sh;
      if (s.water) water = true;
    }
    _res.h = h;
    _res.water = water;
    return _res;
  }

  // Tries to move by dist along tangent direction w; returns true when the move was allowed.
  tryMove(world, w, dist) {
    const cand = _ax.copy(this.n).multiplyScalar(R).addScaledVector(w, dist).normalize().clone();
    const r = new THREE.Vector3().crossVectors(this.f, cand).normalize();
    const res = this.probe(world, cand, this.f, r);
    if (!res.ok || res.water) return false;
    if (res.h - this.foot > STEP) return false;
    // parallel transport of the heading
    const axis = new THREE.Vector3().crossVectors(this.n, cand);
    const s = axis.length();
    if (s > 1e-14) {
      axis.divideScalar(s);
      const ang = Math.atan2(s, this.n.dot(cand));
      this.f.applyAxisAngle(axis, ang);
      w.applyAxisAngle(axis, ang);
    }
    this.n.copy(cand);
    this.f.addScaledVector(this.n, -this.f.dot(this.n)).normalize();
    return true;
  }

  // input: {fwd, strafe, sprint, jump}; returns false while waiting for terrain under the player.
  update(dt, input, world) {
    const here = this.probe(world, this.n, this.f, this.right.clone());
    if (!here.ok) {
      this.blocked = true;
      return false;
    }
    this.blocked = false;

    let wishF = input.fwd;
    let wishR = input.strafe;
    const len = Math.hypot(wishF, wishR);
    if (len > 1) {
      wishF /= len;
      wishR /= len;
    }
    const speed = input.sprint ? 8 : 4.3;
    const total = Math.hypot(wishF, wishR) * speed * dt;
    if (total > 1e-6) {
      const steps = Math.max(1, Math.ceil(total / 0.2));
      const ds = total / steps;
      for (let i = 0; i < steps; i++) {
        const right = new THREE.Vector3().crossVectors(this.f, this.n).normalize();
        const w = new THREE.Vector3().addScaledVector(this.f, wishF).addScaledVector(right, wishR).normalize();
        if (this.tryMove(world, w, ds)) continue;
        // slide along whichever axis is free
        let moved = false;
        if (wishF) moved = this.tryMove(world, this.f.clone().multiplyScalar(Math.sign(wishF)), ds * Math.abs(wishF));
        if (wishR) {
          const r2 = new THREE.Vector3().crossVectors(this.f, this.n).normalize().multiplyScalar(Math.sign(wishR));
          moved = this.tryMove(world, r2, ds * Math.abs(wishR)) || moved;
        }
        if (!moved) break;
      }
    }

    // vertical motion against the highest probed ground
    const ground = this.probe(world, this.n, this.f, new THREE.Vector3().crossVectors(this.f, this.n).normalize());
    if (!ground.ok) return false;
    const gh = ground.h;
    if (this.grounded && input.jump) {
      this.vy = JUMP_V;
      this.grounded = false;
    }
    if (this.grounded && this.foot - gh <= 0.5) {
      this.foot = gh;
      this.vy = 0;
    } else {
      this.vy -= GRAVITY * dt;
      this.foot += this.vy * dt;
      if (this.foot <= gh) {
        this.foot = gh;
        this.vy = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    }
    this.smoothFoot += (this.foot - this.smoothFoot) * (1 - Math.exp(-dt * 16));
    return true;
  }
}
