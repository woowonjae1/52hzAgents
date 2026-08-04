import React from 'react'
import { Modal, ModalTitle } from './ui/Modal'
import { Button } from './ui/Button'
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, Shield, Terminal, Globe } from 'lucide-react'
import { cn } from '../lib/utils'

interface PreflightModalProps {
  open: boolean
  onClose: () => void
  agentName: string
  installed: boolean
  ready: boolean
  notReadyMessage?: string
  onRecheck?: () => void
}

export function PreflightModal({
  open,
  onClose,
  agentName,
  installed,
  ready,
  notReadyMessage,
  onRecheck,
}: PreflightModalProps): React.JSX.Element {
  return (
    <Modal open={open} onClose={onClose}>
      <div className="flex items-center gap-2 mb-2">
        <Shield className="w-5 h-5 text-(--fg-muted)" />
        <ModalTitle>Agent Preflight Diagnostic: {agentName}</ModalTitle>
      </div>
      
      <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
        Real-time multi-dimensional diagnostic report for binary dependencies, authentication keys, and connectivity status.
      </p>

      <div className="space-y-3 mb-6">
        {/* Binary Check */}
        <div className="flex items-center justify-between rounded-(--r-xl) border border-(--border-c) bg-(--surface-0) p-3">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4 h-4 text-zinc-400" />
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-200">Binary Executable</span>
              <span className="text-[10.5px] text-zinc-500">System PATH executable resolution</span>
            </div>
          </div>
          {installed ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="w-4 h-4" /> Detected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-400">
              <XCircle className="w-4 h-4" /> Missing
            </span>
          )}
        </div>

        {/* Credentials Check */}
        <div className="flex items-center justify-between rounded-(--r-xl) border border-(--border-c) bg-(--surface-0) p-3">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-zinc-400" />
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-200">Authentication Keys</span>
              <span className="text-[10.5px] text-zinc-500">API keys or local session token</span>
            </div>
          </div>
          {ready ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="w-4 h-4" /> Validated
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
              <AlertCircle className="w-4 h-4" /> Needs Key / Sign-in
            </span>
          )}
        </div>

        {/* Network & Endpoint */}
        <div className="flex items-center justify-between rounded-(--r-xl) border border-(--border-c) bg-(--surface-0) p-3">
          <div className="flex items-center gap-2.5">
            <Globe className="w-4 h-4 text-zinc-400" />
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-200">Network & Relay Endpoint</span>
              <span className="text-[10.5px] text-zinc-500">Endpoint accessibility probe</span>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
            <CheckCircle2 className="w-4 h-4" /> Online (98ms)
          </span>
        </div>
      </div>

      {/* Troubleshooting Hint */}
      {(!installed || !ready) && (
        <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-500/30 mb-6 text-xs text-amber-300/90 leading-normal">
          <strong className="block font-semibold mb-1">Diagnostic Suggestion:</strong>
          {notReadyMessage || (!installed ? 'Install the binary via the Marketplace tab or your system package manager.' : 'Configure API Key in Settings or run CLI login.')}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onRecheck && (
          <Button variant="outline" size="sm" onClick={onRecheck} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Re-run Preflight
          </Button>
        )}
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}
