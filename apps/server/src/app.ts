import { createServer, type Server } from 'node:http';
import { handleParks, type Deps } from './parks.ts';
import { serveStatic } from './static.ts';

export function createApp(deps: Deps, opts: { webDist: string; version: string }): Server {
  const statics = serveStatic(opts.webDist);
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, version: opts.version, store: deps.store.kind, cache: deps.cache.kind }));
        return;
      }
      if (path.startsWith('/api/')) {
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
