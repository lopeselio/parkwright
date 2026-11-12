import { describe, expect, it } from 'vitest';
import { auditChain, settledFor, type ChainPark } from '../src/audit.ts';

const history: { day: number; spend: Record<string, Record<string, number>> }[] = [
  { day: 0, spend: { '0': { gate: 1000, r1: 500 }, '3': { gate: 200 } } },
  { day: 1, spend: { '1': { gate: 150_000 } } }, // over a patron's 1,000 CR day cap: the agent pays the cap
  { day: 2, spend: {} },
  { day: 3, spend: { '2': { r4: 700 } } },
];
const park = (recent: [number, string][], earned: number, settlements: number): ChainPark =>
  ({ owner: 'parkwright.testnet', name: 'T', balance: String(earned), earned: String(earned), settlements, created_ms: 0, recent_days: recent });

describe('auditChain', () => {
  it('settles each group as the agents do (capped per patron)', () => {
    expect(settledFor(history[0])).toEqual({ total: 1700, groups: 2 });
    expect(settledFor(history[1])).toEqual({ total: 100_000, groups: 1 });
  });

  it('agrees with a chain that settled exactly the replay, and lists the days still to settle', () => {
    const a = auditChain(history, park([[0, '1700'], [1, '100000']], 101_700, 3));
    expect(a.ok).toBe(true);
    expect(a.pending).toEqual([3]);
    expect(a.days.map((d) => d.ok)).toEqual([true, true, null, null]);
  });

  it('flags a day the chain paid differently, extra settlements, or a day the replay never had', () => {
    expect(auditChain(history, park([[0, '1800'], [1, '100000']], 101_800, 3)).ok).toBe(false);
    expect(auditChain(history, park([[0, '1700'], [1, '100000']], 101_700, 4)).ok).toBe(false);
    const extra = auditChain(history, park([[0, '1700'], [9, '50']], 1750, 3));
    expect(extra.ok).toBe(false);
    expect(extra.days.find((d) => d.day === 9)).toMatchObject({ expected: 0, onchain: 50, ok: false });
  });
});
