// /api/ai/* — the park manager and the mod designer, on NEAR AI Cloud (TEE-attested model).
// The server only relays: the browser runs the returned pw commands against its own park (validated
// by the sim like any player input) and can check each reply's TEE signature itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseContent, contentCatalog } from '@parkwright/content';
import { COMMANDS } from '@parkwright/sim';
import { managerMessages, modMessages, parseJsonReply, type ManagerTurn, type Message, type NearAiClient } from '@parkwright/ai';
import type { Cache } from './cache.ts';
import { clientIp } from './parks.ts';

const MAX_BODY = 64_000;
/** NEAR AI credits are finite: a hard daily ceiling across all players. */
const DAILY_CALLS = Number(process.env.AI_DAILY_CALLS ?? 400);
const PER_MIN = { manager: 12, mod: 4 } as const;

export interface AiDeps { ai?: NearAiClient; cache: Cache }

const HELP = Object.values(COMMANDS).map((c) => `pw ${c.usage} — ${c.summary}`).join('\n');
const CATALOG = contentCatalog(baseContent);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Error('request too large'); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Keep only what the manager may return: a short message, ≤5 short commands, a done flag. */
export function cleanTurn(raw: any): ManagerTurn {
  const commands = (Array.isArray(raw?.commands) ? raw.commands : [])
    .filter((c: unknown): c is string => typeof c === 'string')
    .map((c: string) => c.replace(/[\r\n]+/g, ' ').trim().slice(0, 120))
    .filter((c: string) => c.length > 0)
    .slice(0, 5);
  return { say: str(raw?.say, 300) || '…', commands, done: raw?.done === true || commands.length === 0 };
}

async function allow(cache: Cache, req: IncomingMessage, kind: keyof typeof PER_MIN): Promise<string | null> {
  const ip = await cache.incr(`ai:${kind}:${clientIp(req)}`, 60).catch(() => 0);
  if (ip > PER_MIN[kind]) return 'slow down — try again in a minute';
  const day = await cache.incr(`ai:day:${new Date().toISOString().slice(0, 10)}`, 26 * 3600).catch(() => 0);
  if (day > DAILY_CALLS) return "the park AI has used today's budget — try again tomorrow";
  return null;
}

export async function handleAi(req: IncomingMessage, res: ServerResponse, path: string, deps: AiDeps): Promise<boolean> {
  if (!path.startsWith('/api/ai/')) return false;
  const { ai, cache } = deps;
  if (path === '/api/ai/status' && req.method === 'GET') { json(res, 200, { enabled: !!ai, model: ai?.model ?? null }); return true; }
  if (!ai) { json(res, 503, { error: 'the park AI is not configured on this server' }); return true; }

  if (path === '/api/ai/attestation' && req.method === 'GET') {
    // Signing keys vouched for by the model's attestation report; cached, it changes rarely.
    let body = await cache.get('ai:attestation').catch(() => null);
    if (!body) {
      try { body = JSON.stringify({ model: ai.model, signers: await ai.attestedSigners() }); await cache.set('ai:attestation', body, 3600).catch(() => {}); }
      catch (e) { json(res, 502, { error: (e as Error).message }); return true; }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  }

  if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
  let body: any;
  try { body = await readJson(req); } catch (e) { json(res, 400, { error: (e as Error).message || 'body must be JSON' }); return true; }

  if (path === '/api/ai/manager') {
    const why = await allow(cache, req, 'manager');
    if (why) { json(res, 429, { error: why }); return true; }
    const goal = str(body.goal, 300).trim();
    if (!goal) { json(res, 400, { error: 'say what you want the manager to do' }); return true; }
    const state = str(body.state, 12_000);
    const transcript: Message[] = (Array.isArray(body.transcript) ? body.transcript : []).slice(-12)
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m: any) => ({ role: m.role, content: str(m.content, 4000) }));
    try {
      const { content, proof } = await ai.completeJson(managerMessages(HELP, goal, state, transcript));
      let turn: ManagerTurn;
      try { turn = cleanTurn(parseJsonReply(content)); } catch { turn = { say: 'I lost my train of thought — try again.', commands: [], done: true }; }
      json(res, 200, { turn, raw: content, proof });
    } catch (e) { json(res, 502, { error: (e as Error).message }); }
    return true;
  }

  if (path === '/api/ai/mod') {
    const why = await allow(cache, req, 'mod');
    if (why) { json(res, 429, { error: why }); return true; }
    const request = str(body.request, 400).trim();
    if (!request) { json(res, 400, { error: 'describe the mod you want' }); return true; }
    try {
      const { content, proof } = await ai.completeJson(modMessages(CATALOG, request), 1800, 60_000);
      let draft: unknown;
      try { draft = parseJsonReply(content); } catch { json(res, 502, { error: 'the AI did not return a mod — try rephrasing', proof }); return true; }
      // The browser validates and clamps the draft (validateMod) before anything loads.
      json(res, 200, { draft, proof });
    } catch (e) { json(res, 502, { error: (e as Error).message }); }
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
