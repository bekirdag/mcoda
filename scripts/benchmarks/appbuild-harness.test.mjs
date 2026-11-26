import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshotWorkflowWorkspace,provisionAppWorkspace} from './appbuild-workspace.mjs';
import {createWorkflowTools,runRawWorkflow,RAW_FINAL_ANSWER_NOTICE,finalAnswerReserveMs,generateWithRetry,RAW_OUTAGE_WAITS_MS} from './appbuild-tools.mjs';
import {outageWaitMs} from '../../packages/codali/dist/runtime/OutageWait.js';
import {estimateContextTokens} from '../../packages/codali/dist/runtime/ContextCompression.js';
import {createIsolatedExecutor,executorStatus} from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import {readWorkflowCorpus} from './trust-workflow-protocol.mjs';
import {connectBenchmarkDocdex} from './shared-docdex.mjs';
import {DocdexClient} from '../../packages/codali/dist/docdex/DocdexClient.js';
test('raw arm gets one tool-free final turn near the deadline',async()=>{
 const limits={maxSteps:5,maxToolCalls:5,maxOutputTokens:512,timeoutMs:1800000};
 assert.equal(finalAnswerReserveMs(1800000),180000);
 assert.equal(finalAnswerReserveMs(86400000),300000);
 const toolCall={message:{role:'assistant',content:''},toolCalls:[{id:'a',name:'read_file',args:{}}]};
 let clock=0;const requests=[];
 const result=await runRawWorkflow({messages:[{role:'user',content:'Research'}],limits,contextWindow:65536,deadlineAt:1800000,now:()=>clock,
  tools:{schemas:()=>[{name:'read_file',description:'',inputSchema:{type:'object'}}],execute:async()=>{clock=1650000;return {ok:true,output:'notes'};}},
  provider:{generate:async request=>{requests.push({tools:request.tools,last:request.messages.at(-1).content});return requests.length===1?toolCall:{message:{role:'assistant',content:'Best answer so far'}};}}});
 assert.equal(requests.length,2);
 assert.ok(requests[0].tools.length>0);
 assert.equal(requests[1].tools.length,0);
 assert.equal(requests[1].last,RAW_FINAL_ANSWER_NOTICE);
 assert.equal(result.content,'Best answer so far');
 assert.equal(result.finalizedAtDeadline,true);
});
test('raw arm without a deadline keeps its existing loop',async()=>{
 let calls=0;
 const result=await runRawWorkflow({messages:[{role:'user',content:'Q'}],limits:{maxSteps:2,maxToolCalls:1,maxOutputTokens:512},contextWindow:65536,
  tools:{schemas:()=>[],execute:async()=>assert.fail('no tools expected')},
  provider:{generate:async()=>{calls++;return {message:{role:'assistant',content:'A'}};}}});
 assert.equal(calls,1);assert.equal(result.finalizedAtDeadline,undefined);
});
test('new raw tool results retain their full tail before inference compression',async()=>{
 const output='prefix '+ 'x'.repeat(20000)+' REQUIRED TAIL';
 let calls=0;
 const result=await runRawWorkflow({messages:[{role:'user',content:'Read the source'}],limits:{maxSteps:2,maxToolCalls:1,maxOutputTokens:512},contextWindow:65536,
  tools:{schemas:()=>[],execute:async()=>({ok:true,output})},
  provider:{generate:async request=>++calls===1?{message:{role:'assistant',content:''},toolCalls:[{id:'read',name:'read_file',args:{path:'source'}}]}:
   (assert.equal(request.messages.at(-1).content,output),{message:{role:'assistant',content:'Done'}})}});
 assert.equal(result.messages.find(message=>message.role==='tool').content,output);
});
test('raw long-build compression preserves user authority, tool pairing and exact archived recovery',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-context-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const tools=await createWorkflowTools({workspace:root,execution:{effort:'low',deadlineMs:10000,writes:false,web:false,media:false},resolved:{config:{}},startDocdex:async()=>{throw Error('not needed');}});
 const messages=[{role:'system',content:'Follow the original requirements.'},{role:'user',content:'Keep every constraint in RFP.md.'}];
 const original='Important earlier source '+ 'x'.repeat(25000)+' ORIGINAL TAIL';
 for(let i=0;i<4;i++)messages.push({role:'assistant',content:'',toolCalls:[{id:'read-'+i,name:'read_file',args:{path:'RFP.md'}}]},{role:'tool',name:'read_file',toolCallId:'read-'+i,content:original});
 const answer=await runRawWorkflow({tools,messages,limits:{maxSteps:2,maxToolCalls:3,maxOutputTokens:512},contextWindow:8192,
  provider:{generate:async request=>{
   assert.ok(estimateContextTokens(request)<=8192-512-512);assert.equal(request.messages[1].content,messages[1].content);
   const abbreviated=request.messages.find(message=>message.content.includes('Full saved source:'));
   assert.ok(abbreviated);const sha256=abbreviated.content.match(/Full saved source: ([a-f0-9]{64})/)[1];
   const read=await tools.execute({id:'recover',name:'context_read',args:{sha256,offset:original.length-20,maxChars:20}});
   assert.equal(read.ok,true);assert.equal(JSON.parse(read.output).content,original.slice(-20));
   for(const message of request.messages.filter(m=>m.role==='tool'))assert.ok(request.messages.some(m=>m.toolCalls?.some(c=>c.id===message.toolCallId)));
   return {message:{role:'assistant',content:'done'}};
  }}});
 assert.equal(answer.messages[3].content,original);assert.equal(answer.content,'done');
});
test('shared Docdex binding is verified before index access', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-shared-docdex-'));
 const other=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-other-docdex-'));
 t.after(async()=>{await fs.rm(root,{recursive:true,force:true});await fs.rm(other,{recursive:true,force:true});});
 let requested, waits=0, bound=root;
 t.mock.method(DocdexClient.prototype,'initialize',async uri=>{requested=uri;return {repoId:'scoped',repoRoot:bound};});
 t.mock.method(DocdexClient.prototype,'waitForIndex',async()=>{waits++;return {ready:true};});
 const client=await connectBenchmarkDocdex({workspace:root,resolved:{config:{}}});
 assert.ok(client instanceof DocdexClient);assert.equal(new URL(requested).protocol,'file:');assert.equal(waits,1);
 bound=other;
 await assert.rejects(connectBenchmarkDocdex({workspace:root,resolved:{config:{}}}),/different repository/);
 assert.equal(waits,1);
});
test('raw tools preserve immutable RFP through file and broad shell writes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-immutable-'));try{
 await fs.writeFile(path.join(root,'RFP.md'),'original');
 const tools=await createWorkflowTools({workspace:root,execution:{effort:'low',deadlineMs:10000,writes:true,web:false,media:false},resolved:{config:{}},startDocdex:async()=>{throw Error('not needed');}});
 tools.exposed.add('write_file');tools.exposed.add('run_shell');
 const direct=await tools.execute({id:'direct',name:'write_file',args:{path:'RFP.md',content:'wrong'}});
 assert.equal(direct.ok,false);assert.match(direct.error.message,/immutable/);
 const shell=await tools.execute({id:'shell',name:'run_shell',args:{command:'node',args:['-e',"require('fs').writeFileSync('RFP.md','wrong')"],writePaths:['.']}});
 assert.equal(shell.ok,false);assert.equal(await fs.readFile(path.join(root,'RFP.md'),'utf8'),'original');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('five platform specifications and rubrics have complete stable weights',async()=>{
 const root=path.resolve('docs/benchmarks/codali-appbuild5');const {cases}=await readWorkflowCorpus(root);assert.equal(cases.length,5);
 const grading=(await fs.readFile(path.join(root,'grading.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 for(const task of cases){const g=grading.find(x=>x.id===task.id);assert.equal(g.criteria.length,60);assert.equal(g.criteria.reduce((a,c)=>a+c.weight,0),100);assert.equal(new Set(g.criteria.map(c=>c.id)).size,60);assert.equal(task.execution.deadlineMs,3600000);}
});
test('source snapshot retains code and link metadata without following dependency/host paths',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-check-'));try{
  await provisionAppWorkspace(root,{domain:'web'});await fs.writeFile(path.join(root,'main.js'),'export const value=7;');await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules','ignored'),'dependency');await fs.symlink('/etc/hostname',path.join(root,'external-link'));
  const files=await snapshotWorkflowWorkspace(root);assert.ok(files['main.js']);assert.ok(files['ENVIRONMENT.md']);assert.equal(files['external-link'],'SYMLINK:/etc/hostname');assert.ok(!files['node_modules/ignored']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('dependency-enabled shell still hides host home and environment secrets',async()=>{
 assert.equal(executorStatus().available,true);const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-isolation-'));process.env.CODALI_BENCH_SECRET='not-for-child';
 try{const r=await createIsolatedExecutor({network:true})('node',['-e',"console.log(JSON.stringify({secret:process.env.CODALI_BENCH_SECRET??null,hostHome:require('fs').existsSync('/home/wodo/.mcoda/config.json')}))"],{workspaceRoot:root,allowedWritePaths:[],shellTimeoutMs:10000,shellMaxOutputBytes:10000});assert.deepEqual(JSON.parse(r.output),{secret:null,hostHome:false});}
 finally{delete process.env.CODALI_BENCH_SECRET;await fs.rm(root,{recursive:true,force:true});}
});
test('raw loop has actual write and shell tools behind progressive discovery',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-tools-'));try{
 const t=await createWorkflowTools({workspace:root,execution:{effort:'low',deadlineMs:10000,writes:true,web:true,media:false},resolved:{config:{}},startDocdex:async()=>{throw Error('not needed');}});
 assert.ok(t.registry.list().some(x=>x.name==='write_file'));assert.ok(t.registry.list().some(x=>x.name==='run_shell'));assert.ok(t.schemas().some(x=>x.name==='tools_describe'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

import {deadlineBoundResolved} from './appbuild-tools.mjs';
test('the controller is told the attempt deadline with a hash that matches the bound config',async()=>{
  const resolved={hash:'h',config:{interaction:{timeoutMs:86400000,maxModelCalls:9},bindings:{}}};
  const bound=deadlineBoundResolved(resolved,1800000,config=>'hash:'+config.interaction.timeoutMs);
  assert.equal(bound.config.interaction.timeoutMs,1800000); assert.equal(bound.config.interaction.maxModelCalls,9); assert.equal(bound.hash,'hash:1800000');
  assert.equal(resolved.config.interaction.timeoutMs,86400000); assert.equal(resolved.hash,'h');
  assert.equal(deadlineBoundResolved(resolved,172800000),resolved);
  // The controller pins the config it receives; a stale hash fails every attempt at start.
  const {pinOrchestrationConfig,orchestrationHash,validateOrchestrationConfig}=await import('../../packages/codali/dist/config/OrchestrationConfig.js');
  const {readFileSync}=await import('node:fs');
  const real=validateOrchestrationConfig(JSON.parse(readFileSync(new URL('../../packages/codali/config/raijin-suku.example.json',import.meta.url),'utf8')));
  const pinned=pinOrchestrationConfig(deadlineBoundResolved({config:real,hash:orchestrationHash(real),source:'test'},1234567));
  assert.equal(pinned.config.interaction.timeoutMs,1234567);
});

test('raw arm retries a malformed model reply with the same request, at most twice', async () => {
 const fail=code=>Object.assign(Error(code),{code});const seen=[];const retries=[];
 let n=0;const provider={generate:async request=>{seen.push(request);if(n++<2)throw fail('invalid_response');return {message:{role:'assistant',content:'ok'}};}};
 const request={messages:[{role:'user',content:'Q'}]};
 const response=await generateWithRetry(provider,request,{wait:async()=>{},onRetry:r=>retries.push(r)});
 assert.equal(response.message.content,'ok');assert.equal(seen.length,3);
 assert.ok(seen.every(r=>r.messages===request.messages&&Object.keys(r).every(key=>['signal','stream','onProgress'].includes(key)||r[key]===request[key])),'retry must not add guidance (transport fields only: signal, streaming, progress)');assert.deepEqual(retries.map(r=>r.attempt),[1,2]);
 let m=0;await assert.rejects(generateWithRetry({generate:async()=>{m++;throw fail('invalid_response');}},request,{wait:async()=>{}}),/invalid_response/);assert.equal(m,3);
 let k=0;await assert.rejects(generateWithRetry({generate:async()=>{k++;throw fail('invalid_request');}},request,{wait:async()=>{}}),/invalid_request/);assert.equal(k,1);
});

test('raw arm waits out a temporary outage on the schedule Codali uses', async () => {
 const fail=code=>Object.assign(Error(code),{code});const waits=[];const request={messages:[{role:'user',content:'Q'}]};
 let n=0;const provider={generate:async()=>{if(n++<6)throw fail('service_unavailable');return {message:{role:'assistant',content:'ok'}};}};
 const response=await generateWithRetry(provider,request,{wait:async ms=>{waits.push(ms);}});
 assert.equal(response.message.content,'ok');assert.deepEqual(waits,RAW_OUTAGE_WAITS_MS.slice(0,6));
 let m=0;await assert.rejects(generateWithRetry({generate:async()=>{m++;throw fail('service_unavailable');}},request,{wait:async()=>{}}),/service_unavailable/);
 let expected=1;while(outageWaitMs(expected-1)!==undefined)expected++;assert.equal(m,expected);assert.ok(m>RAW_OUTAGE_WAITS_MS.length+1,'a long outage is waited out past the ladder');
 // A native-reasoning preflight wraps the service error as its cause (cycle 3: a raw build ended on one 502).
 let p=0;const wrapped=Object.assign(Error('Native reasoning preflight failed before inference: Model service HTTP 502'),{cause:fail('service_unavailable')});
 const ok=await generateWithRetry({generate:async()=>{if(p++<3)throw wrapped;return {message:{role:'assistant',content:'ok'}};}},request,{wait:async()=>{}});
 assert.equal(ok.message.content,'ok');
 // Near the deadline the wait is bounded by half the time left.
 let d=0;await assert.rejects(generateWithRetry({generate:async()=>{d++;throw fail('service_unavailable');}},request,{wait:async()=>{},deadlineAt:1_000_000+5000,now:()=>1_000_000}),/service_unavailable/);assert.equal(d,3,"retries fit in half the time left: 500 + 2000 ms");
});

test('raw arm waits out a lost connection and a vanished model route, as Codali does', async () => {
 const request={messages:[{role:'user',content:'Q'}]};
 for(const failure of [()=>new TypeError('fetch failed'),()=>Object.assign(Error('Model service HTTP 404: model_unavailable'),{code:'model_unavailable'})]){
  const waits=[];let n=0;
  const provider={generate:async()=>{if(n++<4)throw failure();return {message:{role:'assistant',content:'ok'}};}};
  const response=await generateWithRetry(provider,request,{wait:async ms=>{waits.push(ms);}});
  assert.equal(response.message.content,'ok');assert.deepEqual(waits,RAW_OUTAGE_WAITS_MS.slice(0,4));
 }
 // Other transport-level TypeErrors and refusals are not retried.
 let k=0;await assert.rejects(generateWithRetry({generate:async()=>{k++;throw new TypeError('Invalid URL');}},request,{wait:async()=>{}}),/Invalid URL/);assert.equal(k,1);
});

test('raw arm abandons a request that never returns and sends it again', async () => {
 const request={messages:[{role:'user',content:'Q'}]};const retries=[];let n=0;let abandoned=false;
 const provider={generate:async r=>{if(n++===0)return new Promise((_,reject)=>r.signal.addEventListener('abort',()=>{abandoned=true;reject(new Error('aborted'));},{once:true}));return {message:{role:'assistant',content:'ok'}};}};
 const response=await generateWithRetry(provider,request,{wait:async()=>{},onRetry:r=>retries.push(r),stallMs:30});
 assert.equal(response.message.content,'ok');assert.equal(n,2);assert.ok(abandoned);
 assert.deepEqual(retries.map(r=>[r.code,r.stalledAfterMs]),[['service_unavailable',30]]);
});

test('raw shell deletes a file inside its writePaths, as Codali does, and nothing outside them',{skip:!executorStatus().available},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-delete-'));try{
 await fs.mkdir(path.join(root,'spec'));await fs.writeFile(path.join(root,'spec','stub_spec.rb'),'# placeholder');await fs.writeFile(path.join(root,'spec','order_spec.rb'),'# keep');await fs.writeFile(path.join(root,'Gemfile'),'source');
 const tools=await createWorkflowTools({workspace:root,execution:{effort:'low',deadlineMs:10000,writes:true,web:false,media:false},resolved:{config:{}},startDocdex:async()=>{throw Error('not needed');}});
 tools.exposed.add('run_shell');
 const removed=await tools.execute({id:'rm',name:'run_shell',args:{command:'rm',args:['spec/stub_spec.rb'],writePaths:['spec']}});
 assert.equal(removed.ok,true,removed.error?.message);assert.equal(await fs.stat(path.join(root,'spec','stub_spec.rb')).catch(()=>null),null);
 const outside=await tools.execute({id:'rm-out',name:'run_shell',args:{command:'sh',args:['-c','rm Gemfile'],writePaths:['spec']}});
 assert.equal(outside.ok,false);assert.doesNotMatch(outside.error.message,/Destructive operation blocked/);assert.equal(await fs.readFile(path.join(root,'Gemfile'),'utf8'),'source');
 assert.equal(await fs.readFile(path.join(root,'spec','order_spec.rb'),'utf8'),'# keep');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('raw arm gives up a request still running when its final-answer reserve starts',async()=>{
 const timeoutMs=10_000,deadlineAt=Date.now()+timeoutMs,reserve=finalAnswerReserveMs(timeoutMs);
 const limits={maxSteps:6,maxToolCalls:5,maxOutputTokens:512,timeoutMs};
 const requests=[],cutoffs=[];let cutSignal=false;
 const provider={generate:async request=>{
  requests.push({tools:request.tools.length,last:request.messages.at(-1).content,leftMs:deadlineAt-Date.now()});
  if(requests.length===1)return {message:{role:'assistant',content:''},toolCalls:[{id:'a',name:'read_file',args:{path:'ledger.csv'}}]};
  // The second request never returns on its own; before this fix it held the turn until the deadline.
  if(requests.length===2)return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>{cutSignal=true;reject(new Error('aborted'));},{once:true}));
  return {message:{role:'assistant',content:'Totals from the ledger read so far.'}};
 }};
 const result=await runRawWorkflow({messages:[{role:'user',content:'Reconcile the ledger'}],limits,contextWindow:65536,deadlineAt,signal:AbortSignal.timeout(timeoutMs),onCutoff:cut=>cutoffs.push(cut),
  tools:{schemas:()=>[{name:'read_file',description:'',inputSchema:{type:'object'}}],execute:async()=>({ok:true,output:'date,amount'})},provider});
 assert.equal(result.content,'Totals from the ledger read so far.');assert.equal(result.finalizedAtDeadline,true);
 assert.ok(cutSignal,'the overrunning request was told to stop');assert.equal(cutoffs.length,1);
 assert.equal(requests.length,3);assert.equal(requests[2].tools,0);assert.equal(requests[2].last,RAW_FINAL_ANSWER_NOTICE);
 assert.ok(requests[2].leftMs>=reserve*0.5,`final turn started with ${requests[2].leftMs} ms of a ${reserve} ms reserve`);
});

test('raw arm does not start a retry inside its final-answer reserve',async()=>{
 const fail=code=>Object.assign(Error(code),{code});let clock=0,calls=0;
 await assert.rejects(generateWithRetry({generate:async()=>{calls++;throw fail('service_unavailable');}},{messages:[{role:'user',content:'Q'}]},
  {wait:async ms=>{clock+=ms;},now:()=>clock,deadlineAt:600_000,cutoffAt:1_000}),error=>error.code==='final_answer_reserve'&&error.cutoff===true);
 assert.equal(calls,2,'the 500 ms wait fits before the reserve, the 2 s one does not');
});

test('raw research session can always reach a page reader without guessing a discovery query',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'appbuild-research-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const research={effort:'low',deadlineMs:10000,writes:false,web:true,media:false};
 const initialTools=['read_file','calculate','docdex_search','docdex_open','calendar_calculate','transform_text'];
 const tools=await createWorkflowTools({workspace:root,execution:research,resolved:{config:{}},initialTools,startDocdex:async()=>{throw Error('not needed');}});
 // A scripted raw model asks a discovery query that does not rank the browser, then opens a page.
 const requests=[],receipts=[];
 const execute=async(call,signal)=>{const receipt=await tools.execute(call,signal);receipts.push(receipt);return receipt;};
 await runRawWorkflow({messages:[{role:'user',content:'Which harbour pilots changed their tide-window rules this spring?'}],limits:{maxSteps:4,maxToolCalls:4,maxOutputTokens:512},contextWindow:65536,tools:{...tools,execute},
  provider:{generate:async request=>{requests.push(request.tools.map(tool=>tool.name));
   if(requests.length===1)return {message:{role:'assistant',content:''},toolCalls:[{id:'q',name:'tools_describe',args:{query:'harbour pilot tide window regulations'}}]};
   if(requests.length===2)return {message:{role:'assistant',content:''},toolCalls:[{id:'o',name:'browser_open',args:{url:'not a url'}}]};
   return {message:{role:'assistant',content:'done'}};}}});
 for(const name of ['docdex_web_research','browser_open','browser_read'])assert.ok(requests[0].includes(name),name);
 // The page reader is callable: it judges the URL, it does not refuse an unadvertised tool.
 const opened=receipts.at(-1);
 assert.equal(opened.ok,false);assert.doesNotMatch(opened.error.message,/Unadvertised/);assert.match(opened.error.message,/http or https URL/);
 // No web permission: no web tools at all.
 const offline=await createWorkflowTools({workspace:root,execution:{...research,web:false},resolved:{config:{}},initialTools,startDocdex:async()=>{throw Error('not needed');}});
 assert.ok(!offline.schemas().some(tool=>['docdex_web_research','browser_open','browser_read'].includes(tool.name)));
 // A writing session discovers web tools; loading search brings the page reader with it, as in the candidate.
 const build=await createWorkflowTools({workspace:root,execution:{...research,writes:true},resolved:{config:{}},startDocdex:async()=>{throw Error('not needed');}});
 assert.ok(!build.schemas().some(tool=>tool.name==='browser_open'));
 assert.equal((await build.execute({id:'d',name:'tools_describe',args:{names:['docdex_web_research']}})).ok,true);
 assert.ok(build.schemas().some(tool=>tool.name==='browser_open'));assert.ok(build.schemas().some(tool=>tool.name==='browser_read'));
 // A guessed alias names the usable tools instead of a bare refusal.
 const guessed=await tools.execute({id:'g',name:'tools_describe',args:{names:['web_search','browser_open']}});
 assert.equal(guessed.ok,false);assert.match(guessed.error.message,/Available names from this request: \["browser_open"\]/);
});

test('raw arm, like Codali, never cuts a request that is still streaming output',async()=>{
 let calls=0,streamed;
 const provider={generate:async r=>{calls++;streamed=r.stream;for(let i=0;i<10;i++){await new Promise(resolve=>setTimeout(resolve,40));if(r.signal.aborted)throw new Error('aborted');r.onProgress?.();}return {message:{role:'assistant',content:'long report'}};}};
 const response=await generateWithRetry(provider,{messages:[{role:'user',content:'Write the report'}]},{wait:async()=>{},stallMs:120});
 assert.equal(response.message.content,'long report');assert.equal(calls,1);assert.equal(streamed,true);
});
