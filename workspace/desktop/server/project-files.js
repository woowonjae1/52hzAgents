const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const hash = content => content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
const limits = { files: 2000, fileBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 };
const skip = new Set(['.git', 'node_modules', '.next', '.cache', 'dist', 'build', 'coverage']);
async function git(root, args, binary = false) {
  return (await execute('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', root, ...args],
    { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' })).stdout;
}
async function resolveFile(root, relative) {
  const { projectPath } = await import('./pi-tools.mjs');
  const target = await projectPath(root, relative, { create: true });
  let current=root;
  for(const segment of path.relative(root,path.resolve(root,relative)).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    try {if((await fs.lstat(current)).isSymbolicLink())throw new Error('不能通过符号链接记录或恢复文件。');}
    catch(error){if(error.code==='ENOENT')break;throw error;}
  }
  return target;
}
async function read(root, relative) {
  const target = await resolveFile(root, relative);
  try {
    if ((await fs.lstat(path.resolve(root,relative))).isSymbolicLink()) throw new Error('不记录符号链接。');
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.fileBytes) throw new Error(`不支持的文件类型或文件超过 4 MiB：${relative}`);
    const content = await fs.readFile(target);
    return { content, mode: stat.mode };
  } catch (error) { if (error.code === 'ENOENT') return { content: null, mode: null }; throw error; }
}
async function inventory(root) {
  root = await fs.realpath(root);
  let names, partial = false;
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
    if (await fs.realpath(top) !== root) throw new Error('subfolder');
    names = [...new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))];
  } catch {
    names = [];
    const walk = async (dir, prefix = '', depth = 0) => {
      if (depth > 32 || names.length > limits.files) { partial = true; return; }
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (skip.has(entry.name.toLowerCase())) { partial = true; continue; }
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) { partial = true; continue; }
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/', depth + 1);
        else if (entry.isFile()) names.push(name);
        if (names.length > limits.files) { partial = true; break; }
      }
    };
    await walk(root);
  }
  const files = {}, excluded = [];
  let bytes = 0;
  for (const name of names.slice(0, limits.files)) {
    try {
      const item = await read(root, name);
      bytes += item.content?.length || 0;
      if (bytes > limits.totalBytes) { excluded.push(name); partial = true; continue; }
      files[name] = { content: item.content?.toString('base64') ?? null, mode: item.mode };
    } catch { excluded.push(name); partial = true; }
  }
  return { files, excluded, partial: partial || names.length > limits.files, coverage: 'Git 跟踪及未忽略文件；无 Git 时排除依赖、构建与缓存目录；最多 2000 文件、单文件 4 MiB、合计 32 MiB' };
}
module.exports = { git, read, resolveFile, inventory, hash, limits };
