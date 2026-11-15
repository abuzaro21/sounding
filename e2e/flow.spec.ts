// The full loop in a real browser: plan, measure, block, narrow, approve, drift, rollback, re-simulate, commit, restore.
import { test, expect, type Page } from '@playwright/test';

const shot = async (page: Page, name: string, full = true) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/evidence/screens/${test.info().project.name}-${name}.png`, fullPage: full });
};
async function noHorizontalScroll(page: Page) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, 'no horizontal page scroll').toBeLessThanOrEqual(w);
}

test('simulate, block, narrow, survive drift, commit, restore', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'An agent wants to change your data.' })).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Remove inactive customer accounts older than 18 months' }).click();
  const verdict = page.getByRole('heading', { name: /Blocked/ });
  await expect(verdict).toBeVisible();
  await expect(verdict).toBeFocused();
  await expect(page.getByText(/The dry run measured/)).toContainText(/row changes in \d+ tables/);
  await expect(page.getByRole('button', { name: /^payments: \d+ deleted/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await page.waitForTimeout(800);
  await noHorizontalScroll(page);
  await shot(page, '1-blocked');

  // Drill down: one layer's rows, before and after.
  await page.getByRole('button', { name: /^support cases: \d+ changed/ }).click();
  await expect(page.getByRole('heading', { name: /Before → after · support cases/ })).toBeVisible();
  await expect(page.locator('.diff-row').first()).toContainText('customer_id');

  await page.getByRole('button', { name: 'Let the agent narrow it' }).click();
  await expect(page.getByRole('heading', { name: /Safe to approve/ })).toBeVisible();
  await expect(page.getByText(/I am excluding \d+ customers/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve \d+ changes$/ }).click();
  await expect(page.getByRole('heading', { name: 'Approved, not yet executed' })).toBeVisible();
  await expect(page.getByText('One-time nonce')).toBeVisible();

  // The business moves on before execution.
  await page.getByRole('button', { name: /phones in an order/ }).click();
  await expect(page.getByText(/just phoned in an order/)).toBeVisible();
  await shot(page, '2-approved-drift');
  await page.getByRole('button', { name: 'Execute' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Reality differed from the approved simulation');
  await expect(dialog).toContainText(/Rolled back before commit\..*identical/);
  await expect(dialog).toContainText(/(\d+) of \1 touched rows re-read intact/);
  await shot(page, '3-incident', false);

  // Re-simulate on current data: the new order now blocks that customer; narrow again and commit.
  await dialog.getByRole('button', { name: 'Simulate again on current data' }).click();
  await expect(page.getByRole('heading', { name: /Blocked/ })).toBeVisible();
  await page.getByRole('button', { name: 'Let the agent narrow it' }).click();
  await expect(page.getByRole('heading', { name: /Safe to approve/ })).toBeVisible();
  await page.getByRole('button', { name: /^Approve \d+ changes$/ }).click();
  await page.getByRole('button', { name: 'Execute' }).click();
  await expect(page.getByRole('heading', { name: 'Committed and verified' })).toBeVisible();
  await expect(page.locator('.receipt .checks li.bad')).toHaveCount(0);
  await shot(page, '4-committed');

  // Restore through the same gate.
  await page.getByRole('button', { name: 'Plan a restoration' }).click();
  await expect(page.getByRole('heading', { name: /Safe to approve/ })).toBeVisible();
  await expect(page.getByText(/restored along with them/)).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '5-restore-simulated');
  await page.getByRole('button', { name: /^Approve \d+ changes$/ }).click();
  await page.getByRole('button', { name: 'Execute' }).click();
  await expect(page.getByRole('heading', { name: 'Committed and verified' })).toBeVisible();
  await expect(page.getByText(/cancelled before dispatch/)).toBeVisible();
  await expect(page.getByText('hash chain verified')).toBeVisible();
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('the compiler refuses anything that is not an allowlisted request', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Business request').fill('DELETE FROM customers; DROP TABLE orders');
  await page.getByRole('button', { name: 'Plan and simulate' }).click();
  await expect(page.getByRole('alert')).toContainText('plain words');
  await page.getByLabel('Business request').fill('delete all the customers');
  await page.getByRole('button', { name: 'Plan and simulate' }).click();
  await expect(page.getByRole('alert')).toContainText('Not an allowlisted action');
  await expect(page.getByRole('heading', { name: 'An agent wants to change your data.' })).toBeVisible();
});

test('cancelling unpaid orders surfaces refunds, scope can be changed, and Reset restores fresh data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Cancel unpaid orders older than 14 days' }).click();
  await expect(page.getByRole('heading', { name: /Blocked/ })).toBeVisible();
  await expect(page.locator('.findings')).toContainText(/refund/i);
  await page.getByRole('button', { name: 'Change scope' }).click();
  await page.getByLabel(/Unpaid for more than/).fill('30');
  await page.getByRole('button', { name: 'Propose this scope' }).click();
  await expect(page.getByText('more than 30 days')).toBeVisible();
  await page.getByRole('button', { name: 'Reset data' }).click();
  await expect(page.getByRole('heading', { name: 'An agent wants to change your data.' })).toBeVisible();
});
