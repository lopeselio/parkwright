import type { Content } from '@parkwright/content';
import { book } from './economy.ts';
import { accessTiles, idx, isPath, queueCapacity, Routes, SCENERY } from './map.ts';
import { chance, randInt, randRange } from './rng.ts';
import { DX, DY, rulesOf, SUB, type Dir, type ParkState, type Ride, type Visitor } from './types.ts';

/** Walking visitors per tile, counted once at the start of a tick (rules v2+), or null to count on demand (v1). */
export type Crowd = Uint16Array | null;

const FIRST = ['Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Femi', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lior', 'Mina', 'Nico', 'Oona', 'Pip', 'Quin', 'Rosa', 'Sami', 'Tova', 'Uri', 'Vale', 'Wren', 'Xan', 'Yara', 'Zeb'];
const LAST = ['Ash', 'Birch', 'Cole', 'Dunn', 'Ever', 'Frost', 'Gale', 'Hart', 'Isle', 'Jett', 'Knox', 'Lark', 'Moss', 'Nash', 'Oak', 'Pike', 'Reed', 'Stone', 'Thorn', 'Vance', 'West', 'Yew'];

export const PATRON_GROUPS = 8;
const STOMACH_CAP = [200, 380, 560, 760];
const MAX_THOUGHTS = 5;
const WALK = 2;

export function think(s: ParkState, v: Visitor, kind: string, ride?: number) {
  if (v.thoughts[0]?.kind === kind && v.thoughts[0]?.ride === ride) return;
  v.thoughts.unshift({ kind, ride, day: s.day });
  if (v.thoughts.length > MAX_THOUGHTS) v.thoughts.length = MAX_THOUGHTS;
}

const clamp = (n: number) => Math.max(0, Math.min(255, n));

export function spawnVisitor(s: ParkState, c: Content): Visitor | null {
  const sc = c.scenarios[s.scenario];
  const arch = sc.archetypes;
  let roll = randInt(s.rng, arch.reduce((a, b) => a + b.weight, 0));
  let a = arch[0];
  for (const x of arch) { if (roll < x.weight) { a = x; break; } roll -= x.weight; }
  const cash = Math.floor(sc.visitorCash * (75 + randInt(s.rng, 51)) / 100);
  const free = s.campaigns.some((m) => m.kind === 'freeEntry');
  const fee = free ? 0 : s.fee;
  if (cash < fee + 200) return null; // turns away at the gate
  const [gx, gy] = s.gate;
  const v: Visitor = {
    id: s.nextId++,
    name: `${FIRST[randInt(s.rng, FIRST.length)]} ${LAST[randInt(s.rng, LAST.length)]}`,
    group: randInt(s.rng, PATRON_GROUPS),
    mode: 'walking',
    tx: gx, ty: gy, nx: gx, ny: gy, p: 0, dir: 0,
    goal: null,
    happy: randRange(s.rng, 120, 140),
    energy: randRange(s.rng, 110, 130),
    hunger: randRange(s.rng, 150, 220),
    thirst: randRange(s.rng, 150, 220),
    bladder: randRange(s.rng, 0, 60),
    queasy: 0,
    cash,
    spent: 0,
    thrill: [a.thrill[0], a.thrill[1]],
    stomach: a.stomach,
    ridden: [],
    thoughts: [],
    holding: null,
    litterIn: 0,
    queuedAt: 0,
    enteredTick: s.tick,
    lostTicks: 0,
  };
  if (fee > 0) { pay(s, v, fee, 'gate', 'gate'); }
  s.visitors.push(v);
  s.totalVisitors++;
  s.today.arrivals++;
  return v;
}

/** Move money from a visitor to the park and record it against the visitor's patron group. */
export function pay(s: ParkState, v: Visitor, amount: number, cat: 'gate' | 'rides' | 'stalls', venue: string) {
  v.cash -= amount;
  v.spent += amount;
  book(s, cat, amount);
  if (cat === 'rides') s.today.rideIncome += amount;
  const g = (s.today.spend[String(v.group)] ??= {});
  g[venue] = (g[venue] ?? 0) + amount;
}

function attraction(c: Content, r: Ride) {
  const k = c.rideTypes[r.type].kind;
  return k === 'flat' || k === 'track';
}

/** Value a visitor perceives; halved when they paid to get in. */
function perceived(s: ParkState, r: Ride) {
  const paidEntry = s.fee > 0 && !s.campaigns.some((m) => m.kind === 'freeEntry');
  return paidEntry ? r.value >> 1 : r.value;
}

/** Why a visitor won't ride, or null if they will. */
export function refusal(s: ParkState, c: Content, v: Visitor, r: Ride): string | null {
  if (r.status !== 'open') return 'closed';
  if (r.queue.length >= queueCapacity(s, r)) return 'queue too long';
  if (r.price > v.cash) return 'cannot afford';
  if (!attraction(c, r) || !r.ratings) return null;
  const slack = v.happy >> 2;
  if (r.ratings.i < v.thrill[0] - slack) return 'too tame';
  if (r.ratings.i > v.thrill[1] + slack) return 'too intense';
  if (r.ratings.n > STOMACH_CAP[v.stomach] + (v.happy >> 1)) return 'looks sickening';
  if (v.queasy > 150 && r.ratings.n >= 140) return 'feeling queasy';
  if (r.price > 2 * perceived(s, r)) return 'bad value';
  return null;
}

function chooseRide(s: ParkState, c: Content, routes: Routes, v: Visitor): Ride | null {
  const v2 = rulesOf(s) >= 2;
  let best: Ride | null = null, bestScore = -Infinity;
  for (const r of s.rides) {
    if (!attraction(c, r) || r.status !== 'open' || !r.ratings) continue;
    const f = routes.toRide(r);
    const d = Routes.dist(s, f, v.tx, v.ty);
    if (d < 0 || d > 60) continue;
    if (v.ridden[v.ridden.length - 1] === r.id) continue;
    // Visitors can see what a ride is like before walking over; skip ones they'd never get on.
    const slack = v.happy >> 2;
    if (r.ratings.i < v.thrill[0] - slack || r.ratings.i > v.thrill[1] + slack) continue;
    const mid = (v.thrill[0] + v.thrill[1]) / 2;
    let score: number;
    if (v2) {
      // v2: a full queue isn't worth the walk, a long one counts against the ride by how full it is,
      // and intensity matters half as much, so a crowd spreads over every ride it would enjoy.
      const cap = queueCapacity(s, r);
      if (r.queue.length >= cap) continue;
      score = r.ratings.e - (Math.abs(r.ratings.i - mid) >> 1) - Math.floor((r.queue.length * 200) / cap) - d * 2 + (v.ridden.includes(r.id) ? 0 : 120) + randInt(s.rng, 80);
    } else score = r.ratings.e - Math.abs(r.ratings.i - mid) - r.queue.length * 8 - d * 2 + (v.ridden.includes(r.id) ? 0 : 120) + randInt(s.rng, 80);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

function nearestVenue(s: ParkState, c: Content, routes: Routes, v: Visitor, want: (r: Ride) => boolean): Ride | null {
  let best: Ride | null = null, bd = Infinity;
  for (const r of s.rides) {
    if (r.status !== 'open' || !want(r)) continue;
    const d = Routes.dist(s, routes.toRide(r), v.tx, v.ty);
    if (d >= 0 && d < bd) { bd = d; best = r; }
  }
  return best;
}

function sells(c: Content, r: Ride, need: string) {
  const t = c.rideTypes[r.type];
  return t.kind === 'stall' && !!t.item && c.items[t.item].need === need;
}

/** Pick a goal from current needs. */
function decide(s: ParkState, c: Content, routes: Routes, v: Visitor) {
  if (v.mode === 'leaving') { v.goal = { kind: 'exit' }; return; }
  if (v.energy < 40 || v.happy < 45 || (v.cash < 150 && v.holding === null)) {
    v.mode = 'leaving';
    think(s, v, v.cash < 150 ? 'out of money' : v.energy < 40 ? 'tired' : 'not having fun');
    v.goal = { kind: 'exit' };
    return;
  }
  const needs: [string, (r: Ride) => boolean][] = [];
  if (v.bladder >= 170) needs.push(['need a restroom', (r) => c.rideTypes[r.type].kind === 'facility']);
  if (v.thirst <= 60) needs.push(['thirsty', (r) => sells(c, r, 'thirst')]);
  if (v.hunger <= 50) needs.push(['hungry', (r) => sells(c, r, 'hunger')]);
  for (const [thought, want] of needs) {
    const r = nearestVenue(s, c, routes, v, want);
    think(s, v, thought);
    if (r) { v.goal = { kind: 'ride', ride: r.id }; return; }
  }
  if (v.ridden.length >= 2 && v.happy > 150 && chance(s.rng, 1, 6)) {
    const r = nearestVenue(s, c, routes, v, (x) => sells(c, x, 'souvenir'));
    if (r) { v.goal = { kind: 'ride', ride: r.id }; return; }
  }
  const r = chooseRide(s, c, routes, v);
  if (r) v.goal = { kind: 'ride', ride: r.id };
  else v.goal = null;
}

function stepNeeds(s: ParkState, v: Visitor) {
  v.hunger = clamp(v.hunger - 2);
  v.thirst = clamp(v.thirst - 2);
  v.bladder = clamp(v.bladder + (v.thirst > 180 ? 3 : 2));
  v.energy = clamp(v.energy - (v.mode === 'queuing' ? 1 : 0) - ((s.tick >> 5) % 3 === 0 ? 1 : 0));
  v.queasy = clamp(v.queasy - 3);
  if (v.happy > 128) v.happy--; else if (v.happy < 128) v.happy++;
  if (v.hunger < 20 || v.thirst < 20) v.happy = clamp(v.happy - 2);
  if (v.bladder > 220) v.happy = clamp(v.happy - 3);
  if (v.mode === 'queuing' && s.tick - v.queuedAt > 1500) {
    v.happy = clamp(v.happy - 2);
    if (s.tick - v.queuedAt > 2400) think(s, v, 'this queue is endless');
  }
  if (v.litterIn > 0 && --v.litterIn === 0) dropLitter(s, v);
}

/** Rules v2: litter goes in any bin within this many tiles (a short walk), not just an adjacent one. */
const BIN_REACH_V2 = 2;

function dropLitter(s: ParkState, v: Visitor) {
  const k = idx(s, v.tx, v.ty);
  if (rulesOf(s) >= 2) {
    for (let y = v.ty - BIN_REACH_V2; y <= v.ty + BIN_REACH_V2; y++) for (let x = v.tx - BIN_REACH_V2; x <= v.tx + BIN_REACH_V2; x++)
      if (x >= 0 && y >= 0 && x < s.w && y < s.h && s.bins[idx(s, x, y)]) return;
    s.litter[k] = Math.min(9, s.litter[k] + 1);
    return;
  }
  for (let d = -1; d <= 4; d++) {
    const x = v.tx + (d < 0 ? 0 : DX[d]), y = v.ty + (d < 0 ? 0 : DY[d]);
    if (x >= 0 && y >= 0 && x < s.w && y < s.h && s.bins[idx(s, x, y)]) return;
  }
  s.litter[k] = Math.min(9, s.litter[k] + 1);
}

const CROWDED_V2 = 12;

function surroundings(s: ParkState, v: Visitor, counts: Crowd) {
  let crowd = 0, litter = 0, beauty = 0;
  // v1 scans every visitor (O(n) per check, O(n²) a day); v2 reads the per-tick tile counts.
  if (counts) crowd = counts[idx(s, v.tx, v.ty)];
  else for (const o of s.visitors) if (o.mode === 'walking' && o.tx === v.tx && o.ty === v.ty) crowd++;
  for (let y = v.ty - 2; y <= v.ty + 2; y++) for (let x = v.tx - 2; x <= v.tx + 2; x++) {
    if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
    const k = idx(s, x, y);
    litter += s.litter[k];
    beauty += SCENERY[s.scenery[k]]?.beauty ?? 0;
  }
  // v2 paths take a bigger crowd before it feels packed.
  if (crowd >= (counts ? CROWDED_V2 : 8)) { v.happy = clamp(v.happy - 6); think(s, v, 'too crowded'); }
  if (litter >= 6) { v.happy = clamp(v.happy - 8); think(s, v, 'this path is filthy'); }
  if (beauty >= 12) { v.happy = clamp(v.happy + 6); if (beauty >= 24) think(s, v, 'lovely gardens'); }
  for (const st of s.staff) if (st.role === 'entertainer' && Math.abs(st.tx - v.tx) + Math.abs(st.ty - v.ty) <= 3) v.happy = clamp(v.happy + 3);
}

/** At a tile centre: decide where to step next. */
function chooseStep(s: ParkState, c: Content, routes: Routes, v: Visitor) {
  // Arrived at a venue's access tile?
  if (v.goal?.kind === 'ride') {
    const r = s.rides.find((x) => x.id === (v.goal as { ride: number }).ride);
    if (!r) { v.goal = null; }
    else if (Routes.dist(s, routes.toRide(r), v.tx, v.ty) === 0) { arriveAt(s, c, v, r); return; }
  }
  if (v.goal?.kind === 'exit' && v.tx === s.gate[0] && v.ty === s.gate[1]) {
    v.mode = 'gone';
    return;
  }
  let field: Int32Array | null = null;
  if (v.goal?.kind === 'ride') {
    const r = s.rides.find((x) => x.id === (v.goal as { ride: number }).ride)!;
    field = routes.toRide(r);
  } else if (v.goal?.kind === 'exit') field = routes.toExit();
  if (!isPath(s, v.tx, v.ty)) {
    // The path was removed under them: walk them back to the gate.
    v.tx = v.nx = s.gate[0];
    v.ty = v.ny = s.gate[1];
    return;
  }
  const opts: Dir[] = [];
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) if (isPath(s, v.tx + DX[d], v.ty + DY[d])) opts.push(d);
  if (!opts.length) { v.lostTicks += 32; }
  // Someone trying to leave who can't reach the gate gives up and is shown out.
  if (v.mode === 'leaving' && v.lostTicks > 2400) { v.mode = 'gone'; return; }
  if (!opts.length) return;
  let pick: Dir | null = null;
  if (field) {
    const here = Routes.dist(s, field, v.tx, v.ty);
    let bd = here < 0 ? Infinity : here;
    for (const d of opts) {
      const nd = Routes.dist(s, field, v.tx + DX[d], v.ty + DY[d]);
      if (nd >= 0 && nd < bd) { bd = nd; pick = d; }
    }
    if (pick === null) {
      v.lostTicks += 32;
      if (v.lostTicks > 1200) { think(s, v, v.goal?.kind === 'exit' ? "can't find the exit" : "can't find the way"); v.happy = clamp(v.happy - 10); v.goal = null; v.lostTicks = 0; }
    } else v.lostTicks = 0;
  }
  if (pick === null) {
    // Wander: prefer straight on, avoid turning back.
    const back = ((v.dir + 2) & 3) as Dir;
    const fwd = opts.filter((d) => d !== back);
    const pool = fwd.length ? fwd : opts;
    pick = pool.includes(v.dir) && chance(s.rng, 3, 4) ? v.dir : pool[randInt(s.rng, pool.length)];
  }
  v.dir = pick;
  v.nx = v.tx + DX[pick];
  v.ny = v.ty + DY[pick];
}

function arriveAt(s: ParkState, c: Content, v: Visitor, r: Ride) {
  v.goal = null;
  const t = c.rideTypes[r.type];
  const why = refusal(s, c, v, r);
  if (why) {
    v.happy = clamp(v.happy - (why === 'bad value' ? 14 : 6));
    think(s, v, why === 'bad value' ? `${r.name} is a rip-off` : `${r.name}: ${why}`, r.id);
    r.satisfaction.push(0);
    if (r.satisfaction.length > 20) r.satisfaction.shift();
    return;
  }
  if (t.kind === 'stall') { buy(s, c, v, r); return; }
  v.mode = 'queuing';
  v.queuedAt = s.tick;
  r.queue.push(v.id);
}

function buy(s: ParkState, c: Content, v: Visitor, r: Ride) {
  const item = c.items[c.rideTypes[r.type].item!];
  const need = item.need;
  const want = need === 'hunger' ? v.hunger < 120 : need === 'thirst' ? v.thirst < 140 : need === 'souvenir' ? v.holding === null : true;
  if (!want) return;
  const over = r.price - item.value;
  const tol = v.happy >= 180 ? 120 : v.happy >= 128 ? 60 : 20;
  if (over > tol) { think(s, v, `${item.name} is overpriced`, r.id); v.happy = clamp(v.happy - 8); return; }
  pay(s, v, r.price, 'stalls', `r${r.id}`);
  book(s, 'stock', -item.cost);
  r.customers++;
  r.income += r.price;
  r.incomeWeek += r.price;
  for (const [k, d] of Object.entries(item.effect)) (v as any)[k] = clamp((v as any)[k] + d!);
  if (over <= -50) { v.happy = clamp(v.happy + 8); think(s, v, `good deal on ${item.name}`, r.id); }
  if (item.litter) v.litterIn = randRange(s.rng, 6, 20);
  if (need === 'souvenir') v.holding = item.id;
}

/** Called by the ride when a visitor gets off. */
export function finishRide(s: ParkState, c: Content, v: Visitor, r: Ride) {
  const t = c.rideTypes[r.type];
  let sat = 0;
  if (t.kind === 'facility') {
    for (const [k, d] of Object.entries(t.serviceEffect ?? {})) (v as any)[k] = clamp((v as any)[k] + d!);
  } else if (r.ratings) {
    const pv = perceived(s, r);
    sat += r.price <= pv >> 1 ? 25 : r.price <= pv ? 12 : -12;
    const mid = (v.thrill[0] + v.thrill[1]) / 2;
    sat += Math.abs(r.ratings.i - mid) < 150 ? 25 : Math.abs(r.ratings.i - mid) < 300 ? 8 : -15;
    sat += Math.floor(r.ratings.e / 40);
    const waited = s.tick - v.queuedAt;
    sat += waited < 400 ? 10 : waited > 2000 ? -20 : 0;
    if (v.ridden.includes(r.id)) sat -= 5;
    v.queasy = clamp(v.queasy + Math.floor((r.ratings.n * (4 - v.stomach)) / 40));
    v.energy = clamp(v.energy - 4);
    v.ridden.push(r.id);
    if (v.ridden.length > 20) v.ridden.shift();
    r.satisfaction.push(sat >= 40 ? 3 : sat >= 20 ? 2 : sat >= 0 ? 1 : 0);
    if (r.satisfaction.length > 20) r.satisfaction.shift();
    if (sat >= 40) think(s, v, `${r.name} was amazing`, r.id);
    else if (sat < 0) think(s, v, `${r.name} wasn't worth it`, r.id);
    if (v.queasy > 200) { think(s, v, 'feeling sick'); }
  }
  v.happy = clamp(v.happy + sat);
  leaveRide(s, r, v);
}

/** Put a visitor back on the path next to the ride's entrance (or at the gate if it has no path). */
export function leaveRide(s: ParkState, r: Ride, v: Visitor) {
  const [x, y] = accessTiles(s, r)[0] ?? s.gate;
  v.tx = v.nx = x;
  v.ty = v.ny = y;
  v.p = 0;
  v.mode = 'walking';
  v.goal = null;
}

export function updateVisitor(s: ParkState, c: Content, routes: Routes, v: Visitor, crowd: Crowd = null) {
  if (v.mode === 'gone') return;
  if (((s.tick + v.id) & 31) === 0) {
    stepNeeds(s, v);
    if ((((s.tick + v.id) >> 5) & 7) === 0) surroundings(s, v, crowd);
    if (v.mode === 'walking' && v.queasy > 230 && chance(s.rng, 1, 4)) {
      s.litter[idx(s, v.tx, v.ty)] = Math.min(9, s.litter[idx(s, v.tx, v.ty)] + 2);
      v.queasy = 80;
      v.happy = clamp(v.happy - 20);
      think(s, v, 'threw up');
    }
  }
  if (v.mode !== 'walking' && v.mode !== 'leaving') return;
  if (v.tx === v.nx && v.ty === v.ny) {
    if (v.goal === null || ((s.tick + v.id) & 255) === 0) decide(s, c, routes, v);
    chooseStep(s, c, routes, v);
    return;
  }
  v.p += WALK;
  if (v.p >= SUB) {
    v.p = 0;
    v.tx = v.nx;
    v.ty = v.ny;
    if (!isPath(s, v.tx, v.ty)) {
      // Path removed under their feet: put them back at the gate.
      v.tx = v.nx = s.gate[0];
      v.ty = v.ny = s.gate[1];
    }
  }
}
