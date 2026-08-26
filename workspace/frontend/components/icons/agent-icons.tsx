'use client';

/* eslint-disable @next/next/no-img-element */

import { cn } from '@/lib/utils';
import { resolveAgentIconName } from '@/lib/agent-catalog';

interface IconProps {
  className?: string;
  size?: number;
}

const ICON_BASE = '/icons/agents';

const NEEDS_BG = new Set([
  'codex', 'cline', 'amp', 'goose',
  'nanoclaw', 'opencode', 'kimi', 'default',
  'replicate', 'elevenlabs', 'manus', 'kilo',
]);

const PNG_AGENTS = new Set(['cline', 'kilo']);

function IconWrapper({ name: rawName, size = 20, className }: { name: string } & IconProps) {
  const name = resolveAgentIconName(rawName);
  const needsBg = NEEDS_BG.has(name);
  const isPng = PNG_AGENTS.has(name);
  const ext = isPng ? 'png' : 'svg';

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md shrink-0',
        needsBg && 'bg-white p-0.5',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={`${ICON_BASE}/${name}.${ext}`}
        alt={name}
        width={needsBg ? size - 4 : size}
        height={needsBg ? size - 4 : size}
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          if (img.src.includes('.png')) {
            img.src = `${ICON_BASE}/${name}.svg`;
          } else if (img.src.includes('.svg')) {
            img.src = `${ICON_BASE}/default.svg`;
          }
        }}
      />
    </span>
  );
}

export function AgentIcon({ name, className, size = 20 }: { name: string } & IconProps) {
  return <IconWrapper name={name} size={size} className={className} />;
}

export function ProviderIcon({ name, className, size = 20 }: { name: string } & IconProps) {
  return <IconWrapper name={name} size={size} className={className} />;
}
