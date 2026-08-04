import React from "react"
import { ArrowLeft, ChevronDown, ChevronRight, File, FolderOpen, Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { GitFileEntry } from "../../types"

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  isFile: boolean
  untracked: boolean
}

function buildTree(entries: GitFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), isFile: false, untracked: false }
  for (const entry of entries) {
    const segments = entry.path.split("/")
    let node = root
    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1
      const path = segments.slice(0, index + 1).join("/")
      let child = node.children.get(segment)
      if (!child) {
        child = { name: segment, path, children: new Map(), isFile: isLast, untracked: isLast && entry.untracked }
        node.children.set(segment, child)
      }
      node = child
    })
  }
  return root
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const isOpen = expanded.has(node.path)
  return (
    <>
      <button
        type="button"
        onClick={() => (node.isFile ? onOpenFile(node.path) : onToggle(node.path))}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-[var(--surface-1)]"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="grid size-3.5 shrink-0 place-items-center" style={{ color: "var(--fg-x-muted)" }}>
          {node.isFile ? (
            <File className="size-3" />
          ) : isOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[13px]"
          style={{ color: node.isFile ? "var(--fg-muted)" : "var(--fg)" }}
        >
          {node.name}
        </span>
        {node.untracked && (
          <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
            ?
          </span>
        )}
      </button>
      {!node.isFile &&
        isOpen &&
        sortedChildren(node).map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}

/** Tracked + untracked files in the repository, with a read-only file viewer. */
export default function FilesPanel({
  repoPath,
  onPickRepo,
}: {
  repoPath: string | null
  onPickRepo: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = React.useState<GitFileEntry[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState("")
  const [openFile, setOpenFile] = React.useState<{ path: string; content: string | null; note?: string } | null>(null)

  React.useEffect(() => {
    if (!repoPath) {
      setEntries([])
      return
    }
    let cancelled = false
    void window.api
      .gitFileList(repoPath)
      .then((result) => {
        if (cancelled) return
        setEntries(result.entries)
        setError(result.error ?? null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const tree = React.useMemo(() => buildTree(entries), [entries])
  const needle = query.trim().toLowerCase()
  const matches = React.useMemo(
    () => (needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)).slice(0, 300) : []),
    [entries, needle],
  )

  const loadFile = async (path: string): Promise<void> => {
    if (!repoPath) return
    setOpenFile({ path, content: null })
    const result = await window.api.gitReadFile(repoPath, path)
    setOpenFile({
      path,
      content: result.content,
      note: result.error ?? (result.binary ? t("shell.git.binaryFile") : result.tooLarge ? t("shell.git.tooLarge") : undefined),
    })
  }

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

  if (openFile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5"
          style={{ borderColor: "var(--border-c)" }}
        >
          <button
            type="button"
            onClick={() => setOpenFile(null)}
            aria-label={t("shell.back")}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-2)]"
            style={{ color: "var(--fg-muted)" }}
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" style={{ color: "var(--fg-muted)" }}>
            {openFile.path}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto" style={{ background: "var(--surface-0)" }}>
          {openFile.note ? (
            <p className="px-3 py-3 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {openFile.note}
            </p>
          ) : openFile.content === null ? (
            <p className="px-3 py-3 text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
              {t("shell.loading")}
            </p>
          ) : (
            <pre
              className="m-0 whitespace-pre px-3 py-2 font-mono"
              style={{ fontSize: "var(--text-code)", lineHeight: "var(--lh-diff)", color: "var(--fg-muted)" }}
            >
              {openFile.content}
            </pre>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-2 py-1.5" style={{ borderColor: "var(--border-c)" }}>
        <div
          className="flex items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1"
          style={{ background: "var(--surface-2)" }}
        >
          <Search className="size-3.5 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("shell.git.findFile")}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
            style={{ color: "var(--fg)" }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error && (
          <p className="px-3 py-4 text-center text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
            {error}
          </p>
        )}
        {!error && needle
          ? matches.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void loadFile(entry.path)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--surface-1)]"
              >
                <File className="size-3 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
                <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--fg-muted)" }}>
                  {entry.path}
                </span>
              </button>
            ))
          : !error &&
            sortedChildren(tree).map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={0}
                expanded={expanded}
                onToggle={(path) =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })
                }
                onOpenFile={(path) => void loadFile(path)}
              />
            ))}
      </div>
    </div>
  )
}
