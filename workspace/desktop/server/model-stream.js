const { normalizeUsage } = require("./usage");

/** Decode SSE/NDJSON across arbitrary UTF-8 and network chunk boundaries. */
async function streamModel({ url, headers, body, provider, signal, onDelta }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Model request failed (HTTP ${response.status}). Check the provider, model ID and credentials.`,
    );
  }
  let content = "",
    model = body.model,
    rawUsage = {},
    complete = false;
  const consume = (raw) => {
    if (raw === "[DONE]") {
      complete = true;
      return;
    }
    if (!raw.trim()) return;
    const frame = JSON.parse(raw);
    if (frame.error)
      throw new Error("The model provider reported an error while streaming.");
    let delta = "";
    if (provider === "anthropic") {
      if (frame.type === "message_start") {
        rawUsage = { ...frame.message?.usage };
        model = frame.message?.model || model;
      }
      if (
        frame.type === "content_block_delta" &&
        frame.delta?.type === "text_delta"
      )
        delta = frame.delta.text || "";
      if (frame.type === "message_delta")
        rawUsage = { ...rawUsage, ...frame.usage };
      if (frame.type === "message_stop") complete = true;
    } else if (provider === "ollama") {
      delta = frame.message?.content || "";
      model = frame.model || model;
      if (frame.done) {
        rawUsage = frame;
        complete = true;
      }
    } else {
      delta = frame.choices?.[0]?.delta?.content || "";
      model = frame.model || model;
      if (frame.usage) rawUsage = frame.usage;
    }
    if (delta) {
      content += delta;
      if (content.length > 2_000_000)
        throw new Error("Model output exceeded the desktop response limit.");
      onDelta(content);
    }
  };
  const decoder = new TextDecoder();
  let pending = "",
    data = [];
  const line = (value) => {
    value = value.replace(/\r$/, "");
    if (provider === "ollama") {
      if (value.trim()) consume(value);
      return;
    }
    if (value === "") {
      if (data.length) consume(data.join("\n"));
      data = [];
    } else if (value.startsWith("data:"))
      data.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > 2_000_000)
        throw new Error("Invalid model stream: oversized frame.");
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending) line(pending);
    if (data.length) consume(data.join("\n"));
    if (!complete)
      throw new Error(
        "The model connection ended before the response completed.",
      );
    if (!content.trim())
      throw new Error("The model completed without a text reply.");
    return { content, model, usage: normalizeUsage(rawUsage, provider) };
  } finally {
    if (!response.body.locked) await response.body.cancel().catch(() => {});
  }
}

module.exports = { streamModel };
