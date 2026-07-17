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
    setLoading(true);
    workspaceApi
      .getAgentCatalog()
      .then((entries) => {
        if (!cancelled) {
          setCatalog(entries);
          if (entries.length > 0 && !selectedAgent) {
            setSelectedAgent(entries[0].name);
          }
        }
      })
      .catch(() => {})
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
      <div className="w-full max-w-md flex flex-col items-center">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            <span className="text-xs">Loading onboarding...</span>
          </div>
        ) : selectedEntry ? (
          <div className="w-full flex flex-col items-center animate-in fade-in duration-200">
            {/* Horizontal Agent Switcher */}
            {catalog.length > 1 && (
              <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full border border-zinc-200/50 dark:border-zinc-800/40 bg-zinc-50/50 dark:bg-zinc-900/50 mb-8 max-w-full">
                <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 pl-1.5 shrink-0">Switch Agent:</span>
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5 pr-1.5">
                  {catalog.map((entry) => (
                    <button
                      key={entry.name}
                      onClick={() => setSelectedAgent(entry.name)}
                      className={cn(
                        'size-6 rounded-md flex items-center justify-center p-0.5 border transition-all shrink-0 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                        selectedAgent === entry.name
                          ? 'border-zinc-900 bg-white dark:border-zinc-100 dark:bg-zinc-900 scale-105 shadow-xs'
                          : 'border-transparent opacity-60 hover:opacity-100'
                      )}
                      title={entry.label}
                    >
                      <AgentIcon name={entry.name} size={16} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Agent Large Cover Image */}
            <div className="size-20 flex items-center justify-center rounded-2xl bg-white dark:bg-zinc-900 shadow-md border border-zinc-200/60 dark:border-zinc-800/80 p-3 mb-4 relative group overflow-hidden">
              <AgentIcon name={selectedEntry.name} size={52} />
            </div>

            <h3 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mb-1">
              {selectedEntry.label}
            </h3>
            
            <p className="text-xs text-muted-foreground max-w-sm mb-6 text-center">
              {selectedEntry.description}
            </p>

            {/* Run connection command box */}
            <div className="w-full bg-zinc-900 dark:bg-black border border-zinc-800 rounded-xl p-4 mb-4 relative group text-left">
              <div className="text-[10px] text-zinc-500 font-mono mb-2 uppercase tracking-wider">
                Run command to connect:
              </div>
              <pre className="text-zinc-100 text-xs font-mono select-all whitespace-pre-wrap break-all pr-8 leading-relaxed">
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
              <div className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-card text-xs font-medium text-muted-foreground mb-6">
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

            {/* Cloud agents fallback */}
            <div className="w-full text-center space-y-3.5">
              <div className="flex items-center gap-3 justify-center">
                <div className="w-12 border-t border-zinc-200/50 dark:border-zinc-800/50" />
                <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-muted-foreground">or</span>
                <div className="w-12 border-t border-zinc-200/50 dark:border-zinc-800/50" />
              </div>
              <button
                onClick={() => setViewMode('connect')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 bg-card hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30 transition-colors text-xs group"
              >
                <Cloud className="size-4 text-muted-foreground opacity-70" />
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Try Cloud Agents</span>
                <span className="text-muted-foreground font-normal">| No install needed</span>
                <ChevronRight className="size-3 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No agents available in catalog</p>
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
