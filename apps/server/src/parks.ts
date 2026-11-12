// /api/parks — cloud saves you can share. Anyone can view a park by id; only the holder of its key can overwrite it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basePack, buildContent, type Content } from '@parkwright/content';
import { computeRating, parkValue, type ParkState } from '@parkwright/sim';
import type { Cache, Layered } from './cache.ts';
import { ConflictError, validId, type ParkDoc, type Store } from './store.ts';
import type { Settler } from './settle.ts';
import { modsFor, type Verifier } from './verify.ts';
import { handleClaim, type ClaimChain } from './claim.ts';

export const MAX_BODY = 1_800_000; // under Cosmos' 2 MB item limit
const WRITES_PER_MIN = 30;
/** Across all clients, per replica window — a backstop if per-IP limiting is ever fooled. */
const CREATES_PER_MIN = 300;
const BOARD = 'board:rating';
/** Modded parks rank on their own board: mods change costs and ratings, so they can't compete fairly. */
const boardOf = (d: { modded?: boolean }) => (d.modded ? `${BOARD}:modded` : BOARD);
const baseOnly = buildContent([basePack]);
const CHAIN_CONTRACT = process.env.PARK_CONTRACT_ID ?? 'park.parkwright.testnet';
/** How long GET /verify waits for a replay it had to start before answering "pending". */
const VERIFY_WAIT_MS = 8_000;
/** A transient verification result (timeout, busy queue, crash) is retried this often after a save. */
const VERIFY_RETRIES = 3;
const VERIFY_RETRY_MS = 90_000;

export interface Deps {
  store: Store;
  cache: Cache;
  docs: Layered;
  /** NEAR settlement (absent when the server has no chain keys). */
  settler?: Settler;
  /** Read a park's on-chain state (escrow, earnings, settlements). */
  chainPark?: (parkId: string) => Promise<unknown>;
  /** Replays published parks; only verified ones rank or settle. */
  verifier?: Verifier;
  /** Claiming parks on NEAR (absent without chain keys). */
  claim?: ClaimChain;
}

/** After a save lands: verify it by replay, then (only if it matches) rank it — by the REPLAYED numbers — and queue it for settlement. */
function afterSave(deps: Deps, doc: ParkDoc, attempt = 0) {
  const { verifier, cache, settler } = deps;
  if (!verifier) {
    // Verification off (tests, tools): rank and settle as before.
    void cache.zadd(boardOf(doc), boardScore(doc), doc.id).catch(() => {});
    void settler?.markDirty(doc.id);
    return;
  }
  void verifier.verify(doc.id, doc.version, doc.save).then(async (r) => {
    if (r.transient && attempt < VERIFY_RETRIES) {
      // Said nothing about the save (timeout, busy, crash): try again later instead of leaving it pending.
      setTimeout(() => {
        // A newer save has its own verification; only retry the version that is still current.
        void deps.store.get(doc.id).then((cur) => { if (cur?.version === doc.version) afterSave(deps, doc, attempt + 1); }).catch(() => {});
      }, VERIFY_RETRY_MS).unref();
      return;
    }
    if (!r.ok || !r.replayed) return; // the last verified version (if any) keeps its place
    const ranked = { ...doc, rating: r.replayed.rating, value: r.replayed.value };
    await cache.zrem(boardOf({ modded: !doc.modded }), doc.id).catch(() => {});
    await cache.zadd(boardOf(doc), boardScore(ranked), doc.id).catch(() => {});
    await settler?.markDirty(doc.id);
  }).catch((e) => console.error('[verify]', (e as Error).message));
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(8).toString('hex');
const newKey = () => randomBytes(24).toString('base64url');

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw Object.assign(new Error('save is too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The content a save was built with: the base pack plus its own mods, re-validated here (untrusted). */
export function contentFor(save: any): Content {
  return buildContent([basePack, ...modsFor(save).map((m) => m.pack)]);
}

/** Why a save can't be stored (wrong shape, unknown content), or null. */
export function checkSave(save: any): string | null {
  if (!save || save.v !== 1 || !save.snapshot || typeof save.snapshot !== 'object' || !Array.isArray(save.log)) return 'not a Parkwright v1 save';
  const s = save.snapshot as ParkState;
  if (s.version !== 1 || !Array.isArray(s.tiles) || !Array.isArray(s.rides) || !Array.isArray(s.visitors)) return 'malformed park state';
  // hasOwn: plain lookups would accept "constructor" or "__proto__" as content ids.
  const content = contentFor(save);
  if (typeof s.scenario !== 'string' || !Object.hasOwn(content.scenarios, s.scenario)) return `unknown scenario "${s.scenario}"`;
  if (!Number.isInteger(s.w) || !Number.isInteger(s.h) || s.tiles.length !== s.w * s.h) return 'map size does not match';
  if (s.rides.some((r) => !r || typeof r !== 'object' || typeof r.type !== 'string')) return 'malformed rides';
  if (s.visitors.some((v) => !v || typeof v !== 'object')) return 'malformed visitors';
  const bad = s.rides.find((r) => !Object.hasOwn(content.rideTypes, r.type));
  if (bad) return `unknown ride type "${bad.type}"`;
  return null;
}

/**
 * Leaderboard numbers are recomputed here from the park's contents (not taken from the client's own
 * fields) and clamped to what the sim can produce. Saves are still client-made, so the board is
 * "self-reported, sanity-checked" — full verification needs a replay from the start (see DESIGN).
 */
function summary(save: any) {
  const s = save.snapshot as ParkState;
  const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo);
  let rating = 0, value = 0;
  const content = contentFor(save);
  try { rating = computeRating(s, content); } catch { /* malformed internals: rank it at the bottom */ }
  try { value = parkValue(s, content); } catch { /* summary only */ }
  const modded = Object.keys(content.rideTypes).length !== Object.keys(baseOnly.rideTypes).length || (Array.isArray(save.mods) && save.mods.length > 0);
  return { rating: clamp(rating, 0, 1000), value: clamp(value, 0, 999_999_999), visitors: clamp(s.visitors.length, 0, 100_000), day: clamp(s.day, 0, 100_000), scenario: s.scenario, modded };
}

const cleanName = (n: unknown) => String(n ?? 'My Park').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'My Park';

/**
 * The client address as seen by our ingress. Azure Container Apps' proxy appends the real peer to
 * X-Forwarded-For, so the rightmost entry is trustworthy; anything to its left is client-supplied.
 */
export function clientIp(req: IncomingMessage) {
  const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts[parts.length - 1] || req.socket.remoteAddress || 'unknown';
}

function ownerOk(doc: ParkDoc, key: string | undefined) {
  if (!key) return false;
  const a = Buffer.from(sha(key)), b = Buffer.from(doc.ownerHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rating first, then park value (both clamped, so the score stays exact as a double). */
const boardScore = (d: ParkDoc) => d.rating * 1e9 + d.value;

/** The public view of a park: everything except the owner hash. */
const publicDoc = ({ ownerHash: _o, ...rest }: ParkDoc) => rest;

export async function handleParks(req: IncomingMessage, res: ServerResponse, path: string, deps: Deps): Promise<boolean> {
  const { store, cache, docs } = deps;
  if (path === '/api/leaderboard' && req.method === 'GET') {
    const modded = new URL(req.url ?? '/', 'http://x').searchParams.has('modded');
    const top = await cache.ztop(modded ? `${BOARD}:modded` : BOARD, 20).catch(() => []);
    const rows = await Promise.all(top.map(async ({ member }) => {
      const r = await docs.read(`park:${member}`, async () => { const d = await store.get(member); return d ? JSON.stringify(publicDoc(d)) : null; });
      if (!r.value) return null;
      const d = JSON.parse(r.value);
      // Only verified parks are ranked, and with the numbers the server's replay produced.
      if (deps.verifier) {
        const last = await deps.verifier.latest(d.id);
        const rp = last?.result.replayed;
        if (!rp) return null;
        return { id: d.id, name: d.name, rating: rp.rating, value: rp.value, visitors: rp.visitors, day: rp.day, verified: true, version: last!.version };
      }
      return { id: d.id, name: d.name, rating: d.rating, value: d.value, visitors: d.visitors, day: d.day };
    }));
    json(res, 200, { parks: rows.filter(Boolean), cache: cache.kind });
    return true;
  }

  const verifyMatch = path.match(/^\/api\/parks\/([^/]+)\/verify$/);
  if (verifyMatch && req.method === 'GET') {
    const id = verifyMatch[1];
    if (!validId(id)) { json(res, 400, { error: 'bad park id' }); return true; }
    const d = await store.get(id);
    if (!d) {
      // A park can be registered on chain without a save here (e.g. one published to a local or test server).
      const onchain = deps.chainPark ? await deps.chainPark(id).catch(() => null) : null;
      json(res, 404, onchain ? { error: 'no save for this park on this server: it is registered on chain, but its save was published elsewhere (a local or test server), so it cannot be replayed here', onchain: true } : { error: 'no such park' });
      return true;
    }
    let r = deps.verifier ? await deps.verifier.status(id, d.version) : null;
    if (deps.verifier && !r) {
      // Nothing cached for this version (never run, a restart lost it, or a transient result expired): run it now.
      // Most parks replay in well under a second; a long one answers "pending" and the result lands in the cache.
      // Through afterSave, so a verified park is also ranked and queued for settlement (the replay itself is shared).
      afterSave(deps, d);
      const job = deps.verifier.verify(id, d.version, d.save);
      r = await Promise.race([job, new Promise<null>((ok) => setTimeout(() => ok(null), VERIFY_WAIT_MS).unref())]);
      if (r?.transient) r = null;
    }
    json(res, 200, { id, version: d.version, verified: r?.ok ?? false, reason: r?.reason ?? (deps.verifier ? 'verification pending: the replay is queued, ask again in a few seconds' : 'verification is off'), ms: r?.ms ?? null });
    return true;
  }

  const claimMatch = path.match(/^\/api\/parks\/([^/]+)\/claim(\/challenge)?$/);
  if (claimMatch) {
    if (!validId(claimMatch[1])) { json(res, 400, { error: 'bad park id' }); return true; }
    return handleClaim(req, res, claimMatch[1], claimMatch[2] ? 'challenge' : 'claim', {
      store, cache: deps.cache, verifier: deps.verifier, claim: deps.claim, ownerOk, json,
      readJson: async (r) => JSON.parse(await readBody(r)),
    });
  }

  const chainMatch = path.match(/^\/api\/parks\/([^/]+)\/chain$/);
  if (chainMatch && req.method === 'GET') {
    const id = chainMatch[1];
    if (!validId(id)) { json(res, 400, { error: 'bad park id' }); return true; }
    if (!deps.chainPark) { json(res, 200, { enabled: false }); return true; }
    // On-chain state changes with each settlement: cache it briefly (20 s) to spare the RPC.
    let body = new URL(req.url ?? '/', 'http://x').searchParams.has('fresh') ? null : await cache.get(`chain:${id}`).catch(() => null);
    const from = body ? 'l2' : 'rpc';
    if (!body) {
      const park = (await deps.chainPark!(id).catch(() => null)) as { owner?: string } | null;
      // `claimed`: a player owns it (the server holds unclaimed parks); `claimable`: this server can hand it over.
      body = JSON.stringify({ enabled: true, contract: CHAIN_CONTRACT, park, claimed: !!park?.owner && park.owner !== deps.claim?.admin && !!deps.claim, claimable: !!deps.claim });
      await cache.set(`chain:${id}`, body, 20).catch(() => {});
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-cache': from });
    res.end(body);
    return true;
  }

  const m = path.match(/^\/api\/parks(?:\/([^/]+))?$/);
  if (!m) return false;
  const id = m[1];

  if (req.method === 'GET' && id) {
    if (!validId(id)) { json(res, 400, { error: 'bad park id' }); return true; }
    const fresh = new URL(req.url ?? '/', 'http://x').searchParams.has('fresh');
    const r = await docs.read(`park:${id}`, async () => { const d = await store.get(id); return d ? JSON.stringify(publicDoc(d)) : null; }, fresh);
    if (!r.value) { json(res, 404, { error: 'no such park' }); return true; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-cache': r.from });
    res.end(r.value);
    return true;
  }

  if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id)) {
    const n = await cache.incr(`rl:${clientIp(req)}`, 60).catch(() => 0);
    if (n > WRITES_PER_MIN) { json(res, 429, { error: 'too many saves — try again in a minute' }, { 'retry-after': '60' }); return true; }
    // PUT: check the park and its key before reading a large body.
    let cur: ParkDoc | null = null;
    if (req.method === 'PUT') {
      if (!validId(id!)) { json(res, 400, { error: 'bad park id' }); return true; }
      cur = await store.get(id!);
      if (!cur) { json(res, 404, { error: 'no such park' }); return true; }
      if (!ownerOk(cur, String(req.headers['x-park-key'] ?? ''))) { json(res, 403, { error: 'only the owner can save over this park' }); return true; }
    } else {
      const all = await cache.incr('rl:creates', 60).catch(() => 0);
      if (all > CREATES_PER_MIN) { json(res, 429, { error: 'the server is busy — try again in a minute' }, { 'retry-after': '60' }); return true; }
    }
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch (e: any) { json(res, e?.status ?? 400, { error: e?.status ? e.message : 'body must be JSON' }); return true; }
    const why = checkSave(body?.save);
    if (why) { json(res, 422, { error: why }); return true; }
    const now = Date.now();

    if (req.method === 'POST') {
      const key = newKey();
      let doc: ParkDoc | null = null;
      for (let attempt = 0; attempt < 3 && !doc; attempt++) {
        const candidate: ParkDoc = { id: newId(), name: cleanName(body.name), ownerHash: sha(key), ...summary(body.save), save: body.save, createdAt: now, updatedAt: now, version: 1 };
        try { await store.create(candidate); doc = candidate; }
        catch (e) { if (!(e instanceof ConflictError)) throw e; } // id collision: pick another
      }
      if (!doc) { json(res, 503, { error: 'could not allocate a park id' }); return true; }
      await docs.write(`park:${doc.id}`, JSON.stringify(publicDoc(doc)));
      if (deps.settler) void deps.settler.register(doc.id, doc.name);
      afterSave(deps, doc);
      json(res, 201, { id: doc.id, key, version: doc.version });
      return true;
    }

    const expect = body.version === undefined ? cur!.version : Number(body.version);
    const doc: ParkDoc = { ...cur!, name: cleanName(body.name ?? cur!.name), ...summary(body.save), save: body.save, updatedAt: now, version: cur!.version + 1 };
    try {
      await store.put(doc, expect);
    } catch (e) {
      if (e instanceof ConflictError) { json(res, 409, { error: 'a newer save exists', version: cur!.version }); return true; }
      throw e;
    }
    await docs.write(`park:${doc.id}`, JSON.stringify(publicDoc(doc)));
    afterSave(deps, doc);
    json(res, 200, { id: doc.id, version: doc.version });
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}
