// "Find a spot and hook it up": search for a placement near the path network, build there, and lay a
// short path from the entrance to the nearest existing path. Composed only of ordinary actions
// (ride.build + path.place), so it's validated, logged and replayed like anything a player does.
import { findRideType } from './actions.ts';
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

/** Shortest run of free grass from a start tile to any existing path tile (BFS), excluding `blocked`. */
function linkPath(park: Park, sx: number, sy: number, blocked: Set<number>): [number, number][] | null {
  const s = park.s;
  if (isPath(park.s, sx, sy)) return [];
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
        if (isPath(s, nx, ny)) {
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
  let tried = 0;
  for (const [x, y] of around(park, target.x, target.y)) {
    if (++tried > 4000) break;
    for (const rot of [2, 1, 3, 0] as Dir[]) {
      const [w, h] = rotatedSize(t.size[0], t.size[1], rot);
      // Keep a 1-tile margin from the edge so paths can go around.
      if (x < 1 || y < 1 || x + w > s.w - 1 || y + h > s.h - 1) continue;
      if (!park.query('ride.build', { type, x, y, rot }).ok) continue;
      const [ex, ey] = entranceFor(x, y, w, h, rot);
      const footprint = new Set<number>();
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) footprint.add(idx(s, i, j));
      let route: [number, number][] | null;
      if (isPath(s, ex, ey)) route = [];
      else {
        // The entrance tile becomes part of the ride, so connect from a free neighbour of it.
        footprint.add(idx(s, ex, ey));
        route = null;
        for (let d = 0; d < 4 && route === null; d++) {
          const ax = ex + DX[d], ay = ey + DY[d];
          if (footprint.has(idx(s, ax, ay)) && !isPath(s, ax, ay)) continue;
          route = linkPath(park, ax, ay, footprint);
        }
      }
      if (route === null) continue;
      const cost = t.cost + route.length * 1000;
      if (cost > s.cash) return { ok: false, message: `found a spot at ${x},${y} but it needs ${(cost / 100).toFixed(0)} cr (you have ${(s.cash / 100).toFixed(0)})` };
      const b = park.run('ride.build', { type, x, y, rot }, actor);
      if (!b.ok) continue;
      for (const [px, py] of route) park.run('path.place', { x: px, y: py }, actor);
      const id = (b.data as { id: number }).id;
      return { ok: true, rideId: id, focus: { x, y }, message: `built ${t.name} at ${x},${y} (entrance ${ex},${ey})${route.length ? ` and laid ${route.length} path tile${route.length > 1 ? 's' : ''} to connect it` : ', opening onto the path'}` };
    }
  }
  return { ok: false, message: `no room for ${t.name} near ${target.x},${target.y}`, };
}
