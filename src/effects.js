import * as THREE from 'three';
import { R } from './geo.js';
import { boxGeometry } from './plane.js';

// Crash and landing effects: voxel wreckage that tumbles and skids across the terrain, an additive fireball, rolling
// smoke, water spray and tyre puffs. Everything lives in world (planet-centred) coordinates and is placed relative to
// the camera when drawn, like the rest of the scene.

const rnd = (a, b) => a + Math.random() * (b - a);
const MAX_PARTICLES = 150;

function puffTexture(fire) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const paint = (x, y, r, stops) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  };
  if (fire) {
    paint(32, 32, 32, [
      [0, 'rgba(255,250,225,1)'],
      [0.22, 'rgba(255,200,95,0.92)'],
      [0.55, 'rgba(255,100,24,0.45)'],
      [1, 'rgba(130,24,0,0)'],
    ]);
  } else {
    // lumpy puff: a few overlapping soft discs
    for (const [x, y, r, a] of [[32, 32, 30, 0.7], [24, 28, 18, 0.45], [40, 36, 17, 0.45], [34, 22, 15, 0.35]]) {
      paint(x, y, r, [
        [0, `rgba(255,255,255,${a})`],
        [0.6, `rgba(255,255,255,${a * 0.5})`],
        [1, 'rgba(255,255,255,0)'],
      ]);
    }
  }
  return new THREE.CanvasTexture(c);
}

const PALETTE = {
  white: [238, 240, 244],
  blue: [28, 64, 138],
  red: [205, 45, 45],
  dark: [44, 46, 52],
  metal: [140, 145, 155],
  char: [28, 26, 26],
  glass: [66, 128, 196],
};
// [colour, size range x, y, z]: rough pieces of a light aircraft
const PIECES = [
  ['white', [2.0, 3.6], [0.12, 0.2], [0.8, 1.4]], // wing panel
  ['white', [1.2, 2.2], [0.12, 0.2], [0.5, 0.9]], // stabiliser
  ['blue', [0.8, 1.4], [0.5, 0.9], [1.2, 2.2]], // fuselage chunk
  ['white', [0.8, 1.4], [0.6, 1.0], [1.0, 1.8]],
  ['red', [0.4, 0.8], [0.4, 0.8], [0.8, 1.4]],
  ['dark', [0.5, 0.7], [0.5, 0.7], [0.25, 0.35]], // wheel
  ['metal', [0.1, 0.16], [0.1, 0.16], [1.4, 2.4]], // strut
  ['char', [0.4, 0.9], [0.3, 0.6], [0.4, 0.9]],
  ['glass', [0.6, 1.0], [0.1, 0.16], [0.6, 1.0]],
  ['metal', [0.5, 0.9], [0.5, 0.9], [0.5, 0.9]], // engine block
];

const DIVER_PIECES = [
  ['red', [0.15, 0.3], [0.15, 0.3], [0.2, 0.4]],
  ['dark', [0.1, 0.25], [0.1, 0.25], [0.2, 0.4]],
  ['white', [0.3, 0.6], [0.02, 0.05], [0.3, 0.6]], // canopy scraps
  ['red', [0.3, 0.6], [0.02, 0.05], [0.3, 0.6]],
];

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Effects {
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    this.geo = new THREE.Group();
    this.geo.frustumCulled = false;
    scene.add(this.geo);
    this.tex = { fire: puffTexture(true), smoke: puffTexture(false) };
    this.sprites = [];
    this.parts = []; // live particles
    this.debris = [];
    this.free = [];
    this.up = new THREE.Vector3(0, 1, 0);
    this.site = new THREE.Vector3();
    this.siteVel = new THREE.Vector3();
    this.burn = 0; // seconds of fire left
    this.smokeT = 0;
    this.water = false;
    this.scale = 1;
    this.light = 1;
    this.geoCache = {};
    this.active = false;
  }

  get busy() {
    return this.active;
  }

  clear() {
    for (const d of this.debris) this.geo.remove(d.mesh);
    this.debris.length = 0;
    for (const p of this.parts) {
      p.s.visible = false;
      this.free.push(p.s);
    }
    this.parts.length = 0;
    this.burn = 0;
    this.active = false;
  }

  sprite(fire) {
    let s = this.free.pop();
    if (!s) {
      if (this.sprites.length >= MAX_PARTICLES) return null;
      s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
      s.frustumCulled = false;
      this.sprites.push(s);
      this.geo.add(s);
    }
    const m = s.material;
    m.map = fire ? this.tex.fire : this.tex.smoke;
    m.blending = fire ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.needsUpdate = true;
    s.visible = true;
    return s;
  }

  emit(kind, pos, vel, size, grow, life, tint, spin = 0) {
    const s = this.sprite(kind === 'fire');
    if (!s) return;
    s.material.rotation = rnd(0, 6.28);
    this.parts.push({
      s,
      kind,
      p: pos.clone(),
      v: vel.clone(),
      size,
      grow,
      life,
      age: 0,
      tint,
      spin: spin || rnd(-1, 1),
    });
  }

  // Tyre smoke on touchdown, scaled by how hard the wheels hit.
  puff(pos, up, vel, amount, scale = 1) {
    const n = Math.min(6, 1 + Math.floor(amount * 0.8));
    for (let i = 0; i < n; i++) {
      _v.copy(vel).multiplyScalar(0.25);
      _v.addScaledVector(up, rnd(0.3, 1.4) * scale);
      _w.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(1.2 * scale);
      _v.add(_w);
      this.emit('smoke', pos, _v, rnd(0.8, 1.6) * scale, rnd(1.5, 3) * scale, rnd(1.2, 2.2), [0.85, 0.85, 0.85]);
    }
    this.active = this.active || this.parts.length > 0;
  }

  explode(pos, up, vel, { water = false, scale = 1, speed = 60, style = 'plane' } = {}) {
    this.clear();
    this.site.copy(pos);
    this.up.copy(up);
    this.siteVel.copy(vel);
    this.water = water;
    this.scale = scale;
    this.active = true;
    const sc = scale;
    const diver = style === 'diver';
    const energy = diver ? 0.5 : Math.min(1.6, 0.6 + speed / 90);
    const pieces = diver ? DIVER_PIECES : PIECES;

    // wreckage
    const count = diver ? 10 : Math.round(26 * (0.7 + energy * 0.4));
    for (let i = 0; i < count; i++) {
      const [colName, sx, sy, sz] = pieces[Math.floor(Math.random() * pieces.length)];
      const key = !diver && Math.random() < 0.22 ? 'char' : colName;
      const g = (this.geoCache[key] ??= boxGeometry([-0.5, 0.5, -0.5, 0.5, -0.5, 0.5, PALETTE[key]]));
      const mesh = new THREE.Mesh(g, this.material);
      mesh.frustumCulled = false;
      mesh.scale.set(rnd(...sx) * sc, rnd(...sy) * sc, rnd(...sz) * sc);
      mesh.quaternion.random();
      this.geo.add(mesh);
      const burst = rnd(4, 26) * energy * sc ** 0.5;
      const v = new THREE.Vector3(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(burst);
      v.addScaledVector(up, rnd(2, 14) * energy);
      v.addScaledVector(vel, rnd(0.1, 0.5));
      this.debris.push({
        mesh,
        p: pos.clone().addScaledVector(up, rnd(0.2, 1.5) * sc),
        v,
        w: new THREE.Vector3(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)),
        rest: false,
        half: Math.min(mesh.scale.x, mesh.scale.y, mesh.scale.z) * 0.5,
        life: rnd(14, 24),
      });
    }

    if (water) {
      for (let i = 0; i < 44; i++) {
        _v.set(rnd(-1, 1), 0, rnd(-1, 1)).normalize().multiplyScalar(rnd(2, 12) * sc);
        _v.addScaledVector(up, rnd(10, 34) * energy);
        const a = rnd(0.85, 1);
        this.emit('spray', pos, _v, rnd(1.4, 3.2) * sc, rnd(0.6, 1.4) * sc, rnd(1.8, 3.2), [a * 0.85, a * 0.93, a]);
      }
      this.burn = 0;
      this.smokeT = 2.5;
    } else if (diver) {
      for (let i = 0; i < 18; i++) {
        _v.set(rnd(-1, 1), rnd(0, 0.5), rnd(-1, 1)).normalize().multiplyScalar(rnd(1, 5));
        _v.addScaledVector(up, rnd(1, 4));
        this.emit('smoke', pos, _v, rnd(1.2, 2.4), rnd(2, 4), rnd(1.5, 3), [0.55, 0.5, 0.42]);
      }
      this.burn = 0;
      this.smokeT = 0;
    } else {
      // flash
      this.emit('fire', _a.copy(pos).addScaledVector(up, 1.5 * sc), _b.set(0, 0, 0), 14 * sc * energy, 22 * sc, 0.45, [1, 0.9, 0.7], 0.2);
      for (let i = 0; i < 34; i++) {
        _v.set(rnd(-1, 1), rnd(-0.1, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(2, 15) * energy * sc ** 0.5);
        _v.addScaledVector(up, rnd(2, 9));
        const start = _a.copy(pos).addScaledVector(up, rnd(0.5, 2) * sc);
        this.emit('fire', start, _v, rnd(4, 9) * sc, rnd(3, 8) * sc, rnd(0.6, 1.5), [1, 1, 1]);
      }
      for (let i = 0; i < 16; i++) {
        _v.set(rnd(-1, 1), rnd(0, 0.6), rnd(-1, 1)).normalize().multiplyScalar(rnd(3, 12) * sc ** 0.5);
        _v.addScaledVector(up, rnd(4, 14));
        this.emit('smoke', pos, _v, rnd(5, 9) * sc, rnd(5, 9) * sc, rnd(4, 8), [0.12, 0.11, 0.1]);
      }
      this.burn = 9;
      this.smokeT = 16;
    }
  }

  // groundH(worldPos) -> terrain height above sea level at that spot; camPos is the render origin.
  update(dt, camPos, groundH, light = 1) {
    if (!this.active) return;
    this.light = light;
    const g = 9.8;
    const sc = this.scale;
    const up = this.up;

    // continuous fire and smoke from the wreck
    if (!this.water && this.burn > 0) {
      this.burn -= dt;
      const k = Math.min(1, this.burn / 4);
      if (Math.random() < dt * 22 * k) {
        _a.copy(this.site).addScaledVector(up, rnd(0.3, 2.2) * sc);
        _a.x += rnd(-2.5, 2.5) * sc;
        _a.z += rnd(-2.5, 2.5) * sc;
        _v.set(rnd(-0.8, 0.8), 0, rnd(-0.8, 0.8)).addScaledVector(up, rnd(2.5, 5) * sc ** 0.5);
        this.emit('fire', _a, _v, rnd(2.5, 5) * sc, rnd(1.5, 3) * sc, rnd(0.5, 1.0), [1, 1, 1]);
      }
    }
    if (this.smokeT > 0) {
      this.smokeT -= dt;
      const k = Math.min(1, this.smokeT / 8);
      if (Math.random() < dt * (this.water ? 10 : 14) * k) {
        _a.copy(this.site).addScaledVector(up, rnd(0.5, 2) * sc);
        _v.set(rnd(-1, 1), 0, rnd(-1, 1)).multiplyScalar(0.8).addScaledVector(up, rnd(3, 6));
        if (this.water) this.emit('smoke', _a, _v, rnd(2, 4) * sc, rnd(3, 5) * sc, rnd(2, 3.5), [0.9, 0.95, 1]);
        else this.emit('smoke', _a, _v, rnd(3, 5) * sc, rnd(4, 7) * sc, rnd(5, 9), [0.1, 0.09, 0.09]);
      }
    }

    // particles
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.s.visible = false;
        this.free.push(p.s);
        this.parts.splice(i, 1);
        continue;
      }
      const t = p.age / p.life;
      if (p.kind === 'spray') {
        p.v.addScaledVector(up, -g * 0.8 * dt);
        p.v.multiplyScalar(Math.exp(-0.35 * dt));
      } else if (p.kind === 'fire') {
        p.v.multiplyScalar(Math.exp(-1.6 * dt));
        p.v.addScaledVector(up, 6 * dt); // hot gas rises
      } else {
        p.v.multiplyScalar(Math.exp(-0.5 * dt));
        p.v.addScaledVector(up, 1.8 * dt);
        p.v.x += 0.4 * dt; // light breeze
      }
      p.p.addScaledVector(p.v, dt);
      const s = p.s;
      s.position.copy(p.p).sub(camPos);
      const size = p.size + p.grow * Math.sqrt(t) * (p.kind === 'fire' ? 1 : 1.4);
      s.scale.set(size, size, 1);
      s.material.rotation += p.spin * dt;
      const m = s.material;
      if (p.kind === 'fire') {
        const f = Math.pow(1 - t, 1.3);
        m.color.setRGB(f * p.tint[0], f * (0.55 + 0.45 * (1 - t)) * p.tint[1], f * (0.3 + 0.7 * (1 - t) * (1 - t)) * p.tint[2]);
        m.opacity = 1;
      } else {
        const fade = Math.min(1, p.age * 5) * Math.pow(1 - t, 1.2);
        const lit = 0.1 + 0.9 * this.light;
        m.color.setRGB(p.tint[0] * lit, p.tint[1] * lit, p.tint[2] * lit);
        m.opacity = (p.kind === 'spray' ? 0.75 : 0.62) * fade;
      }
    }

    // wreckage
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.geo.remove(d.mesh);
        this.debris.splice(i, 1);
        continue;
      }
      if (!d.rest) {
        d.v.addScaledVector(_w.copy(d.p).normalize(), -g * dt);
        d.v.multiplyScalar(Math.exp(-0.05 * dt));
        d.p.addScaledVector(d.v, dt);
        _q.setFromAxisAngle(_a.copy(d.w).normalize(), d.w.length() * dt);
        d.mesh.quaternion.premultiply(_q);
        const gh = groundH(d.p);
        const alt = d.p.length() - R;
        const floor = (gh ?? 0) + d.half;
        if (this.water && gh != null && alt < gh + d.half * 0.5) {
          d.rest = true; // floats on the surface
          d.p.normalize().multiplyScalar(R + gh + 0.1);
        } else if (alt < floor) {
          const n = _w.copy(d.p).normalize();
          d.p.copy(n).multiplyScalar(R + floor);
          const vn = d.v.dot(n);
          if (vn < 0) {
            d.v.addScaledVector(n, -vn * 1.3); // bounce
            d.v.multiplyScalar(0.72);
            d.w.multiplyScalar(0.7);
          }
          if (d.v.lengthSq() < 4) {
            d.rest = true;
          }
        }
      }
      d.mesh.position.copy(d.p).sub(camPos);
    }

    const alive = this.parts.length > 0 || this.debris.length > 0 || this.burn > 0 || this.smokeT > 0;
    if (!alive) this.active = false;
  }
}
