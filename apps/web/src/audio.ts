// Park sounds, all synthesized with Web Audio (no audio files to download).
//
// Sound starts on the player's first click, tap or key (browsers block audio before that), follows
// what the sim does (sales, arrivals, coaster runs, breakdowns, building, errors) and has a crowd bed
// whose loudness follows how many visitors are in the park. M or the 🔊 button mutes; that's remembered.
import type { Game } from './game.ts';

const MUTE_KEY = 'parkwright.mute.v1';
const income = (s: { ledgerTotal: Record<string, number> }) => s.ledgerTotal.gate + s.ledgerTotal.rides + s.ledgerTotal.stalls;

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export class ParkAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = readMuted();
  onChange: () => void = () => {};

  /** Last values seen, to turn sim state into one-shot sounds. */
  private seen = { income: NaN, visitors: -1, park: '' as unknown, log: 0, cycles: new Map<number, number>(), status: new Map<number, string>() };
  /** The crowd level last asked for (automation events are only added when it changes). */
  private crowdLevel = -1;
  /** Rate limits per sound (ms timestamps). */
  private last = new Map<string, number>();

  constructor(private game: Game) {
    // Browsers only let audio start from a user activation: a key, or the END of a touch/click (pointerdown
    // doesn't count on phones). Keep trying on each one until the context is actually running.
    const gestures = ['pointerup', 'touchend', 'keydown'] as const;
    const unlock = () => {
      this.start();
      if (this.ctx && this.ctx.state !== 'running' && !this.muted && !document.hidden) void this.ctx.resume().catch(() => {});
      if (this.ctx?.state === 'running' || this.muted) for (const g of gestures) removeEventListener(g, unlock, true);
    };
    for (const g of gestures) addEventListener(g, unlock, true);
    this.unlock = unlock;
    addEventListener('pw:toast', (e) => { if ((e as CustomEvent).detail === 'err') this.play('error'); });
    document.addEventListener('visibilitychange', () => this.sync());
  }

  private unlock: () => void = () => {};
  private failed = false;

  /** Run the context only while it's wanted: not muted and the tab visible (no CPU spent on silence). */
  private sync() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.muted || document.hidden) void ctx.suspend().catch(() => {});
    else void ctx.resume().catch(() => {});
  }

  private start() {
    if (this.ctx || this.failed || this.muted) return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) { this.failed = true; return; }
    let ctx: AudioContext;
    try { ctx = new AC(); } catch { this.failed = true; return; }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);
    // One second of white noise, reused by every noisy sound.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // Crowd bed: band-passed noise with a slow wobble; its gain follows the visitor count.
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.6;
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 0.23;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 250;
    wobble.connect(wobbleDepth).connect(band.frequency);
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0;
    src.connect(band).connect(this.crowd).connect(this.master);
    src.start();
    wobble.start();
  }

  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* private mode */ }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.05);
    if (!this.muted) {
      // Unmuting is itself a gesture: start (or resume) here, and listen again in case it's still blocked.
      this.start();
      for (const g of ['pointerup', 'touchend', 'keydown']) addEventListener(g, this.unlock, true);
    }
    this.sync();
    if (!this.muted) this.play('click');
    this.onChange();
  }

  /** Call once per frame: turns what changed in the sim into sounds. */
  update() {
    const s = this.game.s;
    if (this.seen.park !== s) {
      // A different park (new, load, visit): start fresh rather than "hearing" the whole park appear.
      this.seen = { income: income(s), visitors: s.visitors.length, park: s, log: this.game.park.log.length, cycles: new Map(), status: new Map() };
      for (const r of s.rides) { this.seen.cycles.set(r.id, r.cycle); this.seen.status.set(r.id, r.status); }
      return;
    }
    // Every action that went through (clicks, the terminal, the AI, Claude over MCP) is in the log.
    const log = this.game.park.log;
    const fresh = log.length > this.seen.log ? log.slice(this.seen.log) : [];
    this.seen.log = log.length;
    if (!this.ctx || this.muted || this.ctx.state !== 'running') {
      this.seen.income = income(s);
      this.seen.visitors = s.visitors.length;
      for (const r of s.rides) { this.seen.cycles.set(r.id, r.cycle); this.seen.status.set(r.id, r.status); }
      return;
    }
    for (const a of fresh.slice(-3)) this.built(a.type);
    const t = this.ctx.currentTime;
    // Crowd loudness: grows with visitors, quiet when paused.
    const n = s.visitors.length;
    const target = this.game.speed === 0 ? 0 : Math.min(0.09, Math.sqrt(n) * 0.006);
    if (Math.abs(target - this.crowdLevel) > 0.002) { this.crowd!.gain.setTargetAtTime(target, t, 0.8); this.crowdLevel = target; }

    // Coins for money visitors spend (gate, rides, stalls) — not loans or refunds.
    const inc = income(s);
    if (inc > this.seen.income) this.play('coin');
    this.seen.income = inc;
    if (n > this.seen.visitors) this.play('arrive');
    this.seen.visitors = n;

    if (this.seen.cycles.size > s.rides.length) {
      // Demolished rides: forget them.
      const ids = new Set(s.rides.map((r) => r.id));
      for (const id of [...this.seen.cycles.keys()]) if (!ids.has(id)) { this.seen.cycles.delete(id); this.seen.status.delete(id); }
    }
    for (const r of s.rides) {
      const prevCycle = this.seen.cycles.get(r.id);
      const prevStatus = this.seen.status.get(r.id);
      // A ride starts a run when its cycle counter jumps back up.
      if (prevCycle !== undefined && r.cycle > prevCycle && r.status === 'open') this.play(r.track ? 'coaster' : 'ride');
      if (prevStatus && prevStatus !== 'broken' && r.status === 'broken') this.play('breakdown');
      this.seen.cycles.set(r.id, r.cycle);
      this.seen.status.set(r.id, r.status);
    }
  }

  /** A build or other player action went through. */
  built(type: string) {
    if (type.startsWith('path.') || type.startsWith('scenery.')) this.play('place');
    else if (type.endsWith('.demolish') || type.endsWith('.remove')) this.play('demolish');
    else if (type.startsWith('ride.') || type.startsWith('coaster.') || type.startsWith('bin.')) this.play('build');
    else this.play('click');
  }

  play(kind: 'coin' | 'arrive' | 'ride' | 'coaster' | 'breakdown' | 'place' | 'build' | 'demolish' | 'click' | 'error') {
    const ctx = this.ctx;
    if (!ctx || this.muted || !this.master) return;
    const gap = { coin: 400, arrive: 900, ride: 600, coaster: 2500, breakdown: 1500, place: 60, build: 80, demolish: 120, click: 40, error: 300 }[kind];
    const now = performance.now();
    if (now - (this.last.get(kind) ?? -1e9) < gap) return;
    this.last.set(kind, now);
    const t = ctx.currentTime;
    const out = this.master;
    const tone = (freq: number, start: number, dur: number, type: OscillatorType, vol: number, glide?: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + start);
      if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + start + dur);
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(vol, t + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(out);
      o.start(t + start);
      o.stop(t + start + dur + 0.02);
    };
    const hiss = (start: number, dur: number, freq: number, vol: number, type: BiquadFilterType = 'bandpass', sweep?: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t + start);
      if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + start + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(vol, t + start + dur * 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t + start);
      src.stop(t + start + dur + 0.02);
    };
    switch (kind) {
      case 'coin': tone(1568, 0, 0.09, 'triangle', 0.05); tone(2093, 0.06, 0.16, 'triangle', 0.045); break;
      case 'arrive': tone(659, 0, 0.18, 'sine', 0.03); tone(880, 0.09, 0.22, 'sine', 0.025); break;
      case 'ride': for (let i = 0; i < 4; i++) tone([523, 659, 784, 659][i], i * 0.11, 0.2, 'triangle', 0.03); break;
      case 'coaster':
        for (let i = 0; i < 10; i++) hiss(i * 0.09, 0.04, 2400, 0.05, 'highpass'); // the lift chain clacking
        hiss(1.0, 1.4, 300, 0.09, 'bandpass', 2200); // the rush down the drop
        tone(880, 1.15, 0.5, 'sawtooth', 0.012, 1320); // a distant scream
        break;
      case 'breakdown': tone(180, 0, 0.35, 'square', 0.05, 70); hiss(0, 0.3, 900, 0.06); break;
      case 'place': tone(320, 0, 0.06, 'triangle', 0.05, 220); break;
      case 'build': hiss(0, 0.12, 500, 0.08, 'lowpass'); tone(196, 0, 0.14, 'sine', 0.08, 110); tone(784, 0.08, 0.12, 'triangle', 0.03); break;
      case 'demolish': hiss(0, 0.35, 1200, 0.1, 'lowpass', 200); tone(110, 0, 0.3, 'sine', 0.07, 55); break;
      case 'click': tone(1200, 0, 0.03, 'square', 0.015); break;
      case 'error': tone(220, 0, 0.12, 'square', 0.035); tone(165, 0.1, 0.18, 'square', 0.035); break;
    }
  }
}
