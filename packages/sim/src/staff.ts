import type { Content } from '@parkwright/content';
import { idx, isPath, Routes } from './map.ts';
import { chance, randInt } from './rng.ts';
import { fixRide, inspectRide } from './rides.ts';
import { DX, DY, rulesOf, SUB, type Dir, type ParkState, type Staff } from './types.ts';

const WALK = 3;
const FIX_TICKS = 160;
const INSPECT_TICKS = 100;
const INSPECT_EVERY_DAYS = 4;

function assignMechanics(s: ParkState) {
  const taken = new Set(s.staff.map((m) => m.task).filter((t) => t !== null));
  const idle = s.staff.filter((m) => m.role === 'mechanic' && m.task === null);
  const jobs = s.rides
    .filter((r) => !taken.has(r.id) && (r.status === 'broken' || (r.status === 'open' && s.day - r.lastInspected >= INSPECT_EVERY_DAYS && r.reliability < 9000)))
    .sort((a, b) => (a.status === 'broken' ? 0 : 1) - (b.status === 'broken' ? 0 : 1));
  for (const r of jobs) {
    const m = idle.shift();
    if (!m) return;
    m.task = r.id;
    m.goal = { kind: 'ride', ride: r.id };
  }
}

export function updateStaff(s: ParkState, _c: Content, routes: Routes) {
  if ((s.tick & 63) === 0) assignMechanics(s);
  for (const m of s.staff) {
    if (m.busy > 0) {
      if (--m.busy === 0 && m.task !== null) {
        const r = s.rides.find((x) => x.id === m.task);
        if (r) { if (r.status === 'broken') fixRide(s, r); else inspectRide(s, r); }
        m.task = null;
        m.goal = null;
      }
      continue;
    }
    if (m.tx === m.nx && m.ty === m.ny) { step(s, routes, m); continue; }
    m.p += WALK;
    if (m.p >= SUB) {
      m.p = 0;
      m.tx = m.nx;
      m.ty = m.ny;
      if (!isPath(s, m.tx, m.ty)) { m.tx = m.nx = s.gate[0]; m.ty = m.ny = s.gate[1]; }
      if (m.role === 'handyman') {
        const k = idx(s, m.tx, m.ty);
        if (s.litter[k] > 0) { s.litter[k] = 0; m.busy = 20; }
      }
    }
  }
}

function step(s: ParkState, routes: Routes, m: Staff) {
  if (m.task !== null) {
    const r = s.rides.find((x) => x.id === m.task);
    if (!r) { m.task = null; m.goal = null; }
    else {
      const f = routes.toRide(r);
      const here = Routes.dist(s, f, m.tx, m.ty);
      if (here === 0) { m.busy = r.status === 'broken' ? FIX_TICKS : INSPECT_TICKS; return; }
      if (here < 0) { m.task = null; m.goal = null; }
      else {
        for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
          if (Routes.dist(s, f, m.tx + DX[d], m.ty + DY[d]) === here - 1) { go(m, d); return; }
        }
      }
    }
  }
  // Handymen head for litter nearby; everyone else wanders.
  const opts: Dir[] = [];
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) if (isPath(s, m.tx + DX[d], m.ty + DY[d])) opts.push(d);
  if (!opts.length) return;
  if (m.role === 'handyman') {
    const dirty = opts.filter((d) => s.litter[idx(s, m.tx + DX[d], m.ty + DY[d])] > 0);
    if (dirty.length) { go(m, dirty[0]); return; }
    if (rulesOf(s) >= 2) { const d = towardLitter(s, m); if (d !== null) { go(m, d); return; } }
  }
  const back = ((m.dir + 2) & 3) as Dir;
  const fwd = opts.filter((d) => d !== back);
  const pool = fwd.length ? fwd : opts;
  go(m, pool.includes(m.dir) && chance(s.rng, 2, 3) ? m.dir : pool[randInt(s.rng, pool.length)]);
}

/** Rules v2: handymen look down the paths for litter (breadth-first, a few tiles out) instead of stumbling on it. */
const LITTER_SIGHT = 8;
const seenBuf: number[] = [];
const firstBuf: Dir[] = [];

function towardLitter(s: ParkState, m: Staff): Dir | null {
  // A BFS over path tiles from the handyman; each tile remembers the first step that led there.
  // Scratch arrays are reused (their contents never outlive the call), so this is a pure function of the state.
  const start = idx(s, m.tx, m.ty);
  seenBuf.length = 0; firstBuf.length = 0;
  seenBuf.push(start); firstBuf.push(0);
  const seen = new Set<number>([start]);
  let head = 0;
  for (let depth = 0; depth < LITTER_SIGHT; depth++) {
    const end = seenBuf.length;
    for (; head < end; head++) {
      const k = seenBuf[head], x = k % s.w, y = (k - x) / s.w;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!isPath(s, nx, ny)) continue;
        const nk = idx(s, nx, ny);
        if (seen.has(nk)) continue;
        const first = head === 0 ? d : firstBuf[head];
        if (s.litter[nk] > 0) return first;
        seen.add(nk); seenBuf.push(nk); firstBuf.push(first);
      }
    }
  }
  return null;
}

function go(m: Staff, d: Dir) {
  m.dir = d;
  m.nx = m.tx + DX[d];
  m.ny = m.ty + DY[d];
}
