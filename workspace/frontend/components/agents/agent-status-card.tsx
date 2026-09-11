'use client';

import { useState } from 'react';
import { MoreHorizontal, Crown, UserMinus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SectionHeader } from '@/components/sessions/section-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { toast } from 'sonner';
import type { WorkspaceAgent } from '@/lib/types';

interface AgentStatusCardProps {
  agents: WorkspaceAgent[];
}

export function AgentStatusCard({ agents }: AgentStatusCardProps) {
  const { refreshAgents } = useWorkspace();
  const [busy, setBusy] = useState(false);
  /*
   * `window.confirm` was doing this job. Three reasons it cannot stay: it
   * blocks the JS thread (the SSE stream and every heartbeat stall behind the
   * OS dialog), it renders in the browser chrome's font on a white plate with
   * no relation to this app, and in the Electron shell it appears detached
   * from the window it belongs to. ConfirmDialog is the workspace's own, and
   * every other destructive path already uses it.
   */
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  const handlePromote = async (agentName: string) => {
    setBusy(true);
    try {
      await workspaceApi.updateAgentRole(agentName, 'master');
      toast.success(`${agentName} promoted to master`);
      await refreshAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update role');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (agentName: string) => {
    setBusy(true);
    try {
      await workspaceApi.removeAgent(agentName);
      toast.success(`${agentName} removed`);
      await refreshAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove agent');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(v) => { if (!v) setPendingRemoval(null); }}
        title="Remove agent from workspace?"
        targetName={pendingRemoval ?? undefined}
        description="loses access to this workspace's channels, files and tasks. Reconnect it later with its token."
        confirmLabel="Remove"
        isLoading={busy}
        onConfirm={async () => {
          const name = pendingRemoval;
          if (!name) return;
          await handleRemove(name);
          setPendingRemoval(null);
        }}
      />
      <SectionHeader label="Agents" />
      <div className="space-y-1.5">
        {agents.map((agent) => {
          const isOnline = agent.status === 'online';
          const isMaster = agent.role === 'master';

          return (
            <div
              key={agent.agentName}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-md group"
            >
              <AgentAvatar name={agent.agentName} size={28} status={agent.status} showStatus />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{agent.agentName}</p>
                <p className="text-xs text-muted-foreground">
                  {agent.agentType && <span className="capitalize">{agent.agentType} · </span>}
                  {isOnline
                    ? 'Online'
                    : agent.lastHeartbeatAt
                      ? `Last seen ${timeAgo(agent.lastHeartbeatAt)}`
                      : 'Offline'}
                </p>
              </div>
              <span className={cn(
                'text-3xs  px-1.5 py-0.5 rounded-full font-medium',
                isMaster
                  ? 'bg-surface3 text-foreground'
                  : 'text-muted-foreground'
              )}>
                {agent.role}
              </span>

              {/* Management dropdown — only show when multiple agents */}
              {agents.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Agent actions"
                      className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={busy}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!isMaster && (
                      <DropdownMenuItem onClick={() => handlePromote(agent.agentName)}>
                        <Crown className="size-4 text-status-warning" />
                        Set as Master
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPendingRemoval(agent.agentName)}
                    >
                      <UserMinus className="size-4" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}