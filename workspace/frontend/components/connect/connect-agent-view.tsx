'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Copy, Check, ExternalLink, Loader2, Terminal, Cloud, Trash2, MessageSquare, Image as ImageIcon, Volume2, Key, ChevronRight } from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { AgentCatalogEntry, CloudAgentConfig, CloudAgentProvider } from '@/lib/types';
import { AgentIcon, ProviderIcon } from '@/components/icons/agent-icons';
import { getApiBaseUrl } from '@/lib/config';

/**
 * Surface a failed panel load. Silently swallowing these is what let a wrong
 * endpoint path render an empty view with no trace anywhere.
 */
function reportLoadFailure(what: string, reason: unknown) {
  // eslint-disable-next-line no-console
  console.error(`[connect-agent] could not load ${what}:`, reason);
}

// ---------------------------------------------------------------------------
// Brand colors for local agents and cloud providers
// ---------------------------------------------------------------------------

const AGENT_BRANDS: Record<string, { bg: string; text: string }> = {
  claude:    { bg: 'bg-orange-500',  text: 'text-white' },
  codex:     { bg: 'bg-green-600',   text: 'text-white' },
  gemini:    { bg: 'bg-blue-500',    text: 'text-white' },
  openclaw:  { bg: 'bg-violet-600',  text: 'text-white' },
  amp:       { bg: 'bg-rose-500',    text: 'text-white' },
  aider:     { bg: 'bg-status-success', text: 'text-white' },
  goose:     { bg: 'bg-status-warning',   text: 'text-white' },
  cline:     { bg: 'bg-cyan-500',    text: 'text-white' },
  copilot:   { bg: 'bg-indigo-500',  text: 'text-white' },
  opencode:  { bg: 'bg-teal-500',    text: 'text-white' },
  nanoclaw:  { bg: 'bg-pink-500',    text: 'text-white' },
  cursor:    { bg: 'bg-primary',    text: 'text-white' },
  hermes:    { bg: 'bg-yellow-500',  text: 'text-white' },
  kimi:      { bg: 'bg-sky-500',     text: 'text-white' },
  pi:        { bg: 'bg-emerald-600', text: 'text-white' },
  kilo:      { bg: 'bg-indigo-600',  text: 'text-white' },
};

const PROVIDER_BRANDS: Record<string, { bg: string; text: string; accent: string }> = {
  openai:    { bg: 'bg-primary', text: 'text-primary-foreground', accent: 'border-border-accent' },
  google:    { bg: 'bg-blue-500',    text: 'text-white', accent: 'border-blue-300 dark:border-blue-700' },
  xai:       { bg: 'bg-primary', text: 'text-primary-foreground', accent: 'border-border-accent' },
  deepseek:  { bg: 'bg-blue-700',    text: 'text-white', accent: 'border-blue-300 dark:border-blue-700' },
};

function getAgentBrand(name: string) {
  return AGENT_BRANDS[name] || { bg: 'bg-foreground-muted', text: 'text-white' };
}

function getProviderBrand(name: string) {
  return PROVIDER_BRANDS[name] || { bg: 'bg-foreground-muted', text: 'text-white', accent: 'border-border-accent' };
}

function CategoryIcon({ category, className }: { category: string; className?: string }) {
  if (category === 'image') return <ImageIcon className={cn('text-violet-500', className)} />;
  if (category === 'audio') return <Volume2 className={cn('text-status-warning', className)} />;
  return <MessageSquare className={cn('text-foreground-muted', className)} />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectAgentView() {
  const { setViewMode } = useLayout();
  const { workspace, token, refreshWorkspace } = useWorkspace();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const [activeTab, setActiveTab] = useState<'local' | 'cloud'>('local');
  const [loading, setLoading] = useState(true);

  // Local agents
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  // Cloud agents
  const [cloudProviders, setCloudProviders] = useState<CloudAgentProvider[]>([]);
  const [cloudAgents, setCloudAgents] = useState<CloudAgentConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  // Cloud config form
  const [cfgModel, setCfgModel] = useState('');
  const [cfgName, setCfgName] = useState('');
  const [cfgKey, setCfgKey] = useState('');
  const [cfgBaseUrl, setCfgBaseUrl] = useState('');
  const [cfgPrompt, setCfgPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadCloudAgents = () => {
    workspaceApi.listCloudAgents().then(setCloudAgents).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // allSettled, not all: these three requests are independent. With Promise.all
    // a single failure discarded all three results, so the entire view rendered
    // empty with nothing in the console — that is how a wrong endpoint path stayed
    // invisible. Each section now degrades on its own and says why.
    Promise.allSettled([
      workspaceApi.getAgentCatalog(),
      workspaceApi.getCloudProviders(),
      workspaceApi.listCloudAgents(),
    ])
      .then(([catalogResult, providersResult, agentsResult]) => {
        if (cancelled) return;
        if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
        else reportLoadFailure('the agent catalog', catalogResult.reason);
        if (providersResult.status === 'fulfilled') setCloudProviders(providersResult.value);
        else reportLoadFailure('cloud providers', providersResult.reason);
        if (agentsResult.status === 'fulfilled') setCloudAgents(agentsResult.value);
        else reportLoadFailure('connected cloud agents', agentsResult.reason);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Selected local agent detail
  const selectedCatalogEntry = useMemo(
    () => catalog.find((e) => e.name === selectedAgent),
    [catalog, selectedAgent],
  );

  // Selected cloud provider detail
  const selectedProviderInfo = useMemo(
    () => cloudProviders.find((p) => p.name === selectedProvider),
    [cloudProviders, selectedProvider],
  );

  const isCustomProvider = selectedProvider === 'custom';

  // Auto-select first model and generate name when provider changes
  useEffect(() => {
    if (isCustomProvider) {
      setCfgModel('');
      setCfgName('');
    } else if (selectedProviderInfo && selectedProviderInfo.models.length > 0) {
      const first = selectedProviderInfo.models[0];
      setCfgModel(first.id);
      const base = first.label
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setCfgName(base);
    }
    setCfgKey('');
    setCfgBaseUrl('');
    setCfgPrompt('');
    setShowAdvanced(false);
  }, [selectedProviderInfo, isCustomProvider]);

  // Update name when model changes
  useEffect(() => {
    if (!selectedProviderInfo) return;
    const model = selectedProviderInfo.models.find((m) => m.id === cfgModel);
    if (model) {
      setCfgName(model.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [cfgModel, selectedProviderInfo]);

  const handleCopyToken = () => {
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const displayToken = token || '<token>';
  const maskedToken = (token && token.length > 16)
    ? `${token.slice(0, 8)}${'•'.repeat(8)}${token.slice(-4)}`
    : displayToken;

  const handleAddCloudAgent = async () => {
    if (!selectedProvider || !cfgModel || !cfgName || !cfgKey) {
      toast.error('Please fill in all required fields');
      return;
    }
    if (isCustomProvider && !cfgBaseUrl) {
      toast.error('Custom endpoint requires a base URL');
      return;
    }
    setSaving(true);
    try {
      await workspaceApi.addCloudAgent({
        agentName: cfgName,
        provider: selectedProvider,
        model: cfgModel,
        apiKey: cfgKey,
        baseUrl: cfgBaseUrl || undefined,
        systemPrompt: cfgPrompt || undefined,
      });
      toast.success(`Cloud agent "@${cfgName}" added`);
      refreshWorkspace();
      loadCloudAgents();
      setSelectedProvider(null);
      setCfgKey('');
      setCfgPrompt('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add cloud agent');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveCloudAgent = async (agentName: string) => {
    try {
      await workspaceApi.removeCloudAgent(agentName);
      toast.success(`Removed "@${agentName}"`);
      loadCloudAgents();
      refreshWorkspace();
    } catch {
      toast.error('Failed to remove cloud agent');
    }
  };

  return (
    <div className="flex flex-col h-full bg-card text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60 shrink-0">
        <h2 className="text-[11px] font-semibold text-foreground-muted">Connect Agents</h2>
        <button
          onClick={() => setViewMode('threads')}
          className="size-7 flex items-center justify-center rounded-lg hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors"
          title="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Tab bar — Paseo segmented control on surface1, replacing the two
          underline tabs that were built from raw zinc steps. */}
      <div className="flex shrink-0 items-center justify-center border-b border-border bg-surface1 px-4 py-2.5">
        <SegmentedControl
          value={activeTab}
          onValueChange={setActiveTab}
          size="sm"
          options={[
            { value: 'local', label: 'Local Agents', icon: Terminal },
            { value: 'cloud', label: 'Cloud Agents', icon: Cloud },
          ]}
        />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            <span className="text-xs">Loading...</span>
          </div>
        ) : activeTab === 'local' ? (
          <LocalAgentsTab
            catalog={catalog}
            selectedAgent={selectedAgent}
            selectedEntry={selectedCatalogEntry}
            onSelectAgent={setSelectedAgent}
            token={token}
            maskedToken={maskedToken}
            tokenCopied={tokenCopied}
            onCopyToken={handleCopyToken}
            isCopied={isCopied}
            copyToClipboard={copyToClipboard}
          />
        ) : (
          <CloudAgentsTab
            providers={cloudProviders}
            cloudAgents={cloudAgents}
            selectedProvider={selectedProvider}
            selectedProviderInfo={selectedProviderInfo}
            isCustomProvider={isCustomProvider}
            workspaceId={workspace?.workspaceId || ''}
            onSelectProvider={setSelectedProvider}
            cfgModel={cfgModel}
            setCfgModel={setCfgModel}
            cfgName={cfgName}
            setCfgName={setCfgName}
            cfgKey={cfgKey}
            setCfgKey={setCfgKey}
            cfgBaseUrl={cfgBaseUrl}
            setCfgBaseUrl={setCfgBaseUrl}
            cfgPrompt={cfgPrompt}
            setCfgPrompt={setCfgPrompt}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            saving={saving}
            onAdd={handleAddCloudAgent}
            onRemove={handleRemoveCloudAgent}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local Agents Tab
// ---------------------------------------------------------------------------

function LocalAgentsTab({
  catalog,
  selectedAgent,
  selectedEntry,
  onSelectAgent,
  token,
  maskedToken,
  tokenCopied,
  onCopyToken,
  isCopied,
  copyToClipboard,
}: {
  catalog: AgentCatalogEntry[];
  selectedAgent: string | null;
  selectedEntry: AgentCatalogEntry | undefined;
  onSelectAgent: (name: string | null) => void;
  token: string;
  maskedToken: string;
  tokenCopied: boolean;
  onCopyToken: () => void;
  isCopied: boolean;
  copyToClipboard: (text: string) => void;
}) {
  const displayToken = token || '<token>';
  return (
    <div className="p-4 space-y-4">
      {/* Agent grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {catalog.map((entry) => {
          const brand = getAgentBrand(entry.name);
          const isSelected = selectedAgent === entry.name;
          return (
            <button
              key={entry.name}
              onClick={() => onSelectAgent(isSelected ? null : entry.name)}
              className={cn(
                'flex items-center gap-2.5 px-3 py-3 rounded-lg border text-left transition-all shadow-xs',
                isSelected
                  ? 'border-primary bg-surface1/50'
                  : 'border-border/80 dark:border-border/80 hover:border-border-accent hover:bg-surface1/20 dark:hover:bg-primary/10',
              )}
            >
              <div className="size-8 shrink-0 flex items-center justify-center">
                <AgentIcon name={entry.name} size={32} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium leading-tight truncate">{entry.label}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  {entry.builtin ? 'Built-in' : entry.tags?.[0] || 'Open Source'}
                </div>
              </div>
              {isSelected && <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
            </button>
          );
        })}
      </div>

      {/* Selected agent detail */}
      {selectedEntry && (
        <div className="rounded-lg border bg-surface1/50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Header */}
          <div className="px-4 py-3 border-b bg-background">
            <div className="flex items-center gap-3">
              <div className="size-9 flex items-center justify-center shrink-0">
                <AgentIcon name={selectedEntry.name} size={36} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{selectedEntry.label}</h3>
                  {selectedEntry.homepage && (
                    <a
                      href={selectedEntry.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{selectedEntry.description}</p>
              </div>
            </div>
          </div>

          {/* Connection methods */}
          <div className="p-6 flex flex-col items-center text-center space-y-6">
            {/* Agent Large Cover Image */}
            <div className="size-20 flex items-center justify-center rounded-2xl bg-card shadow-md border border-border/60 dark:border-border/80 p-3 relative group overflow-hidden">
              <AgentIcon name={selectedEntry.name} size={52} />
            </div>

            <div className="w-full bg-primary dark:bg-black border border-border rounded-xl p-4 relative group text-left">
              <div className="text-[11px] text-foreground-muted font-mono mb-2">
                Run command to connect:
              </div>
              <pre className="text-primary-foreground text-xs font-mono select-all whitespace-pre-wrap break-all pr-8 leading-relaxed">
                {`wwj connect my-${selectedEntry.name} ${displayToken}`}
              </pre>
              <button
                className="absolute top-3.5 right-3.5 size-6 flex items-center justify-center rounded bg-primary hover:bg-primary text-foreground-extra-muted hover:text-white transition-colors"
                onClick={() => copyToClipboard(`wwj connect my-${selectedEntry.name} ${displayToken}`)}
              >
                {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            </div>

            {/* Token */}
            <div className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Key className="size-3.5" />
                <span>Workspace Token</span>
              </div>
              <button
                onClick={onCopyToken}
                className="flex items-center gap-1 hover:text-foreground font-mono transition-colors"
              >
                <span className="mr-1.5">
                  {maskedToken}
                </span>
                {tokenCopied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hint when nothing selected */}
      {!selectedEntry && (
        <p className="text-center text-xs text-muted-foreground py-4">
          Select an agent above to see connection instructions
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud Agents Tab
// ---------------------------------------------------------------------------

function CloudAgentsTab({
  providers,
  cloudAgents,
  selectedProvider,
  selectedProviderInfo,
  isCustomProvider,
  workspaceId,
  onSelectProvider,
  cfgModel,
  setCfgModel,
  cfgName,
  setCfgName,
  cfgKey,
  setCfgKey,
  cfgBaseUrl,
  setCfgBaseUrl,
  cfgPrompt,
  setCfgPrompt,
  showAdvanced,
  setShowAdvanced,
  saving,
  onAdd,
  onRemove,
}: {
  providers: CloudAgentProvider[];
  cloudAgents: CloudAgentConfig[];
  selectedProvider: string | null;
  selectedProviderInfo: CloudAgentProvider | undefined;
  isCustomProvider: boolean;
  workspaceId: string;
  onSelectProvider: (name: string | null) => void;
  cfgModel: string;
  setCfgModel: (v: string) => void;
  cfgName: string;
  setCfgName: (v: string) => void;
  cfgKey: string;
  setCfgKey: (v: string) => void;
  cfgBaseUrl: string;
  setCfgBaseUrl: (v: string) => void;
  cfgPrompt: string;
  setCfgPrompt: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  saving: boolean;
  onAdd: () => void;
  onRemove: (name: string) => void;
}) {
  const providerGroups = [
    { label: 'Chat Models', names: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'mistral', 'sensenova'] },
    { label: 'Search & Agents', names: ['perplexity', 'manus'] },
    { label: 'Fast Inference', names: ['groq', 'together', 'fireworks', 'openrouter', 'sambanova', 'cerebras'] },
    { label: 'Image & Media', names: ['stability', 'replicate', 'fal', 'elevenlabs'] },
    { label: 'Custom', names: ['custom'] },
  ];

  // When a provider is selected, show config view instead of grid
  if (selectedProviderInfo) {
    return (
      <div className="p-4 space-y-4">
        {/* Back button */}
        <button
          onClick={() => onSelectProvider(null)}
          className="flex items-center gap-1 text-[11px] font-semibold text-foreground-muted hover:text-foreground transition-colors mb-2"
        >
          <ChevronRight className="size-3.5 rotate-180" />
          All providers
        </button>

        <div className="rounded-xl border border-border/80 dark:border-border/80 bg-card overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="px-4 py-3.5 border-b border-border/60/40 bg-surface1/40">
            <div className="flex items-center gap-2.5">
              <div className="size-8 flex items-center justify-center shrink-0">
                <ProviderIcon name={selectedProviderInfo.name} size={32} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground tracking-tight">{selectedProviderInfo.label}</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {isCustomProvider ? 'Connect any OpenAI-compatible endpoint' : 'Configure and add a cloud agent'}
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* Custom endpoint: Base URL */}
            {isCustomProvider && (
              <div className="space-y-1.5">
                <Label htmlFor="cloud-base-url" className="text-[11px] font-semibold text-foreground-extra-muted">Endpoint URL</Label>
                <Input
                  id="cloud-base-url"
                  value={cfgBaseUrl}
                  onChange={(e) => setCfgBaseUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
                />
                <p className="text-[9px] text-muted-foreground">/v1 is appended automatically if needed</p>
              </div>
            )}

            {/* Model selector — list for known providers, text input for custom */}
            {isCustomProvider ? (
              <div className="space-y-1.5">
                <Label htmlFor="cloud-model" className="text-[11px] font-semibold text-foreground-extra-muted">Model Name</Label>
                <Input
                  id="cloud-model"
                  value={cfgModel}
                  onChange={(e) => setCfgModel(e.target.value)}
                  placeholder="e.g. gpt-4o, deepseek-chat, qwen-turbo"
                  className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-[11px] font-semibold text-foreground-extra-muted">Model</Label>
                <div className="grid grid-cols-1 gap-1">
                  {selectedProviderInfo.models.map((m) => {
                    const modelId = m.id;
                    const modelLabel = m.label;
                    const modelCat = m.category;
                    return (
                      <button
                        key={modelId}
                        onClick={() => setCfgModel(modelId)}
                        className={cn(
                          'flex items-center gap-2.5 px-3 py-2 rounded-lg border text-xs text-left transition-colors shadow-xs',
                          cfgModel === modelId
                            ? 'border-primary bg-surface1/50 font-semibold'
                            : 'border-transparent hover:bg-surface2/40 dark:hover:bg-primary/20 text-foreground-muted hover:text-foreground',
                        )}
                      >
                        <CategoryIcon category={modelCat} className="size-3.5 shrink-0 opacity-70" />
                        <span className="flex-1 truncate">{modelLabel}</span>
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {modelCat}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Google OAuth option */}
            {selectedProvider === 'google' && (
              <>
                <button
                  type="button"
                  disabled
                  className="flex items-center justify-center gap-2.5 w-full px-3 py-2.5 rounded-lg border border-border bg-surface1 opacity-60 cursor-not-allowed text-xs font-semibold text-muted-foreground"
                >
                  <svg viewBox="0 0 24 24" className="size-4 shrink-0" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  <span>Sign in with Google</span>
                  <span className="ms-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface3 text-foreground-muted">Coming Soon</span>
                </button>
                <div className="flex items-center gap-3">
                  <div className="flex-1 border-t border-border/50" />
                  <span className="text-[11px] font-mono font-semibold text-muted-foreground">or use API key</span>
                  <div className="flex-1 border-t border-border/50" />
                </div>
              </>
            )}

            {/* Agent name */}
            <div className="space-y-1.5">
              <Label htmlFor="cloud-name" className="text-[11px] font-semibold text-foreground-extra-muted">Agent Name</Label>
              <Input
                id="cloud-name"
                value={cfgName}
                onChange={(e) => setCfgName(e.target.value)}
                placeholder="e.g. chatgpt"
                className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
              />
              <p className="text-[9px] text-muted-foreground">Use this to @mention the agent in chat</p>
            </div>

            {/* API Key */}
            <div className="space-y-1.5">
              <Label htmlFor="cloud-key" className="text-[11px] font-semibold text-foreground-extra-muted">API Key</Label>
              <Input
                id="cloud-key"
                type="password"
                value={cfgKey}
                onChange={(e) => setCfgKey(e.target.value)}
                placeholder="sk-..."
                className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0 font-mono"
              />
            </div>

            {/* Advanced */}
            <div>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-[11px] font-semibold text-foreground-extra-muted hover:text-foreground transition-colors"
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced options
              </button>
              {showAdvanced && (
                <div className="mt-2.5">
                  <Label htmlFor="cloud-prompt" className="text-[11px] font-semibold text-foreground-extra-muted">System Prompt</Label>
                  <Textarea
                    id="cloud-prompt"
                    value={cfgPrompt}
                    onChange={(e) => setCfgPrompt(e.target.value)}
                    placeholder="Custom instructions for this agent..."
                    className="text-xs min-h-[60px] mt-1.5 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
                  />
                </div>
              )}
            </div>

            {/* Add button */}
            <Button
              onClick={onAdd}
              disabled={saving || !cfgName || !cfgKey || !cfgModel || (isCustomProvider && !cfgBaseUrl)}
              className="w-full bg-primary hover:bg-primary text-white dark:hover:bg-surface3 font-semibold h-9 rounded-lg shadow-xs"
              size="sm"
            >
              {saving && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              Add Agent
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Grid view — no provider selected
  return (
    <div className="p-4 space-y-3">
      {providerGroups.map((group) => {
        const groupProviders = group.names
          .map((n) => providers.find((p) => p.name === n))
          .filter(Boolean) as typeof providers;
        if (groupProviders.length === 0) return null;
        return (
          <div key={group.label}>
            <div className="flex items-center gap-2 mb-1.5 px-0.5">
              <span className="text-[9px] font-semibold text-foreground-extra-muted ">{group.label}</span>
              <div className="flex-1 border-t border-border/50" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {groupProviders.map((p) => {
                return (
                  <button
                    key={p.name}
                    onClick={() => onSelectProvider(p.name)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border/80 dark:border-border/80 hover:border-border-accent hover:bg-surface1/20 dark:hover:bg-primary/10 text-left transition-all shadow-xs"
                  >
                    <div className="size-6 shrink-0 flex items-center justify-center">
                      <ProviderIcon name={p.name} size={22} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold leading-tight truncate text-foreground">{p.label || p.name}</div>
                      <div className="text-[9px] text-foreground-extra-muted font-mono mt-0.5">{p.models.length} models</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Connected cloud agents */}
      {cloudAgents.length > 0 && (
        <div className="space-y-2 mt-5">
          <div className="flex items-center gap-2 px-1">
            <span className="text-[9px] font-semibold text-foreground-extra-muted ">Connected</span>
            <div className="flex-1 border-t border-border/50" />
          </div>
          {cloudAgents.map((agent) => {
            const name = agent.agentName || 'agent';
            const providerName = agent.providerId || '';
            const category = agent.category || 'text';
            const apiKey = agent.apiKeyMasked || '';
            return (
              <div
                key={name}
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-border/80 dark:border-border/80 bg-card shadow-xs"
              >
                <div className="size-7 flex items-center justify-center shrink-0">
                  <ProviderIcon name={providerName} size={28} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">@{name}</span>
                    <CategoryIcon category={category} className="size-3 opacity-60" />
                  </div>
                  <div className="text-[9px] font-mono text-foreground-extra-muted mt-0.5">{agent.model}</div>
                </div>
                <span className="text-[10px] text-foreground-extra-muted font-mono pr-2">{apiKey}</span>
                <button
                  onClick={() => onRemove(name)}
                  className="size-6 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-foreground-extra-muted hover:text-status-danger transition-colors"
                  title="Remove"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
