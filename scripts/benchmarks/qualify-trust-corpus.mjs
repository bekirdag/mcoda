import path from 'node:path';
import { promises as fs } from 'node:fs';
import { gradeTrustAnswer, validateTrustCorpus } from '../../packages/codali/dist/eval/TrustBenchmark.js';
import { corpusRoot,json,jsonl,hash,argumentsMap,writeNew } from './trust-common.mjs';
const args=argumentsMap(undefined,['output']);
const cases=await jsonl(path.join(corpusRoot,'prompts.jsonl'));const specs=await jsonl(path.join(corpusRoot,'grading.jsonl'));
const manifest=await json(path.join(corpusRoot,'manifest.json'));
if(hash(await fs.readFile(path.join(corpusRoot,'grading.jsonl')))!==manifest.gradingSha256)throw Error('Grading hash mismatch');
validateTrustCorpus(cases,specs);
const outcomes=[];
for(const spec of specs){
  if(spec.kind==='rubric'){
    if(spec.criteria?.length!==4||spec.criteria.some(c=>!c.trim()))throw Error('Incomplete rubric');
    const pending=await gradeTrustAnswer(spec,'A plausible but unreviewed answer.');
    if(pending.passed||pending.status!=='needs_review')throw Error('Unreviewed answer passed');
    outcomes.push({id:spec.id,kind:spec.kind,rubricValidated:true});continue;
  }
  const content=spec.kind==='code'?spec.reference:JSON.stringify(spec.expected);
  const grade=await gradeTrustAnswer(spec,content);
  if(!grade.passed)throw Error(JSON.stringify({id:spec.id,grade}));
  const negative=await gradeTrustAnswer(spec,spec.kind==='code'?'export const solve=()=>"deliberately-wrong";':'{"answer":"deliberately-wrong"}');
  if(negative.passed)throw Error('Negative control passed: '+spec.id);
  outcomes.push({id:spec.id,kind:spec.kind,referencePassed:true,negativeRejected:true,checks:grade.checks});
  if(outcomes.length%50===0)console.log(JSON.stringify({qualified:outcomes.length}));
}
const result={at:new Date().toISOString(),corpusHash:manifest.promptsSha256,gradingHash:manifest.gradingSha256,total:outcomes.length,outcomes};
if(args.output)await writeNew(args.output,result);
console.log(JSON.stringify({qualified:outcomes.length,output:args.output}));
