import { basePack } from './base.ts';
import type { Content, ModPack, StaffRole, StaffType } from './types.ts';

export * from './types.ts';
export { basePack };

/** Merge packs in order; later packs override ids from earlier ones. */
export function buildContent(packs: ModPack[]): Content {
  const out: Content = {
    packs: [],
    rideTypes: {},
    items: {},
    staff: {} as Record<StaffRole, StaffType>,
    scenarios: {},
  };
  for (const p of packs) {
    out.packs.push({ id: p.id, version: p.version });
    for (const r of p.rideTypes) out.rideTypes[r.id] = r;
    for (const i of p.items) out.items[i.id] = i;
    for (const s of p.staff) out.staff[s.role] = s;
    for (const s of p.scenarios) out.scenarios[s.id] = s;
  }
  for (const r of Object.values(out.rideTypes)) {
    if (r.item && !out.items[r.item]) throw new Error(`ride type ${r.id} sells unknown item ${r.item}`);
  }
  return out;
}

export const baseContent: Content = buildContent([basePack]);
export * from './mods.ts';
