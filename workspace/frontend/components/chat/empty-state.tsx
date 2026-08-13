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
      toast.error('目前无在线 Agent，请先连接 Agent');
      setViewMode('mission');
      return;
    }
    if (participants.size === 0) {
      toast.error('请先勾选至少一个已连接的 Agent');
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
      toast.error(e instanceof Error ? e.message : '创建对话失败');
    } finally {
      setStarting(false);
    }
  };

  const agentPicker = (
    <div className="flex flex-wrap gap-1.5">
      {onlineAgents.map((agent) => {
        const isSelected = participants.has(agent.agentName);
        return (
          <button
            key={agent.agentName}
            onClick={() => toggleParticipant(agent.agentName)}
            className={cn(
              'flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border text-xs font-medium transition-colors cursor-pointer',
              isSelected
                ? 'border-primary bg-surface1/60 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-surface1/30'
            )}
          >
            <AgentAvatar name={agent.agentName} size={18} />
            {agent.agentName}
            {isSelected && <Check className="size-3" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );

  const startButton = (
    <button
      disabled={starting || (hasAgents && participants.size === 0)}
      onClick={handleStartChat}
      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-xs hover:opacity-90 transition-all disabled:opacity-50 cursor-pointer"
    >
      {starting ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
      {!hasAgents ? '连接 Agent 开始对话' : '开始对话'}
      {participants.size > 0 && <span className="opacity-70">({participants.size})</span>}
    </button>
  );

  return (
    <div className="h-full flex flex-col items-center justify-center bg-surface0 overflow-y-auto p-6">
      <div className="w-full max-w-md space-y-5">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">开始工作</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            选择项目目录与参与的 Agent 即可建立新的对话频道。
          </p>
        </div>

        <div>
          <h3 className="text-[11px] font-semibold text-foreground-extra-muted mb-1.5">项目目录 (可选)</h3>
          <ProjectFolderPicker
            value={workingDir}
            onChange={setWorkingDir}
            helperText="留空则为通用聊天对话。"
          />
        </div>

        <div>
          <h3 className="text-[11px] font-semibold text-foreground-extra-muted mb-2">已连接的 Agent</h3>
          {hasAgents ? (
            agentPicker
          ) : (
            <p className="text-xs text-muted-foreground italic">暂无在线 Agent，请先在 Agent 页面连接。</p>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-1">
          {startButton}
          <div className="flex items-center justify-between text-[11px] pt-1">
            <button
              onClick={() => setViewMode('mission')}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground font-medium transition-colors cursor-pointer"
            >
              <Plug className="size-3.5 opacity-70" />
              连接新的 Agent
            </button>
            <button
              onClick={() => setViewMode('connect')}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground font-medium transition-colors cursor-pointer"
            >
              <Cloud className="size-3.5 opacity-70" />
              Try Cloud Agents
            </button>
          </div>

          {/* Manual pairing command */}
          <div className="w-full bg-surface1/60 border border-border/80 rounded-xl p-3 mt-3 text-left">
            <div className="text-[11px] text-foreground-extra-muted font-mono mb-1 flex items-center justify-between">
              <span>通过命令行连接:</span>
              <button
                className="flex items-center gap-1 text-[10px] text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
                onClick={() => {
                  copyToClipboard(connectCommand);
                  toast.success('配对命令已复制');
                }}
              >
                {isCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                <span>{isCopied ? '已复制' : '复制命令'}</span>
              </button>
            </div>
            <code className="text-foreground-muted text-[10px] font-mono block truncate select-all">
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
                <span className="font-mono text-[11px]">
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
