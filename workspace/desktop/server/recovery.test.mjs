import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store.js';
import { Checkpoints } from './checkpoints.js';
import { createProjectTools } from './pi-tools.mjs';
import { AgentRunner } from './agent-runner.js';
import { startServer } from './index.js';
import { closeDatabasesUnder } from './storage/database.js';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'52hz-recovery-'));
  t.after(async()=>{closeDatabasesUnder(root);assert.ok(path.basename(root).startsWith('52hz-recovery-'));await fs.rm(root,{recursive:true,force:true});});
  const project=path.join(root,'project');await fs.mkdir(project);
  const store=new Store(root);store.updateChannel('general',{working_dir:project,runtime_config:{provider:'ollama',model:'fixture',mode:'agent'}});
  return {root,project,store,checkpoints:new Checkpoints(root)};
}
const bus={broadcast(){},broadcastComposing(){}};
const input={id:'input-1',source:'human:user',target:'channel/general',payload:{content:'Change files'}};

test('atomic store keeps a last-good backup and recovers corruption without discarding original bytes',async t=>{
  const f=await fixture(t);f.store.updateChannel('general',{title:'saved'});f.store.updateChannel('general',{title:'newest'});
  await fs.writeFile(f.store.dbFile,'broken JSON');
  const recovered=new Store(f.root);assert.equal(recovered.getChannel('general').title,'saved');assert.equal(recovered.recovery.recovered,true);
  assert.ok((await fs.readdir(f.root)).some(name=>name.includes('.corrupt-')));
  recovered.save();assert.equal(JSON.parse(await fs.readFile(recovered.dbFile,'utf8')).workspace.channels[0].title,'saved');
  await fs.writeFile(recovered.dbFile,'broken');await fs.writeFile(`${recovered.dbFile}.bak`,'also broken');
  assert.throws(()=>new Store(f.root),/无法读取/);
});

test('a failed store rename reports failure and preserves the committed main file',async t=>{
  const f=await fixture(t), before=await fs.readFile(f.store.dbFile,'utf8');
  const rename=sync.renameSync;
  sync.renameSync=(from,to)=>{if(to===f.store.dbFile)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return rename(from,to);};
  try {f.store.data.todos.push({title:'not committed'});assert.throws(()=>f.store.save(),error=>error.status===507);}
  finally {sync.renameSync=rename;}
  assert.equal(await fs.readFile(f.store.dbFile,'utf8'),before);
  assert.equal(f.store.data.todos.length,0);
  assert.equal((await fs.readdir(f.root)).some(name=>name.endsWith('.tmp')),false);
});

async function toolsFor(f,id='run-1') {
  return createProjectTools({root:f.project,mode:'agent',signal:new AbortController().signal,requestApproval:async()=>false,
    beforeMutation:change=>f.checkpoints.prepare(id,'general',f.project,change)});
}

test('file-tool undo survives restart and preserves pre-existing edits, empty files and new-file absence',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'dirty.txt'),'user uncommitted work');await fs.writeFile(path.join(f.project,'empty.txt'),'');
  const tools=await toolsFor(f),write=tools.find(tool=>tool.name==='write');
  await write.execute('one',{path:'dirty.txt',content:'first'});
  await write.execute('two',{path:'dirty.txt',content:'second'});
  await write.execute('three',{path:'new.txt',content:'new'});
  await write.execute('four',{path:'empty.txt',content:'was empty'});
  const restarted=new Checkpoints(f.root);await restarted.restore('run-1','general',f.project);
  assert.equal(await fs.readFile(path.join(f.project,'dirty.txt'),'utf8'),'user uncommitted work');
  assert.equal(await fs.readFile(path.join(f.project,'empty.txt'),'utf8'),'');
  await assert.rejects(fs.stat(path.join(f.project,'new.txt')),error=>error.code==='ENOENT');
  assert.ok((await restarted.describe('run-1','general')).restored_at);
  await assert.rejects(restarted.restore('run-1','general',f.project),/已经撤销/);
});

test('undo preflight refuses ALL files if any file has later user changes or a wrong session',async t=>{
  const f=await fixture(t),write=(await toolsFor(f)).find(tool=>tool.name==='write');
  await write.execute('a',{path:'a.txt',content:'agent a'});await write.execute('b',{path:'b.txt',content:'agent b'});
  await fs.writeFile(path.join(f.project,'b.txt'),'user later edit');
  await assert.rejects(f.checkpoints.restore('run-1','wrong',f.project),/此会话/);
  await assert.rejects(f.checkpoints.restore('run-1','general',f.project),/后续改动/);
  assert.equal(await fs.readFile(path.join(f.project,'a.txt'),'utf8'),'agent a');
  assert.equal(await fs.readFile(path.join(f.project,'b.txt'),'utf8'),'user later edit');
});

test('checkpoint failure blocks the project write, and concurrent file tools retain every preimage',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'original.txt'),'original');
  const blocked=await createProjectTools({root:f.project,mode:'agent',signal:new AbortController().signal,beforeMutation:async()=>{throw new Error('cannot save checkpoint');}});
  await assert.rejects(blocked.find(tool=>tool.name==='write').execute('x',{path:'original.txt',content:'changed'}),/checkpoint/);
  assert.equal(await fs.readFile(path.join(f.project,'original.txt'),'utf8'),'original');
  const write=(await toolsFor(f)).find(tool=>tool.name==='write');
  await Promise.all(Array.from({length:6},(_,i)=>write.execute(String(i),{path:`file${i}.txt`,content:String(i)})));
  assert.equal((await f.checkpoints.describe('run-1','general')).files.length,6);
});

test('runner records failed writes for recovery and blocks overlapping project writers and undo',async t=>{
  const f=await fixture(t);let release,started;const ready=new Promise(resolve=>started=resolve);
  const runner=new AgentRunner(f.store,bus,{piRuntime:async options=>{
    const tools=await createProjectTools({root:f.project,mode:'agent',signal:options.signal,beforeMutation:options.beforeMutation,onMutation:options.onMutation});
    await tools.find(tool=>tool.name==='write').execute('write',{path:'result.txt',content:'result'});
    started();await new Promise(resolve=>release=resolve);throw new Error('provider disconnected');
  }});
  f.store.updateChannel('second',{working_dir:f.project,runtime_config:{provider:'ollama',model:'fixture',mode:'agent'}});
  const pending=runner.handleUserMessage(input);await ready;
  await runner.handleUserMessage({...input,id:'input-2',target:'channel/second'});
  assert.equal(f.store.data.runtime_runs.length,1);
  await assert.rejects(runner.restore('general',f.store.data.runtime_runs[0].id),/已经结束/);
  release();await pending;
  const record=f.store.data.runtime_runs[0];assert.equal(record.outcome,'failed');assert.deepEqual(record.evidence.checkpoint.files,['result.txt']);
  await runner.restore('general',record.id);await assert.rejects(fs.stat(path.join(f.project,'result.txt')));
});

test('restart marks unfinished tools and runs interrupted without replaying an approval',async t=>{
  const f=await fixture(t);
  f.store.data.runtime_runs=[{id:'run-crashed',channel:'general',phase:'executing',outcome:null}];
  f.store.data.runtime_tools=[{id:'tool',channel:'general',run_id:'run-crashed',tool:'powershell',status:'pending',args:{command:'dangerous'},output:''}];f.store.save();
  let executions=0;const restored=new Store(f.root);const runner=new AgentRunner(restored,bus,{piRuntime:async()=>{executions++;}});
  assert.equal(executions,0);assert.equal(restored.data.runtime_runs[0].outcome,'interrupted');assert.equal(runner.tools.list('general')[0].status,'interrupted');
  assert.equal(restored.data.runtime_runs[0].evidence.commands[0].exitCode,undefined);
});

test('disk failure at run startup releases the project lock and cannot hang shutdown',async t=>{
  const f=await fixture(t),runner=new AgentRunner(f.store,bus,{piRuntime:async()=>{throw new Error('must not start');}});
  const save=f.store.save.bind(f.store);f.store.save=()=>{throw Object.assign(new Error('disk unavailable'),{status:507});};
  await assert.rejects(runner.handleUserMessage(input),/disk unavailable/);
  assert.equal(runner.active.size,0);
  f.store.save=save;await runner.close();
});

test('unsupported mutations fail explicitly and recovery HTTP routes enforce session scope',async t=>{
  const f=await fixture(t);const {server,port}=await startServer({port:0,userDataPath:f.root,staticDir:f.root});t.after(()=>server.shutdown());
  const base=`http://127.0.0.1:${port}`;
  for(const route of ['/v1/workspaces/52hz/skills/custom', '/v1/skills/custom']) {
    const response=await fetch(base+route,{method:'POST',body:'{}'});assert.equal(response.status,501);assert.equal((await response.json()).supported,false);
  }
  const response=await fetch(`${base}/v1/runtime/recovery?channel=general`);assert.equal(response.status,200);assert.deepEqual((await response.json()).runs,[]);
  const denied=await fetch(`${base}/v1/runtime/restore`,{method:'POST',body:JSON.stringify({channel:'other',run_id:'unknown'})});assert.equal(denied.status,409);
});
