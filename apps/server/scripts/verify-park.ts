// pnpm verify <parkId> [host]
//
// Check a published park yourself, without trusting the game server's own verdict:
//   1. download the park's public save from the host (seed, scenario, mods, complete action log, snapshot);
//   2. replay it here with @parkwright/sim on the park's own rules version and compare SHA-256 of the state;
//   3. read the park from the NEAR contract over public RPC (not through the host) and compare each day's
//      settled credits with what the replay says the patron agents should have paid.
// Exit 0 when the replay matches and the chain agrees; 1 otherwise; 2 on a usage or network error.
import { createHash } from 'node:crypto';
import { rulesOf, type ParkState } from '@parkwright/sim';
import { auditChain, type ChainPark } from '../src/audit.ts';
import { verifySave } from '../src/verify.ts';

const [id, hostArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const host = (hostArg ?? process.env.PARKWRIGHT_URL ?? 'https://parkwright.lopeselio.online').replace(/\/+$/, '');
const CONTRACT = process.env.PARK_CONTRACT_ID ?? 'park.parkwright.testnet';
// Public testnet RPCs, tried in turn. rpc.testnet.near.org is deprecated (-429) and FastNEAR rate-limits hard.
const RPCS = (process.env.NEAR_RPC ? [process.env.NEAR_RPC] : []).concat(['https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com']);

if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
  console.error('usage: pnpm verify <parkId> [host]   (host defaults to https://parkwright.lopeselio.online)');
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cr = (units: number) => `${(units / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CR`;

async function getJson(url: string): Promise<{ status: number; body: any }> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429 && i < 4) { await sleep(1000 * 2 ** i); continue; }
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

/** A contract view over public RPC, falling back across endpoints and backing off on 429s. */
async function view<T>(method: string, args: object): Promise<{ value: T; rpc: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'pw', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } });
  let last = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const rpc = RPCS[attempt % RPCS.length];
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
      const j = (await r.json().catch(() => null)) as any;
      const limited = r.status === 429 || j?.error?.code === -429 || /429|rate|limit|deprecated/i.test(JSON.stringify(j?.error ?? ''));
      if (!limited && j?.result?.result) return { value: JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T, rpc };
      if (!limited && j?.result?.error) throw Object.assign(new Error(`${method}: ${j.result.error}`), { fatal: true });
      last = `${rpc}: ${r.status} ${JSON.stringify(j?.error ?? j).slice(0, 160)}`;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      last = `${rpc}: ${(e as Error).message}`;
    }
    await sleep(Math.min(8000, 500 * 2 ** Math.floor(attempt / RPCS.length)));
  }
  throw new Error(`every RPC failed (last: ${last}); set NEAR_RPC to another testnet endpoint`);
}

async function main() {
  console.log(`Parkwright park ${id}\n  host      ${host}\n  contract  ${CONTRACT} (testnet)\n`);

  // 1. The public save.
  const doc = await getJson(`${host}/api/parks/${id}?fresh`);
  if (doc.status !== 200 || !doc.body?.save) { console.error(`could not fetch the save: HTTP ${doc.status} ${JSON.stringify(doc.body)}`); process.exit(2); }
  const save = doc.body.save;
  const s = save.snapshot as ParkState;
  console.log(`save      "${doc.body.name}", version ${doc.body.version}, rules v${rulesOf(s)}, scenario ${s.scenario}, seed ${s.seed}`);
  console.log(`          ${save.log?.length ?? 0} actions, tick ${s.tick} (day ${s.day + 1}), ${s.rides?.length ?? 0} venues, ${s.visitors?.length ?? 0} visitors, sha256 ${createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16)}…`);

  // 2. Replay it here.
  const v = verifySave(save);
  console.log(`\nreplay    ${v.ok ? 'MATCH' : 'FAILED'}: ${v.reason} (${v.ms} ms, locally with @parkwright/sim)`);
  if (v.replayed) console.log(`          replayed rating ${(v.replayed.rating / 100).toFixed(2)}, ${v.replayed.visitors} visitors, ${v.replayed.history.length} finished days`);
  const hostVerdict = await getJson(`${host}/api/parks/${id}/verify`).catch(() => null);
  if (hostVerdict?.body) console.log(`          the host says: verified ${hostVerdict.body.verified} (${hostVerdict.body.reason})`);
  if (!v.ok || !v.replayed) process.exit(1);

  // 3. The chain, read directly.
  const { value: park, rpc } = await view<ChainPark | null>('get_park', { park_id: id });
  if (!park) { console.log(`\nchain     not registered on ${CONTRACT} yet (the server registers a park when it is first published)`); process.exit(1); }
  console.log(`\nchain     get_park via ${rpc}`);
  console.log(`          owner ${park.owner}${park.owner === 'parkwright.testnet' ? ' (unclaimed: the game server holds it until a player claims it)' : ''}, escrow ${cr(Number(park.balance))}, earned ${cr(Number(park.earned))}, ${park.settlements} settlements`);
  const a = auditChain(v.replayed.history, park);
  console.log('\n  day   replay says      on chain   ');
  for (const r of a.days) console.log(`  ${String(r.day + 1).padStart(3)}  ${cr(r.expected).padStart(13)}  ${(r.onchain === null ? 'not settled yet' : cr(r.onchain)).padStart(13)}  ${r.ok === null ? '' : r.ok ? 'ok' : 'MISMATCH'}`);
  console.log(`\n  earned       replay ${cr(a.expectedEarned)}, chain ${cr(a.earned)}  ${a.earned === a.expectedEarned ? 'ok' : 'MISMATCH'}`);
  console.log(`  settlements  replay ${a.expectedSettlements}, chain ${a.settlements}  ${a.settlements === a.expectedSettlements ? 'ok' : 'MISMATCH'}  (one settle_day per visitor group per day)`);
  if (a.pending.length) console.log(`  pending      days ${a.pending.map((d) => d + 1).join(', ')} finished in the save but aren't settled yet (the server settles a park's finished days after it is saved, every 20 s or so)`);
  console.log(`\n${a.ok ? 'VERIFIED' : 'NOT VERIFIED'}: ${a.ok ? 'the save replays exactly and every settled day matches the replay' : 'the chain disagrees with the replay (see above)'}`);
  console.log(`  contract  https://testnet.nearblocks.io/address/${CONTRACT}`);
  process.exit(a.ok ? 0 : 1);
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exit(2); });
