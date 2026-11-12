import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basePack, buildContent, baseContent, validateMod } from '@parkwright/content';
import { Park, runCommand, rulesToHooks, TICKS_PER_DAY } from '@parkwright/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { Layered, MemoryCache } from '../src/cache.ts';
import { FileStore } from '../src/store.ts';
import { Verifier, verifySave } from '../src/verify.ts';

function played(days = 3, seed = 5, rules?: number) {
  const p = Park.create(baseContent, 'meadow', seed, 'Honest Park', rules);
  for (const t of ['carousel', 'pretzel-cart', 'lemonade-stand']) runCommand(p, `ride place ${t}`);
  p.run('park.fee', { fee: 5 });
  p.advanceTo(TICKS_PER_DAY * days + 30);
  return { p, save: { v: 1, snapshot: p.snapshot(), log: p.log, savedAt: 0, fullLog: true } as any };
}

describe('verify by replay', () => {
  it('an honest save verifies', () => {
    const { save } = played();
    const r = verifySave(save);
    expect(r).toMatchObject({ ok: true });
  });

  it('a park on the old (v1) rules still verifies; a swapped or unknown rules version does not', () => {
    const { save } = played(3, 5, 1);
    expect(save.snapshot.rules).toBeUndefined();
    expect(verifySave(save)).toMatchObject({ ok: true });
    const current = played(3, 5).save;
    expect(verifySave(current)).toMatchObject({ ok: true });
    expect(verifySave({ ...current, snapshot: { ...current.snapshot, rules: 99 } }).ok).toBe(false);
    // The rules version is part of what's verified: relabelling a park either way doesn't reproduce it.
    expect(verifySave({ ...save, snapshot: { ...save.snapshot, rules: 2 } }).ok).toBe(false);
    const { rules: _drop, ...unversioned } = current.snapshot;
    expect(verifySave({ ...current, snapshot: unversioned }).ok).toBe(false);
  });

  it('inflated spend, a dropped action, or a partial log do not verify', () => {
    const { save } = played();
    const inflated = structuredClone(save);
    inflated.snapshot.history[0].spend['0'] = { gate: 99_999 };
    expect(verifySave(inflated).ok).toBe(false);
    const dropped = structuredClone(save);
    dropped.log.splice(1, 1);
    expect(verifySave(dropped).ok).toBe(false);
    expect(verifySave({ ...save, fullLog: false }).ok).toBe(false);
    const shuffled = structuredClone(save);
    shuffled.log[0].tick = 999_999_999;
    expect(verifySave(shuffled).ok).toBe(false);
  });

  it('a park built with a data-only mod verifies', () => {
    const { mod } = validateMod({ name: 'Kites', rideTypes: [{ id: 'kite-hut', name: 'Kite Hut', kind: 'stall', item: 'kite' }] }, baseContent);
    const content = buildContent([basePack, mod.pack]);
    const p = Park.create(content, 'meadow', 9, 'Kite Park');
    p.hooks = rulesToHooks(mod.pack.id, mod.rules);
    expect(runCommand(p, `ride place ${mod.pack.rideTypes[0].id}`).ok).toBe(true);
    p.advanceTo(TICKS_PER_DAY * 2);
    expect(verifySave({ v: 1, snapshot: p.snapshot(), log: p.log, savedAt: 0, fullLog: true, mods: [mod] }).ok).toBe(true);
  });

  it('runs in a worker thread and caches per version', async () => {
    const v = new Verifier(new MemoryCache());
    const { save } = played(2);
    const r = await v.verify('parkabc123', 1, save);
    expect(r.ok).toBe(true);
    expect((await v.status('parkabc123', 1))?.ok).toBe(true);
    expect(await v.status('parkabc123', 2)).toBeNull();
  }, 30_000);
});

describe('only verified parks rank', () => {
  let base = '';
  let server: ReturnType<typeof createApp>;
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pw-verify-'));
    const cache = new MemoryCache();
    server = createApp({ store: new FileStore(dir), cache, docs: new Layered(cache), verifier: new Verifier(cache) }, { webDist: dir, version: 't' });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

  it('an honest park appears once verified; a tampered one never does', async () => {
    const post = async (save: unknown) => (await (await fetch(`${base}/api/parks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save }) })).json()) as any;
    const honest = await post(played(2, 11).save);
    const tampered = played(2, 12).save;
    tampered.snapshot.rating = 999;
    tampered.snapshot.history[0].spend['1'] = { gate: 50_000 };
    const bad = await post(tampered);
    let board: any = { parks: [] };
    for (let i = 0; i < 50 && !board.parks.length; i++) { await new Promise((r) => setTimeout(r, 100)); board = await (await fetch(`${base}/api/leaderboard`)).json(); }
    expect(board.parks.map((p: any) => p.id)).toEqual([honest.id]);
    const v = (await (await fetch(`${base}/api/parks/${bad.id}/verify`)).json()) as any;
    expect(v.verified).toBe(false);
  }, 30_000);
});

describe('review: forgery and queue', () => {
  it('a save whose 32-bit sim hash matches but whose content differs still fails (SHA-256 over the state)', async () => {
    const { save } = played(2, 21);
    const forged = structuredClone(save);
    forged.snapshot.history[0].spend['0'] = { gate: 99_999 };
    forged.snapshot.zz = 'padding-to-steer-a-32-bit-hash';
    expect(verifySave(forged).ok).toBe(false);
  });

  it('settlement and ranking numbers come from the replay, not the upload', () => {
    const { p, save } = played(3, 22);
    const r = verifySave(save);
    expect(r.ok).toBe(true);
    const spent = (h: { spend: Record<string, Record<string, number>> }[]) => h.reduce((a, d) => a + Object.values(d.spend).flatMap((g) => Object.values(g)).reduce((x, y) => x + y, 0), 0);
    expect(spent(r.replayed!.history)).toBe(spent(p.s.history.filter((d) => d.day < p.s.day)));
    expect(r.replayed!.day).toBe(p.s.day);
  });

  it('coalesces pending versions of a park and never caches transient failures for long', async () => {
    const v = new Verifier(new MemoryCache());
    const a = played(1, 31).save, b = played(1, 32).save;
    const [r1, r2] = await Promise.all([v.verify('parkxyz', 1, a), v.verify('parkxyz', 2, b)]);
    // v1 may have started already; whichever was still waiting when v2 arrived is superseded.
    expect([r1.ok || r1.reason === 'superseded by a newer save', r2.ok]).toEqual([true, true]);
    expect((await v.latest('parkxyz'))?.version).toBe(2);
  }, 30_000);
});

describe('GET /verify never leaves a park pending forever', () => {
  let base = '';
  let server: ReturnType<typeof createApp>;
  let dir = '';
  let store: FileStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pw-verify-get-'));
    const cache = new MemoryCache();
    store = new FileStore(dir);
    const chainPark = async (id: string) => (id === 'onchainonly01' ? { owner: 'parkwright.testnet', name: 'Test' } : null);
    server = createApp({ store, cache, docs: new Layered(cache), verifier: new Verifier(cache), chainPark }, { webDist: dir, version: 't' });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

  it('a stored park that was never verified (e.g. saved before a restart) is replayed on request', async () => {
    const { save, p } = played(1, 41);
    // Written straight to the store: no afterSave ran, so nothing is cached for it.
    await store.create({ id: 'neververified1', name: 'Old', ownerHash: 'x', rating: 0, value: 0, visitors: 0, day: p.s.day, scenario: 'meadow', save, createdAt: 0, updatedAt: 0, version: 1 });
    const v = (await (await fetch(`${base}/api/parks/neververified1/verify`)).json()) as any;
    expect(v).toMatchObject({ verified: true, reason: 'replay matches the save' });
  }, 30_000);

  it('a park that is only on chain says so instead of a bare "no such park"', async () => {
    const r = await fetch(`${base}/api/parks/onchainonly01/verify`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ onchain: true });
    expect(await (await fetch(`${base}/api/parks/missingpark01/verify`)).json()).toEqual({ error: 'no such park' });
  });
});
