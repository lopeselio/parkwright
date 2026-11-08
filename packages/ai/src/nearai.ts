// Signed completions on NEAR AI Cloud (server side: it holds the API key).
// We keep the exact request/response bytes so the TEE signature can be checked later by anyone.
// Non-streaming + x-no-aliasing → signature_kind "provider_tee" (signed inside the model TEE).
import type { ChatSignature, ProofBundle } from './verify.ts';

export const NEARAI_API = process.env.NEARAI_BASE_URL?.replace(/\/v1\/?$/, '') ?? 'https://cloud-api.near.ai';

export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

class Retryable extends Error {}

export class NearAiClient {
  constructor(private apiKey: string, readonly model: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, 'Accept-Encoding': 'identity', ...extra };
  }

  /** A JSON-mode completion plus its proof (signature fetched after; may lag briefly). */
  async completeJson(messages: Message[], maxTokens = 900, timeoutMs = 45_000): Promise<{ content: string; proof: ProofBundle }> {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
    };
    let r: { requestBody: string; responseBody: string; chatId: string; content: string };
    try { r = await this.once(JSON.stringify(body), timeoutMs); }
    catch (e) { if (!(e instanceof Retryable)) throw e; r = await this.once(JSON.stringify(body), timeoutMs * 1.5); }
    const signature = await this.signature(r.chatId).catch(() => null);
    return { content: r.content, proof: { model: this.model, chatId: r.chatId, requestBody: r.requestBody, responseBody: r.responseBody, signature } };
  }

  private async once(requestBody: string, timeoutMs: number) {
    let res: Response;
    try {
      res = await fetch(`${NEARAI_API}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', 'x-no-aliasing': 'true' }),
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new Retryable(`NEAR AI unreachable: ${(e as Error).message}`); }
    if (res.status >= 500) throw new Retryable(`NEAR AI HTTP ${res.status}`);
    const responseBody = await res.text();
    if (res.status === 402) throw new Error('NEAR AI credits are used up for this server');
    if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}: ${responseBody.slice(0, 200)}`);
    const json = JSON.parse(responseBody);
    return { requestBody, responseBody, chatId: json.id as string, content: (json.choices?.[0]?.message?.content ?? '') as string };
  }

  /** Signatures can lag or live on another TEE node briefly: retry a few times. */
  async signature(chatId: string, attempts = 6): Promise<ChatSignature | null> {
    const url = `${NEARAI_API}/v1/signature/${chatId}?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`;
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(url, { headers: this.headers({ Accept: 'application/json' }) }).catch(() => null);
      if (res?.ok) {
        const j = (await res.json()) as ChatSignature & { error_code?: string };
        if (j.signature && !j.error_code) return j;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return null;
  }

  /** Signing addresses the model's attestation report vouches for. */
  async attestedSigners(): Promise<string[]> {
    const res = await fetch(`${NEARAI_API}/v1/attestation/report?model=${encodeURIComponent(this.model)}&signing_algo=ecdsa`, { headers: this.headers({ Accept: 'application/json' }) });
    if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
    const j = (await res.json()) as any;
    const all = [j.signing_address, ...(j.all_attestations ?? []).map((a: any) => a.signing_address), ...(j.model_attestations ?? []).map((a: any) => a.signing_address)];
    return [...new Set(all.filter((x: unknown): x is string => typeof x === 'string').map((x) => x.toLowerCase()))];
  }
}

/** Parse a model's JSON reply, tolerating code fences or leading prose. */
export function parseJsonReply<T>(content: string): T {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
  throw new Error('the model did not return JSON');
}
