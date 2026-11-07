import './style.css';
import { Game } from './game.ts';
import { World } from './render/world.ts';
import { Tools } from './ui/tools.ts';
import { Hud } from './ui/hud.ts';
import { ParkTerminal } from './ui/terminal.ts';
import { $ } from './ui/dom.ts';

const game = new Game();
const canvas = $<HTMLCanvasElement>('#view');
const world = new World(canvas, () => game.s, game.content);
const tools = new Tools(game, world, canvas);

const termHost = $('#terminal');
const terminal = new ParkTerminal(game, $('#term-body'));
terminal.onFocus = (x, y) => world.focus(x, y);
tools.onCommand = (cmd) => terminal.echo(cmd);
const toggleTerminal = (open = !termHost.classList.contains('open')) => {
  termHost.classList.toggle('open', open);
  if (open) setTimeout(() => terminal.focus(), 160);
  else canvas.focus();
};
new Hud(game, tools, () => toggleTerminal());

// Agents and the AI layer register extra terminal commands on this hook.
(window as unknown as { parkwright: unknown }).parkwright = { game, world, terminal, tools };

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (e.key === '`') { toggleTerminal(); e.preventDefault(); return; }
  if (termHost.classList.contains('open') && termHost.contains(document.activeElement)) return;
  if (e.key === 'Escape') tools.set({ kind: 'select' });
  if (e.key === 'r' || e.key === 'R') tools.rotate();
  if (e.key === 'q') world.rotate(-1);
  if (e.key === 'e') world.rotate(1);
  if (e.key === ' ') { game.speed = game.speed === 0 ? 1 : 0; e.preventDefault(); }
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

let last = performance.now();
function frame(now: number) {
  const dt = now - last;
  last = now;
  const pan = (world.zoom / 14) * dt * 0.02;
  if (keys.has('w') || keys.has('arrowup')) world.pan(0, -pan);
  if (keys.has('s') || keys.has('arrowdown')) world.pan(0, pan);
  if (keys.has('a') || keys.has('arrowleft')) world.pan(-pan, 0);
  if (keys.has('d') || keys.has('arrowright')) world.pan(pan, 0);
  const alpha = game.update(dt);
  world.render(now / 1000, alpha);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('beforeunload', () => game.saveLocal());
