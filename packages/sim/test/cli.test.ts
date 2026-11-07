import { baseContent as c } from '@parkwright/content';
import { describe, expect, it } from 'vitest';
import { Park, runCommand, tokenize } from '../src/index.ts';

describe('pw terminal', () => {
  it('tokenizes quotes', () => {
    expect(tokenize('pw ride build carousel 3 4 --name "Big Spin"')).toEqual(['pw', 'ride', 'build', 'carousel', '3', '4', '--name', 'Big Spin']);
  });

  it('builds, prices and opens a ride by name', () => {
    const p = Park.create(c, 'meadow', 1);
    expect(runCommand(p, 'pw path place 24 30 24 40').ok).toBe(true);
    const b = runCommand(p, 'ride build carousel 20 30 --rot 2 --name "Big Spin"');
    expect(b.ok).toBe(true);
    expect(b.focus).toMatchObject({ x: 20, y: 30 });
    expect(runCommand(p, 'ride price big spin 2.5').text).toContain('2.50 cr');
    expect(runCommand(p, 'ride open big spin').ok).toBe(true);
    expect(runCommand(p, 'ride list').text).toContain('Big Spin [open]');
  });

  it('explains mistakes', () => {
    const p = Park.create(c, 'meadow', 1);
    expect(runCommand(p, 'ride').text).toContain('needs a verb');
    expect(runCommand(p, 'ride build').text).toContain('usage: pw ride build');
    expect(runCommand(p, 'teleport').text).toContain('unknown command');
    expect(runCommand(p, 'ride build zeppelin 1 1').text).toContain('hint: try one of');
  });

  it('shows the map and json output', () => {
    const p = Park.create(c, 'meadow', 1);
    expect(runCommand(p, 'map 24 44 --r 3').text).toContain('G');
    const j = JSON.parse(runCommand(p, 'park -o json').text);
    expect(j.cash).toBe(p.s.cash);
  });

  it('every command has help', () => {
    const p = Park.create(c, 'meadow', 1);
    const h = runCommand(p, 'help').text;
    for (const k of ['ride build', 'path place', 'staff hire', 'finance', 'visitors thoughts']) expect(h).toContain(k);
  });
});
