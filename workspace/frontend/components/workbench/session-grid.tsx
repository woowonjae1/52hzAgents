'use client';

import * as React from 'react';
import { useRef, useCallback, useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useSessionGrid } from '@/lib/session-grid-context';
import { SessionCell } from './session-cell';

interface SessionGridProps {
  children: React.ReactNode;
  className?: string;
}

export function SessionGrid({ children, className }: SessionGridProps) {
  const {
    isSplit,
    secondarySessionId,
    splitRatio,
    splitOrientation,
    setSplitRatio,
    setSecondarySessionId,
    swapSessions,
    closeSplit,
  } = useSessionGrid();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);

      const isHorizontal = splitOrientation === 'horizontal';

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (isHorizontal) {
          const offsetX = moveEvent.clientX - rect.left;
          const ratio = offsetX / rect.width;
          setSplitRatio(ratio);
        } else {
          const offsetY = moveEvent.clientY - rect.top;
          const ratio = offsetY / rect.height;
          setSplitRatio(ratio);
        }
      };

      const handlePointerUp = () => {
        setIsDragging(false);
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [splitOrientation, setSplitRatio]
  );

  if (!isSplit || !secondarySessionId) {
    return <div className={cn('h-full w-full', className)}>{children}</div>;
  }

  const isHorizontal = splitOrientation === 'horizontal';

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full w-full overflow-hidden select-text',
        isHorizontal ? 'flex-row' : 'flex-col',
        isDragging && 'select-none pointer-events-none cursor-col-resize',
        className
      )}
    >
      {/* Primary Session Cell (Main ChatView) */}
      <div
        style={{ flex: `${splitRatio} 1 0%` }}
        className="min-w-0 min-h-0 h-full overflow-hidden"
      >
        {children}
      </div>

      {/* Resize Handle (ported from cdesktop ResizeHandle) */}
      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        onPointerDown={startResize}
        onDoubleClick={() => setSplitRatio(0.5)}
        className={cn(
          'relative z-20 shrink-0 group flex items-center justify-center transition-colors',
          isHorizontal
            ? 'w-1.5 h-full cursor-col-resize hover:bg-primary/40 active:bg-primary'
            : 'h-1.5 w-full cursor-row-resize hover:bg-primary/40 active:bg-primary',
          isDragging && 'bg-primary'
        )}
      >
        <div
          className={cn(
            'bg-border/80 group-hover:bg-primary transition-colors',
            isHorizontal ? 'w-px h-full' : 'h-px w-full'
          )}
        />
        {/* Drag handle center pill indicator */}
        <div
          className={cn(
            'absolute rounded-full bg-surface2 border border-border/80 shadow-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-0.5',
            isHorizontal ? 'w-2 h-6 flex-col' : 'h-2 w-6 flex-row'
          )}
        >
          <div className="size-0.5 rounded-full bg-foreground-muted" />
          <div className="size-0.5 rounded-full bg-foreground-muted" />
          <div className="size-0.5 rounded-full bg-foreground-muted" />
        </div>
      </div>

      {/* Secondary Session Cell */}
      <div
        style={{ flex: `${1 - splitRatio} 1 0%` }}
        className="min-w-0 min-h-0 h-full overflow-hidden"
      >
        <SessionCell
          sessionId={secondarySessionId}
          onSelectSession={setSecondarySessionId}
          onSwap={swapSessions}
          onClose={closeSplit}
        />
      </div>
    </div>
  );
}
