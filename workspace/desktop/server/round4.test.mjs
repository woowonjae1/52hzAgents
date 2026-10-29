import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {runPiAgent} from './pi-engine.mjs';
import {CredentialVault} from './credential-vault.js';
import {ConfigManager} from './config-manager.js';
import {ConnectionTester} from './connection-tester.js';
import {Store} from './store.js';
import {AgentRunner} from './agent-runner.js';
import {contextController} from './pi-context.mjs';
import {importPiConnections} from './pi-config-import.js';

const storage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text).reverse(),decryptString:value=>Buffer.from(value).reverse().toString()};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'52hz-round4-test-'));const project=path.join(root,'project');await fs.mkdir(project);
  t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'52hz-round4-test-')));await fs.rm(root,{recursive:true,force:true});});
  const faux=createFauxCore({models:[{id:'fixture'}],tokensPerSecond:1e9});
  const options={config:{provider:'ollama',model:'fixture',mode:'chat'},channel:'general',userDataPath:root,projectDir:project,prompt:'Hello',signal:new AbortController().signal,model:faux.getModel(),streamFn:faux.streamSimple,onDelta(){},onTool(){},onApproval:async()=>false};
  return {root,project,faux,options};
}
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});

test('Chat/Plan/Agent share ID-based history, preserve repeated text and survive migration/reload',async t=>{
  const f=await fixture(t);
  const history=[{id:'old-u1',role:'user',content:'repeat'},{id:'old-a1',role:'assistant',content:'ok'},{id:'old-u2',role:'user',content:'repeat'}];
  f.faux.setResponses([context=>{assert.equal(context.messages.filter(m=>m.role==='user' && (typeof m.content==='string'?m.content:JSON.stringify(m.content)).includes('repeat')).length,2);return fauxAssistantMessage('First');}]);
  await runPiAgent({...f.options,history,promptId:'u3'});
  f.faux.setResponses([context=>{assert.equal(context.messages.filter(m=>m.role==='user' && JSON.stringify(m.content).includes('repeat')).length,3);return fauxAssistantMessage('Second');}]);
  await runPiAgent({...f.options,config:{...f.options.config,mode:'plan'},history:[...history,{id:'new-id-same-text',role:'user',content:'repeat'}],promptId:'u4'});
  f.faux.setResponses([fauxAssistantMessage('Third')]);
  await runPiAgent({...f.options,config:{...f.options.config,mode:'agent'},history,promptId:'u5'});
  const names=await fs.readdir(path.join(f.root,'pi-sessions'));assert.equal(names.length,1);
  const entries=(await fs.readFile(path.join(f.root,'pi-sessions',names[0]),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(e=>e.message?.uiMessageId==='old-u1').length,1);
  assert.equal(entries.filter(e=>e.message?.uiMessageId==='new-id-same-text').length,1);
});

test('credentials fail closed without OS encryption, migrate legacy only with OS protection, and honor env deletion',async t=>{
  const f=await fixture(t),unavailable=new CredentialVault(f.root,{isEncryptionAvailable:()=>false});
  assert.throws(()=>unavailable.set('key','secret'),/encryption is unavailable/);assert.equal(unavailable.has('key'),false);
  const vault=new CredentialVault(f.root,storage),cm=new ConfigManager(f.root,vault,{OPENAI_API_KEY:'env-secret'});
  cm.saveConnection({id:'openai',credentialAction:'keep'});assert.equal(cm.getConnection('openai').hasCredential,true);
  cm.saveConnection({id:'openai',credentialAction:'delete'});assert.equal(cm.getConnectionSecret('openai'),'');
  const reloaded=new ConfigManager(f.root,new CredentialVault(f.root,storage),{OPENAI_API_KEY:'env-secret'});assert.equal(reloaded.getConnection('openai').hasCredential,false);
  cm.saveConnection({id:'openai',credentialAction:'replace',credentialValue:'new-secret'});assert.equal(cm.getConnectionSecret('openai'),'new-secret');
  assert.doesNotMatch(await fs.readFile(path.join(f.root,'credentials.json'),'utf8'),/new-secret/);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(f.root).digest(),iv);
  const encrypted=Buffer.concat([cipher.update('legacy','utf8'),cipher.final()]);
  vault.data.old=`gcm:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
  assert.equal(vault.get('old'),'legacy');assert.match(vault.data.old,/^safe:/);
});

test('connection probe exposes only read, rejects failed/wrong calls and verifies result continuation',async t=>{
  const f=await fixture(t),cm=new ConfigManager(f.root,new CredentialVault(f.root,storage),{});
  cm.saveConnection({id:'probe',protocol:'openai',baseUrl:'http://127.0.0.1:9999/v1',defaultModel:'fixture',credentialAction:'replace',credentialValue:'fixture'});
  let fail=true;
  const tester=new ConnectionTester(cm,{piRuntime:async opts=>{
    assert.equal(opts.config.mode,'plan');assert.deepEqual(opts.allowedTools,['read']);assert.equal(await opts.onApproval({}),false);
    const nonce=await fs.readFile(path.join(opts.projectDir,'probe.txt'),'utf8');
    opts.onTool({phase:'start',tool:'read',toolCallId:'1'});opts.onTool({phase:'end',toolCallId:'1',isError:fail,output:nonce});
    return {content:nonce};
  }});
  assert.equal((await tester.test({connectionId:'probe',level:'agent'})).ok,false);
  fail=false;assert.equal((await tester.test({connectionId:'probe',level:'agent'})).ok,true);
});

test('Pi import stores secrets behind the vault and never executes command-based credential references',async t=>{
  const f=await fixture(t),cm=new ConfigManager(f.root,new CredentialVault(f.root,storage),{});
  const filename=path.join(f.root,'models.json');
  await fs.writeFile(filename,JSON.stringify({providers:{good:{api:'openai-completions',baseUrl:'https://gateway.invalid/v1',apiKey:'fixture-secret',models:[{id:'fixture',contextWindow:32000}]},blocked:{api:'openai-completions',baseUrl:'https://gateway.invalid/v1',apiKey:'!echo should-not-execute',models:[{id:'fixture'}]}}}));
  const result=importPiConnections(cm,filename);
  assert.equal(result.imported.length,1);assert.deepEqual(result.skipped,['blocked']);assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
  assert.equal(cm.getConnectionSecret('pi-good'),'fixture-secret');assert.doesNotMatch(await fs.readFile(cm.filePath,'utf8'),/fixture-secret/);
});

test('a failed configuration commit retains the prior endpoint and credential together',async t=>{
  const f=await fixture(t),cm=new ConfigManager(f.root,new CredentialVault(f.root,storage),{});
  cm.saveConnection({id:'atomic',baseUrl:'https://old.invalid/v1',defaultModel:'fixture',credentialAction:'replace',credentialValue:'old-key'});
  cm.saveUserConnections=()=>{throw new Error('Simulated disk failure');};
  assert.throws(()=>cm.saveConnection({id:'atomic',baseUrl:'https://new.invalid/v1',credentialAction:'replace',credentialValue:'new-key'}),/disk failure/);
  assert.equal(cm.getConnection('atomic').baseUrl,'https://old.invalid/v1');assert.equal(cm.getConnectionSecret('atomic'),'old-key');
  const reopened=new ConfigManager(f.root,new CredentialVault(f.root,storage),{});assert.equal(reopened.getConnectionSecret('atomic'),'old-key');
});

test('an active run keeps its connection snapshot while the queued run uses the next configuration version',async t=>{
  const f=await fixture(t),store=new Store(f.root),cm=new ConfigManager(f.root,new CredentialVault(f.root,storage),{});
  cm.saveConnection({id:'custom',baseUrl:'https://first.invalid/v1',defaultModel:'fixture',credentialAction:'replace',credentialValue:'first-key'});
  store.updateChannel('general',{working_dir:f.project,runtime_config:{provider:'custom',model:'fixture',mode:'chat'}});
  let release;const gate=new Promise(resolve=>release=resolve),captured=[];
  const runner=new AgentRunner(store,{broadcast(){},broadcastComposing(){}},{configManager:cm,piRuntime:async options=>{
    captured.push({baseUrl:options.baseUrl,key:options.apiKey});
    if(captured.length===1)await gate;
    return {content:'done',model:'fixture',sdk:'pi-1.4.0'};
  }});
  const user=()=>store.addEvent({source:'human:user',target:'channel/general',payload:{content:'repeat'}});
  const first=runner.handleUserMessage(user());
  cm.saveConnection({id:'custom',baseUrl:'https://second.invalid/v1',credentialAction:'replace',credentialValue:'second-key'});
  await runner.handleUserMessage(user());release();await first;
  while(runner.active.size)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(captured,[{baseUrl:'https://first.invalid/v1',key:'first-key'},{baseUrl:'https://second.invalid/v1',key:'second-key'}]);
  assert.deepEqual(store.data.runtime_runs.map(r=>r.snapshot.connectionVersion),[1,2]);
  assert.doesNotMatch(JSON.stringify(store.data.runtime_runs),/first-key|second-key/);
});

async function historySession(f){
  const file=path.join(f.root,'context.jsonl'),session=SessionManager.open(file,f.root,f.project);
  const model=f.faux.getModel();
  for(let i=0;i<8;i++){
    session.appendMessage({role:'user',content:[{type:'text',text:`request-${i} `+'x'.repeat(1500)}],timestamp:Date.now()});
    session.appendMessage({...fauxAssistantMessage(`response-${i} `+'y'.repeat(1200)),api:model.api,provider:model.provider,model:model.id});
  }
  return session;
}
test('Pi compaction appends a checkpoint, retains raw history, counts usage and reloads the compacted context',async t=>{
  const f=await fixture(t),session=await historySession(f),before=session.getEntries().length;
  f.faux.setResponses([fauxAssistantMessage('Goal: preserve the requests. Work completed: responses 0-6. Remaining: request 7.')]);
  let measured=0;
  const budget=contextController({session,model:f.faux.getModel(),capacity:32000,tools:[],signal:f.options.signal,streamFn:f.faux.streamSimple,keepRecentTokens:600,onUsage:usage=>measured+=usage.totalTokens});
  await budget.compress(session.buildSessionContext().messages,true);
  assert.ok(measured>0);assert.equal(session.getEntries().length,before+1);
  const reopened=SessionManager.open(session.getSessionFile(),f.root,f.project);
  assert.ok(reopened.buildSessionContext().messages.some(m=>m.role==='compactionSummary'));
  assert.ok(reopened.buildSessionContext().messages.length<before);
});

test('truncated/cancelled compaction preserves the previous checkpoint and history',async t=>{
  const f=await fixture(t),session=await historySession(f),before=session.getEntries().length;
  f.faux.setResponses([fauxAssistantMessage('partial summary',{stopReason:'length'})]);
  const budget=contextController({session,model:f.faux.getModel(),capacity:32000,tools:[],signal:f.options.signal,streamFn:f.faux.streamSimple,keepRecentTokens:600,onUsage(){}});
  await assert.rejects(budget.compress(session.buildSessionContext().messages,true));assert.equal(session.getEntries().length,before);
  const controller=new AbortController();controller.abort();
  const stopped=contextController({session,model:f.faux.getModel(),capacity:32000,tools:[],signal:controller.signal,streamFn:f.faux.streamSimple,onUsage(){}});
  await assert.rejects(stopped.compress(session.buildSessionContext().messages,true),/stopped/);assert.equal(session.getEntries().length,before);
});

test('automatic pre-request compaction is budgeted, and unknown capacity never becomes a fabricated percentage',async t=>{
  const f=await fixture(t),session=await historySession(f);
  const model={...f.faux.getModel(),maxTokens:128};
  f.faux.setResponses([fauxAssistantMessage('Summary of the earlier work. Preserve request 7 and continue.')]);
  const budget=contextController({session,model,capacity:5000,tools:[],signal:f.options.signal,streamFn:f.faux.streamSimple,keepRecentTokens:600,onUsage(){}});
  const result=await budget.prepare({messages:session.buildSessionContext().messages,tools:[]});
  assert.equal(budget.last.compactions,1);assert.ok(result.context.messages.some(m=>m.role==='compactionSummary'));
  const unknown=contextController({session,model,capacity:0,tools:[],signal:f.options.signal,streamFn:f.faux.streamSimple,onUsage(){}});
  await unknown.prepare({messages:result.context.messages});assert.equal(unknown.last.context_window,null);assert.equal(unknown.last.available_tokens,null);
});

test('the full Pi Agent continues after preflight compaction and does not reuse pre-compaction usage',async t=>{
  const f=await fixture(t),history=[];
  for(let i=0;i<8;i++) history.push({id:`u${i}`,role:'user',content:`Request ${i} `+'x'.repeat(2400)},{id:`a${i}`,role:'assistant',content:`Answer ${i} `+'y'.repeat(1600)});
  const states=[];
  f.faux.setResponses([fauxAssistantMessage('Prior work summary: preserve the last request and continue.'),context=>{
    assert.ok(JSON.stringify(context.messages).includes('Prior work summary'));
    return fauxAssistantMessage('Continued after compaction.');
  }]);
  const result=await runPiAgent({...f.options,history,promptId:'current',confirmedContextWindow:5000,maxOutputTokens:128,keepRecentTokens:600,onContext:s=>states.push(s)});
  assert.equal(result.content,'Continued after compaction.');assert.ok(states.some(s=>s.phase==='compacting'));assert.ok(result.usage.total_tokens>0);
  // Retained assistant usage captured before a compaction must not inflate its new projection.
  const session=await historySession(f),last=session.getEntries().filter(e=>e.type==='message').at(-1).message;
  session.appendMessage({...last,usage:{...last.usage,input:20000,totalTokens:20000}});
  f.faux.setResponses([fauxAssistantMessage('Short summary.'),fauxAssistantMessage('Turn prefix summary.')]);
  const budget=contextController({session,model:{...f.faux.getModel(),maxTokens:128},capacity:5000,tools:[],signal:f.options.signal,streamFn:f.faux.streamSimple,keepRecentTokens:600,onUsage(){}});
  await budget.prepare({messages:session.buildSessionContext().messages});assert.ok(budget.last.estimated_tokens<5000);
});

test('run evidence records actual command text and Git-visible shell edits without attributing pre-existing changes',async t=>{
  const f=await fixture(t),git=args=>execFileSync('git',['-C',f.project,...args],{windowsHide:true,stdio:'ignore'});
  git(['init']);await fs.writeFile(path.join(f.project,'old.txt'),'old\n');await fs.writeFile(path.join(f.project,'change.txt'),'before\n');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','Fixture']);
  await fs.writeFile(path.join(f.project,'old.txt'),'user modification\n');
  const store=new Store(f.root);store.updateChannel('general',{working_dir:f.project,runtime_config:{provider:'ollama',model:'fixture',mode:'agent'}});
  const runner=new AgentRunner(store,{broadcast(){},broadcastComposing(){}},{piRuntime:async opts=>{
    opts.onTool({phase:'start',toolCallId:'cmd',tool:'powershell',args:{command:'node check.cjs'}});
    await fs.writeFile(path.join(f.project,'change.txt'),'after\n');
    opts.onTool({phase:'end',toolCallId:'cmd',tool:'powershell',output:'failed',isError:true,structuredContent:{exit_code:1,wall_time_seconds:1}});
    throw new Error('Provider disconnected.');
  }});
  await runner.handleUserMessage(store.addEvent({source:'human:user',target:'channel/general',payload:{content:'Fix'}}));
  const result=store.data.events.findLast(e=>e.metadata.execution_evidence)?.metadata.execution_evidence;
  assert.equal(result.outcome,'failed');assert.deepEqual(result.files_modified,['change.txt']);assert.equal(result.commands[0].command,'node check.cjs');assert.equal(result.commands[0].exitCode,1);
});
