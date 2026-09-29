'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { anchorOf, ChartTooltip, type ChartAnchor } from './chart-tooltip';

/*
  A GitHub-style calendar: one column per week, Monday at the top, one cell per
  day shaded by its count.

    <HeatCalendar days={days} unit="commit" selectedKey={k} onSelect={setK}>
      <HeatCalendarGrid>
        <HeatCalendarTooltip>{(day) => ...}</HeatCalendarTooltip>
      </HeatCalendarGrid>
      <HeatCalendarLegend />
    </HeatCalendar>

  The shading is one neutral ramp, not a brand green: the count is the only
  thing a cell says, and the workspace keeps colour for status and identity.
*/

export const HEAT_CELL = 11;
export const HEAT_GAP = 3;
/** Width of the weekday label column, for callers fitting weeks to a width. */
export const HEAT_LABEL_WIDTH = 28;

export interface HeatCalendarDay {
  /** Local calendar date, YYYY-MM-DD. */
  key: string;
  date: Date;
  count: number;
  /** After today: drawn as a blank slot, not as a zero. */
  future?: boolean;
}

interface HeatCalendarContextValue {
  days: HeatCalendarDay[];
  unit: string;
  max: number;
  selectedKey?: string | null;
  onSelect?: (day: HeatCalendarDay) => void;
  hovered: { day: HeatCalendarDay; anchor: ChartAnchor } | null;
  setHovered: (value: { day: HeatCalendarDay; anchor: ChartAnchor } | null) => void;
}

const HeatCalendarContext = React.createContext<HeatCalendarContextValue | null>(null);

function useHeatCalendar() {
  const ctx = React.useContext(HeatCalendarContext);
  if (!ctx) throw new Error('HeatCalendar parts must be rendered inside <HeatCalendar>');
  return ctx;
}

const LEVEL_CLASS = [
  'bg-foreground/[0.07]',
  'bg-foreground/25',
  'bg-foreground/45',
  'bg-foreground/65',
  'bg-foreground/85',
];

function levelOf(count: number, max: number) {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

export function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function HeatCalendar({
  days,
  unit,
  maxCount,
  selectedKey,
  onSelect,
  className,
  children,
}: {
  /** Week-major, Monday first; the length must be a multiple of 7. */
  days: HeatCalendarDay[];
  /** Singular noun for a count, e.g. "commit". */
  unit: string;
  /** Count at which a cell is fully shaded. Defaults to the busiest day shown. */
  maxCount?: number;
  selectedKey?: string | null;
  onSelect?: (day: HeatCalendarDay) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = React.useState<HeatCalendarContextValue['hovered']>(null);
  const max = maxCount ?? days.reduce((m, d) => Math.max(m, d.count), 0);
  const value = React.useMemo(
    () => ({ days, unit, max, selectedKey, onSelect, hovered, setHovered }),
    [days, unit, max, selectedKey, onSelect, hovered],
  );
  return (
    <HeatCalendarContext.Provider value={value}>
      <div className={cn('flex flex-col gap-2', className)}>{children}</div>
    </HeatCalendarContext.Provider>
  );
}

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

export function HeatCalendarGrid({ children, className }: { children?: React.ReactNode; className?: string }) {
  const { days, max, unit, selectedKey, onSelect, setHovered } = useHeatCalendar();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const weeks = Math.floor(days.length / 7);

  const monthLabels = React.useMemo(() => {
    const labels: { week: number; text: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const first = days[w * 7]?.date;
      if (!first) continue;
      const month = first.getMonth();
      if (month !== lastMonth) {
        labels.push({ week: w, text: first.toLocaleDateString('en-US', { month: 'short' }) });
        lastMonth = month;
      }
    }
    // A month that only shows a column or two at the left edge would sit on
    // top of the next one's label; that one is the label worth keeping.
    if (labels.length > 1 && labels[1].week - labels[0].week < 3) labels.shift();
    return labels;
  }, [days, weeks]);

  const show = (day: HeatCalendarDay, el: Element) => {
    if (containerRef.current) setHovered({ day, anchor: anchorOf(el, containerRef.current) });
  };

  const step = HEAT_CELL + HEAT_GAP;

  return (
    <div ref={containerRef} className={cn('relative w-fit max-w-full', className)} onMouseLeave={() => setHovered(null)}>
      <div className="relative mb-1 h-3.5 text-2xs text-foreground-extra-muted" style={{ marginLeft: HEAT_LABEL_WIDTH }}>
        {monthLabels.map((m) => (
          <span key={m.week} className="absolute top-0" style={{ left: m.week * step }}>
            {m.text}
          </span>
        ))}
      </div>
      <div className="flex">
        <div
          aria-hidden
          className="grid shrink-0 text-2xs leading-none text-foreground-extra-muted"
          style={{ width: HEAT_LABEL_WIDTH, gridTemplateRows: `repeat(7, ${HEAT_CELL}px)`, rowGap: HEAT_GAP }}
        >
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className="flex items-center">
              {label}
            </span>
          ))}
        </div>
        <div
          role="group"
          aria-label={`${unit}s per day`}
          className="grid grid-flow-col"
          style={{
            gridTemplateRows: `repeat(7, ${HEAT_CELL}px)`,
            gridAutoColumns: `${HEAT_CELL}px`,
            gap: HEAT_GAP,
          }}
        >
          {days.map((day) =>
            day.future ? (
              <span key={day.key} aria-hidden />
            ) : (
              <button
                key={day.key}
                type="button"
                aria-pressed={day.key === selectedKey}
                aria-label={`${plural(day.count, unit)} on ${day.date.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}`}
                onClick={() => onSelect?.(day)}
                onMouseEnter={(e) => show(day, e.currentTarget)}
                onFocus={(e) => show(day, e.currentTarget)}
                onBlur={() => setHovered(null)}
                className={cn(
                  'rounded-[2px] outline-none transition-shadow',
                  LEVEL_CLASS[levelOf(day.count, max)],
                  'hover:ring-1 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring',
                  day.key === selectedKey && 'ring-1 ring-foreground ring-offset-1 ring-offset-card',
                )}
              />
            ),
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The hovered day's card. Without children it says "3 commits on Mon, Sep 28". */
export function HeatCalendarTooltip({ children }: { children?: (day: HeatCalendarDay) => React.ReactNode }) {
  const { hovered, unit } = useHeatCalendar();
  if (!hovered) return null;
  const { day } = hovered;
  return (
    <ChartTooltip anchor={hovered.anchor}>
      {children ? (
        children(day)
      ) : (
        <>
          <span className="font-medium text-foreground">{plural(day.count, unit)}</span>{' '}
          <span className="text-muted-foreground">
            on {day.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </>
      )}
    </ChartTooltip>
  );
}

export function HeatCalendarLegend({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 text-2xs text-foreground-extra-muted', className)}>
      <span className="min-w-0">{children}</span>
      <span className="flex items-center gap-1">
        Less
        {LEVEL_CLASS.map((cls) => (
          <span key={cls} aria-hidden className={cn('rounded-[2px]', cls)} style={{ width: HEAT_CELL, height: HEAT_CELL }} />
        ))}
        More
      </span>
    </div>
  );
}
