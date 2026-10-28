import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {orchestrationHash} from '../../packages/codali/dist/config/OrchestrationConfig.js';
import {benchmarkFingerprint,readPublicCorpus,writeNew,jsonl} from './trust-common.mjs';
const exec=promisify(execFile);
const driver=fileURLToPath(new URL('./run-trust-benchmark.mjs',import.meta.url));
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-trust-harness-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={schemaVersion:1,profile:'test-no-live-model',providers:{local:{adapter:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1'}},models:{model:{provider:'local',catalogId:'test',revision:'1',operations:['chat.completions'],contextWindow:32768,maxOutputTokens:2048,supportsTools:true}},bindings:{lead:{candidates:['model']},router:{useBinding:'lead'},reviewer:{useBinding:'lead'}}};
  const configPath=path.join(root,'config.json');await writeNew(configPath,config);
  const {manifest,cases}=await readPublicCorpus();const task=cases.find(x=>x.split==='development');
  const output=path.join(root,'run');await fs.mkdir(output,{mode:0o700});
  const identity={schemaVersion:1,protocolVersion:'trust-opaque-paths-v2',configHash:orchestrationHash(config),corpusHash:manifest.promptsSha256,fingerprint:await benchmarkFingerprint(),arms:['codali_initial'],taskIds:[task.id],split:'development',timeoutMs:300000};
  await writeNew(path.join(output,'manifest.json'),{identity,createdAt:new Date().toISOString()});
  const args=[driver,'--config',configPath,'--output',output,'--ids',task.id,'--arms','codali_initial'];
  return{root,config,configPath,output,task,args};
}
test('resume retains an interrupted attempt as unknown instead of replaying inference',async t=>{
  const f=await fixture(t);const directory=path.join(f.output,'attempts','interrupted');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(f.output,'ledger.jsonl'),JSON.stringify({type:'start',key:f.task.id+':codali_initial',caseId:f.task.id,arm:'codali_initial',attemptId:'interrupted',directory})+'\n');
  await exec(process.execPath,f.args,{timeout:20000});
  const ledger=await jsonl(path.join(f.output,'ledger.jsonl'));const results=ledger.filter(x=>x.type==='result');
  assert.equal(results.length,1);assert.match(results[0].result.error,/interrupted_unknown/);
  assert.equal(ledger.filter(x=>x.type==='start').length,1);assert.equal(results[0].result.usage.estimated,true);
  await exec(process.execPath,f.args,{timeout:20000});
  assert.equal((await jsonl(path.join(f.output,'ledger.jsonl'))).filter(x=>x.type==='result').length,1);
});
test('an existing runner lock and configuration drift fail before dispatch',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.output,'runner.lock'),'occupied');
  await assert.rejects(exec(process.execPath,f.args,{timeout:20000}),/EEXIST/);
  await fs.unlink(path.join(f.output,'runner.lock'));
  f.config.profile='changed';await fs.writeFile(f.configPath,JSON.stringify(f.config));
  await assert.rejects(exec(process.execPath,f.args,{timeout:20000}),/Run inputs drifted/);
  await assert.rejects(fs.stat(path.join(f.output,'ledger.jsonl')),error=>error.code==='ENOENT');
});
test('held-out execution refuses a missing freeze before creating a run',async t=>{
  const f=await fixture(t);
  await assert.rejects(exec(process.execPath,[driver,'--config',f.configPath,'--output',path.join(f.root,'held-out'),'--split','held_out','--limit','1'],{timeout:20000}),/previously frozen selection/);
  await assert.rejects(fs.stat(path.join(f.root,'held-out')),error=>error.code==='ENOENT');
});
