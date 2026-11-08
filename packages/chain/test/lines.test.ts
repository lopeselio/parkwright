import { describe, expect, it } from 'vitest';
import { PATRONS, patronAccount, settlementLines } from '../src/index.ts';

describe('settlement lines', () => {
  it('turns a day of spend into sorted integer lines', () => {
    expect(settlementLines({ r12: 450, gate: 1000, r3: 120 })).toEqual([
      { venue: 'gate', amount: '1000' }, { venue: 'r12', amount: '450' }, { venue: 'r3', amount: '120' },
    ]);
  });

  it('pays at most the daily cap, scaled evenly', () => {
    const lines = settlementLines({ r1: 150_000, r2: 50_000 }, 100_000);
    expect(lines).toEqual([{ venue: 'r1', amount: '75000' }, { venue: 'r2', amount: '25000' }]);
    expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBeLessThanOrEqual(100_000);
  });

  it('drops junk the contract would refuse', () => {
    expect(settlementLines({ 'r1|x': 10, r2: -5, r3: 1.5, r4: 0 })).toEqual([]);
    expect(settlementLines(undefined)).toEqual([]);
  });

  it('names one patron per visitor group', () => {
    expect(PATRONS).toHaveLength(8);
    expect(patronAccount(3)).toBe('p3.parkwright.testnet');
  });
});
