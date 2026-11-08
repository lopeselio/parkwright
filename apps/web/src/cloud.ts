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

  constructor(private game: Game) {
    game.on((e) => { if (e.kind === 'day' && this.link && !this.conflict) void this.sync(); });
  }

  async publish(): Promise<string> {
    if (this.link) { await this.sync(); return shareUrl(this.link.id); }
    const res = await fetch('/api/parks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: this.game.s.name, save: this.game.toSave() }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `couldn't publish (${res.status})`);
    this.link = { id: body.id, key: body.key, version: body.version };
    write(this.link);
    this.status = 'saved to the cloud';
    return shareUrl(body.id);
  }

  async sync(): Promise<void> {
    if (!this.link) return;
    const res = await fetch(`/api/parks/${this.link.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-park-key': this.link.key },
      body: JSON.stringify({ name: this.game.s.name, save: this.game.toSave(), version: this.link.version }),
    }).catch(() => null);
    if (!res) { this.status = 'offline — will retry tomorrow'; return; }
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) { this.conflict = true; this.status = 'a newer save exists in the cloud — not overwriting it'; return; }
    if (!res.ok) { this.status = body.error ?? `cloud save failed (${res.status})`; return; }
    this.link.version = body.version;
    write(this.link);
    this.status = `saved to the cloud (v${body.version})`;
  }

  /** Open a shared park. Your own link resumes it; anyone else's becomes a copy you can play. */
  async open(id: string): Promise<'own' | 'copy'> {
    const res = await fetch(`/api/parks/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `couldn't load that park (${res.status})`);
    this.game.load(body.save as SaveFile);
    if (this.link?.id === id) { this.link.version = body.version; write(this.link); this.conflict = false; return 'own'; }
    // Visiting someone else's park: play a copy, and don't keep syncing to your own old link.
    this.link = null;
    write(null);
    return 'copy';
  }

  async leaderboard(): Promise<{ id: string; name: string; rating: number; value: number; visitors: number; day: number }[]> {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) return [];
    return (await res.json()).parks ?? [];
  }
}
