// The AI layer in the park terminal:
//   ask "<goal>" [--budget cr]   the park manager (NEAR AI, TEE) plays with pw commands, within a budget
//   mod ai "<request>"           design a mod; mod apply | mod list | mod remove <id> | mod discard
//   ai proofs                    download the signed request/response of every AI reply this session
// Every command the AI proposes runs through the same validated actions as a player's.
import { validateMod, type ModFile } from '@parkwright/content';
import { findRideType, runCommand } from '@parkwright/sim';
import { contentFromProof, verifyProof, type ProofBundle } from '@parkwright/ai/verify';
import { cleanTurn, parseJsonReply, type ManagerTurn } from '@parkwright/ai/prompts';
import type { Game } from './game.ts';
import type { ParkTerminal } from './ui/terminal.ts';

const C = { dim: '\x1b[2m', ok: '\x1b[32m', err: '\x1b[31m', acc: '\x1b[33m', ai: '\x1b[36m', mag: '\x1b[35m', off: '\x1b[0m' };
const MAX_TURNS = 8;

/**
 * What the manager may run. Building and looking only: no loans, fees, demolitions, firings or removals,
 * so a confused (or prompt-injected) model can't wreck the park — at worst it builds within budget.
 */
const ALLOWED = [/^(pw\s+)?(park|map|finance|visitors( thoughts)?|ride (list|types|info)|staff list|marketing list|coaster pieces)\b/,
  /^(pw\s+)?(ride (place|build|price|open)|path place|queue place|bin place|scenery place|staff hire)\b/];

/** Money the manager has committed, from the ledger (income and refunds never refill the budget). */
function committed(game: Game) {
  const l = game.s.ledgerTotal;
  return -(l.construction + l.marketing);
}

function args(line: string) {
  const flags: Record<string, string> = {};
  const rest = line.replace(/--(\w+)\s+("[^"]*"|\S+)/g, (_, k, v) => { flags[k] = v.replace(/^"|"$/g, ''); return ''; });
  return { text: rest.trim().replace(/^"(.*)"$/, '$1'), flags };
}

export class AiTerminal {
  proofs: ProofBundle[] = [];
  private signers: string[] | null = null;
  private pending: { mod: ModFile; warnings: string[] } | null = null;

  constructor(private game: Game, term: ParkTerminal) {
    term.extra.set('ask', { usage: 'ask "<goal>" [--budget 2000]', run: (a, t) => this.ask(a, t) });
    term.extra.set('mod', { usage: 'mod ai "<idea>" | apply | list | remove <id> | discard', run: (a, t) => this.mod(a, t) });
    term.extra.set('ai', { usage: 'ai proofs   (download signed AI replies)', run: (a, t) => this.ai(a, t) });
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  }

  /** Check a reply's TEE signature here in the browser; the attested keys come from the model's report. */
  private async proofLine(p: ProofBundle): Promise<string> {
    this.proofs.push(p);
    if (this.signers === null) {
      this.signers = await fetch('/api/ai/attestation').then((r) => r.json()).then((j) => (Array.isArray(j.signers) ? j.signers : [])).catch(() => []);
    }
    const checks = verifyProof(p, this.signers ?? []);
    const ok = checks.every((c) => c.ok);
    return ok ? `${C.dim}🔏 signed in a TEE by ${p.signature!.signing_address.slice(0, 10)}… — verified here (${checks.length} checks)${C.off}` : `${C.err}⚠ proof check failed: ${checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}${C.off}`;
  }

  private parkState(): string {
    return ['park', 'ride list', 'finance', 'visitors thoughts', `map ${this.game.s.gate[0]} ${this.game.s.gate[1] - 10} --r 10`]
      .map((c) => `> pw ${c}\n${runCommand(this.game.park, c).text}`).join('\n\n');
  }

  /** The reply exactly as the model signed it (falls back to the relayed copy only if the bytes are unreadable). */
  private signedTurn(r: any): ManagerTurn {
    try { return cleanTurn(parseJsonReply(contentFromProof(r.proof))); } catch { return cleanTurn(r.turn); }
  }

  private async ask(line: string, t: ParkTerminal) {
    const { text: goal, flags } = args(line);
    if (!goal) { t.writeln(`${C.err}✗ say what you want, e.g. ask "build a food court near the gate" --budget 1500${C.off}`); return; }
    if (this.game.visiting) { t.writeln(`${C.err}✗ you're visiting someone else's park${C.off}`); return; }
    const budgetCr = Number(flags.budget ?? 2000);
    if (!Number.isFinite(budgetCr) || budgetCr <= 0) { t.writeln(`${C.err}✗ --budget must be a positive number of credits${C.off}`); return; }
    const budget = Math.round(budgetCr * 100);
    const start = committed(this.game);
    const spent = () => committed(this.game) - start;
    const transcript: { role: 'user' | 'assistant'; content: string }[] = [];
    t.writeln(`${C.ai}park manager${C.off} ${C.dim}(NEAR AI, private TEE inference) — goal: ${goal}; budget ${budgetCr} cr; it can build and look, not demolish, borrow or change fees${C.off}`);
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      let r: any;
      try { r = await this.post('/api/ai/manager', { goal, state: this.parkState(), transcript }); }
      catch (e) { t.writeln(`${C.err}✗ ${(e as Error).message}${C.off}`); return; }
      // Act on what the model signed, not on the server's re-sent copy.
      const signed = this.signedTurn(r);
      t.writeln(`${C.ai}◆ ${signed.say}${C.off}`);
      t.writeln(await this.proofLine(r.proof));
      const results: string[] = [];
      for (const cmd of signed.commands) {
        const c = cmd.replace(/^pw\s+/, '');
        if (!ALLOWED.some((re) => re.test(c))) { results.push(`> ${cmd}\n(refused: the manager may only build and look)`); t.writeln(`${C.err}  ✗ refused: ${c}${C.off}`); continue; }
        // Before building, make sure the most it could cost still fits the budget.
        const m = c.match(/^ride (?:place|build) (\S+)/);
        const rideCost = m ? this.game.content.rideTypes[findRideType(this.game.content, m[1]) ?? '']?.cost ?? 0 : 0;
        if (spent() + rideCost > budget) { results.push(`> ${cmd}\n(skipped: over budget)`); t.writeln(`${C.acc}  skipped (over budget): ${c}${C.off}`); continue; }
        const q = runCommand(this.game.park, c);
        t.writeln(`${C.dim}  pw ${c}${C.off}`);
        for (const l of q.text.split('\n').slice(0, 6)) t.writeln(`  ${q.ok ? '' : C.err}${l}${C.off}`);
        results.push(`> ${cmd}\n${q.text}`);
        if (spent() >= budget) break;
      }
      transcript.push({ role: 'assistant', content: JSON.stringify(signed) }, { role: 'user', content: `RESULTS:\n${results.join('\n') || '(no commands)'}\n\nBudget left: ${((budget - spent()) / 100).toFixed(0)} cr.\n\nSTATE NOW:\n${this.parkState()}` });
      if (signed.done) break;
      if (spent() >= budget) { t.writeln(`${C.acc}budget used (${(spent() / 100).toFixed(0)} cr) — stopping${C.off}`); break; }
    }
    t.writeln(`${C.ai}manager done.${C.off} ${C.dim}spent ${(spent() / 100).toFixed(0)} of ${budgetCr} cr · ai proofs to download the signed replies${C.off}`);
  }

  private async mod(line: string, t: ParkTerminal) {
    const [verb, ...rest] = line.trim().split(/\s+/);
    if (verb === 'ai') {
      const { text: idea } = args(rest.join(' '));
      if (!idea) { t.writeln(`${C.err}✗ describe it, e.g. mod ai "a haunted drop tower and a hot cocoa cart"${C.off}`); return; }
      t.writeln(`${C.mag}mod designer${C.off} ${C.dim}(NEAR AI, private TEE inference) — ${idea}${C.off}`);
      let r: any;
      try { r = await this.post('/api/ai/mod', { request: idea }); }
      catch (e) { t.writeln(`${C.err}✗ ${(e as Error).message}${C.off}`); return; }
      t.writeln(await this.proofLine(r.proof));
      // Validate the draft exactly as the model signed it.
      let draft: unknown = r.draft;
      try { draft = parseJsonReply(contentFromProof(r.proof)); } catch { /* keep the relayed copy; it's validated the same way */ }
      try { this.pending = validateMod(draft, this.game.content); }
      catch (e) { t.writeln(`${C.err}✗ ${(e as Error).message}${C.off}`); return; }
      this.describe(this.pending.mod, this.pending.warnings, t);
      t.writeln(`${C.acc}type mod apply to load it, or mod discard${C.off}`);
      return;
    }
    if (verb === 'apply') {
      if (!this.pending) { t.writeln(`${C.err}✗ nothing to apply — try mod ai "<idea>"${C.off}`); return; }
      const why = this.game.applyMod(this.pending.mod);
      if (why) { t.writeln(`${C.err}✗ ${why}${C.off}`); return; }
      t.writeln(`${C.ok}✓ loaded ${this.pending.mod.pack.name}${C.off} — its rides are in the Rides/Stalls drawers and in pw ride types`);
      this.pending = null;
      return;
    }
    if (verb === 'discard') { this.pending = null; t.writeln('discarded'); return; }
    if (verb === 'list') {
      if (!this.game.mods.length) { t.writeln('No mods loaded. Try: mod ai "<idea>"'); return; }
      for (const m of this.game.mods) this.describe(m, [], t);
      return;
    }
    if (verb === 'remove') {
      const why = this.game.removeMod(rest.join(' '));
      t.writeln(why ? `${C.err}✗ ${why}${C.off}` : `${C.ok}✓ removed${C.off}`);
      return;
    }
    t.writeln(`usage: mod ai "<idea>" | mod apply | mod list | mod remove <id> | mod discard`);
  }

  private describe(m: ModFile, warnings: string[], t: ParkTerminal) {
    t.writeln(`${C.mag}${m.pack.name}${C.off} ${C.dim}(${m.pack.id})${C.off}${m.summary ? ` — ${m.summary}` : ''}`);
    for (const r of m.pack.rideTypes) t.writeln(`  ride  ${r.id.split('--')[1]}: ${r.name}, ${r.kind} ${r.size[0]}×${r.size[1]}, ${(r.cost / 100).toFixed(0)} cr${r.kind === 'flat' ? `, E${(r.ratings.e / 100).toFixed(1)} I${(r.ratings.i / 100).toFixed(1)} N${(r.ratings.n / 100).toFixed(1)}` : ''}${r.item ? `, sells ${r.item.split('--').pop()}` : ''}`);
    for (const i of m.pack.items) t.writeln(`  item  ${i.name}: ${i.need}, sells at ${(i.defaultPrice / 100).toFixed(2)} cr`);
    for (const r of m.rules) t.writeln(`  rule  ${r.on}${r.when.type ? ` ${r.when.type.split('--').pop()}` : ''}${r.when.kind ? ` (${r.when.kind})` : ''}: ${'veto' in r ? `blocked — "${r.veto}"` : `cost ×${r.cost}`}`);
    for (const w of warnings) t.writeln(`  ${C.dim}note: ${w}${C.off}`);
  }

  private async ai(line: string, t: ParkTerminal) {
    if (line.trim() !== 'proofs') { t.writeln('usage: ai proofs'); return; }
    if (!this.proofs.length) { t.writeln('No AI replies yet this session.'); return; }
    const blob = new Blob([JSON.stringify({ proofs: this.proofs, attestedSigners: this.signers }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `parkwright-ai-proofs-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    t.writeln(`${C.ok}✓ saved ${this.proofs.length} signed replies${C.off} ${C.dim}— each: model, exact request/response bytes, TEE signature${C.off}`);
  }
}
