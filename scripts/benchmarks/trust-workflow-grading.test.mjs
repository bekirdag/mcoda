import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hash } from './trust-common.mjs';
import { snapshotWorkflowWorkspace, workflowWorkspaceLimits } from './trust-workflow-workspace.mjs';
import { validateWorkflowGrading, observeWorkflow } from './trust-workflow-grading.mjs';
import { applyWorkflowReview } from './trust-workflow-evidence.mjs';
import { executorStatus } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';

const file = content=>({encoding:'utf8',content,sha256:hash(content)});
const task = (overrides={})=>({id:'synthetic.fixture.01',domain:'fixture',family:'fixture',split:'development',variant:1,prompt:'Synthetic grader fixture, not a benchmark question.',history:[],files:{'notes.md':file('Retain this input.')},execution:{writes:true,web:false,media:false,effort:'low',deadlineMs:30000},comparison:'answer',...overrides});
const spec = (overrides={})=>({caseId:'synthetic.fixture.01',criteria:[{id:'correct',criterion:'Result satisfies the fixture request.'}],requirements:[],turns:[],artifacts:[],commands:[],preservePaths:['notes.md'],...overrides});
const review = bundle=>({caseId:bundle.caseId,attemptId:bundle.attemptId,observationSha256:bundle.observationSha256,reviewer:'synthetic-fixture-reviewer',dimensions:bundle.criteria.map(item=>({id:item.id,passed:true,evidence:'Synthetic positive review to exercise objective failure precedence.'}))});
async function fixture(t,files={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-workflow-grade-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [name,value]of Object.entries({'notes.md':'Retain this input.',...files})){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),value);}
  const snapshot=await snapshotWorkflowWorkspace(root);
  return {root,result:{caseId:'synthetic.fixture.01',attemptId:'fixture-attempt',arm:'fixture-arm',originalWorkspace:root,workspaceBefore:{'notes.md':hash('Retain this input.')},workspaceAfter:snapshot,workspacePreserved:false,turns:[{index:0,content:'Done.',outputSha256:hash('Done.')}],usage:{tokens:1}}};
}
const isolation=executorStatus(), isolated={skip:!isolation.available&&isolation.reason};

test('workspace observations preserve bytes, reject symlinks/drift and bound sparse files before allocation',async t=>{
  const {root,result}=await fixture(t,{'nested/value.txt':'évidence'});
  const copy=await fs.mkdtemp(path.join(os.tmpdir(),'codali-workspace-copy-'));t.after(()=>fs.rm(copy,{recursive:true,force:true}));
  assert.deepEqual(await snapshotWorkflowWorkspace(root,{copyTo:copy,expected:result.workspaceAfter}),result.workspaceAfter);
  assert.equal(await fs.readFile(path.join(copy,'nested/value.txt'),'utf8'),'évidence');
  await fs.writeFile(path.join(root,'notes.md'),'Changed');await assert.rejects(snapshotWorkflowWorkspace(root,{expected:result.workspaceAfter}),/differs/);
  await fs.symlink(path.join(root,'notes.md'),path.join(root,'alias'));await assert.rejects(snapshotWorkflowWorkspace(root),/nonregular/);await fs.unlink(path.join(root,'alias'));
  const large=await fs.open(path.join(root,'large.bin'),'w');await large.truncate(workflowWorkspaceLimits.fileBytes+1);await large.close();
  await assert.rejects(snapshotWorkflowWorkspace(root),/byte limit/);
});

test('private grading requires actual artifact/program checks and rejects flags, escape paths and absent turns',()=>{
  assert.throws(()=>validateWorkflowGrading(task({comparison:'implementation'}),spec()),/requires independent/);
  assert.throws(()=>validateWorkflowGrading(task({comparison:'artifact'}),spec()),/requires independent/);
  assert.throws(()=>validateWorkflowGrading(task(),spec({requirements:[{turnIndex:1,anyOf:[{tool:'file_read',args:{}}]}]})),/absent turn/);
  const command={id:'behavior',command:'node',args:['main.mjs'],timeoutMs:1000,output:{format:'json',equals:2}};
  for(const args of [['--eval'],['../outside.mjs'],['/tmp/escaped.mjs']])assert.throws(()=>validateWorkflowGrading(task(),spec({commands:[{...command,args}]})));
});

test('actual implementation imports run with private expectations outside the read-only sandbox',isolated,async t=>{
  const files={'helper.mjs':'export const twice=x=>x*2;', 'main.mjs':"import {twice} from './helper.mjs'; console.log(JSON.stringify({value:twice(Number(process.argv[2])),secret:process.env.CODALI_TEST_PRIVATE??null}));"};
  const {result}=await fixture(t,files);const previous=process.env.CODALI_TEST_PRIVATE;process.env.CODALI_TEST_PRIVATE='fixture-secret';
  t.after(()=>{if(previous===undefined)delete process.env.CODALI_TEST_PRIVATE;else process.env.CODALI_TEST_PRIVATE=previous;});
  const commands=[{id:'negative',command:'node',args:['main.mjs','-3'],timeoutMs:3000,output:{format:'json',equals:{value:-6,secret:null}}},
    {id:'zero',command:'node',args:['main.mjs','0'],timeoutMs:3000,output:{format:'json',equals:{value:0,secret:null}}}];
  const observed=await observeWorkflow({task:task({comparison:'implementation'}),spec:spec({commands}),result,events:[]});
  assert.deepEqual(observed.bundle.failures,[]);assert.equal(observed.programs.length,2);
  assert.equal(applyWorkflowReview(observed.bundle,review(observed.bundle)).passed,true);
  assert.ok(observed.bundle.independentObservations.every(item=>item.kind==='program'&&item.sourceSha256));
});

test('failed program, missing artifact and changed retained bytes cannot be rescued by a positive review',isolated,async t=>{
  const {root,result}=await fixture(t,{'main.mjs':"console.log(JSON.stringify(7));"});
  const grading=spec({commands:[{id:'wrong',command:'node',args:['main.mjs'],timeoutMs:3000,output:{format:'json',equals:8}}],artifacts:[{path:'missing.md',format:'md'}]});
  const observed=await observeWorkflow({task:task(),spec:grading,result,events:[]});
  assert.deepEqual(observed.bundle.failures,['artifact:missing.md','program:wrong']);
  assert.equal(applyWorkflowReview(observed.bundle,review(observed.bundle)).passed,false);
  await fs.writeFile(path.join(root,'main.mjs'),'console.log(8)');
  const drift=await observeWorkflow({task:task(),spec:grading,result,events:[]});
  assert.deepEqual(drift.bundle.failures,['workspace_observation_failed']);assert.equal(drift.programs.length,0);
});

test('document observations bind actual content and failed turns retain separate factual review',isolated,async t=>{
  const {result}=await fixture(t,{'report.md':'# Report\n\nObserved value: 42.\n'});
  const grading=spec({turns:[{turnIndex:0,output:{format:'json',equals:{answer:42}}}],artifacts:[{path:'report.md',format:'md',textIncludes:['Observed value: 42.'],textExcludes:['Guaranteed']} ]});
  const observed=await observeWorkflow({task:task({comparison:'artifact'}),spec:grading,result,events:[]});
  assert.deepEqual(observed.bundle.failures,['turn:0']);assert.equal(observed.artifacts[0].technicalPassed,true);
  assert.match(JSON.stringify(observed.bundle.independentObservations),/Observed value: 42/);
  const altered=structuredClone(observed.bundle);altered.independentObservations[0].observed.text='Replaced';
  assert.throws(()=>applyWorkflowReview(altered,review(observed.bundle)),/changed after/);
});

test('unknown or interrupted work keeps its error and cannot gain credit from an empty workspace',async()=>{
  const observed=await observeWorkflow({task:task(),spec:spec(),result:{caseId:'synthetic.fixture.01',attemptId:'unknown',unknownOutcome:true,error:'Interrupted'},events:[]});
  assert.ok(observed.bundle.failures.includes('execution_failed_or_unknown'));assert.ok(observed.bundle.failures.includes('incomplete_turns'));
  assert.equal(applyWorkflowReview(observed.bundle,review(observed.bundle)).passed,false);
});
