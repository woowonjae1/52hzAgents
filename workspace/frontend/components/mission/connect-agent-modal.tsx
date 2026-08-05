'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/lib/workspace-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Terminal, Copy, Check, Play, Zap, Loader2, Globe, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

import { getApiBaseUrl } from '@/lib/config';

interface ConnectAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectAgentModal({ open, onOpenChange }: ConnectAgentModalProps) {
  const { workspaceId, agents } = useWorkspace();
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);

  const pairingCommand = `node bin/agent-connector.js up --workspace=${workspaceId || 'current'} --server=${getApiBaseUrl()}`;

  const copyCommand = () => {
    navigator.clipboard.writeText(pairingCommand);
    setCopiedCmd(true);
    toast.success('Pairing command copied to clipboard');
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleLaunchAgent = async (agentName: string) => {
    setStartingAgent(agentName);
    try {
      await workspaceApi.sendAgentControl(agentName, 'start', {});
      toast.success(`Launch signal sent to ${agentName}. Daemon is connecting…`);
    } catch {
      toast.info(`Sent reconnect signal to ${agentName}. Ensure the launcher daemon is running.`);
    } finally {
      setTimeout(() => setStartingAgent(null), 1500);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-surface2 flex items-center justify-center text-foreground-muted">
              <Zap className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-semibold">Connect an agent</DialogTitle>
              <DialogDescription className="text-xs">
                Launch a local agent runtime, or pair a remote server into this workspace.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Section 1: One-Click Local Agent Launcher */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider flex items-center gap-1.5">
                <Play className="size-3.5" />
                Local agent runtimes
              </h3>
              <span className="text-[10px] text-foreground-extra-muted">One-click launch</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {agents.map((agent) => {
                const isOnline = agent.status === 'online';
                const isStarting = startingAgent === agent.agentName;

                return (
                  <div
                    key={agent.agentName}
                    className={cn(
                      'p-3 rounded-xl border flex items-center justify-between transition-colors',
                      isOnline
                        ? 'bg-emerald-500/5 border-emerald-500/30'
                        : 'bg-card border-border hover:border-border-accent',
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <AgentAvatar name={agent.agentName} size={32} status={agent.status} showStatus />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate">{agent.agentName}</p>
                        <p className="text-[10px] text-foreground-extra-muted uppercase tracking-wider">
                          {agent.agentType || 'Worker'}
                        </p>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant={isOnline ? 'outline' : 'primary'}
                      disabled={isStarting}
                      onClick={() => handleLaunchAgent(agent.agentName)}
                      className={cn(
                        'h-8 px-3 text-[11px] font-semibold gap-1.5 shrink-0',
                        isOnline && 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10',
                      )}
                    >
                      {isStarting ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : isOnline ? (
                        <>
                          <ShieldCheck className="size-3" />
                          <span>Running</span>
                        </>
                      ) : (
                        <>
                          <Zap className="size-3" />
                          <span>Launch</span>
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: Remote Pairing Command */}
          <div className="space-y-2.5 pt-2 border-t border-border/80">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider flex items-center gap-1.5">
                <Globe className="size-3.5" />
                Pair a remote server
              </h3>
              <span className="text-[10px] text-foreground-extra-muted">Any machine</span>
            </div>

            <p className="text-[11px] text-foreground-muted leading-relaxed">
              Run this command on any remote server, dev container, or laptop to pair its agents into this workspace:
            </p>

            <div className="relative group rounded-xl border border-border bg-surface1/60 p-3 font-mono text-xs text-foreground-muted flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                <Terminal className="size-4 text-foreground-extra-muted shrink-0" />
                <code className="truncate">{pairingCommand}</code>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={copyCommand}
                className="h-7 px-2.5 text-xs shrink-0 gap-1.5"
              >
                {copiedCmd ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
