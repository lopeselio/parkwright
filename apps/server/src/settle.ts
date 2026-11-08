// Daily settlement on NEAR. Parks that sync to the cloud are marked dirty; one replica at a time
// (Redis lock) settles their finished days: each visitor group's patron agent pays that day's spend
// into the park with its own settle_day-only key. The contract is the source of truth and refuses a
// day twice, so retries are safe (at-least-once delivery).
import { createHash } from 'node:crypto';
import type { DayStats, ParkState } from '@parkwright/sim';
import type { Cache } from './cache.ts';
import type { Store } from './store.ts';

export interface ChainApi {
  registerPark(parkId: string, name: string): Promise<string>;
  settleDay(patronGroup: number, parkId: string, day: number, lines: { venue: string; amount: string }[], stateHash: string): Promise<string>;
  /** Credits left in a patron's budget (units). */
  patronBalance(patronGroup: number): Promise<bigint>;
  topUp(patronGroups: number[]): Promise<string>;
  lines(spend: Record<string, number> | undefined): { venue: string; amount: string }[];
  lowWater: bigint;
}

const DIRTY = 'settle:dirty';
const LOCK = 'lock:settle';
const doneKey = (park: string) => `settled:${park}`;
/** How many past days a single pass will settle per park (history keeps 56). */
const MAX_DAYS_PER_PASS = 14;

export const dayHash = (d: DayStats) => createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 32);

export class Settler {
  log: string[] = [];
  constructor(private chain: ChainApi, private store: Store, private cache: Cache) {}

  /** Called when a park is created: register it on chain, owned by the admin until a player claims it. */
  async register(parkId: string, name: string) {
    try { this.note(`registered ${parkId}: ${await this.chain.registerPark(parkId, name)}`); }
    catch (e) { if (!/already registered/.test(String(e))) this.note(`register ${parkId} failed: ${(e as Error).message}`); }
  }

  /** Called after each cloud save. */
  async markDirty(parkId: string) {
    await this.cache.zadd(DIRTY, Date.now(), parkId).catch(() => {});
  }

  /** One pass over dirty parks. Only one replica runs it at a time. */
  async tick(): Promise<number> {
    if (!(await this.cache.lock(LOCK, 120).catch(() => false))) return 0;
    let settled = 0;
    try {
      const dirty = await this.cache.ztop(DIRTY, 25);
      for (const { member: parkId } of dirty) {
        settled += await this.settlePark(parkId);
        await this.cache.zrem(DIRTY, parkId);
      }
      if (settled) await this.refill();
    } finally {
      await this.cache.del(LOCK).catch(() => {});
    }
    return settled;
  }

  async settlePark(parkId: string): Promise<number> {
    const doc = await this.store.get(parkId);
    if (!doc) return 0;
    const s = (doc.save as { snapshot: ParkState }).snapshot;
    const through = Number((await this.cache.get(doneKey(parkId)).catch(() => null)) ?? -1);
    // Finished days only (s.day is the day in progress), oldest first.
    const days = (s.history ?? []).filter((d) => d.day > through && d.day < s.day).sort((a, b) => a.day - b.day).slice(0, MAX_DAYS_PER_PASS);
    let n = 0;
    for (const d of days) {
      for (const [group, spend] of Object.entries(d.spend ?? {})) {
        const g = Number(group);
        if (!Number.isInteger(g) || g < 0 || g > 7) continue;
        const lines = this.chain.lines(spend);
        if (!lines.length) continue;
        try {
          const tx = await this.chain.settleDay(g, parkId, d.day, lines, dayHash(d));
          this.note(`settled ${parkId} day ${d.day + 1} group ${g}: ${tx}`);
          n++;
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          // Already settled (a retry) is success; anything else stops this park until the next pass.
          if (!/already settled/.test(msg)) { this.note(`settle ${parkId} day ${d.day + 1} group ${g} failed: ${msg.slice(0, 200)}`); return n; }
        }
      }
      await this.cache.set(doneKey(parkId), String(d.day), 60 * 60 * 24 * 30);
    }
    return n;
  }

  /** Top up patrons whose budgets are running low. */
  async refill() {
    const low: number[] = [];
    for (let g = 0; g < 8; g++) if ((await this.chain.patronBalance(g).catch(() => this.chain.lowWater)) < this.chain.lowWater) low.push(g);
    if (low.length) this.note(`topped up patrons ${low.join(',')}: ${await this.chain.topUp(low)}`);
  }

  private note(s: string) {
    console.log(`[settle] ${s}`);
    this.log.unshift(`${new Date().toISOString()} ${s}`);
    this.log.length = Math.min(this.log.length, 50);
  }
}
