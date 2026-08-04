import React from "react"
import { useTranslation } from "react-i18next"
import { DownloadCloud, Play, Code, TerminalSquare, Globe, Cpu, CheckCircle2, RefreshCw } from "lucide-react"
import AgentIcon from "../AgentIcon"
import { Button } from "../ui/Button"
import { cn } from "../../lib/utils"
import { stageOf } from "../install-progress/StagedProgress"
import type { CatalogEntry } from "../../types"
import type { InstallJob } from "../../store/install"

interface AgentCardProps {
  entry: CatalogEntry
  job: InstallJob | undefined
  hasUpdate: boolean
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
}

function resolveSkillIcon(tag: string): React.JSX.Element | null {
  const t = tag.toLowerCase()
  if (t.includes("coding") || t.includes("code")) return <Code className="size-3" />
  if (t.includes("terminal") || t.includes("cli")) return <TerminalSquare className="size-3" />
  if (t.includes("browser") || t.includes("web")) return <Globe className="size-3" />
  if (t.includes("agent") || t.includes("ai")) return <Cpu className="size-3" />
  return null
}

export function AgentCard({
  entry,
  job,
  hasUpdate,
  onOpen,
  onInstall,
  onUninstall,
}: AgentCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const isComingSoon = !!entry.comingSoon
  const isInstalled = entry.installed
  const isManaged = entry.managed !== false
  const isBusy = !!job && job.phase !== "done" && job.phase !== "error"
  const stage = stageOf(job)

  return (
    <div
      onClick={isComingSoon ? undefined : onOpen}
      role="button"
      tabIndex={isComingSoon ? -1 : 0}
      data-testid={`agent-card-${entry.name}`}
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-(--r-xl) border transition-colors duration-150",
        isComingSoon
          ? "cursor-default border-(--border-c) bg-(--surface-0) opacity-50"
          : "cursor-pointer border-(--border-c) bg-(--surface-1) hover:border-(--border-accent)"
      )}
    >
      {/* Card Header */}
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-(--r-lg) bg-(--surface-2)">
          <AgentIcon type={entry.name} size={32} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {hasUpdate && (
            <span className="rounded-(--r-base) px-1.5 py-0.5 text-[11px]" style={{ color: "var(--status-muted-warning)" }}>
              Update available
            </span>
          )}
          {entry.featured && !hasUpdate && (
            <span className="rounded-(--r-base) px-1.5 py-0.5 text-[11px] text-(--fg-x-muted)">Featured</span>
          )}
          {isInstalled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              style={{ color: "var(--status-muted-success)" }}
            >
              <CheckCircle2 className="size-3" />
              Installed
            </span>
          )}
        </div>
      </div>

      {/* Card Body */}
      <div className="flex-1 px-4">
        <h3 className="mb-1 truncate text-[14px] font-medium text-(--fg)">
          {entry.label || entry.name}
        </h3>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-(--fg-muted)">
          {entry.description}
        </p>
      </div>

      {/* Skills & Tags Section */}
      <div className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {(entry.tags || []).slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-(--r-md) bg-(--surface-2) px-2 py-0.5 text-[11px] text-(--fg-muted)"
            >
              {resolveSkillIcon(tag)}
              <span className="capitalize">{tag.replace('-', ' ')}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Footer Actions */}
      <div
        className="mt-auto flex items-center justify-between gap-2 border-t border-(--border-c) p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1 truncate pr-2 text-[12px] text-(--fg-x-muted)">
          {isBusy && stage ? (
            <span className="flex items-center gap-1.5 text-(--fg-muted)">
              <RefreshCw className="size-3 animate-spin" />
              {t(`install.progress.stages.${stage}`)}…
            </span>
          ) : isComingSoon ? (
            "Coming soon"
          ) : null}
        </div>

        <div className="flex shrink-0 gap-1.5">
          {isComingSoon || isBusy ? (
            <Button size="sm" variant="ghost" disabled>
              {isBusy ? "Processing…" : "Wait"}
            </Button>
          ) : !isInstalled ? (
            <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); onInstall() }}>
              <DownloadCloud className="size-3.5" />
              Install
            </Button>
          ) : isManaged ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onUninstall() }}>
              Uninstall
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onInstall() }}>
              Reinstall
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
