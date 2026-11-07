import type { Ratings, StaffRole } from '@parkwright/content';
import type { RngState } from './rng.ts';

export const TICKS_PER_DAY = 1800;
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_SEASON = 28;
/** Sub-tile resolution for entity positions. */
export const SUB = 64;

export const enum Tile {
  Grass = 0,
  Path = 1,
  Queue = 2,
}

export type Dir = 0 | 1 | 2 | 3; // N(−y) E(+x) S(+y) W(−x)
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export type LedgerCategory =
  | 'construction'
  | 'upkeep'
  | 'wages'
  | 'stock'
  | 'marketing'
  | 'interest'
  | 'gate'
  | 'rides'
  | 'stalls'
  | 'refunds';

export type Ledger = Record<LedgerCategory, number>;

export interface Ride {
  id: number;
  type: string;
  name: string;
  x: number;
  y: number;
  /** Rotation 0–3; the entrance faces this direction. */
  rot: Dir;
  w: number;
  h: number;
  /** Entrance tile (outside the footprint). */
  ex: number;
  ey: number;
  price: number;
  status: 'open' | 'closed' | 'broken' | 'testing';
  ratings: Ratings | null;
  value: number;
  /** Reliability ×100 (10000 = 100 %). */
  reliability: number;
  builtDay: number;
  /** What the park actually paid to build it (after mod hooks); refunds are based on this. */
  paid?: number;
  /** Visitor ids, front first. */
  queue: number[];
  riders: number[];
  /** Ticks left in the current cycle, 0 = loading. */
  cycle: number;
  /** Ticks the current batch has waited to fill. */
  loadWait: number;
  brokenSince: number;
  lastInspected: number;
  /** Stats for panels and objectives. */
  customers: number;
  income: number;
  incomeWeek: number;
  satisfaction: number[];
  /** Coaster track, if kind = track. */
  track?: TrackPiece[];
}

export interface TrackPiece {
  piece: string;
  x: number;
  y: number;
  z: number;
  dir: Dir;
}

export type VisitorMode = 'walking' | 'queuing' | 'riding' | 'leaving' | 'gone';

export interface Thought {
  kind: string;
  ride?: number;
  day: number;
}

export interface Visitor {
  id: number;
  name: string;
  /** Patron group this visitor belongs to (onchain budget holder). */
  group: number;
  mode: VisitorMode;
  /** Current tile and the tile being walked to. */
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  /** Progress from (tx,ty) to (nx,ny), 0..SUB. */
  p: number;
  dir: Dir;
  goal: Goal | null;
  happy: number;
  energy: number;
  hunger: number;
  thirst: number;
  bladder: number;
  queasy: number;
  cash: number;
  spent: number;
  thrill: [number, number];
  stomach: number;
  ridden: number[];
  thoughts: Thought[];
  holding: string | null;
  litterIn: number;
  queuedAt: number;
  enteredTick: number;
  lostTicks: number;
}

export type Goal =
  | { kind: 'ride'; ride: number }
  | { kind: 'exit' }
  | { kind: 'tile'; x: number; y: number };

export interface Staff {
  id: number;
  role: StaffRole;
  name: string;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  p: number;
  dir: Dir;
  goal: Goal | null;
  /** Ticks of work left at the current job. */
  busy: number;
  task: number | null;
}

export interface Campaign {
  kind: 'flyers' | 'billboard' | 'freeEntry';
  weeksLeft: number;
}

export interface DayStats {
  day: number;
  visitors: number;
  arrivals: number;
  rating: number;
  income: number;
  /** Ride ticket income only (for the rideIncome objective). */
  rideIncome: number;
  costs: number;
  /** cents spent per patron group per venue — the onchain settlement source. */
  spend: Record<string, Record<string, number>>;
}

export interface ParkState {
  version: 1;
  name: string;
  scenario: string;
  seed: number;
  rng: RngState;
  tick: number;
  day: number;
  w: number;
  h: number;
  /** Tile kind per cell, row-major. */
  tiles: number[];
  /** Ride id occupying the cell, or 0. */
  occ: number[];
  /** Litter count per cell. */
  litter: number[];
  /** Bins on path cells. */
  bins: number[];
  /** Scenery object per cell (0 = none, else index into SCENERY). */
  scenery: number[];
  gate: [number, number];
  cash: number;
  loan: number;
  maxLoan: number;
  interestBp: number;
  fee: number;
  rating: number;
  rides: Ride[];
  visitors: Visitor[];
  staff: Staff[];
  campaigns: Campaign[];
  nextId: number;
  /** Bumped when paths or rides change — invalidates route caches. */
  mapVersion: number;
  ledgerWeek: Ledger;
  ledgerTotal: Ledger;
  today: DayStats;
  history: DayStats[];
  objective: { status: 'pending' | 'won' | 'lost'; checkedDay: number };
  incidents: number;
  totalVisitors: number;
  /** Mods this save needs (id@version). */
  mods: string[];
}

export interface ActionRecord {
  tick: number;
  type: string;
  params: Record<string, unknown>;
  actor: string;
}
