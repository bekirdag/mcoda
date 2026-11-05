import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshotWorkflowWorkspace,provisionAppWorkspace} from './appbuild-workspace.mjs';
import {createWorkflowTools,runRawWorkflow} from './appbuild-tools.mjs';
import {estimateContextTokens} from '../../packages/codali/dist/runtime/ContextCompression.js';
import {createIsolatedExecutor,executorStatus} from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import {readWorkflowCorpus} from './trust-workflow-protocol.mjs';
import {connectBenchmarkDocdex} from './shared-docdex.mjs';
import {DocdexClient} from '../../packages/codali/dist/docdex/DocdexClient.js';
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
