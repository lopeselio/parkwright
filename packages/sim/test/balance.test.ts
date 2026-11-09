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
