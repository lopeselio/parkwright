// /api/parks — cloud saves you can share. Anyone can view a park by id; only the holder of its key can overwrite it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseContent } from '@parkwright/content';
import { parkValue, type ParkState } from '@parkwright/sim';
import type { Cache, Layered } from './cache.ts';
import { ConflictError, validId, type ParkDoc, type Store } from './store.ts';

export const MAX_BODY = 1_800_000; // under Cosmos' 2 MB item limit
const WRITES_PER_MIN = 30;
const BOARD = 'board:rating';

export interface Deps { store: Store; cache: Cache; docs: Layered }

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

/** Why a save can't be stored (wrong shape, unknown content), or null. */
export function checkSave(save: any): string | null {
  if (!save || save.v !== 1 || typeof save.snapshot !== 'object' || !Array.isArray(save.log)) return 'not a Parkwright v1 save';
  const s = save.snapshot as ParkState;
  if (s.version !== 1 || !Array.isArray(s.tiles) || !Array.isArray(s.rides) || !Array.isArray(s.visitors)) return 'malformed park state';
  if (!baseContent.scenarios[s.scenario]) return `unknown scenario "${s.scenario}"`;
  if (s.tiles.length !== s.w * s.h) return 'map size does not match';
  const bad = s.rides.find((r) => !baseContent.rideTypes[r.type]);
  if (bad) return `unknown ride type "${bad.type}"`;
  return null;
}

function summary(save: any) {
  const s = save.snapshot as ParkState;
  let value = 0;
  try { value = parkValue(s, baseContent); } catch { /* summary only */ }
  return { rating: s.rating | 0, value, visitors: s.visitors.length, day: s.day | 0, scenario: s.scenario };
}

const cleanName = (n: unknown) => String(n ?? 'My Park').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'My Park';

function clientIp(req: IncomingMessage) {
  const xf = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}

function ownerOk(doc: ParkDoc, key: string | undefined) {
  if (!key) return false;
  const a = Buffer.from(sha(key)), b = Buffer.from(doc.ownerHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The public view of a park: everything except the owner hash. */
const publicDoc = ({ ownerHash: _o, ...rest }: ParkDoc) => rest;

export async function handleParks(req: IncomingMessage, res: ServerResponse, path: string, deps: Deps): Promise<boolean> {
  const { store, cache, docs } = deps;
  if (path === '/api/leaderboard' && req.method === 'GET') {
    const top = await cache.ztop(BOARD, 20);
    const rows = await Promise.all(top.map(async ({ member }) => {
      const r = await docs.read(`park:${member}`, async () => { const d = await store.get(member); return d ? JSON.stringify(publicDoc(d)) : null; });
      if (!r.value) return null;
      const d = JSON.parse(r.value);
      return { id: d.id, name: d.name, rating: d.rating, value: d.value, visitors: d.visitors, day: d.day };
    }));
    json(res, 200, { parks: rows.filter(Boolean), cache: cache.kind });
    return true;
  }

  const m = path.match(/^\/api\/parks(?:\/([^/]+))?$/);
  if (!m) return false;
  const id = m[1];

  if (req.method === 'GET' && id) {
    if (!validId(id)) { json(res, 400, { error: 'bad park id' }); return true; }
    const r = await docs.read(`park:${id}`, async () => { const d = await store.get(id); return d ? JSON.stringify(publicDoc(d)) : null; });
    if (!r.value) { json(res, 404, { error: 'no such park' }); return true; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-cache': r.from });
    res.end(r.value);
    return true;
  }

  if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id)) {
    const n = await cache.incr(`rl:${clientIp(req)}`, 60).catch(() => 0);
    if (n > WRITES_PER_MIN) { json(res, 429, { error: 'too many saves — try again in a minute' }, { 'retry-after': '60' }); return true; }
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch (e: any) { json(res, e?.status ?? 400, { error: e?.status ? e.message : 'body must be JSON' }); return true; }
    const why = checkSave(body?.save);
    if (why) { json(res, 422, { error: why }); return true; }
    const now = Date.now();

    if (req.method === 'POST') {
      const key = newKey();
      const doc: ParkDoc = { id: newId(), name: cleanName(body.name), ownerHash: sha(key), ...summary(body.save), save: body.save, createdAt: now, updatedAt: now, version: 1 };
      await store.put(doc);
      await docs.write(`park:${doc.id}`, JSON.stringify(publicDoc(doc)));
      await cache.zadd(BOARD, doc.rating * 1e9 + Math.min(doc.value, 1e9 - 1), doc.id).catch(() => {});
      json(res, 201, { id: doc.id, key, version: doc.version });
      return true;
    }

    if (!validId(id!)) { json(res, 400, { error: 'bad park id' }); return true; }
    const cur = await store.get(id!);
    if (!cur) { json(res, 404, { error: 'no such park' }); return true; }
    if (!ownerOk(cur, String(req.headers['x-park-key'] ?? ''))) { json(res, 403, { error: 'only the owner can save over this park' }); return true; }
    const expect = body.version === undefined ? undefined : Number(body.version);
    const doc: ParkDoc = { ...cur, name: cleanName(body.name ?? cur.name), ...summary(body.save), save: body.save, updatedAt: now, version: cur.version + 1 };
    try {
      await store.put(doc, expect ?? cur.version);
    } catch (e) {
      if (e instanceof ConflictError) { json(res, 409, { error: 'a newer save exists', version: cur.version }); return true; }
      throw e;
    }
    await docs.write(`park:${doc.id}`, JSON.stringify(publicDoc(doc)));
    await cache.zadd(BOARD, doc.rating * 1e9 + Math.min(doc.value, 1e9 - 1), doc.id).catch(() => {});
    json(res, 200, { id: doc.id, version: doc.version });
    return true;
  }

  json(res, 405, { error: 'method not allowed' });
  return true;
}
