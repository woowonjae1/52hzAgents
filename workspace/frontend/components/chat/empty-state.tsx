'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Rocket, Copy, Check, ChevronRight, Key, Cloud, ExternalLink, Loader2, ArrowLeft } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { capture } from '@/lib/analytics';
import { useLayout } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceApi } from '@/lib/api';
import { AgentIcon } from '@/components/icons/agent-icons';
import { cn } from '@/lib/utils';
import type { AgentCatalogEntry } from '@/lib/types';

const DEFAULT_CATALOG: AgentCatalogEntry[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    description: "Anthropic's official terminal agent for code generation and shell execution.",
    install_command: 'agn install claude',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'openclaw',
    label: 'OpenClaw',
    description: 'A community-driven coding agent with autonomous task execution capabilities.',
    install_command: 'agn install openclaw',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex terminal assistant for natural language shell scripting.',
    install_command: 'agn install codex',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'aider',
    label: 'Aider',
    description: 'A developer-focused command line tool for coding with LLMs in git repositories.',
    install_command: 'agn install aider',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'goose',
    label: 'Goose',
    description: "Block's open-source tool-using agent specialized in coding tasks.",
    install_command: 'agn install goose',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'cline',
    label: 'Cline',
    description: 'An autonomous developer agent that can run commands, edit files, and build apps.',
    install_command: 'agn install cline',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'hermes',
    label: 'Hermes',
    description: 'A fast and lightweight agent built for rapid software maintenance.',
    install_command: 'agn install hermes',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'pi',
    label: 'Pi Agent',
    description: 'Mathematical and reasoning agent tailored for algorithmic tasks and workflows.',
    install_command: 'wwj create pi --type pi',
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

export function EmptyState() {
  const { agents, token } = useWorkspace();
  const { setViewMode } = useLayout();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const hasOnlineAgent = agents.some((a) => a.status === 'online');

  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
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
  }, [token, selectedAgent]);

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

  const selectedEntry = useMemo(
    () => catalog.find((e) => e.name === selectedAgent),
    [catalog, selectedAgent],
  );

  const handleCopyToken = () => {
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  if (hasOnlineAgent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <div className="flex items-center justify-center p-3 rounded-full bg-primary/10">
          <img src="/logo-icon.png" alt="52Hz Agent" className="size-10 object-contain" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">You&apos;re all set!</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Your agent is online. Send a message below to start collaborating.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface0">
      {/* Split Dashboard Panel */}
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

              {/* One-Click Auto-Connect Button — spawns the connector process via
                  the backend (POST /v1/agents/:name/launch). Reports the real
                  outcome; a failed launch must surface as a failure, not a
                  fabricated success toast. */}
              <button
                disabled={launching}
                onClick={async () => {
                  setLaunching(true);
                  toast.loading(`正在启动 ${selectedEntry.label}...`, { id: `launch-${selectedEntry.name}` });
                  try {
                    await workspaceApi.launchAgent(selectedEntry.name);
                    toast.success(`${selectedEntry.label} 已启动，等待连接...`, { id: `launch-${selectedEntry.name}` });
                  } catch (e) {
                    toast.error(
                      `启动 ${selectedEntry.label} 失败：${e instanceof Error ? e.message : '未知错误'}`,
                      { id: `launch-${selectedEntry.name}` },
                    );
                  } finally {
                    setLaunching(false);
                  }
                }}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-foreground text-background font-semibold text-xs hover:opacity-90 transition-all shadow-md cursor-pointer mb-3 disabled:opacity-60 disabled:pointer-events-none"
              >
                {launching ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                <span>一键自动启动并连接 {selectedEntry.label}</span>
              </button>

              {/* Optional Manual CLI Command (Collapsible) */}
              <div className="w-full bg-primary/40 dark:bg-black/60 border border-border/80 rounded-xl p-3 mb-4 relative group text-left">
                <div className="text-[11px] text-foreground-extra-muted font-mono mb-1.5 flex items-center justify-between">
                  <span>或通过命令行连接:</span>
                  <button
                    className="flex items-center gap-1 text-[10px] text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
                    onClick={() => {
                      copyToClipboard(`wwj connect my-${selectedEntry.name} ${token || 'local'}`);
                      toast.success('命令已复制到剪贴板');
                    }}
                  >
                    {isCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                    <span>{isCopied ? '已复制' : '复制命令'}</span>
                  </button>
                </div>
                <code className="text-foreground-muted text-[11px] font-mono block select-all truncate">
                  {`wwj connect my-${selectedEntry.name} ${token || 'local'}`}
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
    </div>
  );
}

function CliStep({
  step,
  label,
  command,
  copyCommand,
  isCopied,
  onCopy,
}: {
  step?: string;
  label: string;
  command: string;
  copyCommand?: string;
  isCopied: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <div>
      <span className="text-[11px] text-muted-foreground">{step ? `${step}. ` : ''}{label}</span>
      <div className="relative group mt-1">
        <pre className="bg-primary text-primary-foreground rounded-lg px-3.5 py-2.5 text-xs font-mono leading-relaxed overflow-x-auto">
          <span className="text-foreground-muted">$ </span>
          <span className="text-status-success">{command}</span>
        </pre>
        <button
          className="absolute top-1.5 right-1.5 size-6 flex items-center justify-center rounded bg-primary/80 hover:bg-primary text-foreground-extra-muted hover:text-white opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
          onClick={() => onCopy(copyCommand || command)}
        >
          {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
    </div>
  );
}