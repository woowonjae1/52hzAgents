import { execFile } from "child_process"
import fs from "fs"
import path from "path"
import type { IpcMain } from "electron"

/**
 * Local git bridge for the workspace Changes/Files panel.
 *
 * Everything here shells out to the user's own `git` with `execFile` (never a
 * shell, never string interpolation) and always terminates the argument list
 * with `--` before any path. The renderer supplies the directory, so treating
 * these paths as data rather than command text is the whole ballgame.
 *
 * Porcelain v1 in line mode, not `-z`: v1's `-z` rename encoding is ambiguous
 * about which of the two paths comes first, whereas `R  orig -> new` is not.
 * `core.quotepath=false` stops the escaping of non-ASCII bytes but git still
 * quotes any path containing a control character, so splitting on newlines
 * stays safe even for pathological filenames.
 */

const GIT_TIMEOUT_MS = 15_000
const MAX_BUFFER = 32 * 1024 * 1024
/** A file bigger than this is reported as too-large rather than diffed. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "typechange"

export interface GitChangedFile {
  path: string
  oldPath?: string
  status: GitFileStatus
  /** Present in the index (green column of `git status -s`). */
  staged: boolean
  /** Differs in the working tree (red column). */
  unstaged: boolean
  additions: number
  deletions: number
  binary: boolean
}

export interface GitRepoInfo {
  isRepo: boolean
  root: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  error?: string
}

export interface GitStatusResult extends GitRepoInfo {
  files: GitChangedFile[]
  additions: number
  deletions: number
}

export type GitDiffLineType = "add" | "del" | "context" | "hunk" | "meta"

export interface GitDiffLine {
  type: GitDiffLineType
  content: string
  oldNumber: number | null
  newNumber: number | null
}

export interface GitDiffHunk {
  header: string
  lines: GitDiffLine[]
}

export interface GitDiffResult {
  path: string
  oldPath?: string
  binary: boolean
  tooLarge: boolean
  hunks: GitDiffHunk[]
  error?: string
}

export interface GitFileEntry {
  path: string
  /** Not in the index yet. */
  untracked: boolean
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code })
      },
    )
  })
}

/** Reverses git's C-style path quoting (`"src/\303\251.ts"`). */
function unquotePath(raw: string): string {
  const value = raw.trim()
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const body = value.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== "\\") {
      bytes.push(...Array.from(Buffer.from(ch, "utf8")))
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (next >= "0" && next <= "7") {
      const octal = next + (body[i + 1] ?? "") + (body[i + 2] ?? "")
      bytes.push(parseInt(octal, 8))
      i += 2
      continue
    }
    const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 }
    bytes.push(escapes[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(bytes).toString("utf8")
}

function statusFromCodes(index: string, worktree: string): GitFileStatus {
  if (index === "?" || worktree === "?") return "untracked"
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) {
    return "conflicted"
  }
  const codes = `${index}${worktree}`
  if (codes.includes("R")) return "renamed"
  if (codes.includes("C")) return "copied"
  if (codes.includes("T")) return "typechange"
  if (index === "A") return "added"
  if (codes.includes("D")) return "deleted"
  return "modified"
}

async function repoInfo(dir: string): Promise<GitRepoInfo> {
  const empty: GitRepoInfo = { isRepo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0 }
  if (!dir) return { ...empty, error: "no directory" }
  try {
    if (!fs.statSync(dir).isDirectory()) return { ...empty, error: "not a directory" }
  } catch {
    return { ...empty, error: "directory not found" }
  }

  const root = await runGit(dir, ["rev-parse", "--show-toplevel"])
  if (root.code !== 0) {
    return { ...empty, error: root.stderr.trim() || "not a git repository" }
  }
  const rootPath = root.stdout.trim()

  const branchResult = await runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null

  const upstreamResult = await runGit(rootPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ])
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null

  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = await runGit(rootPath, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    if (counts.code === 0) {
      const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/)
      behind = Number(behindRaw) || 0
      ahead = Number(aheadRaw) || 0
    }
  }

  return { isRepo: true, root: rootPath, branch, upstream, ahead, behind }
}

/** `git diff --numstat` for every tracked change against HEAD, keyed by path. */
async function numstat(root: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"])
  const args =
    head.code === 0
      ? ["diff", "--numstat", "--find-renames", "HEAD", "--"]
      : ["diff", "--numstat", "--find-renames", "--cached", "--"]
  const result = await runGit(root, args)
  if (result.code !== 0) return out

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    const [addRaw, delRaw, ...rest] = line.split("\t")
    const target = rest[rest.length - 1]
    if (!target) continue
    const binary = addRaw === "-" || delRaw === "-"
    out.set(unquotePath(target), {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    })
  }
  return out
}

function countLines(absPath: string): { additions: number; binary: boolean } {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return { additions: 0, binary: false }
    if (stat.size > MAX_DIFF_BYTES) return { additions: 0, binary: false }
    const buffer = fs.readFileSync(absPath)
    // A NUL byte in the first 8000 bytes is git's own binary heuristic.
    if (buffer.subarray(0, 8000).includes(0)) return { additions: 0, binary: true }
    if (buffer.length === 0) return { additions: 0, binary: false }
    const text = buffer.toString("utf8")
    const lines = text.split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    return { additions: lines.length, binary: false }
  } catch {
    return { additions: 0, binary: false }
  }
}

export async function gitStatus(dir: string): Promise<GitStatusResult> {
  const info = await repoInfo(dir)
  if (!info.isRepo || !info.root) {
    return { ...info, files: [], additions: 0, deletions: 0 }
  }
  const root = info.root

  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--find-renames"])
  if (status.code !== 0) {
    return { ...info, files: [], additions: 0, deletions: 0, error: status.stderr.trim() || "git status failed" }
  }

  const stats = await numstat(root)
  const files: GitChangedFile[] = []

  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    const rest = line.slice(3)
    const fileStatus = statusFromCodes(index, worktree)

    let filePath: string
    let oldPath: string | undefined
    const arrow = rest.indexOf(" -> ")
    if (arrow !== -1 && (fileStatus === "renamed" || fileStatus === "copied")) {
      oldPath = unquotePath(rest.slice(0, arrow))
      filePath = unquotePath(rest.slice(arrow + 4))
    } else {
      filePath = unquotePath(rest)
    }

    const stat = stats.get(filePath)
    let additions = stat?.additions ?? 0
    let deletions = stat?.deletions ?? 0
    let binary = stat?.binary ?? false

    if (fileStatus === "untracked") {
      const counted = countLines(path.join(root, filePath))
      additions = counted.additions
      deletions = 0
      binary = counted.binary
    }

    files.push({
      path: filePath,
      ...(oldPath ? { oldPath } : {}),
      status: fileStatus,
      staged: index !== " " && index !== "?",
      unstaged: worktree !== " " && worktree !== "?",
      additions,
      deletions,
      binary,
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  return {
    ...info,
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  }
}

function parseUnifiedDiff(raw: string): { hunks: GitDiffHunk[]; binary: boolean } {
  const hunks: GitDiffHunk[] = []
  let current: GitDiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0
  let binary = false

  for (const line of raw.split("\n")) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true
      continue
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      oldNumber = match ? Number(match[1]) : 0
      newNumber = match ? Number(match[2]) : 0
      current = { header: match ? (match[3] ?? "").trim() : line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue // diff/index/---/+++ preamble
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), oldNumber: null, newNumber: newNumber++ })
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNumber: oldNumber++, newNumber: null })
    } else if (line.startsWith("\\")) {
      current.lines.push({ type: "meta", content: line.slice(2), oldNumber: null, newNumber: null })
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        content: line.slice(1),
        oldNumber: oldNumber++,
        newNumber: newNumber++,
      })
    }
  }
  return { hunks, binary }
}

export async function gitDiff(
  dir: string,
  filePath: string,
  opts?: { context?: number },
): Promise<GitDiffResult> {
  const empty: GitDiffResult = { path: filePath, binary: false, tooLarge: false, hunks: [] }
  const info = await repoInfo(dir)
  if (!info.isRepo || !info.root) return { ...empty, error: info.error ?? "not a git repository" }
  const root = info.root
  const context = Math.max(0, Math.min(20, opts?.context ?? 3))

  const tracked = await runGit(root, ["ls-files", "--error-unmatch", "--", filePath])
  if (tracked.code !== 0) {
    // Untracked: synthesize an all-additions diff from the file on disk so the
    // panel renders new files the same way as edits.
    const abs = path.join(root, filePath)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return { ...empty, error: "file not found" }
    }
    if (stat.size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true }
    const buffer = fs.readFileSync(abs)
    if (buffer.subarray(0, 8000).includes(0)) return { ...empty, binary: true }
    const lines = buffer.toString("utf8").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    return {
      ...empty,
      hunks: [
        {
          header: "",
          lines: lines.map((content, i) => ({
            type: "add" as const,
            content,
            oldNumber: null,
            newNumber: i + 1,
          })),
        },
      ],
    }
  }

  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"])
  const args = [
    "diff",
    "--no-color",
    "--find-renames",
    `-U${context}`,
    ...(head.code === 0 ? ["HEAD"] : ["--cached"]),
    "--",
    filePath,
  ]
  const result = await runGit(root, args)
  if (result.code !== 0 && !result.stdout) {
    return { ...empty, error: result.stderr.trim() || "git diff failed" }
  }
  const parsed = parseUnifiedDiff(result.stdout)
  return { ...empty, hunks: parsed.hunks, binary: parsed.binary }
}

export async function gitFileList(dir: string): Promise<{ root: string | null; entries: GitFileEntry[]; error?: string }> {
  const info = await repoInfo(dir)
  if (!info.isRepo || !info.root) return { root: null, entries: [], error: info.error ?? "not a git repository" }
  const root = info.root

  const cached = await runGit(root, ["ls-files", "-z"])
  const others = await runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"])
  const split = (value: string): string[] => value.split("\0").filter(Boolean)

  const entries: GitFileEntry[] = [
    ...split(cached.stdout).map((p) => ({ path: p, untracked: false })),
    ...split(others.stdout).map((p) => ({ path: p, untracked: true })),
  ]
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { root, entries }
}

export async function gitReadFile(
  dir: string,
  filePath: string,
): Promise<{ content: string | null; binary: boolean; tooLarge: boolean; error?: string }> {
  const info = await repoInfo(dir)
  if (!info.isRepo || !info.root) return { content: null, binary: false, tooLarge: false, error: "not a git repository" }
  const root = info.root
  const abs = path.resolve(root, filePath)
  // Keep reads inside the repository even if the renderer sends `../`.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { content: null, binary: false, tooLarge: false, error: "path outside repository" }
  }
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile()) return { content: null, binary: false, tooLarge: false, error: "not a file" }
    if (stat.size > MAX_DIFF_BYTES) return { content: null, binary: false, tooLarge: true }
    const buffer = fs.readFileSync(abs)
    if (buffer.subarray(0, 8000).includes(0)) return { content: null, binary: true, tooLarge: false }
    return { content: buffer.toString("utf8"), binary: false, tooLarge: false }
  } catch (err) {
    return { content: null, binary: false, tooLarge: false, error: (err as Error).message }
  }
}

export function registerGitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("git:status", (_e, dir: string) => gitStatus(dir))
  ipcMain.handle("git:diff", (_e, dir: string, filePath: string, opts?: { context?: number }) =>
    gitDiff(dir, filePath, opts),
  )
  ipcMain.handle("git:file-list", (_e, dir: string) => gitFileList(dir))
  ipcMain.handle("git:read-file", (_e, dir: string, filePath: string) => gitReadFile(dir, filePath))
  ipcMain.handle("git:repo-info", (_e, dir: string) => repoInfo(dir))
}
