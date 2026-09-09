'use client';

import * as React from 'react';
import { Check, ChevronDown, Search, Sparkles, X } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  currentModelFor,
  hydrateAgentModels,
  modelsFor,
  rememberForSession,
  restoreForSession,
  parseReportedModels,
  setCurrentModel,
  useAgentModels,
} from '@/lib/agent-model-store';

// Re-exported: agent-profile-panel and mission-control import these from
// here. The definitions moved to lib/agent-model-store.ts because all
// surfaces parse the same adapter payload.
export { parseReportedModels, type AgentModelOption } from '@/lib/agent-model-store';

export function getAgentKind(agentName?: string | null, agentType?: string | null): string {
  return (agentType || agentName || '').toLowerCase();
}

interface AgentModelSwitcherProps {
  /**
   * The thread's leader. Shown first and named on the chip, because it is the
   * agent a bare message goes to — but it does NOT gate the control any more.
   */
  agentName?: string;
  /**
   * The thread's participants. The menu is scoped to these; every other online
   * agent in the workspace is still reachable, under its own heading, because
   * an agent can be added to a thread from anywhere and this chip should not be
   * the one surface that cannot see it.
   */
  participants?: string[];
  sessionId?: string | null;
  className?: string;
}

const norm = (s: string) => s.toLowerCase();

export function extractSubProvider(m: { id: string; provider?: string }): string {
  let p = m.provider || '';
  if (m.id.startsWith('kilo/') || m.id.startsWith('opencode/')) {
    const parts = m.id.split('/');
    if (parts.length > 2) {
      p = parts[1];
    } else if (m.id.startsWith('opencode/')) {
      const sub = parts[1].split('-')[0].toLowerCase();
      if (['mimo', 'nemotron', 'ling', 'muse', 'hy3'].includes(sub)) {
        p = sub;
      }
    }
  }
  const clean = p.replace(/^~/, '').toLowerCase();
  if (clean === 'kilo' || clean === 'opencode' || clean === 'free') return '';
  return clean;
}

export function formatProviderName(cleanP: string): string {
  if (!cleanP) return '';
  switch (cleanP) {
    case 'openai': return 'OpenAI';
    case 'xai':
    case 'x-ai': return 'xAI';
    case 'anthropic': return 'Anthropic';
    case 'deepseek': return 'DeepSeek';
    case 'google': return 'Google';
    case 'qwen': return 'Qwen';
    case 'stepfun': return 'StepFun';
    case 'minimax': return 'MiniMax';
    case 'mistralai':
    case 'mistral': return 'Mistral';
    case 'meta-llama':
    case 'meta': return 'Meta';
    case 'bytedance-seed':
    case 'seed': return 'ByteDance';
    case 'mimo': return 'MiMo';
    case 'nemotron': return 'Nvidia';
    case 'ling': return 'Ling';
    case 'muse': return 'Muse';
    case 'hy3': return 'HY3';
    default: return cleanP.charAt(0).toUpperCase() + cleanP.slice(1);
  }
}

export function AgentModelSwitcher({
  agentName,
  participants,
  sessionId,
  className,
}: AgentModelSwitcherProps) {
  const { workspaceId, agents } = useWorkspace();
  const modelState = useAgentModels();

  const [isOpen, setIsOpen] = React.useState(false);
  const [selectedAgentName, setSelectedAgentName] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [activeCategory, setActiveCategory] = React.useState<string>('all');

  const onlineAgents = React.useMemo(
    () => agents.filter((a) => a.status === 'online'),
    [agents],
  );

  const participantSet = React.useMemo(
    () => new Set((participants || []).map(norm)),
    [participants],
  );

  const inThread = React.useMemo(
    () => onlineAgents.filter((a) => participantSet.has(norm(a.agentName))),
    [onlineAgents, participantSet],
  );
  const elsewhere = React.useMemo(
    () => onlineAgents.filter((a) => !participantSet.has(norm(a.agentName))),
    [onlineAgents, participantSet],
  );

  const primary = participantSet.size > 0 ? inThread : onlineAgents;
  const secondary = participantSet.size > 0 ? elsewhere : [];

  const leadAgent = React.useMemo(() => {
    if (agentName) {
      const match = onlineAgents.find((a) => norm(a.agentName) === norm(agentName));
      if (match) return match;
    }
    return primary[0] || null;
  }, [agentName, onlineAgents, primary]);

  const anyOnline = onlineAgents.length > 0;
  const offlineHint = 'No agent online — connect one to switch models';

  const agentNamesKey = React.useMemo(
    () => onlineAgents.map((a) => a.agentName).sort().join(','),
    [onlineAgents],
  );

  const load = React.useCallback(async () => {
    if (!agentNamesKey) return;
    const names = agentNamesKey.split(',');
    if (workspaceId) workspaceApi.setWorkspaceId(workspaceId);
    await Promise.all(
      names.map(async (name) => {
        try {
          const usage = await workspaceApi.getAgentUsage(name);
          hydrateAgentModels(name, {
            options: parseReportedModels(usage?.available_models),
            current: usage?.current_model,
          });
        } catch {
          // An agent that does not answer keeps whatever the store holds.
        }
      }),
    );
  }, [agentNamesKey, workspaceId]);

  // Heartbeat: fold each agent's reported model list into the shared store.
  React.useEffect(() => {
    if (!agentNamesKey) return;
    let cancelled = false;

    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startTimer = () => {
      if (timer !== null || cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      timer = setInterval(() => { void load(); }, 30_000);
    };
    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
      } else {
        void load();
        startTimer();
      }
    };

    void load();
    startTimer();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentNamesKey, load]);

  // Saved per-thread choices, folded into the same store.
  React.useEffect(() => {
    if (!sessionId || !agentNamesKey) return;
    restoreForSession(sessionId, agentNamesKey.split(','));
  }, [sessionId, agentNamesKey]);

  const leadName = leadAgent?.agentName || agentName || 'agent';
  const leadCurrent = currentModelFor(modelState, leadName);
  const leadModels = modelsFor(modelState, leadName);

  /** What the chip reads when the lead agent has a model. */
  const leadLabel = React.useMemo(() => {
    if (!leadCurrent) return 'Default';
    if (/3\\.5/i.test(leadCurrent) && (norm(leadName) === 'antigravity' || norm(leadName) === 'agy')) {
      return leadModels[0]?.shortName || leadModels[0]?.name || 'Default';
    }
    const match = leadModels.find(
      (m) => m.id === leadCurrent || m.shortName === leadCurrent,
    );
    if (match) return match.shortName;
    return leadCurrent.includes('/') ? leadCurrent.slice(leadCurrent.indexOf('/') + 1) : leadCurrent;
  }, [leadCurrent, leadModels, leadName]);

  const othersConfigured = React.useMemo(
    () =>
      primary.filter(
        (a) => norm(a.agentName) !== norm(leadName) && !!currentModelFor(modelState, a.agentName),
      ).length,
    [primary, leadName, modelState],
  );

  // Active agent selected in the left rail of the popover
  const activeAgent = React.useMemo(() => {
    if (selectedAgentName) {
      const match = onlineAgents.find((a) => norm(a.agentName) === norm(selectedAgentName));
      if (match) return match;
    }
    return leadAgent || primary[0] || onlineAgents[0] || null;
  }, [selectedAgentName, onlineAgents, leadAgent, primary]);

  const activeAgentName = activeAgent?.agentName || '';
  const activeModels = React.useMemo(() => {
    return activeAgentName ? modelsFor(modelState, activeAgentName) : [];
  }, [modelState, activeAgentName]);
  const activeCurrentModel = activeAgentName ? currentModelFor(modelState, activeAgentName) : undefined;

  // Derive quick category filter tags for the currently selected agent
  const categories = React.useMemo(() => {
    if (!activeModels.length) return [];
    const cats: { id: string; label: string; count: number; isFree?: boolean }[] = [
      { id: 'all', label: 'All', count: activeModels.length },
    ];

    const freeCount = activeModels.filter(
      (m) => m.id.toLowerCase().includes('free') || m.name.toLowerCase().includes('free'),
    ).length;
    if (freeCount > 0) {
      cats.push({ id: 'free', label: 'Free', count: freeCount, isFree: true });
    }

    const providerMap: Record<string, { label: string; count: number }> = {};
    for (const m of activeModels) {
      const cleanP = extractSubProvider(m);
      if (cleanP) {
        if (!providerMap[cleanP]) {
          providerMap[cleanP] = { label: formatProviderName(cleanP), count: 0 };
        }
        providerMap[cleanP].count++;
      }
    }

    const sortedProviders = Object.entries(providerMap)
      .filter(([_, data]) => data.count >= 1)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 7);

    for (const [key, data] of sortedProviders) {
      cats.push({ id: key, label: data.label, count: data.count });
    }

    return cats;
  }, [activeModels]);

  // Filtered models for display
  const displayedModels = React.useMemo(() => {
    let list = activeModels;

    if (activeCategory === 'free') {
      list = list.filter(
        (m) => m.id.toLowerCase().includes('free') || m.name.toLowerCase().includes('free'),
      );
    } else if (activeCategory !== 'all') {
      list = list.filter((m) => extractSubProvider(m) === activeCategory);
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.provider && m.provider.toLowerCase().includes(q)) ||
          (m.shortName && m.shortName.toLowerCase().includes(q)),
      );
    }

    return list;
  }, [activeModels, activeCategory, searchQuery]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      void load();
      if (!selectedAgentName || !onlineAgents.some((a) => norm(a.agentName) === norm(selectedAgentName))) {
        setSelectedAgentName(leadName);
      }
    } else {
      setSearchQuery('');
      setActiveCategory('all');
    }
  };

  const handleSelectModel = async (
    targetAgentName: string,
    modelId: string,
    modelName: string,
  ) => {
    const previousId = currentModelFor(modelState, targetAgentName);
    setCurrentModel(targetAgentName, modelId);

    try {
      if (workspaceId) workspaceApi.setWorkspaceId(workspaceId);
      await workspaceApi.sendAgentControl(targetAgentName, 'set_model', {
        model: modelId,
        channel: sessionId || undefined,
      });
      rememberForSession(sessionId || 'default', targetAgentName, modelId);
      toast.success(`@${targetAgentName} switched to ${modelName}`);
    } catch (e) {
      setCurrentModel(targetAgentName, previousId);
      const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
      toast.error(`@${targetAgentName} could not switch to ${modelName}${detail}`);
    }
  };

  if (!anyOnline && !agentName) return null;

  const renderAgentButton = (a: (typeof onlineAgents)[number]) => {
    const isSelected = norm(a.agentName) === norm(activeAgentName);
    const isLead = norm(a.agentName) === norm(leadName);
    const currentModel = currentModelFor(modelState, a.agentName);
    const count = modelsFor(modelState, a.agentName).length;

    const displayModel = currentModel
      ? (currentModel.includes('/') ? currentModel.slice(currentModel.indexOf('/') + 1) : currentModel)
      : (count > 0 ? `${count} models` : 'Default');

    return (
      <button
        key={a.agentName}
        type="button"
        onClick={() => {
          setSelectedAgentName(a.agentName);
          setActiveCategory('all');
        }}
        className={cn(
          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer select-none',
          isSelected
            ? 'bg-surface3 text-foreground font-medium ring-1 ring-border shadow-2xs'
            : 'text-foreground-muted hover:text-foreground hover:bg-surface2/70',
        )}
      >
        <AgentAvatar
          name={a.agentName}
          agentType={a.agentType}
          size={24}
          status={a.status}
          showStatus={true}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium truncate">@{a.agentName}</span>
            {isLead && (
              <span className="text-3xs px-1 py-0.2 rounded bg-primary/10 text-primary font-bold uppercase shrink-0">
                lead
              </span>
            )}
          </div>
          <div className="text-3xs text-muted-foreground/80 truncate mt-0.5" title={currentModel || 'Default'}>
            {displayModel}
          </div>
        </div>
      </button>
    );
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!anyOnline}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-2xs font-medium border transition-colors select-none shadow-2xs',
            anyOnline
              ? 'bg-surface2 hover:bg-surface3 border-border text-foreground cursor-pointer'
              : 'bg-surface2/40 border-border/40 text-muted-foreground/60 cursor-not-allowed',
            className,
          )}
          title={
            anyOnline
              ? `@${leadName}: ${leadLabel}${othersConfigured > 0 ? ` · ${othersConfigured} more agent${othersConfigured > 1 ? 's' : ''} set separately` : ''}`
              : offlineHint
          }
        >
          <span className="truncate max-w-[140px]">{anyOnline ? leadLabel : 'Offline'}</span>
          {anyOnline && othersConfigured > 0 && (
            <span className="shrink-0 text-foreground-extra-muted">+{othersConfigured}</span>
          )}
          <ChevronDown
            className={cn(
              'size-3 shrink-0',
              anyOnline ? 'text-foreground-extra-muted' : 'text-muted-foreground/40',
            )}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="p-0 w-[580px] sm:w-[680px] h-[480px] max-h-[85vh] rounded-xl border border-border bg-surface1 shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/60 bg-surface2/40 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <span className="text-xs font-semibold text-foreground">Agent Models</span>
            <span className="text-3xs text-muted-foreground hidden sm:inline">· Configure AI model per agent</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-3xs font-medium px-2 py-0.5 rounded-full bg-surface3 text-muted-foreground border border-border/40">
              {onlineAgents.length} online
            </span>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 text-muted-foreground hover:text-foreground rounded-md hover:bg-surface3 transition-colors cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Master-Detail Body */}
        <div className="flex-1 flex min-h-0 divide-x divide-border/60">
          {/* Left Rail: Agent Selector */}
          <div className="w-[200px] sm:w-[220px] shrink-0 bg-surface2/20 flex flex-col min-h-0 overflow-y-auto p-2 space-y-2">
            {primary.length > 0 && (
              <div className="space-y-1">
                {participantSet.size > 0 && (
                  <div className="px-2 pt-1 pb-0.5 text-3xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
                    In this thread
                  </div>
                )}
                {primary.map(renderAgentButton)}
              </div>
            )}

            {secondary.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-border/40">
                <div className="px-2 pt-1 pb-0.5 text-3xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
                  Other agents
                </div>
                {secondary.map(renderAgentButton)}
              </div>
            )}
          </div>

          {/* Right Panel: Selected Agent Models */}
          <div className="flex-1 flex flex-col min-w-0 bg-surface1 min-h-0">
            {activeAgent ? (
              <>
                {/* Active Agent Info Header */}
                <div className="px-3.5 py-2.5 border-b border-border/50 flex items-center justify-between gap-2 shrink-0 bg-surface1">
                  <div className="flex items-center gap-2 min-w-0">
                    <AgentAvatar
                      name={activeAgent.agentName}
                      agentType={activeAgent.agentType}
                      size={20}
                    />
                    <span className="text-xs font-semibold text-foreground truncate">
                      @{activeAgent.agentName}
                    </span>
                    <span className="text-3xs text-muted-foreground">
                      ({activeModels.length} {activeModels.length === 1 ? 'model' : 'models'})
                    </span>
                  </div>
                  <div className="text-3xs text-muted-foreground shrink-0 flex items-center gap-1">
                    <span>Current:</span>
                    <span
                      className="font-medium text-foreground bg-surface2 px-1.5 py-0.5 rounded border border-border/40 truncate max-w-[150px]"
                      title={activeCurrentModel || 'Default'}
                    >
                      {activeCurrentModel
                        ? (activeCurrentModel.includes('/') ? activeCurrentModel.slice(activeCurrentModel.indexOf('/') + 1) : activeCurrentModel)
                        : 'Default'}
                    </span>
                  </div>
                </div>

                {/* Search & Category Chips */}
                <div className="p-2.5 border-b border-border/50 space-y-2 shrink-0 bg-surface1">
                  <div className="relative flex items-center">
                    <Search className="size-3.5 absolute left-2.5 text-muted-foreground/70 pointer-events-none" />
                    <input
                      type="text"
                      placeholder={`Filter models for @${activeAgent.agentName}... (e.g. free, claude)`}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-7 py-1 text-xs bg-surface2/70 focus:bg-surface2 rounded-md border border-border/60 focus:outline-none focus:ring-1 focus:ring-ring text-foreground placeholder:text-muted-foreground/60"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 text-muted-foreground/60 hover:text-foreground p-0.5 rounded cursor-pointer"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>

                  {categories.length > 1 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none text-3xs">
                      {categories.map((cat) => {
                        const isActive = activeCategory === cat.id;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setActiveCategory(cat.id)}
                            className={cn(
                              'px-2 py-0.5 rounded-full whitespace-nowrap transition-colors flex items-center gap-1 cursor-pointer select-none font-medium',
                              isActive
                                ? 'bg-foreground text-background font-semibold shadow-2xs'
                                : cat.isFree
                                  ? 'bg-status-muted-success text-status-success hover:bg-status-success/25 border border-status-success/30'
                                  : 'bg-surface2 hover:bg-surface3 text-muted-foreground hover:text-foreground border border-border/40',
                            )}
                          >
                            {cat.isFree && <Sparkles className="size-2.5" />}
                            <span>{cat.label}</span>
                            <span className={cn('text-3xs opacity-70', isActive ? 'text-background' : '')}>
                              ({cat.count})
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Model Items List */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
                  {displayedModels.length > 0 ? (
                    displayedModels.map((m) => {
                      const isSelected =
                        !!activeCurrentModel &&
                        (activeCurrentModel === m.id || activeCurrentModel === m.shortName);
                      const isFree =
                        m.id.toLowerCase().includes('free') || m.name.toLowerCase().includes('free');

                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectModel(activeAgent.agentName, m.id, m.name)}
                          className={cn(
                            'w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer text-left',
                            isSelected
                              ? 'bg-surface3 text-foreground font-semibold ring-1 ring-border/80'
                              : 'text-foreground-muted hover:text-foreground hover:bg-surface2',
                          )}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate">{m.name}</span>
                            {isFree && (
                              <span className="text-3xs px-1.5 py-0.2 rounded-full bg-status-muted-success text-status-success font-bold uppercase shrink-0">
                                Free
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 ml-2">
                            {(() => {
                              const subP = extractSubProvider(m);
                              const label = formatProviderName(subP) || (m.provider && !['kilo', 'opencode'].includes(m.provider.toLowerCase()) ? m.provider : '');
                              return label ? (
                                <span className="text-3xs font-normal text-muted-foreground/80">
                                  {label}
                                </span>
                              ) : null;
                            })()}
                            {isSelected ? (
                              <Check className="size-3.5 text-primary" />
                            ) : (
                              <div className="size-3.5" />
                            )}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="py-12 text-center text-xs text-muted-foreground space-y-1">
                      <div>No models found</div>
                      {searchQuery ? (
                        <div className="text-3xs text-muted-foreground/70">
                          No models match &ldquo;{searchQuery}&rdquo;
                        </div>
                      ) : activeModels.length === 0 ? (
                        <div className="text-3xs text-muted-foreground/70">
                          This agent runs on the default environment model
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-6 text-xs text-muted-foreground">
                Select an agent from the left to configure its model.
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
