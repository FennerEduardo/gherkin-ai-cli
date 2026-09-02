import { test, expect } from '@playwright/test';

test.describe('Gherkin AI Web Studio', () => {

  test('should load the web studio and have correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Gherkin AI Studio/);
  });

  test('should render the directory explorer and features', async ({ page }) => {
    await page.goto('/');
    
    // Wait for features to load (from the specs/ folder we created)
    await page.waitForSelector('#features-list li');
    
    // Check if the login or checkout features are visible
    const textContent = await page.textContent('body');
    expect(textContent).toMatch(/login|checkout/i);
  });

  test('should translate interface when language is toggled', async ({ page }) => {
    await page.goto('/');
    
    // The language toggle should switch to ES
    const toggle = page.locator('#lang-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();

    // Check if English text is replaced by Spanish
    const heading = await page.locator('#tab-sidebar-features').textContent();
    expect(heading).toMatch(/características|features/i);
  });

  test('should render the footer', async ({ page }) => {
    await page.goto('/');
    const footerLink = page.locator('footer a');
    await expect(footerLink).toHaveText('fennereduardo.com');
  });
});
