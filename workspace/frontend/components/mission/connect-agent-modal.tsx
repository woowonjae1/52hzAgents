'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/lib/workspace-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Terminal, Copy, Check, Play, Zap, Loader2, Globe, ShieldCheck, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { useAgentCatalog } from '@/lib/agent-catalog';

import { getApiBaseUrl } from '@/lib/config';

interface ConnectAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand off to the "add another agent" form — `custom` needs configuring, not launching. */
  onConfigureCustom?: () => void;
}

export function ConnectAgentModal({ open, onOpenChange, onConfigureCustom }: ConnectAgentModalProps) {
  const { workspaceId, agents } = useWorkspace();
  // Only fetched while the dialog is open — this is a modal, not a mounted view.
  const { catalog } = useAgentCatalog(open);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);

  const pairingCommand = `node bin/agent-connector.js up --workspace=${workspaceId || 'current'} --server=${getApiBaseUrl()}`;

  const copyCommand = () => {
    navigator.clipboard.writeText(pairingCommand);
    setCopiedCmd(true);
    toast.success('Pairing command copied to clipboard');
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  // launchAgent, not sendAgentControl: a control event is delivered by the
  // agent's own poller, so it only ever reached agents that were already
  // running — exactly not the case for a card the user is clicking Connect on.
  const handleLaunchAgent = async (agentName: string) => {
    // `custom` names no runtime — connecting it directly would start whatever
    // the generic type happens to resolve to. Configure it instead.
    if (agentName.toLowerCase() === 'custom') {
      onConfigureCustom?.();
      return;
    }
    setStartingAgent(agentName);
    try {
      await workspaceApi.launchAgent(agentName);
      toast.success(`Launching ${agentName}. Agent terminal window opened.`);
    } catch (e) {
      toast.error(`Could not launch ${agentName}: ${e instanceof Error ? e.message : 'unknown error'}`);
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
              <h3 className="text-xs font-semibold text-foreground-muted flex items-center gap-1.5">
                <Play className="size-3.5" />
                Local agent runtimes
              </h3>
              <span className="text-[10px] text-foreground-extra-muted">One-click launch</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[340px] overflow-y-auto pr-1">
              {(() => {
                const CATALOG_TYPES = catalog.map((entry) => ({
                  name: entry.name,
                  label: entry.label,
                  desc: entry.description,
                }));

                const existingNames = new Set(agents.map((a) => a.agentName.toLowerCase()));

                return CATALOG_TYPES.map((cat) => {
                  const matchedAgent = agents.find(
                    (a) => a.agentName.toLowerCase() === cat.name || a.agentType?.toLowerCase() === cat.name
                  );
                  const isOnline = matchedAgent?.status === 'online';
                  const isStarting = startingAgent === cat.name;

                  return (
                    <div
                      key={cat.name}
                      className={cn(
                        'p-3 rounded-xl border flex items-center justify-between transition-colors',
                        isOnline
                          ? 'bg-status-success/5 border-status-success/30'
                          : 'bg-card border-border hover:border-border-accent',
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <AgentAvatar name={cat.name} agentType={cat.name} size={32} status={matchedAgent?.status || 'offline'} showStatus />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-foreground truncate">{cat.label}</p>
                          <p className="text-[10px] text-foreground-extra-muted truncate">{cat.desc}</p>
                        </div>
                      </div>

                      <Button
                        size="sm"
                        variant={isOnline ? 'outline' : 'primary'}
                        disabled={isStarting}
                        onClick={() => handleLaunchAgent(cat.name)}
                        className={cn(
                          'h-8 px-3 text-[11px] font-semibold gap-1.5 shrink-0 cursor-pointer',
                          isOnline && 'border-status-success/40 text-status-success hover:bg-status-success/10',
                        )}
                      >
                        {isStarting ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : isOnline ? (
                          <>
                            <ShieldCheck className="size-3" />
                            <span>Running</span>
                          </>
                        ) : cat.name === 'custom' ? (
                          <>
                            <Settings2 className="size-3" />
                            <span>Configure</span>
                          </>
                        ) : (
                          <>
                            <Zap className="size-3" />
                            <span>Connect</span>
                          </>
                        )}
                      </Button>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Section 2: Remote Pairing Command */}
          <div className="space-y-2.5 pt-2 border-t border-border/80">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground-muted flex items-center gap-1.5">
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
                {copiedCmd ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
                <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
