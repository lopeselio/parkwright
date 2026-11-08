// `claude` in the park terminal (local only): your real Claude Code CLI, connected to this park
// through the bridge, working in mods/workspace/. Ctrl+] returns to the park terminal.
import type { Bridge } from './bridge.ts';
import type { ParkTerminal } from './ui/terminal.ts';

const C = { dim: '\x1b[2m', err: '\x1b[31m', cl: '\x1b[38;5;209m', off: '\x1b[0m' };

export class ClaudeTerminal {
  constructor(private term: ParkTerminal, private bridge: Bridge) {
    term.extra.set('claude', { usage: 'claude   (local only: your Claude Code CLI, to mod this park; Ctrl+] to leave)', run: () => this.open() });
  }

  private async open() {
    const t = this.term;
    const status = await fetch('/api/claude/status').then((r) => r.json()).catch(() => ({ enabled: false }));
    if (!status.enabled) {
      t.writeln(`${C.dim}The Claude terminal only runs on your own machine: start the server with PW_CLAUDE_TERMINAL=1 and open the game on localhost. On the hosted game, use bridge + claude mcp add instead.${C.off}`);
      return;
    }
    const code = await this.bridge.ensure();
    if (!code) { t.writeln(`${C.err}✗ couldn't open the park bridge${C.off}`); return; }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/claude`);
    let attached = false;
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        const { cols, rows } = t.size;
        ws.send(JSON.stringify({ type: 'start', code, cols, rows }));
        t.writeln(`${C.cl}claude${C.off} ${C.dim}— working in mods/workspace/ with your park's tools. Ctrl+] to come back.${C.off}`);
        attached = true;
        t.attach((d) => {
          if (d === '\x1d') { attached = false; t.writeln(`\r\n${C.dim}left Claude — back to the park terminal${C.off}`); t.detach(); ws.close(); return; } // Ctrl+]
          ws.send(JSON.stringify({ type: 'data', data: d }));
        });
      };
      // Output that arrives after you've left (the process winding down) is dropped, not printed over the prompt.
      ws.onmessage = (ev) => { if (!attached) return; try { const m = JSON.parse(String(ev.data)); if (m.type === 'data') t.write(m.data); } catch { /* ignore */ } };
      ws.onclose = () => { if (!attached) { resolve(); return; } attached = false; t.writeln(`\r\n${C.dim}left Claude — back to the park terminal${C.off}`); t.detach(); resolve(); };
      ws.onerror = () => { t.writeln(`${C.err}✗ couldn't start the Claude terminal${C.off}`); };
    });
  }
}
