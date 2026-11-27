import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gradeTrustAnswer, applyTrustReview, applyTrustToolEvidence } from '../../packages/codali/dist/eval/TrustBenchmark.js';
import { accountedUsage, usageAccounts } from '../../packages/codali/dist/runtime/UsageReconciliation.js';
import { argumentsMap,json,jsonl,corpusRoot,hash,writeNew,readPublicCorpus } from './trust-common.mjs';
import { pairedFamilyBootstrap } from './analyze-trust-benchmark.mjs';
import { reconciledBenchmarkUsage } from './trust-usage.mjs';
const args=argumentsMap(undefined,['runs','output','reviews','critical-reviews','config-groups','corpus-root','usage-receipts']);if(!args.runs||!args.output)throw Error('Use --runs RUN_DIR[,RUN_DIR] --output NEW_DIR [--reviews JSONL] [--usage-receipts JSONL]');
const usageReceipts=args['usage-receipts']?await jsonl(args['usage-receipts']):[];
const usedUsageReceipts=new Set();
const configGroups=args['config-groups']?await json(args['config-groups']):{};
if(!configGroups||Array.isArray(configGroups)||Object.entries(configGroups).some(([key,value])=>!/^[a-f0-9]{64}$/.test(key)||typeof value!=='string'||!value.trim()))throw Error('Invalid explicit configuration grouping');
const output=path.resolve(args.output);await fs.mkdir(output,{mode:0o700});
const directory=args['corpus-root']?path.resolve(args['corpus-root']):corpusRoot;
const {manifest,cases:publicCases}=await readPublicCorpus(directory);
const bytes=await fs.readFile(path.join(directory,'grading.jsonl'));if(hash(bytes)!==manifest.gradingSha256)throw Error('Grading specification drift');
const specs=new Map(bytes.toString().trim().split('\n').map(line=>{const x=JSON.parse(line);return[x.id,x];}));
const cases=new Map(publicCases.map(x=>[x.id,x]));
const reviews=args.reviews?await jsonl(args.reviews):[];
if(new Set(reviews.map(x=>x.attemptId)).size!==reviews.length)throw Error('Duplicate review attempt');
const criticalReviews=args['critical-reviews']?await jsonl(args['critical-reviews']):[];
if(new Set(criticalReviews.map(x=>x.attemptId)).size!==criticalReviews.length)throw Error('Duplicate critical review attempt');
const scores=[],pending=[],semanticPending=[],criticalPending=[],seen=new Set(),protocols=new Set(),runtimeHashes=new Set();
for(const root of args.runs.split(',')){
  const run=await json(path.join(root,'manifest.json'));
  if(run.identity.corpusHash!==manifest.promptsSha256)throw Error('Run belongs to different corpus');
  protocols.add(run.identity.protocolVersion??'legacy-labelled-paths-v1');runtimeHashes.add(hash(JSON.stringify(run.identity.fingerprint)));
  if(protocols.size>1||runtimeHashes.size>1)throw Error('Comparison requires one identical evaluation protocol and runtime; report diagnostic generations separately');
  for(const record of await jsonl(path.join(root,'ledger.jsonl'))){
    if(record.type!=='result')continue;
    const r=record.result;if(seen.has(r.attemptId))throw Error('Duplicate attempt in report');seen.add(r.attemptId);
    const task=cases.get(r.caseId),spec=specs.get(r.caseId);if(!task||!spec)throw Error('Unknown case in ledger');
    let events=[],eventBytes=Buffer.alloc(0);try{eventBytes=await fs.readFile(path.join(record.directory,'events.jsonl'));events=eventBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
    const modelRequests=events.filter(e=>e.type==='model_request').length;
    const modelResponses=events.filter(e=>e.type==='model_response').length;
    const accounts=usageAccounts(events);
    const derived=r.arm.startsWith('codali')&&accounts.size?accountedUsage(accounts.values()):undefined;
    const corrections=usageReceipts.filter(row=>row.attemptId===r.attemptId);
    const reconciled=reconciledBenchmarkUsage(r,events,hash(eventBytes),corrections);
    corrections.forEach(row=>usedUsageReceipts.add(row));
    const usage=reconciled??(derived?{...r.usage,...derived}:r.usage);
    let grade=await gradeTrustAnswer(spec,r.content??'',{error:r.error??record.launchError,workspacePreserved:r.workspacePreserved});
    if(task.domain==='repository_and_docdex'&&r.arm!=='raw_direct'){
      grade=applyTrustToolEvidence(task,r.arm,grade,events);
    }
    const review=reviews.find(x=>x.attemptId===r.attemptId);
    if(review)grade=applyTrustReview(spec,grade,review);
    const safety=criticalReviews.find(x=>x.attemptId===r.attemptId);
    if(safety&&(!spec.critical||safety.caseId!==r.caseId||safety.outputSha256!==grade.outputSha256||typeof safety.passed!=='boolean'||!safety.reviewer?.trim()||!safety.evidence?.trim()))throw Error('Critical review must bind the exact case/output and include reviewer, decision and evidence');
    if(spec.critical&&!safety)criticalPending.push({caseId:r.caseId,attemptId:r.attemptId,outputSha256:grade.outputSha256,prompt:task.prompt,history:task.history,content:r.content,error:r.error,
      observed:{toolCalls:r.usage?.toolCalls,workspacePreserved:r.workspacePreserved,tools:events.filter(e=>e.type==='tool_receipt').map(e=>e.data?.receipt?.tool??e.data?.call?.name)}});
    if(grade.status==='needs_review')pending.push({reviewId:hash(r.attemptId).slice(0,20),caseId:r.caseId,attemptId:r.attemptId,outputSha256:grade.outputSha256,prompt:task.prompt,history:task.history,content:r.content,criteria:spec.criteria,observed:{toolCalls:r.usage?.toolCalls,workspacePreserved:r.workspacePreserved}});
    if(grade.status==='failed'&&!r.error&&!record.launchError&&grade.semanticPassed!==true&&(grade.semanticPassed===undefined||grade.formatPassed===false))semanticPending.push({reviewId:hash(r.attemptId).slice(0,20),caseId:r.caseId,attemptId:r.attemptId,outputSha256:grade.outputSha256,prompt:task.prompt,history:task.history,content:r.content,failures:grade.failures,criteria:spec.criteria,expected:spec.expected,alternatives:spec.alternatives,tests:spec.tests,observed:{toolEvidence:grade.toolEvidence,workspacePreserved:r.workspacePreserved},instruction:'Assess content correctness separately. Never change strict format, tool evidence or critical grades.'});
    const configHash=r.configHash??run.identity.configHash;
    scores.push({attemptId:r.attemptId,startedAt:r.startedAt??record.at??run.createdAt,retryOf:r.retryOf,caseId:r.caseId,family:task.family,domain:task.domain,split:task.split,arm:r.arm,configHash,configGroup:configGroups[configHash]??configHash,
      grade,elapsedMs:r.answerElapsedMs??r.elapsedMs,totalElapsedMs:r.elapsedMs,usage,originalUsage:r.usage,usageDerivedFromReceipts:!!derived,usageReconciled:!!reconciled,modelRequests,modelResponses,critical:spec.critical,criticalReviewed:!!safety,criticalFailure:safety?.passed===false||review?.criticalFailure===true||r.workspacePreserved===false,artifact:record.directory,error:r.error??record.launchError});
  }
}
if(usedUsageReceipts.size!==usageReceipts.length)throw Error('Usage receipt refers to an attempt outside this report');
// First attempts are primary. A later run is never silently substituted for failure.
const byId=new Map(scores.map(x=>[x.attemptId,x]));
for(const s of scores)if(s.retryOf){const previous=byId.get(s.retryOf);if(!previous||previous.caseId!==s.caseId||previous.arm!==s.arm||previous.configHash!==s.configHash)throw Error('Retry report requires the matching original attempt; a retry cannot replace its failure');}
const first=new Map();for(const s of scores){if(s.retryOf)continue;const key=[s.caseId,s.arm,s.configHash].join(':');const previous=first.get(key);
  if(previous&&(!Number.isFinite(Date.parse(previous.startedAt))||!Number.isFinite(Date.parse(s.startedAt))))throw Error('Repeated primary attempts require timestamps or explicit retry lineage');
  if(!previous||Date.parse(s.startedAt)<Date.parse(previous.startedAt))first.set(key,s);}
const primary=[...first.values()];
const summarize=list=>{
  const sorted=key=>list.map(x=>key(x)).filter(Number.isFinite).sort((a,b)=>a-b);
  const percentile=(xs,p)=>xs.length?xs[Math.min(xs.length-1,Math.ceil(xs.length*p)-1)]:null;
  const latency=sorted(x=>x.elapsedMs),tokens=sorted(x=>x.usage?.tokens);
  return{attempts:list.length,uniqueCases:new Set(list.map(x=>x.caseId)).size,passed:list.filter(x=>x.grade.passed).length,failed:list.filter(x=>x.grade.status==='failed').length,
    liveResponseCases:new Set(list.filter(x=>x.modelResponses>0).map(x=>x.caseId)).size,zeroDispatchAttempts:list.filter(x=>x.modelRequests===0).length,unansweredDispatchedAttempts:list.filter(x=>x.modelRequests>0&&x.modelResponses===0).length,
    needsReview:list.filter(x=>x.grade.status==='needs_review').length,errors:list.filter(x=>x.error).length,criticalFailures:list.filter(x=>x.criticalFailure).length,criticalUnreviewed:list.filter(x=>x.critical&&!x.criticalReviewed).length,strictAccuracy:list.length?list.filter(x=>x.grade.passed).length/list.length:null,
    latencyMs:{p50:percentile(latency,.5),p95:percentile(latency,.95),known:latency.length},tokens:{p50:percentile(tokens,.5),p95:percentile(tokens,.95),sum:tokens.reduce((a,b)=>a+b,0),known:tokens.length,estimated:list.filter(x=>x.usage?.estimated).length}};
};
const groups=[...new Set(primary.map(x=>`${x.arm}:${x.configGroup}`))];const aggregates={};
for(const key of groups){const list=primary.filter(x=>`${x.arm}:${x.configGroup}`===key);
  if(new Set(list.map(x=>x.caseId)).size!==list.length)throw Error('Explicit configuration group has overlapping case attempts; select one primary run per case');
  aggregates[key]={configHashes:[...new Set(list.map(x=>x.configHash))],all:summarize(list),splits:Object.fromEntries(['development','validation','held_out'].map(split=>[split,summarize(list.filter(x=>x.split===split))])),domains:Object.fromEntries([...new Set(list.map(x=>x.domain))].map(domain=>[domain,summarize(list.filter(x=>x.domain===domain))]))};}
const paired=[];
for(const candidate of groups.filter(x=>x.startsWith('codali_'))){
  const selected=primary.filter(x=>`${x.arm}:${x.configGroup}`===candidate&&x.split==='held_out');
  const group=selected[0]?.configGroup;
  const expected=publicCases.filter(task=>task.split==='held_out');
  for(const baselineArm of ['raw_direct','raw_tools']){
    const baseline=primary.filter(x=>x.arm===baselineArm&&x.configGroup===group&&x.split==='held_out');
    if(new Set(baseline.map(x=>x.caseId)).size!==baseline.length)throw Error('Ambiguous baseline');
    const pairs=selected.map(x=>[x,baseline.find(b=>b.caseId===x.caseId)]).filter(([,b])=>b);
    if(!pairs.length)continue;
    const complete=expected.length>0&&expected.every(task=>pairs.some(([a])=>a.caseId===task.id))&&pairs.every(pair=>pair.every(row=>row.grade.status!=='needs_review'&&row.modelRequests>0));
    paired.push({candidate,baselineArm,...pairedFamilyBootstrap(pairs.map(([a,b])=>({family:a.family,candidatePassed:a.grade.passed,baselinePassed:b.grade.passed}))),
      expectedCases:expected.length,complete,numericQualityGate:null,
      qualification:'Descriptive strict scores only. Use analyze-trust-benchmark --freeze for prospective semantic, token, latency, critical-review and tool-parity gates.'});
  }
}
await writeNew(path.join(output,'report.json'),{schemaVersion:3,at:new Date().toISOString(),corpus:manifest,protocolVersion:[...protocols][0],runtimeFingerprint:[...runtimeHashes][0],configGroups,
  usageReceiptsSha256:args['usage-receipts']?hash(await fs.readFile(args['usage-receipts'])):null,
  graderSha256:hash(await fs.readFile(new URL('../../packages/codali/dist/eval/TrustBenchmark.js',import.meta.url))),
  scorerSha256:hash(await fs.readFile(new URL(import.meta.url))),
  scorerDependencies:Object.fromEntries(await Promise.all(['./trust-usage.mjs','./analyze-trust-benchmark.mjs','./trust-common.mjs','../../packages/codali/dist/runtime/UsageReconciliation.js','../../packages/codali/dist/providers/ConfiguredModelScope.js'].map(async file=>[file,hash(await fs.readFile(new URL(file,import.meta.url)))]))),attempts:scores.length,primaryAttempts:primary.length,aggregates,paired,reviewPending:pending.length,criticalReviewPending:criticalPending.length,semanticReviewPending:semanticPending.length});
await fs.writeFile(path.join(output,'scores.jsonl'),scores.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
// Omit arm and model/config labels from the review bundle. The mapping stays in scores.
pending.sort((a,b)=>a.reviewId.localeCompare(b.reviewId));
await fs.writeFile(path.join(output,'review-pending.jsonl'),pending.map(x=>JSON.stringify(x)).join('\n')+(pending.length?'\n':''),{flag:'wx',mode:0o600});
semanticPending.sort((a,b)=>a.reviewId.localeCompare(b.reviewId));
await fs.writeFile(path.join(output,'semantic-review-pending.jsonl'),semanticPending.map(x=>JSON.stringify(x)).join('\n')+(semanticPending.length?'\n':''),{flag:'wx',mode:0o600});
await fs.writeFile(path.join(output,'critical-review-pending.jsonl'),criticalPending.map(x=>JSON.stringify(x)).join('\n')+(criticalPending.length?'\n':''),{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,attempts:scores.length,reviewPending:pending.length,aggregates},null,2));
