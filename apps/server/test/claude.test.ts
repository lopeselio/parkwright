import { describe, expect, it } from 'vitest';
import { claudeTerminalEnabled, isLocalRequest } from '../src/claude.ts';

const req = (remoteAddress: string, host: string, origin?: string) => ({ socket: { remoteAddress }, headers: { host, ...(origin ? { origin } : {}) } }) as any;

describe('claude terminal gate', () => {
  it('is off unless PW_CLAUDE_TERMINAL=1', () => {
    expect(claudeTerminalEnabled()).toBe(false);
  });

  it('accepts only loopback peers with a localhost Host from a same-origin page', () => {
    expect(isLocalRequest(req('127.0.0.1', 'localhost:8811'))).toBe(true);
    expect(isLocalRequest(req('::1', '127.0.0.1:8811', 'http://127.0.0.1:8811'))).toBe(true);
    expect(isLocalRequest(req('10.0.0.5', 'localhost:8811'))).toBe(false); // not loopback
    expect(isLocalRequest(req('127.0.0.1', 'evil.example:8811'))).toBe(false); // DNS rebinding
    expect(isLocalRequest(req('127.0.0.1', 'localhost:8811', 'https://evil.example'))).toBe(false); // other site
  });
});
