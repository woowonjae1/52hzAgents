import type { RoutineItem, KnowledgeEntry, WorkspaceSession } from '@/lib/types';

const STORAGE_PREFIX = '52hz_proj_instructions_v1_';

export function getProjectName(dir: string | null | undefined): string {
  if (!dir) return 'Direct chats';
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || dir;
}

export function getProjectInstructions(dir: string): string {
  if (!dir || typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(dir)}`) || '';
  } catch {
    return '';
  }
}

export function saveProjectInstructions(dir: string, instructions: string): void {
  if (!dir || typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${encodeURIComponent(dir)}`, instructions);
  } catch {}
}

export function getProjectCategory(dir: string): string {
  return `project:${getProjectName(dir)}`;
}

export function isKnowledgeForProject(k: KnowledgeEntry, dir: string): boolean {
  if (!dir) return false;
  const name = getProjectName(dir).toLowerCase();
  const cat = (k.category || '').toLowerCase();
  const desc = (k.description || '').toLowerCase();
  return cat.includes(name) || desc.includes(dir.toLowerCase()) || cat === `project:${name}`;
}

export function isRoutineForProject(
  routine: RoutineItem,
  dir: string,
  sessionIdsInProject: Set<string>
): boolean {
  if (!dir) return false;
  if (routine.context && routine.context.trim() === dir.trim()) return true;
  if (routine.channelName && sessionIdsInProject.has(routine.channelName)) return true;
  const name = getProjectName(dir).toLowerCase();
  if (routine.name.toLowerCase().includes(name)) return true;
  if (routine.message.toLowerCase().includes(name)) return true;
  return false;
}

export interface InstructionTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const INSTRUCTION_TEMPLATES: InstructionTemplate[] = [
  {
    id: 'fullstack-web',
    name: 'Fullstack Next.js & TypeScript',
    description: 'Enforce clean components, strict typing, and Tailwind styling.',
    content: `Project Guidelines:
• Language: TypeScript with strict mode.
• UI Framework: React & Next.js App Router, styled with Tailwind CSS.
• Code Standards: Keep components focused and modular; extract complex state to custom hooks.
• Verification: Always verify changes using npm run typecheck before finalizing tasks.`,
  },
  {
    id: 'backend-go',
    name: 'Go Microservices & API',
    description: 'Idiomatic Go code, clean architecture, and table-driven testing.',
    content: `Project Guidelines:
• Language: Go with standard idiomatic error handling (no unhandled errors).
• Architecture: Clear separation between transport/handlers, business domain, and persistence.
• Testing: Table-driven unit tests for business logic; benchmark critical paths.
• Git / Commits: Meaningful semantic commit messages and atomic commits.`,
  },
  {
    id: 'python-service',
    name: 'Python Service & Automation',
    description: 'Type annotations, robust error handling, and pytest verification.',
    content: `Project Guidelines:
• Language: Python 3.11+, typed function signatures with mypy compatibility.
• Quality: Format with Black / Ruff standards; handle edge-case exceptions gracefully.
• Testing: Write unit tests using pytest; mock external I/O and network requests.
• Performance: Avoid premature optimization but minimize redundant allocations.`,
  },
  {
    id: 'code-review',
    name: 'Careful Refactor & Bugfixer',
    description: 'Minimal invasive diffs, root-cause analysis, preserving existing comments.',
    content: `Project Guidelines:
• Scope: Produce minimal, high-precision diffs that only touch required files.
• Quality: Perform root-cause analysis rather than superficial workarounds.
• Integrity: Maintain existing docstrings, comments, and project idioms.
• Verification: Run tests and verify backward compatibility before closing.`,
  },
];
