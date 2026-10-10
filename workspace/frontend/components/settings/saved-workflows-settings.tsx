'use strict';
'use client';

import * as React from 'react';
import { GitFork, Loader2, Plus, Trash2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useWorkspace } from '@/lib/workspace-context';
import type { PipelineStep } from '@/lib/generated/api-types';

interface WorkflowItem {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  created_at: string;
  updated_at: string;
}

export function SavedWorkflowsSettings() {
  const { agents } = useWorkspace();
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
      const res = await workspaceApi.listSavedWorkflows();
      setWorkflows(res.workflows || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load saved workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleAddStep = () => {
    setSteps([...steps, { agent: '', instruction: '' }]);
  };

  const handleRemoveStep = (index: number) => {
    if (steps.length <= 2) return;
    setSteps(steps.filter((_, i) => i !== index));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) {
      toast.error('Workflow name is required');
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].agent || !steps[i].instruction.trim()) {
        toast.error(`Step ${i + 1} requires both an agent and an instruction`);
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
      toast.success(`Workflow "${cleanName}" saved`);
      setShowAdd(false);
      setName('');
      setDescription('');
      setSteps([
        { agent: '', instruction: '' },
        { agent: '', instruction: '' },
      ]);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, wfName: string) => {
    try {
      await workspaceApi.deleteSavedWorkflow(id);
      toast.success(`Workflow "${wfName}" deleted`);
      setWorkflows(workflows.filter((w) => w.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete workflow');
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-surface1 p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <GitFork className="size-4 text-primary" />
            Reusable Workflows (Pipelines)
          </h3>
          <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
            Multi-step relay pipelines that can be run repeatedly or triggered by agents via <code>workspace_run_workflow</code>.
          </p>
        </div>
        {!showAdd && (
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1.5 shrink-0 text-xs">
            <Plus className="size-3.5" />
            New Workflow
          </Button>
        )}
      </div>

      {showAdd && (
        <form onSubmit={handleSave} className="rounded-xl border border-border bg-surface2 p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Workflow Name</Label>
              <Input
                placeholder="e.g. code-and-review"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs font-mono"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Input
                placeholder="e.g. Implement feature with Coder, then verify with Reviewer"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Pipeline Steps (Sequential Relay)</Label>
              <Button type="button" size="sm" variant="ghost" onClick={handleAddStep} className="h-6 text-2xs gap-1">
                <Plus className="size-3" />
                Add Step
              </Button>
            </div>
            <div className="space-y-2.5">
              {steps.map((step, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-lg border border-border/70 bg-surface1 p-2.5">
                  <span className="text-xs font-mono font-semibold text-foreground-muted mt-1.5 w-5">
                    #{idx + 1}
                  </span>
                  <div className="w-40 shrink-0">
                    <Select
                      value={step.agent}
                      onValueChange={(val) => {
                        const copy = [...steps];
                        copy[idx].agent = val;
                        setSteps(copy);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Select Agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((a) => (
                          <SelectItem key={a.agentName} value={a.agentName} className="text-xs">
                            @{a.agentName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex-1">
                    <Input
                      placeholder={`Instruction for step ${idx + 1}`}
                      value={step.instruction}
                      onChange={(e) => {
                        const copy = [...steps];
                        copy[idx].instruction = e.target.value;
                        setSteps(copy);
                      }}
                      className="h-8 text-xs"
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

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)} className="text-xs">
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving} className="text-xs gap-1">
              {saving && <Loader2 className="size-3 animate-spin" />}
              Save Workflow
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-foreground-muted">
          <Loader2 className="size-4 animate-spin mr-2" />
          <span className="text-xs">Loading workflows...</span>
        </div>
      ) : workflows.length === 0 ? (
        <p className="text-xs text-foreground-muted italic">
          No saved workflows yet. Create a workflow above to enable reusable relay pipelines.
        </p>
      ) : (
        <div className="space-y-2.5">
          {workflows.map((wf) => (
            <div
              key={wf.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-surface2/60 p-3.5 transition-colors hover:border-border"
            >
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-foreground">{wf.name}</span>
                  {wf.description && (
                    <span className="text-xs text-foreground-muted truncate"> — {wf.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap text-2xs font-mono text-foreground-muted">
                  {wf.steps.map((s, idx) => (
                    <React.Fragment key={idx}>
                      {idx > 0 && <ArrowRight className="size-2.5 text-foreground-extra-muted" />}
                      <span className="rounded bg-surface3 px-1.5 py-0.5 text-foreground">
                        @{s.agent}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleDelete(wf.id, wf.name)}
                className="size-7 p-0 text-foreground-muted hover:text-destructive shrink-0"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
