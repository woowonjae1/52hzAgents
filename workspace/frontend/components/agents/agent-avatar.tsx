import Avatar from 'boring-avatars';
import { cn } from '@/lib/utils';

const OA_PALETTE = ['#6366F1', '#8B5CF6', '#06B6D4', '#10B981', '#F59E0B'];

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
          'overflow-hidden border bg-zinc-50 dark:bg-zinc-900 flex items-center justify-center',
          status === 'online' 
            ? 'border-emerald-500/40 dark:border-emerald-500/30 shadow-xs shadow-emerald-500/10' 
            : 'border-zinc-200/20 dark:border-zinc-800/30'
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
          <Avatar name={name} size={size} variant="beam" colors={OA_PALETTE} square={square} />
        )}
      </div>
      {showStatus && size >= 20 && (
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-[1.5px] border-background',
          size >= 28 ? 'size-2.5' : 'size-2',
          status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-300 dark:bg-zinc-600'
        )} />
      )}
    </div>
  );
}
