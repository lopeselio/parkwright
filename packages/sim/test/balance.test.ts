// Balance invariants for the current rules, on the reference parks the balance harness uses
// (scripts/balance.ts). They are built and grown only through `pw` commands.
import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, RULES, rulesOf, TICKS_PER_DAY, type DayStats } from '../src/index.ts';
import { mid, starter } from '../scripts/parks.ts';

/** The contract refuses more than 5,000 CR of visitor spend per park-day (contracts/park). */
const PARK_DAY_CAP = 500_000;

const spendOf = (d: DayStats) => Object.values(d.spend).flatMap((g) => Object.values(g)).reduce((a, b) => a + b, 0);

function play(ref: ReturnType<typeof mid>, days: number) {
  const p = ref.park, out: { day: DayStats; cash: number }[] = [];
  for (let d = 1; d <= days; d++) {
    p.advanceTo(d * TICKS_PER_DAY);
    ref.manage();
    out.push({ day: p.s.history[p.s.history.length - 1], cash: p.s.cash });
  }
  return out;
}

describe(`balance (rules v${RULES})`, () => {
  const ref = mid({ seed: 1 });
  const days = play(ref, 28);
  const visitors = days.map((d) => d.day.visitors);

  it('a good mid-sized park grows to 800+ visitors over a few weeks, not in a day', () => {
    expect(rulesOf(ref.park.s)).toBe(RULES);
    expect(visitors[2]).toBeLessThan(800);
    expect(Math.max(...visitors.slice(0, 21))).toBeGreaterThanOrEqual(800);
    expect(Math.max(...visitors)).toBeLessThanOrEqual(1600);
    expect(days[days.length - 1].day.rating).toBeGreaterThanOrEqual(450);
  });

  it('money stays finite and positive, and profit is a margin, not a runaway', () => {
    for (const d of days) {
      expect(Number.isFinite(d.cash)).toBe(true);
      expect(Number.isInteger(d.cash)).toBe(true);
      expect(d.cash).toBeGreaterThan(0);
    }
    const week = days.slice(-7).map((d) => d.day);
    const income = week.reduce((a, d) => a + d.income, 0), costs = week.reduce((a, d) => a + d.costs, 0);
    expect(costs).toBeGreaterThan(income * 0.3);
    expect(income - costs).toBeGreaterThan(0);
  });

  it("a day's visitor spend stays under the contract's per-park-day cap", () => {
    for (const d of days) expect(spendOf(d.day)).toBeLessThanOrEqual(PARK_DAY_CAP);
  });

  it('replays exactly from its action log', () => {
    const p = ref.park;
    expect(Park.replay(c, p.s.scenario, 1, p.log, p.s.tick, p.s.name, [], rulesOf(p.s)).hash()).toBe(p.hash());
  });

  it('a neglected small park winds down slowly instead of collapsing at once', () => {
    const small = play(starter({ seed: 1 }), 14);
    for (const d of small) expect(d.cash).toBeGreaterThan(0);
    expect(Math.min(...small.slice(0, 7).map((d) => d.day.visitors))).toBeGreaterThan(20);
  });
});

describe('goals follow the rules version', () => {
  it('v1 meadow parks keep the 120-visitor goal; v2 parks aim for 1,000', async () => {
    const { baseContent } = await import('@parkwright/content');
    const { Park, runCommand, objectiveOf, rulesOf } = await import('../src/index.ts');
    const v1 = Park.create(baseContent, 'meadow', 3, 'Old', 1);
    const v2 = Park.create(baseContent, 'meadow', 3, 'New');
    const sc = baseContent.scenarios.meadow;
    expect(objectiveOf(sc, rulesOf(v1.s))).toMatchObject({ count: 120, minRating: 600 });
    expect(objectiveOf(sc, rulesOf(v2.s))).toMatchObject({ count: 1000, minRating: 650 });
    expect(runCommand(v1, 'park').text).toMatch(/Goal: 120 visitors/);
    expect(runCommand(v2, 'park').text).toMatch(/Goal: 1,000 visitors/);
  });
});

describe('v2 settlement record fits the contract caps', () => {
  it('capSpend scales a day to ≤ 4,800 CR and every group to ≤ 950 CR, deterministically', async () => {
    const { capSpend, SETTLE_DAY_CAP, SETTLE_GROUP_CAP } = await import('../src/index.ts');
    const day: Record<string, Record<string, number>> = {};
    for (let g = 0; g < 8; g++) day[String(g)] = { gate: 90_000 + g * 7, '3': 61_234, '7': 10_001 };
    const copy = structuredClone(day);
    capSpend(day);
    capSpend(copy);
    expect(day).toEqual(copy);
    const groups = Object.values(day).map((g) => Object.values(g).reduce((a, b) => a + b, 0));
    expect(groups.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SETTLE_DAY_CAP);
    for (const t of groups) expect(t).toBeLessThanOrEqual(SETTLE_GROUP_CAP);
    const small = { '0': { gate: 1200 } };
    capSpend(small);
    expect(small).toEqual({ '0': { gate: 1200 } });
  });

  it('a mid park at top prices never records more than the caps on any day', async () => {
    const { mid } = await import('../scripts/parks.ts');
    const { runCommand, SETTLE_DAY_CAP, SETTLE_GROUP_CAP } = await import('../src/index.ts');
    const ref = mid({ seed: 4 });
    const p = ref.park;
    for (const r of p.s.rides) runCommand(p, `ride price ${r.id} 50`);
    runCommand(p, 'park fee 40');
    for (let d = 1; d <= 21; d++) {
      p.advanceTo(d * TICKS_PER_DAY);
      ref.manage();
    }
    for (const h of p.s.history) {
      const groups = Object.values(h.spend).map((g) => Object.values(g).reduce((a, b) => a + b, 0));
      expect(groups.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SETTLE_DAY_CAP);
      for (const t of groups) expect(t).toBeLessThanOrEqual(SETTLE_GROUP_CAP);
    }
  }, 120_000);

  it('a save claiming an unknown rules version is refused on load', async () => {
    const { Park } = await import('../src/index.ts');
    const s = Park.create(c, 'meadow', 2).snapshot();
    for (const bad of [3, 0, '2', 1.5, null]) expect(() => new Park({ ...structuredClone(s), rules: bad as never }, c)).toThrow(/rules/);
    expect(() => new Park(structuredClone(s), c)).not.toThrow();
  });
});
