'use client';

import { Hint } from '@/components/ui/hint';
import { VisuallyHidden } from 'radix-ui';
import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Sparkles,
  Search,
  ExternalLink,
  Star,
  ArrowRight,
  ArrowLeft,
  Check,
  Plus,
  Loader2,
  AlertCircle,
  Upload,
  Package,
  LayoutGrid,
  Brain,
  Lock,
  Copy,
  Terminal,
  ShieldCheck,
  Layout,
  FlaskConical,
  GitCommit,
  Bug,
  Wand2,
  FileCode,
  Globe,
  Code2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { ScreenMark } from '@/components/headers/screen-mark';
import { workspaceApi } from '@/lib/api';
import { RowActions } from '@/components/ui/row-actions';
import type { WorkspaceCustomSkill } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CURATED_SKILLS, type CuratedSkill } from '@/lib/curated-skills';

// ---------------------------------------------------------------------------
// Skill data models
// ---------------------------------------------------------------------------

export interface Skill {
  id: string;
  name: string;
  trigger?: string;
  description: string;
  category: string;
  tags: string[];
  icon?: string;
  instructions?: string;
  logo?: string;
  sourceRepo?: string;
  sourcePath?: string;
  author?: string;
  featured?: boolean;
  sourceType?: 'catalog' | 'workspace_file';
  fileId?: string;
  filename?: string;
  contentType?: string;
  packageType?: 'md' | 'zip';
}

const CUSTOM_SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Map curated engineering skills to UI Skill shape. */
function curatedToSkill(c: CuratedSkill): Skill {
  return {
    id: c.id,
    name: c.name,
    trigger: c.trigger,
    description: c.description,
    category: c.category,
    tags: c.tags,
    icon: c.icon,
    instructions: c.instructions,
    author: c.author,
    featured: c.featured,
    sourceRepo: c.sourceRepo,
    sourcePath: c.sourcePath,
    sourceType: 'catalog',
  };
}

/** Map backend custom skill into the local Skill shape used by the UI. */
function customSkillToSkill(c: WorkspaceCustomSkill): Skill {
  const trigger = c.trigger || `/${c.id.replace(/^[/-]+/, '')}`;
  return {
    id: c.id,
    name: c.name,
    trigger,
    description: c.description || '',
    category: 'custom',
    tags: c.tags || ['custom'],
    icon: 'code',
    author: c.author || 'Workspace user',
    sourceType: 'workspace_file',
    fileId: c.fileId,
    filename: c.filename,
    contentType: c.contentType,
    packageType: c.packageType,
  };
}

function deriveSkillId(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return (
    stem.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64) ||
    'custom-skill'
  );
}

function extractErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const brace = msg.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(msg.slice(brace));
      if (parsed && typeof parsed.message === 'string') return parsed.message;
    } catch {
      /* fall through */
    }
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Skill Icon Component
// ---------------------------------------------------------------------------

function SkillIconRenderer({ icon, className }: { icon?: string; className?: string }) {
  const cls = cn('size-5', className);
  switch (icon) {
    case 'shield-check':
      return <ShieldCheck className={cls} />;
    case 'search':
      return <Search className={cls} />;
    case 'layout':
      return <Layout className={cls} />;
    case 'flask-conical':
      return <FlaskConical className={cls} />;
    case 'git-commit':
      return <GitCommit className={cls} />;
    case 'bug':
      return <Bug className={cls} />;
    case 'wand-2':
      return <Wand2 className={cls} />;
    case 'lock':
      return <Lock className={cls} />;
    default:
      return <Code2 className={cls} />;
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: 'all', label: 'All Skills', icon: LayoutGrid },
  { id: 'engineering', label: 'Engineering & Quality', icon: ShieldCheck },
  { id: 'architecture', label: 'Architecture & Spec', icon: Layout },
  { id: 'research', label: 'Research & Benchmarks', icon: Brain },
  { id: 'security', label: 'Security & Audit', icon: Lock },
  { id: 'custom', label: 'Custom & Workspace', icon: Package },
];

// ---------------------------------------------------------------------------
// Skill Card
// ---------------------------------------------------------------------------

function SkillCard({
  skill,
  onSelect,
  onUseInChat,
}: {
  skill: Skill;
  onSelect: (s: Skill) => void;
  onUseInChat: (s: Skill) => void;
}) {
  const ghUrl = skill.sourceRepo
    ? `https://github.com/${skill.sourceRepo}/tree/main/${skill.sourcePath}`
    : '';

  return (
    <div className="relative group">
      <button
        type="button"
        className="w-full text-left rounded-xl border border-border bg-card p-4 ui-transition duration-150 hover:shadow-lg hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary flex flex-col justify-between h-full"
        onClick={() => onSelect(skill)}
      >
        <div>
          <div className="flex items-start gap-3">
            {/* Icon */}
            <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <SkillIconRenderer icon={skill.icon} />
            </div>

            <div className="flex-1 min-w-0 pr-6">
              {/* Name + trigger badge */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-sm font-semibold leading-tight truncate">{skill.name}</h3>
                {skill.trigger && (
                  <span className="shrink-0 text-3xs px-1.5 py-0.5 rounded font-mono font-bold bg-primary/15 text-primary border border-primary/25">
                    {skill.trigger}
                  </span>
                )}
                {skill.author === 'Curated' && (
                  <span className="shrink-0 text-3xs px-1.5 py-0.5 rounded-full bg-surface2 text-muted-foreground font-medium">
                    Curated
                  </span>
                )}
              </div>
              {/* Description */}
              <p className="text-2xs text-muted-foreground leading-relaxed line-clamp-2 mt-1">
                {skill.description}
              </p>
            </div>
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-1 mt-3 ml-[52px]">
            {skill.tags.map((tag) => (
              <span key={tag} className="text-3xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium font-mono">
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-3.5 pt-2 border-t border-border/50 ml-[52px]">
          <span className="text-3xs text-muted-foreground">
            {skill.sourceRepo ? skill.sourceRepo.split('/')[0] : (skill.author || 'Custom')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUseInChat(skill);
              }}
              className="text-3xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 transition-colors"
            >
              <Terminal className="size-2.5" />
              <span>Use in Chat</span>
            </button>
            <span className="text-3xs text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-0.5">
              Details <ArrowRight className="size-2.5" />
            </span>
          </div>
        </div>
      </button>

      <RowActions
        label={`Actions for ${skill.name}`}
        className="absolute right-2 top-2"
        items={[
          { label: 'Use in Chat', icon: Terminal, onSelect: () => onUseInChat(skill) },
          { label: 'View details', icon: ArrowRight, onSelect: () => onSelect(skill) },
          ...(skill.trigger
            ? [
                {
                  label: `Copy trigger (${skill.trigger})`,
                  icon: Copy,
                  onSelect: () => {
                    navigator.clipboard.writeText(skill.trigger!);
                    toast.success(`Copied ${skill.trigger}`);
                  },
                },
              ]
            : []),
          ...(ghUrl
            ? [
                {
                  label: 'Copy source link',
                  icon: Copy,
                  onSelect: () => {
                    navigator.clipboard.writeText(ghUrl);
                    toast.success('Link copied');
                  },
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill Detail Modal
// ---------------------------------------------------------------------------

function SkillDetail({
  skill,
  onClose,
  onUseInChat,
}: {
  skill: Skill;
  onClose: () => void;
  onUseInChat: (s: Skill) => void;
}) {
  const isCustom = skill.sourceType === 'workspace_file';
  const ghUrl = skill.sourceRepo
    ? `https://github.com/${skill.sourceRepo}/tree/main/${skill.sourcePath}`
    : '';
  const { agents, refreshWorkspace } = useWorkspace();
  const [installing, setInstalling] = useState<string | null>(null);
  const [confirmUninstallAgent, setConfirmUninstallAgent] = useState<string | null>(null);

  const handleInstall = useCallback(
    async (agentName: string) => {
      setInstalling(agentName);
      try {
        await workspaceApi.installSkill(agentName, skill.id);
        await refreshWorkspace();
        toast.success(`Installing ${skill.name} on @${agentName}…`);
      } catch (e) {
        toast.error(extractErrorMessage(e) || 'Failed to request skill install');
      } finally {
        setInstalling(null);
      }
    },
    [skill, refreshWorkspace],
  );

  const handleUninstall = useCallback(
    async (agentName: string) => {
      setInstalling(agentName);
      try {
        await workspaceApi.uninstallSkill(agentName, skill.id);
        await refreshWorkspace();
        toast.success(`${skill.name} removed from @${agentName}`);
      } catch {
        toast.error('Failed to remove skill');
      } finally {
        setInstalling(null);
      }
    },
    [skill, refreshWorkspace],
  );

  const STALE_INSTALL_MS = 2 * 60 * 1000;
  const getSkillState = (agentName: string): 'installing' | 'installed' | 'failed' | null => {
    const agent = agents.find((a) => a.agentName === agentName);
    const skills = (agent?.enabledSkills as Record<string, unknown>) || {};
    const statusMap = (skills.skill_status as Record<string, { state?: string; updated_at?: number }>) || {};
    const entry = statusMap[skill.id];
    if (entry?.state === 'installing') {
      if (entry.updated_at && Date.now() - entry.updated_at > STALE_INSTALL_MS) {
        return 'failed';
      }
      return 'installing';
    }
    if (entry?.state === 'failed' || entry?.state === 'installed') {
      return entry.state;
    }
    const installed = (skills.installed as string[]) || [];
    return installed.includes(skill.id) ? 'installed' : null;
  };

  const onlineAgents = agents.filter((a) => a.status === 'online');

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 max-w-none w-[calc(100%-2rem)] md:w-[540px] max-h-[85vh] flex flex-col overflow-hidden"
      >
        <VisuallyHidden.Root asChild>
          <DialogTitle>{skill.name}</DialogTitle>
        </VisuallyHidden.Root>

        {/* Modal Header */}
        <div className="px-5 pt-5 pb-3 border-b border-border">
          <div className="flex items-start gap-3">
            <div className="size-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <SkillIconRenderer icon={skill.icon} className="size-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold">{skill.name}</h2>
                {skill.trigger && (
                  <span className="text-2xs font-mono font-bold px-2 py-0.5 rounded bg-primary/15 text-primary border border-primary/25">
                    {skill.trigger}
                  </span>
                )}
                {skill.author === 'Curated' && (
                  <span className="text-3xs px-1.5 py-0.5 rounded-full bg-surface2 text-muted-foreground font-medium">
                    Curated
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{skill.description}</p>
              <div className="flex flex-wrap gap-1 mt-2">
                {skill.tags.map((tag) => (
                  <span key={tag} className="text-3xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono font-medium">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Quick Action: Use in Chat */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20">
            <div>
              <div className="text-xs font-semibold text-foreground">Invoke in Chat</div>
              <div className="text-2xs text-muted-foreground mt-0.5">
                Type <code className="font-mono text-primary font-bold">{skill.trigger || `/${skill.id}`}</code> in any thread to trigger this skill.
              </div>
            </div>
            <button
              onClick={() => {
                onUseInChat(skill);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors shrink-0 shadow-sm"
            >
              <Terminal className="size-3.5" />
              <span>Use in Chat</span>
            </button>
          </div>

          {/* Add to Agent Section */}
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
              Agent Installation (Persistent)
            </div>
            {onlineAgents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No online agents. Connect an agent to install skills permanently.</p>
            ) : (
              <div className="space-y-1.5">
                {onlineAgents.map((agent) => {
                  const serverState = getSkillState(agent.agentName);
                  const pending = installing === agent.agentName;
                  const state = pending ? 'installing' : serverState;

                  if (state === 'installed') {
                    return (
                      <div key={agent.agentName} className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                        <AgentAvatar name={agent.agentName} size={20} status={agent.status} showStatus />
                        <span className="flex-1 text-xs font-medium truncate">@{agent.agentName}</span>
                        <button
                          onClick={() => setConfirmUninstallAgent(agent.agentName)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-3xs font-medium bg-status-success/10 text-status-success hover:bg-surface3 hover:text-status-danger transition-colors"
                        >
                          <Check className="size-3" />
                          Installed
                        </button>
                      </div>
                    );
                  }
                  if (state === 'installing') {
                    return (
                      <div key={agent.agentName} className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                        <AgentAvatar name={agent.agentName} size={20} status={agent.status} showStatus />
                        <span className="flex-1 text-xs font-medium truncate">@{agent.agentName}</span>
                        <button disabled className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-3xs font-medium bg-muted text-muted-foreground disabled:opacity-70">
                          <Loader2 className="size-3 animate-spin" />
                          Installing…
                        </button>
                      </div>
                    );
                  }
                  if (state === 'failed') {
                    return (
                      <div key={agent.agentName} className="flex items-center gap-2 rounded-lg bg-background border border-status-danger/30 px-3 py-2">
                        <AgentAvatar name={agent.agentName} size={20} status={agent.status} showStatus />
                        <span className="flex-1 text-xs font-medium truncate">@{agent.agentName}</span>
                        <Hint label="Installation failed — click to retry">
                          <button
                            onClick={() => handleInstall(agent.agentName)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-3xs font-medium bg-status-danger/10 text-status-danger hover:bg-surface30/20 transition-colors"
                          >
                            <AlertCircle className="size-3" />
                            Failed · Retry
                          </button>
                        </Hint>
                      </div>
                    );
                  }
                  return (
                    <div key={agent.agentName} className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2">
                      <AgentAvatar name={agent.agentName} size={20} status={agent.status} showStatus />
                      <span className="flex-1 text-xs font-medium truncate">@{agent.agentName}</span>
                      <button
                        onClick={() => handleInstall(agent.agentName)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-3xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        <Plus className="size-3" />
                        Install
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Skill Instructions & Prompt */}
          {skill.instructions && (
            <div className="rounded-xl border border-border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Skill Prompt & Instructions
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(skill.instructions!);
                    toast.success('Prompt instructions copied');
                  }}
                  className="text-3xs text-primary hover:underline flex items-center gap-1"
                >
                  <Copy className="size-2.5" />
                  <span>Copy</span>
                </button>
              </div>
              <pre className="text-2xs font-mono bg-muted/40 p-2.5 rounded-lg border border-border/60 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto text-muted-foreground">
                {skill.instructions}
              </pre>
            </div>
          )}

          {/* Source / Package Details */}
          {isCustom ? (
            <div className="rounded-xl border border-border p-3 flex items-center justify-between">
              <div>
                <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">Uploaded Package</div>
                <div className="text-xs font-mono font-medium mt-0.5">{skill.filename || `${skill.id}.${skill.packageType || 'md'}`}</div>
              </div>
              <span className="text-3xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono font-bold uppercase">
                {skill.packageType || 'md'}
              </span>
            </div>
          ) : (
            skill.sourceRepo && (
              <div className="rounded-xl border border-border p-3 flex items-center justify-between">
                <div>
                  <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">Source Repository</div>
                  <div className="text-xs font-mono text-primary mt-0.5">
                    {skill.sourceRepo}/{skill.sourcePath}
                  </div>
                </div>
                {ghUrl && (
                  <a
                    href={ghUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    GitHub <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            )
          )}

          {/* Compatibility Chips */}
          <div className="rounded-xl border border-border p-3">
            <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Compatible AI IDEs & Agents
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['Antigravity', 'Claude Code', 'Cursor', 'Codex', 'OpenAgents', 'Gemini CLI'].map((env) => (
                <span key={env} className="text-3xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                  {env}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
          <div className="flex items-center gap-2">
            {skill.trigger && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(skill.trigger!);
                  toast.success(`Copied ${skill.trigger}`);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-muted transition-colors"
              >
                <Copy className="size-3" />
                <span>Copy Trigger</span>
              </button>
            )}
            <button
              onClick={() => {
                onUseInChat(skill);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              <Terminal className="size-3.5" />
              <span>Use in Chat</span>
            </button>
          </div>
        </div>
      </DialogContent>

      <ConfirmDialog
        open={Boolean(confirmUninstallAgent)}
        onOpenChange={(open) => {
          if (!open) setConfirmUninstallAgent(null);
        }}
        title="Uninstall Skill"
        description={`Are you sure you want to uninstall "${skill.name}" from @${confirmUninstallAgent}?`}
        confirmLabel="Uninstall"
        variant="destructive"
        onConfirm={async () => {
          if (confirmUninstallAgent) {
            await handleUninstall(confirmUninstallAgent);
            setConfirmUninstallAgent(null);
          }
        }}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add / Import Skill Dialog
// ---------------------------------------------------------------------------

function AddSkillDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (skill: WorkspaceCustomSkill) => void;
}) {
  const [tab, setTab] = useState<'create' | 'upload' | 'github'>('create');

  // Tab 1: Create
  const [createId, setCreateId] = useState('');
  const [createName, setCreateName] = useState('');
  const [createTrigger, setCreateTrigger] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createPrompt, setCreatePrompt] = useState(
    `# Role & Goal\nYou are a specialized skill agent.\n\n## Instructions\n1. Analyze the context.\n2. Execute structured steps.\n3. Return clean, verified results.`,
  );

  // Tab 2: Upload
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');

  // Tab 3: GitHub
  const [ghUrl, setGhUrl] = useState('');
  const [fetchingGh, setFetchingGh] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setCreateId('');
    setCreateName('');
    setCreateTrigger('');
    setCreateDesc('');
    setCreatePrompt(
      `# Role & Goal\nYou are a specialized skill agent.\n\n## Instructions\n1. Analyze the context.\n2. Execute structured steps.\n3. Return clean, verified results.`,
    );
    setFile(null);
    setUploadId('');
    setUploadName('');
    setUploadDesc('');
    setGhUrl('');
    setFetchingGh(false);
    setError(null);
    setSubmitting(false);
  }, []);

  const onPickFile = (f: File | null) => {
    setError(null);
    setFile(f);
    if (f) {
      setUploadId(deriveSkillId(f.name));
      setUploadName(f.name.replace(/\.[^.]+$/, ''));
    }
  };

  // Submit Tab 1: Create custom skill
  const submitCreate = async () => {
    const rawId = createId.trim();
    if (!rawId) { setError('Skill ID is required.'); return; }
    if (!CUSTOM_SKILL_ID_RE.test(rawId)) {
      setError('Skill ID must contain only letters, numbers, ".", "_" or "-".');
      return;
    }
    const name = createName.trim() || rawId;
    const trigger = createTrigger.trim() ? (createTrigger.trim().startsWith('/') ? createTrigger.trim() : `/${createTrigger.trim()}`) : `/${rawId}`;
    const desc = createDesc.trim();

    const mdContent = `---
name: ${name}
id: ${rawId}
trigger: ${trigger}
description: ${desc}
---

${createPrompt}
`;
    setSubmitting(true);
    setError(null);
    try {
      const blob = new Blob([mdContent], { type: 'text/markdown' });
      const mdFile = new File([blob], `${rawId}.md`, { type: 'text/markdown' });
      const created = await workspaceApi.uploadCustomSkill(mdFile, {
        id: rawId,
        name,
        description: desc,
      });
      toast.success(`Created skill "${created.name}" (${trigger})`);
      onAdded(created);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Submit Tab 2: Upload file
  const submitUpload = async () => {
    if (!file) { setError('Choose a .md or .zip file to upload.'); return; }
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (ext !== '.md' && ext !== '.zip') { setError('Only .md and .zip packages are supported.'); return; }
    const id = uploadId.trim();
    if (!id || !CUSTOM_SKILL_ID_RE.test(id)) {
      setError('Valid skill ID is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await workspaceApi.uploadCustomSkill(file, {
        id,
        name: uploadName.trim() || id,
        description: uploadDesc.trim(),
      });
      toast.success(`Uploaded skill "${created.name}"`);
      onAdded(created);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Submit Tab 3: GitHub / URL import
  const submitGithub = async () => {
    const raw = ghUrl.trim();
    if (!raw) { setError('Please enter a GitHub repo path or URL.'); return; }

    setFetchingGh(true);
    setError(null);
    try {
      // Resolve URL: support "owner/repo/skills/foo" or full github url
      let directUrl = raw;
      if (!raw.startsWith('http')) {
        directUrl = `https://raw.githubusercontent.com/${raw}/main/SKILL.md`;
      } else if (raw.includes('github.com') && !raw.includes('raw.githubusercontent.com')) {
        directUrl = raw
          .replace('github.com', 'raw.githubusercontent.com')
          .replace('/tree/', '/')
          .replace('/blob/', '/');
        if (!directUrl.endsWith('.md')) {
          directUrl = `${directUrl.replace(/\/+$/, '')}/SKILL.md`;
        }
      }

      const res = await fetch(directUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch from ${directUrl} (Status ${res.status})`);
      }
      const text = await res.text();
      if (!text || text.length < 10) {
        throw new Error('Retrieved file is empty or invalid.');
      }

      // Extract stem or name from url
      const segments = raw.replace(/\/+$/, '').split('/');
      const lastSeg = segments[segments.length - 1].replace(/\.md$/, '') || 'imported-skill';
      const id = deriveSkillId(lastSeg);

      const blob = new Blob([text], { type: 'text/markdown' });
      const mdFile = new File([blob], `${id}.md`, { type: 'text/markdown' });
      const created = await workspaceApi.uploadCustomSkill(mdFile, {
        id,
        name: lastSeg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: `Imported from ${raw}`,
      });
      toast.success(`Successfully imported "${created.name}"`);
      onAdded(created);
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setFetchingGh(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add / Import Skill</DialogTitle>
        </DialogHeader>

        {/* Tab Switcher */}
        <div className="flex border-b border-border gap-4 text-xs font-medium">
          <button
            type="button"
            onClick={() => { setTab('create'); setError(null); }}
            className={cn(
              'pb-2 border-b-2 transition-colors',
              tab === 'create'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Create Prompt
          </button>
          <button
            type="button"
            onClick={() => { setTab('upload'); setError(null); }}
            className={cn(
              'pb-2 border-b-2 transition-colors',
              tab === 'upload'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Upload Package
          </button>
          <button
            type="button"
            onClick={() => { setTab('github'); setError(null); }}
            className={cn(
              'pb-2 border-b-2 transition-colors',
              tab === 'github'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            Import from GitHub / URL
          </button>
        </div>

        {/* Tab 1: Create */}
        {tab === 'create' && (
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-2xs font-medium text-muted-foreground">Skill ID *</label>
                <input
                  type="text"
                  value={createId}
                  onChange={(e) => setCreateId(e.target.value)}
                  placeholder="e.g. api-audit"
                  className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              <div>
                <label className="text-2xs font-medium text-muted-foreground">Slash Trigger</label>
                <input
                  type="text"
                  value={createTrigger}
                  onChange={(e) => setCreateTrigger(e.target.value)}
                  placeholder="/api-audit"
                  className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
            </div>

            <div>
              <label className="text-2xs font-medium text-muted-foreground">Skill Name</label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. REST API Security Audit"
                className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="text-2xs font-medium text-muted-foreground">Description</label>
              <input
                type="text"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Audits REST endpoints for missing auth and injection risks"
                className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="text-2xs font-medium text-muted-foreground">Prompt Instructions (Markdown)</label>
              <textarea
                value={createPrompt}
                onChange={(e) => setCreatePrompt(e.target.value)}
                rows={5}
                className="mt-1 w-full px-3 py-2 text-2xs font-mono rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary resize-none leading-relaxed"
              />
            </div>
          </div>
        )}

        {/* Tab 2: Upload */}
        {tab === 'upload' && (
          <div className="space-y-3 pt-2">
            <div>
              <label className="text-2xs font-medium text-muted-foreground">Skill Package (.md or .zip)</label>
              <label className="mt-1 flex items-center gap-2 rounded-lg border border-dashed border-input px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer">
                <Upload className="size-4 text-muted-foreground shrink-0" />
                <span className="text-xs truncate flex-1">
                  {file ? file.name : 'Choose a .md or .zip file…'}
                </span>
                {file && (
                  <span className="text-3xs text-muted-foreground shrink-0">
                    {(file.size / 1024).toFixed(1)} KB
                  </span>
                )}
                <input
                  type="file"
                  accept=".md,.zip"
                  className="hidden"
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                />
              </label>
              <p className="mt-1 text-3xs text-muted-foreground">
                Single SKILL.md file or .zip containing SKILL.md.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-2xs font-medium text-muted-foreground">Skill ID *</label>
                <input
                  type="text"
                  value={uploadId}
                  onChange={(e) => setUploadId(e.target.value)}
                  placeholder="my-skill"
                  className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              <div>
                <label className="text-2xs font-medium text-muted-foreground">Display Name</label>
                <input
                  type="text"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder="My Skill"
                  className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <label className="text-2xs font-medium text-muted-foreground">Description (optional)</label>
              <textarea
                value={uploadDesc}
                onChange={(e) => setUploadDesc(e.target.value)}
                rows={2}
                placeholder="What does this skill do?"
                className="mt-1 w-full px-3 py-1.5 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
            </div>
          </div>
        )}

        {/* Tab 3: GitHub / URL */}
        {tab === 'github' && (
          <div className="space-y-3 pt-2">
            <div>
              <label className="text-2xs font-medium text-muted-foreground">
                GitHub Repo Path or Raw URL
              </label>
              <input
                type="text"
                value={ghUrl}
                onChange={(e) => setGhUrl(e.target.value)}
                placeholder="e.g. anthropics/skills/skills/frontend-design"
                className="mt-1 w-full px-3 py-2 text-xs rounded-lg bg-muted/50 border border-input focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
              <p className="mt-1 text-3xs text-muted-foreground">
                Directly imports any standard SKILL.md from the open source ecosystem.
              </p>
            </div>

            <div className="space-y-1">
              <span className="text-3xs font-medium text-muted-foreground">Quick Suggestions:</span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  'anthropics/skills/skills/mcp-builder',
                  'anthropics/skills/skills/frontend-design',
                  'anthropics/skills/skills/accessibility-auditor',
                ].map((sug) => (
                  <button
                    key={sug}
                    type="button"
                    onClick={() => setGhUrl(sug)}
                    className="text-3xs font-mono px-2 py-0.5 rounded bg-muted hover:bg-muted/80 text-foreground transition-colors"
                  >
                    {sug.split('/').pop()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-status-danger/30 bg-status-danger/5 px-3 py-2">
            <AlertCircle className="size-3.5 text-status-danger shrink-0 mt-0.5" />
            <p className="text-2xs text-status-danger">{error}</p>
          </div>
        )}

        <DialogFooter className="pt-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={
              tab === 'create'
                ? submitCreate
                : tab === 'upload'
                ? submitUpload
                : submitGithub
            }
            disabled={submitting || fetchingGh}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
          >
            {submitting || fetchingGh ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : tab === 'create' ? (
              <Plus className="size-3.5" />
            ) : (
              <Upload className="size-3.5" />
            )}
            {submitting || fetchingGh ? 'Saving…' : tab === 'create' ? 'Create Skill' : 'Import Skill'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main SkillsView
// ---------------------------------------------------------------------------

export function SkillsView() {
  const { workspace } = useWorkspace();
  const { setViewMode } = useLayout();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [customSkills, setCustomSkills] = useState<Skill[]>([]);
  const [addSkillOpen, setAddSkillOpen] = useState(false);

  // Load custom skills
  const workspaceId = workspace?.workspaceId;
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    workspaceApi
      .getCustomSkills()
      .then((list) => {
        if (!cancelled) setCustomSkills(list.map(customSkillToSkill));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleAdded = useCallback((created: WorkspaceCustomSkill) => {
    const skill = customSkillToSkill(created);
    setCustomSkills((prev) => [skill, ...prev.filter((s) => s.id !== skill.id)]);
    setActiveCategory('custom');
  }, []);

  const catalogSkills = useMemo(() => CURATED_SKILLS.map(curatedToSkill), []);
  const allSkills = useMemo(() => [...catalogSkills, ...customSkills], [catalogSkills, customSkills]);

  const filtered = useMemo(() => {
    let result = allSkills;
    if (activeCategory !== 'all') {
      result = result.filter((s) => s.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.trigger && s.trigger.toLowerCase().includes(q)) ||
          s.tags.some((t) => t.includes(q)),
      );
    }
    return result;
  }, [search, activeCategory, allSkills]);

  const featured = useMemo(() => allSkills.filter((s) => s.featured), [allSkills]);

  const categoryCounts = useMemo(() => {
    const c: Record<string, number> = { all: allSkills.length };
    for (const s of allSkills) c[s.category] = (c[s.category] || 0) + 1;
    return c;
  }, [allSkills]);

  const handleUseInChat = useCallback(
    (skill: Skill) => {
      const trigger = skill.trigger || `/${skill.id}`;
      const text = `${trigger} `;
      try {
        localStorage.setItem('52hz_pending_composer_draft', text);
      } catch {}
      window.dispatchEvent(new CustomEvent('52hz_apply_composer_draft', { detail: text }));
      setViewMode('threads');
    },
    [setViewMode],
  );

  return (
    <div className="h-full flex flex-col">
      {/* Title bar */}
      <div className="app-header ps-5">
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <Hint label="Back to chats">
            <button
              type="button"
              onClick={() => setViewMode('threads')}
              className="flex items-center gap-1 px-2 py-1 -ml-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
            >
              <ArrowLeft className="size-3.5" />
              <span>Back</span>
            </button>
          </Hint>
          <div className="h-3.5 w-px bg-border/60" />
          <ScreenMark icon={Sparkles} />
          <ScreenTitle>Skill Hub</ScreenTitle>
          <span className="text-xs text-muted-foreground">{allSkills.length} skills</span>
          <button
            onClick={() => setAddSkillOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-2xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus className="size-3.5" />
            <span>Add / Import Skill</span>
          </button>
        </div>
      </div>

      {/* Toolbar: search + category filters */}
      <div className="shrink-0 px-5 py-2.5 border-b border-border space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search skills by name, trigger (/review, /plan), description..."
            data-view-search
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-muted/50 border border-input placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Category tabs */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-2xs font-medium transition-colors',
                activeCategory === cat.id
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'hover:bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              <cat.icon className="size-3.5" />
              <span>{cat.label}</span>
              {categoryCounts[cat.id] !== undefined && (
                <span className="text-3xs opacity-60 font-mono">({categoryCounts[cat.id]})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Skills Content Grid */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Search className="size-8 opacity-30" />
            <p className="text-sm">No skills match your search</p>
            <button
              onClick={() => {
                setSearch('');
                setActiveCategory('all');
              }}
              className="text-xs text-primary hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* Featured Section */}
            {activeCategory === 'all' && !search && featured.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2.5">
                  <Star className="size-3.5 text-amber-500 fill-amber-500" />
                  <h3 className="text-xs font-semibold text-foreground">Featured Core Skills</h3>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                  {featured.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      onSelect={setSelectedSkill}
                      onUseInChat={handleUseInChat}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* All / Filtered Grid */}
            <div>
              {activeCategory === 'all' && !search && (
                <div className="flex items-center gap-2 mb-2.5">
                  <h3 className="text-xs font-semibold text-muted-foreground">All Available Skills</h3>
                  <span className="text-3xs text-muted-foreground font-mono">({filtered.length})</span>
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {filtered.map((skill) => (
                  <div key={skill.id} className="skip-offscreen-card">
                    <SkillCard
                      skill={skill}
                      onSelect={setSelectedSkill}
                      onUseInChat={handleUseInChat}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedSkill && (
        <SkillDetail
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onUseInChat={handleUseInChat}
        />
      )}

      <AddSkillDialog
        open={addSkillOpen}
        onOpenChange={setAddSkillOpen}
        onAdded={handleAdded}
      />
    </div>
  );
}
