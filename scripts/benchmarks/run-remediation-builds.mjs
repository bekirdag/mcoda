// Developer integration diagnostics; these are not held-out intelligence scores.
import { promises as fs, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SessionController } from '../../packages/codali/dist/runtime/SessionController.js';
import { loadOrchestrationConfig, orchestrationHash } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { createIsolatedExecutor } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('New absolute output directory required');
const {config: original} = await loadOrchestrationConfig(process.argv[3]);
const config = structuredClone(original);
config.profile='remediation-build-v2';
config.taskControl={maxWritingTasksPerWorktree:1,maxConcurrentHelpers:1,helpers:'read-only-or-draft',repeatedFailureThreshold:3,repairAttemptsBeforeReplan:2,checkpointOn:['task-transition','before-compaction','before-exit'],reviewPolicy:'risk-and-evidence',initialTools:['read_file','write_file','prepare_edit','run_shell','list_files','docdex_search','docdex_open','work_claim','work_rescope','work_plan','work_verify','work_complete','skill_load']};
config.models['diagnostic-balanced']={provider:'mswarm',catalogId:'qwen-latest-flash-next',revision:'catalog-unversioned',operations:['chat.completions'],backend:'strata',contextWindow:65536,maxOutputTokens:4096,supportsTools:true,supportsStreaming:false};
config.bindings.lead={candidates:['diagnostic-balanced']};
config.effort={medium:{maxTotalTokens:300000,maxModelCalls:100,maxToolCalls:160,maxSteps:120,maxOutputTokens:4096,timeoutMs:900000}};
const resolved={config,hash:orchestrationHash(config),source:'developer integration diagnostic'};
const cases=[{
 id:'booking-library',rfp:`Build a Node ES-module booking library in index.mjs, exporting createScheduler(). No dependencies. Its object has reserve(resource,start,end,id), cancel(id), list(resource).
resource and id are nonempty strings; start/end are safe integer times with start < end. Invalid inputs throw. Reservations on one resource must not overlap (half-open [start,end)); adjacent and different-resource reservations are allowed. reserve returns {resource,start,end,id}. Exact retry of the same id returns the existing reservation; conflicting reuse throws. Failed mutations leave all state unchanged. cancel returns true once, false thereafter; cancellation releases the slot. list returns sorted by start then id, with fresh objects that cannot mutate internal state. Supply meaningful node:test tests, package.json with npm test and README usage. Complete and test the implementation. Do not modify this RFP.`,
 grade:`const s=m.createScheduler();
const a=s.reserve('room',10,20,'a');assert.deepEqual(a,{resource:'room',start:10,end:20,id:'a'});
assert.deepEqual(s.reserve('room',10,20,'a'),a);
assert.throws(()=>s.reserve('room',12,18,'b'));assert.throws(()=>s.reserve('room',20,21,'a'));
assert.equal(s.list('room').length,1);s.reserve('room',20,30,'b');s.reserve('other',15,25,'c');
for(const args of [['room',4,4,'x'],['room',NaN,4,'x'],['room',1,2.5,'x'],['',1,2,'x'],['room',1,2,'']])assert.throws(()=>s.reserve(...args));
const list=s.list('room');try{list[0].end=999;}catch(e){assert.ok(e instanceof TypeError);}list.push({id:'bad'});try{a.start=-1;}catch(e){assert.ok(e instanceof TypeError);}assert.equal(s.list('room')[0].start,10);assert.equal(s.list('room')[0].end,20);
assert.equal(s.cancel('a'),true);assert.equal(s.cancel('a'),false);s.reserve('room',10,20,'d');assert.deepEqual(s.list('room').map(x=>x.id),['d','b']);`
},{
 id:'money-ledger',rfp:`Build a Node ES-module ledger library in index.mjs exporting createLedger(initialBalances). No dependencies. Balances and amounts are arbitrary precision integer cent strings; never convert to Number. initialBalances is an object of account names to nonnegative cent strings. Ledger exposes transfer(id,from,to,amount), balance(account), entries(). transfer returns {id,from,to,amount}; amount must be positive canonical integer string, both accounts must exist and differ, sufficient funds required. Exact retries by id have no second effect; changed payload under same id throws. Failed transfers change no balances/history. balance returns cent string, unknown accounts throw. entries returns defensive copies in commit order. Include node:test tests, npm test, README. Do not modify RFP.`,
 grade:`const l=m.createLedger({a:'9007199254740993',b:'0'});assert.equal(l.balance('a'),'9007199254740993');
l.transfer('t','a','b','8');assert.equal(l.balance('a'),'9007199254740985');assert.equal(l.balance('b'),'8');
l.transfer('t','a','b','8');assert.equal(l.balance('b'),'8');assert.throws(()=>l.transfer('t','a','b','9'));
for(const args of [['x','a','missing','2'],['x','a','a','2'],['x','a','b','-1'],['x','a','b','0'],['x','a','b','1.5'],['x','a','b','01'],['x','b','a','9']])assert.throws(()=>l.transfer(...args));
assert.equal(l.entries().length,1);assert.equal(l.balance('b'),'8');const e=l.entries();e[0].amount='999';e.push({});assert.equal(l.entries().length,1);assert.equal(l.entries()[0].amount,'8');assert.throws(()=>l.balance('missing'));`
},{
 id:'bounded-cache',rfp:`Build an ES-module cache library index.mjs exporting createCache(capacity,clock). capacity must be positive safe integer; clock is injected and returns integer milliseconds. No dependencies. Expose set(key,value,ttlMs), get(key), has(key), keys(). Keys are nonempty strings, ttlMs positive safe integer; invalid set throws before altering state. An entry expires when clock() >= insertionTime+ttlMs. get returns undefined if absent/expired and promotes live entries to most recent; has does not promote. set inserts/updates as most recent; when full, purge expired entries first then evict least recently used. keys returns live keys oldest to newest without promotion. Store values including false and zero correctly. Include node:test tests with fake clock, npm test, README. Do not alter RFP.`,
 grade:`let now=10;const c=m.createCache(2,()=>now);c.set('a',0,5);c.set('b',false,30);assert.equal(c.get('a'),0);assert.deepEqual(c.keys(),['b','a']);assert.equal(c.has('b'),true);assert.deepEqual(c.keys(),['b','a']);
c.set('c',3,30);assert.equal(c.has('b'),false);assert.deepEqual(c.keys(),['a','c']);now=15;assert.equal(c.get('a'),undefined);assert.deepEqual(c.keys(),['c']);
c.set('d',4,30);assert.throws(()=>c.set('e',5,0));assert.deepEqual(c.keys(),['c','d']);c.set('c',8,40);assert.deepEqual(c.keys(),['d','c']);assert.equal(c.get('c'),8);assert.throws(()=>m.createCache(0,()=>now));`
}];
await fs.mkdir(output,{mode:0o700});
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({kind:'developer-integration-not-intelligence-comparison',configHash:resolved.hash,cases:cases.map(({grade,...c})=>({...c,gradeSha256:createHash('sha256').update(grade).digest('hex')}))},null,2));
const results=[];
const runtime=await fs.readFile(new URL('../../packages/codali/dist/runtime/SessionController.js',import.meta.url));await fs.writeFile(path.join(output,'runtime-sha256.txt'),createHash('sha256').update(runtime).digest('hex')+'\n');
for(const item of cases){
 const dir=path.join(output,item.id),workspace=path.join(dir,'workspace');await fs.mkdir(workspace,{recursive:true,mode:0o700});
 await fs.writeFile(path.join(workspace,'RFP.md'),item.rfp,{flag:'wx'});
 const controller=new SessionController({workspaceRoot:workspace,storageRoot:path.join(dir,'state'),resolved,effort:'medium',permissions:'workspace',allowNetwork:false,allowWeb:false,allowMemory:false,userInstructionsPath:false,onEvent:e=>{if(e.type!=='token')appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify(e)+'\n');}});
 const started=Date.now();let answer,error,gradeError,testError,gradePassed=false,testsPassed=false;
 try{answer=await controller.run('Implement and test the complete requirements in RFP.md. Read it first and preserve it. Deliver the runnable library, real tests and usage documentation.');}catch(e){error=String(e);}
 // Independent checks are mounted read-only only after the candidate has stopped.
 const grader=await fs.mkdtemp(path.join(os.tmpdir(),'codali-independent-'));
 const source=`import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.cwd()+'/index.mjs'));\n${item.grade}\nconsole.log('Independent behavior checks passed');`;
 await fs.writeFile(path.join(grader,'grade.mjs'),source);await fs.writeFile(path.join(dir,'grade.mjs'),source);
 const exec=createIsolatedExecutor({readOnlyRuntimeRoots:[grader]});const context={workspaceRoot:workspace,allowedWritePaths:[],shellTimeoutMs:30000};
 try{const r=await exec('node',[path.join(grader,'grade.mjs')],context);gradePassed=true;await fs.writeFile(path.join(dir,'grade.log'),r.output);}catch(e){gradeError=String(e);await fs.writeFile(path.join(dir,'grade.log'),gradeError);}
 try{const r=await exec('npm',['test'],context);testsPassed=true;await fs.writeFile(path.join(dir,'tests.log'),r.output);}catch(e){testError=String(e);await fs.writeFile(path.join(dir,'tests.log'),testError);}
 await fs.rm(grader,{recursive:true,force:true});
 const result={id:item.id,answer,error,gradePassed,gradeError,testsPassed,testError,rfpPreserved:await fs.readFile(path.join(workspace,'RFP.md'),'utf8')===item.rfp,usage:controller.usageSnapshot(),elapsedMs:Date.now()-started,sessionId:controller.sessionId};results.push(result);await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(results,null,2));
