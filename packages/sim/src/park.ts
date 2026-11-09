import type { Content } from '@parkwright/content';
import { ACTIONS, checkParams, findRideType, type ActionResult, type Hook } from './actions.ts';
import './coaster.ts'; // registers coaster.* actions
import { arrivalRate, book, computeRating, emptyLedger, parkValue, refreshRideValues } from './economy.ts';
import { idx, Routes, SCENERY } from './map.ts';
import { chance, seedRng } from './rng.ts';
import { payUpkeep, updateRide, wearRide } from './rides.ts';
import { updateStaff } from './staff.ts';
import { DAYS_PER_SEASON, DAYS_PER_WEEK, TICKS_PER_DAY, Tile, type ActionRecord, type DayStats, type ParkState, type Visitor } from './types.ts';
import { spawnVisitor, updateVisitor } from './visitors.ts';

const beauty = (id: number) => SCENERY[id]?.beauty ?? 0;
const freshDay = (day: number): DayStats => ({ day, visitors: 0, arrivals: 0, rating: 0, income: 0, rideIncome: 0, costs: 0, spend: {} });

export function newState(c: Content, scenarioId: string, seed: number, name = 'My Park'): ParkState {
  const sc = c.scenarios[scenarioId];
  if (!sc) throw new Error(`unknown scenario ${scenarioId}; have ${Object.keys(c.scenarios).join(', ')}`);
  const [w, h] = sc.size;
  const s: ParkState = {
    version: 1, name, scenario: sc.id, seed, rng: seedRng(seed), tick: 0, day: 0, w, h,
    tiles: new Array(w * h).fill(Tile.Grass), occ: new Array(w * h).fill(0), litter: new Array(w * h).fill(0),
    bins: new Array(w * h).fill(0), scenery: new Array(w * h).fill(0),
    gate: [sc.gate[0], sc.gate[1]], cash: sc.cash + sc.loan, loan: sc.loan, maxLoan: sc.maxLoan, interestBp: sc.interestBp,
    fee: sc.fee, rating: 500, rides: [], visitors: [], staff: [], campaigns: [], nextId: 1, mapVersion: 0,
    ledgerWeek: emptyLedger(), ledgerTotal: emptyLedger(), today: freshDay(0), history: [],
    objective: { status: 'pending', checkedDay: -1 }, incidents: 0, totalVisitors: 0,
    mods: c.packs.map((p) => `${p.id}@${p.version}`),
  };
  for (const [x, y] of [sc.gate, ...sc.paths]) s.tiles[idx(s, x, y)] = Tile.Path;
  return s;
}

/** FNV-1a 32 over the canonical JSON of the state. Same seed + same actions ⇒ same hash. */
export function stateHash(s: ParkState): string {
  const str = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export type ParkEvent =
  | { kind: 'action'; record: ActionRecord; result: ActionResult }
  | { kind: 'day'; stats: DayStats }
  | { kind: 'objective'; status: 'won' | 'lost' };

export class Park {
  readonly routes: Routes;
  readonly log: ActionRecord[] = [];
  hooks: Hook[] = [];
  private listeners: ((e: ParkEvent) => void)[] = [];
  /** id → visitor for s.visitors. Derived from the state only (rebuilt when the array is replaced, extended as it grows). */
  private byId = new Map<number, Visitor>();
  private byIdOf: Visitor[] | null = null;
  private byIdLen = 0;

  constructor(public s: ParkState, public c: Content) {
    this.routes = new Routes(() => this.s);
  }

  static create(c: Content, scenario: string, seed: number, name?: string) {
    return new Park(newState(c, scenario, seed, name), c);
  }

  /** Rebuild from scratch by replaying an action log. */
  static replay(c: Content, scenario: string, seed: number, log: ActionRecord[], untilTick: number, name?: string, hooks: Hook[] = []) {
    const p = Park.create(c, scenario, seed, name);
    p.hooks = hooks;
    const sorted = [...log].sort((a, b) => a.tick - b.tick);
    for (const rec of sorted) {
      if (rec.tick > untilTick) break;
      p.advanceTo(rec.tick);
      p.run(rec.type, rec.params, rec.actor);
    }
    p.advanceTo(untilTick);
    return p;
  }

  on(fn: (e: ParkEvent) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((x) => x !== fn); };
  }

  private emit(e: ParkEvent) {
    for (const l of this.listeners) l(e);
  }

  /** Validate without changing anything. */
  /**
   * Canonical params: ride types typed by name ("Carousel", "swing") become their ids before hooks run
   * and before the action is logged, so mod rules can't be dodged and replays don't depend on which
   * mods happen to be loaded.
   */
  normalize(type: string, params: Record<string, unknown>): Record<string, unknown> {
    if (type === 'ride.build' && params && params.type !== undefined) {
      const id = findRideType(this.c, params.type);
      if (id && id !== params.type) return { ...params, type: id };
    }
    return params;
  }

  query(type: string, rawParams: Record<string, unknown>): ActionResult {
    const params = this.normalize(type, rawParams);
    const a = ACTIONS[type];
    if (!a) return { ok: false, error: `unknown action "${type}"`, hint: `actions: ${Object.keys(ACTIONS).join(', ')}` };
    const bad = checkParams(this.s, params);
    if (bad) return bad;
    const ctx = { s: this.s, c: this.c };
    let res = a.query(ctx, params);
    if (!res.ok) return res;
    for (const h of this.hooks) {
      if (!h.query) continue;
      const out = h.query(ctx, type, params, res);
      if (typeof out === 'number') res = { ...res, cost: Math.max(0, Math.round(out)) };
      else if (out && !out.ok) return { ...out, error: `${out.error} (mod ${h.mod})` };
    }
    if (res.cost > 0 && res.cost > this.s.cash) {
      return { ok: false, error: `that costs ${(res.cost / 100).toFixed(0)} cr and you have ${(this.s.cash / 100).toFixed(0)} cr`, hint: 'take a loan (loan.set) or wait for income' };
    }
    return res;
  }

  /** Query, then execute and book the cost. Every change to the park goes through here. */
  run(type: string, rawParams: Record<string, unknown>, actor = 'player'): ActionResult {
    const params = this.normalize(type, rawParams);
    const q = this.query(type, params);
    const record: ActionRecord = { tick: this.s.tick, type, params, actor };
    if (!q.ok) { this.emit({ kind: 'action', record, result: q }); return q; }
    const a = ACTIONS[type];
    const res = a.execute({ s: this.s, c: this.c }, params);
    if (res.ok) {
      const cost = q.cost; // hooks may have adjusted it in query
      if (cost > 0) book(this.s, a.category ?? 'construction', -cost);
      res.cost = cost;
      // Record what was actually paid (after hooks), so refunds can never exceed it.
      if ((type === 'ride.build' || type === 'coaster.start' || type === 'coaster.add') && res.data) {
        const built = this.s.rides.find((r) => r.id === (res.data as { id: number }).id);
        if (built) built.paid = (type === 'coaster.add' ? built.paid ?? 0 : 0) + cost;
        // Spread what was paid over the pieces just placed, so undo refunds exactly that.
        if (built?.track && type !== 'ride.build') {
          const n = type === 'coaster.start' ? built.track.length : Number(params.count ?? 1);
          const fresh = built.track.slice(-n);
          fresh.forEach((tp, i) => { tp.paid = Math.floor(cost / n) + (i === n - 1 ? cost % n : 0); });
        }
      }
      this.log.push(record);
      if (type.startsWith('ride.') || type.startsWith('scenery.')) refreshRideValues(this.s, this.c, beauty);
      for (const h of this.hooks) h.execute?.({ s: this.s, c: this.c }, type, params, res);
    }
    this.emit({ kind: 'action', record, result: res });
    return res;
  }

  advanceTo(tick: number) {
    while (this.s.tick < tick) this.tick();
  }

  tick() {
    const s = this.s, c = this.c;
    s.tick++;
    const rate = arrivalRate(s, c);
    if (chance(s.rng, Math.round(rate * 100), TICKS_PER_DAY * 100)) spawnVisitor(s, c);
    for (const v of s.visitors) updateVisitor(s, c, this.routes, v);
    const byId = this.visitorIndex();
    for (const r of s.rides) updateRide(s, c, r, byId);
    updateStaff(s, c, this.routes);
    if (s.tick % TICKS_PER_DAY === 0) this.endDay();
  }

  /** The visitor index, kept in step with s.visitors without rebuilding it every tick. */
  private visitorIndex(): Map<number, Visitor> {
    const vs = this.s.visitors;
    if (vs !== this.byIdOf || vs.length < this.byIdLen) { this.byId.clear(); this.byIdOf = vs; this.byIdLen = 0; }
    for (let i = this.byIdLen; i < vs.length; i++) this.byId.set(vs[i].id, vs[i]);
    this.byIdLen = vs.length;
    return this.byId;
  }

  private endDay() {
    const s = this.s, c = this.c;
    for (const r of s.rides) wearRide(s, c, r);
    // Running costs are charged daily (a seventh of the weekly rate) into today's stats,
    // so hiring and firing around payday can't dodge them.
    payUpkeep(s, c);
    for (const st of s.staff) book(s, 'wages', -Math.round(c.staff[st.role].wage / 7));
    refreshRideValues(s, c, beauty);
    s.rating = computeRating(s, c);
    s.visitors = s.visitors.filter((v) => v.mode !== 'gone');
    s.today.visitors = s.visitors.length;
    s.today.rating = s.rating;
    s.incidents = Math.max(0, s.incidents - 10);
    const done = s.today;
    s.history.push(done);
    if (s.history.length > DAYS_PER_SEASON * 2) s.history.shift();
    s.day++;
    s.today = freshDay(s.day);
    if (s.day % DAYS_PER_WEEK === 0) this.startWeek();
    this.checkObjective();
    this.emit({ kind: 'day', stats: done });
  }

  /** New week: fresh weekly ledger, then this week's interest and campaign countdown. */
  private startWeek() {
    const s = this.s;
    s.ledgerWeek = emptyLedger();
    for (const r of s.rides) r.incomeWeek = 0;
    if (s.loan > 0) book(s, 'interest', -Math.floor((s.loan * s.interestBp) / 10000 / 4));
    for (const m of s.campaigns) m.weeksLeft--;
    s.campaigns = s.campaigns.filter((m) => m.weeksLeft > 0);
  }

  private checkObjective() {
    const s = this.s, c = this.c;
    if (s.objective.status !== 'pending') return;
    const o = c.scenarios[s.scenario].objective;
    let won = false, deadline = Infinity;
    switch (o.kind) {
      case 'visitors': won = s.visitors.length >= o.count && s.rating >= o.minRating; deadline = o.byDay; break;
      case 'parkValue': won = parkValue(s, c) >= o.value; deadline = o.byDay; break;
      case 'rideIncome': won = s.history.slice(-7).reduce((a, d) => a + d.rideIncome, 0) >= o.perWeek; break;
      case 'coasters': won = s.rides.filter((r) => r.track && (r.ratings?.e ?? 0) >= o.minExcitement).length >= o.count; deadline = o.byDay; break;
      case 'sandbox': return;
    }
    if (won) s.objective.status = 'won';
    else if (s.day >= deadline) s.objective.status = 'lost';
    s.objective.checkedDay = s.day;
    if (s.objective.status !== 'pending') this.emit({ kind: 'objective', status: s.objective.status });
  }

  hash() {
    return stateHash(this.s);
  }

  snapshot(): ParkState {
    return structuredClone(this.s);
  }
}
