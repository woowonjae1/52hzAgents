'use client';

import * as React from 'react';
import { Terminal, Copy, Check, Sparkles, Plus, ArrowRight, Plug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { DEFAULT_AGENT_CATALOG } from '@/lib/agent-catalog';

interface OnboardingGuideProps {
  onQuickConnect: (agentName: string) => void;
  className?: string;
}

export function OnboardingGuide({ onQuickConnect, className }: OnboardingGuideProps) {
  const [copiedStep, setCopiedStep] = React.useState<number | null>(null);

  const copyCmd = (cmd: string, stepIdx: number) => {
    navigator.clipboard.writeText(cmd);
    setCopiedStep(stepIdx);
    toast.success('命令已复制到剪贴板');
    setTimeout(() => setCopiedStep(null), 2000);
  };

  const steps = [
    {
      title: '1. 全局安装 agn 智能体 CLI',
      desc: '安装 52hzAgents 官方终端连接器与进程守护套件',
      cmd: 'npm install -g @52hz/agn',
    },
    {
      title: '2. 快速创建或接入智能体',
      desc: '初始化支持 ACP / MCP 协议的本地工作 Agent 实例',
      cmd: 'agn create my-agent --type claude',
    },
    {
      title: '3. 启动并连接到当前协同网',
      desc: '建立双向实时通道，立即加入工作区多 Agent 席位',
      cmd: 'agn connect my-agent',
    },
  ];

  return (
    <div
      className={cn(
        'rounded-3xl border border-primary/20 bg-surface1/95 p-6 space-y-6 shadow-sm',
        className
      )}
    >
      {/* Title */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            <h2 className="text-base font-bold text-foreground tracking-tight">
              接入你的第一个 AI Agent
            </h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
            52hzAgents 支持接入 Claude Code、OpenClaw、Aider、Antigravity 等任意本地或云端 Agent。仅需 3 步即可完成接入：
          </p>
        </div>
      </div>

      {/* 3 Step Interactive Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {steps.map((step, idx) => (
          <div
            key={idx}
            className="flex flex-col justify-between p-4 rounded-2xl bg-surface2/60 border border-border/70 space-y-3 shadow-2xs hover:border-primary/40 transition-colors"
          >
            <div className="space-y-1">
              <div className="font-semibold text-xs text-foreground">{step.title}</div>
              <div className="text-[11px] text-muted-foreground leading-snug">{step.desc}</div>
            </div>

            <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-neutral-900 text-neutral-100 font-mono text-[11px] border border-neutral-800">
              <span className="truncate">{step.cmd}</span>
              <button
                type="button"
                onClick={() => copyCmd(step.cmd, idx)}
                className="size-6 rounded-md hover:bg-neutral-800 flex items-center justify-center text-neutral-400 hover:text-white transition-colors cursor-pointer shrink-0"
                title="复制命令"
              >
                {copiedStep === idx ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Launch Preset Agents */}
      <div className="space-y-2.5 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Zap className="size-3.5 text-primary" />
          <span>或一键启动内置智能体模板：</span>
        </div>

        <div className="flex flex-wrap gap-2">
          {DEFAULT_AGENT_CATALOG.slice(0, 6).map((cat) => (
            <button
              key={cat.name}
              type="button"
              onClick={() => onQuickConnect(cat.name)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface2 hover:bg-surface3 border border-border/80 text-xs font-medium text-foreground transition-all cursor-pointer shadow-2xs group"
            >
              <Plug className="size-3 text-muted-foreground group-hover:text-primary transition-colors" />
              <span>{cat.name}</span>
              <ArrowRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
