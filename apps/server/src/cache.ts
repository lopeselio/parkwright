// Caching layer: an in-process LRU (L1) in front of Redis (L2) when REDIS_URL is set.
// Redis also backs the leaderboard (sorted set) and rate limits, so they're shared across replicas.

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Set only if absent (cache fills must never overwrite a newer write-through). */
  setNx(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment a counter that expires after ttlSec; returns the new value. */
  incr(key: string, ttlSec: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  /** Highest scores first. */
  ztop(key: string, n: number): Promise<{ member: string; score: number }[]>;
  zrem(key: string, member: string): Promise<void>;
  readonly kind: string;
}

/** Small LRU with per-entry expiry. */
export class Lru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max: number, private now: () => number = Date.now) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.map.delete(k); return undefined; }
    this.map.delete(k);
    this.map.set(k, e); // most recently used goes last
    return e.v;
  }
  set(k: string, v: V, ttlMs: number) {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(k: string) { this.map.delete(k); }
  get size() { return this.map.size; }
}

export class MemoryCache implements Cache {
  readonly kind = 'memory';
  private kv = new Lru<string>(5000);
  private counters = new Map<string, { n: number; exp: number }>();
  private zsets = new Map<string, Map<string, number>>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ttl: number) { this.kv.set(k, v, ttl * 1000); }
  async setNx(k: string, v: string, ttl: number) { if (this.kv.get(k) === undefined) this.kv.set(k, v, ttl * 1000); }
  async del(k: string) { this.kv.delete(k); }
  async incr(k: string, ttl: number) {
    const now = Date.now();
    const c = this.counters.get(k);
    if (!c || c.exp <= now) { this.counters.set(k, { n: 1, exp: now + ttl * 1000 }); return 1; }
    return ++c.n;
  }
  async zadd(k: string, score: number, m: string) { (this.zsets.get(k) ?? this.zsets.set(k, new Map()).get(k)!).set(m, score); }
  async ztop(k: string, n: number) {
    return [...(this.zsets.get(k) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, n).map(([member, score]) => ({ member, score }));
  }
  async zrem(k: string, m: string) { this.zsets.get(k)?.delete(m); }
}

/** Redis-backed cache. Keys share one hash tag so multi-key ops stay on one shard. */
export class RedisCache implements Cache {
  readonly kind = 'redis';
  private constructor(private client: any, private prefix: string) {}

  static async connect(url: string, prefix = '{pw}:'): Promise<RedisCache> {
    const { createClient } = await import('redis');
    // Fail fast while disconnected (callers fall back to the store) instead of queueing and hanging requests.
    const client = createClient({ url, disableOfflineQueue: true, socket: { reconnectStrategy: (n: number) => Math.min(n * 200, 5000), connectTimeout: 5000 } });
    client.on('error', (e: Error) => console.error('[redis]', e.message));
    await client.connect();
    return new RedisCache(client, prefix);
  }

  private k(key: string) { return this.prefix + key; }
  async get(key: string) { return (await this.client.get(this.k(key))) as string | null; }
  async set(key: string, v: string, ttl: number) { await this.client.set(this.k(key), v, { EX: ttl }); }
  async setNx(key: string, v: string, ttl: number) { await this.client.set(this.k(key), v, { EX: ttl, NX: true }); }
  async del(key: string) { await this.client.del(this.k(key)); }
  async incr(key: string, ttl: number) {
    const k = this.k(key);
    const [n] = await this.client.multi().incr(k).expire(k, ttl, 'NX').exec();
    return Number(n);
  }
  async zadd(key: string, score: number, m: string) { await this.client.zAdd(this.k(key), { score, value: m }); }
  async ztop(key: string, n: number) {
    const rows = await this.client.zRangeWithScores(this.k(key), 0, n - 1, { REV: true });
    return rows.map((r: { value: string; score: number }) => ({ member: r.value, score: r.score }));
  }
  async zrem(key: string, m: string) { await this.client.zRem(this.k(key), m); }
}

/**
 * Read-through two-level cache for hot JSON documents: L1 (this process, a few seconds) then L2 (Redis).
 * Writes go to the store first, then refresh both levels (write-through).
 */
export class Layered {
  private l1 = new Lru<string>(500);
  constructor(readonly l2: Cache, private l1Ms = 5000, private l2Sec = 300) {}
  /** fresh skips L1 (the owner resuming must see the newest version; L2 is kept current by write-through). */
  async read(key: string, load: () => Promise<string | null>, fresh = false): Promise<{ value: string | null; from: 'l1' | 'l2' | 'store' }> {
    const a = fresh ? undefined : this.l1.get(key);
    if (a !== undefined) return { value: a, from: 'l1' };
    const b = await this.l2.get(key).catch(() => null);
    if (b !== null) { this.l1.set(key, b, this.l1Ms); return { value: b, from: 'l2' }; }
    const c = await load();
    if (c !== null) {
      // NX: if a PUT on another replica wrote a newer value meanwhile, keep that one.
      this.l1.set(key, c, this.l1Ms);
      await this.l2.setNx(key, c, this.l2Sec).catch(() => {});
    }
    return { value: c, from: 'store' };
  }
  async write(key: string, value: string) {
    this.l1.set(key, value, this.l1Ms);
    await this.l2.set(key, value, this.l2Sec).catch(() => {});
  }
  async drop(key: string) {
    this.l1.delete(key);
    await this.l2.del(key).catch(() => {});
  }
}
