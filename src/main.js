import * as THREE from 'three';
import { R, llToDir, llToMerc, dirToLat, dirToLon } from './geo.js';
import { Flight } from './flight.js';
import { AutoPlay } from './autoplay.js';
import { World } from './world.js';
import { createAircraft } from './models.js';
import { AIRCRAFT, AIRCRAFT_IDS } from './aircraft.js';
import { Walker } from './walker.js';
import { Skydiver, HIP } from './skydiver.js';
import { Effects } from './effects.js';
import { Shadows } from './shadows.js';
import { Bloom } from './bloom.js';
import { env, shared, createVoxelMaterial, createSky, createAtmosphere, createSkyLUT } from './materials.js';
import { Weather, WEATHER_NAMES, DEFAULT_WEATHER } from './weather.js';
import { touch, initTouch, setMode as setTouchMode, setAction as setTouchAction, setThrottleDisplay, setSprint, takeLook, TOUCH_DEVICE } from './touch.js';

const PRESETS = [
  { name: 'Orbit view', lat: 20, lon: -40, alt: 11_000_000, heading: 0, pitch: -80 },
  { name: 'New York', lat: 40.7484, lon: -73.9857, alt: 500, heading: 200, pitch: -6 },
  { name: 'Paris', lat: 48.8584, lon: 2.2945, alt: 450, heading: 90, pitch: -6 },
  { name: 'Tokyo', lat: 35.6595, lon: 139.7005, alt: 600, heading: 270, pitch: -6 },
  { name: 'Dubai', lat: 25.1972, lon: 55.2744, alt: 700, heading: 0, pitch: -6 },
  { name: 'San Francisco', lat: 37.8087, lon: -122.4098, alt: 500, heading: 180, pitch: -6 },
  { name: 'Mount Everest', lat: 27.9881, lon: 86.925, alt: 9500, heading: 250, pitch: -4 },
  { name: 'Alps (Matterhorn)', lat: 45.9763, lon: 7.6586, alt: 5200, heading: 60, pitch: -4 },
  { name: 'Grand Canyon', lat: 36.1069, lon: -112.1129, alt: 3200, heading: 90, pitch: -4 },
  { name: 'SFO approach', lat: 37.5985, lon: -122.31, alt: 450, heading: 285, pitch: -3 },
  { name: 'Montréal', lat: 45.5017, lon: -73.5673, alt: 500, heading: 45, pitch: -6 },
];

const WALK_PRESETS = [
  { name: 'Times Square', lat: 40.75795, lon: -73.98555, heading: 0 },
  { name: 'Eiffel Tower', lat: 48.85605, lon: 2.29365, heading: 135 },
  { name: 'Shibuya Crossing', lat: 35.65950, lon: 139.70065, heading: 20 },
  { name: 'Sydney Opera House', lat: -33.85735, lon: 151.21525, heading: 0 },
  { name: 'Old Montréal', lat: 45.50735, lon: -73.55395, heading: 330 },
  { name: 'Burj Khalifa', lat: 25.19535, lon: 55.27425, heading: 90 },
];

const QUALITY = { Low: 14, Medium: 8, High: 5, Ultra: 3.5 };
const DEFAULT_QUALITY = TOUCH_DEVICE ? 'Medium' : 'High';
const JUMP_MIN_AGL = 250; // metres above ground needed to jump

// --- renderer / scene -----------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // shaders output sRGB-encoded values themselves
renderer.setPixelRatio(Math.min(window.devicePixelRatio, TOUCH_DEVICE ? 1.5 : 2));
renderer.autoClear = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.5, 1e8);
camera.layers.enable(1); // sky, atmosphere, base sphere and caps live on layer 1 (they cast no shadows)

const skyLUT = createSkyLUT();
const shadows = new Shadows();
const bloom = new Bloom();
const sky = createSky();
scene.add(sky);
const weather = new Weather(scene, sky);
const _wf = new THREE.Vector3();
let savedWeather = DEFAULT_WEATHER;
let savedSound = true;
try {
  const w = localStorage.getItem('weather');
  if (WEATHER_NAMES.includes(w)) savedWeather = w;
  savedSound = localStorage.getItem('weatherSound') !== '0';
} catch (e) {
  // storage can be blocked; keep the defaults
}
weather.set(savedWeather, true);
weather.setSound(savedSound);
const atmosphere = createAtmosphere();
scene.add(atmosphere);

const voxelMat = createVoxelMaterial();
const world = new World(scene, {
  material: voxelMat,
  fadeMaterial: createVoxelMaterial(THREE.FrontSide, true),
  capMaterial: createVoxelMaterial(THREE.DoubleSide),
  maxZ: 20,
  pxThreshold: QUALITY[DEFAULT_QUALITY],
});

let aircraftId = 'light';
try {
  const saved = localStorage.getItem('aircraft');
  if (AIRCRAFT[saved]) aircraftId = saved;
} catch (e) {
  // storage can be blocked; fall back to the default plane
}
const models = {};
const getModel = (id) => (models[id] ??= createAircraft(id, voxelMat));
let plane = getModel(aircraftId);
scene.add(plane);
const diver = new Skydiver(voxelMat);
scene.add(diver.body, diver.canopy);
const effects = new Effects(scene, voxelMat);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- state ------------------------------------------------------------------
const flight = new Flight();
flight.setAircraft(aircraftId);
const walker = new Walker();
let mode = 'fly'; // 'fly' | 'walk' | 'chute' | 'crash'
let crash = null; // wreck being shown after a crash: { kind, t, site, up, az, side, dist, ground, lat, lon, heading, shown }
let paused = true;
let planeScale = 1;
let planeGone = false; // the plane was left behind in the air; P calls it back
let chase = true;
let sunLon = 0;
let tod = 15; // local solar hour at the player, kept across teleports
const DAY_CYCLES = { Off: 0, 'Slow (30 min)': 0.2, 'Normal (8 min)': 0.75, 'Fast (2 min)': 3 }; // sun degrees of longitude per second
const DEFAULT_CYCLE = 'Normal (8 min)';
let dayRate = DAY_CYCLES[DEFAULT_CYCLE];
let lastRate = dayRate;
let notice = null; // { text, until } transient HUD warning
let settle = null; // { t } while waiting for ground tiles to stream in under a freshly placed walker
let lastUnlock = 0;
const camQuat = new THREE.Quaternion();
const chuteGround = { h: 0, water: 0 };
const chuteInput = { steer: 0, speed: 0, flare: false };
const NO_INPUT = { pitch: 0, roll: 0, yaw: 0, brake: false };
const flightInput = { pitch: 0, roll: 0, yaw: 0, brake: false };
let lookYaw = 0; // free-look offset in fly mode; springs back when released
let lookPitch = 0;
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const lookQuat = new THREE.Quaternion();
const shakeEuler = new THREE.Euler();
const shakeQuat = new THREE.Quaternion();
const clamp1 = (x) => Math.min(1, Math.max(-1, x));
const planeQuat = new THREE.Quaternion();
const camPos = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const pitchDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.1);
let camInit = false;

function sampleAt(dir) {
  const m = llToMerc(dirToLat(dir.x, dir.y, dir.z), dirToLon(dir.x, dir.z));
  return world.sample(m.u, m.v);
}

function currentLon() {
  return mode === 'fly' ? flight.lon : mode === 'chute' ? diver.lon : mode === 'crash' ? crash.lon : walker.lon;
}

const wrap24 = (h) => ((h % 24) + 24) % 24;
const localHour = () => wrap24(12 + (currentLon() - sunLon) / 15);
const sunLonFor = (lon, hour) => lon - (hour - 12) * 15;

function showNotice(text, secs = 3) {
  notice = { text, until: performance.now() + secs * 1000 };
}

function lockPointer() {
  if (!touch.enabled) canvas.requestPointerLock?.()?.catch?.(() => {});
}

// --- auto play ------------------------------------------------------------------------
const auto = new AutoPlay(flight, {
  ground: (dir) => {
    const s = sampleAt(dir);
    return s ? Math.max(s.h, 0) : null;
  },
  ready: () => world.ground.height !== null && world.ground.z >= 14,
  arrive: (poi, hour) => {
    sunLon = sunLonFor(poi.lon, hour);
    tod = hour;
    $('auto-title').classList.remove('on');
    $('auto-tag').classList.remove('on');
  },
  title: (poi) => {
    $('auto-place').textContent = poi.name;
    $('auto-sub').textContent = poi.place;
    $('auto-tag').textContent = `${poi.name} · ${poi.place}`;
    $('auto-title').classList.add('on');
    $('auto-tag').classList.add('on');
    clearTimeout(autoTitleTimer);
    autoTitleTimer = setTimeout(() => $('auto-title').classList.remove('on'), 8000);
  },
});
let autoTitleTimer = 0;
let autoFadeShown = 0;
let autoIdleTimer = 0;

function startAuto() {
  applyAircraft();
  hideCrash();
  effects.clear();
  diver.hide();
  document.exitPointerLock?.();
  mode = 'fly';
  settle = null;
  planeGone = false;
  planeScale = 1;
  lookYaw = lookPitch = 0;
  document.body.classList.add('auto');
  auto.start();
}

// handover: the player grabs the controls and keeps flying from where the plane is
function stopAuto(handover) {
  if (!auto.active) return;
  auto.stop();
  clearTimeout(autoTitleTimer);
  document.body.classList.remove('auto', 'idle');
  $('auto-title').classList.remove('on');
  $('auto-tag').classList.remove('on');
  $('auto-fade').style.opacity = 0;
  autoFadeShown = 0;
  if (handover) {
    flight.throttle = flight.eng = flight.spec.trimThrottle;
    flight.gHold = 0;
    flight.spoil = 1;
    flight.ele = flight.ail = flight.rud = flight.wp = flight.wq = flight.wr = 0;
    lookYaw = lookPitch = 0;
    camInit = false;
  }
}

function spawn(p) {
  stopAuto(false);
  applyAircraft();
  hideCrash();
  effects.clear();
  if (p.ground) return startOnFoot(p);
  mode = 'fly';
  settle = null;
  planeGone = false;
  diver.hide();
  document.exitPointerLock?.();
  flight.spawn(p.lat, p.lon, p.alt, p.heading, p.pitch);
  lookYaw = lookPitch = 0;
  planeScale = Math.max(1, p.alt / 1200);
  sunLon = sunLonFor(p.lon, tod);
  camInit = false;
}

function startOnFoot(p) {
  flight.spawn(p.lat, p.lon, 0, p.heading, 0);
  flight.stop();
  flight.throttle = flight.eng = 0;
  walker.place(_a.copy(flight.p).normalize(), flight.f, 0);
  mode = 'walk';
  settle = { t: 0 };
  planeScale = 1;
  planeGone = false;
  diver.hide();
  sunLon = sunLonFor(p.lon, tod);
  camInit = false;
}

let wantedAircraft = aircraftId;

// Swaps the plane model and flight model to the one the player picked.
function applyAircraft() {
  if (wantedAircraft === aircraftId) return;
  scene.remove(plane);
  aircraftId = wantedAircraft;
  plane = getModel(aircraftId);
  scene.add(plane);
  flight.setAircraft(aircraftId);
}

function syncAircraftButtons() {
  for (const b of $('aircraft').children) b.classList.toggle('on', b.dataset.id === wantedAircraft);
}

// Menu pick: takes effect right away on the ground or in the air, and after the next respawn otherwise.
function chooseAircraft(id) {
  if (id === wantedAircraft) return;
  wantedAircraft = id;
  try {
    localStorage.setItem('aircraft', id);
  } catch (e) {
    // storage can be blocked
  }
  syncAircraftButtons();
  if (auto.active) return applyAircraft();
  if (mode !== 'fly' && mode !== 'walk') return;
  const oldDrop = flight.spec.gearDrop;
  if (mode === 'walk' && (planeGone || settle)) return applyAircraft();
  const wasNear = mode === 'walk' && nearPlane();
  if (!flight.grounded && mode === 'fly') {
    const ground = world.ground.height ?? 0;
    spawn({ lat: flight.lat, lon: flight.lon, alt: Math.max(flight.alt, ground + 250), heading: flight.headingDeg, pitch: flight.pitchDeg });
    return;
  }
  // parked: put the new plane on its wheels where the old one stood
  const wheels = flight.alt - oldDrop * planeScale;
  applyAircraft();
  _a.copy(flight.p).normalize();
  _b.copy(flight.f);
  flight.park(_c.copy(_a).multiplyScalar(R + wheels + flight.spec.gearDrop * planeScale), _b, _a);
  if (wasNear) parkPlaneAhead(flight.spec.parkAhead);
}

const canJump = (agl) => !flight.grounded && agl > JUMP_MIN_AGL;

// --- crashes ------------------------------------------------------------------------
const groundAt = (p) => {
  const s = sampleAt(_tmp.copy(p).normalize());
  return s ? s.h : null;
};
const _tmp = new THREE.Vector3();
const _lookM = new THREE.Matrix4();

function hideCrash() {
  crash = null;
  $('crash').classList.remove('on', 'fade');
}

// Freezes the action at the impact point, blows the wreck apart and starts an orbiting wreck cam.
function startCrash(kind, { pos, vel, speed, text, heading }) {
  const up = pos.clone().normalize();
  const gs = sampleAt(up);
  const ground = gs ? gs.h : 0;
  const water = !!gs && !!gs.water && pos.length() - R - gs.h < 12;
  const sc = kind === 'plane' ? planeScale * flight.spec.fx : 1;
  effects.explode(pos, up, vel, { water, scale: sc, speed, style: kind === 'diver' ? 'diver' : 'plane' });
  const back = vel.clone().addScaledVector(up, -vel.dot(up));
  if (back.lengthSq() < 0.25) back.crossVectors(up, new THREE.Vector3(0, 1, 0));
  back.normalize().negate();
  mode = 'crash';
  settle = null;
  document.exitPointerLock?.();
  diver.hide();
  crash = {
    kind,
    t: 0,
    site: pos.clone(),
    up,
    az: back,
    side: new THREE.Vector3().crossVectors(up, back).normalize(),
    dist: kind === 'plane' ? flight.spec.crashDist * planeScale : 9,
    sc,
    ground,
    lat: dirToLat(up.x, up.y, up.z),
    lon: dirToLon(up.x, up.z),
    heading: heading ?? 0,
    shown: false,
  };
  $('crash-title').textContent = kind === 'plane' ? (water ? 'Splashdown' : 'Crashed') : water ? 'Splashdown' : 'Hard landing';
  $('crash-msg').textContent = text;
  const b = $('crash-again');
  b.textContent = kind === 'plane' ? 'Fly again' : 'Back in a plane';
  camInit = false;
}

function updateCrash(dt) {
  crash.t += dt;
  if (!crash.shown && crash.t > 1.5) {
    crash.shown = true;
    $('crash').classList.add('on');
  }
  if (crash.t > 6.2) $('crash').classList.add('fade');
  if (crash.t > 7.4) respawnAfterCrash();
}

function crashContinue() {
  if (crash && crash.t > 0.8) respawnAfterCrash();
}

function respawnAfterCrash() {
  const c = crash;
  if (!c) return;
  spawn({ lat: c.lat, lon: c.lon, alt: Math.max(c.ground, 0) + (c.kind === 'plane' ? 350 : 500), heading: c.heading, pitch: 0 });
}

function crashCamera(outPos, outQuat) {
  const c = crash;
  const k = Math.min(1, c.t / 3);
  const ang = c.t * 0.2;
  const d = c.dist * (1 + 0.3 * k);
  _tmp.copy(c.az).multiplyScalar(Math.cos(ang)).addScaledVector(c.side, Math.sin(ang)).multiplyScalar(d);
  outPos.copy(c.site).add(_tmp).addScaledVector(c.up, d * (0.22 + 0.18 * k) + 1.5 * c.sc);
  const gh = groundAt(outPos);
  const minR = R + (gh ?? c.ground) + 2;
  if (outPos.length() < minR) outPos.multiplyScalar(minR / outPos.length());
  _a.copy(c.site).addScaledVector(c.up, 2 * c.sc + 2 * k);
  _lookM.lookAt(outPos, _a, c.up);
  outQuat.setFromRotationMatrix(_lookM);
}

// Leaves the plane in mid-air; the plane keeps flying on its own.
function startChute() {
  const exit = _b.copy(flight.r).multiplyScalar(flight.spec.exitSide * planeScale).add(flight.p);
  flight.velocity(_c);
  diver.start(exit, flight.f, _c);
  mode = 'chute';
  camInit = false;
  lockPointer();
}

function touchdown(res) {
  const speed = res.speed;
  if (speed > 14) {
    diver.velocity(_c);
    startCrash('diver', {
      pos: diver.p.clone(),
      vel: _c.clone(),
      speed,
      heading: diver.headingDeg,
      text: diver.open < 0.5 ? 'The parachute never opened in time.' : `You hit the ground at ${(speed * 3.6).toFixed(0)} km/h.`,
    });
    return;
  }
  if (res.water) {
    // no swimming: put the player back in a plane over the same spot
    showNotice('Splashdown! Back in the plane.', 4);
    spawn({ lat: diver.lat, lon: diver.lon, alt: 600, heading: diver.headingDeg, pitch: -3 });
    return;
  }
  diver.land(speed);
  _b.copy(diver.up);
  diver.velocity(_c);
  _a.copy(diver.p).addScaledVector(_b, -HIP);
  effects.puff(_a, _b, _c, 1 + speed * 0.6, 0.6);
}

// The diver has run out the landing and the canopy is down: hand over to walking.
function finishLanding() {
  walker.place(_a.copy(diver.p).normalize(), diver.f, diver.alt - HIP);
  diver.hide();
  mode = 'walk';
  settle = { t: 0, keepPlane: true };
  planeGone = true;
  planeScale = 1;
  camInit = false;
}

// Puts the plane on the ground a few metres ahead of the walker.
function parkPlaneAhead(dist) {
  applyAircraft();
  const dir = _b.copy(walker.n).multiplyScalar(R).addScaledVector(walker.f, dist).normalize();
  const s = sampleAt(dir);
  const h = s ? s.h : walker.foot;
  const pos = _c.copy(dir).multiplyScalar(R + h + flight.spec.gearDrop);
  flight.park(pos, walker.f, dir);
  planeGone = false;
}

function exitPlane() {
  const side = _b.copy(flight.r).multiplyScalar(flight.spec.walkOff);
  const dir = _c.copy(flight.p).normalize().multiplyScalar(R).add(side).normalize();
  const s = sampleAt(dir);
  const h = s && !s.water ? s.h : flight.alt - flight.spec.gearDrop;
  walker.place(dir, flight.f, h);
  flight.stop();
  mode = 'walk';
  camInit = false;
  lockPointer();
}

function nearPlane() {
  return !planeGone && _a.copy(walker.n).multiplyScalar(R + walker.foot).distanceTo(flight.p) < flight.spec.boardDist;
}

function boardPlane() {
  mode = 'fly';
  flight.throttle = flight.eng = 0;
  flight.stop();
  lookYaw = lookPitch = 0;
  camInit = false;
  document.exitPointerLock?.();
}

// The round on-screen button (and the Enter/J/Space/P keys) do whatever makes sense right now.
function actionLabel(agl) {
  if (paused || mode === 'crash') return '';
  if (mode === 'fly') return flight.landed ? 'Exit plane' : canJump(agl) ? 'Parachute' : '';
  if (mode === 'walk') return settle ? '' : nearPlane() ? 'Board plane' : 'Call plane';
  return diver.deployed ? '' : 'Open chute';
}

function doAction() {
  if (paused) return;
  if (mode === 'crash') return crashContinue();
  if (mode === 'fly') {
    if (flight.landed) exitPlane();
    else if (canJump(flight.alt - (world.ground.height ?? 0))) startChute();
  } else if (mode === 'walk') {
    if (settle) return;
    if (nearPlane()) boardPlane();
    else parkPlaneAhead(flight.spec.parkAhead);
  } else diver.deploy();
}

function sunDirection() {
  const now = new Date();
  const doy = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 864e5;
  const dec = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
  return llToDir(dec, sunLon);
}

// --- input ---------------------------------------------------------------------
const keys = new Set();
const AUTO_TAKEOVER = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space']);
const AUTO_IGNORED = new Set(['Enter', 'KeyJ', 'KeyP', 'KeyB']);
const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox';

window.addEventListener('keydown', (e) => {
  if (typing()) return;
  if (e.code === 'Escape') {
    // Esc while pointer-locked already released the lock and opened the menu
    if (performance.now() - lastUnlock < 200) return;
    toggleMenu();
    return;
  }
  if (e.code === 'KeyM') {
    toggleMenu();
    return;
  }
  if (e.code === 'KeyV' && !e.repeat) {
    if (auto.active) stopAuto(true);
    else startAuto();
    toggleMenu(false);
    return;
  }
  if (paused) return;
  if (auto.active) {
    if (e.code === 'KeyN') return auto.skip();
    if (AUTO_IGNORED.has(e.code)) return;
    if (AUTO_TAKEOVER.has(e.code)) stopAuto(true);
  }
  keys.add(e.code);
  if (e.repeat) return;
  switch (e.code) {
    case 'Enter':
      if (mode === 'crash') crashContinue();
      else if (mode === 'fly') {
        if (flight.landed) exitPlane();
      } else if (mode === 'walk' && !settle && nearPlane()) {
        boardPlane();
      }
      break;
    case 'KeyJ':
      if (mode === 'fly' && canJump(flight.alt - (world.ground.height ?? 0))) startChute();
      break;
    case 'Space':
      if (mode === 'chute') diver.deploy();
      else if (mode === 'crash') crashContinue();
      break;
    case 'KeyP':
      if (mode === 'walk' && !settle) parkPlaneAhead(flight.spec.parkAhead);
      break;
    case 'KeyC':
      chase = !chase;
      break;
    case 'KeyI':
      setInvert(!flight.invertPitch);
      break;
    case 'KeyL':
      setAssist(!flight.assist);
      break;
    case 'KeyT':
      if (dayRate) {
        lastRate = dayRate;
        dayRate = 0;
      } else {
        dayRate = lastRate || DAY_CYCLES[DEFAULT_CYCLE];
      }
      syncCycleSelect();
      break;
    case 'BracketLeft':
      sunLon += 15;
      break;
    case 'BracketRight':
      sunLon -= 15;
      break;
    case 'KeyG':
      e.preventDefault();
      showSearch();
      break;
    case 'KeyH':
      document.getElementById('help').classList.toggle('hidden');
      break;
  }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
window.addEventListener(
  'wheel',
  (e) => {
    if (paused || mode !== 'fly') return;
    flight.throttle = Math.min(1, Math.max(0, flight.throttle - e.deltaY * 0.0004));
  },
  { passive: true },
);

function setAssist(on) {
  flight.assist = on;
  $('assist').checked = on;
  showNotice(`Flight assist ${on ? 'on' : 'off'}`, 1.5);
}

function setInvert(on) {
  flight.invertPitch = on;
  $('invert').checked = on;
  showNotice(`Pitch ${on ? 'inverted' : 'normal'}`, 1.5);
}

const locked = () => document.pointerLockElement === canvas;
window.addEventListener('mousemove', (e) => {
  if (paused || settle || !locked()) return;
  if (mode === 'walk') walker.turn(e.movementX * 0.0022, -e.movementY * 0.0022);
  else if (mode === 'chute') diver.lookBy(e.movementX * 0.0022, -e.movementY * 0.0022);
});
document.addEventListener('pointerlockchange', () => {
  if (locked()) return;
  lastUnlock = performance.now();
  if (mode !== 'fly' && mode !== 'crash' && !paused && !touch.enabled) toggleMenu(true);
});
canvas.addEventListener('click', () => {
  if (mode !== 'fly' && mode !== 'crash' && !paused && !locked()) lockPointer();
});

function readFlightInput(dt) {
  const k = (c) => (keys.has(c) ? 1 : 0);
  if (k('ShiftLeft') || k('ShiftRight') || k('KeyR') || k('Equal')) flight.throttle = Math.min(1, flight.throttle + dt * 0.35);
  if (k('ControlLeft') || k('ControlRight') || k('KeyF') || k('Minus')) flight.throttle = Math.max(0, flight.throttle - dt * 0.35);
  const i = flightInput;
  i.pitch = clamp1(k('KeyS') + k('ArrowDown') - k('KeyW') - k('ArrowUp') - touch.stick.y);
  i.roll = clamp1(k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') + touch.stick.x);
  i.yaw = clamp1(k('KeyE') - k('KeyQ') + touch.rudder);
  i.brake = !!(k('Space') || k('KeyB') || touch.brake);
  return i;
}

function readWalkInput(dt) {
  const k = (c) => (keys.has(c) ? 1 : 0);
  const [dx, dy] = takeLook();
  walker.turn((k('ArrowRight') - k('ArrowLeft')) * 1.8 * dt + dx * 0.0055, (k('ArrowUp') - k('ArrowDown')) * 1.2 * dt - dy * 0.0055);
  return {
    fwd: clamp1(k('KeyW') - k('KeyS') + touch.stick.y),
    strafe: clamp1(k('KeyD') - k('KeyA') + touch.stick.x),
    sprint: k('ShiftLeft') || k('ShiftRight') || touch.sprint,
    jump: k('Space') || touch.jump,
  };
}

function readChuteInput() {
  const k = (c) => (keys.has(c) ? 1 : 0);
  const [dx, dy] = takeLook();
  if (dx || dy) diver.lookBy(dx * 0.0055, -dy * 0.0055);
  chuteInput.steer = clamp1(k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft') + touch.stick.x);
  chuteInput.speed = clamp1(k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown') + touch.stick.y);
  chuteInput.flare = !!(diver.deployed && (k('Space') || touch.brake));
  return chuteInput;
}

initTouch({
  onThrottle: (v) => {
    flight.throttle = v;
  },
  onAction: doAction,
  onMenu: () => toggleMenu(),
  onCamera: () => {
    chase = !chase;
  },
  onSearch: () => showSearch(),
  onFullscreen: () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch?.(() => {});
  },
  canLook: (e) => e.pointerType !== 'mouse' || (mode === 'fly' && !paused),
});

// --- UI -------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const menu = $('menu');

function toggleMenu(show) {
  const want = show ?? !menu.classList.contains('open');
  menu.classList.toggle('open', want);
  paused = want;
  keys.clear();
  if (want) document.exitPointerLock?.();
  else if (mode !== 'fly' && mode !== 'crash') lockPointer();
}

function buildMenu() {
  for (const id of AIRCRAFT_IDS) {
    const b = document.createElement('button');
    b.dataset.id = id;
    b.innerHTML = `${AIRCRAFT[id].name}<small>${AIRCRAFT[id].desc}</small>`;
    b.onclick = () => chooseAircraft(id);
    $('aircraft').appendChild(b);
  }
  syncAircraftButtons();
  const add = (parent, list, extra) => {
    for (const p of list) {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.onclick = () => {
        spawn({ ...p, ...extra });
        toggleMenu(false);
      };
      $(parent).appendChild(b);
    }
  };
  add('presets', PRESETS);
  add('walk-presets', WALK_PRESETS, { ground: true });
  const q = $('quality');
  for (const name of Object.keys(QUALITY)) q.add(new Option(name, name, false, name === DEFAULT_QUALITY));
  q.onchange = () => {
    world.pxThreshold = QUALITY[q.value];
  };
  $('shadows').onchange = (e) => {
    shadows.enabled = e.target.checked;
  };
  if (TOUCH_DEVICE) {
    $('shadows').checked = false;
    shadows.enabled = false;
  }
  $('assist').onchange = (e) => {
    flight.assist = e.target.checked;
  };
  $('invert').onchange = (e) => {
    flight.invertPitch = e.target.checked;
  };
  $('show-help').onclick = () => {
    $('help').classList.toggle('hidden');
    toggleMenu(false);
  };
  const dc = $('daycycle');
  for (const name of Object.keys(DAY_CYCLES)) dc.add(new Option(name, name, false, name === DEFAULT_CYCLE));
  dc.onchange = () => {
    dayRate = DAY_CYCLES[dc.value];
    if (dayRate) lastRate = dayRate;
  };
  const wsel = $('weather');
  for (const name of WEATHER_NAMES) wsel.add(new Option(name, name, false, name === savedWeather));
  wsel.onchange = () => {
    weather.set(wsel.value);
    try {
      localStorage.setItem('weather', wsel.value);
    } catch (e) {
      // storage can be blocked
    }
  };
  $('wsound').checked = savedSound;
  $('wsound').onchange = (e) => {
    weather.setSound(e.target.checked);
    if (e.target.checked) weather.audio.unlock();
    try {
      localStorage.setItem('weatherSound', e.target.checked ? '1' : '0');
    } catch (err) {
      // storage can be blocked
    }
  };
  $('tod').oninput = (e) => {
    sunLon = sunLonFor(currentLon(), parseFloat(e.target.value));
    tod = localHour();
  };
  $('resume').onclick = () => toggleMenu(false);
  $('auto-start').onclick = () => {
    startAuto();
    toggleMenu(false);
  };
  $('auto-take').onclick = () => stopAuto(true);
  window.addEventListener('pointermove', () => {
    if (!auto.active) return;
    document.body.classList.remove('idle');
    clearTimeout(autoIdleTimer);
    autoIdleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  });
  $('menu-search-go').onclick = () => geocode($('menu-search').value, true);
  $('menu-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') geocode($('menu-search').value, true);
  });
}

function showSearch() {
  const box = $('search');
  box.classList.add('open');
  const input = $('search-input');
  input.value = '';
  input.focus();
  keys.clear();
}

function hideSearch() {
  $('search').classList.remove('open');
  $('search-input').blur();
}

async function geocode(query, fromMenu) {
  query = query.trim();
  if (!query) return;
  const status = $(fromMenu ? 'menu-status' : 'search-status');
  status.textContent = 'Searching…';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
    const [hit] = await res.json();
    if (!hit) {
      status.textContent = 'No match found';
      return;
    }
    const heading = mode === 'fly' ? flight.headingDeg || 0 : mode === 'chute' ? diver.headingDeg : walker.headingDeg;
    spawn({ lat: +hit.lat, lon: +hit.lon, alt: 700, heading, pitch: -8 });
    status.textContent = hit.display_name;
    hideSearch();
    toggleMenu(false);
  } catch (e) {
    status.textContent = 'Search failed';
  }
}

$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') geocode(e.target.value, false);
  if (e.key === 'Escape') hideSearch();
  e.stopPropagation();
});
$('search-input').addEventListener('blur', () => setTimeout(hideSearch, 250));
buildMenu();
$('crash-again').onclick = crashContinue;

const hud = {
  speed: $('h-speed'),
  alt: $('h-alt'),
  agl: $('h-agl'),
  vs: $('h-vs'),
  assist: $('h-assist'),
  pos: $('h-pos'),
  hdg: $('h-hdg'),
  time: $('h-time'),
  thr: $('h-thr'),
  tiles: $('h-tiles'),
  net: $('h-net'),
  warn: $('h-warn'),
  prompt: $('prompt'),
  cross: $('crosshair'),
};

function fmtDist(m) {
  if (m >= 1e6) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1e4) return `${(m / 1000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}

function fmtHour(h) {
  const m = Math.floor(h * 60 + 0.5) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function syncCycleSelect() {
  const name = Object.keys(DAY_CYCLES).find((k) => DAY_CYCLES[k] === dayRate) ?? Object.keys(DAY_CYCLES)[0];
  $('daycycle').value = name;
}

function fmtSpeed(s) {
  return s >= 1000 ? `${(s / 1000).toFixed(1)} km/s` : `${(s * 3.6).toFixed(0)} km/h`;
}

const tip = (kbd, tch) => (touch.enabled ? tch : kbd);

let hudTimer = 0;
let fps = 60;
function updateHud(dt, agl) {
  hudTimer += dt;
  if (hudTimer < 0.1) return;
  hudTimer = 0;
  const st = world.stats;
  let warn = '';
  setTouchMode(mode);
  setTouchAction(touch.enabled ? actionLabel(agl) : '');
  if (mode === 'fly') {
    hud.speed.textContent = fmtSpeed(flight.speed);
    hud.alt.textContent = fmtDist(flight.alt);
    hud.agl.textContent = fmtDist(agl);
    const vs = flight.vsi;
    hud.vs.textContent = Math.abs(vs) >= 1000 ? `${(vs / 1000).toFixed(1)} km/s` : `${vs >= 0 ? '+' : ''}${vs.toFixed(0)} m/s`;
    hud.assist.textContent = flight.assist ? 'on' : 'off';
    hud.pos.textContent = `${flight.lat.toFixed(4)}°, ${flight.lon.toFixed(4)}°`;
    hud.hdg.textContent = `${flight.headingDeg.toFixed(0)}°  pitch ${flight.pitchDeg.toFixed(0)}°  bank ${flight.bankDeg.toFixed(0)}°`;
    hud.thr.style.width = `${(flight.throttle * 100).toFixed(0)}%`;
    setThrottleDisplay(flight.throttle);
    if (flight.crashed) warn = 'HARD LANDING';
    if (flight.stalled && agl > 3) warn = 'STALL';
    else if (!flight.grounded && vs < -12 && agl / -vs < 4 && agl < 800) warn = 'PULL UP';
    hud.prompt.textContent = flight.landed
      ? tip('[Enter] Exit plane', 'Tap Exit plane')
      : flight.grounded
        ? flight.throttle > 0.1
          ? tip('Space brakes · ease back on the stick to take off', 'Pull back on the stick to take off')
          : tip('Throttle up to take off · Space brakes', 'Raise the throttle to take off')
        : agl > JUMP_MIN_AGL
          ? tip('[J] Jump with parachute', '')
          : '';
  } else if (mode === 'chute') {
    hud.speed.textContent = `${(-diver.vy * 3.6).toFixed(0)} km/h down · ${(diver.hv.length() * 3.6).toFixed(0)} across`;
    hud.alt.textContent = fmtDist(diver.alt);
    hud.agl.textContent = fmtDist(Math.max(0, diver.agl));
    hud.vs.textContent = `${diver.vy.toFixed(0)} m/s`;
    hud.pos.textContent = `${diver.lat.toFixed(5)}°, ${diver.lon.toFixed(5)}°`;
    hud.hdg.textContent = `${diver.headingDeg.toFixed(0)}°`;
    hud.thr.style.width = '0%';
    hud.prompt.textContent = diver.landed
      ? ''
      : !diver.deployed
        ? tip('[Space] Open parachute · A/D turn · W dive · S slow', 'Open the parachute · stick up to dive')
        : !diver.flying
          ? 'Canopy opening…'
          : diver.agl < 40
            ? tip('Hold [Space] to flare just above the ground · steer into the wind', 'Hold FLARE just above the ground')
            : tip('A/D steer · W speed bar · S brakes · Space flare · mouse looks around', 'Stick: steer / speed · FLARE to brake · drag to look');
  } else if (mode === 'crash') {
    hud.speed.textContent = '–';
    hud.alt.textContent = '–';
    hud.agl.textContent = '–';
    hud.vs.textContent = '–';
    hud.pos.textContent = `${crash.lat.toFixed(4)}°, ${crash.lon.toFixed(4)}°`;
    hud.hdg.textContent = '–';
    hud.thr.style.width = '0%';
    hud.prompt.textContent = '';
  } else {
    hud.speed.textContent = 'on foot';
    hud.alt.textContent = fmtDist(walker.foot);
    hud.agl.textContent = '–';
    hud.vs.textContent = '–';
    hud.pos.textContent = `${walker.lat.toFixed(5)}°, ${walker.lon.toFixed(5)}°`;
    hud.hdg.textContent = `${walker.headingDeg.toFixed(0)}°`;
    hud.thr.style.width = '0%';
    hud.prompt.textContent = settle
      ? 'Loading terrain…'
      : nearPlane()
        ? tip('[Enter] Board plane', 'Tap Board plane')
        : tip('[P] Call plane · click to look around', 'Drag to look · tap Call plane');
  }
  if (notice && performance.now() < notice.until) warn = notice.text;
  hud.warn.textContent = warn;
  hud.warn.classList.toggle('on', !!warn);
  hud.time.textContent = fmtHour(localHour());
  if (document.activeElement !== $('tod')) {
    $('tod').value = localHour();
    $('tod-label').textContent = fmtHour(localHour());
  }
  hud.cross.classList.toggle('on', mode === 'walk' && !paused);
  hud.tiles.textContent = `${st.drawn} drawn · ${st.ready} cached · ${st.inflight} loading${st.trees ? ` (${st.trees} tree passes)` : ''} · z${world.ground.z} · ${(st.tris / 1e6).toFixed(2)}M tris · ${fps.toFixed(0)} fps`;
  hud.net.textContent = `${(st.bytes / 1048576).toFixed(1)} MB streamed · ${st.mb.toFixed(0)} MB GPU`;
}

// --- main loop ---------------------------------------------------------------------
spawn(PRESETS[0]);
toggleMenu(true);

const smooth = THREE.MathUtils.smoothstep;
let lastT = performance.now();
const t0 = lastT;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const rawDt = (now - lastT) / 1000;
  lastT = now;
  const dt = Math.min(0.05, rawDt);
  if (rawDt > 0) fps += (1 / rawDt - fps) * 0.05;
  if (dayRate && !paused) sunLon -= dt * dayRate;
  const sd = sunDirection();
  env.sun.set(sd[0], sd[1], sd[2]);
  env.moon.set(-sd[0], -sd[1] + 0.3, -sd[2]).normalize();
  tod = localHour();

  // --- simulate ---
  const ground = world.ground.height;
  let agl;
  if (mode === 'fly') {
    if (!paused && auto.active) auto.update(dt, planeScale);
    else if (!paused) {
      flight.update(dt, readFlightInput(dt), planeScale, ground, flight.spec.gearDrop);
      if (flight.touchEvent) {
        const te = flight.touchEvent;
        flight.touchEvent = null;
        flight.velocity(_c);
        _b.copy(flight.p).normalize();
        _a.copy(flight.p).addScaledVector(_b, -flight.spec.gearDrop * planeScale);
        if (te.speed > 12) effects.puff(_a, _b, _c, (1.5 + te.vsink * 0.7 + te.speed / 30) * flight.spec.fx, planeScale * flight.spec.fx);
      }
      if (flight.crashSevere) {
        const im = flight.impact;
        const kmh = (im.speed * 3.6).toFixed(0);
        startCrash('plane', {
          pos: im.pos,
          vel: im.vel,
          speed: im.speed,
          heading: flight.headingDeg,
          text:
            im.kind === 'wall'
              ? `You flew into an obstacle at ${kmh} km/h.`
              : im.vsink > 12
                ? `You hit the ground at ${(im.vsink * 3.6).toFixed(0)} km/h vertical speed.`
                : `Bad landing angle at ${kmh} km/h. Keep the wings level and the nose up.`,
        });
      }
    }
    const [ldx, ldy] = takeLook();
    if (touch.looking && !paused) {
      lookYaw = Math.max(-3.2, Math.min(3.2, lookYaw - ldx * 0.006));
      lookPitch = Math.max(-0.9, Math.min(1.2, lookPitch - ldy * 0.006));
    } else {
      const k = Math.exp(-dt * 3);
      lookYaw *= k;
      lookPitch *= k;
    }
    agl = flight.alt - (ground ?? 0);
    const targetScale = Math.max(1, agl / 1200);
    planeScale *= Math.pow(targetScale / planeScale, Math.min(1, dt * 3));
  } else if (mode === 'crash') {
    if (!paused) updateCrash(dt);
    agl = 60;
  } else if (mode === 'chute') {
    const gs = sampleAt(_c.copy(diver.p).normalize());
    chuteGround.h = gs ? (gs.water ? Math.max(gs.h, 0) : gs.h) : 0;
    chuteGround.water = gs ? gs.water : 0;
    if (!paused) {
      const input = readChuteInput();
      const res = diver.update(dt, input, chuteGround);
      // the abandoned plane flies on by itself
      const pg = sampleAt(_c.copy(flight.p).normalize());
      flight.update(dt, NO_INPUT, planeScale, pg ? pg.h : 0, flight.spec.gearDrop);
      if (res) touchdown(res);
      else if (diver.finished) finishLanding();
    }
    agl = Math.max(1.7, diver.agl);
    planeScale += (1 - planeScale) * Math.min(1, dt * 3);
  } else {
    if (settle) {
      // hold the player in place until fine tiles exist, then drop them onto the real ground
      settle.t += dt;
      const m = llToMerc(walker.lat, walker.lon);
      const s = world.sample(m.u, m.v);
      if (s) walker.foot = walker.smoothFoot = s.z >= 20 ? s.h : Math.max(s.h, 0);
      if ((s && s.z >= 20) || settle.t > 12) {
        if (s) {
          const keepPlane = settle.keepPlane;
          settle = null;
          if (!keepPlane) parkPlaneAhead(flight.spec.parkAhead);
        } else if (settle.t > 40) settle = null;
      }
    } else if (!paused) {
      walker.update(dt, readWalkInput(dt), world);
    }
    agl = 1.7;
    planeScale += (1 - planeScale) * Math.min(1, dt * 3);
  }
  const s = planeScale;

  // --- camera rig ---
  flight.basisQuaternion(planeQuat);
  if (mode === 'fly' && auto.active) {
    camPos.copy(auto.camPos);
    _q.copy(auto.camQuat);
    camera.near = Math.max(0.3, 0.4 * s);
    camera.fov = auto.fov;
  } else if (mode === 'fly') {
    if (!camInit) {
      camQuat.copy(planeQuat);
      camInit = true;
    } else {
      camQuat.slerp(planeQuat, 1 - Math.exp(-dt * 6));
    }
    lookEuler.set(lookPitch, lookYaw, 0);
    lookQuat.setFromEuler(lookEuler);
    _q.copy(camQuat).multiply(lookQuat);
    if (chase) {
      _a.set(0, flight.spec.chase[0] * s, flight.spec.chase[1] * s).applyQuaternion(_q);
      camPos.copy(flight.p).add(_a);
      _q.multiply(pitchDown);
    } else {
      _a.set(0, flight.spec.eye[0] * s, flight.spec.eye[1] * s).applyQuaternion(camQuat);
      camPos.copy(flight.p).add(_a);
    }
    if (flight.stalled && !flight.grounded) {
      shakeEuler.set((Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.02);
      _q.multiply(shakeQuat.setFromEuler(shakeEuler));
    }
    camera.near = Math.max(0.3, 0.4 * s);
    const vNorm = flight.vn.length();
    const fovT = 65 + flight.spec.fov * smooth(vNorm, flight.spec.trimSpeed * 0.8, flight.spec.trimSpeed * 2.9);
    camera.fov += (fovT - camera.fov) * Math.min(1, dt * 3);
  } else if (mode === 'crash') {
    crashCamera(camPos, _q);
    camera.near = Math.max(0.3, 0.3 * crash.sc);
    camera.fov += (62 - camera.fov) * Math.min(1, dt * 3);
  } else if (mode === 'chute') {
    diver.cameraRig(camPos, _q, chuteGround.h);
    camera.near = 0.2;
    camera.fov += (diver.fov - camera.fov) * Math.min(1, dt * 4);
  } else {
    walker.eyePosition(camPos);
    walker.basisQuaternion(_q);
    camera.near = 0.1;
    camera.fov = 72;
  }
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(_q);
  camera.far = 1e8;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  plane.visible = !planeGone && mode !== 'crash' && (mode !== 'fly' || (auto.active ? auto.planeVisible : chase));
  plane.position.copy(flight.p).sub(camPos);
  plane.quaternion.copy(planeQuat);
  plane.scale.setScalar(s);
  plane.userData.update(dt, mode === 'fly' ? flight.eng : 0, {
    ab: mode === 'fly' ? flight.ab : 0,
    grounded: flight.grounded,
    agl: flight.alt - (world.ground.height ?? 0),
    speed: flight.speed,
  });
  if (mode === 'chute') diver.syncMeshes(camPos, dt);
  else diver.hide();

  // --- lighting uniforms ---
  const camUp = _a.copy(camPos).normalize();
  const camAlt = camPos.length() - R;
  const sunUp = camUp.dot(env.sun);
  const nightF = (1 - smooth(sunUp, -0.22, 0.04)) * (1 - smooth(camAlt, 20000, 120000));
  shared.uExposure.value = 0.9 + 0.9 * nightF;
  effects.update(dt, camPos, groundAt, smooth(sunUp, -0.12, 0.2));
  env.camPos.copy(camPos);
  shared.uUpC.value.copy(camUp);
  shared.uSunH.value.copy(env.sun).addScaledVector(camUp, -sunUp);
  if (shared.uSunH.value.lengthSq() < 1e-8) shared.uSunH.value.crossVectors(camUp, _b.set(0, 1, 0));
  if (shared.uSunH.value.lengthSq() < 1e-8) shared.uSunH.value.crossVectors(camUp, _b.set(1, 0, 0));
  shared.uSunH.value.normalize();
  shared.uSunE.value.crossVectors(camUp, shared.uSunH.value);
  shared.uCamAlt.value = camAlt;
  shared.uTime.value = (now - t0) / 1000;
  shared.uUseTrue.value = smooth(camAlt, 25000, 100000);

  const su = sky.material.uniforms;
  su.uInvProj.value.copy(camera.projectionMatrix).invert();
  su.uCamWorld.value.copy(camera.matrixWorld);
  su.uSpace.value = smooth(camAlt, 60000, 150000);
  weather.update(dt, {
    camPos,
    camUp,
    camAlt,
    forward: _wf.set(0, 0, -1).applyQuaternion(camera.quaternion),
    ground: world.ground.height,
    groundAt,
    paused,
    fov: camera.fov,
    height: renderer.domElement.height,
  });
  atmosphere.position.copy(camPos).negate();
  atmosphere.material.uniforms.uFade.value = THREE.MathUtils.clamp((camAlt - 40000) / 150000, 0, 1);

  // --- stream world ---
  const shScale = THREE.MathUtils.clamp(Math.max(1, agl / 250), 1, 10);
  const shStrength = shadows.enabled ? (1 - smooth(agl, 3000, 8000)) * smooth(sunUp, -0.03, 0.05) * (1 - weather.overcast) : 0;
  world.keepRadius = shStrength > 0 ? Math.min(900, shadows.extent(shScale)) : 0;
  const pos = mode === 'fly' ? flight.lat : mode === 'chute' ? diver.lat : mode === 'crash' ? crash.lat : walker.lat;
  const lon = currentLon();
  const m = llToMerc(pos, lon);
  world.update(camera, camPos, renderer.domElement.height / renderer.getPixelRatio(), m.u, m.v);

  // --- render ---
  skyLUT.render(renderer, camAlt, sunUp);
  shadows.render(renderer, scene, camPos, env.sun, shScale, shStrength);
  const bloomAmt = nightF * (1 - smooth(camAlt, 15000, 30000));
  if (bloomAmt > 0.02) {
    shared.uOutHDR.value = 1;
    bloom.render(renderer, scene, camera, bloomAmt, shared.uTime.value);
    shared.uOutHDR.value = 0;
  } else {
    renderer.render(scene, camera);
  }
  updateHud(dt, agl);
  if (auto.active && Math.abs(auto.fade - autoFadeShown) > 0.004) {
    autoFadeShown = auto.fade;
    $('auto-fade').style.opacity = autoFadeShown;
  }
}
frame();

window.__earth = {
  flight, walker, diver, world, camera, spawn, startOnFoot, PRESETS, WALK_PRESETS, sky, env, shared, atmosphere, shadows, renderer,
  get mode() { return mode; },
  get settle() { return settle; },
  get tod() { return tod; },
  setSunLon: (v) => { sunLon = v; },
  setHour: (h) => { sunLon = sunLonFor(currentLon(), h); },
  setDayRate: (v) => { dayRate = v; },
  setPaused: (v) => toggleMenu(v),
  startChute, touch, doAction, effects, startCrash,
  get crash() { return crash; },
  exitPlane, boardPlane, parkPlaneAhead, chooseAircraft, weather, auto, startAuto, stopAuto,
};
