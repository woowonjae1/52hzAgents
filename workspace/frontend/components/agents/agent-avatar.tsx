import { useState } from 'react';
import { cn } from '@/lib/utils';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { resolveAgentIconName } from '@/lib/agent-catalog';

const KNOWN_AGENTS = [
  'aider', 'amp', 'anthropic', 'cerebras', 'claude', 'cline', 'codex', 'copilot', 'cursor',
  'custom', 'deepseek', 'elevenlabs', 'fal', 'fireworks', 'gemini', 'google', 'goose', 'groq',
  'hermes', 'kilo', 'kimi', 'manus', 'mistral', 'nanoclaw', 'openai', 'openclaw', 'opencode', 'openrouter',
  'perplexity', 'pi', 'replicate', 'sambanova', 'sensenova', 'stability', 'together', 'xai', 'yaml-agent'
];

const PNG_AGENTS = ['cline', 'hermes', 'kilo', 'pi'];

interface AgentAvatarProps {
  name: string;
  /**
   * The agent's reported type ("claude", "openclaw", "cloud:openai"…). Prefer
   * passing this whenever the agent record is at hand: it is the canonical
   * identity, whereas the display name is whatever the user called the agent.
   * Matching on the name alone means an agent named "worker-1" or "小助手" never
   * gets its brand icon, which is why chat messages showed a letter tile while
   * the sidebar — which looks agents up properly — showed the real icon.
   */
  agentType?: string | null;
  size?: number;
  status?: string;
  showStatus?: boolean;
  className?: string;
  square?: boolean;
}

export function AgentAvatar({ name = '', agentType, size = 28, status, showStatus = false, className, square = false }: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const cleanName = (name || '').replace(/^(openagents:|agent:|human:)/, '').trim();
  const lowercaseName = cleanName.toLowerCase();

  // Cloud agents report "cloud:<provider>"; the provider is what has an icon.
  // resolveAgentIconName maps roster names with no icon of their own
  // (chatgpt → openai) before matching.
  const typeKey = resolveAgentIconName((agentType || '').replace(/^cloud:/, '').trim());
  const nameKey = resolveAgentIconName(lowercaseName);
  const matchedAgent =
    (typeKey ? KNOWN_AGENTS.find(k => typeKey.includes(k)) : undefined) ||
    KNOWN_AGENTS.find(k => nameKey.includes(k));
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
          'overflow-hidden border border-border dark:border-surface4 bg-white dark:bg-foreground flex items-center justify-center shrink-0 shadow-xs',
          status === 'online' && 'border-status-success shadow-xs shadow-status-success/20'
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
            className="flex h-full w-full items-center justify-center font-semibold text-white uppercase"
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
          status === 'online' ? 'bg-status-success animate-pulse' : 'bg-foreground-extra-muted dark:bg-surface4'
        )} />
      )}
    </div>
  );
}
