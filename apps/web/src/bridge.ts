// `bridge` in the park terminal: pair this tab with Claude Code (or any MCP client).
// Commands arrive over a WebSocket, run through the same pw parser and validated actions as yours,
// and are echoed in the terminal so you can watch.
import { runCommand } from '@parkwright/sim';
import type { Game } from './game.ts';
import type { ParkTerminal } from './ui/terminal.ts';

const C = { dim: '\x1b[2m', ok: '\x1b[32m', err: '\x1b[31m', acc: '\x1b[33m', cl: '\x1b[38;5;209m', off: '\x1b[0m' };

export class Bridge {
  private ws: WebSocket | null = null;
  code: string | null = null;

  constructor(private game: Game, private term: ParkTerminal, private onFocus: (x: number, y: number) => void) {
    term.extra.set('bridge', { usage: 'bridge [off]   (let Claude Code play this park over MCP)', run: (a) => this.command(a) });
  }

  private async command(arg: string) {
    const t = this.term;
    if (arg.trim() === 'off') {
      this.ws?.close();
      this.ws = null;
      this.code = null;
      t.writeln('bridge closed — the old link no longer works');
      return;
    }
    if (this.game.visiting) { t.writeln(`${C.err}✗ you're visiting someone else's park${C.off}`); return; }
    if (this.code) { this.instructions(this.code); return; }
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/bridge`;
    const ws = new WebSocket(url);
    this.ws = ws;
    const code = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === 'paired') { clearTimeout(timer); resolve(m.code); }
        if (m.type === 'command') this.run(m.id, String(m.command));
      };
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
    if (!code) { t.writeln(`${C.err}✗ couldn't reach the bridge server${C.off}`); ws.close(); return; }
    this.code = code;
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.code = null; t.writeln(`\r\n${C.dim}bridge disconnected — run bridge for a new link${C.off}`); } };
    this.instructions(code);
  }

  private instructions(code: string) {
    const t = this.term;
    const mcp = `${location.origin}/mcp/${code}`;
    t.writeln(`${C.cl}bridge open.${C.off} Claude Code can play this park while this tab stays open. In a shell:`);
    t.writeln(`  ${C.acc}claude mcp add --transport http parkwright ${mcp}${C.off}`);
    t.writeln(`${C.dim}then ask Claude: "use the parkwright tools to build me a food court". The link is the only key — don't share it. bridge off revokes it.${C.off}`);
  }

  private run(id: string, command: string) {
    const r = runCommand(this.game.park, command);
    const t = this.term;
    t.writeln(`\r\n${C.cl}claude ›${C.off} ${C.dim}pw ${command.replace(/^pw\s+/, '')}${C.off}`);
    for (const l of r.text.split('\n').slice(0, 4)) t.writeln(`  ${r.ok ? '' : C.err}${l}${C.off}`);
    if (r.focus) this.onFocus(r.focus.x, r.focus.y);
    this.ws?.send(JSON.stringify({ type: 'result', id, ok: r.ok, text: r.text }));
  }
}
