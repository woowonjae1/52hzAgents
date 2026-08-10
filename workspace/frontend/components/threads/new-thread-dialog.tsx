'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { History, Check, Minus, Folder, MessageCircle } from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';

/**
 * wwj (the local agent connector daemon) runs on the actual desktop and can
 * show a genuine native OS folder dialog — no in-page directory browser to
 * build or maintain. Only works when wwj runs on the same machine as this
 * browser tab, which is the only case where "pick a local folder" makes
 * sense in the first place (see the comment on `openFolder` state below).
 */
const WWJ_BROWSE_URL = process.env.NEXT_PUBLIC_WWJ_BROWSE_URL || 'http://127.0.0.1:47893';

interface NewThreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: WorkspaceAgent[];
  sessions?: WorkspaceSession[];
  /** Pre-checked agents when the dialog opens — normally the current thread's members. */
  defaultParticipants?: string[];
  onCreateThread: (opts: { participants: string[]; resumeFrom?: string; workingDir?: string }) => void;
}

export function NewThreadDialog({ open, onOpenChange, agents, sessions, defaultParticipants, onCreateThread }: NewThreadDialogProps) {
  // Only show online agents in the picker
  const onlineAgents = agents.filter((a) => a.status === 'online');
  const offlineAgentCount = agents.length - onlineAgents.length;
  const agentNames = onlineAgents.map((a) => a.agentName);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resumeFrom, setResumeFrom] = useState<string>('');
  // "Open Folder" is a per-thread choice, not a per-agent one — see the
  // architecture note in new-thread-dialog-host.tsx / workspace-context.tsx
  // createSession().
  const [openFolder, setOpenFolder] = useState(false);
  const [workingDir, setWorkingDir] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const handleBrowse = async () => {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const res = await fetch(`${WWJ_BROWSE_URL}/browse-folder`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: { path: string | null } = await res.json();
      if (data.path) setWorkingDir(data.path);
    } catch (e) {
      setBrowseError(
        e instanceof Error
          ? `Can't reach wwj on this machine (${e.message}). Make sure "wwj up" is running, or type the path below.`
          : 'Failed to open the folder dialog.'
      );
    } finally {
      setBrowsing(false);
    }
  };

  const isAllSelected = onlineAgents.length > 0 && selected.size === onlineAgents.length;
  const isPartiallySelected = selected.size > 0 && selected.size < onlineAgents.length;

  const toggleAll = () => {
    setSelected(isAllSelected ? new Set() : new Set(agentNames));
  };

  // Reset state when dialog opens. Prefer the caller's default (the current
  // thread's members), then fall back to pre-selecting the only online agent, so
  // both the single-agent and "same team again" cases are a one-click start.
  useEffect(() => {
    if (open) {
      const preset = (defaultParticipants || []).filter((name) => agentNames.includes(name));
      if (preset.length > 0) {
        setSelected(new Set(preset));
      } else {
        setSelected(onlineAgents.length === 1 ? new Set([onlineAgents[0].agentName]) : new Set());
      }
      setResumeFrom('');
      setOpenFolder(false);
      setWorkingDir('');
      setBrowseError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAgent = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleCreate = () => {
    // No leader is assigned at creation — the default "dynamic" mode doesn't
    // need one. A leader can be set later from the thread's agent menu (and is
    // only required by "master" orchestration mode).
    const participants = agentNames.filter((n) => selected.has(n));
    const trimmedDir = workingDir.trim();
    onCreateThread({
      participants,
      resumeFrom: resumeFrom || undefined,
      workingDir: openFolder && trimmedDir ? trimmedDir : undefined,
    });
    onOpenChange(false);
  };

  const canCreate = selected.size > 0 && (!openFolder || workingDir.trim().length > 0);

  // Filter sessions that have messages (lastEventAt != null) for resume picker
  const resumableSessions = (sessions || []).filter(
    (s) => s.status === 'active' && s.lastEventAt != null
  );

  // Session resume is a Claude Code feature. Match on the reported agent type
  // ("claude" is the catalog name) so renaming an agent no longer silently hides
  // the resume picker. The name is only a fallback for agents that joined
  // without reporting a type.
  const hasClaudeAgent = onlineAgents.some((agent) => {
    if (!selected.has(agent.agentName)) return false;
    const type = (agent.agentType || '').toLowerCase();
    return type ? type.startsWith('claude') : /claude/i.test(agent.agentName);
  });

  const multipleAgents = onlineAgents.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>New Thread</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {multipleAgents
            ? 'Pick which agents join this conversation.'
            : 'Start a new conversation with your agent.'}
        </DialogDescription>

        {/* Chat vs Open Folder — a per-thread choice. See the state comment above. */}
        <div className="mt-3 flex gap-1.5 rounded-lg bg-surface1 p-1">
          <button
            type="button"
            onClick={() => setOpenFolder(false)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              !openFolder ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <MessageCircle className="size-3.5" />
            Chat
          </button>
          <button
            type="button"
            onClick={() => setOpenFolder(true)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              openFolder ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Folder className="size-3.5" />
            Open Folder
          </button>
        </div>
        {openFolder && (
          <div className="mt-2">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="D:\code\my-project"
                className="flex-1 text-sm rounded-lg border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Button variant="outline" size="sm" onClick={handleBrowse} disabled={browsing}>
                {browsing ? 'Waiting…' : 'Browse…'}
              </Button>
            </div>
            <p className="mt-1 px-0.5 text-[11px] text-muted-foreground/70">
              Local absolute path on the machine running the agent. Agents in this thread read/edit files there.
            </p>
            {browseError && (
              <p className="mt-1 px-0.5 text-[11px] text-status-danger">{browseError}</p>
            )}
          </div>
        )}

        {/* Select All Control */}
        {onlineAgents.length > 0 && (
          <button
            type="button"
            className="mt-3 flex w-full items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer text-left transition-colors hover:bg-surface1"
            onClick={toggleAll}
          >
            <div className={cn(
              'size-4 rounded shrink-0 flex items-center justify-center border transition-colors',
              isAllSelected || isPartiallySelected
                ? 'bg-foreground-extra-muted border-blue-500 text-white'
                : 'border-border-accent'
            )}>
              {isAllSelected && <Check className="size-3" strokeWidth={3} />}
              {isPartiallySelected && <Minus className="size-3" strokeWidth={3} />}
            </div>
            <span className="text-sm font-medium">
              {isAllSelected
                ? 'All agents selected'
                : isPartiallySelected
                  ? `${selected.size} of ${onlineAgents.length} agents selected`
                  : 'Select all agents'}
            </span>
          </button>
        )}
        {offlineAgentCount > 0 && (
          <p className={cn(
            'px-3 text-[11px] text-muted-foreground/70',
            onlineAgents.length > 0 ? 'mt-1' : 'mt-3'
          )}>
            {offlineAgentCount} offline {offlineAgentCount === 1 ? 'agent' : 'agents'} not included
          </p>
        )}

        {/* Agent list */}
        <div className={cn(
          'space-y-1.5 max-h-64 overflow-y-auto',
          onlineAgents.length === 0 ? 'mt-3' : 'mt-1.5'
        )}>
          {onlineAgents.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No agents are currently online.</p>
          )}
          {onlineAgents.map((agent) => {
            const isSelected = selected.has(agent.agentName);

            return (
              <div
                key={agent.agentName}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-all border',
                  isSelected
                    ? 'bg-surface1/80 border-border'
                    : 'border-transparent opacity-50 hover:opacity-75 hover:bg-surface1'
                )}
                onClick={() => toggleAgent(agent.agentName)}
              >
                {/* Checkbox */}
                <div className={cn(
                  'size-4 rounded shrink-0 flex items-center justify-center border transition-colors',
                  isSelected
                    ? 'bg-foreground-extra-muted border-blue-500 text-white'
                    : 'border-border-accent'
                )}>
                  {isSelected && <Check className="size-3" strokeWidth={3} />}
                </div>

                {/* Avatar */}
                <AgentAvatar name={agent.agentName} size={24} />

                {/* Name */}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate">{agent.agentName}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Resume from past session — show when there are resumable sessions */}
        {hasClaudeAgent && resumableSessions.length > 0 && (
          <div className="mt-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
              <History className="size-3" />
              Resume from past session
            </label>
            <select
              value={resumeFrom}
              onChange={(e) => setResumeFrom(e.target.value)}
              className="w-full text-sm rounded-lg border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">New conversation (no context)</option>
              {resumableSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title || s.sessionId}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="border border-border/80 text-foreground hover:bg-surface2 hover:text-foreground font-medium"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!canCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
          >
            {resumeFrom ? 'Resume Thread' : 'Start Thread'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
