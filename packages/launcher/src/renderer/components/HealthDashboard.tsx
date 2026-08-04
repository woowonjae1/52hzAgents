import React, { useState, useEffect } from "react"
import { CheckCircle2, XCircle, RefreshCw, Activity, Zap } from "lucide-react"

interface ServiceStatus {
  name: string
  url: string
  status: "checking" | "online" | "offline"
  latency?: number
}

export function HealthDashboard(): React.JSX.Element {
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: "Go Workspace Backend", url: "http://localhost:8000/v1/health", status: "checking" },
    { name: "Next.js Web Frontend", url: "http://localhost:3005", status: "checking" },
    { name: "OpenClaw Gateway", url: "http://127.0.0.1:18789", status: "checking" },
  ])
  const [isRefreshing, setIsRefreshing] = useState(false)

  const checkHealth = async () => {
    setIsRefreshing(true)
    const updated = await Promise.all(
      services.map(async (service) => {
        const start = performance.now()
        try {
          const res = await fetch(service.url, { method: "GET", mode: "no-cors" })
          const latency = Math.round(performance.now() - start)
          return { ...service, status: "online" as const, latency }
        } catch {
          return { ...service, status: "offline" as const, latency: undefined }
        }
      })
    )
    setServices(updated)
    setIsRefreshing(false)
  }

  useEffect(() => {
    void checkHealth()
  }, [])

  return (
    <div className="mt-4 space-y-3 rounded-(--r-xl) border border-(--border-c) bg-(--surface-1) p-4 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-zinc-200">
          <Activity className="w-4 h-4 text-emerald-400" />
          <span>本地服务健康与一键自愈 (Service Self-Healing)</span>
        </div>
        <button
          onClick={() => void checkHealth()}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          <span>重新诊断</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
        {services.map((svc) => (
          <div
            key={svc.name}
            className="flex items-center justify-between rounded-(--r-lg) border border-(--border-c) bg-(--surface-0) p-3"
          >
            <div>
              <div className="text-xs font-medium text-zinc-300">{svc.name}</div>
              <div className="text-[10px] text-zinc-500 font-mono mt-0.5">{svc.url}</div>
            </div>
            {svc.status === "online" ? (
              <div className="flex items-center gap-1 text-xs text-emerald-400 font-mono">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {svc.latency !== undefined && <span>{svc.latency}ms</span>}
              </div>
            ) : svc.status === "offline" ? (
              <div className="flex items-center gap-1 text-xs text-rose-400 font-mono">
                <XCircle className="w-4 h-4 shrink-0" />
                <span>离线</span>
              </div>
            ) : (
              <div className="text-xs text-zinc-500">检测中...</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
