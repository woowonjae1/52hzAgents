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
        "group flex flex-col h-full rounded-2xl border transition-all duration-300 relative overflow-hidden",
        isComingSoon
          ? "opacity-50 cursor-default border-zinc-800/50 bg-zinc-950/20 grayscale"
          : "cursor-pointer border-zinc-800/80 bg-zinc-950/40 hover:bg-zinc-900/60 hover:border-cyan-500/50 hover:shadow-[0_4px_30px_rgba(6,182,212,0.12)] hover:-translate-y-1"
      )}
    >
      {/* Dynamic Background Glow on Hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-blue-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

      {/* Card Header */}
      <div className="p-4 flex items-start justify-between gap-3 relative z-10">
        <div className="size-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 shadow-inner overflow-hidden">
          <AgentIcon type={entry.name} size={32} />
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {hasUpdate && (
            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-sm bg-amber-500/10 text-amber-500 border border-amber-500/20">
              Update Available
            </span>
          )}
          {entry.featured && !hasUpdate && (
            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-sm bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              Featured
            </span>
          )}
          {isInstalled && (
            <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-1 bg-emerald-500/10 px-1.5 py-0.5 rounded-sm">
              <CheckCircle2 className="size-3" />
              Installed
            </span>
          )}
        </div>
      </div>

      {/* Card Body */}
      <div className="px-4 flex-1 relative z-10">
        <h3 className="text-sm font-bold text-zinc-100 group-hover:text-cyan-400 transition-colors mb-1 truncate">
          {entry.label || entry.name}
        </h3>
        <p className="text-[11.5px] text-zinc-500 leading-relaxed line-clamp-2">
          {entry.description || "Powerful autonomous AI agent."}
        </p>
      </div>

      {/* Skills & Tags Section */}
      <div className="px-4 py-3 relative z-10">
        <div className="flex flex-wrap gap-1.5">
          {(entry.tags || []).slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-zinc-800/50 text-zinc-400 border border-zinc-700/50"
            >
              {resolveSkillIcon(tag)}
              <span className="capitalize">{tag.replace('-', ' ')}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Footer Actions */}
      <div
        className="p-3 border-t border-zinc-800/50 bg-zinc-950/80 mt-auto flex items-center justify-between relative z-10 gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[10.5px] text-zinc-500 truncate flex-1 min-w-0 pr-2">
          {isBusy && stage ? (
            <span className="text-cyan-400 flex items-center gap-1.5 animate-pulse">
              <RefreshCw className="size-3 animate-spin" />
              {t(`install.progress.stages.${stage}`)}...
            </span>
          ) : isComingSoon ? (
            "Coming Soon"
          ) : (
            `v${entry.version || "1.0.0"}`
          )}
        </div>
        
        <div className="flex shrink-0 gap-1.5">
          {isComingSoon || isBusy ? (
            <Button size="sm" variant="ghost" disabled className="h-7 text-xs bg-zinc-900 border-zinc-800">
              {isBusy ? "Processing..." : "Wait"}
            </Button>
          ) : !isInstalled ? (
            <Button size="sm" className="h-7 text-xs bg-cyan-600 hover:bg-cyan-500 text-white border-0 shadow-[0_0_10px_rgba(6,182,212,0.3)]" onClick={(e) => { e.stopPropagation(); onInstall() }}>
              <DownloadCloud className="size-3.5 mr-1" />
              Install
            </Button>
          ) : isManaged ? (
            <Button size="sm" variant="outline" className="h-7 text-xs bg-zinc-900 hover:bg-zinc-800 border-zinc-700 hover:border-zinc-600" onClick={(e) => { e.stopPropagation(); onUninstall() }}>
              Uninstall
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs bg-zinc-900 hover:bg-zinc-800 border-zinc-700" onClick={(e) => { e.stopPropagation(); onInstall() }}>
              Reinstall
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
