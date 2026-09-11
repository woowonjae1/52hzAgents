'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { useLayout, type ViewMode } from './layout-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { ShortcutsDialog } from './shortcuts-dialog';
import { GOTO_SEQUENCE } from '@/lib/shortcuts';
import { Kbd } from '@/components/ui/kbd';

/** Custom event any surface can fire to open the help sheet. */
export const SHORTCUTS_EVENT = 'app:shortcuts';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

/**
 * The app's one global key handler.
 *
 * Two rules keep it from fighting the components that already listen:
 *
 *   1. Anything with a modifier is handled here and nowhere else.
 *   2. Bare letters the thread list already owns (c, i, j, k, /, 1-9) are
 *      only handled here when the thread list is NOT mounted. It unmounts in
 *      Files, Routines and Settings, which is exactly where those keys used
 *      to go dead. The `[data-thread-list]` attribute is the probe.
 *
 * Deliberately NOT bound: Ctrl/Cmd+N. Chrome and Safari reserve it for a new
 * window and will not let a page preventDefault it, so the two places that
 * printed a Ctrl+N badge were teaching a key the browser eats. The real
 * new-chat key is C, which the app has always implemented.
 */
export function GlobalShortcuts() {
  const {
    isMobile,
    setViewMode,
    openSettings,
    openNewThread,
    sidebarToggle,
    activeRightTab,
    setActiveRightTab,
    isDetailExpanded,
    toggleDetailExpanded,
    selectedAgentName,
    setSelectedAgentName,
  } = useLayout();
  const { isCanvasOpen, closeCanvas } = useArtifacts();
  const { theme, setTheme } = useTheme();

  const [helpOpen, setHelpOpen] = React.useState(false);
  const [pendingPrefix, setPendingPrefix] = React.useState<string | null>(null);
  const prefixTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefixRef = React.useRef<string | null>(null);
  pendingPrefixRef.current = pendingPrefix;

  // Everything the handler touches, read through a ref so the listener is
  // installed once instead of torn down and re-added on every state change in
  // the shell.
  const state = {
    setViewMode,
    openSettings,
    openNewThread,
    sidebarToggle,
    activeRightTab,
    setActiveRightTab,
    isDetailExpanded,
    toggleDetailExpanded,
    selectedAgentName,
    setSelectedAgentName,
    isCanvasOpen,
    closeCanvas,
    theme,
    setTheme,
    helpOpen,
  };
  const handlers = React.useRef(state);
  handlers.current = state;

  const armPrefix = React.useCallback((key: string | null) => {
    if (prefixTimer.current) clearTimeout(prefixTimer.current);
    setPendingPrefix(key);
    pendingPrefixRef.current = key;
    if (key) {
      // A sequence the user walks away from must not still be armed a minute
      // later, silently eating the next letter they type.
      prefixTimer.current = setTimeout(() => {
        pendingPrefixRef.current = null;
        setPendingPrefix(null);
      }, 2000);
    }
  }, []);
  const armPrefixRef = React.useRef(armPrefix);
  armPrefixRef.current = armPrefix;

  React.useEffect(() => {
    const open = () => setHelpOpen(true);
    window.addEventListener(SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHORTCUTS_EVENT, open);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = handlers.current;
      const mod = e.metaKey || e.ctrlKey;
      const typing = isTypingTarget(e.target);

      // -- Chords ---------------------------------------------------------
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();

        if (key === 'b' && !e.shiftKey) {
          e.preventDefault();
          h.sidebarToggle();
          return;
        }
        if (key === '\\' && !e.shiftKey) {
          e.preventDefault();
          if (h.activeRightTab !== null || h.isCanvasOpen) {
            h.setActiveRightTab(null);
            h.closeCanvas();
          } else {
            h.setActiveRightTab('preview');
          }
          return;
        }
        if (key === ',' && !e.shiftKey) {
          e.preventDefault();
          h.openSettings('general');
          return;
        }
        if (key === 'l' && e.shiftKey) {
          e.preventDefault();
          h.setTheme(h.theme === 'dark' ? 'light' : 'dark');
          return;
        }
        return; // every other chord belongs to the browser or to a field
      }

      // -- Escape: close the topmost thing, one layer per press -----------
      if (e.key === 'Escape') {
        if (h.helpOpen) return; // the dialog closes itself
        if (pendingPrefixRef.current) {
          armPrefixRef.current(null);
          return;
        }
        if (typing) return; // fields own their own Escape (clear, blur, cancel)
        if (h.selectedAgentName) {
          e.preventDefault();
          h.setSelectedAgentName(null);
          return;
        }
        if (h.isCanvasOpen || h.activeRightTab !== null) {
          e.preventDefault();
          h.setActiveRightTab(null);
          h.closeCanvas();
          return;
        }
        if (h.isDetailExpanded) {
          e.preventDefault();
          h.toggleDetailExpanded();
        }
        return;
      }

      if (typing || e.altKey) return;

      // -- `g` sequences --------------------------------------------------
      if (pendingPrefixRef.current === 'g') {
        const target = GOTO_SEQUENCE[e.key.toLowerCase()];
        armPrefixRef.current(null);
        if (target) {
          e.preventDefault();
          h.setViewMode(target.view as ViewMode);
        }
        return;
      }
      if (e.key === 'g') {
        e.preventDefault();
        armPrefixRef.current('g');
        return;
      }

      // -- Bare keys ------------------------------------------------------
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      // Keys the thread list owns while it is on screen. See the note above.
      const threadListMounted = !!document.querySelector('[data-thread-list]');
      if (!threadListMounted && e.key === 'c') {
        e.preventDefault();
        h.openNewThread();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => {
    return () => {
      if (prefixTimer.current) clearTimeout(prefixTimer.current);
    };
  }, []);

  return (
    <>
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {/* Sequence feedback. A prefix key with no visible state is a key that
          feels broken for the two seconds it is armed. */}
      {pendingPrefix && !isMobile && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-border bg-surface-overlay/95 backdrop-blur-xl px-3 py-1.5 shadow-xl pointer-events-none">
          <Kbd>{pendingPrefix.toUpperCase()}</Kbd>
          <span className="text-2xs text-foreground-muted">
            go to — t threads · a tasks · m mission · f files · k knowledge · s settings
          </span>
        </div>
      )}
    </>
  );
}
