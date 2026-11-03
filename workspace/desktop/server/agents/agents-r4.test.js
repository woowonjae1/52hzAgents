'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {startServer}=require('../index');
const {runNativePi}=require('./adapters/pi-native');
const {runCodex}=require('./adapters/codex');
const {createNativeBudgetPolicy,allowsNativeBudgetPolicy}=require('../native-budget-policy');
async function waitFor(fn){for(let i=0;i<800;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,15));}throw Error('R4 state did not settle');}
const version=lane=>({expected_commit:lane.commit_hash,expected_version:lane.delivery_version});

const nativeScript=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const kind=process.argv[2],send=x=>process.stdout.write(JSON.stringify(x)+'\n');
let prompt='',writable=false;
function finishReview(){
 const revision=fs.readFileSync('result.txt','utf8');
 const text=JSON.stringify({verdict:revision.trim()==='v2'?'approved':'changes_requested',notes:revision.trim()==='v2'?'Verified current delivery':'Change result.txt to v2; preserve the acceptance test.'});
 send({method:'item/completed',params:{item:{id:'review-result',type:'agentMessage',text}}});
 send({method:'turn/completed',params:{turn:{id:'review-turn',status:'completed'}}});
}
function askReview(){send({id:202,method:'item/tool/requestUserInput',params:{threadId:'review-thread',turnId:'review-turn',itemId:'criteria',questions:[{id:'criteria',header:'Criteria',question:'Which acceptance criteria apply?',options:[{label:'Require v2',description:'Use the saved task requirement'}]}]}});}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(kind==='pi'){
  const ok=data=>send({type:'response',id:m.id,command:m.type,success:true,data});
  if(m.type==='get_state')ok({model:{id:'test',provider:'test'},sessionId:'r4-pi'});
  if(m.type==='get_session_stats')ok({tokens:{input:0,output:0,total:0},cost:0});
  if(m.type==='prompt'){prompt=m.message;ok({});send({type:'extension_ui_request',id:'author-question',method:'input',title:'确认交付目标'});}
  if(m.type==='extension_ui_response'){
    const value=prompt.includes('Previous review feedback')?'v2':'v1';
    send({type:'tool_execution_start',toolCallId:'write-result',toolName:'write',args:{path:'result.txt'}});
    fs.writeFileSync('result.txt',value+'\n');
    send({type:'tool_execution_end',toolCallId:'write-result',toolName:'write',args:{path:'result.txt'},result:{content:[{type:'text',text:'written'}]}});
    send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Delivered '+value}],usage:{input:5,output:2,totalTokens:7,cost:{total:0.001}}}});
    send({type:'agent_end',messages:[]});
  }
 }else{
  const ok=result=>send({id:m.id,result});
  if(m.method==='initialize')ok({});
  if(m.method==='config/read')ok({config:{}});
  if(m.method==='thread/start'){writable=m.params.sandbox==='workspace-write';ok({thread:{id:'review-thread'},model:'test',sandbox:{type:writable?'workspaceWrite':'readOnly'},approvalPolicy:'untrusted',approvalsReviewer:'user'});}
  if(m.method==='turn/start'){
    ok({turn:{id:'review-turn'}});
    if(writable){send({method:'item/started',params:{item:{id:'verification',type:'commandExecution',command:'node --test verification-test.cjs',status:'inProgress'}}});
      send({id:201,method:'item/commandExecution/requestApproval',params:{threadId:'review-thread',turnId:'review-turn',itemId:'verification',command:'node --test verification-test.cjs',cwd:process.cwd()}});
    }else askReview();
  }
  if(m.id===201&&!m.method){
    if(m.result?.decision==='accept'){
      const result=cp.spawnSync(process.execPath,['--test','verification-test.cjs'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true});
      fs.writeFileSync('verification-result.txt',result.stdout || '');
      send({method:'item/completed',params:{item:{id:'verification',type:'commandExecution',command:'node --test verification-test.cjs',status:'completed',exitCode:result.status,aggregatedOutput:result.stdout}}});
    }else send({method:'item/completed',params:{item:{id:'verification',type:'commandExecution',command:'node --test verification-test.cjs',status:'declined'}}});
    askReview();
  }
  if(m.id===202&&!m.method)finishReview();
 }
});`;

async function fixture(t){
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'52hz-r4-')));
 const project=path.join(root,'project');fs.mkdirSync(project);
 const git=(...args)=>execFileSync('git',['-C',project,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
 git('init','-b','main');git('config','user.name','R4 Fixture');git('config','user.email','r4@example.invalid');git('config','core.autocrlf','false');
 fs.writeFileSync(path.join(project,'result.txt'),'base\n');
 fs.writeFileSync(path.join(project,'verification-test.cjs'),`require('node:assert/strict').match(require('node:fs').readFileSync('result.txt','utf8'),/^v[12]/);`);
 git('add','.');git('commit','-m','baseline');
 const script=path.join(root,'native.cjs');fs.writeFileSync(script,nativeScript);
 const bin=path.join(root,'bin');
 for(const parts of [['@earendil-works','pi-coding-agent','dist','cli.js'],['@openai','codex','bin','codex.js']]){
   const file=path.join(bin,'node_modules',...parts);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'// test locator');
 }
 const {server,port}=await startServer({port:0,userDataPath:path.join(root,'data'),staticDir:root,apiToken:'r4-test-token',runtimeOptions:{
   env:{PATH:bin,USERPROFILE:root},nativeRuntime:(agent,opts)=>(agent.execution.connectionKind==='native-pi'?runNativePi:runCodex)(opts,{launch:{command:process.execPath,args:[script,agent.execution.connectionKind==='native-pi'?'pi':'codex']}})
 }});
 t.after(async()=>{await server.shutdown();assert.equal(path.dirname(path.resolve(root)),fs.realpathSync.native(os.tmpdir()));assert.ok(path.basename(root).startsWith('52hz-r4-'));fs.rmSync(root,{recursive:true,force:true});});
 const request=async(url,body,method)=>{
  const response=await fetch(`http://127.0.0.1:${port}${url}`,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Workspace-Token':'r4-test-token'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
 };
 const actors=[];
 for(const kind of ['native-pi','native-codex']){
   const dir=path.join(root,kind);fs.mkdirSync(dir);
   const {connection}=server.nativeConfigService.registerConnection({kind,configDir:dir,createMember:false});
   actors.push(server.store.storage.agentDefinitions.create({name:kind,connectionId:connection.id,
     defaultMode:kind==='native-pi'?'agent':'plan',maxMode:'agent',permissions:{readFiles:true,writeFiles:kind==='native-pi',executeCommands:kind==='native-codex',delegate:false,mcp:false,knowledge:false}}));
 }
 server.store.updateChannel('general',{working_dir:project});
 const [author,reviewer]=actors;
 const input={channel:'general',workers:[{agent_id:author.id,task:'Deliver v2, with an independently reviewed acceptance test.'}],review_agent:reviewer.id,review_verification:true};
 const ack={mode:'native-managed',acknowledged:true};
 const view=id=>server.agentRunner.collaboration.view(id);
 const answerWaiting=async()=>{
   for(const row of server.store.storage.humanInteractions.list({channel:'general'}).filter(r=>r.state==='waiting')){
     const answers=Object.fromEntries(row.questions.map(q=>[q.id,[q.options[0]?.label || '确认验收目标']]));
     assert.equal((await request(`/v1/interactions/${row.id}/answer`,{attemptId:row.attemptId,expectedVersion:row.version,idempotencyKey:row.id,answers})).status,200);
   }
 };
 async function settleReview(id,grant=true){
   const until=Date.now()+60000;
   for(;;){
     await answerWaiting();
     for(const pending of [...server.agentRunner.tools.pending.values()]){
       assert.equal(server.store.data.runtime_tools.filter(tool=>tool.run_id===pending.row.run_id&&tool.tool_call_id==='verification').length,1,'approval must not restart or duplicate the command tool record');
       const lane=view(id).run.lanes[0];
       assert.notEqual(lane.review_worktree_path,lane.worktree_path);
       assert.equal(fs.existsSync(path.join(lane.review_worktree_path,'verification-result.txt')),false,'command must wait for approval');
       assert.equal((await request(`/v1/runtime/approvals/${pending.row.approval_id}`,{channel:'general',granted:grant})).status,200);
     }
     const current=view(id).run.lanes[0];
     if(server.agentRunner.active.size===0 && ['approved','changes_requested','failed'].includes(current.review_status))return current;
     if(Date.now()>until)throw Error('Native review loop did not settle: '+JSON.stringify(current));
     await new Promise(r=>setTimeout(r,15));
   }
 }
 return {root,project,git,server,request,input,ack,view,author,reviewer,settleReview};
}

test('R4 Pi author and Codex reviewer: questions, approved test, revision, re-review, stale rejection and human integration',async t=>{
 const f=await fixture(t),collaboration=f.server.agentRunner.collaboration;
 const budgets=JSON.stringify(f.server.store.storage.budgets.get());
 assert.equal((await f.request('/v1/parallel-batch/start',f.input)).status,409);
 assert.equal(f.server.store.storage.db.prepare('SELECT COUNT(*) AS n FROM parallel_batches').get().n,0);
 const started=await f.request('/v1/parallel-batch/start',{...f.input,native_budget_policy:f.ack});assert.equal(started.status,200);
 const id=started.body.run.batch.id,base=`/v1/workspaces/52hz/parallel-batches/${id}`;
 const first=await f.settleReview(id);
 assert.equal(first.review_status,'changes_requested');assert.equal(first.delivery_version,1);
 assert.equal(first.review_history[0].verification.commands[0].exitCode,0);
 assert.equal(fs.readFileSync(path.join(first.worktree_path,'result.txt'),'utf8'),'v1\n');
 assert.equal(fs.readFileSync(path.join(f.project,'result.txt'),'utf8'),'base\n');
 assert.throws(()=>collaboration.merge(id),/approve/);
 assert.equal(JSON.stringify(f.server.store.storage.budgets.get()),budgets,'native exception never changes global hard budgets');
 // Changing a hard budget invalidates this batch's authorization before the next attempt.
 f.server.store.storage.db.prepare("UPDATE budget_limits SET max_cost_per_day=51 WHERE id='global'").run();
 assert.equal(f.view(id).run.batch.native_budget_policy.valid,false);
 assert.equal((await f.request(`${base}/lanes/${first.id}/send-back`,version(first))).status,409);
 assert.equal((await f.request(`${base}/native-budget-policy`,f.ack)).status,200);
 assert.equal((await f.request(`${base}/lanes/${first.id}/send-back`,version(first))).status,200);
 assert.equal(f.view(id).run.lanes[0].reviewed_version,0);
 const second=await f.settleReview(id);assert.equal(second.review_status,'approved');assert.equal(second.delivery_version,2);
 assert.notEqual(second.commit_hash,first.commit_hash);assert.equal(second.reviewed_version,2);
 assert.equal(second.agent_id,first.agent_id);assert.ok(second.review_history.some(r=>r.delivery_version===1&&r.verdict==='changes_requested'));
 assert.equal((await f.request(`${base}/lanes/${second.id}/review/complete`,{verdict:'approved',...version(first)})).status,409);
 assert.equal((await f.request(`${base}/lanes/${second.id}/review/complete`,{verdict:'approved',...version(second)})).status,200);
 assert.equal(f.view(id).run.batch.accounting.costKnown,false);assert.equal(f.view(id).run.batch.accounting.estimatedCost,null);
 const summary=f.server.store.storage.usage.getSummaryForSession('general');
 assert.equal(summary.estimatedCost,null);assert.equal(summary.hasUnknownUsage,true);
 assert.equal((await f.request(`${base}/merge`,{expected_deliveries:[{id:first.id,commit:first.commit_hash,version:first.delivery_version}]})).status,409);
 assert.equal((await f.request(`${base}/merge`,{expected_deliveries:[{id:second.id,commit:second.commit_hash,version:second.delivery_version}]})).status,200);
 assert.equal(fs.readFileSync(path.join(f.project,'result.txt'),'utf8'),'v2\n');
 assert.equal(fs.existsSync(path.join(f.project,'verification-result.txt')),false,'review artifacts must never be merged into source');
});

test('R4 denied verification never runs or becomes approval; revision-bound authorization cannot leak to other Agents',async t=>{
 const f=await fixture(t);
 const budgets=JSON.stringify(f.server.store.storage.budgets.get());
 f.server.store.updateChannel('general',{agent_id:f.author.id,runtime_config:{inheritAgent:true,mode:'agent'}});
 const preview=await f.request('/v1/runtime/native-budget-policy?channel=general');assert.equal(preview.body.valid,false);
 assert.equal((await f.request('/v1/runtime/native-budget-policy',{channel:'general',...f.ack,expectedFingerprint:'stale'})).status,409);
 assert.equal((await f.request('/v1/runtime/native-budget-policy',{channel:'general',...f.ack,expectedFingerprint:preview.body.fingerprint})).status,200);
 f.server.agentRunner.validateNativeExecution(f.author,f.server.agentRunner.collaboration.actorConfig(f.author),{channel:'general'});
 assert.equal((await f.request('/v1/parallel-batch/start',f.input)).status,409,'session exception must never authorize a batch');
 assert.equal((await f.request('/v1/runtime/native-budget-policy?channel=general',undefined,'DELETE')).status,200);
 assert.throws(()=>f.server.agentRunner.validateNativeExecution(f.author,f.server.agentRunner.collaboration.actorConfig(f.author),{channel:'general'}));
 assert.equal(JSON.stringify(f.server.store.storage.budgets.get()),budgets);
 const policy=createNativeBudgetPolicy(f.server.store,'general',[f.author,f.reviewer],f.ack,null);
 assert.throws(()=>createNativeBudgetPolicy(f.server.store,'general',[f.author],f.ack,{runId:'agent-delegation'}));
 assert.equal(allowsNativeBudgetPolicy(f.server.store,policy,'other',f.author),false);
 assert.equal(allowsNativeBudgetPolicy(f.server.store,policy,'general',{...f.author,revision:99}),false);
 const started=await f.request('/v1/parallel-batch/start',{...f.input,native_budget_policy:f.ack});assert.equal(started.status,200);
 const id=started.body.run.batch.id,lane=await f.settleReview(id,false);
 assert.equal(lane.review_status,'failed');
 assert.equal(fs.existsSync(path.join(lane.review_worktree_path,'verification-result.txt')),false);
 assert.throws(()=>f.server.agentRunner.collaboration.merge(id),/approve/);
 assert.equal(fs.readFileSync(path.join(f.project,'result.txt'),'utf8'),'base\n');
});

test('R4 a failed verification command cannot become an approved delivery',async t=>{
 const f=await fixture(t);
 fs.writeFileSync(path.join(f.project,'verification-test.cjs'),"require('node:assert/strict').fail('Injected failed verification');");
 f.git('add','.');f.git('commit','-m','failing acceptance test');
 const started=await f.request('/v1/parallel-batch/start',{...f.input,native_budget_policy:f.ack});assert.equal(started.status,200);
 const id=started.body.run.batch.id,lane=await f.settleReview(id);
 assert.equal(lane.review_status,'failed');assert.equal(lane.review_history[0].verification.commands[0].exitCode,1);
 assert.throws(()=>f.server.agentRunner.collaboration.merge(id),/approve/);
});

test('R4 verification changes to tracked review files invalidate approval and preserve author workspace',async t=>{
 const f=await fixture(t);
 fs.writeFileSync(path.join(f.project,'verification-test.cjs'),"require('node:fs').writeFileSync('result.txt','v2\\n');");
 f.git('add','.');f.git('commit','-m','test that mutates review checkout');
 const started=await f.request('/v1/parallel-batch/start',{...f.input,native_budget_policy:f.ack});assert.equal(started.status,200);
 const id=started.body.run.batch.id,lane=await f.settleReview(id);
 assert.equal(lane.review_status,'failed');assert.match(lane.review_notes,/tracked review files changed/);
 assert.equal(fs.readFileSync(path.join(lane.worktree_path,'result.txt'),'utf8'),'v1\n');
 assert.equal(fs.readFileSync(path.join(f.project,'result.txt'),'utf8'),'base\n');
});
