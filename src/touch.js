// On-screen controls for phones and tablets. This module only turns finger input into a small shared state
// object (`touch`) that main.js reads every frame, plus a few callbacks for one-shot buttons.
const $ = (id) => document.getElementById(id);

export const TOUCH_DEVICE =
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || /[?&]touch=1\b/.test(location.search);

export const touch = {
  enabled: false,
  stick: { x: 0, y: 0 }, // -1..1, y up
  rudder: 0, // -1..1
  brake: false,
  sprint: false,
  jump: false,
  looking: false, // a finger is dragging the view
  lookDX: 0, // accumulated drag in CSS pixels since the last takeLook()
  lookDY: 0,
};

export function takeLook() {
  const out = [touch.lookDX, touch.lookDY];
  touch.lookDX = touch.lookDY = 0;
  return out;
}

const DEAD = 0.08;
const shape = (v) => {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  return Math.sign(v) * Math.pow((a - DEAD) / (1 - DEAD), 1.35);
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

let curMode = '';
export function setMode(mode) {
  if (mode === curMode) return;
  curMode = mode;
  const cl = document.body.classList;
  cl.remove('m-fly', 'm-walk', 'm-chute');
  cl.add(`m-${mode}`);
  touch.stick.x = touch.stick.y = 0;
  touch.rudder = 0;
  touch.brake = false;
  touch.jump = false;
  resetKnob();
}

export function setAction(label) {
  const b = $('tb-action');
  if (b.dataset.label === label) return;
  b.dataset.label = label;
  b.textContent = label;
  b.classList.toggle('on', !!label);
}

export function setThrottleDisplay(v) {
  $('tc-thr-fill').style.height = `${(v * 100).toFixed(0)}%`;
}

export function setSprint(v) {
  touch.sprint = v;
  $('tb-sprint').classList.toggle('active', v);
}

let knob;
function resetKnob() {
  if (knob) knob.style.transform = '';
}

function enable() {
  if (touch.enabled) return;
  touch.enabled = true;
  document.body.classList.add('touch');
  document.dispatchEvent(new Event('touchmode'));
}

// h: { onThrottle(v), onAction(), onMenu(), onCamera(), onSearch(), onFullscreen(), canLook(e) }
export function initTouch(h) {
  if (TOUCH_DEVICE) enable();
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') enable();
    },
    { capture: true, passive: true },
  );
  for (const el of [document.body, $('c')]) el.addEventListener('contextmenu', (e) => e.preventDefault());

  // virtual stick
  const pad = $('tc-stick');
  knob = pad.firstElementChild;
  let stickId = null;
  const stickTo = (e) => {
    const r = pad.getBoundingClientRect();
    const rad = r.width / 2;
    let dx = (e.clientX - (r.left + rad)) / rad;
    let dy = (e.clientY - (r.top + rad)) / rad;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    knob.style.transform = `translate(${dx * rad * 0.6}px, ${dy * rad * 0.6}px)`;
    touch.stick.x = shape(dx);
    touch.stick.y = shape(-dy);
  };
  pad.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    stickTo(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) stickTo(e);
  });
  const stickEnd = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    touch.stick.x = touch.stick.y = 0;
    resetKnob();
  };
  pad.addEventListener('pointerup', stickEnd);
  pad.addEventListener('pointercancel', stickEnd);

  // throttle lever
  const lever = $('tc-throttle');
  let leverId = null;
  const leverTo = (e) => {
    const r = lever.getBoundingClientRect();
    let v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    if (v < 0.04) v = 0;
    if (v > 0.97) v = 1;
    h.onThrottle(v);
    setThrottleDisplay(v);
  };
  lever.addEventListener('pointerdown', (e) => {
    if (leverId !== null) return;
    leverId = e.pointerId;
    lever.setPointerCapture(e.pointerId);
    leverTo(e);
    e.preventDefault();
  });
  lever.addEventListener('pointermove', (e) => {
    if (e.pointerId === leverId) leverTo(e);
  });
  const leverEnd = (e) => {
    if (e.pointerId === leverId) leverId = null;
  };
  lever.addEventListener('pointerup', leverEnd);
  lever.addEventListener('pointercancel', leverEnd);

  // press-and-hold buttons
  const hold = (id, on, off) => {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      on();
      e.preventDefault();
    });
    const up = () => {
      el.classList.remove('active');
      off();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  hold('tb-rl', () => (touch.rudder = -1), () => (touch.rudder = 0));
  hold('tb-rr', () => (touch.rudder = 1), () => (touch.rudder = 0));
  hold('tb-brake', () => (touch.brake = true), () => (touch.brake = false));
  hold('tb-jump', () => (touch.jump = true), () => (touch.jump = false));

  // taps
  const tap = (id, fn) => $(id).addEventListener('click', fn);
  tap('tb-sprint', () => setSprint(!touch.sprint));
  tap('tb-action', h.onAction);
  tap('tb-menu', h.onMenu);
  tap('tb-cam', h.onCamera);
  tap('tb-search', h.onSearch);
  tap('tb-full', h.onFullscreen);
  if (!document.documentElement.requestFullscreen) $('tb-full').style.display = 'none';

  // drag anywhere else to look around
  const cv = $('c');
  let lookId = null;
  let lx = 0;
  let ly = 0;
  cv.addEventListener('pointerdown', (e) => {
    if (lookId !== null || !h.canLook(e)) return;
    lookId = e.pointerId;
    lx = e.clientX;
    ly = e.clientY;
    touch.looking = true;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    touch.lookDX += e.clientX - lx;
    touch.lookDY += e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
  });
  const lookEnd = (e) => {
    if (e.pointerId !== lookId) return;
    lookId = null;
    touch.looking = false;
  };
  cv.addEventListener('pointerup', lookEnd);
  cv.addEventListener('pointercancel', lookEnd);
}
