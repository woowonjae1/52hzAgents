import { cn } from '@/lib/utils';
import { deriveIdentityColor } from '@/lib/identity-colors';

const KNOWN_AGENTS = [
  'aider', 'amp', 'anthropic', 'cerebras', 'claude', 'cline', 'codex', 'copilot', 'cursor',
  'custom', 'deepseek', 'elevenlabs', 'fal', 'fireworks', 'gemini', 'google', 'goose', 'groq',
  'hermes', 'kilo', 'kimi', 'manus', 'mistral', 'nanoclaw', 'openai', 'openclaw', 'opencode', 'openrouter',
  'perplexity', 'pi', 'replicate', 'sambanova', 'sensenova', 'stability', 'together', 'xai', 'yaml-agent'
];

const PNG_AGENTS = ['cline', 'hermes', 'kilo', 'pi'];

interface AgentAvatarProps {
  name: string;
  size?: number;
  status?: string;
  showStatus?: boolean;
  className?: string;
  square?: boolean;
}

export function AgentAvatar({ name, size = 28, status, showStatus = false, className, square = false }: AgentAvatarProps) {
  const lowercaseName = name.toLowerCase();

  // Find matching agent keyword
  const matchedAgent = KNOWN_AGENTS.find(k => lowercaseName.includes(k));
  const isPng = matchedAgent ? PNG_AGENTS.includes(matchedAgent) : false;
  const isOffline = status === 'offline';
  // Paseo identity fill: low chroma, even luminance across all ten hues, with a
  // white glyph on top. The previous fallback used a five-colour saturated palette,
  // which is what identity-colors.ts explicitly argues against — at full
  // saturation the avatar wins a fight it should not be in, and the hue ends up
  // ranking agents rather than identifying them.
  const identityFill = deriveIdentityColor(name);
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className={cn(
        'relative shrink-0 transition-all duration-200',
        isOffline && 'opacity-50 grayscale-[20%]',
        className
      )}
      style={{ width: size, height: size }}
    >
      <div
        className={cn(
          square ? 'rounded-lg' : 'rounded-full',
          'overflow-hidden border bg-surface2 flex items-center justify-center',
          status === 'online'
            ? 'border-accent/40 shadow-xs shadow-accent/10'
            : 'border-border'
        )}
        style={{ width: size, height: size }}
      >
        {matchedAgent ? (
          <img
            src={`/icons/agents/${matchedAgent}.${isPng ? 'png' : 'svg'}`}
            alt={name}
            className="w-full h-full object-contain p-1 animate-[fadeIn_0.3s_ease-out]"
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-medium text-white animate-[fadeIn_0.3s_ease-out]"
            style={{ backgroundColor: identityFill, fontSize: Math.max(9, Math.round(size * 0.42)) }}
            aria-label={name}
          >
            {initial}
          </span>
        )}
      </div>
      {showStatus && size >= 20 && (
        <span className={cn(
          // The status dot deliberately keeps a saturated colour — per Paseo's
          // theme notes it is the one signal that is supposed to shout, so it
          // stays off the normalized status scale.
          'absolute -bottom-0.5 -right-0.5 rounded-full border-[1.5px] border-background',
          size >= 28 ? 'size-2.5' : 'size-2',
          status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-surface4'
        )} />
      )}
    </div>
  );
}
