import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { R, DEG, G, heightScale, tileToLat, tileToLon } from './geo.js';

const TERRAIN_MAXZ = 15;
const IMAGERY_MAXZ = 17;
const VECTOR_MAXZ = 14;
const WATER_MINZ = 10;
const ROAD_MINZ = 14;
const BUILDING_MINZ = 16;
const TREE_MAX_CELL = 5; // metres
const PLACEHOLDER_BYTES = 2521; // Esri "map data not yet available" tile
const SS = 2; // sub-samples per column when rasterising polygons
const GR = G * SS;
const EARTH_M = 2 * Math.PI * R;

// Vertex kinds, shared with materials.js
const K_TERRAIN = 0;
const K_WALL = 1;
const K_ROOF = 2;
const K_WATER = 3;
const K_TREE = 4;
const K_ROAD = 5;
const K_LATTICE = 7;

const LIFT_MIN = 8; // building parts starting higher than this (m) float as slabs instead of filling down to the ground
const BRIDGE_MAX_CELL = 7; // metres; coarser tiles keep the flat causeway fallback
const FRAME_MIN_H = 50; // open-frame structures: tall parts only
const CLUSTER_GAP = 30; // metres: rings of one feature closer than this belong to the same structure
const FRAME_STEEL = [124, 112, 104];

let cfg = null;
let bytesFetched = 0;

class LruCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key, make) {
    let p = this.map.get(key);
    if (p) {
      this.map.delete(key);
      this.map.set(key, p);
      return p;
    }
    p = make().catch((e) => {
      this.map.delete(key);
      throw e;
    });
    this.map.set(key, p);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return p;
  }
}

const terrainCache = new LruCache(48);
const imageryCache = new LruCache(48);
const vectorCache = new LruCache(10);
const scratchCanvas = new OffscreenCanvas(256, 256);
const scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });

function fill(tpl, z, x, y) {
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// Tries the tile's own alias first (stable per tile, so the HTTP cache still hits), then the others.
async function fetchAny(tpls, z, x, y) {
  const k = (x + y) % tpls.length;
  let err;
  for (let i = 0; i < tpls.length; i++) {
    try {
      return await fetchBuf(fill(tpls[(k + i) % tpls.length], z, x, y));
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

async function fetchBuf(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  bytesFetched += buf.byteLength;
  return buf;
}

async function decodeImage(buf) {
  const bmp = await createImageBitmap(new Blob([buf]), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  scratchCtx.drawImage(bmp, 0, 0, 256, 256);
  bmp.close();
  return scratchCtx.getImageData(0, 0, 256, 256).data;
}

function getTerrain(z, x, y) {
  return terrainCache.get(`${z}/${x}/${y}`, async () => {
    const buf = await fetchAny(cfg.terrain, z, x, y);
    if (!buf) return null;
    const d = await decodeImage(buf);
    const h = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    return h;
  });
}

function getImagery(z, x, y) {
  return imageryCache.get(`${z}/${x}/${y}`, async () => {
    const buf = await fetchAny(cfg.imagery, z, x, y);
    if (!buf || buf.byteLength === PLACEHOLDER_BYTES) return null;
    return decodeImage(buf);
  });
}

async function getImageryChain(z, x, y) {
  const zs = [Math.min(z, IMAGERY_MAXZ)];
  if (zs[0] > 13) zs.push(13);
  for (const zz of zs) {
    const d = z - zz;
    const data = await getImagery(zz, x >> d, y >> d);
    if (data) return { data, z: zz };
  }
  return null;
}

// --- vector tile decoding ---------------------------------------------------------

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// 16x16 bin grid over the tile for quick bbox queries
class FeatIndex {
  constructor() {
    this.bins = new Array(256);
    this.seen = [];
    this.stamp = 0;
  }
  add(idx, minx, miny, maxx, maxy) {
    this.seen.push(0);
    const x0 = clamp(Math.floor(minx * 16), 0, 15);
    const x1 = clamp(Math.floor(maxx * 16), 0, 15);
    const y0 = clamp(Math.floor(miny * 16), 0, 15);
    const y1 = clamp(Math.floor(maxy * 16), 0, 15);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const b = j * 16 + i;
        (this.bins[b] || (this.bins[b] = [])).push(idx);
      }
  }
  query(minx, miny, maxx, maxy, cb) {
    const s = ++this.stamp;
    const x0 = clamp(Math.floor(minx * 16), 0, 15);
    const x1 = clamp(Math.floor(maxx * 16), 0, 15);
    const y0 = clamp(Math.floor(miny * 16), 0, 15);
    const y1 = clamp(Math.floor(maxy * 16), 0, 15);
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const bin = this.bins[j * 16 + i];
        if (!bin) continue;
        for (const idx of bin) {
          if (this.seen[idx] === s) continue;
          this.seen[idx] = s;
          cb(idx);
        }
      }
  }
}

const COLOR_NAMES = {
  white: [240, 240, 240],
  black: [60, 60, 60],
  gray: [150, 150, 150],
  grey: [150, 150, 150],
  red: [190, 80, 70],
  brown: [140, 100, 75],
  beige: [225, 210, 180],
  yellow: [230, 205, 120],
  orange: [220, 150, 90],
  green: [120, 160, 120],
  blue: [110, 140, 190],
  tan: [210, 180, 140],
  cream: [240, 230, 200],
  silver: [190, 195, 200],
  pink: [225, 170, 170],
};

function parseColour(s) {
  if (!s || typeof s !== 'string') return null;
  const c = s.trim().toLowerCase();
  if (c[0] === '#') {
    if (c.length === 7) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    if (c.length === 4) return [...c.slice(1)].map((h) => parseInt(h + h, 16));
    return null;
  }
  return COLOR_NAMES[c] || null;
}

function toRings(geom, extent) {
  const out = [];
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const ring of geom) {
    const a = new Float32Array(ring.length * 2);
    for (let k = 0; k < ring.length; k++) {
      const px = ring[k].x / extent;
      const py = ring[k].y / extent;
      a[2 * k] = px;
      a[2 * k + 1] = py;
      if (px < minx) minx = px;
      if (px > maxx) maxx = px;
      if (py < miny) miny = py;
      if (py > maxy) maxy = py;
    }
    out.push(a);
  }
  return { rings: out, minx, miny, maxx, maxy };
}

// Footprint summary of one ring: signed area (fraction space), centre (fractions), extents and bounds (metres)
function ringInfo(ring, mpt) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let area = 0;
  const n = ring.length / 2;
  for (let k = 0; k < n; k++) {
    const x = ring[2 * k];
    const y = ring[2 * k + 1];
    const k2 = k + 1 === n ? 0 : k + 1;
    area += x * ring[2 * k2 + 1] - ring[2 * k2] * y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const w = (x1 - x0) * mpt;
  const h = (y1 - y0) * mpt;
  return { ring, area, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h, size: Math.sqrt(w * h), x0: x0 * mpt, y0: y0 * mpt, x1: x1 * mpt, y1: y1 * mpt };
}

function unionBox(list) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const r of list) {
    b.x0 = Math.min(b.x0, r.x0);
    b.y0 = Math.min(b.y0, r.y0);
    b.x1 = Math.max(b.x1, r.x1);
    b.y1 = Math.max(b.y1, r.y1);
  }
  return b;
}

// does box a contain box b, with a margin of m metres
function boxContains(a, b, m) {
  return a.x0 - m <= b.x0 && a.y0 - m <= b.y0 && a.x1 + m >= b.x1 && a.y1 + m >= b.y1;
}

// overlap area as a fraction of the smaller box
function overlapFrac(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const sa = (a.x1 - a.x0) * (a.y1 - a.y0);
  const sb = (b.x1 - b.x0) * (b.y1 - b.y0);
  return (w * h) / Math.max(1e-6, Math.min(sa, sb));
}

const ROAD_STYLE = {
  motorway: { w: 16, p: 9, maxCell: 60, c: [96, 96, 102] },
  trunk: { w: 14, p: 8, maxCell: 60, c: [96, 96, 102] },
  primary: { w: 12, p: 7, maxCell: 40, c: [92, 92, 98] },
  secondary: { w: 10, p: 6, maxCell: 24, c: [88, 88, 94] },
  tertiary: { w: 8, p: 5, maxCell: 14, c: [84, 84, 90] },
  minor: { w: 6.5, p: 4, maxCell: 8, c: [80, 80, 86] },
  service: { w: 4, p: 3, maxCell: 4, c: [78, 78, 84] },
  raceway: { w: 8, p: 4, maxCell: 8, c: [80, 80, 86] },
  busway: { w: 6, p: 4, maxCell: 8, c: [80, 80, 86] },
  track: { w: 3, p: 2, maxCell: 4, c: [150, 130, 100] },
  path: { w: 1.6, p: 1, maxCell: 2, c: [170, 155, 125] },
  rail: { w: 3.4, p: 2, maxCell: 14, c: [118, 106, 98] },
  runway: { w: 45, p: 9, maxCell: 60, c: [62, 62, 66] },
  taxiway: { w: 16, p: 8, maxCell: 14, c: [84, 84, 90] },
};

const WATERWAY_W = { river: 12, canal: 9, stream: 3, drain: 2, ditch: 2 };

// Lazily decoded layers of one vector tile.
class VecData {
  constructor(vt, z, x, y) {
    this.vt = vt;
    this.z = z;
    this.x = x;
    this.y = y;
    this.cache = {};
  }

  polys(name, props, key = name) {
    if (this.cache[key]) return this.cache[key];
    const layer = this.vt.layers[name];
    const list = [];
    const ix = new FeatIndex();
    if (layer) {
      for (let f = 0; f < layer.length; f++) {
        const feat = layer.feature(f);
        if (feat.type !== 3) continue;
        const item = props(feat.properties, feat, f);
        if (!item) continue;
        const g = toRings(feat.loadGeometry(), layer.extent);
        if (item.skip) {
          g.rings = g.rings.filter((_, i) => !item.skip.has(i));
          if (!g.rings.length) continue;
        }
        Object.assign(item, g);
        ix.add(list.length, g.minx, g.miny, g.maxx, g.maxy);
        list.push(item);
      }
    }
    return (this.cache[key] = { list, ix });
  }

  lines(name, props) {
    const key = name + ':l';
    if (this.cache[key]) return this.cache[key];
    const layer = this.vt.layers[name];
    const list = [];
    const ix = new FeatIndex();
    if (layer) {
      for (let f = 0; f < layer.length; f++) {
        const feat = layer.feature(f);
        if (feat.type !== 2) continue;
        const item = props(feat.properties);
        if (!item) continue;
        const g = toRings(feat.loadGeometry(), layer.extent);
        item.lines = g.rings;
        ix.add(list.length, g.minx, g.miny, g.maxx, g.maxy);
        list.push(item);
      }
    }
    return (this.cache[key] = { list, ix });
  }

  // Open-frame structures (lattice towers, pylons) recognised from how the map data models them:
  // groups of separate pillar footprints, or hollow tubes, plus every tall part stacked on or inside them.
  get frames() {
    if (this.cache.frames) return this.cache.frames;
    const layer = this.vt.layers.building;
    const mpt = (EARTH_M * Math.cos(tileToLat(this.y + 0.5, 2 ** this.z) * DEG)) / 2 ** this.z;
    const items = [];
    if (layer) {
      for (let f = 0; f < layer.length; f++) {
        const feat = layer.feature(f);
        if (feat.type !== 3) continue;
        const p = feat.properties;
        const hi = p.render_height || 0;
        const lo = p.render_min_height || 0;
        if (hi < FRAME_MIN_H || hi - lo < 20) continue;
        const g = toRings(feat.loadGeometry(), layer.extent);
        const infos = g.rings.map((ring, i) => Object.assign(ringInfo(ring, mpt), { i }));
        // one feature can hold unrelated footprints: split it into clusters of nearby rings
        const comp = infos.map((_, i) => i);
        const find = (i) => (comp[i] === i ? i : (comp[i] = find(comp[i])));
        for (let a = 0; a < infos.length; a++) {
          for (let b = a + 1; b < infos.length; b++) {
            const gap = Math.max(infos[a].x0 - infos[b].x1, infos[b].x0 - infos[a].x1, infos[a].y0 - infos[b].y1, infos[b].y0 - infos[a].y1);
            if (gap <= CLUSTER_GAP) comp[find(b)] = find(a);
          }
        }
        const groups = new Map();
        for (const r of infos) {
          const k = find(r.i);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
        for (const rs of groups.values()) {
          const outers = rs.filter((r) => r.area > 0);
          if (!outers.length) continue;
          const holes = rs.filter((r) => r.area <= 0);
          const it = { f, lo, hi, hide: !!p.hide_3d, col: parseColour(p.colour), id: feat.id !== undefined ? feat.id : f * 97 + 13, rings: rs.map((r) => r.ring), ringIdx: rs.map((r) => r.i), outers, holes };
          it.box = unionBox(outers);
          it.minx = Math.min(...rs.map((r) => r.x0)) / mpt;
          it.miny = Math.min(...rs.map((r) => r.y0)) / mpt;
          it.maxx = Math.max(...rs.map((r) => r.x1)) / mpt;
          it.maxy = Math.max(...rs.map((r) => r.y1)) / mpt;
          items.push(it);
        }
      }
    }

    const maxDim = (o) => Math.max(o.w, o.h);
    // separate equal-sized footprints ringing an empty centre: the legs of a tower rather than a block of flats
    const isPillarRing = (it) => {
      const os = it.outers;
      if (os.length < 3 || os.length > 8 || it.lo < LIFT_MIN || it.hi - it.lo < 25 || os.some((o) => maxDim(o) > 60)) return false;
      const sizes = os.map((o) => o.size);
      const mean = sizes.reduce((a, b) => a + b, 0) / os.length;
      if (Math.max(...sizes) > 1.35 * Math.min(...sizes)) return false;
      const cx = os.reduce((a, o) => a + o.cx, 0) / os.length;
      const cy = os.reduce((a, o) => a + o.cy, 0) / os.length;
      if (os.some((o) => cx >= o.x0 / mpt && cx <= o.x1 / mpt && cy >= o.y0 / mpt && cy <= o.y1 / mpt)) return false;
      const far = Math.max(...os.map((o) => Math.hypot((o.cx - cx) * mpt, (o.cy - cy) * mpt)));
      if (far < 0.4 * mean || far > 2.5 * mean) return false;
      // a crown standing on a solid tower is part of that building
      return !items.some(
        (o) => o !== it && o.outers.length === 1 && !o.holes.length && o.lo <= it.lo + 1 && o.hi >= it.lo - 1 && o.box.x0 <= cx * mpt && o.box.x1 >= cx * mpt && o.box.y0 <= cy * mpt && o.box.y1 >= cy * mpt,
      );
    };
    const isSeed = (it) => {
      if (it.hide) return false;
      const span = it.hi - it.lo;
      if (isPillarRing(it)) return true;
      if (it.hi >= FRAME_MIN_H && span >= 40)
        return it.holes.some((h) => it.outers.some((o) => maxDim(o) <= 60 && h.w >= 0.75 * o.w && h.h >= 0.75 * o.h && boxContains(o, h, 1)));
      return false;
    };
    // a candidate joins when it is stacked on/under a frame part, or sits inside a frame part's footprint
    const related = (a, b) => {
      if (overlapFrac(a.box, b.box) < 0.5) return false;
      const touch = Math.abs(a.lo - b.hi) <= 3 || Math.abs(a.hi - b.lo) <= 3;
      const sizeA = Math.max(a.box.x1 - a.box.x0, a.box.y1 - a.box.y0);
      const sizeB = Math.max(b.box.x1 - b.box.x0, b.box.y1 - b.box.y0);
      return (touch && sizeA <= 2 * sizeB) || boxContains(b.box, a.box, 2);
    };
    const frame = items.filter(isSeed);
    const rest = items.filter((it) => !frame.includes(it));
    for (let grew = frame.length > 0; grew; ) {
      grew = false;
      for (let i = rest.length - 1; i >= 0; i--) {
        if (frame.some((fr) => related(rest[i], fr))) {
          frame.push(rest[i]);
          rest.splice(i, 1);
          grew = true;
        }
      }
    }

    // loft each hole-free pillar group towards what sits on top of it, so legs lean and taper like real ones
    for (const it of frame) {
      it.loft = null;
      if (it.holes.length) continue;
      let next = null;
      let best = 0;
      for (const o of frame) {
        if (o === it || o.hi <= it.hi || Math.abs(o.lo - it.hi) > 4) continue;
        const ov = overlapFrac(it.box, o.box);
        if (ov > best) {
          best = ov;
          next = o;
        }
      }
      it.loft = it.outers.map((o) => {
        if (next) {
          let q = null;
          let qd = Infinity;
          for (const c of next.outers) {
            const d = Math.hypot((c.cx - o.cx) * mpt, (c.cy - o.cy) * mpt);
            if (d < qd) {
              qd = d;
              q = c;
            }
          }
          return q && qd <= 1.2 * Math.max(o.size, q.size) ? { cx: q.cx, cy: q.cy, size: q.size } : null;
        }
        return it.lo >= LIFT_MIN ? { cx: o.cx, cy: o.cy, size: o.size * 0.35 } : null;
      });
    }

    const ix = new FeatIndex();
    frame.forEach((it, k) => ix.add(k, it.minx, it.miny, it.maxx, it.maxy));
    const skip = new Map();
    for (const it of frame) {
      if (!skip.has(it.f)) skip.set(it.f, new Set());
      for (const i of it.ringIdx) skip.get(it.f).add(i);
    }
    return (this.cache.frames = { list: frame, ix, skip });
  }

  get buildings() {
    const skip = this.frames.skip;
    return this.polys('building', (p, feat, f) => {
      if (p.hide_3d || (p.render_min_height || 0) >= LIFT_MIN) return null;
      return {
        h: p.render_height > 0 ? p.render_height : 6,
        col: parseColour(p.colour),
        id: feat.id !== undefined ? feat.id : f * 97 + 13,
        skip: skip.get(f),
      };
    });
  }

  // building parts that hang above the ground (arches, platforms, overpasses, tower stages)
  get lifted() {
    const skip = this.frames.skip;
    return this.polys(
      'building',
      (p, feat, f) => {
        const lo = p.render_min_height || 0;
        if (p.hide_3d || lo < LIFT_MIN || !(p.render_height > lo)) return null;
        return {
          lo,
          h: p.render_height,
          col: parseColour(p.colour),
          id: feat.id !== undefined ? feat.id : f * 97 + 13,
          skip: skip.get(f),
        };
      },
      'lifted',
    );
  }

  get water() {
    return this.polys('water', () => ({}));
  }

  get aeroPolys() {
    return this.polys('aeroway', (p) => (p.class === 'runway' || p.class === 'taxiway' || p.class === 'apron' ? {} : null));
  }

  get aeroLines() {
    return this.lines('aeroway', (p) => (p.class === 'runway' || p.class === 'taxiway' ? { cls: p.class } : null));
  }

  get waterways() {
    return this.lines('waterway', (p) => (WATERWAY_W[p.class] ? { w: WATERWAY_W[p.class] } : null));
  }

  get roads() {
    return this.lines('transportation', (p) => {
      if (p.brunnel === 'tunnel') return null;
      const st = ROAD_STYLE[p.class];
      if (!st) return null;
      let w = st.w;
      if (p.class === 'service' && (p.service === 'driveway' || p.service === 'parking_aisle')) w = 2.6;
      return { st, w, bridge: p.brunnel === 'bridge' };
    });
  }
}

function getVector(z, x, y) {
  return vectorCache.get(`${z}/${x}/${y}`, async () => {
    const buf = await fetchBuf(fill(cfg.vector, z, x, y));
    return buf ? new VecData(new VectorTile(new PbfReader(new Uint8Array(buf))), z, x, y) : null;
  });
}

// --- sampling -------------------------------------------------------------

function sampleH(h, px, py) {
  const x = px - 0.5;
  const y = py - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = Math.min(255, Math.max(0, x0));
  const xb = Math.min(255, Math.max(0, x0 + 1));
  const ya = Math.min(255, Math.max(0, y0)) * 256;
  const yb = Math.min(255, Math.max(0, y0 + 1)) * 256;
  return (
    (h[ya + xa] * (1 - fx) + h[ya + xb] * fx) * (1 - fy) + (h[yb + xa] * (1 - fx) + h[yb + xb] * fx) * fy
  );
}

function areaH(h, cx, cy, fp) {
  if (fp <= 1.5) return sampleH(h, cx, cy);
  const k = Math.min(4, Math.ceil(fp / 2));
  let s = 0;
  for (let a = 0; a < k; a++)
    for (let b = 0; b < k; b++) s += sampleH(h, cx + ((a + 0.5) / k - 0.5) * fp, cy + ((b + 0.5) / k - 0.5) * fp);
  return s / (k * k);
}

function sampleRGB(d, px, py, acc, w) {
  const x = px - 0.5;
  const y = py - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = Math.min(255, Math.max(0, x0));
  const xb = Math.min(255, Math.max(0, x0 + 1));
  const ya = Math.min(255, Math.max(0, y0)) * 256;
  const yb = Math.min(255, Math.max(0, y0 + 1)) * 256;
  for (let c = 0; c < 3; c++) {
    acc[c] +=
      w *
      ((d[(ya + xa) * 4 + c] * (1 - fx) + d[(ya + xb) * 4 + c] * fx) * (1 - fy) +
        (d[(yb + xa) * 4 + c] * (1 - fx) + d[(yb + xb) * 4 + c] * fx) * fy);
  }
}

function areaRGB(d, cx, cy, fp, out) {
  out[0] = out[1] = out[2] = 0;
  if (fp <= 1.5) {
    sampleRGB(d, cx, cy, out, 1);
    return;
  }
  const k = Math.min(4, Math.ceil(fp / 2));
  const w = 1 / (k * k);
  for (let a = 0; a < k; a++)
    for (let b = 0; b < k; b++) sampleRGB(d, cx + ((a + 0.5) / k - 0.5) * fp, cy + ((b + 0.5) / k - 0.5) * fp, out, w);
}

function hash2(a, b) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Fallback colours when no imagery is available.
function procColor(h, lat, out) {
  const al = Math.abs(lat);
  if (h > 3800 || al > 75) {
    out[0] = 235;
    out[1] = 240;
    out[2] = 245;
  } else if (h > 2400) {
    out[0] = 125;
    out[1] = 120;
    out[2] = 115;
  } else if (h < 4) {
    out[0] = 210;
    out[1] = 195;
    out[2] = 150;
  } else {
    const t = clamp(h / 2000, 0, 1);
    out[0] = 70 + 60 * t;
    out[1] = 120 - 10 * t;
    out[2] = 55 + 30 * t;
  }
}

// --- rasterisation --------------------------------------------------------------

// Even-odd polygon fill on the GR x GR sub-grid. Rings are in vector-tile fractions.
function fillPoly(rings, w, cb) {
  const sx = GR / (w.x1 - w.x0);
  const sy = GR / (w.y1 - w.y0);
  let minY = Infinity;
  let maxY = -Infinity;
  const pts = [];
  for (const ring of rings) {
    const a = new Float64Array(ring.length);
    for (let k = 0; k < ring.length; k += 2) {
      a[k] = (ring[k] - w.x0) * sx;
      const py = (ring[k + 1] - w.y0) * sy;
      a[k + 1] = py;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    pts.push(a);
  }
  if (maxY < 0 || minY > GR) return;
  const r0 = Math.max(0, Math.floor(minY));
  const r1 = Math.min(GR - 1, Math.ceil(maxY));
  const xs = [];
  for (let row = r0; row <= r1; row++) {
    const yc = row + 0.5;
    xs.length = 0;
    for (const a of pts) {
      const n = a.length / 2;
      for (let k = 0; k < n; k++) {
        const k2 = k + 1 === n ? 0 : k + 1;
        const y0 = a[2 * k + 1];
        const y1 = a[2 * k2 + 1];
        if (y0 <= yc !== y1 <= yc) {
          xs.push(a[2 * k] + ((yc - y0) / (y1 - y0)) * (a[2 * k2] - a[2 * k]));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const c0 = Math.max(0, Math.ceil(xs[m] - 0.5));
      const c1 = Math.min(GR - 1, Math.ceil(xs[m + 1] - 0.5) - 1);
      if (c1 >= c0) cb(row, c0, c1);
    }
  }
}

// Calls cb(columnIndex) for columns within halfW metres of a polyline.
function strokeLine(lines, w, cellM, halfW, cb) {
  const sx = G / (w.x1 - w.x0);
  const sy = G / (w.y1 - w.y0);
  const hw = Math.max(halfW / cellM, 0.5);
  const hw2 = hw * hw;
  for (const ln of lines) {
    for (let k = 0; k + 3 < ln.length; k += 2) {
      const ax = (ln[k] - w.x0) * sx;
      const ay = (ln[k + 1] - w.y0) * sy;
      const bx = (ln[k + 2] - w.x0) * sx;
      const by = (ln[k + 3] - w.y0) * sy;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - 0.5));
      const i1 = Math.min(G - 1, Math.ceil(Math.max(ax, bx) + hw - 0.5));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - 0.5));
      const j1 = Math.min(G - 1, Math.ceil(Math.max(ay, by) + hw - 0.5));
      if (i1 < i0 || j1 < j0) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = i + 0.5;
          const cy = j + 0.5;
          const t = clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1);
          const ex = cx - (ax + t * dx);
          const ey = cy - (ay + t * dy);
          if (ex * ex + ey * ey <= hw2) cb(j * G + i);
        }
      }
    }
  }
}

// Like strokeLine for one polyline, but also reports the distance along it (metres) and the offset from it (columns).
function strokeLineS(ln, w, cellM, halfW, segStart, segLen, cb) {
  const sx = G / (w.x1 - w.x0);
  const sy = G / (w.y1 - w.y0);
  const hw = Math.max(halfW / cellM, 0.5);
  const hw2 = hw * hw;
  for (let k = 0, m = 0; k + 3 < ln.length; k += 2, m++) {
    const ax = (ln[k] - w.x0) * sx;
    const ay = (ln[k + 1] - w.y0) * sy;
    const bx = (ln[k + 2] - w.x0) * sx;
    const by = (ln[k + 3] - w.y0) * sy;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - 0.5));
    const i1 = Math.min(G - 1, Math.ceil(Math.max(ax, bx) + hw - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - hw - 0.5));
    const j1 = Math.min(G - 1, Math.ceil(Math.max(ay, by) + hw - 0.5));
    if (i1 < i0 || j1 < j0) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = i + 0.5;
        const cy = j + 0.5;
        const t = clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1);
        const ex = cx - (ax + t * dx);
        const ey = cy - (ay + t * dy);
        if (ex * ex + ey * ey <= hw2) cb(j * G + i, segStart[m] + t * segLen[m], Math.hypot(ex, ey));
      }
    }
  }
}

// --- palettes ----------------------------------------------------------------------

const WALLS = [
  [226, 220, 205],
  [205, 190, 170],
  [190, 196, 205],
  [172, 160, 150],
  [220, 200, 180],
  [200, 205, 210],
  [185, 150, 130],
  [165, 100, 85],
  [210, 190, 150],
  [150, 150, 155],
];
const ROOFS = [
  [118, 118, 124],
  [150, 96, 86],
  [92, 98, 106],
  [140, 140, 135],
  [110, 80, 72],
  [165, 125, 105],
];
const GLASS = [
  [120, 160, 195],
  [100, 140, 175],
  [150, 180, 205],
  [90, 120, 150],
];
const CONCRETE = [150, 150, 155];

// --- mesh scratch buffers ---------------------------------------------------------------

const MAXV = G * G * 20;
const posBuf = new Float32Array(MAXV * 3);
const clrBuf = new Uint8Array(MAXV * 3);
const auxBuf = new Uint8Array(MAXV * 4);
const wuvBuf = new Float32Array(MAXV * 2);
const idxBuf = new Uint16Array(G * G * 5 * 6 * 2);

const CORN = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const SIDES = [
  { c: [2, 1], di: 1, dj: 0 }, // east: c,b
  { c: [0, 3], di: -1, dj: 0 }, // west: a,d
  { c: [3, 2], di: 0, dj: 1 }, // south: d,c
  { c: [1, 0], di: 0, dj: -1 }, // north: b,a
];
const AO_DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.414],
  [-1, 1, 1.414],
  [1, -1, 1.414],
  [-1, -1, 1.414],
];

// withTrees=false is the fast first pass (terrain, water, roads, buildings); trees are added by a later, lower-priority rebuild.
async function buildTile(z, x, y, withTrees) {
  const n = 2 ** z;
  const zt = Math.min(z, TERRAIN_MAXZ);
  const zv = Math.min(z, VECTOR_MAXZ);
  const dt = z - zt;
  const dv = z - zv;

  const [terr, imgR, vec] = await Promise.all([
    getTerrain(zt, x >> dt, y >> dt),
    getImageryChain(z, x, y),
    z >= WATER_MINZ && cfg.vector ? getVector(zv, x >> dv, y >> dv) : null,
  ]);
  const img = imgR ? imgR.data : null;
  const zi = imgR ? imgR.z : 0;
  const di = z - zi;

  const centerLat = tileToLat(y + 0.5, n);
  const centerLon = tileToLon(x + 0.5, n);
  const cosLat = Math.cos(centerLat * DEG);
  const cellM = (EARTH_M * cosLat) / n / G;
  const ex = heightScale(z);
  const Q = Math.max(0.5, Math.min(cellM, 150));
  const BQ = clamp(cellM * 0.6, 1, 3);
  const tileRand = (hash2(x, y * 31 + z) * 255) | 0;

  // Corner directions
  const cs = G + 1;
  const dirs = new Float64Array(cs * cs * 3);
  const cosLon = new Float64Array(cs);
  const sinLon = new Float64Array(cs);
  for (let i = 0; i < cs; i++) {
    const lo = tileToLon(x + i / G, n) * DEG;
    cosLon[i] = Math.cos(lo);
    sinLon[i] = Math.sin(lo);
  }
  for (let j = 0; j < cs; j++) {
    const la = tileToLat(y + j / G, n) * DEG;
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    for (let i = 0; i < cs; i++) {
      const d = (j * cs + i) * 3;
      dirs[d] = cl * cosLon[i];
      dirs[d + 1] = sl;
      dirs[d + 2] = -cl * sinLon[i];
    }
  }
  const cLa = centerLat * DEG;
  const cLo = centerLon * DEG;
  const cx = Math.cos(cLa) * Math.cos(cLo) * R;
  const cy = Math.sin(cLa) * R;
  const cz = -Math.cos(cLa) * Math.sin(cLo) * R;

  // Per-column data
  const GG = G * G;
  const Ht = new Float32Array(GG);
  const Hc = new Float32Array(GG);
  const flags = new Uint8Array(GG);
  const top = new Uint8Array(GG * 3);
  const side = new Uint8Array(GG * 3);
  const kindTop = new Uint8Array(GG);
  const isOcean = new Uint8Array(GG);
  const isWater = new Uint8Array(GG);
  const veg = new Uint8Array(GG);
  const bIdx = new Int32Array(GG).fill(-1);
  const bVar = new Uint8Array(GG);
  const bRnd = new Uint8Array(GG);
  const bBase = new Float32Array(GG);
  const roofCol = new Uint8Array(GG * 3);
  // floating slabs: bridge decks, piers and elevated building parts (one per column)
  const Hg = new Float32Array(GG);
  const sHas = new Uint8Array(GG);
  const sDeck = new Uint8Array(GG);
  const sLo = new Float32Array(GG);
  const sHi = new Float32Array(GG);
  const sTopC = new Uint8Array(GG * 3);
  const sSideC = new Uint8Array(GG * 3);
  const sTopK = new Uint8Array(GG);
  const sSideK = new Uint8Array(GG);
  const putSlab = (k, lo, hi, topC, sideC, topK, sideK, deck) => {
    if (!sHas[k]) {
      sHas[k] = 1;
      sLo[k] = lo;
      sHi[k] = hi;
    } else {
      if (lo < sLo[k]) sLo[k] = lo;
      if (hi <= sHi[k]) {
        if (deck) sDeck[k] = 1;
        return;
      }
      sHi[k] = hi;
    }
    for (let c = 0; c < 3; c++) {
      sTopC[k * 3 + c] = topC[c];
      sSideC[k * 3 + c] = sideC[c];
    }
    sTopK[k] = topK;
    sSideK[k] = sideK;
    if (deck) sDeck[k] = 1;
    veg[k] = 0;
  };
  const bridges = [];
  const rgb = [0, 0, 0];

  const tx = x >> dt;
  const ty = y >> dt;
  const ix = x >> di;
  const iy = y >> di;
  const tScale = 2 ** zt;
  const iScale = 2 ** zi;
  const tFp = 256 / G / 2 ** dt;
  const iFp = 256 / G / 2 ** di;

  for (let j = 0; j < G; j++) {
    const lat = tileToLat(y + (j + 0.5) / G, n);
    const v = (y + (j + 0.5) / G) / n;
    for (let i = 0; i < G; i++) {
      const u = (x + (i + 0.5) / G) / n;
      const k = j * G + i;
      let h = 0;
      if (terr) h = areaH(terr, (u * tScale - tx) * 256, (v * tScale - ty) * 256, tFp);
      if (img) {
        areaRGB(img, (u * iScale - ix) * 256, (v * iScale - iy) * 256, iFp, rgb);
        // richer colours and lifted shadows: photo shadows are baked in and we add our own
        const l = (rgb[0] + rgb[1] + rgb[2]) / 3;
        for (let c = 0; c < 3; c++) rgb[c] = 255 * Math.pow(clamp((l + (rgb[c] - l) * 1.12) / 255, 0, 1), 0.9);
      } else {
        procColor(h, lat, rgb);
      }
      let r = rgb[0];
      let g = rgb[1];
      let b = rgb[2];
      const ocean = h <= 0.5 && (img ? b >= r && b >= g * 0.85 : h <= 0);
      if (ocean) {
        isOcean[k] = 1;
        isWater[k] = 1;
        kindTop[k] = K_WATER;
        Ht[k] = 0;
        const t = Math.sqrt(clamp(-h / 3000, 0, 1));
        r = r * 0.35 + (70 + (6 - 70) * t) * 0.65;
        g = g * 0.35 + (165 + (28 - 165) * t) * 0.65;
        b = b * 0.35 + (180 + (70 - 180) * t) * 0.65;
      } else {
        Ht[k] = Math.round((h * ex) / Q) * Q;
        veg[k] = g > r * 1.04 && g > b * 1.12 && (r + g + b) / 3 < 100 ? 1 : 0;
        const jit = 1 + (hash2(x * G + i, y * G + j + z * 7919) - 0.5) * 0.1;
        r *= jit;
        g *= jit;
        b *= jit;
      }
      top[k * 3] = r;
      top[k * 3 + 1] = g;
      top[k * 3 + 2] = b;
      side[k * 3] = r * 0.8 + 14;
      side[k * 3 + 1] = g * 0.78 + 8;
      side[k * 3 + 2] = b * 0.72;
    }
  }

  // Vector overlay: water, roads, buildings
  if (vec) {
    const win = {
      x0: (x / n) * 2 ** zv - (x >> dv),
      x1: ((x + 1) / n) * 2 ** zv - (x >> dv),
      y0: (y / n) * 2 ** zv - (y >> dv),
      y1: ((y + 1) / n) * 2 ** zv - (y >> dv),
    };
    const pad = 0.002;
    const qx0 = win.x0 - pad;
    const qx1 = win.x1 + pad;
    const qy0 = win.y0 - pad;
    const qy1 = win.y1 + pad;
    const carve = Math.min(Q, 4);
    const vecTileM = (EARTH_M * cosLat) / 2 ** zv;

    // water polygons and waterways
    {
      const mask = new Uint8Array(GR * GR);
      const wat = vec.water;
      wat.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        fillPoly(wat.list[idx].rings, win, (row, c0, c1) => {
          for (let c = c0; c <= c1; c++) mask[row * GR + c] = 1;
        });
      });
      const lineMask = new Uint8Array(GG);
      if (cellM <= 12) {
        const ww = vec.waterways;
        ww.ix.query(qx0, qy0, qx1, qy1, (idx) => {
          const it = ww.list[idx];
          strokeLine(it.lines, win, cellM, it.w / 2, (k) => {
            lineMask[k] = 1;
          });
        });
      }
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const k = j * G + i;
          if (isOcean[k]) continue;
          const m =
            mask[2 * j * GR + 2 * i] + mask[2 * j * GR + 2 * i + 1] + mask[(2 * j + 1) * GR + 2 * i] + mask[(2 * j + 1) * GR + 2 * i + 1];
          if (m < 2 && !lineMask[k]) continue;
          isWater[k] = 1;
          kindTop[k] = K_WATER;
          veg[k] = 0;
          Ht[k] -= carve;
          const jit = 1 + (hash2(x * G + i, y * G + j) - 0.5) * 0.05;
          top[k * 3] = (top[k * 3] * 0.3 + 40 * 0.7) * jit;
          top[k * 3 + 1] = (top[k * 3 + 1] * 0.3 + 100 * 0.7) * jit;
          top[k * 3 + 2] = (top[k * 3 + 2] * 0.3 + 150 * 0.7) * jit;
          side[k * 3] = top[k * 3] * 0.8;
          side[k * 3 + 1] = top[k * 3 + 1] * 0.8;
          side[k * 3 + 2] = top[k * 3 + 2] * 0.8;
        }
      }
    }

    // roads, rails and runways
    Hg.set(Ht);
    if (z >= ROAD_MINZ && cellM <= 60) {
      const prio = new Uint8Array(GG);
      const apply = (k, st, bridge) => {
        if (st.p < prio[k]) return;
        if (bridge) {
          if (isWater[k]) {
            Ht[k] += carve + (isOcean[k] ? 7 : 2.5);
            Ht[k] = Math.round(Ht[k] / Q) * Q;
            isWater[k] = 0;
            isOcean[k] = 0;
          }
        } else if (isWater[k]) return;
        prio[k] = st.p;
        const jit = 1 + (hash2(x * G + (k % G), y * G + ((k / G) | 0)) - 0.5) * 0.07;
        kindTop[k] = K_ROAD;
        veg[k] = 0;
        for (let c = 0; c < 3; c++) {
          top[k * 3 + c] = st.c[c] * jit;
          side[k * 3 + c] = st.c[c] * 0.82;
        }
      };
      const rd = vec.roads;
      rd.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        const it = rd.list[idx];
        if (cellM > it.st.maxCell) return;
        if (it.bridge && cellM <= BRIDGE_MAX_CELL) {
          bridges.push(it);
          return;
        }
        strokeLine(it.lines, win, cellM, it.w / 2, (k) => apply(k, it.st, it.bridge));
      });
      const al = vec.aeroLines;
      al.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        const it = al.list[idx];
        const st = ROAD_STYLE[it.cls];
        if (cellM > st.maxCell) return;
        strokeLine(it.lines, win, cellM, st.w / 2, (k) => apply(k, st, false));
      });
      const ap = vec.aeroPolys;
      const apMask = new Uint8Array(GR * GR);
      ap.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        fillPoly(ap.list[idx].rings, win, (row, c0, c1) => {
          for (let c = c0; c <= c1; c++) apMask[row * GR + c] = 1;
        });
      });
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const m =
            apMask[2 * j * GR + 2 * i] + apMask[2 * j * GR + 2 * i + 1] + apMask[(2 * j + 1) * GR + 2 * i] + apMask[(2 * j + 1) * GR + 2 * i + 1];
          if (m >= 2) apply(j * G + i, ROAD_STYLE.taxiway, false);
        }
    }

    // bridges: raised decks with open space (and piers) underneath
    for (const it of bridges) {
      const halfW = it.w / 2;
      const deckC = it.st.c;
      for (const ln of it.lines) {
        const np = ln.length / 2;
        if (np < 2) continue;
        const segLen = new Float64Array(np - 1);
        const segStart = new Float64Array(np - 1);
        let L = 0;
        for (let m = 0; m < np - 1; m++) {
          segStart[m] = L;
          segLen[m] = Math.hypot((ln[2 * m + 2] - ln[2 * m]) * vecTileM, (ln[2 * m + 3] - ln[2 * m + 1]) * vecTileM);
          L += segLen[m];
        }
        if (L < 4) continue;
        const real = (px, py) => px > -0.0145 && px < 1.0145 && py > -0.0145 && py < 1.0145;
        const startReal = real(ln[0], ln[1]);
        const endReal = real(ln[2 * np - 2], ln[2 * np - 1]);
        const cells = new Map();
        strokeLineS(ln, win, cellM, halfW, segStart, segLen, (k, s, perp) => {
          const c = cells.get(k);
          if (!c || perp < c.perp) cells.set(k, { s, perp });
        });
        if (!cells.size) continue;
        let maxLand = -Infinity;
        let maxWater = -Infinity;
        let maxG = -Infinity;
        let minG = Infinity;
        for (const k of cells.keys()) {
          const g = Hg[k];
          if (g > maxG) maxG = g;
          if (g < minG) minG = g;
          if (isWater[k]) {
            if (g > maxWater) maxWater = g;
          } else if (g > maxLand) maxLand = g;
        }
        let base;
        let target;
        if (maxWater > -Infinity) {
          target = Math.max(maxWater + 6, maxLand + 0.5);
          base = maxLand > -Infinity ? maxLand : target;
        } else if (maxG - minG > 5) {
          target = maxG + 0.6;
          base = target;
        } else {
          base = maxG;
          target = maxG + clamp(L * 0.12, 1.5, 5.5);
        }
        const ramp = clamp(L * 0.45, 12, 60);
        for (const [k, c] of cells) {
          const dEnd = Math.min(startReal ? c.s : Infinity, endReal ? L - c.s : Infinity);
          const r = clamp(dEnd / ramp, 0, 1);
          const deck = Math.max(Hg[k] + 0.35, base + (target - base) * r * r * (3 - 2 * r));
          const thick = Math.min(1.3, Math.max(0.5, deck - Hg[k]));
          let lo = deck - thick;
          if (deck - Hg[k] > 3.2 && cellM <= BRIDGE_MAX_CELL && c.perp <= 0.5) {
            const ph = (c.s + 20) % 40;
            if (Math.abs(ph - 20) <= cellM * 0.5) lo = Hg[k] - 1;
          }
          putSlab(k, lo, deck, deckC, CONCRETE, K_ROAD, K_ROOF, true);
        }
      }
    }

    // buildings
    if (z >= BUILDING_MINZ) {
      const bl = vec.buildings;
      const bh = new Float32Array(GR * GR);
      const bsrc = new Int32Array(GR * GR).fill(-1);
      bl.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        const it = bl.list[idx];
        const hh = it.h;
        fillPoly(it.rings, win, (row, c0, c1) => {
          for (let c = c0; c <= c1; c++) {
            const q = row * GR + c;
            if (hh > bh[q]) {
              bh[q] = hh;
              bsrc[q] = idx;
            }
          }
        });
      });
      const minCover = cellM > 6 ? 1 : 2;
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const k = j * G + i;
          let cover = 0;
          let best = 0;
          let bi = -1;
          for (let sy = 0; sy < SS; sy++)
            for (let sx = 0; sx < SS; sx++) {
              const q = (j * SS + sy) * GR + i * SS + sx;
              if (bh[q] > 0) {
                cover++;
                if (bh[q] > best) {
                  best = bh[q];
                  bi = bsrc[q];
                }
              }
            }
          if (cover >= minCover && bi >= 0) bIdx[k] = bi;
        }
      }

      // lowest ground per building in this tile, so window rows line up
      const baseOf = new Map();
      for (let k = 0; k < GG; k++) {
        const bi = bIdx[k];
        if (bi < 0) continue;
        const cur = baseOf.get(bi);
        if (cur === undefined || Ht[k] < cur) baseOf.set(bi, Ht[k]);
      }

      // distance (in columns) to the building edge, for roof shaping
      const ed = new Uint8Array(GG).fill(255);
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const k = j * G + i;
          const bi = bIdx[k];
          if (bi < 0) continue;
          if (
            (i > 0 && bIdx[k - 1] !== bi) ||
            (i < G - 1 && bIdx[k + 1] !== bi) ||
            (j > 0 && bIdx[k - G] !== bi) ||
            (j < G - 1 && bIdx[k + G] !== bi)
          )
            ed[k] = 0;
        }
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const k = j * G + i;
          if (bIdx[k] < 0) continue;
          if (i > 0 && bIdx[k - 1] === bIdx[k]) ed[k] = Math.min(ed[k], ed[k - 1] + 1);
          if (j > 0 && bIdx[k - G] === bIdx[k]) ed[k] = Math.min(ed[k], ed[k - G] + 1);
        }
      for (let j = G - 1; j >= 0; j--)
        for (let i = G - 1; i >= 0; i--) {
          const k = j * G + i;
          if (bIdx[k] < 0) continue;
          if (i < G - 1 && bIdx[k + 1] === bIdx[k]) ed[k] = Math.min(ed[k], ed[k + 1] + 1);
          if (j < G - 1 && bIdx[k + G] === bIdx[k]) ed[k] = Math.min(ed[k], ed[k + G] + 1);
        }

      const detail = cellM <= 2.5;
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const k = j * G + i;
          const bi = bIdx[k];
          if (bi < 0) continue;
          const it = bl.list[bi];
          const height = it.h;
          const dimM = Math.min((it.maxx - it.minx) * vecTileM, (it.maxy - it.miny) * vecTileM);
          let hb = Math.max(BQ, Math.round(height / BQ) * BQ);
          let roofExtra = 0;
          let pitched = false;
          if (detail && height < 16 && dimM < 32 && dimM > 4) {
            const ridge = Math.min(3.6, 0.32 * dimM);
            if (ridge >= BQ) {
              pitched = true;
              roofExtra = Math.round(Math.min(ridge, ed[k] * cellM * 0.7) / BQ) * BQ;
              hb = Math.max(BQ, Math.round((height - ridge) / BQ) * BQ);
            }
          } else if (detail && ed[k] === 0 && height >= 4) {
            roofExtra = Math.max(BQ, 0.8); // parapet
          }
          const hv = hash2(it.id, 17);
          const glass = height > 45;
          const wallC = it.col || (glass ? GLASS[(hv * GLASS.length) | 0] : WALLS[(hv * WALLS.length) | 0]);
          const roofC = glass ? [96, 106, 118] : ROOFS[(hash2(it.id, 91) * ROOFS.length) | 0];
          const jit = 1 + (hash2(x * G + i, y * G + j) - 0.5) * 0.06;
          bBase[k] = baseOf.get(bi);
          bVar[k] = (hv * 255) | 0;
          bRnd[k] = (hash2(it.id, 5) * 255) | 0;
          let topC = roofC;
          if (detail && !pitched && ed[k] >= 2 && cellM <= 1.5) {
            // rooftop equipment
            const mx = Math.floor(((x * G + i) * cellM) / 3);
            const my = Math.floor(((y * G + j) * cellM) / 3);
            if (hash2(mx + it.id, my) < 0.05) {
              roofExtra += 1.4;
              topC = [150, 152, 156];
            }
          }
          Ht[k] += hb + roofExtra;
          kindTop[k] = K_ROOF;
          veg[k] = 0;
          for (let c = 0; c < 3; c++) {
            top[k * 3 + c] = topC[c] * jit;
            side[k * 3 + c] = wallC[c] * jit;
            roofCol[k * 3 + c] = roofC[c] * jit;
          }
        }
      }

      const lf = vec.lifted;
      const cover = new Uint8Array(GG);
      lf.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        const it = lf.list[idx];
        cover.fill(0);
        fillPoly(it.rings, win, (row, c0, c1) => {
          const rj = (row / SS) | 0;
          for (let c = c0; c <= c1; c++) cover[rj * G + ((c / SS) | 0)]++;
        });
        const glass = it.h > 45;
        const hv = hash2(it.id, 17);
        const wallC = it.col || (glass ? GLASS[(hv * GLASS.length) | 0] : WALLS[(hv * WALLS.length) | 0]);
        const roofC = glass ? [96, 106, 118] : ROOFS[(hash2(it.id, 91) * ROOFS.length) | 0];
        for (let k = 0; k < GG; k++) {
          if (cover[k] < minCover) continue;
          putSlab(k, Hg[k] + it.lo, Hg[k] + it.h, roofC, wallC, K_ROOF, K_WALL, false);
        }
      });

      // open-frame structures: pillars loft between levels, drawn with the steel lattice shader
      const fr = vec.frames;
      fr.ix.query(qx0, qy0, qx1, qy1, (idx) => {
        const it = fr.list[idx];
        const col = it.col || FRAME_STEEL;
        const span = it.hi - it.lo;
        const slices = it.loft && it.loft.some(Boolean) ? clamp(Math.ceil(span / Math.max(cellM * 1.5, 2)), 3, 40) : 1;
        for (let s = 0; s < slices; s++) {
          const t0 = s / slices;
          const t1 = (s + 1) / slices;
          let rings = it.rings;
          if (slices > 1) {
            const tm = (t0 + t1) / 2;
            rings = it.outers.map((o) => {
              const tg = it.loft[it.outers.indexOf(o)];
              if (!tg) return o.ring;
              const sc = 1 + (tg.size / o.size - 1) * tm;
              const cx = o.cx + (tg.cx - o.cx) * tm;
              const cy = o.cy + (tg.cy - o.cy) * tm;
              const out = new Float32Array(o.ring.length);
              for (let q = 0; q < out.length; q += 2) {
                out[q] = cx + (o.ring[q] - o.cx) * sc;
                out[q + 1] = cy + (o.ring[q + 1] - o.cy) * sc;
              }
              return out;
            });
          }
          cover.fill(0);
          fillPoly(rings, win, (row, c0, c1) => {
            const rj = (row / SS) | 0;
            for (let c = c0; c <= c1; c++) cover[rj * G + ((c / SS) | 0)]++;
          });
          const lo = it.lo + t0 * span;
          const hi = it.lo + t1 * span;
          for (let k = 0; k < GG; k++) {
            if (cover[k] < minCover) continue;
            putSlab(k, Hg[k] + (it.lo < LIFT_MIN && s === 0 ? 0 : lo), Hg[k] + hi, col, col, K_ROOF, K_LATTICE, false);
          }
        }
      });
    }
  }

  // collision heights/flags before trees go on top
  for (let k = 0; k < GG; k++) {
    Hc[k] = sDeck[k] ? Math.max(Ht[k], sHi[k]) : Ht[k];
    flags[k] = isWater[k] && !sDeck[k] ? 1 : 0;
  }

  // trees: dark-green imagery pixels grow noisy canopies
  let treeCount = 0;
  if (cellM <= TREE_MAX_CELL && img) {
    const treeQ = Math.max(BQ * 0.5, 0.5);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = j * G + i;
        if (!veg[k] || kindTop[k] !== K_TERRAIN) continue;
        const gx = (x * G + i) * cellM;
        const gy = (y * G + j) * cellM * cosLat;
        const nse = vnoise(gx / 6.5, gy / 6.5) * 0.6 + vnoise(gx / 2.4, gy / 2.4) * 0.4;
        if (nse < 0.4) continue;
        treeCount++;
        if (!withTrees) continue;
        const th = Math.round((2.5 + 17.6 * (nse - 0.4) + hash2(i + x * G, j + y * G) * 1.5) / treeQ) * treeQ;
        Ht[k] += th;
        kindTop[k] = K_TREE;
        const lf = 0.85 + nse * 0.5;
        top[k * 3] = clamp(top[k * 3] * lf * 0.9, 0, 255);
        top[k * 3 + 1] = clamp(top[k * 3 + 1] * lf * 1.2 + 6, 0, 255);
        top[k * 3 + 2] = clamp(top[k * 3 + 2] * lf * 0.85, 0, 255);
        side[k * 3] = top[k * 3] * 0.7;
        side[k * 3 + 1] = top[k * 3 + 1] * 0.75;
        side[k * 3 + 2] = top[k * 3 + 2] * 0.7;
      }
    }
  }

  // ambient occlusion from the height field (horizon sampling at several metre scales)
  const colAO = new Float32Array(GG);
  {
    const steps = [];
    for (const m of [1, 2.5, 5, 10, 20]) {
      const s = Math.max(1, Math.round(m / cellM));
      if (!steps.includes(s) && s < G) steps.push(s);
    }
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const k = j * G + i;
        const h = Ht[k];
        let sum = 0;
        for (const [dx, dy, dl] of AO_DIRS) {
          let best = 0;
          for (const s of steps) {
            const ni = i + dx * s;
            const nj = j + dy * s;
            if (ni < 0 || nj < 0 || ni >= G || nj >= G) break;
            const dh = Ht[nj * G + ni] - h;
            if (dh <= 0) continue;
            const o = dh / Math.hypot(dh, s * cellM * dl);
            if (o > best) best = o;
          }
          sum += best;
        }
        colAO[k] = clamp(Math.pow(sum / 8, 0.85) * 1.5, 0, 0.88);
      }
    }
  }

  // --- mesh ---------------------------------------------------------------
  let vc = 0;
  let ic = 0;
  let minH = Infinity;
  let maxH = -Infinity;

  const vert = (ci, cj, h, c, kind, ao, a, b, u, v) => {
    const d = (cj * cs + ci) * 3;
    const rad = R + h;
    const o = vc * 3;
    posBuf[o] = dirs[d] * rad - cx;
    posBuf[o + 1] = dirs[d + 1] * rad - cy;
    posBuf[o + 2] = dirs[d + 2] * rad - cz;
    clrBuf[o] = c[0];
    clrBuf[o + 1] = c[1];
    clrBuf[o + 2] = c[2];
    const q = vc * 4;
    auxBuf[q] = kind;
    auxBuf[q + 1] = clamp(ao, 0, 1) * 255;
    auxBuf[q + 2] = a;
    auxBuf[q + 3] = b;
    wuvBuf[vc * 2] = u;
    wuvBuf[vc * 2 + 1] = v;
    return vc++;
  };
  const tri = (a, b, c) => {
    idxBuf[ic++] = a;
    idxBuf[ic++] = b;
    idxBuf[ic++] = c;
  };

  const skirt = Math.max(3 * Q, cellM * 0.35);
  const colC = [0, 0, 0];
  const vv = [0, 0, 0, 0];
  const aoV = [0, 0, 0, 0];

  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      const h = Ht[k];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      const kind = kindTop[k];
      const isB = bIdx[k] >= 0;
      const va0 = isB ? bVar[k] : 0;
      const vb0 = isB ? bRnd[k] : tileRand;

      // top face with per-vertex AO (self + lower-or-equal neighbours around the corner)
      colC[0] = top[k * 3];
      colC[1] = top[k * 3 + 1];
      colC[2] = top[k * 3 + 2];
      for (let q = 0; q < 4; q++) {
        const ci = CORN[q][0];
        const cj = CORN[q][1];
        const sdi = ci ? 1 : -1;
        const sdj = cj ? 1 : -1;
        let s = colAO[k];
        let cnt = 1;
        for (let m = 0; m < 3; m++) {
          const ni = i + (m === 1 ? 0 : sdi);
          const nj = j + (m === 0 ? 0 : sdj);
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          const nk = nj * G + ni;
          if (Ht[nk] <= h + 1e-3) {
            s += colAO[nk];
            cnt++;
          }
        }
        aoV[q] = 1 - s / cnt;
        vv[q] = vert(i + ci, j + cj, h, colC, kind, aoV[q], va0, vb0, (i + ci) * cellM, (j + cj) * cellM);
      }
      // corners are a=0, b=1, c=2, d=3; winding a, d, c, b. Split along the diagonal with the smoother AO.
      if (aoV[0] + aoV[2] >= aoV[1] + aoV[3]) {
        tri(vv[0], vv[3], vv[2]);
        tri(vv[0], vv[2], vv[1]);
      } else {
        tri(vv[3], vv[2], vv[1]);
        tri(vv[3], vv[1], vv[0]);
      }

      // side walls where the neighbour is lower
      for (const s of SIDES) {
        const ni = i + s.di;
        const nj = j + s.dj;
        const outside = ni < 0 || nj < 0 || ni >= G || nj >= G;
        const nk = outside ? -1 : nj * G + ni;
        const nh = outside ? h - skirt : Ht[nk];
        if (h <= nh) continue;
        const p = CORN[s.c[0]];
        const q = CORN[s.c[1]];
        let wkind = kind === K_ROAD || kind === K_WATER ? K_TERRAIN : kind;
        let cols = side;
        if (isB) {
          if (nk >= 0 && bIdx[nk] === bIdx[k]) {
            wkind = K_ROOF; // step inside one building = roof
            cols = roofCol;
          } else {
            wkind = K_WALL;
          }
        }
        colC[0] = cols[k * 3];
        colC[1] = cols[k * 3 + 1];
        colC[2] = cols[k * 3 + 2];
        const horiz = s.di !== 0;
        const base = isB ? bBase[k] : nh;
        const lowAO = outside ? 1 : 1 - Math.min(0.85, colAO[nk] + Math.min(0.3, (h - nh) * 0.03));
        const u0 = (horiz ? j + p[1] : i + p[0]) * cellM;
        const u1 = (horiz ? j + q[1] : i + q[0]) * cellM;
        const w0 = vert(i + p[0], j + p[1], nh, colC, wkind, lowAO, va0, vb0, u0, nh - base);
        const w1 = vert(i + q[0], j + q[1], nh, colC, wkind, lowAO, va0, vb0, u1, nh - base);
        const w2 = vert(i + q[0], j + q[1], h, colC, wkind, 1, va0, vb0, u1, h - base);
        const w3 = vert(i + p[0], j + p[1], h, colC, wkind, 1, va0, vb0, u0, h - base);
        tri(w0, w1, w2);
        tri(w0, w2, w3);
      }
    }
  }

  // floating slabs
  const slabC = [0, 0, 0];
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const k = j * G + i;
      if (!sHas[k]) continue;
      if (vc + 28 > 65000 || ic + 66 > idxBuf.length || vc + 28 > MAXV) break;
      const lo = sLo[k];
      const hi = sHi[k];
      if (hi > maxH) maxH = hi;
      if (lo < minH) minH = lo;
      const topK = sTopK[k];
      const sideK = sSideK[k];
      slabC[0] = sTopC[k * 3];
      slabC[1] = sTopC[k * 3 + 1];
      slabC[2] = sTopC[k * 3 + 2];
      for (let q = 0; q < 4; q++)
        vv[q] = vert(i + CORN[q][0], j + CORN[q][1], hi, slabC, topK, 1, 0, tileRand, (i + CORN[q][0]) * cellM, (j + CORN[q][1]) * cellM);
      tri(vv[0], vv[3], vv[2]);
      tri(vv[0], vv[2], vv[1]);

      if (lo > Hg[k] + 0.3 && !(bIdx[k] >= 0 && Ht[k] >= lo - 0.05)) {
        slabC[0] = sSideC[k * 3] * 0.65;
        slabC[1] = sSideC[k * 3 + 1] * 0.65;
        slabC[2] = sSideC[k * 3 + 2] * 0.65;
        for (let q = 0; q < 4; q++)
          vv[q] = vert(i + CORN[q][0], j + CORN[q][1], lo, slabC, K_ROOF, 0.7, 0, tileRand, (i + CORN[q][0]) * cellM, (j + CORN[q][1]) * cellM);
        tri(vv[0], vv[1], vv[2]);
        tri(vv[0], vv[2], vv[3]);
      }

      slabC[0] = sSideC[k * 3];
      slabC[1] = sSideC[k * 3 + 1];
      slabC[2] = sSideC[k * 3 + 2];
      for (const s of SIDES) {
        const ni = i + s.di;
        const nj = j + s.dj;
        const nk = ni < 0 || nj < 0 || ni >= G || nj >= G ? -1 : nj * G + ni;
        const spans = [];
        if (nk >= 0 && sHas[nk]) {
          if (hi > sHi[nk] + 0.01) spans.push([Math.max(lo, sHi[nk]), hi]);
          if (lo < sLo[nk] - 0.01) spans.push([lo, Math.min(hi, sLo[nk])]);
        } else {
          spans.push([lo, hi]);
        }
        const p = CORN[s.c[0]];
        const q = CORN[s.c[1]];
        const horiz = s.di !== 0;
        const u0 = (horiz ? j + p[1] : i + p[0]) * cellM;
        const u1 = (horiz ? j + q[1] : i + q[0]) * cellM;
        for (const [y0, y1] of spans) {
          if (y1 - y0 < 0.02) continue;
          const w0 = vert(i + p[0], j + p[1], y0, slabC, sideK, 0.9, 0, tileRand, u0, y0);
          const w1 = vert(i + q[0], j + q[1], y0, slabC, sideK, 0.9, 0, tileRand, u1, y0);
          const w2 = vert(i + q[0], j + q[1], y1, slabC, sideK, 1, 0, tileRand, u1, y1);
          const w3 = vert(i + p[0], j + p[1], y1, slabC, sideK, 1, 0, tileRand, u0, y1);
          tri(w0, w1, w2);
          tri(w0, w2, w3);
        }
      }
    }
  }

  const bytes = bytesFetched;
  bytesFetched = 0;
  return {
    pos: posBuf.slice(0, vc * 3),
    clr: clrBuf.slice(0, vc * 3),
    aux: auxBuf.slice(0, vc * 4),
    wuv: wuvBuf.slice(0, vc * 2),
    idx: idxBuf.slice(0, ic),
    heights: Ht,
    collide: Hc,
    flags,
    minH,
    maxH,
    center: [cx, cy, cz],
    bytes,
    treeCount,
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    cfg = m.cfg;
    return;
  }
  if (m.type === 'build') {
    try {
      const result = await buildTile(m.z, m.x, m.y, !!m.trees);
      self.postMessage({ id: m.id, result }, [
        result.pos.buffer,
        result.clr.buffer,
        result.aux.buffer,
        result.wuv.buffer,
        result.idx.buffer,
        result.heights.buffer,
        result.collide.buffer,
        result.flags.buffer,
      ]);
    } catch (err) {
      self.postMessage({ id: m.id, error: String(err && err.message ? err.message : err) });
    }
  }
};
