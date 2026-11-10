// First-run experience: a title screen (continue / new park with scenario + name), a short welcome,
// a hands-on walkthrough that waits for you to actually do each thing, and a "How to play" sheet that's
// always one click (or "?") away. Plain DOM, like the rest of the HUD.
import type { Cloud } from '../cloud.ts';
import type { Game } from '../game.ts';
import type { World } from '../render/world.ts';
import type { Tools } from './tools.ts';
import { $, h } from './dom.ts';
import { icon } from './icons.ts';
import { goalText, objectiveOf, rulesOf } from '@parkwright/sim';
import type { Scenario } from '@parkwright/content';

/** "A flat meadow by the road. Goal: 1,000 visitors…" — the goal comes from the park's rules version. */
function goalLine(sc: Scenario, rules?: number): string {
  const o = objectiveOf(sc, rules);
  return o.kind === 'sandbox' ? sc.blurb : `${sc.blurb} Goal: ${goalText(o)}.`;
}

const KEY = 'parkwright.onboarding.v1';
interface Seen { welcomed?: boolean; toured?: boolean }
const readSeen = (): Seen => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; } };
const writeSeen = (patch: Seen) => { try { localStorage.setItem(KEY, JSON.stringify({ ...readSeen(), ...patch })); } catch { /* private mode: just show it again next time */ } };

const PATH = 1;
const pathCount = (g: Game) => g.s.tiles.reduce((n, t) => n + (t === PATH ? 1 : 0), 0);
const rideCount = (g: Game, kinds: string[]) => g.s.rides.filter((r) => kinds.includes(g.content.rideTypes[r.type]?.kind ?? '')).length;

interface Step {
  title: string;
  body: string;
  /** What to point at (re-queried every frame — the HUD re-renders). None: the card sits centred low. */
  target?: () => Element | null;
  /** Moves on by itself once this is true (checked a few times a second). Without it, a Next button. */
  done?: () => boolean;
  /** Runs when the step starts (e.g. snapshot a count, or move the camera). */
  enter?: () => void;
}

export class Onboarding {
  private modal: HTMLElement | null = null;
  private lastFocus: Element | null = null;
  private pausedFrom: number | null = null;
  private tourEls: HTMLElement[] = [];
  private tourTimer = 0;
  private tourFrame = 0;

  constructor(private game: Game, private tools: Tools, private world: World, private cloud: Cloud) {
    addEventListener('pw:help', () => this.help());
  }

  /** True while a dialog owns the keyboard (the game ignores its shortcuts). */
  get blocking() { return this.modal !== null; }

  /** On launch: the title screen, then the welcome for first-timers. */
  launch() {
    this.titleScreen();
  }

  // ── dialogs ────────────────────────────────────────────────────────────────

  private open(el: HTMLElement, opts: { label: string; onEsc?: () => void; full?: boolean }) {
    this.close(false);
    this.lastFocus = document.activeElement;
    if (this.pausedFrom === null) { this.pausedFrom = this.game.speed; this.game.speed = 0; }
    const overlay = h('div', { class: `ob-overlay${opts.full ? ' full' : ''}` }, el);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', opts.label);
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the game's own key handler never sees keys typed in a dialog
      if (e.key === 'Escape' && opts.onEsc) { e.preventDefault(); opts.onEsc(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex="0"]'));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!el.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(overlay);
    this.modal = overlay;
    // If focus ever drops to <body> (a re-rendered dialog), keys still belong to the dialog.
    const refocus = (e: KeyboardEvent) => {
      if (this.modal !== overlay) { removeEventListener('keydown', refocus, true); return; }
      if (overlay.contains(document.activeElement)) return;
      if (e.key === 'Escape' && opts.onEsc) { e.preventDefault(); e.stopPropagation(); opts.onEsc(); return; }
      focusIn();
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    addEventListener('keydown', refocus, true);
    const focusIn = () => (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    focusIn();
  }

  private close(resume = true) {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    if (resume) {
      if (this.pausedFrom !== null) this.game.speed = this.pausedFrom;
      this.pausedFrom = null;
      // Back to the canvas — never to the button that opened us, or Space/Enter would click it again.
      const back = this.lastFocus as HTMLElement | null;
      (back && document.contains(back) && back.matches('input, textarea, .xterm-helper-textarea') ? back : $('#view')).focus();
    }
  }

  // ── title screen ───────────────────────────────────────────────────────────

  titleScreen(view: 'menu' | 'new' = 'menu') {
    const s = this.game.s;
    const fresh = s.tick < 60 && s.rides.length === 0;
    const afterwards = () => { this.close(); if (!readSeen().welcomed) this.welcome(); };
    const panel = h('div', { class: 'ob-title' });
    let escClose = false;
    const menu = () => { escClose = false; panel.replaceChildren(
      h('div', { class: 'ob-logo' }, h('span', { class: 'ob-flag', 'aria-hidden': 'true' }, icon('wheel', 40)), h('h1', {}, 'Parkwright')),
      h('p', { class: 'ob-tag' }, 'Lay the paths, raise the rides, keep the crowds happy.'),
      h('ul', { class: 'ob-chips', 'aria-label': 'Features' },
        h('li', {}, icon('coaster', 16), 'Build piece by piece'),
        h('li', {}, icon('people', 16), 'Guests with opinions'),
        h('li', {}, icon('check', 16), 'Verified on NEAR testnet')),
      h('div', { class: 'ob-menu' },
        h('button', { class: 'primary big', 'data-autofocus': true, onclick: afterwards }, fresh ? 'Play' : 'Continue', h('small', {}, fresh ? s.name : `${s.name} · day ${s.day + 1}`)),
        h('button', { class: 'big', onclick: () => newPark() }, 'New park', h('small', {}, 'pick a scenario and a name')),
        h('button', { class: 'big', onclick: () => { this.close(false); this.help(true); } }, 'How to play', h('small', {}, 'rules, controls, the terminal')),
      ),
      h('p', { class: 'ob-foot' }, 'Saved in this browser as you play. Publish from the Parks panel to share a park or rank it.'),
    ); requestAnimationFrame(() => panel.querySelector<HTMLElement>('[data-autofocus]')?.focus()); };
    const newPark = () => {
      escClose = view === 'new';
      const scen = Object.values(this.game.content.scenarios);
      let pick = scen[0]?.id ?? 'meadow';
      const name = h('input', { id: 'ob-name', maxlength: 32, value: 'Meadowbrook', 'aria-label': 'Park name', 'data-autofocus': true }) as HTMLInputElement;
      const cards = scen.map((sc) => {
        const b = h('button', { class: `ob-scen${sc.id === pick ? ' on' : ''}`, 'aria-pressed': String(sc.id === pick), onclick: () => {
          pick = sc.id;
          for (const c of cards) { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); }
        } }, h('b', {}, sc.name), h('small', {}, goalLine(sc)), h('span', { class: 'ob-cash' }, `${sc.size[0]}×${sc.size[1]} · starts with ${(sc.cash / 100).toLocaleString()} cr`));
        return b;
      });
      const start = () => {
        const n = name.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'My Park';
        this.cloud.forget(); // the new park replaces your saved one, so it must not sync over the old one's link
        this.game.newGame(pick, n);
        this.focusGate();
        afterwards();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
      panel.replaceChildren(
        h('h2', {}, 'New park'),
        h('div', { class: 'ob-scens', role: 'group', 'aria-label': 'Scenario' }, ...cards),
        h('label', { class: 'ob-field', for: 'ob-name' }, 'Name your park', name),
        this.game.visiting ? h('p', { class: 'ob-warn' }, 'This starts a park of your own and replaces your saved park in this browser.')
          : fresh ? '' : h('p', { class: 'ob-warn' }, this.cloud.link
            ? `This replaces ${s.name} in this browser. Its published copy stays online but stops updating.`
            : `This replaces ${s.name} in this browser. Publish it from the Parks panel first if you want to keep it.`),
        h('div', { class: 'ob-row' }, h('button', { onclick: () => (view === 'new' ? this.close() : menu()) }, 'Back'), h('button', { class: 'primary', onclick: start }, 'Open the gates')),
      );
      requestAnimationFrame(() => name.focus());
    };
    if (view === 'new') newPark(); else menu();
    this.open(panel, { label: 'Parkwright', full: true, onEsc: () => { if (escClose) this.close(); else if (panel.querySelector('#ob-name')) menu(); } });
  }

  private focusGate() {
    const sc = this.game.content.scenarios[this.game.s.scenario];
    if (sc) this.world.focus(sc.gate[0], sc.gate[1]);
  }

  // ── welcome ────────────────────────────────────────────────────────────────

  welcome() {
    const sc = this.game.content.scenarios[this.game.s.scenario];
    const cards: { art: string; title: string; body: string }[] = [
      { art: 'coaster', title: 'Build a park people love', body: 'Visitors walk in, ride, eat, and tell each other what they thought. Their mood becomes your park rating, and your rating brings more of them. Your job is to keep that loop going without running out of cash.' },
      { art: 'path', title: 'Paths come first', body: 'Everyone arrives at the gate and walks only on paths. A ride’s entrance, the small square, has to touch a path, or nobody can reach it. Queue tiles in front of a ride let more people wait in line.' },
      { art: 'food', title: 'Rides, food and prices', body: 'Rides bring excitement, and stalls fix hunger and thirst. Click anything you built to set its price or open and close it. Hire mechanics for breakdowns and handymen for litter. Fees and marketing are in Finance.' },
      { art: 'flag', title: sc?.objective?.kind === 'sandbox' ? 'No goal, just build' : 'Your goal', body: `${sc ? goalLine(sc, rulesOf(this.game.s)) : ''} When you’re ready, you can build a coaster piece by piece, open the terminal with \` to type commands or ask the AI for a mod, and publish your park. Published parks are checked by replay and earn on NEAR testnet.` },
    ];
    let i = 0;
    const panel = h('div', { class: 'ob-card' });
    const finish = (tour: boolean) => { writeSeen({ welcomed: true }); this.close(); if (tour) this.tour(); };
    const render = () => {
      const c = cards[i];
      const last = i === cards.length - 1;
      panel.replaceChildren(
        h('div', { class: `ob-art art-${i}`, 'aria-hidden': 'true' }, icon(c.art, 40)),
        h('h2', { id: 'ob-h' }, c.title),
        h('p', {}, c.body),
        h('div', { class: 'ob-dots', 'aria-label': `Card ${i + 1} of ${cards.length}` }, ...cards.map((_, k) => h('i', { class: k === i ? 'on' : '' }))),
        h('div', { class: 'ob-row' },
          h('button', { class: 'link', onclick: () => finish(false) }, last ? 'I’ll explore on my own' : 'Skip'),
          i > 0 ? h('button', { onclick: () => { i--; render(); } }, 'Back') : '',
          h('button', { class: 'primary', 'data-autofocus': true, onclick: () => { if (last) finish(true); else { i++; render(); } } }, last ? 'Show me how' : 'Next'),
        ),
      );
      panel.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    };
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && i < cards.length - 1) { i++; render(); }
      if (e.key === 'ArrowLeft' && i > 0) { i--; render(); }
    });
    render();
    this.open(panel, { label: 'Welcome to Parkwright', onEsc: () => finish(false) });
  }

  // ── walkthrough ────────────────────────────────────────────────────────────

  tour() {
    this.endTour();
    const g = this.game;
    let base = 0;
    const q = (sel: string) => () => document.querySelector(sel);
    const steps: Step[] = [
      { title: 'Your park at a glance', body: 'Cash, park rating (0–1000) and how many visitors are inside right now. Keep an eye on all three.', target: q('#top [data-tour="stats"]') },
      { title: 'Pick the Path tool', body: 'Everything starts with paths. Choose Path in the toolbar.', target: q('[data-tour="path"]'), done: () => this.tools.tool.kind === 'path' },
      { title: 'Lay a path from the gate', body: 'The camera is on the gate. Drag across the grass (mouse or finger) to lay a few path tiles that join the gate’s path. Q/E or a two-finger twist turn the view; the wheel or a pinch zooms; WASD or two fingers pan.', enter: () => { base = pathCount(g); this.focusGate(); }, done: () => pathCount(g) >= base + 3 },
      { title: 'Open the Rides drawer', body: 'Now give them something to do.', target: q('[data-tour="ride"]'), done: () => !!document.querySelector('#drawer.open') },
      { title: 'Place a ride', body: 'Pick a ride, then click or tap beside your path. Press R (or the R button on touch screens) to turn it until its entrance (the small square) touches the path. Red means it can’t go there.', target: () => document.querySelector('[data-tour="ride"].on') ? document.querySelector('#drawer.open') : document.querySelector('[data-tour="ride"]'), enter: () => { base = rideCount(g, ['flat', 'track']); }, done: () => rideCount(g, ['flat', 'track']) > base },
      { title: 'Feed them', body: 'Visitors get hungry and thirsty. Open Stalls and place one along the path the same way.', target: () => document.querySelector('[data-tour="stall"].on') ? document.querySelector('#drawer.open') : document.querySelector('[data-tour="stall"]'), enter: () => { base = rideCount(g, ['stall']); }, done: () => rideCount(g, ['stall']) > base },
      { title: 'Inspect what you built', body: 'Click anything you built (with Inspect, or right after placing it) to open its panel: set the price, open or close it, and see how visitors rate it. A ride whose entrance doesn’t touch a path stays closed.', target: () => document.querySelector('#side.open') ?? document.querySelector('[data-tour="select"]') },
      { title: 'Let time run', body: 'Visitors trickle in during the day. Space pauses, and 2× or 4× speeds things up. Watch the rating climb as they enjoy your rides.', target: q('#top .speeds'), done: () => g.speed > 1 },
      { title: 'Money matters', body: 'Finance has your entry fee, loan and marketing campaigns, plus a chart of what each day earned. Staff hires mechanics and handymen.', target: q('#top [data-tour="finance"]') },
      { title: 'The park terminal', body: 'Everything you click is also a command. Open the terminal with ` and try “help”, “map” or “ride place carousel”. Ask the private AI to manage (ask "…") or design a mod (“mod ai …”) or let Claude build over MCP (“bridge”).', target: q('#top .term-btn') },
      { title: 'That’s the basics', body: 'Grow the park, hit the goal, then publish it from Parks to share it and rank it. Press ? any time to see the rules and controls again.', target: q('#top [data-tour="help"]') },
    ];
    let i = 0;
    const ring = h('div', { class: 'ob-ring', 'aria-hidden': 'true' });
    const card = h('div', { class: 'ob-coach', role: 'dialog', 'aria-modal': 'false', 'aria-live': 'polite', 'aria-label': 'Walkthrough' });
    this.tourEls = [ring, card];
    document.body.append(ring, card);
    const show = () => {
      const st = steps[i];
      st.enter?.();
      card.replaceChildren(
        h('div', { class: 'ob-step' }, `Step ${i + 1} of ${steps.length}`, h('span', { class: 'ob-progress', 'aria-hidden': 'true' }, h('i', { style: `width:${((i + 1) / steps.length) * 100}%` }))),
        h('h3', {}, st.title),
        h('p', {}, st.body),
        h('div', { class: 'ob-row' },
          h('button', { class: 'link', onclick: () => this.endTour(true) }, 'End tour'),
          i > 0 ? h('button', { onclick: () => { i--; show(); } }, 'Back') : '',
          st.done ? h('span', { class: 'ob-wait' }, 'waiting for you…') : '',
          h('button', { class: st.done ? '' : 'primary', onclick: () => next() }, i === steps.length - 1 ? 'Finish' : st.done ? 'Skip step' : 'Next'),
        ),
      );
    };
    const next = () => { if (i >= steps.length - 1) { this.endTour(true); return; } i++; show(); };
    this.tourTimer = window.setInterval(() => { if (!this.modal && steps[i].done?.()) next(); }, 300);
    const place = () => {
      this.tourFrame = requestAnimationFrame(place);
      const t = steps[i].target?.();
      const r = t?.getBoundingClientRect();
      const narrow = innerWidth < 760;
      if (!r || r.width === 0) { ring.style.display = 'none'; }
      else {
        ring.style.display = 'block';
        const pad = 6;
        const top = Math.max(2, r.top - pad), left = Math.max(2, r.left - pad);
        Object.assign(ring.style, { top: `${top}px`, left: `${left}px`, width: `${Math.min(innerWidth - 4, r.right + pad) - left}px`, height: `${Math.min(innerHeight - 4, r.bottom + pad) - top}px` });
      }
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let x: number, y: number;
      if (narrow) { x = 8; y = r && r.top > innerHeight / 2 ? 80 : innerHeight - ch - 96; }
      else if (!r || r.width === 0) { x = (innerWidth - cw) / 2; y = innerHeight - ch - 60; }
      else if (r.right + 16 + cw < innerWidth) { x = r.right + 16; y = r.top; }
      else if (r.bottom + 16 + ch < innerHeight) { x = r.left; y = r.bottom + 16; }
      else { x = r.left - cw - 16; y = r.top; }
      x = Math.max(8, Math.min(innerWidth - cw - 8, x));
      y = Math.max(8, Math.min(innerHeight - ch - 8, y));
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    show();
    place();
  }

  private endTour(done = false) {
    clearInterval(this.tourTimer);
    cancelAnimationFrame(this.tourFrame);
    for (const el of this.tourEls) el.remove();
    this.tourEls = [];
    if (done) writeSeen({ toured: true });
  }

  // ── how to play ────────────────────────────────────────────────────────────

  help(fromTitle = false) {
    const sc = this.game.content.scenarios[this.game.s.scenario];
    const keys: [string, string][] = [
      ['Click / drag', 'build with the chosen tool; drag paths and scenery'],
      ['R', 'rotate what you’re placing'], ['Q / E', 'turn the camera'], ['WASD / arrows', 'pan'], ['Wheel / pinch', 'zoom'],
      ['Space', 'pause / resume'], ['M', 'sound on / off (or the speaker next to the speeds)'], ['1 finger', 'tap to build or select; drag lays paths, or pans with Inspect'], ['2 fingers', 'pinch to zoom, drag to pan, twist to turn the view'], ['⟲ R ⟳', 'on touch screens: turn the view, rotate the piece; pause is first in the speed buttons'], ['Esc', 'back to Inspect'], ['`', 'park terminal'], ['?', 'this sheet'],
    ];
    const sec = (title: string, ...kids: (Node | string)[]) => h('section', {}, h('h3', {}, title), ...kids);
    const panel = h('div', { class: 'ob-sheet' },
      h('header', {}, h('h2', {}, 'How to play'), h('button', { class: 'x', 'aria-label': 'Close', onclick: () => done() }, icon('close', 20))),
      h('div', { class: 'ob-cols' },
        sec('Goal', h('p', {}, sc ? goalLine(sc, rulesOf(this.game.s)) : 'Build the best park you can.'), h('p', {}, 'Your rating (0–1000) comes from how happy visitors are, how good your rides are, how clean the park is, and whether it’s worth the money.')),
        sec('Building',
          h('ul', {},
            h('li', {}, 'Paths connect everything to the gate. Ride and stall entrances must touch a path.'),
            h('li', {}, 'Queue tiles in front of a ride let more people wait.'),
            h('li', {}, 'Build a Timber Coaster from the Rides drawer: place the station, add pieces, close the loop, then test it.'),
            h('li', {}, 'Scenery, bins and benches near paths make people happier.'))),
        sec('Visitors', h('ul', {},
          h('li', {}, 'Each visitor has energy, hunger, thirst, nausea and money. Click one to read what they’re thinking.'),
          h('li', {}, 'Bored or unhappy visitors go home. Litter and broken rides cost you rating.'),
          h('li', {}, 'Mechanics fix breakdowns and handymen sweep. Hire them in Staff.'))),
        sec('Money', h('ul', {},
          h('li', {}, 'Income comes from the entry fee, ride tickets and stall sales. Costs are wages, upkeep and loan interest.'),
          h('li', {}, 'If you charge too much, people refuse to pay. Too little, and you go broke.'),
          h('li', {}, 'Marketing campaigns bring a rush of new visitors.'))),
        sec('Controls', h('dl', { class: 'ob-keys' }, ...keys.flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))),
        sec('Terminal, AI and NEAR', h('ul', {},
          h('li', {}, 'Press ` to open the terminal. “help” lists commands, and each button in the game has a command too.'),
          h('li', {}, 'ask "<goal>" lets the private NEAR AI manager play a few turns, with signed proofs (“ai proofs” downloads them). “mod ai <idea>” designs a data-only mod.'),
          h('li', {}, '“bridge” connects Claude Code over MCP. Running locally, “claude” opens it right inside the game.'),
          h('li', {}, 'Publish from Parks. The server replays every action to verify your park, and only verified parks rank and earn on NEAR testnet.'))),
      ),
      h('div', { class: 'ob-row' },
        h('button', { onclick: () => { this.close(false); this.welcome(); } }, 'Replay the welcome'),
        h('button', { onclick: () => { this.close(); this.tour(); } }, 'Start the walkthrough'),
        h('button', { onclick: () => { this.close(false); this.titleScreen('new'); } }, 'New park…'),
        h('button', { class: 'primary', 'data-autofocus': true, onclick: () => done() }, fromTitle ? 'Back' : 'Got it'),
      ),
    );
    const done = () => { if (fromTitle) { this.close(false); this.titleScreen(); } else this.close(); };
    this.open(panel, { label: 'How to play', onEsc: done });
  }
}
