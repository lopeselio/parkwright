import { test, expect, ready, state } from './fixtures.ts';

test('title screen → New park → scenario → name → Open the gates starts that park', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('dialog', { name: 'Parkwright', exact: true });
  await expect(title.getByRole('heading', { name: 'Parkwright' })).toBeVisible();
  await title.getByRole('button', { name: /New park/ }).click();

  await expect(title.getByRole('heading', { name: 'New park' })).toBeVisible();
  const scenarios = title.getByRole('group', { name: 'Scenario' }).getByRole('button');
  await expect(scenarios.first()).toBeVisible();
  const pick = scenarios.last();
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');

  await title.getByLabel('Park name').fill('Playwright Pier');
  await title.getByRole('button', { name: 'Open the gates' }).click();

  await expect(title).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Welcome to Parkwright' })).toBeVisible(); // first-timers get the welcome
  await expect(page.locator('#top .brand b')).toHaveText('Playwright Pier');
  await ready(page);
  expect((await state(page)).name).toBe('Playwright Pier');
});
