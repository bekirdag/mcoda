import { promises as fs, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadOrchestrationConfig } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { runEvaluationProcess } from '../../packages/codali/dist/eval/EvaluationProcess.js';
import { argumentsMap, json, jsonl, hash, writeNew } from './trust-common.mjs';
import { readWorkflowCorpus, workflowFingerprint, validateWorkflowConfig } from './trust-workflow-protocol.mjs';

const args=argumentsMap(undefined,['config','output','corpus-root','split','arms','ids','limit','freeze']);
if(!args.config||!args.output||!args['corpus-root'])throw Error('Usage: node scripts/benchmarks/run-workflow-benchmark.mjs --config FILE --output DIRECTORY --corpus-root DIRECTORY [--split development|validation|held_out|all] [--freeze FILE]');
const resolved=await loadOrchestrationConfig(path.resolve(args.config));
const corpusRoot=path.resolve(args['corpus-root']),{manifest:corpus,cases}=await readWorkflowCorpus(corpusRoot);
const arms=(args.arms??'raw_direct,raw_tools,codali_candidate').split(',');
if(!arms.length||new Set(arms).size!==arms.length||arms.some(arm=>!['raw_direct','raw_tools','codali_candidate'].includes(arm)))throw Error('Invalid workflow arms');
const split=args.split??'development';if(!['development','validation','held_out','all'].includes(split))throw Error('Invalid split');
const ids=args.ids?.split(',');if(ids?.some(id=>!cases.some(task=>task.id===id)))throw Error('Unknown case ID');
let selected=cases.filter(task=>(split==='all'||task.split===split)&&(!ids||ids.includes(task.id))).sort((a,b)=>a.variant-b.variant||a.id.localeCompare(b.id));
if(args.limit){const limit=Number(args.limit);if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid limit');selected=selected.slice(0,limit);}
if(!selected.length)throw Error('Empty selection');validateWorkflowConfig(resolved.config,selected);
const fingerprint=await workflowFingerprint();
let freeze;
if(args.freeze)freeze=await json(args.freeze);
if(selected.some(task=>task.split!=='development')){
  if(!freeze||freeze.protocol!=='trust-workflows-v1'||freeze.configHash!==resolved.hash||freeze.corpusHash!==corpus.promptsSha256
    ||!/^[a-f0-9]{64}$/.test(corpus.gradingSha256??'')||freeze.gradingHash!==corpus.gradingSha256
    ||freeze.clientFingerprint!==hash(JSON.stringify(fingerprint))||!freeze.selectionEvidence||!Number.isFinite(Date.parse(freeze.createdAt))||Date.parse(freeze.createdAt)>Date.now())throw Error('Prospective validation/held-out execution requires a matching prior selection freeze');
}
const root=path.resolve(args.output);await fs.mkdir(root,{recursive:true,mode:0o700});await fs.chmod(root,0o700);
const identity={schemaVersion:1,protocolVersion:'trust-workflows-v1',configHash:resolved.hash,corpusHash:corpus.promptsSha256,gradingHash:corpus.gradingSha256??null,fingerprint,arms,taskIds:selected.map(task=>task.id),split,freezeHash:freeze?hash(JSON.stringify(freeze)):null};
try{const previous=await json(path.join(root,'manifest.json'));if(JSON.stringify(previous.identity)!==JSON.stringify(identity))throw Error('Workflow inputs drifted; use a separate study');}
catch(error){if(error.code!=='ENOENT')throw error;await writeNew(path.join(root,'manifest.json'),{identity,createdAt:new Date().toISOString(),limitations:[...corpus.limitations,'Raw-direct artifact/implementation results measure a capability gap, not an intelligence gain.','Generated media quality requires semantic review in addition to verified local provenance and technical decoding.','Live web results and shared-host timing can vary between sequential arms.']});await writeNew(path.join(root,'config.json'),resolved.config);}
const lock=await fs.open(path.join(root,'runner.lock'),'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.sync();
const abort=new AbortController();process.once('SIGTERM',()=>abort.abort(Error('Workflow benchmark stopped')));process.once('SIGINT',()=>abort.abort(Error('Workflow benchmark stopped')));
const append=record=>{const fd=openSync(path.join(root,'ledger.jsonl'),'a',0o600);try{writeSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
try{
  let ledger=[];try{ledger=await jsonl(path.join(root,'ledger.jsonl'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const completed=new Map(ledger.filter(record=>record.type==='result').map(record=>[record.key,record]));
  for(const start of ledger.filter(record=>record.type==='start'&&!completed.has(record.key))){
    let result;try{result=await json(path.join(start.directory,'result.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    let location;try{location=await json(path.join(start.directory,'runtime-location.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    result??={caseId:start.caseId,arm:start.arm,attemptId:start.attemptId,error:'interrupted_unknown: retain and inspect original model/media receipts; no automatic retry',content:'',usage:{estimated:true},runtimeArchive:location?.opaqueRoot,unknownOutcome:true};
    const record={type:'result',key:start.key,directory:start.directory,result,recovered:true};append(record);completed.set(start.key,record);
  }
  // A live/uncertain render must not contend with a subsequent timed attempt.
  // A completed late render does not retroactively replace its original failure.
  const checkOutstanding=async()=>{
    for(const record of completed.values()){
      if(record.result.unknownOutcome)throw Error('An interrupted workflow has an unknown outcome; inspect its retained receipts before a new study');
      if(!record.result.pendingMediaJobs?.length)continue;
      const runtime=record.result.runtimeArchive;
      for(const job of record.result.pendingMediaJobs){
        const mediaRoot=record.result.arm==='codali_candidate'?path.join(runtime,'state/sessions',job.sessionId??record.result.sessionId,'media'):path.join(runtime,'state/media');
        const current=await json(path.join(mediaRoot,job.id,'job.json'));
        if(!['succeeded','failed','cancelled'].includes(current.status))throw Error('A retained media job is still active or uncertain; do not start competing inference');
      }
    }
  };
  for(let index=0;index<selected.length;index++){
    const task=selected[index];
    // Rotating orders, followed by reversals, distribute first/last positions.
    const offset=index%arms.length,rotated=[...arms.slice(offset),...arms.slice(0,offset)];
    const order=Math.floor(index/arms.length)%2?rotated.reverse():rotated;
    for(const arm of order){
      const key=`${task.id}:${arm}`;if(completed.has(key))continue;
      abort.signal.throwIfAborted();await checkOutstanding();
      const currentCorpus=(await readWorkflowCorpus(corpusRoot)).manifest;
      if(hash(JSON.stringify(await workflowFingerprint()))!==hash(JSON.stringify(fingerprint))||(await loadOrchestrationConfig(args.config)).hash!==resolved.hash||currentCorpus.promptsSha256!==corpus.promptsSha256||currentCorpus.gradingSha256!==corpus.gradingSha256)throw Error('Frozen workflow inputs changed before another request');
      const attemptId=randomUUID(),directory=path.join(root,'attempts',`${task.id}-${arm}-${attemptId}`);await fs.mkdir(directory,{recursive:true,mode:0o700});
      const requestPath=path.join(directory,'request.json');await writeNew(requestPath,{schemaVersion:1,task,arm,attemptId,directory,config:path.join(root,'config.json')});
      append({type:'start',key,caseId:task.id,arm,attemptId,directory,at:new Date().toISOString()});console.log(JSON.stringify({type:'start',caseId:task.id,arm,completed:completed.size}));
      let launchError;try{await runEvaluationProcess({file:fileURLToPath(new URL('./trust-workflow-attempt.mjs',import.meta.url)),args:['--request',requestPath],cwd:directory,config:resolved.config,timeoutMs:task.execution.deadlineMs+20000,signal:abort.signal});}catch(error){launchError=String(error);}
      let result;try{result=await json(path.join(directory,'result.json'));}catch(error){if(error.code!=='ENOENT')throw error;result={caseId:task.id,arm,attemptId,error:launchError??'Workflow process ended without result',content:'',usage:{estimated:true},unknownOutcome:true};}
      const record={type:'result',key,directory,result,launchError,at:new Date().toISOString()};append(record);completed.set(key,record);console.log(JSON.stringify({type:'result',caseId:task.id,arm,error:result.error,elapsedMs:result.elapsedMs,usage:result.usage,pendingMediaJobs:result.pendingMediaJobs}));
    }
  }
  await checkOutstanding();append({type:'run_complete',attempts:completed.size,at:new Date().toISOString()});
}finally{await lock.close();await fs.unlink(path.join(root,'runner.lock'));}
