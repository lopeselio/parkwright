import { basePack, buildContent, validateMod, type Content, type ModFile } from '@parkwright/content';
import { Park, rulesToHooks, type ActionRecord, type ActionResult, type ParkEvent, type ParkState } from '@parkwright/sim';

export const TICK_MS = 50; // 20 ticks per second at 1×
const SAVE_KEY = 'parkwright.save.v1';
/** A park you're visiting autosaves here, so your own park's save is never touched. */
const VISIT_KEY = 'parkwright.save.v1.visit';
const BACKUP_KEY = 'parkwright.save.v1.backup';
/** Keep the newest actions only; the snapshot already holds the result of older ones. */
const MAX_LOG = 5000;
const MODS_KEY = 'parkwright.mods.v1';

export interface SaveFile {
  v: 1;
  snapshot: ParkState;
  /** Actions since the game began (kept for verification/replay on the server). */
  log: ActionRecord[];
  savedAt: number;
  /** Mods the park was built with (data only), so anyone opening it gets the same content. */
  mods?: ModFile[];
}

/** Owns the simulation, its clock and the save. */
export class Game {
  park: Park;
  speed = 1;
  private acc = 0;
  private listeners: ((e: ParkEvent) => void)[] = [];
  private unsub: () => void = () => {};

  /** Loaded mods, in order. Content = base pack + these. */
  mods: ModFile[] = [];
  content: Content = buildContent([basePack]);

  constructor() {
    this.setMods(readMods());
    this.park = this.loadLocal() ?? Park.create(this.content, 'meadow', (Math.random() * 2 ** 31) | 0, 'Meadowbrook');
    this.park.hooks = this.hooks();
    this.wire();
  }

  private hooks() {
    return this.mods.flatMap((m) => rulesToHooks(m.pack.id, m.rules));
  }

  /** Re-validate and load a set of mods (also used when opening a park that brings its own). */
  private setMods(mods: ModFile[]) {
    const ok: ModFile[] = [];
    for (const m of mods) {
      try {
        // Re-validate on every load: a stored or shared mod is untrusted input too.
        const { mod } = validateMod({ name: m.pack.name, summary: m.summary, rideTypes: m.pack.rideTypes, items: m.pack.items, rules: m.rules }, buildContent([basePack, ...ok.map((x) => x.pack)]));
        if (!ok.some((x) => x.pack.id === mod.pack.id)) ok.push(mod);
      } catch { /* skip a broken mod */ }
    }
    this.mods = ok;
    this.content = buildContent([basePack, ...ok.map((m) => m.pack)]);
    if (this.park) { this.park.c = this.content; this.park.hooks = this.hooks(); }
  }

  /** Load a validated mod into the running park. */
  applyMod(mod: ModFile) {
    this.setMods([...this.mods.filter((m) => m.pack.id !== mod.pack.id), mod]);
    writeMods(this.mods);
    this.saveLocal();
  }

  /** Unload a mod, unless the park still uses something from it. */
  removeMod(id: string): string | null {
    const m = this.mods.find((x) => x.pack.id === id || x.pack.name.toLowerCase() === id.toLowerCase());
    if (!m) return `no mod "${id}" — try: mod list`;
    const used = this.s.rides.filter((r) => m.pack.rideTypes.some((t) => t.id === r.type));
    if (used.length) return `the park still has ${used.map((r) => r.name).join(', ')} from this mod — demolish them first`;
    this.setMods(this.mods.filter((x) => x !== m));
    writeMods(this.mods);
    return null;
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
    this.park.hooks = this.hooks();
    this.wire();
    this.saveLocal();
  }

  /** Play a copy of someone else's park without touching your own save. */
  visit(save: SaveFile) {
    if (!this.visiting) this.saveLocal(); // make sure your park is saved before switching away
    this.load(save);
    this.visiting = true;
  }

  /** Go back to your own park (from its local save). Returns false if there is none. */
  goHome(): boolean {
    this.visiting = false;
    this.setMods(readMods()); // your own mods, before your save is checked against them
    const p = this.loadLocal();
    if (!p) return false;
    this.park = p;
    this.park.c = this.content;
    this.park.hooks = this.hooks();
    this.wire();
    return true;
  }

  load(save: SaveFile) {
    // A park brings its own mods; they replace what's loaded (they're re-validated first).
    if (save.mods?.length) this.setMods(save.mods);
    const why = this.incompatible(save);
    if (why) throw new Error(why);
    this.park = new Park(structuredClone(save.snapshot), this.content);
    this.park.hooks = this.hooks();
    this.park.log.splice(0, this.park.log.length, ...save.log.slice(-MAX_LOG));
    this.wire();
  }

  /** Why a save can't run with the loaded content (renamed/removed ride types, unknown scenario), or null. */
  incompatible(save: SaveFile): string | null {
    if (save?.v !== 1 || !save.snapshot) return 'not a Parkwright v1 save';
    const s = save.snapshot;
    if (typeof s.scenario !== 'string' || !Object.hasOwn(this.content.scenarios, s.scenario)) return `unknown scenario "${s.scenario}"`;
    if (!Array.isArray(s.rides) || s.rides.some((r) => !r || typeof r.type !== 'string')) return 'malformed rides';
    const missing = s.rides.map((r) => r.type).filter((t) => !Object.hasOwn(this.content.rideTypes, t));
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
    return { v: 1, snapshot: this.park.snapshot(), log: this.park.log.slice(-MAX_LOG), savedAt: Date.now(), ...(this.mods.length ? { mods: this.mods } : {}) };
  }

  /** True while playing a copy of someone else's park. */
  visiting = false;

  saveLocal() {
    try {
      localStorage.setItem(this.visiting ? VISIT_KEY : SAVE_KEY, JSON.stringify(this.toSave()));
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
      p.hooks = this.hooks();
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

function readMods(): ModFile[] {
  try { const v = JSON.parse(localStorage.getItem(MODS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeMods(mods: ModFile[]) {
  try { localStorage.setItem(MODS_KEY, JSON.stringify(mods)); } catch { /* storage blocked */ }
}
