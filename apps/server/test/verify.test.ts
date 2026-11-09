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

function played(days = 3, seed = 5) {
  const p = Park.create(baseContent, 'meadow', seed, 'Honest Park');
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
