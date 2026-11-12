import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.map', '.glb']);

/** Path under root, or null if the request tries to escape it. */
export function resolveSafe(root: string, urlPath: string): string | null {
  let p: string;
  try { p = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const full = normalize(join(root, p));
  return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null;
}

/**
 * Cache policy: Vite's hashed files under /assets/ never change → cache for a year, immutable.
 * index.html and other unhashed files → revalidate every time, so a deploy shows up at once.
 */
export function cacheControl(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

export function serveStatic(root: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = req.url ?? '/';
    let file = resolveSafe(root, url === '/' ? '/index.html' : url);
    if (!file) { res.writeHead(400).end(); return true; }
    let st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) {
      // SPA fallback for paths without an extension.
      if (extname(url.split('?')[0])) return false;
      file = join(root, 'index.html');
      st = await stat(file).catch(() => null);
      if (!st) return false;
    }
    const ext = extname(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const pathForCache = file.slice(root.length).split(sep).join('/');
    const headers: Record<string, string> = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': cacheControl(pathForCache),
      etag,
      'x-content-type-options': 'nosniff',
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return true; }
    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (gzip) headers['content-encoding'] = 'gzip';
    else headers['content-length'] = String(st.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    // pipeline() forwards errors and tears everything down if the client goes away or a read fails mid-response.
    const done = (err: NodeJS.ErrnoException | null) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('[static]', file, err.message);
      if (err) res.destroy();
    };
    if (gzip) pipeline(createReadStream(file), createGzip(), res, done);
    else pipeline(createReadStream(file), res, done);
    return true;
  };
}
