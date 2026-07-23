import React, { useEffect, useMemo, useRef, useCallback, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslation } from "react-i18next"
import { ArrowRight, Activity, Cpu, Layers, ShieldCheck, RefreshCw, Zap, Terminal } from "lucide-react"
import { useAgentsStore } from "../../store/agents"
import { useUiStore } from "../../store/ui"
import { useInstallStore } from "../../store/install"
import { useConnectionsStore } from "../../store/connections"
import { useNotificationsStore } from "../../store/notifications"
import { Button } from "../../components/ui/Button"
import { TopBar } from "../../components/TopBar"
import { AgentCard } from "../../components/dashboard/AgentCard"
import type { Agent, AgentUpdateInfo } from "../../types"
import { useUpdateDismissals } from "../../hooks/useUpdateDismissals"
import type { ToastType } from "../../hooks/useToast"
import { cn } from "../../lib/utils"

interface DashboardProps {
  showToast: (message: string, type?: ToastType) => void
  onOpenConfigure: (agentName: string, agentType: string) => void
  onOpenConnectWorkspace: (agentName: string) => void
}

function SkeletonCard(): React.JSX.Element {
  return (
    <div className="flex flex-col h-full p-4 bg-zinc-950/60 border border-zinc-800/80 rounded-2xl animate-pulse">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-xl bg-zinc-900" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-zinc-800 rounded w-1/2" />
          <div className="h-2 bg-zinc-900 rounded w-1/3" />
        </div>
      </div>
      <div className="mt-4 h-8 bg-zinc-900 rounded-xl" />
    </div>
  )
}

export default function Dashboard({
  showToast,
}: DashboardProps): React.JSX.Element {
  const { t } = useTranslation()
  const {
    agents,
    setAgents,
    pendingAgentActions,
    addPendingAction,
    removePendingAction,
  } = useAgentsStore(
    useShallow((s) => ({
      agents: s.agents,
      setAgents: s.setAgents,
      pendingAgentActions: s.pendingAgentActions,
      addPendingAction: s.addPendingAction,
      removePendingAction: s.removePendingAction,
    })),
  )
  const {
    setCurrentTab,
    goToInstallList,
  } = useUiStore(
    useShallow((s) => ({
      setCurrentTab: s.setCurrentTab,
      goToInstallList: s.goToInstallList,
    })),
  )
  const { updates } = useInstallStore(
    useShallow((s) => ({ updates: s.updates })),
  )
  const { isDismissed } = useUpdateDismissals()

  const mounted = useRef(true)
  const [loading, setLoading] = useState(agents.length === 0)

  const activeCount = agents.filter((a) => ["online", "running", "idle"].includes(a.state)).length
  const connectedCount = agents.filter((a) => !!a.network).length

  const refreshAgents = useCallback(async () => {
    try {
      const list = await window.api.listAgents()
      if (mounted.current) {
        setAgents(list)
        setLoading(false)
      }
    } catch {
      if (mounted.current) setLoading(false)
    }
  }, [setAgents])

  useEffect(() => {
    mounted.current = true
    void refreshAgents()
    return () => {
      mounted.current = false
    }
  }, [refreshAgents])

  const toggleAgentState = async (agent: Agent) => {
    const isRunning = ["online", "running", "idle"].includes(agent.state)
    addPendingAction(agent.name)
    try {
      if (isRunning) {
        await window.api.stopAgent(agent.name)
        showToast(`已成功停止 ${agent.name}`, "info")
      } else {
        await window.api.startAgent(agent.name)
        showToast(`已成功启动 ${agent.name}`, "success")
      }
      await refreshAgents()
    } catch (e) {
      showToast((e as Error).message, "error")
    } finally {
      removePendingAction(agent.name)
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#09090b] text-zinc-100 overflow-y-auto">
      <TopBar title="智能体控制塔 (Control Tower)" showSearch />

      <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* Header Control Metrics Banner */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-gradient-to-br from-zinc-900/90 to-zinc-950/90 border border-zinc-800/80 shadow-md flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-zinc-400">活跃智能体节点</div>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1 flex items-baseline gap-2">
                <span>{activeCount}</span>
                <span className="text-xs text-zinc-500 font-normal">/ {agents.length} Total</span>
              </div>
            </div>
            <div className="size-11 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
              <Cpu className="size-5" />
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-gradient-to-br from-zinc-900/90 to-zinc-950/90 border border-zinc-800/80 shadow-md flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-zinc-400">已桥接 Workspace</div>
              <div className="text-2xl font-bold font-mono text-zinc-100 mt-1 flex items-baseline gap-2">
                <span>{connectedCount}</span>
                <span className="text-xs text-emerald-400 font-normal">Active WS</span>
              </div>
            </div>
            <div className="size-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Layers className="size-5" />
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-gradient-to-br from-zinc-900/90 to-zinc-950/90 border border-zinc-800/80 shadow-md flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-zinc-400">守护进程与后端自愈</div>
              <div className="text-xs font-bold font-mono text-emerald-400 mt-2 flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] inline-block" />
                <span>Healthy (PID Active)</span>
              </div>
            </div>
            <div className="size-11 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-400">
              <ShieldCheck className="size-5" />
            </div>
          </div>
        </div>

        {/* Section Title & Toolbar */}
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-zinc-100 m-0">智能体集群矩阵</h2>
            <button
              onClick={() => void refreshAgents()}
              className="p-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer border border-zinc-800"
              title="刷新节点状态"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>

          <button
            onClick={() => setCurrentTab("install")}
            className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 transition-colors cursor-pointer"
          >
            <span>添加新智能体</span>
            <ArrowRight className="size-3.5" />
          </button>
        </div>

        {/* Agent Grid Matrix */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : agents.length === 0 ? (
          <div className="p-10 rounded-2xl bg-zinc-950/60 border border-zinc-800/80 text-center space-y-4">
            <div className="size-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 mx-auto">
              <Cpu className="size-6" />
            </div>
            <div>
              <div className="text-sm font-semibold text-zinc-200">未准备智能体节点</div>
              <div className="text-xs text-zinc-500 mt-1">安装并配置您的第一个 AI 智能体节点以开辟协作</div>
            </div>
            <Button variant="primary" onClick={() => goToInstallList()}>
              一键安装智能体
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((agent) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                isPending={pendingAgentActions.has(agent.name)}
                onToggle={() => void toggleAgentState(agent)}
                onOpenChat={() => setCurrentTab("agents")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
