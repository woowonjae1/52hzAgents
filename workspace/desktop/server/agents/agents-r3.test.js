'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage');
const { HumanInteractions } = require('./human-interactions');
const { runNativePi } = require('./adapters/pi-native');
const { runCodex } = require('./adapters/codex');
const { startServer } = require('../index');
const { piQuestion, codexQuestion } = require('./native-questions');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { locate, buildSanitizedNativeEnv, stopChild } = require('./adapters/common');
const { attachJsonlLineReader } = require('./transports/jsonl');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r3-'));
  const storage = createStorage({ dbPath: path.join(root, 'db.sqlite') });
  const service = new HumanInteractions(storage);
  t.after(() => { service.close(); storage.close(); removeFixture(root); });
  return { root, storage, service };
}
function removeFixture(root) {
  const target = path.resolve(root);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('52hz-r3-'));
  fs.rmSync(target, { recursive: true, force: true });
}
const spec = (patch = {}) => ({ runId: 'run-r3', attemptId: 'attempt-r3', channel: 'r3', agentId: 'pi', agentName: 'Pi',
  nativeRequestId: 'native-1', kind: 'question', questions: [{ id: 'target', title: '选择目标', options: [{ label: 'A' }, { label: 'B' }], allowFreeInput: true }], ...patch });
const answerBody = row => ({ attemptId: row.attemptId, expectedVersion: row.version, idempotencyKey: 'answer-once', answers: { target: ['A'] } });
async function waitFor(fn) {
  for (let i = 0; i < 300; i++) { const result = fn(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for R3 event');
}

test('R3 durable answers are attempt-bound, versioned, idempotent and have honest delivery receipts', async t => {
  const { storage, service } = fixture(t);
  let resumed = 0;
  const pending = service.request(spec(), { onResumed: () => resumed++ });
  const row = storage.humanInteractions.list()[0];
  assert.equal(service.isWaiting(row.runId), true);
  assert.throws(() => service.answer(row.id, { ...answerBody(row), attemptId: 'old-attempt' }), e => e.code === 'STALE_INTERACTION_ATTEMPT');
  assert.throws(() => service.answer(row.id, { ...answerBody(row), expectedVersion: 99 }), e => e.status === 409);
  assert.throws(() => service.answer(row.id, { ...answerBody(row), answers: {} }), e => e.status === 400);
  const accepted = service.answer(row.id, answerBody(row));
  assert.equal(accepted.state, 'answered');
  assert.equal(service.answer(row.id, answerBody(row)).state, 'answered');
  const received = await pending;
  assert.deepEqual(received.answers, { target: ['A'] });
  assert.equal(resumed, 0, 'Persisting an answer does not yet resume the native task');
  assert.equal(service.isWaiting(row.runId), true);
  assert.throws(() => service.answer(row.id, { ...answerBody(row), idempotencyKey: 'second' }), e => e.status === 409);
  service.sent(row.id);
  assert.equal(resumed, 1);
  assert.equal(storage.humanInteractions.get(row.id).state, 'sent');
  service.progress(row.runId);
  service.finish(row.runId);
  assert.equal(storage.humanInteractions.get(row.id).state, 'continued');
});

test('R3 permissions cannot be granted through answer endpoint, and rejected decisions are not broadened', async t => {
  const { storage, service } = fixture(t);
  const pending = service.request(spec({ kind: 'approval' }));
  const row = storage.humanInteractions.list()[0];
  assert.throws(() => service.answer(row.id, answerBody(row)), e => e.code === 'INVALID_APPROVAL');
  service.answer(row.id, { ...answerBody(row), confirmed: false }, 'decision');
  assert.equal((await pending).confirmed, false);
  service.sent(row.id);
  service.finish(row.runId);
  assert.equal(storage.humanInteractions.get(row.id).state, 'delivery_unknown');
});

test('R3 cancellation, expiry and process interruption never replay an answer', async t => {
  const { storage, service } = fixture(t);
  const cancelled = service.request(spec());
  const row = storage.humanInteractions.list()[0];
  service.answer(row.id, answerBody(row), 'cancel');
  assert.equal((await cancelled).cancelled, true);
  service.sent(row.id);
  assert.equal(storage.humanInteractions.get(row.id).state, 'cancelled');
  const expiring = service.request(spec({ nativeRequestId: 'timeout', timeoutMs: 5 }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await expiring).cancelled, true);
  assert.equal(storage.humanInteractions.list().find(r => r.nativeRequestId === 'timeout').state, 'expired');
  const aborted = service.request(spec({ nativeRequestId: 'abort' }));
  const rejection = assert.rejects(aborted, e => e.code === 'INTERACTION_INVALIDATED');
  service.finish('run-r3'); await rejection;
  const lost = storage.humanInteractions.list().find(r => r.nativeRequestId === 'abort');
  assert.equal(lost.state, 'invalidated');
  assert.throws(() => service.answer(lost.id, answerBody(lost)), e => e.status === 409);
});

test('R3 restart recovery distinguishes unsubmitted requests from delivery-unknown answers', async t => {
  const { root, storage } = fixture(t);
  const row = storage.humanInteractions.create(spec({ timeoutMs: 60000 }));
  const answered = storage.humanInteractions.create(spec({ nativeRequestId: 'answered', timeoutMs: 60000 }));
  storage.humanInteractions.transition(answered.id, 'waiting', 'answered', { answer: { answers: { target: ['A'] } } });
  storage.db.prepare('UPDATE human_interactions SET owner_pid=99999999').run();
  const reopened = createStorage({ dbPath: path.join(root, 'db.sqlite') });
  const recovered = new HumanInteractions(reopened);
  try {
    assert.equal(reopened.humanInteractions.get(row.id).state, 'invalidated');
    const persisted = reopened.humanInteractions.get(answered.id);
    assert.equal(persisted.state, 'delivery_unknown');
    assert.deepEqual(persisted.answer, { answers: { target: ['A'] } });
    assert.throws(() => recovered.answer(row.id, answerBody(row)), e => e.status === 409);
  } finally { recovered.close(); reopened.close(); }
});

test('R3 normalization keeps Pi confirmations separate and refuses secret input', () => {
  assert.equal(piQuestion({ id: 'c', method: 'confirm', title: '确认操作', message: '执行本次操作？' }).kind, 'approval');
  assert.throws(() => codexQuestion({ questions: [{ id: 's', question: 'Enter credential', isSecret: true }] }, 's'), e => e.code === 'AUTH_INPUT_NOT_ALLOWED');
  assert.throws(() => piQuestion({ id: 's', method: 'input', title: '请输入 API key' }), e => e.code === 'AUTH_INPUT_NOT_ALLOWED');
  assert.throws(() => codexQuestion({ questions: [{ id: 'x', question: 'one' }, { id: 'x', question: 'two' }] }, 's'));
});

test('R3 cancellation during optional Pi statistics cannot send a prompt or be overwritten by process exit', async t => {
  const { root } = fixture(t);
  const statsMarker=path.join(root,'stats.pending'),promptMarker=path.join(root,'prompt.sent');
  const script=path.join(root,'abort-stats.cjs');
  fs.writeFileSync(script,`const fs=require('node:fs');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.type==='get_state')send({type:'response',id:m.id,command:m.type,success:true,data:{model:{id:'test',provider:'test'}}});
      if(m.type==='get_session_stats')fs.writeFileSync(${JSON.stringify(statsMarker)},'pending');
      if(m.type==='prompt')fs.writeFileSync(${JSON.stringify(promptMarker)},'sent after cancel');
      if(m.type==='abort')process.exit(0);
    });`);
  const controller=new AbortController();
  const task=runNativePi({projectDir:root,config:{mode:'plan'},agentPolicy:{permissions:{readFiles:true}},prompt:'must not send',signal:controller.signal},
    {launch:{command:process.execPath,args:[script]}});
  const rejected=assert.rejects(task,e=>e.code==='ABORT_ERR');
  await waitFor(()=>fs.existsSync(statsMarker));controller.abort();
  await rejected;assert.equal(fs.existsSync(promptMarker),false);
});

function fakeLaunch(root, kind, premature = false) {
  const file = path.join(root, `fake-${kind}-${premature}.cjs`);
  fs.writeFileSync(file, `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const kind=${JSON.stringify(kind)},premature=${premature};
rl.on('line',line=>{
 const m=JSON.parse(line);
 const done=()=>{
   if(kind==='pi'){
     send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'continued original task'}]}});
     send({type:'agent_end',messages:[]});
   }else{
     send({method:'item/completed',params:{item:{id:'final',type:'agentMessage',text:'continued original task'}}});
     send({method:'turn/completed',params:{turn:{id:'turn-r3',status:'completed'}}});
   }
 };
 if(kind==='pi'){
   const ok=data=>send({id:m.id,type:'response',command:m.type,success:true,data});
   if(m.type==='get_state')ok({sessionId:'native-r3',model:{id:'test',provider:'test'}});
   if(m.type==='get_session_stats')ok({tokens:{input:0,output:0,total:0},cost:0});
   if(m.type==='prompt'){
     ok({});send({type:'extension_ui_request',id:'notify',method:'notify',message:'notification only'});
     send({type:'extension_ui_request',id:'question-r3',method:'select',title:'选择目标',options:['A','B']});
     if(premature)done();
   }
   if(m.type==='extension_ui_response'&&m.id==='question-r3'){
     if(m.value!=='A')throw Error('wrong Pi answer');done();
   }
 }else{
   const ok=result=>send({id:m.id,result});
   if(m.method==='initialize')ok({});
   if(m.method==='config/read')ok({config:{}});
   if(m.method==='thread/start'){
     if(m.params.config.features.default_mode_request_user_input!==true)throw Error('Codex question capability not enabled for this thread');
     ok({thread:{id:'thread-r3'},sandbox:{type:'readOnly'},approvalPolicy:'untrusted',approvalsReviewer:'user',model:'test'});
   }
   if(m.method==='turn/start'){
     ok({turn:{id:'turn-r3'}});
     send({id:101,method:'item/tool/requestUserInput',params:{threadId:'thread-r3',turnId:'turn-r3',itemId:'ask',questions:[{id:'target',header:'Target',question:'选择目标',options:[{label:'A',description:'First'},{label:'B',description:'Second'}]}]}});
     if(premature)done();
   }
   if(m.id===101&&!m.method){if(m.result?.answers?.target?.answers?.[0]!=='A')throw Error('wrong Codex answer');done();}
 }
});`);
  return { command: process.execPath, args: [file], path: file, env: {} };
}

for (const kind of ['pi', 'codex']) {
  test(`R3 ${kind}: actual JSONL child waits, receives one answer, then completes original task`, async t => {
    const { root, storage, service } = fixture(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    let notices = 0;
    const options = { projectDir: root, config: { mode: 'plan' }, agentPolicy: { permissions: { readFiles: true } },
      signal: controller.signal, prompt: 'ask first',
      onExtensionNotification: () => notices++,
      onHumanInteraction: q => service.request(spec({ ...q }), { signal: controller.signal }),
      onHumanInteractionSent: id => service.sent(id), onHumanInteractionProgress: () => service.progress('run-r3') };
    let completed = false;
    const task = (kind === 'pi' ? runNativePi : runCodex)(options, { launch: fakeLaunch(root, kind) }).then(r => { completed = true; return r; });
    const row = await waitFor(() => storage.humanInteractions.list()[0]);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(completed, false, 'A waiting question is not a successful completed task');
    const body = { ...answerBody(row), answers: { [row.questions[0].id]: ['A'] } };
    service.answer(row.id, body);
    service.answer(row.id, body);
    const result = await task;
    assert.equal(result.content, 'continued original task');
    assert.equal(storage.humanInteractions.get(row.id).state, 'continued');
    if (kind === 'pi') assert.equal(notices, 1);
    service.finish('run-r3');
  });
  test(`R3 ${kind}: premature terminal event while a question is pending fails closed`, async t => {
    const { root, service } = fixture(t);
    await assert.rejects((kind === 'pi' ? runNativePi : runCodex)({projectDir:root,config:{mode:'plan'},agentPolicy:{permissions:{readFiles:true}},prompt:'test',
      onHumanInteraction:q=>service.request(spec({...q})) }, {launch:fakeLaunch(root,kind,true)}), e=>e.code==='INTERACTION_PENDING');
    service.finish('run-r3');
  });
}

test('R3 authenticated HTTP answers, reconnect reads and recovery guard use the real broker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r3-http-'));
  const { server, port } = await startServer({ port: 0, userDataPath: root, staticDir: root, apiToken: 'r3-test-token' });
  t.after(async () => { await server.shutdown(); removeFixture(root); });
  const base = `http://127.0.0.1:${port}`;
  const broker = server.agentRunner.interactions;
  const pending = broker.request(spec());
  const row = server.store.storage.humanInteractions.list()[0];
  const get = await fetch(`${base}/v1/interactions?channel=r3`, { headers: { 'X-Workspace-Token': 'r3-test-token' } });
  assert.equal((await get.json()).interactions[0].id, row.id);
  const url = `${base}/v1/interactions/${row.id}/answer`;
  assert.equal((await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'},body:JSON.stringify(answerBody(row)) })).status, 401);
  const options = {method:'POST',headers:{'X-Workspace-Token':'r3-test-token','Content-Type':'application/json'},body:JSON.stringify(answerBody(row))};
  assert.equal(server.agentRunner.acquireRecoveryLock(), true);
  assert.equal((await fetch(url, options)).status, 409);
  server.agentRunner.releaseRecoveryLock();
  const [first, duplicate] = await Promise.all([fetch(url,options),fetch(url,options)]);
  assert.equal(first.status,200);assert.equal(duplicate.status,200);
  assert.deepEqual((await pending).answers,{target:['A']});
  broker.sent(row.id);broker.finish(row.runId);
  assert.equal(server.store.storage.humanInteractions.get(row.id).state,'delivery_unknown');
});

test('R3 AgentRunner + HTTP + native child retain waiting phase and continue the same run after answer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '52hz-r3-runner-'));
  const launch = fakeLaunch(root, 'pi');
  const bin = path.join(root, 'bin');
  const cli = path.join(bin, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.copyFileSync(launch.args[0], cli);
  const piDir = path.join(root, 'native'); fs.mkdirSync(piDir);
  fs.writeFileSync(path.join(piDir, 'settings.json'), '{"defaultProvider":"test","defaultModel":"test"}');
  const { server, port } = await startServer({port:0,userDataPath:path.join(root,'data'),staticDir:root,
    runtimeOptions:{env:{PATH:bin,USERPROFILE:root},nativeRuntime:(_agent,opts)=>runNativePi(opts,{launch})}});
  t.after(async()=>{await server.shutdown();removeFixture(root);});
  const { connection } = server.nativeConfigService.registerConnection({kind:'native-pi',configDir:piDir,createMember:false});
  const agent = server.store.storage.agentDefinitions.create({name:'Pi R3',role:'assistant',runtimeKind:'pi',connectionId:connection.id,
    defaultMode:'plan',maxMode:'plan',permissions:{readFiles:true,writeFiles:false,executeCommands:false,knowledge:false,mcp:false,delegate:false}});
  server.store.updateChannel('general',{agent_id:agent.id,working_dir:root,runtime_config:{inheritAgent:true,mode:'plan'}});
  server.store.storage.db.prepare(`UPDATE budget_limits SET max_tokens_per_run=NULL,max_steps_per_run=NULL,max_cost_per_session=NULL,max_cost_per_day=NULL WHERE id='global'`).run();
  const event=server.store.addEvent({type:'workspace.message.posted',source:'human:user',target:'channel/general',payload:{content:'Ask me before continuing'}});
  const execution=server.agentRunner.handleUserMessage(event);
  const row=await waitFor(()=>server.store.storage.humanInteractions.list({channel:'general'})[0]);
  assert.equal(server.store.storage.runs.get(row.runId).phase,'waiting_input');
  assert.equal(server.store.data.runtime_runs.find(r=>r.id===row.runId).phase,'waiting_input');
  assert.equal(server.agentRunner.active.size,1);
  const res=await fetch(`http://127.0.0.1:${port}/v1/interactions/${row.id}/answer`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...answerBody(row),answers:{value:['A']}})});
  assert.equal(res.status,200);
  assert.equal((await execution).outcome,'finished');
  assert.equal(server.store.storage.runs.get(row.runId).phase,'finished');
  assert.equal(server.store.storage.humanInteractions.get(row.id).state,'continued');
  assert.equal(server.agentRunner.active.size,0);
});

test('R3 installed Pi runs the workbench question tool through real RPC without any model request', { timeout: 45000 }, async t => {
  const launch = locate('pi');
  if (!launch) return t.skip('No local Pi installation; deterministic protocol tests remain required.');
  const { root, storage, service } = fixture(t);
  const agentDir = path.join(root, 'native-pi'); fs.mkdirSync(agentDir);
  const extension = path.join(root, 'r3-probe.mjs');
  const toolUrl = pathToFileURL(path.join(__dirname, 'extensions', 'workbench-questions.mjs')).href;
  fs.writeFileSync(extension, `import install from ${JSON.stringify(toolUrl)};
export default function(pi) {
 let tool;install({registerTool:t=>{tool=t;pi.registerTool(t);}});
 pi.registerCommand('r3-offline-probe',{description:'Offline question test',handler:async(_args,ctx)=>{
   const result=await tool.execute('probe',{question:'选择验收目标'},new AbortController().signal,()=>{},ctx);
   ctx.ui.notify(result.content[0].text==='R3_NATIVE_OK'?'R3_NATIVE_OK':'R3_NATIVE_FAILED');
 }});
}`);
  const child = spawn(launch.command,[...launch.args,'--mode','rpc','--no-session','--no-extensions','--no-skills',
    '--extension',extension,'--tools','read,workbench_ask_user'],{cwd:root,
    env:buildSanitizedNativeEnv(process.env,launch,{PI_CODING_AGENT_DIR:agentDir}),windowsHide:true,stdio:['pipe','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  let detach, timer;
  try {
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Installed Pi offline UI probe timed out')),35000);
      child.once('error',reject);
      child.once('close',()=>reject(new Error('Installed Pi exited before the UI probe finished')));
      child.stderr.on('data',()=>{});
      detach=attachJsonlLineReader(child.stdout,line=>{
        Promise.resolve().then(async()=>{
          const event=JSON.parse(line);
          if(event.type==='response'&&event.id==='commands'){
            assert.ok(event.data.commands.some(c=>c.name==='r3-offline-probe'));
            child.stdin.write(JSON.stringify({id:'invoke',type:'prompt',message:'/r3-offline-probe'})+'\n');
          }
          if(event.type==='extension_ui_request'&&event.method==='input'){
            const pending=service.request(spec({...piQuestion(event)}));
            const row=storage.humanInteractions.list()[0];
            service.answer(row.id,{...answerBody(row),answers:{value:['R3_NATIVE_OK']}});
            const answer=await pending;
            await new Promise((ok,fail)=>child.stdin.write(JSON.stringify({type:'extension_ui_response',id:event.id,value:answer.answers.value[0]})+'\n',e=>e?fail(e):ok()));
            service.sent(row.id);
          }
          if(event.type==='extension_ui_request'&&event.method==='notify'){
            assert.equal(event.message,'R3_NATIVE_OK');service.progress('run-r3');resolve();
          }
        }).catch(reject);
      },reject);
      child.stdin.write(JSON.stringify({id:'commands',type:'get_commands'})+'\n');
    });
    assert.equal(storage.humanInteractions.list()[0].state,'continued');
  } finally {clearTimeout(timer);detach?.();await stopChild(child);await closed;}
});
