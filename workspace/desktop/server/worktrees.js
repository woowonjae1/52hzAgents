const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { git, read, resolveFile, hash, limits } = require('./project-files');
const fail = message => Object.assign(new Error(message), { status: 409 });
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

class Worktrees {
  constructor(store, runner, broadcaster) {
    this.store = store; this.runner = runner; this.broadcaster = broadcaster;
    this.directory = path.join(store.userDataPath, 'worktrees');
    store.data.managed_worktrees ||= [];
  }
  record(channel) { return this.store.data.managed_worktrees.find(item => item.channel === channel && item.status !== 'removed'); }
  async validate(record) {
    const root = await fs.realpath(record.root), directory = await fs.realpath(this.directory);
    if (!same(path.dirname(root), directory) || path.basename(root) !== record.id) throw fail('隔离目录不在此应用管理范围内。');
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (!same(await fs.realpath(common), record.common)) throw fail('隔离目录的 Git 仓库身份已变化。');
    return root;
  }
  async state(channel) {
    const session = this.store.getChannel(channel);
    if (!session) throw fail('会话不存在。');
    const record = this.record(channel);
    if (record) {
      try {
        await this.validate(record);
        const changed = (await git(record.root, ['status', '--porcelain', '--untracked-files=all'])).length > 0;
        return { available: true, ...record, active: same(session.working_dir || '', record.root), changed };
      } catch { return { available: false, ...record, active: false, reason: '隔离目录缺失或仓库身份不匹配。保留记录，请检查磁盘。' }; }
    }
    try {
      const selected = await fs.realpath(session.working_dir);
      const source = await fs.realpath((await git(selected, ['rev-parse', '--show-toplevel'])).trim());
      if (!same(source, selected)) return { available: false, reason: '请选择 Git 仓库根目录，再创建隔离工作区。' };
      const head = (await git(source, ['rev-parse', '--verify', 'HEAD'])).trim();
      return { available: true, active: false, source, head, source_dirty: !!(await git(source, ['status', '--porcelain'])).trim() };
    } catch { return { available: false, reason: '隔离工作区需要已有提交的 Git 仓库。' }; }
  }
  async locked(channel, roots, operation) {
    const keys = roots.map(root => { try { root=sync.realpathSync.native(root); } catch { root=path.resolve(root); } return process.platform === 'win32' ? root.toLowerCase() : root; });
    const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
    for (const key of keys) {
      if ([...this.runner.restoring].some(other => overlap(other,key))) throw fail('项目正在进行恢复或工作区操作。');
      for (const run of this.runner.active.values()) {
        if (!run.snapshot.workingDir) continue;
        const active = sync.realpathSync.native(run.snapshot.workingDir);
        if (overlap(process.platform === 'win32' ? active.toLowerCase() : active,key)) throw fail('请先停止原项目与隔离目录中的全部任务。');
      }
    }
    if (this.runner.workspaceOperations.has(channel)) throw fail('此会话正在进行工作区操作。');
    for (const key of keys) this.runner.restoring.add(key);
    this.runner.workspaceOperations.add(channel);
    try { return await operation(); } finally { this.runner.workspaceOperations.delete(channel);for (const key of keys) this.runner.restoring.delete(key); }
  }
  changed(channel) { this.broadcaster.broadcast({ type:'workspace.project.files.changed',target:`channel/${channel}`,payload:{workspace_changed:true} }); }
  async create(channel) {
    const state = await this.state(channel);
    if (!state.available || state.id) throw fail(state.reason || '此会话已有隔离工作区。');
    return this.locked(channel,[state.source], async () => {
      if (this.record(channel)) throw fail('此会话已有隔离工作区。');
      const id = crypto.randomUUID(), root = path.join(this.directory,id);
      await fs.mkdir(this.directory,{recursive:true});
      const common = await fs.realpath((await git(state.source,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
      const record = { id, channel, root, source:state.source, base:state.head, common, status:'creating', created_at:Date.now() };
      // Journal before Git writes. Failed creation is retained, never recursively removed.
      this.store.data.managed_worktrees.push(record); this.store.save();
      await git(state.source,['worktree','add','--detach',root,state.head]);
      await this.validate(record); record.status='ready';
      this.store.updateChannel(channel,{working_dir:root}); this.changed(channel);
      return this.state(channel);
    });
  }
  async switch(channel, active) {
    const record = this.record(channel); if (!record) throw fail('没有隔离工作区。');
    await this.validate(record);
    const source = await fs.realpath(record.source);
    return this.locked(channel,[source,record.root],async()=>{
      this.store.updateChannel(channel,{working_dir:active?record.root:source});this.changed(channel);return this.state(channel);
    });
  }
  async plan(channel) {
    const record = this.record(channel); if (!record) throw fail('没有隔离工作区。');
    await this.validate(record);
    if (!same(await fs.realpath(record.source),record.source)) throw fail('原项目目录身份已变化。');
    if (!same(await fs.realpath((await git(record.source,['rev-parse','--path-format=absolute','--git-common-dir'])).trim()),record.common)) throw fail('原项目 Git 仓库身份已变化。');
    const names = [...new Set([
      ...(await git(record.root,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',record.base,'--'])).split('\0'),
      ...(await git(record.root,['ls-files','--others','--exclude-standard','-z'])).split('\0'),
    ].filter(Boolean))];
    if (names.length > 200) throw fail('导回超过 200 个文件，请分批人工审阅。');
    const entries = (await git(record.root,['ls-tree','-r','-z',record.base])).split('\0').filter(Boolean);
    const base = new Map(entries.map(line=>{const split=line.indexOf('\t');return [line.slice(split+1),line.slice(0,split).split(' ')];}));
    const files = []; let bytes=0;
    for (const name of names) {
      const original=await read(record.source,name), current=await read(record.root,name);
      const item=base.get(name);
      if(item && !['100644','100755'].includes(item[0])) throw fail(`不支持导回链接或子模块：${name}`);
      const baseline=item?await git(record.root,['cat-file','blob',item[2]],true):null;
      if(hash(original.content)===hash(current.content)) continue;
      // Git's clean conversion handles Windows CRLF and repository attributes.
      // Never treat an existing untracked destination as an unchanged base file.
      let matchesBase=hash(original.content)===hash(baseline);
      if(!matchesBase && item && original.content!==null) {
        matchesBase=await git(record.source,['diff','--no-ext-diff','--no-textconv','--quiet',record.base,'--',name]).then(()=>true,()=>false);
      }
      if(!matchesBase) throw fail(`原项目有冲突，未导回任何文件：${name}`);
      bytes+=(original.content?.length||0)+(current.content?.length||0);
      if(bytes>limits.totalBytes) throw fail('导回内容超过 32 MiB，请人工处理。');
      files.push({path:name,before:original.content,after:current.content,mode:current.mode||original.mode});
    }
    return {record,files};
  }
  async review(channel) {
    const {record,files}=await this.plan(channel);
    const revision=hash(Buffer.from(JSON.stringify(files.map(file=>[file.path,hash(file.before),hash(file.after)]))));
    return {id:record.id,source:record.source,root:record.root,revision,files:files.map(file=>({path:file.path,action:file.after===null?'delete':file.before===null?'create':'modify'}))};
  }
  async apply(channel, revision) {
    const record=this.record(channel);if(!record)throw fail('没有隔离工作区。');
    await this.validate(record);
    return this.locked(channel,[record.source,record.root],async()=>{
      const {files}=await this.plan(channel);
      const currentRevision=hash(Buffer.from(JSON.stringify(files.map(file=>[file.path,hash(file.before),hash(file.after)]))));
      if(!revision || revision!==currentRevision)throw fail('文件已变化，请重新审阅后导回。');
      if(!files.length)throw fail('没有需要导回的文件。');
      const id=crypto.randomUUID();
      const run={id,channel,snapshot:{workingDir:record.source,mode:'import'},phase:'importing',outcome:null,started_at:Date.now()};
      this.store.data.runtime_runs.push(run);this.store.save();
      try {
        // Save the whole import checkpoint before the first write.
        for(const file of files)await this.runner.checkpoints.prepare(id,channel,record.source,{...file,after:file.after||Buffer.alloc(0)});
        const checkpoint=await this.runner.checkpoints.load(id);checkpoint.scope='project-import';
        for(const file of files){const entry=checkpoint.entries.find(item=>item.path===file.path);entry.after=hash(file.after);entry.mode=file.mode;}
        await this.runner.checkpoints.save(checkpoint);
        for(const file of files){
          const target=await resolveFile(record.source,file.path);
          if(hash((await read(record.source,file.path)).content)!==hash(file.before) || hash((await read(record.root,file.path)).content)!==hash(file.after))throw fail(`导回期间文件发生变化：${file.path}。已写文件可通过恢复记录撤销。`);
          if(file.after===null)await fs.unlink(target);
          else {await fs.mkdir(path.dirname(target),{recursive:true});const temp=target+'.'+crypto.randomUUID()+'.import';await fs.writeFile(temp,file.after,{flag:'wx',mode:file.mode||0o644});await fs.rename(temp,target);}
        }
        run.outcome='finished';record.last_import_at=Date.now();
      }catch(error){run.outcome='failed';throw error;}
      finally{
        run.phase='finished';run.ended_at=Date.now();
        // Return to the destination so both Diff and undo target the imported files.
        this.store.updateChannel(channel,{working_dir:record.source});this.changed(channel);
      }
      return this.state(channel);
    });
  }
  async remove(channel) {
    const record=this.record(channel);if(!record)throw fail('没有隔离工作区。');
    await this.validate(record);
    if(same(this.store.getChannel(channel)?.working_dir||'',record.root))throw fail('请先返回原项目。');
    return this.locked(channel,[record.source,record.root],async()=>{
      if((await git(record.root,['status','--porcelain','--untracked-files=all','--ignored'])).trim())throw fail('隔离工作区有修改或忽略文件，请保留目录或人工处理，不能自动删除。');
      if((await git(record.root,['rev-parse','HEAD'])).trim()!==record.base)throw fail('隔离工作区有新的提交，请保留目录。');
      // Git validates its own worktree. No --force, no recursive filesystem deletion.
      await git(record.source,['worktree','remove',record.root]);record.status='removed';this.store.save();return this.state(channel);
    });
  }
  async forget(channel) {
    const record=this.record(channel);if(!record)throw fail('没有隔离工作区记录。');
    const directory=await fs.realpath(this.directory);
    if(!same(path.dirname(record.root),directory) || path.basename(record.root)!==record.id)throw fail('记录路径不在管理范围内。');
    return this.locked(channel,[record.source,record.root],async()=>{
      const exists=await fs.lstat(record.root).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      if(exists)throw fail('目录仍存在，不能仅移除记录。请先人工检查。');
      const registered=(await git(record.source,['worktree','list','--porcelain','-z'])).split('\0').filter(item=>item.startsWith('worktree ')).some(item=>same(path.resolve(item.slice(9)),record.root));
      if(registered)throw fail('Git 仍登记此工作区，不能丢弃记录。请先修复 Git 工作区状态。');
      record.status='removed';this.store.save();return this.state(channel);
    });
  }
}
module.exports={Worktrees};
