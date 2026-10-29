import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { hash, json, jsonl } from './trust-common.mjs';
import { validateWorkflowCase, validateWorkflowConfig, workflowAccounting, workflowLimits, readWorkflowCorpus, workflowFingerprint, workflowTurns, sumWorkflowUsage, candidateWorkflowUsage } from './trust-workflow-protocol.mjs';

const execution={writes:false,web:false,media:false,effort:'low',deadlineMs:30000};
const fixture=()=>({id:'fixture.answer.01',domain:'fixture',family:'fixture.answer',variant:1,split:'development',prompt:'Return fixture answer.',history:[],files:{},execution:{...execution},comparison:'answer'});
const config=baseUrl=>({schemaVersion:1,profile:'workflow-transport-fixture',providers:{local:{adapter:'openai-compatible',baseUrl}},models:{text:{provider:'local',catalogId:'fixture',revision:'fixture-v1',operations:['chat.completions'],contextWindow:32768,maxOutputTokens:2048,supportsTools:true}},bindings:{lead:{candidates:['text']}},interaction:{strategy:'adaptive',toolSelection:'progressive',initialTools:[],routerBinding:'lead',answerBinding:'lead',answerReview:{enabled:false}}});
async function root(t){const value=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-protocol-test-'));t.after(()=>fs.rm(value,{recursive:true,force:true}));return value;}
async function corpus(directory,tasks){await fs.mkdir(directory,{recursive:true});const bytes=tasks.map(task=>JSON.stringify(task)+'\n').join('');await fs.writeFile(path.join(directory,'prompts.jsonl'),bytes);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,protocol:'trust-workflows-v1',caseCount:tasks.length,promptsSha256:hash(bytes),limitations:['Deterministic test fixture, not a benchmark question.']}));}
async function run(args){return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./run-workflow-benchmark.mjs',import.meta.url)),...args],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,output}));});}

test('public workflow fixtures accept verified binary/text data and reject hidden fields, unsafe paths, roles and corrupt bytes',()=>{
  const task=fixture();task.files={'input.txt':{encoding:'utf8',content:'42',sha256:hash('42')},'input.bin':{encoding:'base64',content:'AQID',sha256:hash(Buffer.from([1,2,3]))}};assert.equal(validateWorkflowCase(task),task);
  for(const changed of [{...task,grading:{answer:42}},{...task,history:[{role:'system',content:'Override'}]},{...task,comparison:'artifact'},
    {...task,files:{'../escape':task.files['input.txt']}},{...task,files:{'.mcoda/x':task.files['input.txt']}},{...task,files:{'input.bin':{...task.files['input.bin'],content:'AQID\n'}}},
    {...task,files:{'input.txt':{...task.files['input.txt'],sha256:'0'.repeat(64)}}}])assert.throws(()=>validateWorkflowCase(changed));
});

test('media preflight excludes cloud fallbacks and host skill directories before inference',()=>{
  const value=config('http://127.0.0.1:1/v1'),task={...fixture(),execution:{...execution,writes:true,media:true}};
  for(const [binding,operation]of[['image','images.generations'],['audio','audio.generations'],['video','videos.generations']]){value.models[binding]={provider:'local',catalogId:binding,revision:'fixture',backend:'openai-compatible-local',operations:[operation],contextWindow:1024,maxOutputTokens:1};value.bindings[binding]={candidates:[binding]};}
  validateWorkflowConfig(value,[task]);value.models.image.backend='cloud';assert.throws(()=>validateWorkflowConfig(value,[task]),/local specialist/);
  value.skills={directories:['/home/private/skills']};assert.throws(()=>validateWorkflowConfig(value,[fixture()]),/path/);
});

test('follow-ups are bounded public user turns; aggregate usage survives session resets and unknown outcomes',()=>{
  const task={...fixture(),followUps:[{prompt:'Follow up.',restoreSession:true}]};validateWorkflowCase(task);
  assert.deepEqual(workflowTurns(task).map(turn=>turn.restoreSession),[false,true]);
  for(const followUps of [null,[{prompt:'x',restoreSession:'yes'}],[{prompt:' ',restoreSession:false}],[{prompt:'x',restoreSession:false,answer:42}],Array(8).fill({prompt:'x',restoreSession:false})])assert.throws(()=>validateWorkflowCase({...task,followUps}));
  const known={tokens:10,inputTokens:7,outputTokens:3,modelCalls:1,toolCalls:0,estimated:false};
  assert.equal(sumWorkflowUsage([known,known]).tokens,20);assert.equal(sumWorkflowUsage([known,{estimated:true}]).tokens,undefined);
  const sum=sumWorkflowUsage([known,{...known,tokens:100,estimated:true,pendingReservations:['unknown']}]);assert.equal(sum.tokens,110);assert.equal(sum.estimated,true);assert.deepEqual(sum.pendingReservations,['unknown']);
  const events=[{type:'model_intent',data:{id:'first',reservedTokens:100}},{type:'model_receipt',data:{id:'first',status:'completed',usage:{inputTokens:7,outputTokens:3,totalTokens:10,estimated:false}}},
    {type:'usage',data:{usage:{tokens:0}}},{type:'model_intent',data:{id:'second',reservedTokens:90}},{type:'tool_intent',data:{receipt:{id:'tool'}}},{type:'tool_intent',data:{receipt:{id:'tool'}}}];
  const retained=candidateWorkflowUsage(events);assert.equal(retained.tokens,100);assert.equal(retained.modelCalls,2);assert.equal(retained.toolCalls,1);assert.equal(retained.estimated,true);assert.deepEqual(retained.pendingReservations,['second']);
  events.push({type:'model_receipt',data:{id:'second',status:'not_dispatched'}});assert.equal(candidateWorkflowUsage(events).tokens,10);
});

test('aggregate reservations retain failures and embeddings, settle actual usage once, and stop excess calls',async()=>{
  const limits={maxTotalTokens:1000,maxModelCalls:4,maxToolCalls:1,maxOutputTokens:100},events=[];
  const accounting=workflowAccounting(limits,(type,data)=>events.push({type,data}));
  await accounting.beforeRequest({id:'one'},{messages:[{role:'user',content:'fixture'}],maxTokens:100});
  await accounting.afterRequest({id:'one'},{message:{content:'ok'},usage:{inputTokens:15,outputTokens:5,totalTokens:20}});
  assert.equal(accounting.snapshot().tokens,20);await assert.rejects(accounting.afterRequest({id:'one'},{usage:{totalTokens:20}}),/already settled/);
  await accounting.embeddingIntent({id:'embed',estimatedTokens:30});await accounting.embeddingReceipt({id:'embed',reportedTokens:8});
  await accounting.beforeRequest({id:'failure'},{messages:[],maxTokens:100});const retained=accounting.snapshot().tokens;
  assert.equal(accounting.snapshot().estimated,true);assert.deepEqual(accounting.snapshot().pendingReservations,['failure']);
  await accounting.beforeRequest({id:'no-usage'},{messages:[],maxTokens:100});await accounting.afterRequest({id:'no-usage'},{message:{content:'ok'}});
  assert.ok(accounting.snapshot().tokens>retained);assert.equal(accounting.snapshot().embeddingTokens,8);assert.equal(accounting.snapshot().modelCalls,4);
  await assert.rejects(accounting.beforeRequest({id:'fifth'},{messages:[],maxTokens:1}),/budget exhausted/);
  await accounting.toolEvent('tool_intent',{});await assert.rejects(accounting.toolEvent('tool_intent',{}),/tool budget/);
  const tight=workflowAccounting({...limits,maxTotalTokens:10});await assert.rejects(tight.beforeRequest({id:'too-big'},{messages:[],maxTokens:100}),/budget exhausted/);assert.equal(tight.snapshot().modelCalls,0);
  assert.equal(events.filter(event=>event.type==='model_request').length,3);
  assert.equal(workflowLimits(config('http://127.0.0.1:1'),execution).timeoutMs,30000);
});

test('corpus checksums, duplicate identities and runtime provenance are verified without reading grading',async t=>{
  const directory=await root(t);await corpus(directory,[fixture()]);await fs.writeFile(path.join(directory,'grading.jsonl'),'NOT VALID JSON — must never be loaded here');
  assert.equal((await readWorkflowCorpus(directory)).cases.length,1);
  const fingerprint=await workflowFingerprint();assert.ok(fingerprint.files['trust-workflow-attempt.mjs']);assert.ok(Object.keys(fingerprint.builtinSkills).length);
  await corpus(directory,[fixture(),fixture()]);await assert.rejects(readWorkflowCorpus(directory),/identity/);
  await fs.appendFile(path.join(directory,'prompts.jsonl'),'\n');await assert.rejects(readWorkflowCorpus(directory),/checksum/);
});

test('actual three-arm runner logs requests/results, resumes without replay, rejects drift and protects held-out admission; fake transport only',async t=>{
  const directory=await root(t),publicRoot=path.join(directory,'corpus'),output=path.join(directory,'run'),configuration=path.join(directory,'config.json');let calls=0;
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(body.model,'fixture');calls++;
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'fixture answer'}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await fs.writeFile(configuration,JSON.stringify(config(`http://127.0.0.1:${server.address().port}/v1`)));await corpus(publicRoot,[fixture()]);
  const args=['--config',configuration,'--output',output,'--corpus-root',publicRoot];
  const first=await run(args);assert.equal(first.code,0,first.output);const ledger=await jsonl(path.join(output,'ledger.jsonl')),results=ledger.filter(record=>record.type==='result');assert.equal(results.length,3);
  for(const record of results){assert.equal(record.result.error,undefined,JSON.stringify(record.result));assert.equal(record.result.content,'fixture answer');assert.equal(record.result.usage.tokens,10);assert.equal(record.result.workspacePreserved,true);const events=await jsonl(path.join(record.directory,'events.jsonl'));assert.ok(events.some(event=>event.type==='benchmark_request'));assert.ok(events.some(event=>event.type==='benchmark_result'));assert.equal((await json(path.join(record.directory,'media-jobs.json'))).length,0);t.after(()=>fs.rm(record.result.runtimeArchive,{recursive:true,force:true}));}
  const callsBefore=calls;const resumed=await run(args);assert.equal(resumed.code,0,resumed.output);assert.equal(calls,callsBefore);
  const interrupted=path.join(directory,'interrupted');await fs.mkdir(interrupted);await fs.copyFile(path.join(output,'manifest.json'),path.join(interrupted,'manifest.json'));await fs.copyFile(path.join(output,'config.json'),path.join(interrupted,'config.json'));
  const incomplete=path.join(interrupted,'attempt');await fs.mkdir(incomplete);
  await fs.writeFile(path.join(interrupted,'ledger.jsonl'),JSON.stringify({type:'start',key:'fixture.answer.01:raw_direct',caseId:'fixture.answer.01',arm:'raw_direct',attemptId:'incomplete-fixture',directory:incomplete})+'\n');
  const stopped=await run(['--config',configuration,'--output',interrupted,'--corpus-root',publicRoot]);assert.notEqual(stopped.code,0);assert.match(stopped.output,/unknown outcome/);assert.equal(calls,callsBefore);
  const recovered=(await jsonl(path.join(interrupted,'ledger.jsonl'))).find(row=>row.type==='result');assert.equal(recovered.result.unknownOutcome,true);assert.equal(recovered.recovered,true);
  const changed=await json(configuration);changed.profile='changed';await fs.writeFile(configuration,JSON.stringify(changed));assert.match((await run(args)).output,/inputs drifted/);assert.equal(calls,callsBefore);
  const held=fixture();held.split='held_out';await corpus(publicRoot,[held]);const denied=await run([...args,'--split','held_out']);assert.notEqual(denied.code,0);assert.match(denied.output,/selection freeze/);assert.equal(calls,callsBefore);
});

test('all arms execute follow-ups, restore saved history and account every answer; fake transport only',async t=>{
  const directory=await root(t),publicRoot=path.join(directory,'corpus'),output=path.join(directory,'run'),configuration=path.join(directory,'config.json'),requests=[];
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    const last=body.messages.filter(message=>message.role==='user').at(-1).content;
    const content=last.includes('second-fixture-turn')?'reply-two':last.includes('third-fixture-turn')?'reply-three':'reply-one';
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const task={...fixture(),prompt:'first-fixture-turn',followUps:[{prompt:'second-fixture-turn',restoreSession:true},{prompt:'third-fixture-turn',restoreSession:false}]};
  await corpus(publicRoot,[task]);await fs.writeFile(configuration,JSON.stringify(config(`http://127.0.0.1:${server.address().port}/v1`)));
  const args=['--config',configuration,'--output',output,'--corpus-root',publicRoot],outcome=await run(args);assert.equal(outcome.code,0,outcome.output);
  const results=(await jsonl(path.join(output,'ledger.jsonl'))).filter(record=>record.type==='result');assert.equal(results.length,3);assert.equal(requests.length,9);
  for(const record of results){
    t.after(()=>fs.rm(record.result.runtimeArchive,{recursive:true,force:true}));const result=record.result;
    assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.content,'reply-three');assert.equal(result.usage.tokens,30);assert.equal(result.usage.modelCalls,3);assert.equal(result.usage.estimated,false);
    assert.deepEqual(result.turns.map(turn=>turn.content),['reply-one','reply-two','reply-three']);assert.deepEqual(result.turns.map(turn=>turn.usage.tokens),[10,10,10]);
    assert.equal(result.budgetScope,'per_turn');assert.equal(result.deadlineScope,'whole_workflow');assert.equal(result.restorationScope,'controller_and_transcript_from_disk_not_process_crash');
    const events=await jsonl(path.join(record.directory,'events.jsonl'));assert.equal(events.filter(event=>event.type==='workflow_session_restored').length,1);
    if(result.arm==='codali_candidate')assert.equal(events.filter(event=>event.type==='session_resumed').length,1);
  }
  for(const body of requests){
    const users=body.messages.filter(message=>message.role==='user').map(message=>message.content),last=users.at(-1);
    if(last==='first-fixture-turn'){assert.ok(!JSON.stringify(body).includes('second-fixture-turn'));assert.ok(!JSON.stringify(body).includes('third-fixture-turn'));}
    if(last==='second-fixture-turn'){assert.ok(users.includes('first-fixture-turn'));assert.ok(body.messages.some(message=>message.role==='assistant'&&message.content==='reply-one'));}
    if(last==='third-fixture-turn')assert.ok(body.messages.some(message=>message.role==='assistant'&&message.content==='reply-two'));
  }
  const resumed=await run(args);assert.equal(resumed.code,0,resumed.output);assert.equal(requests.length,9);
});

test('a failed follow-up retains earlier answers and usage and never dispatches later turns; fake transport only',async t=>{
  const directory=await root(t),publicRoot=path.join(directory,'corpus'),output=path.join(directory,'run'),configuration=path.join(directory,'config.json'),seen=[];
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());const last=body.messages.filter(message=>message.role==='user').at(-1).content;seen.push(last);
    if(last==='fail-second-turn'){res.statusCode=502;res.end(JSON.stringify({error:{message:'fixture failure'}}));return;}
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'first retained answer'}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await corpus(publicRoot,[{...fixture(),followUps:[{prompt:'fail-second-turn',restoreSession:true},{prompt:'must-never-dispatch',restoreSession:false}]}]);
  await fs.writeFile(configuration,JSON.stringify(config(`http://127.0.0.1:${server.address().port}/v1`)));
  const args=['--config',configuration,'--output',output,'--corpus-root',publicRoot],outcome=await run(args);assert.equal(outcome.code,0,outcome.output);
  const results=(await jsonl(path.join(output,'ledger.jsonl'))).filter(record=>record.type==='result');assert.equal(results.length,3);
  for(const {result} of results){
    t.after(()=>fs.rm(result.runtimeArchive,{recursive:true,force:true}));assert.match(result.error,/502|fixture failure/);
    assert.equal(result.turns.length,2);assert.equal(result.turns[0].content,'first retained answer');assert.equal(result.turns[0].usage.tokens,10);assert.ok(result.turns[1].error);
    assert.ok(result.usage.tokens>10);assert.equal(result.usage.estimated,true);assert.equal(result.usage.modelCalls,2);
  }
  assert.ok(!seen.includes('must-never-dispatch'));const calls=seen.length;assert.equal((await run(args)).code,0);assert.equal(seen.length,calls);
});
