import { basePack, buildContent, validateMod, type Content, type ModFile } from '@parkwright/content';
import { Park, rulesToHooks, type ActionRecord, type ActionResult, type ParkEvent, type ParkState } from '@parkwright/sim';

export const TICK_MS = 50; // 20 ticks per second at 1×
const SAVE_KEY = 'parkwright.save.v1';
/** A park you're visiting autosaves here, so your own park's save is never touched. */
const VISIT_KEY = 'parkwright.save.v1.visit';
const BACKUP_KEY = 'parkwright.save.v1.backup';
/** The full action log is kept (the server replays it to verify a published park); past this it's trimmed. */
const MAX_LOG = 50_000;
const MODS_KEY = 'parkwright.mods.v1';

export interface SaveFile {
  v: 1;
  snapshot: ParkState;
  /** Actions since the game began (kept for verification/replay on the server). */
  log: ActionRecord[];
  savedAt: number;
  /** Mods the park was built with (data only), so anyone opening it gets the same content. */
  mods?: ModFile[];
  /** True when `log` holds every action since the park was created, so the server can verify it by replay. */
  fullLog?: boolean;
}

/** Owns the simulation, its clock and the save. */
export class Game {
  park: Park;
  speed = 1;
  private acc = 0;
  private listeners: ((e: ParkEvent) => void)[] = [];
  private unsub: () => void = () => {};

  /** Whether this park's log goes back to its creation (new parks: yes; a trimmed or legacy save: no). */
  private fullLog = true;

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
    this.mods = validMods(mods);
    this.content = buildContent([basePack, ...this.mods.map((m) => m.pack)]);
    if (this.park) { this.park.c = this.content; this.park.hooks = this.hooks(); }
  }

  /** What in the park would break if `mod`'s current version went away: its rides, and stalls selling its items. */
  private usesOf(id: string): string[] {
    const m = this.mods.find((x) => x.pack.id === id);
    if (!m) return [];
    const types = new Set(m.pack.rideTypes.map((t) => t.id));
    const items = new Set(m.pack.items.map((i) => i.id));
    return this.s.rides.filter((r) => types.has(r.type) || items.has(this.content.rideTypes[r.type]?.item ?? '')).map((r) => r.name);
  }

  /** Load a validated mod into the running park. Returns why not, or null. */
  /**
   * True while the park could still be verified (and so settled and claimed on NEAR) but loading a mod now
   * would end that: the replay applies a save's mods from tick 0, so a mod loaded mid-game can't be replayed.
   */
  get modWouldBlockClaim(): boolean { return this.fullLog && this.s.tick > 0; }

  applyMod(mod: ModFile): string | null {
    // A park whose mods change mid-game can't be replayed from its log alone (mod rules would apply from
    // tick 0), so it stops being verifiable. Mod changes aren't actions yet.
    const marksUnverifiable = this.s.tick > 0;
    if (this.visiting) return "you're visiting someone else's park — go back to yours to change mods";
    // Replacing a mod with the same name must not pull out rides or items the park still uses.
    const old = this.mods.find((m) => m.pack.id === mod.pack.id);
    if (old) {
      const keepTypes = new Set(mod.pack.rideTypes.map((t) => t.id));
      const keepItems = new Set(mod.pack.items.map((i) => i.id));
      const lost = this.s.rides.filter((r) => (old.pack.rideTypes.some((t) => t.id === r.type) && !keepTypes.has(r.type))
        || (old.pack.items.some((i) => i.id === this.content.rideTypes[r.type]?.item) && !keepItems.has(this.content.rideTypes[r.type]!.item!)));
      if (lost.length) return `a mod called ${mod.pack.name} is already loaded and the park uses ${lost.map((r) => r.name).join(', ')} from it — rename the new one or demolish those first`;
    }
    this.setMods([...this.mods.filter((m) => m.pack.id !== mod.pack.id), mod]);
    if (marksUnverifiable) this.fullLog = false;
    writeMods(this.mods);
    this.saveLocal();
    return null;
  }

  /** Unload a mod, unless the park still uses something from it. */
  removeMod(id: string): string | null {
    if (this.visiting) return "you're visiting someone else's park — go back to yours to change mods";
    const m = this.mods.find((x) => x.pack.id === id || x.pack.name.toLowerCase() === id.toLowerCase());
    if (!m) return `no mod "${id}" — try: mod list`;
    const used = this.usesOf(m.pack.id);
    if (used.length) return `the park still uses ${used.join(', ')} from this mod — demolish them first`;
    // Another mod's stall may sell this mod's item.
    const items = new Set(m.pack.items.map((i) => i.id));
    const dependents = this.mods.filter((x) => x !== m && x.pack.rideTypes.some((t) => t.item && items.has(t.item)));
    if (dependents.length) return `${dependents.map((d) => d.pack.name).join(', ')} sells items from this mod — remove that first`;
    this.setMods(this.mods.filter((x) => x !== m));
    if (this.s.tick > 0) this.fullLog = false;
    writeMods(this.mods);
    return null;
  }


  private wire() {
    this.unsub();
    this.unsub = this.park.on((e) => {
      for (const l of this.listeners) l(e);
      if (e.kind === 'day') this.saveLocal();
    });
    for (const fn of this.replaced ?? []) fn();
  }

  on(fn: (e: ParkEvent) => void) { this.listeners.push(fn); }

  private replaced: (() => void)[] = [];
  /** Called whenever the running park is swapped (new game, load, visit, home). */
  onReplace(fn: () => void) { this.replaced.push(fn); }

  get s() { return this.park.s; }

  newGame(scenario: string, name: string) {
    // A new park is always your own: leave any park you were visiting, with your own mods.
    this.visiting = false;
    this.setMods(readMods());
    this.park = Park.create(this.content, scenario, (Math.random() * 2 ** 31) | 0, name);
    this.park.hooks = this.hooks();
    this.fullLog = true;
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

  /** Load a park. Its own mods (re-validated) replace what's loaded; `persist` also keeps them as yours. */
  load(save: SaveFile, persist = false) {
    if (save.mods?.length) { this.setMods(save.mods); if (persist) writeMods(this.mods); }
    const why = this.incompatible(save);
    if (why) throw new Error(why);
    this.park = new Park(structuredClone(save.snapshot), this.content);
    this.park.hooks = this.hooks();
    this.fullLog = save.fullLog === true;
    this.park.log.splice(0, this.park.log.length, ...save.log.slice(-MAX_LOG));
    this.wire();
  }

  /** Why a save can't run with the loaded content (renamed/removed ride types, unknown scenario), or null. */
  incompatible(save: SaveFile): string | null {
    if (save?.v !== 1 || !save.snapshot) return 'not a Parkwright v1 save';
    const s = save.snapshot;
    // A park that brings its own mods is checked against base + those mods (validated), not ours.
    const content = save.mods?.length ? buildContent([basePack, ...validMods(save.mods).map((m) => m.pack)]) : this.content;
    if (typeof s.scenario !== 'string' || !Object.hasOwn(content.scenarios, s.scenario)) return `unknown scenario "${s.scenario}"`;
    if (!Array.isArray(s.rides) || s.rides.some((r) => !r || typeof r.type !== 'string')) return 'malformed rides';
    const missing = s.rides.map((r) => r.type).filter((t) => !Object.hasOwn(content.rideTypes, t));
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
    // A log too big to publish (the server takes ≤ 1.8 MB per save) can't be verified, so say so up front.
    const fullLog = this.fullLog && this.park.log.length <= MAX_LOG && JSON.stringify(this.park.log).length < 1_200_000;
    return { v: 1, snapshot: this.park.snapshot(), log: this.park.log.slice(-MAX_LOG), savedAt: Date.now(), fullLog, ...(this.mods.length ? { mods: this.mods } : {}) };
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
      if (save.mods?.length) { this.setMods(save.mods); writeMods(this.mods); }
      const p = new Park(save.snapshot, this.content);
      p.log.splice(0, p.log.length, ...save.log.slice(-MAX_LOG));
      p.hooks = this.hooks();
      this.fullLog = save.fullLog === true;
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

/** Re-validate mods in order (each against base + the ones before it); drop broken ones and duplicates. */
function validMods(mods: ModFile[]): ModFile[] {
  const ok: ModFile[] = [];
  for (const m of Array.isArray(mods) ? mods.slice(0, 8) : []) {
    try {
      const { mod } = validateMod({ name: m?.pack?.name, summary: m?.summary, rideTypes: m?.pack?.rideTypes, items: m?.pack?.items, rules: m?.rules }, buildContent([basePack, ...ok.map((x) => x.pack)]));
      if (!ok.some((x) => x.pack.id === mod.pack.id)) ok.push(mod);
    } catch { /* skip a broken mod */ }
  }
  return ok;
}

function readMods(): ModFile[] {
  try { const v = JSON.parse(localStorage.getItem(MODS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeMods(mods: ModFile[]) {
  try { localStorage.setItem(MODS_KEY, JSON.stringify(mods)); } catch { /* storage blocked */ }
}
