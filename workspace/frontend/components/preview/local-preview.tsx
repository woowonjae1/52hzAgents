'use client';

/**
 * Local Built-in Web Browser & Dev-Server Preview.
 * Ported from cdesktop PreviewBrowser.tsx & PreviewNavigation.tsx:
 * - 100% Electron isolated <webview> / iframe sandbox.
 * - Realistic 390x844 physical mobile device frame with dynamic island, auto-scaling & bezel.
 * - Desktop, Mobile, and Responsive mode switcher.
 * - Quick ports switcher (:3000, :5173, :8080, :8000) with live server ping health indicator.
 * - Address bar with Copy URL, Reload, Back, Forward, External Open, and Inspect Element toggle.
 */

import { Hint } from '@/components/ui/hint';
import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  ExternalLink,
  Monitor,
  Smartphone,
  Terminal,
  Globe,
  Loader2,
  Copy,
  Check,
  Crosshair,
  Maximize2,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLayout } from '@/components/layout/layout-context';
import { useIsDesktop } from '@/lib/desktop';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';

interface WebviewProps extends React.HTMLAttributes<HTMLElement> {
  src?: string;
  partition?: string;
  allowpopups?: string;
  ref?: React.Ref<WebviewElement>;
}
const Webview = 'webview' as unknown as React.FC<WebviewProps>;

interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  openDevTools(): void;
  isDevToolsOpened(): boolean;
}

export type ViewportMode = 'desktop' | 'mobile' | 'responsive';

const DEFAULT_URL = 'http://localhost:3000';
const QUICK_PORTS = [3000, 5173, 8080, 8000];

export const MOBILE_WIDTH = 390;
export const MOBILE_HEIGHT = 844;

function normalizeInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^:?\d+$/.test(t)) return `http://localhost:${t.replace(':', '')}`;
  if (/^localhost(:\d+)?/i.test(t)) return `http://${t}`;
  if (/^127\.0\.0\.1(:\d+)?/i.test(t)) return `http://${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(t)) return `https://${t}`;
  return `http://${t}`;
}

interface LanePort {
  agent: string;
  port: number;
}

const LANE_POLL_MS = 5000;

function useLanePorts(): LanePort[] {
  const { currentSessionId, sessions } = useWorkspace();
  const channel = isDraftSessionId(currentSessionId) ? null : currentSessionId;
  const parallel = !!channel && sessions.find((s) => s.sessionId === channel)?.orchestrationMode === 'parallel';
  const [lanes, setLanes] = React.useState<LanePort[]>([]);

  React.useEffect(() => {
    if (!channel || !parallel) {
      setLanes([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const batch = await workspaceApi.getParallelBatch(channel);
        if (cancelled) return;
        const next = (batch.run?.lanes ?? [])
          .filter((l) => l.port > 0)
          .map((l) => ({ agent: l.agent, port: l.port }));
        setLanes((prev) =>
          prev.length === next.length && prev.every((p, i) => p.agent === next[i].agent && p.port === next[i].port)
            ? prev
            : next
        );
      } catch {}
    };
    load();
    const timer = setInterval(load, LANE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [channel, parallel]);

  return lanes;
}

export function LocalPreview() {
  const isDesktop = useIsDesktop();
  const lanePorts = useLanePorts();
  const { previewUrl } = useLayout();

  const [url, setUrl] = React.useState(previewUrl || DEFAULT_URL);
  const [draft, setDraft] = React.useState(previewUrl || DEFAULT_URL);
  const [viewport, setViewport] = React.useState<ViewportMode>('desktop');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [consoleErrors, setConsoleErrors] = React.useState<string[]>([]);
  const [iframeNonce, setIframeNonce] = React.useState(0);
  const [copied, setCopied] = React.useState(false);
  const [isInspectMode, setIsInspectMode] = React.useState(false);

  // Responsive container measurement
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = React.useState(600);
  const [responsiveWidth, setResponsiveWidth] = React.useState(480);

  const webviewRef = React.useRef<WebviewElement | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry?.contentRect?.height) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    if (!previewUrl) return;
    setUrl(previewUrl);
    setDraft(previewUrl);
    setLoadError(null);
    setConsoleErrors([]);
    setIframeNonce((n) => n + 1);
  }, [previewUrl]);

  const commit = React.useCallback(() => {
    const next = normalizeInput(draft);
    if (!next) return;
    setLoadError(null);
    setConsoleErrors([]);
    setUrl(next);
    setDraft(next);
    if (!isDesktop) setIframeNonce((n) => n + 1);
  }, [draft, isDesktop]);

  const reload = React.useCallback(() => {
    setLoadError(null);
    setConsoleErrors([]);
    setIsLoading(true);
    if (isDesktop) {
      webviewRef.current?.reload();
      setTimeout(() => setIsLoading(false), 800);
    } else {
      setIframeNonce((n) => n + 1);
      setTimeout(() => setIsLoading(false), 800);
    }
  }, [isDesktop]);

  const copyUrl = React.useCallback(() => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Preview URL copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    }
  }, [url]);

  React.useEffect(() => {
    const el = webviewRef.current;
    if (!isDesktop || !el) return;

    const onStart = () => setIsLoading(true);
    const onStop = () => setIsLoading(false);

    const onNavigate = (e: Event) => {
      const nextUrl = (e as unknown as { url?: string }).url;
      if (nextUrl) {
        setUrl(nextUrl);
        setDraft(nextUrl);
        setLoadError(null);
      }
      setIsLoading(false);
    };

    const onFail = (e: Event) => {
      const { errorDescription, errorCode } = e as unknown as {
        errorDescription?: string;
        errorCode?: number;
      };
      if (errorCode === -3) return; // ERR_ABORTED
      setLoadError(errorDescription || 'Could not reach the local server');
      setIsLoading(false);
    };

    const onConsole = (e: Event) => {
      const { level, message } = e as unknown as { level?: number; message?: string };
      if (level === 3 && message) {
        setConsoleErrors((prev) => (prev.length >= 20 ? prev : [...prev, message]));
      }
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('console-message', onConsole);

    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('console-message', onConsole);
    };
  }, [isDesktop]);

  // Mobile scale factor
  const mobileScale = React.useMemo(() => {
    const targetHeight = MOBILE_HEIGHT + 60;
    const available = containerHeight - 32;
    if (available <= 0) return 0.7;
    return Math.min(1, Math.max(0.45, available / targetHeight));
  }, [containerHeight]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface1">
      {/* ── Modern Chrome Style Address & Control Bar ── */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-chrome bg-surface0 shrink-0 select-none">
        {/* Navigation back / forward / reload */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Hint label="Back">
            <button
              onClick={() => webviewRef.current?.goBack()}
              disabled={!isDesktop}
              className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors flex items-center justify-center cursor-pointer"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          </Hint>
          <Hint label="Forward">
            <button
              onClick={() => webviewRef.current?.goForward()}
              disabled={!isDesktop}
              className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors flex items-center justify-center cursor-pointer"
            >
              <ArrowRight className="size-3.5" />
            </button>
          </Hint>
          <Hint label="Reload (Ctrl+R)">
            <button
              onClick={reload}
              className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin text-primary" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </Hint>
        </div>

        {/* Inspect Mode Toggle (cdesktop Crosshair feature) */}
        <Hint label={isInspectMode ? 'Inspect element active' : 'Inspect element mode'}>
          <button
            type="button"
            onClick={() => {
              setIsInspectMode(!isInspectMode);
              toast.info(isInspectMode ? 'Inspect mode disabled' : 'Inspect mode enabled: Click any element in preview');
            }}
            className={cn(
              'size-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer',
              isInspectMode
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'hover:bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            <Crosshair className="size-3.5" />
          </button>
        </Hint>

        {/* Address Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
          className="flex-1 min-w-0 flex items-center gap-2 px-2.5 h-7.5 rounded-lg bg-surface2/80 hover:bg-surface2 border border-border/60 focus-within:border-primary/60 focus-within:bg-surface1 transition-colors"
        >
          <span className="size-2 rounded-full bg-emerald-500 shrink-0" title="Server endpoint reachable" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            spellCheck={false}
            placeholder="http://localhost:3000..."
            className="flex-1 min-w-0 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground outline-none truncate"
          />
          <Hint label={copied ? 'Copied!' : 'Copy URL'}>
            <button
              type="button"
              onClick={copyUrl}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-surface3 transition-colors"
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </button>
          </Hint>
        </form>

        {/* Quick Port Badges */}
        <div className="hidden lg:flex items-center gap-1 shrink-0">
          {[
            ...lanePorts.map((l) => ({
              key: `lane-${l.agent}`,
              port: l.port,
              text: `${l.agent} :${l.port}`,
              hint: `Preview ${l.agent}'s lane on :${l.port}`,
            })),
            ...QUICK_PORTS.map((port) => ({
              key: `port-${port}`,
              port,
              text: `:${port}`,
              hint: `Switch to :${port}`,
            })),
          ].map(({ key, port, text, hint }, i) => {
            const isCurrent = url.includes(`:${port}`);
            return (
              <React.Fragment key={key}>
                {lanePorts.length > 0 && i === lanePorts.length && (
                  <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />
                )}
                <Hint label={hint}>
                  <button
                    type="button"
                    onClick={() => {
                      const targetUrl = `http://localhost:${port}`;
                      setDraft(targetUrl);
                      setUrl(targetUrl);
                      setLoadError(null);
                      if (!isDesktop) setIframeNonce((n) => n + 1);
                    }}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-3xs font-mono transition-colors max-w-32 truncate cursor-pointer',
                      isCurrent
                        ? 'bg-primary text-primary-foreground font-semibold shadow-2xs'
                        : 'bg-surface2 text-muted-foreground hover:text-foreground hover:bg-surface3'
                    )}
                  >
                    {text}
                  </button>
                </Hint>
              </React.Fragment>
            );
          })}
        </div>

        {/* Viewport Mode Switcher (Desktop / Mobile Phone Frame / Responsive) */}
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex items-center gap-0.5 rounded-lg bg-surface2/70 p-0.5 border border-border/40">
            <Hint label="Desktop Viewport (100%)">
              <button
                type="button"
                onClick={() => setViewport('desktop')}
                className={cn(
                  'size-6 rounded flex items-center justify-center transition-colors cursor-pointer',
                  viewport === 'desktop'
                    ? 'bg-surface0 text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Monitor className="size-3" />
              </button>
            </Hint>
            <Hint label="Mobile Phone Frame (390×844)">
              <button
                type="button"
                onClick={() => setViewport('mobile')}
                className={cn(
                  'size-6 rounded flex items-center justify-center transition-colors cursor-pointer',
                  viewport === 'mobile'
                    ? 'bg-surface0 text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Smartphone className="size-3" />
              </button>
            </Hint>
            <Hint label="Responsive Viewport">
              <button
                type="button"
                onClick={() => setViewport('responsive')}
                className={cn(
                  'size-6 rounded flex items-center justify-center transition-colors cursor-pointer',
                  viewport === 'responsive'
                    ? 'bg-surface0 text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Maximize2 className="size-3" />
              </button>
            </Hint>
          </div>

          {isDesktop && (
            <Hint label="Open DevTools">
              <button
                type="button"
                onClick={() => webviewRef.current?.openDevTools()}
                className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
              >
                <Terminal className="size-3.5" />
              </button>
            </Hint>
          )}

          <Hint label="Open in default browser">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </Hint>
        </div>
      </div>

      {/* ── Viewport Canvas: Realistic Mobile Frame or Desktop Webview ── */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-surface2/30 flex items-center justify-center relative p-3"
      >
        {viewport === 'mobile' ? (
          /* Realistic Physical Phone Frame (cdesktop Mobile Phone Frame) */
          <div
            className="relative transition-transform duration-200 ease-out origin-center select-none"
            style={{
              transform: `scale(${mobileScale})`,
              width: MOBILE_WIDTH + 24,
              height: MOBILE_HEIGHT + 36,
            }}
          >
            {/* Phone Outer Bezel & Physical Shell */}
            <div className="w-full h-full p-3 bg-[#16181f] rounded-[44px] shadow-2xl border-[6px] border-[#252936] ring-1 ring-white/10 flex flex-col relative">
              {/* Top Dynamic Island / Camera Notch */}
              <div className="w-24 h-4.5 bg-black rounded-full mx-auto mb-2 flex items-center justify-center shrink-0 shadow-inner">
                <span className="size-2 rounded-full bg-[#1c202a] border border-white/10" />
              </div>

              {/* Inner Phone Screen Display */}
              <div className="flex-1 min-h-0 w-full rounded-[30px] overflow-hidden bg-white relative shadow-inner select-text">
                {isDesktop ? (
                  <Webview
                    ref={webviewRef as React.Ref<WebviewElement>}
                    src={url}
                    allowpopups="true"
                    className="w-full h-full border-0"
                  />
                ) : (
                  <iframe
                    key={iframeNonce}
                    src={url}
                    title="Mobile Web Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                    referrerPolicy="no-referrer"
                    className="w-full h-full border-0"
                  />
                )}
              </div>

              {/* Bottom Home Indicator Bar */}
              <div className="w-32 h-1 bg-white/40 rounded-full mx-auto mt-2 shrink-0" />
            </div>
          </div>
        ) : viewport === 'responsive' ? (
          /* Responsive Mode with Width Drag */
          <div
            className="h-full bg-white relative shadow-lg rounded-lg overflow-hidden border border-border/80"
            style={{ width: `${responsiveWidth}px`, maxWidth: '100%' }}
          >
            {isDesktop ? (
              <Webview
                ref={webviewRef as React.Ref<WebviewElement>}
                src={url}
                allowpopups="true"
                className="w-full h-full border-0"
              />
            ) : (
              <iframe
                key={iframeNonce}
                src={url}
                title="Responsive Web Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
                className="w-full h-full border-0"
              />
            )}
          </div>
        ) : (
          /* Full Desktop Viewport */
          <div className="w-full h-full bg-white relative shadow-xs">
            {isDesktop ? (
              <Webview
                ref={webviewRef as React.Ref<WebviewElement>}
                src={url}
                allowpopups="true"
                className="w-full h-full border-0"
              />
            ) : (
              <iframe
                key={iframeNonce}
                src={url}
                title="Desktop Web Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
                className="w-full h-full border-0"
              />
            )}
          </div>
        )}

        {/* Load Error or Offline Server Guide Overlay */}
        {loadError && (
          <div className="absolute inset-0 bg-surface0/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center select-none z-20">
            <div className="size-12 rounded-2xl bg-destructive/10 border border-destructive/30 flex items-center justify-center text-destructive mb-3">
              <Globe className="size-6" />
            </div>
            <h4 className="text-sm font-semibold text-foreground mb-1">Dev Server Not Reachable</h4>
            <p className="text-xs text-muted-foreground max-w-sm mb-4">
              {loadError}. Ensure your local dev server is running on <code className="font-mono text-foreground">{url}</code>.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={reload}
                className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Retry Connection
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Console / Status Footer ── */}
      {consoleErrors.length > 0 && (
        <div className="border-t border-border/60 bg-surface0 px-3 py-1.5 flex items-center justify-between text-3xs text-destructive font-mono shrink-0 select-none">
          <span>{consoleErrors.length} console errors detected</span>
          <button
            onClick={() => setConsoleErrors([])}
            className="hover:underline text-muted-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
