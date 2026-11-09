import { DX, DY, rulesOf, Tile, type Dir, type ParkState, type Ride } from './types.ts';

export const idx = (s: ParkState, x: number, y: number) => y * s.w + x;
export const inBounds = (s: ParkState, x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h;
export const tileAt = (s: ParkState, x: number, y: number) => (inBounds(s, x, y) ? s.tiles[idx(s, x, y)] : -1);
export const isPath = (s: ParkState, x: number, y: number) => tileAt(s, x, y) === Tile.Path;
export const isQueue = (s: ParkState, x: number, y: number) => tileAt(s, x, y) === Tile.Queue;

export const SCENERY = [
  { id: 0, name: 'none', cost: 0, beauty: 0 },
  { id: 1, name: 'oak tree', cost: 2500, beauty: 2 },
  { id: 2, name: 'flower bed', cost: 1200, beauty: 3 },
  { id: 3, name: 'fountain', cost: 18000, beauty: 8 },
  { id: 4, name: 'hedge', cost: 800, beauty: 1 },
  { id: 5, name: 'pine tree', cost: 2200, beauty: 2 },
] as const;

export function sceneryByName(name: string) {
  const n = name.toLowerCase();
  return SCENERY.find((s) => s.id > 0 && (s.name === n || s.name.split(' ')[0] === n));
}

/** Footprint size after rotation. */
export function rotatedSize(w: number, h: number, rot: Dir): [number, number] {
  return rot % 2 === 0 ? [w, h] : [h, w];
}

/** Entrance tile for a footprint at (x,y) of size (w,h) facing rot: centre of that side, one tile outside. */
export function entranceFor(x: number, y: number, w: number, h: number, rot: Dir): [number, number] {
  const cx = x + Math.floor((w - 1) / 2);
  const cy = y + Math.floor((h - 1) / 2);
  switch (rot) {
    case 0: return [cx, y - 1];
    case 1: return [x + w, cy];
    case 2: return [cx, y + h];
    default: return [x - 1, cy];
  }
}

/** Queue tiles chained from the ride's entrance (flood over queue tiles). */
export function queueChain(s: ParkState, r: Ride): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<number>();
  const stack: [number, number][] = [];
  for (let d = 0; d < 4; d++) {
    const x = r.ex + DX[d], y = r.ey + DY[d];
    if (isQueue(s, x, y)) stack.push([x, y]);
  }
  while (stack.length) {
    const [x, y] = stack.pop()!;
    const k = idx(s, x, y);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([x, y]);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (isQueue(s, nx, ny) && !seen.has(idx(s, nx, ny))) stack.push([nx, ny]);
    }
  }
  return out;
}

/** How many can wait for a ride: a few at the entrance (about a full load in rules v2) plus 8 per queue tile. */
export function queueCapacity(s: ParkState, r: Ride): number {
  return (rulesOf(s) >= 2 ? 20 : 6) + 8 * queueTiles(s, r);
}

// Queue lengths only change with the map (paths and rides bump mapVersion), so cache them per state and version.
const queueCache = new WeakMap<ParkState, { version: number; tiles: Map<number, number> }>();

function queueTiles(s: ParkState, r: Ride): number {
  let e = queueCache.get(s);
  if (!e || e.version !== s.mapVersion) { e = { version: s.mapVersion, tiles: new Map() }; queueCache.set(s, e); }
  // Key on the entrance too: it's what the chain grows from.
  const key = r.id * 1_000_000 + r.ey * 1000 + r.ex; // maps are well under 1000 tiles a side
  let n = e.tiles.get(key);
  if (n === undefined) { n = queueChain(s, r).length; e.tiles.set(key, n); }
  return n;
}

/** Path tiles from which a visitor can step into the ride (directly or via its queue). */
export function accessTiles(s: ParkState, r: Ride): [number, number][] {
  const sources: [number, number][] = [[r.ex, r.ey], ...queueChain(s, r)];
  const out: [number, number][] = [];
  const seen = new Set<number>();
  if (isPath(s, r.ex, r.ey)) { out.push([r.ex, r.ey]); seen.add(idx(s, r.ex, r.ey)); }
  for (const [x, y] of sources) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (isPath(s, nx, ny)) {
        const k = idx(s, nx, ny);
        if (!seen.has(k)) { seen.add(k); out.push([nx, ny]); }
      }
    }
  }
  return out;
}

/**
 * Distance fields over the path graph, one per goal, cached by map version.
 * A visitor at a junction steps to the neighbour with the smallest distance — no per-visitor search.
 */
export class Routes {
  private version = -1;
  private state: ParkState | null = null;
  private fields = new Map<string, Int32Array>();
  /** Ride fields by id too, so the hot path skips building a string key. Cleared with `fields`. */
  private rideFields = new Map<number, Int32Array>();

  constructor(private s: () => ParkState) {}

  private ensure() {
    const s = this.s();
    // A loaded save can share a mapVersion with the old one, so also key on the state object.
    if (s.mapVersion !== this.version || s !== this.state) {
      this.fields.clear();
      this.rideFields.clear();
      this.version = s.mapVersion;
      this.state = s;
    }
  }

  field(key: string, goals: () => [number, number][]): Int32Array {
    this.ensure();
    let f = this.fields.get(key);
    if (f) return f;
    const s = this.s();
    f = new Int32Array(s.w * s.h).fill(-1);
    const q: number[] = [];
    for (const [x, y] of goals()) {
      if (!inBounds(s, x, y)) continue;
      const k = idx(s, x, y);
      if (f[k] === -1) { f[k] = 0; q.push(k); }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const k = q[qi];
      const x = k % s.w, y = (k - x) / s.w;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!isPath(s, nx, ny)) continue;
        const nk = idx(s, nx, ny);
        if (f[nk] === -1) { f[nk] = f[k] + 1; q.push(nk); }
      }
    }
    this.fields.set(key, f);
    return f;
  }

  toRide(r: Ride) {
    this.ensure();
    let f = this.rideFields.get(r.id);
    if (!f) { f = this.field(`r${r.id}`, () => accessTiles(this.s(), r)); this.rideFields.set(r.id, f); }
    return f;
  }

  toExit() {
    return this.field('exit', () => [this.s().gate]);
  }

  /** Distance from (x,y) along paths to the goal field, or -1 if unreachable. */
  static dist(s: ParkState, f: Int32Array, x: number, y: number) {
    return inBounds(s, x, y) ? f[idx(s, x, y)] : -1;
  }
}
