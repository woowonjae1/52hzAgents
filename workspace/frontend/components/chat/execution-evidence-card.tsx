'use client';

import * as React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  FileCode,
  Terminal,
  Shield,
  Ban,
  StopCircle,
  Info,
  ExternalLink,
} from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
  };
}) {
  const { setActiveRightTab } = useLayout();
  const hasFiles = Boolean(evidence.files_modified && evidence.files_modified.length > 0);
  const hasCommands = Boolean(evidence.commands && evidence.commands.length > 0);

  if (
    !hasFiles &&
    !hasCommands &&
    !evidence.denied &&
    !evidence.interrupted &&
    !evidence.limited &&
    !['failed', 'timed_out', 'expired'].includes(evidence.outcome || '')
  ) {
    return null;
  }

  const failedCommandsCount =
    evidence.commands?.filter(
      (cmd) => cmd.exitCode !== undefined && cmd.exitCode !== 0,
    ).length || 0;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-surface1/60 text-xs shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 bg-surface2/30 px-3 py-2">
        <span className="font-medium text-foreground flex items-center gap-1.5">
          <Shield className="size-3.5 text-primary" />
          修改与执行结果
        </span>
        <div className="flex items-center gap-1.5 text-[11px]">
          {evidence.outcome === 'failed' || evidence.outcome === 'timed_out' ? (
            <span className="text-red-400">
              {evidence.outcome === 'timed_out' ? '运行超时' : '运行失败'}
            </span>
          ) : evidence.outcome === 'expired' ? (
            <span className="text-amber-400">审批已过期</span>
          ) : evidence.denied ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400 flex items-center gap-1">
              <Ban className="size-3" /> 用户拒绝命令
            </span>
          ) : evidence.interrupted ? (
            <span className="rounded bg-surface2 px-1.5 py-0.5 text-foreground-muted flex items-center gap-1">
              <StopCircle className="size-3" />{' '}
              {evidence.outcome === 'interrupted'
                ? '应用退出或异常中断'
                : '用户主动停止'}
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

      <div className="px-3 py-2 text-foreground-muted flex items-center justify-between">
        <span>
          修改 {evidence.files_modified?.length || 0} 个文件 · 执行{' '}
          {evidence.commands?.length || 0} 条命令
          {failedCommandsCount > 0 ? (
            <span className="text-red-400 font-medium ml-1">
              · 非零退出码 {failedCommandsCount} 条
            </span>
          ) : (
            ' · 全部命令正常退出'
          )}
          。运行结束不代表所有检查通过。
        </span>
      </div>

      <details className="px-3 pb-3">
        <summary className="cursor-pointer text-foreground-muted hover:text-foreground transition-colors">
          查看文件与命令记录
        </summary>
        <div className="pt-3 space-y-2.5">
          {/* Modified Files */}
          {hasFiles && (
            <div>
              <div className="text-[11px] font-medium text-foreground-muted mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <FileCode className="size-3" />
                  观察到的文件修改 ({evidence.files_modified!.length}) ·{' '}
                  {evidence.file_observation === 'git-visible'
                    ? 'Git 可见变化及文件工具记录'
                    : '仅文件工具记录，命令改动未完整检测'}
                </span>
                <button
                  type="button"
                  onClick={() => setActiveRightTab('diff')}
                  className="inline-flex items-center gap-1 rounded border border-border/80 bg-surface2/80 px-2 py-0.5 text-[10px] text-primary hover:bg-surface3 transition-colors"
                  title="在右侧面板查看变更对比"
                >
                  <ExternalLink className="size-2.5" />
                  在 Diff 面板查看变更
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {evidence.files_modified!.map((file) => (
                  <button
                    key={file}
                    type="button"
                    onClick={() => setActiveRightTab('diff')}
                    className="group inline-flex items-center gap-1 rounded-md border border-border bg-surface2/60 px-2 py-0.5 font-mono text-[11px] text-foreground hover:border-primary/50 hover:bg-surface2 transition-colors cursor-pointer"
                    title={`在 Diff 中查看 ${file}`}
                  >
                    <span>{file}</span>
                    <ExternalLink className="size-2.5 opacity-0 group-hover:opacity-100 transition-opacity text-primary" />
                  </button>
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
                      className={`flex items-center justify-between rounded-md border px-2 py-1 font-mono text-[11px] ${
                        isPass
                          ? 'border-border/60 bg-surface2/40'
                          : 'border-red-500/30 bg-red-500/10'
                      }`}
                    >
                      <span className="truncate max-w-[70%] text-foreground flex items-center gap-1.5">
                        {!isPass && (
                          <AlertTriangle className="size-3 text-red-400 shrink-0" />
                        )}
                        {cmd.command}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        {cmd.exitCode !== undefined && (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              isPass
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-red-500/20 text-red-400'
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
                Token 消耗：输入 {usage.prompt_tokens?.toLocaleString() || 0} / 输出{' '}
                {usage.completion_tokens?.toLocaleString() || 0}
                {usage.cache_read_tokens
                  ? ` · 缓存读取 ${usage.cache_read_tokens.toLocaleString()}`
                  : ''}
              </span>
              <span className="flex items-center gap-1 text-[10px]">
                <Info className="size-2.5" />
                客观证据仅记录实际执行，不代表全部用例通过
              </span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
