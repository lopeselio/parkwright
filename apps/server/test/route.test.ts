import { describe, expect, it } from 'vitest';
import { routeOf } from '../src/route.ts';

describe('request names for telemetry', () => {
  it('keeps known routes and replaces ids and codes with placeholders', () => {
    expect(routeOf('/api/leaderboard')).toBe('/api/leaderboard');
    expect(routeOf('/api/parks')).toBe('/api/parks');
    expect(routeOf('/api/parks/7fb49d0d75ad638c')).toBe('/api/parks/:id');
    expect(routeOf('/api/parks/7fb49d0d75ad638c/verify')).toBe('/api/parks/:id/verify');
    expect(routeOf('/api/parks/7fb49d0d75ad638c/claim/challenge')).toBe('/api/parks/:id/claim/challenge');
    expect(routeOf('/mcp/2x4y44l6dfj32dfvowhmyhao6n')).toBe('/mcp/:code');
    expect(routeOf('/api/bridge/abc/state')).toBe('/api/bridge/:code');
  });
  it('collapses everything else into a few buckets', () => {
    expect(routeOf('/api/whatever/123')).toBe('/api/*');
    expect(routeOf('/assets/main-Df6lwWD4.js')).toBe('/assets/*');
    expect(routeOf('/models/carousel.glb')).toBe('/models/*');
    expect(routeOf('/')).toBe('/ (page)');
    expect(routeOf('/some/random/path')).toBe('/ (page)');
  });
});
