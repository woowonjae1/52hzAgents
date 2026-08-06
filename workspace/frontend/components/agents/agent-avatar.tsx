import { useState } from 'react';
import { cn } from '@/lib/utils';
import { deriveIdentityColor } from '@/lib/identity-colors';

const KNOWN_AGENTS = [
  'aider', 'amp', 'anthropic', 'cerebras', 'claude', 'cline', 'codex', 'copilot', 'cursor',
  'custom', 'deepseek', 'elevenlabs', 'fal', 'fireworks', 'gemini', 'google', 'goose', 'groq',
  'hermes', 'kilo', 'kimi', 'manus', 'mistral', 'nanoclaw', 'openai', 'openclaw', 'opencode', 'openrouter',
  'perplexity', 'pi', 'replicate', 'sambanova', 'sensenova', 'stability', 'together', 'xai', 'yaml-agent'
];

const PNG_AGENTS = ['cline', 'hermes', 'kilo', 'openclaw', 'pi'];

interface AgentAvatarProps {
  name: string;
  size?: number;
  status?: string;
  showStatus?: boolean;
  className?: string;
  square?: boolean;
}

export function AgentAvatar({ name = '', size = 28, status, showStatus = false, className, square = false }: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const cleanName = (name || '').replace(/^(openagents:|agent:|human:)/, '').trim();
  const lowercaseName = cleanName.toLowerCase();

  // Find matching agent keyword
  const matchedAgent = KNOWN_AGENTS.find(k => lowercaseName.includes(k));
  const isPng = matchedAgent ? PNG_AGENTS.includes(matchedAgent) : false;
  const isOffline = status === 'offline';
  const identityFill = deriveIdentityColor(cleanName || 'agent');
  const initial = (cleanName || '?').charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        'relative shrink-0 transition-all duration-200 select-none',
        isOffline && 'opacity-70 grayscale-[20%]',
        className
      )}
      style={{ width: size, height: size }}
    >
      <div
        className={cn(
          square ? 'rounded-lg' : 'rounded-full',
          'overflow-hidden border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-200 flex items-center justify-center shrink-0 shadow-xs',
          status === 'online' && 'border-emerald-500 shadow-xs shadow-emerald-500/20'
        )}
        style={{ width: size, height: size }}
      >
        {matchedAgent && !imgError ? (
          <img
            src={`/icons/agents/${matchedAgent}.${isPng ? 'png' : 'svg'}`}
            alt={cleanName}
            onError={() => setImgError(true)}
            className="w-full h-full object-contain p-1"
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-bold text-white uppercase"
            style={{ backgroundColor: identityFill, fontSize: Math.max(9, Math.round(size * 0.42)) }}
            aria-label={cleanName}
          >
            {initial}
          </span>
        )}
      </div>
      {showStatus && size >= 20 && (
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-[1.5px] border-background',
          size >= 28 ? 'size-2.5' : 'size-2',
          status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400 dark:bg-zinc-600'
        )} />
      )}
    </div>
  );
}
