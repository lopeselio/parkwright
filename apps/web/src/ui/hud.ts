import { DAYS_PER_SEASON, DAYS_PER_WEEK, PIECES, SCENERY, endPose, findRide, isClosed, queueCapacity, valueForMoney, type Dir } from '@parkwright/sim';
import type { Game } from '../game.ts';
import type { Tools } from './tools.ts';
import type { Cloud } from '../cloud.ts';
import { $, cr, h, toast } from './dom.ts';

const ICON: Record<string, string> = { select: '☝', path: '▦', queue: '⋯', ride: '🎠', stall: '🥨', scenery: '🌳', bin: '🗑', bulldoze: '✕' };

export class Hud {
  private selected: number | null = null;
  private drawer: 'rides' | 'stalls' | 'scenery' | null = null;
  private panel: 'finance' | 'visitors' | 'staff' | 'parks' | null = null;
  private board: Awaited<ReturnType<Cloud['leaderboard']>> = [];
  private chain: Awaited<ReturnType<Cloud['chain']>> = null;
  private verification: Awaited<ReturnType<Cloud['verification']>> = null;
  private last = '';

  constructor(private game: Game, private tools: Tools, private toggleTerminal: () => void, private cloud: Cloud) {
    tools.onSelect = (id) => { this.selected = id; this.panel = null; this.renderSide(); };
    tools.onChange = () => this.renderTools();
    // The terminal, the AI manager or a bridge can change the track too: keep the builder and preview current.
    game.on((e) => { if (e.kind === 'action' && e.result.ok && this.tools.tool.kind === 'coaster') this.renderTools(); });
    // Never rebuild the side panel between mousedown and mouseup, or the click is lost.
    $('#side').addEventListener('pointerdown', () => { this.pressing = true; });
    addEventListener('pointerup', () => { setTimeout(() => { this.pressing = false; }, 0); });
    this.renderTools();
    this.renderTop();
    setInterval(() => { this.renderTop(); this.renderSide(false); }, 250);
  }

  /** Live value nodes in the top bar; patched in place so buttons are never rebuilt under the cursor. */
  private topRefs: { date: HTMLElement; cash: HTMLElement; bar: HTMLElement; rating: HTMLElement; visitors: HTMLElement; save: HTMLElement } | null = null;

  private renderTop() {
    const s = this.game.s;
    // Rebuild the bar only when its structure changes (speed, open panel, goal state); otherwise patch numbers.
    const muted = document.documentElement.dataset.muted === '1';
    const key = [s.name, this.game.speed, this.panel, s.objective.status, muted].join('|');
    if (key !== this.last || !this.topRefs) {
      this.last = key;
      const speeds = [0, 1, 2, 4].map((n) => h('button', { class: `speed ${this.game.speed === n ? 'on' : ''}`, title: n ? `${n}× speed` : 'pause', onclick: () => { this.game.speed = n; this.renderTop(); } }, n ? `${n}×` : '❚❚'));
      const refs = { date: h('span', { class: 'date' }), cash: h('b'), bar: h('i'), rating: h('b'), visitors: h('b'), save: h('div', { class: 'save-err' }) };
      this.topRefs = refs;
      $('#top').replaceChildren(
        h('div', { class: 'brand' }, h('b', {}, s.name), refs.date),
        h('div', { class: 'stats', 'data-tour': 'stats' },
        h('div', { class: 'stat' }, h('label', {}, 'Cash'), refs.cash),
        h('div', { class: 'stat' }, h('label', {}, 'Rating'), h('div', { class: 'bar' }, refs.bar), refs.rating),
        h('div', { class: 'stat' }, h('label', {}, 'Visitors'), refs.visitors)),
        refs.save,
        h('div', { class: 'speeds' }, ...speeds,
          // Sound (main.ts owns the audio; the bar only reflects and toggles it).
          h('button', { class: 'speed sound', 'aria-pressed': String(!muted), 'aria-label': 'Sound', title: muted ? 'Sound off (M)' : 'Sound on (M)', onclick: () => dispatchEvent(new Event('pw:sound-toggle')) }, muted ? '🔇' : '🔊')),
        h('div', { class: 'menu' },
          ...(['finance', 'visitors', 'staff', 'parks'] as const).map((p) => h('button', { class: this.panel === p ? 'on' : '', 'data-tour': p, onclick: () => {
            this.panel = this.panel === p ? null : p; this.selected = null; this.renderSide(); this.renderTop();
            if (this.panel === 'parks') {
              void this.cloud.leaderboard().then((b) => { this.board = b; this.renderSide(); });
              void this.cloud.chain().then((c) => { this.chain = c; this.renderSide(); });
              void this.cloud.verification().then((v) => { this.verification = v; this.renderSide(); });
            }
          } }, p[0].toUpperCase() + p.slice(1))),
          h('button', { class: 'term-btn', title: 'Terminal (`)', 'aria-label': 'Terminal', onclick: () => this.toggleTerminal() }, '>_', h('span', { class: 'term-label' }, ' Terminal')),
          h('button', { class: 'help-btn', 'data-tour': 'help', title: 'How to play (?)', 'aria-label': 'How to play', onclick: () => dispatchEvent(new Event('pw:help')) }, '?'),
        ),
        s.objective.status !== 'pending' ? h('div', { class: `goal ${s.objective.status}` }, s.objective.status === 'won' ? 'Goal reached!' : 'Goal missed') : '',
      );
    }
    const r = this.topRefs!;
    const season = Math.floor(s.day / DAYS_PER_SEASON) + 1;
    const week = (Math.floor(s.day / DAYS_PER_WEEK) % 4) + 1;
    r.date.textContent = `Season ${season} · Week ${week} · Day ${s.day + 1}`;
    r.cash.textContent = cr(s.cash);
    r.cash.className = s.cash < 0 ? 'neg' : '';
    const pct = s.rating / 10;
    r.bar.style.width = `${pct}%`;
    r.bar.style.background = pct > 60 ? '#7ccf7a' : pct > 40 ? '#f2b84b' : '#e85d5d';
    r.rating.textContent = String(s.rating);
    r.visitors.textContent = String(s.visitors.length);
    r.save.textContent = this.game.saveError ?? '';
  }

  renderTools() {
    const t = this.tools.tool;
    const btn = (id: string, label: string, on: boolean, click: () => void) => h('button', { class: `tool ${on ? 'on' : ''}`, title: label, 'data-tour': id, onclick: click }, h('span', { class: 'ic' }, ICON[id]), h('span', {}, label));
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
    if (t.kind === 'coaster') { d.classList.add('open'); this.renderCoasterBuilder(d); return; }
    this.tools.previewPiece(null);
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
    const coasterCard = this.drawer === 'rides' ? h('button', { class: 'card', onclick: () => { this.drawer = null; this.tools.set({ kind: 'coaster', dir: 1 }); } },
      h('i', { class: 'sw', style: 'background:#b07a4a' }), h('b', {}, 'Timber Coaster'), h('small', {}, 'build it piece by piece · from 300 cr')) : '';
    d.replaceChildren(
      h('h3', {}, this.drawer === 'rides' ? 'Rides' : 'Stalls & facilities'),
      coasterCard,
      ...types.map((r) => h('button', { class: `card ${t.kind === 'ride' && t.type === r.id ? 'on' : ''}`, onclick: () => this.tools.set({ kind: 'ride', type: r.id, rot: (t.kind === 'ride' ? t.rot : 2) as Dir }) },
        h('i', { class: 'sw', style: `background:${r.color}` }),
        h('b', {}, r.name),
        h('small', {}, `${cr(r.cost)} · ${r.size[0]}×${r.size[1]}${r.kind === 'flat' ? ` · E ${(r.ratings.e / 100).toFixed(1)} I ${(r.ratings.i / 100).toFixed(1)}` : r.item ? ` · ${c.items[r.item].name}` : ''}`),
      )),
      h('p', { class: 'tip' }, 'R rotates the entrance. The entrance (small square) must touch a path — add queue tiles in front so more visitors can wait.'),
    );
  }

  private sideKey = '';
  private pressing = false;
  /** Builder state that must survive a re-render: the piece under the pointer / with focus, and a touch-armed piece. */
  private hoverPiece: string | null = null;
  private focusPiece: string | null = null;
  private armedPiece: string | null = null;
  private skipClick = false;

  /** Re-render the side panel; on the timer only when what it shows has changed (so clicks aren't lost). */
  private renderCoasterBuilder(d: HTMLElement) {
    const r = this.tools.building();
    const t = this.tools.tool as { kind: 'coaster'; dir: Dir };
    if (!r) {
      this.tools.previewPiece(null);
      d.replaceChildren(
        h('h3', {}, 'Timber Coaster'),
        h('p', { class: 'tip' }, `Click a tile to place the 3-tile station heading ${['north', 'east', 'south', 'west'][t.dir]}. R turns it. The entrance goes on its left.`),
        h('button', { onclick: () => this.tools.set({ kind: 'select' }) }, 'Cancel'),
      );
      return;
    }
    const closed = isClosed(r.track!);
    const end = endPose(r.track!);
    const add = (piece: string) => {
      const res = this.tools.coaster('coaster.add', { piece, ride: r.id }, `pw coaster add ${piece}`);
      if (res.ok) this.tools.lastPiece = piece;
    };
    const groups: [string, string[]][] = [['Straight', ['straight', 'lift', 'brakes']], ['Turns', ['left', 'right', 'bigleft', 'bigright']], ['Hills', ['up', 'down', 'steepup', 'steepdown']]];
    // The next-piece preview: the piece you point at (or focus), else the last one you added.
    const next = h('p', { class: 'next-piece' });
    const show = (piece: string) => {
      const res = this.tools.previewPiece(closed ? null : piece);
      if (!res) { next.replaceChildren(); return; }
      const cost = (res.ok ? res.cost : undefined) ?? PIECES[piece].cost;
      const broke = res.ok && cost > this.game.s.cash;
      next.className = `next-piece ${broke ? 'broke' : res.ok ? 'ok' : 'bad'}`;
      next.replaceChildren(h('b', {}, PIECES[piece].name),
        broke ? ` fits, but costs ${cr(cost)} and you have ${cr(this.game.s.cash)}` : res.ok ? ` fits · ${cr(cost)}` : ` won't fit: ${res.error}${res.hint ? ` — ${res.hint}` : ''}`);
    };
    const current = () => this.hoverPiece ?? this.focusPiece ?? this.armedPiece ?? this.tools.lastPiece;
    const pieceBtn = (id: string) => {
      const res = closed ? null : this.tools.pieceCheck(id);
      return h('button', {
        disabled: closed, class: res && !res.ok ? 'nofit' : '', 'data-piece': id,
        title: `${PIECES[id].name} · ${cr(PIECES[id].cost)}${res && !res.ok ? ` — won't fit: ${res.error}` : ''}`,
        // Touch has no hover: the first tap previews, a second tap on the same piece places it.
        onpointerdown: (e: PointerEvent) => { if (e.pointerType === 'touch' && this.armedPiece !== id) { this.armedPiece = id; this.skipClick = true; show(id); } },
        onclick: () => { if (this.skipClick) { this.skipClick = false; return; } this.armedPiece = null; add(id); },
        onmouseenter: () => { this.hoverPiece = id; show(id); }, onmouseleave: () => { this.hoverPiece = null; show(current()); },
        onfocus: () => { this.focusPiece = id; show(id); }, onblur: () => { this.focusPiece = null; show(current()); },
      }, PIECES[id].name.replace(' turn', ''));
    };
    const refocus = this.focusPiece;
    d.replaceChildren(
      h('h3', {}, r.name),
      h('p', { class: 'tip' }, closed ? 'Circuit closed — run a test to rate it.' : `Open end at ${end!.x},${end!.y}, ${end!.z * 2} m up. Bring it back to the station at ground level.`),
      ...groups.map(([label, ids]) => h('div', { class: 'pieces' }, h('label', {}, label), ...ids.map(pieceBtn))),
      next,
      h('div', { class: 'row' },
        h('button', { onclick: () => this.tools.coaster('coaster.undo', { ride: r.id }, 'pw coaster undo') }, 'Undo'),
        h('button', { class: 'primary', disabled: !closed, onclick: () => {
          const res = this.tools.coaster('coaster.test', { ride: r.id }, 'pw coaster test');
          if (res.ok) { this.game.run('ride.open', { ride: r.id }); this.tools.set({ kind: 'select' }); this.selected = r.id; this.renderSide(); }
        } }, 'Test & open'),
      ),
      h('p', { class: 'tip' }, 'Point at a piece to preview it on the track (green fits, red doesn\'t); on touch, tap once to preview and again to place. Lifts pull the train up; drops and airtime make it exciting; fast tight turns make it intense. Wide turns are gentler but take 2×2 tiles.'),
    );
    // The buttons were rebuilt under a pointer that hasn't moved: keep showing (and focusing) the same piece.
    if (refocus) (d.querySelector(`button[data-piece="${refocus}"]`) as HTMLButtonElement | null)?.focus();
    show(current());
  }

  private renderSide(force = true) {
    const side = $('#side');
    const s = this.game.s, c = this.game.content;
    const r0 = this.selected !== null ? s.rides.find((x) => x.id === this.selected) : null;
    const key = `${this.selected}|${this.panel}|${this.cloud.status}|${this.board.length}|${this.game.visiting}|${this.chain?.park?.earned ?? ''}|${this.verification?.verified ?? ''}|` + (r0 ? `${r0.status}|${r0.price}|${r0.customers}|${r0.queue.length}|${Math.round(r0.reliability / 100)}` : `${s.day}|${s.cash}|${s.loan}|${s.fee}|${s.staff.length}|${s.campaigns.length}|${s.visitors.length >> 3}`);
    if (!force && (key === this.sideKey || this.pressing)) return;
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
        r.stats ? h('p', { class: 'muted' }, `${r.stats.length} m · ${r.stats.duration} s · top ${r.stats.maxSpeed} m/s · drop ${r.stats.maxDrop} m · ${r.stats.maxVertG}g / ${r.stats.minVertG}g · ${r.stats.maxLatG}g lateral`) : '',
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
    if (this.panel === 'parks') {
      side.classList.add('open');
      const link = this.cloud.link;
      side.replaceChildren(
        h('header', {}, h('h2', {}, 'Parks'), h('button', { class: 'x', onclick: () => { this.panel = null; side.classList.remove('open'); this.last = ''; } }, '×')),
        this.game.visiting ? h('div', { class: 'row' }, h('span', { class: 'muted' }, "You're playing a copy of someone else's park. Your own park is safe."),
          h('button', { onclick: () => { if (!this.cloud.home()) toast('no saved park of your own yet', 'err'); this.last = ''; this.renderTop(); this.renderSide(); } }, 'Back to my park')) : '',
        h('p', { class: 'muted' }, link ? `Your park is in the cloud and saves itself every day. ${this.cloud.status}` : 'Publish your park to get a link anyone can open. It keeps saving itself every day.'),
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
          try {
            const url = await this.cloud.publish();
            await navigator.clipboard?.writeText(url).catch(() => {});
            toast('Link copied — anyone with it can visit a copy of your park', 'ok', url);
          } catch (e) { toast((e as Error).message, 'err'); }
          this.renderSide();
        } }, link ? 'Copy share link' : 'Publish & share')),
        link && this.verification ? h('p', { class: this.verification.verified ? 'verified' : 'muted' },
          this.verification.verified ? '✓ Verified: the server replayed every action and got exactly your park — it ranks and settles on NEAR.' : `Not verified yet: ${this.verification.reason}. Unverified parks don't rank or settle.`) : '',
        this.chain?.enabled && this.chain.park ? h('div', { class: 'chain' },
          h('h4', {}, 'On NEAR testnet'),
          h('p', { class: 'muted' }, `Visitors arrive in 8 groups, each paid for by an agent with its own NEAR account and a daily spending cap. Every finished day, each agent settles what its visitors spent into your park.`),
          h('dl', {},
            h('dt', {}, 'Settled into the park'), h('dd', {}, cr(Number(this.chain.park.earned))),
            h('dt', {}, 'Waiting to withdraw'), h('dd', {}, cr(Number(this.chain.park.balance))),
            h('dt', {}, 'Settlements'), h('dd', {}, String(this.chain.park.settlements)),
          ),
          h('a', { class: 'small', href: `https://testnet.nearblocks.io/address/${this.chain.contract}`, target: '_blank', rel: 'noopener' }, 'See the contract on NearBlocks ↗'),
        ) : link && this.chain?.enabled ? h('p', { class: 'muted' }, 'Registering your park on NEAR… finished days settle within a minute of each cloud save.') : '',
        h('h4', {}, 'Top parks'),
        ...(this.board.length ? this.board.map((b, i) => h('div', { class: 'staff' },
          h('span', {}, `${i + 1}. `, h('b', {}, b.name), ` · rating ${b.rating} · ${b.visitors} visitors · day ${b.day + 1}`),
          h('a', { class: 'small', href: `/?park=${b.id}` }, 'Visit'))) : [h('p', { class: 'muted' }, 'No published parks yet.')]),
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
