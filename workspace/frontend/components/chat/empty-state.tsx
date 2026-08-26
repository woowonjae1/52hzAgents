'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Rocket, Copy, Check, Key, Cloud, Loader2, Plug } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { capture } from '@/lib/analytics';
import { useLayout } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { ProjectFolderPicker, rememberWorkingDir } from './project-folder-picker';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/config';

export function EmptyState() {
  const { agents, token, workspaceId, createSession, setCurrentSessionId } = useWorkspace();
  const { setViewMode } = useLayout();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onlineAgents = agents.filter((a) => a.status === 'online');
  const hasAgents = onlineAgents.length > 0;

  const [tokenCopied, setTokenCopied] = useState(false);
  const [workingDir, setWorkingDir] = useState('');
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);

  // Pre-select the first online agent if only one is connected
  useEffect(() => {
    if (onlineAgents.length === 1) {
      setParticipants((prev) => (prev.size === 0 ? new Set([onlineAgents[0].agentName]) : prev));
    }
  }, [onlineAgents.length]);

  const onboardingTracked = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (onboardingTracked.current) return;
      onboardingTracked.current = true;
      capture('workspace_onboarding_viewed');
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  const connectCommand = `node bin/agent-connector.js up --workspace=${workspaceId || 'current'} --server=${getApiBaseUrl()}`;

  const handleCopyToken = () => {
    if (!token) return;
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const toggleParticipant = (name: string) => {
    setParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleStartChat = async () => {
    if (onlineAgents.length === 0) {
      toast.error('No agents online — connect one first');
      setViewMode('mission');
      return;
    }
    if (participants.size === 0) {
      toast.error('Select at least one connected agent');
      return;
    }
    setStarting(true);
    const dir = workingDir.trim();
    try {
      const session = await createSession({
        participants: Array.from(participants),
        workingDir: dir || undefined,
      });
      rememberWorkingDir(dir);
      if (session?.sessionId) {
        setCurrentSessionId(session.sessionId);
        setViewMode('threads');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the conversation');
    } finally {
      setStarting(false);
    }
  };

  const agentPicker = (
    <div className="flex flex-wrap gap-2">
      {onlineAgents.map((agent) => {
        const isSelected = participants.has(agent.agentName);
        return (
          <button
            key={agent.agentName}
            onClick={() => toggleParticipant(agent.agentName)}
            className={cn(
              'flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-semibold transition-all cursor-pointer shadow-2xs',
              isSelected
                ? 'border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30 shadow-xs'
                : 'border-border/70 bg-surface2/60 text-muted-foreground hover:text-foreground hover:bg-surface2'
            )}
          >
            <AgentAvatar name={agent.agentName} size={20} />
            <span>@{agent.agentName}</span>
            {isSelected && <Check className="size-3 text-blue-500" strokeWidth={2.5} />}
          </button>
        );
      })}
    </div>
  );

  const startButton = (
    <button
      disabled={starting || (hasAgents && participants.size === 0)}
      onClick={handleStartChat}
      className={cn(
        'w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-xs transition-all cursor-pointer shadow-md',
        !hasAgents || participants.size === 0
          ? 'bg-surface3 text-muted-foreground opacity-50 cursor-not-allowed'
          : 'bg-gradient-to-tr from-blue-600 to-indigo-600 text-white hover:opacity-95 hover:shadow-lg hover:shadow-blue-500/25 hover:scale-[1.01] active:scale-[0.99]'
      )}
    >
      {starting ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
      <span>{!hasAgents ? 'Connect an agent to start' : 'Start Workspace Channel'}</span>
      {participants.size > 0 && <span className="opacity-80">({participants.size})</span>}
    </button>
  );

  return (
    <div className="h-full flex flex-col items-center justify-center bg-surface0 overflow-y-auto p-6">
      {/*
        Was `.glass-panel` + `shadow-xl` — a frosted, 40px-blurred, drop-shadowed
        card. Both were wasted here: this panel is not floating over anything,
        it IS the content of an otherwise empty pane, so there is nothing behind
        it to blur and nothing for it to cast onto. A plain raised surface with
        one hairline reads as more solid, not less.
      */}
      <div className="w-full max-w-md rounded-xl border border-border bg-surface1 p-6 sm:p-8 space-y-6">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">Launch Workspace Channel</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Pick a project folder and select the agents to collaborate with.
          </p>
        </div>

        <div>
          <h3 className="text-2xs font-medium text-foreground-extra-muted mb-1.5">Project folder (optional)</h3>
          <ProjectFolderPicker
            value={workingDir}
            onChange={setWorkingDir}
            helperText="Leave empty for a plain chat with no filesystem access."
          />
        </div>

        <div>
          <h3 className="text-2xs font-medium text-foreground-extra-muted mb-2">Connected agents</h3>
          {hasAgents ? (
            agentPicker
          ) : (
            <p className="text-xs text-muted-foreground italic">No agents online — connect one from the Agents page.</p>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-1">
          {startButton}
          <div className="flex items-center justify-between text-2xs pt-1">
            <button
              onClick={() => setViewMode('mission')}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground font-medium transition-colors cursor-pointer"
            >
              <Plug className="size-3.5 opacity-70" />
              Connect a new agent
            </button>
            <button
              onClick={() => setViewMode('mission')}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground font-medium transition-colors cursor-pointer"
            >
              <Cloud className="size-3.5 opacity-70" />
              Try Cloud Agents
            </button>
          </div>

          {/* Manual pairing command */}
          <div className="w-full bg-surface1/60 border border-border/80 rounded-xl p-3 mt-3 text-left">
            <div className="text-2xs text-foreground-extra-muted font-mono mb-1 flex items-center justify-between">
              <span>Or connect from the command line:</span>
              <button
                className="flex items-center gap-1 text-3xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
                onClick={() => {
                  copyToClipboard(connectCommand);
                  toast.success('Pairing command copied');
                }}
              >
                {isCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                <span>{isCopied ? 'Copied' : 'Copy command'}</span>
              </button>
            </div>
            <code className="text-foreground-muted text-3xs font-mono block truncate select-all">
              {connectCommand}
            </code>
          </div>

          {/* Workspace Token info */}
          {token && (
            <div className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border/60 bg-surface1/30 text-xs font-medium text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Key className="size-3.5" />
                <span>Workspace Token</span>
              </div>
              <button
                onClick={handleCopyToken}
                className="flex items-center gap-1 hover:text-foreground font-mono transition-colors"
              >
                <span className="font-mono text-2xs">
                  {token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token}
                </span>
                {tokenCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
