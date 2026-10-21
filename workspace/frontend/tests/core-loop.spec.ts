import { test, expect, Page } from '@playwright/test';

function attachErrorGuards(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter out non-fatal network polling/EventSource disconnects on static test server
      if (
        text.includes('Failed to load resource') ||
        text.includes('favicon.ico') ||
        text.includes('[Fast Refresh]') ||
        text.includes('EventSource') ||
        text.includes('404')
      ) {
        return;
      }
      errors.push(`[Console Error] ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    errors.push(`[Unhandled Error] ${err.message}`);
  });

  return errors;
}

test.describe('Core Loop E2E Regression Suite (Connect -> Message -> Approval -> Rollback)', () => {
  test.beforeEach(async ({ page }) => {
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
            {
              agent_name: 'claude-architect',
              agent_type: 'claude',
              role: 'Architect',
              status: 'online',
              joined_at: new Date().toISOString(),
            },
            {
              agent_name: 'deepseek-reviewer',
              agent_type: 'deepseek',
              role: 'Reviewer',
              status: 'online',
              joined_at: new Date().toISOString(),
            },
          ],
          channels: [
            {
              id: 'general',
              channel: 'general',
              name: 'general',
              topic: 'Core Deliberation Channel',
              participants: ['claude-architect', 'deepseek-reviewer'],
              orchestration_mode: 'dynamic',
              status: 'active',
              created_at: new Date(Date.now() - 3600_000).toISOString(),
            },
          ],
        }),
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

  // ── Path 1: Agent 接入与预设配置 (Connect Agent & Presets) ──
  test('Path 1: Connect & configure agents from Home Dashboard', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.addInitScript(() => {
      localStorage.setItem('workspace_layout_v1', JSON.stringify({ viewMode: 'home' }));
    });

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    // Verify HomeDashboard is active and displays agent count
    const agentsHeading = page.getByRole('heading', { name: 'Agents' }).first();
    await expect(agentsHeading).toBeVisible();

    const onlineBanner = page.locator('text=/\\d+ of \\d+ agents online/i');
    await expect(onlineBanner).toBeVisible();

    // Verify Preset buttons exist
    const codeReviewPreset = page.locator('button:has-text("Code review")').first();
    await expect(codeReviewPreset).toBeVisible();

    // Verify online agent checklist items exist
    const architectCheckbox = page.getByRole('checkbox', {
      name: /Add @claude-architect to the session/i,
    });
    await expect(architectCheckbox).toBeVisible();

    expect(errors, `Uncaught errors in Path 1: ${errors.join('\n')}`).toEqual([]);
  });

  // ── Path 2: 发送任务消息 (Send Message) ──
  test('Path 2: Dispatch task message into chat transcript', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.addInitScript(() => {
      localStorage.setItem('workspace_layout_v1', JSON.stringify({ viewMode: 'threads' }));
      localStorage.setItem('last_session_id_default', 'general');
      localStorage.setItem('last_session_id', 'general');
    });

    let sentEventBody: Record<string, unknown> | null = null;
    await page.route('**/v1/events*', async (route) => {
      if (route.request().method() === 'POST') {
        sentEventBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            event_id: 'evt-msg-1',
            status: 'confirmed',
            timestamp: new Date().toISOString(),
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      });
    });

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const textarea = page.locator('textarea[data-chat-input="true"]');
    await expect(textarea).toBeVisible();

    // Type task prompt
    const testTask = 'Optimize PostgreSQL index strategy for multi-agent transcripts';
    await textarea.fill(testTask);

    // Click Send message button
    const sendBtn = page.locator('button[aria-label="Send message"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // Verify optimistic message is displayed immediately in the transcript
    await expect(page.locator(`text=${testTask}`).first()).toBeVisible();

    // Verify POST event payload was delivered
    expect(sentEventBody).not.toBeNull();
    expect(errors, `Uncaught errors in Path 2: ${errors.join('\n')}`).toEqual([]);
  });

  // ── Path 3: 工具权限审批 (Tool Approval & Decision) ──
  test('Path 3: Interactively inspect and approve tool execution request', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.addInitScript(() => {
      localStorage.setItem('workspace_layout_v1', JSON.stringify({ viewMode: 'threads' }));
      localStorage.setItem('last_session_id_default', 'general');
      localStorage.setItem('last_session_id', 'general');
    });

    let approvalResponseDelivered = false;
    await page.route('**/v1/events*', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        if (body.metadata?.tool_approval_response || body.payload?.tool_approval_response) {
          approvalResponseDelivered = true;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            event_id: 'evt-appr-resp-1',
            status: 'confirmed',
            timestamp: new Date().toISOString(),
          }),
        });
        return;
      }

      // Return a pending tool approval request event
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            {
              id: 'evt-appr-1',
              event_id: 'evt-appr-1',
              target: 'channel/general',
              source: 'claude-architect',
              type: 'workspace.message',
              timestamp: new Date().toISOString(),
              payload: {
                content: 'I need to run the database migration before proceeding with index optimizations.',
                sender_type: 'agent',
                sender_name: 'claude-architect',
                message_type: 'chat',
              },
              metadata: {
                tool_approval_request: {
                  approval_id: 'appr-mig-42',
                  tool: 'bash',
                  args: { command: 'go run ./cmd/migrate up' },
                },
              },
            },
          ],
        }),
      });
    });

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Verify Tool Confirmation card is rendered
    const toolTitle = page.locator('text=Run bash?').first();
    await expect(toolTitle).toBeVisible();

    const approvalRequiredBadge = page.locator('text=Approval required').first();
    await expect(approvalRequiredBadge).toBeVisible();

    // Verify "Allow once" button is present and click it
    const allowBtn = page.getByRole('button', { name: 'Allow once' }).first();
    await expect(allowBtn).toBeVisible();
    await allowBtn.click();
    await page.waitForTimeout(300);

    // Verify approval badge updates to Approved
    await expect(page.locator('text=Approved').first()).toBeVisible();
    expect(approvalResponseDelivered).toBe(true);

    expect(errors, `Uncaught errors in Path 3: ${errors.join('\n')}`).toEqual([]);
  });

  // ── Path 4: 变更审计与一键安全回滚 (Turn Changes & Safe Rollback) ──
  test('Path 4: Inspect code modifications and execute safe 1-click rollback', async ({ page }) => {
    const errors = attachErrorGuards(page);

    await page.addInitScript(() => {
      localStorage.setItem('workspace_layout_v1', JSON.stringify({ viewMode: 'threads' }));
      localStorage.setItem('last_session_id_default', 'general');
      localStorage.setItem('last_session_id', 'general');
    });

    let rollbackCalledWithTurnId: string | null = null;
    await page.route('**/v1/git/turn-rollback*', async (route) => {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        rollbackCalledWithTurnId = body.turn_id;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ok',
            turn_id: body.turn_id,
            reverted: ['src/config.ts', 'src/db.ts'],
          }),
        });
        return;
      }
    });

    await page.route('**/v1/events*', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ event_id: 'evt-post', status: 'confirmed' }),
        });
        return;
      }

      // Return a message that includes turn_changes metadata
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            {
              id: 'evt-turn-1',
              event_id: 'evt-turn-1',
              target: 'channel/general',
              source: 'deepseek-reviewer',
              type: 'workspace.message',
              timestamp: new Date().toISOString(),
              payload: {
                content: 'Refactored database connection pooling settings.',
                sender_type: 'agent',
                sender_name: 'deepseek-reviewer',
                message_type: 'chat',
              },
              metadata: {
                turn_changes: {
                  turn_id: 'turn-audit-88',
                  status: 'active',
                  file_count: 2,
                  additions: 22,
                  deletions: 4,
                  changes: [
                    { path: 'src/config.ts', status: 'M', additions: 14, deletions: 3 },
                    { path: 'src/db.ts', status: 'M', additions: 8, deletions: 1 },
                  ],
                },
              },
            },
          ],
        }),
      });
    });

    await page.goto('/default/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Verify Turn Changes capsule is present with file count (e.g. "2 files changed")
    const turnSummary = page.locator('text=2 files changed').first();
    await expect(turnSummary).toBeVisible();

    // Verify "Roll back" button exists
    const rollbackBtn = page.getByRole('button', { name: 'Roll back' }).first();
    await expect(rollbackBtn).toBeVisible();

    // Click Roll back -> triggers confirmation step
    await rollbackBtn.click();
    await page.waitForTimeout(200);

    const confirmBtn = page.getByRole('button', { name: 'Confirm' }).first();
    await expect(confirmBtn).toBeVisible();

    // Confirm rollback
    await confirmBtn.click();
    await page.waitForTimeout(500);

    // Verify rollback endpoint was contacted with the exact turn ID
    expect(rollbackCalledWithTurnId).toBe('turn-audit-88');

    // Verify rolled back badge
    await expect(page.locator('text=Changes rolled back').first()).toBeVisible();

    expect(errors, `Uncaught errors in Path 4: ${errors.join('\n')}`).toEqual([]);
  });
});
