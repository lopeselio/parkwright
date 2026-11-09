// Reference parks for the balance harness and the balance tests. Each one is built only through the
// player's own commands (`runCommand`), so it is logged and replays like a real park.
import { baseContent, type Content } from '@parkwright/content';
import { runCommand } from '../src/cli.ts';
import { Park } from '../src/park.ts';

export interface RefPark {
  park: Park;
  /** Called at the end of every day: the scripted "player" reinvests and hires like a sensible manager. */
  manage(): void;
}

type Opts = { rules?: number; seed?: number; c?: Content };

function make(scenario: string, name: string, o: Opts): Park {
  const c = o.c ?? baseContent;
  // Older sims don't take a rules version; extra arguments are ignored there.
  return (Park.create as (...a: unknown[]) => Park)(c, scenario, o.seed ?? 1, name, ...(o.rules === undefined ? [] : [o.rules]));
}

function cmd(park: Park, line: string, strict = true) {
  const r = runCommand(park, line);
  if (!r.ok && strict) throw new Error(`pw ${line}: ${r.text}`);
  return r.ok;
}

const cash = (p: Park) => p.s.cash / 100;
const count = (p: Park, role: string) => p.s.staff.filter((x) => x.role === role).length;
const here = (p: Park) => p.s.visitors.filter((v) => v.mode !== 'gone').length;

/** Hire towards a target ratio of staff to visitors, firing nobody (wages are the price of growth). */
function staffUp(p: Park, perHandyman: number, perMechanic: number) {
  const n = here(p);
  const wantH = Math.max(1, Math.ceil(n / perHandyman));
  const rides = p.s.rides.filter((r) => p.c.rideTypes[r.type].kind === 'flat').length;
  const wantM = Math.max(1, Math.ceil(rides / perMechanic));
  if (count(p, 'handyman') < wantH && cash(p) > 500) cmd(p, 'staff hire handyman');
  if (count(p, 'mechanic') < wantM && cash(p) > 500) cmd(p, 'staff hire mechanic');
}

/** Build the next item of a wish list when there is cash to spare. */
function grow(p: Park, wish: [string, string][], reserve: number) {
  while (wish.length) {
    const [type, near] = wish[0];
    const cost = p.c.rideTypes[type].cost / 100;
    if (cash(p) < cost + reserve) return;
    wish.shift();
    cmd(p, `ride place ${type} --near ${near}`, false);
  }
}

/** The test suite's starter: one spine, two rides, a cart, a stand and a restroom. Never grows. */
export function starter(o: Opts = {}): RefPark {
  const p = make('meadow', 'Starter', o);
  for (const l of [
    'path place 24 30 24 40', 'path place 18 34 30 34',
    'ride build carousel 20 30 --rot 2', 'ride open brass carousel',
    'ride build swings 26 30 --rot 2', 'ride open whirl swings',
    'ride build pretzel-cart 23 36 --rot 1', 'ride build lemonade-stand 25 37 --rot 3', 'ride build restroom 23 38 --rot 1',
  ]) cmd(p, l);
  return { park: p, manage() {} };
}

/** A sensible mid-sized meadow park: a path grid, six rides, food, drink, restrooms, bins and staff; grows from income. */
export function mid(o: Opts = {}): RefPark {
  const p = make('meadow', 'Midway', o);
  for (const l of [
    'path place 24 6 24 40', 'path place 6 12 42 12', 'path place 6 22 42 22', 'path place 6 32 42 32',
    'path place 6 12 6 32', 'path place 42 12 42 32',
  ]) cmd(p, l);
  for (const [t, n] of [
    ['carousel', '20,30'], ['wheel', '28,30'], ['swings', '20,20'], ['teacups', '28,20'], ['spookwalk', '10,30'], ['droptower', '38,30'],
    ['pretzel-cart', '24,34'], ['lemonade-stand', '24,26'], ['noodle-bar', '24,16'], ['icepop-cart', '14,22'],
    ['restroom', '24,36'], ['restroom', '34,22'], ['kite-kiosk', '24,10'],
  ]) cmd(p, `ride place ${t} --near ${n}`);
  for (let x = 8; x <= 40; x += 4) for (const y of [12, 22, 32]) cmd(p, `bin place ${x} ${y}`, false);
  cmd(p, 'staff hire handyman');
  cmd(p, 'staff hire mechanic');
  const wish: [string, string][] = [
    ['lemonade-stand', '10,12'], ['pretzel-cart', '38,12'], ['restroom', '14,32'], ['swings', '12,16'],
    ['wheel', '36,16'], ['noodle-bar', '34,32'], ['icepop-cart', '40,22'], ['carousel', '12,8'], ['teacups', '36,8'],
    ['restroom', '8,22'], ['lemonade-stand', '30,12'], ['spookwalk', '16,26'], ['droptower', '32,26'], ['pretzel-cart', '18,22'],
  ];
  return { park: p, manage() { staffUp(p, 150, 4); grow(p, wish, 2000); } };
}

/** A big sandbox park with a billboard running: sixteen rides and plenty of stalls. */
export function big(o: Opts = {}): RefPark {
  const p = make('sandbox', 'Grand', o);
  for (const l of [
    'path place 32 4 32 60', 'path place 4 10 60 10', 'path place 4 22 60 22', 'path place 4 34 60 34', 'path place 4 46 60 46',
    'path place 4 10 4 46', 'path place 60 10 60 46', 'path place 18 10 18 46', 'path place 46 10 46 46',
  ]) cmd(p, l);
  const rides = ['carousel', 'wheel', 'swings', 'teacups', 'spookwalk', 'droptower'];
  const spots = ['10,14', '24,14', '38,14', '52,14', '10,26', '24,26', '38,26', '52,26', '10,38', '24,38', '38,38', '52,38', '10,50', '24,50', '38,50', '52,50'];
  spots.forEach((n, i) => cmd(p, `ride place ${rides[i % rides.length]} --near ${n}`));
  const stalls = ['pretzel-cart', 'lemonade-stand', 'noodle-bar', 'icepop-cart', 'restroom', 'restroom', 'kite-kiosk'];
  for (const [i, n] of ['32,8', '32,20', '32,30', '32,42', '32,52', '12,22', '50,22', '12,46', '50,46', '25,10', '40,34', '18,30', '46,18', '4,30'].entries())
    cmd(p, `ride place ${stalls[i % stalls.length]} --near ${n}`);
  for (let x = 6; x <= 58; x += 4) for (const y of [10, 22, 34, 46]) cmd(p, `bin place ${x} ${y}`, false);
  for (let i = 0; i < 4; i++) cmd(p, 'staff hire handyman');
  for (let i = 0; i < 3; i++) cmd(p, 'staff hire mechanic');
  cmd(p, 'staff hire entertainer');
  cmd(p, 'marketing start billboard 8');
  return { park: p, manage() { staffUp(p, 150, 4); } };
}

export const PARKS = { starter, mid, big } as const;
export type ParkName = keyof typeof PARKS;
