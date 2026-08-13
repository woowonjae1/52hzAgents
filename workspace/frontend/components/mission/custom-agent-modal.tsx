'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Puzzle } from 'lucide-react';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { EXTRA_AGENT_RUNTIMES } from '@/lib/agent-catalog';
import { cn } from '@/lib/utils';

interface CustomAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the agent is registered and its launch has been requested. */
  onConnected?: (agentName: string) => void;
}

const CUSTOM = 'custom';

/**
 * Configure an agent that is not on the six-card roster.
 *
 * Two cases, one form:
 *  - a runtime wwj already adapts (Goose, Cline, Aider…) → pick it, no command
 *  - anything else (Kilo, an in-house CLI, a script) → type `custom` plus the
 *    command to run
 *
 * The old behaviour was a bare Connect button on the `custom` card, which ran
 * `wwj connect custom` and silently started OpenClaw — connecting something the
 * user never chose.
 */
export function CustomAgentModal({ open, onOpenChange, onConnected }: CustomAgentModalProps) {
  const [agentName, setAgentName] = useState('');
  const [runtime, setRuntime] = useState<string>(CUSTOM);
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [saving, setSaving] = useState(false);

  const isCustom = runtime === CUSTOM;
  const nameValid = /^[A-Za-z0-9._-]{1,64}$/.test(agentName);
  const canSubmit = nameValid && (!isCustom || command.trim().length > 0) && !saving;

  const reset = () => {
    setAgentName('');
    setRuntime(CUSTOM);
    setCommand('');
    setArgs('');
    setWorkingDir('');
  };

  const submit = async () => {
    setSaving(true);
    try {
      await workspaceApi.createAgent({
        agentName,
        agentType: runtime,
        command: isCustom ? command.trim() : '',
        args: isCustom ? args.trim() : '',
        workingDir: workingDir.trim(),
      });
      await workspaceApi.launchAgent(agentName, workingDir.trim() || undefined);
      toast.success(`${agentName} registered and launching. Agent terminal window opened.`);
      onConnected?.(agentName);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Could not add ${agentName}: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-surface2 flex items-center justify-center text-foreground-muted">
              <Puzzle className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-semibold">Add another agent</DialogTitle>
              <DialogDescription className="text-xs">
                Connect a runtime that is not on the roster — or any CLI of your own.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="custom-agent-name" className="text-xs">Agent name</Label>
            <Input
              id="custom-agent-name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. kilo"
              className="h-9 text-xs"
            />
            <p className="text-[10px] text-foreground-extra-muted">
              {agentName && !nameValid
                ? 'Letters, digits, dot, underscore and hyphen only.'
                : 'How this agent appears in the workspace and in @mentions.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Runtime</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {[{ name: CUSTOM, label: 'Custom command' }, ...EXTRA_AGENT_RUNTIMES].map((rt) => (
                <button
                  key={rt.name}
                  type="button"
                  onClick={() => setRuntime(rt.name)}
                  className={cn(
                    'h-8 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer',
                    runtime === rt.name
                      ? 'border-border-accent bg-surface2 text-foreground'
                      : 'border-border bg-card text-foreground-muted hover:border-border-accent',
                  )}
                >
                  {rt.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-foreground-extra-muted">
              {isCustom
                ? 'Runs a command you supply — use this for anything with no built-in adapter.'
                : 'Built-in adapter. wwj installs and drives this runtime for you.'}
            </p>
          </div>

          {isCustom && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="custom-agent-command" className="text-xs">Command</Label>
                <Input
                  id="custom-agent-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. kilo"
                  className="h-9 text-xs font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="custom-agent-args" className="text-xs">Arguments (optional)</Label>
                <Input
                  id="custom-agent-args"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="e.g. run --quiet {prompt}"
                  className="h-9 text-xs font-mono"
                />
                <p className="text-[10px] text-foreground-extra-muted">
                  Include <code className="font-mono">{'{prompt}'}</code> to pass the message as an
                  argument; leave it out and the message is written to the command&apos;s stdin.
                  Also available: <code className="font-mono">{'{agent} {channel} {cwd}'}</code>.
                </p>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="custom-agent-dir" className="text-xs">Working directory (optional)</Label>
            <Input
              id="custom-agent-dir"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="D:\\code\\my-project"
              className="h-9 text-xs font-mono"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="h-8 text-xs">
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={submit} className="h-8 text-xs gap-1.5">
              {saving && <Loader2 className="size-3 animate-spin" />}
              Add and connect
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
