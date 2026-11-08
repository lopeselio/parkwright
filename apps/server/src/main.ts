import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { Layered, MemoryCache, RedisCache, type Cache } from './cache.ts';
import { CosmosStore, FileStore, type Store } from './store.ts';

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
const server = createApp({ store, cache, docs: new Layered(cache) }, { webDist: WEB_DIST, version: VERSION });
// Don't let slow clients hold connections open (defaults are 300 s / 60 s).
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, () => console.log(`parkwright server ${VERSION} on :${PORT} — store ${store.kind}, cache ${cache.kind}, serving ${WEB_DIST}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
