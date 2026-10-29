const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { streamModel } = require("./model-stream");
const { AgentRunner } = require("./agent-runner");
const { Store } = require("./store");
const { startServer } = require("./index");

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
function storeFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "52hz-runtime-test-"));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "52hz-runtime-test-")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.updateChannel("general", {
    runtime_config: { provider: "openai", model: "fixture", mode: "chat" },
  });
  return store;
}
const frame = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;

test("stream parser preserves split UTF-8, SSE frames and reported usage", async (t) => {
  const payload =
    frame({ model: "fixture", choices: [{ delta: { content: "你好 " } }] }) +
    frame({ choices: [{ delta: { content: "world" } }] }) +
    frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) +
    "data: [DONE]\r\n\r\n";
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const buffer = Buffer.from(payload);
    for (let i = 0; i < buffer.length; i += 7)
      res.write(buffer.subarray(i, i + 7));
    res.end();
  });
  const deltas = [];
  const reply = await streamModel({
    url,
    body: { model: "fixture" },
    provider: "openai",
    onDelta: (text) => deltas.push(text),
  });
  assert.deepEqual(deltas, ["你好 ", "你好 world"]);
  assert.equal(reply.usage.total_tokens, 15);
});

test("Anthropic and Ollama streams normalize text and final token measurements", async (t) => {
  const anthropic =
    frame({
      type: "message_start",
      message: {
        usage: { input_tokens: 10, cache_read_input_tokens: 20 },
        model: "fixture",
      },
    }) +
    frame({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Plan" },
    }) +
    frame({ type: "message_delta", usage: { output_tokens: 4 } }) +
    frame({ type: "message_stop" });
  const url = await fixture(t, (req, res) =>
    res.end(
      req.url === "/anthropic"
        ? anthropic
        : '{"message":{"content":"Local"},"done":false}\n{"done":true,"prompt_eval_count":8,"eval_count":2}\n',
    ),
  );
  assert.equal(
    (
      await streamModel({
        url: `${url}/anthropic`,
        body: {},
        provider: "anthropic",
        onDelta() {},
      })
    ).usage.total_tokens,
    34,
  );
  assert.equal(
    (
      await streamModel({
        url: `${url}/ollama`,
        body: {},
        provider: "ollama",
        onDelta() {},
      })
    ).usage.total_tokens,
    10,
  );
});

test("truncation is an error and HTTP errors do not expose provider bodies", async (t) => {
  const url = await fixture(t, (req, res) => {
    if (req.url === "/secret") {
      res.writeHead(401);
      return res.end("secret-key-do-not-display");
    }
    res.end(frame({ choices: [{ delta: { content: "Partial" } }] }));
  });
  await assert.rejects(
    streamModel({ url, body: {}, provider: "openai", onDelta() {} }),
    /before.*completed/,
  );
  await assert.rejects(
    streamModel({
      url: `${url}/secret`,
      body: {},
      provider: "openai",
      onDelta() {},
    }),
    (e) => /HTTP 401/.test(e.message) && !e.message.includes("secret-key"),
  );
});

test("queued prompts retain prior replies, exclude future prompts and store one final reply", async (t) => {
  const store = storeFor(t),
    emitted = [],
    calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new AgentRunner(
    store,
    { broadcast: (e) => emitted.push(e), broadcastComposing() {} },
    {
      env: { OPENAI_API_KEY: "fixture" },
      stream: async (options) => {
        calls.push(options.body.messages);
        options.onDelta("Streaming");
        if (calls.length === 1) await gate;
        return {
          content: `Reply ${calls.length}`,
          model: "fixture",
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        };
      },
    },
  );
  const user = (text) =>
    store.addEvent({
      type: "workspace.message.posted",
      source: "human:user",
      target: "channel/general",
      payload: { content: text },
    });
  const first = runner.handleUserMessage(user("First"));
  const second = user("Second");
  await runner.handleUserMessage(second);
  const third = user("Third");
  await runner.handleUserMessage(third);
  assert.equal(runner.queues.get("general").length, 2);
  assert.equal(runner.snapshot("general").metadata.streaming, true);
  release();
  await first;
  while (runner.active.size)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls[1].map((m) => m.content).slice(1), [
    "First",
    "Reply 1",
    "Second",
  ]);
  assert.deepEqual(calls[2].map((m) => m.content).slice(1), [
    "First",
    "Reply 1",
    "Second",
    "Reply 2",
    "Third",
  ]);
  assert.equal(store.data.events.filter((e) => e.metadata?.usage).length, 3);
  assert.equal(
    store.data.events.some((e) => e.type === "workspace.message.streaming"),
    false,
  );
  assert.ok(emitted.some((e) => e.type === "workspace.message.streaming"));
});

test("stop aborts generation, clears the queue and persists a single interrupted response", async (t) => {
  const store = storeFor(t);
  const runner = new AgentRunner(
    store,
    { broadcast() {}, broadcastComposing() {} },
    {
      env: { OPENAI_API_KEY: "fixture" },
      stream: (options) =>
        new Promise((_resolve, reject) => {
          options.onDelta("Partial text");
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          );
        }),
    },
  );
  const user = (text) =>
    store.addEvent({
      type: "workspace.message.posted",
      source: "human:user",
      target: "channel/general",
      payload: { content: text },
    });
  const task = runner.handleUserMessage(user("Start"));
  await runner.handleUserMessage(user("Queued"));
  assert.deepEqual(runner.stop("general"), {
    stopped: true,
    cancelled_queued: 1,
  });
  await task;
  const replies = store.data.events.filter((e) => e.metadata?.interrupted && e.source.startsWith('52hz:'));
  assert.equal(replies.length, 1);
  assert.match(replies[0].payload.content, /Partial text/);
  assert.equal(replies[0].metadata.outcome, "stopped");
  assert.equal(runner.active.size, 0);
  assert.equal(runner.queues.size, 0);
  assert.equal(runner.conversation('channel/general').some(m => m.content === 'Queued'), false);
});

test("timeout and app restart produce terminal states instead of perpetual running", async (t) => {
  const store = storeFor(t);
  const runner = new AgentRunner(
    store,
    { broadcast() {}, broadcastComposing() {} },
    {
      env: { OPENAI_API_KEY: "fixture" },
      timeoutMs: 15,
      stream: (options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          ),
        ),
    },
  );
  await runner.handleUserMessage(
    store.addEvent({
      source: "human:user",
      target: "channel/general",
      payload: { content: "Timeout" },
    }),
  );
  assert.equal(runner.turns.get("general/openai").state, "error");
  assert.match(runner.turns.get("general/openai").error, /timed out/);
  runner.updateTurn("general", "openai", "running");
  const restarted = new AgentRunner(new Store(store.userDataPath), {
    broadcast() {},
  });
  assert.equal(restarted.turns.get("general/openai").state, "error");
});

test("HTTP runtime config persists per session and rejects invalid providers", async (t) => {
  const store = storeFor(t);
  const { server, port } = await startServer({
    port: 0,
    userDataPath: store.userDataPath,
    staticDir: store.userDataPath,
    runtimeOptions: { env: {} },
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${port}/v1/runtime/session?channel=general`;
  const patch = (config) =>
    fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  assert.equal(
    (await patch({ provider: "__proto__", model: "bad", mode: "chat" })).status,
    400,
  );
  assert.equal(
    (await patch({ provider: "ollama", model: "local-test", mode: "plan" }))
      .status,
    200,
  );
  assert.equal((await (await fetch(url)).json()).config.model, "local-test");
  assert.equal(
    new Store(store.userDataPath).getChannel("general").runtime_config.mode,
    "plan",
  );
});
