import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, RULES, rulesOf, stateHash, TICKS_PER_DAY, type ActionRecord } from '../src/index.ts';
import midV1 from './fixtures/v1-mid.json';
import bigV1 from './fixtures/v1-big.json';

interface Fixture { scenario: string; seed: number; name: string; tick: number; hash: string; visitors: number; cash: number; log: ActionRecord[] }

// Published parks are verified by replaying their action log. These logs were recorded with the
// original (v1) rules; replaying them must reproduce the recorded state exactly, whatever later
// rules versions change.
describe('v1 parks replay exactly as recorded', () => {
  for (const [label, fx] of [['mid meadow park, 12 days', midV1], ['big sandbox park, 4 days', bigV1]] as [string, Fixture][]) {
    it(label, () => {
      const p = Park.replay(c, fx.scenario, fx.seed, fx.log, fx.tick, fx.name, [], 1);
      expect(p.s.visitors.length).toBe(fx.visitors);
      expect(p.s.cash).toBe(fx.cash);
      expect(stateHash(p.s)).toBe(fx.hash);
    });
  }
});

describe('rules versions', () => {
  it('new parks start on the latest rules; v1 parks carry no rules field', () => {
    const now = Park.create(c, 'meadow', 1);
    expect(now.s.rules).toBe(RULES);
    expect(rulesOf(now.s)).toBe(RULES);
    const old = Park.create(c, 'meadow', 1, 'Old', 1);
    expect('rules' in old.s).toBe(false);
    expect(rulesOf(old.s)).toBe(1);
    expect(() => Park.create(c, 'meadow', 1, 'Future', RULES + 1)).toThrow(/rules version/);
  });

  it('replay carries the version, and the wrong version does not reproduce a park', () => {
    for (const rules of [1, RULES]) {
      const p = Park.create(c, 'meadow', 5, 'V', rules);
      p.run('path.place', { x: 24, y: 30, x2: 24, y2: 39 });
      p.run('ride.build', { type: 'carousel', x: 20, y: 30, rot: 1 });
      p.advanceTo(TICKS_PER_DAY * 2);
      const again = Park.replay(c, 'meadow', 5, p.log, p.s.tick, 'V', [], rulesOf(p.s));
      expect(rulesOf(again.s)).toBe(rules);
      expect(again.hash()).toBe(p.hash());
    }
    const fx = midV1 as Fixture;
    expect(Park.replay(c, fx.scenario, fx.seed, fx.log, fx.tick, fx.name).hash()).not.toBe(fx.hash);
  });
});
