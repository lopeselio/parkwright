// Content schema. Everything a mod pack can add is data described here.
// Money is integer cents of park credits; ratings are ×100; stats are 0–255.

export type Need = 'hunger' | 'thirst' | 'bladder' | 'souvenir';

export interface ItemType {
  id: string;
  name: string;
  /** Stock cost per unit, cents. */
  cost: number;
  /** What a visitor thinks it is worth, cents. */
  value: number;
  defaultPrice: number;
  need: Need;
  /** Stat deltas applied when consumed. */
  effect: Partial<Record<'hunger' | 'thirst' | 'bladder' | 'happy' | 'energy' | 'queasy', number>>;
  /** Leaves a wrapper/cup that becomes litter unless binned. */
  litter: boolean;
}

export type RideKind = 'flat' | 'stall' | 'facility' | 'track';

export interface Ratings {
  /** Excitement ×100. */
  e: number;
  /** Intensity ×100. */
  i: number;
  /** Nausea ×100. */
  n: number;
}

export interface RideType {
  id: string;
  name: string;
  kind: RideKind;
  /** Footprint in tiles (before rotation). Stalls are 1×1. */
  size: [number, number];
  /** Build cost, cents. */
  cost: number;
  /** Running cost per week, cents. */
  upkeep: number;
  /** Riders per cycle (flat), customers served per cycle (stall/facility). */
  capacity: number;
  /** Ticks per ride cycle (load + run + unload). */
  cycleTicks: number;
  ratings: Ratings;
  /** Reliability lost per day, in 1/100 % (100 = 1 %). */
  wear: number;
  defaultPrice: number;
  /** Stall: the item sold. */
  item?: string;
  /** Facility effect when used (e.g. restroom empties bladder). */
  serviceEffect?: ItemType['effect'];
  /** Visitors this ride can entertain; sums to the park's soft visitor cap. */
  draw: number;
  /** Renderer model id (assets/blender) — the client falls back to a procedural mesh. */
  model: string;
  /** Hex colour for the procedural fallback. */
  color: string;
}

export type StaffRole = 'handyman' | 'mechanic' | 'guard' | 'entertainer';

export interface StaffType {
  role: StaffRole;
  name: string;
  /** Wage per week, cents. */
  wage: number;
}

export interface Archetype {
  id: string;
  /** Preferred intensity window, ×100. */
  thrill: [number, number];
  /** Nausea tolerance 0–3. */
  stomach: number;
  weight: number;
}

export type Objective =
  | { kind: 'visitors'; count: number; minRating: number; byDay: number }
  | { kind: 'parkValue'; value: number; byDay: number }
  | { kind: 'rideIncome'; perWeek: number }
  | { kind: 'coasters'; count: number; minExcitement: number; byDay: number }
  | { kind: 'sandbox' };

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  size: [number, number];
  /** Park gate tile (on the map edge). Visitors spawn and leave here. */
  gate: [number, number];
  cash: number;
  loan: number;
  maxLoan: number;
  /** Interest per season in basis points (800 = 8 %). */
  interestBp: number;
  fee: number;
  visitorCash: number;
  archetypes: Archetype[];
  objective: Objective;
  /** A different goal under a later sim rules version (a park keeps the goal of the rules it was made with). */
  objectives?: Partial<Record<number, Objective>>;
  /** Ride type ids available to build; empty = all. */
  rides: string[];
  /** Pre-laid path tiles. */
  paths: [number, number][];
}

export interface ModPack {
  id: string;
  version: string;
  name: string;
  rideTypes: RideType[];
  items: ItemType[];
  staff: StaffType[];
  scenarios: Scenario[];
}

/** Merged view of every loaded pack. Later packs override earlier ids. */
export interface Content {
  packs: { id: string; version: string }[];
  rideTypes: Record<string, RideType>;
  items: Record<string, ItemType>;
  staff: Record<StaffRole, StaffType>;
  scenarios: Record<string, Scenario>;
}
