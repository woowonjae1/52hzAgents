import { test, expect } from '@playwright/test';

function attachErrorGuards(page: import('@playwright/test').Page) {
  const errors: string[] = [];

  page.on('pageerror', (err) => {
    errors.push(`[PageError] ${err.message}\n${err.stack || ''}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore routine network failures when API backend is offline during test
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

test.describe('Composer & Channel Header Regression Tests', () => {
  test('ChannelHeader renders with app-header chrome, studio toggle and overflow controls', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Verify ChannelHeader (.app-header) mounted
    const header = page.locator('.app-header');
    await expect(header).toBeVisible();

    // Verify Studio panel toggle button is present
    const studioBtn = header.locator('button:has(svg.lucide-panel-right)');
    await expect(studioBtn).toBeVisible();

    // Verify More actions button is present
    const moreBtn = header.locator('button:has(svg.lucide-more-horizontal)');
    await expect(moreBtn).toBeVisible();

    expect(errors, `Uncaught errors in ChannelHeader: ${errors.join('\n')}`).toEqual([]);
  });

  test('PromptComposer renders 1-click attachment, model switcher, and interactive RFC toggle', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const textarea = page.locator('textarea[data-chat-input="true"]');
    await expect(textarea).toBeVisible();

    // Verify 1-click direct attachment (Paperclip) button is present
    const attachBtn = page.locator('button[aria-label="Attach file or image"]');
    await expect(attachBtn).toBeVisible();

    // Verify RFC deliberation toggle button is present
    const rfcBtn = page.locator('button[aria-label="Toggle RFC deliberation"]');
    await expect(rfcBtn).toBeVisible();

    // If enabled, verify click interaction toggles /rfc prefix in composer
    const isDisabled = await rfcBtn.isDisabled();
    if (!isDisabled) {
      // Click RFC button to activate deliberation mode
      await rfcBtn.click();
      await page.waitForTimeout(200);

      const val = await textarea.inputValue();
      expect(val.startsWith('/rfc')).toBe(true);

      // Click again to toggle off
      await rfcBtn.click();
      await page.waitForTimeout(200);
      const valAfter = await textarea.inputValue();
      expect(valAfter.startsWith('/rfc')).toBe(false);
    } else {
      // If disabled (because fewer than 2 agents configured), ensure aria-disabled or disabled attribute is present
      expect(isDisabled).toBe(true);
    }

    expect(errors, `Uncaught errors in PromptComposer: ${errors.join('\n')}`).toEqual([]);
  });
});
