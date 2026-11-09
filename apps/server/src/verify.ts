// Verify a published park by replaying it: seed + scenario + mods + the complete action log must
// reproduce the uploaded snapshot exactly. Only verified parks settle on chain or rank — and they settle
// and rank from the SERVER'S replayed state, never from numbers in the upload.
//
// The comparison is SHA-256 over the full state JSON (the sim's own 32-bit FNV hash is fine for
// determinism tests, but a 32-bit hash can be matched by brute force). Replays run in a worker thread
// so a long park never blocks the event loop.
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { basePack, buildContent, validateMod, type ModFile } from '@parkwright/content';
import { computeRating, Park, parkValue, rulesToHooks, type ActionRecord, type DayStats, type ParkState } from '@parkwright/sim';
import type { Cache } from './cache.ts';

/** What the replay produced: the only numbers settlement and the leaderboard ever use. */
export interface Replayed {
  rating: number;
  value: number;
  visitors: number;
  day: number;
  /** Finished days (day < `day`) with each patron group's spend per venue. */
  history: Pick<DayStats, 'day' | 'spend'>[];
}

export interface VerifyResult { ok: boolean; reason: string; ms: number; replayed?: Replayed; transient?: boolean }

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

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Replay a save and compare. Pure and synchronous — run it in a worker. */
export function verifySave(save: any, maxDays = 400): VerifyResult {
  const t0 = performance.now();
  const done = (ok: boolean, reason: string, replayed?: Replayed): VerifyResult => ({ ok, reason, ms: Math.round(performance.now() - t0), ...(replayed ? { replayed } : {}) });
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
  // `mods` is metadata (which packs were loaded at creation); everything else must match byte for byte.
  replayed.s.mods = s.mods;
  if (sha256(replayed.s) !== sha256(s)) return done(false, 'replaying the actions does not reproduce this save');
  const r = replayed.s;
  return done(true, 'replay matches the save', {
    rating: computeRating(r, content),
    value: parkValue(r, content),
    visitors: r.visitors.length,
    day: r.day,
    history: r.history.filter((d) => d.day < r.day).map((d) => ({ day: d.day, spend: d.spend })),
  });
}

const MAX_QUEUE = 50;
/** Results that say nothing about the save itself (timeouts, crashes, a busy queue) are retried soon, not remembered. */
const TRANSIENT_TTL = 60;
const KEEP = 60 * 60 * 24 * 30;

/**
 * One worker thread. Pending work is coalesced per park (only its newest version waits), identical
 * concurrent requests share one replay, and the queue is bounded.
 */
export class Verifier {
  private worker: Worker | null = null;
  private onFail: ((why: string) => void) | null = null;
  private inflight = new Map<string, Promise<VerifyResult>>();
  private waiting = new Map<string, { version: number; save: unknown; resolve: (r: VerifyResult) => void }[]>();
  private order: string[] = [];
  private busy = false;
  constructor(private cache: Cache, private timeoutMs = 30_000) {}

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

  /** Verify one version (cached per version; deduplicated; coalesced per park). */
  async verify(id: string, version: number, save: unknown): Promise<VerifyResult> {
    const key = `verify:${id}:${version}`;
    const cached = await this.cache.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as VerifyResult;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.enqueue(id, version, save).then(async (r) => {
      await this.cache.set(key, JSON.stringify(r), r.transient ? TRANSIENT_TTL : KEEP).catch(() => {});
      if (r.ok) {
        const last = await this.latest(id);
        if (!last || last.version <= version) await this.cache.set(`verify:last:${id}`, JSON.stringify({ version, result: r }), KEEP).catch(() => {});
      }
      return r;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private enqueue(id: string, version: number, save: unknown): Promise<VerifyResult> {
    return new Promise((resolve) => {
      const list = this.waiting.get(id) ?? [];
      // Coalesce: an older pending version of the same park is superseded (it's re-checked on demand).
      for (const old of list.splice(0)) {
        if (old.version !== version) old.resolve({ ok: false, reason: 'superseded by a newer save', ms: 0, transient: true });
        else list.push(old);
      }
      list.push({ version, save, resolve });
      this.waiting.set(id, list);
      if (!this.order.includes(id)) {
        if (this.order.length >= MAX_QUEUE) { this.waiting.delete(id); resolve({ ok: false, reason: 'verification is busy — try again shortly', ms: 0, transient: true }); return; }
        this.order.push(id);
      }
      void this.pump();
    });
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.order.length) {
        const id = this.order.shift()!;
        const jobs = this.waiting.get(id) ?? [];
        this.waiting.delete(id);
        if (!jobs.length) continue;
        const r = await this.run(jobs[jobs.length - 1].save);
        for (const j of jobs) j.resolve(r);
      }
    } finally { this.busy = false; }
  }

  /** Result for this exact version, if any. */
  async status(id: string, version: number): Promise<VerifyResult | null> {
    const cached = await this.cache.get(`verify:${id}:${version}`).catch(() => null);
    return cached ? (JSON.parse(cached) as VerifyResult) : null;
  }

  /** The newest verified version of a park and what its replay produced (used for ranking). */
  async latest(id: string): Promise<{ version: number; result: VerifyResult } | null> {
    const cached = await this.cache.get(`verify:last:${id}`).catch(() => null);
    return cached ? JSON.parse(cached) : null;
  }

  private run(save: unknown): Promise<VerifyResult> {
    if (!this.worker) this.spawn();
    const w = this.worker!;
    return new Promise((resolve) => {
      const finish = (r: VerifyResult) => { clearTimeout(timer); this.onFail = null; resolve(r); };
      const timer = setTimeout(() => { void w.terminate(); this.worker = null; finish({ ok: false, reason: 'verification timed out', ms: this.timeoutMs, transient: true }); }, this.timeoutMs);
      this.onFail = (why) => finish({ ok: false, reason: why, ms: 0, transient: true });
      w.once('message', (r: VerifyResult) => finish(r));
      w.postMessage(save);
    });
  }
}
