import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { serveStatic } from './static.ts';

const PORT = Number(process.env.PORT ?? 8790);
const WEB_DIST = resolve(process.env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname);
const VERSION = process.env.APP_VERSION ?? 'dev';

const statics = serveStatic(WEB_DIST);

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '/';
    if (url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    if (url.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (await statics(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end('server error');
  }
});

server.listen(PORT, () => console.log(`parkwright server ${VERSION} on :${PORT}, serving ${WEB_DIST}`));
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
