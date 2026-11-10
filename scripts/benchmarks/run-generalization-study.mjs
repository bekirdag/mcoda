// Prospective three-arm study. Configuration and grading remain host-only.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateRuntime } from './generalization-freeze.mjs';
import { validateWorkflowCase } from './trust-workflow-protocol.mjs';
import { probeModelDispatch, waitForModelRoute } from './model-route-wait.mjs';
import { validateStudyShape, studyLabels } from './study-shape.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const hash=b=>createHash('sha256').update(b).digest('hex');
const load=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const studyPath=process.argv[2];if(!studyPath)throw Error('Usage: node run-generalization-study.mjs /absolute/study.json');
const studyBytes=await fs.readFile(studyPath),study=JSON.parse(studyBytes);
const labels=studyLabels(study);
if(study.protocol!=='codali-generalization-v1'||!study.frozenAt||!Number.isFinite(Date.parse(study.frozenAt))||Date.parse(study.frozenAt)>Date.now())throw Error('Prospective study freeze required');
const casesBytes=await fs.readFile(study.casesFile);
if(hash(casesBytes)!==study.casesSha256||hash(await fs.readFile(study.gradingFile))!==study.gradingSha256)throw Error('Frozen cases/grading mismatch');
const validateEvaluators=async()=>{for(const [file,sha]of Object.entries(study.evaluatorFiles??{}))if(hash(await fs.readFile(file))!==sha)throw Error('Frozen evaluator changed: '+file);};
await validateEvaluators();
// Never load grading content into the attempt process or model input.
const cases=casesBytes.toString('utf8').trim().split('\n').map(l=>validateWorkflowCase(JSON.parse(l)));
validateStudyShape(study,cases);
const knownKeys=new Set(cases.flatMap(task=>labels.map(label=>`${task.id}:${label}`)));
if(study.onlyKeys!==undefined&&(!Array.isArray(study.onlyKeys)||!study.onlyKeys.length
  ||new Set(study.onlyKeys).size!==study.onlyKeys.length||study.onlyKeys.some(key=>typeof key!=='string'||!knownKeys.has(key))))throw Error('Invalid recovery attempt selection');
const selectedKeys=study.onlyKeys===undefined?undefined:new Set(study.onlyKeys);
for(const label of labels){await validateRuntime(study.arms[label].runtime);if(hash(await fs.readFile(study.arms[label].config))!==study.arms[label].configSha256)throw Error(`Config drift: ${label}`);}
await fs.mkdir(study.output,{recursive:true,mode:0o700});
const identityPath=path.join(study.output,'identity.json');
try{const previous=await load(identityPath);if(previous.studySha256!==hash(studyBytes))throw Error('Output belongs to another frozen study');}
catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(identityPath,JSON.stringify({studySha256:hash(studyBytes),createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
const lockPath=path.join(study.output,'runner.lock'),lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
const abort=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>abort.abort(Error('Study interrupted')));
// Infrastructure waiting is recorded separately, never charged as model execution.
// Do not consume held-out cases while the required shared service is unavailable.
const waitForDependencies=async()=>{
  const urls=study.dependencyHealthUrls??[];
  for(const value of urls){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw Error('Health URL must be credential-free local service');}
  let waiting=false,lastNotice=0;
  while(true){
    abort.signal.throwIfAborted();
    const status=await Promise.all(urls.map(async url=>{try{const r=await fetch(url,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});await r.body?.cancel();return r.ok;}catch{return false;}}));
    if(status.every(Boolean)){if(waiting)await append({type:'dependencies_ready',at:new Date().toISOString()});return;}
    if(!waiting){waiting=true;await append({type:'dependencies_wait',urls,at:new Date().toISOString()});}
    if(Date.now()-lastNotice>60000){console.log(JSON.stringify({type:'dependencies_wait',urls,at:new Date().toISOString()}));lastNotice=Date.now();}
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',stop);resolve();},15000);const stop=()=>{clearTimeout(timer);reject(abort.signal.reason);};abort.signal.addEventListener('abort',stop,{once:true});});
  }
};
const ledgerPath=path.join(study.output,'ledger.jsonl');
const append=async r=>{const f=await fs.open(ledgerPath,'a',0o600);try{await f.writeFile(JSON.stringify(r)+'\n');await f.sync();}finally{await f.close();}};
try{
  let ledger=[];try{ledger=(await fs.readFile(ledgerPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
  const completed=new Set(ledger.filter(r=>r.type==='result').map(r=>r.key));
  for(const start of ledger.filter(r=>r.type==='start'&&!completed.has(r.key))){
    const result=await load(path.join(start.directory,'result.json')).catch(()=>undefined);
    if(!result)throw Error(`Uncertain prior attempt ${start.key}; inspect receipts, never silently retry`);
    await append({type:'result',key:start.key,label:start.label,directory:start.directory,result,recovered:true});completed.add(start.key);
  }
  for(let i=0;i<cases.length;i++){
    const task=cases[i],offset=i%labels.length,order=[...labels.slice(offset),...labels.slice(0,offset)];if(Math.floor(i/labels.length)%2)order.reverse();
    for(const label of order){
      const key=`${task.id}:${label}`;if(completed.has(key))continue;abort.signal.throwIfAborted();
      if(selectedKeys&&!selectedKeys.has(key))continue;
      await waitForDependencies();await validateEvaluators();
      const arm=study.arms[label];await validateRuntime(arm.runtime);
      if(hash(await fs.readFile(studyPath))!==hash(studyBytes)||hash(await fs.readFile(study.casesFile))!==study.casesSha256||hash(await fs.readFile(study.gradingFile))!==study.gradingSha256||hash(await fs.readFile(arm.config))!==arm.configSha256)throw Error('Frozen inputs changed');
      const {loadOrchestrationConfig}=await import(pathToFileURL(path.join(arm.runtime,'dist/config/OrchestrationConfig.js')));
      const {runEvaluationProcess}=await import(pathToFileURL(path.join(arm.runtime,'dist/eval/EvaluationProcess.js')));
      const resolved=await loadOrchestrationConfig(arm.config);
      const {ConfiguredProvider}=await import(pathToFileURL(path.join(arm.runtime,'dist/providers/ConfiguredProvider.js')));
      await waitForModelRoute({
        probe: signal => Promise.all(['lead', ...(label === 'raw_tools' ? [] : ['coding','frontend'].filter(binding => resolved.config.bindings[binding] && resolved.config.bindings[binding].enabled !== false))]
          .map(binding => probeModelDispatch(new ConfiguredProvider(resolved,binding),signal))),
        signal: abort.signal,
        sleep: (ms,signal) => sleep(ms,undefined,{signal}),
        onState: async state => {const event={...state,key,at:new Date().toISOString()};await append(event);console.log(JSON.stringify(event));},
      });
      const attemptId=randomUUID(),directory=path.join(study.output,`${task.id}-${label}-${attemptId}`);await fs.mkdir(directory,{mode:0o700});
      const requestPath=path.join(directory,'request.json');
      await fs.writeFile(requestPath,JSON.stringify({schemaVersion:1,task,arm:label==='raw_tools'?'raw_tools':'codali_candidate',attemptId,directory,config:arm.config}),{flag:'wx',mode:0o600});
      await append({type:'start',key,label,directory,at:new Date().toISOString()});console.log(JSON.stringify({type:'start',key,completed:completed.size}));
      let launchError;try{await runEvaluationProcess({file:path.join(arm.runtime,'benchmarks/complex52-attempt.mjs'),args:['--request',requestPath],cwd:directory,config:resolved.config,timeoutMs:task.execution.deadlineMs+20000,signal:abort.signal});}catch(error){launchError=String(error);}
      const result=await load(path.join(directory,'result.json')).catch(()=>undefined);
      if(!result)throw Error(`Attempt ${key} ended without a result (${launchError}); inspect before resuming`);
      await append({type:'result',key,label,directory,result,launchError,at:new Date().toISOString()});completed.add(key);
      console.log(JSON.stringify({type:'result',key,error:result.error,tokens:result.usage?.tokens,elapsedMs:result.elapsedMs}));
    }
  }
  await append({type:'run_complete',attempts:completed.size,at:new Date().toISOString()});
}finally{await lock.close();await fs.unlink(lockPath);}
