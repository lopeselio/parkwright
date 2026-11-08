// Declarative mod rules → query hooks. No mod code ever runs: a rule can only veto an action or
// scale its cost, and the sim's own checks still apply first.
import type { Rule } from '@parkwright/content';
import type { Hook } from './actions.ts';

export function rulesToHooks(modId: string, rules: Rule[]): Hook[] {
  return [{
    mod: modId,
    query: (ctx, type, params: any, res) => {
      for (const r of rules) {
        if (r.on !== type) continue;
        if (r.when.type !== undefined && params?.type !== r.when.type) continue;
        if (r.when.kind !== undefined && ctx.c.rideTypes[String(params?.type)]?.kind !== r.when.kind) continue;
        if ('veto' in r) return { ok: false, error: r.veto };
        return Math.round(res.cost * r.cost);
      }
      return undefined;
    },
  }];
}
