// Shared test setup: offline fonts, and a check that no test logged a console error or threw.
import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // The page loads Google Fonts; keep the run hermetic (and silent) by serving them empty.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await use(errors);
    expect(errors, 'console errors during the test').toEqual([]);
  }, { auto: true }],
});
export { expect };

type PW = { game: { s: any; content: any; speed: number; run(type: string, p: Record<string, unknown>): { ok: boolean; error?: string; cost?: number } } };

/** Wait for the game to boot and expose window.parkwright. */
export async function ready(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as { parkwright?: PW }).parkwright?.game);
}

/** Run a game action through the same validated path as the UI. */
export function run(page: Page, type: string, params: Record<string, unknown>) {
  return page.evaluate(([t, p]) => (window as unknown as { parkwright: PW }).parkwright.game.run(t, p), [type, params] as const);
}

export const state = (page: Page) => page.evaluate(() => {
  const g = (window as unknown as { parkwright: PW }).parkwright.game;
  return { name: g.s.name as string, cash: g.s.cash as number, rides: g.s.rides.length as number, tick: g.s.tick as number };
});
