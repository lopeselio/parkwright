// The park bridge: Claude Code (or any MCP client) plays the park open in your browser.
//   browser  ──ws /ws/bridge──▶  server  ◀──MCP over HTTP /mcp/<code>── Claude Code
// The browser asks for a pairing code; the code is the only key (128 bits, valid while the tab is open).
// Every command runs in the browser through the same validated actions as a player's.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { Cache } from './cache.ts';
import type { BridgeReply, Relay } from './relay.ts';
import { clientIp } from './parks.ts';

const CODE_RE = /^[a-z2-7]{26}$/;
/** The tab gets 15 s; whoever waits for the relay gets a little longer, so the tab's own timeout reply arrives. */
const TIMEOUT_MS = 15_000;
const WAIT_MS = TIMEOUT_MS + 2_000;
/** Mods travel as a command too, so they get a bigger (but still bounded) size limit. */
const MOD_MAX = 20_000;
const PER_MIN = 90;
const newCode = () => {
  // RFC 4648 base32, lowercase: 26 chars ≈ 128 bits.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(26);
  return Array.from(bytes, (b) => alphabet[b & 31]).join('');
};

/** Sockets per client IP and per replica (each holds a subscription and a keep-alive). */
const MAX_PER_IP = 5;
const MAX_SOCKETS = 500;
const RESUME_TTL = 24 * 3600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Same-site only: the page that pairs must be served by this host (blocks drive-by socket floods). */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (tests, tools) send no Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function attachBridge(server: Server, relay: Relay, cache: Cache) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const perIp = new Map<string, number>();
  let total = 0;
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url ?? '').split('?')[0];
    if (p === '/ws/claude') return; // handled by the (local-only) Claude terminal
    if (p !== '/ws/bridge' || !sameOrigin(req)) { socket.destroy(); return; }
    const ip = clientIp(req);
    if (total >= MAX_SOCKETS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Error handler first, synchronously: an oversized or invalid frame must never crash the process.
      ws.on('error', () => ws.terminate());
      total++;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.once('close', () => { total--; const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); });
      pair(ws, relay, cache).catch((e) => { console.error('[bridge]', (e as Error).message); ws.terminate(); });
    });
  });
}

/** Wait for the browser's hello: a new pairing, or resuming an earlier code with its secret. */
function hello(ws: WebSocket): Promise<{ code?: string; secret?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 3000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { const m = JSON.parse(String(data)); resolve(m?.type === 'hello' ? { code: m.code, secret: m.secret } : {}); }
      catch { resolve({}); }
    });
  });
}

async function pair(ws: WebSocket, relay: Relay, cache: Cache) {
  let closed = false;
  let unserve: (() => Promise<void>) | null = null;
  const pending = new Map<string, (r: BridgeReply) => void>();
  const keepAlive = setInterval(() => { if (code) void relay.touch(code).catch(() => {}); if (ws.readyState === ws.OPEN) ws.ping(); }, 20_000);
  ws.on('close', () => {
    closed = true;
    clearInterval(keepAlive);
    void unserve?.();
    for (const r of pending.values()) r({ ok: false, text: 'the game tab closed' });
  });

  // Resume: same code after a reconnect (deploy, network blip), if the secret matches and nobody holds it.
  const h = await hello(ws);
  let code = '';
  let secret = '';
  if (h.code && h.secret && CODE_RE.test(h.code) && typeof h.secret === 'string') {
    const stored = await cache.get(`bridge:secret:${h.code}`).catch(() => null);
    if (stored && stored === sha(h.secret) && !(await relay.alive(h.code))) { code = h.code; secret = h.secret; }
  }
  if (!code) { code = newCode(); secret = randomBytes(24).toString('base64url'); }
  await cache.set(`bridge:secret:${code}`, sha(secret), RESUME_TTL).catch(() => {});
  if (closed) return;

  let n = 0;
  unserve = await relay.serve(code, (command) => new Promise<BridgeReply>((resolve) => {
    if (closed) { resolve({ ok: false, text: 'the game tab closed' }); return; }
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: 'the game tab did not answer' }); }, TIMEOUT_MS);
    pending.set(id, (r) => { clearTimeout(timer); pending.delete(id); resolve(r); });
    ws.send(JSON.stringify({ type: 'command', id, command }));
  }));
  // The socket may have closed while we were subscribing.
  if (closed) { await unserve(); return; }
  ws.send(JSON.stringify({ type: 'paired', code, secret, resumed: code === h.code }));
  ws.on('message', (data) => {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m?.type === 'result' && typeof m.id === 'string') pending.get(m.id)?.({ ok: m.ok === true, text: String(m.text ?? '').slice(0, 20_000) });
  });
}

function mcpFor(code: string, relay: Relay) {
  const mcp = new McpServer({ name: 'parkwright', version: '0.1.0' });
  const run = async (command: string) => {
    const r = await relay.request(code, command, WAIT_MS);
    if (!r) return { content: [{ type: 'text' as const, text: 'The park is not connected: open the game tab (the link resumes automatically) or run `bridge` for a new one.' }], isError: true };
    return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok };
  };
  mcp.registerTool('pw', {
    title: 'Park terminal',
    description: 'Run one Parkwright terminal command against the park open in the player\'s browser, e.g. "help", "park", "map 24 38 --r 9", "ride list", "ride place carousel", "path place 24 30 24 40", "coaster start 10 10 --dir 1", "finance". Every command is validated by the game; errors explain what to fix.',
    inputSchema: { command: z.string().min(1).max(200).describe('The command, with or without the leading "pw"') },
  }, async ({ command }) => run(command));
  mcp.registerTool('mod_apply', {
    title: 'Load a mod',
    description: 'Validate a Parkwright mod (data only: rideTypes, items, rules — same schema as `mod ai`) and load it into the player\'s park. The game clamps numbers and namespaces ids; the reply lists what loaded and any warnings. Build with the new types using pw ("ride types" shows their ids).',
    inputSchema: { mod: z.record(z.string(), z.unknown()).describe('The mod JSON object: {name, summary, rideTypes, items, rules}') },
  }, async ({ mod }) => {
    const json = JSON.stringify(mod);
    if (json.length > MOD_MAX) return { content: [{ type: 'text' as const, text: `mod is too large (${json.length} chars, max ${MOD_MAX})` }], isError: true };
    return run(`mod load ${json}`);
  });
  mcp.registerTool('park_overview', {
    title: 'Park overview',
    description: 'Status, rides, finances and what visitors are thinking — a good first call.',
    inputSchema: {},
  }, async () => {
    // In parallel, so the whole call stays well inside the HTTP request timeout.
    const cmds = ['park', 'ride list', 'finance', 'visitors thoughts'];
    const rs = await Promise.all(cmds.map((c) => relay.request(code, c, WAIT_MS)));
    if (rs.some((r) => !r)) return { content: [{ type: 'text' as const, text: 'The park is not connected.' }], isError: true };
    return { content: [{ type: 'text' as const, text: cmds.map((c, i) => `> pw ${c}\n${rs[i]!.text}`).join('\n\n') }] };
  });
  return mcp;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > 64_000) throw new Error('too large'); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : undefined;
}

/** HTTP side: MCP endpoint /mcp/<code> and a plain JSON endpoint /api/bridge/<code>/command. */
export async function handleBridge(req: IncomingMessage, res: ServerResponse, path: string, relay: Relay, cache: Cache): Promise<boolean> {
  const mcpMatch = path.match(/^\/mcp\/([a-z2-7]+)$/);
  const apiMatch = path.match(/^\/api\/bridge\/([a-z2-7]+)\/command$/);
  if (!mcpMatch && !apiMatch) return false;
  const code = (mcpMatch ?? apiMatch)![1];
  if (!CODE_RE.test(code)) { res.writeHead(404).end(); return true; }
  const n = await cache.incr(`bridge:rl:${code}`, 60).catch(() => 0);
  if (n > PER_MIN) { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'too many commands — slow down' })); return true; }

  if (apiMatch) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    let body: any;
    try { body = await readBody(req); } catch { res.writeHead(400).end(); return true; }
    const command = typeof body?.command === 'string' ? body.command.slice(0, 200) : '';
    if (!command) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'command required' })); return true; }
    const r = await relay.request(code, command, WAIT_MS);
    res.writeHead(r ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(r ?? { ok: false, text: 'no park is paired with that code (is the tab still open?)' }));
    return true;
  }

  // Stateless MCP over Streamable HTTP: a fresh server + transport per request.
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return true; }
  let body: unknown;
  try { body = await readBody(req); } catch { res.writeHead(400).end(); return true; }
  const mcp = mcpFor(code, relay);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void mcp.close(); });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
  return true;
}
