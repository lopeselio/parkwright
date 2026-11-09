import { test, expect, ready, run } from './fixtures.ts';

test('Publish & share returns a park id and the server verifies it by replay', async ({ page, request }) => {
  await page.goto('/?play');
  await ready(page);
  // Play a little: build, open a ride, let the sim run for a while.
  expect((await run(page, 'path.place', { x: 24, y: 33, x2: 24, y2: 47 })).ok).toBe(true);
  expect((await run(page, 'ride.build', { type: 'teacups', x: 21, y: 34, rot: 1 })).ok).toBe(true);
  await page.evaluate(() => { (window as any).parkwright.game.speed = 4; });
  await page.waitForFunction(() => (window as any).parkwright.game.s.tick > 200);

  await page.locator('#top [data-tour="parks"]').click();
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/parks') && r.request().method() === 'POST');
  await page.locator('#side').getByRole('button', { name: 'Publish & share' }).click();
  const res = await posted;
  expect(res.status()).toBe(201);
  const { id } = await res.json() as { id: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  await expect(page.locator('#side').getByRole('button', { name: 'Copy share link' })).toBeVisible();

  await expect.poll(async () => {
    const r = await request.get(`/api/parks/${id}/verify`);
    return (await r.json()).verified;
  }, { timeout: 30_000, message: 'park never verified' }).toBe(true);
});
