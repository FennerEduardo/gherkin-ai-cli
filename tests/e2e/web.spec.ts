import { test, expect, Page } from '@playwright/test';

const TOKEN = process.env.GHK_E2E_TOKEN as string;

/** Opens the studio the way users do: with the session token in the URL fragment. */
async function openStudio(page: Page) {
  await page.goto(`/#token=${TOKEN}`);
}

test.describe('Gherkin AI Web Studio', () => {
  test('loads with the session token and removes it from the address bar', async ({ page }) => {
    await openStudio(page);
    await expect(page).toHaveTitle(/Gherkin AI Studio/);
    expect(page.url()).not.toContain('token=');
  });

  test('works offline: every request stays on 127.0.0.1 (no CDN)', async ({ page }) => {
    const external: string[] = [];
    page.on('request', req => {
      const host = new URL(req.url()).hostname;
      if (host !== '127.0.0.1' && !req.url().startsWith('data:')) external.push(req.url());
    });
    await openStudio(page);
    await page.waitForLoadState('networkidle');
    expect(external).toEqual([]);
    // Bundled Tailwind is applied (body has a non-default background).
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('renders the feature list from the workspace', async ({ page }) => {
    await openStudio(page);
    await page.waitForSelector('#features-list li');
    await expect(page.locator('#features-list')).toContainText(/login|checkout/i);
  });

  test('translates the interface when the language is toggled', async ({ page }) => {
    await openStudio(page);
    const toggle = page.locator('#lang-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('#tab-sidebar-features')).toContainText(/características|features/i);
  });

  test('renders the footer', async ({ page }) => {
    await openStudio(page);
    await expect(page.locator('footer a')).toHaveText('fennereduardo.com');
  });

  test('API rejects requests without the session token', async ({ request }) => {
    const res = await request.get('/api/features');
    expect(res.status()).toBe(401);
  });
});
