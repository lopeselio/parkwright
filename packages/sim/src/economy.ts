import type { Content, Ratings, StaffRole } from '@parkwright/content';
import { DAYS_PER_SEASON, rulesOf, type Ledger, type LedgerCategory, type ParkState, type Ride } from './types.ts';

export const emptyLedger = (): Ledger => ({
  construction: 0, upkeep: 0, wages: 0, stock: 0, marketing: 0, interest: 0,
  gate: 0, rides: 0, stalls: 0, refunds: 0,
});

export const INCOME: LedgerCategory[] = ['gate', 'rides', 'stalls'];

/** Book money. Positive = income, negative = cost. */
export function book(s: ParkState, cat: LedgerCategory, amount: number) {
  if (amount === 0) return;
  s.cash += amount;
  s.ledgerWeek[cat] += amount;
  s.ledgerTotal[cat] += amount;
  if (amount > 0) s.today.income += amount;
  else s.today.costs -= amount;
}

/** What a ride is worth to a visitor, in cents, before price. */
export function rideValue(r: Ratings, ageDays: number, duplicates: number): number {
  let v = (r.e * 52 + r.i * 28 + r.n * 10) >> 5;
  const seasons = ageDays / DAYS_PER_SEASON;
  if (seasons < 1) v = Math.floor(v * 1.15);
  else if (seasons >= 3) v = Math.floor(v * Math.max(0.4, 1 - (seasons - 3) * 0.08));
  if (duplicates > 0) v = Math.floor(v * 0.8);
  return Math.max(0, v);
}

/** Excitement bonus from scenery near the ride (flat rides). */
export function sceneryBonus(s: ParkState, r: Ride, beauty: (id: number) => number): number {
  let b = 0;
  for (let y = r.y - 3; y < r.y + r.h + 3; y++) {
    for (let x = r.x - 3; x < r.x + r.w + 3; x++) {
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      b += beauty(s.scenery[y * s.w + x]);
    }
  }
  return Math.min(80, b * 2);
}

export function refreshRideValues(s: ParkState, c: Content, beauty: (id: number) => number) {
  const counts = new Map<string, number>();
  for (const r of s.rides) {
    const t = c.rideTypes[r.type];
    if (t.kind === 'flat') {
      r.ratings = { ...t.ratings, e: t.ratings.e + sceneryBonus(s, r, beauty) };
    }
    if (!r.ratings || (t.kind !== 'flat' && t.kind !== 'track')) { r.value = 0; continue; }
    const dup = counts.get(r.type) ?? 0;
    counts.set(r.type, dup + 1);
    r.value = rideValue(r.ratings, s.day - r.builtDay, dup);
  }
}

/** Σ max(0, value − price) over open rides — what visitors think the rides are worth beyond their prices. */
export function valueForMoney(s: ParkState): number {
  let v = 0;
  for (const r of s.rides) if (r.status === 'open' && r.value > r.price) v += r.value - r.price;
  return v;
}

export function parkValue(s: ParkState, c: Content): number {
  let v = 0;
  for (const r of s.rides) v += Math.floor(c.rideTypes[r.type].cost * 0.6) + r.value * 20;
  return v + s.visitors.filter((x) => x.mode !== 'gone').length * 500;
}

/** Park rating 0–1000, recomputed daily. */
export function computeRating(s: ParkState, c: Content): number {
  const v2 = rulesOf(s) >= 2;
  const here = s.visitors.filter((v) => v.mode !== 'gone');
  const n = here.length;
  let r = 300;
  if (n > 0) {
    const happy = here.filter((v) => v.happy > 128).length;
    r += Math.floor((300 * happy) / n);
    const lost = here.filter((v) => v.lostTicks > 600).length;
    // v2: a few lost visitors are forgiven per 50 in the park, so a big crowd isn't penalised for its size.
    r -= Math.max(0, lost - 10 - (v2 ? Math.floor(n / 50) : 0)) * 5;
  } else {
    r += 150;
  }
  r += Math.min(150, Math.floor(n / 3));
  const attractions = s.rides.filter((x) => c.rideTypes[x.type].kind === 'flat' || c.rideTypes[x.type].kind === 'track');
  if (attractions.length === 0) r -= 150;
  else {
    const up = attractions.filter((x) => x.status === 'open').length / attractions.length;
    r += Math.floor(100 * up) - 50;
    let e = 0;
    for (const a of attractions) e += a.ratings?.e ?? 0;
    r += Math.min(150, Math.floor(e / 25));
  }
  let litter = 0;
  for (const l of s.litter) litter += l;
  if (v2) {
    // v2: litter counts by density — 1 piece per path tile costs 300 — so a big park isn't judged by its size.
    let paths = 0;
    for (const t of s.tiles) if (t !== 0) paths++;
    r -= Math.min(250, Math.floor((litter * 300) / Math.max(100, paths)));
  } else r -= Math.min(250, litter * 3);
  r -= Math.min(300, s.incidents);
  return Math.max(0, Math.min(1000, r));
}

/**
 * Running costs. Rules v2 multiplies wages and upkeep, so a park's costs grow with the staff and rides a
 * big crowd needs instead of vanishing next to its takings.
 */
export const WAGES_V2 = 4;
export const UPKEEP_V2 = 3;

/** What a staff member costs per week, in cents, on this park's rules. */
export function weeklyWage(s: ParkState, c: Content, role: StaffRole): number {
  return c.staff[role].wage * (rulesOf(s) >= 2 ? WAGES_V2 : 1);
}

/** What a ride, stall or facility costs to run per week, in cents, on this park's rules. */
export function weeklyUpkeep(s: ParkState, c: Content, type: string): number {
  return c.rideTypes[type].upkeep * (rulesOf(s) >= 2 ? UPKEEP_V2 : 1);
}

/** Rules v2: each this many points of ride draw adds the base arrival rate again. */
export const ARRIVAL_DRAW = 40;
/** Rules v2: word of mouth. Arrivals start at AWARE_START/AWARE_FULL of demand and reach it after AWARE_FULL − AWARE_START visitors. */
export const AWARE_START = 1000;
export const AWARE_FULL = 6000;

/** Expected arrivals per day. */
export function arrivalRate(s: ParkState, c: Content): number {
  let rate = 10 + s.rating / 6;
  let draw = 0;
  for (const r of s.rides) if (r.status === 'open') draw += c.rideTypes[r.type].draw;
  let here = 0;
  for (const v of s.visitors) if (v.mode !== 'gone') here++;
  if (rulesOf(s) >= 2) {
    // v2: what's on offer drives demand, word of mouth builds with every visitor so far, and a park
    // holds four to five visitors per point of draw before word gets round that it's packed.
    rate *= 1 + draw / ARRIVAL_DRAW;
    rate *= Math.min(1, (AWARE_START + s.totalVisitors) / AWARE_FULL);
    if (here > draw * 5.5) rate /= 3;
    else if (here > draw * 4) rate /= 1.6;
  } else if (here > draw * 3) rate /= 3;
  else if (here > draw * 2) rate /= 1.6;
  const vfm = valueForMoney(s);
  if (s.fee > vfm) rate /= 2;
  if (s.fee > vfm * 2) rate /= 2;
  for (const m of s.campaigns) rate *= m.kind === 'billboard' ? 1.5 : m.kind === 'flyers' ? 1.25 : 1.4;
  return rate;
}
