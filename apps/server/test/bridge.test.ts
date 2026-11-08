import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { baseContent } from '@parkwright/content';
import { Park, runCommand } from '@parkwright/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachBridge } from '../src/bridge.ts';
import { createApp } from '../src/app.ts';
import { Layered, MemoryCache } from '../src/cache.ts';
import { LocalRelay } from '../src/relay.ts';
import { FileStore } from '../src/store.ts';

let base = '';
let server: ReturnType<typeof createApp>;
const relay = new LocalRelay();

beforeAll(async () => {
  const cache = new MemoryCache();
  server = createApp({ store: new FileStore('/tmp/pw-bridge-unused'), cache, docs: new Layered(cache), relay }, { webDist: '/tmp', version: 't' });
  attachBridge(server, relay, cache);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A stand-in for the browser tab: holds a park and answers commands like the real client. */
async function fakeTab(resume?: { code: string; secret: string }) {
  const park = Park.create(baseContent, 'meadow', 3, 'Bridge Park');
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/bridge');
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...(resume ?? {}) })));
  let secret = '';
  const code = await new Promise<string>((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.type === 'paired') { secret = m.secret; resolve(m.code); }
      if (m.type === 'command') { const r = runCommand(park, m.command); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: r.ok, text: r.text })); }
    });
  });
  return { park, ws, code, secret };
}

describe('park bridge', () => {
  it('pairs a tab with an unguessable code', async () => {
    const { ws, code } = await fakeTab();
    expect(code).toMatch(/^[a-z2-7]{26}$/);
    ws.close();
  });

  it('lets an MCP client (Claude Code) play the paired park', async () => {
    const { park, ws, code } = await fakeTab();
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${code}`)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['park_overview', 'pw']);
    const r: any = await client.callTool({ name: 'pw', arguments: { command: 'ride place carousel' } });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('built Brass Carousel');
    expect(park.s.rides).toHaveLength(1);
    const bad: any = await client.callTool({ name: 'pw', arguments: { command: 'ride build zeppelin 1 1' } });
    expect(bad.isError).toBe(true);
    const overview: any = await client.callTool({ name: 'park_overview', arguments: {} });
    expect(overview.content[0].text).toContain('> pw finance');
    await client.close();
    ws.close();
  });

  it('has a plain JSON endpoint too', async () => {
    const { ws, code } = await fakeTab();
    const r = (await (await fetch(`${base}/api/bridge/${code}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'park' }) })).json()) as any;
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Bridge Park');
    ws.close();
  });

  it('refuses unknown or closed codes', async () => {
    const { ws, code } = await fakeTab();
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const r = await fetch(`${base}/api/bridge/${code}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'park' }) });
    expect(r.status).toBe(404);
    expect((await fetch(`${base}/mcp/short`, { method: 'POST' })).status).toBe(404);
  });

  it('review: an oversized frame closes that socket instead of crashing the server', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/bridge');
    await new Promise((r) => ws.on('open', r));
    ws.send('x'.repeat(70_000));
    await new Promise((r) => ws.on('close', r));
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('review: refuses sockets opened by other sites', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/bridge', { headers: { origin: 'https://evil.example' } });
    const outcome = await new Promise((r) => { ws.on('open', () => r('open')); ws.on('error', () => r('refused')); });
    expect(outcome).toBe('refused');
  });

  it('review: a reconnecting tab keeps its link (so Claude Code config survives a deploy)', async () => {
    const first = await fakeTab();
    first.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await fakeTab({ code: first.code, secret: first.secret });
    expect(again.code).toBe(first.code);
    const r = (await (await fetch(`${base}/api/bridge/${again.code}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'park' }) })).json()) as any;
    expect(r.ok).toBe(true);
    // A wrong secret gets a fresh code instead.
    again.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const thief = await fakeTab({ code: first.code, secret: 'guess' });
    expect(thief.code).not.toBe(first.code);
    thief.ws.close();
  });
});
