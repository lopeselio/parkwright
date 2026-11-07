import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { nextU32, seedRng } from '../src/rng.ts';
import { Park, TICKS_PER_DAY, findRide, refusal } from '../src/index.ts';
import { breakDown } from '../src/rides.ts';

/** A small working park: a path spine, a carousel, a pretzel cart, a lemonade stand and a restroom. */
function starter(seed = 7) {
  const p = Park.create(c, 'meadow', seed, 'Test Park');
  const ok = (type: string, params: Record<string, unknown>) => {
    const r = p.run(type, params);
    if (!r.ok) throw new Error(`${type}: ${r.error}`);
    return r;
  };
  ok('path.place', { x: 24, y: 30, x2: 24, y2: 40 });
  ok('path.place', { x: 18, y: 34, x2: 30, y2: 34 });
  ok('ride.build', { type: 'carousel', x: 20, y: 30, rot: 2 }); // entrance (21,33) touches path (21,34)
  ok('ride.open', { ride: 'brass carousel' });
  ok('ride.build', { type: 'swings', x: 26, y: 30, rot: 2 });
  ok('ride.open', { ride: 'whirl swings' });
  ok('ride.build', { type: 'pretzel-cart', x: 23, y: 36, rot: 1 });
  ok('ride.build', { type: 'lemonade-stand', x: 25, y: 37, rot: 3 });
  ok('ride.build', { type: 'restroom', x: 23, y: 38, rot: 1 });
  return p;
}

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = seedRng(1), b = seedRng(1), d = seedRng(2);
    const xs = Array.from({ length: 5 }, () => nextU32(a));
    expect(Array.from({ length: 5 }, () => nextU32(b))).toEqual(xs);
    expect(Array.from({ length: 5 }, () => nextU32(d))).not.toEqual(xs);
  });
});

describe('actions', () => {
  it('charges construction and logs only successful actions', () => {
    const p = Park.create(c, 'meadow', 1);
    const cash = p.s.cash;
    expect(p.run('path.place', { x: 24, y: 35, x2: 24, y2: 39 }).ok).toBe(true);
    expect(p.s.cash).toBe(cash - 5 * 1000);
    const bad = p.run('ride.build', { type: 'carousel', x: 46, y: 46 });
    expect(bad.ok).toBe(false);
    expect(p.log).toHaveLength(1);
  });

  it('gives guided errors', () => {
    const p = Park.create(c, 'meadow', 1);
    const r = p.run('ride.build', { type: 'rollercoaster', x: 1, y: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('carousel');
    const b = p.run('bin.place', { x: 3, y: 3 });
    if (!b.ok) expect(b.hint).toMatch(/nearest path tile 24,4\d/);
  });

  it('refuses what you cannot afford', () => {
    const p = Park.create(c, 'meadow', 1);
    p.s.cash = 1000;
    const r = p.run('ride.build', { type: 'droptower', x: 10, y: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('loan');
  });

  it('borrows and repays within the limit', () => {
    const p = Park.create(c, 'meadow', 1);
    const cash = p.s.cash;
    expect(p.run('loan.set', { amount: 25000 }).ok).toBe(true);
    expect(p.s.cash).toBe(cash + 1500000);
    expect(p.run('loan.set', { amount: 25001 }).ok).toBe(false);
    expect(p.run('loan.set', { amount: 0 }).ok).toBe(true);
    expect(p.s.loan).toBe(0);
  });

  it('lets a mod hook veto or reprice an action', () => {
    const p = Park.create(c, 'meadow', 1);
    p.hooks.push({ mod: 'no-teacups', query: (_ctx, type, params: any) => (type === 'ride.build' && params.type === 'teacups' ? { ok: false, error: 'teacups are banned' } : undefined) });
    p.hooks.push({ mod: 'cheap-paths', query: (_ctx, type, _p, res) => (type === 'path.place' ? res.cost / 2 : undefined) });
    const veto = p.run('ride.build', { type: 'teacups', x: 5, y: 5 });
    expect(veto.ok).toBe(false);
    if (!veto.ok) expect(veto.error).toContain('no-teacups');
    const cash = p.s.cash;
    p.run('path.place', { x: 24, y: 39, x2: 24, y2: 38 });
    expect(cash - p.s.cash).toBe(1000);
  });
});

describe('simulation', () => {
  it('visitors arrive, ride, eat and pay', () => {
    const p = starter();
    p.advanceTo(TICKS_PER_DAY * 4);
    const carousel = findRide(p.s, 'brass carousel')!;
    expect(p.s.totalVisitors).toBeGreaterThan(10);
    expect(carousel.customers).toBeGreaterThan(0);
    expect(p.s.ledgerTotal.rides).toBeGreaterThan(0);
    expect(p.s.history).toHaveLength(4);
    expect(p.s.rating).toBeGreaterThan(0);
  });

  it('records daily spend per patron group and venue', () => {
    const p = starter();
    const days: any[] = [];
    p.on((e) => { if (e.kind === 'day') days.push(e.stats); });
    p.advanceTo(TICKS_PER_DAY * 3);
    const total = days.reduce((a, d) => a + Object.values(d.spend as Record<string, Record<string, number>>).flatMap((g) => Object.values(g)).reduce((x, y) => x + y, 0), 0);
    expect(total).toBe(p.s.ledgerTotal.rides + p.s.ledgerTotal.stalls + p.s.ledgerTotal.gate);
  });

  it('overpriced rides get refused as bad value', () => {
    const p = starter();
    const r = findRide(p.s, 'brass carousel')!;
    p.run('ride.price', { ride: r.id, price: 40 });
    p.advanceTo(TICKS_PER_DAY);
    const v = { ...p.s.visitors[0], cash: 99999, thrill: [0, 1000] as [number, number] };
    expect(refusal(p.s, c, v, r)).toBe('bad value');
    p.run('ride.price', { ride: r.id, price: 1 });
    expect(refusal(p.s, c, v, r)).toBeNull();
  });

  it('replaying the action log reproduces the exact state', () => {
    const p = starter(42);
    p.advanceTo(900);
    p.run('ride.price', { ride: 'whirl swings', price: 3 });
    p.run('staff.hire', { role: 'handyman' });
    p.advanceTo(1500);
    p.run('scenery.place', { kind: 'oak', x: 18, y: 36, x2: 20, y2: 37 });
    p.advanceTo(TICKS_PER_DAY * 3);
    const again = Park.replay(c, 'meadow', 42, p.log, p.s.tick, 'Test Park');
    expect(again.hash()).toBe(p.hash());
    const other = Park.replay(c, 'meadow', 43, p.log, p.s.tick, 'Test Park');
    expect(other.hash()).not.toBe(p.hash());
  });

  it('mechanics fix broken rides', () => {
    const p = starter();
    p.run('staff.hire', { role: 'mechanic' });
    const r = findRide(p.s, 'brass carousel')!;
    r.status = 'broken';
    r.reliability = 3000;
    p.advanceTo(TICKS_PER_DAY - 1); // before the end-of-day wear roll, which may break it again
    expect(r.status).toBe('open');
    expect(r.reliability).toBeGreaterThan(3000);
  });

  it('pays wages, upkeep and interest weekly', () => {
    const p = starter();
    p.run('staff.hire', { role: 'handyman' });
    p.advanceTo(TICKS_PER_DAY * 7);
    expect(p.s.ledgerTotal.wages).toBe(-7 * Math.round(10000 / 7));
    expect(p.s.ledgerTotal.upkeep).toBeLessThan(0);
    expect(p.s.ledgerTotal.interest).toBe(-Math.floor((1000000 * 800) / 10000 / 4));
  });

  it('a high gate fee with nothing to do slows arrivals', () => {
    const cheap = starter(5), dear = starter(5);
    dear.run('park.fee', { fee: 30 });
    cheap.advanceTo(TICKS_PER_DAY * 3);
    dear.advanceTo(TICKS_PER_DAY * 3);
    expect(dear.s.totalVisitors).toBeLessThan(cheap.s.totalVisitors);
  });
});

describe('review regressions', () => {
  it('rejects non-integer or off-map numbers so the log always replays', () => {
    const p = Park.create(c, 'sandbox', 1);
    const cash = p.s.cash;
    for (const [t, q] of [
      ['ride.build', { type: 'carousel', x: 10, y: 10, rot: 'x' }],
      ['marketing.start', { kind: 'billboard', weeks: 'x' }],
      ['marketing.start', { kind: 'flyers', weeks: 2.5 }],
      ['path.place', { x: 3.5, y: 4 }],
      ['path.place', { x: 0, y: 0, x2: 1e9, y2: 1e9 }],
    ] as const) expect(p.run(t, q as Record<string, unknown>).ok).toBe(false);
    expect(p.s.cash).toBe(cash);
    expect(p.log).toHaveLength(0);
  });

  it('lets riders off (refunded) when a ride breaks mid-cycle', () => {
    const p = starter();
    p.advanceTo(TICKS_PER_DAY);
    const r = p.s.rides.find((x) => x.riders.length > 0) ?? findRide(p.s, 'whirl swings')!;
    while (r.riders.length === 0) p.tick();
    const riders = [...r.riders];
    breakDown(p.s, c, r);
    expect(r.riders).toHaveLength(0);
    for (const id of riders) expect(p.s.visitors.find((v) => v.id === id)?.mode).toBe('walking');
  });

  it('charges wages daily, so firing before payday saves nothing', () => {
    const p = starter();
    p.run('staff.hire', { role: 'mechanic' });
    p.advanceTo(TICKS_PER_DAY * 6);
    p.run('staff.fire', { staff: 'mechanic 1' });
    expect(p.s.ledgerTotal.wages).toBe(-6 * Math.round(16000 / 7));
  });

  it('shows weekly costs in the weekly ledger', () => {
    const p = starter();
    p.run('staff.hire', { role: 'handyman' });
    p.advanceTo(TICKS_PER_DAY * 3);
    expect(p.s.ledgerWeek.wages).toBe(-3 * Math.round(10000 / 7));
    expect(p.s.ledgerWeek.upkeep).toBeLessThan(0);
  });

  it('never matches a ride by an empty name', () => {
    const p = starter();
    expect(findRide(p.s, '')).toBeUndefined();
    expect(p.run('ride.demolish', { ride: '  ' }).ok).toBe(false);
  });

  it('refunds half of what was actually paid', () => {
    const p = Park.create(c, 'sandbox', 1);
    p.hooks.push({ mod: 'free', query: (_x, type) => (type === 'ride.build' ? 0 : undefined) });
    p.run('ride.build', { type: 'droptower', x: 10, y: 10 });
    const cash = p.s.cash;
    p.run('ride.demolish', { ride: 'plummet' });
    expect(p.s.cash).toBe(cash);
  });

  it('replays with the same mod hooks', () => {
    const hook = { mod: 'cheap', query: (_x: unknown, type: string, _p: unknown, res: { cost: number }) => (type === 'path.place' ? res.cost / 2 : undefined) };
    const p = Park.create(c, 'meadow', 9);
    p.hooks.push(hook as never);
    p.run('path.place', { x: 24, y: 30, x2: 24, y2: 39 });
    p.advanceTo(400);
    expect(Park.replay(c, 'meadow', 9, p.log, p.s.tick, 'My Park', [hook as never]).hash()).toBe(p.hash());
  });

  it('keeps an entrance that sits on a path', () => {
    const p = starter();
    // the pretzel cart faces (24,36), a path tile
    expect(p.run('path.remove', { x: 24, y: 36 }).ok).toBe(false);
  });
});
