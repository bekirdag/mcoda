// Observe once; later scoring reuses these immutable receipts without executing
// submitted code or changing a review's evidence binding.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { argumentsMap, hash, json, jsonl, writeNew } from './trust-common.mjs';
import { readWorkflowCorpus } from './trust-workflow-protocol.mjs';
import { validateWorkflowGrading, observeWorkflow } from './trust-workflow-grading.mjs';

const args=argumentsMap(undefined,['runs','corpus-root','output','media-policy']);
if(!args.runs||!args['corpus-root']||!args.output)throw Error('Usage: node scripts/benchmarks/observe-workflow-benchmark.mjs --runs DIRECTORY --corpus-root DIRECTORY --output NEW_DIRECTORY [--media-policy FILE]');
const runs=path.resolve(args.runs),corpusRoot=path.resolve(args['corpus-root']);
const run=await json(path.join(runs,'manifest.json')),{manifest:corpus,cases}=await readWorkflowCorpus(corpusRoot);
if(run.identity.protocolVersion!=='trust-workflows-v1'||run.identity.corpusHash!==corpus.promptsSha256)throw Error('Workflow corpus/run identity mismatch');
const gradingBytes=await fs.readFile(path.join(corpusRoot,'grading.jsonl'));
if(hash(gradingBytes)!==corpus.gradingSha256||run.identity.gradingHash!==corpus.gradingSha256)throw Error('Private grading corpus hash mismatch');
const specs=gradingBytes.toString().trim().split('\n').map(JSON.parse);
if(specs.length!==cases.length||new Set(specs.map(spec=>spec.caseId)).size!==cases.length)throw Error('Private grading count/identity mismatch');
const byId=new Map(cases.map(task=>[task.id,task]));for(const spec of specs)validateWorkflowGrading(byId.get(spec.caseId),spec);
const grading=new Map(specs.map(spec=>[spec.caseId,spec]));
const policy=args['media-policy']?await json(args['media-policy']):undefined;
if(policy&&(policy.configHash!==run.identity.configHash||hash(JSON.stringify(policy))!==corpus.mediaPolicySha256))throw Error('Local media policy must match the prospectively recorded corpus policy/config');
const ledgerBytes=await fs.readFile(path.join(runs,'ledger.jsonl')),ledger=ledgerBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
const outcomes=ledger.filter(record=>record.type==='result');
if(!outcomes.length||new Set(outcomes.map(record=>record.key)).size!==outcomes.length)throw Error('Missing or duplicate workflow outcomes');
for(const record of outcomes)if(!record.result||record.key!==`${record.result.caseId}:${record.result.arm}`
  ||!run.identity.taskIds.includes(record.result.caseId)||!run.identity.arms.includes(record.result.arm))throw Error('Outcome identity is outside the recorded run');
const output=path.resolve(args.output);await fs.mkdir(output,{mode:0o700});await fs.mkdir(path.join(output,'review'),{mode:0o700});
const graderFiles=['trust-workflow-grading.mjs','trust-workflow-workspace.mjs','trust-workflow-evidence.mjs','trust-artifacts.mjs','observe-workflow-benchmark.mjs'];
const graderHashes=Object.fromEntries(await Promise.all(graderFiles.map(async file=>[file,hash(await fs.readFile(new URL(file,import.meta.url)))])));
await writeNew(path.join(output,'manifest.json'),{protocol:'trust-workflow-observations-v1',createdAt:new Date().toISOString(),run:run.identity,
  runComplete:ledger.some(record=>record.type==='run_complete')&&outcomes.length===run.identity.taskIds.length*run.identity.arms.length,
  sourceLedgerSha256:hash(ledgerBytes),gradingSha256:corpus.gradingSha256,mediaPolicySha256:policy?hash(JSON.stringify(policy)):null,graderHashes,
  limitations:run.limitations});
const file=await fs.open(path.join(output,'observations.jsonl'),'wx',0o600);
try{
  for(const record of outcomes){
    const {result,directory}=record,task=byId.get(result.caseId);
    const relative=path.relative(path.join(runs,'attempts'),path.resolve(directory));
    if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Outcome directory escapes recorded run');
    const optional=async(name,fallback,read)=>{try{return await read(path.join(directory,name));}catch(error){if(error.code!=='ENOENT')throw error;return fallback;}};
    const events=await optional('events.jsonl',[],jsonl),mediaJobs=await optional('media-jobs.json',[],json);
    if(!result.unknownOutcome&&result.configHash!==run.identity.configHash)throw Error('Outcome configuration does not match run');
    const observed=await observeWorkflow({task,spec:grading.get(task.id),result,events,mediaJobs,localMediaPolicy:policy});
    const reviewFile=`${hash(result.attemptId)}.json`;
    await writeNew(path.join(output,'review',reviewFile),observed.bundle);
    const row={caseId:task.id,attemptId:result.attemptId,arm:result.arm,domain:task.domain,family:task.family,split:task.split,comparison:task.comparison,
      usage:result.usage,answerElapsedMs:result.answerElapsedMs??result.elapsedMs,error:result.error,reviewFile,bundle:observed.bundle};
    await file.writeFile(JSON.stringify(row)+'\n');await file.sync();
    console.log(JSON.stringify({caseId:task.id,arm:result.arm,failures:observed.bundle.failures}));
  }
}finally{await file.close();}
const bytes=await fs.readFile(path.join(output,'observations.jsonl'));
await writeNew(path.join(output,'complete.json'),{observations:outcomes.length,sha256:hash(bytes)});
