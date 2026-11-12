// Audit a park against the chain: what the replay says each day should have settled, next to what
// the contract recorded. Pure, so `pnpm verify` and the tests share it.
import { settlementLines } from '@parkwright/chain';
import type { DayStats } from '@parkwright/sim';

export interface ChainPark { owner: string; name: string; balance: string; earned: string; settlements: number; created_ms: number; recent_days: [number, string][] }

export interface DayRow { day: number; expected: number; onchain: number | null; ok: boolean | null }

export interface Audit {
  /** One row per finished day the contract still keeps (its ring of recent days), plus finished days it hasn't seen yet. */
  days: DayRow[];
  /** Days through the last one the contract has settled. */
  expectedEarned: number;
  earned: number;
  expectedSettlements: number;
  settlements: number;
  /** Finished days with spend that the chain hasn't settled yet (the server settles on its own schedule). */
  pending: number[];
  ok: boolean;
}

/** What the patron agents settle for one day: each group's spend, capped and scaled exactly as the server's agents do. */
export function settledFor(d: Pick<DayStats, 'spend'>): { total: number; groups: number } {
  let total = 0, groups = 0;
  for (const [g, spend] of Object.entries(d.spend ?? {})) {
    const n = Number(g);
    if (!Number.isInteger(n) || n < 0 || n > 7) continue;
    const lines = settlementLines(spend);
    if (!lines.length) continue;
    groups++;
    total += lines.reduce((a, l) => a + Number(l.amount), 0);
  }
  return { total, groups };
}

export function auditChain(history: Pick<DayStats, 'day' | 'spend'>[], park: ChainPark): Audit {
  const chainDays = new Map(park.recent_days.map(([d, amt]) => [d, Number(amt)]));
  const lastChainDay = park.recent_days.length ? Math.max(...park.recent_days.map(([d]) => d)) : -1;
  const ringFrom = park.recent_days.length ? Math.min(...park.recent_days.map(([d]) => d)) : Infinity;
  const days: DayRow[] = [];
  const pending: number[] = [];
  let expectedEarned = 0, expectedSettlements = 0;
  for (const d of [...history].sort((a, b) => a.day - b.day)) {
    const { total, groups } = settledFor(d);
    if (d.day <= lastChainDay) { expectedEarned += total; expectedSettlements += groups; }
    else if (total > 0) pending.push(d.day);
    if (d.day >= ringFrom) {
      const onchain = d.day <= lastChainDay ? (chainDays.get(d.day) ?? 0) : null;
      days.push({ day: d.day, expected: total, onchain, ok: onchain === null ? null : onchain === total });
    }
  }
  // A day the chain paid that the replay never finished is a mismatch too.
  const seen = new Set(history.map((d) => d.day));
  for (const [d, amt] of chainDays) if (!seen.has(d)) days.push({ day: d, expected: 0, onchain: amt, ok: amt === 0 });
  days.sort((a, b) => a.day - b.day);
  const earned = Number(park.earned);
  const ok = days.every((r) => r.ok !== false) && earned === expectedEarned && park.settlements === expectedSettlements;
  return { days, expectedEarned, earned, expectedSettlements, settlements: park.settlements, pending, ok };
}
