import { baseContent, basePack, buildContent, validateMod } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, rulesToHooks } from '../src/index.ts';

const aiReply = {
  name: 'Spooky Nights',
  summary: 'A haunted drop tower and hot cocoa.',
  rideTypes: [
    { id: 'phantom-drop', name: 'Phantom Drop', kind: 'flat', size: [2, 2], cost: 300000, upkeep: 6000, capacity: 10, cycleTicks: 340, ratings: { e: 560, i: 780, n: 400 }, wear: 80, defaultPrice: 350, draw: 26, model: 'droptower', color: '#4a2a6a' },
    { id: 'cocoa-cart', name: 'Cocoa Cart', kind: 'stall', cost: 22000, item: 'hot-cocoa', model: 'stall', color: '#6a3a1a' },
    { id: 'evil', name: 'Evil', kind: 'flat', cost: -5, ratings: { e: 1e9, i: -3, n: 'x' }, size: [99, 0], capacity: 9999, model: 'nuke' },
    { id: 'orphan-stall', kind: 'stall', item: 'does-not-exist' },
  ],
  items: [{ id: 'hot-cocoa', name: 'Hot Cocoa', need: 'thirst', cost: 30, value: 160, defaultPrice: 130, effect: { thirst: 150, happy: 999 }, litter: true }],
  rules: [
    { on: 'ride.build', when: { kind: 'stall' }, cost: 0.5 },
    { on: 'ride.build', when: { type: 'teacups' }, veto: 'No teacups after dark' },
    { on: 'teleport', when: {}, veto: 'x' },
  ],
};

describe('mods', () => {
  it('validates and clamps an AI-designed mod, namespacing its ids', () => {
    const { mod, warnings } = validateMod(aiReply, baseContent);
    const ids = mod.pack.rideTypes.map((t) => t.id);
    expect(ids).toEqual(['mod-spooky-nights--phantom-drop', 'mod-spooky-nights--cocoa-cart', 'mod-spooky-nights--evil']);
    const evil = mod.pack.rideTypes[2];
    expect(evil.cost).toBe(600_000); // excitement 10.00 costs at least 6,000 cr
    expect(evil.ratings).toEqual({ e: 1000, i: 0, n: 100 });
    expect(evil.size).toEqual([4, 1]);
    expect(evil.capacity).toBe(30); // ≤ 1 rider per 12 ticks of its 360-tick cycle
    expect(evil.model).toBe('carousel');
    expect(mod.pack.items[0].effect.happy).toBe(255);
    expect(mod.pack.rideTypes[1].item).toBe('mod-spooky-nights--hot-cocoa');
    expect(mod.rules).toHaveLength(2);
    expect(warnings.some((w) => w.includes('unknown item'))).toBe(true);
    expect(warnings.some((w) => w.includes('nuke'))).toBe(true);
  });

  it('can never replace base content', () => {
    const { mod } = validateMod({ name: 'x', rideTypes: [{ id: 'carousel', name: 'Hijack', kind: 'flat' }] }, baseContent);
    expect(mod.pack.rideTypes[0].id).not.toBe('carousel');
    const c = buildContent([basePack, mod.pack]);
    expect(c.rideTypes.carousel.name).toBe('Brass Carousel');
  });

  it('rejects junk', () => {
    expect(() => validateMod('nope', baseContent)).toThrow();
    expect(() => validateMod({ name: 'empty' }, baseContent)).toThrow(/no usable/);
  });

  it('loads into the game: build the new ride, rules veto and discount', () => {
    const { mod } = validateMod(aiReply, baseContent);
    const content = buildContent([basePack, mod.pack]);
    const p = Park.create(content, 'sandbox', 1);
    p.hooks.push(...rulesToHooks(mod.pack.id, mod.rules));
    expect(p.run('ride.build', { type: 'mod-spooky-nights--phantom-drop', x: 10, y: 10 }).ok).toBe(true);
    const veto = p.run('ride.build', { type: 'teacups', x: 20, y: 20 });
    expect(veto.ok).toBe(false);
    if (!veto.ok) expect(veto.error).toContain('No teacups after dark');
    const cash = p.s.cash;
    expect(p.run('ride.build', { type: 'mod-spooky-nights--cocoa-cart', x: 30, y: 30 }).ok).toBe(true);
    expect(cash - p.s.cash).toBe(11000); // half of 22000
  });

  it('review: rules apply whether a ride is named by id or by display name', () => {
    const { mod } = validateMod({ name: 'No Spin', rules: [{ on: 'ride.build', when: { type: 'carousel' }, veto: 'no spinning' }] }, baseContent);
    const p = Park.create(buildContent([basePack, mod.pack]), 'sandbox', 1);
    p.hooks.push(...rulesToHooks(mod.pack.id, mod.rules));
    for (const t of ['carousel', 'Carousel', 'Brass Carousel', 'brass_carousel']) expect(p.run('ride.build', { type: t, x: 10, y: 10 }).ok, t).toBe(false);
  });

  it('review: logs the resolved ride id, so replays never depend on loaded mods', () => {
    const p = Park.create(baseContent, 'sandbox', 1);
    p.run('ride.build', { type: 'swing', x: 10, y: 10 });
    expect(p.log[0].params.type).toBe('swings');
  });

  it('review: ids are always slugged and packs cannot collide', () => {
    const evil = 'mod-x--' + 'a'.repeat(5000) + '<script>\u001b]0;pwn\u0007';
    const { mod } = validateMod({ name: 'X', rideTypes: [{ id: evil, name: 'N\u009b31m', kind: 'flat' }] }, baseContent);
    expect(mod.pack.rideTypes[0].id).toMatch(/^mod-x--[a-z0-9-]{1,24}$/);
    expect(mod.pack.rideTypes[0].name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const a = validateMod({ name: 'Spooky--Fun', rideTypes: [{ id: 'carousel', kind: 'flat' }] }, baseContent).mod;
    const b = validateMod({ name: 'Spooky', rideTypes: [{ id: 'fun--carousel', kind: 'flat' }] }, baseContent).mod;
    expect(a.pack.rideTypes[0].id).not.toBe(b.pack.rideTypes[0].id);
  });
});
