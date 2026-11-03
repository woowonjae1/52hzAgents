'use strict';
const fail = message => Object.assign(new Error(message), { code: 'INVALID_NATIVE_QUESTION' });
function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) throw fail('原生问题数量无效。');
  const ids = new Set();
  for (const q of questions) {
    if (typeof q.id !== 'string' || !q.id || ids.has(q.id) || q.id.length > 200
      || typeof q.title !== 'string' || !q.title || q.title.length > 20000
      || q.options.length > 100 || q.options.some(o => typeof o.label !== 'string' || !o.label || o.label.length > 2000)) throw fail('原生问题格式无效。');
    ids.add(q.id);
    if (q.isSecret || /(?:api[ _-]?key|access[ _-]?token|oauth[ _-]?token|password|密码|密钥)/i.test(q.title)) {
      throw Object.assign(new Error('请通过 Agent 原生登录或受保护的连接设置处理凭据，任务问题不接收认证秘密。'), { code: 'AUTH_INPUT_NOT_ALLOWED' });
    }
  }
  return questions;
}
function piQuestion(event) {
  return { nativeRequestId: String(event.id), kind: event.method === 'confirm' ? 'approval' : 'question',
    timeoutMs: event.timeout > 0 ? event.timeout : undefined,
    questions: validateQuestions([{ id: 'value', title: [event.title, event.message].filter(Boolean).join('\n'),
      options: event.method === 'select' ? (event.options || []).map(label => ({ label })) : [],
      prefill: event.method === 'editor' && typeof event.prefill === 'string' ? event.prefill.slice(0, 20000) : '',
      allowFreeInput: !['select','confirm'].includes(event.method), isSecret: Boolean(event.isSecret) }]) };
}
function codexQuestion(params, id) {
  return { nativeRequestId: String(id), nativeSession: params.threadId, kind: 'question', timeoutMs: params.autoResolutionMs ?? undefined,
    questions: validateQuestions((params.questions || []).map(q => ({ id: q.id, title: q.question,
      options: (q.options || []).map(o => ({ label: o.label, description: o.description })),
      allowFreeInput: q.isOther === true || !q.options?.length, isSecret: q.isSecret === true }))) };
}
function writeNativeReply(stream, payload) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) return reject(new Error('原生交互通道已关闭，答案投递结果未知。'));
    stream.write(JSON.stringify(payload) + '\n', error => error ? reject(error) : resolve());
  });
}
module.exports = { piQuestion, codexQuestion, writeNativeReply };
