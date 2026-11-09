// Claiming a park on NEAR. A player proves two things:
//   1. they published the park: the park's secret key (x-park-key), which only the publisher's browser holds;
//   2. they own a NEAR account: a NEP-413 signature over a one-time challenge, made with a full-access key.
// The park must also be verified by replay. Then the server (admin) assigns the park to that account on
// chain; the contract only allows this while the admin still holds the park, so a claim is final.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Cache } from './cache.ts';
import type { ParkDoc, Store } from './store.ts';
import type { Verifier } from './verify.ts';

export interface SignedClaim { accountId: string; publicKey: string; signature: string }

export interface ClaimChain {
  admin: string;
  message: (parkId: string) => string;
  recipient: string;
  parkOwner(parkId: string): Promise<string | null>;
  registerPark(parkId: string, name: string): Promise<unknown>;
  assignPark(parkId: string, owner: string): Promise<unknown>;
  verifySignature(signed: SignedClaim, parkId: string, nonce: Uint8Array): Promise<boolean>;
}

export interface ClaimDeps {
  store: Store;
  cache: Cache;
  verifier?: Verifier;
  claim?: ClaimChain;
  ownerOk: (doc: ParkDoc, key: string | undefined) => boolean;
  readJson: (req: IncomingMessage) => Promise<any>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

const CHALLENGE_TTL = 300;
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** POST /api/parks/:id/claim/challenge and POST /api/parks/:id/claim. Returns true if it handled the request. */
export async function handleClaim(req: IncomingMessage, res: ServerResponse, id: string, sub: 'challenge' | 'claim', d: ClaimDeps): Promise<boolean> {
  const { store, cache, json } = d;
  if (req.method !== 'POST') return false;
  if (!d.claim) { json(res, 503, { error: 'claiming is off on this server (no NEAR keys)' }); return true; }
  const doc = await store.get(id);
  if (!doc) { json(res, 404, { error: 'no such park' }); return true; }
  if (!d.ownerOk(doc, String(req.headers['x-park-key'] ?? '') || undefined)) { json(res, 403, { error: 'only the browser that published this park can claim it' }); return true; }
  if ((await cache.incr(`claimrate:${id}`, 600)) > 20) { json(res, 429, { error: 'too many claim attempts; try again in a few minutes' }); return true; }

  if (sub === 'challenge') {
    const nonce = randomBytes(32).toString('base64');
    await cache.set(`claimnonce:${id}:${nonce}`, '1', CHALLENGE_TTL);
    json(res, 200, { message: d.claim.message(id), recipient: d.claim.recipient, nonce });
    return true;
  }

  const body = await d.readJson(req).catch(() => null);
  const signed = body?.signed as SignedClaim | undefined;
  const nonceB64 = String(body?.nonce ?? '');
  if (!signed || typeof signed.accountId !== 'string' || typeof signed.publicKey !== 'string' || typeof signed.signature !== 'string' || !ACCOUNT.test(signed.accountId)) {
    json(res, 400, { error: 'send { signed: { accountId, publicKey, signature }, nonce }' }); return true;
  }
  if (signed.accountId === d.claim.admin) { json(res, 400, { error: 'claim it with a player account' }); return true; }
  // The challenge must exist (fresh) and be used once: `lock` succeeds for exactly one caller.
  const nonceKey = `claimnonce:${id}:${nonceB64}`;
  if (!(await cache.get(nonceKey)) || !(await cache.lock(`${nonceKey}:used`, CHALLENGE_TTL))) { json(res, 400, { error: 'that challenge expired or was already used; start the claim again' }); return true; }
  await cache.del(nonceKey);
  const nonce = Buffer.from(nonceB64, 'base64');
  if (nonce.length !== 32 || !(await d.claim.verifySignature(signed, id, nonce))) {
    json(res, 401, { error: 'the wallet signature does not check out (it must be signed with a full-access key of that account)' }); return true;
  }
  // The CURRENT save must replay exactly (not just some earlier version).
  if (d.verifier && !(await d.verifier.verify(doc.id, doc.version, doc.save)).ok) { json(res, 409, { error: 'only verified parks can be claimed: keep playing and save, then try again' }); return true; }

  let owner = await d.claim.parkOwner(id);
  if (owner === null) { await d.claim.registerPark(id, doc.name).catch(() => {}); owner = await d.claim.parkOwner(id); }
  if (owner !== d.claim.admin) {
    json(res, 409, owner === signed.accountId ? { error: 'you already own this park', owner } : { error: 'this park has already been claimed', owner });
    return true;
  }
  try {
    await d.claim.assignPark(id, signed.accountId);
  } catch (e) {
    // The transaction may have landed even though the call failed (an RPC timeout), or a concurrent
    // claim may have won: the chain says which.
    const now = await d.claim.parkOwner(id).catch(() => null);
    if (now !== signed.accountId) {
      json(res, now && now !== d.claim.admin ? 409 : 502, now && now !== d.claim.admin ? { error: 'this park has already been claimed', owner: now } : { error: `the claim transaction failed: ${String((e as Error).message ?? e).slice(0, 160)}` });
      return true;
    }
  }
  await cache.del(`chain:${id}`).catch(() => {});
  json(res, 200, { id, owner: signed.accountId });
  return true;
}
