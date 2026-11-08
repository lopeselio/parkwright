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
  attachBridge(server, relay);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A stand-in for the browser tab: holds a park and answers commands like the real client. */
async function fakeTab() {
  const park = Park.create(baseContent, 'meadow', 3, 'Bridge Park');
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/bridge');
  const code = await new Promise<string>((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.type === 'paired') resolve(m.code);
      if (m.type === 'command') { const r = runCommand(park, m.command); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: r.ok, text: r.text })); }
    });
  });
  return { park, ws, code };
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
});
