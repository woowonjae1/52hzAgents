const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const projectFiles = require('./project-files');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(new Error(message), { status: 409 });

// File images cover bounded project changes, never arbitrary external side effects.
class Checkpoints {
  constructor(userDataPath) { this.directory = path.join(userDataPath, 'checkpoints'); }
  file(id) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw fail('无效检查点。');
    return path.join(this.directory, `${id}.json`);
  }
  async load(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(record) {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.file(record.id), temp = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, target);
  }
  async prepare(id, channel, root, change) {
    root = await fs.realpath(root);
    const record = await this.load(id) || { id, channel, root, entries: [], created_at: Date.now(), scope: 'file-tools' };
    if (record.root !== root || record.channel !== channel || record.restored_at) throw fail('检查点与当前项目不匹配。');
    let entry = record.entries.find(item => item.path === change.path);
    if (!entry) {
      if (record.entries.length >= 200 || record.entries.reduce((n, item) => n + (item.before?.length || 0), 0) + (change.before?.length || 0) * 1.34 > 32 * 1024 * 1024) throw fail('检查点达到容量上限，已阻止本次写入。');
      entry = { path: change.path, before: change.before === null ? null : Buffer.from(change.before).toString('base64') };
      record.entries.push(entry);
    }
    // Persist the expected post-write hash before changing the project file.
    entry.after = hash(Buffer.from(change.after));
    await this.save(record);
  }
  async describe(id, channel) {
    const record = await this.load(id);
    if (!record || record.channel !== channel) return null;
    return { id, scope: record.scope, root: record.root, files: record.entries.map(item => item.path), restored_at: record.restored_at || null,
      partial: !!record.partial, coverage: record.coverage, pending_command: !!record.pending_command };
  }
  async beginCommand(id, channel, root) {
    root = await fs.realpath(root);
    const record = await this.load(id) || { id, channel, root, entries: [], created_at: Date.now(), scope: 'project-files' };
    if (record.root !== root || record.channel !== channel || record.restored_at || record.pending_command) throw fail('命令检查点状态不匹配。');
    record.pending_command = await projectFiles.inventory(root);
    record.scope = 'project-files'; record.coverage = record.pending_command.coverage;
    record.partial ||= record.pending_command.partial;
    await this.save(record);
  }
  async endCommand(id, channel) {
    const record = await this.load(id);
    if (!record || record.channel !== channel || !record.pending_command) throw fail('命令检查点不存在。');
    const before = record.pending_command, after = await projectFiles.inventory(record.root);
    record.partial ||= after.partial;
    const excluded = new Set([...before.excluded, ...after.excluded]);
    for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
      if (excluded.has(name) || (!(name in before.files) && before.partial) || (!(name in after.files) && after.partial)) { record.partial = true; continue; }
      const original = before.files[name]?.content ?? null, current = after.files[name]?.content ?? null;
      if (original === current) continue;
      let entry = record.entries.find(item => item.path === name);
      if (!entry) {
        if (record.entries.length >= 200 || record.entries.reduce((n, item) => n + (item.before?.length || 0), 0) + (original?.length || 0) > 44 * 1024 * 1024) { record.partial = true; continue; }
        entry = { path: name, before: original, mode: before.files[name]?.mode }; record.entries.push(entry);
      }
      entry.after = current === null ? null : hash(Buffer.from(current, 'base64'));
    }
    delete record.pending_command;
    await this.save(record);
  }
  async restore(id, channel, root) {
    const record = await this.load(id);
    if (!record || record.channel !== channel) throw fail('此会话没有该检查点。');
    if (record.restored_at) throw fail('此检查点已经撤销。');
    if (record.pending_command) throw fail('上次命令异常中断，尚未取得执行后快照。请先人工检查进程与文件，不能自动撤销。');
    if (await fs.realpath(root) !== record.root) throw fail('项目目录已改变，不能撤销。');
    const pending = [];
    // Preflight ALL files before touching any, including persisted partial undo.
    for (const entry of record.entries) {
      const target = await projectFiles.resolveFile(record.root, entry.path);
      const current = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
      if (current === null ? before === null : before !== null && hash(current) === hash(before)) continue;
      if ((current === null ? null : hash(current)) !== entry.after) throw fail(`文件已有后续改动，未撤销任何文件：${entry.path}`);
      pending.push({ entry, target, before });
    }
    for (const item of pending) {
      const target = await projectFiles.resolveFile(record.root, item.entry.path);
      const current = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if ((current === null ? null : hash(current)) !== item.entry.after) throw fail(`撤销期间检测到新改动：${item.entry.path}。可修复冲突后重试。`);
      if (item.before === null) await fs.unlink(target);
      else {
        const temp = `${target}.${crypto.randomUUID()}.restore`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(temp, item.before, { flag: 'wx', mode: item.entry.mode || (current !== null ? (await fs.stat(target)).mode : 0o644) });
        await fs.rename(temp, target);
      }
    }
    record.restored_at = Date.now(); await this.save(record);
    return this.describe(id, channel);
  }
}
module.exports = { Checkpoints };
