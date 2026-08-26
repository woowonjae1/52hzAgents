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
  'goose', 'nanoclaw', 'kimi', 'default',
  'replicate', 'elevenlabs', 'manus',
]);

const MONOCHROME_AGENTS = new Set([
  'cursor', 'openai', 'codex', 'grok', 'xai', 'pi', 'cline', 'kilo', 'opencode', 'copilot'
]);

const PNG_AGENTS = new Set<string>([]);

function IconWrapper({ name: rawName, size = 20, className }: { name: string } & IconProps) {
  const name = resolveAgentIconName(rawName);
  const needsBg = NEEDS_BG.has(name);
  const isMonochrome = MONOCHROME_AGENTS.has(name);
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
        src={`${ICON_BASE}/${name}.${ext}?v=52hz-1`}
        alt={name}
        width={needsBg ? size - 4 : size}
        height={needsBg ? size - 4 : size}
        className={cn(isMonochrome && 'dark:invert')}
        onError={(e) => {
          const img = e.target as HTMLImageElement;
          if (img.src.includes('.png')) {
            img.src = `${ICON_BASE}/${name}.svg?v=52hz-1`;
          } else if (img.src.includes('.svg')) {
            img.src = `${ICON_BASE}/default.svg?v=52hz-1`;
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
