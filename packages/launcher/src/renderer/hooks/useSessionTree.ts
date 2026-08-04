import { useCallback, useEffect, useMemo, useState } from "react"
import { useAgentsStore } from "../store/agents"
import type { Agent, ChatSessionMeta, Workspace } from "../types"
import type { ShellStatus } from "../components/shell/StatusDot"

export interface WorkspaceGroup {
  workspace: Workspace
  label: string
  sessions: ChatSessionMeta[]
  agents: Agent[]
  status: ShellStatus
}

function agentStatus(agents: Agent[]): ShellStatus {
  if (agents.length === 0) return "offline"
  if (agents.some((a) => a.state === "error")) return "error"
  if (agents.some((a) => a.state === "running")) return "working"
  if (agents.some((a) => a.state === "online" || a.state === "idle")) return "online"
  if (agents.some((a) => a.state === "starting" || a.state === "reconnecting")) return "working"
  return "offline"
}

/**
 * Workspaces + their sessions + the agents connected to each, shaped for the
 * sidebar tree.
 *
 * Sessions are stored per workspace on disk by the main process, so one
 * `sessionList()` call covers every workspace and is cheaper than fanning out
 * per group. Workspaces that exist but have no session yet still get a group —
 * the "+" on an empty group is how a first session gets created.
 */
export function useSessionTree(): {
  groups: WorkspaceGroup[]
  workspaces: Workspace[]
  sessions: ChatSessionMeta[]
  agents: Agent[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const [loading, setLoading] = useState(true)
  // Agents live in the shared store, not in local state: `useDaemonStatus`
  // derives the footer's daemon dot from it, and the management pages read the
  // same list. Two copies would drift.
  const agents = useAgentsStore((s) => s.agents)
  const setAgents = useAgentsStore((s) => s.setAgents)

  /** Resolves false when the main process wasn't ready to answer yet. */
  const load = useCallback(async (): Promise<boolean> => {
    const settle = async <T,>(promise: Promise<T>): Promise<{ ok: boolean; value: T | null }> => {
      try {
        return { ok: true, value: await promise }
      } catch {
        return { ok: false, value: null }
      }
    }
    const [ws, ss, ag] = await Promise.all([
      settle(window.api.listWorkspaces()),
      settle(window.api.sessionList()),
      settle(window.api.listAgents()),
    ])
    setWorkspaces(ws.value ?? [])
    setSessions(ss.value ?? [])
    setAgents(ag.value ?? [])
    setLoading(false)
    return ws.ok && ss.ok && ag.ok
  }, [setAgents])

  const refresh = useCallback(async () => {
    await load()
  }, [load])

  useEffect(() => {
    let timer = 0
    let disposed = false

    // On a cold start the main process rejects these calls with "Launcher is
    // still initializing" for a second or two. Polling at the steady 10s cadence
    // from the first failure would leave the sidebar blank that whole time, so
    // back off fast until the first successful round instead.
    const tick = async (): Promise<void> => {
      const ok = await load()
      if (disposed) return
      timer = window.setTimeout(() => void tick(), ok ? 10_000 : 1_500)
    }
    void tick()

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [load])

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const byWorkspace = new Map<string, ChatSessionMeta[]>()
    for (const session of sessions) {
      const list = byWorkspace.get(session.workspaceId)
      if (list) list.push(session)
      else byWorkspace.set(session.workspaceId, [session])
    }

    const result: WorkspaceGroup[] = workspaces.map((workspace) => {
      const connected = agents.filter(
        (a) => a.network === workspace.slug || a.networkName === workspace.slug || a.network === workspace.id,
      )
      return {
        workspace,
        label: workspace.name || workspace.slug || workspace.id,
        sessions: byWorkspace.get(workspace.id) ?? [],
        agents: connected,
        status: agentStatus(connected),
      }
    })

    // Sessions whose workspace is no longer registered would otherwise vanish
    // from the tree while still existing on disk. Surface them under their own
    // group so they can be opened and deleted.
    for (const [workspaceId, list] of byWorkspace) {
      if (result.some((g) => g.workspace.id === workspaceId)) continue
      const first = list[0]
      result.push({
        workspace: { id: workspaceId, slug: first?.workspaceSlug ?? workspaceId, name: first?.workspaceName },
        label: first?.workspaceName || first?.workspaceSlug || workspaceId,
        sessions: list,
        agents: [],
        status: "offline",
      })
    }

    return result.sort((a, b) => a.label.localeCompare(b.label))
  }, [workspaces, sessions, agents])

  return { groups, workspaces, sessions, agents, loading, refresh }
}
