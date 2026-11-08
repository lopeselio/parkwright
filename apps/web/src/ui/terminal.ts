import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { runCommand, type CliResult } from '@parkwright/sim';
import type { Game } from '../game.ts';

export type AgentHandler = (goal: string, term: ParkTerminal) => Promise<void>;

const C = { dim: '\x1b[2m', ok: '\x1b[32m', err: '\x1b[31m', acc: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' };

/** The in-game terminal. Same `pw` grammar as the AI manager and MCP. */
export class ParkTerminal {
  readonly term: Terminal;
  private fit = new FitAddon();
  private line = '';
  private history: string[] = [];
  private hIdx = -1;
  private busy = false;
  /** Extra top-level commands: `ask`, `mod`, `claude` … registered by the AI layer. */
  readonly extra = new Map<string, { usage: string; run: (args: string, t: ParkTerminal) => Promise<void> | void }>();
  onFocus: (x: number, y: number) => void = () => {};

  constructor(private game: Game, private host: HTMLElement) {
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#1d1b22', foreground: '#ece6d8', cursor: '#f2b84b', selectionBackground: '#4a4458' },
      convertEol: true,
      scrollback: 2000,
    });
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.term.onData((d) => this.input(d));
    new ResizeObserver(() => { try { this.fit.fit(); } catch { /* hidden */ } }).observe(host);
    this.writeln(`${C.acc}Parkwright terminal${C.off} — type ${C.cyan}help${C.off} for commands. Everything you can click, you can type.`);
    this.prompt();
  }

  writeln(s: string) { this.term.writeln(s); }
  write(s: string) { this.term.write(s); }
  prompt() { this.term.write(`\r\n${C.acc}pw›${C.off} `); }
  focus() { this.fit.fit(); this.term.focus(); }

  /** Show a command the UI ran, so clicks teach the grammar. */
  echo(cmd: string) {
    if (this.busy) return;
    this.term.write(`\r\x1b[2K${C.dim}${cmd}${C.off}`);
    this.prompt();
    this.term.write(this.line);
  }

  print(res: CliResult) {
    const color = res.ok ? '' : C.err;
    for (const l of res.text.split('\n')) this.writeln(color + l.replace(/^✓/, `${C.ok}✓${C.off}`) + C.off);
    if (res.focus) this.onFocus(res.focus.x, res.focus.y);
  }

  /** Run a line as if typed (used by agents too). Returns the result. */
  exec(line: string, actor = 'terminal'): CliResult {
    void actor;
    const res = runCommand(this.game.park, line);
    return res;
  }

  private async submit(raw: string) {
    const line = raw.trim();
    this.term.write('\r\n');
    if (!line) { this.prompt(); return; }
    this.history.unshift(line);
    this.hIdx = -1;
    const [head, ...rest] = line.replace(/^pw\s+/, '').split(/\s+/);
    if (head === 'clear') { this.term.clear(); this.prompt(); return; }
    if (head === 'help' && rest.length === 0) {
      this.print(this.exec('help'));
      for (const [k, v] of this.extra) this.writeln(`pw ${v.usage.padEnd(52)} ${C.dim}${k}${C.off}`);
      this.prompt();
      return;
    }
    const ext = this.extra.get(head);
    if (ext) {
      this.busy = true;
      try { await ext.run(rest.join(' '), this); } catch (e) { this.writeln(`${C.err}✗ ${(e as Error).message}${C.off}`); }
      this.busy = false;
      this.prompt();
      return;
    }
    this.print(this.exec(line));
    this.prompt();
  }

  /** Raw mode: every keystroke goes to `sink` (e.g. a Claude session) until detach(). */
  private sink: ((d: string) => void) | null = null;
  attach(sink: (d: string) => void) { this.sink = sink; this.busy = true; }
  /** Leave raw mode; the command that attached prints the next prompt when it finishes. */
  detach() { this.sink = null; }
  get size() { return { cols: this.term.cols, rows: this.term.rows }; }

  private input(d: string) {
    if (this.sink) { this.sink(d); return; }
    if (this.busy) return;
    if (d === '\r') { const l = this.line; this.line = ''; void this.submit(l); return; }
    if (d === '\x7f') { if (this.line) { this.line = this.line.slice(0, -1); this.term.write('\b \b'); } return; }
    if (d === '\x1b[A' || d === '\x1b[B') {
      this.hIdx = Math.max(-1, Math.min(this.history.length - 1, this.hIdx + (d === '\x1b[A' ? 1 : -1)));
      const next = this.hIdx >= 0 ? this.history[this.hIdx] : '';
      this.term.write('\r\x1b[2K' + `${C.acc}pw›${C.off} ` + next);
      this.line = next;
      return;
    }
    if (d === '\t') { this.complete(); return; }
    if (d === '\x03') { this.line = ''; this.term.write('^C'); this.prompt(); return; }
    if (d < ' ' && d !== '\t') return;
    this.line += d;
    this.term.write(d);
  }

  private complete() {
    const words = ['park', 'map', 'ride', 'path', 'queue', 'scenery', 'bin', 'staff', 'finance', 'visitors', 'marketing', 'loan', 'fee', 'help', 'clear', ...this.extra.keys()];
    const parts = this.line.split(' ');
    if (parts.length !== 1) return;
    const m = words.filter((w) => w.startsWith(parts[0]));
    if (m.length === 1) { const add = m[0].slice(parts[0].length) + ' '; this.line += add; this.term.write(add); }
  }
}
