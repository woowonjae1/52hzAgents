'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Rocket, Copy, Check, ChevronRight, Key, Cloud, ExternalLink, Loader2, ArrowLeft } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { capture } from '@/lib/analytics';
import { useLayout } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceApi } from '@/lib/api';
import { AgentIcon } from '@/components/icons/agent-icons';
import { cn } from '@/lib/utils';
import type { AgentCatalogEntry } from '@/lib/types';

export function EmptyState() {
  const { agents, token } = useWorkspace();
  const { setViewMode } = useLayout();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const hasOnlineAgent = agents.some((a) => a.status === 'online');

  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    workspaceApi
      .getAgentCatalog()
      .then((entries) => { if (!cancelled) setCatalog(entries); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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
        <div className="flex items-center p-4 rounded-full bg-emerald-500/10">
          <Rocket className="size-8 text-emerald-500" />
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
    <div className="flex flex-col items-center justify-center h-full overflow-y-auto p-6 sm:p-8 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-lg space-y-8 py-8 flex flex-col items-center">
        {/* Back to the agent picker */}
        {selectedEntry && (
          <button
            onClick={() => setSelectedAgent(null)}
            className="self-start inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to agents
          </button>
        )}

        {/* Header */}
        {!selectedEntry && (
          <div className="text-center space-y-2.5">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">Connect an Agent</h2>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Select an agent below to obtain the command line connection launcher.
            </p>
          </div>
        )}

        {/* Agent catalog grid */}
        {!selectedEntry && (loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            <span className="text-sm">Loading agents...</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 w-full">
            {catalog.map((entry) => {
              const isSelected = selectedAgent === entry.name;
              return (
                <button
                  key={entry.name}
                  onClick={() => setSelectedAgent(isSelected ? null : entry.name)}
                  className={cn(
                    'flex flex-col items-center gap-3 px-4 py-5 rounded-xl border bg-card text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
                    isSelected
                      ? 'border-zinc-900 dark:border-zinc-50 ring-1 ring-zinc-900 dark:ring-zinc-50'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700',
                  )}
                >
                  <div className="size-12 flex items-center justify-center rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-1 border border-zinc-100 dark:border-zinc-800/40">
                    <AgentIcon name={entry.name} size={36} />
                  </div>
                  <div className="min-w-0 w-full">
                    <div className="text-sm font-semibold leading-tight truncate">{entry.label}</div>
                    <div className="text-[10px] text-muted-foreground mt-1 truncate">
                      {entry.tags?.[0] || 'Agent'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}

        {/* Selected agent — Connection illustration / cover design */}
        {selectedEntry && (
          <div className="w-full flex flex-col items-center text-center animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Agent Large Cover Image */}
            <div className="size-24 flex items-center justify-center rounded-2xl bg-white dark:bg-zinc-900 shadow-md border border-zinc-200/60 dark:border-zinc-800/80 p-4 mb-5 relative group overflow-hidden">
              <AgentIcon name={selectedEntry.name} size={64} />
            </div>

            <h3 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mb-1">
              {selectedEntry.label}
            </h3>
            
            <p className="text-xs text-muted-foreground max-w-sm mb-6">
              {selectedEntry.description}
            </p>

            {/* Run connection command box */}
            <div className="w-full bg-zinc-900 dark:bg-black border border-zinc-800 rounded-xl p-4 mb-4 relative group">
              <div className="text-[10px] text-zinc-500 font-mono mb-2 text-left uppercase tracking-wider">
                Run command to connect:
              </div>
              <pre className="text-zinc-100 text-xs font-mono text-left select-all whitespace-pre-wrap break-all pr-8 leading-relaxed">
                {`wwj connect my-${selectedEntry.name} ${token}`}
              </pre>
              <button
                className="absolute top-3.5 right-3.5 size-6 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
                onClick={() => {
                  capture('cli_install_copied', {
                    source: 'workspace_onboarding',
                    agent_type: selectedEntry.name,
                    os: 'unix',
                  });
                  copyToClipboard(`wwj connect my-${selectedEntry.name} ${token}`);
                }}
              >
                {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            </div>

            {/* Token details */}
            {token && (
              <div className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-card text-xs font-medium text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Key className="size-3.5" />
                  <span>Workspace Token</span>
                </div>
                <button
                  onClick={handleCopyToken}
                  className="flex items-center gap-1 hover:text-foreground font-mono transition-colors"
                >
                  <span className="mr-1.5">
                    {token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token}
                  </span>
                  {tokenCopied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Cloud agents fallback */}
        {!selectedEntry && (
          <div className="w-full text-center space-y-3 pt-2">
            <div className="flex items-center gap-3 justify-center">
              <div className="w-12 border-t" />
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">or</span>
              <div className="w-12 border-t" />
            </div>
            <button
              onClick={() => setViewMode('connect')}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-card hover:bg-zinc-50 dark:hover:bg-zinc-900/60 transition-colors text-sm group"
            >
              <Cloud className="size-4 text-muted-foreground" />
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">Try Cloud Agents</span>
              <span className="text-xs text-muted-foreground font-normal">| No install needed</span>
              <ChevronRight className="size-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        )}
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
        <pre className="bg-zinc-900 text-zinc-100 rounded-lg px-3.5 py-2.5 text-xs font-mono leading-relaxed overflow-x-auto">
          <span className="text-zinc-500">$ </span>
          <span className="text-emerald-400">{command}</span>
        </pre>
        <button
          className="absolute top-1.5 right-1.5 size-6 flex items-center justify-center rounded bg-zinc-700/80 hover:bg-zinc-600 text-zinc-300 hover:text-white opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
          onClick={() => onCopy(copyCommand || command)}
        >
          {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
    </div>
  );
}
