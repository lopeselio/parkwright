// Name each request by its route (not just "GET"), so Application Insights groups timings and failures
// per endpoint. Ids and secrets in paths become placeholders, and unknown paths collapse into one bucket,
// so the names stay few (no per-park or per-bridge-code cardinality).
import { trace } from '@opentelemetry/api';

const EXACT = new Set(['/api/health', '/api/leaderboard', '/api/parks', '/api/ai/attestation', '/api/ai/manager', '/api/ai/mod', '/api/ai/status', '/api/claude/status', '/ws/bridge', '/ws/claude']);

export function routeOf(path: string): string {
  if (EXACT.has(path)) return path;
  let m = path.match(/^\/api\/parks\/[^/]+(\/[a-z/]+)?$/);
  if (m) return `/api/parks/:id${m[1] ?? ''}`;
  if (/^\/api\/players\/[^/]+$/.test(path)) return '/api/players/:account';
  if (/^\/api\/bridge\/[^/]+/.test(path)) return '/api/bridge/:code';
  if (/^\/mcp\/[^/]+/.test(path)) return '/mcp/:code';
  if (path.startsWith('/api/')) return '/api/*';
  m = path.match(/^\/(assets|models)\//);
  return m ? `/${m[1]}/*` : '/ (page)';
}

/** Rename the active request span (a no-op unless telemetry is on). */
export function nameRequest(method: string | undefined, path: string) {
  const span = trace.getActiveSpan();
  if (!span) return;
  const route = routeOf(path);
  span.setAttribute('http.route', route);
  span.updateName(`${method ?? 'GET'} ${route}`);
}
