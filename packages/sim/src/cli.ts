// `pw` — the park terminal. One grammar for the in-game terminal, the AI manager and MCP.
// pw <noun> <verb> [args…] [--flag value] [-o json]
import { ACTIONS, findRide, type ActionResult, type Focus } from './actions.ts';
import { parkValue, valueForMoney } from './economy.ts';
import { LEVEL_M, PIECES } from './coaster.ts';
import { idx, queueCapacity, SCENERY } from './map.ts';
import type { Park } from './park.ts';
import { placeRide } from './place.ts';
import { DAYS_PER_SEASON, DAYS_PER_WEEK, Tile, type LedgerCategory } from './types.ts';

export interface CliResult {
  ok: boolean;
  text: string;
  json?: unknown;
  focus?: Focus;
}

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, has = false;
  for (const ch of line.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function parseArgs(tokens: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-o') { flags.o = tokens[++i] ?? 'json'; continue; }
    if (t.startsWith('--')) {
      const [k, v] = t.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('--')) flags[k] = tokens[++i];
      else flags[k] = true;
      continue;
    }
    pos.push(t);
  }
  return { pos, flags };
}

const cr = (cents: number) => `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} cr`;
const rating = (x: number) => (x / 100).toFixed(2);

type Handler = (park: Park, pos: string[], flags: Record<string, string | true>) => CliResult;

interface Cmd {
  usage: string;
  summary: string;
  run: Handler;
}

function fromAction(park: Park, type: string, params: Record<string, unknown>): CliResult {
  const r: ActionResult = park.run(type, params, 'terminal');
  if (!r.ok) return { ok: false, text: `✗ ${r.error}${r.hint ? `\n  hint: ${r.hint}` : ''}` };
  const cost = r.cost > 0 ? ` (−${cr(r.cost)})` : '';
  return { ok: true, text: `✓ ${r.message ?? type}${cost}`, focus: r.focus, json: r.data };
}

const need = (pos: string[], n: number, usage: string): CliResult | null =>
  pos.length < n ? { ok: false, text: `✗ missing arguments\n  usage: pw ${usage}` } : null;

const statusLine = (park: Park) => {
  const s = park.s;
  const week = Math.floor(s.day / DAYS_PER_WEEK) % 4 + 1;
  const season = Math.floor(s.day / DAYS_PER_SEASON) + 1;
  return `${s.name} — season ${season}, week ${week}, day ${s.day + 1}. Cash ${cr(s.cash)}, loan ${cr(s.loan)}. Rating ${s.rating}/1000. ${s.visitors.length} visitors in the park.`;
};

export const COMMANDS: Record<string, Cmd> = {
  'park': {
    usage: 'park', summary: 'Park overview',
    run(park) {
      const s = park.s, c = park.c;
      const sc = c.scenarios[s.scenario];
      const o = sc.objective;
      const goal = o.kind === 'visitors' ? `${o.count} visitors with rating ≥ ${o.minRating} by day ${o.byDay}`
        : o.kind === 'parkValue' ? `park value ≥ ${cr(o.value)} by day ${o.byDay}`
        : o.kind === 'rideIncome' ? `ride income ≥ ${cr(o.perWeek)} a week`
        : o.kind === 'coasters' ? `${o.count} coasters with excitement ≥ ${rating(o.minExcitement)} by day ${o.byDay}` : 'none (sandbox)';
      const lines = [
        statusLine(park),
        `Entry fee ${cr(s.fee)}; rides are worth ${cr(valueForMoney(s))} more than they cost (keep the fee below that).`,
        `Park value ${cr(parkValue(s, c))}. Gate at ${s.gate[0]},${s.gate[1]}. Map ${s.w}×${s.h}.`,
        `Goal: ${goal} — ${s.objective.status}.`,
      ];
      return { ok: true, text: lines.join('\n'), json: { name: s.name, day: s.day, cash: s.cash, loan: s.loan, rating: s.rating, visitors: s.visitors.length, fee: s.fee, objective: s.objective }, focus: { x: s.gate[0], y: s.gate[1], label: 'Gate' } };
    },
  },
  'map': {
    usage: 'map [x y] [--r 8]', summary: 'ASCII map around a tile (# path, = queue, letters rides, * scenery, ~ litter, G gate)',
    run(park, pos, flags) {
      const s = park.s;
      const r = Math.min(16, Number(flags.r ?? 8));
      const cx = pos[0] !== undefined ? Number(pos[0]) : s.gate[0];
      const cy = pos[1] !== undefined ? Number(pos[1]) : s.gate[1] - r;
      const legend = new Map<number, string>();
      const lines: string[] = [];
      const x0 = Math.max(0, cx - r), x1 = Math.min(s.w - 1, cx + r), y0 = Math.max(0, cy - r), y1 = Math.min(s.h - 1, cy + r);
      lines.push('    ' + Array.from({ length: x1 - x0 + 1 }, (_, i) => ((x0 + i) % 10).toString()).join(''));
      for (let y = y0; y <= y1; y++) {
        let row = String(y).padStart(3) + ' ';
        for (let x = x0; x <= x1; x++) {
          const k = idx(s, x, y);
          let ch = '.';
          if (x === s.gate[0] && y === s.gate[1]) ch = 'G';
          else if (s.occ[k]) {
            const rid = s.occ[k];
            if (!legend.has(rid)) legend.set(rid, String.fromCharCode(65 + (legend.size % 26)));
            const ride = s.rides.find((q) => q.id === rid)!;
            ch = x === ride.ex && y === ride.ey ? legend.get(rid)!.toLowerCase() : legend.get(rid)!;
          } else if (s.tiles[k] === Tile.Path) ch = s.litter[k] > 2 ? '~' : s.bins[k] ? 'b' : '#';
          else if (s.tiles[k] === Tile.Queue) ch = '=';
          else if (s.scenery[k]) ch = '*';
          row += ch;
        }
        lines.push(row);
      }
      for (const [rid, ch] of legend) lines.push(`${ch} = ${s.rides.find((q) => q.id === rid)!.name} (lowercase = entrance)`);
      return { ok: true, text: lines.join('\n'), focus: { x: cx, y: cy } };
    },
  },
  'ride list': {
    usage: 'ride list', summary: 'All rides, stalls and facilities',
    run(park) {
      const s = park.s, c = park.c;
      if (!s.rides.length) return { ok: true, text: 'Nothing built yet. Try: pw ride types', json: [] };
      const rows = s.rides.map((r) => {
        const t = c.rideTypes[r.type];
        const rt = r.ratings && (t.kind === 'flat' || t.kind === 'track') ? ` E${rating(r.ratings.e)} I${rating(r.ratings.i)} N${rating(r.ratings.n)} worth ~${cr(r.value)}` : '';
        const q = t.kind === 'stall' ? '' : ` queue ${r.queue.length}/${queueCapacity(s, r)}`;
        return `#${r.id} ${r.name} [${r.status}] ${cr(r.price)}${rt}${q} rel ${Math.round(r.reliability / 100)}% · ${r.customers} customers, ${cr(r.income)} total`;
      });
      return { ok: true, text: rows.join('\n'), json: s.rides.map((r) => ({ id: r.id, name: r.name, type: r.type, status: r.status, price: r.price, value: r.value, ratings: r.ratings, queue: r.queue.length, reliability: r.reliability, customers: r.customers, income: r.income })) };
    },
  },
  'ride types': {
    usage: 'ride types', summary: 'What you can build',
    run(park) {
      const c = park.c;
      const sc = c.scenarios[park.s.scenario];
      const types = Object.values(c.rideTypes).filter((t) => !sc.rides.length || sc.rides.includes(t.id));
      const text = types.map((t) => `${t.id.padEnd(15)} ${t.name} — ${t.kind}, ${t.size[0]}×${t.size[1]}, ${cr(t.cost)}${t.kind === 'flat' ? `, E${rating(t.ratings.e)} I${rating(t.ratings.i)} N${rating(t.ratings.n)}` : ''}${t.item ? `, sells ${c.items[t.item].name}` : ''}`).join('\n');
      return { ok: true, text, json: types };
    },
  },
  'ride info': {
    usage: 'ride info <ride>', summary: 'Details and recent satisfaction for one ride',
    run(park, pos) {
      const r = findRide(park.s, pos.join(' '));
      if (!r) return { ok: false, text: `✗ no ride "${pos.join(' ')}"` };
      const sat = r.satisfaction.length ? Math.round((r.satisfaction.reduce((a, b) => a + b, 0) / (r.satisfaction.length * 3)) * 100) : null;
      const why = new Map<string, number>();
      for (const v of park.s.visitors) for (const t of v.thoughts) if (t.ride === r.id) why.set(t.kind, (why.get(t.kind) ?? 0) + 1);
      const lines = [
        `${r.name} (#${r.id}, ${park.c.rideTypes[r.type].name}) at ${r.x},${r.y}, entrance ${r.ex},${r.ey} — ${r.status}`,
        `Price ${cr(r.price)}; visitors value it at ~${cr(r.value)}${park.s.fee > 0 ? ' (half that, since they paid to get in)' : ''}.`,
        r.ratings ? `Excitement ${rating(r.ratings.e)}, intensity ${rating(r.ratings.i)}, nausea ${rating(r.ratings.n)}.` : r.track ? 'Not rated yet — close the circuit and run pw coaster test.' : 'Not rated.',
        ...(r.stats ? [`Track: ${r.stats.length} m, ${r.stats.duration} s, top speed ${r.stats.maxSpeed} m/s, ${r.stats.drops} drop(s) up to ${r.stats.maxDrop} m, ${r.stats.maxVertG}g/${r.stats.minVertG}g vertical, ${r.stats.maxLatG}g lateral, ${r.stats.airtime} s airtime.`] : []),
        `Reliability ${Math.round(r.reliability / 100)}%, last inspected day ${r.lastInspected + 1}. Queue ${r.queue.length}/${queueCapacity(park.s, r)}.`,
        `Satisfaction ${sat === null ? 'n/a' : sat + '%'}; ${r.customers} customers; ${cr(r.incomeWeek)} this week.`,
        ...[...why].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `  ${n}× "${k}"`),
      ];
      return { ok: true, text: lines.join('\n'), focus: { x: r.x, y: r.y, label: r.name }, json: r };
    },
  },
  'ride place': {
    usage: 'ride place <type> [--near x,y]', summary: 'Find room near the paths, build, and lay a path to the entrance (easiest way to add a ride)',
    run(park, pos, f) {
      if (!pos[0]) return { ok: false, text: '✗ missing ride type\n  usage: pw ride place <type> [--near x,y]' };
      let near: { x: number; y: number } | undefined;
      if (typeof f.near === 'string') { const [x, y] = f.near.split(',').map(Number); if (Number.isInteger(x) && Number.isInteger(y)) near = { x, y }; }
      const r = placeRide(park, pos[0], near);
      if (!r.ok) return { ok: false, text: `✗ ${r.message}` };
      const t = park.c.rideTypes[park.s.rides.find((x) => x.id === r.rideId)!.type];
      if (t.kind === 'flat' && r.rideId) park.run('ride.open', { ride: r.rideId }, 'terminal');
      return { ok: true, text: `✓ ${r.message}${t.kind === 'flat' ? ' — and opened it' : ''}`, focus: r.focus, json: { id: r.rideId } };
    },
  },
  'ride build': {
    usage: 'ride build <type> <x> <y> [--rot 0-3] [--name "…"]', summary: 'Build a ride, stall or facility (rot = entrance side: 0 N, 1 E, 2 S, 3 W)',
    run(park, pos, f) {
      return need(pos, 3, this.usage) ?? fromAction(park, 'ride.build', { type: pos[0], x: Number(pos[1]), y: Number(pos[2]), rot: f.rot !== undefined ? Number(f.rot) : undefined, name: typeof f.name === 'string' ? f.name : undefined });
    },
  },
  'ride price': { usage: 'ride price <ride> <cr>', summary: 'Set a ticket price', run(park, pos) { return need(pos, 2, this.usage) ?? fromAction(park, 'ride.price', { ride: pos.slice(0, -1).join(' '), price: pos[pos.length - 1] }); } },
  'ride open': { usage: 'ride open <ride>', summary: 'Open a ride', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'ride.open', { ride: pos.join(' ') }); } },
  'ride close': { usage: 'ride close <ride>', summary: 'Close a ride', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'ride.close', { ride: pos.join(' ') }); } },
  'ride demolish': { usage: 'ride demolish <ride>', summary: 'Demolish (half refund)', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'ride.demolish', { ride: pos.join(' ') }); } },
  'path place': {
    usage: 'path place <x> <y> [x2 y2] [--queue]', summary: 'Lay a path line or rectangle',
    run(park, pos, f) { return need(pos, 2, this.usage) ?? fromAction(park, 'path.place', { x: +pos[0], y: +pos[1], x2: pos[2] !== undefined ? +pos[2] : undefined, y2: pos[3] !== undefined ? +pos[3] : undefined, queue: !!f.queue }); },
  },
  'queue place': {
    usage: 'queue place <x> <y> [x2 y2]', summary: 'Lay queue tiles (attach to a ride entrance; each tile holds 8)',
    run(park, pos) { return need(pos, 2, this.usage) ?? fromAction(park, 'path.place', { x: +pos[0], y: +pos[1], x2: pos[2] !== undefined ? +pos[2] : undefined, y2: pos[3] !== undefined ? +pos[3] : undefined, queue: true }); },
  },
  'path remove': {
    usage: 'path remove <x> <y> [x2 y2]', summary: 'Remove path tiles',
    run(park, pos) { return need(pos, 2, this.usage) ?? fromAction(park, 'path.remove', { x: +pos[0], y: +pos[1], x2: pos[2] !== undefined ? +pos[2] : undefined, y2: pos[3] !== undefined ? +pos[3] : undefined }); },
  },
  'bin place': { usage: 'bin place <x> <y>', summary: 'Litter bin on a path', run(park, pos) { return need(pos, 2, this.usage) ?? fromAction(park, 'bin.place', { x: +pos[0], y: +pos[1] }); } },
  'scenery place': {
    usage: 'scenery place <kind> <x> <y> [x2 y2]', summary: `Plant scenery (${SCENERY.slice(1).map((s) => s.name.split(' ')[0]).join(', ')})`,
    run(park, pos) { return need(pos, 3, this.usage) ?? fromAction(park, 'scenery.place', { kind: pos[0], x: +pos[1], y: +pos[2], x2: pos[3] !== undefined ? +pos[3] : undefined, y2: pos[4] !== undefined ? +pos[4] : undefined }); },
  },
  'scenery remove': {
    usage: 'scenery remove <x> <y> [x2 y2]', summary: 'Clear scenery',
    run(park, pos) { return need(pos, 2, this.usage) ?? fromAction(park, 'scenery.remove', { x: +pos[0], y: +pos[1], x2: pos[2] !== undefined ? +pos[2] : undefined, y2: pos[3] !== undefined ? +pos[3] : undefined }); },
  },
  'staff list': {
    usage: 'staff list', summary: 'Who works here',
    run(park) {
      const s = park.s;
      if (!s.staff.length) return { ok: true, text: 'No staff. Try: pw staff hire handyman', json: [] };
      return { ok: true, text: s.staff.map((m) => `#${m.id} ${m.name} at ${m.tx},${m.ty}${m.task !== null ? ` → ${s.rides.find((r) => r.id === m.task)?.name}` : ''}`).join('\n'), json: s.staff };
    },
  },
  'staff hire': { usage: 'staff hire <handyman|mechanic|guard|entertainer>', summary: 'Hire staff', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'staff.hire', { role: pos[0] }); } },
  'staff fire': { usage: 'staff fire <name|id>', summary: 'Let staff go', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'staff.fire', { staff: pos.join(' ') }); } },
  'finance': {
    usage: 'finance', summary: 'This week and all-time ledger',
    run(park) {
      const s = park.s;
      const cats = Object.keys(s.ledgerTotal) as LedgerCategory[];
      const rows = cats.filter((k) => s.ledgerTotal[k] !== 0).map((k) => `${k.padEnd(13)} ${cr(s.ledgerWeek[k]).padStart(12)} ${cr(s.ledgerTotal[k]).padStart(14)}`);
      const last = s.history.slice(-7);
      const inc = last.reduce((a, d) => a + d.income, 0), cost = last.reduce((a, d) => a + d.costs, 0);
      return { ok: true, text: [`${'category'.padEnd(13)} ${'this week'.padStart(12)} ${'all time'.padStart(14)}`, ...rows, `Last 7 days: income ${cr(inc)}, costs ${cr(cost)}, net ${cr(inc - cost)}.`, statusLine(park)].join('\n'), json: { week: s.ledgerWeek, total: s.ledgerTotal, cash: s.cash, loan: s.loan } };
    },
  },
  'visitors': {
    usage: 'visitors [--n 8]', summary: 'Sample of visitors and how they feel',
    run(park, _p, f) {
      const vs = park.s.visitors.slice(0, Number(f.n ?? 8));
      if (!vs.length) return { ok: true, text: 'No visitors yet.', json: [] };
      const mood = (h: number) => (h > 200 ? 'delighted' : h > 150 ? 'happy' : h > 100 ? 'okay' : h > 60 ? 'unhappy' : 'miserable');
      return { ok: true, text: vs.map((v) => `${v.name} — ${mood(v.happy)}, ${cr(v.cash)} left, ${v.mode}${v.thoughts[0] ? `: "${v.thoughts[0].kind}"` : ''}`).join('\n'), json: vs };
    },
  },
  'visitors thoughts': {
    usage: 'visitors thoughts', summary: 'What visitors are thinking, most common first',
    run(park) {
      const m = new Map<string, number>();
      for (const v of park.s.visitors) for (const t of v.thoughts) m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
      const rows = [...m].sort((a, b) => b[1] - a[1]).slice(0, 12);
      return { ok: true, text: rows.length ? rows.map(([k, n]) => `${String(n).padStart(4)}× ${k}`).join('\n') : 'Nobody is thinking anything yet.', json: Object.fromEntries(rows) };
    },
  },
  'marketing start': { usage: 'marketing start <flyers|billboard|freeEntry> [weeks]', summary: 'Run a campaign', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'marketing.start', { kind: pos[0], weeks: pos[1] !== undefined ? +pos[1] : undefined }); } },
  'marketing list': { usage: 'marketing list', summary: 'Running campaigns', run(park) { const m = park.s.campaigns; return { ok: true, text: m.length ? m.map((x) => `${x.kind}: ${x.weeksLeft} week(s) left`).join('\n') : 'No campaigns running.', json: m }; } },
  'loan set': { usage: 'loan set <cr>', summary: 'Borrow or repay', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'loan.set', { amount: pos[0] }); } },
  'coaster start': {
    usage: 'coaster start <x> <y> [--dir 0-3] [--name "…"]', summary: 'Start a coaster: 3-tile station heading dir (1 = east); entrance on the left of the middle tile',
    run(park, pos, f) { return need(pos, 2, this.usage) ?? fromAction(park, 'coaster.start', { x: +pos[0], y: +pos[1], dir: f.dir !== undefined ? +f.dir : undefined, name: typeof f.name === 'string' ? f.name : undefined }); },
  },
  'coaster add': {
    usage: 'coaster add <piece> [count] [--ride "…"]', summary: 'Add track pieces to the open end (see: pw coaster pieces)',
    run(park, pos, f) { return need(pos, 1, this.usage) ?? fromAction(park, 'coaster.add', { piece: pos[0], count: pos[1] !== undefined ? +pos[1] : undefined, ride: typeof f.ride === 'string' ? f.ride : undefined }); },
  },
  'coaster undo': { usage: 'coaster undo [--ride "…"]', summary: 'Remove the last piece (refunded)', run(park, _p, f) { return fromAction(park, 'coaster.undo', { ride: typeof f.ride === 'string' ? f.ride : undefined }); } },
  'coaster test': { usage: 'coaster test [--ride "…"]', summary: 'Test run: checks the circuit, simulates a train, rates the ride', run(park, _p, f) { return fromAction(park, 'coaster.test', { ride: typeof f.ride === 'string' ? f.ride : undefined }); } },
  'coaster pieces': {
    usage: 'coaster pieces', summary: 'Track pieces and what they cost',
    run() {
      const rows = Object.values(PIECES).filter((p) => !p.station).map((p) => `${p.id.padEnd(10)} ${p.name.padEnd(16)} ${cr(p.cost).padStart(8)}  ${p.dz > 0 ? `+${p.dz * LEVEL_M} m` : p.dz < 0 ? `${p.dz * LEVEL_M} m` : 'level'}${p.wide ? ', 2×2 tiles, gentle' : p.turn ? ', 1 tile, tight' : ''}${p.lift ? ', chain' : ''}${p.brakes ? `, slows to 3 m/s` : ''}`);
      return { ok: true, text: [...rows, 'Turns are right/left relative to the direction of travel. Big drops and airtime are exciting; tight fast turns are intense.'].join('\n'), json: PIECES };
    },
  },
  'fee set': { usage: 'fee set <cr>', summary: 'Park entry fee', run(park, pos) { return need(pos, 1, this.usage) ?? fromAction(park, 'park.fee', { fee: pos[0] }); } },
};

function help(noun?: string): CliResult {
  const entries = Object.entries(COMMANDS).filter(([k]) => !noun || k.split(' ')[0] === noun);
  if (!entries.length) return { ok: false, text: `✗ no commands for "${noun}"` };
  return { ok: true, text: entries.map(([, c]) => `pw ${c.usage.padEnd(52)} ${c.summary}`).join('\n') };
}

/** Run one line of `pw`. The leading "pw" is optional. */
export function runCommand(park: Park, line: string): CliResult {
  let tokens = tokenize(line);
  if (tokens[0] === 'pw') tokens = tokens.slice(1);
  if (!tokens.length || tokens[0] === 'help' || tokens[0] === '--help') return help(tokens[1]);
  const { pos, flags } = parseArgs(tokens);
  const two = `${pos[0]} ${pos[1] ?? ''}`.trim();
  let cmd = COMMANDS[two], rest = pos.slice(2);
  if (!cmd) { cmd = COMMANDS[pos[0]]; rest = pos.slice(1); }
  if (!cmd && pos[0] === 'shop') { cmd = COMMANDS[`ride ${pos[1]}`]; rest = pos.slice(2); }
  if (!cmd) {
    const nouns = [...new Set(Object.keys(COMMANDS).map((k) => k.split(' ')[0]))];
    const verbs = Object.keys(COMMANDS).filter((k) => k.startsWith(pos[0] + ' ')).map((k) => k.split(' ')[1]);
    return { ok: false, text: verbs.length ? `✗ "${pos[0]}" needs a verb: ${verbs.join(', ')}` : `✗ unknown command "${pos[0]}"\n  try: ${nouns.join(', ')} — or pw help` };
  }
  if (flags.help) return { ok: true, text: `pw ${cmd.usage}\n${cmd.summary}` };
  const res = cmd.run(park, rest, flags);
  if (flags.o === 'json') return { ...res, text: JSON.stringify(res.json ?? { ok: res.ok, text: res.text }, null, 2) };
  return res;
}

/** Action types reachable from the terminal (for docs/tests). */
export const TERMINAL_ACTIONS = Object.keys(ACTIONS);
