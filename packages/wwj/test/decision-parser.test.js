'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDecisionQuestions,
  MAX_QUESTIONS,
  MAX_OPTIONS,
} = require('../src/adapters/decision-parser');

const block = (json) => '```decision\n' + json + '\n```';

test('extracts a well-formed block and strips it from the text', () => {
  const content =
    '我看了一下，有两种做法。\n\n' +
    block(JSON.stringify({
      questions: [{
        title: '用哪种鉴权方式?',
        options: [
          { label: 'JWT', description: '无状态' },
          { label: 'Session', description: '可吊销' },
        ],
        allowCustom: true,
      }],
    }));

  const r = extractDecisionQuestions(content);
  assert.equal(r.invalid, 0);
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].title, '用哪种鉴权方式?');
  assert.equal(r.questions[0].options.length, 2);
  assert.equal(r.questions[0].allowCustom, true);
  assert.equal(r.text, '我看了一下，有两种做法。');
  assert.ok(!r.text.includes('```'), 'fence survived in visible text');
});

test('accepts a bare array as the payload', () => {
  const r = extractDecisionQuestions(block(JSON.stringify([
    { title: 'Deploy now?', options: ['Yes', 'No'] },
  ])));
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.questions[0].options, [
    { value: 'Yes', label: 'Yes' },
    { value: 'No', label: 'No' },
  ]);
});

test('value falls back to label', () => {
  const r = extractDecisionQuestions(block(JSON.stringify({
    questions: [{ title: 'Pick', options: [{ label: '方案 A' }] }],
  })));
  assert.deepEqual(r.questions[0].options[0], { value: '方案 A', label: '方案 A' });
});

test('derives readable ids and keeps them unique', () => {
  const r = extractDecisionQuestions(block(JSON.stringify({
    questions: [
      { title: 'Which auth strategy?', options: ['JWT'] },
      { title: 'Which auth strategy?', options: ['Session'] },
    ],
  })));
  // The id is echoed back to the agent via the [Decision] reply, so it has to
  // be legible — "q1" would tell it nothing.
  assert.equal(r.questions[0].id, 'which-auth-strategy');
  assert.equal(r.questions[1].id, 'which-auth-strategy-2');
});

test('a CJK title keeps its own characters in the id', () => {
  const r = extractDecisionQuestions(block(JSON.stringify({
    questions: [{ title: '用哪种鉴权方式', options: ['JWT'] }],
  })));
  assert.equal(r.questions[0].id, '用哪种鉴权方式');
});

test('an explicit id is respected', () => {
  const r = extractDecisionQuestions(block(JSON.stringify({
    questions: [{ id: 'auth', title: 'Which?', options: ['JWT'] }],
  })));
  assert.equal(r.questions[0].id, 'auth');
});

// ---------------------------------------------------------------------------
// Failing closed. Every case below must leave the agent's words on screen —
// deleting a block the user cannot see is worse than showing raw JSON, because
// the reply then ends mid-thought with no explanation.
// ---------------------------------------------------------------------------

test('malformed JSON is left as visible text', () => {
  const content = 'Here:\n' + block('{ "questions": [ }');
  const r = extractDecisionQuestions(content);
  assert.equal(r.questions, null);
  assert.equal(r.invalid, 1);
  assert.equal(r.text, content, 'block must not be swallowed');
});

test('valid JSON with no renderable question is left as visible text', () => {
  for (const payload of [
    JSON.stringify({ questions: [] }),
    JSON.stringify({ questions: [{ title: 'No options here' }] }),
    JSON.stringify({ questions: [{ options: ['a'] }] }),
    JSON.stringify({ nope: true }),
    JSON.stringify({ questions: [{ title: 'x', options: [{ description: 'unlabelled' }] }] }),
  ]) {
    const content = block(payload);
    const r = extractDecisionQuestions(content);
    assert.equal(r.questions, null, `should not render: ${payload}`);
    assert.equal(r.invalid, 1, `should count as invalid: ${payload}`);
    assert.equal(r.text, content, `should stay visible: ${payload}`);
  }
});

test('an unterminated fence is left alone', () => {
  // Routine while a reply is still streaming. Consuming half a JSON object
  // would drop the question entirely.
  const content = '```decision\n{ "questions": [';
  const r = extractDecisionQuestions(content);
  assert.equal(r.questions, null);
  assert.equal(r.text, content);
});

test('no fence at all is a cheap pass-through', () => {
  const r = extractDecisionQuestions('就用 JWT 吧，我已经改好了。');
  assert.equal(r.questions, null);
  assert.equal(r.invalid, 0);
  assert.equal(r.text, '就用 JWT 吧，我已经改好了。');
});

test('a plain code block is not mistaken for a decision block', () => {
  const content = '```json\n{ "questions": [{ "title": "x", "options": ["y"] }] }\n```';
  const r = extractDecisionQuestions(content);
  assert.equal(r.questions, null, 'promoted a non-decision fence');
  assert.equal(r.text, content);
});

test('natural-language questions are NOT promoted', () => {
  // The whole design premise: no sniffing. A false positive puts a card with
  // invented options in front of the user and makes them click through a
  // decision the agent never asked for.
  for (const s of [
    '请选择方案 A 还是方案 B？',
    '你想用 JWT 还是 Session？',
    'Should I use JWT or Session?',
    '1. JWT\n2. Session\n请选一个',
  ]) {
    const r = extractDecisionQuestions(s);
    assert.equal(r.questions, null, `sniffed a question out of: ${s}`);
    assert.equal(r.text, s);
  }
});

test('handles non-string input', () => {
  for (const v of [null, undefined, 42, {}]) {
    const r = extractDecisionQuestions(v);
    assert.equal(r.questions, null);
    assert.equal(r.text, '');
  }
});

test('caps runaway payloads', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    title: `Q${i}`,
    options: Array.from({ length: 40 }, (_, j) => `opt${j}`),
  }));
  const r = extractDecisionQuestions(block(JSON.stringify({ questions: many })));
  assert.equal(r.questions.length, MAX_QUESTIONS);
  assert.equal(r.questions[0].options.length, MAX_OPTIONS);
});

test('multiple blocks in one reply are merged', () => {
  const content =
    block(JSON.stringify({ questions: [{ title: 'A?', options: ['1'] }] })) +
    '\n\ntext between\n\n' +
    block(JSON.stringify({ questions: [{ title: 'B?', options: ['2'] }] }));
  const r = extractDecisionQuestions(content);
  assert.equal(r.questions.length, 2);
  assert.equal(r.text, 'text between');
});

test('emitted shape matches ApprovalCardQuestion exactly', () => {
  // chat-message.tsx casts metadata.questions straight to
  // ApprovalCardQuestion[] with no runtime validation, so an unexpected key or
  // a missing required one is a render crash in the message list.
  const r = extractDecisionQuestions(block(JSON.stringify({
    questions: [{
      title: 'Pick',
      options: [{ label: 'A', value: 'a', description: 'd' }],
      allowCustom: true,
      customPlaceholder: '其他方案…',
    }],
  })));
  const q = r.questions[0];
  assert.deepEqual(Object.keys(q).sort(), ['allowCustom', 'customPlaceholder', 'id', 'options', 'title']);
  assert.deepEqual(Object.keys(q.options[0]).sort(), ['description', 'label', 'value']);
  assert.equal(typeof q.id, 'string');
  assert.equal(typeof q.title, 'string');
  assert.ok(Array.isArray(q.options) && q.options.length > 0);
});
