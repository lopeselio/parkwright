// `bridge` in the park terminal: pair this tab with Claude Code (or any MCP client).
// Commands arrive over a WebSocket, run through the same pw parser and validated actions as yours,
// and are echoed in the terminal so you can watch. The link survives reconnects (deploys, network
// blips): the tab resumes the same code with a secret kept in sessionStorage.
import { runCommand } from '@parkwright/sim';
import type { Game } from './game.ts';
import type { ParkTerminal } from './ui/terminal.ts';

const C = { dim: '\x1b[2m', ok: '\x1b[32m', err: '\x1b[31m', acc: '\x1b[33m', cl: '\x1b[38;5;209m', off: '\x1b[0m' };
const KEY = 'parkwright.bridge.v1';
/** Commands come from an untrusted MCP client: never let them write terminal control sequences. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export class Bridge {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry = 1000;
  code: string | null = null;

  constructor(private game: Game, private term: ParkTerminal, private onFocus: (x: number, y: number) => void) {
    term.extra.set('bridge', { usage: 'bridge [off]   (let Claude Code play this park over MCP)', run: (a) => this.command(a) });
    // A tab reloaded mid-session picks its link back up.
    if (this.saved()) { this.wanted = true; void this.connect(true); }
  }

  private saved(): { code: string; secret: string } | null {
    try { const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); return v?.code && v?.secret ? v : null; } catch { return null; }
  }

  private async command(arg: string) {
    const t = this.term;
    if (arg.trim() === 'off') {
      this.wanted = false;
      try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      this.ws?.close();
      this.ws = null;
      this.code = null;
      t.writeln('bridge closed — the old link no longer works');
      return;
    }
    if (this.game.visiting) { t.writeln(`${C.err}✗ you're visiting someone else's park${C.off}`); return; }
    if (this.code) { this.instructions(this.code); return; }
    this.wanted = true;
    if (!(await this.connect(false))) t.writeln(`${C.err}✗ couldn't reach the bridge server${C.off}`);
  }

  private connect(quiet: boolean): Promise<boolean> {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/bridge`;
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...(this.saved() ?? {}) }));
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === 'paired') {
          clearTimeout(timer);
          this.code = m.code;
          this.retry = 1000;
          try { sessionStorage.setItem(KEY, JSON.stringify({ code: m.code, secret: m.secret })); } catch { /* ignore */ }
          if (!quiet || !m.resumed) this.instructions(m.code);
          else this.term.writeln(`\r\n${C.dim}bridge reconnected — same link${C.off}`);
          resolve(true);
        }
        if (m.type === 'command') this.run(String(m.id), String(m.command));
      };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.code = null;
        if (!this.wanted) return;
        // Reconnect with backoff; the server hands back the same code if our secret matches.
        setTimeout(() => { if (this.wanted && !this.ws) void this.connect(true); }, this.retry);
        this.retry = Math.min(this.retry * 2, 30_000);
      };
    });
  }

  private instructions(code: string) {
    const t = this.term;
    const mcp = `${location.origin}/mcp/${code}`;
    t.writeln(`${C.cl}bridge open.${C.off} Claude Code can play this park while this tab stays open. In a shell:`);
    t.writeln(`  ${C.acc}claude mcp add --transport http parkwright ${mcp}${C.off}`);
    t.writeln(`${C.dim}then ask Claude: "use the parkwright tools to build me a food court". The link is the only key — don't share it. bridge off revokes it.${C.off}`);
  }

  private run(id: string, rawCommand: string) {
    const command = clean(rawCommand).slice(0, 200);
    let reply: { ok: boolean; text: string };
    if (this.game.visiting) reply = { ok: false, text: "The player is visiting someone else's park right now; their own park will be back when they return." };
    else {
      try { const r = runCommand(this.game.park, command); reply = { ok: r.ok, text: r.text }; if (r.focus) this.onFocus(r.focus.x, r.focus.y); }
      catch (e) { reply = { ok: false, text: `the game hit an error running that: ${(e as Error).message}` }; }
    }
    const t = this.term;
    t.writeln(`\r\n${C.cl}claude ›${C.off} ${C.dim}pw ${command.replace(/^pw\s+/, '')}${C.off}`);
    for (const l of reply.text.split('\n').slice(0, 4)) t.writeln(`  ${reply.ok ? '' : C.err}${clean(l)}${C.off}`);
    this.ws?.send(JSON.stringify({ type: 'result', id, ok: reply.ok, text: reply.text }));
  }
}
