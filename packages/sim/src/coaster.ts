// Coasters: track pieces on the tile grid, a smooth path through them, a test-run physics model and ratings.
// Everything here is deterministic: no trig at runtime (turns use a constant table), integer outputs.
import type { Ratings } from '@parkwright/content';
import { ACTIONS, type ActionDef, type ActionResult, findRide } from './actions.ts';
import { book } from './economy.ts';
import { idx, inBounds, isPath, tileAt } from './map.ts';
import { DX, DY, Tile, type Dir, type ParkState, type Ride, type TrackPiece } from './types.ts';

/** Metres per tile (horizontal) and per height level (vertical). */
export const TILE_M = 4;
export const LEVEL_M = 2;
export const MAX_LEVEL = 20;
const G = 9.81;

export interface PieceDef {
  id: string;
  name: string;
  /** Cost in cents. */
  cost: number;
  /** Height change in levels across the piece. */
  dz: number;
  /** 0 straight, +1 right turn, −1 left turn. */
  turn: 0 | 1 | -1;
  lift?: boolean;
  brakes?: boolean;
  station?: boolean;
  /** Wide turns sweep a 2×2 area with a 6 m radius; tight turns fit one tile (2 m). */
  wide?: boolean;
}

export const PIECES: Record<string, PieceDef> = {
  station: { id: 'station', name: 'Station', cost: 10000, dz: 0, turn: 0, station: true },
  straight: { id: 'straight', name: 'Straight', cost: 6000, dz: 0, turn: 0 },
  left: { id: 'left', name: 'Left turn', cost: 8000, dz: 0, turn: -1 },
  right: { id: 'right', name: 'Right turn', cost: 8000, dz: 0, turn: 1 },
  bigleft: { id: 'bigleft', name: 'Wide left turn', cost: 18000, dz: 0, turn: -1, wide: true },
  bigright: { id: 'bigright', name: 'Wide right turn', cost: 18000, dz: 0, turn: 1, wide: true },
  up: { id: 'up', name: 'Slope up', cost: 7000, dz: 1, turn: 0 },
  down: { id: 'down', name: 'Slope down', cost: 7000, dz: -1, turn: 0 },
  steepup: { id: 'steepup', name: 'Steep up', cost: 9000, dz: 2, turn: 0 },
  steepdown: { id: 'steepdown', name: 'Steep drop', cost: 9000, dz: -2, turn: 0 },
  lift: { id: 'lift', name: 'Chain lift', cost: 12000, dz: 1, turn: 0, lift: true },
  brakes: { id: 'brakes', name: 'Brakes', cost: 9000, dz: 0, turn: 0, brakes: true },
};

export interface Pose { x: number; y: number; z: number; dir: Dir }

/** Where the next piece goes after placing `piece` at `p`. The piece occupies tile (p.x, p.y). */
export function nextPose(p: Pose, piece: PieceDef): Pose {
  const dir = ((p.dir + piece.turn + 4) & 3) as Dir;
  if (piece.wide) return { x: p.x + DX[p.dir] + DX[dir] * 2, y: p.y + DY[p.dir] + DY[dir] * 2, z: p.z + piece.dz, dir };
  return { x: p.x + DX[dir], y: p.y + DY[dir], z: p.z + piece.dz, dir };
}

/** Tiles a piece occupies when placed at pose p. */
export function pieceTiles(p: Pose, piece: PieceDef): [number, number][] {
  if (!piece.wide) return [[p.x, p.y]];
  const side = ((p.dir + piece.turn + 4) & 3) as Dir;
  return [[p.x, p.y], [p.x + DX[p.dir], p.y + DY[p.dir]], [p.x + DX[side], p.y + DY[side]], [p.x + DX[p.dir] + DX[side], p.y + DY[p.dir] + DY[side]]];
}

export function endPose(track: TrackPiece[]): Pose | null {
  const last = track[track.length - 1];
  if (!last) return null;
  return nextPose({ x: last.x, y: last.y, z: last.z, dir: last.dir }, PIECES[last.piece]);
}

export function isClosed(track: TrackPiece[]): boolean {
  const end = endPose(track), first = track[0];
  return !!end && !!first && track.length >= 6 && end.x === first.x && end.y === first.y && end.z === first.z && end.dir === first.dir;
}

// cos/sin of k·(π/2)/8, k = 0..8 — a constant table so turns never call Math.sin/cos.
const COS = [1, 0.9807852804032304, 0.9238795325112867, 0.8314696123025452, 0.7071067811865476, 0.5555702330196023, 0.3826834323650898, 0.19509032201612825, 0];
const SIN = [0, 0.19509032201612825, 0.3826834323650898, 0.5555702330196023, 0.7071067811865476, 0.8314696123025452, 0.9238795325112867, 0.9807852804032304, 1];
export const SAMPLES = 8;

export interface PathPoint {
  /** World metres: x east, y up, z south. */
  x: number; y: number; z: number;
  piece: number;
  /** Bank in the turn (fraction of 45°, signed: + right). */
  bank: number;
}

/** Height smoothing: box-filter radius (samples) and passes. 3 passes of a box ≈ a Gaussian of ~3 m. */
const SMOOTH_R = 6;
const SMOOTH_PASSES = 3;

/**
 * Smooth 3D path through the track. Horizontally: straights and quarter circles (exact, tangent-continuous).
 * Vertically: the piecewise-linear height profile, box-filtered so drops pull out over a few metres
 * instead of kinking — and since it's an average of non-negative heights, it never goes underground.
 */
export function trackPath(track: TrackPiece[]): PathPoint[] {
  const n = track.length;
  const closed = isClosed(track);
  const pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    const tp = track[i];
    const def = PIECES[tp.piece];
    const z0 = tp.z, z1 = tp.z + def.dz;
    // Entry point = middle of the tile edge we come in through.
    const cx = tp.x + 0.5, cy = tp.y + 0.5;
    const ex = cx - DX[tp.dir] * 0.5, ey = cy - DY[tp.dir] * 0.5;
    for (let k = 0; k < SAMPLES; k++) {
      const t = k / SAMPLES;
      let hx: number, hy: number;
      if (def.turn === 0) {
        hx = ex + DX[tp.dir] * t;
        hy = ey + DY[tp.dir] * t;
      } else {
        // Quarter circle about a centre on the inside of the turn (radius 0.5 tile, or 1.5 for wide turns).
        const R = def.wide ? 1.5 : 0.5;
        const side = ((tp.dir + def.turn + 4) & 3) as Dir;
        const ox = ex + DX[side] * R, oy = ey + DY[side] * R;
        const rx = ex - ox, ry = ey - oy; // radius vector
        const fx = DX[tp.dir] * R, fy = DY[tp.dir] * R; // forward, same length
        hx = ox + rx * COS[k] + fx * SIN[k];
        hy = oy + ry * COS[k] + fy * SIN[k];
      }
      const bank = def.turn === 0 ? 0 : def.turn * (k === 0 ? 0.5 : 1);
      pts.push({ x: hx * TILE_M, y: (z0 + (z1 - z0) * t) * LEVEL_M, z: hy * TILE_M, piece: i, bank });
    }
  }
  if (!closed && n) {
    const end = endPose(track)!;
    pts.push({ x: (end.x + 0.5 - DX[end.dir] * 0.5) * TILE_M, y: end.z * LEVEL_M, z: (end.y + 0.5 - DY[end.dir] * 0.5) * TILE_M, piece: n - 1, bank: 0 });
  }
  // Smooth heights (wrapping round a closed circuit; clamping at the ends of an open one).
  const m = pts.length;
  let h = pts.map((p) => p.y);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const out = new Array<number>(m);
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let d = -SMOOTH_R; d <= SMOOTH_R; d++) {
        const j = closed ? (i + d + m) % m : Math.max(0, Math.min(m - 1, i + d));
        sum += h[j];
      }
      out[i] = sum / (2 * SMOOTH_R + 1);
    }
    h = out;
  }
  // Stations stay exactly level so trains stop where riders board.
  for (let i = 0; i < m; i++) pts[i].y = PIECES[track[pts[i].piece].piece].station ? track[pts[i].piece].z * LEVEL_M : h[i];
  return pts;
}

export interface CoasterStats {
  length: number; // m
  duration: number; // s
  maxSpeed: number; // m/s
  avgSpeed: number;
  maxVertG: number;
  minVertG: number;
  maxLatG: number;
  drops: number;
  maxDrop: number; // m
  airtime: number; // s
  turns: number;
  height: number; // m
}

export interface TestRun {
  ok: boolean;
  error?: string;
  stalledAt?: number;
  stats?: CoasterStats;
  /** Cumulative distance and time at each path point (for animating trains). */
  s?: number[];
  t?: number[];
  /** Vertical and lateral g at each path point (for colouring the track by intensity). */
  vert?: number[];
  lat?: number[];
}

const LIFT_SPEED = 3;
const BRAKE_SPEED = 3;
const STATION_SPEED = 2;
const ROLL = 0.012; // rolling resistance × g
const DRAG = 0.0008; // per metre, × v²

/** Run a point-mass train once around the circuit. */
export function testRun(track: TrackPiece[]): TestRun {
  if (!isClosed(track)) return { ok: false, error: 'the circuit is not closed' };
  const pts = trackPath(track);
  const n = pts.length;
  const s = [0], t = [0];
  const vertAt: number[] = [], latAt: number[] = [];
  let v = STATION_SPEED;
  let maxSpeed = 0, maxVert = -Infinity, minVert = Infinity, maxLat = 0, airtime = 0;
  let length = 0, time = 0;
  // The chain keeps pulling past the last lift piece until the crest (smoothing spreads the climb a little).
  let onChain = false;
  let drops = 0, maxDrop = 0, dropStart: number | null = null, maxH = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const ds = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const def = PIECES[track[a.piece].piece];
    let v2 = v * v + 2 * G * (a.y - b.y) - 2 * (ROLL * G + DRAG * v * v) * ds;
    onChain = def.lift || (onChain && b.y > a.y + 1e-9);
    if (onChain) v2 = Math.max(v2, LIFT_SPEED * LIFT_SPEED);
    if (def.station) v2 = Math.max(v2, STATION_SPEED * STATION_SPEED);
    if (v2 <= 0.04) {
      return { ok: false, error: `the train stalls on piece ${a.piece + 1} (${def.name.toLowerCase()}) — add a lift or a bigger drop before it`, stalledAt: a.piece };
    }
    let v1 = Math.sqrt(v2);
    if (def.brakes) v1 = Math.min(v1, BRAKE_SPEED);
    const dt = ds / ((v + v1) / 2);
    length += ds;
    time += dt;
    s.push(length);
    t.push(time);
    v = v1;
    maxSpeed = Math.max(maxSpeed, v);
    maxH = Math.max(maxH, b.y);
    // Drops: track descents of at least 2 m.
    if (b.y < a.y - 1e-6) { if (dropStart === null) dropStart = a.y; }
    else if (dropStart !== null) {
      const d = dropStart - a.y;
      if (d >= 2) { drops++; maxDrop = Math.max(maxDrop, d); }
      dropStart = null;
    }
    // Forces from the curvature through three consecutive points.
    const p = pts[(i - 1 + n) % n], c = a, q = b;
    const ux = c.x - p.x, uy = c.y - p.y, uz = c.z - p.z;
    const wx = q.x - c.x, wy = q.y - c.y, wz = q.z - c.z;
    const lu = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1e-9, lw = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1e-9;
    // Curvature vector ≈ (w/|w| − u/|u|) / ((|u|+|w|)/2)
    const avg = (lu + lw) / 2;
    const kx = (wx / lw - ux / lu) / avg, ky = (wy / lw - uy / lu) / avg, kz = (wz / lw - uz / lu) / avg;
    // Felt force per unit mass: v²κ + g·up (what the seat pushes with), in g.
    const fx = (v * v * kx) / G, fy = (v * v * ky) / G + 1, fz = (v * v * kz) / G;
    // Track frame: tangent, lateral (horizontal, to the right), and up (perpendicular).
    const tx = wx / lw, ty = wy / lw, tz = wz / lw;
    let lx = -tz, lz = tx; // right-hand lateral in the horizontal plane (x east, z south)
    const ll = Math.sqrt(lx * lx + lz * lz) || 1;
    lx /= ll; lz /= ll;
    // Banked turns tilt the frame 40°: cos/sin constants.
    const bank = a.bank;
    const cb = bank === 0 ? 1 : Math.abs(bank) === 1 ? 0.766044443118978 : 0.9396926207859084;
    const sb = bank === 0 ? 0 : (bank > 0 ? 1 : -1) * (Math.abs(bank) === 1 ? 0.6427876096865393 : 0.3420201433256687);
    // Unbanked frame: lateral is horizontal; vertical is world up (good enough for slopes up to 45°).
    const latFlat = fx * lx + fz * lz;
    const vertFlat = fy;
    void ty;
    const vert = vertFlat * cb + latFlat * sb;
    const lat = latFlat * cb - vertFlat * sb;
    vertAt.push(Math.round(vert * 100) / 100);
    latAt.push(Math.round(lat * 100) / 100);
    maxVert = Math.max(maxVert, vert);
    minVert = Math.min(minVert, vert);
    maxLat = Math.max(maxLat, Math.abs(lat));
    if (vert < 0.3) airtime += dt;
  }
  const turns = track.filter((p) => PIECES[p.piece].turn !== 0).length;
  const stats: CoasterStats = {
    length: Math.round(length), duration: Math.round(time * 10) / 10,
    maxSpeed: Math.round(maxSpeed * 10) / 10, avgSpeed: Math.round((length / time) * 10) / 10,
    maxVertG: Math.round(maxVert * 100) / 100, minVertG: Math.round(minVert * 100) / 100, maxLatG: Math.round(maxLat * 100) / 100,
    drops, maxDrop: Math.round(maxDrop * 10) / 10, airtime: Math.round(airtime * 10) / 10, turns, height: Math.round(maxH),
  };
  return { ok: true, stats, s, t, vert: vertAt, lat: latAt };
}

/** Our own rating model. Integer ratings ×100. */
export function rateCoaster(st: CoasterStats): Ratings {
  let e = 120 + st.maxSpeed * 16 + st.drops * 30 + st.maxDrop * 9 + st.airtime * 100 + Math.min(120, st.length / 3) + st.turns * 8;
  let i = 40 + st.maxSpeed * 18 + Math.max(0, st.maxVertG - 1) * 90 + Math.max(0, -st.minVertG) * 140 + st.maxLatG * 110;
  let n = 40 + st.maxLatG * 90 + Math.max(0, st.maxVertG - 1) * 60 + st.turns * 4 + st.airtime * 25;
  if (st.maxDrop < 6) { e /= 2; i /= 2; n /= 2; } // too tame to count as a real coaster
  if (i > 900) e *= Math.max(0.3, 1 - ((i - 900) / 100) * 0.2); // brutal rides aren't fun
  return { e: Math.round(e), i: Math.round(i), n: Math.round(n) };
}

/* ---------------- actions ---------------- */

const fail = (error: string, hint?: string): ActionResult => ({ ok: false, error, hint });

function buildingCoaster(s: ParkState, ref: unknown): Ride | undefined {
  if (ref !== undefined && ref !== null && ref !== '') return findRide(s, ref);
  // Default: the most recent coaster that isn't finished.
  return [...s.rides].reverse().find((r) => r.track && !isClosed(r.track)) ?? [...s.rides].reverse().find((r) => r.track);
}

function tileFree(s: ParkState, x: number, y: number) {
  if (!inBounds(s, x, y)) return false;
  const k = idx(s, x, y);
  return s.tiles[k] === Tile.Grass && s.occ[k] === 0 && s.scenery[k] === 0;
}

const STATION_LEN = 3;

const startDef: ActionDef = {
  type: 'coaster.start',
  summary: 'Start a coaster: a 3-tile station at x,y heading dir (0 N, 1 E, 2 S, 3 W); entrance on the left',
  params: [{ name: 'x', desc: 'tile x' }, { name: 'y', desc: 'tile y' }, { name: 'dir', desc: 'heading 0–3 (default 1 = east)', optional: true }, { name: 'name', desc: 'name', optional: true }],
  category: 'construction',
  query({ s }, p) {
    const dir = (Number(p.dir ?? 1) & 3) as Dir;
    const x = Number(p.x), y = Number(p.y);
    for (let i = 0; i < STATION_LEN; i++) {
      const tx = x + DX[dir] * i, ty = y + DY[dir] * i;
      if (!tileFree(s, tx, ty)) return fail(`station tile ${tx},${ty} is not clear grass`, 'pick an open area at least 3 tiles long');
    }
    const [ex, ey] = stationEntrance(x, y, dir);
    if (!inBounds(s, ex, ey) || s.occ[idx(s, ex, ey)] || s.scenery[idx(s, ex, ey)] || tileAt(s, ex, ey) === Tile.Queue) return fail(`the entrance tile ${ex},${ey} is blocked`, 'the entrance goes on the left of the middle station tile');
    return { ok: true, cost: PIECES.station.cost * STATION_LEN, focus: { x, y } };
  },
  execute({ s }, p) {
    const dir = (Number(p.dir ?? 1) & 3) as Dir;
    const x = Number(p.x), y = Number(p.y);
    const id = s.nextId++;
    const n = s.rides.filter((r) => r.type === 'coaster').length + 1;
    const [ex, ey] = stationEntrance(x, y, dir);
    const track: TrackPiece[] = [];
    for (let i = 0; i < STATION_LEN; i++) {
      const tx = x + DX[dir] * i, ty = y + DY[dir] * i;
      track.push({ piece: 'station', x: tx, y: ty, z: 0, dir });
      s.occ[idx(s, tx, ty)] = id;
    }
    if (!isPath(s, ex, ey)) s.occ[idx(s, ex, ey)] = id;
    const ride: Ride = {
      id, type: 'coaster', name: p.name ? String(p.name) : n > 1 ? `Timber Coaster ${n}` : 'Timber Coaster',
      x, y, rot: ((dir + 3) & 3) as Dir, w: 1, h: 1, ex, ey,
      price: 400, status: 'testing', ratings: null, value: 0, reliability: 10000, builtDay: s.day,
      queue: [], riders: [], cycle: 0, loadWait: 0, brokenSince: -1, lastInspected: s.day,
      customers: 0, income: 0, incomeWeek: 0, satisfaction: [], track,
    };
    s.rides.push(ride);
    s.mapVersion++;
    return { ok: true, cost: PIECES.station.cost * STATION_LEN, focus: { x, y, label: ride.name }, data: { id }, message: `started ${ride.name} (#${id}). Add pieces with coaster.add until the track comes back to the station.` };
  },
};

/** Entrance: one tile to the left of the middle station tile. */
export function stationEntrance(x: number, y: number, dir: Dir): [number, number] {
  const mx = x + DX[dir], my = y + DY[dir];
  const left = ((dir + 3) & 3) as Dir;
  return [mx + DX[left], my + DY[left]];
}

function placeCheck(s: ParkState, r: Ride, piece: PieceDef): { ok: false; error: string; hint?: string } | Pose {
  const fail = (error: string, hint?: string) => ({ ok: false as const, error, hint });
  if (!r.track) return fail(`${r.name} isn't a coaster`);
  if (isClosed(r.track)) return fail(`${r.name}'s circuit is already closed`, 'run coaster.test, or coaster.undo to change it');
  const p = endPose(r.track)!;
  const z1 = p.z + piece.dz;
  if (z1 < 0 || p.z + Math.min(0, piece.dz) < 0) return fail('the track would go underground', 'add a slope up or a lift first');
  if (z1 > MAX_LEVEL) return fail(`the track can't go above ${MAX_LEVEL * LEVEL_M} m`);
  if (piece.station) return fail('stations only come at the start');
  const first = r.track[0];
  const closing = p.x === first.x && p.y === first.y;
  if (closing) return fail(`the track is at the station tile ${p.x},${p.y} but not lined up`, `it must arrive heading ${['north', 'east', 'south', 'west'][first.dir]} at ground level`);
  for (const [tx, ty] of pieceTiles(p, piece)) {
    if (!tileFree(s, tx, ty)) return fail(`tile ${tx},${ty} is not clear`, 'turn another way, or clear the tile first');
  }
  return p;
}

const addDef: ActionDef = {
  type: 'coaster.add',
  summary: `Add track pieces to the open end: ${Object.keys(PIECES).filter((k) => k !== 'station').join(', ')}`,
  params: [{ name: 'piece', desc: 'piece id' }, { name: 'count', desc: 'how many (default 1)', optional: true }, { name: 'ride', desc: 'coaster name (default: the one being built)', optional: true }],
  category: 'construction',
  query({ s }, p) {
    const piece = PIECES[String(p.piece)];
    if (!piece || piece.station) return fail(`unknown piece "${p.piece}"`, `pieces: ${Object.keys(PIECES).filter((k) => k !== 'station').join(', ')}`);
    const r = buildingCoaster(s, p.ride);
    if (!r?.track) return fail('no coaster is being built', 'start one with coaster.start x y dir');
    const count = Number(p.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 20) return fail('count must be 1–20');
    // Simulate placing them one after another on a scratch copy of occupancy.
    const track = [...r.track];
    const taken = new Set<number>();
    for (let i = 0; i < count; i++) {
      const res = placeCheck(s, { ...r, track }, piece);
      if ('ok' in res) return i === 0 ? res : fail(`only ${i} of ${count} fit: ${res.error}`, res.hint);
      // (res is a Pose from here on)
      for (const [tx, ty] of pieceTiles(res, piece)) {
        const k = idx(s, tx, ty);
        if (taken.has(k)) return fail(`the track would cross itself at ${tx},${ty}`);
        taken.add(k);
      }
      track.push({ piece: piece.id, x: res.x, y: res.y, z: res.z, dir: res.dir });
    }
    return { ok: true, cost: piece.cost * count, focus: { x: track[track.length - 1].x, y: track[track.length - 1].y } };
  },
  execute({ s }, p) {
    const piece = PIECES[String(p.piece)];
    const r = buildingCoaster(s, p.ride)!;
    const count = Number(p.count ?? 1);
    for (let i = 0; i < count; i++) {
      const pose = endPose(r.track!)!;
      r.track!.push({ piece: piece.id, x: pose.x, y: pose.y, z: pose.z, dir: pose.dir });
      for (const [tx, ty] of pieceTiles(pose, piece)) s.occ[idx(s, tx, ty)] = r.id;
    }
    r.ratings = null;
    r.status = 'testing';
    s.mapVersion++;
    const end = endPose(r.track!)!;
    const msg = isClosed(r.track!) ? `${r.name}: circuit closed! Run coaster.test` : `added ${count} ${piece.name.toLowerCase()}${count > 1 ? 's' : ''}; next piece goes at ${end.x},${end.y} height ${end.z * LEVEL_M} m heading ${['N', 'E', 'S', 'W'][end.dir]}`;
    return { ok: true, cost: piece.cost * count, focus: { x: end.x, y: end.y, label: r.name }, message: msg, data: { id: r.id } };
  },
};

const undoDef: ActionDef = {
  type: 'coaster.undo',
  summary: 'Remove the last track piece (refunds it)',
  params: [{ name: 'ride', desc: 'coaster name', optional: true }],
  query({ s }, p) {
    const r = buildingCoaster(s, p.ride);
    if (!r?.track) return fail('no coaster is being built');
    if (r.track.length <= STATION_LEN) return fail('only the station is left', 'demolish the ride to remove it');
    if (r.queue.length || r.riders.length) return fail(`${r.name} has visitors on it`, 'close it and wait for the train to empty');
    return { ok: true, cost: 0 };
  },
  execute({ s }, p) {
    const r = buildingCoaster(s, p.ride)!;
    const last = r.track!.pop()!;
    for (const [tx, ty] of pieceTiles(last, PIECES[last.piece])) s.occ[idx(s, tx, ty)] = 0;
    // Refund the piece, but never more than was actually paid for the track (mods can make pieces cheaper).
    const refund = Math.min(PIECES[last.piece].cost, r.paid ?? 0);
    r.paid = (r.paid ?? 0) - refund;
    book(s, 'refunds', refund);
    r.ratings = null;
    r.status = 'testing';
    s.mapVersion++;
    return { ok: true, cost: 0, focus: { x: last.x, y: last.y, label: r.name }, message: `removed a ${PIECES[last.piece].name.toLowerCase()}` };
  },
};

const testDef: ActionDef = {
  type: 'coaster.test',
  summary: 'Send a test train round the circuit and rate the ride',
  params: [{ name: 'ride', desc: 'coaster name', optional: true }],
  query({ s }, p) {
    const r = buildingCoaster(s, p.ride);
    if (!r?.track) return fail('no coaster to test');
    if (!isClosed(r.track)) {
      const e = endPose(r.track)!;
      return fail('the circuit is not closed', `the open end is at ${e.x},${e.y}, height ${e.z * LEVEL_M} m, heading ${['N', 'E', 'S', 'W'][e.dir]}; it must reach ${r.track[0].x},${r.track[0].y} at ground level heading ${['N', 'E', 'S', 'W'][r.track[0].dir]}`);
    }
    const run = testRun(r.track);
    if (!run.ok) return fail(run.error!);
    return { ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name } };
  },
  execute({ s }, p) {
    const r = buildingCoaster(s, p.ride)!;
    const run = testRun(r.track!);
    const st = run.stats!;
    r.ratings = rateCoaster(st);
    r.stats = st;
    r.cycleTicks = Math.round(st.duration * 20) + 80;
    if (r.status === 'testing') r.status = 'closed';
    const f = (x: number) => (x / 100).toFixed(2);
    return {
      ok: true, cost: 0, focus: { x: r.x, y: r.y, label: r.name }, data: st,
      message: `${r.name} tested: excitement ${f(r.ratings.e)}, intensity ${f(r.ratings.i)}, nausea ${f(r.ratings.n)} — top speed ${st.maxSpeed} m/s, ${st.drops} drop(s) (max ${st.maxDrop} m), ${st.maxVertG}g / ${st.minVertG}g vertical, ${st.maxLatG}g lateral, ${st.duration}s. Open it when ready.`,
    };
  },
};

for (const d of [startDef, addDef, undoDef, testDef]) ACTIONS[d.type] = d;
