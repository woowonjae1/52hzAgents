import { useState } from 'react';
import { cn } from '@/lib/utils';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { resolveAgentIconName } from '@/lib/agent-catalog';

const KNOWN_AGENTS = [
  'amp', 'anthropic', 'antigravity', 'agy', 'cerebras', 'claude', 'cline', 'codex', 'copilot', 'cursor',
  'custom', 'deepseek', 'elevenlabs', 'fal', 'fireworks', 'gemini', 'google', 'goose', 'grok', 'groq',
  'hermes', 'kilo', 'kimi', 'manus', 'mistral', 'nanoclaw', 'openai', 'openclaw', 'opencode', 'openhands', 'openrouter',
  'perplexity', 'pi', 'replicate', 'sambanova', 'sensenova', 'stability', 'together', 'xai', 'yaml-agent'
];

const PNG_AGENTS: string[] = [];

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
        isOffline && 'opacity-80',
        className
      )}
      style={{ width: size, height: size }}
    >
      <div
        className={cn(
          square ? 'rounded-xl' : 'rounded-full',
          'overflow-hidden border border-border/80 dark:border-white/[0.1] bg-surface2/90 dark:bg-surface2/80 backdrop-blur-xs flex items-center justify-center shrink-0 shadow-2xs transition-all duration-200',
          status === 'online' && 'border-status-success/60 shadow-xs shadow-status-success/20 ring-1 ring-status-success/30'
        )}
        style={{ width: size, height: size }}
      >
        {matchedAgent && !imgError ? (
          <img
            src={`/icons/agents/${matchedAgent}.${isPng ? 'png' : 'svg'}?v=52hz-1`}
            alt={cleanName}
            onError={() => setImgError(true)}
            className={cn(
              "w-full h-full object-contain p-1 drop-shadow-xs",
              ['cursor', 'openai', 'codex', 'grok', 'xai', 'pi', 'cline', 'kilo', 'opencode', 'copilot'].includes(matchedAgent) && "dark:invert"
            )}
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-bold text-white uppercase tracking-wider"
            style={{
              background: `linear-gradient(135deg, ${identityFill} 0%, color-mix(in srgb, ${identityFill} 75%, black) 100%)`,
              fontSize: Math.max(9, Math.round(size * 0.42))
            }}
            aria-label={cleanName}
          >
            {initial}
          </span>
        )}
      </div>
      {showStatus && size >= 20 && (
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface0',
          size >= 28 ? 'size-3' : 'size-2.5',
          status === 'online'
            ? 'bg-status-success'
            : 'bg-foreground-extra-muted/60 dark:bg-surface4'
        )} />
      )}
    </div>
  );
}
