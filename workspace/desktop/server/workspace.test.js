const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("./store");
const { AgentRunner } = require("./agent-runner");
const { normalizeUsage, sessionUsage } = require("./usage");
const { startServer } = require("./index");

test("provider token measurements include cache exactly once and retain unknown usage", () => {
  assert.equal(normalizeUsage({}, "openai"), null);
  assert.equal(
    normalizeUsage({ prompt_tokens: -1, completion_tokens: 3 }, "openai"),
    null,
  );
  assert.deepEqual(
    normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 80 },
      },
      "openai",
    ),
    {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cache_read_tokens: 80,
      cache_write_tokens: null,
    },
  );
  assert.equal(
    normalizeUsage(
      { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80 },
      "anthropic",
    ).total_tokens,
    110,
  );
  assert.equal(
    normalizeUsage({ prompt_eval_count: 0, eval_count: 0 }, "ollama")
      .total_tokens,
    0,
  );
});

test("session creation, replay, discovery, usage and history survive restart without cross-session leakage", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "52hz-workspace-test-"),
  );
  t.after(() => {
    assert.ok(
      directory.startsWith(path.join(os.tmpdir(), "52hz-workspace-test-")),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { server, port } = await startServer({
    port: 0,
    userDataPath: directory,
    staticDir: directory,
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const request = async (route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${port}${route}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const event = {
    type: "network.channel.create",
    source: "human:user",
    target: "core",
    payload: { title: "Project A", participants: ["claude"] },
    client_message_id: "create-A",
  };
  const created = await request("/v1/events", event);
  assert.equal((await request('/v1/browser/tabs')).supported, false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/unknown-feature`, { method: 'POST' })).status, 404);
  const channel = created.metadata.channel_name;
  assert.ok(channel.startsWith("session-"));
  assert.equal(
    (await request("/v1/events", event)).metadata.channel_name,
    channel,
  );
  const discovery = await request("/v1/discover");
  assert.equal(
    discovery.channels.filter((c) => c.channel_name === channel).length,
    1,
  );
  assert.equal(
    discovery.channels.find((c) => c.channel_name === channel).title,
    "Project A",
  );
  const reply = {
    type: "workspace.message.posted",
    source: "52hz:claude",
    target: `channel/${channel}`,
    payload: { content: "Real reply fixture" },
    metadata: {
      model: "fixture-model",
      usage: normalizeUsage(
        { input_tokens: 20, output_tokens: 5 },
        "anthropic",
      ),
    },
    client_message_id: "reply-A",
  };
  const first = await request("/v1/events", reply);
  await request("/v1/events", reply);
  await request("/v1/events", {
    ...reply,
    target: "channel/general",
    metadata: {},
    client_message_id: "reply-B",
    payload: { content: "Another project" },
  });
  const usage = await request(
    `/v1/workspaces/52hz/session-usage?channel=${channel}`,
  );
  assert.equal(usage.measured_turns, 1);
  assert.equal(usage.total_tokens, 25);
  assert.equal(
    (await request("/v1/workspaces/52hz/session-usage?channel=general"))
      .measured_turns,
    0,
  );
  assert.equal(
    (await request(`/v1/events?channel=${channel}&after=${first.event_id}`))
      .events.length,
    0,
  );
  const reopened = new Store(directory);
  assert.equal(reopened.getChannel(channel).title, "Project A");
  assert.equal(sessionUsage(reopened.data.events, channel).total_tokens, 25);
  const runner = new AgentRunner(reopened, { broadcast() {} });
  assert.deepEqual(
    runner.conversation(`channel/${channel}`).map((m) => m.content),
    ["Real reply fixture"],
  );
  assert.equal(
    runner
      .conversation("channel/general")
      .some((m) => m.content === "Real reply fixture"),
    false,
  );
});
