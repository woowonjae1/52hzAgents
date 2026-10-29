import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { minimatch } from 'minimatch';
import ignore from 'ignore';
import { Type } from '@earendil-works/pi-ai';
import { createReadTool, createWriteTool, createEditTool, createLsTool, createFindTool,
  createPowerShellTool, createBashTool, createLocalPowerShellOperations, createLocalBashOperations,
  generateUnifiedPatch } from '@earendil-works/pi-coding-agent';

const MAX_FILE = 4 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.next', '.cache']);

/** File tools are project-scoped. Approved shell commands use the user's privileges. */
export async function projectPath(root, input, { create = false } = {}) {
  root = await fs.realpath(root);
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Invalid project path.');
  const target = path.resolve(root, input);
  const check = value => {
    const relative = path.relative(root, value);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('File tools cannot access paths outside this project.');
    if (relative.split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('File tools cannot modify or inspect Git internals.');
    return relative;
  };
  check(target);
  let current = target;
  const suffix = [];
  while (true) {
    try { const resolved = await fs.realpath(current); check(resolved); return path.join(resolved, ...suffix.reverse()); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      if (current === root || path.dirname(current) === current) throw error;
      suffix.push(path.basename(current)); current = path.dirname(current);
    }
  }
}

export async function createProjectTools({ root, mode, signal, requestApproval, onMutation = () => {} }) {
  if (mode === 'chat') return [];
  root = await fs.realpath(root);
  const aborted = () => { if (signal?.aborted) throw new Error('Operation stopped.'); };
  const checked = async (input, create = false) => { aborted(); return projectPath(root, input, { create }); };
  const read = async input => {
    const target = await checked(input), stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Read supports project files up to 4 MiB.');
    aborted(); const content = await fs.readFile(target);
    if (content.includes(0)) throw new Error('This tool reads text files. Binary files are not supported.');
    return content;
  };
  const mutate = async (input, content) => {
    if (mode !== 'agent') throw new Error('Plan mode cannot modify files.');
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('Writes are limited to 4 MiB.');
    const target = await checked(input, true);
    const before = await fs.readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    aborted();
    // Re-resolve after awaits so an existing symlink cannot bypass the project boundary.
    const safe = await checked(input, true);
    await fs.writeFile(safe, content, { encoding: 'utf8', flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0) });
    onMutation({ path: path.relative(root, target).replace(/\\/g, '/'), patch: generateUnifiedPatch(path.relative(root, target).replace(/\\/g, '/'), before, content) });
  };
  const rules = ignore();
  try { const text = await read(path.join(root, '.gitignore')); rules.add(text.toString('utf8')); } catch { /* Optional project ignore file. */ }
  const walk = async function* (directory, depth = 0) {
    if (depth > 40) return;
    const entries = await fs.readdir(await checked(directory), { withFileTypes: true });
    for (const entry of entries) {
      aborted();
      if (entry.isSymbolicLink() || SKIP.has(entry.name.toLowerCase())) continue;
      const target = path.join(directory, entry.name), relative = path.relative(root, target).replace(/\\/g, '/');
      if (rules.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) yield* walk(target, depth + 1);
      else if (entry.isFile()) yield target;
    }
  };
  const find = createFindTool(root, { operations: {
    exists: async input => { await checked(input); return true; },
    glob: async (pattern, directory, options) => {
      if (pattern.length > 512) throw new Error('Search pattern is too long.');
      const found = []; let visited = 0;
      const base = await checked(directory);
      for await (const file of walk(base)) {
        if (++visited > 10_000) break;
        const relative = path.relative(base, file).replace(/\\/g, '/');
        if (minimatch(relative, pattern, { matchBase: true, dot: true, windowsPathsNoEscape: true })) found.push(relative);
        if (found.length >= Math.min(options.limit, 1000)) break;
      }
      return found;
    },
  } });
  find.description = 'Find project files by glob. Skips symlinks, Git internals, dependencies and root .gitignore rules. Bounded to 10,000 visited files.';
  const tools = [
    createReadTool(root, { autoResizeImages: false, operations: { readFile: read, access: async input => { await checked(input); } } }),
    createLsTool(root, { operations: {
      exists: async input => { await checked(input); return true; },
      stat: async input => fs.stat(await checked(input)),
      readdir: async input => (await fs.readdir(await checked(input))).filter(name => !SKIP.has(name.toLowerCase())),
    } }), find,
    {
      name: 'search', label: 'Search project text',
      description: 'Search project file contents for literal text, not regular expressions. Skips ignored files and symlinks; bounded to 16 MiB and 200 matches.',
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 512 }), path: Type.Optional(Type.String()), ignoreCase: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args) => {
        const base = await checked(args.path || root), hits = []; let bytes = 0, files = 0;
        for await (const file of walk(base)) {
          if (++files > 2000 || bytes > 16 * 1024 * 1024 || hits.length >= 200) break;
          let content; try { content = await read(file); } catch { continue; }
          bytes += content.length; if (content.includes(0)) continue;
          const needle = args.ignoreCase ? args.text.toLowerCase() : args.text;
          content.toString('utf8').split(/\r?\n/).forEach((line, i) => { if (hits.length < 200 && (args.ignoreCase ? line.toLowerCase() : line).includes(needle)) hits.push(`${path.relative(root, file).replace(/\\/g, '/')}:${i + 1}: ${line.slice(0, 400)}`); });
        }
        return { content: [{ type: 'text', text: hits.join('\n') || 'No matches found.' }], details: { matches: hits.length, scannedFiles: files } };
      },
    },
  ];
  if (mode !== 'agent') return tools;
  tools.push(createEditTool(root, { operations: { readFile: read, writeFile: mutate, access: async input => { await checked(input); } } }),
    createWriteTool(root, { operations: { writeFile: mutate, mkdir: async directory => { aborted(); await fs.mkdir(await checked(directory, true), { recursive: true }); } } }));
  const local = process.platform === 'win32' ? createLocalPowerShellOperations() : createLocalBashOperations();
  const options = { exposeSessionEnvironment: false, operations: {
    exec: async (command, _cwd, execution) => {
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
      return local.exec(command, root, { ...execution, timeout: Math.min(120, Math.max(1, execution.timeout || 120)), env });
    },
  } };
  const shell = process.platform === 'win32' ? createPowerShellTool(root, options) : createBashTool(root, options);
  const execute = shell.execute;
  shell.description += ' Every command requires explicit user approval. Runs with user privileges in the project folder; it is not an OS sandbox. Maximum duration 120 seconds.';
  shell.execute = async (id, args, executionSignal, update) => {
    aborted();
    if (!await requestApproval({ toolCallId: id, tool: shell.name, args: structuredClone(args), cwd: root }, executionSignal)) {
      return { content: [{ type: 'text', text: 'Command denied by the user. Stop this run; do not try another command.' }], details: { denied: true }, isError: true, terminate: true };
    }
    aborted(); return execute(id, { ...args, timeout: Math.min(120, Math.max(1, args.timeout || 120)) }, executionSignal, update);
  };
  tools.push(shell); return tools;
}
