// Procedural weather sound: filtered-noise rain and wind beds plus rumbling thunder, all synthesised with WebAudio.
export class WeatherAudio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  // Browsers only allow audio after a user gesture, so this is called from input handlers.
  unlock() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.build(new AC());
      } catch (e) {
        this.enabled = false;
        return;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  noise(seconds, brown) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
    return buf;
  }

  build(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.white = this.noise(3, false);
    this.brown = this.noise(4, true);

    const loop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7500;
    loop(this.white).connect(hp);
    hp.connect(lp);
    lp.connect(this.rainGain);
    this.rainGain.connect(this.master);

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 1.2;
    loop(this.brown).connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
  }

  update({ rain, wind, storm, outside, paused }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.enabled && !paused ? 1 : 0;
    this.master.gain.setTargetAtTime(on * 0.8, t, 0.3);
    this.rainGain.gain.setTargetAtTime(Math.pow(rain, 0.8) * 0.28 * outside, t, 0.4);
    this.windGain.gain.setTargetAtTime((0.025 + wind / 30 * 0.2 + storm * 0.08) * outside, t, 0.4);
    this.windFilter.frequency.setTargetAtTime(280 + wind * 22, t, 0.5);
  }

  thunder(distance, delay) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const when = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // far thunder is only a low rumble
    const bright = Math.max(0.15, 1 - distance / 6000);
    lp.frequency.setValueAtTime(250 + 900 * bright, when);
    lp.frequency.exponentialRampToValueAtTime(90, when + 4);
    const g = ctx.createGain();
    const peak = 0.9 * (0.35 + 0.65 * bright);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.06 + (1 - bright) * 0.4);
    // a couple of secondary rolls make it rumble rather than boom once
    g.gain.exponentialRampToValueAtTime(peak * 0.35, when + 0.9);
    g.gain.exponentialRampToValueAtTime(peak * 0.6, when + 1.4);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 4.5);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    src.start(when, Math.random() * 2);
    src.stop(when + 5);
  }
}
