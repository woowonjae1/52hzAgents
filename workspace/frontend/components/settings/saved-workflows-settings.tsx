'use strict';
'use client';

import * as React from 'react';
import { GitFork, Loader2, Plus, Trash2, ArrowRight, Bot, AlertTriangle, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceApi, type AgentDefinition } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { PipelineStep } from '@/lib/generated/api-types';
import { Badge } from '@/components/ui/badge';

interface WorkflowItem {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  created_at: string;
  updated_at: string;
}

export function SavedWorkflowsSettings() {
  const [agents, setAgents] = React.useState<AgentDefinition[]>([]);
  const [workflows, setWorkflows] = React.useState<WorkflowItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showAdd, setShowAdd] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [steps, setSteps] = React.useState<Array<{ agent: string; instruction: string }>>([
    { agent: '', instruction: '' },
    { agent: '', instruction: '' },
  ]);

  const load = React.useCallback(async () => {
    try {
      const [wfRes, agRes] = await Promise.all([
        workspaceApi.listSavedWorkflows(),
        workspaceApi.listAgentDefinitions(true),
      ]);
      setWorkflows(wfRes.workflows || []);
      setAgents(agRes.agents || []);
      if (agRes.agents?.length > 0) {
        setSteps([
          { agent: agRes.agents[0].id, instruction: '' },
          { agent: agRes.agents[Math.min(1, agRes.agents.length - 1)].id, instruction: '' },
        ]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载工作流模板失败');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleAddStep = () => {
    setSteps([...steps, { agent: agents[0]?.id || '', instruction: '' }]);
  };

  const handleRemoveStep = (index: number) => {
    if (steps.length <= 2) return;
    setSteps(steps.filter((_, i) => i !== index));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) {
      toast.error('工作流名称不能为空');
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].agent || !steps[i].instruction.trim()) {
        toast.error(`步骤 #${i + 1} 必须指定 Agent 和执行指令`);
        return;
      }
    }
    setSaving(true);
    try {
      await workspaceApi.saveWorkflow({
        name: cleanName,
        description: description.trim(),
        steps: steps.map((s) => ({ agent: s.agent, instruction: s.instruction.trim(), status: 'pending' })),
      });
      toast.success(`工作流模板 "${cleanName}" 已保存`);
      setShowAdd(false);
      setName('');
      setDescription('');
      if (agents.length > 0) {
        setSteps([
          { agent: agents[0].id, instruction: '' },
          { agent: agents[Math.min(1, agents.length - 1)].id, instruction: '' },
        ]);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, wfName: string) => {
    try {
      await workspaceApi.deleteSavedWorkflow(id);
      toast.success(`已删除工作流 "${wfName}"`);
      await load();
    } catch {
      toast.error('删除工作流失败');
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-surface1 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <GitFork className="size-4 text-primary" />
            <span>顺序接力工作流 (Relay Pipelines)</span>
          </h3>
          <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
            定义多步骤接力流水线：每个步骤绑定具体的 Agent ID，上一步的交付物自动提炼传递给下一步。
          </p>
        </div>
        {!showAdd && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAdd(true)}
            className="gap-1.5 shrink-0 text-xs h-8"
          >
            <Plus className="size-3.5" />
            <span>新建工作流</span>
          </Button>
        )}
      </div>

      {showAdd && (
        <form onSubmit={handleSave} className="rounded-xl border border-border bg-surface2/60 p-4 space-y-4 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">工作流标识 (Workflow Name) *</Label>
              <Input
                placeholder="例如：code-and-review"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs font-mono bg-surface0"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">描述说明</Label>
              <Input
                placeholder="例如：先由编码 Agent 实施，再交由审阅 Agent 检查"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-8 text-xs bg-surface0"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">接力步骤序列</Label>
              <Button type="button" size="sm" variant="ghost" onClick={handleAddStep} className="h-6 text-2xs gap-1">
                <Plus className="size-3" />
                <span>添加步骤</span>
              </Button>
            </div>
            <div className="space-y-2.5">
              {steps.map((step, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-lg border border-border/70 bg-surface1 p-2.5">
                  <span className="text-xs font-mono font-semibold text-foreground-muted mt-1.5 w-5">
                    #{idx + 1}
                  </span>
                  <div className="w-48 shrink-0">
                    <Select
                      value={step.agent}
                      onValueChange={(val) => {
                        const copy = [...steps];
                        copy[idx].agent = val;
                        setSteps(copy);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-surface0">
                        <SelectValue placeholder="选择 Agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((ag) => (
                          <SelectItem key={ag.id} value={ag.id} className="text-xs">
                            {ag.name} ({ag.role})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1">
                    <Input
                      placeholder={`步骤 #${idx + 1} 的交付目标与执行指令...`}
                      value={step.instruction}
                      onChange={(e) => {
                        const copy = [...steps];
                        copy[idx].instruction = e.target.value;
                        setSteps(copy);
                      }}
                      className="h-8 text-xs bg-surface0"
                      required
                    />
                  </div>
                  {steps.length > 2 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemoveStep(idx)}
                      className="size-8 p-0 text-foreground-muted hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)} className="text-xs h-8">
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving}
              className="text-xs h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving && <Loader2 className="size-3 animate-spin" />}
              <span>保存工作流</span>
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-8 text-center text-xs text-foreground-muted flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span>正在加载流水线模板...</span>
        </div>
      ) : workflows.length === 0 ? (
        <p className="text-xs text-foreground-muted text-center py-6">暂无已保存的流水线模板。</p>
      ) : (
        <div className="space-y-3">
          {workflows.map((wf) => (
            <div key={wf.id} className="rounded-xl border border-border/60 bg-surface0 p-3.5 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold text-foreground font-mono">{wf.name}</h4>
                  {wf.description && <p className="text-2xs text-foreground-muted mt-0.5">{wf.description}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(wf.id, wf.name)}
                  className="size-7 p-0 text-foreground-muted hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              {/* Steps display */}
              <div className="flex items-center gap-1.5 overflow-x-auto py-1 text-2xs">
                {wf.steps.map((st, i) => {
                  const ag = agents.find((a) => a.id === st.agent);
                  const isMissing = !ag;

                  return (
                    <React.Fragment key={i}>
                      {i > 0 && <ArrowRight className="size-3 text-border shrink-0" />}
                      <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border shrink-0 ${
                          isMissing
                            ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
                            : 'border-border/60 bg-surface1 text-foreground'
                        }`}
                        title={st.instruction}
                      >
                        <Bot className="size-3 text-primary shrink-0" />
                        <span className="font-medium">{ag ? ag.name : `未知 Agent (${st.agent})`}</span>
                        <span className="text-foreground-extra-muted max-w-40 truncate font-mono">
                          · {st.instruction}
                        </span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
