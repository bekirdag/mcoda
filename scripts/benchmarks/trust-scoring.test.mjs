import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readPublicCorpus,writeNew,json} from './trust-common.mjs';
const exec=promisify(execFile);
const scorer=fileURLToPath(new URL('./score-trust-benchmark.mjs',import.meta.url));

test('host partitions combine only under explicit grouping and identical protocol, with live admission required',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-trust-scoring-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {manifest,cases}=await readPublicCorpus();const held=cases.filter(x=>x.split==='held_out');
  const configs=['a'.repeat(64),'b'.repeat(64)],runs=[];
  for(let host=0;host<2;host++){
    const dir=path.join(root,'host-'+host);runs.push(dir);await fs.mkdir(dir);
    await writeNew(path.join(dir,'manifest.json'),{identity:{configHash:configs[host],corpusHash:manifest.promptsSha256,protocolVersion:'synthetic-report-test',fingerprint:{synthetic:true}}});
    await fs.writeFile(path.join(dir,'events.jsonl'),[
      {type:'model_request',data:{synthetic:true}}, {type:'model_response',data:{synthetic:true}},
      {type:'model_intent',data:{id:'unresolved',reservedTokens:123}},
      {type:'model_receipt',data:{id:'unresolved',status:'outcome_unknown',reservedTokens:123}},
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const records=held.slice(host*100,(host+1)*100).flatMap(task=>['raw_direct','codali_selected'].map(arm=>({type:'result',directory:dir,result:{caseId:task.id,arm,attemptId:task.id+arm,configHash:configs[host],content:'',error:'Synthetic failure for scorer validation; no model ran.',workspacePreserved:true,elapsedMs:1,usage:{tokens:1}}})));
    await fs.writeFile(path.join(dir,'ledger.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n');
  }
  const mapping=path.join(root,'groups.json');await writeNew(mapping,Object.fromEntries(configs.map(x=>[x,'same-candidate-host-pins'])));
  const run=async name=>{const out=path.join(root,name);await exec(process.execPath,[scorer,'--runs',runs.join(','),'--output',out,'--config-groups',mapping],{timeout:20000});return json(path.join(out,'report.json'));};
  const combined=await run('combined');assert.equal(combined.paired.length,1);assert.equal(combined.paired[0].cases,200);assert.equal(combined.paired[0].complete,true);assert.equal(combined.paired[0].numericQualityGate,false);
  assert.equal(combined.aggregates['codali_selected:same-candidate-host-pins'].all.uniqueCases,200);
  assert.equal(combined.aggregates['codali_selected:same-candidate-host-pins'].all.tokens.estimated,200);
  assert.equal(combined.aggregates['codali_selected:same-candidate-host-pins'].all.tokens.sum,200*123);
  assert.ok(combined.criticalReviewPending>0);assert.match(combined.graderSha256,/^[a-f0-9]{64}$/);
  await fs.writeFile(path.join(runs[0],'events.jsonl'),'');
  assert.equal((await run('zero-dispatch')).paired[0].complete,false);
  const manifestPath=path.join(runs[1],'manifest.json');const changed=await json(manifestPath);changed.identity.protocolVersion='different-protocol';await fs.writeFile(manifestPath,JSON.stringify(changed));
  await assert.rejects(run('mixed'),/identical evaluation protocol and runtime/);
});

test('an explicit successful retry never replaces the original failure in primary scores',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-trust-retry-score-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {manifest,cases}=await readPublicCorpus();const task=cases.find(x=>x.id==='general_knowledge.chemical_symbols.01');
  const configHash='c'.repeat(64),dirs=[];
  for(const retry of [false,true]){
    const dir=path.join(root,retry?'retry':'original');dirs.push(dir);await fs.mkdir(dir);
    await writeNew(path.join(dir,'manifest.json'),{identity:{configHash,corpusHash:manifest.promptsSha256,protocolVersion:'synthetic-retry-test',fingerprint:{synthetic:true}}});
    await fs.writeFile(path.join(dir,'events.jsonl'),JSON.stringify({type:'model_request',data:{synthetic:true}})+'\n');
    await fs.writeFile(path.join(dir,'ledger.jsonl'),JSON.stringify({type:'result',directory:dir,result:{caseId:task.id,arm:'codali_selected',attemptId:retry?'retry':'original',
      ...(retry?{retryOf:'original'}:{}),configHash,startedAt:retry?'2026-01-02T00:00:00Z':'2026-01-01T00:00:00Z',content:retry?'{"answer":"H"}':'',error:retry?undefined:'Synthetic original failure',workspacePreserved:true,usage:{tokens:1}}})+'\n');
  }
  const out=path.join(root,'score');await exec(process.execPath,[scorer,'--runs',[...dirs].reverse().join(','),'--output',out],{timeout:20000});
  const report=await json(path.join(out,'report.json'));assert.equal(report.attempts,2);assert.equal(report.primaryAttempts,1);
  assert.equal(report.aggregates['codali_selected:'+configHash].all.passed,0);
  await assert.rejects(exec(process.execPath,[scorer,'--runs',dirs[1],'--output',path.join(root,'missing-original')],{timeout:20000}),/matching original attempt/);
});
