import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowTools, runRawWorkflow, validateWorkflowExecution, workflowControllerOptions } from './trust-workflow.mjs';
import { executorStatus } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { gradeArtifact } from './trust-artifacts.mjs';

const base = { writes: false, web: false, media: false, effort: 'low', deadlineMs: 30000 };
const limits = { maxSteps: 6, maxToolCalls: 8, maxOutputTokens: 1024 };
async function fixture(t, execution = base, extra = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-workflow-fixture-')); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let starts = 0, events = [];
  const tools = await createWorkflowTools({ workspace, execution, initialTools: [], startDocdex: async () => { starts++; throw Error('No Docdex used in this fixture'); }, onToolEvent: (type,data) => events.push({type,data}), ...extra });
  return { workspace, tools, events, starts: () => starts };
}
const call = (name,args,id = name) => ({ name,args,id });
const response = calls => ({ message: { role: 'assistant', content: '', toolCalls: calls }, toolCalls: calls });
const final = content => ({ message: { role: 'assistant', content } });

test('workflow permissions are frozen and candidate/raw capability grants agree', async t => {
  for (const execution of [{ ...base, media: true }, { ...base, network: true }, { ...base, deadlineMs: 0 }, { ...base, writes: 'yes' }]) assert.throws(() => validateWorkflowExecution(execution));
  const candidate = workflowControllerOptions({ ...base, web: true }); assert.equal(candidate.permissions, 'ask'); assert.equal(candidate.allowWeb, true); assert.equal(candidate.allowNetwork, false);
  const { tools, starts } = await fixture(t);
  for (const name of ['write_file','document_create','run_shell','browser_open','docdex_web_research','tnl_read','media_generate_image']) assert.equal(tools.registry.list().some(tool => tool.name === name),false,name);
  assert.equal(starts(),0);
  const described = await tools.execute(call('tools_describe',{names:['document_read','server_time']})); assert.equal(described.ok,true);
  const unavailable=await tools.execute(call('write_file',{path:'x.txt',content:'bad'}));assert.equal(unavailable.ok,false);assert.match(unavailable.error.message,/Unadvertised/);
});

test('raw model creates a real document through the same tools without answer rewriting', { skip: !executorStatus().available }, async t => {
  const { workspace,tools,events,starts } = await fixture(t,{...base,writes:true}); let requests = 0;
  const script = [response([call('tools_describe',{names:['document_create','document_read']})]),
    response([call('document_create',{path:'report.pdf',format:'pdf',blocks:[{type:'paragraph',text:'Recorded total: 42 EUR.'}]})]),
    response([call('document_read',{path:'report.pdf'})]),final('Exact unmodified model answer.')];
  const provider = { async generate(request) { requests++; if(requests===4)assert.match(request.messages.at(-1).content,/42 EUR/);return script.shift(); } };
  const result = await runRawWorkflow({provider,tools,messages:[{role:'user',content:'Document fixture'}],limits});
  assert.equal(result.content,'Exact unmodified model answer.'); assert.equal(result.toolCalls,3); assert.equal(starts(),0);
  assert.equal(events.filter(event=>event.type==='tool_receipt').length,3);
  assert.equal((await gradeArtifact(workspace,{path:'report.pdf',format:'pdf',textIncludes:['42 EUR']})).technicalPassed,true);
});

test('shell workspace writes are explicit and do not escape into host/control paths', { skip: !executorStatus().available }, async t => {
  const {workspace,tools} = await fixture(t,{...base,writes:true});
  await fs.mkdir(path.join(workspace,'.mcoda')); await fs.writeFile(path.join(workspace,'.mcoda','keep'),'preserve');
  await tools.execute(call('tools_describe',{names:['run_shell','write_file']}));
  const denied = await tools.execute(call('run_shell',{command:'node',args:['-e',"require('fs').writeFileSync('result.txt','value')"]}));
  assert.equal(denied.ok,false);await assert.rejects(fs.access(path.join(workspace,'result.txt')));
  const allowed = await tools.execute(call('run_shell',{command:'node',args:['-e',"require('fs').writeFileSync('result.txt','value')"],writePaths:['.']}));
  assert.equal(allowed.ok,true,JSON.stringify(allowed.error));assert.equal(await fs.readFile(path.join(workspace,'result.txt'),'utf8'),'value');
  for(const scope of ['../','/tmp','.mcoda']){const refused=await tools.execute(call('run_shell',{command:'node',args:['-e','0'],writePaths:[scope]}));assert.equal(refused.ok,false);assert.match(refused.error.message,/scope|escapes|authorized/);}
  const control = await tools.execute(call('write_file',{path:'.mcoda/keep',content:'changed'}));assert.equal(control.ok,false);
  assert.equal(await fs.readFile(path.join(workspace,'.mcoda','keep'),'utf8'),'preserve');
});

test('tool failures are observable, budgets and cancellation stop further calls, and text markup never executes', async t => {
  const {tools,events}=await fixture(t);let requests=0;
  const printed=await runRawWorkflow({provider:{generate:async()=>{requests++;return final('<tool_call>write_file</tool_call>');}},tools,messages:[],limits});
  assert.equal(requests,1);assert.equal(printed.toolCalls,0);assert.equal(events.length,0);
  await assert.rejects(runRawWorkflow({provider:{generate:async()=>response([call('tools_describe',{})])},tools,messages:[],limits:{...limits,maxToolCalls:1}}),/tool budget/);
  await assert.rejects(runRawWorkflow({provider:{generate:async()=>response([call('tools_describe',{})])},tools,messages:[],limits:{...limits,maxSteps:1}}),/step budget/);
  const abort=AbortSignal.abort(Error('stop fixture'));await assert.rejects(runRawWorkflow({provider:{generate:async()=>{throw Error('must not run');}},tools,messages:[],limits,signal:abort}),/stop fixture/);
  let step=0;const recovered=await runRawWorkflow({provider:{generate:async request=>{if(!step++)return response([call('unavailable',{})]);assert.match(request.messages.at(-1).content,/Unadvertised/);return final('Tool unavailable; no action performed.');}},tools,messages:[],limits});
  assert.equal(recovered.content,'Tool unavailable; no action performed.');assert.ok(events.some(event=>event.type==='tool_receipt'&&event.data.receipt.ok===false));
});

test('local media submission and waiting are exposed only with explicit capability; no model inference in fixture', async t => {
  let submissions=0;const mediaStore={submit:async()=>{submissions++;return{id:'fixture-job',status:'queued'};},reconcileProcess:async()=>({id:'fixture-job',status:'succeeded',artifact:{sha256:'fixture'}})};
  const {tools}=await fixture(t,{...base,writes:true,media:true},{resolved:{config:{bindings:{image:{candidates:['fixture']}}}},mediaStore});
  await tools.execute(call('tools_describe',{names:['media_generate_image','media_job_wait']}));
  assert.equal((await tools.execute(call('media_generate_image',{prompt:'test fixture'}))).ok,true);
  assert.equal((await tools.execute(call('media_job_wait',{jobId:'fixture-job',waitSeconds:1}))).ok,true);
  assert.equal(submissions,1);
});

test('raw comparator can discover and read the real builtin planning skill without hidden policy injection', async t => {
  const {tools, starts}=await fixture(t);
  assert.equal(tools.schemas().some(tool=>tool.name==='skill_load'),false);
  await tools.execute(call('tools_describe',{names:['skill_list','skill_load','skill_read']}));
  const listed=await tools.execute(call('skill_list',{query:'planning'}));assert.equal(listed.ok,true);
  const skills=JSON.parse(listed.output).skills;assert.ok(skills.length>0);
  assert.ok(skills.every(skill=>!skill.id.startsWith('user')));
  const selected=skills.find(skill=>skill.id.startsWith('builtin:'));assert.ok(selected);
  const loaded=await tools.execute(call('skill_load',{id:selected.id}));assert.equal(loaded.ok,true);
  assert.match(JSON.parse(loaded.output).content,/planning/i);
  const escaped=await tools.execute(call('skill_read',{id:selected.id,path:'../../../../../../etc/passwd'}));assert.equal(escaped.ok,false);
  assert.equal(starts(),0);
  const initial=await fixture(t,base,{initialTools:['skill_list']});assert.ok(initial.tools.schemas().some(tool=>tool.name==='skill_list'));
});
