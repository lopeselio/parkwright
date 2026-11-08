// Browser-safe helpers shared by the server and the client.
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

/** Parse a model's JSON reply, tolerating code fences or leading prose. */
export function parseJsonReply<T>(content: string): T {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
  throw new Error('the model did not return JSON');
}
