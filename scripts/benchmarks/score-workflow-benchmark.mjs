import { promises as fs } from 'node:fs';
import path from 'node:path';
import { argumentsMap,hash,json,jsonl,writeNew } from './trust-common.mjs';
import { applyWorkflowReview } from './trust-workflow-evidence.mjs';
import { workflowReport } from './trust-workflow-report.mjs';

const args=argumentsMap(undefined,['observations','reviews','output']);
if(!args.observations||!args.output)throw Error('Usage: node scripts/benchmarks/score-workflow-benchmark.mjs --observations DIRECTORY --output NEW_DIRECTORY [--reviews JSONL]');
const root=path.resolve(args.observations),manifest=await json(path.join(root,'manifest.json')),complete=await json(path.join(root,'complete.json'));
if(manifest.protocol!=='trust-workflow-observations-v1')throw Error('Wrong observation protocol');
const scorerFiles=['trust-workflow-evidence.mjs','trust-workflow-report.mjs','score-workflow-benchmark.mjs'];
const scorerHashes=Object.fromEntries(await Promise.all(scorerFiles.map(async file=>[file,hash(await fs.readFile(new URL(file,import.meta.url)))])));
if(Object.entries(scorerHashes).some(([file,sha])=>manifest.run.fingerprint?.files?.[file]!==sha))throw Error('Scoring source differs from the frozen study');
const bytes=await fs.readFile(path.join(root,'observations.jsonl'));
if(hash(bytes)!==complete.sha256)throw Error('Immutable observations changed');
const observations=bytes.toString().trim().split('\n').map(JSON.parse);
if(observations.length!==complete.observations)throw Error('Incomplete observations');
const reviews=args.reviews?await jsonl(args.reviews):[],reviewById=new Map(reviews.map(review=>[review.attemptId,review]));
if(reviewById.size!==reviews.length||reviews.some(review=>!observations.some(row=>row.attemptId===review.attemptId)))throw Error('Duplicate or unrelated workflow review');
const scores=observations.map(row=>{const {bundle,...metadata}=row;return {...metadata,observationSha256:bundle.observationSha256,grade:applyWorkflowReview(bundle,reviewById.get(row.attemptId))};});
const report=workflowReport(scores,manifest),output=path.resolve(args.output);await fs.mkdir(output,{mode:0o700});
await writeNew(path.join(output,'manifest.json'),{createdAt:new Date().toISOString(),source:manifest,observationsSha256:complete.sha256,
  reviewsSha256:args.reviews?hash(await fs.readFile(args.reviews)):null,scorerHashes});
await fs.writeFile(path.join(output,'scores.jsonl'),scores.map(row=>JSON.stringify(row)+'\n').join(''),{flag:'wx',mode:0o600});
await writeNew(path.join(output,'report.json'),report);
console.log(JSON.stringify({output,attempts:scores.length,pendingReviews:scores.filter(row=>!row.grade.reviewer).length,evaluationGate:report.evaluationGate}));
