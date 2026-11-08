// The park bridge: Claude Code (or any MCP client) plays the park open in your browser.
//   browser  ──ws /ws/bridge──▶  server  ◀──MCP over HTTP /mcp/<code>── Claude Code
// The browser asks for a pairing code; the code is the only key (128 bits, valid while the tab is open).
// Every command runs in the browser through the same validated actions as a player's.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { Cache } from './cache.ts';
import type { BridgeReply, Relay } from './relay.ts';

const CODE_RE = /^[a-z2-7]{26}$/;
const TIMEOUT_MS = 15_000;
const PER_MIN = 90;
const newCode = () => {
  // RFC 4648 base32, lowercase: 26 chars ≈ 128 bits.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(26);
  return Array.from(bytes, (b) => alphabet[b & 31]).join('');
};

export function attachBridge(server: Server, relay: Relay) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws/bridge') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => void pair(ws, relay));
  });
}

async function pair(ws: WebSocket, relay: Relay) {
  const code = newCode();
  const pending = new Map<string, (r: BridgeReply) => void>();
  let n = 0;
  const unserve = await relay.serve(code, (command) => new Promise<BridgeReply>((resolve) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: 'the game tab did not answer' }); }, TIMEOUT_MS);
    pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    ws.send(JSON.stringify({ type: 'command', id, command }));
  }));
  ws.send(JSON.stringify({ type: 'paired', code }));
  const keepAlive = setInterval(() => { void relay.touch(code).catch(() => {}); if (ws.readyState === ws.OPEN) ws.ping(); }, 20_000);
  ws.on('message', (data) => {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m?.type === 'result' && typeof m.id === 'string') pending.get(m.id)?.({ ok: m.ok === true, text: String(m.text ?? '').slice(0, 20_000) });
  });
  ws.on('close', () => { clearInterval(keepAlive); void unserve(); for (const r of pending.values()) r({ ok: false, text: 'the game tab closed' }); });
}

function mcpFor(code: string, relay: Relay) {
  const mcp = new McpServer({ name: 'parkwright', version: '0.1.0' });
  const run = async (command: string) => {
    const r = await relay.request(code, command, TIMEOUT_MS);
    if (!r) return { content: [{ type: 'text' as const, text: 'The park is not connected: open the game and run `pw bridge` again for a fresh link.' }], isError: true };
    return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok };
  };
  mcp.registerTool('pw', {
    title: 'Park terminal',
    description: 'Run one Parkwright terminal command against the park open in the player\'s browser, e.g. "help", "park", "map 24 38 --r 9", "ride list", "ride place carousel", "path place 24 30 24 40", "coaster start 10 10 --dir 1", "finance". Every command is validated by the game; errors explain what to fix.',
    inputSchema: { command: z.string().min(1).max(200).describe('The command, with or without the leading "pw"') },
  }, async ({ command }) => run(command));
  mcp.registerTool('park_overview', {
    title: 'Park overview',
    description: 'Status, rides, finances and what visitors are thinking — a good first call.',
    inputSchema: {},
  }, async () => {
    const parts: string[] = [];
    for (const c of ['park', 'ride list', 'finance', 'visitors thoughts']) {
      const r = await relay.request(code, c, TIMEOUT_MS);
      if (!r) return { content: [{ type: 'text' as const, text: 'The park is not connected.' }], isError: true };
      parts.push(`> pw ${c}\n${r.text}`);
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] };
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
    const r = await relay.request(code, command, TIMEOUT_MS);
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
