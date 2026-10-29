"use client";

import * as React from "react";
import {
  ArrowRight,
  Bot,
  FolderGit2,
  Layers3,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { useWorkspace } from "@/lib/workspace-context";
import { useLayout } from "@/components/layout/layout-context";
import {
  ProjectFolderPicker,
  basename,
  recentWorkingDirs,
  rememberWorkingDir,
} from "@/components/chat/project-folder-picker";
import { SidebarExpandButton } from "@/components/layout/sidebar-expand-button";
import { HomeDashboard } from "./home-dashboard";
import { getSmartSessionTitle } from "@/components/threads/thread-list";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Project entry and agent configuration share a destination, but not a screen. */
export function ProjectHome() {
  const {
    sessions,
    activeProjectDir,
    setActiveProjectDir,
    createSession,
    setCurrentSessionId,
    lastMessageBySession,
    activeSessionIds,
  } = useWorkspace();
  const { setViewMode, isMobile, openMobileDetail } = useLayout();
  const [tab, setTab] = React.useState<"projects" | "agents">("projects");
  const [folder, setFolder] = React.useState(activeProjectDir || "");
  const [recents, setRecents] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  React.useEffect(() => setRecents(recentWorkingDirs()), []);
  React.useEffect(() => setFolder(activeProjectDir || ""), [activeProjectDir]);
  const available = React.useMemo(
    () =>
      sessions.filter((s) => s.status !== "deleted" && s.status !== "archived"),
    [sessions],
  );
  const projects = React.useMemo(
    () => [
      ...new Set([
        ...recents,
        ...available.flatMap((s) => (s.workingDir ? [s.workingDir] : [])),
      ]),
    ],
    [recents, available],
  );
  const filtered = available
    .filter(
      (s) =>
        (!activeProjectDir || s.workingDir === activeProjectDir) &&
        `${s.title} ${s.workingDir || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (b.lastEventAt || Date.parse(b.createdAt || "") || 0) -
        (a.lastEventAt || Date.parse(a.createdAt || "") || 0),
    );

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const dir = folder.trim();
      if (dir) rememberWorkingDir(dir);
      setActiveProjectDir(dir || null);
      const session = await createSession({ workingDir: dir || undefined });
      setCurrentSessionId(session.sessionId);
      setViewMode("threads");
      if (isMobile) openMobileDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open session");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface0"
      data-testid="project-home"
    >
      <header className="app-header px-4 gap-3">
        <SidebarExpandButton />
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label="Workspace views"
        >
          {(["projects", "agents"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`workspace-${value}`}
              id={`workspace-tab-${value}`}
              onClick={() => setTab(value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs transition-colors",
                tab === value
                  ? "bg-surface2 text-foreground font-medium"
                  : "text-foreground-muted hover:text-foreground",
              )}
            >
              {value === "projects" ? "Workspace" : "Agent team"}
            </button>
          ))}
        </div>
        <span className="ml-auto hidden sm:flex items-center gap-1.5 text-[10px] text-foreground-extra-muted">
          <span className="size-1.5 rounded-full bg-status-success" />
          Local workspace
        </span>
      </header>
      {tab === "agents" ? (
        <div
          id="workspace-agents"
          role="tabpanel"
          aria-labelledby="workspace-tab-agents"
          className="min-h-0 flex-1"
        >
          <HomeDashboard />
        </div>
      ) : (
        <div
          id="workspace-projects"
          role="tabpanel"
          aria-labelledby="workspace-tab-projects"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto max-w-5xl px-6 py-10 lg:px-12 lg:py-14 space-y-10">
            <section className="space-y-5">
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-widest uppercase text-foreground-extra-muted">
                <Layers3 className="size-4" />
                52hzAgents / Workspace
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Your project. Your next session.
                </h1>
                <p className="mt-3 text-sm leading-6 text-foreground-muted">
                  Open a local project, continue a conversation, and keep your
                  work in one place.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-surface1 p-5 space-y-4">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <FolderGit2 className="size-4 text-foreground-muted" />
                  Project folder
                  <span className="ml-auto text-[10px] font-normal text-foreground-extra-muted">
                    Optional for chat
                  </span>
                </div>
                <ProjectFolderPicker
                  value={folder}
                  onChange={setFolder}
                  helperText="Each new session keeps its own project folder."
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                  <button
                    type="button"
                    onClick={() => setTab("agents")}
                    className="inline-flex items-center gap-2 text-xs text-foreground-muted hover:text-foreground"
                  >
                    <Bot className="size-3.5" />
                    Configure agents
                    <ArrowRight className="size-3" />
                  </button>
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => void start()}
                    className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                  >
                    <Plus className="size-3.5" />
                    {starting ? "Opening…" : "New session"}
                  </button>
                </div>
              </div>
            </section>
            {projects.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-medium text-foreground-muted">
                    Projects
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveProjectDir(null)}
                    className="text-[11px] text-foreground-extra-muted hover:text-foreground"
                  >
                    Show all sessions
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {projects.map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => {
                        setActiveProjectDir(dir);
                        setFolder(dir);
                      }}
                      title={dir}
                      aria-pressed={activeProjectDir === dir}
                      className={cn(
                        "min-w-0 rounded-xl border p-4 text-left transition-colors",
                        activeProjectDir === dir
                          ? "border-foreground-muted bg-surface2"
                          : "border-border hover:bg-surface1",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <FolderGit2 className="size-4 shrink-0 text-foreground-muted" />
                        <span className="truncate text-sm font-medium">
                          {basename(dir)}
                        </span>
                      </div>
                      <p className="mt-2 truncate text-[10px] font-mono text-foreground-extra-muted">
                        {dir}
                      </p>
                      <p className="mt-3 text-[11px] text-foreground-muted">
                        {available.filter((s) => s.workingDir === dir).length}{" "}
                        sessions
                      </p>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xs font-medium text-foreground-muted">
                  {activeProjectDir
                    ? `${basename(activeProjectDir)} sessions`
                    : "Recent sessions"}
                </h2>
                <label className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                  <Search className="size-3 text-foreground-extra-muted" />
                  <input
                    aria-label="Search recent sessions"
                    placeholder="Find a session…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-36 bg-transparent text-xs outline-none"
                  />
                </label>
              </div>
              <div className="divide-y divide-border/60">
                {filtered.slice(0, 12).map((s) => (
                  <button
                    key={s.sessionId}
                    type="button"
                    onClick={() => {
                      setCurrentSessionId(s.sessionId);
                      setViewMode("threads");
                      if (isMobile) openMobileDetail();
                    }}
                    className="group flex w-full items-center gap-3 rounded-lg px-2 py-3.5 text-left hover:bg-surface1"
                  >
                    <MessageSquare className="size-4 shrink-0 text-foreground-extra-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {getSmartSessionTitle(
                          s,
                          lastMessageBySession[s.sessionId],
                        )}
                      </p>
                      <p className="mt-1 truncate text-[11px] text-foreground-extra-muted">
                        {s.workingDir
                          ? basename(s.workingDir)
                          : "No project folder"}
                      </p>
                    </div>
                    <span className="text-[10px] text-foreground-muted">
                      {activeSessionIds.has(s.sessionId) ? "Running" : "Open"}
                    </span>
                    <ArrowRight className="size-3.5 text-foreground-extra-muted" />
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border px-6 py-9 text-center">
                    <MessageSquare className="mx-auto size-5 text-foreground-extra-muted" />
                    <p className="mt-3 text-xs text-foreground-muted">
                      {query
                        ? "No sessions match your search."
                        : "Your conversations will appear here."}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
