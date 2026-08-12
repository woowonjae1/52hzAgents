'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Rocket, Copy, Check, ChevronRight, ChevronLeft, Key, Cloud, Loader2, Plug } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { capture } from '@/lib/analytics';
import { useLayout } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceApi } from '@/lib/api';
import { AgentIcon } from '@/components/icons/agent-icons';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { ProjectFolderPicker, rememberWorkingDir } from './project-folder-picker';
import { cn } from '@/lib/utils';
import type { AgentCatalogEntry } from '@/lib/types';

/** Fallback only — the live list comes from GET /v1/agents/catalog. Keep the
 * commands identical to the backend's (internal/handlers/agents_catalog.go), or
 * users get a command that doesn't exist depending on whether the fetch won. */
const DEFAULT_CATALOG: AgentCatalogEntry[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    description: "Anthropic's official terminal agent for code generation and shell execution.",
    install_command: 'wwj install claude',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'openclaw',
    label: 'OpenClaw',
    description: 'A community-driven coding agent with autonomous task execution capabilities.',
    install_command: 'wwj install openclaw',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex terminal assistant for natural language shell scripting.',
    install_command: 'wwj install codex',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'aider',
    label: 'Aider',
    description: 'A developer-focused command line tool for coding with LLMs in git repositories.',
    install_command: 'wwj install aider',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'goose',
    label: 'Goose',
    description: "Block's open-source tool-using agent specialized in coding tasks.",
    install_command: 'wwj install goose',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'cline',
    label: 'Cline',
    description: 'An autonomous developer agent that can run commands, edit files, and build apps.',
    install_command: 'wwj install cline',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'hermes',
    label: 'Hermes',
    description: 'A fast and lightweight agent built for rapid software maintenance.',
    install_command: 'wwj install hermes',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'pi',
    label: 'Pi Agent',
    description: 'Mathematical and reasoning agent tailored for algorithmic tasks and workflows.',
    install_command: 'wwj install pi',
    homepage: 'https://openagents.org',
    tags: ['coding', 'reasoning', 'cli'],
    builtin: true,
  },
  {
    name: 'custom',
    label: 'Custom',
    description: 'Connect any process using stdin/stdout framing or standard MCP tools.',
    install_command: 'wwj create my-agent --type custom',
    homepage: 'https://openagents.org',
    tags: ['custom'],
    builtin: true,
  },
];

/** How long to wait for a launched agent to call home before telling the user
 * where to look. Cold `wwj install` + first model handshake can be slow. */
const LAUNCH_TIMEOUT_SEC = 120;

interface PendingLaunch {
  name: string;
  label: string;
  /** Agents already online when the launch fired — anything new is the one we started. */
  known: string[];
  startedAt: number;
}

export function EmptyState() {
  const { agents, token, createSession } = useWorkspace();
  const { setViewMode } = useLayout();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onlineAgents = agents.filter((a) => a.status === 'online');
  const hasAgents = onlineAgents.length > 0;

  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [workingDir, setWorkingDir] = useState('');
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  // Someone with agents already connected wants to start working, not to browse
  // a runtime catalog. They opt into the catalog explicitly; a first-time user
  // (no agents) still lands on it directly.
  const [showCatalog, setShowCatalog] = useState(false);
  const catalogVisible = !hasAgents || showCatalog;

  // One connected agent is the common case — pre-select it so starting a
  // chat is a single click, same convention as the New Thread dialog.
  useEffect(() => {
    if (onlineAgents.length === 1) {
      setParticipants((prev) => (prev.size === 0 ? new Set([onlineAgents[0].agentName]) : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineAgents.length]);

  useEffect(() => {
    if (!catalogVisible) return;
    let cancelled = false;
    setLoading(true);
    workspaceApi
      .getAgentCatalog()
      .then((entries) => {
        if (!cancelled) {
          const validEntries = entries && entries.length > 0 ? entries : DEFAULT_CATALOG;
          setCatalog(validEntries);
          if (validEntries.length > 0 && !selectedAgent) {
            setSelectedAgent(validEntries[0].name);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(DEFAULT_CATALOG);
          if (!selectedAgent) {
            setSelectedAgent(DEFAULT_CATALOG[0].name);
          }
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, selectedAgent, catalogVisible]);

  // The onboarding view auto-shows when a workspace is open with no agent connected.
  // It's a conditional render (no route/pageview), so fire an explicit event here.
  // Debounced ~1s so the brief no-agents flash during initial load doesn't count;
  // if agents arrive first, this component unmounts and the timer is cleared.
  // The active workspace group (set on workspace open) auto-attaches for funnel joins.
  const onboardingTracked = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (onboardingTracked.current) return;
      onboardingTracked.current = true;
      capture('workspace_onboarding_viewed');
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  // ── Launch → connected, closed loop ──────────────────────────────────────
  // Launching an agent used to end at a "waiting for connection…" toast that
  // never resolved. Watch the roster instead: whichever agent shows up that
  // wasn't online before is the one we started.
  const onlineKey = onlineAgents.map((a) => a.agentName).sort().join(',');
  useEffect(() => {
    if (!pending) return;
    const fresh = onlineAgents.find((a) => !pending.known.includes(a.agentName));
    if (!fresh) return;
    setParticipants((prev) => new Set(prev).add(fresh.agentName));
    toast.success(`${fresh.agentName} 已连接`, { id: `launch-${pending.name}` });
    setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineKey, pending]);

  useEffect(() => {
    if (!pending) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - pending.startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pending]);

  const launchTimedOut = pending != null && elapsed >= LAUNCH_TIMEOUT_SEC;

  const selectedEntry = useMemo(
    () => catalog.find((e) => e.name === selectedAgent),
    [catalog, selectedAgent],
  );

  const connectCommand = `wwj connect my-${selectedEntry?.name ?? 'agent'} ${token || 'local'}`;

  const handleCopyToken = () => {
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
    if (participants.size === 0) {
      toast.error('先选择至少一个已连接的 agent');
      return;
    }
    setStarting(true);
    const dir = workingDir.trim();
    try {
      await createSession({
        participants: Array.from(participants),
        workingDir: dir || undefined,
      });
      rememberWorkingDir(dir);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建对话失败');
    } finally {
      setStarting(false);
    }
  };

  const handleLaunch = async () => {
    if (!selectedEntry) return;
    setLaunching(true);
    try {
      await workspaceApi.launchAgent(selectedEntry.name, workingDir.trim() || undefined);
      setPending({
        name: selectedEntry.name,
        label: selectedEntry.label,
        known: onlineAgents.map((a) => a.agentName),
        startedAt: Date.now(),
      });
    } catch (e) {
      toast.error(`启动 ${selectedEntry.label} 失败:${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setLaunching(false);
    }
  };

  // ── Connected-agent picker, shared by both views ─────────────────────────
  const agentPicker = (
    <div className="flex flex-wrap gap-1.5">
      {onlineAgents.map((agent) => {
        const isSelected = participants.has(agent.agentName);
        return (
          <button
            key={agent.agentName}
            onClick={() => toggleParticipant(agent.agentName)}
            className={cn(
              'flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border text-xs font-medium transition-colors',
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
      disabled={starting || participants.size === 0}
      onClick={handleStartChat}
      className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-primary text-primary-foreground font-semibold text-xs hover:opacity-90 transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
    >
      {starting ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
      开始对话
      {participants.size > 0 && <span className="opacity-70">({participants.size})</span>}
    </button>
  );

  // ── Returning user: directory, agents, go. Nothing else. ─────────────────
  if (!catalogVisible) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-surface0 overflow-y-auto p-6">
        <div className="w-full max-w-md space-y-5">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">开始工作</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              选一个项目目录和参与的 agent,就可以开始了。
            </p>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold text-foreground-extra-muted mb-1.5">项目目录(可选)</h3>
            <ProjectFolderPicker
              value={workingDir}
              onChange={setWorkingDir}
              helperText="留空则是不接触文件系统的普通对话。"
            />
          </div>

          <div>
            <h3 className="text-[11px] font-semibold text-foreground-extra-muted mb-2">已连接的 Agent</h3>
            {agentPicker}
          </div>

          <div className="flex flex-col gap-2 pt-1">
            {startButton}
            <div className="flex items-center justify-between text-[11px]">
              <button
                onClick={() => setShowCatalog(true)}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plug className="size-3.5 opacity-70" />
                连接新的 Agent
              </button>
              <button
                onClick={() => setViewMode('connect')}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Cloud className="size-3.5 opacity-70" />
                Try Cloud Agents
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Catalog: install / launch / connect a runtime ────────────────────────
  return (
    <div className="h-full flex flex-col bg-surface0 overflow-y-auto">
      {hasAgents && (
        <div className="px-5 pt-4 shrink-0">
          <button
            onClick={() => setShowCatalog(false)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="size-3.5" />
            返回开始工作
          </button>
        </div>
      )}

      {/* Project directory — also becomes the launched agent's working dir. */}
      <div className="px-5 pt-4 pb-1 shrink-0">
        <h2 className="text-[11px] font-semibold text-foreground-extra-muted">项目目录(可选)</h2>
        <p className="text-[11px] text-muted-foreground mb-2">不选目录也能开始普通对话。</p>
        <ProjectFolderPicker value={workingDir} onChange={setWorkingDir} />
      </div>

      {/* Already-connected agents — pick who joins this conversation. */}
      {hasAgents && (
        <div className="px-5 pt-4 pb-1 shrink-0">
          <h2 className="text-[11px] font-semibold text-foreground-extra-muted mb-2">已连接的 Agent</h2>
          {agentPicker}
        </div>
      )}

      <div className="px-5 pt-4 pb-1 shrink-0">
        <h2 className="text-[11px] font-semibold text-foreground-extra-muted">
          {hasAgents ? '连接新的 Agent' : 'Agent Catalog'}
        </h2>
      </div>
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-border/60">

        {/* Left Column: Roster List */}
        <div className="md:col-span-5 flex flex-col justify-between p-5 bg-card min-h-0 overflow-y-auto">
          <div className="space-y-4">
            <div>
              <span className="text-[11px] font-semibold text-foreground-extra-muted">
                Agent Catalog
              </span>
              <h2 className="text-base font-semibold tracking-tight text-foreground mt-1">
                Select Runtime
              </h2>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" />
                <span className="text-xs">Loading agents...</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {catalog.map((entry) => {
                  const isSelected = selectedAgent === entry.name;
                  return (
                    <button
                      key={entry.name}
                      onClick={() => setSelectedAgent(entry.name)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all duration-150',
                        isSelected
                          ? 'border-primary bg-surface1/50 shadow-xs'
                          : 'border-transparent hover:bg-surface1/50 dark:hover:bg-primary/30'
                      )}
                    >
                      <div className="size-8 shrink-0 flex items-center justify-center rounded-lg bg-surface2/40 p-1 border border-border/20 dark:border-border/20">
                        <AgentIcon name={entry.name} size={24} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-foreground truncate">{entry.label}</div>
                        <div className="text-[9px] text-muted-foreground mt-0.5 font-mono ">
                          {entry.tags?.[0] || 'Local'}
                        </div>
                      </div>
                      {isSelected && (
                        <div className="size-1.5 rounded-full bg-primary shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cloud Fallback Link */}
          <div className="border-t border-border/60/40 pt-4 mt-6">
            <button
              onClick={() => setViewMode('connect')}
              className="w-full inline-flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-border/80 dark:border-border/80 bg-surface1/50 hover:bg-surface2 transition-colors text-[11px] font-semibold text-foreground-muted"
            >
              <span className="flex items-center gap-2">
                <Cloud className="size-3.5 opacity-70" />
                <span>Try Cloud Agents</span>
              </span>
              <ChevronRight className="size-3.5 opacity-60" />
            </button>
          </div>
        </div>

        {/* Right Column: Connection Canvas */}
        <div className="md:col-span-7 flex flex-col justify-center items-center p-6 bg-surface1/30 min-h-0 overflow-y-auto">
          {selectedEntry ? (
            <div className="w-full max-w-sm flex flex-col items-center animate-in fade-in duration-200">
              {/* Agent Large Cover Image */}
              <div className="size-20 flex items-center justify-center rounded-2xl bg-card shadow-md border border-border/60 dark:border-border/80 p-3 mb-4 relative group overflow-hidden">
                <AgentIcon name={selectedEntry.name} size={52} />
              </div>

              <h3 className="text-base font-semibold tracking-tight text-foreground mb-1">
                {selectedEntry.label}
              </h3>

              <p className="text-xs text-foreground-muted max-w-xs mb-6 text-center leading-relaxed">
                {selectedEntry.description}
              </p>

              {/* One-click launch — spawns the connector process via the backend
                  (POST /v1/agents/:name/launch), then waits for it to actually
                  join the roster. A failed launch, and a launch that starts but
                  never connects, both have to surface as such. */}
              {pending && pending.name === selectedEntry.name ? (
                <div className="w-full rounded-xl border border-border bg-card p-3.5 mb-3 text-xs">
                  {launchTimedOut ? (
                    <div className="space-y-2">
                      <p className="font-semibold text-status-danger">
                        {pending.label} 已启动 {elapsed}s,但一直没有连上。
                      </p>
                      <p className="text-muted-foreground leading-relaxed">
                        在终端里运行 <code className="font-mono text-foreground">wwj status</code> 看进程是否还活着,
                        <code className="font-mono text-foreground">wwj logs</code> 看失败原因;或者用下面的命令手动连接。
                      </p>
                      <div className="flex gap-2 pt-0.5">
                        <button
                          onClick={handleLaunch}
                          className="rounded-lg border border-border px-2.5 py-1 font-medium text-foreground hover:bg-surface2 transition-colors"
                        >
                          重试启动
                        </button>
                        <button
                          onClick={() => setPending(null)}
                          className="rounded-lg px-2.5 py-1 font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          知道了
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin text-foreground-muted shrink-0" />
                      <span className="flex-1 text-foreground-muted">
                        已启动 {pending.label},等待它连接…({elapsed}s)
                      </span>
                      <button
                        onClick={() => setPending(null)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  disabled={launching}
                  onClick={handleLaunch}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-foreground text-background font-semibold text-xs hover:opacity-90 transition-all shadow-md cursor-pointer mb-3 disabled:opacity-60 disabled:pointer-events-none"
                >
                  {launching ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                  <span>一键自动启动并连接 {selectedEntry.label}</span>
                </button>
              )}

              {/* Optional Manual CLI Command (Collapsible) */}
              <div className="w-full bg-primary/40 dark:bg-black/60 border border-border/80 rounded-xl p-3 mb-4 relative group text-left">
                <div className="text-[11px] text-foreground-extra-muted font-mono mb-1.5 flex items-center justify-between">
                  <span>或通过命令行连接:</span>
                  <button
                    className="flex items-center gap-1 text-[10px] text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
                    onClick={() => {
                      copyToClipboard(connectCommand);
                      toast.success('命令已复制到剪贴板');
                    }}
                  >
                    {isCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                    <span>{isCopied ? '已复制' : '复制命令'}</span>
                  </button>
                </div>
                <code className="text-foreground-muted text-[11px] font-mono block select-all truncate">
                  {connectCommand}
                </code>
              </div>

              {/* Token Details */}
              {token && (
                <div className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Key className="size-3.5" />
                    <span>Workspace Token</span>
                  </div>
                  <button
                    onClick={handleCopyToken}
                    className="flex items-center gap-1 hover:text-foreground font-mono transition-colors"
                  >
                    <span className="mr-1.5 font-mono">
                      {token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token}
                    </span>
                    {tokenCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-xs text-muted-foreground py-12">
              Select an agent from the list to see connection details
            </div>
          )}
        </div>
      </div>

      {/* Start — creates the thread with whichever already-connected agents
          are checked above, bound to the project directory if one was set. */}
      <div className="px-5 py-3.5 border-t border-border/60 shrink-0 flex justify-end">
        {startButton}
      </div>
    </div>
  );
}
