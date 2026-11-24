import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxGeometry, voxelize, createPlane } from './plane.js';

// Voxel airliner and fast jet, sampled from analytic shapes like the light plane in plane.js.
// Units are metres: +X right, +Y up, -Z forward. The body mesh is static; the landing gear, engine fans and
// afterburner are separate meshes that animate in userData.update(dt, engine, ctx).

const WHITE = [240, 242, 246];
const UNDER = [188, 194, 205];
const NAVY = [22, 48, 110];
const ORANGE = [238, 128, 30];
const GLASS_DARK = [30, 56, 96];
const DARK = [40, 42, 48];
const METAL = [138, 143, 153];
const BLACK = [24, 24, 28];

const sq = (v) => v * v;
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// Wing-like slab: returns the chordwise parameter u (0 leading edge, 1 trailing edge) or -1 outside the slab.
function slab(z, zLE, zTE, y, yc, thick, minTh) {
  const u = (z - zLE) / (zTE - zLE);
  if (u < 0 || u > 1) return -1;
  const th = Math.max(minTh, thick * 2.6 * Math.sqrt(u) * (1 - u));
  return Math.abs(y - yc) < th / 2 ? u : -1;
}

// Rounds a wing or tail tip: shrinks the chord to zero over the last (1 - t0) of the span.
function roundTip(t, t0, zLE, zTE) {
  if (t <= t0) return [zLE, zTE];
  const k = Math.sqrt(Math.max(0, 1 - sq((t - t0) / (1 - t0))));
  const mid = (zLE + zTE) / 2;
  const half = ((zTE - zLE) / 2) * k;
  return [mid - half, mid + half];
}

// A wheel as an octagon: a square box and the same box turned 45° about the axle (+X).
function wheelGeometry(cx, cy, cz, r, w, tyre, hub) {
  const parts = [];
  for (const rot of [0, Math.PI / 4]) {
    const m = new THREE.Matrix4().makeTranslation(cx, cy, cz).multiply(new THREE.Matrix4().makeRotationX(rot));
    parts.push(boxGeometry([-w / 2, w / 2, -r, r, -r, r, tyre], m));
  }
  parts.push(boxGeometry([cx - w / 2 - 0.02, cx + w / 2 + 0.02, cy - r * 0.45, cy + r * 0.45, cz - r * 0.45, cz + r * 0.45, hub]));
  return parts;
}

function mesh(geom, material) {
  const m = new THREE.Mesh(geom, material);
  m.frustumCulled = false;
  return m;
}

// Eases a retractable gear toward down/up and hides it when fully folded.
function gearAnimator(gear) {
  let k = 1;
  return (dt, down) => {
    k += (down ? 1 : -1) * Math.min(1, dt * 0.9);
    k = Math.min(1, Math.max(0, k));
    const e = k * k * (3 - 2 * k);
    gear.visible = e > 0.02;
    gear.scale.y = Math.max(0.001, e);
  };
}

// ---------------------------------------------------------------------------------------------------
// Airliner: 38 m long, 34 m span, twin underwing turbofans.
// ---------------------------------------------------------------------------------------------------
const AIR_VOX = 0.28;
const AIR_ORIGIN = [-17.6, -3.0, -19.4];
const AIR_DIMS = [126, 45, 139];
const ENGINE_X = 6.4;
const ENGINE_Y = -1.55;
const ENGINE_FACE = -5.3;

function airlinerFuselage(x, y, z) {
  if (z < -19 || z > 19) return null;
  let rad;
  let cy = 0;
  if (z < -14) {
    const t = (z + 14) / 5;
    rad = 1.9 * Math.sqrt(Math.max(0, 1 - t * t));
    cy = -0.12 * t * t;
  } else if (z <= 9) rad = 1.9;
  else {
    const t = (z - 9) / 10;
    rad = 1.9 * (1 - 0.8 * Math.pow(t, 1.4));
    cy = 1.2 * t * t;
  }
  if (rad < 0.1) return null;
  const dx = Math.abs(x) / rad;
  const rel = y - cy;
  if (Math.pow(dx, 2.3) + Math.pow(Math.abs(rel) / rad, 2.3) > 1) return null;
  if (z < -18.2) return DARK;
  if (z > 18.4) return METAL;
  // cockpit windscreen
  if (z < -14.2 && z > -17.8 && rel > 0.4 && rel < 1.0 && dx > 0.25 && Math.abs(x) > 0.1) return GLASS_DARK;
  // passenger windows
  if (z > -13.6 && z < 13.4 && rel > 0.42 && rel < 0.82 && dx > 0.88 && (z + 13.6) % 0.84 < 0.46) return GLASS_DARK;
  // door seams
  if (dx > 0.7 && rel > -1.2 && rel < 1.3 && (Math.abs(z + 13) < 0.1 || Math.abs(z - 10.5) < 0.1)) return shade(WHITE, 0.78);
  // livery: a navy cheat line that widens and sweeps up toward the tail, and a grey belly
  const back = Math.max(0, z - 4);
  if (dx > 0.5 && z > -14.5 && rel > -0.55 - 0.02 * back && rel < -0.12 + 0.075 * back) return NAVY;
  if (dx > 0.5 && z > -14.5 && rel > -0.66 - 0.02 * back && rel < -0.55 - 0.02 * back) return ORANGE;
  if (rel < -rad * 0.62) return UNDER;
  return WHITE;
}

function airlinerWing(x, y, z) {
  const ax = Math.abs(x);
  if (ax < 1.0 || ax > 16.9) return null;
  const t = (ax - 1.0) / 15.9;
  let zLE = -3.6 + 7.4 * t;
  let zTE = zLE + 7.7 - 5.6 * t;
  [zLE, zTE] = roundTip(t, 0.965, zLE, zTE);
  const yc = -1.15 + 1.45 * t;
  const u = slab(z, zLE, zTE, y, yc, 0.55 - 0.33 * t, 0.3);
  if (u < 0) return null;
  if (t > 0.95 && y > yc) return x > 0 ? [40, 200, 90] : [215, 45, 45];
  if (y < yc - 0.02) return UNDER;
  if (u < 0.06) return shade(WHITE, 0.9);
  if (u > 0.7 && u < 0.74 && t > 0.1 && t < 0.78) return shade(WHITE, 0.8);
  if (t > 0.8 && u > 0.7) return shade(WHITE, 0.88);
  return WHITE;
}

function winglet(x, y, z) {
  const ax = Math.abs(x);
  if (y < 0.25 || y > 2.3) return null;
  const h = (y - 0.3) / 2;
  if (Math.abs(ax - (16.55 + 0.3 * h)) > 0.14) return null;
  const zLE = 4.1 + 1.0 * h;
  const zTE = 6.0 + 0.5 * h;
  if (z < zLE || z > zTE) return null;
  return h > 0.85 ? ORANGE : NAVY;
}

function nacelle(x, y, z) {
  const d = Math.hypot(Math.abs(x) - ENGINE_X, y - ENGINE_Y);
  if (z < -6.2 || z > 1.8) return null;
  let r;
  if (z < -5.6) r = 1.1 + 0.02 * (-5.6 - z);
  else if (z < -1.5) r = 1.1;
  else if (z < 0.2) r = 1.1 - 0.25 * ((z + 1.5) / 1.7);
  else r = 0.85 - 0.5 * ((z - 0.2) / 1.6);
  if (d > r) return null;
  if (z < ENGINE_FACE + 0.1 && d < 0.85) return null; // open inlet; the fan spins in it
  if (z < -5.2 && d < 0.9) return METAL; // inlet lip is polished metal
  if (z < -5.2) return d > 1.0 ? METAL : WHITE;
  if (z >= 0.2) return METAL;
  if (d < 0.85 && z < -4.8) return DARK; // fan housing back wall
  if (z < -4.6 && z > -5.0) return NAVY; // ring around the inlet
  return z > -1.5 && d < 0.85 ? shade(WHITE, 0.9) : WHITE;
}

function airlinerStab(x, y, z) {
  const ax = Math.abs(x);
  if (ax > 7.3) return null;
  const t = ax / 7.3;
  let zLE = 12.4 + 3.7 * t;
  let zTE = 17.4 + 0.8 * t;
  [zLE, zTE] = roundTip(t, 0.94, zLE, zTE);
  const u = slab(z, zLE, zTE, y, 0.95 + 0.7 * t, 0.36 - 0.15 * t, 0.3);
  if (u < 0) return null;
  if (t > 0.85) return NAVY;
  return y < 0.95 + 0.7 * t - 0.02 ? UNDER : WHITE;
}

function airlinerFin(x, y, z) {
  if (Math.abs(x) > 0.2 || y < 0.9 || y > 9.3) return null;
  const h = (y - 1.0) / 8.3;
  let zLE = 7.0 + 7.6 * h;
  let zTE = 17.4 + 1.1 * h;
  [zLE, zTE] = roundTip(h, 0.95, zLE, zTE);
  if (z < zLE || z > zTE) return null;
  const u = (z - zLE) / (zTE - zLE);
  if (h > 0.97) return WHITE;
  if (Math.abs(u - (0.25 + 0.4 * h)) < 0.1) return ORANGE;
  if (Math.abs(u - 0.74) < 0.02) return shade(NAVY, 0.7);
  return NAVY;
}

function airlinerColour(x, y, z) {
  return airlinerFuselage(x, y, z) || airlinerWing(x, y, z) || winglet(x, y, z) || nacelle(x, y, z) || airlinerStab(x, y, z) || airlinerFin(x, y, z);
}

function airlinerGear() {
  const parts = [];
  // nose gear
  parts.push(boxGeometry([-0.1, 0.1, -1.55, 0, -15.1, -14.9, METAL]));
  parts.push(...wheelGeometry(-0.33, -1.95, -15.0, 0.45, 0.28, BLACK, METAL));
  parts.push(...wheelGeometry(0.33, -1.95, -15.0, 0.45, 0.28, BLACK, METAL));
  parts.push(boxGeometry([-0.38, 0.38, -1.55, -1.4, -15.1, -14.9, METAL]));
  // main gear: a strut and a pair of wheels under each wing root
  for (const s of [-1, 1]) {
    parts.push(boxGeometry([s * 3.0 - 0.14, s * 3.0 + 0.14, -1.9, 0, 0.9, 1.2, METAL]));
    parts.push(boxGeometry([s * 3.0 - 0.45, s * 3.0 + 0.45, -1.9, -1.75, 0.95, 1.15, METAL]));
    parts.push(...wheelGeometry(s * 3.0 - 0.38, -1.85, 1.05, 0.55, 0.32, BLACK, METAL));
    parts.push(...wheelGeometry(s * 3.0 + 0.38, -1.85, 1.05, 0.55, 0.32, BLACK, METAL));
  }
  return mergeGeometries(parts);
}

function fanGeometry() {
  const parts = [boxGeometry([-0.22, 0.22, -0.22, 0.22, -0.1, 0.1, METAL])];
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Matrix4().makeRotationZ((i / 12) * Math.PI * 2);
    parts.push(boxGeometry([-0.07, 0.07, 0.15, 0.84, -0.05, 0.05, i % 2 ? [190, 194, 202] : [150, 155, 165]], m));
  }
  return mergeGeometries(parts);
}

export function createAirliner(material) {
  const group = new THREE.Group();
  group.add(mesh(voxelize(airlinerColour, AIR_ORIGIN, AIR_DIMS, AIR_VOX), material));
  const gear = mesh(airlinerGear(), material);
  gear.position.y = -1.5;
  group.add(gear);
  const fans = [];
  const fanGeom = fanGeometry();
  for (const s of [-1, 1]) {
    const fan = mesh(fanGeom, material);
    fan.position.set(s * ENGINE_X, ENGINE_Y, ENGINE_FACE);
    fans.push(fan);
    group.add(fan);
  }
  const animateGear = gearAnimator(gear);
  group.userData.update = (dt, eng, ctx) => {
    for (const fan of fans) fan.rotation.z += dt * (4 + eng * 34);
    if (ctx) animateGear(dt, ctx.grounded || ctx.agl < 220 || ctx.speed < 115);
  };
  return group;
}

// ---------------------------------------------------------------------------------------------------
// Fast jet: 16 m long, delta wing, twin canted fins, single afterburning engine.
// ---------------------------------------------------------------------------------------------------
const JET_VOX = 0.15;
const JET_ORIGIN = [-6.0, -1.35, -8.8];
const JET_DIMS = [80, 33, 117];

const JET_TOP = [112, 122, 138];
const JET_SIDE = [130, 139, 152];
const JET_BELLY = [170, 176, 186];
const JET_DARK = [62, 66, 76];
const JET_RED = [200, 48, 44];
const JET_BLUE = [40, 70, 150];
const AMBER = [196, 142, 58];

function jetFuselage(x, y, z) {
  if (z < -8.5 || z > 7.0) return null;
  let hw;
  let hh;
  if (z < -3) {
    const t = (z + 8.5) / 5.5;
    hw = 0.8 * Math.pow(t, 0.8);
    hh = 0.7 * Math.pow(t, 0.8);
  } else if (z < 1) {
    hw = 0.8;
    hh = 0.7;
  } else {
    const t = (z - 1) / 6;
    hw = 0.8 - 0.1 * t;
    hh = 0.7 - 0.06 * t;
  }
  if (hw < 0.05) return null;
  const dx = Math.abs(x) / hw;
  const dy = Math.abs(y) / hh;
  if (Math.pow(dx, 2.4) + Math.pow(dy, 2.4) > 1) return null;
  if (z < -6.6) return JET_DARK; // radome
  if (Math.abs(z - 2.2) < 0.05 || Math.abs(z + 0.3) < 0.05 || Math.abs(z - 4.6) < 0.05) return shade(JET_SIDE, 0.8);
  if (y < -0.3) return JET_BELLY;
  return y > 0.25 ? JET_TOP : JET_SIDE;
}

function jetIntake(x, y, z) {
  if (Math.abs(x) > 0.66 || y > -0.2 || y < -1.2 || z < -3.3 || z > 0.8) return null;
  if (z < -3.0) return JET_DARK;
  if (y > -0.3) return null;
  return y < -1.05 ? shade(JET_BELLY, 0.9) : JET_SIDE;
}

function jetCanopy(x, y, z) {
  if (y < 0.3) return null;
  if (sq(x / 0.52) + sq((y - 0.45) / 0.62) + sq((z + 3.5) / 1.9) > 1) return null;
  if (Math.abs(z + 2.3) < 0.07 || Math.abs(z + 4.6) < 0.05) return JET_TOP;
  return y > 0.85 ? shade(AMBER, 1.15) : AMBER;
}

function jetWing(x, y, z) {
  const ax = Math.abs(x);
  if (ax < 0.5 || ax > 5.5) return null;
  const t = (ax - 0.5) / 5.0;
  let zLE = -3.2 + 6.6 * t;
  let zTE = 5.9 - 0.5 * t;
  [zLE, zTE] = roundTip(t, 0.94, zLE, zTE);
  const yc = -0.16 - 0.06 * t;
  const u = slab(z, zLE, zTE, y, yc, 0.34 - 0.17 * t, 0.17);
  if (u < 0) return null;
  if (y > yc) {
    const d = Math.hypot(ax - 3.1, z - 3.3);
    if (d < 0.18) return JET_RED;
    if (d < 0.36) return WHITE;
    if (d < 0.54) return JET_BLUE;
    if (u > 0.78 && t > 0.2) return shade(JET_TOP, 0.85);
    return JET_TOP;
  }
  return JET_BELLY;
}

// air-to-air missile on each wing tip
function jetMissile(x, y, z) {
  const ax = Math.abs(x);
  if (z < 1.8 || z > 5.6) return null;
  const dxm = ax - 5.65;
  const dym = y + 0.2;
  if (z > 4.7 && ((Math.abs(dxm) < 0.45 && Math.abs(dym) < 0.05) || (Math.abs(dym) < 0.45 && Math.abs(dxm) < 0.05))) return JET_DARK;
  if (Math.hypot(dxm, dym) > 0.17) return null;
  if (z < 2.5) return JET_RED;
  return WHITE;
}

function jetStab(x, y, z) {
  const ax = Math.abs(x);
  if (ax < 0.6 || ax > 3.2) return null;
  const t = (ax - 0.6) / 2.6;
  let zLE = 4.7 + 1.5 * t;
  let zTE = 7.3 + 0.6 * t;
  [zLE, zTE] = roundTip(t, 0.9, zLE, zTE);
  const u = slab(z, zLE, zTE, y, -0.1, 0.28, 0.17);
  if (u < 0) return null;
  if (t > 0.85) return JET_DARK;
  return y < -0.1 ? JET_BELLY : JET_TOP;
}

function jetFins(x, y, z) {
  if (y < 0.4 || y > 3.0) return null;
  const h = (y - 0.45) / 2.55;
  const xc = Math.sign(x) * (1.0 + 0.5 * h);
  if (Math.abs(x - xc) > 0.12) return null;
  let zLE = 3.5 + 2.4 * h;
  let zTE = 7.3 + 0.3 * h;
  [zLE, zTE] = roundTip(h, 0.93, zLE, zTE);
  if (z < zLE || z > zTE) return null;
  const u = (z - zLE) / (zTE - zLE);
  if (h > 0.84) return JET_DARK;
  if (h > 0.45 && h < 0.58 && u > 0.2) return JET_RED;
  if (Math.abs(u - 0.7) < 0.03) return shade(JET_TOP, 0.75);
  return JET_TOP;
}

function jetNozzle(x, y, z) {
  if (z < 6.5 || z > 8.3) return null;
  const d = Math.hypot(x, y);
  const r = z < 7.4 ? 0.72 : 0.72 - 0.12 * ((z - 7.4) / 0.9);
  if (d > r) return null;
  if (z > 7.5 && d < r - 0.22) return z > 7.9 ? [120, 64, 36] : DARK;
  return Math.floor((z - 6.5) / 0.3) % 2 ? [150, 155, 165] : [112, 118, 128];
}

function jetColour(x, y, z) {
  return (
    jetCanopy(x, y, z) ||
    jetFuselage(x, y, z) ||
    jetIntake(x, y, z) ||
    jetNozzle(x, y, z) ||
    jetWing(x, y, z) ||
    jetMissile(x, y, z) ||
    jetStab(x, y, z) ||
    jetFins(x, y, z)
  );
}

function jetGear() {
  const parts = [];
  parts.push(boxGeometry([-0.07, 0.07, -1.3, 0, -5.45, -5.25, METAL]));
  parts.push(...wheelGeometry(0, -1.42, -5.35, 0.28, 0.2, BLACK, METAL));
  for (const s of [-1, 1]) {
    parts.push(boxGeometry([s * 1.35 - 0.08, s * 1.35 + 0.08, -1.3, 0, 2.65, 2.95, METAL]));
    parts.push(...wheelGeometry(s * 1.35, -1.32, 2.8, 0.38, 0.24, BLACK, METAL));
  }
  return mergeGeometries(parts);
}

// A stack of glowing boxes that narrows and cools along +Z; scaled in length with the throttle.
function flameGeometry() {
  const colours = [[255, 250, 225], [255, 225, 140], [255, 190, 90], [255, 150, 55], [255, 110, 40], [235, 75, 30], [190, 50, 28], [140, 40, 30]];
  const parts = [];
  colours.forEach((c, i) => {
    const w = (0.46 * (1 - i / 9) + 0.05) * (i % 2 ? 0.88 : 1);
    parts.push(boxGeometry([-w, w, -w, w, i * 0.6, i * 0.6 + 0.62, c], null, 8));
  });
  return mergeGeometries(parts);
}

export function createJet(material) {
  const group = new THREE.Group();
  group.add(mesh(voxelize(jetColour, JET_ORIGIN, JET_DIMS, JET_VOX), material));
  const gear = mesh(jetGear(), material);
  gear.position.y = -0.4;
  group.add(gear);
  const flame = mesh(flameGeometry(), material);
  flame.position.set(0, 0, 8.2);
  group.add(flame);
  const animateGear = gearAnimator(gear);
  group.userData.update = (dt, eng, ctx) => {
    const ab = ctx ? ctx.ab : 0;
    flame.visible = eng > 0.12;
    const flick = 1 + (Math.random() - 0.5) * 0.12;
    flame.scale.set(0.45 + 0.55 * eng + 0.2 * ab, 0.45 + 0.55 * eng + 0.2 * ab, (0.16 + 0.45 * eng + 0.95 * ab) * flick);
    if (ctx) animateGear(dt, ctx.grounded || ctx.agl < 150 || ctx.speed < 130);
  };
  return group;
}

export function createAircraft(id, material) {
  if (id === 'airliner') return createAirliner(material);
  if (id === 'jet') return createJet(material);
  return createPlane(material);
}
