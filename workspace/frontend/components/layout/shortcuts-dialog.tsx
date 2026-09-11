'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KeyCombo } from '@/components/ui/kbd';
import { SHORTCUTS, type ShortcutGroup } from '@/lib/shortcuts';

const GROUP_ORDER: ShortcutGroup[] = ['General', 'Navigation', 'Threads', 'Panels'];

/**
 * The keyboard help sheet — `?`.
 *
 * An app that has shortcuts and no way to list them has shortcuts only for
 * the person who wrote them. Everything in here is read from `SHORTCUTS`, so
 * it cannot drift from what the handler actually binds.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const grouped = React.useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      items: SHORTCUTS.filter((s) => s.group === group),
    })).filter((g) => g.items.length > 0);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single-letter keys only fire when the focus is not in a text field.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 grid gap-6 sm:grid-cols-2">
          {grouped.map(({ group, items }) => (
            <section key={group} className="space-y-1.5">
              <h3 className="text-3xs font-semibold uppercase tracking-wider text-foreground-extra-muted px-1 pb-1">
                {group}
              </h3>
              {items.map((s) => (
                <div
                  key={s.id}
                  className="flex items-start justify-between gap-3 rounded-lg px-1.5 py-1.5 hover:bg-surface2/60 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-foreground leading-snug">{s.label}</p>
                    {s.scope && (
                      <p className="text-3xs text-foreground-extra-muted mt-0.5">{s.scope}</p>
                    )}
                  </div>
                  <KeyCombo keys={s.keys} className="shrink-0 pt-0.5" />
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
