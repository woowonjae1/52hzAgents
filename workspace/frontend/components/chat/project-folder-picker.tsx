'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { FolderClock } from 'lucide-react';

/**
 * wwj (the local agent connector daemon) runs on the actual desktop and can
 * show a genuine native OS folder dialog — no in-page directory browser to
 * build or maintain. Only works when wwj runs on the same machine as this
 * browser tab, which is the only case where "pick a local folder" makes
 * sense in the first place.
 */
const WWJ_BROWSE_URL = process.env.NEXT_PUBLIC_WWJ_BROWSE_URL || 'http://127.0.0.1:47893';

const RECENT_KEY = 'recent_working_dirs';
const RECENT_LIMIT = 5;

/** Directories this browser has started threads in, most recent first. People
 * work out of the same handful of checkouts every day; re-Browsing for them on
 * every new thread was the single most repeated step in the start flow. */
export function recentWorkingDirs(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Record a directory as used. Call when a thread is actually created, not on
 * every keystroke, so half-typed paths never pollute the list. */
export function rememberWorkingDir(dir: string): void {
  const trimmed = dir.trim();
  if (!trimmed) return;
  try {
    const next = [trimmed, ...recentWorkingDirs().filter((d) => d !== trimmed)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

/**
 * Ask native Electron bridge (instant 0ms) or local wwj daemon to show the OS folder dialog.
 * Returns null if the user cancelled.
 */
export async function browseForFolder(defaultPath?: string): Promise<string | null> {
  // 1. In Electron desktop, invoke the native C++ Win32 IFileDialog via Electron IPC (instant popup, 0ms delay)
  const bridge = typeof window !== 'undefined'
    ? (window as unknown as { electronBridge?: { browseFolder?: (defaultPath?: string) => Promise<string | null> } }).electronBridge
    : undefined;

  if (bridge?.browseFolder) {
    try {
      const selected = await bridge.browseFolder(defaultPath);
      return selected;
    } catch (err) {
      console.warn('[Desktop Bridge] Native folder browse failed, falling back to daemon:', err);
    }
  }

  // 2. Fallback to WWJ local daemon if running in a regular web browser tab
  const res = await fetch(`${WWJ_BROWSE_URL}/browse-folder`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const data: { path: string | null } = await res.json();
  return data.path;
}

/** Last segment of a Windows or POSIX path, for compact display. */
export function basename(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

interface ProjectFolderPickerProps {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  helperText?: string;
}

/** Directory field with a native-OS "Browse…" button and recently-used
 * shortcuts, shared by the new-thread dialog and the landing panel's project
 * step so the wwj-browse logic only lives in one place. */
export function ProjectFolderPicker({ value, onChange, placeholder, helperText }: ProjectFolderPickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Read on mount, not during render: localStorage doesn't exist on the server.
  const [recents, setRecents] = useState<string[]>([]);
  useEffect(() => setRecents(recentWorkingDirs()), []);

  const handleBrowse = async () => {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const path = await browseForFolder();
      if (path) onChange(path);
    } catch (e) {
      setBrowseError(
        e instanceof Error
          ? `无法连接本机的 wwj(${e.message})。请确认 \`wwj up\` 正在运行,或直接在上方输入路径。`
          : '打开文件夹选择框失败。'
      );
    } finally {
      setBrowsing(false);
    }
  };

  const suggestions = recents.filter((d) => d !== value.trim());

  return (
    <div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || 'D:\\code\\my-project'}
          className="flex-1 text-sm rounded-lg border border-border bg-card px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Button variant="outline" size="sm" onClick={handleBrowse} disabled={browsing}>
          {browsing ? 'Waiting…' : 'Browse…'}
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <FolderClock className="size-3 text-foreground-extra-muted shrink-0" />
          {suggestions.map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => onChange(dir)}
              title={dir}
              className="max-w-[12rem] truncate rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border-accent hover:text-foreground"
            >
              {basename(dir)}
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 px-0.5 text-[11px] text-muted-foreground/70">
        {helperText || '运行 agent 的机器上的本地绝对路径。该会话里的 agent 会读写这里的文件。'}
      </p>
      {browseError && (
        <p className="mt-1 px-0.5 text-[11px] text-status-danger">{browseError}</p>
      )}
    </div>
  );
}
