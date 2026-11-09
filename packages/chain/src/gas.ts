// Gas watch: the patron agents and the server admin pay transaction gas from their own NEAR balance.
// This reads each balance with the public `view_account` RPC query (no keys needed) and flags the low ones.
import { ADMIN, PATRONS, RPC } from './index.ts';

const YOCTO = 10n ** 24n;
/** Alert below this many NEAR (GAS_MIN_NEAR overrides). */
export const GAS_MIN_NEAR = process.env.GAS_MIN_NEAR ?? '0.1';
/** Everyone who signs transactions: the admin, then patrons g0..g7. */
export const GAS_ACCOUNTS = [ADMIN, ...PATRONS];

/** "0.1" → 10^23 yocto. Exact decimal parsing, no floats. */
export function nearToYocto(near: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d{0,24}))?\s*$/.exec(near);
  if (!m) throw new Error(`not a NEAR amount: ${JSON.stringify(near)}`);
  return BigInt(m[1]) * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}

/** Yocto → NEAR with 4 decimals (rounded down), for display. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO;
  const frac = ((yocto % YOCTO) / 10n ** 20n).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}

export interface GasRow { account: string; yocto: bigint | null; near: string; low: boolean; error?: string }
export interface GasReport { threshold: string; rows: GasRow[]; low: GasRow[]; errors: GasRow[] }

type Fetch = typeof fetch;

/** An account's liquid balance in yoctoNEAR; 0 when the account doesn't exist. Throws on RPC/transport errors. */
export async function nearBalance(account: string, opts: { rpc?: string; fetch?: Fetch } = {}): Promise<bigint> {
  const res = await (opts.fetch ?? fetch)(opts.rpc ?? RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'gas', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (body?.error?.cause?.name === 'UNKNOWN_ACCOUNT') return 0n;
  if (!res.ok || !body || body.error || typeof body.result?.amount !== 'string') {
    throw new Error(`view_account ${account}: ${body?.error ? JSON.stringify(body.error).slice(0, 200) : `HTTP ${res.status}`}`);
  }
  return BigInt(body.result.amount);
}

/** Every account's balance against the threshold. RPC failures (after retries) are reported separately, never as "low". */
export async function gasReport(opts: { accounts?: string[]; minNear?: string; rpc?: string; fetch?: Fetch; tries?: number; retryMs?: number } = {}): Promise<GasReport> {
  const tries = opts.tries ?? 3, retryMs = opts.retryMs ?? 1000; // public RPCs drop the odd request
  const threshold = opts.minNear ?? GAS_MIN_NEAR;
  const min = nearToYocto(threshold);
  const rows = await Promise.all((opts.accounts ?? GAS_ACCOUNTS).map(async (account): Promise<GasRow> => {
    let error = '';
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryMs * attempt));
      try {
        const yocto = await nearBalance(account, opts);
        return { account, yocto, near: formatNear(yocto), low: yocto < min };
      } catch (e) { error = (e as Error).message; }
    }
    return { account, yocto: null, near: '?', low: false, error };
  }));
  return { threshold, rows, low: rows.filter((r) => r.low), errors: rows.filter((r) => r.error) };
}

/** A Markdown table (it reads fine in a terminal too). */
export function gasTable(r: GasReport): string {
  const lines = ['| account | NEAR | status |', '| --- | ---: | --- |'];
  for (const row of r.rows) lines.push(`| ${row.account} | ${row.near} | ${row.error ? `error: ${row.error}` : row.low ? `LOW (< ${r.threshold})` : 'ok'} |`);
  return lines.join('\n');
}
