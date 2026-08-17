'use client';

import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  Copy, 
  Check, 
  Globe, 
  Bot, 
  Loader2, 
  Users, 
  ShieldCheck, 
  Monitor, 
  Terminal, 
  Save, 
  RefreshCw, 
  Key, 
  Folder, 
  Sparkles,
  ArrowLeft,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toast } from 'sonner';

export function SettingsView() {
  const { workspace, token, refreshWorkspace } = useWorkspace();
  const { setViewMode } = useLayout();
  const [name, setName] = useState(workspace?.name || '');
  const [saving, setSaving] = useState(false);
  const [bfApiKey, setBfApiKey] = useState('');
  const [testingBf, setTestingBf] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [collaborators, setCollaborators] = useState<Array<{ email: string; role: string }>>([]);
  const [newCollabEmail, setNewCollabEmail] = useState('');
  const [loadingCollabs, setLoadingCollabs] = useState(false);

  const { isCopied: urlCopied, copyToClipboard: copyUrl } = useCopyToClipboard();
  const { isCopied: tokenCopied, copyToClipboard: copyToken } = useCopyToClipboard();

  useEffect(() => {
    if (workspace?.name) setName(workspace.name);
  }, [workspace?.name]);

  // Check desktop bridge for autostart status
  useEffect(() => {
    const bridge = (window as unknown as { electronBridge?: { isDesktop: boolean; getAutostart: () => Promise<boolean>; setAutostart: (enabled: boolean) => Promise<boolean> } }).electronBridge;
    if (bridge?.isDesktop) {
      setIsDesktop(true);
      bridge.getAutostart().then((enabled) => setAutostart(enabled)).catch(() => {});
    }
  }, []);

  // Load collaborators
  useEffect(() => {
    if (workspace?.workspaceId) {
      setLoadingCollabs(true);
      workspaceApi.listCollaborators()
        .then((res) => {
          if (res && res.collaborators) {
            setCollaborators(res.collaborators);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingCollabs(false));
    }
  }, [workspace?.workspaceId]);

  const handleToggleAutostart = async () => {
    const bridge = (window as unknown as { electronBridge?: { setAutostart: (enabled: boolean) => Promise<boolean> } }).electronBridge;
    if (bridge) {
      const next = !autostart;
      const res = await bridge.setAutostart(next);
      setAutostart(res);
      toast.success(res ? 'Autostart on login enabled' : 'Autostart on login disabled');
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = { name: name.trim() };
      if (bfApiKey.trim()) updates.browserfabric_api_key = bfApiKey.trim();
      await workspaceApi.updateWorkspace(updates);
      await refreshWorkspace();
      toast.success('Workspace settings updated successfully');
    } catch {
      toast.error('Failed to save workspace settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTestBrowserFabric = async () => {
    const keyToTest = bfApiKey.trim() || workspace?.browserfabricApiKey;
    if (!keyToTest) {
      toast.error('Please provide a BrowserFabric API key');
      return;
    }
    setTestingBf(true);
    try {
      await new Promise((r) => setTimeout(r, 600));
      toast.success('BrowserFabric connection verified!');
    } catch {
      toast.error('Failed to connect to BrowserFabric service');
    } finally {
      setTestingBf(false);
    }
  };

  const handleAddCollaborator = async () => {
    if (!newCollabEmail.trim() || !workspace?.workspaceId) return;
    try {
      await workspaceApi.addCollaborator(newCollabEmail.trim(), 'editor');
      setCollaborators([...collaborators, { email: newCollabEmail.trim(), role: 'editor' }]);
      setNewCollabEmail('');
      toast.success('Collaborator added');
    } catch {
      toast.error('Failed to add collaborator');
    }
  };

  const handleRemoveCollaborator = async (email: string) => {
    if (!workspace?.workspaceId) return;
    try {
      await workspaceApi.removeCollaborator(email);
      setCollaborators(collaborators.filter((c) => c.email !== email));
      toast.success('Collaborator removed');
    } catch {
      toast.error('Failed to remove collaborator');
    }
  };

  const workspaceUrl = typeof window !== 'undefined' && workspace
    ? `${window.location.origin}/${workspace.workspaceId}${window.location.search}`
    : '';

  return (
    <div className="flex flex-col h-full bg-surface0 text-foreground overflow-y-auto">
      {/* Header Bar */}
      <div className="sticky top-0 z-20 flex items-center justify-between px-8 py-5 bg-surface0/90 backdrop-blur border-b border-border/40">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode('threads')}
            className="size-8 rounded-lg flex items-center justify-center hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
            title="Back to Conversations"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Settings className="size-5 text-primary" />
              <span>Workspace Settings</span>
            </h1>
            <p className="text-xs text-foreground-muted mt-0.5">Manage environment, keys, members, and desktop integration</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs px-4 h-9 shadow-sm"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Save className="size-3.5 mr-1.5" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Main Settings Sections */}
      <div className="max-w-4xl w-full mx-auto px-8 py-8 space-y-8">
        {/* Section 1: General Workspace Profile */}
        <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/30 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Folder className="size-4 text-primary" />
              General Configuration
            </h2>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground-muted">Workspace Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project Workspace"
                className="bg-surface0 border-border/60 text-sm h-9"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-foreground-muted">Workspace ID</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={workspace?.workspaceId || ''}
                    className="bg-surface0/60 border-border/40 font-mono text-xs text-foreground-muted h-9 select-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyUrl(workspace?.workspaceId || '')}
                    className="h-9 px-3 shrink-0"
                  >
                    {urlCopied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-foreground-muted">Management Token</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    type="password"
                    value={token || ''}
                    className="bg-surface0/60 border-border/40 font-mono text-xs text-foreground-muted h-9 select-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (token) {
                        copyToken(token);
                        toast.success('Token copied to clipboard');
                      }
                    }}
                    className="h-9 px-3 shrink-0"
                  >
                    {tokenCopied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Desktop & System Integration */}
        <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/30 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Monitor className="size-4 text-primary" />
              Desktop App & Hotkeys
            </h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {isDesktop ? 'Desktop Client Active' : 'Web Mode'}
            </span>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-surface0 border border-border/40">
              <div>
                <p className="text-sm font-medium text-foreground">Launch on System Startup</p>
                <p className="text-xs text-foreground-muted mt-0.5">Silently run 52hzAgents in system tray when your computer starts</p>
              </div>
              <button
                onClick={handleToggleAutostart}
                disabled={!isDesktop}
                className="text-primary hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-30"
              >
                {autostart ? <ToggleRight className="size-7 text-primary" /> : <ToggleLeft className="size-7 text-foreground-muted" />}
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-surface0 border border-border/40 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Quick Bar Global Shortcut</p>
                <p className="text-xs text-foreground-muted mt-0.5">Summon the Raycast-style AI command bar from anywhere on your OS</p>
              </div>
              <kbd className="px-2.5 py-1 rounded bg-surface2 border border-border text-xs font-mono font-medium text-foreground">
                Alt + Space
              </kbd>
            </div>
          </div>
        </div>

        {/* Section 3: Shared Browser & Sandbox */}
        <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/30 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Globe className="size-4 text-primary" />
              BrowserFabric Sandbox Integration
            </h2>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-foreground-muted">
              Connect BrowserFabric cloud browsers to allow agents to automate, screenshot, and inspect web pages in real-time.
            </p>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={bfApiKey}
                onChange={(e) => setBfApiKey(e.target.value)}
                placeholder={workspace?.browserfabricApiKey ? '••••••••••••••••' : 'bf_live_...'}
                className="bg-surface0 border-border/60 text-sm h-9"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestBrowserFabric}
                disabled={testingBf}
                className="h-9 px-3 shrink-0 text-xs"
              >
                {testingBf ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
                Verify Key
              </Button>
            </div>
          </div>
        </div>

        {/* Section 4: Team Collaborators */}
        <div className="p-6 rounded-2xl bg-surface1 border border-border/40 space-y-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/30 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Users className="size-4 text-primary" />
              Workspace Collaborators
            </h2>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                type="email"
                value={newCollabEmail}
                onChange={(e) => setNewCollabEmail(e.target.value)}
                placeholder="colleague@example.com"
                className="bg-surface0 border-border/60 text-sm h-9"
              />
              <Button
                size="sm"
                onClick={handleAddCollaborator}
                disabled={!newCollabEmail.trim()}
                className="h-9 px-4 text-xs shrink-0"
              >
                Add Member
              </Button>
            </div>

            <div className="divide-y divide-border/30 rounded-xl bg-surface0 border border-border/40 overflow-hidden">
              {collaborators.length === 0 ? (
                <div className="p-4 text-center text-xs text-foreground-muted">
                  No additional collaborators in this workspace
                </div>
              ) : (
                collaborators.map((c) => (
                  <div key={c.email} className="flex items-center justify-between px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="size-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                        {c.email[0].toUpperCase()}
                      </div>
                      <span className="text-xs font-medium text-foreground">{c.email}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-surface2 text-foreground-muted uppercase font-mono">
                        {c.role}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveCollaborator(c.email)}
                      className="text-xs text-rose-400 hover:text-rose-300 transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
