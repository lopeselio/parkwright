// Turn untrusted mod JSON (from an AI or a file) into a safe ModPack: whitelisted fields only, every
// number clamped, ids namespaced so a mod can never replace base content, references checked.
import type { Content, ItemType, ModPack, Need, RideType } from './types.ts';

export type RuleWhen = { type?: string; kind?: 'flat' | 'stall' | 'facility' };
export type Rule =
  | { on: RuleAction; when: RuleWhen; cost: number }
  | { on: RuleAction; when: RuleWhen; veto: string };
export type RuleAction = 'ride.build' | 'path.place' | 'scenery.place' | 'staff.hire' | 'marketing.start';

export interface ModFile {
  pack: ModPack;
  summary: string;
  rules: Rule[];
}

export const MODELS = ['carousel', 'teacups', 'wheel', 'swings', 'droptower', 'spookwalk', 'stall', 'restroom'] as const;
const RULE_ACTIONS: RuleAction[] = ['ride.build', 'path.place', 'scenery.place', 'staff.hire', 'marketing.start'];
const NEEDS: Need[] = ['hunger', 'thirst', 'bladder', 'souvenir'];
const STATS = ['hunger', 'thirst', 'bladder', 'happy', 'energy', 'queasy'] as const;

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(lo, Math.min(hi, n))) : dflt;
};
const text = (v: unknown, max: number, dflt: string) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '';
  return s || dflt;
};
const slug = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#c080e0');

/** Validate a mod. Throws with a plain-language reason when nothing usable is left. */
export function validateMod(raw: unknown, base: Content): { mod: ModFile; warnings: string[] } {
  if (!raw || typeof raw !== 'object') throw new Error('a mod must be a JSON object');
  const r = raw as Record<string, any>;
  const warnings: string[] = [];
  const name = text(r.name, 40, 'Untitled mod');
  const packId = `mod-${slug(name) || 'untitled'}`;
  const ns = (id: string) => (id.startsWith(`${packId}--`) ? id : `${packId}--${slug(id) || 'x'}`);

  const items: ItemType[] = [];
  for (const it of Array.isArray(r.items) ? r.items.slice(0, 6) : []) {
    if (!it || typeof it !== 'object') continue;
    const need = NEEDS.includes(it.need) ? (it.need as Need) : 'souvenir';
    const effect: ItemType['effect'] = {};
    for (const k of STATS) if (it.effect && it.effect[k] !== undefined) effect[k] = num(it.effect[k], -255, 255, 0);
    items.push({
      id: ns(String(it.id ?? it.name ?? 'item')), name: text(it.name, 30, 'Item'), need,
      cost: num(it.cost, 0, 2000, 50), value: num(it.value, 0, 2000, 150), defaultPrice: num(it.defaultPrice, 0, 2000, 120),
      effect, litter: it.litter === true,
    });
  }

  const known = new Set([...Object.keys(base.items), ...items.map((i) => i.id)]);
  const resolveItem = (id: unknown) => {
    const s = String(id ?? '');
    if (known.has(s)) return s;
    const n = ns(s);
    return known.has(n) ? n : null;
  };

  const rideTypes: RideType[] = [];
  for (const t of Array.isArray(r.rideTypes) ? r.rideTypes.slice(0, 6) : []) {
    if (!t || typeof t !== 'object') continue;
    const kind = t.kind === 'stall' || t.kind === 'facility' ? t.kind : 'flat';
    const small = kind !== 'flat';
    const size: [number, number] = small ? [1, 1] : [num(t.size?.[0], 1, 4, 2), num(t.size?.[1], 1, 4, 2)];
    const model = (MODELS as readonly string[]).includes(t.model) ? t.model : small ? (kind === 'facility' ? 'restroom' : 'stall') : 'carousel';
    if (t.model && model !== t.model) warnings.push(`${t.name ?? t.id}: unknown model "${t.model}", using ${model}`);
    let item: string | undefined;
    if (kind === 'stall') {
      const ref = resolveItem(t.item);
      if (!ref) { warnings.push(`${t.name ?? t.id}: sells an unknown item, skipped`); continue; }
      item = ref;
    }
    const ratings = small ? { e: 0, i: 0, n: 0 } : { e: num(t.ratings?.e, 0, 1000, 200), i: num(t.ratings?.i, 0, 1000, 200), n: num(t.ratings?.n, 0, 1000, 100) };
    rideTypes.push({
      id: ns(String(t.id ?? t.name ?? 'ride')), name: text(t.name, 30, 'Ride'), kind, size,
      cost: num(t.cost, 5000, 2_000_000, 100_000), upkeep: num(t.upkeep, 0, 20_000, 3000),
      capacity: num(t.capacity, 1, 40, small ? 1 : 12), cycleTicks: small ? num(t.cycleTicks, 20, 120, 40) : num(t.cycleTicks, 120, 1200, 360),
      ratings, wear: num(t.wear, 0, 200, 50), defaultPrice: num(t.defaultPrice, 0, 5000, 200),
      ...(item ? { item } : {}),
      ...(kind === 'facility' ? { serviceEffect: { bladder: -255, happy: 10 } } : {}),
      draw: num(t.draw, 0, 60, small ? 2 : 18), model, color: hex(t.color),
    });
  }

  const rideIds = new Set([...Object.keys(base.rideTypes), ...rideTypes.map((t) => t.id)]);
  const rules: Rule[] = [];
  for (const ru of Array.isArray(r.rules) ? r.rules.slice(0, 8) : []) {
    if (!ru || typeof ru !== 'object' || !RULE_ACTIONS.includes(ru.on)) continue;
    const when: RuleWhen = {};
    if (ru.when?.type !== undefined) {
      const t = String(ru.when.type);
      const id = rideIds.has(t) ? t : rideIds.has(ns(t)) ? ns(t) : null;
      if (!id) { warnings.push(`rule on unknown ride type "${t}" skipped`); continue; }
      when.type = id;
    }
    if (['flat', 'stall', 'facility'].includes(ru.when?.kind)) when.kind = ru.when.kind;
    if (typeof ru.veto === 'string') rules.push({ on: ru.on, when, veto: text(ru.veto, 80, 'not allowed by a mod') });
    else if (ru.cost !== undefined) rules.push({ on: ru.on, when, cost: Math.max(0.1, Math.min(5, Number(ru.cost) || 1)) });
  }

  if (!rideTypes.length && !items.length && !rules.length) throw new Error('the mod has no usable ride types, items or rules');
  const pack: ModPack = { id: packId, version: '1.0.0', name, rideTypes, items, staff: [], scenarios: [] };
  return { mod: { pack, summary: text(r.summary, 160, ''), rules }, warnings };
}

/** A compact description of the content, for the AI's reference when designing mods. */
export function contentCatalog(c: Content): string {
  const rides = Object.values(c.rideTypes).filter((t) => t.kind !== 'track').map((t) =>
    `${t.id}: ${t.kind} ${t.size[0]}x${t.size[1]}, cost ${t.cost}, E/I/N ${t.ratings.e}/${t.ratings.i}/${t.ratings.n}, price ${t.defaultPrice}${t.item ? `, sells ${t.item}` : ''}`);
  const items = Object.values(c.items).map((i) => `${i.id}: ${i.need}, cost ${i.cost}, value ${i.value}, price ${i.defaultPrice}`);
  return `Ride types:\n${rides.join('\n')}\nItems:\n${items.join('\n')}`;
}
