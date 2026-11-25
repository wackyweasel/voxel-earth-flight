import * as THREE from 'three';
import { R, DEG, llToDir } from './geo.js';
import { POIS } from './places.js';

// Auto Play: a hands-off screensaver. The plane circles one place after another while the camera drifts between shots.
// It flies kinematically (no stall, no collisions), writing the pose straight into the Flight object.

const G = 9.81;
const CRUISE = { light: 65, airliner: 100, jet: 140 }; // real m/s while circling
const MAX_BANK = 36 * DEG;
const SHOTS = { chase: 3, wing: 3, outward: 2.5, high: 2, cockpit: 1.5 };
const HOURS = [7, 8, 9, 10, 12, 14, 16, 17, 18, 19, 21, 22];
const RING = 8;
const FADE_OUT = 1.4;
const FADE_IN = 2;

const clamp = THREE.MathUtils.clamp;
const smooth = (x) => x * x * (3 - 2 * x);
const lerpK = (dt, tau) => 1 - Math.exp(-dt / tau);
const rand = (a, b) => a + Math.random() * (b - a);

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _u0 = new THREE.Vector3();
const _r0 = new THREE.Vector3();
const _o = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class AutoPlay {
  // cb: { ground(dir) -> metres | null, ready() -> bool, arrive(poi), title(poi) }
  constructor(flight, cb) {
    this.flight = flight;
    this.cb = cb;
    this.active = false;
    this.poi = null;
    this.state = 'wait'; // wait | in | cruise | out
    this.fade = 1; // 0 = clear, 1 = black
    this.camPos = new THREE.Vector3();
    this.camQuat = new THREE.Quaternion();
    this.fov = 62;
    this.planeVisible = true;
    this.history = [];
    this.nc = new THREE.Vector3();
    this.e1 = new THREE.Vector3();
    this.e2 = new THREE.Vector3();
    this.fS = new THREE.Vector3(1, 0, 0);
    this.lvlR = new THREE.Vector3(); // wings-level basis, for shots that shouldn't roll with the plane
    this.lvlU = new THREE.Vector3();
    this.camOff = new THREE.Vector3();
    this.camMid = new THREE.Vector3();
    this.tgtMid = new THREE.Vector3();
    this.tgtOff = new THREE.Vector3();
    this.ring = new Float32Array(RING);
    this.shot = { kind: 'chase', side: 1, th0: 0, rate: 0.08 };
    this.first = true;
  }

  start() {
    this.active = true;
    this.next();
  }

  stop() {
    this.active = false;
    this.fade = 0;
  }

  // Moves on to the next place early.
  skip() {
    if (this.active && (this.state === 'cruise' || this.state === 'in')) this.state = 'out';
  }

  pickPoi() {
    const fresh = POIS.map((_, i) => i).filter((i) => !this.history.includes(i));
    const i = fresh[Math.floor(Math.random() * fresh.length)];
    this.history.push(i);
    if (this.history.length > 8) this.history.shift();
    return POIS[i];
  }

  // Jumps to a new place; the screen stays black until its tiles are in.
  next() {
    const poi = (this.poi = this.pickPoi());
    const d = llToDir(poi.lat, poi.lon);
    this.nc.set(d[0], d[1], d[2]);
    const lo = poi.lon * DEG;
    this.e1.set(-Math.sin(lo), 0, -Math.cos(lo));
    this.e2.crossVectors(this.nc, this.e1).normalize();
    this.phi = rand(0, Math.PI * 2);
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.ph = rand(0, 6.28);
    this.ph2 = rand(0, 6.28);
    this.t = 0;
    this.visit = rand(70, 110);
    this.alt = poi.h + 150;
    this.altTarget = this.alt;
    this.vAlt = 0;
    this.gHere = 0;
    this.gC = 0;
    this.ring.fill(-1e9);
    this.ringI = 0;
    this.senseT = 0;
    this.camLift = 0;
    this.shotT = 0;
    this.shotLen = 0;
    this.first = true;
    this.state = 'wait';
    this.wait = 0;
    this.fade = 1;
    this.cb.arrive(poi, HOURS[Math.floor(Math.random() * HOURS.length)]);
    this.step(0.05, 1);
  }

  orbitDir(phi, rad, out) {
    const a = rad / R;
    out.copy(this.nc).multiplyScalar(Math.cos(a));
    out.addScaledVector(this.e1, Math.cos(phi) * Math.sin(a));
    out.addScaledVector(this.e2, Math.sin(phi) * Math.sin(a));
    return out;
  }

  // Samples the ground around the orbit to pick a cruise altitude.
  sense(rad, w) {
    const { poi, cb } = this;
    let ahead = -1e9;
    for (const t of [0, 2, 4, 7, 10]) {
      const g = cb.ground(this.orbitDir(this.phi + w * t, rad, _d));
      if (g == null) continue;
      if (t === 0) this.gHere = g;
      ahead = Math.max(ahead, g);
    }
    const gr = cb.ground(this.orbitDir((this.ringI / RING) * Math.PI * 2, rad, _d));
    if (gr != null) this.ring[this.ringI] = gr;
    this.ringI = (this.ringI + 1) % RING;
    const gc = cb.ground(this.nc);
    if (gc != null) this.gC = gc;
    const ref = Math.max(ahead, ...this.ring);
    if (ref > -1e8) this.altTarget = ref + poi.h * (1 + 0.15 * Math.sin(0.05 * this.t + this.ph2));
  }

  update(dt, s) {
    if (!this.active) return;
    this.t += dt;
    this.shotT += dt;
    if (this.shotT > this.shotLen) this.newShot();
    this.step(dt, s);
    this.camera(dt, s);
    switch (this.state) {
      case 'wait':
        this.wait += dt;
        if ((this.wait > 2 && this.cb.ready()) || this.wait > 12) {
          const rad = this.poi.r;
          this.sense(rad, 0);
          this.alt = this.altTarget;
          this.vAlt = 0;
          this.first = true;
          this.shotT = 0;
          this.state = 'in';
          this.inT = 0;
          this.cb.title(this.poi);
        }
        break;
      case 'in':
        this.inT += dt;
        this.fade = 1 - smooth(Math.min(1, this.inT / FADE_IN));
        if (this.inT >= FADE_IN) this.state = 'cruise';
        break;
      case 'cruise':
        this.fade = 0;
        if (this.t > this.visit) this.state = 'out';
        break;
      case 'out':
        this.fade = Math.min(1, this.fade + dt / FADE_OUT);
        if (this.fade >= 1) this.next();
        break;
    }
  }

  step(dt, s) {
    const fl = this.flight;
    const sp = fl.spec;
    const sf = Math.pow(s, 0.75);
    const v = (CRUISE[sp.id] ?? 80) * sf;
    const rMin = (v * v) / (G * Math.tan(MAX_BANK));
    const r0 = Math.max(this.poi.r, rMin);
    const rad = r0 * (1 + 0.18 * Math.sin(0.07 * this.t + this.ph));
    this.phi += (this.dir * v * dt) / rad;

    this.senseT -= dt;
    if (this.senseT <= 0) {
      this.senseT = 0.25;
      this.sense(rad, (this.dir * v) / rad);
    }
    let want = clamp((this.altTarget - this.alt) * 0.2, -12, 25);
    if (this.alt < this.gHere + 90) want = Math.max(want, 45);
    this.vAlt += (want - this.vAlt) * lerpK(dt, 0.8);
    this.alt += this.vAlt * dt;

    this.orbitDir(this.phi, rad, _d);
    _p.copy(_d).multiplyScalar(R + this.alt);
    if (this.first) {
      this.orbitDir(this.phi + this.dir * 0.001, rad, _v).multiplyScalar(R + this.alt).sub(_p);
      _v.normalize().multiplyScalar(v);
    } else {
      _v.copy(_p).sub(fl.p).divideScalar(Math.max(dt, 1e-4));
    }
    _t.copy(_v).normalize();
    if (this.first) this.fS.copy(_t);
    else this.fS.lerp(_t, lerpK(dt, 0.4)).normalize();

    const bankT = -this.dir * clamp(Math.atan((v * v) / (G * rad)), 5 * DEG, MAX_BANK);
    this.bank = this.first ? bankT : this.bank + (bankT - this.bank) * lerpK(dt, 1);

    const f = this.fS;
    _n.copy(_p).normalize();
    _u0.copy(_n).addScaledVector(f, -_n.dot(f)).normalize();
    _r0.crossVectors(f, _u0).normalize();
    const cb = Math.cos(this.bank);
    const sb = Math.sin(this.bank);
    fl.p.copy(_p);
    fl.f.copy(f);
    fl.r.copy(_r0).multiplyScalar(cb).addScaledVector(_u0, -sb);
    fl.u.copy(_u0).multiplyScalar(cb).addScaledVector(_r0, sb);
    fl.sf = sf;
    fl.vn.copy(_v).divideScalar(sf);
    fl.speed = _v.length();
    fl.vsi = this.vAlt;
    fl.eng = fl.throttle = sp.trimThrottle;
    fl.ab = 0;
    fl.grounded = fl.landed = fl.crashSevere = fl.stalled = false;
    fl.age += dt;
    this.lvlR.copy(_r0);
    this.lvlU.copy(_u0);
  }

  newShot() {
    const prev = this.shot.kind;
    const bag = Object.keys(SHOTS).filter((k) => k !== prev);
    let r = Math.random() * bag.reduce((a, k) => a + SHOTS[k], 0);
    let kind = bag[0];
    for (const k of bag) {
      r -= SHOTS[k];
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    this.shot = {
      kind,
      side: Math.random() < 0.5 ? 1 : -1,
      th0: rand(0, Math.PI * 2),
      rate: rand(3, 6) * DEG * (Math.random() < 0.5 ? 1 : -1),
    };
    this.shotT = 0;
    this.shotLen = rand(9, 18);
  }

  // Builds the camera pose for the current shot, easing toward it so cuts are never abrupt.
  camera(dt, s) {
    const fl = this.flight;
    const sp = fl.spec;
    const H = sp.chase[0] * s;
    const B = sp.chase[1] * s;
    const sh = this.shot;
    const tau = this.shotT;
    const f = fl.f;
    const n = _n.copy(fl.p).normalize();
    _o.copy(fl.p).addScaledVector(this.nc, -fl.p.dot(this.nc)).normalize(); // away from the orbit centre
    const lf = (x, y, z, r, u, out) => out.set(0, 0, 0).addScaledVector(r, x).addScaledVector(u, y).addScaledVector(f, -z);

    const off = _w;
    let mix = 0.12;
    let fovT = 62;
    let inward = 0;
    switch (sh.kind) {
      case 'chase':
        lf(sh.side * 0.25 * B * Math.sin(tau * 0.35), H * (1 + 0.3 * Math.sin(tau * 0.2)), B * (1 + 0.2 * Math.sin(tau * 0.27)), fl.r, fl.u, off);
        break;
      case 'wing': {
        const th = sh.th0 + sh.rate * tau;
        const rho = B * 0.85;
        lf(Math.sin(th) * rho, H * (0.5 + 0.4 * Math.sin(tau * 0.3)), Math.cos(th) * rho, this.lvlR, this.lvlU, off);
        mix = 0;
        fovT = 58;
        break;
      }
      case 'outward':
        off.copy(_o).multiplyScalar(B * 1.5 * (1 + 0.15 * Math.sin(tau * 0.3))).addScaledVector(n, H * 1.5).addScaledVector(f, -B * 0.5);
        mix = 1;
        fovT = 58;
        break;
      case 'high':
        off.copy(n).multiplyScalar(B * (3 + 0.5 * Math.sin(tau * 0.25))).addScaledVector(f, -B).addScaledVector(_o, sh.side * B * 0.5);
        mix = 0.45;
        fovT = 60;
        break;
      default: // cockpit
        lf(0, sp.eye[0] * s, sp.eye[1] * s, fl.r, fl.u, off);
        mix = -1;
        fovT = 72;
    }

    // two cascaded filters ease in and out, so a cut starts gently instead of snapping
    if (this.first) this.camMid.copy(off);
    else this.camMid.lerp(off, lerpK(dt, 0.9));
    this.camOff.lerp(this.camMid, this.first ? 1 : lerpK(dt, 0.9));

    // where to look, relative to the plane
    const tgt = _c;
    const cAlt = R + this.gC + this.poi.look;
    const ctr = _t.copy(this.nc).multiplyScalar(cAlt);
    if (mix < 0) {
      inward = 120 * s;
      tgt.copy(fl.p).addScaledVector(f, 300 * s).addScaledVector(_o, -inward);
    } else {
      tgt.copy(fl.p).addScaledVector(f, B * 0.3).lerp(ctr, mix);
    }
    tgt.sub(fl.p);
    if (this.first) this.tgtMid.copy(tgt);
    else this.tgtMid.lerp(tgt, lerpK(dt, 1.1));
    this.tgtOff.lerp(this.tgtMid, this.first ? 1 : lerpK(dt, 1.1));

    this.camPos.copy(fl.p).add(this.camOff);
    // keep the camera out of the ground
    const cg = this.cb.ground(_up.copy(this.camPos).normalize());
    if (cg != null) {
      const need = Math.max(0, cg + 25 - (this.camPos.length() - R));
      this.camLift += (need - this.camLift) * lerpK(dt, need > this.camLift ? 0.25 : 2);
    }
    this.camPos.addScaledVector(n, this.camLift);

    _v.copy(fl.p).add(this.tgtOff).sub(this.camPos);
    if (_v.lengthSq() < 1) _v.copy(f);
    _up.copy(n).multiplyScalar(0.7).addScaledVector(fl.u, 0.3);
    _m.lookAt(_zero, _v, _up);
    this.camQuat.setFromRotationMatrix(_m);
    this.fov += (fovT - this.fov) * lerpK(dt, 1.2);
    this.planeVisible = this.camOff.length() > 0.25 * B;
    this.first = false;
  }
}
