'use client';

import { useEffect, useState } from 'react';
import {
  MessageSquare, BookOpen, Sparkles, CalendarClock, Users,
  Settings, Moon, Sun, KeyRound, Check,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLayout, type ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

/**
 * Destinations, in the order they appear on the rail. These used to be a
 * segmented control (Chats / Knowledge / Skills) with "Scheduled tasks" tacked
 * on underneath as a plain row — four destinations wearing two different visual
 * languages, stacked on top of the list they navigate. One rail, one idiom.
 */
const DESTINATIONS: { id: ViewMode; label: string; icon: typeof MessageSquare }[] = [
  { id: 'threads', label: 'Chats', icon: MessageSquare },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'routines', label: 'Scheduled tasks', icon: CalendarClock },
  { id: 'mission', label: 'Agents', icon: Users },
];

function RailButton({
  label, active, onClick, children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative size-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer',
            active
              ? 'bg-surface2 text-foreground'
              : 'text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60',
          )}
        >
          {/* Active marker on the rail edge, not a filled pill — keeps the
              column quiet when several things are highlighted at once.
              -start-1 (not -2): the sidebar clips at overflow-hidden, and a
              wider offset puts the marker at a negative x where it vanishes. */}
          {active && (
            <span className="absolute -start-1 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-full bg-primary" />
          )}
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function IconRail() {
  const { viewMode, setViewMode } = useLayout();
  const { token } = useWorkspace();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // `resolvedTheme`, not `theme` — `theme` can be the literal 'system', which
  // reads as "not dark" and makes the first toggle click a no-op.
  const isDark = mounted && resolvedTheme === 'dark';

  const handleCopyToken = () => {
    if (!token) {
      toast.error('No management token available');
      return;
    }
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    toast.success('Management token copied');
    setTimeout(() => setTokenCopied(false), 2000);
  };

  return (
    <nav
      aria-label="Workspace sections"
      className="w-12 shrink-0 h-full flex flex-col items-center gap-1 py-2.5 border-e border-border/40 bg-surface0"
    >
      {DESTINATIONS.map(({ id, label, icon: Icon }) => (
        <RailButton
          key={id}
          label={label}
          active={viewMode === id}
          // Re-clicking the current destination returns to the thread list, so
          // the rail is a toggle rather than a one-way trip.
          onClick={() => setViewMode(viewMode === id && id !== 'threads' ? 'threads' : id)}
        >
          <Icon className="size-4" />
        </RailButton>
      ))}

      <div className="flex-1" />

      {token && (
        <RailButton label="Copy management token" onClick={handleCopyToken}>
          {tokenCopied ? <Check className="size-4 text-status-success" /> : <KeyRound className="size-4" />}
        </RailButton>
      )}
      <RailButton
        label={isDark ? 'Light mode' : 'Dark mode'}
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
      >
        {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </RailButton>
      <RailButton
        label="Settings"
        active={viewMode === 'settings'}
        onClick={() => setViewMode(viewMode === 'settings' ? 'threads' : 'settings')}
      >
        <Settings className="size-4" />
      </RailButton>
    </nav>
  );
}
