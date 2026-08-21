'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPreview } = require('../src/adapters/preview-parser');

const block = (json) => '```preview\n' + json + '\n```';

test('extracts a url and strips the block', () => {
  const content = '服务起好了。\n\n' + block('{ "url": "http://localhost:3000", "label": "Next.js dev" }');
  const r = extractPreview(content);
  assert.equal(r.invalid, 0);
  assert.deepEqual(r.preview, { url: 'http://localhost:3000', label: 'Next.js dev' });
  assert.equal(r.text, '服务起好了。');
  assert.ok(!r.text.includes('```'));
});

test('accepts a bare port as shorthand', () => {
  const r = extractPreview(block('{ "port": 5173 }'));
  assert.deepEqual(r.preview, { url: 'http://localhost:5173' });
});

test('accepts a numeric string port', () => {
  const r = extractPreview(block('{ "port": "8080" }'));
  assert.deepEqual(r.preview, { url: 'http://localhost:8080' });
});

test('accepts the alternate fence tags', () => {
  for (const tag of ['oa-preview', 'oa:preview']) {
    const r = extractPreview('```' + tag + '\n{ "port": 3000 }\n```');
    assert.deepEqual(r.preview, { url: 'http://localhost:3000' }, tag);
  }
});

test('accepts every loopback spelling', () => {
  for (const url of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://app.localhost:3000',
    'https://localhost:8443',
    'http://localhost:3000/dashboard',
  ]) {
    const r = extractPreview(block(JSON.stringify({ url })));
    assert.equal(r.preview?.url, url, `should accept: ${url}`);
  }
});

// ---------------------------------------------------------------------------
// Rejections. Every case must leave the block visible — a silently dropped
// block means the user never learns why the panel did not open.
// ---------------------------------------------------------------------------

test('rejects non-loopback hosts', () => {
  // An agent reply must not be able to render a third-party page inside the app.
  for (const url of [
    'http://example.com',
    'https://evil.test/path',
    'http://192.168.1.10:3000',
    'http://localhost.evil.com:3000',
    'http://10.0.0.5:8080',
  ]) {
    const content = block(JSON.stringify({ url }));
    const r = extractPreview(content);
    assert.equal(r.preview, null, `should reject: ${url}`);
    assert.equal(r.invalid, 1, `should count invalid: ${url}`);
    assert.equal(r.text, content, `should stay visible: ${url}`);
  }
});

test('rejects non-http schemes', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x']) {
    const r = extractPreview(block(JSON.stringify({ url })));
    assert.equal(r.preview, null, `should reject: ${url}`);
  }
});

test('rejects out-of-range and junk ports', () => {
  for (const port of [0, -1, 70000, 3.5, 'abc', null, true, '']) {
    const r = extractPreview(block(JSON.stringify({ port })));
    assert.equal(r.preview, null, `should reject port: ${JSON.stringify(port)}`);
  }
});

test('malformed JSON is left as visible text', () => {
  const content = 'see:\n' + block('{ "port": }');
  const r = extractPreview(content);
  assert.equal(r.preview, null);
  assert.equal(r.invalid, 1);
  assert.equal(r.text, content);
});

test('an unterminated fence is left alone', () => {
  const content = '```preview\n{ "port": 3000';
  const r = extractPreview(content);
  assert.equal(r.preview, null);
  assert.equal(r.text, content);
});

test('a plain code block is not mistaken for a preview block', () => {
  const content = '```json\n{ "port": 3000 }\n```';
  const r = extractPreview(content);
  assert.equal(r.preview, null);
  assert.equal(r.text, content);
});

test('prose mentioning a port is NOT promoted', () => {
  // The whole reason the protocol exists. Text-scraping `localhost:\d+` would
  // hijack the panel on every one of these.
  for (const s of [
    '旧配置里指向的是 localhost:8080，我改掉了。',
    'The dev server usually runs on http://localhost:3000 but I did not start it.',
    'Set PORT=4000 in .env if 3000 is taken.',
  ]) {
    const r = extractPreview(s);
    assert.equal(r.preview, null, `sniffed a port out of: ${s}`);
    assert.equal(r.text, s);
  }
});

test('the last valid block wins', () => {
  // An agent that restarts the server in one turn: the newest address is live.
  const content =
    block('{ "port": 3000 }') + '\n\n端口被占，换一个。\n\n' + block('{ "port": 3001 }');
  const r = extractPreview(content);
  assert.equal(r.preview.url, 'http://localhost:3001');
  assert.equal(r.text, '端口被占，换一个。');
});

test('an invalid block does not clobber a valid one', () => {
  const content = block(JSON.stringify({ url: 'http://example.com' })) + '\n\n' + block('{ "port": 3000 }');
  const r = extractPreview(content);
  assert.equal(r.preview.url, 'http://localhost:3000');
  assert.equal(r.invalid, 1);
  // The rejected block stays on screen so the user can see it was refused.
  assert.ok(r.text.includes('example.com'));
});

test('no fence at all is a cheap pass-through', () => {
  const r = extractPreview('已经改好了。');
  assert.equal(r.preview, null);
  assert.equal(r.invalid, 0);
  assert.equal(r.text, '已经改好了。');
});

test('handles non-string input', () => {
  for (const v of [null, undefined, 42, {}]) {
    const r = extractPreview(v);
    assert.equal(r.preview, null);
    assert.equal(r.text, '');
  }
});
