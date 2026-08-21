/**
 * Decision-block parser: turns an explicit protocol block in an agent's reply
 * into the `metadata.questions` payload the workspace renders as an
 * ApprovalCard.
 *
 * WHY A PROTOCOL AND NOT A DETECTOR
 *
 * The obvious alternative is to sniff natural language — spot "请选择方案 A 还是
 * 方案 B？" and promote it. That was rejected. The failure mode is asymmetric:
 * a missed question costs the user one extra typed reply, while a false
 * positive puts an interactive card with wrong options in front of them and
 * makes them click through a decision the agent never asked for. Detecting
 * "is this Chinese sentence a request for a choice, or is it describing the
 * choices it already made" is not a regex problem, and getting it wrong is
 * worse than not having the feature.
 *
 * So an agent opts in by emitting a fenced block. Explicit, testable, and it
 * fails closed — no block, no card.
 *
 *     ```decision
 *     {
 *       "questions": [
 *         {
 *           "title": "用哪种鉴权方式?",
 *           "options": [
 *             { "label": "JWT", "description": "无状态, 适合多实例" },
 *             { "label": "Session", "description": "可即时吊销" }
 *           ],
 *           "allowCustom": true
 *         }
 *       ]
 *     }
 *     ```
 *
 * A bare array is accepted too (`[{...}]`) since that is the shape agents
 * reach for first.
 */

'use strict';

/**
 * Fenced blocks tagged `decision` / `oa-decision` / `oa:decision`.
 *
 * The closing fence is required. An unterminated block means the message is
 * still streaming, and half a JSON object parses as nothing useful — better to
 * leave it as visible text on this pass than to consume it.
 */
const DECISION_FENCE_RE = /^[ \t]*```(?:oa[-:])?decision[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gim;

/** Cap so a runaway agent cannot render a hundred-question wall. */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 10;

/**
 * Derive a stable, readable id from a title.
 *
 * Readability matters here, not just uniqueness: when the user answers, the
 * workspace posts `[Decision]` lines keyed by these values, and the agent has
 * to understand what it is reading. `q1: JWT` tells it nothing.
 *
 * Latin titles slug normally. A CJK title has no ASCII to slug, so it keeps its
 * own characters — they survive JSON and are what the agent recognises anyway.
 */
function deriveId(title, index, taken) {
  let base = String(title)
    .toLowerCase()
    .replace(/[`*_~>#[\]()]/g, '')
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  if (!base) base = `q${index + 1}`;

  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

function asText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Coerce one raw option into `{ value, label, description? }`.
 *
 * `value` falls back to `label` because that is what agents omit most often,
 * and a label alone is a complete option from the user's point of view.
 * Returns null for anything with no label — an unlabelled button is not
 * something to render.
 */
function normalizeOption(raw) {
  if (typeof raw === 'string') {
    const label = raw.trim();
    return label ? { value: label, label } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const label = asText(raw.label) || asText(raw.value) || asText(raw.title);
  if (!label) return null;

  const option = { value: asText(raw.value) || label, label };
  const description = asText(raw.description) || asText(raw.detail) || asText(raw.hint);
  if (description) option.description = description;
  return option;
}

/**
 * Coerce one raw question into the `ApprovalCardQuestion` shape.
 *
 * Validation is strict on purpose. `chat-message.tsx` casts
 * `metadata.questions` straight to `ApprovalCardQuestion[]` with no runtime
 * check, so a malformed entry reaching the frontend is a render crash in the
 * message list, not a degraded card.
 */
function normalizeQuestion(raw, index, taken) {
  if (!raw || typeof raw !== 'object') return null;

  const title = asText(raw.title) || asText(raw.question) || asText(raw.prompt) || asText(raw.label);
  if (!title) return null;

  const rawOptions = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.choices)
      ? raw.choices
      : [];

  const options = [];
  for (const o of rawOptions) {
    const opt = normalizeOption(o);
    if (opt) options.push(opt);
    if (options.length >= MAX_OPTIONS) break;
  }
  // A card with no buttons is just text that stole a border.
  if (options.length === 0) return null;

  const question = {
    id: asText(raw.id) ? asText(raw.id) : deriveId(title, index, taken),
    title,
    options,
  };
  if (asText(raw.id)) taken.add(question.id);

  if (raw.allowCustom === true || raw.allow_custom === true) {
    question.allowCustom = true;
    const placeholder = asText(raw.customPlaceholder) || asText(raw.custom_placeholder);
    if (placeholder) question.customPlaceholder = placeholder;
  }
  return question;
}

/**
 * Pull decision blocks out of an agent reply.
 *
 * @param {string} content
 * @returns {{ text: string, questions: object[]|null, invalid: number }}
 *   `text` is the reply with valid blocks removed. Blocks that fail to parse
 *   are LEFT IN — swallowing them would silently drop the agent's question and
 *   leave the user staring at a reply that ends mid-thought. `invalid` counts
 *   them so the caller can log.
 */
function extractDecisionQuestions(content) {
  if (typeof content !== 'string' || content.indexOf('```') === -1) {
    return { text: typeof content === 'string' ? content : '', questions: null, invalid: 0 };
  }

  const questions = [];
  const taken = new Set();
  let invalid = 0;

  // `replace` with a function walks every match in one pass and hands back the
  // stripped text; the regex is `g`-flagged so lastIndex is reset by replace.
  const text = content.replace(DECISION_FENCE_RE, (match, body) => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      invalid++;
      return match;
    }

    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.questions)
        ? parsed.questions
        : null;
    if (!list) {
      invalid++;
      return match;
    }

    const before = questions.length;
    for (const raw of list) {
      if (questions.length >= MAX_QUESTIONS) break;
      const q = normalizeQuestion(raw, questions.length, taken);
      if (q) questions.push(q);
    }
    // Parsed as JSON but produced nothing renderable — same reasoning as a
    // parse failure, so keep it visible rather than deleting the agent's words.
    if (questions.length === before) {
      invalid++;
      return match;
    }
    return '';
  });

  if (questions.length === 0) {
    return { text: content, questions: null, invalid };
  }

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    questions,
    invalid,
  };
}

module.exports = {
  extractDecisionQuestions,
  // exported for tests
  normalizeQuestion,
  normalizeOption,
  deriveId,
  MAX_QUESTIONS,
  MAX_OPTIONS,
};
