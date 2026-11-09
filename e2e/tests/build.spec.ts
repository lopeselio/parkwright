import { test, expect, ready, run, state } from './fixtures.ts';

test('with ?play, a path and a ride go in and the cash drops by the cost', async ({ page }) => {
  await page.goto('/?play');
  await ready(page);
  await expect(page.getByRole('dialog')).toHaveCount(0); // ?play skips the title screen
  await page.evaluate(() => { (window as any).parkwright.game.speed = 0; }); // no running costs or income mid-test

  const before = await state(page);
  const path = await run(page, 'path.place', { x: 24, y: 33, x2: 24, y2: 40 });
  expect(path.ok, path.error).toBe(true);
  const afterPath = await state(page);
  expect(afterPath.cash).toBe(before.cash - path.cost!);

  const ride = await run(page, 'ride.build', { type: 'teacups', x: 21, y: 34, rot: 1 });
  expect(ride.ok, ride.error).toBe(true);
  const cost = await page.evaluate(() => (window as any).parkwright.game.content.rideTypes.teacups.cost as number);
  expect(ride.cost).toBe(cost);
  const after = await state(page);
  expect(after.rides).toBe(before.rides + 1);
  expect(after.cash).toBe(afterPath.cash - cost);

  // The HUD shows the new balance.
  const shown = await page.evaluate((c) => `${(c / 100).toLocaleString(undefined, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })} cr`, after.cash);
  await expect(page.locator('#top .stat').filter({ hasText: 'Cash' }).locator('b')).toHaveText(shown);
});
