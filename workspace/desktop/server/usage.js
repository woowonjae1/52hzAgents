// Preserve provider measurements. Missing usage is never manufactured from text length.
function normalizeUsage(raw, provider) {
  if (!raw || typeof raw !== "object") return null;
  const input =
    provider === "ollama"
      ? raw.prompt_eval_count
      : (raw.prompt_tokens ?? raw.input_tokens);
  const output =
    provider === "ollama"
      ? raw.eval_count
      : (raw.completion_tokens ?? raw.output_tokens);
  if (
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  )
    return null;
  const cacheRead =
    raw.cache_read_input_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.prompt_tokens_details?.cached_tokens ??
    null;
  const cacheWrite = raw.cache_creation_input_tokens ?? null;
  // Anthropic reports uncached input separately; OpenAI includes cache hits in prompt_tokens.
  const prompt =
    provider === "anthropic" ? input + (cacheRead || 0) + (cacheWrite || 0) : input;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

function sessionUsage(events, channel) {
  const turns = events.filter(
    (e) =>
      e.target === `channel/${channel}` &&
      e.type === "workspace.message.posted" &&
      e.metadata?.usage,
  );
  const totals = turns.reduce(
    (sum, e) => {
      for (const key of [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
      ])
        sum[key] += e.metadata.usage[key] || 0;
      return sum;
    },
    {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  );
  return {
    channel_name: channel,
    measured_turns: turns.length,
    cache_measured_turns: turns.filter(e => e.metadata.usage.cache_read_tokens != null).length,
    ...totals,
    last: turns.length
      ? {
          model: turns.at(-1).metadata.model || "",
          ...turns.at(-1).metadata.usage,
          prompt_tokens: turns.at(-1).metadata.last_prompt_tokens ?? turns.at(-1).metadata.usage.prompt_tokens,
        }
      : null,
  };
}

module.exports = { normalizeUsage, sessionUsage };
