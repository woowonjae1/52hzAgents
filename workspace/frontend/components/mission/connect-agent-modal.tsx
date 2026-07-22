'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/lib/workspace-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Terminal, Copy, Check, Play, Zap, Radio, Globe, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';

interface ConnectAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectAgentModal({ open, onOpenChange }: ConnectAgentModalProps) {
  const { workspaceId, agents } = useWorkspace();
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);

  const pairingCommand = `node bin/agent-connector.js up --workspace=${workspaceId || 'current'} --server=http://localhost:8000`;

  const copyCommand = () => {
    navigator.clipboard.writeText(pairingCommand);
    setCopiedCmd(true);
    toast.success('Pairing command copied to clipboard!');
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleLaunchAgent = async (agentName: string) => {
    setStartingAgent(agentName);
    try {
      // Send a control event or agent runtime start signal
      await workspaceApi.sendAgentControl(agentName, 'start', {});
      toast.success(`Launch signal sent to ${agentName}! Daemon is connecting...`);
    } catch {
      toast.info(`Sent reconnect signal to ${agentName}. Ensure launcher daemon is running.`);
    } finally {
      setTimeout(() => setStartingAgent(null), 1500);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-zinc-950 border-zinc-800 text-zinc-100 p-6 shadow-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
              <Zap className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold text-zinc-50">Agent Launcher & Remote Pairing</DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                Launch local agent runtimes or pair distributed remote servers into your 52Hz Sonar Network.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Section 1: One-Click Local Agent Launcher */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Play className="size-3.5 text-emerald-400" />
                Local Agent Runtime Launcher
              </h3>
              <span className="text-[10px] text-zinc-500">1-Click Daemon Activation</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {agents.map((agent) => {
                const isOnline = agent.status === 'online';
                const isStarting = startingAgent === agent.agentName;

                return (
                  <div
                    key={agent.agentName}
                    className={cn(
                      'p-3 rounded-xl border flex items-center justify-between transition-all duration-200',
                      isOnline
                        ? 'bg-zinc-900/60 border-emerald-500/30'
                        : 'bg-zinc-900/30 border-zinc-800 hover:border-zinc-700'
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <AgentAvatar name={agent.agentName} size={32} status={agent.status} showStatus />
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-zinc-100 truncate">{agent.agentName}</p>
                        <p className="text-[10px] text-zinc-400 uppercase tracking-wider font-mono">
                          {agent.agentType || 'Worker'}
                        </p>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant={isOnline ? 'outline' : 'default'}
                      disabled={isStarting}
                      onClick={() => handleLaunchAgent(agent.agentName)}
                      className={cn(
                        'h-8 px-3 text-[11px] font-semibold gap-1.5 shrink-0',
                        isOnline
                          ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                          : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-xs'
                      )}
                    >
                      {isStarting ? (
                        <Radio className="size-3 animate-spin text-cyan-200" />
                      ) : isOnline ? (
                        <>
                          <ShieldCheck className="size-3 text-emerald-400" />
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

          {/* Section 2: Distributed Remote Pairing Command */}
          <div className="space-y-2.5 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                <Globe className="size-3.5 text-cyan-400" />
                Distributed Remote Agent Pairing Command
              </h3>
              <span className="text-[10px] text-cyan-400 font-mono">Multi-Env Ready</span>
            </div>

            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Run this command in terminal on any remote GPU server, dev container, or laptop to pair its Agents into this workspace:
            </p>

            <div className="relative group rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-cyan-300 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                <Terminal className="size-4 text-cyan-500 shrink-0" />
                <code className="truncate">{pairingCommand}</code>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={copyCommand}
                className="h-7 px-2.5 text-xs text-zinc-300 hover:text-white hover:bg-zinc-800 shrink-0 gap-1.5"
              >
                {copiedCmd ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
