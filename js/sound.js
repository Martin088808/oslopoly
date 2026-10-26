// Små syntetiserte lydeffekter (ingen lydfiler).
(function () {
  'use strict';
  let ctx = null;
  const Sound = {
    on: true,
    ensure() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    },
    tone(freq, dur, type = 'sine', vol = 0.15, delay = 0, slide = 0) {
      if (!this.on) return;
      const a = this.ensure(); if (!a) return;
      const t = a.currentTime + delay;
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    noise(dur, vol = 0.2, freq = 2000, delay = 0) {
      if (!this.on) return;
      const a = this.ensure(); if (!a) return;
      const t = a.currentTime + delay;
      const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
      const g = a.createGain(); g.gain.value = vol;
      src.connect(f).connect(g).connect(a.destination);
      src.start(t);
    },
    dice() { for (let k = 0; k < 4; k++) this.noise(0.05, 0.35, 2500 + Math.random() * 1500, k * 0.06); },
    bounce() { this.noise(0.04, 0.3, 1800); this.tone(180, 0.05, 'triangle', 0.08); },
    step() { this.tone(740, 0.05, 'triangle', 0.07); },
    coin() { this.tone(1700 + Math.random() * 500, 0.07, 'sine', 0.05); },
    cash() { this.tone(1320, 0.12, 'sine', 0.12); this.tone(1980, 0.22, 'sine', 0.1, 0.07); },
    pay() { this.tone(520, 0.12, 'triangle', 0.1); this.tone(390, 0.18, 'triangle', 0.1, 0.08); },
    buy() { [523, 659, 784, 1046].forEach((f, k) => this.tone(f, 0.18, 'triangle', 0.1, k * 0.07)); },
    build() { this.tone(160, 0.08, 'square', 0.06); this.noise(0.05, 0.2, 900, 0.01); this.tone(880, 0.1, 'sine', 0.06, 0.08); },
    bad() { this.tone(330, 0.25, 'sawtooth', 0.06, 0, -150); this.tone(220, 0.35, 'sawtooth', 0.06, 0.18, -100); },
    card() { this.noise(0.18, 0.18, 4000); },
    turn() { this.tone(660, 0.12, 'sine', 0.07); this.tone(990, 0.2, 'sine', 0.06, 0.08); },
    click() { this.tone(1200, 0.03, 'square', 0.03); },
    win() { [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, k) => this.tone(f, 0.28, 'triangle', 0.11, k * 0.12)); },
  };
  window.MP.Sound = Sound;
})();
