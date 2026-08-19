'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

export interface SparklineBarProps {
  data?: number[];
  height?: number;
  barWidth?: number;
  barGap?: number;
  color?: string;
  className?: string;
}

export function SparklineBar({
  data,
  height = 32,
  barWidth = 4,
  barGap = 2,
  color = '#8b5cf6',
  className,
}: SparklineBarProps) {
  if (!data || data.length === 0 || data.every((v) => v === 0)) return null;

  const max = Math.max(...data, 1);

  return (
    <div
      className={cn('flex items-end', className)}
      style={{ height, gap: barGap }}
    >
      {data.map((val, idx) => {
        const pct = Math.max(0.1, val / max);
        const barHeight = Math.round(pct * height);
        return (
          <div
            key={idx}
            className="group/bar relative flex flex-col justify-end"
            style={{ width: barWidth, height }}
          >
            <div
              className="w-full rounded-xs transition-all duration-300 group-hover/bar:brightness-125"
              style={{
                height: `${barHeight}px`,
                backgroundColor: color,
                opacity: 0.35 + 0.65 * pct,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export interface SparklineAreaProps {
  data?: number[];
  height?: number;
  width?: number;
  color?: string;
  className?: string;
}

export function SparklineArea({
  data,
  height = 32,
  width = 72,
  color = '#10b981',
  className,
}: SparklineAreaProps) {
  if (!data || data.length < 2 || data.every((v) => v === 0)) return null;

  const min = Math.min(...data);
  const max = Math.max(...data, min + 1);
  const range = max - min;

  const points = data.map((val, idx) => {
    const x = (idx / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `${pathD} L ${width},${height} L 0,${height} Z`;

  return (
    <div className={cn('relative overflow-hidden', className)} style={{ width, height }}>
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0.0} />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#grad-${color.replace('#', '')})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export interface RingProgressProps {
  value: number; // 0 to 100
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  label?: string;
  className?: string;
}

export function RingProgress({
  value,
  size = 36,
  strokeWidth = 3,
  color = '#10b981',
  trackColor = 'rgba(128, 128, 128, 0.12)',
  label,
  className,
}: RingProgressProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(100, Math.max(0, value)) / 100) * circumference;

  return (
    <div className={cn('relative flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {value > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="none"
            className="transition-all duration-500 ease-out"
          />
        )}
      </svg>
      {label && (
        <span className="absolute text-[10px] font-mono font-medium text-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

export interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  badge?: {
    text: string;
    trend?: 'up' | 'down' | 'neutral';
  };
  chart?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function MetricCard({
  title,
  value,
  subtitle,
  badge,
  chart,
  icon,
  className,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col justify-between p-3.5 rounded-2xl',
        'bg-surface1/80 dark:bg-surface1/50 border border-border/70 shadow-2xs backdrop-blur-md',
        'hover:border-border-accent/80 transition-all duration-150',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon && (
            <span className="size-5 rounded-md bg-surface2 border border-border/40 flex items-center justify-center text-foreground-muted shrink-0">
              {icon}
            </span>
          )}
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground truncate font-mono">
            {title}
          </span>
        </div>

        {badge && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9.5px] font-mono font-medium',
              badge.trend === 'up'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : badge.trend === 'down'
                ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                : 'bg-surface2 text-muted-foreground'
            )}
          >
            {badge.trend === 'up' && <ArrowUpRight className="size-2.5" />}
            {badge.trend === 'down' && <ArrowDownRight className="size-2.5" />}
            <span>{badge.text}</span>
          </span>
        )}
      </div>

      {/* Body: Value & Chart */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xl font-semibold font-mono tracking-tight text-foreground truncate">
            {value}
          </div>
          {subtitle && (
            <div className="text-[10.5px] text-muted-foreground mt-0.5 truncate">
              {subtitle}
            </div>
          )}
        </div>

        {chart && <div className="shrink-0 flex items-end">{chart}</div>}
      </div>
    </div>
  );
}
