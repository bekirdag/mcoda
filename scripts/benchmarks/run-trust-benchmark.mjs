import { promises as fs, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadOrchestrationConfig } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { runEvaluationProcess } from '../../packages/codali/dist/eval/EvaluationProcess.js';
import { argumentsMap, json, jsonl, hash, writeNew, readPublicCorpus, benchmarkFingerprint, hasToolBaseline } from './trust-common.mjs';

const args=argumentsMap(undefined,['config','output','split','arms','ids','limit','freeze','timeout-ms','retry-of','retry-reason','corpus-root']);
if(!args.config||!args.output)throw Error('Usage: node scripts/benchmarks/run-trust-benchmark.mjs --config FILE --output NEW_OR_RESUMED_DIRECTORY [--split development|validation|held_out|all] [--arms raw_direct,codali_initial] [--ids comma-separated] [--limit N] [--freeze FILE]');
const resolved=await loadOrchestrationConfig(path.resolve(args.config));
const {manifest:corpus,cases}=await readPublicCorpus(args['corpus-root']?path.resolve(args['corpus-root']):undefined);
const arms=(args.arms??'raw_direct,codali_initial').split(',');
if(new Set(arms).size!==arms.length||arms.some(a=>!['raw_direct','raw_tools','codali_initial','codali_selected','codali_candidate'].includes(a)))throw Error('Invalid arms');
const split=args.split??'development';if(!['development','validation','held_out','all'].includes(split))throw Error('Invalid split');
const ids=args.ids?.split(',');if(ids?.some(id=>!cases.some(c=>c.id===id)))throw Error('Unknown case ID');
let selected=cases.filter(c=>(split==='all'||c.split===split)&&(!ids||ids.includes(c.id)));
// Spread pilot admission across families, preserving the frozen case ordering inside a family.
selected.sort((a,b)=>a.variant-b.variant||a.id.localeCompare(b.id));
if(args.limit){const n=Number(args.limit);if(!Number.isSafeInteger(n)||n<1)throw Error('Invalid limit');selected=selected.slice(0,n);}
if(!selected.length)throw Error('Empty selection');
if(!!args['retry-of']!==!!args['retry-reason']||args['retry-reason']&&!args['retry-reason'].trim())throw Error('Explicit retries require both --retry-of RUN_DIR and --retry-reason TEXT');
const retryLineage=[];
let retryFingerprint;
if(args['retry-of']){
  const priorRoot=path.resolve(args['retry-of']);
  const prior=await json(path.join(priorRoot,'manifest.json'));
  retryFingerprint=hash(JSON.stringify(prior.identity.fingerprint));
  if(prior.identity.configHash!==resolved.hash||prior.identity.corpusHash!==corpus.promptsSha256)throw Error('Retry source configuration/corpus mismatch');
  const records=await jsonl(path.join(priorRoot,'ledger.jsonl'));
  for(const task of selected)for(const arm of arms){
    if(arm==='raw_tools'&&!hasToolBaseline(task))continue;
    const matches=records.filter(x=>x.type==='result'&&x.result.caseId===task.id&&x.result.arm===arm);
    if(matches.length!==1)throw Error('Retry source must have one retained outcome for every selected case/arm');
    retryLineage.push({caseId:task.id,arm,attemptId:matches[0].result.attemptId,source:priorRoot,reason:args['retry-reason']});
  }
}
const fingerprint=await benchmarkFingerprint();
if(retryFingerprint&&retryFingerprint!==hash(JSON.stringify(fingerprint)))throw Error('A retry must retain the original runtime; use a separate configuration study for code changes');
if(selected.some(c=>c.split==='held_out')){
  if(!args.freeze)throw Error('Held-out execution requires a previously frozen selection record');
  const freeze=await json(args.freeze);
  if(freeze.configHash!==resolved.hash||freeze.corpusHash!==corpus.promptsSha256||freeze.clientFingerprint!==hash(JSON.stringify(fingerprint))||!freeze.selectionEvidence||!freeze.createdAt)throw Error('Selection freeze does not match this run');
}
const root=path.resolve(args.output);await fs.mkdir(root,{recursive:true,mode:0o700});await fs.chmod(root,0o700);
const identity={schemaVersion:1,protocolVersion:'trust-opaque-paths-v2',configHash:resolved.hash,corpusHash:corpus.promptsSha256,fingerprint,arms,taskIds:selected.map(x=>x.id),split,timeoutMs:Number(args['timeout-ms']??300000)};
if(retryLineage.length)identity.retryLineage=retryLineage;
if(!Number.isSafeInteger(identity.timeoutMs)||identity.timeoutMs<1000||identity.timeoutMs>900000)throw Error('Invalid common deadline');
const manifestPath=path.join(root,'manifest.json');
try{const previous=await json(manifestPath);if(JSON.stringify(previous.identity)!==JSON.stringify(identity))throw Error('Run inputs drifted; use a separate run directory');}
catch(e){if(e.code!=='ENOENT')throw e;await writeNew(manifestPath,{identity,createdAt:new Date().toISOString(),limitations:corpus.limitations});await writeNew(path.join(root,'config.json'),resolved.config);}
// Exclusive process lock. Stale locks are not silently bypassed.
const lock=await fs.open(path.join(root,'runner.lock'),'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.sync();
const abort=new AbortController();process.once('SIGTERM',()=>abort.abort(Error('Benchmark stopped')));process.once('SIGINT',()=>abort.abort(Error('Benchmark stopped')));
const append=record=>{const fd=openSync(path.join(root,'ledger.jsonl'),'a',0o600);try{writeSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
try{
  let ledger=[];try{ledger=await jsonl(path.join(root,'ledger.jsonl'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const completed=new Set(ledger.filter(x=>x.type==='result').map(x=>x.key));
  for(const start of ledger.filter(x=>x.type==='start'&&!completed.has(x.key))){
    let result;try{result=await json(path.join(start.directory,'result.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    // Never retry an accepted inference with unknown outcome automatically.
    result??={caseId:start.caseId,arm:start.arm,attemptId:start.attemptId,error:'interrupted_unknown: inspect original request receipts before an explicit new run',content:'',elapsedMs:null,usage:{estimated:true}};
    if(start.retryOf)result={...result,retryOf:start.retryOf,retryReason:start.retryReason};
    append({type:'result',key:start.key,directory:start.directory,result,recovered:true});completed.add(start.key);
  }
  for(let index=0;index<selected.length;index++){
    const task=selected[index];const order=index%2?[...arms].reverse():arms;
    for(const arm of order){
      if(arm==='raw_tools'&&!hasToolBaseline(task))continue;
      const key=`${task.id}:${arm}`;if(completed.has(key))continue;
      abort.signal.throwIfAborted();
      if(hash(JSON.stringify(await benchmarkFingerprint()))!==hash(JSON.stringify(fingerprint)))throw Error('Runtime fingerprint changed; stopped before another model request');
      if((await loadOrchestrationConfig(args.config)).hash!==resolved.hash)throw Error('Configuration changed');
      const attemptId=randomUUID();const directory=path.join(root,'attempts',`${task.id}-${arm}-${attemptId}`);await fs.mkdir(directory,{recursive:true,mode:0o700});
      const retry=retryLineage.find(x=>x.caseId===task.id&&x.arm===arm);
      const request={schemaVersion:1,task,arm,attemptId,directory,config:path.join(root,'config.json'),timeoutMs:identity.timeoutMs,
        ...(retry?{retryOf:retry.attemptId,retryReason:retry.reason}:{})};
      const requestPath=path.join(directory,'request.json');await writeNew(requestPath,request);
      append({type:'start',key,caseId:task.id,arm,attemptId,directory,at:new Date().toISOString(),...(retry?{retryOf:retry.attemptId,retryReason:retry.reason}:{})});
      console.log(JSON.stringify({type:'start',caseId:task.id,arm,completed:completed.size}));
      let launchError;
      try{await runEvaluationProcess({file:fileURLToPath(new URL('./trust-attempt.mjs',import.meta.url)),args:['--request',requestPath],cwd:directory,config:resolved.config,timeoutMs:identity.timeoutMs+20000,signal:abort.signal});}catch(e){launchError=String(e);}
      let result;try{result=await json(path.join(directory,'result.json'));}catch(e){if(e.code!=='ENOENT')throw e;result={caseId:task.id,arm,attemptId,error:launchError??'Process ended without result',content:'',usage:{estimated:true}};}
      if(retry)result={...result,retryOf:retry.attemptId,retryReason:retry.reason};
      append({type:'result',key,directory,result,launchError,at:new Date().toISOString()});completed.add(key);
      console.log(JSON.stringify({type:'result',caseId:task.id,arm,error:result.error,elapsedMs:result.elapsedMs,usage:result.usage}));
    }
  }
  append({type:'run_complete',attempts:completed.size,at:new Date().toISOString()});
}finally{await lock.close();await fs.unlink(path.join(root,'runner.lock'));}
