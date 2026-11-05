// Assisted development repairs, never replacements for frozen benchmark submissions.
import { promises as fs, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtimeRoot=process.env.CODALI_REPAIR_RUNTIME_ROOT ?? fileURLToPath(new URL('../../packages/codali/dist',import.meta.url));
if(!path.isAbsolute(runtimeRoot))throw Error('Runtime root must be absolute');
for(const asset of ['tools/deterministic/node-worker.cjs','tools/deterministic/python-worker.py','tools/documents/worker.py'])await fs.access(path.join(runtimeRoot,asset));
const {SessionController}=await import(pathToFileURL(path.join(runtimeRoot,'runtime/SessionController.js')).href);
const {loadOrchestrationConfig,orchestrationHash}=await import(pathToFileURL(path.join(runtimeRoot,'config/OrchestrationConfig.js')).href);
import { provisionAppWorkspace, snapshotWorkflowWorkspace, excludedNames } from './appbuild-workspace.mjs';

const [output, configFile, sourceRoot, ...ids] = process.argv.slice(2);
if (![output, sourceRoot].every(x=>x && path.isAbsolute(x)) || !ids.length || ids.some(x=>!/^app-0[1-5]-(?:web|desktop|ios|ios-game|android)-(?:codali_candidate|raw_tools)$/.test(x))) throw Error('Use new absolute output, config, original results root and explicit submission IDs');
await fs.mkdir(path.dirname(output), {recursive:true,mode:0o700});
await fs.mkdir(output, {mode:0o700});
const {config: original}=await loadOrchestrationConfig(configFile), config=structuredClone(original);
config.profile='assisted-app-remediation-v2-planned';
config.taskControl={maxWritingTasksPerWorktree:1,maxConcurrentHelpers:1,helpers:'read-only-or-draft',repeatedFailureThreshold:3,repairAttemptsBeforeReplan:2,checkpointOn:['task-transition','before-compaction','before-exit'],reviewPolicy:'risk-and-evidence',...config.taskControl,requirePlan:true,initialTools:['read_file','write_file','create_directory','prepare_edit','run_shell','list_files','docdex_search','docdex_open','work_claim','work_rescope','work_refine','work_plan','work_decision','work_verify','work_complete','skill_load']};
config.models['repair-balanced']={provider:'mswarm',catalogId:'qwen-latest-flash-next',revision:'catalog-unversioned',operations:['chat.completions'],backend:'strata',contextWindow:65536,maxOutputTokens:4096,supportsTools:true,supportsStreaming:false};
config.bindings.lead={candidates:['repair-balanced']};
if(process.env.CODALI_REPAIR_REASONING_BUDGET){
 const budget=Number(process.env.CODALI_REPAIR_REASONING_BUDGET);
 if(!Number.isInteger(budget)||budget<1||budget>4096)throw Error('Invalid diagnostic reasoning budget');
 config.models['repair-balanced'].reasoning={medium:{reasoning_effort:'low',reasoning_budget_tokens:budget}};
}
config.effort={medium:{maxTotalTokens:1000000,maxModelCalls:100,maxToolCalls:200,maxSteps:180,maxOutputTokens:4096,timeoutMs:3600000}};
const resolved={config,hash:orchestrationHash(config),source:'assisted development repair, not benchmark'};
const sha=text=>createHash('sha256').update(text).digest('hex');
const inventory=await fs.readFile(new URL('../../docs/benchmarks/codali-appbuild5/CODALI_ISSUES.md',import.meta.url),'utf8');
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({kind:'assisted-development-repair-not-blind-benchmark',ids,sourceRoot,configHash:resolved.hash,runtimeRoot,runtimeHash:sha(await fs.readFile(path.join(runtimeRoot,'runtime/SessionController.js'))),startedAt:new Date().toISOString()},null,2));
await fs.cp(runtimeRoot,path.join(output,'runtime'),{recursive:true,errorOnExist:true,force:false});
for(const id of ids){
  const dir=path.join(output,id), workspace=path.join(dir,'workspace'), source=path.join(sourceRoot,id,'source');
  await fs.mkdir(dir,{mode:0o700});
  await fs.cp(source,workspace,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true,filter:src=>!path.relative(source,src).split(path.sep).some(p=>excludedNames.has(p)||p==='tools'||/\.(?:tar|tar\.gz|zip)$/.test(p))});
  // Archived submissions are read-only. Change modes only in this new copy;
  // never follow a copied symlink back into the frozen submission.
  async function writableCopy(dir){
    await fs.chmod(dir,0o700);
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const target=path.join(dir,entry.name);
      if(entry.isDirectory())await writableCopy(target);
      else if(entry.isFile())await fs.chmod(target,(await fs.stat(target)).mode|0o600);
    }
  }
  await writableCopy(workspace);
  const app=id.replace(/-(codali_candidate|raw_tools)$/,''), domain=app.replace(/^app-0\d-/,'');
  const canonical=await fs.readFile(new URL(`../../docs/benchmarks/codali-appbuild5/rfps/${app}.md`,import.meta.url),'utf8');
  const originalRfp=await fs.readFile(path.join(workspace,'RFP.md'),'utf8').catch(()=>null);
  await fs.writeFile(path.join(dir,'input-provenance.json'),JSON.stringify({originalRfpSha256:originalRfp===null?null:sha(originalRfp),canonicalRfpSha256:sha(canonical),note:'New repair copy restores canonical requirements; original submission untouched.'},null,2));
  await fs.writeFile(path.join(workspace,'RFP.md'),canonical);
  await provisionAppWorkspace(workspace,{domain});
  const review=await fs.readFile(path.join(sourceRoot,id,'REVIEW.md'),'utf8');
  const relevant=inventory.split(/(?=\n## )/).filter(section=>section.includes(`/${id}/`) && /## APP-/.test(section)).join('\n');
  await fs.writeFile(path.join(workspace,'REPAIR_FINDINGS.md'),review+'\n\n'+relevant);
  config.taskControl.immutableInputs=['RFP.md','ENVIRONMENT.md','REPAIR_FINDINGS.md',...(domain==='android'?['.toolchain']:[])];
  resolved.hash=orchestrationHash(config);
  await fs.writeFile(path.join(dir,'before.json'),JSON.stringify(await snapshotWorkflowWorkspace(workspace),null,2));
  const controller=new SessionController({workspaceRoot:workspace,storageRoot:path.join(dir,'state'),resolved,effort:'medium',permissions:'workspace',allowNetwork:true,allowWeb:true,allowMemory:false,userInstructionsPath:false,onEvent:event=>{if(event.type!=='token')appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify(event)+'\n');}});
  const started=Date.now();let answer,error;
  try{answer=await controller.run('Repair and complete this application end to end against RFP.md. Read RFP.md, ENVIRONMENT.md and REPAIR_FINDINGS.md first; these are immutable. The existing source is an incomplete prior attempt, not an authoritative design. Fix the documented defects and complete missing requirements. Establish a runnable entrypoint/build first, then implement and test all behavior, including authorization, transactions, edge cases and UI states. Use Docdex and available tools. Deliver real tests, README, DELIVERY.md and delivery.json. Report any validation that requires another platform honestly. This is an assisted repair job, not a fresh benchmark; do not claim original scores changed.');}catch(cause){error=String(cause);}
  const after=await snapshotWorkflowWorkspace(workspace);
  const result={id,answer,error,sessionId:controller.sessionId,usage:controller.usageSnapshot(),elapsedMs:Date.now()-started,rfpPreserved:sha(await fs.readFile(path.join(workspace,'RFP.md')))==sha(canonical),independentlyValidated:false};
  await fs.writeFile(path.join(dir,'after.json'),JSON.stringify(after,null,2));
  await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
