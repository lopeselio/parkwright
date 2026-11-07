import { describe, expect, it } from 'vitest';
import { cacheControl, resolveSafe } from '../src/static.ts';

describe('static serving', () => {
  it('refuses paths that escape the web root', () => {
    expect(resolveSafe('/srv/web', '/../etc/passwd')).toBeNull();
    expect(resolveSafe('/srv/web', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveSafe('/srv/web', '/assets/app.js')).toBe('/srv/web/assets/app.js');
  });

  it('caches hashed assets forever and revalidates the page', () => {
    expect(cacheControl('/assets/index-abc123.js')).toContain('immutable');
    expect(cacheControl('/index.html')).toBe('no-cache');
    expect(cacheControl('/models/manifest.json')).toBe('no-cache');
  });
});
