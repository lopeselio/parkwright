import { describe, expect, it, vi } from 'vitest';
import { formatNear, GAS_ACCOUNTS, gasReport, gasTable, nearBalance, nearToYocto } from '../src/gas.ts';

const ok = (amount: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'gas', result: { amount, locked: '0', storage_usage: 228, code_hash: '1'.repeat(32), block_height: 1, block_hash: 'h' } }));
const unknown = (account: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'gas', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: account } }, code: -32000, message: 'Server error' } }));
/** A fake RPC: account → yocto amount, 'missing' or 'down'. Records each request body. */
function rpc(balances: Record<string, string>) {
  const calls: any[] = [];
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    calls.push(body);
    const b = balances[body.params.account_id];
    if (b === 'missing') return unknown(body.params.account_id);
    if (b === 'down' || b === undefined) throw new TypeError('fetch failed');
    return ok(b);
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

describe('NEAR amounts', () => {
  it('parses decimal NEAR exactly', () => {
    expect(nearToYocto('0.1')).toBe(10n ** 23n);
    expect(nearToYocto('2')).toBe(2n * 10n ** 24n);
    expect(nearToYocto('0.000000000000000000000001')).toBe(1n);
    expect(() => nearToYocto('-1')).toThrow();
    expect(() => nearToYocto('abc')).toThrow();
  });
  it('formats yocto as NEAR with 4 decimals', () => {
    expect(formatNear(3_272_312_345n * 10n ** 15n)).toBe('3.2723');
    expect(formatNear(0n)).toBe('0.0000');
  });
});

describe('nearBalance', () => {
  it('sends a view_account query and returns the liquid amount', async () => {
    const { fetch, calls } = rpc({ 'a.testnet': '300000000000000000000000' });
    expect(await nearBalance('a.testnet', { fetch, rpc: 'http://rpc' })).toBe(3n * 10n ** 23n);
    expect(calls[0]).toMatchObject({ jsonrpc: '2.0', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: 'a.testnet' } });
  });
  it('treats a missing account as zero', async () => {
    expect(await nearBalance('gone.testnet', rpc({ 'gone.testnet': 'missing' }))).toBe(0n);
  });
  it('throws on other RPC errors', async () => {
    const f = (async () => new Response(JSON.stringify({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }))) as unknown as typeof fetch;
    await expect(nearBalance('a.testnet', { fetch: f })).rejects.toThrow(/UNKNOWN_BLOCK/);
  });
});

describe('gasReport', () => {
  it('checks the admin and all eight patrons by default', () => {
    expect(GAS_ACCOUNTS).toEqual(['parkwright.testnet', ...Array.from({ length: 8 }, (_, g) => `g${g}.parkwright.testnet`)]);
  });
  it('flags accounts under the threshold, and reports RPC failures separately', async () => {
    const { fetch } = rpc({ 'rich.testnet': '5000000000000000000000000', 'poor.testnet': '99999999999999999999999', 'gone.testnet': 'missing', 'flaky.testnet': 'down' });
    const r = await gasReport({ accounts: ['rich.testnet', 'poor.testnet', 'gone.testnet', 'flaky.testnet'], minNear: '0.1', fetch, retryMs: 0 });
    expect(r.low.map((x) => x.account)).toEqual(['poor.testnet', 'gone.testnet']);
    expect(r.errors.map((x) => x.account)).toEqual(['flaky.testnet']);
    const table = gasTable(r);
    expect(table).toContain('| rich.testnet | 5.0000 | ok |');
    expect(table).toContain('| poor.testnet | 0.0999 | LOW (< 0.1) |');
    expect(table).toContain('| flaky.testnet | ? | error: fetch failed |');
  });
  it('retries a dropped request before giving up', async () => {
    let n = 0;
    const f = (async () => { if (n++ < 2) throw new TypeError('fetch failed'); return ok('1000000000000000000000000'); }) as unknown as typeof fetch;
    const r = await gasReport({ accounts: ['a.testnet'], fetch: f, retryMs: 0 });
    expect(n).toBe(3);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].near).toBe('1.0000');
  });
  it('uses an exact threshold: equal is fine', async () => {
    const r = await gasReport({ accounts: ['a.testnet'], minNear: '0.3', fetch: rpc({ 'a.testnet': '300000000000000000000000' }).fetch });
    expect(r.low).toEqual([]);
  });
});
