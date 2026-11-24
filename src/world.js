import * as THREE from 'three';
import { R, DEG, G, MAX_LAT, heightScale, tileToLat, tileToLon, llToDir } from './geo.js';

const NONE = 0;
const LOADING = 1;
const READY = 2;
const FAILED = 3;
const TREES_NONE = 0;
const TREES_PENDING = 1;
const TREES_LOADING = 2;

// The same tiles are served from several hostnames; browsers cap HTTP/1.1 at 6 connections per host,
// so alternating between aliases doubles the download concurrency.
const SOURCES = {
  terrain: [
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
  ],
  imagery: [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  ],
};
const TILEJSON = 'https://tiles.openfreemap.org/planet';

const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();

const FADE_T = 0.35; // seconds for a tile swap cross-fade
const WIDE = 1.3; // tiles are selected against a frustum this much wider than the view, so turning never exposes unloaded tiles
const LEAD_T = 1.2; // seconds of camera rotation to look ahead while turning
const TURN_HOLD = 1.5; // seconds for the measured turn rate to decay
const MAX_LEAD = 1.0; // radians added to the half field of view at most
const MAX_HALF_FOV = 1.45; // radians; keeps the wide projection finite
const SPLIT_HYST = 0.7; // a split tile merges back only below this fraction of the split threshold
const PREFETCH = 0.8; // children are requested once a tile is this close to its split threshold
const UPLOAD_BUDGET = 3 * 1048576; // bytes of never-drawn meshes that may enter the scene per frame

// Called per mesh at draw time: only cross-fading meshes use the material that reads uFade.
function fadeBefore(renderer, scene, camera, geometry, material) {
  const u = material.uniforms && material.uniforms.uFade;
  if (!u) return;
  u.value.set(this.userData.fx, this.userData.fdir);
  material.uniformsNeedUpdate = true;
}

// Fills the voxel-shader attributes for simple generated meshes (base sphere, polar caps).
function addFlatAttributes(geo, color) {
  const n = geo.attributes.position.count;
  if (color) {
    const c = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) c.set(color, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3, true));
  }
  const aux = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) aux[i * 4 + 1] = 255;
  geo.setAttribute('aux', new THREE.BufferAttribute(aux, 4));
  geo.setAttribute('wuv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
}

class TileNode {
  constructor(z, x, y, parent) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.parent = parent;
    this.children = null;
    this.state = NONE;
    this.mesh = null;
    this.treeState = TREES_NONE;
    this.heights = null;
    this.collide = null;
    this.flags = null;
    this.bytes = 0;
    this.lastUsed = 0;
    this.retryAt = 0;
    this.split = false; // last LOD decision: children drawn instead of this tile
    this.lockUntil = 0; // no LOD change before this time (lets a cross-fade finish)
    this.a = 1; // fade-in level while the tile is being swapped in
    this.shown = false;
    this.settled = false; // has been fully faded in before; returning to view then needs no fade
    this.ghost = false;
    this.drawFrame = -1;
    this.coverFrame = -1;
    this.coverNode = null;
    this.tf = null; // vegetation cross-fade { old mesh, a }

    const n = 2 ** z;
    this.u0 = x / n;
    this.u1 = (x + 1) / n;
    this.v0 = y / n;
    this.v1 = (y + 1) / n;
    const lat = tileToLat(y + 0.5, n);
    const lon = tileToLon(x + 0.5, n);
    const d = llToDir(lat, lon);
    this.dir = new THREE.Vector3(d[0], d[1], d[2]);
    this.center = this.dir.clone().multiplyScalar(R);
    this.cellM = (2 * Math.PI * R * Math.cos(lat * DEG)) / n / G;

    // Boundary samples (corners and edge midpoints): corners alone under-estimate the extent of huge tiles.
    let radius = 0;
    let ang = 0;
    for (const [fx, fy] of [
      [x, y],
      [x + 0.5, y],
      [x + 1, y],
      [x, y + 0.5],
      [x + 1, y + 0.5],
      [x, y + 1],
      [x + 0.5, y + 1],
      [x + 1, y + 1],
    ]) {
      const c = llToDir(tileToLat(fy, n), tileToLon(fx, n));
      _v.set(c[0], c[1], c[2]).multiplyScalar(R).sub(this.center);
      radius = Math.max(radius, _v.length());
      ang = Math.max(ang, Math.acos(Math.min(1, Math.max(-1, this.dir.x * c[0] + this.dir.y * c[1] + this.dir.z * c[2]))));
    }
    this.radius = radius;
    const margin = 10000 * heightScale(z) + 200;
    this.cullRadius = radius + margin;
    this.angRad = Math.max(this.cullRadius / R, ang + margin / R);
  }

  getChildren() {
    if (!this.children) {
      const z = this.z + 1;
      const x = this.x * 2;
      const y = this.y * 2;
      this.children = [
        new TileNode(z, x, y, this),
        new TileNode(z, x + 1, y, this),
        new TileNode(z, x, y + 1, this),
        new TileNode(z, x + 1, y + 1, this),
      ];
    }
    return this.children;
  }
}

export class World {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.maxZ = opts.maxZ ?? 21;
    this.pxThreshold = opts.pxThreshold ?? 6;
    this.maxReady = opts.maxReady ?? 8000;
    this.maxBytes = opts.maxBytes ?? (navigator.deviceMemory >= 8 ? 1400 : 900) * 1048576;
    this.gpuBytes = 0;
    this.maxInflight = opts.maxInflight ?? 24;
    this.keepRadius = 0; // tiles closer than this stay drawn even outside the frustum (shadow casters)

    this.group = new THREE.Group();
    scene.add(this.group);
    this.material = opts.material;
    this.fadeMaterial = opts.fadeMaterial;
    this.capMaterial = opts.capMaterial;
    this.root = new TileNode(0, 0, 0, null);
    this.frame = 0;
    this.drawn = [];
    this.ghosts = []; // { node, cover } tiles still fading out underneath their replacements
    this.treeGhosts = []; // { mesh, tf } plain meshes fading out under their vegetation version
    this.treeQueue = [];
    this.uploadUsed = 0;
    this.nowS = performance.now() / 1000;
    this.dt = 0.016;
    this.wanted = [];
    this.vegWanted = [];
    this.inflightVeg = 0;
    this.maxVeg = opts.maxVeg ?? 4;
    this.ready = new Set();
    this.inflight = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.frustum = new THREE.Frustum();
    this.frustumWide = new THREE.Frustum();
    this.projView = new THREE.Matrix4();
    this.projWide = new THREE.Matrix4();
    this.prevQuat = null;
    this.turnRate = 0;
    this.stats = { drawn: 0, ready: 0, inflight: 0, wanted: 0, bytes: 0, tris: 0 };
    this.ground = { height: null, z: 0 };
    this.lastEvict = 0;

    this.buildBase();
    this.startWorkers();
  }

  async startWorkers() {
    let vector = null;
    try {
      const tj = await (await fetch(TILEJSON)).json();
      vector = tj.tiles[0];
    } catch (e) {
      console.warn('OpenFreeMap TileJSON unavailable, buildings/water disabled', e);
    }
    const cfg = { ...SOURCES, vector };
    const count = Math.max(2, Math.min(12, (navigator.hardwareConcurrency || 4) - 4));
    // Tile builds are CPU-bound once imagery is cached, so the slot count follows the worker count.
    if (this.opts.maxInflight === undefined) this.maxInflight = count * 5;
    if (this.opts.maxVeg === undefined) this.maxVeg = Math.max(4, count >> 1);
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', cfg });
      w.onmessage = (e) => this.onResult(e.data);
      this.workers.push(w);
    }
  }

  buildBase() {
    // Dark sphere just under the surface so cracks never show the sky.
    const baseGeo = new THREE.SphereGeometry(R - 2500, 192, 96);
    baseGeo.deleteAttribute('normal');
    baseGeo.deleteAttribute('uv');
    addFlatAttributes(baseGeo, [34, 46, 62]);
    const base = new THREE.Mesh(baseGeo, this.material);
    base.frustumCulled = false;
    base.layers.set(1); // not a shadow caster
    this.base = base;
    this.group.add(base);

    // Polar caps beyond the web-mercator limit.
    const capMat = this.capMaterial;
    this.caps = [1, -1].map((sgn) => {
      const h = sgn > 0 ? 0 : 2500;
      const seg = 96;
      const pos = [];
      const clr = [];
      const idx = [];
      const centerPt = [0, sgn * R, 0];
      const push = (p, n, c) => {
        pos.push(p[0] - centerPt[0], p[1] - centerPt[1], p[2] - centerPt[2]);
        clr.push(c[0], c[1], c[2]);
        return pos.length / 3 - 1;
      };
      const white = [232, 238, 245];
      const pole = push([0, sgn * (R + h), 0], [0, sgn, 0], white);
      const ringTop = [];
      const wallTop = [];
      const wallBot = [];
      for (let k = 0; k <= seg; k++) {
        const d = llToDir(sgn * MAX_LAT, (k / seg) * 360 - 180);
        const o = d.map((v) => v * (R + h));
        const o2 = d.map((v) => v * (R + h - 3000));
        const horiz = [d[0], 0, d[2]];
        ringTop.push(push(o, [0, sgn, 0], white));
        wallTop.push(push(o, horiz, [190, 205, 220]));
        wallBot.push(push(o2, horiz, [190, 205, 220]));
      }
      for (let k = 0; k < seg; k++) {
        idx.push(pole, ringTop[k], ringTop[k + 1]);
        idx.push(wallTop[k], wallBot[k], wallBot[k + 1]);
        idx.push(wallTop[k], wallBot[k + 1], wallTop[k + 1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(clr), 3, true));
      addFlatAttributes(g);
      g.setIndex(idx);
      const m = new THREE.Mesh(g, capMat);
      m.frustumCulled = false;
      m.layers.set(1);
      m.userData.anchor = new THREE.Vector3(centerPt[0], centerPt[1], centerPt[2]);
      this.group.add(m);
      return m;
    });
  }

  workerFor(node) {
    const s = Math.max(0, node.z - 16);
    const h = ((node.x >> s) * 73856093) ^ ((node.y >> s) * 19349663) ^ (Math.min(node.z, 16) * 83492791);
    return this.workers[(h >>> 0) % this.workers.length];
  }

  // Lower score = loaded sooner. Tiles ahead of the camera win over the ones to the side or behind,
  // and tiles outside the view (kept only as shadow casters) go last.
  score(node, ctx) {
    _v.copy(node.center).sub(ctx.camPos);
    const dist = Math.max(1, _v.length() - 0.8 * node.radius);
    const cosA = dist > 1 ? _v.dot(ctx.fwd) / Math.max(1, _v.length()) : 1;
    let s = dist * (1 + 2.5 * (1 - cosA));
    _sphere.center.copy(_v);
    _sphere.radius = node.radius;
    if (!this.frustum.intersectsSphere(_sphere)) s = s * 4 + 500;
    return s;
  }

  request(node, ctx, prefetch = false) {
    if (node.state === READY || node.state === LOADING) return;
    if (node.state === FAILED && performance.now() < node.retryAt) return;
    this.wanted.push({ node, d: this.score(node, ctx) * (prefetch ? 2 : 1) });
  }

  dispatch() {
    if (!this.workers) return;
    this.wanted.sort((a, b) => a.d - b.d);
    this.vegWanted.sort((a, b) => a.d - b.d);
    this.pump();
  }

  // Fills free worker slots from the already-sorted wanted lists; also called when a result frees a slot,
  // so throughput does not depend on the frame rate.
  pump() {
    let starved = false;
    for (const { node } of this.wanted) {
      if (this.inflight >= this.maxInflight) {
        starved = true;
        break;
      }
      if (node.state === READY || node.state === LOADING) continue;
      const id = this.nextId++;
      node.state = LOADING;
      this.pending.set(id, node);
      this.inflight++;
      this.workerFor(node).postMessage({ type: 'build', id, z: node.z, x: node.x, y: node.y, trees: false });
    }
    // Vegetation is rebuilt only once every wanted base tile has a worker slot, and only in a few slots.
    if (starved) return;
    for (const { node } of this.vegWanted) {
      if (this.inflightVeg >= this.maxVeg || this.inflight >= this.maxInflight) break;
      if (node.state !== READY || node.treeState !== TREES_PENDING) continue;
      const id = this.nextId++;
      node.treeState = TREES_LOADING;
      this.pending.set(id, node);
      this.inflight++;
      this.inflightVeg++;
      this.workerFor(node).postMessage({ type: 'build', id, z: node.z, x: node.x, y: node.y, trees: true });
    }
  }

  makeMesh(node, r) {
    const g = new THREE.BufferGeometry();
    const attrs = [
      new THREE.BufferAttribute(r.pos, 3),
      new THREE.BufferAttribute(r.clr, 3, true),
      new THREE.BufferAttribute(r.aux, 4),
      new THREE.BufferAttribute(r.wuv, 2),
      new THREE.BufferAttribute(r.idx, 1),
    ];
    // free the CPU copies once uploaded; the bounding sphere is set by hand below
    for (const a of attrs) a.onUpload(() => (a.array = null));
    g.setAttribute('position', attrs[0]);
    g.setAttribute('color', attrs[1]);
    g.setAttribute('aux', attrs[2]);
    g.setAttribute('wuv', attrs[3]);
    g.setIndex(attrs[4]);
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      node.radius + Math.max(Math.abs(r.minH), Math.abs(r.maxH)) + 50,
    );
    const mesh = new THREE.Mesh(g, this.material);
    mesh.visible = false;
    mesh.userData.center = new THREE.Vector3(r.center[0], r.center[1], r.center[2]);
    mesh.userData.fx = 1;
    mesh.userData.fdir = 1;
    mesh.userData.up = false;
    mesh.onBeforeRender = fadeBefore;
    this.group.add(mesh);
    node.mesh = mesh;
    node.heights = r.heights;
    node.tris = r.idx.length / 3;
    const bytes = r.pos.byteLength + r.clr.byteLength + r.aux.byteLength + r.wuv.byteLength + r.idx.byteLength;
    this.gpuBytes += bytes - node.bytes;
    node.bytes = bytes;
  }

  onResult(msg) {
    this.handleResult(msg);
    if (this.workers) this.pump();
  }

  handleResult(msg) {
    const node = this.pending.get(msg.id);
    if (!node) return;
    this.pending.delete(msg.id);
    this.inflight--;
    const vegPass = node.treeState === TREES_LOADING;
    if (vegPass) {
      this.inflightVeg--;
      node.treeState = TREES_NONE;
      if (msg.error || node.state !== READY) return; // the plain tile stays; no retry for trees
      this.treeQueue.push({ node, result: msg.result });
      this.stats.bytes += msg.result.bytes;
      return;
    }
    if (msg.error) {
      console.warn('tile failed', node.z, node.x, node.y, msg.error);
      node.state = FAILED;
      node.retryAt = performance.now() + 3000;
      return;
    }
    const r = msg.result;
    this.makeMesh(node, r);
    node.collide = r.collide;
    node.flags = r.flags;
    node.treeState = r.treeCount > 0 ? TREES_PENDING : TREES_NONE;
    node.state = READY;
    node.lastUsed = this.frame;
    this.ready.add(node);
    this.stats.bytes += r.bytes;
  }

  // Swaps in the vegetation version of a tile; a tile that is on screen and settled cross-fades from its plain mesh.
  applyTrees(node, r) {
    if (node.state !== READY || !node.mesh) return;
    const old = node.mesh;
    const settled = this.fadeMaterial && node.shown && node.a >= 1 && !node.tf && !node.ghost;
    this.gpuBytes -= node.bytes;
    node.bytes = 0;
    this.makeMesh(node, r);
    if (settled) {
      node.tf = { old, a: 0 };
      node.lockUntil = this.nowS + FADE_T;
      this.treeGhosts.push({ mesh: old, tf: node.tf, node });
    } else {
      this.group.remove(old);
      old.geometry.dispose();
    }
  }

  evict() {
    if (this.ready.size <= this.maxReady && this.gpuBytes <= this.maxBytes) return;
    // Finest tiles go first (oldest first within a level) and only leaves are evictable (a tile that still has a loaded
    // child stays). A turned-away view therefore keeps a coarse-to-mid pyramid and refines in a moment when you turn
    // back, instead of dropping to the lowest LOD while whole regions reload.
    const hasReadyKid = (n) => !!n.children && n.children.some((k) => k.state === READY);
    let excess = this.ready.size - Math.floor(this.maxReady * 0.85);
    let overBytes = this.gpuBytes - this.maxBytes * 0.85;
    for (let pass = 0; pass < 8 && (excess > 0 || overBytes > 0); pass++) {
      const old = [...this.ready]
        .filter((n) => n.lastUsed < this.frame - 5 && n.treeState !== TREES_LOADING && !n.ghost && !n.tf && !hasReadyKid(n))
        .sort((a, b) => b.z - a.z || a.lastUsed - b.lastUsed);
      if (!old.length) break;
      for (const n of old) {
        if (excess <= 0 && overBytes <= 0) break;
        excess--;
        overBytes -= n.bytes;
        this.gpuBytes -= n.bytes;
        this.group.remove(n.mesh);
        n.mesh.geometry.dispose();
        n.mesh = null;
        n.heights = null;
        n.collide = null;
        n.flags = null;
        n.bytes = 0;
        n.state = NONE;
        n.treeState = TREES_NONE;
        n.shown = false;
        n.settled = false;
        n.split = false;
        n.a = 1;
        this.ready.delete(n);
      }
    }
  }

  // Deepest ready tile column under (u,v); used for walking collision.
  sample(u, v) {
    let node = this.root;
    if (node.state !== READY) return null;
    for (;;) {
      if (node.z >= this.maxZ || !node.children) break;
      const kid = node.children[(u >= (node.u0 + node.u1) / 2 ? 1 : 0) + (v >= (node.v0 + node.v1) / 2 ? 2 : 0)];
      if (kid.state !== READY) break;
      node = kid;
    }
    const i = Math.min(G - 1, Math.max(0, Math.floor(((u - node.u0) / (node.u1 - node.u0)) * G)));
    const j = Math.min(G - 1, Math.max(0, Math.floor(((v - node.v0) / (node.v1 - node.v0)) * G)));
    const k = j * G + i;
    return { h: node.collide[k], water: node.flags[k] & 1, z: node.z, cellM: node.cellM };
  }

  visible(node, ctx) {
    _v.copy(node.center).sub(ctx.camPos);
    _sphere.center.copy(_v);
    _sphere.radius = node.cullRadius;
    if (_v.length() > this.keepRadius + node.radius && !this.frustumWide.intersectsSphere(_sphere)) return false;
    const cosA = node.dir.dot(ctx.camDir);
    if (cosA < ctx.cosLimit(node.angRad)) return false;
    return true;
  }

  inFrustum(node, ctx) {
    _v.copy(node.center).sub(ctx.camPos);
    _sphere.center.copy(_v);
    _sphere.radius = node.cullRadius;
    return this.frustum.intersectsSphere(_sphere);
  }

  select(node, ctx) {
    node.lastUsed = this.frame;
    if (!this.visible(node, ctx)) return;
    if (node.state !== READY) {
      this.request(node, ctx);
      return;
    }
    if (node.z < this.maxZ) {
      const dist = Math.max(1, node.center.distanceTo(ctx.camPos) - 0.8 * node.radius);
      const err = (node.cellM * ctx.pxPerRad) / dist;
      const thr = this.pxThreshold;
      // hysteresis plus a lock during cross-fades keep the LOD from flickering at the threshold
      let split = err > thr * (node.split ? SPLIT_HYST : 1);
      if (this.nowS < node.lockUntil) split = node.split;
      if (split || err > thr * PREFETCH) {
        const kids = node.getChildren();
        let allReady = true;
        let cost = 0;
        for (const k of kids) {
          k.lastUsed = this.frame;
          if (!this.visible(k, ctx)) continue;
          if (k.state !== READY) {
            // an already-split node keeps its children while only margin tiles (outside the real view) are still loading,
            // otherwise turning would collapse whole regions back to the coarse parent
            if (!(node.split && !this.inFrustum(k, ctx))) allReady = false;
            this.request(k, ctx, !split);
          } else if (!k.mesh.userData.up) {
            cost += k.bytes;
          }
        }
        // spread first-time GPU uploads over several frames
        if (allReady && cost > 0 && this.uploadUsed > 0 && this.uploadUsed + cost > UPLOAD_BUDGET) allReady = false;
        if (split && allReady) {
          this.uploadUsed += cost;
          if (!node.split) node.lockUntil = this.nowS + FADE_T;
          node.split = true;
          for (const k of kids) this.select(k, ctx);
          return;
        }
      }
    }
    if (node.split) node.lockUntil = this.nowS + FADE_T;
    node.split = false;
    this.draw(node, ctx);
  }

  draw(node, ctx) {
    const m = node.mesh;
    m.position.copy(m.userData.center).sub(ctx.camPos);
    m.visible = true;
    node.drawFrame = this.frame;
    this.drawn.push(node);
    this.stats.tris += node.tris;
    if (node.treeState === TREES_PENDING) this.vegWanted.push({ node, d: this.score(node, ctx) });
    if (ctx.u >= node.u0 && ctx.u < node.u1 && ctx.v >= node.v0 && ctx.v < node.v1) {
      const i = Math.min(G - 1, Math.floor(((ctx.u - node.u0) / (node.u1 - node.u0)) * G));
      const j = Math.min(G - 1, Math.floor(((ctx.v - node.v0) / (node.v1 - node.v0)) * G));
      this.ground.height = node.heights[j * G + i];
      this.ground.z = node.z;
    }
  }

  // Cross-fades tile swaps: a tile that newly enters the drawn set dithers in while the tiles it replaces
  // (parent or children) dither out with the complementary pattern, so the surface never has holes or z-fights.
  updateFades(ctx, prev) {
    const frame = this.frame;
    const step = this.dt / FADE_T;
    const fade = !!this.fadeMaterial;

    const entering = [];
    const replacing = new Set();
    for (const n of this.drawn) {
      if (!n.shown) {
        n.shown = true;
        n.lockUntil = this.nowS + FADE_T;
        n.a = fade ? 0 : 1;
        n.ghost = false;
        entering.push(n);
        for (let p = n.parent; p; p = p.parent) {
          p.coverFrame = frame;
          p.coverNode = n;
          if (p.shown && p.drawFrame !== frame) replacing.add(n);
        }
      }
    }

    // tiles that left the drawn set: fade out when something replaced them, otherwise drop immediately
    if (fade) {
      for (const n of prev) {
        if (n.drawFrame === frame || n.ghost) continue;
        n.shown = false;
        let cover = n.coverFrame === frame ? n.coverNode : null;
        for (let p = n.parent; !cover && p; p = p.parent) if (p.drawFrame === frame) cover = p;
        if (cover) replacing.add(cover);
        if (cover && cover.a < 1 && n.mesh) {
          n.ghost = true;
          this.ghosts.push({ node: n, cover });
        }
      }
    } else {
      for (const n of prev) if (n.drawFrame !== frame) n.shown = false;
    }

    // a tile that merely re-enters the view (it replaces nothing) shows at once instead of dissolving in over the coarse globe
    for (const n of entering) if (n.settled && !replacing.has(n)) n.a = 1;

    for (const n of this.drawn) {
      const m = n.mesh;
      if (n.tf) {
        n.tf.a = Math.min(1, n.tf.a + step);
        m.userData.fx = n.tf.a;
        m.userData.fdir = 1;
        m.material = this.fadeMaterial;
        if (n.tf.a >= 1) n.tf = null;
      } else if (n.a < 1) {
        n.a = Math.min(1, n.a + step);
        m.userData.fx = n.a;
        m.userData.fdir = 1;
        m.material = this.fadeMaterial;
      } else if (m.material !== this.material) {
        m.material = this.material;
      }
      if (n.a >= 1) n.settled = true;
      m.userData.up = true;
    }

    let keep = 0;
    for (const g of this.ghosts) {
      const n = g.node;
      const m = n.mesh;
      // a ghost is done once its replacement is fully in, or when it was swapped back into the drawn set
      if (!n.ghost || !m || g.cover.drawFrame !== frame || g.cover.a >= 1) {
        n.ghost = false;
        if (m && n.drawFrame !== frame) m.visible = false;
        continue;
      }
      n.lastUsed = frame;
      m.position.copy(m.userData.center).sub(ctx.camPos);
      m.visible = true;
      m.material = this.fadeMaterial;
      m.userData.fx = g.cover.a;
      m.userData.fdir = -1;
      this.stats.tris += n.tris;
      this.ghosts[keep++] = g;
    }
    this.ghosts.length = keep;

    keep = 0;
    for (const g of this.treeGhosts) {
      const m = g.mesh;
      if (g.tf.a >= 1 || g.node.tf !== g.tf || g.node.drawFrame !== frame) {
        if (g.node.tf === g.tf) g.node.tf = null;
        this.group.remove(m);
        m.geometry.dispose();
        continue;
      }
      m.position.copy(m.userData.center).sub(ctx.camPos);
      m.visible = true;
      m.material = this.fadeMaterial;
      m.userData.fx = g.tf.a;
      m.userData.fdir = -1;
      this.treeGhosts[keep++] = g;
    }
    this.treeGhosts.length = keep;
  }

  // camPos: THREE.Vector3 (double precision, world units = metres); camera must sit at the scene origin.
  update(camera, camPos, viewportHeight, u, v) {
    this.frame++;
    const nowMs = performance.now();
    this.dt = Math.min(0.1, Math.max(0.001, nowMs / 1000 - this.nowS));
    this.nowS = nowMs / 1000;
    const prev = this.drawn;
    for (const n of prev) if (n.mesh) n.mesh.visible = false;
    for (const g of this.ghosts) if (g.node.mesh) g.node.mesh.visible = false;
    for (const g of this.treeGhosts) g.mesh.visible = false;
    this.drawn = [];
    this.wanted.length = 0;
    this.vegWanted.length = 0;
    this.stats.tris = 0;
    this.ground.height = null;
    this.uploadUsed = 0;

    // vegetation meshes enter within the same per-frame upload budget as tiles
    while (this.treeQueue.length) {
      const q = this.treeQueue[0];
      const r = q.result;
      const bytes = r.pos.byteLength + r.clr.byteLength + r.aux.byteLength + r.wuv.byteLength + r.idx.byteLength;
      if (this.uploadUsed > 0 && this.uploadUsed + bytes > UPLOAD_BUDGET) break;
      this.treeQueue.shift();
      this.uploadUsed += bytes;
      this.applyTrees(q.node, r);
    }

    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    // The pre-load frustum widens with the camera's angular speed so tiles in the direction of a turn are already loading.
    const qNow = camera.quaternion;
    if (this.prevQuat) {
      const rate = (2 * Math.acos(Math.min(1, Math.abs(this.prevQuat.dot(qNow))))) / this.dt;
      this.turnRate = Math.max(rate, this.turnRate * Math.exp(-this.dt / TURN_HOLD));
    }
    this.prevQuat = (this.prevQuat || new THREE.Quaternion()).copy(qNow);
    const lead = Math.min(MAX_LEAD, this.turnRate * LEAD_T);
    this.projWide.copy(camera.projectionMatrix);
    for (const i of [0, 5]) {
      const e = this.projWide.elements[i];
      this.projWide.elements[i] = 1 / Math.tan(Math.min(MAX_HALF_FOV, Math.atan(WIDE / e) + lead));
    }
    this.projWide.multiply(camera.matrixWorldInverse);
    this.frustumWide.setFromProjectionMatrix(this.projWide);

    const rc = camPos.length();
    const horizon = Math.acos(Math.min(1, R / Math.max(rc, R))) + Math.acos(R / (R + 10000));
    const ctx = {
      camPos,
      camDir: camPos.clone().normalize(),
      fwd: camera.getWorldDirection(new THREE.Vector3()),
      pxPerRad: viewportHeight / (2 * Math.tan((camera.fov * DEG) / 2)),
      cosLimit: (ang) => Math.cos(Math.min(Math.PI, horizon + ang)),
      u,
      v,
    };
    this.select(this.root, ctx);
    this.updateFades(ctx, prev);
    this.dispatch();

    this.base.position.copy(camPos).negate();
    for (const c of this.caps) c.position.copy(c.userData.anchor).sub(camPos);

    if (this.frame - this.lastEvict > 60) {
      this.lastEvict = this.frame;
      this.evict();
    }
    this.stats.drawn = this.drawn.length;
    this.stats.mb = this.gpuBytes / 1048576;
    this.stats.ready = this.ready.size;
    this.stats.inflight = this.inflight;
    this.stats.wanted = this.wanted.length;
    this.stats.trees = this.vegWanted.length + this.inflightVeg;
  }
}
