// Balance harness: build reference parks through the player's commands, simulate N days and print
// what a manager would watch, plus how long each simulated day took.
//
//   node --experimental-transform-types packages/sim/scripts/balance.ts [park…] [--days 42] [--rules N] [--seed 1] [--every 1]
//   node --experimental-transform-types packages/sim/scripts/balance.ts --stress 500,1000,1500 [--rules N]
//
// park: starter | mid | big (default: all three). --stress fills the big park with N visitors and
// times one day at each size.
declare const process: { argv: string[] };
import { TICKS_PER_DAY } from '../src/types.ts';
import { spawnVisitor } from '../src/visitors.ts';
import { PARKS, big, type ParkName } from './parks.ts';

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const days = Number(flag('days', '42'));
const every = Number(flag('every', '1'));
const seed = Number(flag('seed', '1'));
const rules = flag('rules') === undefined ? undefined : Number(flag('rules'));
const stress = flag('stress');
const flagVals = new Set(['--days', '--every', '--seed', '--rules', '--stress'].flatMap((k) => { const i = argv.indexOf(k); return i >= 0 ? [argv[i + 1]] : []; }));
const names = argv.filter((a) => !a.startsWith('--') && !flagVals.has(a)) as ParkName[];

const cr = (c: number) => (c / 100).toFixed(0).padStart(8);
const here = (s: { visitors: { mode: string }[] }) => s.visitors.filter((v) => v.mode !== 'gone').length;

function run(name: ParkName) {
  const ref = PARKS[name]({ rules, seed });
  const p = ref.park;
  console.log(`\n== ${name} (${p.s.scenario}, rules ${(p.s as { rules?: number }).rules ?? 1}, seed ${seed}) — ${p.s.rides.length} venues, cash ${cr(p.s.cash).trim()} cr`);
  console.log(' day  visitors arrive rating     cash   income    costs  spend/day  litter  staff     ms');
  let peak = 0, worst = 0, total = 0, maxSpend = 0;
  for (let d = 1; d <= days; d++) {
    const t0 = performance.now();
    p.advanceTo(d * TICKS_PER_DAY);
    const ms = performance.now() - t0;
    ref.manage();
    const h = p.s.history[p.s.history.length - 1];
    const spend = Object.values(h.spend).flatMap((g) => Object.values(g)).reduce((a, b) => a + b, 0);
    const litter = p.s.litter.reduce((a, b) => a + b, 0);
    peak = Math.max(peak, h.visitors); worst = Math.max(worst, ms); total += ms; maxSpend = Math.max(maxSpend, spend);
    if (!Number.isFinite(p.s.cash)) throw new Error(`cash went ${p.s.cash} on day ${d}`);
    if (d % every === 0 || d === days)
      console.log(`${String(d).padStart(4)} ${String(h.visitors).padStart(9)} ${String(h.arrivals).padStart(6)} ${String(h.rating).padStart(6)} ${cr(p.s.cash)} ${cr(h.income)} ${cr(h.costs)} ${cr(spend)}   ${String(litter).padStart(6)} ${String(p.s.staff.length).padStart(6)} ${ms.toFixed(1).padStart(6)}`);
  }
  console.log(`peak ${peak} visitors · max spend ${cr(maxSpend).trim()} cr/day · ${(total / days).toFixed(1)} ms/day avg, ${worst.toFixed(1)} worst`);
}

function stressRun(sizes: number[]) {
  console.log(`\n== stress (big park, rules ${rules ?? 'default'}, seed ${seed})`);
  console.log('   size  in park   ms/day');
  for (const n of sizes) {
    const p = big({ rules, seed }).park;
    p.advanceTo(TICKS_PER_DAY);
    // Hold the crowd at n: the gate fee is out of everyone's reach except while we let people in.
    const fill = () => {
      p.s.fee = 0;
      for (let k = here(p.s); k < n; k++) if (!spawnVisitor(p.s, p.c)) break;
      p.s.fee = 10000;
    };
    fill();
    p.advanceTo(2 * TICKS_PER_DAY); // let them spread out over the paths
    fill();
    // Time one day, topping the crowd back up as people leave (the top-ups are part of the cost).
    let ms = 0, sum = 0, samples = 0;
    while (p.s.tick < 3 * TICKS_PER_DAY) {
      fill();
      const t0 = performance.now();
      p.advanceTo(Math.min(3 * TICKS_PER_DAY, p.s.tick + 60));
      ms += performance.now() - t0;
      sum += here(p.s); samples++;
    }
    console.log(`${String(n).padStart(7)} ${String(Math.round(sum / samples)).padStart(8)} ${ms.toFixed(0).padStart(8)}`);
  }
}

if (stress) stressRun(stress.split(',').map(Number));
else for (const n of names.length ? names : (Object.keys(PARKS) as ParkName[])) run(n);
