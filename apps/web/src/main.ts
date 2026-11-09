import './style.css';
import { Game } from './game.ts';
import { Cloud } from './cloud.ts';
import { AiTerminal } from './ai.ts';
import { Bridge } from './bridge.ts';
import { ClaudeTerminal } from './claude.ts';
import { World } from './render/world.ts';
import { Tools } from './ui/tools.ts';
import { Hud } from './ui/hud.ts';
import { Onboarding } from './ui/onboarding.ts';
import { ParkTerminal } from './ui/terminal.ts';
import { $, toast } from './ui/dom.ts';

const game = new Game();
const canvas = $<HTMLCanvasElement>('#view');
const world = new World(canvas, () => game.s, () => game.content);
const tools = new Tools(game, world, canvas);

const termHost = $('#terminal');
const terminal = new ParkTerminal(game, $('#term-body'));
terminal.onFocus = (x, y) => world.focus(x, y);
new AiTerminal(game, terminal);
const bridge = new Bridge(game, terminal, (x, y) => world.focus(x, y));
new ClaudeTerminal(terminal, bridge);
tools.onCommand = (cmd) => terminal.echo(cmd);
const toggleTerminal = (open = !termHost.classList.contains('open')) => {
  termHost.classList.toggle('open', open);
  if (open) setTimeout(() => terminal.focus(), 160);
  else canvas.focus();
};
const cloud = new Cloud(game);
new Hud(game, tools, () => toggleTerminal(), cloud);
const onboarding = new Onboarding(game, tools, world, cloud);

// ?park=<id> opens a shared park (yours resumes; anyone else's becomes a copy you play).
const shared = new URLSearchParams(location.search).get('park');
if (shared) {
  cloud.open(shared)
    .then((how) => toast(how === 'own' ? 'Welcome back to your park' : `Visiting ${game.s.name} — this is your own copy to play`))
    .catch((e: Error) => toast(e.message, 'err'))
    .finally(() => history.replaceState(null, '', location.pathname));
} else if (!new URLSearchParams(location.search).has('play')) {
  // The title screen (Continue / New park / How to play). ?play skips it (links, tests).
  onboarding.launch();
}

// Agents and the AI layer register extra terminal commands on this hook.
(window as unknown as { parkwright: unknown }).parkwright = { game, world, terminal, tools };

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (onboarding.blocking) return; // a dialog is open: it owns the keyboard
  if (e.key === '`') { toggleTerminal(); e.preventDefault(); return; }
  if (termHost.classList.contains('open') && termHost.contains(document.activeElement)) return;
  if (e.key === '?') { onboarding.help(); e.preventDefault(); return; }
  if (e.key === 'Escape') tools.set({ kind: 'select' });
  if (e.key === 'r' || e.key === 'R') tools.rotate();
  if (e.key === 'q') world.rotate(-1);
  if (e.key === 'e') world.rotate(1);
  if (e.key === ' ') { game.speed = game.speed === 0 ? 1 : 0; e.preventDefault(); }
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
// Keyup never arrives if focus leaves mid-press (alt-tab, Cmd shortcuts): forget held keys.
addEventListener('blur', () => keys.clear());
const saveNow = () => game.saveLocal();
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); saveNow(); } });
addEventListener('pagehide', saveNow);
if (game.shelved) toast(`Started a new park — your old save couldn't load (${game.shelved}). It's kept as a backup.`, 'err');

let last = performance.now();
function frame(now: number) {
  // Always schedule the next frame first, so one bad frame can't stop the game.
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - last);
  last = now;
  try { step(now, dt); } catch (e) { console.error('[parkwright] frame error', e); }
}
function step(now: number, dt: number) {
  const pan = (world.zoom / 14) * dt * 0.02;
  if (keys.has('w') || keys.has('arrowup')) world.pan(0, -pan);
  if (keys.has('s') || keys.has('arrowdown')) world.pan(0, pan);
  if (keys.has('a') || keys.has('arrowleft')) world.pan(-pan, 0);
  if (keys.has('d') || keys.has('arrowright')) world.pan(pan, 0);
  const alpha = game.update(dt);
  world.render(now / 1000, alpha);
}
requestAnimationFrame(frame);
addEventListener('beforeunload', saveNow);
