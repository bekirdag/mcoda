import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {readWorkflowCorpus} from './trust-workflow-protocol.mjs';
import {provisionAppWorkspace} from './complex52-workspace.mjs';
import {hash} from './trust-common.mjs';
const root=path.resolve('docs/benchmarks/codali-complex52');
test('52 fresh frozen specifications have separate complete scoring rubrics',async()=>{
 const all=[];
 for(const [name,count] of [['tasks',50],['apps',2]]){
  const {cases,manifest}=await readWorkflowCorpus(path.join(root,name));assert.equal(cases.length,count);
  const bytes=await fs.readFile(path.join(root,name,'grading.jsonl'));assert.equal(hash(bytes),manifest.gradingSha256);
  const gold=bytes.toString().trim().split('\n').map(JSON.parse);assert.equal(gold.length,count);
  for(const task of cases){const spec=gold.find(g=>g.id===task.id);assert.ok(spec);assert.equal(spec.criteria.reduce((n,c)=>n+c.weight,0),100);assert.equal(task.split,'validation');assert.equal(task.criteria,undefined);assert.ok(!Object.keys(task.files).some(p=>p.includes('grading')));all.push(task.prompt);}
  if(name==='tasks'){assert.equal(cases.filter(c=>c.execution.web).length,10);assert.ok(cases.every(c=>!c.execution.writes&&c.comparison==='answer'));}
  else assert.ok(cases.every(c=>c.execution.writes&&c.files['RFP.md']&&c.comparison==='implementation'));
 }
 assert.equal(new Set(all).size,52);
 const old=await fs.readFile('docs/benchmarks/codali-industry50/prompts.jsonl','utf8');
 for(const prompt of all)assert.ok(!old.includes(JSON.stringify(prompt)));
});
test('answer provisioning does not instruct app construction or overwrite evidence',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'complex52-provision-'));
 try{await fs.writeFile(path.join(dir,'evidence.txt'),'keep');await provisionAppWorkspace(dir,{comparison:'answer'});const env=await fs.readFile(path.join(dir,'ENVIRONMENT.md'),'utf8');assert.match(env,/read-only evidence/);assert.ok(!env.includes('Source starts empty'));assert.equal(await fs.readFile(path.join(dir,'evidence.txt'),'utf8'),'keep');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('implementation provisioning retains build prerequisites and immutable input guidance',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'complex52-build-'));try{await provisionAppWorkspace(dir,{comparison:'implementation',domain:'web'});const env=await fs.readFile(path.join(dir,'ENVIRONMENT.md'),'utf8');assert.match(env,/Node22/);assert.match(env,/RFP.md and ENVIRONMENT.md are immutable/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
