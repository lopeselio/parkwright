// Verify a published park by replaying it: seed + scenario + mods + the complete action log must
// reproduce the uploaded snapshot exactly (same state hash). Only verified parks settle on chain or
// rank on the leaderboard — a save can no longer claim spend the simulation never produced.
//
// Replays run in a worker thread so a long park never blocks the server's event loop.
import { Worker } from 'node:worker_threads';
import { basePack, buildContent, validateMod, type ModFile } from '@parkwright/content';
import { Park, rulesToHooks, stateHash, type ActionRecord, type ParkState } from '@parkwright/sim';
import type { Cache } from './cache.ts';

export interface VerifyResult { ok: boolean; reason: string; ms: number }

/** The save's mods, re-validated in order (each against base + the ones before it). */
export function modsFor(save: any): ModFile[] {
  const ok: ModFile[] = [];
  for (const m of Array.isArray(save?.mods) ? save.mods.slice(0, 8) : []) {
    try {
      const { mod } = validateMod({ name: m?.pack?.name, summary: m?.summary, rideTypes: m?.pack?.rideTypes, items: m?.pack?.items, rules: m?.rules }, buildContent([basePack, ...ok.map((x) => x.pack)]));
      if (!ok.some((x) => x.pack.id === mod.pack.id)) ok.push(mod);
    } catch { /* an unusable mod contributes nothing */ }
  }
  return ok;
}

/** Replay a save and compare. Pure and synchronous — run it in a worker. */
export function verifySave(save: any, maxDays = 400): VerifyResult {
  const t0 = performance.now();
  const done = (ok: boolean, reason: string) => ({ ok, reason, ms: Math.round(performance.now() - t0) });
  if (save?.fullLog !== true) return done(false, 'the save does not carry its complete action log');
  const s = save.snapshot as ParkState;
  const log = save.log as ActionRecord[];
  if (!Array.isArray(log) || log.length > 50_000) return done(false, 'action log missing or too long');
  if (!Number.isInteger(s?.tick) || s.tick < 0 || s.tick > maxDays * 1800) return done(false, 'park is too long to verify');
  for (let i = 0; i < log.length; i++) {
    const r = log[i];
    if (!r || typeof r.type !== 'string' || !Number.isInteger(r.tick) || r.tick < 0 || r.tick > s.tick || (i > 0 && r.tick < log[i - 1].tick)) return done(false, `action ${i} is malformed or out of order`);
  }
  const mods = modsFor(save);
  const content = buildContent([basePack, ...mods.map((m) => m.pack)]);
  const hooks = mods.flatMap((m) => rulesToHooks(m.pack.id, m.rules));
  let replayed: Park;
  try { replayed = Park.replay(content, s.scenario, s.seed, log, s.tick, s.name, hooks); }
  catch (e) { return done(false, `replay failed: ${(e as Error).message}`); }
  // `mods` is metadata (which packs were loaded when the park was created); a mod added later is fine as
  // long as replaying with it reproduces every action's outcome — which the rest of the hash checks.
  replayed.s.mods = s.mods;
  return stateHash(replayed.s) === stateHash(s) ? done(true, 'replay matches the save') : done(false, 'replaying the actions does not reproduce this save');
}

/** One worker thread, one replay at a time, with a timeout. */
export class Verifier {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private cache: Cache, private timeoutMs = 30_000) {}

  private onFail: ((why: string) => void) | null = null;

  private spawn() {
    // The worker is TypeScript too: make sure it can load .ts files whatever started this process.
    const execArgv = process.execArgv.includes('--experimental-transform-types') ? process.execArgv : [...process.execArgv, '--experimental-transform-types', '--disable-warning=ExperimentalWarning'];
    const w = new Worker(new URL('./verify-worker.ts', import.meta.url), { execArgv });
    w.unref();
    const fail = (why: string) => { if (this.worker === w) this.worker = null; this.onFail?.(why); };
    w.on('error', (e) => fail(`verifier crashed: ${e.message}`));
    w.on('exit', (code) => { if (code !== 0) fail(`verifier exited (${code})`); });
    this.worker = w;
  }

  /** Verify (cached per park version). */
  async verify(id: string, version: number, save: unknown): Promise<VerifyResult> {
    const cached = await this.cache.get(`verify:${id}`).catch(() => null);
    if (cached) { const c = JSON.parse(cached); if (c.version === version) return c.result; }
    const result = await (this.queue = this.queue.then(() => this.run(save), () => this.run(save))) as VerifyResult;
    await this.cache.set(`verify:${id}`, JSON.stringify({ version, result }), 60 * 60 * 24 * 30).catch(() => {});
    return result;
  }

  /** Last result for this park, only if it's for this exact version. */
  async status(id: string, version: number): Promise<VerifyResult | null> {
    const cached = await this.cache.get(`verify:${id}`).catch(() => null);
    if (!cached) return null;
    const c = JSON.parse(cached);
    return c.version === version ? c.result : null;
  }

  private run(save: unknown): Promise<VerifyResult> {
    if (!this.worker) this.spawn();
    const w = this.worker!;
    return new Promise((resolve) => {
      const finish = (r: VerifyResult) => { clearTimeout(timer); this.onFail = null; resolve(r); };
      const timer = setTimeout(() => { void w.terminate(); this.worker = null; finish({ ok: false, reason: 'verification timed out', ms: this.timeoutMs }); }, this.timeoutMs);
      this.onFail = (why) => finish({ ok: false, reason: why, ms: 0 });
      w.once('message', (r: VerifyResult) => finish(r));
      w.postMessage(save);
    });
  }
}
