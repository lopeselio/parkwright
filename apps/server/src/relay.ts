// Relay pw commands from whoever asks (an MCP client) to the browser tab that holds the park,
// even when they land on different replicas. Local: in-process. Hosted: Redis pub/sub only —
// commands go to `cmd:<code>`, replies come back on this replica's own `res:<replica>` channel
// (one shared subscriber connection; no per-request connections).
import { randomBytes } from 'node:crypto';

export interface BridgeReply { ok: boolean; text: string }
export type Handler = (command: string) => Promise<BridgeReply>;

export interface Relay {
  readonly kind: string;
  /** On the replica holding the browser socket: answer commands for this code until unsubscribed. */
  serve(code: string, handler: Handler): Promise<() => Promise<void>>;
  /** Keep a code alive (the browser socket is still open). */
  touch(code: string): Promise<void>;
  /** From anywhere: send a command to the tab paired with `code`; null if nobody answers in time. */
  request(code: string, command: string, timeoutMs: number): Promise<BridgeReply | null>;
  alive(code: string): Promise<boolean>;
}

export class LocalRelay implements Relay {
  readonly kind = 'local';
  private handlers = new Map<string, Handler>();
  async serve(code: string, h: Handler) { this.handlers.set(code, h); return async () => { if (this.handlers.get(code) === h) this.handlers.delete(code); }; }
  async touch() {}
  async alive(code: string) { return this.handlers.has(code); }
  async request(code: string, command: string, timeoutMs: number) {
    const h = this.handlers.get(code);
    if (!h) return null;
    return Promise.race([h(command).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  }
}

const P = '{pw}:bridge:';

export class RedisRelay implements Relay {
  readonly kind = 'redis';
  private readonly replica = randomBytes(8).toString('hex');
  private pending = new Map<string, (r: BridgeReply) => void>();
  private constructor(private pub: any, private sub: any) {}

  static async connect(url: string): Promise<RedisRelay> {
    const { createClient } = await import('redis');
    const pub = createClient({ url, socket: { reconnectStrategy: (n: number) => Math.min(n * 200, 5000), connectTimeout: 5000 } });
    pub.on('error', (e: Error) => console.error('[relay]', e.message));
    await pub.connect();
    const sub = pub.duplicate();
    sub.on('error', (e: Error) => console.error('[relay sub]', e.message));
    await sub.connect();
    const r = new RedisRelay(pub, sub);
    await sub.subscribe(`${P}res:${r.replica}`, (msg: string) => {
      try {
        const m = JSON.parse(msg) as { id: string; reply: BridgeReply };
        r.pending.get(m.id)?.(m.reply);
      } catch { /* ignore malformed */ }
    });
    return r;
  }

  async serve(code: string, handler: Handler) {
    const channel = `${P}cmd:${code}`;
    await this.sub.subscribe(channel, (msg: string) => {
      let m: { id: string; command: string; replyTo: string };
      try { m = JSON.parse(msg); } catch { return; }
      if (!/^[0-9a-f]{16}$/.test(m.replyTo ?? '')) return;
      void handler(m.command)
        .catch(() => ({ ok: false, text: 'the game tab failed to run that' }))
        .then((reply) => this.pub.publish(`${P}res:${m.replyTo}`, JSON.stringify({ id: m.id, reply })))
        .catch((e: Error) => console.error('[relay reply]', e.message));
    });
    await this.touch(code);
    return async () => {
      await this.sub.unsubscribe(channel).catch(() => {});
      await this.pub.del(`${P}alive:${code}`).catch(() => {});
    };
  }

  async touch(code: string) { await this.pub.set(`${P}alive:${code}`, this.replica, { EX: 60 }); }
  async alive(code: string) { return (await this.pub.exists(`${P}alive:${code}`).catch(() => 0)) === 1; }

  async request(code: string, command: string, timeoutMs: number): Promise<BridgeReply | null> {
    if (!(await this.alive(code))) return null;
    const id = randomBytes(12).toString('hex');
    const reply = new Promise<BridgeReply | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); this.pending.delete(id); resolve(r); });
    });
    let receivers = 1;
    try { receivers = Number(await this.pub.publish(`${P}cmd:${code}`, JSON.stringify({ id, command, replyTo: this.replica }))); }
    catch { this.pending.get(id)?.({ ok: false, text: 'relay unavailable' }); }
    // Nobody subscribed (the replica holding the tab is gone): fail fast instead of waiting it out.
    if (receivers === 0) this.pending.get(id)?.({ ok: false, text: 'The park is not connected right now — reopen the game tab.' });
    return reply;
  }
}
