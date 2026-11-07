import type { Content } from '@parkwright/content';
import { book } from './economy.ts';
import { ejectQueue } from './actions.ts';
import { chance, randInt } from './rng.ts';
import { finishRide, leaveRide, pay, think } from './visitors.ts';
import type { ParkState, Ride, Visitor } from './types.ts';

/** How long a partial load waits for more riders before it runs anyway. */
const LOAD_PATIENCE = 120;

export function updateRide(s: ParkState, c: Content, r: Ride, byId: Map<number, import('./types.ts').Visitor>) {
  const t = c.rideTypes[r.type];
  if (t.kind === 'stall') return;
  if (r.status === 'broken') return;
  if (r.cycle > 0) {
    r.cycle--;
    if (r.cycle === 0) {
      for (const id of r.riders) {
        const v = byId.get(id);
        if (v) finishRide(s, c, v, r);
      }
      r.riders = [];
    }
    return;
  }
  if (r.status !== 'open' || r.queue.length === 0) { r.loadWait = 0; return; }
  r.loadWait++;
  if (r.queue.length < t.capacity && r.loadWait < LOAD_PATIENCE) return;
  r.loadWait = 0;
  const batch = r.queue.splice(0, t.capacity);
  for (const id of batch) {
    const v = byId.get(id);
    if (!v) continue;
    if (v.cash < r.price) { v.mode = 'walking'; think(s, v, `can't afford ${r.name}`, r.id); continue; }
    if (r.price > 0) pay(s, v, r.price, 'rides', `r${r.id}`);
    r.customers++;
    r.income += r.price;
    r.incomeWeek += r.price;
    v.mode = 'riding';
    r.riders.push(id);
  }
  const cycle = t.kind === 'track' ? trackCycle(r) : t.cycleTicks;
  r.cycle = Math.max(1, cycle);
}

function trackCycle(r: Ride): number {
  return 200 + (r.track?.length ?? 10) * 12;
}

/** Daily wear and a chance of breaking down. */
export function wearRide(s: ParkState, c: Content, r: Ride) {
  const t = c.rideTypes[r.type];
  const ageSeasons = Math.floor((s.day - r.builtDay) / 28);
  r.reliability = Math.max(0, r.reliability - Math.round(t.wear * (1 + ageSeasons * 0.25)));
  if (r.status !== 'open' || t.kind === 'stall') return;
  const risk = 10000 - r.reliability; // 0..10000
  if (chance(s.rng, risk, 40000)) breakDown(s, c, r);
}

export function breakDown(s: ParkState, c: Content, r: Ride, byId?: Map<number, Visitor>) {
  r.status = 'broken';
  r.brokenSince = s.tick;
  ejectQueue(s, r);
  // Riders are let off (and refunded) rather than left stuck until a mechanic comes.
  for (const id of r.riders) {
    const v = byId?.get(id) ?? s.visitors.find((x) => x.id === id);
    if (!v) continue;
    if (r.price > 0) { v.cash += r.price; v.spent -= r.price; book(s, 'refunds', -r.price); }
    leaveRide(s, r, v);
    v.happy = Math.max(0, v.happy - 25);
    think(s, v, `${r.name} broke down`, r.id);
  }
  r.riders = [];
  r.cycle = 0;
  s.incidents += 20;
}

/** Mechanics: send the nearest idle one to broken rides, and inspect old ones. */
export function fixRide(s: ParkState, r: Ride) {
  r.status = 'open';
  r.reliability = Math.min(10000, r.reliability + Math.floor((10000 - r.reliability) / 2));
  r.lastInspected = s.day;
  r.brokenSince = -1;
}

export function inspectRide(s: ParkState, r: Ride) {
  r.reliability = Math.min(10000, r.reliability + Math.floor((10000 - r.reliability) / 3) + randInt(s.rng, 200));
  r.lastInspected = s.day;
}

/** Upkeep is charged daily (1/7 of the weekly figure), so a ride built and removed inside a week still pays. */
export function payUpkeep(s: ParkState, c: Content) {
  for (const r of s.rides) book(s, 'upkeep', -Math.round(c.rideTypes[r.type].upkeep / 7));
}
