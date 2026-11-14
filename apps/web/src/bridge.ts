// `bridge` in the park terminal: pair this tab with Claude Code (or any MCP client).
// Commands arrive over a WebSocket, run through the same pw parser and validated actions as yours,
// and are echoed in the terminal so you can watch. The link survives reconnects (deploys, network
// blips): the tab resumes the same code with a secret kept in sessionStorage.
import { validateMod } from '@parkwright/content';
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

  /** Make sure this tab has a live bridge; returns its code (used by the Claude terminal). */
  async ensure(): Promise<string | null> {
    if (this.code) return this.code;
    if (this.game.visiting) return null;
    this.wanted = true;
    return (await this.connect(false)) ? this.code : null;
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

  /** `mod load <json>` (from the mod_apply tool): validate exactly like `mod ai`, then load. */
  private loadMod(json: string): { ok: boolean; text: string } {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return { ok: false, text: 'mod is not valid JSON' }; }
    let v: ReturnType<typeof validateMod>;
    try { v = validateMod(raw, this.game.content); } catch (e) { return { ok: false, text: (e as Error).message }; }
    if (this.game.modWouldBlockClaim) return { ok: false, text: 'not loaded: Loading a mod now means this park can no longer be verified, so it won\'t settle or be claimable on NEAR (the replay applies mods from day 0). To keep a park claimable, start a New park, load the mod while it\'s paused on day 0, then build. The player can still load it from the game terminal with mod apply --anyway.' };
    const why = this.game.applyMod(v.mod);
    if (why) return { ok: false, text: why };
    const p = v.mod.pack;
    const lines = [
      `loaded mod ${p.name} (${p.id})`,
      ...p.rideTypes.map((t) => `  ride type ${t.id}: ${t.name}, ${t.kind}, cost ${t.cost / 100} cr${t.kind === 'flat' ? `, E${t.ratings.e / 100} I${t.ratings.i / 100} N${t.ratings.n / 100}` : ''}`),
      ...p.items.map((i) => `  item ${i.id}: ${i.name}`),
      ...v.mod.rules.map((r) => `  rule on ${r.on}: ${'veto' in r ? 'veto' : `cost ×${r.cost}`}`),
      ...v.warnings.map((w) => `  note: ${w}`),
    ];
    return { ok: true, text: lines.join('\n') };
  }

  private run(id: string, rawCommand: string) {
    const isMod = rawCommand.startsWith('mod load ');
    // Commands come from an untrusted client: strip control characters; mods get a larger bound.
    const command = isMod ? rawCommand.slice(0, 20_000) : clean(rawCommand).slice(0, 200);
    let reply: { ok: boolean; text: string };
    if (this.game.visiting) reply = { ok: false, text: "The player is visiting someone else's park right now; their own park will be back when they return." };
    else if (isMod) reply = this.loadMod(command.slice('mod load '.length));
    else {
      try { const r = runCommand(this.game.park, command); reply = { ok: r.ok, text: r.text }; if (r.focus) this.onFocus(r.focus.x, r.focus.y); }
      catch (e) { reply = { ok: false, text: `the game hit an error running that: ${(e as Error).message}` }; }
    }
    const t = this.term;
    t.writeln(`\r\n${C.cl}claude ›${C.off} ${C.dim}${isMod ? 'mod load …' : `pw ${command.replace(/^pw\s+/, '')}`}${C.off}`);
    for (const l of reply.text.split('\n').slice(0, 4)) t.writeln(`  ${reply.ok ? '' : C.err}${clean(l)}${C.off}`);
    this.ws?.send(JSON.stringify({ type: 'result', id, ok: reply.ok, text: reply.text }));
  }
}
