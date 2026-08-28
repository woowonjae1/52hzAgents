/**
 * Shared workspace prompt builder for all adapters.
 *
 * Generates system prompt sections that teach agents about:
 * - Their identity and workspace context
 * - Multi-agent collaboration (@mention delegation)
 * - Workspace REST API skills (files, browser, tunnels)
 *
 * Direct port of Python: sdk/src/52hzAgents/adapters/workspace_prompt.py
 */

'use strict';

/**
 * Strong directive forcing agents to use the workspace browser when the
 * workspace has Browser Fabric enabled. Emitted high in the system prompt
 * so it wins against any earlier guidance that suggests local browsing
 * tools.
 *
 * Returns '' when the toggle is off; the caller can unconditionally
 * concatenate the result.
 *
 * Mirrors `build_browser_directive` in
 * sdk/src/52hzAgents/adapters/workspace_prompt.py.
 */
function buildBrowserDirective(browserEnabled) {
  if (!browserEnabled) return '';
  return (
    '\n## Browser Use (MANDATORY)\n' +
    'This workspace has the **shared Browser Fabric session** enabled. ' +
    'All web browsing MUST go through it so the user can watch the ' +
    'session live in their right-side panel and so cookies / state ' +
    'persist across agents.\n\n' +
    '**Use ONLY these tools for any web browsing:**\n' +
    '- `mcp__wwj-workspace__workspace_browser_open`\n' +
    '- `mcp__wwj-workspace__workspace_browser_navigate`\n' +
    '- `mcp__wwj-workspace__workspace_browser_click`\n' +
    '- `mcp__wwj-workspace__workspace_browser_type`\n' +
    '- `mcp__wwj-workspace__workspace_browser_snapshot`\n' +
    '- `mcp__wwj-workspace__workspace_browser_screenshot`\n' +
    '- `mcp__wwj-workspace__workspace_browser_list_tabs`\n' +
    '- `mcp__wwj-workspace__workspace_browser_close`\n' +
    '\n' +
    'If you don\'t have these MCP tools, use `Bash` + `curl` against ' +
    '`/v1/browser/tabs` (documented below in Shared Browser).\n\n' +
    '**FORBIDDEN â€?do NOT call any of these:**\n' +
    '- `mcp__browsermcp__*` (any local Browser MCP extension tool)\n' +
    '- `mcp__playwright__*`, `mcp__puppeteer__*`, `mcp__chrome-devtools__*`, or any other local-browser MCP\n' +
    '- `WebFetch`, `WebSearch`, `web_fetch`, `web_search`, or any built-in network/browser tool\n' +
    '\n' +
    'If a local browser tool errors with "extension isn\'t connected" or ' +
    '"connect your browser", do NOT ask the user to connect anything â€?' +
    'the local extension is irrelevant here. Immediately switch to the ' +
    'workspace browser tools above. The Browser Fabric session is already ' +
    'running on the backend.\n'
  );
}

/**
 * Build the identity section common to all adapters.
 *
 * `toolMode` controls how the "read prior context" hint is phrased:
 * - `'mcp'`    â†?names the native `workspace_get_history` MCP tool.
 * - `'skills'` â†?points at the wwj-workspace skill (Bash + curl),
 *   since no MCP server is spawned and that tool would not exist.
 */
function buildWorkspaceIdentity(agentName, workspaceId, channelName, mode = 'execute', toolMode = 'mcp') {
  const priorContext = toolMode === 'skills'
    ? (
      'When you need prior context, use the wwj-workspace skill to ' +
      `read this channel's recent messages (with \`channel="${channelName}"\`). ` +
      'Always specify the channel â€?the default may be different from where ' +
      'you are.\n'
    )
    : (
      'When you need prior context, call `workspace_get_history` with ' +
      `\`channel="${channelName}"\` (the current channel). Without the ` +
      'channel argument the tool falls back to a default channel that may ' +
      'be different from where you are.\n'
    );
  return (
    `You are agent '${agentName}' connected to a 52hzAgents workspace.\n` +
    'Your text responses are automatically posted to the workspace chat ' +
    'â€?just write your answer naturally.\n\n' +
    '## Workspace Context\n' +
    `- Workspace ID: ${workspaceId}\n` +
    `- Channel: ${channelName}  (this is the channel you are currently speaking in)\n` +
    `- Mode: ${mode}\n\n` +
    priorContext
  );
}

/**
 * Build the multi-agent collaboration instructions.
 *
 * `toolMode` tailors the discovery pointer: `skills` mode sends the agent to
 * the skill's "Discover Agents" section (Bash + curl), `mcp` mode names the
 * native tool.
 */
function buildCollaborationPrompt(toolMode = 'mcp') {
  const discover = toolMode === 'skills'
    ? (
      'Before delegating, use the wwj-workspace skill (see its ' +
      '"Discover Agents" section) to list the agents in this channel and read ' +
      'each one\'s description, then @mention the best-matched agent.\n'
    )
    : (
      'Before delegating, discover who is available and what they do: call ' +
      '`workspace_get_agents`, or the discover endpoint for full descriptions, ' +
      'and match the task to an agent\'s description before @mentioning it.\n'
    );
  return (
    '\n## Multi-Agent Collaboration\n' +
    'To delegate work to another agent, @mention them in your response. ' +
    'Only @mentioned agents will receive the message.\n\n' +
    'IMPORTANT: Do NOT @mention an agent just to say thanks or acknowledge ' +
    'â€?that wakes them up for nothing. Only @mention when you need them ' +
    'to do work. When the task is complete, report results to the user ' +
    'without @mentioning other agents.\n\n' +
    // Agents whose own runtime ships a sub-agent feature (Antigravity's
    // define_subagent/invoke_subagent, Claude Code's Task tool, â€? will happily
    // spin up a local helper NAMED after a workspace peer and then report
    // "handed off to @peer". The peer never ran, the user believes two agents
    // collaborated, and the answer carries one runtime's blind spots twice.
    'These agents are separate processes, not sub-agents of yours. If the user ' +
    'names another workspace agent, hand that step to THAT agent by @mentioning ' +
    'it and stopping â€?do not do its step yourself, and do not create a local ' +
    'sub-agent named after it. Your own sub-agent / Task tools are for splitting ' +
    'up YOUR OWN step, never for standing in for a named workspace agent. If you ' +
    'cannot reach it, say so plainly rather than simulating the hand-off.\n\n' +
    discover +
    buildDecisionProtocolPrompt() +
    buildPreviewProtocolPrompt()
  );
}

/**
 * Teach agents the preview-block protocol.
 *
 * Required for the same reason as the decision block: nothing else can supply
 * this. The daemon spawns the agent CLI, not the dev server â€?the server is
 * started by the agent's own shell tool, so its "ready on localhost:3000" line
 * never reaches us. Scraping the reply text for `localhost:\d+` was the
 * alternative and it fires on any sentence that mentions a port.
 *
 * The "only when actually running" rule is load-bearing: an agent that reports
 * a port it merely intends to use points the user's preview panel at a dead
 * address, which reads as the feature being broken.
 */
function buildPreviewProtocolPrompt() {
  return (
    '\n## Reporting a Local Preview URL\n' +
    'When you start a dev server the user should look at, emit a `preview` ' +
    'block. The workspace opens its Local Preview panel on that address, so ' +
    'the user sees the running app without leaving the chat.\n\n' +
    '```preview\n' +
    '{ "url": "http://localhost:3000", "label": "Next.js dev" }\n' +
    '```\n\n' +
    '`{ "port": 3000 }` is accepted as shorthand.\n\n' +
    'Rules:\n' +
    '- Emit it ONLY after the server is actually listening. Reporting a port ' +
    'you are about to use points the panel at nothing.\n' +
    '- Loopback addresses only (localhost, 127.0.0.1, *.localhost). Anything ' +
    'else is rejected and shown to the user as raw text.\n' +
    '- Re-emit the block if you restart the server on a different port. The ' +
    'most recent block in a reply wins.\n' +
    '- Do NOT emit it just because a port appears in a config file or in ' +
    'something you are describing. It means "this is live right now".\n'
  );
}

/**
 * Teach agents the decision-block protocol.
 *
 * Without this the parser in `decision-parser.js` has nothing to parse: the
 * workspace only promotes a question to an interactive card when the agent
 * opts in with this exact block, and no model emits it unprompted.
 *
 * The "ask in prose instead" instruction at the end is load-bearing. A model
 * told about a nice interactive widget will reach for it to present
 * information, not just to ask â€?and a card whose options are really just
 * bullet points forces the user to click to dismiss something that was never
 * a question.
 */
function buildDecisionProtocolPrompt() {
  return (
    '\n## Asking the User to Choose\n' +
    'When you need a decision from the user before you can continue, emit a ' +
    '`decision` block. The workspace renders it as clickable buttons and posts ' +
    'the answer back to you as a `[Decision]` message. Write the block INSTEAD ' +
    'of asking in prose â€?do not do both.\n\n' +
    '```decision\n' +
    '{\n' +
    '  "questions": [\n' +
    '    {\n' +
    '      "title": "Which auth strategy should I use?",\n' +
    '      "options": [\n' +
    '        { "label": "JWT", "description": "Stateless, scales across instances" },\n' +
    '        { "label": "Session", "description": "Revocable immediately" }\n' +
    '      ],\n' +
    '      "allowCustom": true\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    '```\n\n' +
    'Rules:\n' +
    '- Valid JSON, and the closing ``` is required. A block that fails to ' +
    'parse is shown to the user as raw text.\n' +
    '- `title` and at least one `option` are required. `description` and ' +
    '`allowCustom` are optional. Write them in the user\'s language.\n' +
    '- Use it ONLY for a real fork you cannot resolve yourself â€?a decision ' +
    'that changes what you do next. Do not use it to summarise options, to ' +
    'present findings, to confirm something obvious, or to ask permission for ' +
    'work you were already asked to do. Prefer making a reasonable call and ' +
    'saying what you assumed.\n' +
    '- After emitting a block, stop and wait. Do not guess the answer and ' +
    'carry on.\n'
  );
}

/**
 * Build mode-specific instructions.
 */
function buildModePrompt(mode) {
  if (mode === 'plan') {
    return (
      '\n## Mode: PLAN\n' +
      'You are in PLAN mode. Only read, analyze, and propose.\n' +
      '- Do NOT write code, make changes, or execute actions.\n' +
      '- Outline your plan step by step.\n' +
      '- Describe what changes you would make and why.\n' +
      '- Ask clarifying questions if needed.\n' +
      '- When the user is satisfied, they can switch you to Execute mode.\n'
    );
  }
  return (
    '\n## Mode: EXECUTE\n' +
    'You are in EXECUTE mode. You can write code, make changes, ' +
    'and take actions.\n' +
    'Be helpful, concise, and direct. Use markdown formatting.\n'
  );
}

/**
 * Build REST API skill instructions for non-MCP agents.
 *
 * These teach the agent how to interact with workspace resources
 * (files, browser, tunnels) by calling HTTP endpoints directly.
 *
 * In plan mode, only read-only operations are documented.
 */
function buildApiSkillsPrompt({ endpoint, workspaceId, token, agentName, channelName, disabledModules, mode = 'execute', isWindows = process.platform === 'win32' }) {
  const disabled = disabledModules || new Set();
  const baseUrl = endpoint.replace(/\/+$/, '');
  const isPlan = mode === 'plan';
  const h = `X-Workspace-Token: ${token}`;
  const curl = isWindows ? 'curl.exe' : 'curl';

  const sections = [];

  // Capabilities preamble
  const caps = [];
  if (!disabled.has('files')) caps.push('share and read files with other agents and users');
  if (!disabled.has('browser')) caps.push('browse websites in a shared browser');
  if (!disabled.has('knowledge')) caps.push('create and access a shared knowledge base');
  caps.push('discover other agents in the workspace');

  sections.push(
    '## Workspace Tools (MANDATORY)\n\n' +
    'You can ' + caps.join(', ') + '.\n' +
    'These are WORKSPACE tools shared with all agents and users. ' +
    'They are different from your native tools.\n\n' +
    '**HOW TO USE:** Call your `exec` tool to run the `curl` commands below. ' +
    'Do NOT output curl commands as text â€?EXECUTE them with `exec`.\n\n' +
    '**IMPORTANT â€?tool priority:**\n' +
    '- ALWAYS use `exec` + `curl` (documented below) for workspace operations.\n' +
    '- Do NOT use `workspace_browser_*` native tools â€?they are not configured ' +
    'and will fail.\n' +
    '- Do NOT use `web_fetch`, `browser`, or any native browsing tool ' +
    'when the user asks to use the workspace browser â€?use `exec` + `curl` instead.\n' +
    '- The workspace browser is a *shared* browser visible to all users and agents.\n\n' +
    '**Auth header** (include on every request):\n' +
    `\`X-Workspace-Token: ${token}\`\n`
  );

  // Files
  if (!disabled.has('files')) {
    let s = '\n### Shared Files\n\n';

    if (!isPlan) {
      if (isWindows) {
        s += (
          '**To upload a file**, exec this (replace filename/content):\n' +
          `$CONTENT = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('YOUR_CONTENT'))\n` +
          `${curl} -s -X POST ${baseUrl}/v1/files/base64 ` +
          `-H "${h}" ` +
          '-H "Content-Type: application/json" ' +
          `-d "{\\"filename\\":\\"report.md\\",` +
          `\\"content_base64\\":\\"$CONTENT\\",` +
          `\\"content_type\\":\\"text/markdown\\",` +
          `\\"network\\":\\"${workspaceId}\\",` +
          `\\"source\\":\\"52hz:${agentName}\\",` +
          `\\"channel_name\\":\\"${channelName}\\"}"\n\n`
        );
      } else {
        s += (
          '**To upload a file**, exec this (replace filename/content):\n' +
          `CONTENT=$(echo -n 'YOUR_CONTENT' | base64) && ` +
          `${curl} -s -X POST ${baseUrl}/v1/files/base64 ` +
          `-H "${h}" ` +
          '-H "Content-Type: application/json" ' +
          `-d '{"filename":"report.md",` +
          `"content_base64":"'"$CONTENT"'",` +
          `"content_type":"text/markdown",` +
          `"network":"${workspaceId}",` +
          `"source":"52hz:${agentName}",` +
          `"channel_name":"${channelName}"}'\n\n`
        );
      }
    }

    const tmpDir = isWindows ? '$env:TEMP' : '/tmp';
    s += (
      '**List files:**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/files?network=${workspaceId}\`\n\n` +
      '**Download file (text):**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/files/{file_id}\`\n\n` +
      '**Download file (binary/images) â€?save to disk, then use Read tool to view:**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/files/{file_id} -o ${tmpDir}/{filename}\`\n\n` +
      '**File info (metadata):**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/files/{file_id}/info\`\n`
    );

    if (!isPlan) {
      s += (
        '\n**Delete file:**\n' +
        `\`${curl} -s -X DELETE -H "${h}" ${baseUrl}/v1/files/{file_id}\`\n`
      );
    }

    sections.push(s);
  }

  // Browser
  if (!disabled.has('browser')) {
    let s = '\n### Shared Browser\n\n';

    s += (
      'The shared browser is a real cloud browser (backed by BrowserFabric) ' +
      'that all users and agents in the workspace share and can watch live. ' +
      'Drive it ONLY through these `/v1/browser` endpoints â€?never a local ' +
      'browser. Every tab is server-side; you interact by tab id.\n\n' +
      'When you open a tab, the JSON response includes an `id` (use it in every ' +
      'later call) and, in the cloud, a `live_url` â€?a link to the live, ' +
      'interactive view of that tab. Share the `live_url` with the user when ' +
      'they may want to watch or take over (e.g. a login or a CAPTCHA).\n\n'
    );

    if (!isPlan) {
      s += (
        '**To browse a website**, exec these steps (use exec for each):\n' +
        `Step 1 â€?open tab: ` +
        `${curl} -s -X POST ${baseUrl}/v1/browser/tabs ` +
        `-H "${h}" -H "Content-Type: application/json" ` +
        `-d '{"url":"https://example.com","network":"${workspaceId}",` +
        `"source":"52hz:${agentName}"}'\n` +
        `Step 2 â€?read content: ` +
        `${curl} -s -H "${h}" ${baseUrl}/v1/browser/tabs/TAB_ID/snapshot\n` +
        `Step 3 â€?close tab: ` +
        `${curl} -s -X DELETE -H "${h}" ${baseUrl}/v1/browser/tabs/TAB_ID\n` +
        '(Replace TAB_ID with the `id` from the step 1 response)\n\n'
      );
    }

    s += (
      '**List open tabs:**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/browser/tabs?network=${workspaceId}\`\n\n` +
      '**Get page content (text):**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/browser/tabs/{tab_id}/snapshot\`\n\n` +
      '**Get screenshot (PNG):**\n' +
      `\`${curl} -s -H "${h}" ${baseUrl}/v1/browser/tabs/{tab_id}/screenshot\`\n`
    );

    if (!isPlan) {
      s += (
        '\n**Open tab:**\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs` +
        ` -d '{"url":"URL","network":"${workspaceId}",` +
        `"source":"52hz:${agentName}"}'\`\n\n` +
        '**Navigate:**\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/navigate` +
        ` -d '{"url":"URL"}'\`\n\n` +
        '**Click element:**\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/click` +
        ` -d '{"selector":"CSS_SELECTOR"}'\`\n\n` +
        '**Type text:**\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/type` +
        ` -d '{"selector":"CSS_SELECTOR","text":"TEXT"}'\`\n` +
        '(add `"append":true` to keep existing text instead of replacing it)\n\n' +
        '**Press a key** (e.g. submit a form with Enter):\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/press_key` +
        ` -d '{"key":"Enter"}'\`\n\n` +
        '**Run JavaScript** in the page (returns the result):\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/evaluate` +
        ` -d '{"expression":"document.title"}'\`\n\n` +
        '**Close tab:**\n' +
        `\`${curl} -s -X DELETE -H "${h}" ${baseUrl}/v1/browser/tabs/{tab_id}\`\n\n` +
        '**Clicks/typing use CSS selectors only** (no pixel coordinates). If a ' +
        'selector is hard to find, use `evaluate` to inspect the DOM first.\n\n' +
        '**Persistent logins (contexts):** to reuse cookies/login across tabs ' +
        'and sessions, save the current tab as a named context, then open ' +
        'future tabs with that `context_id`:\n' +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs/{tab_id}/persist -d '{"name":"my-login"}'\`\n` +
        `\`${curl} -s -H "${h}" ${baseUrl}/v1/browser/contexts?network=${workspaceId}\`` +
        ` (list saved contexts and their ids)\n` +
        `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json"` +
        ` ${baseUrl}/v1/browser/tabs -d '{"url":"URL","context_id":"CONTEXT_ID",` +
        `"network":"${workspaceId}","source":"52hz:${agentName}"}'\`` +
        ' (open a tab already logged in)\n'
      );
    }

    sections.push(s);
  }

  // Message history
  sections.push(
    '\n### Message History\n\n' +
    '**Get recent messages in the current channel:**\n' +
    `\`${curl} -s -H "${h}" "${baseUrl}/v1/events?network=${workspaceId}&channel=${channelName}&type=workspace.message&sort=desc&limit=20"\`\n\n` +
    '**Get messages from a specific channel:**\n' +
    `\`${curl} -s -H "${h}" "${baseUrl}/v1/events?network=${workspaceId}&channel=CHANNEL_NAME&type=workspace.message&sort=desc&limit=20"\`\n`
  );

  // Post status update
  if (!isPlan) {
    sections.push(
      '\n### Post Status Update\n\n' +
      'Post a status/thinking message (visible in the workspace UI as an intermediate step):\n' +
      `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/events -d '{"type":"workspace.message.posted",` +
      `"source":"52hz:${agentName}","target":"channel/${channelName}",` +
      `"payload":{"content":"YOUR_STATUS","message_type":"status"}}'\`\n`
    );
  }

  // To-Dos (planning)
  if (!isPlan && !disabled.has('todos')) {
    sections.push(
      '\n### To-Do List (Planning)\n\n' +
      'Create or update your to-do list to track progress. The entire list ' +
      'is replaced each time (send the full list with current statuses).\n\n' +
      '**Status values:** `pending`, `in_progress`, `completed`\n\n' +
      '**Update your to-do list:**\n' +
      `\`${curl} -s -X PUT -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/todos -d '{"todos":[` +
      `{"content":"First task","status":"in_progress"},` +
      `{"content":"Second task","status":"pending"}` +
      `],"network":"${workspaceId}","channel":"${channelName}",` +
      `"source":"52hz:${agentName}"}'\`\n\n` +
      '**Get your to-do list:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/todos?network=${workspaceId}&channel=${channelName}"\`\n\n` +
      '**IMPORTANT:** When you receive a task with multiple steps or a list of things to do, ' +
      'ALWAYS create a to-do list first before starting work. This lets the user see your ' +
      'progress in real time. Update statuses as you work through each item.\n' +
      'You can assign items to other agents: `"assignee": "other-agent-name"`\n'
    );
  }

  // Timers
  if (!isPlan && !disabled.has('timers')) {
    sections.push(
      '\n### Timers\n\n' +
      'Set a timer that will send you a message after a delay, waking you up ' +
      'to continue work. Use this instead of `sleep` â€?timers let you release ' +
      'the session and get called back later.\n\n' +
      'Use cases: check back on a deploy, retry after a rate limit, remind ' +
      'yourself to follow up.\n\n' +
      '**Create a timer:**\n' +
      `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/timers -d '{"delay":300,"message":"Check the build",` +
      `"network":"${workspaceId}","channel":"${channelName}",` +
      `"source":"52hz:${agentName}"}'\`\n\n` +
      '**List active timers:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/timers?network=${workspaceId}&channel=${channelName}"\`\n\n` +
      '**Cancel a timer:**\n' +
      `\`${curl} -s -X DELETE -H "${h}" ${baseUrl}/v1/timers/TIMER_ID\`\n`
    );
  }

  // Routines (recurring scheduled tasks)
  if (!isPlan && !disabled.has('routines')) {
    sections.push(
      '\n### Routines (Recurring Tasks)\n\n' +
      'Create a recurring routine that fires on a schedule. Each routine gets ' +
      '**its own dedicated thread** (`routine:<id>`) so different routines never ' +
      'interfere, and the full context is preserved.\n\n' +
      '**`context` is required** â€?provide a thorough description of what the ' +
      'routine should do, any background info, and relevant details from the ' +
      'current conversation. This context is posted at the start of the routine\'s ' +
      'thread every time it fires, so you have full background.\n\n' +
      '**Two schedule modes:**\n' +
      '- **Daily**: `hour` (0-23 UTC) + `minute` (0-59), optional `days` ' +
      'array (0=Mon, 6=Sun). Omit `days` for every day.\n' +
      '- **Interval**: `interval_minutes` (1-1440). Fires every N minutes. ' +
      'Mutually exclusive with `hour`/`minute`.\n\n' +
      '**Create a daily routine:**\n' +
      `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/routines -d '{"name":"Daily PR Review","message":"Review open PRs",` +
      `"context":"Review all open pull requests on the main repo. Check for merge conflicts, ` +
      `CI failures, and stale PRs older than 3 days. Post a summary to the workspace.",` +
      `"hour":8,"minute":0,` +
      `"network":"${workspaceId}",` +
      `"source":"52hz:${agentName}"}'\`\n\n` +
      '**List active routines:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/routines?network=${workspaceId}"\`\n\n` +
      '**Cancel a routine:**\n' +
      `\`${curl} -s -X DELETE -H "${h}" ${baseUrl}/v1/routines/ROUTINE_ID\`\n`
    );
  }

  // Notifications / Inbox
  if (!isPlan && !disabled.has('notifications')) {
    sections.push(
      '\n### Notifications (Inbox)\n\n' +
      'Send notifications to the workspace inbox. Notifications appear in a ' +
      'dedicated panel separate from the chat stream. Use for task completions, ' +
      'important findings, or anything that needs human attention.\n\n' +
      '**Send a notification:**\n' +
      `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/notifications -d '{"title":"Task Complete","message":"The analysis is ready.",` +
      `"priority":"normal","channel":"${channelName}",` +
      `"network":"${workspaceId}",` +
      `"source":"52hz:${agentName}"}'\`\n\n` +
      '**Priority values:** `low`, `normal`, `high`\n\n' +
      '**List notifications:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/notifications?network=${workspaceId}"\`\n`
    );
  }

  // Knowledge Base
  if (!isPlan && !disabled.has('knowledge')) {
    sections.push(
      '\n### Knowledge Base\n\n' +
      'The workspace has a shared knowledge base of markdown documents. ' +
      'Use it to store and retrieve shared information like API docs, ' +
      'design decisions, project conventions, and other reference material. ' +
      'Knowledge entries are accessible to all agents via @knowledge:slug mentions.\n\n' +
      '**Create a knowledge entry:**\n' +
      `\`${curl} -s -X POST -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/knowledge -d '{"title":"API Design Patterns","content":"# API Design Patterns\\n\\n...",` +
      `"description":"Common API patterns used in this project",` +
      `"network":"${workspaceId}",` +
      `"source":"52hz:${agentName}"}'\`\n\n` +
      '**Search knowledge entries (semantic / keyword):**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/knowledge/search?network=${workspaceId}&q=search+terms"\`\n\n` +
      '**List knowledge entries:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/knowledge?network=${workspaceId}"\`\n\n` +
      '**Read a knowledge entry by slug:**\n' +
      `\`${curl} -s -H "${h}" "${baseUrl}/v1/knowledge/by-slug/api-design-patterns?network=${workspaceId}"\`\n\n` +
      '**Update a knowledge entry:**\n' +
      `\`${curl} -s -X PUT -H "${h}" -H "Content-Type: application/json" ` +
      `${baseUrl}/v1/knowledge/ENTRY_ID -d '{"title":"Updated Title","content":"# Updated\\n\\n...",` +
      `"network":"${workspaceId}","source":"52hz:${agentName}"}'\`\n\n` +
      '**Delete a knowledge entry:**\n' +
      `\`${curl} -s -X DELETE -H "${h}" "${baseUrl}/v1/knowledge/ENTRY_ID?network=${workspaceId}"\`\n`
    );
  }

  // Discovery
  sections.push(
    '\n### Discover Agents\n\n' +
    'Before delegating, look up who is available and what they do â€?match the ' +
    'task to an agent by its `description`.\n\n' +
    '**List all agents in the workspace (with descriptions, roles, status):**\n' +
    `\`${curl} -s -H "${h}" ${baseUrl}/v1/discover?network=${workspaceId}\`\n` +
    'The response has `agents[]` (each with `address` `52hz:<name>`, ' +
    '`description`, `role`, `status`, `agent_type`) and `channels[]` (each with ' +
    'an `address` `channel/<name>` and a `participants` list of agent names).\n\n' +
    '**To list the agents in THIS channel with their descriptions:** call ' +
    'discover, find the entry in `channels[]` whose `address` is ' +
    `\`channel/${channelName}\`, then keep the \`agents[]\` whose name is in ` +
    'that channel\'s `participants`. Example:\n' +
    `\`${curl} -s -H "${h}" ${baseUrl}/v1/discover?network=${workspaceId} | ` +
    'jq --arg ch "channel/' + channelName + '" \'' +
    '(.data.channels[]|select(.address==$ch).participants) as $p | ' +
    '.data.agents[]|select((.address|sub("52hz:";"")) as $n|$p|index($n))|' +
    '{name:(.address|sub("52hz:";"")),description,role,status}\'`\n' +
    '(Discovery is workspace-wide â€?there is no per-channel discover endpoint, ' +
    'so cross-reference `participants` yourself as shown.)\n'
  );

  return sections.join('\n');
}

/**
 * Guardrails shared across all adapter prompt builders.
 */
function buildGuardrails() {
  return (
    '\nIMPORTANT: Never use AskUserQuestion. ' +
    'AskUserQuestion blocks the subprocess and will hang the thread. ' +
    'If you need to ask the user something, just write the question ' +
    'as your text response.\n' +
    '\nIMPORTANT: When the user gives you a numbered list, bulleted list, or ' +
    'multiple tasks in a single message, you MUST create a to-do list BEFORE ' +
    'doing any work. This is mandatory â€?no exceptions, even for simple tasks. ' +
    'The to-do list lets the user track your progress in real time.\n' +
    '\nIMPORTANT: Do NOT use built-in scheduling tools (CronCreate, CronDelete, ' +
    'CronList, ScheduleWakeup). For timers, routines, and recurring tasks, ' +
    'ALWAYS use the workspace REST API (curl commands in your skill instructions). ' +
    'Built-in scheduling is local-only and won\'t appear in the workspace.\n'
  );
}

/**
 * The MCP tool-reference block for Claude in `mcp` tool mode. Each line names
 * a native `workspace_*` MCP tool the agent can call directly.
 */
function buildClaudeMcpToolBlock() {
  return (
    'Use workspace_get_history to read previous messages.\n' +
    'Use workspace_get_agents to see other agents.\n' +
    'Use workspace_put_todos to track your progress. ALWAYS create a to-do list when given multiple tasks or multi-step work.\n' +
    'Use workspace_create_timer to set a reminder that wakes you up later.\n' +
    'Use workspace_create_routine to set up recurring scheduled tasks (e.g. daily reviews).\n' +
    'Use workspace_send_notification to send a notification to the workspace inbox when you complete a task or have important results.\n' +
    'Use workspace_write_knowledge to create or update shared knowledge base entries that persist across conversations.\n' +
    'Use workspace_read_knowledge to read knowledge entries by ID or slug (from @knowledge:slug mentions).\n'
  );
}

/**
 * The skills tool-reference block for Claude in `skills` tool mode. In this
 * mode there is no MCP server â€?every workspace operation goes through the
 * wwj-workspace skill (Bash + curl), so we must NOT name any
 * `workspace_*` MCP tool here.
 */
function buildClaudeSkillsToolBlock() {
  return (
    'IMPORTANT: READ the wwj-workspace skill FIRST, before any workspace\n' +
    'action. It is your ONLY interface to the workspace â€?every operation goes\n' +
    'through the exact Bash + curl commands documented there. Do not guess\n' +
    'endpoints or improvise; open and follow the skill instructions.\n' +
    'The wwj-workspace skill (Bash + curl) covers all workspace operations:\n' +
    'reading message history, discovering agents (and who is in this channel),\n' +
    'sharing files, browsing the shared browser, managing to-do lists, setting\n' +
    'timers, creating routines, sending inbox notifications, and reading/writing\n' +
    'the shared knowledge base.\n'
  );
}

/**
 * Build the system prompt for the Claude adapter.
 *
 * `toolMode` selects how the agent reaches workspace resources:
 * - `'mcp'`    â†?native `workspace_*` MCP tools (an MCP server is spawned).
 * - `'skills'` â†?the wwj-workspace skill (Bash + curl); no MCP server.
 *
 * The tool-reference block is emitted directly for the chosen mode so it can
 * never drift out of sync (previously the adapter string-replaced the MCP
 * block, which silently leaked stale MCP tool names when the list changed).
 */
function buildClaudeSystemPrompt({ agentName, workspaceId, channelName, mode = 'execute', browserEnabled = false, toolMode = 'mcp' }) {
  const parts = [];
  parts.push(buildWorkspaceIdentity(agentName, workspaceId, channelName, mode, toolMode));
  parts.push(toolMode === 'skills' ? buildClaudeSkillsToolBlock() : buildClaudeMcpToolBlock());
  parts.push(buildBrowserDirective(browserEnabled));
  parts.push(buildCollaborationPrompt(toolMode));

  if (mode === 'plan') {
    parts.push(
      '\nYou are in PLAN mode. Only read, analyze, and propose ' +
      'changes. Do not make edits.\n'
    );
  }

  parts.push(buildGuardrails());

  return parts.join('\n');
}

/**
 * Build the full system prompt for OpenClaw/non-MCP agents.
 */
function buildOpenclawSystemPrompt({ agentName, workspaceId, channelName, endpoint, token, mode = 'execute', disabledModules, browserEnabled = false }) {
  const parts = [];
  parts.push(buildWorkspaceIdentity(agentName, workspaceId, channelName, mode, 'skills'));
  parts.push(buildBrowserDirective(browserEnabled));
  parts.push(buildCollaborationPrompt('skills'));
  parts.push(buildModePrompt(mode));
  parts.push(buildApiSkillsPrompt({
    endpoint, workspaceId, token, agentName, channelName, disabledModules, mode,
  }));
  parts.push(buildGuardrails());
  return parts.join('\n');
}

/**
 * Build a SKILL.md file for OpenClaw's skill auto-discovery.
 */
function buildOpenclawSkillMd({ endpoint, workspaceId, token, agentName, channelName, disabledModules, browserEnabled = false }) {
  const body = buildApiSkillsPrompt({
    endpoint, workspaceId, token, agentName, channelName, disabledModules, mode: 'execute',
  });

  const identity = buildWorkspaceIdentity(agentName, workspaceId, channelName, 'execute', 'skills');
  const directive = buildBrowserDirective(browserEnabled);
  const collab = buildCollaborationPrompt('skills');

  const frontmatter = (
    '---\n' +
    'name: wwj-workspace\n' +
    'description: "Share files, browse websites, and collaborate ' +
    'with other agents in an 52hzAgents workspace. Use when: ' +
    '(1) sharing results or reports with the user or other agents, ' +
    '(2) browsing a website to gather information, ' +
    '(3) reading files shared by users or other agents, ' +
    '(4) checking who else is in the workspace."\n' +
    'metadata:\n' +
    '  {"openclaw": {"always": true, "emoji": "\\U0001F310"}}\n' +
    '---\n\n'
  );

  return frontmatter + identity + directive + '\n' + collab + '\n' + body + '\n' + buildGuardrails();
}

/**
 * Build system prompt for OpenCode adapter.
 */
function buildOpenCodeSystemPrompt({ agentName, workspaceId, channelName, endpoint, token, mode = 'execute', disabledModules, browserEnabled = false }) {
  const identity = buildWorkspaceIdentity(agentName, workspaceId, channelName, mode, 'skills');
  const directive = buildBrowserDirective(browserEnabled);
  const collab = buildCollaborationPrompt('skills');
  const modePrompt = buildModePrompt(mode);
  const api = buildApiSkillsPrompt({ endpoint, workspaceId, token, agentName, channelName, disabledModules, mode });
  return identity + directive + '\n' + collab + '\n' + modePrompt + '\n' + api + '\n' + buildGuardrails();
}

/**
 * Build workspace skill markdown for OpenCode (written to .opencode/skills/).
 */
function buildOpenCodeSkillMd({ endpoint, workspaceId, token, agentName, channelName, disabledModules }) {
  const api = buildApiSkillsPrompt({
    endpoint, workspaceId, token, agentName,
    channelName: channelName || 'general',
    disabledModules,
    mode: 'execute',
  });

  const frontmatter =
    '---\n' +
    'name: wwj-workspace\n' +
    'description: 52hzAgents Workspace API â€?shared files, browser, and agent collaboration\n' +
    '---\n\n';

  const identity =
    `You are agent '${agentName}' connected to 52hzAgents workspace ${workspaceId}.\n` +
    'Use these APIs via bash + curl to interact with the workspace.\n\n';

  return frontmatter + identity + api + '\n' + buildGuardrails();
}

/**
 * Build a SKILL.md file for Claude Code's skill auto-discovery.
 *
 * When tool_mode is 'skills', the Claude adapter writes this file instead
 * of spawning an MCP server. Claude Code discovers the skill via its
 * .claude/skills/ directory and uses Bash + curl to call workspace APIs.
 */
function buildClaudeSkillMd({ endpoint, workspaceId, token, agentName, channelName, disabledModules, browserEnabled = false }) {
  const api = buildApiSkillsPrompt({
    endpoint, workspaceId, token, agentName,
    channelName: channelName || 'general',
    disabledModules,
    mode: 'execute',
  });

  const identity = buildWorkspaceIdentity(agentName, workspaceId, channelName, 'execute', 'skills');
  const directive = buildBrowserDirective(browserEnabled);
  const collab = buildCollaborationPrompt('skills');

  const frontmatter =
    '---\n' +
    'name: wwj-workspace\n' +
    'description: |\n' +
    '  52hzAgents Workspace collaboration tools â€?shared files, browser,\n' +
    '  and multi-agent coordination. Use when: sharing files or reports,\n' +
    '  browsing websites, reading shared files, checking workspace agents,\n' +
    '  or collaborating with other agents via @mentions.\n' +
    '---\n\n';

  return frontmatter + identity + directive + '\n' + collab + '\n' + api + '\n' + buildGuardrails();
}

/**
 * Build a SKILL.md file for Cursor CLI's skill auto-discovery.
 *
 * Written to .cursor/skills/wwj-workspace.md before each CLI spawn.
 * Cursor discovers skills from the .cursor/skills/ directory automatically.
 */
function buildCursorSkillMd({ endpoint, workspaceId, token, agentName, channelName, disabledModules, browserEnabled = false }) {
  const api = buildApiSkillsPrompt({
    endpoint, workspaceId, token, agentName,
    channelName: channelName || 'general',
    disabledModules,
    mode: 'execute',
  });

  const identity = buildWorkspaceIdentity(agentName, workspaceId, channelName, 'execute', 'skills');
  const directive = buildBrowserDirective(browserEnabled);
  const collab = buildCollaborationPrompt('skills');

  const frontmatter =
    '---\n' +
    'name: wwj-workspace\n' +
    'description: |\n' +
    '  52hzAgents Workspace collaboration tools â€?shared files, browser,\n' +
    '  and multi-agent coordination. Use when: sharing files or reports,\n' +
    '  browsing websites, reading shared files, checking workspace agents,\n' +
    '  or collaborating with other agents via @mentions.\n' +
    '---\n\n';

  return frontmatter + identity + directive + '\n' + collab + '\n' + api + '\n' + buildGuardrails();
}

module.exports = {
  buildWorkspaceIdentity,
  buildBrowserDirective,
  buildCollaborationPrompt,
  buildDecisionProtocolPrompt,
  buildPreviewProtocolPrompt,
  buildModePrompt,
  buildGuardrails,
  buildApiSkillsPrompt,
  buildClaudeMcpToolBlock,
  buildClaudeSkillsToolBlock,
  buildClaudeSystemPrompt,
  buildOpenclawSystemPrompt,
  buildOpenclawSkillMd,
  buildOpenCodeSystemPrompt,
  buildOpenCodeSkillMd,
  buildClaudeSkillMd,
  buildCursorSkillMd,
};
