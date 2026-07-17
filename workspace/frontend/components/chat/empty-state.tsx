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
    <div className="h-full flex flex-col bg-zinc-50 dark:bg-zinc-950">
      {/* Split Dashboard Panel */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-12 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-zinc-200/60 dark:divide-zinc-800/80">
        
        {/* Left Column: Roster List */}
        <div className="md:col-span-5 flex flex-col justify-between p-5 bg-white dark:bg-zinc-900 min-h-0 overflow-y-auto">
          <div className="space-y-4">
            <div>
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Agent Catalog
              </span>
              <h2 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-1">
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
                          ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50/50 dark:bg-zinc-900/50 shadow-xs'
                          : 'border-transparent hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30'
                      )}
                    >
                      <div className="size-8 shrink-0 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800/40 p-1 border border-zinc-200/20 dark:border-zinc-800/20">
                        <AgentIcon name={entry.name} size={24} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-50 truncate">{entry.label}</div>
                        <div className="text-[9px] text-muted-foreground mt-0.5 font-mono uppercase tracking-wider">
                          {entry.tags?.[0] || 'Local'}
                        </div>
                      </div>
                      {isSelected && (
                        <div className="size-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cloud Fallback Link */}
          <div className="border-t border-zinc-100 dark:border-zinc-800/40 pt-4 mt-6">
            <button
              onClick={() => setViewMode('connect')}
              className="w-full inline-flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/20 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors text-[11px] font-semibold text-zinc-700 dark:text-zinc-300"
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
        <div className="md:col-span-7 flex flex-col justify-center items-center p-6 bg-zinc-50/30 dark:bg-zinc-950/10 min-h-0 overflow-y-auto">
          {selectedEntry ? (
            <div className="w-full max-w-sm flex flex-col items-center animate-in fade-in duration-200">
              {/* Agent Large Cover Image */}
              <div className="size-20 flex items-center justify-center rounded-2xl bg-white dark:bg-zinc-900 shadow-md border border-zinc-200/60 dark:border-zinc-800/80 p-3 mb-4 relative group overflow-hidden">
                <AgentIcon name={selectedEntry.name} size={52} />
              </div>

              <h3 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mb-1">
                {selectedEntry.label}
              </h3>
              
              <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-6 text-center leading-relaxed">
                {selectedEntry.description}
              </p>

              {/* Connection Command Card */}
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

              {/* Token Details */}
              {token && (
                <div className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-card text-xs font-medium text-muted-foreground">
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
                    {tokenCopied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
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
