'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/*
  THE ONE CARD RECIPE ON HOME.

  Every block on the page answers the same two questions before it shows
  anything -- what is this, and what state is it in -- so each one is a title
  plus a one-line subtitle, then its content. Label-above-value for fields.
  A raised `bg-card` with one hairline and no shadow: the page is a surface of
  equals, and the only thing that should read as louder than the rest is the
  one primary button.
*/

export function HomePanel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('rounded-xl border border-border bg-card p-4', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children !== undefined && <div className={cn('mt-3', bodyClassName)}>{children}</div>}
    </section>
  );
}

/** Small muted label over its value. */
export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-2xs font-medium text-foreground-extra-muted">
      {children}
    </label>
  );
}

/** A read-only value drawn like an input, for facts that are not editable here. */
export function FieldValue({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-xs text-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Online / working / offline, in the two accents the workspace spends on status. */
export function StatusDot({ state, className }: { state: 'online' | 'working' | 'offline'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        state === 'working'
          ? 'bg-status-warning'
          : state === 'online'
            ? 'bg-status-success'
            : 'bg-foreground-extra-muted/50',
        className,
      )}
    />
  );
}

/** A row inside a list panel: icon, text, trailing actions. */
export function HomeRow({
  icon,
  title,
  detail,
  meta,
  actions,
  onClick,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon && <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        {detail && <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{detail}</span>}
      </span>
      {meta && <span className="shrink-0 pt-0.5 text-2xs tabular-nums text-foreground-extra-muted">{meta}</span>}
    </>
  );
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface2/60">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-2.5">{body}</span>
      )}
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </li>
  );
}
