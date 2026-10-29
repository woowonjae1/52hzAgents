'use client';

import * as React from 'react';
import { CheckCircle2, AlertTriangle, FileCode, Terminal, Shield, Ban, StopCircle, Info } from 'lucide-react';

export interface ExecutionEvidence {
  files_modified?: string[];
  commands?: { command: string; exitCode?: number; durationMs?: number }[];
  completed?: boolean;
  interrupted?: boolean;
  denied?: boolean;
  limited?: boolean;
  outcome?: string;
  file_observation?: string;
}

export function ExecutionEvidenceCard({
  evidence,
  usage,
}: {
  evidence: ExecutionEvidence;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cache_read_tokens?: number };
}) {
  const hasFiles = Boolean(evidence.files_modified && evidence.files_modified.length > 0);
  const hasCommands = Boolean(evidence.commands && evidence.commands.length > 0);

  if (!hasFiles && !hasCommands && !evidence.denied && !evidence.interrupted && !evidence.limited && !['failed','timed_out','expired'].includes(evidence.outcome || '')) {
    return null;
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-surface1/60 text-xs shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 bg-surface2/30 px-3 py-2">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <Shield className="size-3.5 text-primary" />
          运行事实与执行证据 (System Verified)
        </span>
        <div className="flex items-center gap-1.5 text-[11px]">
          {evidence.outcome === 'failed' || evidence.outcome === 'timed_out' ? <span className="text-red-400">{evidence.outcome === 'timed_out' ? '运行超时' : '运行失败'}</span> : evidence.outcome === 'expired' ? <span className="text-amber-400">审批已过期</span> : evidence.denied ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400 flex items-center gap-1">
              <Ban className="size-3" /> 用户拒绝命令
            </span>
          ) : evidence.interrupted ? (
            <span className="rounded bg-surface2 px-1.5 py-0.5 text-foreground-muted flex items-center gap-1">
              <StopCircle className="size-3" /> {evidence.outcome === 'interrupted' ? '应用退出或异常中断' : '用户主动停止'}
            </span>
          ) : evidence.limited ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400 flex items-center gap-1">
              <AlertTriangle className="size-3" /> 达到步骤上限
            </span>
          ) : (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="size-3" /> 运行结束
            </span>
          )}
        </div>
      </div>

      <div className="p-3 space-y-2.5">
        {/* Modified Files */}
        {hasFiles && (
          <div>
            <div className="text-[11px] font-medium text-foreground-muted mb-1 flex items-center gap-1">
              <FileCode className="size-3" />
              观察到的文件修改 ({evidence.files_modified!.length}) · {evidence.file_observation === 'git-visible' ? 'Git 可见变化及文件工具记录' : '仅文件工具记录，命令改动未完整检测'}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {evidence.files_modified!.map((file) => (
                <span
                  key={file}
                  className="rounded-md border border-border bg-surface2/60 px-2 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {file}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Executed Commands */}
        {hasCommands && (
          <div>
            <div className="text-[11px] font-medium text-foreground-muted mb-1 flex items-center gap-1">
              <Terminal className="size-3" />
              实际执行的命令流水 ({evidence.commands!.length})
            </div>
            <div className="space-y-1">
              {evidence.commands!.map((cmd, idx) => {
                const isPass = cmd.exitCode === 0;
                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-md border border-border/60 bg-surface2/40 px-2 py-1 font-mono text-[11px]"
                  >
                    <span className="truncate max-w-[70%] text-foreground">{cmd.command}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {cmd.exitCode !== undefined && (
                        <span
                          className={`rounded px-1.5 py-0.2 text-[10px] ${
                            isPass ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                          }`}
                        >
                          exit {cmd.exitCode}
                        </span>
                      )}
                      {cmd.durationMs !== undefined && (
                        <span className="text-[10px] text-foreground-extra-muted">
                          {(cmd.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Token Usage Footprint */}
        {usage && (
          <div className="flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-foreground-extra-muted">
            <span>
              Token 消耗：输入 {usage.prompt_tokens?.toLocaleString() || 0} / 输出 {usage.completion_tokens?.toLocaleString() || 0}
              {usage.cache_read_tokens ? ` · 缓存读取 ${usage.cache_read_tokens.toLocaleString()}` : ''}
            </span>
            <span className="flex items-center gap-1 text-[10px]">
              <Info className="size-2.5" />
              客观证据仅记录实际执行，不代表全部用例通过
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
