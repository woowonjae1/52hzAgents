'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateSessionTitle, SESSION_DEFAULT_RE } = require('../src/adapters/utils');

// Display width, mirroring the generator: CJK counts two columns. Asserting on
// width rather than `.length` is the point of the rewrite — the old code capped
// at 50 characters, which is 100 columns of Chinese.
function width(s) {
  let w = 0;
  for (const ch of s) {
    w += /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return w;
}

test('Chinese: strips stacked filler openers', () => {
  assert.equal(generateSessionTitle('请帮我看看这个报错'), '这个报错');
  assert.equal(generateSessionTitle('你好，帮我查一下成都天气'), '成都天气');
  assert.equal(generateSessionTitle('麻烦你写一个登录页面'), '登录页面');
  assert.equal(generateSessionTitle('我想要一个用户鉴权模块'), '一个用户鉴权模块');
});

test('Chinese: cuts at the first sentence terminator', () => {
  assert.equal(
    generateSessionTitle('重构用户鉴权模块。然后补上单元测试。'),
    '重构用户鉴权模块'
  );
  assert.equal(generateSessionTitle('这个接口报 500 错误！帮我查一下'), '这个接口报 500 错误');
});

test('Chinese: never returns the whole paragraph', () => {
  const long =
    '帮我把整个前端的字体系统重构一下，包括字体族、字号阶梯和字重分配，' +
    '然后再把所有硬编码的像素值都换成 token，最后跑一遍构建确认没有回归。';
  const title = generateSessionTitle(long);
  assert.ok(width(title) <= 32, `width ${width(title)} exceeded budget: ${title}`);
  assert.ok(title.length > 0);
  // The old implementation returned a 50-character slab because split(/\s+/)
  // found no word boundary to cut on.
  assert.ok(title.length < 30, `title still paragraph-length: ${title}`);
});

test('Chinese: prefers a clause boundary over a mid-word cut', () => {
  const title = generateSessionTitle('成都未来7天的天气怎么样，然后再帮我写一份出行建议报告');
  assert.ok(!title.includes('，'), `kept a dangling clause: ${title}`);
  assert.ok(title.startsWith('成都未来7天'), title);
});

test('English: word budget and sentence case still apply', () => {
  assert.equal(
    generateSessionTitle('can you please refactor the auth module for me'),
    'Refactor the auth module for me'
  );
  assert.equal(generateSessionTitle('fix the login bug. it 500s'), 'Fix the login bug');
});

test('never cuts inside a Latin word', () => {
  const input = 'investigate the intermittent websocket disconnect problem';
  const title = generateSessionTitle(input);
  assert.ok(title.endsWith('…'), `expected truncation: ${title}`);

  // Every surviving token must be a whole word from the input. Checking for a
  // word character before the ellipsis would pass a correct cut and a mid-word
  // cut alike — "intermittent…" and "intermitten…" both end in one.
  const words = title.replace(/…$/, '').toLowerCase().split(' ');
  const source = input.toLowerCase().split(' ');
  for (const w of words) {
    assert.ok(source.includes(w), `"${w}" is not a whole word of the input: ${title}`);
  }
});

test('does not split an ASCII decimal into a sentence', () => {
  assert.equal(generateSessionTitle('bump the SDK to 3.5 and retest'), 'Bump the SDK to 3.5 and');
});

test('strips leading @mentions and /mentions', () => {
  assert.equal(generateSessionTitle('@claude 帮我看下这个报错'), '这个报错');
  assert.equal(generateSessionTitle('/pi 重构鉴权模块'), '重构鉴权模块');
  assert.equal(generateSessionTitle('@claude @pi 部署到预发环境'), '部署到预发环境');
});

test('strips code so a code-only message yields no title', () => {
  assert.equal(generateSessionTitle('```js\nconst a = 1;\n```'), '');
  // Unterminated fence — routine mid-stream. The old order collapsed newlines
  // first, which stopped this looking like a fence at all.
  assert.equal(generateSessionTitle('```js\nconst a = 1;'), '');
  assert.equal(generateSessionTitle('修一下 `getUser()` 的空指针'), '修一下 的空指针');
});

test('never strips itself down to nothing', () => {
  // Every token here is a filler prefix; stripping them all would empty it.
  for (const input of ['帮我', '请', '看看', 'please', '你好']) {
    assert.notEqual(generateSessionTitle(input), '', `emptied on: ${input}`);
  }
});

test('handles non-string and empty input without throwing', () => {
  assert.equal(generateSessionTitle(''), '');
  assert.equal(generateSessionTitle(null), '');
  assert.equal(generateSessionTitle(undefined), '');
  assert.equal(generateSessionTitle(42), '');
  assert.equal(generateSessionTitle('   \n\t  '), '');
});

test('appends an ellipsis only when it actually truncated', () => {
  assert.ok(!generateSessionTitle('修一下登录 bug').endsWith('…'));
  assert.ok(generateSessionTitle('把这个非常非常长的中文标题一直写下去直到超出预算为止好了'.repeat(2)).endsWith('…'));
});

test('SESSION_DEFAULT_RE matches placeholder titles only', () => {
  for (const t of ['Session 1', 'Session 42', 'session-a1b2c3', 'channel-deadbeef',
    'New chat', 'New Chat', 'Untitled', '新会话', '新对话', '未命名']) {
    assert.ok(SESSION_DEFAULT_RE.test(t), `should be overwritable: ${t}`);
  }
  // `general` is a standing channel people navigate by, not a session — and a
  // channel the user named is theirs. Auto-titling must leave both alone.
  for (const t of ['general', 'General', 'sprint-planning', '前端重构', 'Session', 'my session 1']) {
    assert.ok(!SESSION_DEFAULT_RE.test(t), `must NOT be overwritten: ${t}`);
  }
});
