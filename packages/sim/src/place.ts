// "Find a spot and hook it up": search for a placement near the path network, build there, and lay a
// short path from the entrance to the nearest existing path. Composed only of ordinary actions
// (ride.build + path.place), so it's validated, logged and replayed like anything a player does.
import { findRideType } from './actions.ts';
import { MAX_LEVEL, PIECES, nextPose, pieceTiles, stationEntrance, type Pose } from './coaster.ts';
import { entranceFor, idx, inBounds, isPath, rotatedSize } from './map.ts';
import type { Park } from './park.ts';
import { DX, DY, Tile, type Dir } from './types.ts';

export interface PlaceResult {
  ok: boolean;
  message: string;
  rideId?: number;
  focus?: { x: number; y: number };
}

const MAX_LINK = 12; // path tiles we're willing to lay to connect an entrance

function grassFree(park: Park, x: number, y: number) {
  const s = park.s;
  if (!inBounds(s, x, y)) return false;
  const k = idx(s, x, y);
  return s.tiles[k] === Tile.Grass && s.occ[k] === 0 && s.scenery[k] === 0;
}

/** Path tiles visitors can actually reach from the gate. */
function gateNetwork(park: Park): Set<number> {
  const s = park.s;
  const seen = new Set<number>([idx(s, s.gate[0], s.gate[1])]);
  const q = [idx(s, s.gate[0], s.gate[1])];
  for (let i = 0; i < q.length; i++) {
    const x = q[i] % s.w, y = (q[i] - x) / s.w;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!isPath(s, nx, ny)) continue;
      const k = idx(s, nx, ny);
      if (!seen.has(k)) { seen.add(k); q.push(k); }
    }
  }
  return seen;
}

/** Shortest run of free grass from a start tile to a path tile on the gate's network (BFS), excluding `blocked`. */
function linkPath(park: Park, sx: number, sy: number, blocked: Set<number>, network: Set<number>): [number, number][] | null {
  const s = park.s;
  if (network.has(idx(s, sx, sy))) return [];
  if (!grassFree(park, sx, sy) || blocked.has(idx(s, sx, sy))) return null;
  const prev = new Map<number, number>();
  const start = idx(s, sx, sy);
  prev.set(start, -1);
  let frontier = [start];
  for (let depth = 0; depth < MAX_LINK && frontier.length; depth++) {
    const next: number[] = [];
    for (const k of frontier) {
      const x = k % s.w, y = (k - x) / s.w;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inBounds(s, nx, ny)) continue;
        const nk = idx(s, nx, ny);
        if (prev.has(nk)) continue;
        if (network.has(nk)) {
          const route: [number, number][] = [];
          for (let c = k; c !== -1; c = prev.get(c)!) route.push([c % s.w, Math.floor(c / s.w)]);
          return route;
        }
        if (!grassFree(park, nx, ny) || blocked.has(nk)) continue;
        prev.set(nk, k);
        next.push(nk);
      }
    }
    frontier = next;
  }
  return null;
}

/** Candidate top-left corners, nearest to (cx, cy) first (deterministic order). */
function* around(park: Park, cx: number, cy: number) {
  const s = park.s;
  for (let r = 0; r < Math.max(s.w, s.h); r++) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
      if (inBounds(s, x, y)) yield [x, y] as const;
    }
  }
}

export function placeRide(park: Park, typeRef: string, near?: { x: number; y: number }, actor = 'terminal'): PlaceResult {
  const s = park.s;
  const type = findRideType(park.c, typeRef);
  const t = type ? park.c.rideTypes[type] : undefined;
  if (!t || !type) return { ok: false, message: `unknown ride type "${typeRef}" — types: ${Object.values(park.c.rideTypes).filter((x) => x.kind !== 'track').map((x) => x.id).join(', ')}` };
  if (t.kind === 'track') return { ok: false, message: 'coasters are built piece by piece (pw coaster start)' };
  const target = near ?? { x: s.gate[0], y: Math.max(0, s.gate[1] - 6) };
  const network = gateNetwork(park);
  let tried = 0;
  for (const [x, y] of around(park, target.x, target.y)) {
    if (++tried > 4000) break;
    for (const rot of [2, 1, 3, 0] as Dir[]) {
      const [w, h] = rotatedSize(t.size[0], t.size[1], rot);
      // Keep a 1-tile margin from the edge so paths can go around.
      if (x < 1 || y < 1 || x + w > s.w - 1 || y + h > s.h - 1) continue;
      const q = park.query('ride.build', { type, x, y, rot });
      if (!q.ok) continue;
      const [ex, ey] = entranceFor(x, y, w, h, rot);
      const footprint = new Set<number>();
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) footprint.add(idx(s, i, j));
      let route: [number, number][] | null;
      if (network.has(idx(s, ex, ey))) route = [];
      else {
        // The entrance tile becomes part of the ride, so connect from a free neighbour of it.
        footprint.add(idx(s, ex, ey));
        route = null;
        for (let d = 0; d < 4 && route === null; d++) {
          const ax = ex + DX[d], ay = ey + DY[d];
          if (footprint.has(idx(s, ax, ay)) && !isPath(s, ax, ay)) continue;
          route = linkPath(park, ax, ay, footprint, network);
        }
      }
      if (route === null) continue;
      // Hook-adjusted cost of the ride (mods can change it) plus the path tiles.
      const pathCost = route.length ? park.query('path.place', { x: route[0][0], y: route[0][1] }) : null;
      const cost = q.cost + route.length * (pathCost?.ok ? pathCost.cost : 1000);
      if (cost > s.cash) return { ok: false, message: `found a spot at ${x},${y} but it needs ${(cost / 100).toFixed(0)} cr (you have ${(s.cash / 100).toFixed(0)})` };
      const b = park.run('ride.build', { type, x, y, rot }, actor);
      if (!b.ok) continue;
      const id = (b.data as { id: number }).id;
      for (const [px, py] of route) {
        const r = park.run('path.place', { x: px, y: py }, actor);
        if (!r.ok) return { ok: false, rideId: id, focus: { x, y }, message: `built ${t.name} at ${x},${y} but couldn't finish its path at ${px},${py}: ${r.error}` };
      }
      return { ok: true, rideId: id, focus: { x, y }, message: `built ${t.name} at ${x},${y} (entrance ${ex},${ey})${route.length ? ` and laid ${route.length} path tile${route.length > 1 ? 's' : ''} to connect it` : ', opening onto the path'}` };
    }
  }
  return { ok: false, message: `no room for ${t.name} near ${target.x},${target.y}`, };
}

/**
 * A tested closed circuit (the same loop the coaster tests build), heading east from the station:
 * chain lift, a drop, a wide turn and back. Turns add up to a full circle and climbs cancel drops.
 */
export const STARTER_LOOP: [string, number][] = [
  ['lift', 4], ['straight', 1], ['right', 1], ['steepdown', 2], ['up', 1], ['bigright', 1],
  ['down', 1], ['straight', 5], ['brakes', 1], ['right', 1], ['straight', 4], ['right', 1],
];
const STATION_LEN = 3;

/** Every tile the station plus STARTER_LOOP would take from (x, y) heading dir, or null if it leaves the map or goes out of range. */
function loopFootprint(park: Park, x: number, y: number, dir: Dir): number[] | null {
  const s = park.s;
  const tiles: number[] = [];
  const add = (tx: number, ty: number): boolean => { if (tx < 1 || ty < 1 || tx >= s.w - 1 || ty >= s.h - 1) return false; tiles.push(idx(s, tx, ty)); return true; };
  for (let i = 0; i < STATION_LEN; i++) if (!add(x + DX[dir] * i, y + DY[dir] * i)) return null;
  let pose: Pose = nextPose({ x: x + DX[dir] * (STATION_LEN - 1), y: y + DY[dir] * (STATION_LEN - 1), z: 0, dir }, PIECES.station);
  for (const [id, n] of STARTER_LOOP) {
    const piece = PIECES[id];
    for (let k = 0; k < n; k++) {
      if (pose.z + Math.min(0, piece.dz) < 0 || pose.z + piece.dz > MAX_LEVEL) return null;
      for (const [tx, ty] of pieceTiles(pose, piece)) if (!add(tx, ty)) return null;
      pose = nextPose(pose, piece);
    }
  }
  return new Set(tiles).size === tiles.length ? tiles : null;
}

/**
 * `coaster place`: find room for the starter loop near the paths, build it piece by piece, test it,
 * open it and lay a path to its entrance. Only ordinary actions (coaster.start/add/test, ride.open,
 * path.place), checked first on a footprint, so it's validated, logged and replayed like a player's build.
 */
export function placeCoaster(park: Park, near?: { x: number; y: number }, name?: string, actor = 'terminal'): PlaceResult {
  const s = park.s;
  const target = near ?? { x: s.gate[0], y: Math.max(0, s.gate[1] - 10) };
  const network = gateNetwork(park);
  const loopCost = PIECES.station.cost * STATION_LEN + STARTER_LOOP.reduce((a, [id, n]) => a + PIECES[id].cost * n, 0);
  let tried = 0;
  for (const [x, y] of around(park, target.x, target.y)) {
    if (++tried > 6000) break;
    for (const dir of [1, 3, 0, 2] as Dir[]) {
      const foot = loopFootprint(park, x, y, dir);
      if (!foot || !foot.every((k) => grassFree(park, k % s.w, Math.floor(k / s.w)))) continue;
      const [ex, ey] = stationEntrance(x, y, dir);
      if (!inBounds(s, ex, ey) || foot.includes(idx(s, ex, ey))) continue;
      const entranceOnPath = isPath(s, ex, ey);
      if (!entranceOnPath && !grassFree(park, ex, ey)) continue;
      const blocked = new Set(foot);
      let route: [number, number][] | null = entranceOnPath && network.has(idx(s, ex, ey)) ? [] : null;
      if (route === null) {
        blocked.add(idx(s, ex, ey));
        for (let d = 0; d < 4 && route === null; d++) route = linkPath(park, ex + DX[d], ey + DY[d], blocked, network);
      }
      if (route === null) continue;
      const pathCost = route.length ? park.query('path.place', { x: route[0][0], y: route[0][1] }) : null;
      const cost = loopCost + route.length * (pathCost?.ok ? pathCost.cost : 1000);
      if (cost > s.cash) return { ok: false, message: `found room at ${x},${y} but the coaster needs about ${(cost / 100).toFixed(0)} cr (you have ${(s.cash / 100).toFixed(0)})` };
      const st = park.run('coaster.start', { x, y, dir, ...(name ? { name } : {}) }, actor);
      if (!st.ok) continue;
      const id = (st.data as { id: number }).id;
      const ride = s.rides.find((r) => r.id === id)!;
      for (const [piece, count] of STARTER_LOOP) {
        const r = park.run('coaster.add', { piece, count, ride: ride.name }, actor);
        if (!r.ok) return { ok: false, rideId: id, focus: { x, y }, message: `started ${ride.name} at ${x},${y} but ${piece} didn't fit: ${r.error} (coaster undo removes pieces, refunded)` };
      }
      for (const [px, py] of route) {
        const r = park.run('path.place', { x: px, y: py }, actor);
        if (!r.ok) return { ok: false, rideId: id, focus: { x, y }, message: `built ${ride.name} but couldn't finish its path at ${px},${py}: ${r.error}` };
      }
      const t = park.run('coaster.test', { ride: ride.name }, actor);
      if (!t.ok) return { ok: false, rideId: id, focus: { x, y }, message: `built ${ride.name} at ${x},${y}; its test run failed: ${t.error}` };
      const o = park.run('ride.open', { ride: id }, actor);
      const rated = ride.ratings ? ` (excitement ${(ride.ratings.e / 100).toFixed(2)}, intensity ${(ride.ratings.i / 100).toFixed(2)}, nausea ${(ride.ratings.n / 100).toFixed(2)})` : '';
      return { ok: true, rideId: id, focus: { x, y }, message: `built ${ride.name} at ${x},${y} heading ${['north', 'east', 'south', 'west'][dir]}, tested it${rated}${o.ok ? ' and opened it' : ` (not opened: ${o.error})`}${route.length ? `; laid ${route.length} path tile${route.length > 1 ? 's' : ''} to its entrance` : ''}` };
    }
  }
  return { ok: false, message: `no room for a coaster near ${target.x},${target.y}: it needs a clear area of about 12×8 tiles (try --near x,y)` };
}
