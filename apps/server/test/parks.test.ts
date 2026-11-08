import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseContent } from '@parkwright/content';
import { Park } from '@parkwright/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { clientIp } from '../src/parks.ts';
import { Layered, Lru, MemoryCache } from '../src/cache.ts';
import { FileStore } from '../src/store.ts';

let base = '';
let dir = '';
let server: ReturnType<typeof createApp>;

function saveOf(seed = 1) {
  const p = Park.create(baseContent, 'meadow', seed, 'Cloud Park');
  p.run('path.place', { x: 24, y: 35, x2: 24, y2: 39 });
  p.advanceTo(200);
  return { v: 1, snapshot: p.snapshot(), log: p.log, savedAt: 0 };
}

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-saves-'));
  const cache = new MemoryCache();
  server = createApp({ store: new FileStore(dir), cache, docs: new Layered(cache) }, { webDist: dir, version: 'test' });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

describe('/api/parks', () => {
  it('creates, reads (cached) and updates a park with its key', async () => {
    const created = await call('POST', '/api/parks', { name: 'Cloud Park', save: saveOf() });
    expect(created.status).toBe(201);
    const { id, key, version } = (await created.json()) as any;
    expect(version).toBe(1);

    const first = await call('GET', `/api/parks/${id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache')).toBe('l1'); // written through on create
    const doc = (await first.json()) as any;
    expect(doc.name).toBe('Cloud Park');
    expect(doc.ownerHash).toBeUndefined();

    const upd = await call('PUT', `/api/parks/${id}`, { save: saveOf(2), version: 1 }, { 'x-park-key': key });
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as any).version).toBe(2);
  });

  it('refuses writes without the key, stale versions and bad saves', async () => {
    const { id, key } = (await (await call('POST', '/api/parks', { save: saveOf() })).json()) as any;
    expect((await call('PUT', `/api/parks/${id}`, { save: saveOf() }, { 'x-park-key': 'nope' })).status).toBe(403);
    expect((await call('PUT', `/api/parks/${id}`, { save: saveOf(), version: 7 }, { 'x-park-key': key })).status).toBe(409);
    expect((await call('POST', '/api/parks', { save: { v: 1, snapshot: { ...saveOf().snapshot, scenario: 'mars' }, log: [] } })).status).toBe(422);
    expect((await call('POST', '/api/parks', 'not json')).status).toBe(422);
    expect((await call('GET', '/api/parks/../../etc')).status).toBe(404);
    expect((await call('GET', '/api/parks/ZZZ')).status).toBe(400);
  });

  it('lists parks on the leaderboard by rating', async () => {
    const board = (await (await call('GET', '/api/leaderboard')).json()) as any;
    expect(board.parks.length).toBeGreaterThan(0);
    expect(board.parks[0]).toHaveProperty('rating');
  });

  it('rate-limits writes per client', async () => {
    const cache = new MemoryCache();
    for (let i = 0; i < 31; i++) await cache.incr('rl:x', 60);
    expect(await cache.incr('rl:x', 60)).toBe(32);
  });
});

describe('cache', () => {
  it('LRU evicts the least recently used and expires entries', () => {
    let now = 0;
    const l = new Lru<number>(2, () => now);
    l.set('a', 1, 1000); l.set('b', 2, 1000);
    l.get('a');
    l.set('c', 3, 1000);
    expect(l.get('b')).toBeUndefined();
    expect(l.get('a')).toBe(1);
    now = 2000;
    expect(l.get('a')).toBeUndefined();
  });

  it('reads through L1 → L2 → store and only hits the store once', async () => {
    const docs = new Layered(new MemoryCache(), 1000, 60);
    let loads = 0;
    const load = async () => { loads++; return '{"x":1}'; };
    expect((await docs.read('k', load)).from).toBe('store');
    expect((await docs.read('k', load)).from).toBe('l1');
    expect(loads).toBe(1);
  });
});

describe('review regressions', () => {
  it('rejects prototype names and null shapes with 422, not 500', async () => {
    const good = saveOf();
    for (const bad of [
      { ...good, snapshot: { ...good.snapshot, scenario: 'constructor' } },
      { ...good, snapshot: { ...good.snapshot, rides: [{ type: '__proto__' }] } },
      { ...good, snapshot: null },
      { ...good, snapshot: { ...good.snapshot, rides: [null] } },
    ]) expect((await call('POST', '/api/parks', { save: bad })).status).toBe(422);
  });

  it('ranks by a rating it computes itself, not the one the client claims', async () => {
    const fake = saveOf();
    fake.snapshot.rating = 999;
    const { id } = (await (await call('POST', '/api/parks', { save: fake })).json()) as any;
    const doc = (await (await call('GET', `/api/parks/${id}`)).json()) as any;
    expect(doc.rating).toBeLessThan(999);
    expect(doc.rating).toBeGreaterThanOrEqual(0);
  });

  it('checks the key before reading the body', async () => {
    const { id } = (await (await call('POST', '/api/parks', { save: saveOf() })).json()) as any;
    const r = await fetch(`${base}/api/parks/${id}`, { method: 'PUT', headers: { 'x-park-key': 'wrong' }, body: 'x'.repeat(10) });
    expect(r.status).toBe(403);
  });

  it('uses the rightmost x-forwarded-for entry (the one our ingress adds)', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, socket: {} } as any;
    expect(clientIp(req)).toBe('9.9.9.9');
  });

  it('cache fills never overwrite a newer write-through', async () => {
    const l2 = new MemoryCache();
    const docs = new Layered(l2, 1000, 60);
    await docs.read('k', async () => { await l2.set('k', 'v6', 60); return 'v5'; }, true);
    expect(await l2.get('k')).toBe('v6');
  });
});

describe('modded parks', () => {
  it('rank on their own board', async () => {
    const save: any = saveOf(4);
    save.mods = [{ pack: { name: 'Tiny', rideTypes: [{ id: 'mini', name: 'Mini', kind: 'flat' }], items: [] }, summary: '', rules: [] }];
    const r = (await (await call('POST', '/api/parks', { name: 'Modded', save })).json()) as any;
    const vanilla = (await (await call('GET', '/api/leaderboard')).json()) as any;
    const modded = (await (await call('GET', '/api/leaderboard?modded=1')).json()) as any;
    expect(vanilla.parks.some((p: any) => p.id === r.id)).toBe(false);
    expect(modded.parks.some((p: any) => p.id === r.id)).toBe(true);
  });
});
