import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { Layered, MemoryCache, RedisCache, type Cache } from './cache.ts';
import { CosmosStore, FileStore, type Store } from './store.ts';
import { Settler, type ChainApi } from './settle.ts';
import { NearAiClient } from '@parkwright/ai';
import { attachBridge } from './bridge.ts';
import { attachClaudeTerminal } from './claude.ts';
import { LocalRelay, RedisRelay, type Relay } from './relay.ts';

const PORT = Number(process.env.PORT ?? 8790);
const WEB_DIST = resolve(process.env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname);
const VERSION = process.env.APP_VERSION ?? 'dev';

async function makeStore(): Promise<Store> {
  if (process.env.STORE === 'cosmos' && process.env.COSMOS_ENDPOINT) return CosmosStore.connect(process.env.COSMOS_ENDPOINT);
  return new FileStore(resolve(process.env.SAVES_DIR ?? new URL('../../../saves', import.meta.url).pathname));
}

async function makeCache(): Promise<Cache> {
  if (process.env.REDIS_URL) {
    try { return await RedisCache.connect(process.env.REDIS_URL); }
    catch (e) { console.error('[redis] unavailable, using the in-process cache:', (e as Error).message); }
  }
  return new MemoryCache();
}

const [store, cache] = await Promise.all([makeStore(), makeCache()]);

/** NEAR settlement: on when the server has chain keys (hosted secrets), or SETTLE_LOCAL=1 (~/.near-credentials). */
async function makeSettler(): Promise<{ settler?: Settler; chainPark?: (id: string) => Promise<unknown> }> {
  const local = process.env.SETTLE_LOCAL === '1';
  if (!local && !(process.env.PARK_ADMIN_KEY && process.env.PATRON_KEYS)) return {};
  const chain = await import('@parkwright/chain');
  const patronKeys: Record<string, string> = local ? {} : JSON.parse(process.env.PATRON_KEYS!);
  const admin = chain.adminClient(local ? {} : { privateKey: process.env.PARK_ADMIN_KEY });
  const patrons = chain.PATRONS.map((a) => chain.patronClient(a, local ? {} : { privateKey: patronKeys[a] }));
  const api: ChainApi = {
    admin: chain.ADMIN,
    registerPark: (id, name) => admin.registerPark(id, name),
    parkOwner: async (id) => (await chain.getPark(id))?.owner ?? null,
    lastSettledDay: (g, id) => chain.lastSettledDay(chain.PATRONS[g], id),
    settleDay: (g, id, day, lines, hash) => patrons[g].settleDay(id, day, lines, hash),
    patronBalance: async (g) => BigInt((await chain.getPatron(chain.PATRONS[g]))?.balance ?? '0'),
    topUp: (gs) => admin.fundPatrons(gs.map((g) => chain.PATRONS[g]), chain.TOP_UP),
    lines: (spend) => chain.settlementLines(spend),
    lowWater: BigInt(chain.LOW_WATER),
  };
  return { settler: new Settler(api, store, cache), chainPark: chain.getPark };
}
const { settler, chainPark } = await makeSettler();
if (settler) {
  const every = Number(process.env.SETTLE_MS ?? 20_000);
  setInterval(() => { settler.tick().catch((e) => console.error('[settle]', e)); }, every).unref();
  // Budgets are topped up on their own schedule (not only after a pass that settled something).
  setInterval(() => { settler.refill().catch((e) => console.error('[settle]', e)); }, Number(process.env.REFILL_MS ?? 300_000)).unref();
}
// NEAR AI Cloud (TEE): the park manager and mod designer. Off unless the server has an API key.
const ai = process.env.NEARAI_API_KEY ? new NearAiClient(process.env.NEARAI_API_KEY, process.env.NEARAI_MODEL ?? 'Qwen/Qwen3.6-35B-A3B-FP8') : undefined;
// Bridge relay: Redis pub/sub across replicas when hosted, in-process locally.
const relay: Relay = process.env.REDIS_URL ? await RedisRelay.connect(process.env.REDIS_URL).catch((e) => { console.error('[relay] falling back to local:', e.message); return new LocalRelay(); }) : new LocalRelay();
const server = createApp({ store, cache, docs: new Layered(cache), settler, chainPark, ai, relay }, { webDist: WEB_DIST, version: VERSION });
attachBridge(server, relay, cache);
// Local-only Claude terminal for modding (PW_CLAUDE_TERMINAL=1; never on the hosted image).
attachClaudeTerminal(server, relay, PORT, resolve(new URL('../../..', import.meta.url).pathname));
// Don't let slow clients hold connections open (defaults are 300 s / 60 s).
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, () => console.log(`parkwright server ${VERSION} on :${PORT} — store ${store.kind}, cache ${cache.kind}, settlement ${settler ? 'on' : 'off'}, serving ${WEB_DIST}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
