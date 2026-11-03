'use client';
import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';

interface Question { id: string; title: string; options: { label: string; description?: string }[]; allowFreeInput: boolean; prefill?: string }
interface Interaction {
  id: string; runId: string; attemptId: string; channel: string; agentName: string;
  kind: 'question' | 'approval'; state: string; version: number; expiresAt: number;
  questions: Question[]; receipt: string | null; answer: { answers?: Record<string, string[]>; cancelled?: boolean; confirmed?: boolean } | null;
}
const states: Record<string, string> = { waiting: '等待处理', answered: '答案已保存，正在投递', sent: '已发送，等待 Agent 继续',
  continued: 'Agent 已继续', cancelled: '已取消', expired: '已过期', invalidated: '原生请求已失效', delivery_unknown: '投递结果待核对' };
const button = 'rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-surface2';

function InteractionCard({ item, refresh }: { item: Interaction; refresh: () => Promise<void> }) {
  const [answers, setAnswers] = React.useState<Record<string, string>>(() => {
    const defaults = Object.fromEntries(item.questions.filter(q => q.prefill).map(q => [q.id, q.prefill!])) as Record<string, string>;
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(`52hz:interaction:${item.id}`) || '{}') }; } catch { return defaults; }
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const submission = React.useRef<{ fingerprint: string; key: string } | null>(null);
  const waiting = item.state === 'waiting';
  const update = (id: string, value: string) => {
    const next = { ...answers, [id]: value }; setAnswers(next);
    try { localStorage.setItem(`52hz:interaction:${item.id}`, JSON.stringify(next)); } catch { /* Keep in-memory draft. */ }
  };
  const submit = async (action: 'answer' | 'decision' | 'cancel', confirmed?: boolean) => {
    if (busy || !waiting) return;
    setBusy(true); setError('');
    const value = action === 'answer' ? { answers: Object.fromEntries(item.questions.map(q => [q.id, [answers[q.id] || '']])) }
      : action === 'decision' ? { confirmed } : {};
    const fingerprint = JSON.stringify({ action, value });
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await workspaceApi.request(`/v1/interactions/${encodeURIComponent(item.id)}/${action}`, { method: 'POST',
        body: JSON.stringify({ ...value, attemptId: item.attemptId, expectedVersion: item.version, idempotencyKey: submission.current.key }) });
      try { localStorage.removeItem(`52hz:interaction:${item.id}`); } catch { /* Storage unavailable. */ }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请刷新状态后重试。'); await refresh(); }
    finally { setBusy(false); }
  };
  return <section className="rounded-lg border border-border bg-surface1 px-4 py-3 text-sm" aria-label={`${item.agentName} 的${item.kind === 'approval' ? '权限确认' : '问题'}`}>
    <div className="flex items-center justify-between gap-3 text-xs"><strong>{item.agentName} · {item.kind === 'approval' ? '权限确认' : '需要你的回答'}</strong>
      <span role="status" className="text-foreground-muted">{states[item.state] || item.state}</span></div>
    {item.kind === 'approval' && <p className="mt-2 text-xs text-foreground-muted">原生扩展的本次确认，与普通问题分开处理；不会授予后续操作或扩大工作台权限。</p>}
    {item.questions.map(q => <fieldset key={q.id} disabled={busy || !waiting} className="mt-3 space-y-2">
      <legend className="whitespace-pre-wrap break-words text-sm">{q.title}</legend>
      {item.kind === 'question' && <>
        {q.options.map((option, index) => <label key={index} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2">
          <input type="radio" name={`${item.id}:${q.id}`} checked={(answers[q.id] ?? item.answer?.answers?.[q.id]?.[0]) === option.label} onChange={() => update(q.id, option.label)} className="mt-0.5" />
          <span><span className="text-xs">{option.label}</span>{option.description && <span className="mt-1 block text-xs text-foreground-muted">{option.description}</span>}</span>
        </label>)}
        {q.allowFreeInput && <textarea aria-label={`${q.title}：输入答案`} value={answers[q.id] ?? item.answer?.answers?.[q.id]?.[0] ?? ''}
          onChange={e => update(q.id, e.target.value)} maxLength={20000} rows={3}
          placeholder={q.options.length ? '也可以填写自己的答案' : '输入答案'}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60" />}
      </>}
    </fieldset>)}
    {waiting && <div className="mt-3 flex flex-wrap gap-2">
      {item.kind === 'approval' ? <><button type="button" className={button} disabled={busy} onClick={() => void submit('decision', true)}>允许本次请求</button>
        <button type="button" className={button} disabled={busy} onClick={() => void submit('decision', false)}>拒绝</button></>
        : <button type="button" className={button} disabled={busy || item.questions.some(q => !answers[q.id]?.trim())} onClick={() => void submit('answer')}>{busy ? '正在提交' : '提交答案'}</button>}
      <button type="button" className={button} disabled={busy} onClick={() => void submit('cancel')}>取消请求</button>
    </div>}
    {item.receipt && <p className="mt-2 text-xs text-foreground-muted">{item.receipt}</p>}
    {item.kind === 'approval' && typeof item.answer?.confirmed === 'boolean' && <p className="mt-2 text-xs text-foreground-muted">你的决定：{item.answer.confirmed ? '允许本次请求' : '拒绝本次请求'}</p>}
    {['invalidated','delivery_unknown','expired'].includes(item.state) && <p className="mt-2 text-xs text-foreground-muted">不会自动重发答案或授权。请检查原任务状态，再决定是否重新发起任务；未提交的答案草稿仍保留。</p>}
    {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
    <details className="mt-2 text-xs text-foreground-muted"><summary className="cursor-pointer">任务上下文</summary>
      <p className="mt-1 break-all">任务 {item.runId} · 执行尝试 {item.attemptId}</p><p>有效期至 {new Date(item.expiresAt).toLocaleString()}</p>
    </details>
  </section>;
}

export function AgentInteractionsPanel({ channel, running }: { channel: string | null; running: boolean }) {
  const [items, setItems] = React.useState<Interaction[]>([]);
  const [loadError, setLoadError] = React.useState('');
  const current = React.useRef(channel); current.current = channel;
  const refresh = React.useCallback(async () => {
    if (!channel || channel.startsWith('draft:')) return;
    try {
      const result = await workspaceApi.request<{ interactions: Interaction[] }>(`/v1/interactions?channel=${encodeURIComponent(channel)}`);
      if (current.current === channel) { setItems(result.interactions); setLoadError(''); }
    } catch { if (current.current === channel) setLoadError('交互状态暂时无法同步。连接恢复后会重新读取，不会自动重复提交。'); }
  }, [channel]);
  React.useEffect(() => { setItems([]); setLoadError(''); void refresh(); }, [refresh]);
  useVisibilityPolling(refresh, running ? 1000 : 5000);
  React.useEffect(() => { void refresh(); }, [running, refresh]);
  const waiting = items.filter(i => ['waiting','answered','sent'].includes(i.state));
  const history = items.filter(i => !['waiting','answered','sent'].includes(i.state)).slice(0, 10);
  if (!items.length) return null;
  return <div className="mt-3 max-h-96 space-y-2 overflow-y-auto" data-testid="agent-interactions">
    {!!loadError && <p role="status" className="text-xs text-foreground-muted">{loadError}</p>}
    {waiting.map(item => <InteractionCard key={item.id} item={item} refresh={refresh} />)}
    {!!history.length && <details><summary className="cursor-pointer text-xs text-foreground-muted">提问与确认记录 ({history.length})</summary>
      <div className="mt-2 space-y-2">{history.map(item => <InteractionCard key={item.id} item={item} refresh={refresh} />)}</div>
    </details>}
  </div>;
}
