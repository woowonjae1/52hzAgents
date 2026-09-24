'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  ACP_COMMAND_PRESETS,
  ACP_PERMISSION_MODES,
  type AcpPermissionMode,
} from '@/lib/agent-catalog';

/**
 * The two settings an ACP agent needs before it can run: which command speaks
 * ACP (ACP_COMMAND) and how its permission requests are answered
 * (ACP_PERMISSION_MODE). Shared by the Connect view and the mission modal so
 * both hand wwj the same values.
 */
export function AcpSetupFields({
  idPrefix,
  command,
  onCommandChange,
  permissionMode,
  onPermissionModeChange,
  className,
}: {
  idPrefix: string;
  command: string;
  onCommandChange: (value: string) => void;
  permissionMode: AcpPermissionMode;
  onPermissionModeChange: (value: AcpPermissionMode) => void;
  className?: string;
}) {
  const commandId = `${idPrefix}-acp-command`;
  return (
    <div className={cn('space-y-4 text-left', className)}>
      <div className="space-y-1.5">
        <Label htmlFor={commandId} className="text-2xs font-medium text-foreground-extra-muted">
          Command
        </Label>
        <Input
          id={commandId}
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="gemini --experimental-acp"
          spellCheck={false}
          autoComplete="off"
          className="text-xs h-9 font-mono border-border focus:border-border-accent focus:ring-0 focus-visible:ring-0"
        />
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {ACP_COMMAND_PRESETS.map((preset) => {
            const active = command.trim() === preset.command;
            return (
              <button
                key={preset.command}
                type="button"
                onClick={() => onCommandChange(preset.command)}
                aria-pressed={active}
                className={cn(
                  'px-2 py-1 rounded-md border text-3xs font-mono ui-transition',
                  active
                    ? 'border-primary bg-surface1/50 text-foreground'
                    : 'border-border text-foreground-muted hover:border-border-accent hover:bg-surface2 hover:text-foreground',
                )}
              >
                {preset.command}
              </button>
            );
          })}
        </div>
        <p className="text-3xs text-muted-foreground">
          The CLI must be installed and signed in on the machine running wwj.
        </p>
      </div>

      <div className="space-y-1.5" role="radiogroup" aria-label="Permission requests">
        <span className="text-2xs font-medium text-foreground-extra-muted">Permission requests</span>
        <div className="grid grid-cols-1 gap-1">
          {ACP_PERMISSION_MODES.map((mode) => {
            const active = permissionMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPermissionModeChange(mode.value)}
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2 rounded-lg border text-left ui-transition',
                  active
                    ? 'border-primary bg-surface1/50'
                    : 'border-border hover:border-border-accent hover:bg-surface2',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 size-3 shrink-0 rounded-full border',
                    active ? 'border-primary border-[3.5px]' : 'border-border-accent',
                  )}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className={cn('block text-xs', active ? 'font-semibold text-foreground' : 'text-foreground-muted')}>
                    {mode.label}
                    {mode.value === 'ask' && <span className="ms-1.5 text-3xs font-normal text-foreground-extra-muted">Default</span>}
                  </span>
                  <span className="block text-3xs text-muted-foreground mt-0.5">{mode.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
