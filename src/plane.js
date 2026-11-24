import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Voxel-style single-engine prop plane, sampled from analytic shapes on a fine grid.
// Units are metres: +X right, +Y up, -Z forward (nose at about z = -5, tail at about z = 6).

// Distance from the plane origin down to the wheel contact point, metres at scale 1.
export const GEAR_DROP = 1.9;

const VOX = 0.15;
const ORIGIN = [-7.05, -2.1, -5.1];
const DIMS = [94, 34, 78];

const WHITE = [238, 240, 244];
const UNDER = [196, 202, 212];
const BLUE = [28, 64, 138];
const RED = [205, 45, 45];
const GREEN = [40, 200, 90];
const GLASS = [66, 128, 196];
const GLASS_DARK = [34, 70, 120];
const DARK = [44, 46, 52];
const METAL = [140, 145, 155];
const BLACK = [24, 24, 28];

const sq = (v) => v * v;
const lerp = (a, b, t) => a + (b - a) * t;
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// Wing-like slab: spanwise parameter t, chordwise u (0 leading edge, 1 trailing edge), returns [u, t] or null.
function slab(z, zLE, zTE, y, yc, thick) {
  const u = (z - zLE) / (zTE - zLE);
  if (u < 0 || u > 1) return null;
  const th = Math.max(0.16, thick * 2.6 * Math.sqrt(u) * (1 - u));
  return Math.abs(y - yc) < th / 2 ? u : null;
}

function fuselage(x, y, z) {
  if (z < -4.3 || z > 6.1) return null;
  let hw, hu, hd, cy = 0;
  if (z < -3.4) {
    hw = hu = hd = 0.78 + (0.12 * (z + 4.3)) / 0.9;
  } else if (z <= 1.4) {
    hw = hu = 0.9;
    hd = 0.85;
  } else {
    const t = (z - 1.4) / 4.7;
    hw = hu = 0.9 - 0.76 * Math.pow(t, 0.9);
    hd = 0.85 - 0.71 * Math.pow(t, 0.9);
    cy = 0.6 * t * t;
  }
  const dx = Math.abs(x) / hw;
  const dy = (y - cy) / (y > cy ? hu : hd);
  if (Math.pow(dx, 2.5) + Math.pow(Math.abs(dy), 2.5) > 1) return null;
  if (z < -4.1) return DARK;
  const rel = y - cy;
  const outer = dx > 0.78;
  const winZ = z > -2.5 && z < 1.2 && rel > 0.1 && rel < 0.58 && dx > 0.6;
  if (winZ && Math.abs(z + 1.1) > 0.1 && Math.abs(z - 0.3) > 0.1) return GLASS_DARK;
  if (z > -3.2 && z < 5.8 && outer) {
    if (rel > -0.32 && rel < -0.16) return BLUE;
    if (rel > -0.5 && rel < -0.34) return RED;
  }
  if (z > -3.3 && z < -3.15) return RED;
  if (rel < -0.6 * hd) return UNDER;
  return WHITE;
}

function wing(x, y, z) {
  const ax = Math.abs(x);
  if (ax < 0.6 || ax > 6.5) return null;
  const t = (ax - 0.6) / 5.9;
  let zLE = -1.75 + 1.15 * t;
  let zTE = 1.05 - 0.1 * t;
  if (t > 0.9) {
    const k = Math.sqrt(Math.max(0, 1 - sq((t - 0.9) / 0.1)));
    const mid = (zLE + zTE) / 2;
    const half = ((zTE - zLE) / 2) * k;
    zLE = mid - half;
    zTE = mid + half;
  }
  const yc = -0.4 + 0.07 * ax;
  const u = slab(z, zLE, zTE, y, yc, 0.34 - 0.2 * t);
  if (u === null) return null;
  if (t > 0.9 && y > yc) return x > 0 ? GREEN : RED;
  if (y < yc - 0.02) return UNDER;
  if (u < 0.07) return WHITE;
  if (u > 0.82 && u < 0.93) return BLUE;
  if (t > 0.45 && t < 0.95 && Math.abs(u - 0.74) < 0.025) return shade(WHITE, 0.82);
  if (t < 0.3 && u > 0.35 && u < 0.62) return shade(WHITE, 0.95);
  return WHITE;
}

function stabiliser(x, y, z) {
  const ax = Math.abs(x);
  if (ax > 2.5) return null;
  const t = ax / 2.5;
  let zLE = 4.55 + 0.45 * t;
  let zTE = 6.05 + 0.1 * t;
  if (t > 0.88) {
    const k = Math.sqrt(Math.max(0, 1 - sq((t - 0.88) / 0.12)));
    const mid = (zLE + zTE) / 2;
    const half = ((zTE - zLE) / 2) * k;
    zLE = mid - half;
    zTE = mid + half;
  }
  const u = slab(z, zLE, zTE, y, 0.38 + 0.02 * ax, 0.2);
  if (u === null) return null;
  if (t > 0.8) return BLUE;
  return y < 0.37 ? UNDER : WHITE;
}

function fin(x, y, z) {
  if (Math.abs(x) > 0.15 || y < 0.3 || y > 2.75) return null;
  const h = (y - 0.4) / 2.3;
  let zLE = 3.5 + 1.35 * h;
  let zTE = 6.05 + 0.2 * h;
  if (h > 0.92) {
    const k = Math.sqrt(Math.max(0, 1 - sq((h - 0.92) / 0.08)));
    const mid = (zLE + zTE) / 2;
    const half = ((zTE - zLE) / 2) * k;
    zLE = mid - half;
    zTE = mid + half;
  }
  if (z < zLE || z > zTE) return null;
  if (h > 0.25 && h < 0.36) return RED;
  if (z > zTE - 0.55 && Math.abs(z - (zTE - 0.55)) < 0.08) return shade(BLUE, 0.7);
  return h < 0.2 ? WHITE : BLUE;
}

function gear(x, y, z) {
  const ax = Math.abs(x);
  // nose gear
  if (ax < 0.08 && z > -3.1 && z < -2.9 && y > -1.55 && y < -0.6) return METAL;
  if (ax < 0.13) {
    const d = Math.hypot(y + 1.55, z + 3.0);
    if (d < 0.15) return METAL;
    if (d < 0.35) return BLACK;
  }
  // main gear: strut, wheel with hub, diagonal brace
  if (ax > 1.25 && ax < 1.42 && z > -0.4 && z < -0.1 && y > -1.5 && y < -0.28) return METAL;
  if (ax > 1.2 && ax < 1.5) {
    const d = Math.hypot(y + 1.52, z + 0.25);
    if (d < 0.17) return METAL;
    if (d < 0.38) return BLACK;
  }
  if (ax > 0.5 && ax < 1.3 && z > -0.33 && z < -0.17) {
    const yb = -0.7 - 0.75 * (ax - 0.5);
    if (Math.abs(y - yb) < 0.09) return METAL;
  }
  // whip antenna
  if (ax < 0.08 && Math.abs(z - 2.3) < 0.08 && y > 0.7 && y < 1.2) return METAL;
  return null;
}

function canopy(x, y, z) {
  if (y < 0.3) return null;
  if (sq(x / 0.66) + sq((y - 0.5) / 0.9) + sq((z + 0.75) / 1.65) > 1) return null;
  if (z > 0.2 || Math.abs(z + 1.1) < 0.08) return WHITE;
  return y > 1.1 ? GLASS : shade(GLASS, 0.85);
}

function spinner(x, y, z) {
  if (z < -5 || z >= -4.2) return null;
  const r = 0.36 * Math.sqrt(Math.max(0, 1 - sq((-4.2 - z) / 0.8)));
  return x * x + y * y < r * r ? RED : null;
}

function colourAt(x, y, z) {
  return spinner(x, y, z) || canopy(x, y, z) || fuselage(x, y, z) || wing(x, y, z) || stabiliser(x, y, z) || fin(x, y, z) || gear(x, y, z);
}

function hash3(i, j, k) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildBody() {
  const [nx, ny, nz] = DIMS;
  const grid = new Array(nx * ny * nz).fill(null);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = colourAt(ORIGIN[0] + (i + 0.5) * VOX, ORIGIN[1] + (j + 0.5) * VOX, ORIGIN[2] + (k + 0.5) * VOX);
        if (c) grid[idx(i, j, k)] = shade(c, 1 + (hash3(i, j, k) - 0.5) * 0.05);
      }
    }
  }
  const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && grid[idx(i, j, k)] !== null;

  const pos = [];
  const col = [];
  const ao = [];
  const index = [];
  const AO_LEVEL = [0.5, 0.68, 0.84, 1];
  const cell = [0, 0, 0];
  const probe = [0, 0, 0];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = grid[idx(i, j, k)];
        if (!c) continue;
        for (let a = 0; a < 3; a++) {
          for (const s of [-1, 1]) {
            cell[0] = i; cell[1] = j; cell[2] = k;
            probe[0] = i; probe[1] = j; probe[2] = k;
            probe[a] += s;
            if (solid(probe[0], probe[1], probe[2])) continue;
            const u = (a + 1) % 3;
            const v = (a + 2) % 3;
            const base = pos.length / 3;
            const vertAo = [];
            for (const [su, sv] of corners) {
              const p = [cell[0], cell[1], cell[2]];
              p[a] += s;
              const q1 = [p[0], p[1], p[2]];
              const q2 = [p[0], p[1], p[2]];
              const q3 = [p[0], p[1], p[2]];
              q1[u] += su;
              q2[v] += sv;
              q3[u] += su;
              q3[v] += sv;
              const s1 = solid(q1[0], q1[1], q1[2]) ? 1 : 0;
              const s2 = solid(q2[0], q2[1], q2[2]) ? 1 : 0;
              const s3 = solid(q3[0], q3[1], q3[2]) ? 1 : 0;
              vertAo.push(AO_LEVEL[s1 && s2 ? 0 : 3 - (s1 + s2 + s3)]);
              const vert = [cell[0], cell[1], cell[2]];
              vert[a] += s > 0 ? 1 : 0;
              vert[u] += su > 0 ? 1 : 0;
              vert[v] += sv > 0 ? 1 : 0;
              pos.push(ORIGIN[0] + vert[0] * VOX, ORIGIN[1] + vert[1] * VOX, ORIGIN[2] + vert[2] * VOX);
              col.push(c[0], c[1], c[2]);
            }
            ao.push(...vertAo);
            const flip = vertAo[0] + vertAo[2] > vertAo[1] + vertAo[3];
            if (s > 0) {
              if (flip) index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
              else index.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else if (flip) {
              index.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
            } else {
              index.push(base, base + 2, base + 1, base, base + 3, base + 2);
            }
          }
        }
      }
    }
  }

  const n = pos.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col.map((v) => Math.max(0, Math.min(255, Math.round(v))))), 3, true));
  const aux = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) aux.set([6, Math.round(ao[i] * 255), 0, 0], i * 4);
  g.setAttribute('aux', new THREE.BufferAttribute(aux, 4));
  g.setAttribute('wuv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  g.setIndex(index);
  return g;
}

function buildProp() {
  const tilt = new THREE.Matrix4().makeRotationY(0.35);
  const parts = [];
  for (const sign of [1, -1]) {
    const m = new THREE.Matrix4().makeRotationZ(sign > 0 ? 0 : Math.PI).multiply(tilt);
    parts.push(boxGeometry([-0.1, 0.1, 0.2, 1.5, -0.04, 0.04, BLACK], m));
    parts.push(boxGeometry([-0.1, 0.1, 1.25, 1.5, -0.045, 0.045, [240, 200, 40]], m));
  }
  return mergeGeometries(parts);
}

// One coloured box as an attribute-complete voxel geometry (kind 6 = unlit-by-AO prop material).
// An optional matrix repositions it, which lets thin boxes act as angled lines.
export function boxGeometry([x0, x1, y0, y1, z0, z1, c], matrix) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  if (matrix) g.applyMatrix4(matrix);
  const n = g.attributes.position.count;
  const col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) col.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  const aux = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) aux.set([6, 255, 0, 0], i * 4);
  g.setAttribute('aux', new THREE.BufferAttribute(aux, 4));
  g.setAttribute('wuv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

export function createPlane(material) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(buildBody(), material);
  body.frustumCulled = false;
  const prop = new THREE.Mesh(buildProp(), material);
  prop.frustumCulled = false;
  prop.position.set(0, 0, -4.5);
  group.add(body, prop);
  group.userData.update = (dt, throttle) => {
    if (throttle > 0.02) prop.rotation.z += dt * (14 + throttle * 36);
  };
  return group;
}
