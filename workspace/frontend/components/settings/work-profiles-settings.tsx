'use client';

import * as React from 'react';
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import { modelsFor, useAgentModels } from '@/lib/agent-model-store';
import { AGENT_PROFILES, isReadOnlyEnforced, type AgentMode } from '@/lib/agent-profiles';
import type { WorkProfile, WorkMode } from '@/lib/api/orchestration';

/**
 * Saved profiles: the presets orchestrating agents choose from when they
 * delegate (workspace_list_profiles → workspace_delegate).
 *
 * A profile is an agent, an optional model and Fix or Review — the same two
 * modes as the composer's switch, with the same labels and the same honesty
 * about where Review is enforced — plus a line saying when to use it, which is
 * what the agent picks by. The agent reads only these fields, so the line is
 * written for an agent, not for the settings page.
 */

const MODE_OPTIONS = AGENT_PROFILES.map((p) => ({ value: p.settings.agentMode, label: p.label, icon: p.icon }));

const modeOf = (mode: string): (typeof AGENT_PROFILES)[number] =>
  AGENT_PROFILES.find((p) => p.settings.agentMode === mode) ?? AGENT_PROFILES[0];

interface Draft {
  id: string | null;
  name: string;
  agent: string;
  model: string;
  mode: WorkMode;
  whenToUse: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', agent: '', model: '', mode: 'execute', whenToUse: '' };

export function WorkProfilesSettings() {
  const { agents } = useWorkspace();
  const modelSnapshot = useAgentModels();
  const [profiles, setProfiles] = React.useState<WorkProfile[]>([]);
  const [agentStatus, setAgentStatus] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await workspaceApi.listWorkProfiles();
      setProfiles(res.profiles ?? []);
      setAgentStatus(res.agent_status ?? {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Deleting is a two-step click, like discarding a batch.
  React.useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const agentNames = React.useMemo(() => agents.map((a) => a.agentName).sort((a, b) => a.localeCompare(b)), [agents]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        agent: draft.agent,
        model: draft.model.trim(),
        mode: draft.mode,
        when_to_use: draft.whenToUse.trim(),
      };
      if (draft.id) await workspaceApi.updateWorkProfile(draft.id, input);
      else await workspaceApi.createWorkProfile(input);
      toast.success(draft.id ? 'Profile saved' : 'Profile added');
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the profile');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await workspaceApi.deleteWorkProfile(id);
      setProfiles((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the profile');
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-surface1 p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Profiles</h3>
          <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
            Named ways to run an agent — which agent, which model, Fix or Review — and when to use each. Agents
            pick from these when they delegate: every task runs in its own worktree, and nothing is merged until
            you approve it.
          </p>
        </div>
        {!draft && (
          <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setDraft({ ...EMPTY_DRAFT, agent: agentNames[0] ?? '' })}>
            <Plus className="size-3.5 mr-1" />
            Add profile
          </Button>
        )}
      </div>

      {draft && (
        <ProfileForm
          draft={draft}
          setDraft={setDraft}
          agentNames={agentNames}
          agentType={agents.find((a) => a.agentName === draft.agent)?.agentType ?? null}
          modelOptions={draft.agent ? modelsFor(modelSnapshot, draft.agent).map((m) => m.id) : []}
          saving={saving}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Loader2 className="size-3.5 animate-spin" /> Loading profiles…
        </div>
      ) : profiles.length === 0 ? (
        !draft && (
          <p className="text-2xs text-foreground-muted leading-snug">
            No profiles yet. Agents can still delegate by naming an agent; a profile adds the model, the mode and a
            line on when to use it.
          </p>
        )
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {profiles.map((p) => {
            const mode = modeOf(p.mode);
            const ModeIcon = mode.icon;
            const status = agentStatus[p.agent];
            return (
              <li key={p.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <code className="text-xs font-medium text-foreground">{p.name}</code>
                    <span className="text-2xs text-foreground-muted">@{p.agent}</span>
                    <span className="inline-flex items-center gap-1 text-2xs text-foreground-muted">
                      <ModeIcon className="size-3" />
                      {mode.label}
                    </span>
                    <span className="text-2xs text-foreground-muted font-mono truncate">{p.model || "agent's own model"}</span>
                    {status && status !== 'online' && (
                      <span className="inline-flex items-center gap-1 text-2xs text-status-warning">
                        <AlertTriangle className="size-3" />
                        {status === 'missing' ? 'agent no longer in workspace' : 'agent offline'}
                      </span>
                    )}
                  </div>
                  {p.when_to_use && <p className="mt-0.5 text-2xs text-foreground-muted leading-snug">{p.when_to_use}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Edit profile ${p.name}`}
                    onClick={() =>
                      setDraft({ id: p.id, name: p.name, agent: p.agent, model: p.model, mode: p.mode, whenToUse: p.when_to_use })
                    }
                    className="rounded-md p-1 text-foreground-muted hover:bg-surface2 hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={confirmDelete === p.id ? `Click again to delete ${p.name}` : `Delete profile ${p.name}`}
                    onClick={() => (confirmDelete === p.id ? void remove(p.id) : setConfirmDelete(p.id))}
                    className={cn(
                      'rounded-md p-1 hover:bg-surface2',
                      confirmDelete === p.id ? 'text-status-danger' : 'text-foreground-muted hover:text-foreground',
                    )}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
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
  agentNames: string[];
  agentType: string | null;
  modelOptions: string[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function ProfileForm({ draft, setDraft, agentNames, agentType, modelOptions, saving, onSave, onCancel }: FormProps) {
  const listId = React.useId();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const reviewOnlyAsked = draft.mode === 'plan' && draft.agent !== '' && !isReadOnlyEnforced(agentType, draft.agent);

  return (
    <div className="rounded-lg border border-border bg-surface2/40 p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="profile-name">
            Name
          </Label>
          <Input
            id="profile-name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="reviewer"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Agent</Label>
          <Select value={draft.agent || undefined} onValueChange={(agent) => set({ agent, model: '' })}>
            <SelectTrigger size="sm" aria-label="Agent">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {agentNames.map((name) => (
                <SelectItem key={name} value={name}>
                  @{name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Mode</Label>
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
            {reviewOnlyAsked && ` @${draft.agent} is only asked not to edit.`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="profile-model">
            Model
          </Label>
          <Input
            id="profile-model"
            list={listId}
            value={draft.model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder="Agent's own model"
            className="h-8 text-xs font-mono"
          />
          <datalist id={listId}>
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs" htmlFor="profile-when">
            When to use
          </Label>
          <Textarea
            id="profile-when"
            value={draft.whenToUse}
            onChange={(e) => set({ whenToUse: e.target.value })}
            placeholder="Independent code review before a merge; reads and reports, never edits."
            className="min-h-16 text-xs"
          />
          <p className="text-2xs text-foreground-muted">The delegating agent reads this line to decide.</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" className="h-8 text-xs" onClick={onSave} disabled={saving || !draft.name.trim() || !draft.agent}>
          {saving && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
          {draft.id ? 'Save profile' : 'Add profile'}
        </Button>
      </div>
    </div>
  );
}
