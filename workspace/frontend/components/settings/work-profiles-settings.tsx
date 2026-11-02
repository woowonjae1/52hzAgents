'use client';

import * as React from 'react';
import { AlertTriangle, Loader2, Pencil, Plus, Trash2, Bot, Layers, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceApi, type AgentDefinition } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AGENT_PROFILES, type AgentMode } from '@/lib/agent-profiles';
import type { WorkProfile, WorkMode } from '@/lib/api/orchestration';
import { Badge } from '@/components/ui/badge';

const MODE_OPTIONS = AGENT_PROFILES.map((p) => ({ value: p.settings.agentMode, label: p.label, icon: p.icon }));

const modeOf = (mode: string): (typeof AGENT_PROFILES)[number] =>
  AGENT_PROFILES.find((p) => p.settings.agentMode === mode) ?? AGENT_PROFILES[0];

interface Draft {
  id: string | null;
  name: string;
  agent: string;
  mode: WorkMode;
  whenToUse: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', agent: '', mode: 'execute', whenToUse: '' };

export function WorkProfilesSettings() {
  const [profiles, setProfiles] = React.useState<WorkProfile[]>([]);
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [profilesRes, agentsRes] = await Promise.all([
        workspaceApi.listWorkProfiles(),
        workspaceApi.listAgentDefinitions(true),
      ]);
      setProfiles(profilesRes.profiles ?? []);
      setAgents(agentsRes.agents ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载工作配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        agent: draft.agent,
        model: '',
        mode: draft.mode,
        when_to_use: draft.whenToUse.trim(),
      };
      if (draft.id) await workspaceApi.updateWorkProfile(draft.id, input);
      else await workspaceApi.createWorkProfile(input);
      toast.success(draft.id ? '工作配置已保存' : '工作配置已创建');
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '无法保存工作配置');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await workspaceApi.deleteWorkProfile(id);
      setProfiles((prev) => prev.filter((p) => p.id !== id));
      toast.success('已删除工作配置');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-surface1 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Layers className="size-4 text-primary" />
            <span>协作工作配置 (Work Profiles)</span>
          </h3>
          <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
            为主协调 Agent 提供委派预设方案。每个配置引用一个真实已保存的 Agent 身份，并收窄其任务方式与使用时机。不再维护独立的模型覆盖体系。
          </p>
        </div>
        {!draft && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs shrink-0 gap-1.5"
            onClick={() => setDraft({ ...EMPTY_DRAFT, agent: agents[0]?.id ?? '' })}
          >
            <Plus className="size-3.5" />
            <span>添加工作配置</span>
          </Button>
        )}
      </div>

      {draft && (
        <ProfileForm
          draft={draft}
          setDraft={setDraft}
          agents={agents}
          saving={saving}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      )}

      {loading ? (
        <div className="py-8 text-center text-xs text-foreground-muted flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>正在加载工作配置...</span>
        </div>
      ) : profiles.length === 0 ? (
        <p className="text-xs text-foreground-muted text-center py-6">暂无工作配置预设。</p>
      ) : (
        <ul className="divide-y divide-border/40 rounded-xl border border-border/60 bg-surface0 overflow-hidden">
          {profiles.map((p) => {
            const boundAgent = agents.find((a) => a.id === p.agent);
            const isInvalidRef = !boundAgent;

            return (
              <li key={p.id} className="p-3 flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground font-mono">{p.name}</span>
                    <Badge variant="outline" size="sm" className="text-3xs uppercase">
                      {p.mode}
                    </Badge>
                    {isInvalidRef ? (
                      <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border border-status-warning/40 bg-status-warning/10 text-status-warning">
                        <AlertTriangle className="size-2.5" />
                        <span>引用的 Agent ({p.agent}) 不存在，需重新绑定</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-3xs text-foreground-muted">
                        <Bot className="size-3 text-primary" />
                        <span>{boundAgent.name}</span>
                      </span>
                    )}
                  </div>
                  {p.when_to_use && (
                    <p className="text-2xs text-foreground-muted line-clamp-2 leading-relaxed">
                      {p.when_to_use}
                    </p>
                  )}
                  {boundAgent?.modelResource && (
                    <p className="text-3xs text-foreground-extra-muted font-mono">
                      继承模型：{boundAgent.modelResource.connectionId} / {boundAgent.modelResource.modelId}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0 self-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-2xs gap-1"
                    onClick={() =>
                      setDraft({
                        id: p.id,
                        name: p.name,
                        agent: p.agent,
                        mode: p.mode,
                        whenToUse: p.when_to_use,
                      })
                    }
                  >
                    <Pencil className="size-3" />
                    <span>编辑</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-7 px-2 text-2xs gap-1',
                      confirmDelete === p.id
                        ? 'text-status-danger hover:bg-status-danger/10'
                        : 'text-foreground-muted hover:text-status-danger'
                    )}
                    onClick={() => (confirmDelete === p.id ? void remove(p.id) : setConfirmDelete(p.id))}
                  >
                    <Trash2 className="size-3" />
                    <span>{confirmDelete === p.id ? '再次确认' : '删除'}</span>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface FormProps {
  draft: Draft;
  setDraft: (d: Draft) => void;
  agents: AgentDefinition[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function ProfileForm({ draft, setDraft, agents, saving, onSave, onCancel }: FormProps) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const selectedAgent = agents.find((a) => a.id === draft.agent);

  return (
    <div className="rounded-lg border border-border bg-surface2/40 p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="profile-name">
            配置名称 (Profile Name) *
          </Label>
          <Input
            id="profile-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="例如：code-reviewer, architect"
            className="h-8 text-xs font-mono bg-surface0"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">绑定的 Agent 执行主体 *</Label>
          <Select value={draft.agent || undefined} onValueChange={(agent) => set({ agent })}>
            <SelectTrigger size="sm" aria-label="Agent" className="h-8 text-xs bg-surface0">
              <SelectValue placeholder="选择已保存的 Agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((ag) => (
                <SelectItem key={ag.id} value={ag.id}>
                  {ag.name} ({ag.role})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">执行方式</Label>
          <div>
            <SegmentedControl<AgentMode>
              size="xs"
              options={MODE_OPTIONS}
              value={draft.mode}
              onValueChange={(mode) => set({ mode })}
            />
          </div>
          <p className="text-2xs text-foreground-muted leading-snug">
            {modeOf(draft.mode).whenToUse}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">执行资源模型</Label>
          <div className="h-8 rounded-lg border border-border bg-surface0/60 px-2.5 flex items-center text-xs text-foreground-muted font-mono">
            {selectedAgent?.modelResource ? (
              <span>
                {selectedAgent.modelResource.connectionId} · {selectedAgent.modelResource.modelId}
              </span>
            ) : (
              <span className="text-foreground-extra-muted italic">继承全局连接 (无独立模型资源)</span>
            )}
          </div>
          <p className="text-3xs text-foreground-extra-muted">模型由所选 Agent 的配置决定，不在此处重复覆盖。</p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs" htmlFor="profile-when">
            适用时机 (When to use)
          </Label>
          <Textarea
            id="profile-when"
            value={draft.whenToUse}
            onChange={(e) => set({ whenToUse: e.target.value })}
            placeholder="说明在何种场景下委派此任务（主 Agent 会读取此段说明进行判断）..."
            className="min-h-16 text-xs bg-surface0"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onSave}
          disabled={saving || !draft.name.trim() || !draft.agent}
        >
          {saving && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
          <span>{draft.id ? '保存修改' : '创建配置'}</span>
        </Button>
      </div>
    </div>
  );
}
