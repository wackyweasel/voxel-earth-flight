import * as THREE from 'three';
import { R, DEG, llToDir, dirToLat, dirToLon } from './geo.js';
import { AIRCRAFT } from './aircraft.js';

const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _vh = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _hor = new THREE.Vector3();
const _fh = new THREE.Vector3();
const _rh = new THREE.Vector3();
const _p0 = new THREE.Vector3();

function rotateAbout(v, axis, angle) {
  v.applyAxisAngle(axis, angle);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Aircraft constants live in aircraft.js, in "scale 1" units: metres and seconds. At altitude the world scales the
// plane up (see main.js), so the dynamics run on a normalised velocity that is multiplied by a speed factor
// when the position is advanced.
const G0 = 9.81;

// lift coefficient with a soft stall on both sides
function liftCoef(s, a) {
  if (a > s.stall) {
    const x = sstep(0, 0.22, a - s.stall);
    return (s.CL0 + s.CLA * s.stall) * (1 - 0.55 * x);
  }
  if (a < -s.stallNeg) {
    const x = sstep(0, 0.22, -s.stallNeg - a);
    return (s.CL0 - s.CLA * s.stallNeg) * (1 - 0.55 * x);
  }
  return s.CL0 + s.CLA * a;
}

// Flight in an Earth-centred frame. Position, orientation and velocity are kept in double precision; the frame
// follows the planet's curvature by parallel transport. The plane has real lift, drag, thrust, gravity and a stall,
// with rate-limited control surfaces. With `assist` on, an auto-trim and wing levelling keep it easy to fly.
export class Flight {
  constructor() {
    this.p = new THREE.Vector3();
    this.f = new THREE.Vector3(1, 0, 0);
    this.u = new THREE.Vector3(0, 1, 0);
    this.r = new THREE.Vector3(0, 0, 1);
    this.vn = new THREE.Vector3(); // normalised velocity (scale-1 m/s)
    this.sf = 1; // speed factor of the last update: real velocity = vn * sf
    this.spec = AIRCRAFT.light;
    this.throttle = this.spec.trimThrottle; // 0..1, the pilot's lever
    this.eng = this.throttle; // engine power, which spools toward the lever
    this.ab = 0; // afterburner 0..1
    this.assist = true;
    this.invertPitch = false;
    this.ele = 0; // control surface positions, -1..1
    this.ail = 0;
    this.rud = 0;
    this.wp = 0; // body rates, rad/s
    this.wq = 0;
    this.wr = 0;
    this.speed = 0; // real speed, m/s
    this.vsi = 0; // real vertical speed, m/s
    this.alpha = 0;
    this.gHold = 0; // flight-path angle the assist holds when the stick is released
    this.stalled = false;
    this.crashed = false; // hard landing in the last moment
    this.crashSevere = false; // destroyed; main respawns the plane
    this.grounded = false;
    this.landed = false;
    this.crashTimer = 0;
    this.spoil = 1; // lift multiplier on the ground: ground spoilers keep the wheels down unless the pilot wants to take off
    this.age = 0; // seconds since spawn
    this.impact = null; // {kind, speed, vsink, pos} of the crash that destroyed the plane
    this.touchEvent = null; // {vsink, speed} on touchdown; consumed by main for tyre smoke
  }

  setAircraft(id) {
    this.spec = AIRCRAFT[id] ?? AIRCRAFT.light;
  }

  spawn(lat, lon, alt, headingDeg = 0, pitchDeg = 0, speed = this.spec.trimSpeed) {
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
    this.vn.copy(this.f).multiplyScalar(speed);
    this.ele = this.ail = this.rud = this.wp = this.wq = this.wr = 0;
    this.grounded = false;
    this.landed = false;
    this.crashSevere = false;
    this.impact = null;
    this.touchEvent = null;
    this.crashTimer = 0;
    this.stalled = false;
    this.gHold = 0;
    this.spoil = 1;
    this.age = 0;
    this.speed = speed;
    this.throttle = this.eng = this.spec.trimThrottle;
    this.ab = 0;
  }

  stop() {
    this.vn.set(0, 0, 0);
    this.speed = 0;
    this.wp = this.wq = this.wr = 0;
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

  // Real velocity vector in the Earth-centred frame.
  velocity(out) {
    return out.copy(this.vn).multiplyScalar(this.sf);
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
    const east = _n0.set(-Math.sin(lo), 0, -Math.cos(lo));
    const north = _n1.crossVectors(n, east);
    const h = Math.atan2(this.f.dot(east), this.f.dot(north)) / DEG;
    return (h + 360) % 360;
  }

  get pitchDeg() {
    return Math.asin(clamp(this.f.dot(_tmp.copy(this.p).normalize()), -1, 1)) / DEG;
  }

  get bankDeg() {
    const n = _tmp.copy(this.p).normalize();
    return Math.atan2(-this.r.dot(n), this.u.dot(n)) / DEG;
  }

  // Destroys the plane: freezes it and records where and how hard it hit.
  hit(kind, speed, vsink, n) {
    this.crashSevere = true;
    this.crashTimer = 0;
    this.impact = { kind, speed, vsink, pos: this.p.clone(), normal: n.clone(), vel: this.vn.clone().multiplyScalar(this.sf) };
    this.vn.set(0, 0, 0);
    this.grounded = false;
  }

  // input: {pitch, roll, yaw, brake}; pitch, roll, yaw in -1..1 (pitch>0 = nose up, roll>0 = right wing down, yaw>0 = nose right)
  update(dt, input, scale, groundHeight, gearDrop = 2.2) {
    const sf = Math.pow(scale, 0.75);
    this.sf = sf;
    this.age += dt;
    if (this.crashSevere) return;
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / steps;
    for (let i = 0; i < steps && !this.crashSevere; i++) this.step(h, input, scale, sf, groundHeight, gearDrop);
    this.crashTimer = Math.max(0, this.crashTimer - dt);
    this.crashed = this.crashTimer > 0;
    this.speed = this.vn.length() * sf;
    this.vsi = this.vn.dot(_tmp.copy(this.p).normalize()) * sf;
    this.landed = this.grounded && this.speed < 2.5 && this.throttle < 0.1;
  }

  step(h, input, scale, sf, groundHeight, gearDrop) {
    const { f, u, r, vn, spec: S } = this;
    const n0 = _n0.copy(this.p).normalize();
    const r0 = this.p.length();
    const alt = r0 - R;
    const grounded = this.grounded;
    const p0 = _p0.copy(this.p);
    const g = G0 * (1 - sstep(25000, 100000, alt)); // no gravity out in space, so the orbit view can drift
    const pitchIn = input.pitch * (this.invertPitch ? -1 : 1);
    const A_STALL = S.stall;
    const A_STALL_NEG = S.stallNeg;
    const CL0 = S.CL0;
    const CLA = S.CLA;
    const K_LIFT = S.K;

    // --- attitude ---------------------------------------------------------------------------------
    let V = vn.length();
    const vf = vn.dot(f);
    const flying = V > 1 && vf > 0;
    const alpha = flying ? Math.atan2(-vn.dot(u), vf) : 0;
    const beta = flying ? Math.atan2(vn.dot(r), vf) : 0;
    const bank = Math.atan2(-r.dot(n0), u.dot(n0));
    const gamma = V > 1 ? Math.asin(clamp(vn.dot(n0) / V, -1, 1)) : 0;
    const eff = 0.2 + 0.8 * sstep(S.authority[0], S.authority[1], V); // control authority grows with airspeed

    const rate = (cur, tgt, k) => cur + clamp(tgt - cur, -k * h, k * h);
    this.ele = rate(this.ele, pitchIn, S.surfaceRate[0]);
    this.ail = rate(this.ail, input.roll, S.surfaceRate[1]);
    this.rud = rate(this.rud, input.yaw, S.surfaceRate[2]);
    this.eng += (this.throttle - this.eng) * (1 - Math.exp(-S.spool * h));
    this.ab = S.ab ? sstep(0.82, 0.96, this.eng) : 0;

    // The elevator commands an angle of attack around the trim point; the nose weathercocks toward it.
    let aTrim;
    let aMax = A_STALL * 0.92;
    let aMin = -0.2;
    if (grounded) aTrim = this.spoil < 0.6 ? -0.02 : 0.05; // after touchdown the nose settles onto the wheels
    else if (this.assist) {
      // trim for the lift that balances weight in the current bank, and steer the climb angle back to the held one
      if (Math.abs(pitchIn) > 0.05) this.gHold = clamp(gamma, -0.5, 0.35);
      else if (Math.abs(this.gHold) < 0.05) this.gHold = 0; // level-flight detent
      else if (this.gHold > 0 && V < S.noseOver[0] + 10) this.gHold = Math.max(0, this.gHold - 0.12 * h); // a slow climb relaxes back to level
      const lReq = (g * Math.cos(gamma)) / Math.max(0.3, Math.cos(bank)) - V * S.holdGain * (gamma - this.gHold) * (Math.abs(pitchIn) > 0.05 ? 0 : 1);
      const q = K_LIFT * Math.max(V * V, 400);
      const gEff = Math.max(g, 3);
      aTrim = clamp((lReq / q - CL0) / CLA, -0.12, 0.8 * A_STALL);
      // g limits and stall protection: the stick can't over-stress or stall the plane
      aMax = Math.min(A_STALL * (0.4 + 0.52 * sstep(S.assistV[0], S.assistV[1], V)), (S.gUp * gEff / q - CL0) / CLA);
      aMin = clamp((-S.gDown * gEff / q - CL0) / CLA, -S.aMinLimit, -0.02);
    } else aTrim = 0;
    let aTarget = aTrim + (this.ele >= 0 ? this.ele * S.aUp : this.ele * S.aDown);
    if (this.assist && !grounded) aTarget = clamp(aTarget, Math.min(aMin, aTrim), Math.max(aMax, Math.min(aTrim, A_STALL * 0.5)));
    let qCmd = flying ? S.pitchGain * (aTarget - alpha) * eff : grounded ? 0 : -1.2 * f.dot(n0) - 0.3; // no airflow: the nose falls
    const stalled = flying && !grounded && alpha > A_STALL;
    // assist: nose over when climbing too steeply while running out of speed
    if (this.assist && !grounded && flying) {
      qCmd -= clamp((S.noseOver[0] - V) / S.noseOver[1], 0, 1) * Math.max(0, f.dot(n0) - 0.2) * 2.5;
      // feed-forward: in a banked turn the nose has to keep rotating up to hold the angle of attack
      const bc = clamp(bank, -1.1, 1.1);
      qCmd += ((g * Math.tan(bc) * Math.sin(bc)) / Math.max(V, S.assistV[0])) * eff;
    }
    if (alpha > A_STALL) qCmd -= (alpha - A_STALL) * 6;
    if (alpha < -A_STALL_NEG) qCmd += (-A_STALL_NEG - alpha) * 6;

    let pCmd;
    let rCmd;
    if (grounded) {
      pCmd = -bank * 6;
      const steer = clamp(input.yaw + input.roll, -1, 1);
      rCmd = (steer * S.steer * Math.min(1, V / 5)) / (1 + V / S.steerFade);
    } else {
      pCmd = this.ail * (this.assist ? S.rollAssist : S.rollRate) * eff;
      if (this.assist && Math.abs(f.dot(n0)) < 0.85) {
        // the stick commands a bank angle, so holding it gives a steady turn and releasing it levels the wings
        const rMax = S.rollAssist * 1.12;
        pCmd = clamp((this.ail * S.bankLimit - bank) * S.rollAssist * 1.4, -rMax, rMax) * eff;
      }
      if (stalled || (flying && alpha > 0.9 * A_STALL)) pCmd += (Math.random() - 0.5) * 2.2; // buffet
      rCmd = this.rud * S.rudder * eff + beta * 2.4 * eff;
    }
    this.wq += (qCmd - this.wq) * (1 - Math.exp(-S.response[0] * h));
    this.wp += (pCmd - this.wp) * (1 - Math.exp(-S.response[1] * h));
    this.wr += (rCmd - this.wr) * (1 - Math.exp(-S.response[2] * h));
    this.pitch(this.wq * h);
    this.roll(this.wp * h);
    this.yaw(this.wr * h);
    f.normalize();
    r.crossVectors(f, u).normalize();
    u.crossVectors(r, f).normalize();
    this.alpha = alpha;
    this.stalled = stalled;

    // --- forces -------------------------------------------------------------------------------------
    V = vn.length();
    const a = _acc.set(0, 0, 0);
    a.addScaledVector(f, S.thrust * this.eng * this.eng * (1 + S.ab * this.ab) * (1 - S.thrustFade * Math.min(1, V / S.fadeV)));
    if (V > 1) {
      const vhat = _vh.copy(vn).divideScalar(V);
      const alpha2 = Math.atan2(-vn.dot(u), Math.max(vn.dot(f), 1e-3));
      const cl = liftCoef(S, alpha2);
      const ld = _ld.copy(u).addScaledVector(vhat, -u.dot(vhat));
      const ll = ld.length();
      if (ll > 1e-3) a.addScaledVector(ld, (K_LIFT * V * V * cl * this.spoil) / ll);
      const sa = Math.sin(alpha2);
      const sb = vn.dot(r) / V;
      let k = S.cd0 + S.cdi * cl * cl + S.cFlat * (sa * sa + sb * sb);
      if (input.brake && !grounded) k += S.cBrake;
      a.addScaledVector(vhat, -k * V * V);
      a.addScaledVector(r, -S.kSide * V * vn.dot(r));
    }
    a.addScaledVector(n0, -g);
    vn.addScaledVector(a, h);
    if (vn.length() > S.maxV) vn.setLength(S.maxV);

    // --- move: tangential part along the surface, vertical part changes the radius ------------------
    const vUp = vn.dot(n0);
    const hor = _hor.copy(vn).addScaledVector(n0, -vUp);
    this.p.addScaledVector(hor, sf * h);
    this.p.normalize().multiplyScalar(r0 + vUp * sf * h);

    // parallel-transport the frame and the velocity along the curved surface
    const n1 = _n1.copy(this.p).normalize();
    _axis.crossVectors(n0, n1);
    const s = _axis.length();
    if (s > 1e-12) {
      _axis.divideScalar(s);
      const ang = Math.atan2(s, n0.dot(n1));
      rotateAbout(f, _axis, ang);
      rotateAbout(u, _axis, ang);
      rotateAbout(vn, _axis, ang);
    }
    f.normalize();
    r.crossVectors(f, u).normalize();
    u.crossVectors(r, f).normalize();

    // --- ground contact -----------------------------------------------------------------------------
    const floor = (groundHeight ?? 0) + gearDrop * scale;
    const alt1 = this.p.length() - R;
    const vu1 = vn.dot(n1);
    const speedNow = vn.length() * sf;
    let touchedDown = false;
    if (alt1 < floor) {
      const pen = floor - alt1;
      // the floor can only jump by metres in one 12 ms step when the nose meets a wall or a building flank
      const wallLimit = (grounded ? 6 : 3) * scale;
      if (pen > wallLimit && this.age > 1) {
        if (speedNow > 18) {
          this.hit('wall', speedNow, 0, n1);
          return;
        }
        // slow taxi into a wall: stop instead of climbing it
        this.p.copy(p0);
        vn.set(0, 0, 0);
        return;
      }
      this.p.normalize().multiplyScalar(R + floor);
      if (vu1 < 0) {
        const vsink = -vu1 * sf;
        if (!grounded) touchedDown = true;
        if (vsink > S.hardSink) this.crashTimer = 1.5;
        const fh = _fh.copy(f).addScaledVector(n1, -f.dot(n1)).normalize();
        const side = Math.abs(vn.dot(_rh.crossVectors(fh, n1).normalize())) * sf;
        const badAttitude = speedNow > 28 && (Math.abs(this.bankDeg) > 40 || f.dot(n1) < -0.3 || side > 12);
        if (!grounded && (vsink > S.crashSink || badAttitude)) {
          this.hit('ground', speedNow, vsink, n1);
          return;
        }
        if (touchedDown) {
          this.touchEvent = { vsink, speed: speedNow };
          // ground spoilers: no lift after touchdown, so the plane stays planted unless the pilot asks to go around
          if (pitchIn < 0.2 && this.throttle < 0.75) this.spoil = 0.3;
        }
        vn.addScaledVector(n1, -vu1);
      }
    } else if (grounded && vu1 <= 0.005 && alt1 <= floor + 0.3 * scale) {
      // follow the ground down gentle slopes and across tile changes instead of hopping off it
      this.p.normalize().multiplyScalar(R + floor);
      if (vu1 < 0) vn.addScaledVector(n1, -vu1);
    }
    const touching = this.p.length() - R <= floor + 0.05;
    // any net upward acceleration (lift beating weight) lets the wheels leave the ground; a fast sink rate must
    // reach the floor first so that the impact is judged by the clamp above
    this.grounded = touching && vu1 <= 0.005 && (touchedDown || grounded || vu1 * sf > -2.5);
    if (this.grounded && !grounded && !touchedDown) {
      // gentle arrival inside the contact band, without ever penetrating the floor
      touchedDown = true;
      this.touchEvent = { vsink: Math.max(0, -vu1 * sf), speed: speedNow };
      if (pitchIn < 0.2 && this.throttle < 0.75) this.spoil = 0.3;
    }
    if (!touching) this.spoil = 1;
    else if (this.spoil < 1 && (pitchIn > 0.2 || this.throttle > 0.75)) this.spoil = Math.min(1, this.spoil + 2 * h);
    if (this.grounded) {
      // tyres: grip sideways, rolling resistance and brakes along the heading
      const fh = _fh.copy(f).addScaledVector(n1, -f.dot(n1)).normalize();
      const rh = _rh.crossVectors(fh, n1).normalize();
      let vF = vn.dot(fh);
      let vS = vn.dot(rh);
      vS *= Math.exp(-9 * h);
      const dv = (S.rolling + (input.brake ? S.brake : 0)) * G0 * h;
      vF = vF > 0 ? Math.max(0, vF - dv) : Math.min(0, vF + dv);
      vn.copy(fh).multiplyScalar(vF).addScaledVector(rh, vS);
      if (vn.lengthSq() < 0.09 && this.throttle < 0.02) vn.set(0, 0, 0);
      // nose between the ground and a tail strike
      const lift = f.dot(n1);
      const want = clamp(lift, 0, S.rotate);
      if (want !== lift) {
        f.addScaledVector(n1, want - lift).normalize();
        r.crossVectors(f, u).normalize();
        u.crossVectors(r, f).normalize();
        this.wq = 0;
      }
    }
  }

  // Parks the plane on the ground at direction/heading taken from a walker or spawn point.
  park(pos, fwd, up) {
    this.p.copy(pos);
    this.u.copy(up).normalize();
    this.f.copy(fwd).addScaledVector(this.u, -fwd.dot(this.u)).normalize();
    this.r.crossVectors(this.f, this.u).normalize();
    this.stop();
    this.throttle = 0;
    this.eng = 0;
    this.grounded = true;
    this.landed = true;
    this.crashSevere = false;
    this.spoil = 1;
  }

  basisQuaternion(out = new THREE.Quaternion()) {
    const m = new THREE.Matrix4().makeBasis(this.r, this.u, _tmp.copy(this.f).negate());
    return out.setFromRotationMatrix(m);
  }
}
