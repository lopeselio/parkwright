import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, stateHash, type ActionRecord } from '../src/index.ts';
import midV1 from './fixtures/v1-mid.json';
import bigV1 from './fixtures/v1-big.json';

interface Fixture { scenario: string; seed: number; name: string; tick: number; hash: string; visitors: number; cash: number; log: ActionRecord[] }

// Published parks are verified by replaying their action log. These logs were recorded with the
// original (v1) rules; replaying them must reproduce the recorded state exactly, whatever later
// rules versions change.
describe('v1 parks replay exactly as recorded', () => {
  for (const [label, fx] of [['mid meadow park, 12 days', midV1], ['big sandbox park, 4 days', bigV1]] as [string, Fixture][]) {
    it(label, () => {
      const p = Park.replay(c, fx.scenario, fx.seed, fx.log, fx.tick, fx.name);
      expect(p.s.visitors.length).toBe(fx.visitors);
      expect(p.s.cash).toBe(fx.cash);
      expect(stateHash(p.s)).toBe(fx.hash);
    });
  }
});
