import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshotWorkflowWorkspace,provisionAppWorkspace} from './appbuild-workspace.mjs';
import {createWorkflowTools,runRawWorkflow,RAW_FINAL_ANSWER_NOTICE,finalAnswerReserveMs,generateWithRetry,RAW_OUTAGE_WAITS_MS} from './appbuild-tools.mjs';
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
 assert.ok(seen.every(r=>r===request),'retry must not add guidance');assert.deepEqual(retries.map(r=>r.attempt),[1,2]);
 let m=0;await assert.rejects(generateWithRetry({generate:async()=>{m++;throw fail('invalid_response');}},request,{wait:async()=>{}}),/invalid_response/);assert.equal(m,3);
 let k=0;await assert.rejects(generateWithRetry({generate:async()=>{k++;throw fail('invalid_request');}},request,{wait:async()=>{}}),/invalid_request/);assert.equal(k,1);
});

test('raw arm waits out a temporary outage on the schedule Codali uses', async () => {
 const fail=code=>Object.assign(Error(code),{code});const waits=[];const request={messages:[{role:'user',content:'Q'}]};
 let n=0;const provider={generate:async()=>{if(n++<6)throw fail('service_unavailable');return {message:{role:'assistant',content:'ok'}};}};
 const response=await generateWithRetry(provider,request,{wait:async ms=>{waits.push(ms);}});
 assert.equal(response.message.content,'ok');assert.deepEqual(waits,RAW_OUTAGE_WAITS_MS.slice(0,6));
 let m=0;await assert.rejects(generateWithRetry({generate:async()=>{m++;throw fail('service_unavailable');}},request,{wait:async()=>{}}),/service_unavailable/);
 assert.equal(m,RAW_OUTAGE_WAITS_MS.length+1);
});
