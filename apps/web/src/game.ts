import { baseContent, type Content } from '@parkwright/content';
import { Park, type ActionRecord, type ActionResult, type ParkEvent, type ParkState } from '@parkwright/sim';

export const TICK_MS = 50; // 20 ticks per second at 1×
const SAVE_KEY = 'parkwright.save.v1';
const BACKUP_KEY = 'parkwright.save.v1.backup';
/** Keep the newest actions only; the snapshot already holds the result of older ones. */
const MAX_LOG = 5000;

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
    const why = this.incompatible(save);
    if (why) throw new Error(why);
    this.park = new Park(structuredClone(save.snapshot), this.content);
    this.park.log.splice(0, this.park.log.length, ...save.log.slice(-MAX_LOG));
    this.wire();
  }

  /** Why a save can't run with the loaded content (renamed/removed ride types, unknown scenario), or null. */
  incompatible(save: SaveFile): string | null {
    if (save?.v !== 1 || !save.snapshot) return 'not a Parkwright v1 save';
    const s = save.snapshot;
    if (!this.content.scenarios[s.scenario]) return `unknown scenario "${s.scenario}"`;
    const missing = s.rides.map((r) => r.type).filter((t) => !this.content.rideTypes[t]);
    if (missing.length) return `this save needs ride types that aren't loaded: ${[...new Set(missing)].join(', ')}`;
    return null;
  }

  /** Set when the last save attempt failed (shown by the HUD). */
  saveError: string | null = null;

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
    return { v: 1, snapshot: this.park.snapshot(), log: this.park.log.slice(-MAX_LOG), savedAt: Date.now() };
  }

  saveLocal() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.toSave()));
      this.saveError = null;
    } catch (e) {
      this.saveError = `couldn't save: ${(e as Error).name === 'QuotaExceededError' ? 'browser storage is full' : (e as Error).message}`;
    }
  }

  private loadLocal(): Park | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      let save: SaveFile;
      try { save = JSON.parse(raw) as SaveFile; } catch { this.shelve(raw, 'unreadable save'); return null; }
      const why = this.incompatible(save);
      if (why) { this.shelve(raw, why); return null; }
      const p = new Park(save.snapshot, this.content);
      p.log.splice(0, p.log.length, ...save.log.slice(-MAX_LOG));
      return p;
    } catch { return null; }
  }

  /** Move a save we can't load aside instead of overwriting it, so a content fix can bring it back. */
  shelved: string | null = null;
  private shelve(raw: string, why: string) {
    try { localStorage.setItem(BACKUP_KEY, raw); localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    this.shelved = why;
  }
}
