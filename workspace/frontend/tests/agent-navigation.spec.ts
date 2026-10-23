import { test, expect } from '@playwright/test';

test('Workbench Navigation: Seamless round-trip between Chat Sessions and Agent Team', async ({ page }) => {
  await page.route('**/v1/workspaces/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'default',
        name: 'OpenAgents Workspace',
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
          { agent_name: 'deepseek-coder', agent_type: 'deepseek', role: 'Coder', status: 'online' },
        ],
        channels: [
          {
            id: 'session-1',
            channel: 'session-1',
            name: 'Architecture Planning',
            topic: 'System Architecture',
            participants: ['claude-architect', 'deepseek-coder'],
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

  await page.goto('/default/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // 1. Verify primary sidebar navigation item "Agent Team" is visible with live online badge
  const agentTeamBtn = page.locator('nav[aria-label="Workbench destinations"] button:has-text("Agent Team")');
  await expect(agentTeamBtn).toBeVisible();
  await expect(agentTeamBtn).toContainText('2 online');

  // 2. Click "Agent Team" in sidebar to open the Agent Management Dashboard
  await agentTeamBtn.click();
  await page.waitForTimeout(500);

  // Verify Agent Team dashboard mounts cleanly
  const agentTeamHeading = page.locator('h1:has-text("Agent Team")');
  await expect(agentTeamHeading).toBeVisible();

  // Verify Connect Agent and Open Chat buttons exist
  const connectBtn = page.locator('button:has-text("Connect Agent")');
  await expect(connectBtn).toBeVisible();

  const openChatBtn = page.locator('button:has-text("Open Chat")');
  await expect(openChatBtn).toBeVisible();

  // 3. Click "Open Chat" to return to chat sessions
  await openChatBtn.click();
  await page.waitForTimeout(500);

  // 4. Click the header's agent online badge to jump straight back to Agent Team
  const headerAgentPill = page.locator('button[title="Open Agent Team Management"]');
  if (await headerAgentPill.isVisible()) {
    await headerAgentPill.click();
    await page.waitForTimeout(500);
    await expect(agentTeamHeading).toBeVisible();
  }
});
