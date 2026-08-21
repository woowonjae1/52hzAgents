'use client';

/**
 * Local Built-in Web Browser & Dev-Server Preview.
 *
 * Provides a native, full-featured built-in browser panel on the right side:
 * - 100% free, runs entirely inside Electron's isolated <webview> sandbox.
 * - Supports local dev server preview (localhost:3000 / 5173 / 8080) with instant hot reload.
 * - Supports web documentation browsing.
 * - Device viewport switching (Desktop 100% / Mobile 375px).
 * - Graceful offline & auto-detection state when localhost server is not yet running.
 */

import * as React from 'react';
import {
  ArrowLeft, ArrowRight, RefreshCw, ExternalLink, Monitor,
  Smartphone, Terminal, Globe, Loader2, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLayout } from '@/components/layout/layout-context';

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

type Viewport = 'desktop' | 'mobile';

const DEFAULT_URL = 'http://localhost:3000';
const QUICK_PORTS = [3000, 5173, 8080, 8000];

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

export function LocalPreview() {
  const isDesktop =
    typeof window !== 'undefined' &&
    !!(window as unknown as { electronBridge?: unknown }).electronBridge;

  const { previewUrl } = useLayout();

  const [url, setUrl] = React.useState(previewUrl || DEFAULT_URL);
  const [draft, setDraft] = React.useState(previewUrl || DEFAULT_URL);
  const [viewport, setViewport] = React.useState<Viewport>('desktop');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [consoleErrors, setConsoleErrors] = React.useState<string[]>([]);
  const [iframeNonce, setIframeNonce] = React.useState(0);

  const webviewRef = React.useRef<WebviewElement | null>(null);

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
        errorDescription?: string; errorCode?: number;
      };
      if (errorCode === -3) return; // ERR_ABORTED
      setLoadError(errorDescription || '无法连接到本地服务');
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface1">
      {/* ── Modern Chrome Style Clean Toolbar ── */}
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border/60 bg-surface0 shrink-0 select-none">
        {/* Navigation controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => webviewRef.current?.goBack()}
            disabled={!isDesktop}
            title="后退"
            className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors flex items-center justify-center cursor-pointer"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <button
            onClick={() => webviewRef.current?.goForward()}
            disabled={!isDesktop}
            title="前进"
            className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors flex items-center justify-center cursor-pointer"
          >
            <ArrowRight className="size-3.5" />
          </button>
          <button
            onClick={reload}
            title="刷新"
            className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
          >
            {isLoading ? (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </button>
        </div>

        {/* Spacious Address Bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); commit(); }}
          className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 h-7.5 rounded-lg bg-surface2/80 hover:bg-surface2 border border-border/60 focus-within:border-primary/60 focus-within:bg-surface1 transition-all"
        >
          <Globe className="size-3.5 text-muted-foreground shrink-0" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            spellCheck={false}
            placeholder="输入 localhost:3000 或网址..."
            className="flex-1 min-w-0 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground outline-none truncate"
          />
        </form>

        {/* Quick Port Badges */}
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          {QUICK_PORTS.map((port) => {
            const isCurrent = url.includes(`:${port}`);
            return (
              <button
                key={port}
                type="button"
                onClick={() => {
                  const targetUrl = `http://localhost:${port}`;
                  setDraft(targetUrl);
                  setUrl(targetUrl);
                  setLoadError(null);
                  if (!isDesktop) setIframeNonce((n) => n + 1);
                }}
                className={cn(
                  "px-1.5 py-0.5 rounded text-3xs font-mono transition-colors cursor-pointer",
                  isCurrent
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "bg-surface2 text-muted-foreground hover:text-foreground hover:bg-surface3"
                )}
                title={`切换到 :${port}`}
              >
                :{port}
              </button>
            );
          })}
        </div>

        {/* Responsive Viewport & External */}
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex items-center gap-0.5 rounded-lg bg-surface2/70 p-0.5">
            <button
              onClick={() => setViewport('desktop')}
              title="桌面视口 (100%)"
              className={cn(
                'size-6 rounded flex items-center justify-center transition-colors cursor-pointer',
                viewport === 'desktop' ? 'bg-surface0 text-foreground shadow-2xs font-semibold' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Monitor className="size-3" />
            </button>
            <button
              onClick={() => setViewport('mobile')}
              title="手机视口 (375px)"
              className={cn(
                'size-6 rounded flex items-center justify-center transition-colors cursor-pointer',
                viewport === 'mobile' ? 'bg-surface0 text-foreground shadow-2xs font-semibold' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Smartphone className="size-3" />
            </button>
          </div>

          {isDesktop && (
            <button
              onClick={() => webviewRef.current?.openDevTools()}
              title="打开控制台 DevTools"
              className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
            >
              <Terminal className="size-3.5" />
            </button>
          )}

          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="在系统浏览器中打开"
            className="size-7 rounded-lg hover:bg-surface2 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      {/* ── Viewport Canvas & Empty / Offline State ── */}
      <div className="flex-1 min-h-0 overflow-auto bg-surface2/30 flex items-center justify-center relative">
        <div
          className="h-full bg-white transition-all duration-200 relative shadow-sm"
          style={{ width: viewport === 'mobile' ? '375px' : '100%' }}
        >
          {isDesktop ? (
            <Webview
              ref={webviewRef}
              src={url}
              partition="persist:localpreview"
              className="w-full h-full border-0"
              style={{ display: 'flex', width: '100%', height: '100%' }}
            />
          ) : (
            <iframe
              key={iframeNonce}
              src={url}
              className="w-full h-full border-0"
              title={`Local preview: ${url}`}
            />
          )}

          {/* Friendly Overlay when service is not reachable */}
          {loadError && (
            <div className="absolute inset-0 z-20 bg-surface0 flex flex-col items-center justify-center p-6 text-center select-none animate-[fadeIn_0.15s_ease-out]">
              <div className="size-13 rounded-2xl bg-surface2 border border-border/80 flex items-center justify-center mb-3 shadow-2xs">
                <Globe className="size-6 text-foreground-extra-muted" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">本地服务尚未启动</h3>
              <p className="text-xs text-muted-foreground max-w-xs mb-4 font-mono">
                {url} 连接未就绪
              </p>
              <div className="text-2xs text-muted-foreground bg-surface1 border border-border/60 rounded-xl p-3.5 max-w-xs mb-4 text-left space-y-2">
                <p className="font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles className="size-3 text-primary" />
                  <span>快捷启动方式：</span>
                </p>
                <p className="text-foreground/90">在左侧对 Agent 说：<br/><span className="text-primary font-mono font-medium">@claude 帮我启动本地开发服务</span></p>
                <p className="text-foreground/75">或在终端执行 <code className="bg-surface2 px-1 py-0.5 rounded font-mono text-foreground">npm run dev</code></p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={reload}
                  className="px-3.5 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity flex items-center gap-1.5 cursor-pointer shadow-2xs"
                >
                  <RefreshCw className="size-3" />
                  <span>刷新检测</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Console Error Drawer */}
      {isDesktop && consoleErrors.length > 0 && (
        <div className="shrink-0 max-h-24 overflow-auto border-t border-status-danger/20 bg-status-danger/5">
          <div className="px-3 py-1 text-3xs font-medium text-status-danger sticky top-0 bg-surface1/95">
            控制台错误 ({consoleErrors.length})
          </div>
          {consoleErrors.map((msg, i) => (
            <div key={i} className="px-3 py-0.5 text-3xs font-mono text-foreground-muted break-all">
              {msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
