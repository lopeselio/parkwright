import { createServer, type Server } from 'node:http';
import { handleParks, type Deps } from './parks.ts';
import { handleAi } from './ai.ts';
import type { NearAiClient } from '@parkwright/ai';
import { handleBridge } from './bridge.ts';
import { claudeTerminalEnabled, isLocalRequest } from './claude.ts';
import { LocalRelay, type Relay } from './relay.ts';
import { serveStatic } from './static.ts';

export function createApp(deps: Deps & { ai?: NearAiClient; relay?: Relay }, opts: { webDist: string; version: string }): Server {
  const relay = deps.relay ?? new LocalRelay();
  const statics = serveStatic(opts.webDist);
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, version: opts.version, store: deps.store.kind, cache: deps.cache.kind, settlement: !!deps.settler, ai: deps.ai?.model ?? null, bridge: relay.kind }));
        return;
      }
      if (path === '/api/claude/status') {
        // Only ever true for a local request to a server started with PW_CLAUDE_TERMINAL=1.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ enabled: claudeTerminalEnabled() && isLocalRequest(req) }));
        return;
      }
      if (path.startsWith('/mcp/') || path.startsWith('/api/bridge/')) {
        if (await handleBridge(req, res, path, relay, deps.cache)) return;
      }
      if (path.startsWith('/api/')) {
        if (await handleAi(req, res, path, { ai: deps.ai, cache: deps.cache })) return;
        if (await handleParks(req, res, path, deps)) return;
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (await statics(req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server error' }));
    }
  });
}
