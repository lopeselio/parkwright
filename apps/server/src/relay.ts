// Relay pw commands from whoever asks (an MCP client) to the browser tab that holds the park,
// even when they land on different replicas. Local: in-process. Hosted: Redis pub/sub + a reply list.
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
  async serve(code: string, h: Handler) { this.handlers.set(code, h); return async () => { this.handlers.delete(code); }; }
  async touch() {}
  async alive(code: string) { return this.handlers.has(code); }
  async request(code: string, command: string, timeoutMs: number) {
    const h = this.handlers.get(code);
    if (!h) return null;
    return Promise.race([h(command), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  }
}

const P = '{pw}:bridge:';

export class RedisRelay implements Relay {
  readonly kind = 'redis';
  private constructor(private pub: any, private sub: any) {}

  static async connect(url: string): Promise<RedisRelay> {
    const { createClient } = await import('redis');
    const pub = createClient({ url, socket: { reconnectStrategy: (n: number) => Math.min(n * 200, 5000) } });
    pub.on('error', (e: Error) => console.error('[relay]', e.message));
    await pub.connect();
    const sub = pub.duplicate();
    sub.on('error', (e: Error) => console.error('[relay sub]', e.message));
    await sub.connect();
    return new RedisRelay(pub, sub);
  }

  async serve(code: string, handler: Handler) {
    const channel = `${P}cmd:${code}`;
    await this.sub.subscribe(channel, (msg: string) => {
      let m: { id: string; command: string };
      try { m = JSON.parse(msg); } catch { return; }
      void handler(m.command).then(async (reply) => {
        const key = `${P}res:${m.id}`;
        await this.pub.multi().lPush(key, JSON.stringify(reply)).expire(key, 30).exec();
      });
    });
    await this.touch(code);
    return async () => { await this.sub.unsubscribe(channel).catch(() => {}); await this.pub.del(`${P}alive:${code}`).catch(() => {}); };
  }

  async touch(code: string) { await this.pub.set(`${P}alive:${code}`, '1', { EX: 60 }); }
  async alive(code: string) { return (await this.pub.exists(`${P}alive:${code}`)) === 1; }

  async request(code: string, command: string, timeoutMs: number) {
    if (!(await this.alive(code))) return null;
    const id = randomBytes(12).toString('hex');
    // A blocking pop needs its own connection.
    const waiter = this.pub.duplicate();
    await waiter.connect();
    try {
      await this.pub.publish(`${P}cmd:${code}`, JSON.stringify({ id, command }));
      const got = await waiter.brPop(`${P}res:${id}`, Math.max(1, Math.ceil(timeoutMs / 1000)));
      return got ? (JSON.parse(got.element) as BridgeReply) : null;
    } finally {
      await waiter.quit().catch(() => {});
    }
  }
}
