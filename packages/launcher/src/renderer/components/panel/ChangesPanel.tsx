import React from "react"
import { ChevronDown, ChevronRight, FolderOpen, GitBranch, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "../../lib/utils"
import type { GitChangedFile, GitDiffResult, GitFileStatus, GitStatusResult } from "../../types"
import DiffStat from "../shell/DiffStat"
import DiffView from "./DiffView"

/** Single-letter marker per status, matching `git status -s`. */
const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  conflicted: "!",
  typechange: "T",
}

const STATUS_COLOR: Record<GitFileStatus, string> = {
  modified: "var(--status-muted-warning)",
  added: "var(--status-muted-success)",
  deleted: "var(--status-muted-danger)",
  renamed: "var(--status-muted-merged)",
  copied: "var(--status-muted-merged)",
  untracked: "var(--fg-x-muted)",
  conflicted: "var(--status-danger)",
  typechange: "var(--status-muted-warning)",
}

function splitPath(filePath: string): { dir: string; name: string } {
  const index = filePath.lastIndexOf("/")
  if (index === -1) return { dir: "", name: filePath }
  return { dir: filePath.slice(0, index + 1), name: filePath.slice(index + 1) }
}

function FileRow({
  file,
  repoPath,
}: {
  file: GitChangedFile
  repoPath: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [diff, setDiff] = React.useState<GitDiffResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const { dir, name } = splitPath(file.path)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (!next || diff || loading) return
    setLoading(true)
    try {
      setDiff(await window.api.gitDiff(repoPath, file.path))
    } catch (error) {
      setDiff({
        path: file.path,
        binary: false,
        tooLarge: false,
        hunks: [],
        error: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "var(--border-c)" }}>
      <button
        type="button"
        onClick={() => void toggle()}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--surface-1)]"
      >
        <span className="grid size-3.5 shrink-0 place-items-center" style={{ color: "var(--fg-x-muted)" }}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <span
          className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold"
          style={{ color: STATUS_COLOR[file.status] }}
          title={t(`shell.git.status.${file.status}`)}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {dir && <span style={{ color: "var(--fg-x-muted)" }}>{dir}</span>}
          <span style={{ color: "var(--fg)" }}>{name}</span>
        </span>
        {file.binary ? (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
            {t("shell.git.binary")}
          </span>
        ) : (
          <DiffStat additions={file.additions} deletions={file.deletions} />
        )}
      </button>

      {open && (
        <div style={{ background: "var(--surface-0)" }}>
          {loading && (
            <p className="px-3 py-2 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {t("shell.loading")}
            </p>
          )}
          {!loading && diff?.error && (
            <p className="px-3 py-2 text-[12px]" style={{ color: "var(--status-danger)" }}>
              {diff.error}
            </p>
          )}
          {!loading && diff && !diff.error && diff.binary && (
            <p className="px-3 py-2 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {t("shell.git.binaryFile")}
            </p>
          )}
          {!loading && diff && !diff.error && diff.tooLarge && (
            <p className="px-3 py-2 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {t("shell.git.tooLarge")}
            </p>
          )}
          {!loading && diff && !diff.error && !diff.binary && !diff.tooLarge && diff.hunks.length === 0 && (
            <p className="px-3 py-2 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {t("shell.git.noDiff")}
            </p>
          )}
          {!loading && diff && diff.hunks.length > 0 && <DiffView hunks={diff.hunks} />}
        </div>
      )}
    </div>
  )
}

/**
 * Working-tree changes for the repository a workspace is pointed at.
 *
 * The repository is a per-workspace choice the user makes once: the daemon knows
 * about workspaces and agents, not about which checkout on this machine backs
 * them, so there is nothing to infer. An unset path renders the picker rather
 * than guessing.
 */
export default function ChangesPanel({
  repoPath,
  onPickRepo,
}: {
  repoPath: string | null
  onPickRepo: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<GitStatusResult | null>(null)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!repoPath) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      setStatus(await window.api.gitStatus(repoPath))
    } catch (error) {
      setStatus({
        isRepo: false,
        root: null,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        additions: 0,
        deletions: 0,
        error: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!repoPath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <FolderOpen className="size-6" style={{ color: "var(--fg-x-muted)" }} />
        <p className="m-0 text-[13px]" style={{ color: "var(--fg-muted)" }}>
          {t("shell.git.noRepo")}
        </p>
        <button
          type="button"
          onClick={onPickRepo}
          className="rounded-[var(--r-md)] px-3 py-1.5 text-[13px]"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {t("shell.git.selectRepo")}
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5"
        style={{ borderColor: "var(--border-c)" }}
      >
        <GitBranch className="size-3.5 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
        <span
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: "var(--fg-muted)" }}
          title={status?.root ?? repoPath}
        >
          {status?.branch ?? repoPath}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "var(--fg-x-muted)" }}>
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        {status && <DiffStat additions={status.additions} deletions={status.deletions} />}
        <button
          type="button"
          onClick={() => void load()}
          title={t("shell.git.refresh")}
          aria-label={t("shell.git.refresh")}
          className="grid size-6 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-2)]"
          style={{ color: "var(--fg-muted)" }}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-[spin_1s_linear_infinite]")} />
        </button>
        <button
          type="button"
          onClick={onPickRepo}
          title={t("shell.git.changeRepo")}
          aria-label={t("shell.git.changeRepo")}
          className="grid size-6 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-2)]"
          style={{ color: "var(--fg-muted)" }}
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status && !status.isRepo && (
          <p className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
            {status.error || t("shell.git.notARepo")}
          </p>
        )}
        {status?.isRepo && status.files.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
            {t("shell.git.clean")}
          </p>
        )}
        {status?.files.map((file) => (
          <FileRow key={file.path} file={file} repoPath={repoPath} />
        ))}
      </div>
    </div>
  )
}
