import { baseContent, type Content } from '@parkwright/content';
import { Park, type ActionRecord, type ActionResult, type ParkEvent, type ParkState } from '@parkwright/sim';

export const TICK_MS = 50; // 20 ticks per second at 1×
const SAVE_KEY = 'parkwright.save.v1';

export interface SaveFile {
  v: 1;
  snapshot: ParkState;
  /** Actions since the game began (kept for verification/replay on the server). */
  log: ActionRecord[];
  savedAt: number;
}

/** Owns the simulation, its clock and the save. */
export class Game {
  park: Park;
  speed = 1;
  private acc = 0;
  private listeners: ((e: ParkEvent) => void)[] = [];
  private unsub: () => void = () => {};

  constructor(readonly content: Content = baseContent) {
    this.park = this.loadLocal() ?? Park.create(content, 'meadow', (Math.random() * 2 ** 31) | 0, 'Meadowbrook');
    this.wire();
  }

  private wire() {
    this.unsub();
    this.unsub = this.park.on((e) => {
      for (const l of this.listeners) l(e);
      if (e.kind === 'day') this.saveLocal();
    });
  }

  on(fn: (e: ParkEvent) => void) { this.listeners.push(fn); }

  get s() { return this.park.s; }

  newGame(scenario: string, name: string) {
    this.park = Park.create(this.content, scenario, (Math.random() * 2 ** 31) | 0, name);
    this.wire();
    this.saveLocal();
  }

  load(save: SaveFile) {
    this.park = new Park(structuredClone(save.snapshot), this.content);
    this.park.log.push(...save.log);
    this.wire();
  }

  run(type: string, params: Record<string, unknown>, actor = 'player'): ActionResult {
    return this.park.run(type, params, actor);
  }

  /** Advance by real elapsed ms; returns the fraction toward the next tick (for interpolation). */
  update(dtMs: number): number {
    if (this.speed === 0) return 0;
    this.acc += Math.min(dtMs, 250) * this.speed;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 40) { this.park.tick(); this.acc -= TICK_MS; steps++; }
    return this.acc / TICK_MS;
  }

  toSave(): SaveFile {
    return { v: 1, snapshot: this.park.snapshot(), log: this.park.log, savedAt: Date.now() };
  }

  saveLocal() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.toSave())); } catch { /* storage full or blocked */ }
  }

  private loadLocal(): Park | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw) as SaveFile;
      if (save.v !== 1) return null;
      const p = new Park(save.snapshot, this.content);
      p.log.push(...save.log);
      return p;
    } catch { return null; }
  }
}
