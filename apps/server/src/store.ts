// Durable park storage. Cosmos DB for NoSQL when hosted (managed identity, no keys); JSON files locally.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ParkDoc {
  id: string;
  name: string;
  /** sha256 of the owner key; only the owner can overwrite. */
  ownerHash: string;
  /** Summary for listings and the leaderboard. */
  rating: number;
  value: number;
  visitors: number;
  day: number;
  scenario: string;
  /** Built with mods (ranked on a separate board). */
  modded?: boolean;
  /** The save file as the client produced it (snapshot + recent action log). */
  save: unknown;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every write; clients send it back to avoid overwriting newer saves. */
  version: number;
}

export interface Store {
  readonly kind: string;
  get(id: string): Promise<ParkDoc | null>;
  /** Create a new doc; fails with ConflictError if the id exists. */
  create(doc: ParkDoc): Promise<void>;
  /** Replace an existing doc, only if its stored version is still expectVersion. */
  put(doc: ParkDoc, expectVersion: number): Promise<void>;
}

export class ConflictError extends Error {
  constructor() { super('conflict'); }
}

const ID_RE = /^[a-z0-9]{8,32}$/;
export const validId = (id: string) => ID_RE.test(id);

export class FileStore implements Store {
  readonly kind = 'file';
  constructor(private dir: string) {}
  private path(id: string) {
    if (!validId(id)) throw new Error('bad id');
    return join(this.dir, `${id}.json`);
  }
  async get(id: string) {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as ParkDoc; } catch { return null; }
  }
  async create(doc: ParkDoc) {
    await mkdir(this.dir, { recursive: true });
    try { await writeFile(this.path(doc.id), JSON.stringify(doc), { flag: 'wx' }); }
    catch (e: any) { if (e?.code === 'EEXIST') throw new ConflictError(); throw e; }
  }
  // Local dev only: a per-id promise chain makes check-then-write atomic within this process.
  private locks = new Map<string, Promise<unknown>>();
  async put(doc: ParkDoc, expectVersion: number) {
    const prev = this.locks.get(doc.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const cur = await this.get(doc.id);
      if (!cur || cur.version !== expectVersion) throw new ConflictError();
      const tmp = `${this.path(doc.id)}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(doc));
      await rename(tmp, this.path(doc.id)); // atomic replace
    });
    this.locks.set(doc.id, next);
    try { await next; } finally { if (this.locks.get(doc.id) === next) this.locks.delete(doc.id); }
  }
}

export class CosmosStore implements Store {
  readonly kind = 'cosmos';
  private constructor(private container: any) {}

  static async connect(endpoint: string): Promise<CosmosStore> {
    const [{ CosmosClient }, { DefaultAzureCredential }] = await Promise.all([import('@azure/cosmos'), import('@azure/identity')]);
    // AZURE_CLIENT_ID selects the app's user-assigned identity; locally this falls back to `az login`.
    const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    return new CosmosStore(client.database('parkwright').container('parks'));
  }

  async get(id: string) {
    try {
      const { resource } = await this.container.item(id, id).read();
      return resource ? stripSystem(resource) : null;
    } catch (e: any) {
      if (e?.code === 404) return null;
      throw e;
    }
  }

  async create(doc: ParkDoc) {
    try { await this.container.items.create(doc); }
    catch (e: any) { if (e?.code === 409) throw new ConflictError(); throw e; }
  }

  async put(doc: ParkDoc, expectVersion: number) {
    // Optimistic concurrency on our version field, made atomic with If-Match on the item's ETag.
    const cur = await this.container.item(doc.id, doc.id).read();
    if (!cur.resource || (cur.resource as ParkDoc).version !== expectVersion) throw new ConflictError();
    try {
      await this.container.item(doc.id, doc.id).replace(doc, { accessCondition: { type: 'IfMatch', condition: cur.etag } });
    } catch (e: any) {
      if (e?.code === 412) throw new ConflictError();
      throw e;
    }
  }
}

/** Drop Cosmos system properties (_rid, _self, _etag, _ts…) before a doc goes anywhere public. */
function stripSystem(r: Record<string, unknown>): ParkDoc {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v;
  return out as unknown as ParkDoc;
}
