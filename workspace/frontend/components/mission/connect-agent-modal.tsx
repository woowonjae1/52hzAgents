'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ArrowRight,
  MessageSquare,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import { AgentIcon } from '@/components/icons/agent-icons';
import type {
  AgentConnection,
  AgentConnectionCandidate,
  AgentConnectionKind,
} from '@/lib/api/agent-definitions';

interface ConnectAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface NativeAgentSpec {
  probeKind: string;
  candidateKind: AgentConnectionKind;
  displayName: string;
  commandName: string;
  description: string;
  installCommand: string;
}

const NATIVE_SPECS: NativeAgentSpec[] = [
  {
    probeKind: 'antigravity',
    candidateKind: 'native-antigravity',
    displayName: 'Google Antigravity',
    commandName: 'agy',
    description: 'Google Antigravity 智能体编码 CLI，原生集成 Gemini 模型与受控执行',
    installCommand: 'npm i -g @google/antigravity',
  },
  {
    probeKind: 'codex',
    candidateKind: 'native-codex',
    displayName: 'OpenAI Codex',
    commandName: 'codex',
    description: 'OpenAI 官方终端编码助手，深度集成 o-series 及 GPT 系列模型',
    installCommand: 'npm i -g @openai/codex',
  },
  {
    probeKind: 'pi',
    candidateKind: 'native-pi',
    displayName: 'Pi 极客助手',
    commandName: 'pi',
    description: '多模型跨平台工程命令行工具，具备完整读写与终端受控执行能力',
    installCommand: 'npm i -g @mario/pi',
  },
  {
    probeKind: 'openclaw',
    candidateKind: 'native-openclaw',
    displayName: 'OpenClaw',
    commandName: 'openclaw',
    description: '开源社区自主任务执行智能体，支持独立进程与会话互斥隔离',
    installCommand: 'npm i -g openclaw',
  },
  {
    probeKind: 'hermes',
    candidateKind: 'native-hermes',
    displayName: 'Hermes Agent',
    commandName: 'hermes',
    description: '轻量极速敏捷代码维护智能体，支持多任务互斥与 Profile 保护',
    installCommand: 'pip install hermes-agent',
  },
];

export function ConnectAgentModal({ open, onOpenChange }: ConnectAgentModalProps) {
  const { agents, refreshAgents, createSession } = useWorkspace();
  const { setViewMode, setSettingsTab } = useLayout();

  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<AgentConnectionCandidate[]>([]);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [connectingProbe, setConnectingProbe] = useState<string | null>(null);
  const [connectingAll, setConnectingAll] = useState(false);
  const [copiedProbe, setCopiedProbe] = useState<string | null>(null);

  const loadCandidatesAndConnections = useCallback(async (showToast = false) => {
    setLoading(true);
    try {
      const [candRes, connRes] = await Promise.all([
        workspaceApi.listAgentConnectionCandidates(false),
        workspaceApi.listAgentConnections(true),
      ]);
      setCandidates(candRes.candidates || []);
      setConnections(connRes.connections || []);
      if (showToast) {
        toast.success('已刷新本机客户端探测状态');
      }
    } catch (err) {
      if (showToast) {
        toast.error(err instanceof Error ? err.message : '探测本机 Agent 失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadCandidatesAndConnections(false);
    }
  }, [open, loadCandidatesAndConnections]);

  const candidateMap = useMemo(() => {
    const map = new Map<string, AgentConnectionCandidate>();
    for (const c of candidates) {
      map.set(c.probeKind.toLowerCase(), c);
      if (c.candidateKind) {
        map.set(c.candidateKind.toLowerCase(), c);
      }
    }
    return map;
  }, [candidates]);

  const connectionMap = useMemo(() => {
    const map = new Map<string, AgentConnection>();
    for (const conn of connections) {
      if (conn.status === 'registered') {
        map.set(conn.kind.toLowerCase(), conn);
      }
    }
    return map;
  }, [connections]);

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      map.set(a.agentName.toLowerCase(), a.agentName);
      if (a.agentType) {
        map.set(a.agentType.toLowerCase(), a.agentName);
      }
    }
    return map;
  }, [agents]);

  const resolveSpecStatus = useCallback(
    (spec: NativeAgentSpec) => {
      const cand = candidateMap.get(spec.probeKind.toLowerCase()) || candidateMap.get(spec.candidateKind.toLowerCase());
      const conn = connectionMap.get(spec.candidateKind.toLowerCase());
      const hasRegisteredConn = Boolean(conn) || (cand?.registeredConnections && cand.registeredConnections.length > 0);
      const matchedMember =
        memberMap.get(spec.commandName.toLowerCase()) ||
        memberMap.get(spec.probeKind.toLowerCase()) ||
        conn?.sharedMembers?.[0]?.name ||
        cand?.registeredConnections?.[0]?.sharedMembers?.[0]?.name;

      const isConnected = hasRegisteredConn || Boolean(matchedMember);
      const isDetected = Boolean(cand?.installation?.detected);
      const version = cand?.installation?.version || null;

      return {
        cand,
        conn,
        isConnected,
        isDetected,
        version,
        memberName: matchedMember || spec.probeKind,
      };
    },
    [candidateMap, connectionMap, memberMap],
  );

  const readyToConnectSpecs = useMemo(() => {
    return NATIVE_SPECS.filter((spec) => {
      const { isConnected, isDetected } = resolveSpecStatus(spec);
      return !isConnected && isDetected;
    });
  }, [resolveSpecStatus]);

  const handleConnect = async (spec: NativeAgentSpec) => {
    setConnectingProbe(spec.probeKind);
    try {
      const created = await workspaceApi.registerAgentConnection({
        kind: spec.candidateKind,
        displayName: spec.displayName,
        memberName: spec.probeKind,
        createMember: true,
      });
      toast.success(`已连接 ${created.member?.name || spec.displayName}`);
      await refreshAgents();
      await loadCandidatesAndConnections(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '连接失败');
    } finally {
      setConnectingProbe(null);
    }
  };

  const handleConnectAllReady = async () => {
    if (readyToConnectSpecs.length === 0) return;
    setConnectingAll(true);
    let successCount = 0;
    try {
      for (const spec of readyToConnectSpecs) {
        await workspaceApi.registerAgentConnection({
          kind: spec.candidateKind,
          displayName: spec.displayName,
          memberName: spec.probeKind,
          createMember: true,
        });
        successCount++;
      }
      toast.success(`已一键接入 ${successCount} 个本机客户端`);
      await refreshAgents();
      await loadCandidatesAndConnections(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '部分客户端连接失败');
    } finally {
      setConnectingAll(false);
    }
  };

  const handleStartChat = async (spec: NativeAgentSpec, memberName: string) => {
    try {
      await createSession({
        master: memberName,
        participants: [memberName],
        title: `${spec.displayName} 对话`,
      });
      setViewMode('threads');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发起对话失败');
    }
  };

  const handleCopyInstall = (probeKind: string, installCommand: string) => {
    navigator.clipboard.writeText(installCommand);
    setCopiedProbe(probeKind);
    toast.success('已复制安装命令，在终端执行后刷新即可一键连接');
    setTimeout(() => {
      setCopiedProbe((cur) => (cur === probeKind ? null : cur));
    }, 2000);
  };

  const goToAdvancedSettings = () => {
    onOpenChange(false);
    setSettingsTab?.('agents');
    setViewMode('settings');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-6 gap-5 bg-card/95 backdrop-blur-md border-border/80 shadow-2xl rounded-2xl">
        <DialogHeader className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Zap className="size-4" />
              </div>
              <DialogTitle className="text-base font-semibold text-foreground tracking-tight">
                连接智能体
              </DialogTitle>
            </div>

            <div className="flex items-center gap-2">
              {readyToConnectSpecs.length >= 2 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={connectingAll || Boolean(connectingProbe)}
                  onClick={handleConnectAllReady}
                  className="h-7 px-2.5 text-xs gap-1.5 border-primary/30 hover:border-primary text-primary hover:bg-primary/5 cursor-pointer font-medium"
                >
                  {connectingAll ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Zap className="size-3" />
                  )}
                  <span>接入全部就绪 ({readyToConnectSpecs.length})</span>
                </Button>
              )}

              <Button
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={() => void loadCandidatesAndConnections(true)}
                title="重新探测本机环境"
                className="size-7 p-0 text-foreground-muted hover:text-foreground cursor-pointer"
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
          <DialogDescription className="text-xs text-foreground-muted">
            一键直连本机已安装的 Coding Agent，无需手动配置参数或中转网关。
          </DialogDescription>
        </DialogHeader>

        {/* ── Native Agents List ── */}
        <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
          {NATIVE_SPECS.map((spec) => {
            const { isConnected, isDetected, version, memberName } = resolveSpecStatus(spec);
            const isConnecting = connectingProbe === spec.probeKind || connectingAll;
            const isCopied = copiedProbe === spec.probeKind;

            return (
              <div
                key={spec.probeKind}
                className={cn(
                  'group relative rounded-xl border p-3 flex items-center justify-between gap-3.5 transition-all',
                  isConnected
                    ? 'bg-status-success/[0.03] border-status-success/20'
                    : isDetected
                    ? 'bg-surface2/30 border-border/80 hover:border-primary/40 hover:bg-surface2/50'
                    : 'bg-card/40 border-border/50 hover:border-border/80',
                )}
              >
                {/* Left: Icon & Info */}
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="size-9 rounded-xl bg-surface2/80 flex items-center justify-center shrink-0 border border-border/60">
                    <AgentIcon name={spec.probeKind} size={22} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground truncate">
                        {spec.displayName}
                      </span>
                      <code className="text-3xs font-mono text-foreground-extra-muted bg-surface3/60 px-1 py-0.5 rounded">
                        {spec.commandName}
                      </code>

                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs font-medium bg-status-success/10 text-status-success border border-status-success/20">
                          <span className="size-1 rounded-full bg-status-success" />
                          已接入 (@{memberName})
                        </span>
                      ) : isDetected ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs font-medium bg-primary/10 text-primary border border-primary/20">
                          <span className="size-1 rounded-full bg-primary" />
                          已就绪{version ? ` ${version}` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs font-normal bg-surface3/80 text-foreground-extra-muted border border-border/40">
                          未安装客户端
                        </span>
                      )}
                    </div>
                    <p className="text-3xs text-foreground-extra-muted truncate mt-0.5">
                      {spec.description}
                    </p>
                  </div>
                </div>

                {/* Right: Action Button */}
                <div className="shrink-0">
                  {isConnected ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleStartChat(spec, memberName)}
                      className="h-8 px-3 text-xs gap-1.5 font-medium border-border hover:border-border-accent hover:bg-surface2 cursor-pointer"
                    >
                      <MessageSquare className="size-3.5 text-foreground-muted" />
                      <span>发起对话</span>
                    </Button>
                  ) : isDetected ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={isConnecting}
                      onClick={() => handleConnect(spec)}
                      className="h-8 px-3.5 text-xs gap-1.5 font-medium cursor-pointer shadow-xs"
                    >
                      {isConnecting ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Zap className="size-3.5" />
                      )}
                      <span>一键连接</span>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleCopyInstall(spec.probeKind, spec.installCommand)}
                      className="h-8 px-3 text-xs gap-1.5 font-normal text-foreground-muted hover:text-foreground cursor-pointer"
                    >
                      {isCopied ? (
                        <Check className="size-3.5 text-status-success" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      <span>{isCopied ? '已复制命令' : '复制安装命令'}</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Footer ── */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2 border-t border-border/40 text-2xs text-foreground-extra-muted">
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500/80 shrink-0" />
            <span>原生接入基于本机环境与系统凭据安全运行</span>
          </div>

          <button
            type="button"
            onClick={goToAdvancedSettings}
            className="inline-flex items-center gap-1 text-foreground-muted hover:text-primary transition-colors cursor-pointer shrink-0 font-medium"
          >
            <span>需要 WSL 路径或参数微调？前往高级设置</span>
            <ArrowRight className="size-3" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
