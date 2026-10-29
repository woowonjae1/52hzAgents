'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
  Bot,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { getBridge } from '@/lib/desktop';

export interface ConnectionItem {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic' | 'ollama';
  baseUrl: string;
  defaultModel: string;
  models?: { id: string; name: string }[];
  hasCredential: boolean;
  source: 'user' | 'env' | 'preset';
  confirmedContextWindow?: number;
}

export interface TestResult {
  ok: boolean;
  level: 'chat' | 'agent';
  latencyMs: number;
  model: string;
  message?: string;
  errorCode?: string;
  error?: string;
  toolExecuted?: boolean;
}

export function RouterProviderSettings() {
  const [connections, setConnections] = React.useState<ConnectionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // Form states
  const [formName, setFormName] = React.useState('');
  const [formProtocol, setFormProtocol] = React.useState<'openai' | 'anthropic' | 'ollama'>('openai');
  const [formBaseUrl, setFormBaseUrl] = React.useState('');
  const [formModel, setFormModel] = React.useState('');
  const [formCapacity,setFormCapacity] = React.useState('');
  const [formKeyAction, setFormKeyAction] = React.useState<'keep' | 'replace' | 'delete'>('keep');
  const [formKeyValue, setFormKeyValue] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [importing,setImporting] = React.useState(false);
  const importPi=async()=>{
    setImporting(true);
    try{const bridge=getBridge();if(!bridge?.importPiConnections)throw new Error('请在桌面应用中导入 Pi 配置。');
      const result=await bridge.importPiConnections();toast.success(`已导入 ${result.imported.length} 个连接，跳过 ${result.skipped.length} 个不支持的配置。导入不会发起模型请求。`);await fetchConnections();
    }catch(error){toast.error(error instanceof Error?error.message:'导入失败');}finally{setImporting(false);}
  };

  // Testing states
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<TestResult | null>(null);

  const fetchConnections = React.useCallback(async () => {
    try {
      const res = await workspaceApi.request<{ connections: ConnectionItem[] }>('/v1/settings/connections');
      if (res?.connections) {
        setConnections(res.connections);
      }
    } catch (e) {
      toast.error('无法加载模型连接列表');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  const startEdit = (conn: ConnectionItem) => {
    setEditingId(conn.id);
    setFormName(conn.name);
    setFormProtocol(conn.protocol);
    setFormBaseUrl(conn.baseUrl);
    setFormModel(conn.defaultModel);
    setFormCapacity(conn.confirmedContextWindow?String(conn.confirmedContextWindow):'');
    setFormKeyAction(conn.hasCredential ? 'keep' : 'replace');
    setFormKeyValue('');
    setTestResult(null);
  };

  const startNew = () => {
    const newId = `custom_${Date.now().toString(36)}`;
    setEditingId(newId);
    setFormName('自定义 API 网关');
    setFormProtocol('openai');
    setFormBaseUrl('https://api.openai.com/v1');
    setFormModel('gpt-4o');
    setFormCapacity('');
    setFormKeyAction('replace');
    setFormKeyValue('');
    setTestResult(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setTestResult(null);
  };

  const saveConnection = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await workspaceApi.request('/v1/settings/connections', {
        method: 'POST',
        body: JSON.stringify({
          id: editingId,
          name: formName,
          protocol: formProtocol,
          baseUrl: formBaseUrl,
          defaultModel: formModel,
          confirmedContextWindow: Number(formCapacity)||0,
          credentialAction: formKeyAction,
          credentialValue: formKeyValue,
        }),
      });
      toast.success('模型连接已成功保存');
      setEditingId(null);
      await fetchConnections();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存连接失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteConnection = async (id: string) => {
    if (!window.confirm(`确定删除连接 "${id}" 及其安全凭据吗？`)) return;
    try {
      await workspaceApi.request(`/v1/settings/connections?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      toast.success('连接已删除');
      if (editingId === id) setEditingId(null);
      await fetchConnections();
    } catch (e) {
      toast.error('删除连接失败');
    }
  };

  const runTest = async (connectionId: string, level: 'chat' | 'agent') => {
    setTestingId(`${connectionId}:${level}`);
    setTestResult(null);
    try {
      const isUnsavedEditing = editingId === connectionId;
      const res = await workspaceApi.request<TestResult>('/v1/settings/connections/test', {
        method: 'POST',
        body: JSON.stringify({
          connectionId,
          level,
          model: isUnsavedEditing ? formModel : undefined,
          overrideKey: isUnsavedEditing && formKeyAction === 'replace' ? formKeyValue : undefined,
          overrideBaseUrl: isUnsavedEditing ? formBaseUrl : undefined,
          protocol: isUnsavedEditing ? formProtocol : undefined,
          credentialAction: isUnsavedEditing ? formKeyAction : undefined,
        }),
      });
      setTestResult(res);
      if (res.ok) {
        toast.success(res.message || '测试通过');
      } else {
        toast.error(res.error || '测试失败');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '连通性测试失败';
      toast.error(msg);
      setTestResult({
        ok: false,
        level,
        latencyMs: 0,
        model: formModel,
        errorCode: 'REQUEST_ERROR',
        error: msg,
      });
    } finally {
      setTestingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-xs text-foreground-muted">
        <Loader2 className="size-4 animate-spin" />
        加载模型连接配置...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">模型连接与安全凭据</h3>
          <button type="button" onClick={()=>void importPi()} disabled={importing} className="mt-2 text-xs underline disabled:opacity-40">{importing?'正在导入…':'从本机 Pi models.json 导入（同名连接将更新）'}</button>
          <p className="mt-1 text-xs text-foreground-muted">
            配置用于对话与 Agent 工具执行的大语言模型端点。凭据采用操作系统加密（Windows DPAPI）安全隔离。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={startNew} className="gap-1 text-xs">
          <Plus className="size-3.5" />
          添加连接
        </Button>
      </div>

      {/* Warning note */}
      <div className="rounded-lg border border-border/60 bg-surface1 p-3 text-xs leading-5 text-foreground-muted">
        <span className="font-semibold text-foreground">💡 真实测试与 Token 提示：</span>
        进行连通性测试（对话测试或 Agent 工具测试）会向模型提供商发送真实请求，可能会产生少量 Token 消耗。测试结果仅代表当前网络与凭据状态。
      </div>

      {/* Editing Modal/Form */}
      {editingId && (
        <div className="rounded-xl border border-primary/30 bg-surface2/40 p-4 shadow-sm space-y-4">
          <label className="block text-xs text-foreground-muted">已确认的默认模型上下文容量（未知请留空）<Input type="number" min={2048} max={10000000} value={formCapacity} onChange={e=>setFormCapacity(e.target.value)} placeholder="例如 128000" className="mt-1 h-8" /></label>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-primary">
              {connections.some((c) => c.id === editingId) ? `编辑连接: ${formName}` : '新建模型连接'}
            </span>
            <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-6 px-2 text-xs">
              取消
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-foreground-muted">连接名称</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如 DeepSeek 生产、自定义中转"
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <Label className="text-xs text-foreground-muted">接口通信协议</Label>
              <select
                value={formProtocol}
                onChange={(e) => setFormProtocol(e.target.value as any)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-surface1 px-2 text-xs text-foreground"
              >
                <option value="openai">OpenAI 兼容协议 (DeepSeek / OpenAI / 中转 / vLLM)</option>
                <option value="anthropic">Anthropic Messages 协议 (Claude)</option>
                <option value="ollama">Ollama 原生协议 (本地端点)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-foreground-muted">接口基础地址 (Base URL)</Label>
              <Input
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="mt-1 h-8 font-mono text-xs"
              />
              <span className="mt-1 block text-[10px] text-foreground-extra-muted">
                系统会自动规范化末尾斜杠及多余子路径。
              </span>
            </div>
            <div>
              <Label className="text-xs text-foreground-muted">默认模型 ID (Model ID)</Label>
              <Input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder="如 deepseek-chat, gpt-4o"
                className="mt-1 h-8 font-mono text-xs"
              />
            </div>
          </div>

          {/* Credential explicit action */}
          <div className="rounded-lg border border-border bg-surface1 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Key className="size-3.5 text-primary" />
                API Key 凭据管理
              </Label>
              <span className="text-[11px] text-foreground-extra-muted">
                {formKeyAction === 'keep' ? '当前将保留现有密钥' : formKeyAction === 'replace' ? '准备写入新密钥' : '准备删除密钥'}
              </span>
            </div>

            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
                <input
                  type="radio"
                  name="keyAction"
                  checked={formKeyAction === 'keep'}
                  onChange={() => setFormKeyAction('keep')}
                />
                保留已存密钥
              </label>
              <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
                <input
                  type="radio"
                  name="keyAction"
                  checked={formKeyAction === 'replace'}
                  onChange={() => setFormKeyAction('replace')}
                />
                替换新密钥
              </label>
              <label className="flex items-center gap-1.5 text-xs text-destructive cursor-pointer">
                <input
                  type="radio"
                  name="keyAction"
                  checked={formKeyAction === 'delete'}
                  onChange={() => setFormKeyAction('delete')}
                />
                删除密钥
              </label>
            </div>

            {formKeyAction === 'replace' && (
              <div className="pt-2">
                <Input
                  type="password"
                  value={formKeyValue}
                  onChange={(e) => setFormKeyValue(e.target.value)}
                  placeholder="在此输入新的 API Key（明文不会回传前端展示）"
                  className="h-8 font-mono text-xs"
                />
              </div>
            )}
          </div>

          {/* Test & Action buttons in edit mode */}
          <div className="flex items-center justify-between pt-2">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(testingId)}
                onClick={() => runTest(editingId, 'chat')}
                className="h-7 text-xs gap-1"
              >
                {testingId === `${editingId}:chat` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Bot className="size-3" />
                )}
                测试对话连通性
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(testingId)}
                onClick={() => runTest(editingId, 'agent')}
                className="h-7 text-xs gap-1"
              >
                {testingId === `${editingId}:agent` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Wrench className="size-3" />
                )}
                测试 Agent 工具链
              </Button>
            </div>

            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-7 text-xs">
                取消
              </Button>
              <Button size="sm" onClick={saveConnection} disabled={saving} className="h-7 text-xs gap-1">
                {saving && <Loader2 className="size-3 animate-spin" />}
                保存连接
              </Button>
            </div>
          </div>

          {/* Test Feedback */}
          {testResult && (
            <div
              className={`rounded-lg p-2.5 text-xs border ${
                testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-destructive/30 bg-destructive/10 text-destructive-foreground'
              }`}
            >
              <div className="font-semibold flex items-center gap-1.5">
                {testResult.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                {testResult.ok
                  ? testResult.level === 'agent'
                    ? '✓ Agent 工具链验证通过'
                    : '✓ 对话链路验证通过'
                  : `验证失败 [${testResult.errorCode || 'ERROR'}]`}
              </div>
              <div className="mt-1 text-[11px] leading-4 opacity-90">
                {testResult.message || testResult.error}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Connections List */}
      <div className="space-y-3">
        {connections.map((conn) => (
          <div
            key={conn.id}
            className="flex items-center justify-between rounded-xl border border-border bg-surface1 p-3.5 transition-colors hover:border-border/80"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">{conn.name}</span>
                <span className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted">
                  {conn.protocol}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    conn.hasCredential
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-amber-500/15 text-amber-400'
                  }`}
                >
                  {conn.hasCredential ? '✓ 已配置凭据' : '⚠ 未配置凭据'}
                </span>
                <span className="rounded bg-surface2/60 px-1.5 py-0.5 text-[10px] text-foreground-extra-muted">
                    {conn.source === 'env' ? '环境变量来源' : conn.source === 'preset' ? '内置预设' : '自定义配置'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-foreground-muted">
                <span className="font-mono">{conn.baseUrl}</span>
                <span>·</span>
                <span className="font-mono text-foreground-extra-muted">
                  默认模型: {conn.defaultModel || '未设置'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(testingId)}
                onClick={() => runTest(conn.id, 'chat')}
                className="h-7 text-xs gap-1"
                title="验证对话请求与流式分块"
              >
                {testingId === `${conn.id}:chat` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Bot className="size-3" />
                )}
                对话测试
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(testingId)}
                onClick={() => runTest(conn.id, 'agent')}
                className="h-7 text-xs gap-1"
                title="在沙盒中测试只读 ToolCall 闭环"
              >
                {testingId === `${conn.id}:agent` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Wrench className="size-3" />
                )}
                Agent 测试
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => startEdit(conn)}
                className="h-7 text-xs"
              >
                配置
              </Button>
              {conn.source === 'user' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => deleteConnection(conn.id)}
                  className="h-7 w-7 p-0 text-foreground-muted hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
