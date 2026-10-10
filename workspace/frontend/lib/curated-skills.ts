export interface CuratedSkill {
  id: string;
  name: string;
  trigger: string;
  description: string;
  category: 'engineering' | 'architecture' | 'research' | 'security' | 'custom';
  tags: string[];
  icon: string;
  author: string;
  featured?: boolean;
  sourceRepo?: string;
  sourcePath?: string;
  instructions: string;
}

export const CURATED_SKILLS: CuratedSkill[] = [
  {
    id: 'code-review',
    name: 'Code Review & Audit',
    trigger: '/review',
    description: 'Inspect diffs for bugs, edge cases, regression risks, performance bottlenecks, and security vulnerabilities.',
    category: 'engineering',
    tags: ['review', 'diff', 'audit', 'quality'],
    icon: 'shield-check',
    author: 'Curated',
    featured: true,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/code-review',
    instructions: `You are an expert code reviewer. Conduct a thorough and constructive code review on the requested changes or diffs:
1. Examine code correctness, logic flaws, and unhandled edge cases.
2. Check for memory leaks, resource exhaustion, and concurrency hazards.
3. Verify test coverage and error boundary handling.
4. Report findings with severity levels (Critical, Warning, Suggestion) and concrete code fix recommendations.`,
  },
  {
    id: 'deep-research',
    name: 'Deep Technical Research',
    trigger: '/research',
    description: 'Multi-source technical investigation, architectural trade-offs, and structured report synthesis.',
    category: 'research',
    tags: ['research', 'architecture', 'benchmarks', 'synthesis'],
    icon: 'search',
    author: 'Curated',
    featured: true,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/deep-research',
    instructions: `You are an elite principal research engineer. Investigate the problem systematically:
1. Formulate clear research hypotheses and evaluation criteria.
2. Compare competing technical approaches, design patterns, and libraries with concrete trade-off matrices.
3. Validate performance, maintainability, and operational complexity.
4. Deliver structured findings with actionable recommendations.`,
  },
  {
    id: 'arch-planner',
    name: 'Architecture Spec Planner',
    trigger: '/plan',
    description: 'Design end-to-end system architecture, interface contracts, data models, and phased execution blueprints.',
    category: 'architecture',
    tags: ['architecture', 'design', 'spec', 'planning'],
    icon: 'layout',
    author: 'Curated',
    featured: true,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/arch-planner',
    instructions: `You are a system architect. Draft an engineering specification:
1. Clarify goals, non-goals, and boundary constraints.
2. Design component interfaces, data schemas, and communication protocols.
3. Identify single-points-of-failure, scalability limits, and migration paths.
4. Break down implementation into self-contained, verifiable milestones.`,
  },
  {
    id: 'test-generator',
    name: 'Test Generator & TDD',
    trigger: '/test',
    description: 'Generate robust unit, integration, and E2E test suites with high branch coverage and edge-case assertions.',
    category: 'engineering',
    tags: ['testing', 'unit-test', 'tdd', 'integration'],
    icon: 'flask-conical',
    author: 'Curated',
    featured: true,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/test-generator',
    instructions: `You are a test automation specialist:
1. Analyze the target functions, methods, or endpoints.
2. Write idiomatic tests covering happy paths, negative tests, and boundary values.
3. Mock external I/O and network boundaries cleanly.
4. Ensure tests are deterministic, isolated, and readable.`,
  },
  {
    id: 'git-commit-craft',
    name: 'Commit Craft & PR Summary',
    trigger: '/commit',
    description: 'Analyze workspace diffs to craft Conventional Commits messages and concise PR walkthroughs.',
    category: 'engineering',
    tags: ['git', 'commit', 'pr', 'changelog'],
    icon: 'git-commit',
    author: 'Curated',
    featured: false,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/git-commit-craft',
    instructions: `Analyze recent file diffs and workspace status:
1. Group changes logically into atomic commits if needed.
2. Format messages using Conventional Commits: <type>(<scope>): <summary>.
3. Add a concise bulleted summary explaining "Why" rather than just "What".
4. Highlight breaking changes or database migration requirements.`,
  },
  {
    id: 'bug-postmortem',
    name: 'Root Cause Analysis (RCA)',
    trigger: '/debug',
    description: 'Investigate crash logs, trace stack dumps, isolate repro steps, and formulate targeted fixes.',
    category: 'engineering',
    tags: ['debug', 'rca', 'logs', 'postmortem'],
    icon: 'bug',
    author: 'Curated',
    featured: false,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/bug-postmortem',
    instructions: `You are a site reliability and triage engineer:
1. Analyze stack traces, panic messages, or unexpected state transitions.
2. Trace code execution backwards to locate the precise triggering root cause.
3. Propose minimal-diff, regression-safe bug fixes.
4. Outline preventive regression test cases to prevent recurrence.`,
  },
  {
    id: 'refactor-cleaner',
    name: 'Refactor & Debt Cleaner',
    trigger: '/refactor',
    description: 'Eliminate code smells, simplify complex control flow, and safely prune dead code without regressions.',
    category: 'engineering',
    tags: ['refactor', 'clean-code', 'complexity', 'debt'],
    icon: 'wand-2',
    author: 'Curated',
    featured: false,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/refactor-cleaner',
    instructions: `You are a code refactoring expert:
1. Identify high cognitive complexity, DRY violations, and antipatterns.
2. Refactor into clean, decoupled, single-responsibility functions or modules.
3. Preserve existing public APIs and semantic behavior.
4. Explain the rationale behind each structural simplification.`,
  },
  {
    id: 'security-audit',
    name: 'Security & Secret Scanner',
    trigger: '/security',
    description: 'Scan for hardcoded credentials, OWASP vulnerabilities, injection risks, and auth bypasses.',
    category: 'security',
    tags: ['security', 'owasp', 'secrets', 'cve'],
    icon: 'lock',
    author: 'Curated',
    featured: false,
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/security-audit',
    instructions: `You are an application security engineer:
1. Scan code for leaked API keys, tokens, credentials, and secrets.
2. Audit input validation and sanitization (SQL injection, XSS, SSRF, command injection).
3. Verify authentication and authorization checks across all sensitive entry points.
4. Provide remediations with CWE classifications and fix examples.`,
  },
];
