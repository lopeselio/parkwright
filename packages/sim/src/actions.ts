import type { Content, StaffRole } from '@parkwright/content';
import { book } from './economy.ts';
import { SCENERY, accessTiles, entranceFor, idx, inBounds, isPath, rotatedSize, sceneryByName, tileAt } from './map.ts';
import { Tile, type Dir, type LedgerCategory, type ParkState, type Ride } from './types.ts';

export interface Focus {
  x: number;
  y: number;
  label?: string;
}

export type ActionResult =
  | { ok: true; cost: number; focus?: Focus; data?: unknown; message?: string }
  | { ok: false; error: string; hint?: string };

export interface Ctx {
  s: ParkState;
  c: Content;
}

export interface ActionDef<P = any> {
  type: string;
  summary: string;
  /** Param names in CLI order, with a short description. */
  params: { name: string; desc: string; optional?: boolean }[];
  /** Ledger category charged for the cost. */
  category?: LedgerCategory;
  query(ctx: Ctx, p: P): ActionResult;
  execute(ctx: Ctx, p: P): ActionResult;
}

export type Hook = {
  mod: string;
  /** Called after the built-in query passes. Return a failure to veto, or a number to replace the cost. */
  query?: (ctx: Readonly<Ctx>, type: string, params: unknown, res: ActionResult & { ok: true }) => ActionResult | number | void;
  execute?: (ctx: Readonly<Ctx>, type: string, params: unknown, res: ActionResult) => void;
};

const fail = (error: string, hint?: string): ActionResult => ({ ok: false, error, hint });

export const PATH_COST = 1000;
export const QUEUE_COST = 1400;
export const BIN_COST = 600;
export const DEMOLISH_REFUND = 0.5;

export function findRide(s: ParkState, ref: unknown): Ride | undefined {
  if (typeof ref === 'number') return s.rides.find((r) => r.id === ref);
  if (typeof ref === 'string') {
    const n = ref.trim().toLowerCase();
    if (!n) return undefined;
    if (/^\d+$/.test(n)) return s.rides.find((r) => r.id === Number(n));
    const name = (r: Ride) => r.name.toLowerCase();
    return s.rides.find((r) => name(r) === n)
      ?? s.rides.find((r) => name(r).startsWith(n))
      ?? s.rides.find((r) => r.type === n)
      ?? s.rides.find((r) => name(r).split(/\s+/).some((w) => w.startsWith(n)))
      ?? s.rides.find((r) => name(r).includes(n));
  }
  return undefined;
}

/**
 * Resolve a ride type the way people (and models) type it: exact id, display name, underscores/spaces
 * for dashes, a unique prefix or a whole word of the name ("swing" → swings, "lemonade_stand",
 * "drop tower" → droptower). Deterministic for given content, so replays resolve the same way.
 */
export function findRideType(c: Content, ref: unknown): string | undefined {
  const raw = String(ref ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  const types = Object.values(c.rideTypes);
  if (c.rideTypes[raw]) return raw;
  const dashed = raw.replace(/[\s_]+/g, '-');
  if (c.rideTypes[dashed]) return dashed;
  const squashed = raw.replace(/[\s_-]+/g, '');
  const byName = types.find((t) => t.name.toLowerCase() === raw || t.name.toLowerCase().replace(/\s+/g, '') === squashed);
  if (byName) return byName.id;
  const pre = types.filter((t) => t.id.startsWith(dashed) || t.id.replace(/-/g, '').startsWith(squashed));
  if (pre.length === 1) return pre[0].id;
  const word = types.filter((t) => t.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(raw)));
  if (word.length === 1) return word[0].id;
  const stem = types.filter((t) => t.id.replace(/-/g, '').startsWith(squashed.replace(/s$/, '')));
  return stem.length === 1 ? stem[0].id : undefined;
}

function rideHint(s: ParkState) {
  return s.rides.length ? `rides: ${s.rides.map((r) => r.name).join(', ')}` : 'no rides built yet';
}

function lineTiles(x: number, y: number, x2?: number, y2?: number): [number, number][] {
  const ax = x2 ?? x, ay = y2 ?? y;
  const out: [number, number][] = [];
  for (let j = Math.min(y, ay); j <= Math.max(y, ay); j++)
    for (let i = Math.min(x, ax); i <= Math.max(x, ax); i++) out.push([i, j]);
  return out;
}

const int = (v: unknown) => (typeof v === 'number' ? v : Number(v));

/** Integer-valued params, by name. Anything else here would make replay diverge (NaN → null in JSON). */
const INT_PARAMS = ['x', 'y', 'x2', 'y2', 'rot', 'weeks', 'dir', 'count'] as const;
const COORDS = new Set(['x', 'y', 'x2', 'y2']);

/** Reject non-integer or off-map coordinates before any action runs. */
export function checkParams(s: ParkState, p: Record<string, unknown>): ActionResult | null {
  for (const k of INT_PARAMS) {
    if (p[k] === undefined || p[k] === null) continue;
    const v = typeof p[k] === 'number' ? (p[k] as number) : Number(p[k]);
    if (!Number.isInteger(v)) return fail(`${k} must be a whole number, got "${p[k]}"`);
    if (COORDS.has(k)) {
      const max = (k.startsWith('x') ? s.w : s.h) - 1;
      if (v < 0 || v > max) return fail(`${k}=${v} is off the map`, `the map is ${s.w}×${s.h} (0–${s.w - 1}, 0–${s.h - 1})`);
    }
  }
  if (p.rot !== undefined && p.rot !== null && (Number(p.rot) < 0 || Number(p.rot) > 3)) return fail('rot must be 0–3 (entrance side: 0 N, 1 E, 2 S, 3 W)');
  if (p.weeks !== undefined && p.weeks !== null && (Number(p.weeks) < 1 || Number(p.weeks) > 8)) return fail('weeks must be 1–8');
  if (p.dir !== undefined && p.dir !== null && (Number(p.dir) < 0 || Number(p.dir) > 3)) return fail('dir must be 0–3 (0 N, 1 E, 2 S, 3 W)');
  return null;
}

function freeCell(s: ParkState, x: number, y: number) {
  const k = idx(s, x, y);
  return s.tiles[k] === Tile.Grass && s.occ[k] === 0 && s.scenery[k] === 0;
}

function nearestPath(s: ParkState, x: number, y: number): string {
  let best: [number, number] | null = null, bd = Infinity;
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    if (!isPath(s, i, j)) continue;
    const d = Math.abs(i - x) + Math.abs(j - y);
    if (d < bd) { bd = d; best = [i, j]; }
  }
  return best ? `nearest path tile ${best[0]},${best[1]}` : 'there are no path tiles yet';
}

export const ACTIONS: Record<string, ActionDef> = {};
const def = (a: ActionDef) => { ACTIONS[a.type] = a; };

def({
  type: 'path.place',
  summary: 'Lay path (or queue) tiles from x,y to x2,y2',
  params: [
    { name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' },
    { name: 'x2', desc: 'end x (line/rect)', optional: true }, { name: 'y2', desc: 'end y', optional: true },
    { name: 'queue', desc: 'lay queue instead of path', optional: true },
  ],
  category: 'construction',
  query({ s }, p) {
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    const want = p.queue ? Tile.Queue : Tile.Path;
    let n = 0;
    for (const [x, y] of tiles) {
      if (!inBounds(s, x, y)) return fail(`${x},${y} is off the map`, `the map is ${s.w}×${s.h} (0–${s.w - 1}, 0–${s.h - 1})`);
      const k = idx(s, x, y);
      if (s.occ[k]) {
        const r = s.rides.find((q) => q.id === s.occ[k]);
        if (r && x === r.ex && y === r.ey) {
          // Laying path *on* an entrance is a common mistake: point at a free tile next to it instead.
          const free = [0, 1, 2, 3].map((d) => [r.ex + [0, 1, 0, -1][d], r.ey + [-1, 0, 1, 0][d]] as [number, number])
            .find(([fx, fy]) => inBounds(s, fx, fy) && (isPath(s, fx, fy) || freeCell(s, fx, fy)));
          return fail(`${x},${y} is the entrance of ${r.name}`, free ? `lay path on a tile next to it, e.g. ${free[0]},${free[1]}, and on to an existing path` : 'every tile around it is blocked — clear one');
        }
        return fail(`${x},${y} is taken by ${r?.name}`);
      }
      if (s.tiles[k] !== want) n++;
    }
    if (n === 0) return fail('those tiles are already that kind of path');
    return { ok: true, cost: n * (p.queue ? QUEUE_COST : PATH_COST), focus: { x: int(p.x), y: int(p.y) } };
  },
  execute({ s }, p) {
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    const want = p.queue ? Tile.Queue : Tile.Path;
    let n = 0;
    for (const [x, y] of tiles) {
      const k = idx(s, x, y);
      if (s.tiles[k] !== want) { s.tiles[k] = want; s.scenery[k] = 0; n++; }
    }
    s.mapVersion++;
    return { ok: true, cost: n * (p.queue ? QUEUE_COST : PATH_COST), focus: { x: int(p.x), y: int(p.y) }, message: `laid ${n} ${p.queue ? 'queue' : 'path'} tile${n === 1 ? '' : 's'}` };
  },
});

def({
  type: 'path.remove',
  summary: 'Remove path tiles from x,y to x2,y2',
  params: [
    { name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' },
    { name: 'x2', desc: 'end x', optional: true }, { name: 'y2', desc: 'end y', optional: true },
  ],
  query({ s }, p) {
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    if (tiles.some(([x, y]) => x === s.gate[0] && y === s.gate[1])) return fail('the gate tile must stay a path');
    const entrance = s.rides.find((r) => tiles.some(([x, y]) => x === r.ex && y === r.ey) && isPath(s, r.ex, r.ey));
    if (entrance) return fail(`${entrance.ex},${entrance.ey} is the entrance of ${entrance.name}`, 'demolish the ride first, or leave that tile');
    if (!tiles.some(([x, y]) => inBounds(s, x, y) && tileAt(s, x, y) !== Tile.Grass)) return fail('no path there');
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    for (const [x, y] of tiles) if (inBounds(s, x, y)) { const k = idx(s, x, y); s.tiles[k] = Tile.Grass; s.bins[k] = 0; }
    s.mapVersion++;
    return { ok: true, cost: 0, focus: { x: int(p.x), y: int(p.y) } };
  },
});

function placement(ctx: Ctx, p: any) {
  const { s, c } = ctx;
  const t = c.rideTypes[findRideType(c, p.type) ?? ''];
  if (!t) {
    const ids = Object.values(c.rideTypes).filter((r) => r.kind !== 'track').map((r) => r.id);
    return { err: fail(`unknown ride type "${p.type}"`, `try one of: ${ids.join(', ')}`) };
  }
  if (t.kind === 'track') return { err: fail('coasters are built piece by piece', 'use coaster.start') };
  const sc = c.scenarios[s.scenario];
  if (sc && sc.rides.length && !sc.rides.includes(t.id)) return { err: fail(`${t.name} isn't available in this scenario`) };
  const rot = (int(p.rot ?? 2) & 3) as Dir;
  const [w, h] = rotatedSize(t.size[0], t.size[1], rot);
  const x = int(p.x), y = int(p.y);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    if (!inBounds(s, i, j)) return { err: fail(`${t.name} (${w}×${h}) doesn't fit at ${x},${y}`, 'move it inside the map') };
    if (!freeCell(s, i, j)) return { err: fail(`${i},${j} is not free`, `${t.name} needs ${w}×${h} clear grass`) };
  }
  const [ex, ey] = entranceFor(x, y, w, h, rot);
  if (!inBounds(s, ex, ey)) return { err: fail('the entrance would be off the map', 'rotate the ride (rot 0–3)') };
  const ek = idx(s, ex, ey);
  // The entrance may open straight onto a path, or onto grass (it becomes an entrance tile).
  if (s.occ[ek] || s.scenery[ek] || s.tiles[ek] === Tile.Queue) return { err: fail(`the entrance tile ${ex},${ey} is blocked`, 'rotate or move the ride') };
  return { t, rot, w, h, x, y, ex, ey };
}

def({
  type: 'ride.build',
  summary: 'Build a flat ride, stall or facility with its entrance facing rot (0 N, 1 E, 2 S, 3 W)',
  params: [
    { name: 'type', desc: 'ride type id' }, { name: 'x', desc: 'tile x (top-left)' }, { name: 'y', desc: 'tile y (top-left)' },
    { name: 'rot', desc: 'entrance side 0–3 (default 2 = south)', optional: true }, { name: 'name', desc: 'custom name', optional: true },
  ],
  category: 'construction',
  query(ctx, p) {
    const pl = placement(ctx, p);
    if ('err' in pl) return pl.err!;
    const adj = isPath(ctx.s, pl.ex, pl.ey) || [0, 1, 2, 3].some((d) => isPath(ctx.s, pl.ex + [0, 1, 0, -1][d], pl.ey + [-1, 0, 1, 0][d]));
    return { ok: true, cost: pl.t.cost, focus: { x: pl.x, y: pl.y, label: pl.t.name }, message: adj ? undefined : `no path touches the entrance at ${pl.ex},${pl.ey} yet` };
  },
  execute(ctx, p) {
    const pl = placement(ctx, p);
    if ('err' in pl) return pl.err!;
    const { s } = ctx;
    const id = s.nextId++;
    const n = s.rides.filter((r) => r.type === pl.t.id).length + 1;
    const ride: Ride = {
      id, type: pl.t.id, name: p.name ? String(p.name) : n > 1 ? `${pl.t.name} ${n}` : pl.t.name,
      x: pl.x, y: pl.y, rot: pl.rot, w: pl.w, h: pl.h, ex: pl.ex, ey: pl.ey,
      price: pl.t.defaultPrice, status: pl.t.kind === 'flat' ? 'closed' : 'open', ratings: null, value: 0,
      reliability: 10000, builtDay: s.day, queue: [], riders: [], cycle: 0, loadWait: 0, brokenSince: -1, lastInspected: s.day,
      customers: 0, income: 0, incomeWeek: 0, satisfaction: [],
    };
    for (let j = pl.y; j < pl.y + pl.h; j++) for (let i = pl.x; i < pl.x + pl.w; i++) s.occ[idx(s, i, j)] = id;
    if (!isPath(s, pl.ex, pl.ey)) s.occ[idx(s, pl.ex, pl.ey)] = id;
    s.rides.push(ride);
    s.mapVersion++;
    const linked = isPath(s, pl.ex, pl.ey) || [0, 1, 2, 3].some((d) => isPath(s, pl.ex + [0, 1, 0, -1][d], pl.ey + [-1, 0, 1, 0][d]));
    const where = `entrance at ${pl.ex},${pl.ey}${linked ? ', touching a path' : ' — no path touches it yet'}`;
    return { ok: true, cost: pl.t.cost, focus: { x: pl.x, y: pl.y, label: ride.name }, data: { id }, message: `built ${ride.name} (#${id}), ${where}${pl.t.kind === 'flat' ? '; it is closed — open it when ready' : ''}` };
  },
});

def({
  type: 'ride.demolish',
  summary: 'Demolish a ride (refunds half its build cost)',
  params: [{ name: 'ride', desc: 'ride name or id' }],
  query({ s }, p) {
    const r = findRide(s, p.ride);
    if (!r) return fail(`no ride "${p.ride}"`, rideHint(s));
    return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name } };
  },
  execute({ s, c }, p) {
    const r = findRide(s, p.ride)!;
    for (const vid of [...r.queue, ...r.riders]) {
      const v = s.visitors.find((x) => x.id === vid);
      if (v) { const [x, y] = accessTiles(s, r)[0] ?? s.gate; v.mode = 'walking'; v.goal = null; v.tx = v.nx = x; v.ty = v.ny = y; v.p = 0; }
    }
    for (let k = 0; k < s.occ.length; k++) if (s.occ[k] === r.id) s.occ[k] = 0;
    s.rides = s.rides.filter((x) => x.id !== r.id);
    s.mapVersion++;
    // Refund half of what was actually paid (a mod may have changed the price), never the list price.
    const refund = Math.floor((r.paid ?? c.rideTypes[r.type].cost) * DEMOLISH_REFUND);
    book(s, 'refunds', refund);
    return { ok: true, cost: 0, focus: { x: r.x, y: r.y }, message: `demolished ${r.name}, refunded ${(refund / 100).toFixed(2)} cr` };
  },
});

def({
  type: 'ride.price',
  summary: 'Set the ticket price of a ride or stall, in credits',
  params: [{ name: 'ride', desc: 'ride name or id' }, { name: 'price', desc: 'price in cr (e.g. 2.5)' }],
  query({ s }, p) {
    const r = findRide(s, p.ride);
    if (!r) return fail(`no ride "${p.ride}"`, rideHint(s));
    const cents = Math.round(Number(p.price) * 100);
    if (!Number.isFinite(cents) || cents < 0 || cents > 5000) return fail('price must be between 0 and 50 cr');
    return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name } };
  },
  execute({ s }, p) {
    const r = findRide(s, p.ride)!;
    r.price = Math.round(Number(p.price) * 100);
    const hint = r.value ? ` (visitors value it at about ${(r.value / 100).toFixed(2)} cr)` : '';
    return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name }, message: `${r.name} now costs ${(r.price / 100).toFixed(2)} cr${hint}` };
  },
});

for (const open of [true, false]) {
  def({
    type: open ? 'ride.open' : 'ride.close',
    summary: open ? 'Open a ride to visitors' : 'Close a ride (ejects its queue)',
    params: [{ name: 'ride', desc: 'ride name or id' }],
    query({ s, c }, p) {
      const r = findRide(s, p.ride);
      if (!r) return fail(`no ride "${p.ride}"`, rideHint(s));
      if (open && r.status === 'broken') return fail(`${r.name} is broken down`, 'hire a mechanic; they fix broken rides');
      if (open && r.status === 'open') return fail(`${r.name} is already open`);
      if (!open && r.status === 'closed') return fail(`${r.name} is already closed`);
      if (open && c.rideTypes[r.type].kind === 'track' && !r.ratings) return fail(`${r.name} hasn't passed a test run`, 'finish the circuit and run coaster.test');
      return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name } };
    },
    execute({ s }, p) {
      const r = findRide(s, p.ride)!;
      r.status = open ? 'open' : 'closed';
      if (!open) ejectQueue(s, r);
      return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name }, message: `${r.name} is ${r.status}` };
    },
  });
}

export function ejectQueue(s: ParkState, r: Ride) {
  for (const vid of r.queue) {
    const v = s.visitors.find((x) => x.id === vid);
    if (!v) continue;
    v.mode = 'walking';
    v.goal = null;
    v.happy = Math.max(0, v.happy - 10);
    v.thoughts.unshift({ kind: 'ride closed', ride: r.id, day: s.day });
    v.thoughts.length = Math.min(v.thoughts.length, 5);
  }
  r.queue = [];
}

def({
  type: 'park.fee',
  summary: 'Set the park entry fee, in credits',
  params: [{ name: 'fee', desc: 'fee in cr' }],
  query(_c, p) {
    const cents = Math.round(Number(p.fee) * 100);
    if (!Number.isFinite(cents) || cents < 0 || cents > 10000) return fail('fee must be between 0 and 100 cr');
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    s.fee = Math.round(Number(p.fee) * 100);
    return { ok: true, cost: 0, focus: { x: s.gate[0], y: s.gate[1], label: 'Gate' }, message: `entry fee is now ${(s.fee / 100).toFixed(2)} cr` };
  },
});

def({
  type: 'loan.set',
  summary: 'Set the loan to an amount in credits (borrow or repay)',
  params: [{ name: 'amount', desc: 'new loan in cr' }],
  query({ s }, p) {
    const want = Math.round(Number(p.amount) * 100);
    if (!Number.isFinite(want) || want < 0) return fail('amount must be a number ≥ 0');
    if (want > s.maxLoan) return fail(`the bank lends at most ${(s.maxLoan / 100).toFixed(0)} cr`);
    if (want < s.loan && s.cash < s.loan - want) return fail(`you need ${((s.loan - want) / 100).toFixed(0)} cr in cash to repay that much`);
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    const want = Math.round(Number(p.amount) * 100);
    s.cash += want - s.loan;
    s.loan = want;
    return { ok: true, cost: 0, message: `loan is now ${(s.loan / 100).toFixed(0)} cr` };
  },
});

def({
  type: 'staff.hire',
  summary: 'Hire staff: handyman, mechanic, guard or entertainer',
  params: [{ name: 'role', desc: 'handyman | mechanic | guard | entertainer' }],
  query({ c }, p) {
    if (!c.staff[p.role as StaffRole]) return fail(`unknown role "${p.role}"`, `roles: ${Object.keys(c.staff).join(', ')}`);
    return { ok: true, cost: 0 };
  },
  execute({ s, c }, p) {
    const role = p.role as StaffRole;
    const id = s.nextId++;
    const n = s.staff.filter((x) => x.role === role).length + 1;
    const [gx, gy] = s.gate;
    s.staff.push({ id, role, name: `${c.staff[role].name} ${n}`, tx: gx, ty: gy, nx: gx, ny: gy, p: 0, dir: 0, goal: null, busy: 0, task: null });
    return { ok: true, cost: 0, focus: { x: gx, y: gy }, data: { id }, message: `hired ${c.staff[role].name} ${n} for ${(c.staff[role].wage / 100).toFixed(0)} cr a week` };
  },
});

def({
  type: 'staff.fire',
  summary: 'Let a staff member go',
  params: [{ name: 'staff', desc: 'staff name or id' }],
  query({ s }, p) {
    const ref = String(p.staff).toLowerCase();
    if (!s.staff.some((x) => String(x.id) === ref || x.name.toLowerCase() === ref)) return fail(`no staff "${p.staff}"`, s.staff.map((x) => x.name).join(', ') || 'nobody is hired');
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    const ref = String(p.staff).toLowerCase();
    const st = s.staff.find((x) => String(x.id) === ref || x.name.toLowerCase() === ref)!;
    s.staff = s.staff.filter((x) => x !== st);
    return { ok: true, cost: 0, message: `${st.name} has left` };
  },
});

export const CAMPAIGNS = { flyers: 30000, billboard: 90000, freeEntry: 50000 } as const;

def({
  type: 'marketing.start',
  summary: 'Run a campaign for N weeks: flyers, billboard or freeEntry',
  params: [{ name: 'kind', desc: 'flyers | billboard | freeEntry' }, { name: 'weeks', desc: '1–8', optional: true }],
  category: 'marketing',
  query({ s }, p) {
    const k = String(p.kind) as keyof typeof CAMPAIGNS;
    if (!(k in CAMPAIGNS)) return fail(`unknown campaign "${p.kind}"`, `campaigns: ${Object.keys(CAMPAIGNS).join(', ')}`);
    if (s.campaigns.some((c) => c.kind === k)) return fail(`a ${k} campaign is already running`);
    const weeks = Math.max(1, Math.min(8, int(p.weeks ?? 2)));
    return { ok: true, cost: CAMPAIGNS[k] * weeks };
  },
  execute({ s }, p) {
    const k = String(p.kind) as keyof typeof CAMPAIGNS;
    const weeks = Math.max(1, Math.min(8, int(p.weeks ?? 2)));
    s.campaigns.push({ kind: k, weeksLeft: weeks });
    return { ok: true, cost: CAMPAIGNS[k] * weeks, message: `${k} campaign running for ${weeks} week${weeks > 1 ? 's' : ''}` };
  },
});

def({
  type: 'scenery.place',
  summary: 'Plant scenery on grass: oak, pine, flower, fountain, hedge',
  params: [{ name: 'kind', desc: 'oak | pine | flower | fountain | hedge' }, { name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' }, { name: 'x2', desc: 'end x', optional: true }, { name: 'y2', desc: 'end y', optional: true }],
  category: 'construction',
  query({ s }, p) {
    const sc = sceneryByName(String(p.kind));
    if (!sc) return fail(`unknown scenery "${p.kind}"`, `scenery: ${SCENERY.slice(1).map((x) => x.name.split(' ')[0]).join(', ')}`);
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    const free = tiles.filter(([x, y]) => inBounds(s, x, y) && freeCell(s, x, y));
    if (!free.length) return fail('no clear grass there');
    return { ok: true, cost: free.length * sc.cost, focus: { x: int(p.x), y: int(p.y) } };
  },
  execute({ s }, p) {
    const sc = sceneryByName(String(p.kind))!;
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    const free = tiles.filter(([x, y]) => inBounds(s, x, y) && freeCell(s, x, y));
    for (const [x, y] of free) s.scenery[idx(s, x, y)] = sc.id;
    return { ok: true, cost: free.length * sc.cost, focus: { x: int(p.x), y: int(p.y) }, message: `planted ${free.length} ${sc.name}${free.length > 1 ? 's' : ''}` };
  },
});

def({
  type: 'scenery.remove',
  summary: 'Clear scenery from a tile range',
  params: [{ name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' }, { name: 'x2', desc: 'end x', optional: true }, { name: 'y2', desc: 'end y', optional: true }],
  query({ s }, p) {
    const tiles = lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2));
    if (!tiles.some(([x, y]) => inBounds(s, x, y) && s.scenery[idx(s, x, y)])) return fail('no scenery there');
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    for (const [x, y] of lineTiles(int(p.x), int(p.y), p.x2 === undefined ? undefined : int(p.x2), p.y2 === undefined ? undefined : int(p.y2)))
      if (inBounds(s, x, y)) s.scenery[idx(s, x, y)] = 0;
    return { ok: true, cost: 0 };
  },
});

def({
  type: 'bin.place',
  summary: 'Put a litter bin on a path tile',
  params: [{ name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' }],
  category: 'construction',
  query({ s }, p) {
    const x = int(p.x), y = int(p.y);
    if (!isPath(s, x, y)) return fail(`${x},${y} is not a path`, nearestPath(s, x, y));
    if (s.bins[idx(s, x, y)]) return fail('there is already a bin there');
    return { ok: true, cost: BIN_COST, focus: { x, y } };
  },
  execute({ s }, p) {
    s.bins[idx(s, int(p.x), int(p.y))] = 1;
    s.mapVersion++; // renderers redraw path furniture on map changes
    return { ok: true, cost: BIN_COST, focus: { x: int(p.x), y: int(p.y) } };
  },
});
