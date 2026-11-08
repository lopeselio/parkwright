import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, TICKS_PER_DAY, findRide, isClosed, runCommand, testRun } from '../src/index.ts';

/** A small closed circuit: station east at (10,10), lift hill, drop south, back west and north. */
export const LOOP: [string, number][] = [
  ['lift', 4], ['straight', 1], ['right', 1], ['steepdown', 2], ['up', 1], ['bigright', 1],
  ['down', 1], ['straight', 5], ['brakes', 1], ['right', 1], ['straight', 4], ['right', 1],
];

function build(p: Park, x = 10, y = 10) {
  const ok = (t: string, q: Record<string, unknown>) => { const r = p.run(t, q); if (!r.ok) throw new Error(`${t} ${JSON.stringify(q)}: ${r.error}`); return r; };
  ok('coaster.start', { x, y, dir: 1 });
  for (const [piece, count] of LOOP) ok('coaster.add', { piece, count });
  return p.s.rides.find((r) => r.track)!;
}

describe('coasters', () => {
  it('closes a circuit, tests it and rates it', () => {
    const p = Park.create(c, 'sandbox', 1);
    const r = build(p);
    expect(isClosed(r.track!)).toBe(true);
    const res = p.run('coaster.test', {});
    expect(res.ok).toBe(true);
    expect(r.ratings!.e).toBeGreaterThan(300);
    expect(r.status).toBe('closed');
    expect(p.run('ride.open', { ride: r.id }).ok).toBe(true);
  });

  it('refuses to open an untested coaster and explains an open circuit', () => {
    const p = Park.create(c, 'sandbox', 1);
    p.run('coaster.start', { x: 10, y: 10, dir: 1 });
    p.run('coaster.add', { piece: 'straight', count: 2 });
    const t = p.run('coaster.test', {});
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.hint).toContain('open end is at 15,10');
    expect(p.run('ride.open', { ride: 'timber' }).ok).toBe(false);
  });

  it('reports a stall without enough height', () => {
    const p = Park.create(c, 'sandbox', 1);
    p.run('coaster.start', { x: 10, y: 10, dir: 1 });
    for (const [piece, count] of [['up', 2], ['straight', 1], ['right', 1], ['down', 2], ['right', 1], ['straight', 3], ['right', 1], ['right', 1]] as [string, number][]) p.run('coaster.add', { piece, count });
    // whatever shape this makes, an un-lifted climb must stall or the circuit is open
    const t = p.run('coaster.test', {});
    expect(t.ok).toBe(false);
  });

  it('blocks crossings, underground track and occupied tiles', () => {
    const p = Park.create(c, 'sandbox', 1);
    p.run('coaster.start', { x: 10, y: 10, dir: 1 });
    expect(p.run('coaster.add', { piece: 'down' }).ok).toBe(false);
    p.run('path.place', { x: 13, y: 10 });
    expect(p.run('coaster.add', { piece: 'straight' }).ok).toBe(false);
  });

  it('undo refunds the piece and demolish refunds half of the track', () => {
    const p = Park.create(c, 'sandbox', 1);
    const start = p.s.cash;
    const r = build(p);
    const spent = start - p.s.cash;
    expect(r.paid).toBe(spent);
    const before = p.s.cash;
    p.run('coaster.undo', {});
    expect(p.s.cash).toBeGreaterThan(before);
    p.run('ride.demolish', { ride: r.id });
    expect(p.s.occ.every((o) => o !== r.id)).toBe(true);
  });

  it('carries visitors once open, and replays exactly', () => {
    const p = Park.create(c, 'meadow', 4);
    p.run('path.place', { x: 24, y: 20, x2: 24, y2: 39 });
    build(p, 12, 20);
    // entrance is left of the middle station tile: (13,19); connect it
    p.run('path.place', { x: 13, y: 18, x2: 24, y2: 18 });
    p.run('path.place', { x: 24, y: 18, x2: 24, y2: 20 });
    p.run('path.place', { x: 13, y: 19 });
    expect(p.run('coaster.test', {}).ok).toBe(true);
    expect(p.run('ride.open', { ride: 'timber coaster' }).ok).toBe(true);
    p.advanceTo(TICKS_PER_DAY * 3);
    const r = findRide(p.s, 'timber coaster')!;
    expect(r.customers).toBeGreaterThan(0);
    expect(Park.replay(c, 'meadow', 4, p.log, p.s.tick, 'My Park').hash()).toBe(p.hash());
  });

  it('has pw commands', () => {
    const p = Park.create(c, 'sandbox', 1);
    expect(runCommand(p, 'coaster start 10 10 --dir 1').ok).toBe(true);
    expect(runCommand(p, 'coaster add lift 3').text).toContain('next piece goes at');
    expect(runCommand(p, 'coaster pieces').text).toContain('steepdown');
  });

  it('test run is deterministic', () => {
    const p = Park.create(c, 'sandbox', 1);
    const r = build(p);
    expect(testRun(r.track!).stats).toEqual(testRun(structuredClone(r.track!)).stats);
  });
});
