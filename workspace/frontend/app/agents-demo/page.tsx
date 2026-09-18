'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Sparkles,
  Bot,
  FileCode2,
  Bell,
  Code,
} from 'lucide-react';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { FileTree, FileTreeFolder, FileTreeFile } from '@/components/motion/file-tree';
import { AnimatedToastStack, type AnimatedToast } from '@/components/motion/animated-toast-stack';
import { TodoList, type TodoItem } from '@/components/agents/todo-list';
import { ApprovalCard } from '@/components/agents/approval-card';
import { FileDiff, type FileDiffLine } from '@/components/agents/file-diff';
import { ThinkingShimmer } from '@/components/agents/loading-states/thinking-shimmer';
import { PromptInput } from '@/components/agents/prompt-input';
import { Citations, type CitationItem } from '@/components/agents/citations';

export default function AgentsDemoPage() {
  const [activeFile, setActiveFile] = useState<string | null>('pi.js');
  const [promptText, setPromptText] = useState('');
  const [selectedModel, setSelectedModel] = useState('qwen-max');
  const [toasts, setToasts] = useState<AnimatedToast[]>([]);

  const addToast = (title: string, description: string, status: 'info' | 'success' | 'error' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, title, description, status }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const [todoItems] = useState<TodoItem[]>([
    {
      id: '1',
      title: 'Analyze multi-agent communication protocols',
      status: 'completed',
      detail: 'Checked Go websocket gateway & pi adapter contracts',
    },
    {
      id: '2',
      title: 'Integrate beUI motion & agent components',
      status: 'in-progress',
      progress: 85,
      detail: '55 components unpacked, Shimmer & ActionSwapRoll connected',
    },
    {
      id: '3',
      title: 'Run TypeScript & Next.js production builds',
      status: 'pending',
      detail: 'Verify zero errors across desktop release',
    },
  ]);

  const diffLines: FileDiffLine[] = [
    { id: '1', type: 'context', content: 'export function ThinkingMessage() {' },
    { id: '2', type: 'removed', content: '  // Old plain text thinking' },
    { id: '3', type: 'removed', content: '  return <div>Thinking...</div>;' },
    { id: '4', type: 'added', content: '  // New beUI dynamic breathing shimmer' },
    { id: '5', type: 'added', content: '  return <ThinkingShimmer duration={1.8}>Thinking…</ThinkingShimmer>;' },
    { id: '6', type: 'context', content: '}' },
  ];

  const citations: CitationItem[] = [
    {
      id: '1',
      title: 'beUI Components Registry Documentation',
      url: 'https://beui.dev/components/agents/chat-app',
      domain: 'beui.dev',
    },
    {
      id: '2',
      title: 'OpenAgents Multi-Agent Orchestration',
      url: 'https://github.com/openagents/openagents',
      domain: 'github.com',
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Back to Workspace</span>
          </Link>
          <span className="text-border">|</span>
          <div className="flex items-center gap-2 font-semibold text-base">
            <Sparkles className="size-4 text-primary animate-pulse" />
            <span>beUI Agent Ecosystem Showcase</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() =>
              addToast(
                'Agent Workflow Triggered',
                'OpenAgents background coordination running smoothly.',
                'success'
              )
            }
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 text-xs font-medium transition-colors"
          >
            <Bell className="size-3.5" />
            <span>Test Toast Stack</span>
          </button>
          <ThemeToggle variant="circle" />
        </div>
      </header>

      {/* Main Showcase Grid */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-8">
        {/* Banner */}
        <section className="rounded-2xl border border-primary/20 bg-primary/5 p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Bot className="size-5 text-primary" />
              Next-Gen Agent Interface Components
            </h1>
            <p className="text-sm text-foreground-muted">
              55 custom motion-enhanced components fully integrated into 52hzAgents.
            </p>
          </div>
          <div className="flex items-center gap-3 bg-surface2 px-4 py-2 rounded-xl border border-border shadow-xs">
            <span className="text-xs text-foreground-muted">Live Reasoning:</span>
            <ThinkingShimmer duration={1.8} className="text-sm font-semibold text-primary">
              Analyzing Workspace Context…
            </ThinkingShimmer>
          </div>
        </section>

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: File Tree & Todo List */}
          <div className="lg:col-span-4 space-y-6">
            {/* FileTree Component */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                  Interactive File Tree
                </span>
                <span className="text-xs text-foreground-extra-muted font-mono">{activeFile}</span>
              </div>
              <FileTree
                value={activeFile}
                onValueChange={setActiveFile}
                className="bg-background rounded-lg border border-border/70 p-2"
              >
                <FileTreeFolder value="packages" name="packages">
                  <FileTreeFolder value="wwj" name="wwj">
                    <FileTreeFolder value="adapters" name="adapters">
                      <FileTreeFile value="pi.js" name="pi.js" icon={<FileCode2 className="size-3.5 text-amber-500" />} />
                      <FileTreeFile value="antigravity.js" name="antigravity.js" icon={<FileCode2 className="size-3.5 text-blue-500" />} />
                    </FileTreeFolder>
                  </FileTreeFolder>
                </FileTreeFolder>
                <FileTreeFolder value="workspace" name="workspace">
                  <FileTreeFolder value="frontend" name="frontend">
                    <FileTreeFolder value="components" name="components">
                      <FileTreeFile value="chat-view.tsx" name="chat-view.tsx" icon={<FileCode2 className="size-3.5 text-cyan-500" />} />
                      <FileTreeFile value="thinking-message.tsx" name="thinking-message.tsx" icon={<FileCode2 className="size-3.5 text-emerald-500" />} />
                    </FileTreeFolder>
                  </FileTreeFolder>
                </FileTreeFolder>
              </FileTree>
            </div>

            {/* TodoList Component */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs">
              <TodoList
                title="Agent Execution Plan"
                items={todoItems}
                defaultOpen={true}
                className="bg-background rounded-lg border border-border/70 p-1"
              />
            </div>

            {/* Citations Component */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs">
              <Citations citations={citations} defaultOpen={true} />
            </div>
          </div>

          {/* Right Column: Approval Card, File Diff & Prompt Input */}
          <div className="lg:col-span-8 space-y-6">
            {/* Tool Approval Card */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs space-y-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                Agent Tool Execution Approval
              </span>
              <ApprovalCard
                title="Execute git commit"
                description="The agent is requesting permission to commit 55 new visual modules to git."
                status="pending"
                onApprove={() =>
                  addToast(
                    'Command Approved',
                    'Git commit executed successfully.',
                    'success'
                  )
                }
                onReject={() =>
                  addToast(
                    'Command Rejected',
                    'Tool execution was cancelled by user policy.',
                    'error'
                  )
                }
              >
                <div className="p-3 bg-background rounded-lg border border-border font-mono text-xs text-foreground-muted flex items-center gap-2">
                  <Code className="size-3.5 text-primary" />
                  <span>git commit -m &quot;feat: full beUI agent components integration&quot;</span>
                </div>
              </ApprovalCard>
            </div>

            {/* File Diff Card */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                  Agent File Diff Preview
                </span>
                <span className="text-xs text-foreground-extra-muted font-mono">
                  components/chat/thinking-message.tsx
                </span>
              </div>
              <FileDiff
                file="thinking-message.tsx"
                lines={diffLines}
                defaultOpen={true}
              />
            </div>

            {/* Modular Prompt Input */}
            <div className="rounded-xl border border-border bg-surface1 p-4 shadow-xs space-y-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                Modern Motion Prompt Input
              </span>
              <PromptInput
                value={promptText}
                onValueChange={setPromptText}
                placeholder="Message @pi or ask agent to run tasks..."
                model={selectedModel}
                onModelChange={setSelectedModel}
                models={[
                  { value: 'qwen-max', label: 'Qwen 3.6 Max' },
                  { value: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
                  { value: 'pi-agent', label: 'Pi Local Agent' },
                ]}
                onSubmit={(val) => {
                  addToast('Prompt Sent', val, 'info');
                  setPromptText('');
                }}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Global Toast Stack */}
      <AnimatedToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
        position="bottom-right"
      />
    </div>
  );
}
