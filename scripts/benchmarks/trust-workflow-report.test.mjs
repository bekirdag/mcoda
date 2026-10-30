import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { hash,json,jsonl } from './trust-common.mjs';
import { summarizeWorkflowRows,workflowReport } from './trust-workflow-report.mjs';

const arms=['raw_direct','raw_tools','codali_candidate'];
const row=(arm,id,changes={})=>({caseId:id,attemptId:`${arm}-${id}`,arm,domain:'fixture',family:id,split:'held_out',comparison:'answer',
  usage:{tokens:100,estimated:false,toolCalls:arm==='raw_direct'?0:1},answerElapsedMs:1000,
  grade:{passed:true,status:'passed',reviewer:'fixture',criticalPassed:true},...changes});
const manifest=ids=>({run:{arms,taskIds:ids,freezeHash:hash('prospective fixture freeze')},runComplete:true,limitations:[]});

test('workflow report separates text answers from artifact capability and retains all failure costs',()=>{
  const rows=arms.flatMap(arm=>[row(arm,'answer'),row(arm,'artifact',{comparison:'artifact',grade:{passed:arm!=='raw_direct',reviewer:'fixture',criticalPassed:true}})]);
  rows.find(value=>value.arm==='codali_candidate'&&value.caseId==='answer').error='failed after spending tokens';
  const report=workflowReport(rows,manifest(['answer','artifact']));
  assert.equal(report.comparisons.find(value=>value.baseline==='raw_direct').pairedCases,1);
  assert.equal(report.comparisons.find(value=>value.baseline==='raw_tools'&&value.scope==='all_workflows').pairedCases,2);
  assert.equal(report.aggregate.codali_candidate.totalTokens,200);assert.equal(report.aggregate.codali_candidate.executionFailures,1);
  assert.equal(report.evaluationGate.passed,false);
});

test('unknown costs/timings are never silently dropped and incomplete reviews block qualification',()=>{
  const rows=[row('codali_candidate','one'),row('codali_candidate','two',{usage:{estimated:true},answerElapsedMs:undefined,grade:{passed:false,criticalPassed:null}})];
  const result=summarizeWorkflowRows(rows);
  assert.equal(result.totalTokens,null);assert.equal(result.knownTokenSubtotal,100);assert.equal(result.unknownUsageAttempts,1);
  assert.equal(result.medianMs,null);assert.equal(result.pendingCriticalReviews,1);
  const report=workflowReport(rows,manifest(['one','two']));assert.equal(report.evaluationGate.passed,false);
  assert.ok(report.evaluationGate.failures.includes('Study is incomplete'));assert.ok(report.evaluationGate.failures.includes('Review is incomplete'));
});

test('prospective evaluation gate requires paired gain, efficiency and no critical regression',()=>{
  const ids=Array.from({length:100},(_,i)=>`case.${i}`);
  const rows=ids.flatMap((id,i)=>arms.map(arm=>row(arm,id,{grade:{passed:arm!=='raw_direct'||i>=20,reviewer:'fixture',criticalPassed:true}})));
  const report=workflowReport(rows,manifest(ids));assert.equal(report.evaluationGate.passed,true);
  const expensive=structuredClone(rows);expensive.filter(value=>value.arm==='codali_candidate').forEach(value=>value.usage.tokens=200);
  assert.equal(workflowReport(expensive,manifest(ids)).evaluationGate.passed,false);
  const critical=structuredClone(rows);critical.find(value=>value.arm==='codali_candidate').grade.criticalPassed=false;
  assert.equal(workflowReport(critical,manifest(ids)).evaluationGate.passed,false);
  assert.equal(workflowReport(rows,{...manifest(ids),runComplete:false}).evaluationGate.passed,false);
});

test('observe/score CLI freezes evidence once, requires matching reviews and detects modified observations',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-workflow-report-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const corpus=path.join(root,'corpus'),runs=path.join(root,'run');await fs.mkdir(corpus);await fs.mkdir(runs);
  const task={id:'fixture.answer.01',domain:'fixture',family:'fixture',split:'development',variant:1,prompt:'Synthetic protocol fixture.',history:[],files:{},
    execution:{writes:false,web:false,media:false,effort:'low',deadlineMs:1000},comparison:'answer'};
  const grading={caseId:task.id,criteria:[{id:'answer',criterion:'Returns the synthetic requested value.'}],requirements:[],turns:[{turnIndex:0,output:{format:'json',equals:{value:42}}}],artifacts:[],commands:[],preservePaths:[]};
  const prompts=JSON.stringify(task)+'\n',gradeBytes=JSON.stringify(grading)+'\n';
  await fs.writeFile(path.join(corpus,'prompts.jsonl'),prompts);await fs.writeFile(path.join(corpus,'grading.jsonl'),gradeBytes);
  await fs.writeFile(path.join(corpus,'manifest.json'),JSON.stringify({schemaVersion:1,protocol:'trust-workflows-v1',caseCount:1,promptsSha256:hash(prompts),gradingSha256:hash(gradeBytes),limitations:['Synthetic fixtures only.']}));
  const configHash=hash('fixture config');await fs.writeFile(path.join(runs,'manifest.json'),JSON.stringify({identity:{protocolVersion:'trust-workflows-v1',corpusHash:hash(prompts),gradingHash:hash(gradeBytes),configHash,arms,taskIds:[task.id],split:'development'},limitations:[]}));
  const records=[];
  for(const arm of arms){
    const directory=path.join(runs,'attempts',arm),workspace=path.join(root,`${arm}-workspace`);await fs.mkdir(directory,{recursive:true});await fs.mkdir(workspace);
    const content=arm==='raw_direct'?'A malformed result':'{"value":42}';
    records.push({type:'result',key:`${task.id}:${arm}`,directory,result:{caseId:task.id,attemptId:`fixture-${arm}`,arm,configHash,originalWorkspace:workspace,workspaceBefore:{},workspaceAfter:{},workspacePreserved:true,
      turns:[{index:0,content,outputSha256:hash(content)}],usage:{tokens:100,estimated:false},answerElapsedMs:1000}});
    await fs.writeFile(path.join(directory,'events.jsonl'),'');await fs.writeFile(path.join(directory,'media-jobs.json'),'[]');
  }
  records.push({type:'run_complete'});await fs.writeFile(path.join(runs,'ledger.jsonl'),records.map(value=>JSON.stringify(value)+'\n').join(''));
  const invoke=(script,args)=>promisify(execFile)(process.execPath,[fileURLToPath(new URL(script,import.meta.url)),...args],{timeout:30000,maxBuffer:100000});
  const observations=path.join(root,'observations');await invoke('observe-workflow-benchmark.mjs',['--runs',runs,'--corpus-root',corpus,'--output',observations]);
  const observed=await jsonl(path.join(observations,'observations.jsonl'));assert.equal(observed.length,3);
  const raw=observed.find(value=>value.arm==='raw_direct');assert.deepEqual(raw.bundle.failures,['turn:0']);
  const reviews=observed.map(({bundle})=>({caseId:bundle.caseId,attemptId:bundle.attemptId,observationSha256:bundle.observationSha256,reviewer:'synthetic positive fixture',dimensions:bundle.criteria.map(item=>({id:item.id,passed:true,evidence:'Synthetic contract exercise only.'}))}));
  const reviewPath=path.join(root,'reviews.jsonl');await fs.writeFile(reviewPath,reviews.map(value=>JSON.stringify(value)+'\n').join(''));
  const output=path.join(root,'scores');await invoke('score-workflow-benchmark.mjs',['--observations',observations,'--reviews',reviewPath,'--output',output]);
  const report=await json(path.join(output,'report.json'));assert.equal(report.aggregate.raw_direct.passed,0);assert.equal(report.aggregate.codali_candidate.passed,1);assert.equal(report.evaluationGate.passed,false);
  await fs.appendFile(path.join(observations,'observations.jsonl'),' ');
  await assert.rejects(invoke('score-workflow-benchmark.mjs',['--observations',observations,'--reviews',reviewPath,'--output',path.join(root,'altered')]),/Immutable observations changed/);
});
