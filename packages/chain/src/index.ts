// NEAR side of Parkwright: config, read-only views, and the calls the game server makes.
// The contract enforces the money rules; this package only builds and signs the calls.
import { Near } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';

export const NETWORK = (process.env.NEAR_NETWORK ?? 'testnet') as 'testnet';
export const RPC = process.env.NEAR_RPC ?? 'https://rpc.testnet.fastnear.com';
export const CONTRACT = process.env.PARK_CONTRACT_ID ?? 'park.parkwright.testnet';
export const ADMIN = process.env.PARK_ADMIN_ID ?? 'parkwright.testnet';
/** One patron agent per visitor group in the sim (visitors.ts PATRON_GROUPS). */
export const PATRON_GROUPS = 8;
export const patronAccount = (group: number) => `p${group}.${ADMIN}`;
export const PATRONS = Array.from({ length: PATRON_GROUPS }, (_, g) => patronAccount(g));

/** Most a patron may settle into one park for one day, in credit units (cents). */
export const DAY_CAP = 100_000; // 1,000 credits
/** Budget top-up per funding round. */
export const TOP_UP = 2_000_000; // 20,000 credits
/** Top up a patron when its budget falls below this. */
export const LOW_WATER = 500_000;

export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

export async function view<T>(method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const body = (await res.json()) as any;
  if (body.error || body.result?.error) throw new Error(`view ${method}: ${JSON.stringify(body.error ?? body.result.error).slice(0, 300)}`);
  return JSON.parse(Buffer.from(body.result.result).toString('utf8')) as T;
}

export interface SettleLine { venue: string; amount: string }

/**
 * Turn one patron group's spend for one day into settlement lines.
 * Venues are the sim's ids ("gate", "r12"). Amounts are integer cents. If the day's total is over the
 * patron's daily cap, the agent pays at most the cap, scaled down evenly across venues (its own policy;
 * the contract would refuse anything over the cap anyway). Returns [] when there's nothing to pay.
 */
export function settlementLines(spend: Record<string, number> | undefined, cap = DAY_CAP): SettleLine[] {
  if (!spend) return [];
  const entries = Object.entries(spend)
    .filter(([venue, amt]) => /^[A-Za-z0-9_-]{1,24}$/.test(venue) && Number.isInteger(amt) && amt > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = entries.reduce((s, [, a]) => s + a, 0);
  if (total === 0) return [];
  const scale = total > cap ? cap / total : 1;
  const lines = entries.map(([venue, amt]) => ({ venue, amount: Math.floor(amt * scale) })).filter((l) => l.amount > 0).slice(0, 40);
  return lines.map((l) => ({ venue: l.venue, amount: String(l.amount) }));
}

type Signer = { privateKey?: string };

function nearFor(account: string, s: Signer) {
  return new Near({
    network: NETWORK,
    rpcUrl: RPC,
    defaultSignerId: account,
    ...(s.privateKey ? { privateKey: s.privateKey as `ed25519:${string}` } : { keyStore: new FileKeyStore('~/.near-credentials', NETWORK) }),
  });
}

async function call(near: Near, signer: string, method: string, args: object, deposit?: `${bigint} yocto`) {
  const r = await near
    .transaction(signer)
    .functionCall(CONTRACT, method, args, { gas: '50 Tgas', ...(deposit ? { attachedDeposit: deposit } : {}) })
    .send({ waitUntil: 'EXECUTED_OPTIMISTIC' });
  return r.transaction.hash as string;
}

/** The game server acting as admin (with a function-call key limited to admin methods). */
export function adminClient(s: Signer = {}) {
  const near = nearFor(ADMIN, s);
  return {
    registerPark: (parkId: string, name: string, owner?: string) => call(near, ADMIN, 'register_park', { park_id: parkId, name, owner: owner ?? null }),
    setPatron: (patron: string, dayCap: number, active = true) => call(near, ADMIN, 'set_patron', { patron, day_cap: String(dayCap), active }),
    fundPatrons: (patrons: string[], amount: number) => call(near, ADMIN, 'fund_patrons', { patrons, amount: String(amount) }),
  };
}

/** A patron agent, signing its own settlements with a key that can only call settle_day. */
export function patronClient(account: string, s: Signer = {}) {
  const near = nearFor(account, s);
  return {
    settleDay: (parkId: string, day: number, lines: SettleLine[], stateHash: string) =>
      call(near, account, 'settle_day', { park_id: parkId, day, lines, state_hash: stateHash }),
  };
}

export interface ParkOnChain { owner: string; name: string; balance: string; earned: string; settlements: number; created_ms: number }
export interface PatronOnChain { account: string; balance: string; day_cap: string; spent: string; active: boolean }

export const getPark = (parkId: string) => view<ParkOnChain | null>('get_park', { park_id: parkId });
export const getPatron = (account: string) => view<PatronOnChain | null>('get_patron', { account_id: account });
export const lastSettledDay = (patron: string, parkId: string) => view<number | null>('last_settled_day', { patron, park_id: parkId });
