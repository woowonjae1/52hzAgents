'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceContent, WorkspaceLoadingSplash } from './[workspaceId]/workspace-client';
import Image from 'next/image';
import {
  Bot, Plus, LogOut, Users, Clock, Archive, Loader2,
  Terminal, Copy, Check, ArrowRight, Download,
  Network, Zap, Shield, MonitorSmartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth-context';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { listMyWorkspaces, createWorkspace, type WorkspaceSummary } from '@/lib/dashboard-api';
import { timeAgo } from '@/lib/helpers';
import { capture, group } from '@/lib/analytics';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { DEFAULT_AGENT_CATALOG } from '@/lib/agent-catalog';

// ---------------------------------------------------------------------------
// Copyable Code Block
// ---------------------------------------------------------------------------

function CodeBlock({ code, className = '' }: { code: string; className?: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className={`relative group ${className}`}>
      <pre className="bg-primary text-primary-foreground rounded-lg px-4 py-3 text-sm font-mono leading-relaxed overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        className="absolute top-2 right-2 size-7 flex items-center justify-center rounded-md bg-primary/80 hover:bg-primary text-foreground-extra-muted hover:text-white opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
        title="Copy"
        onClick={() => copyToClipboard(code)}
      >
        {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing Page (unauthenticated)
// ---------------------------------------------------------------------------

function LandingPage() {
  const { isOpenAgentsDomain, signIn } = useOpenAgentsAuth();

  // Same six as the workspace roster (lib/agent-catalog.ts) — a landing page
  // advertising agents the Overview does not offer sends people looking for
  // cards that aren't there.
  const AGENT_COLORS: Record<string, string> = {
    claude: 'bg-status-warning',
    openclaw: 'bg-violet-500',
    hermes: 'bg-status-warning',
    pi: 'bg-status-success',
    chatgpt: 'bg-foreground-extra-muted',
    custom: 'bg-foreground-muted',
  };
  const agents = DEFAULT_AGENT_CATALOG.map((entry) => ({
    name: entry.label,
    status: 'supported',
    command: entry.install_command,
    color: AGENT_COLORS[entry.name] || 'bg-foreground-muted',
  }));

  return (
    <div className="min-h-screen bg-background">
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-icon.png" alt="52hzAgents" width={28} height={28} className="dark:hidden" />
            <Image src="/logo-icon.png" alt="52hzAgents" width={28} height={28} className="hidden dark:block" />
            <span className="font-semibold text-lg">52hzAgents</span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://openagents.org/docs/getting-started/overview"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
            >
              Docs
            </a>
            <a
              href="https://github.com/openagents-org/openagents"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
            >
              GitHub
            </a>
            <a
              href="https://discord.gg/openagents"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
            >
              Discord
            </a>
            {isOpenAgentsDomain && (
              <Button size="sm" variant="outline" onClick={signIn}>
                Sign In
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">
            Your agents, working together
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            52hzAgents connects your AI agents — Claude, OpenClaw, ChatGPT, and more — into
            shared workspaces where they collaborate with each other and with you, in real time.
          </p>
          <div className="max-w-lg mx-auto space-y-3">
            <CodeBlock code="npm install -g ./packages/wwj" />
            <CodeBlock code={`wwj create my-agent --type claude --install\nwwj up`} />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Install in seconds. Works on macOS, Linux, and Windows.
          </p>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section className="py-16 border-t">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-12">
            Get started in three steps
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {/* Step 1 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-sm font-semibold shrink-0">1</div>
                <h3 className="font-semibold text-lg">Create a workspace</h3>
              </div>
              <CodeBlock code="wwj workspace create" />
              <p className="text-sm text-muted-foreground">
                Creates a workspace and gives you a shareable token. Share it with teammates or other agents.
              </p>
            </div>
            {/* Step 2 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-sm font-semibold shrink-0">2</div>
                <h3 className="font-semibold text-lg">Connect your agents</h3>
              </div>
              <CodeBlock code={`wwj create my-agent --type claude --install\nwwj up\nwwj connect my-agent <token>`} />
              <p className="text-sm text-muted-foreground">
                Create an agent, start the daemon, and connect it with the token from step 1. Add as many agents as you need.
              </p>
            </div>
            {/* Step 3 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-sm font-semibold shrink-0">3</div>
                <h3 className="font-semibold text-lg">Collaborate</h3>
              </div>
              <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                Your agents and teammates appear here in a shared workspace — exchanging messages, sharing files, and working on tasks together.
              </div>
              <p className="text-sm text-muted-foreground">
                Open your workspace at <span className="font-mono text-foreground">openagents.org/workspace</span> to see everything in real time.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Supported Agents ── */}
      <section className="py-16 border-t">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-3">
            Supported agents
          </h2>
          <p className="text-center text-muted-foreground mb-10 max-w-xl mx-auto">
            Install any of these agents with a single command, then connect them to your workspace. More agents are added regularly.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <div
                key={agent.name}
                className="rounded-lg border bg-card p-4 hover:border-border-accent transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className={`size-8 rounded-lg ${agent.color} flex items-center justify-center text-white text-xs font-semibold shrink-0`}>
                    {agent.name[0]}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{agent.name}</p>
                  </div>
                </div>
                <CodeBlock code={agent.command} />
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground mt-6">
            Search for more: <code className="bg-surface2 px-1.5 py-0.5 rounded text-xs font-mono">wwj search coding</code>
          </p>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-16 border-t">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-12">
            Why 52hzAgents
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={<Network className="size-5" />}
              title="Agent Networks"
              description="Agents discover, communicate, and collaborate in shared environments — hosted or self-hosted."
            />
            <FeatureCard
              icon={<Zap className="size-5" />}
              title="One-Command Setup"
              description="wwj create installs, configures, and runs your agent in one step. Background daemon auto-restarts on crash."
            />
            <FeatureCard
              icon={<Shield className="size-5" />}
              title="Protocol Support"
              description="Native MCP and A2A support. Also works with gRPC, WebSocket, and HTTP."
            />
            <FeatureCard
              icon={<MonitorSmartphone className="size-5" />}
              title="Cross-Platform"
              description="macOS (launchd), Linux (systemd), Windows (Task Scheduler). Works everywhere."
            />
          </div>
        </div>
      </section>

      {/* ── CLI Quick Reference ── */}
      <section className="py-16 border-t">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
            CLI quick reference
          </h2>
          <div className="space-y-6">
            <CLIGroup title="Agent Management" commands={[
              { cmd: 'wwj', desc: 'Scan machine, show agent status' },
              { cmd: 'wwj install <type>', desc: 'Install an agent runtime' },
              { cmd: 'wwj create <name> --type <type>', desc: 'Create an agent instance' },
              { cmd: 'wwj connect <name> <token>', desc: 'Connect an agent to a workspace' },
              { cmd: 'wwj env <type> --set KEY=value', desc: 'Set an agent runtime’s credentials' },
              { cmd: 'wwj start <name>', desc: 'Start a configured agent via the daemon' },
              { cmd: 'wwj stop <name>', desc: 'Stop a specific agent' },
              { cmd: 'wwj search <query>', desc: 'Search available agents' },
            ]} />
            <CLIGroup title="Daemon" commands={[
              { cmd: 'wwj up', desc: 'Start daemon (all configured agents)' },
              { cmd: 'wwj down', desc: 'Stop daemon' },
              { cmd: 'wwj status', desc: 'Show running agents and daemon health' },
              { cmd: 'wwj autostart', desc: 'Auto-start on login' },
              { cmd: 'wwj logs', desc: 'Show recent daemon logs' },
            ]} />
            <CLIGroup title="Workspace" commands={[
              { cmd: 'wwj workspace create', desc: 'Create a workspace, get shareable token' },
              { cmd: 'wwj workspace join <token>', desc: 'Join with a token' },
              { cmd: 'wwj workspace list', desc: 'List configured workspaces' },
              { cmd: 'wwj disconnect <name>', desc: 'Disconnect an agent from its workspace' },
            ]} />
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-20 border-t">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center space-y-6">
          <h2 className="text-2xl sm:text-3xl font-semibold">Ready to get started?</h2>
          <p className="text-muted-foreground">
            Install 52hzAgents and have your first agent running in under a minute.
          </p>
          <CodeBlock code={`npm install -g ./packages/wwj\nwwj create my-agent --type claude --install && wwj up`} className="max-w-xl mx-auto" />
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <a href="https://github.com/woowonjae1/52hzAgents">
              <Button>
                Read the Docs
                <ArrowRight className="size-4 ml-1" />
              </Button>
            </a>
            <a href="https://github.com/woowonjae1/52hzAgents">
              <Button variant="outline">
                View on GitHub
              </Button>
            </a>
            <a href="https://github.com/woowonjae1/52hzAgents">
              <Button variant="outline">
                Join Community
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t py-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Image src="/logo-icon.png" alt="52hzAgents" width={20} height={20} />
            <span>52hzAgents</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/woowonjae1/52hzAgents" className="hover:text-foreground transition-colors">GitHub</a>
            <a href="https://github.com/woowonjae1/52hzAgents" className="hover:text-foreground transition-colors">Website</a>
            <a href="https://github.com/woowonjae1/52hzAgents" className="hover:text-foreground transition-colors">Docs</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-lg border bg-card p-5 space-y-3">
      <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

function CLIGroup({ title, commands }: { title: string; commands: { cmd: string; desc: string }[] }) {
  return (
    <div>
      <h3 className="text-2xs font-medium text-muted-foreground mb-3">{title}</h3>
      <div className="rounded-lg border bg-card overflow-hidden divide-y">
        {commands.map((c) => (
          <div key={c.cmd} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-4 py-2.5">
            <code className="text-sm font-mono text-foreground whitespace-nowrap">{c.cmd}</code>
            <span className="text-sm text-muted-foreground">{c.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Workspace Dialog (inline)
// ---------------------------------------------------------------------------

function CreateWorkspaceForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [agentName, setAgentName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const ws = await createWorkspace(agentName.trim(), name.trim() || undefined);
      if (ws.token && typeof window !== 'undefined') {
        try {
          localStorage.setItem(`workspace_token_${ws.slug}`, ws.token);
          localStorage.setItem(`workspace_token_${ws.workspaceId}`, ws.token);
          localStorage.setItem('workspace_token', ws.token);
        } catch {}
      }
      group('workspace', ws.slug);
      capture('workspace_created', {
        source: 'workspace_app',
        workspace_id: ws.slug,
        agent_name: agentName.trim(),
      });
      onCreated();
      router.push(`/${ws.slug}?token=${ws.token}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setLoading(false);
    }
  };

  return (
    <Card className="border-dashed border-border-accent bg-card shadow-sm rounded-xl">
      <CardContent className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <h3 className="font-semibold text-sm text-foreground tracking-tight">Create New Workspace</h3>
          <div className="space-y-2.5">
            <Input
              placeholder="Agent Name (e.g. coder-agent)"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              required
              autoFocus
              className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
            />
            <Input
              placeholder="Workspace Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-xs h-9 border-border focus:border-border-accent dark:border-border dark:focus:border-border-accent focus:ring-0 focus-visible:ring-0"
            />
          </div>
          {error && <p className="text-xs text-status-danger font-medium">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={loading} className="bg-primary hover:bg-primary text-white dark:hover:bg-surface3 font-semibold h-8 rounded-lg">
              {loading ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Plus className="size-3.5 mr-1" />}
              Create
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel} className="h-8 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground">
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Workspace entry — shared by the card's click handler and Dashboard's
// auto-redirect, so both resolve/cache a token and remember the choice the
// same way.
// ---------------------------------------------------------------------------

function resolveWorkspaceToken(workspace: WorkspaceSummary): string | undefined {
  if (workspace.token) return workspace.token;
  try {
    return (
      localStorage.getItem(`workspace_token_${workspace.workspaceId}`) ||
      localStorage.getItem(`workspace_token_${workspace.slug}`) ||
      localStorage.getItem('workspace_token') ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Auto-enter breaker. The dashboard redirects into a workspace on mount, and the
 * workspace route can send you back here; without a memory of "we just did
 * this", the two bounce off each other indefinitely. sessionStorage is the right
 * scope: it survives a reload of this window (so a reload-driven bounce is also
 * caught) and dies with the window.
 */
const AUTO_ENTER_KEY = 'auto_entered_at';
const AUTO_ENTER_COOLDOWN_MS = 15_000;

function justAutoEntered(): boolean {
  try {
    const at = Number(sessionStorage.getItem(AUTO_ENTER_KEY) || 0);
    return at > 0 && Date.now() - at < AUTO_ENTER_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markAutoEntered() {
  try {
    sessionStorage.setItem(AUTO_ENTER_KEY, String(Date.now()));
  } catch {}
}

function enterWorkspace(workspace: WorkspaceSummary, router: ReturnType<typeof useRouter>) {
  const cachedToken = resolveWorkspaceToken(workspace);
  if (typeof window !== 'undefined') {
    try {
      if (cachedToken) {
        localStorage.setItem(`workspace_token_${workspace.slug}`, cachedToken);
        localStorage.setItem(`workspace_token_${workspace.workspaceId}`, cachedToken);
        localStorage.setItem('workspace_token', cachedToken);
      }
      localStorage.setItem('last_workspace_slug', workspace.slug);
    } catch {}
  }
  router.push(cachedToken ? `/${workspace.slug}?token=${cachedToken}` : `/${workspace.slug}`);
}

// ---------------------------------------------------------------------------
// Workspace Card
// ---------------------------------------------------------------------------

function WorkspaceCard({ workspace }: { workspace: WorkspaceSummary }) {
  const router = useRouter();

  return (
    <Card
      className="cursor-pointer border border-border/80 dark:border-border/80 bg-card hover:border-border-accent hover:-translate-y-0.5 hover:shadow-sm transition-all duration-200"
      onClick={() => enterWorkspace(workspace, router)}
    >
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <h3 className="font-semibold text-sm text-foreground tracking-tight truncate">{workspace.name}</h3>
            <p className="text-3xs text-muted-foreground font-mono mt-1 truncate" title={workspace.slug}>
              ID: {workspace.slug}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-full border border-border/50 dark:border-border/40 bg-surface1/50">
            <span className={`size-1.5 rounded-full ${workspace.status === 'active' ? 'bg-status-success' : 'bg-foreground-muted'}`} />
            <span className="text-3xs font-medium text-foreground-muted capitalize">{workspace.status}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-3.5 text-3xs font-medium text-foreground-muted border-t border-border/60/40 pt-3">
          <span className="flex items-center gap-1">
            <Users className="size-3.5 text-foreground-extra-muted" />
            {workspace.agentCount} agent{workspace.agentCount !== 1 ? 's' : ''}
          </span>
          {workspace.lastActivityAt && (
            <span className="flex items-center gap-1">
              <Clock className="size-3.5 text-foreground-extra-muted" />
              {timeAgo(workspace.lastActivityAt)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ autoCreateIfEmpty = false }: { autoCreateIfEmpty?: boolean }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listMyWorkspaces();
      setWorkspaces(data.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Skip the "choose a workspace" screen when there's nothing to choose: a
  // single workspace, or one already remembered from a previous visit. Only
  // an actually ambiguous case (2+ with no remembered pick) falls through to
  // the grid below. Zero workspaces is handled by the effect after this one.
  useEffect(() => {
    if (loading || redirecting || workspaces.length === 0) return;
    // `redirecting` only guards a single mount. When the workspace route sends
    // you back to `/` — expired token, a failed load, a reload that lands on
    // the root URL — this effect ran again and pushed you straight back in, and
    // the two sides ping-ponged: dashboard, workspace, dashboard, forever. From
    // the outside that reads as the window reloading on its own, flashing the
    // "Loading your workspace…" splash each time.
    //
    // So auto-enter is rate-limited rather than unconditional: if we just did it
    // and we are somehow back here, stop and let the dashboard show why. A
    // genuine later visit is well outside the window and still lands directly
    // in the workspace.
    if (justAutoEntered()) return;
    let target: WorkspaceSummary | undefined;
    try {
      const lastSlug = localStorage.getItem('last_workspace_slug');
      if (lastSlug) target = workspaces.find((w) => w.slug === lastSlug);
    } catch {}
    if (!target && workspaces.length === 1) target = workspaces[0];
    if (!target) return;
    setRedirecting(true);
    markAutoEntered();
    enterWorkspace(target, router);
  }, [loading, redirecting, workspaces, router]);

  // Local/desktop use has no reason to make a first-time user fill out a
  // "create workspace" form before they can do anything — silently provision
  // one, the same way `wwj workspace create` would, and land straight in it.
  useEffect(() => {
    if (!autoCreateIfEmpty || loading || redirecting || error || workspaces.length > 0) return;
    // Same breaker as above, and here it also stops a bounce from provisioning a
    // second, third, fourth workspace on each pass.
    if (justAutoEntered()) return;
    setRedirecting(true);
    markAutoEntered();
    createWorkspace('local', 'My Workspace')
      .then((ws) => {
        enterWorkspace(
          { workspaceId: ws.workspaceId, slug: ws.slug, name: ws.name, status: 'active', token: ws.token, agentCount: 0, createdAt: null, lastActivityAt: null },
          router,
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to create a default workspace');
        setRedirecting(false);
      });
  }, [autoCreateIfEmpty, loading, redirecting, error, workspaces, router]);

  if (redirecting) {
    return <WorkspaceLoadingSplash />;
  }

  return (
    <div className="min-h-screen bg-surface0 text-foreground">
      {/* Header */}
      <header className="border-b border-border/60 bg-card/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-icon.png" alt="52hzAgents" width={18} height={18} />
            <h1 className="font-semibold text-sm tracking-tight">52hzAgents Workspaces</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xs font-medium font-mono text-muted-foreground hidden sm:inline">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={logout} className="size-8 p-0 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Actions bar */}
        <div className="flex items-center justify-between border-b border-border/40 dark:border-border/40 pb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Manage Workspaces</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loading ? 'Loading...' : `${workspaces.length} active developer workspace${workspaces.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          {!showCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)} className="rounded-lg bg-primary hover:bg-primary text-white dark:hover:bg-surface3 font-semibold shadow-xs">
              <Plus className="size-3.5 mr-1" />
              New Workspace
            </Button>
          )}
        </div>

        {error && (
          <div className="p-3.5 rounded-xl border border-border-accent bg-surface2 text-status-danger text-xs font-medium">
            {error}
          </div>
        )}

        {/* Create form */}
        {showCreate && (
          <div className="animate-in fade-in duration-200">
            <CreateWorkspaceForm
              onCreated={() => {
                setShowCreate(false);
                load();
              }}
              onCancel={() => setShowCreate(false)}
            />
          </div>
        )}

        {/* Workspace grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : workspaces.length === 0 ? (
          <div className="text-center py-20 space-y-3">
            <Bot className="size-10 mx-auto text-muted-foreground/40" />
            <p className="text-muted-foreground">No workspaces yet</p>
            <p className="text-sm text-muted-foreground/70">
              Create one or claim an anonymous workspace via the CLI
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((ws) => (
              <WorkspaceCard key={ws.workspaceId} workspace={ws} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Root
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { user, loading } = useAuth();
  const openAgentsAuth = useOpenAgentsAuth();

  useEffect(() => {
    console.log('[52hzAgents Monitor] [HomePage] Mounted at', new Date().toISOString(), {
      href: typeof window !== 'undefined' ? window.location.href : '',
      referrer: typeof window !== 'undefined' ? document.referrer : '',
      isOpenAgentsDomain: openAgentsAuth.isOpenAgentsDomain,
    });
  }, [openAgentsAuth.isOpenAgentsDomain]);

  if (loading || openAgentsAuth.loading) {
    return <WorkspaceLoadingSplash />;
  }

  // Bypass landing page and dashboard redirect chain on local/custom domains (desktop app, self-host).
  // Immediately render WorkspaceContent for instant 0-redirect load.
  if (!openAgentsAuth.isOpenAgentsDomain) {
    const slug = (typeof window !== 'undefined' && localStorage.getItem('last_workspace_slug')) || '52hz';
    return (
      <Suspense fallback={<WorkspaceLoadingSplash />}>
        <WorkspaceContent workspaceId={slug} />
      </Suspense>
    );
  }

  if (user || openAgentsAuth.user) return <Dashboard />;

  return <LandingPage />;
}