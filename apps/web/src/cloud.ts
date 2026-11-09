// Cloud saves: publish a park to get a shareable link; later days sync automatically.
// The owner key never leaves this browser except as the x-park-key header on our own API.
import type { Game, SaveFile } from './game.ts';

const KEY = 'parkwright.cloud.v1';

export interface CloudLink { id: string; key: string; version: number }

function read(): CloudLink | null {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return v?.id && v?.key ? v : null; } catch { return null; }
}
function write(v: CloudLink | null) {
  try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export const shareUrl = (id: string) => `${location.origin}/?park=${id}`;

export class Cloud {
  link: CloudLink | null = read();
  /** Set when the cloud copy is newer (another tab or device): we stop overwriting it. */
  conflict = false;
  status = '';
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  /** Don't retry before this time after an error (doubles each failure, up to 10 min). */
  private retryAt = 0;
  private backoff = 15_000;

  constructor(private game: Game) {
    game.on((e) => { if (e.kind === 'day') void this.sync(); });
  }

  /** Your own park is the one that syncs; visiting someone else's never touches your link. */
  private get canSync() {
    return !!this.link && !this.conflict && !this.game.visiting;
  }

  /** Unlink from the published park (a new park starts): the published copy stays online but stops updating. */
  forget() {
    this.link = null;
    write(null);
    this.conflict = false;
    this.dirty = false;
    this.status = '';
  }

  async publish(): Promise<string> {
    if (this.game.visiting) throw new Error("you're visiting someone else's park — go back to yours to share it");
    if (this.link) { await this.sync(true); return shareUrl(this.link.id); }
    const res = await fetch('/api/parks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: this.game.s.name, save: this.game.toSave() }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `couldn't publish (${res.status})`);
    this.link = { id: body.id, key: body.key, version: body.version };
    write(this.link);
    this.status = 'saved to the cloud';
    return shareUrl(body.id);
  }

  /** One upload at a time; a sync requested meanwhile sends the latest save when the current one ends. */
  async sync(force = false): Promise<void> {
    if (!this.canSync) return;
    if (!force && Date.now() < this.retryAt) return;
    if (this.inFlight) { this.dirty = true; return this.inFlight; }
    this.inFlight = this.upload().finally(() => { this.inFlight = null; });
    await this.inFlight;
    if (this.dirty) { this.dirty = false; await this.sync(); }
  }

  private async upload() {
    const link = this.link!;
    const res = await fetch(`/api/parks/${link.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-park-key': link.key },
      body: JSON.stringify({ name: this.game.s.name, save: this.game.toSave(), version: link.version }),
    }).catch(() => null);
    if (!res) return this.fail('offline');
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) { this.conflict = true; this.status = 'a newer save exists in the cloud — not overwriting it. Open your share link to continue from it.'; return; }
    if (!res.ok) return this.fail(body.error ?? `cloud save failed (${res.status})`);
    link.version = body.version;
    write(link);
    this.backoff = 15_000;
    this.retryAt = 0;
    this.status = `saved to the cloud (v${body.version})`;
  }

  private fail(why: string) {
    this.retryAt = Date.now() + this.backoff;
    this.backoff = Math.min(this.backoff * 2, 600_000);
    this.status = `${why} — will retry`;
  }

  /** Open a shared park. Your own link resumes it; anyone else's becomes a copy (your park is kept). */
  async open(id: string): Promise<'own' | 'copy'> {
    const own = this.link?.id === id;
    // The owner reads past the per-server cache so they always continue from the newest version.
    const res = await fetch(`/api/parks/${encodeURIComponent(id)}${own ? '?fresh=1' : ''}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `couldn't load that park (${res.status})`);
    const why = this.game.incompatible(body.save as SaveFile);
    if (why) throw new Error(`can't open that park: ${why}`);
    if (own) {
      this.game.visiting = false;
      this.game.load(body.save as SaveFile, true);
      this.link!.version = body.version;
      write(this.link);
      this.conflict = false;
      return 'own';
    }
    this.game.visit(body.save as SaveFile);
    return 'copy';
  }

  /** Leave a visited park and return to your own. */
  home(): boolean {
    return this.game.goHome();
  }

  /** Your park's state on NEAR (escrow, earnings, settlements), if settlement is on. */
  async chain(fresh = false): Promise<{ enabled: boolean; contract?: string; claimed?: boolean; claimable?: boolean; park?: { owner: string; balance: string; earned: string; settlements: number } | null } | null> {
    if (!this.link) return null;
    const res = await fetch(`/api/parks/${this.link.id}/chain${fresh ? '?fresh=1' : ''}`).catch(() => null);
    return res?.ok ? res.json() : null;
  }

  /**
   * Claim this park on NEAR: the server checks this browser published it (the park key) and that the
   * wallet signed its one-time challenge, then assigns the park to that account on chain.
   */
  async claim(): Promise<string> {
    if (!this.link) throw new Error('publish the park first');
    const { connect, signClaim } = await import('./wallet.ts');
    const { wallet, accountId } = await connect();
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`/api/parks/${this.link!.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-park-key': this.link!.key }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `claim failed (${res.status})`);
      return out;
    };
    const ch = await post('claim/challenge', {});
    const signed = await signClaim(wallet, accountId, ch);
    const out = await post('claim', { signed: { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature }, nonce: ch.nonce });
    return out.owner as string;
  }

  /** Withdraw the park's escrow to its owner (signed in the owner's wallet). */
  async withdraw(): Promise<void> {
    if (!this.link) throw new Error('publish the park first');
    const { connect, withdraw } = await import('./wallet.ts');
    const { wallet, accountId } = await connect();
    await withdraw(wallet, accountId, this.link.id);
  }

  /** Has the server replayed this park's actions and got exactly this save? (Only verified parks settle and rank.) */
  async verification(): Promise<{ verified: boolean; reason: string } | null> {
    if (!this.link) return null;
    const res = await fetch(`/api/parks/${this.link.id}/verify`).catch(() => null);
    return res?.ok ? res.json() : null;
  }

  async leaderboard(): Promise<{ id: string; name: string; rating: number; value: number; visitors: number; day: number }[]> {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) return [];
    return (await res.json()).parks ?? [];
  }
}
