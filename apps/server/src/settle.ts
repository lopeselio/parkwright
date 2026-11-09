// Daily settlement on NEAR. Parks that sync to the cloud are marked dirty; one replica at a time
// (Redis lock with a random token) settles their finished days: each visitor group's patron agent
// pays that day's spend into the park with its own settle_day-only key.
//
// Trust: the spend comes from the client's save. The contract bounds what any park-day can draw
// (per-patron and per-park caps, days can't outrun real time, minting is budgeted per day), and this
// worker applies the same bounds before sending, so bad saves cost nothing and can't burn gas.
import { createHash, randomBytes } from 'node:crypto';
import type { DayStats, ParkState } from '@parkwright/sim';
import type { Cache } from './cache.ts';
import type { Store } from './store.ts';
import type { Verifier } from './verify.ts';

export interface ChainApi {
  admin: string;
  registerPark(parkId: string, name: string): Promise<string>;
  parkOwner(parkId: string): Promise<string | null>;
  lastSettledDay(patronGroup: number, parkId: string): Promise<number | null>;
  settleDay(patronGroup: number, parkId: string, day: number, lines: { venue: string; amount: string }[], stateHash: string): Promise<string>;
  /** Credits left in a patron's budget (units). */
  patronBalance(patronGroup: number): Promise<bigint>;
  topUp(patronGroups: number[]): Promise<string>;
  lines(spend: Record<string, number> | undefined): { venue: string; amount: string }[];
  lowWater: bigint;
}

const DIRTY = 'settle:dirty';
const LOCK = 'lock:settle';
const LOCK_SEC = 120;
/** Stop a pass well before the lock expires, so two passes never overlap. */
const PASS_BUDGET_MS = 90_000;
/** Must match the contract: a park day takes at least 20 s of real time, plus 2 days of slack. */
const GAME_DAY_MIN_MS = 20_000;
const DAY_SLACK = 2;
const MAX_DAYS_PER_PASS = 14;
const doneKey = (park: string) => `settled:${park}`;

export const dayHash = (d: DayStats) => createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 32);

export class Settler {
  log: string[] = [];
  private running = false;
  constructor(private chain: ChainApi, private store: Store, private cache: Cache, private now: () => number = Date.now, private verifier?: Verifier) {}

  /** Register a park on chain, owned by the admin. Safe to call again: "already registered" is fine. */
  async register(parkId: string, name: string): Promise<boolean> {
    try { this.note(`registered ${parkId}: ${await this.chain.registerPark(parkId, name)}`); return true; }
    catch (e) {
      if (/already registered/.test(String(e))) return true;
      this.note(`register ${parkId} failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
      return false;
    }
  }

  async markDirty(parkId: string) {
    await this.cache.zadd(DIRTY, this.now(), parkId).catch(() => {});
  }

  /** One pass over dirty parks: one at a time in this process, one replica at a time overall. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    const token = randomBytes(8).toString('hex');
    if (!(await this.cache.lock(LOCK, LOCK_SEC, token).catch(() => false))) return 0;
    this.running = true;
    const deadline = this.now() + PASS_BUDGET_MS;
    let settled = 0;
    try {
      const dirty = await this.cache.ztop(DIRTY, 25);
      for (const { member: parkId } of dirty) {
        if (this.now() > deadline) break;
        const r = await this.settlePark(parkId, deadline);
        settled += r.settled;
        if (r.complete) await this.cache.zrem(DIRTY, parkId);
      }
    } finally {
      this.running = false;
      await this.cache.unlock(LOCK, token).catch(() => {});
    }
    return settled;
  }

  async settlePark(parkId: string, deadline = Infinity): Promise<{ settled: number; complete: boolean }> {
    const doc = await this.store.get(parkId);
    if (!doc) return { settled: 0, complete: true };
    // Only spend the simulation actually produced: the save must replay exactly from its action log.
    if (this.verifier) {
      const v = await this.verifier.verify(doc.id, doc.version, doc.save);
      if (!v.ok) { this.note(`${parkId} v${doc.version} not settled: ${v.reason}`); return { settled: 0, complete: true }; }
    }
    // The park must exist on chain and still be in the admin's custody (claimed parks need replay
    // verification before the server will settle client-reported spend into them).
    let owner = await this.chain.parkOwner(parkId).catch(() => undefined);
    if (owner === undefined) return { settled: 0, complete: false }; // RPC trouble: try later
    if (owner === null) {
      if (!(await this.register(parkId, doc.name))) return { settled: 0, complete: false };
      owner = this.chain.admin;
    }
    if (owner !== this.chain.admin) { this.note(`${parkId} is owned by ${owner}; not settling client-reported spend`); return { settled: 0, complete: true }; }

    const s = (doc.save as { snapshot: ParkState }).snapshot;
    const through = Number((await this.cache.get(doneKey(parkId)).catch(() => null)) ?? -1);
    // Same bound as the contract: days can't run ahead of real time since the park was created.
    const maxDay = Math.floor((this.now() - doc.createdAt) / GAME_DAY_MIN_MS) + DAY_SLACK;
    const seen = new Set<number>();
    const days = (Array.isArray(s.history) ? s.history : [])
      .filter((d) => Number.isInteger(d?.day) && d.day > through && d.day < s.day && d.day <= maxDay && !seen.has(d.day) && seen.add(d.day))
      .sort((a, b) => a.day - b.day)
      .slice(0, MAX_DAYS_PER_PASS);
    let n = 0;
    for (const d of days) {
      if (this.now() > deadline) return { settled: n, complete: false };
      for (const [group, spend] of Object.entries(d.spend ?? {})) {
        const g = Number(group);
        if (!Number.isInteger(g) || g < 0 || g > 7) continue;
        const lines = this.chain.lines(spend);
        if (!lines.length) continue;
        // The chain is the source of truth (free view): skip what this patron already settled.
        const last = await this.chain.lastSettledDay(g, parkId).catch(() => null);
        if (last !== null && last >= d.day) continue;
        try {
          const tx = await this.chain.settleDay(g, parkId, d.day, lines, dayHash(d));
          this.note(`settled ${parkId} day ${d.day + 1} group ${g}: ${tx}`);
          n++;
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          if (/already settled/.test(msg)) continue;
          // Over a cap, or the day is out of range: the contract will never accept this line; skip it.
          if (/daily cap|hasn't happened yet|too old/.test(msg)) { this.note(`skipped ${parkId} day ${d.day + 1} group ${g}: ${msg.match(/(over [^"]+cap|hasn't happened yet|too old[^"]*)/)?.[0]}`); continue; }
          this.note(`settle ${parkId} day ${d.day + 1} group ${g} failed: ${msg.slice(0, 200)}`);
          return { settled: n, complete: false };
        }
      }
      await this.cache.set(doneKey(parkId), String(d.day), 60 * 60 * 24 * 30);
    }
    return { settled: n, complete: true };
  }

  /** Top up patrons running low. Runs on its own schedule; the contract limits minting per day. */
  async refill() {
    const low: number[] = [];
    for (let g = 0; g < 8; g++) if ((await this.chain.patronBalance(g).catch(() => this.chain.lowWater)) < this.chain.lowWater) low.push(g);
    if (!low.length) return;
    try { this.note(`topped up patrons ${low.join(',')}: ${await this.chain.topUp(low)}`); }
    catch (e) { this.note(`top-up failed: ${String((e as Error).message ?? e).slice(0, 200)}`); }
  }

  private note(s: string) {
    console.log(`[settle] ${s}`);
    this.log.unshift(`${new Date(this.now()).toISOString()} ${s}`);
    this.log.length = Math.min(this.log.length, 50);
  }
}
