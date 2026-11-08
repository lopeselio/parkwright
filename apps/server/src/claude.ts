// The Claude terminal (local only): your real `claude` CLI inside the game's terminal, for modding.
//
// Off unless the server runs with PW_CLAUDE_TERMINAL=1 — never set in the hosted image. Even then only
// a loopback socket, with a localhost Host header (no DNS rebinding) from a same-origin page, may open it.
// Claude runs in mods/workspace/ with ONLY: this tab's park tools (pw, park_overview, mod_apply over the
// MCP bridge) and file Read/Write/Edit/Glob/Grep. Bash and web tools are disallowed; anything else it
// wants still asks you in the terminal (no --dangerously-skip-permissions).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Relay } from './relay.ts';

export const claudeTerminalEnabled = () => process.env.PW_CLAUDE_TERMINAL === '1';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Strictly local: loopback peer, localhost Host header, same-origin page (if any Origin is sent). */
export function isLocalRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

const GUIDE = `You are helping the player mod Parkwright, a theme-park builder, from inside the game.
Tools: mcp__parkwright__pw runs any park terminal command against their open park (try "help", "ride types", "map", "ride place <type>"); mcp__parkwright__park_overview summarises the park; mcp__parkwright__mod_apply loads a mod.
A mod is DATA ONLY (no code): {"name", "summary", "rideTypes": [...], "items": [...], "rules": [...]}. Call "pw ride types" to see existing types and their numbers; keep new ones balanced. Ride kinds: flat (size 1-4 x 1-4), stall (1x1, sells an item), facility (1x1). Models: carousel, teacups, wheel, swings, droptower, spookwalk, stall, restroom. Rules: {"on": "ride.build"|"path.place"|"scenery.place"|"staff.hire"|"marketing.start", "when": {"type"?: id, "kind"?: kind}, "cost": 0.5-5} or {"on", "when", "veto": "reason"}.
Workflow: save each mod as a .json file in this folder (so the player keeps it), then call mod_apply with it, read the reply (ids are namespaced as mod-<name>--<id>, numbers may be clamped), then try it in the park with pw (e.g. "ride place <new id>"). Explain what you made in a sentence or two.`;

let active: ChildProcess | null = null;

export function attachClaudeTerminal(server: Server, relay: Relay, port: number, repoRoot: string) {
  if (!claudeTerminalEnabled()) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws/claude') return; // other upgrade handlers run too
    if (!isLocalRequest(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      void session(ws, relay, port, repoRoot).catch(() => ws.terminate());
    });
  });
  console.log('[claude] local Claude terminal enabled (PW_CLAUDE_TERMINAL=1)');
}

async function session(ws: WebSocket, relay: Relay, port: number, repoRoot: string) {
  const start = await new Promise<{ code: string; cols: number; rows: number } | null>((res) => {
    const t = setTimeout(() => res(null), 5000);
    ws.once('message', (d) => { clearTimeout(t); try { const m = JSON.parse(String(d)); res(m?.type === 'start' ? m : null); } catch { res(null); } });
  });
  const say = (s: string) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'data', data: s }));
  if (!start || !/^[a-z2-7]{26}$/.test(String(start.code))) { say('\r\nno park bridge — run `bridge` first\r\n'); ws.close(); return; }
  if (!(await relay.alive(start.code))) { say('\r\nthis tab\'s park bridge is not connected\r\n'); ws.close(); return; }
  if (active) { say('\r\na Claude session is already running in another tab\r\n'); ws.close(); return; }

  const workspace = resolve(repoRoot, 'mods', 'workspace');
  mkdirSync(workspace, { recursive: true });
  const mcpConfig = join(workspace, '.parkwright-mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { parkwright: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${start.code}` } } }, null, 2), { mode: 0o600 });

  const cols = Math.max(40, Math.min(300, Number(start.cols) || 100));
  const rows = Math.max(10, Math.min(120, Number(start.rows) || 30));
  const args = [
    'claude',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__parkwright__pw', 'mcp__parkwright__park_overview', 'mcp__parkwright__mod_apply', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch',
    '--append-system-prompt', GUIDE,
  ];
  // A real terminal without native Node modules: a tiny Python pty helper (python3 ships with macOS).
  const helper = resolve(repoRoot, 'apps', 'server', 'pty-helper.py');
  const child = spawn('python3', [helper, String(cols), String(rows), ...args], { cwd: workspace, env: { ...process.env, TERM: 'xterm-256color' } });
  active = child;
  child.stdout?.on('data', (b: Buffer) => say(b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => say(b.toString('utf8')));
  child.on('error', (e) => { say(`\r\ncouldn't start claude: ${e.message}\r\n`); ws.close(); });
  child.on('exit', (codeN) => { if (active === child) active = null; say(`\r\n[claude exited${codeN ? ` (${codeN})` : ''}]\r\n`); ws.close(); });
  ws.on('message', (d) => {
    try { const m = JSON.parse(String(d)); if (m?.type === 'data' && typeof m.data === 'string') child.stdin?.write(m.data); } catch { /* ignore */ }
  });
  ws.on('close', () => {
    if (active === child) active = null;
    if (child.exitCode === null) { child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref(); }
  });
}
