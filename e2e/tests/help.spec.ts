import { test, expect, ready } from './fixtures.ts';

test('? opens How to play and Esc closes it', async ({ page }) => {
  await page.goto('/?play');
  await ready(page);
  await page.locator('#view').focus();
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'How to play' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Controls' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
