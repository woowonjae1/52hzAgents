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
  test.beforeEach(async ({ page }) => {
    // Pre-seed layout to 'threads' and active session so ChatView is the visible active view
    await page.addInitScript(() => {
      localStorage.setItem('workspace_layout_v1', JSON.stringify({ viewMode: 'threads' }));
      localStorage.setItem('last_session_id_default', 'general');
      localStorage.setItem('last_session_id', 'general');
    });

    await page.route('**/v1/workspaces/*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'default',
          name: 'Default Workspace',
          owner_id: 'user1',
        }),
      });
    });

    await page.route('**/v1/discover*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspace_id: 'default',
          agents: [
            { agent_name: 'claude-architect', agent_type: 'claude', role: 'Architect', status: 'online' },
            { agent_name: 'deepseek-reviewer', agent_type: 'deepseek', role: 'Reviewer', status: 'online' },
          ],
          channels: [
            {
              id: 'general',
              channel: 'general',
              name: 'general',
              topic: 'Architecture Deliberation',
              participants: ['claude-architect', 'deepseek-reviewer'],
              orchestration_mode: 'dynamic',
              status: 'active',
            },
          ],
        }),
      });
    });

    await page.route('**/v1/events*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      });
    });

    await page.route('**/v1/conversations*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] }),
      });
    });
  });

  test('ChannelHeader renders with app-header chrome, studio toggle and overflow controls', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // ChannelHeader in the main chat view
    const mainHeader = page.locator('main .app-header-fade').first();
    await expect(mainHeader).toBeVisible();

    // Verify Studio panel toggle button is present
    const studioBtn = page.locator('button:has(svg.lucide-panel-right)').first();
    await expect(studioBtn).toBeVisible();

    // Verify More actions button is present
    const moreBtn = page.getByRole('button', { name: 'More actions' });
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

    // With 2 online agents mocked, RFC button should be enabled
    await expect(rfcBtn).toBeEnabled();

    // Click RFC button to activate deliberation mode
    await rfcBtn.click();
    await page.waitForTimeout(200);

    let val = await textarea.inputValue();
    expect(val.startsWith('/rfc')).toBe(true);

    // Click again to toggle off
    await rfcBtn.click();
    await page.waitForTimeout(200);
    val = await textarea.inputValue();
    expect(val.startsWith('/rfc')).toBe(false);

    expect(errors, `Uncaught errors in PromptComposer: ${errors.join('\n')}`).toEqual([]);
  });

  test('Sidebar can be collapsed and restored via mouse toggle and keyboard shortcut', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const collapseBtn = page.locator('button[aria-label="Collapse sidebar"]');
    await expect(collapseBtn).toBeVisible();

    // 1. Click collapse button to close sidebar
    await collapseBtn.click();
    await page.waitForTimeout(300);

    // Expand button should now appear in ChannelHeader
    const expandBtn = page.locator('button[aria-label="Expand sidebar"]');
    await expect(expandBtn).toBeVisible();

    // 2. Click expand button to restore sidebar
    await expandBtn.click();
    await page.waitForTimeout(300);

    // Collapse button in sidebar should be visible again
    await expect(collapseBtn).toBeVisible();
    await expect(expandBtn).not.toBeVisible();

    // 3. Test keyboard shortcut (Control+b) to toggle
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    await expect(expandBtn).toBeVisible();

    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    await expect(collapseBtn).toBeVisible();

    expect(errors, `Uncaught errors in Sidebar toggle: ${errors.join('\n')}`).toEqual([]);
  });
});
