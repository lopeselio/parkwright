import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseContent } from '@parkwright/content';
import { Park, TICKS_PER_DAY } from '@parkwright/sim';
import { settlementLines } from '@parkwright/chain';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/cache.ts';
import { Settler, type ChainApi } from '../src/settle.ts';
import { FileStore, type ParkDoc } from '../src/store.ts';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

function fakeChain() {
  const settled = new Set<string>();
  const calls: string[] = [];
  const balances = new Array(8).fill(1_000_000n);
  const api: ChainApi = {
    registerPark: async (id) => { calls.push(`register ${id}`); return 'tx-r'; },
    settleDay: async (g, id, day, lines) => {
      const k = `${g}|${id}|${day}`;
      if (settled.has(k)) throw new Error('Smart contract panicked: that day is already settled');
      settled.add(k);
      balances[g] -= lines.reduce((s, l) => s + BigInt(l.amount), 0n);
      calls.push(`settle ${k}`);
      return `tx-${k}`;
    },
    patronBalance: async (g) => balances[g],
    topUp: async (gs) => { for (const g of gs) balances[g] += 2_000_000n; calls.push(`topup ${gs.join(',')}`); return 'tx-t'; },
    lines: (spend) => settlementLines(spend),
    lowWater: 500_000n,
  };
  return { api, settled, calls, balances };
}

async function parkWithDays(days: number) {
  const p = Park.create(baseContent, 'meadow', 3, 'Chain Park');
  p.run('path.place', { x: 24, y: 30, x2: 24, y2: 40 });
  p.run('ride.build', { type: 'carousel', x: 20, y: 30, rot: 2 });
  p.run('ride.open', { ride: 'carousel' });
  p.run('path.place', { x: 21, y: 34, x2: 23, y2: 34 });
  p.advanceTo(TICKS_PER_DAY * days + 50);
  const dir = await mkdtemp(join(tmpdir(), 'pw-settle-'));
  dirs.push(dir);
  const store = new FileStore(dir);
  const doc: ParkDoc = { id: 'chainpark1', name: 'Chain Park', ownerHash: 'x', rating: 0, value: 0, visitors: 0, day: p.s.day, scenario: 'meadow', save: { v: 1, snapshot: p.snapshot(), log: [] }, createdAt: 0, updatedAt: 0, version: 1 };
  await store.create(doc);
  return { store, park: p };
}

describe('settlement worker', () => {
  it('settles each finished day once per visitor group, never the day in progress', async () => {
    const { store, park } = await parkWithDays(3);
    const chain = fakeChain();
    const cache = new MemoryCache();
    const s = new Settler(chain.api, store, cache);
    await s.markDirty('chainpark1');
    const n = await s.tick();
    expect(n).toBeGreaterThan(0);
    const days = new Set([...chain.settled].map((k) => Number(k.split('|')[2])));
    expect([...days].sort()).toEqual([0, 1, 2]);
    expect(days.has(park.s.day)).toBe(false);
    // Amount settled equals what the sim recorded as spend (no cap hit at this size).
    const recorded = park.s.history.reduce((a, d) => a + Object.values(d.spend).flatMap((g) => Object.values(g)).reduce((x, y) => x + y, 0), 0);
    const paid = chain.balances.reduce((a, b) => a + (1_000_000n - b), 0n);
    expect(Number(paid)).toBe(recorded);
    // A second pass (still dirty after a re-sync) settles nothing new.
    await s.markDirty('chainpark1');
    expect(await s.tick()).toBe(0);
  });

  it('treats "already settled" as done (at-least-once retries are safe)', async () => {
    const { store } = await parkWithDays(2);
    const chain = fakeChain();
    const s1 = new Settler(chain.api, store, new MemoryCache());
    await s1.markDirty('chainpark1');
    await s1.tick();
    const before = chain.settled.size;
    // A fresh worker with no memory of what was done retries everything; the contract refuses duplicates.
    const s2 = new Settler(chain.api, store, new MemoryCache());
    await s2.markDirty('chainpark1');
    await s2.tick();
    expect(chain.settled.size).toBe(before);
    expect(s2.log.some((l) => l.includes('failed'))).toBe(false);
  });

  it('only one replica settles at a time', async () => {
    const { store } = await parkWithDays(1);
    const cache = new MemoryCache();
    const s = new Settler(fakeChain().api, store, cache);
    expect(await cache.lock('lock:settle', 60)).toBe(true);
    await s.markDirty('chainpark1');
    expect(await s.tick()).toBe(0);
  });

  it('tops up patrons that run low', async () => {
    const { store } = await parkWithDays(2);
    const chain = fakeChain();
    chain.balances[0] = 1000n;
    const s = new Settler(chain.api, store, new MemoryCache());
    await s.markDirty('chainpark1');
    await s.tick();
    expect(chain.calls.some((c) => c.startsWith('topup') && c.includes('0'))).toBe(true);
  });
});
