import { DAYS_PER_SEASON, DAYS_PER_WEEK, SCENERY, findRide, queueCapacity, valueForMoney, type Dir } from '@parkwright/sim';
import type { Game } from '../game.ts';
import type { Tools } from './tools.ts';
import { $, cr, h, toast } from './dom.ts';

const ICON: Record<string, string> = { select: '☝', path: '▦', queue: '⋯', ride: '🎠', stall: '🥨', scenery: '🌳', bin: '🗑', bulldoze: '✕' };

export class Hud {
  private selected: number | null = null;
  private drawer: 'rides' | 'stalls' | 'scenery' | null = null;
  private panel: 'finance' | 'visitors' | 'staff' | null = null;
  private last = '';

  constructor(private game: Game, private tools: Tools, private toggleTerminal: () => void) {
    tools.onSelect = (id) => { this.selected = id; this.panel = null; this.renderSide(); };
    tools.onChange = () => this.renderTools();
    this.renderTools();
    this.renderTop();
    setInterval(() => { this.renderTop(); this.renderSide(false); }, 250);
  }

  private renderTop() {
    const s = this.game.s;
    const season = Math.floor(s.day / DAYS_PER_SEASON) + 1;
    const week = (Math.floor(s.day / DAYS_PER_WEEK) % 4) + 1;
    const key = [s.cash, s.rating, s.visitors.length, s.day, this.game.speed, s.objective.status].join('|');
    if (key === this.last) return;
    this.last = key;
    const speeds = [0, 1, 2, 4].map((n) => h('button', { class: `speed ${this.game.speed === n ? 'on' : ''}`, title: n ? `${n}× speed` : 'pause', onclick: () => { this.game.speed = n; this.last = ''; this.renderTop(); } }, n ? `${n}×` : '❚❚'));
    const pct = s.rating / 10;
    $('#top').replaceChildren(
      h('div', { class: 'brand' }, h('b', {}, s.name), h('span', { class: 'date' }, `Season ${season} · Week ${week} · Day ${s.day + 1}`)),
      h('div', { class: 'stat' }, h('label', {}, 'Cash'), h('b', { class: s.cash < 0 ? 'neg' : '' }, cr(s.cash))),
      h('div', { class: 'stat' }, h('label', {}, 'Rating'), h('div', { class: 'bar' }, h('i', { style: `width:${pct}%;background:${pct > 60 ? '#7ccf7a' : pct > 40 ? '#f2b84b' : '#e85d5d'}` })), h('b', {}, String(s.rating))),
      h('div', { class: 'stat' }, h('label', {}, 'Visitors'), h('b', {}, String(s.visitors.length))),
      h('div', { class: 'speeds' }, ...speeds),
      h('div', { class: 'menu' },
        ...(['finance', 'visitors', 'staff'] as const).map((p) => h('button', { class: this.panel === p ? 'on' : '', onclick: () => { this.panel = this.panel === p ? null : p; this.selected = null; this.renderSide(); this.last = ''; this.renderTop(); } }, p[0].toUpperCase() + p.slice(1))),
        h('button', { class: 'term-btn', title: 'Terminal (`)', onclick: () => this.toggleTerminal() }, '>_ Terminal'),
      ),
      s.objective.status !== 'pending' ? h('div', { class: `goal ${s.objective.status}` }, s.objective.status === 'won' ? 'Goal reached!' : 'Goal missed') : '',
    );
  }

  renderTools() {
    const t = this.tools.tool;
    const btn = (id: string, label: string, on: boolean, click: () => void) => h('button', { class: `tool ${on ? 'on' : ''}`, title: label, onclick: click }, h('span', { class: 'ic' }, ICON[id]), h('span', {}, label));
    $('#tools').replaceChildren(
      btn('select', 'Inspect', t.kind === 'select', () => { this.drawer = null; this.tools.set({ kind: 'select' }); }),
      btn('path', 'Path', t.kind === 'path' && !t.queue, () => { this.drawer = null; this.tools.set({ kind: 'path', queue: false }); }),
      btn('queue', 'Queue', t.kind === 'path' && t.queue, () => { this.drawer = null; this.tools.set({ kind: 'path', queue: true }); }),
      btn('ride', 'Rides', this.drawer === 'rides', () => { this.drawer = this.drawer === 'rides' ? null : 'rides'; this.renderTools(); }),
      btn('stall', 'Stalls', this.drawer === 'stalls', () => { this.drawer = this.drawer === 'stalls' ? null : 'stalls'; this.renderTools(); }),
      btn('scenery', 'Scenery', this.drawer === 'scenery', () => { this.drawer = this.drawer === 'scenery' ? null : 'scenery'; this.renderTools(); }),
      btn('bin', 'Bin', t.kind === 'bin', () => { this.drawer = null; this.tools.set({ kind: 'bin' }); }),
      btn('bulldoze', 'Clear', t.kind === 'bulldoze', () => { this.drawer = null; this.tools.set({ kind: 'bulldoze' }); }),
    );
    const d = $('#drawer');
    if (!this.drawer) { d.classList.remove('open'); return; }
    d.classList.add('open');
    const c = this.game.content;
    if (this.drawer === 'scenery') {
      d.replaceChildren(h('h3', {}, 'Scenery'), ...SCENERY.slice(1).map((sc) => {
        const k = sc.name.split(' ')[0];
        return h('button', { class: `card ${t.kind === 'scenery' && t.scenery === k ? 'on' : ''}`, onclick: () => this.tools.set({ kind: 'scenery', scenery: k }) }, h('b', {}, sc.name), h('small', {}, `${cr(sc.cost)} · beauty ${sc.beauty}`));
      }), h('p', { class: 'tip' }, 'Drag to fill an area. Visitors love gardens and fountains near paths and rides.'));
      return;
    }
    const kinds = this.drawer === 'rides' ? ['flat'] : ['stall', 'facility'];
    const types = Object.values(c.rideTypes).filter((r) => kinds.includes(r.kind));
    d.replaceChildren(
      h('h3', {}, this.drawer === 'rides' ? 'Rides' : 'Stalls & facilities'),
      ...types.map((r) => h('button', { class: `card ${t.kind === 'ride' && t.type === r.id ? 'on' : ''}`, onclick: () => this.tools.set({ kind: 'ride', type: r.id, rot: (t.kind === 'ride' ? t.rot : 2) as Dir }) },
        h('i', { class: 'sw', style: `background:${r.color}` }),
        h('b', {}, r.name),
        h('small', {}, `${cr(r.cost)} · ${r.size[0]}×${r.size[1]}${r.kind === 'flat' ? ` · E ${(r.ratings.e / 100).toFixed(1)} I ${(r.ratings.i / 100).toFixed(1)}` : r.item ? ` · ${c.items[r.item].name}` : ''}`),
      )),
      h('p', { class: 'tip' }, 'R rotates the entrance. The entrance (small square) must touch a path — add queue tiles in front so more visitors can wait.'),
    );
  }

  private sideKey = '';

  /** Re-render the side panel; on the timer only when what it shows has changed (so clicks aren't lost). */
  private renderSide(force = true) {
    const side = $('#side');
    const s = this.game.s, c = this.game.content;
    const r0 = this.selected !== null ? s.rides.find((x) => x.id === this.selected) : null;
    const key = `${this.selected}|${this.panel}|` + (r0 ? `${r0.status}|${r0.price}|${r0.customers}|${r0.queue.length}|${Math.round(r0.reliability / 100)}` : `${s.day}|${s.cash}|${s.loan}|${s.fee}|${s.staff.length}|${s.campaigns.length}|${s.visitors.length >> 3}`);
    if (!force && key === this.sideKey) return;
    this.sideKey = key;
    if (this.selected !== null) {
      const r = s.rides.find((x) => x.id === this.selected);
      if (!r) { this.selected = null; side.classList.remove('open'); return; }
      const t = c.rideTypes[r.type];
      const attraction = t.kind === 'flat' || t.kind === 'track';
      const sat = r.satisfaction.length ? Math.round((r.satisfaction.reduce((a, b) => a + b, 0) / (r.satisfaction.length * 3)) * 100) : null;
      const thoughts = new Map<string, number>();
      for (const v of s.visitors) for (const th of v.thoughts) if (th.ride === r.id) thoughts.set(th.kind, (thoughts.get(th.kind) ?? 0) + 1);
      const run = (type: string, params: Record<string, unknown>) => { const res = this.game.run(type, params); if (!res.ok) toast(res.error, 'err', res.hint); this.renderSide(); };
      const ratingRow = (label: string, v: number, max = 1000) => h('div', { class: 'rrow' }, h('label', {}, label), h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, (v / max) * 100)}%` })), h('b', {}, (v / 100).toFixed(2)));
      side.classList.add('open');
      side.replaceChildren(
        h('header', {}, h('h2', {}, r.name), h('button', { class: 'x', onclick: () => { this.selected = null; side.classList.remove('open'); } }, '×')),
        h('div', { class: `status ${r.status}` }, r.status),
        attraction && r.ratings ? h('div', {}, ratingRow('Excitement', r.ratings.e), ratingRow('Intensity', r.ratings.i), ratingRow('Nausea', r.ratings.n)) : '',
        h('div', { class: 'price' },
          h('label', {}, t.kind === 'stall' ? `${c.items[t.item!].name} price` : 'Ticket'),
          h('button', { onclick: () => run('ride.price', { ride: r.id, price: Math.max(0, r.price - 10) / 100 }) }, '−'),
          h('b', {}, cr(r.price)),
          h('button', { onclick: () => run('ride.price', { ride: r.id, price: (r.price + 10) / 100 }) }, '+'),
        ),
        attraction ? h('p', { class: 'muted' }, `Visitors think it's worth about ${cr(s.fee > 0 ? r.value >> 1 : r.value)}${s.fee > 0 ? ' (they paid to get in)' : ''}. They walk away above twice that.`) : t.item ? h('p', { class: 'muted' }, `Worth ${cr(c.items[t.item].value)} to a visitor; costs you ${cr(c.items[t.item].cost)} each.`) : '',
        h('dl', {},
          h('dt', {}, 'Customers'), h('dd', {}, String(r.customers)),
          h('dt', {}, 'Income this week'), h('dd', {}, cr(r.incomeWeek)),
          h('dt', {}, 'Total income'), h('dd', {}, cr(r.income)),
          t.kind !== 'stall' ? h('dt', {}, 'Queue') : '', t.kind !== 'stall' ? h('dd', {}, `${r.queue.length} / ${queueCapacity(s, r)}`) : '',
          h('dt', {}, 'Reliability'), h('dd', {}, `${Math.round(r.reliability / 100)}%`),
          attraction ? h('dt', {}, 'Satisfaction') : '', attraction ? h('dd', {}, sat === null ? '—' : `${sat}%`) : '',
        ),
        thoughts.size ? h('div', { class: 'thoughts' }, h('h4', {}, 'Visitors say'), ...[...thoughts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => h('div', {}, `“${k}” ×${n}`))) : '',
        h('div', { class: 'row' },
          r.status === 'open' ? h('button', { onclick: () => run('ride.close', { ride: r.id }) }, 'Close') : h('button', { class: 'primary', onclick: () => run('ride.open', { ride: r.id }) }, 'Open'),
          h('button', { class: 'danger', onclick: () => { run('ride.demolish', { ride: r.id }); this.selected = null; } }, 'Demolish'),
        ),
      );
      return;
    }
    if (this.panel === 'finance') {
      side.classList.add('open');
      const rows = (Object.keys(s.ledgerTotal) as (keyof typeof s.ledgerTotal)[]).filter((k) => s.ledgerTotal[k] !== 0);
      const last = s.history.slice(-7);
      const net = last.reduce((a, d) => a + d.income - d.costs, 0);
      side.replaceChildren(
        h('header', {}, h('h2', {}, 'Finance'), h('button', { class: 'x', onclick: () => { this.panel = null; side.classList.remove('open'); this.last = ''; } }, '×')),
        h('table', { class: 'ledger' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Week'), h('th', {}, 'Total')), ...rows.map((k) => h('tr', {}, h('td', {}, k), h('td', { class: s.ledgerWeek[k] < 0 ? 'neg' : '' }, cr(s.ledgerWeek[k])), h('td', { class: s.ledgerTotal[k] < 0 ? 'neg' : '' }, cr(s.ledgerTotal[k]))))),
        h('p', {}, `Last 7 days net: `, h('b', { class: net < 0 ? 'neg' : '' }, cr(net))),
        h('div', { class: 'spark' }, ...s.history.slice(-28).map((d) => h('i', { title: `day ${d.day + 1}: ${cr(d.income)}`, style: `height:${Math.min(100, d.income / 600)}%` }))),
        h('div', { class: 'price' }, h('label', {}, 'Loan'), h('button', { onclick: () => { const r = this.game.run('loan.set', { amount: Math.max(0, s.loan - 100000) / 100 }); if (!r.ok) toast(r.error, 'err', r.hint); } }, '−'), h('b', {}, cr(s.loan)), h('button', { onclick: () => { const r = this.game.run('loan.set', { amount: (s.loan + 100000) / 100 }); if (!r.ok) toast(r.error, 'err', r.hint); } }, '+')),
        h('div', { class: 'price' }, h('label', {}, 'Entry fee'), h('button', { onclick: () => this.game.run('park.fee', { fee: Math.max(0, s.fee - 100) / 100 }) }, '−'), h('b', {}, cr(s.fee)), h('button', { onclick: () => this.game.run('park.fee', { fee: (s.fee + 100) / 100 }) }, '+')),
        h('p', { class: 'muted' }, `Rides are worth ${cr(valueForMoney(s))} more than they cost. Keep the fee under that or fewer visitors come.`),
        h('h4', {}, 'Marketing'),
        h('div', { class: 'row' }, ...(['flyers', 'billboard', 'freeEntry'] as const).map((k) => h('button', { disabled: s.campaigns.some((m) => m.kind === k), onclick: () => { const r = this.game.run('marketing.start', { kind: k, weeks: 2 }); toast(r.ok ? `${k} campaign started` : r.error, r.ok ? 'ok' : 'err'); } }, k))),
      );
      return;
    }
    if (this.panel === 'visitors') {
      side.classList.add('open');
      const m = new Map<string, number>();
      for (const v of s.visitors) for (const t of v.thoughts) m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
      const avg = (k: 'happy' | 'energy' | 'hunger' | 'thirst') => (s.visitors.length ? Math.round(s.visitors.reduce((a, v) => a + v[k], 0) / s.visitors.length) : 0);
      side.replaceChildren(
        h('header', {}, h('h2', {}, `Visitors (${s.visitors.length})`), h('button', { class: 'x', onclick: () => { this.panel = null; side.classList.remove('open'); this.last = ''; } }, '×')),
        ...(['happy', 'energy', 'hunger', 'thirst'] as const).map((k) => h('div', { class: 'rrow' }, h('label', {}, k), h('div', { class: 'bar' }, h('i', { style: `width:${(avg(k) / 255) * 100}%` })), h('b', {}, String(avg(k))))),
        h('h4', {}, 'What they are thinking'),
        ...[...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => h('div', { class: 'thought' }, h('b', {}, String(n)), ` ${k}`)),
        h('p', { class: 'muted' }, `${s.totalVisitors} visitors so far.`),
      );
      return;
    }
    if (this.panel === 'staff') {
      side.classList.add('open');
      side.replaceChildren(
        h('header', {}, h('h2', {}, 'Staff'), h('button', { class: 'x', onclick: () => { this.panel = null; side.classList.remove('open'); this.last = ''; } }, '×')),
        h('div', { class: 'row wrap' }, ...(Object.values(c.staff)).map((st) => h('button', { onclick: () => { const r = this.game.run('staff.hire', { role: st.role }); toast(r.ok ? r.message ?? 'hired' : r.error, r.ok ? 'ok' : 'err'); this.renderSide(); } }, `Hire ${st.name} · ${cr(st.wage)}/wk`))),
        h('p', { class: 'muted' }, 'Handymen sweep litter. Mechanics fix breakdowns and inspect rides. Entertainers cheer up nearby visitors.'),
        ...s.staff.map((st) => h('div', { class: 'staff' }, h('b', {}, st.name), h('span', {}, st.task !== null ? ` → ${findRide(s, st.task)?.name ?? ''}` : ''), h('button', { class: 'small', onclick: () => { this.game.run('staff.fire', { staff: st.id }); this.renderSide(); } }, 'Fire'))),
      );
      return;
    }
    side.classList.remove('open');
  }
}
