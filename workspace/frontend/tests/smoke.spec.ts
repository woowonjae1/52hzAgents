import { test, expect } from '@playwright/test';

// Helper to track uncaught exceptions and console errors
function attachErrorGuards(page: import('@playwright/test').Page) {
  const errors: string[] = [];

  page.on('pageerror', (err) => {
    errors.push(`[PageError] ${err.message}\n${err.stack || ''}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore routine network failures when API backend is offline during smoke test
      if (
        text.includes('Failed to fetch') ||
        text.includes('NetworkError') ||
        text.includes('ERR_CONNECTION_REFUSED') ||
        text.includes('/v1/workspaces') ||
        text.includes('EventSource') ||
        text.includes('404')
      ) {
        return;
      }
      errors.push(`[ConsoleError] ${text}`);
    }
  });

  return errors;
}

test.describe('Frontend Smoke Tests (Browser Mount & Hydration)', () => {
  test('Root / mounts and redirects cleanly without blank screen', async ({ page }) => {
    const errors = attachErrorGuards(page);

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);

    // Wait for client-side hydration
    await page.waitForTimeout(1000);

    // Assert body has mounted non-empty content
    const bodyContent = await page.locator('body').innerHTML();
    expect(bodyContent.trim().length).toBeGreaterThan(50);

    // Ensure zero uncaught React/Radix exceptions
    expect(errors, `Uncaught errors on /: ${errors.join('\n')}`).toEqual([]);
  });

  test('Main Workspace /default/ hydrates with Providers, Sidebar & Chat layout', async ({ page }) => {
    const errors = attachErrorGuards(page);

    const response = await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);

    await page.waitForTimeout(1500);

    // Check that Radix/React tree hydrated and main layout is rendered
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // Verify Tailwind theme/classes took effect (not unstyled plain document)
    const hasClassOrStyle = await page.evaluate(() => {
      const root = document.querySelector('html');
      return Boolean(root && (root.classList.length > 0 || root.getAttribute('style')));
    });
    expect(hasClassOrStyle, 'Theme class or style must be applied to HTML root').toBe(true);

    // Verify critical layout elements rendered
    const layoutExists = await page.evaluate(() => {
      return Boolean(
        document.querySelector('[data-radix-scroll-area-viewport]') ||
        document.querySelector('main') ||
        document.querySelector('nav') ||
        document.querySelector('textarea') ||
        document.querySelector('input')
      );
    });
    expect(layoutExists, 'Main layout or interactive elements must exist in DOM').toBe(true);

    // Ensure zero uncaught React / Radix / Context errors
    expect(errors, `Uncaught errors on /default/: ${errors.join('\n')}`).toEqual([]);
  });

  test('QuickBar /quickbar/ floating window mounts without invariant crashes', async ({ page }) => {
    const errors = attachErrorGuards(page);

    const response = await page.goto('/quickbar/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);

    await page.waitForTimeout(1000);

    // QuickBar input or card container must be present
    const content = await page.locator('body').innerText();
    expect(content.length).toBeGreaterThan(0);

    expect(errors, `Uncaught errors on /quickbar/: ${errors.join('\n')}`).toEqual([]);
  });

  test('Agents Demo /agents-demo/ catalog mounts without missing provider crashes', async ({ page }) => {
    const errors = attachErrorGuards(page);

    const response = await page.goto('/agents-demo/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);

    await page.waitForTimeout(1000);

    const bodyContent = await page.locator('body').innerHTML();
    expect(bodyContent.trim().length).toBeGreaterThan(50);

    expect(errors, `Uncaught errors on /agents-demo/: ${errors.join('\n')}`).toEqual([]);
  });
});
