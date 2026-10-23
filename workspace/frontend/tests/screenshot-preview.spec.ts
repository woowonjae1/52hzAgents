import { test } from '@playwright/test';
import path from 'path';

test('Capture workbench screenshots', async ({ page }) => {
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
            id: 'general',
            channel: 'general',
            name: 'general',
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
  await page.waitForTimeout(1500);

  // 1. Open a new session to capture the OpenWork centered empty hero
  const newSessionBtn = page.locator('button[aria-label="New session"]');
  if (await newSessionBtn.isVisible()) {
    await newSessionBtn.click();
    await page.waitForTimeout(500);
  }

  const artifactDir = 'C:/Users/Administrator/.gemini/antigravity/brain/86a1d2f6-6a28-4e09-bd2f-ba31ab1872aa';
  await page.screenshot({ path: path.join(artifactDir, 'workbench_empty_hero.png'), fullPage: true });

  // 2. Click suggestion card to fill prompt
  const refactorCard = page.locator('button:has-text("Refactor & review")');
  if (await refactorCard.isVisible()) {
    await refactorCard.click();
    await page.waitForTimeout(300);
  }

  // 3. Mock incoming messages to capture the active conversation stream
  await page.route('**/v1/events*', async (route) => {
    if (route.request().method() === 'POST') {
      const postData = route.request().postDataJSON() || {};
      const isCreateChannel = postData.type === 'network.channel.create';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          event_id: 'evt-post-1',
          status: 'confirmed',
          metadata: isCreateChannel ? { channel_name: 'session-demo' } : {},
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        events: [
          {
            event_id: 'evt-user-1',
            type: 'workspace.message.posted',
            target: 'channel/session-demo',
            source: 'human:Architect',
            timestamp: new Date(Date.now() - 30_000).toISOString(),
            payload: {
              content: 'Review the core architecture and suggest concrete improvements.',
              sender_type: 'human',
              sender_name: 'Architect',
            },
          },
          {
            event_id: 'evt-tool-1',
            type: 'workspace.message.posted',
            target: 'channel/session-demo',
            source: 'agent:claude-architect',
            timestamp: new Date(Date.now() - 20_000).toISOString(),
            payload: {
              content: 'Read workbench-layout.tsx',
              sender_type: 'agent',
              sender_name: 'claude-architect',
              message_type: 'tool_call',
            },
            metadata: {
              tool_name: 'read',
              tool_args: JSON.stringify({ filePath: 'workspace/frontend/components/workbench/workbench-layout.tsx' }),
              tool_status: 'ok',
              tool_summary: 'Read workbench-layout.tsx',
            },
          },
          {
            event_id: 'evt-tool-2',
            type: 'workspace.message.posted',
            target: 'channel/session-demo',
            source: 'agent:claude-architect',
            timestamp: new Date(Date.now() - 10_000).toISOString(),
            payload: {
              content: '$ git status',
              sender_type: 'agent',
              sender_name: 'claude-architect',
              message_type: 'tool_call',
            },
            metadata: {
              tool_name: 'bash',
              tool_args: JSON.stringify({ command: 'git status' }),
              tool_status: 'ok',
              tool_summary: '$ git status',
            },
          },
          {
            event_id: 'evt-agent-1',
            type: 'workspace.message.posted',
            target: 'channel/session-demo',
            source: 'agent:claude-architect',
            timestamp: new Date().toISOString(),
            payload: {
              content: '### Architectural Review\n\nI have completed the review of the workspace.\n\n```typescript\nexport interface AgentWorkbench {\n  status: "active";\n  mode: "claude-desktop";\n}\n```\n\n1. **Modularity**: Clean separation between shell, kernel, and domains.\n2. **Performance**: Virtualized streaming lists ensure zero frame drops.\n3. **Reliability**: Seamless state persistence across reloads.',
              sender_type: 'agent',
              sender_name: 'claude-architect',
            },
            metadata: {
              thinking: 'Analyzing component boundaries across workspace/frontend...\nChecking state isolation between layout-context and workspace-context.\nEvaluating message deduplication and virtualized rendering pipeline.\nEverything checks out cleanly with 0 cyclic dependencies.',
              thinking_duration: 3.4,
            },
          },
        ],
      }),
    });
  });

  // Send message
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Capture active conversation state
  await page.screenshot({ path: path.join(artifactDir, 'workbench_active_chat.png'), fullPage: true });
});
