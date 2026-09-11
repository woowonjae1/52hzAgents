'use client';

import { Hint } from '@/components/ui/hint';
import { useEffect, useRef, useState } from 'react';
import { Globe, X, RefreshCw, Users, ChevronLeft, Lock, Unlock, Maximize2, Minimize2 } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { stripAddressPrefix } from '@/lib/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PromptDialog } from '@/components/ui/prompt-dialog';

export function BrowserView() {
  const {
    browserTabs, selectedBrowserTabId, setSelectedBrowserTabId,
    closeBrowserTab, navigateBrowserTab, reconnectBrowserTab, persistBrowserTab, unpersistBrowserTab, browserContexts,
    refreshBrowserTabs,
  } = useWorkspace();
  const { isMobile, openMobileList, isDetailExpanded, toggleDetailExpanded } = useLayout();
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [sessionDead, setSessionDead] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  /* Was `window.prompt` / `window.confirm`. Both block the event loop, which
     here means the screenshot poll and the SSE stream freeze behind an OS box
     the user may have pushed behind the window. */
  const [namingSession, setNamingSession] = useState(false);
  const [confirmUnpersist, setConfirmUnpersist] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const prevBlobRef = useRef<string | null>(null);
  const failCountRef = useRef(0);

  const tab = browserTabs.find((t) => t.id === selectedBrowserTabId);

  // Validate live session on mount / tab switch. The backend checks if the
  // BF session is still alive and auto-reconnects if dead, returning fresh
  // tab data (including a new live_url).
  useEffect(() => {
    if (!selectedBrowserTabId || !tab?.liveUrl) return;
    let cancelled = false;

    const validate = async () => {
      setReconnecting(true);
      try {
        await workspaceApi.validateBrowserTab(selectedBrowserTabId);
        if (!cancelled) await refreshBrowserTabs();
      } catch {
        if (!cancelled) setSessionDead(true);
      } finally {
        if (!cancelled) setReconnecting(false);
      }
    };

    validate();
    return () => { cancelled = true; };
  }, [selectedBrowserTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll screenshot every 2 seconds (only when no live URL)
  useEffect(() => {
    if (!selectedBrowserTabId || !tab || tab.liveUrl) {
      setScreenshotUrl(null);
      return;
    }

    let cancelled = false;
    failCountRef.current = 0;
    setSessionDead(false);

    const fetchScreenshot = async () => {
      try {
        const url = workspaceApi.getBrowserScreenshotUrl(selectedBrowserTabId);
        const headers: Record<string, string> = {};
        const token = (workspaceApi as unknown as { token: string }).token;
        if (token) headers['X-Workspace-Token'] = token;
        const bearerToken = (workspaceApi as unknown as { bearerToken: string }).bearerToken;
        if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

        const res = await fetch(url, { headers });
        if (cancelled) return;
        if (!res.ok) {
          failCountRef.current++;
          if (failCountRef.current >= 3) {
            setSessionDead(true);
            setLoading(false);
          }
          return;
        }

        const blob = await res.blob();
        if (cancelled) return;

        failCountRef.current = 0;
        setSessionDead(false);

        if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);

        const blobUrl = URL.createObjectURL(blob);
        prevBlobRef.current = blobUrl;
        setScreenshotUrl(blobUrl);
        setLoading(false);
      } catch {
        failCountRef.current++;
        if (failCountRef.current >= 3) {
          setSessionDead(true);
          setLoading(false);
        }
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const startPolling = () => {
      if (timer !== null || cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      timer = setInterval(fetchScreenshot, 2000);
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopPolling();
      } else {
        fetchScreenshot();
        startPolling();
      }
    };

    setLoading(true);
    fetchScreenshot();
    startPolling();

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (prevBlobRef.current) {
        URL.revokeObjectURL(prevBlobRef.current);
        prevBlobRef.current = null;
      }
    };
  }, [selectedBrowserTabId, tab]);

  const handleReconnect = async () => {
    if (!tab || reconnecting) return;
    setReconnecting(true);
    try {
      await reconnectBrowserTab(tab.id);
      setSessionDead(false);
      failCountRef.current = 0;
      setLoading(true);
      toast.success('Tab reconnected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reconnect');
    } finally {
      setReconnecting(false);
    }
  };

  const startEditingUrl = () => {
    setUrlDraft(tab?.url || '');
    setEditingUrl(true);
    setTimeout(() => urlInputRef.current?.select(), 0);
  };

  const handleNavigate = async () => {
    setEditingUrl(false);
    const trimmed = urlDraft.trim();
    if (!trimmed || !tab || trimmed === tab.url) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    setNavigating(true);
    try {
      await navigateBrowserTab(tab.id, url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to navigate');
    } finally {
      setNavigating(false);
    }
  };

  const handleClose = async () => {
    if (!selectedBrowserTabId) return;
    try {
      await closeBrowserTab(selectedBrowserTabId);
      toast.success('Tab closed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to close tab');
    }
  };

  const handlePersist = async (name: string) => {
    if (!tab || tab.contextId) return;
    try {
      await persistBrowserTab(tab.id, name);
      toast.success(`"${name}" is now persistent`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to make persistent');
      throw err;
    }
  };

  const handleUnpersist = async () => {
    if (!tab || !tab.contextId) return;
    try {
      await unpersistBrowserTab(tab.id);
      toast.success('Tab is now temporal');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove persistent state');
    }
  };

  // No tab selected
  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <Globe className="size-12 mx-auto opacity-20" />
          <p className="text-sm font-medium">Select a browser tab</p>
          <p className="text-xs">Choose a tab from the list or open a new one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PromptDialog
        open={namingSession}
        onOpenChange={setNamingSession}
        title="Name this session"
        description="A persistent session keeps cookies and login state so an agent can come back to this site already signed in."
        placeholder="LinkedIn Account"
        confirmLabel="Make persistent"
        onSubmit={handlePersist}
      />
      <ConfirmDialog
        open={confirmUnpersist}
        onOpenChange={setConfirmUnpersist}
        title="Remove persistent state?"
        targetName={browserContexts.find((c) => c.id === tab.contextId)?.name || 'This tab'}
        description="will go back to being temporal — its saved cookies and login state are deleted."
        confirmLabel="Remove"
        onConfirm={handleUnpersist}
      />
      {/* Header */}
      <div className="flex items-center gap-2 pl-2 lg:pl-4 pr-12 py-2 lg:py-2.5 border-b border-input shrink-0">
        {isMobile && (
          <button
            onClick={openMobileList}
            className="size-8 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground transition-colors shrink-0"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        <Globe className={cn("size-4 shrink-0", navigating ? "text-status-warning animate-pulse" : "text-foreground-muted")} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{tab.title || 'Untitled'}</p>
          {editingUrl ? (
            <input
              ref={urlInputRef}
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => setEditingUrl(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNavigate();
                if (e.key === 'Escape') setEditingUrl(false);
              }}
              className="w-full text-xs bg-surface2 border border-border-accent rounded px-1.5 py-0.5 outline-none focus:border-accent font-mono"
              autoFocus
            />
          ) : (
            <p
              className="text-xs text-muted-foreground truncate cursor-pointer hover:text-foreground transition-colors"
              onClick={startEditingUrl}
              title="Click to edit URL"
            >
              {tab.url}
            </p>
          )}
        </div>

        {/* Shared with badges */}
        {(tab.sharedWith || []).length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <Users className="size-3.5 text-muted-foreground" />
            {(tab.sharedWith || []).map((agent) => (
              <span
                key={agent}
                className="text-3xs px-1.5 py-0.5 rounded-full bg-surface3 text-foreground-muted"
              >
                {agent}
              </span>
            ))}
          </div>
        )}

        <span className="text-3xs text-muted-foreground shrink-0">
          by {stripAddressPrefix(tab.createdBy || 'unknown')}
        </span>

        {tab.contextId ? (
          <Hint label="Remove persistent state — revert to temporal tab">
            <button
              onClick={() => setConfirmUnpersist(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs text-status-success hover:bg-surface2 hover:text-status-warning transition-colors shrink-0"
            >
              <Lock className="size-3" />
              {browserContexts.find((c) => c.id === tab.contextId)?.name || 'persistent'}
            </button>
          </Hint>
        ) : (
          <Hint label="Make persistent — preserve login state for agents to reuse">
            <button
              onClick={() => setNamingSession(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs text-muted-foreground hover:bg-surface2 hover:text-status-success transition-colors shrink-0"
            >
              <Lock className="size-3" />
              Make Persistent
            </button>
          </Hint>
        )}

        <Hint label="Reconnect — create a new browser session">
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="p-1 rounded hover:bg-surface2 text-muted-foreground transition-colors shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={cn("size-4", reconnecting && "animate-spin")} />
          </button>
        </Hint>

        {!isMobile && (
          <Hint label={isDetailExpanded ? 'Restore size' : 'Expand to full page'}>
            <button
              onClick={toggleDetailExpanded}
              className="p-1 rounded hover:bg-surface2 text-muted-foreground transition-colors shrink-0"
            >
              {isDetailExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </Hint>
        )}

        <Hint label="Close tab">
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-surface2 text-muted-foreground hover:text-status-danger transition-colors shrink-0"
          >
            <X className="size-4" />
          </button>
        </Hint>
      </div>

      {/* Browser view area */}
      <div className="flex-1 overflow-auto bg-surface1 flex items-start justify-center">
        {tab.liveUrl && !reconnecting ? (
          <iframe
            src={tab.liveUrl}
            className="w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
            title={`Live browser: ${tab.url}`}
          />
        ) : sessionDead ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center space-y-3">
              <Globe className="size-10 mx-auto opacity-20" />
              <p className="text-sm font-medium">Browser session expired</p>
              <p className="text-xs text-muted-foreground">The remote browser timed out. Click reconnect to start a new session.</p>
              <button
                onClick={handleReconnect}
                disabled={reconnecting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-medium hover:bg-accent-bright disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={cn("size-3.5", reconnecting && "animate-spin")} />
                {reconnecting ? 'Reconnecting…' : 'Reconnect'}
              </button>
            </div>
          </div>
        ) : loading && !screenshotUrl ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <RefreshCw className="size-6 animate-spin" />
          </div>
        ) : screenshotUrl ? (
          <div className="p-4 w-full flex justify-center">
            <img
              src={screenshotUrl}
              alt={`Screenshot of ${tab.url}`}
              className="max-w-full border border-border rounded-lg shadow-sm"
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">No screenshot available</p>
          </div>
        )}
      </div>
    </div>
  );
}
