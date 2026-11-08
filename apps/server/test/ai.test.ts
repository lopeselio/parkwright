import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { cleanTurn } from '../src/ai.ts';
import { Layered, MemoryCache } from '../src/cache.ts';
import { FileStore } from '../src/store.ts';

let base = '';
let server: ReturnType<typeof createApp>;
const fakeAi = {
  model: 'test-model',
  completeJson: async () => ({ content: '{"say":"Building a carousel.","commands":["ride place carousel"],"done":false}', proof: { model: 'test-model', chatId: 'c1', requestBody: '{}', responseBody: '{}', signature: null } }),
  attestedSigners: async () => ['0xabc'],
} as any;

beforeAll(async () => {
  const cache = new MemoryCache();
  server = createApp({ store: new FileStore('/tmp/pw-ai-unused'), cache, docs: new Layered(cache), ai: fakeAi }, { webDist: '/tmp', version: 't' });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/ai', () => {
  it('returns a cleaned manager turn with its proof', async () => {
    const r = (await (await post('/api/ai/manager', { goal: 'add a ride', state: 'x' })).json()) as any;
    expect(r.turn).toEqual({ say: 'Building a carousel.', commands: ['ride place carousel'], done: false });
    expect(r.proof.chatId).toBe('c1');
  });

  it('rate-limits each client', async () => {
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await post('/api/ai/manager', { goal: 'g' })).status;
    expect(last).toBe(429);
  });

  it('requires a goal and serves attested signers', async () => {
    expect((await post('/api/ai/mod', {})).status).toBe(400);
    expect(((await (await fetch(base + '/api/ai/attestation')).json()) as any).signers).toEqual(['0xabc']);
  });
});

describe('cleanTurn', () => {
  it('keeps at most 5 short single-line commands and says done when there are none', () => {
    const t = cleanTurn({ say: 'x'.repeat(500), commands: ['a\nb', 1, '', ...Array(9).fill('ride list')], done: false });
    expect(t.say.length).toBe(300);
    expect(t.commands).toEqual(['a b', 'ride list', 'ride list', 'ride list', 'ride list']);
    expect(cleanTurn({ say: 'hi', commands: [] }).done).toBe(true);
    expect(cleanTurn('garbage').commands).toEqual([]);
  });
});
