// Declarative mod rules → query hooks. No mod code ever runs: a rule can only veto an action or
// scale its cost, and the sim's own checks still apply first.
import type { Rule } from '@parkwright/content';
import { findRideType, type Hook } from './actions.ts';

export function rulesToHooks(modId: string, rules: Rule[]): Hook[] {
  return [{
    mod: modId,
    query: (ctx, type, params: any, res) => {
      for (const r of rules) {
        if (r.on !== type) continue;
        // Park.run normalises ride types before hooks; resolve again so direct callers can't dodge rules.
        const id = params?.type === undefined ? undefined : findRideType(ctx.c, params.type) ?? String(params.type);
        if (r.when.type !== undefined && id !== r.when.type) continue;
        if (r.when.kind !== undefined && (id === undefined || ctx.c.rideTypes[id]?.kind !== r.when.kind)) continue;
        if ('veto' in r) return { ok: false, error: r.veto };
        return Math.round(res.cost * r.cost);
      }
      return undefined;
    },
  }];
}
