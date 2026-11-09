import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseContent } from '@parkwright/content';
import { Park, runCommand, TICKS_PER_DAY } from '@parkwright/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { Layered, MemoryCache } from '../src/cache.ts';
import type { ClaimChain } from '../src/claim.ts';
import { FileStore } from '../src/store.ts';
import { Verifier } from '../src/verify.ts';

function save(seed: number) {
  const p = Park.create(baseContent, 'meadow', seed, 'Claimable');
  runCommand(p, 'ride place carousel');
  p.advanceTo(TICKS_PER_DAY + 10);
  return { v: 1, snapshot: p.snapshot(), log: p.log, savedAt: 0, fullLog: true };
}

const owners = new Map<string, string>();
/** Parks whose assign transaction "lands but the RPC times out". */
const flaky = new Set<string>();
const assigned: [string, string][] = [];
const chain: ClaimChain = {
  admin: 'admin.testnet',
  message: (id) => `Claim Parkwright park ${id}`,
  recipient: 'parkwright',
  parkOwner: async (id) => owners.get(id) ?? null,
  registerPark: async (id) => { owners.set(id, 'admin.testnet'); },
  assignPark: async (id, owner) => {
    if (owners.get(id) !== 'admin.testnet') throw new Error('already been claimed');
    owners.set(id, owner); assigned.push([id, owner]);
    if (flaky.has(id)) throw new Error('RPC timeout');
  },
  // A "valid" signature is one whose text is good:<account>:<park>.
  verifySignature: async (s, id, nonce) => nonce.length === 32 && s.signature === `good:${s.accountId}:${id}`,
};

let base = '', dir = '';
let server: ReturnType<typeof createApp>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-claim-'));
  const cache = new MemoryCache();
  server = createApp({ store: new FileStore(dir), cache, docs: new Layered(cache), verifier: new Verifier(cache), claim: chain }, { webDist: dir, version: 't' });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const post = async (path: string, body: unknown, key?: string) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-park-key': key } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function publish(seed: number) {
  const { body } = await post('/api/parks', { save: save(seed) });
  for (let i = 0; i < 100; i++) { // wait for the replay to verify it
    const v = (await (await fetch(`${base}/api/parks/${body.id}/verify`)).json()) as any;
    if (v.verified) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return body as { id: string; key: string };
}
const signed = (account: string, id: string, sig = `good:${account}:${id}`) => ({ accountId: account, publicKey: 'ed25519:x', signature: sig });

describe('claiming a park', () => {
  it('the publisher claims with a wallet signature; the park is assigned on chain once', async () => {
    const p = await publish(41);
    const ch = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    expect(ch.status).toBe(200);
    expect(ch.body.message).toBe(`Claim Parkwright park ${p.id}`);
    const ok = await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id), nonce: ch.body.nonce }, p.key);
    expect(ok).toEqual({ status: 200, body: { id: p.id, owner: 'carol.testnet' } });
    expect(assigned).toContainEqual([p.id, 'carol.testnet']);
    // Claimed is final: a second claim (fresh challenge) is refused.
    const ch2 = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    const again = await post(`/api/parks/${p.id}/claim`, { signed: signed('mallory.testnet', p.id), nonce: ch2.body.nonce }, p.key);
    expect(again.status).toBe(409);
  }, 30_000);

  it('needs the park key, a fresh single-use challenge and a good signature', async () => {
    const p = await publish(42);
    expect((await post(`/api/parks/${p.id}/claim/challenge`, {}, 'wrong-key')).status).toBe(403);
    expect((await post(`/api/parks/${p.id}/claim/challenge`, {})).status).toBe(403);
    const ch = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    expect((await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id, 'forged'), nonce: ch.body.nonce }, p.key)).status).toBe(401);
    // That challenge is spent even though the signature failed.
    expect((await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id), nonce: ch.body.nonce }, p.key)).status).toBe(400);
    expect((await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id), nonce: 'made-up' }, p.key)).status).toBe(400);
    // A signature for another park doesn't carry over.
    const ch2 = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    expect((await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', 'otherpark'), nonce: ch2.body.nonce }, p.key)).status).toBe(401);
  }, 30_000);

  it('unverified parks cannot be claimed', async () => {
    const tampered = save(43) as any;
    tampered.snapshot.cash += 1;
    const { body: p } = await post('/api/parks', { save: tampered });
    await new Promise((r) => setTimeout(r, 1500));
    const ch = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    const r = await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id), nonce: ch.body.nonce }, p.key);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/verified/);
  }, 30_000);

  it('review: the CURRENT save must verify, not just an earlier version', async () => {
    const p = await publish(44);
    const tampered = save(44) as any;
    tampered.snapshot.cash += 1;
    const put = await fetch(`${base}/api/parks/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-park-key': p.key, 'if-match': '1' }, body: JSON.stringify({ save: tampered, version: 1 }) });
    expect(put.status).toBeLessThan(300);
    const ch = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    const r = await post(`/api/parks/${p.id}/claim`, { signed: signed('carol.testnet', p.id), nonce: ch.body.nonce }, p.key);
    expect(r.status).toBe(409);
  }, 30_000);

  it('review: a claim whose transaction landed despite an RPC error still succeeds', async () => {
    const p = await publish(45);
    flaky.add(p.id);
    const ch = await post(`/api/parks/${p.id}/claim/challenge`, {}, p.key);
    const r = await post(`/api/parks/${p.id}/claim`, { signed: signed('dave.testnet', p.id), nonce: ch.body.nonce }, p.key);
    expect(r).toEqual({ status: 200, body: { id: p.id, owner: 'dave.testnet' } });
  }, 30_000);
});
