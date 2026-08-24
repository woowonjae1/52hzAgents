'use client';

import * as React from 'react';
import { Waypoints, Crown, Sparkles, Check, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceAgent } from '@/lib/types';

type Mode = 'dynamic' | 'master' | 'workflow';

const MODES: { value: Mode; label: string; icon: React.ElementType; description: string }[] = [
  {
    value: 'dynamic',
    label: 'Dynamic',
    icon: Sparkles,
    description: 'A router model picks the best next agent each turn.',
  },
  {
    value: 'master',
    label: 'Master / sub-agents',
    icon: Crown,
    description: 'Everything goes to the leader, who delegates and collects results.',
  },
  {
    value: 'workflow',
    label: 'Custom workflow',
    icon: Waypoints,
    description: 'Write a plan in plain language; the router follows it.',
  },
];

interface Props {
  session: WorkspaceSession;
  agents: WorkspaceAgent[];
  onChange: (updates: { mode?: Mode; instruction?: string | null; verificationCmd?: string | null }) => void;
  /** 'submenu' nests this under a parent DropdownMenu (the thread header's
   * overflow menu) instead of rendering its own standalone trigger button. */
  variant?: 'standalone' | 'submenu';
}

/**
 * Lets the user pick how a multi-agent thread coordinates: dynamic router
 * (default), master/sub-agent, or a custom natural-language workflow. The
 * custom workflow opens an editor with @agent autocomplete.
 */
export function OrchestrationControl({ session, agents, onChange, variant = 'standalone' }: Props) {
  const mode = (session.orchestrationMode || 'dynamic') as Mode;
  const active = MODES.find((m) => m.value === mode) || MODES[0];
  const [planOpen, setPlanOpen] = React.useState(false);
  const [qualityGateOpen, setQualityGateOpen] = React.useState(false);

  const selectMode = (next: Mode) => {
    if (next === 'workflow') {
      // Entering workflow mode always opens the plan editor so the user can
      // author (or review) the plan the router will follow.
      setPlanOpen(true);
      if (mode !== 'workflow') onChange({ mode: 'workflow' });
    } else {
      onChange({ mode: next });
    }
  };

  const ActiveIcon = active.icon;

  const items = (
    <>
      {MODES.map((m) => {
        const Icon = m.icon;
        const isActive = m.value === mode;
        return (
          <DropdownMenuItem
            key={m.value}
            onSelect={(e) => {
              // Keep the menu semantics simple; workflow opens a dialog.
              e.preventDefault();
              selectMode(m.value);
            }}
            className="flex items-start gap-2 py-2 cursor-pointer"
          >
            <Icon className="size-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{m.label}</span>
                {isActive && <Check className="size-3 text-primary" />}
              </div>
              <p className="text-2xs text-muted-foreground leading-snug">{m.description}</p>
            </div>
          </DropdownMenuItem>
        );
      })}
      {mode === 'workflow' && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setPlanOpen(true);
            }}
            className="text-xs cursor-pointer"
          >
            Edit workflow plan…
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          setQualityGateOpen(true);
        }}
        className="flex items-start gap-2 py-2 cursor-pointer"
      >
        <ShieldCheck className="size-3.5 mt-0.5 shrink-0 text-primary" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">质量门验证命令…</span>
            {session.verificationCmd && (
              <span className="text-3xs px-1.5 py-0.2 rounded bg-primary/10 text-primary font-mono truncate max-w-[100px]">
                {session.verificationCmd}
              </span>
            )}
          </div>
          <p className="text-2xs text-muted-foreground leading-snug">
            设置 Turn 结束时的真实验证命令（如 go test / npm test）
          </p>
        </div>
      </DropdownMenuItem>
    </>
  );

  return (
    <>
      {variant === 'submenu' ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 text-xs">
            <ActiveIcon className="size-3.5 text-foreground-muted" />
            Collaboration mode
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">{items}</DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-7 text-xs font-medium"
              title="Collaboration mode"
            >
              <ActiveIcon className="size-3.5" />
              <span className="hidden lg:inline">{active.label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Collaboration mode</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <WorkflowPlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        agents={agents}
        initialValue={session.orchestrationInstruction || ''}
        onSave={(instruction) => onChange({ mode: 'workflow', instruction: instruction || null })}
      />

      <QualityGateDialog
        open={qualityGateOpen}
        onOpenChange={setQualityGateOpen}
        initialValue={session.verificationCmd || ''}
        onSave={(cmd) => onChange({ verificationCmd: cmd || null })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Plan editor with @agent autocomplete
export interface WorkflowPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: WorkspaceAgent[];
  initialValue: string;
  onSave: (instruction: string) => void;
}

export function WorkflowPlanDialog({ open, onOpenChange, agents, initialValue, onSave }: WorkflowPlanDialogProps) {
  const [value, setValue] = React.useState(initialValue);
  const [showMentions, setShowMentions] = React.useState(false);
  const [mentionFilter, setMentionFilter] = React.useState('');
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Reset the draft whenever the dialog is (re)opened.
  React.useEffect(() => {
    if (open) {
      setValue(initialValue);
      setShowMentions(false);
    }
  }, [open, initialValue]);

  const filteredAgents = React.useMemo(
    () => agents.filter((a) => a.agentName.toLowerCase().includes(mentionFilter.toLowerCase())),
    [agents, mentionFilter],
  );

  const detectMention = (el: HTMLTextAreaElement, text: string) => {
    const cursor = el.selectionStart;
    const before = text.slice(0, cursor);
    const at = before.match(/@([\w-]*)$/);
    if (at && agents.length > 0) {
      setMentionFilter(at[1]);
      setMentionIndex(0);
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const next = before.slice(0, at) + `@${name} ` + after;
    setValue(next);
    setShowMentions(false);
    // Restore caret just after the inserted mention.
    requestAnimationFrame(() => {
      const pos = at + name.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((p) => (p + 1) % filteredAgents.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredAgents[mentionIndex].agentName);
      } else if (e.key === 'Escape') {
        setShowMentions(false);
      }
    }
  };

  const save = () => {
    onSave(value.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Custom collaboration workflow</DialogTitle>
          <DialogDescription>
            Describe, in plain language, how the agents should collaborate. Use{' '}
            <span className="font-mono">@</span> to reference an agent. The router follows this plan
            when deciding who responds next.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              detectMention(e.target, e.target.value);
            }}
            onKeyDown={onKeyDown}
            rows={6}
            autoFocus
            placeholder={
              'e.g. First @tester writes test cases for the requirement. Then @coder ' +
              'implements the code. Finally @reviewer runs the tests and fixes any bugs.'
            }
            className="w-full resize-none rounded-md border bg-transparent p-3 text-sm outline-none focus:border-primary"
          />
          {showMentions && filteredAgents.length > 0 && (
            <div className="absolute left-3 right-3 z-50 mt-1 max-h-44 overflow-auto rounded-md border bg-popover shadow-md">
              {filteredAgents.map((a, i) => (
                <button
                  key={a.agentName}
                  type="button"
                  onClick={() => insertMention(a.agentName)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface2',
                    i === mentionIndex && 'bg-surface2',
                  )}
                >
                  <span className="font-medium">@{a.agentName}</span>
                  {a.role === 'master' && <Crown className="size-3 text-status-warning" />}
                  <span
                    className={cn(
                      'ml-auto size-1.5 rounded-full',
                      a.status === 'online' ? 'bg-status-success' : 'bg-foreground-extra-muted',
                    )}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Quality Gate Verification Command Dialog
export interface QualityGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: string;
  onSave: (command: string) => void;
}

export function QualityGateDialog({ open, onOpenChange, initialValue, onSave }: QualityGateDialogProps) {
  const [value, setValue] = React.useState(initialValue);

  React.useEffect(() => {
    if (open) {
      setValue(initialValue);
    }
  }, [open, initialValue]);

  const save = () => {
    onSave(value.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <DialogTitle>质量门真实验证命令</DialogTitle>
          </div>
          <DialogDescription>
            显式配置此会话的真实编译与测试命令（如 <code className="font-mono text-2xs bg-surface2 px-1 py-0.5 rounded">go test ./...</code>、<code className="font-mono text-2xs bg-surface2 px-1 py-0.5 rounded">npm test</code>、<code className="font-mono text-2xs bg-surface2 px-1 py-0.5 rounded">pytest</code>）。
            系统会在 Agent 开始前记录初始基线，结束时对比差集，仅当引入<strong>新错误或回归</strong>时才会触发自愈修复。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <label className="text-xs font-medium text-foreground">验证命令 (Verification Command)</label>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            placeholder="例如: go test ./... 或 npm test"
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-primary"
          />
          <p className="text-3xs text-muted-foreground">留空则表示关闭真实验证，回退至散文文本启发式检测。</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={save}>
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}