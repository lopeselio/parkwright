// Durable park storage. Cosmos DB for NoSQL when hosted (managed identity, no keys); JSON files locally.
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
  /** Create or replace. With expectVersion, fails with 'conflict' if the stored version differs. */
  put(doc: ParkDoc, expectVersion?: number): Promise<void>;
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
  async put(doc: ParkDoc, expectVersion?: number) {
    await mkdir(this.dir, { recursive: true });
    if (expectVersion !== undefined) {
      const cur = await this.get(doc.id);
      if (cur && cur.version !== expectVersion) throw new ConflictError();
    }
    const tmp = this.path(doc.id) + '.tmp';
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, this.path(doc.id)); // atomic replace
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
      return (resource as ParkDoc | undefined) ?? null;
    } catch (e: any) {
      if (e?.code === 404) return null;
      throw e;
    }
  }

  async put(doc: ParkDoc, expectVersion?: number) {
    if (expectVersion === undefined) { await this.container.items.upsert(doc); return; }
    // Optimistic concurrency on our own version field, using Cosmos' ETag of the stored item.
    const cur = await this.container.item(doc.id, doc.id).read().catch((e: any) => (e?.code === 404 ? { resource: undefined } : Promise.reject(e)));
    if (!cur.resource) { await this.container.items.create(doc); return; }
    if ((cur.resource as ParkDoc).version !== expectVersion) throw new ConflictError();
    try {
      await this.container.item(doc.id, doc.id).replace(doc, { accessCondition: { type: 'IfMatch', condition: cur.etag } });
    } catch (e: any) {
      if (e?.code === 412) throw new ConflictError();
      throw e;
    }
  }
}
