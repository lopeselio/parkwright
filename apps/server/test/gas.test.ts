import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { gasReport } from '@parkwright/chain/gas';
import { createApp } from '../src/app.ts';
import { Layered, MemoryCache } from '../src/cache.ts';
import { GasWatch } from '../src/gas.ts';
import { FileStore } from '../src/store.ts';

/** A mocked RPC fetch: view_account answers from `balances` (yocto strings), counting requests. */
function mockRpc(balances: Record<string, string>) {
  const counter = { n: 0 };
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    counter.n++;
    const { params } = JSON.parse(String(init!.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'gas', result: { amount: balances[params.account_id] ?? '0', locked: '0' } }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, counter };
}
const accounts = ['parkwright.testnet', 'g0.parkwright.testnet', 'g1.parkwright.testnet'];
const NEAR = (n: number) => (BigInt(Math.round(n * 1e4)) * 10n ** 20n).toString();

describe('GasWatch', () => {
  it('lists low accounts and caches the result for the TTL', async () => {
    const rpc = mockRpc({ 'parkwright.testnet': NEAR(3), 'g0.parkwright.testnet': NEAR(0.05), 'g1.parkwright.testnet': NEAR(0.3) });
    let t = 1_000;
    const watch = new GasWatch(() => gasReport({ accounts, fetch: rpc.fetch }), 600_000, 3_000, () => t);
    expect(await watch.status()).toEqual({ low: [{ account: 'g0.parkwright.testnet', near: '0.0500' }], unread: [], checkedAt: 1_000 });
    expect(rpc.counter.n).toBe(3);
    t += 599_999;
    await watch.status();
    expect(rpc.counter.n).toBe(3); // still cached
    t += 1;
    await watch.status();
    expect(rpc.counter.n).toBe(6); // 10 minutes on: read again
  });

  it("answers with the last result instead of waiting on a slow RPC", async () => {
    let t = 0;
    let release!: () => void;
    let slow = false;
    const watch = new GasWatch(async () => {
      if (slow) await new Promise<void>((r) => { release = r; });
      return { low: [{ account: 'g3.parkwright.testnet', near: '0.0100' }], errors: [] };
    }, 1_000, 20, () => t);
    const first = await watch.status();
    slow = true;
    t = 5_000;
    expect(await watch.status()).toBe(first); // stale but immediate
    release();
  });

  it('keeps the last list when a read fails', async () => {
    let fail = false;
    let t = 0;
    const watch = new GasWatch(async () => { if (fail) throw new Error('rpc down'); return { low: [{ account: 'g1.parkwright.testnet', near: '0.0200' }], errors: [{ account: 'g2.parkwright.testnet' }] }; }, 10, 1_000, () => t);
    expect((await watch.status()).unread).toEqual(['g2.parkwright.testnet']);
    fail = true;
    t = 100;
    expect(await watch.status()).toMatchObject({ low: [{ account: 'g1.parkwright.testnet' }], error: 'rpc down' });
  });
});

describe('/api/health gas', () => {
  let server: ReturnType<typeof createApp> | undefined;
  afterEach(() => server?.close());
  const health = async (gas?: GasWatch) => {
    const cache = new MemoryCache();
    server = createApp({ store: new FileStore('/tmp/pw-gas-unused'), cache, docs: new Layered(cache), gas }, { webDist: '/tmp', version: 't' });
    await new Promise<void>((r) => server!.listen(0, r));
    return (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`)).json() as Promise<any>;
  };

  it('reports low signers when the server has a gas watch (settlement on)', async () => {
    const rpc = mockRpc({ 'parkwright.testnet': NEAR(0.01), 'g0.parkwright.testnet': NEAR(1), 'g1.parkwright.testnet': NEAR(1) });
    const body = await health(new GasWatch(() => gasReport({ accounts, fetch: rpc.fetch })));
    expect(body.ok).toBe(true);
    expect(body.gas.low).toEqual([{ account: 'parkwright.testnet', near: '0.0100' }]);
  });

  it('has no gas field without one', async () => {
    expect((await health()).gas).toBeUndefined();
  });
});
