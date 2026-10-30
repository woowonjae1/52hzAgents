import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from './store.js';
import {AgentRunner} from './agent-runner.js';
import {Worktrees} from './worktrees.js';
import {Checkpoints} from './checkpoints.js';
import {git,inventory} from './project-files.js';
import {createProjectTools} from './pi-tools.mjs';
import {runPiAgent} from './pi-engine.mjs';
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {startServer} from './index.js';
import {closeDatabasesUnder} from './storage/database.js';
const bus={broadcast(){},broadcastComposing(){}};
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'52hz-isolation-')));
  t.after(async()=>{closeDatabasesUnder(root);assert.ok(path.basename(root).startsWith('52hz-isolation-'));await fs.rm(root,{recursive:true,force:true,maxRetries:3});});
  const project=path.join(root,'project'),data=path.join(root,'data');await fs.mkdir(project);await fs.mkdir(data);
  await git(project,['init','-q']);await git(project,['config','core.autocrlf','false']);await fs.writeFile(path.join(project,'app.txt'),'baseline\n');await fs.writeFile(path.join(project,'delete.txt'),'keep me');
  await fs.writeFile(path.join(project,'.gitignore'),'ignored/\n');await git(project,['add','.']);
  await git(project,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','baseline']);
  const store=new Store(data);store.updateChannel('general',{working_dir:project,runtime_config:{provider:'ollama',model:'fixture',mode:'agent'}});
  const runner=new AgentRunner(store,bus);return {root,project,data,store,runner,trees:new Worktrees(store,runner,bus),checkpoints:runner.checkpoints};
}
test('worktree creates from the selected commit, preserves dirty source, survives restart and switches directories',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'app.txt'),'user dirty');
  const state=await f.trees.create('general');assert.equal(state.active,true);assert.equal(await fs.readFile(path.join(state.root,'app.txt'),'utf8'),'baseline\n');
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'user dirty');
  const loaded=new Store(f.data),runner=new AgentRunner(loaded,bus),trees=new Worktrees(loaded,runner,bus);
  assert.equal((await trees.state('general')).id,state.id);
  await trees.switch('general',false);assert.equal(loaded.getChannel('general').working_dir,f.project);
  await trees.switch('general',true);assert.equal(loaded.getChannel('general').working_dir,state.root);
});
test('reviewed worktree import includes added/deleted/binary files and preserves unrelated source edits; import is undoable',async t=>{
  const f=await fixture(t),state=await f.trees.create('general');
  await fs.writeFile(path.join(f.project,'user.txt'),'unrelated untracked work');
  await fs.writeFile(path.join(state.root,'app.txt'),'isolated change');await fs.unlink(path.join(state.root,'delete.txt'));
  await fs.writeFile(path.join(state.root,'new.bin'),Buffer.from([0,1,2,255]));
  const review=await f.trees.review('general');assert.equal(review.files.length,3);
  const result=await f.trees.apply('general',review.revision);assert.equal(result.active,false);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'isolated change');assert.deepEqual(await fs.readFile(path.join(f.project,'new.bin')),Buffer.from([0,1,2,255]));
  await assert.rejects(fs.stat(path.join(f.project,'delete.txt')));
  const run=f.store.data.runtime_runs.at(-1);await f.runner.restore('general',run.id);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'baseline\n');assert.equal(await fs.readFile(path.join(f.project,'delete.txt'),'utf8'),'keep me');
  await assert.rejects(fs.stat(path.join(f.project,'new.bin')));assert.equal(await fs.readFile(path.join(f.project,'user.txt'),'utf8'),'unrelated untracked work');
});
test('source conflicts and changed review revisions refuse import before touching source files',async t=>{
  const f=await fixture(t),state=await f.trees.create('general');await fs.writeFile(path.join(state.root,'app.txt'),'change1');
  const review=await f.trees.review('general');await fs.writeFile(path.join(state.root,'app.txt'),'change2');
  await assert.rejects(f.trees.apply('general',review.revision),/重新审阅/);assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'baseline\n');
  await fs.writeFile(path.join(f.project,'app.txt'),'user conflict');await assert.rejects(f.trees.review('general'),/原项目有冲突/);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'user conflict');
});
test('worktree operations reject active tasks, wrong sessions and unsafe deletion; clean detached directories can be removed',async t=>{
  const f=await fixture(t);f.runner.active.set('other',{snapshot:{workingDir:f.project}});
  await assert.rejects(f.trees.create('general'),/全部任务/);f.runner.active.clear();
  const state=await f.trees.create('general');await assert.rejects(f.trees.switch('other',true),/没有隔离/);
  await assert.rejects(f.trees.remove('general'),/返回原项目/);await f.trees.switch('general',false);
  await fs.mkdir(path.join(state.root,'ignored'));await fs.writeFile(path.join(state.root,'ignored','output.txt'),'do not delete');
  await assert.rejects(f.trees.remove('general'),/忽略文件/);await fs.unlink(path.join(state.root,'ignored','output.txt'));await fs.rmdir(path.join(state.root,'ignored'));
  await f.trees.remove('general');await assert.rejects(fs.stat(state.root));assert.equal((await f.trees.state('general')).id,undefined);
});
test('independent sessions receive independent worktrees',async t=>{
  const f=await fixture(t);f.store.updateChannel('second',{working_dir:f.project});
  const a=await f.trees.create('general'),b=await f.trees.create('second');assert.notEqual(a.root,b.root);
  await fs.writeFile(path.join(a.root,'app.txt'),'A');assert.equal(await fs.readFile(path.join(b.root,'app.txt'),'utf8'),'baseline\n');
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'baseline\n');
});
test('real approved shell file effects are checkpointed, including deletions and creations, and recover after restart',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'app.txt'),'pre-existing dirty');
  const tools=await createProjectTools({root:f.project,mode:'agent',signal:new AbortController().signal,requestApproval:async()=>true,
    beforeCommand:()=>f.checkpoints.beginCommand('command-run','general',f.project),afterCommand:()=>f.checkpoints.endCommand('command-run','general')});
  const shell=tools.find(item=>['powershell','bash'].includes(item.name));
  await fs.writeFile(path.join(f.project,'command.cjs'),"const fs=require('fs');fs.writeFileSync('app.txt','changed');fs.unlinkSync('delete.txt');fs.writeFileSync('new.txt','created');");
  const result=await shell.execute('shell',{command:'node command.cjs'},new AbortController().signal);
  assert.equal(result.isError,undefined);const checkpoint=await f.checkpoints.describe('command-run','general');assert.equal(checkpoint.scope,'project-files');assert.equal(checkpoint.pending_command,false);assert.equal(checkpoint.files.length,3);
  await new Checkpoints(f.data).restore('command-run','general',f.project);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'pre-existing dirty');assert.equal(await fs.readFile(path.join(f.project,'delete.txt'),'utf8'),'keep me');await assert.rejects(fs.stat(path.join(f.project,'new.txt')));
});
test('denied commands never take snapshots or run; failed snapshot prevents command execution',async t=>{
  const f=await fixture(t);let snapshots=0;
  let tools=await createProjectTools({root:f.project,mode:'agent',signal:new AbortController().signal,requestApproval:async()=>false,beforeCommand:async()=>{snapshots++;}});
  const name=process.platform==='win32'?'powershell':'bash';await tools.find(item=>item.name===name).execute('deny',{command:'node --version'},new AbortController().signal);assert.equal(snapshots,0);
  tools=await createProjectTools({root:f.project,mode:'agent',signal:new AbortController().signal,requestApproval:async()=>true,beforeCommand:async()=>{throw new Error('snapshot disk failure');}});
  await assert.rejects(tools.find(item=>item.name===name).execute('fail',{command:'node --version'},new AbortController().signal),/snapshot disk failure/);
});
test('crash without post-command snapshot disables automatic restoration, and later user edits block undo',async t=>{
  const f=await fixture(t);await f.checkpoints.beginCommand('crashed','general',f.project);await fs.writeFile(path.join(f.project,'app.txt'),'uncertain');
  assert.equal((await new Checkpoints(f.data).describe('crashed','general')).pending_command,true);
  await assert.rejects(f.checkpoints.restore('crashed','general',f.project),/执行后快照/);
  await f.checkpoints.beginCommand('completed','general',f.project);await fs.writeFile(path.join(f.project,'app.txt'),'command');await f.checkpoints.endCommand('completed','general');
  await fs.writeFile(path.join(f.project,'app.txt'),'later user edit');await assert.rejects(f.checkpoints.restore('completed','general',f.project),/后续改动/);
});
test('snapshot limits and ignored files are reported without claiming complete coverage',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'big.bin'),Buffer.alloc(4*1024*1024+1));
  await fs.mkdir(path.join(f.project,'ignored'));await fs.writeFile(path.join(f.project,'ignored','private'),'ignored');
  const snapshot=await inventory(f.project);assert.equal(snapshot.partial,true);assert.ok(snapshot.excluded.includes('big.bin'));assert.equal(snapshot.files['ignored/private'],undefined);
});

test('Windows line-ending normalization does not create false source conflicts',async t=>{
  const f=await fixture(t);await git(f.project,['config','core.autocrlf','true']);await fs.writeFile(path.join(f.project,'app.txt'),'baseline\r\n');
  const state=await f.trees.create('general');await fs.writeFile(path.join(state.root,'app.txt'),'new content\r\n');
  const review=await f.trees.review('general');await f.trees.apply('general',review.revision);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'new content\r\n');
});

test('native Windows path aliases cannot bypass the active project lock',async t=>{
  const f=await fixture(t);const alias=path.join(os.tmpdir(),path.basename(f.root),'project');
  f.runner.active.set('alias',{snapshot:{workingDir:alias}});
  await assert.rejects(f.trees.create('general'),/全部任务/);
});

test('full Pi runner forwards command snapshots through the actual approval and tool lifecycle',async t=>{
  const f=await fixture(t),faux=createFauxCore({models:[{id:'fixture',contextWindow:32000}],tokensPerSecond:1e9});
  await fs.writeFile(path.join(f.project,'check.cjs'),"require('fs').writeFileSync('app.txt','Pi shell change');console.log('verified');");
  const name=process.platform==='win32'?'powershell':'bash';
  faux.setResponses([fauxAssistantMessage(fauxToolCall(name,{command:'node check.cjs'}),{stopReason:'toolUse'}),fauxAssistantMessage('Finished.')]);
  const runner=new AgentRunner(f.store,bus,{piRuntime:options=>runPiAgent({...options,model:faux.getModel(),streamFn:faux.streamSimple})});
  const input=f.store.addEvent({source:'human:user',target:'channel/general',payload:{content:'Run check.cjs'}});
  const execution=runner.handleUserMessage(input);
  for(let i=0;i<300&&!runner.tools.pending.size;i++)await new Promise(resolve=>setTimeout(resolve,20));
  const approval=[...runner.tools.pending.keys()][0];assert.ok(approval);runner.tools.decide(approval,'general',true);await execution;
  const run=f.store.data.runtime_runs.at(-1);assert.equal(run.outcome,'finished');assert.equal(run.evidence.checkpoint.scope,'project-files');
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'Pi shell change');await runner.restore('general',run.id);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'baseline\n');
});

test('HTTP worktree lifecycle validates review revisions and restores the imported destination',async t=>{
  const f=await fixture(t),{server,port}=await startServer({port:0,userDataPath:f.data,staticDir:f.root});t.after(()=>server.shutdown());
  const url=`http://127.0.0.1:${port}`,post=async body=>{const response=await fetch(url+'/v1/runtime/worktree',{method:'POST',body:JSON.stringify({channel:'general',...body})});return {status:response.status,body:await response.json()};};
  const created=await post({action:'create'});assert.equal(created.status,200);await fs.writeFile(path.join(created.body.root,'app.txt'),'HTTP import');
  assert.equal((await post({action:'apply',revision:'stale'})).status,409);
  const review=await post({action:'review'});assert.equal(review.status,200);assert.equal((await post({action:'apply',revision:review.body.revision})).status,200);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'HTTP import');
  const records=await (await fetch(url+'/v1/runtime/recovery?channel=general')).json(),run=records.runs.at(-1);assert.equal(run.checkpoint.root_matches,true);
  const undo=await fetch(url+'/v1/runtime/restore',{method:'POST',body:JSON.stringify({channel:'general',run_id:run.id})});assert.equal(undo.status,200);
  assert.equal(await fs.readFile(path.join(f.project,'app.txt'),'utf8'),'baseline\n');
});

test('incomplete creation records can be cleared only when both filesystem and Git registration are absent',async t=>{
  const f=await fixture(t);await fs.mkdir(f.trees.directory,{recursive:true});
  f.store.data.managed_worktrees.push({id:'failed-creation',channel:'general',root:path.join(f.trees.directory,'failed-creation'),source:f.project,status:'creating'});f.store.save();
  assert.equal((await f.trees.state('general')).available,false);await f.trees.forget('general');assert.equal(f.trees.record('general'),undefined);
  const created=await f.trees.create('general');await assert.rejects(f.trees.forget('general'),/目录仍存在/);assert.ok(await fs.stat(created.root));
});

test('recovery rejects a replaced parent directory even when an internal link has matching file bytes',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.project,'nested'));await fs.writeFile(path.join(f.project,'nested','file.txt'),'before');
  await f.checkpoints.prepare('link-test','general',f.project,{path:'nested/file.txt',before:Buffer.from('before'),after:'after'});
  await fs.writeFile(path.join(f.project,'nested','file.txt'),'after');await fs.rename(path.join(f.project,'nested'),path.join(f.project,'moved'));
  await fs.mkdir(path.join(f.project,'other'));await fs.writeFile(path.join(f.project,'other','file.txt'),'after');
  try {await fs.symlink(path.join(f.project,'other'),path.join(f.project,'nested'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not allow symlink creation');return;}throw error;}
  await assert.rejects(f.checkpoints.restore('link-test','general',f.project),/符号链接/);
  assert.equal(await fs.readFile(path.join(f.project,'other','file.txt'),'utf8'),'after');
});
