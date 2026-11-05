// Independent evaluator support. Never imported by the frozen generation runner.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {snapshotWorkflowWorkspace,excludedNames} from './appbuild-workspace.mjs';
import {createIsolatedExecutor} from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
const exec=promisify(execFile);
const state='/home/wodo/.local/state/codali-appbuild5';
export const reviewRoot='/home/wodo/apps/codali-appbuild-results/2026-11-04';
export async function collectCompleted(){
 const ledger=(await fs.readFile(`${state}/run/ledger.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
 const collected=[];
 for(const row of ledger.filter(r=>r.type==='result')){
  const key=`${row.result.caseId}-${row.result.arm}`,dest=path.join(reviewRoot,key);
  try{await fs.access(path.join(dest,'submission.json'));collected.push(key);continue;}catch{}
  const location=JSON.parse(await fs.readFile(path.join(row.directory,'runtime-location.json'),'utf8'));
  const original=location.workspace,before=await snapshotWorkflowWorkspace(original);
  await fs.mkdir(dest,{recursive:true});
  const source=path.join(dest,'source');
  await fs.cp(original,source,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false,filter:p=>!path.relative(original,p).split(path.sep).some(x=>excludedNames.has(x))});
  const after=await snapshotWorkflowWorkspace(original),copy=await snapshotWorkflowWorkspace(source);
  if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(before)!==JSON.stringify(copy))throw Error(`Snapshot changed: ${key}`);
  await fs.mkdir(path.join(dest,'receipts'),{recursive:true});
  for(const name of ['result.json','events.jsonl','runtime-location.json'])await fs.copyFile(path.join(row.directory,name),path.join(dest,'receipts',name));
  await fs.writeFile(path.join(dest,'source-sha256.json'),JSON.stringify(copy,null,2)+'\n');
  await exec('tar',['-czf',path.join(dest,'source.tar.gz'),'-C',dest,'source']);
  await fs.cp(source,path.join(dest,'evaluation'),{recursive:true,dereference:false,verbatimSymlinks:true});
  await fs.writeFile(path.join(dest,'submission.json'),JSON.stringify({key,original,attemptDirectory:row.directory,collectedAt:new Date().toISOString(),sourceFiles:Object.keys(copy).length,result:row.result},null,2)+'\n');
  collected.push(key);
 }
 return collected;
}
export async function evaluateCommand(key,label,command,{timeoutMs=600000,runtimeRoots=[]}={}){
 if(!/^[\w-]+$/.test(key)||!/^[\w-]+$/.test(label))throw Error('Invalid evaluation label');
 const dest=path.join(reviewRoot,key),workspaceRoot=path.join(dest,'evaluation');
 await fs.mkdir(path.join(dest,'checks'),{recursive:true});
 const startedAt=new Date().toISOString();let result;
 try{result=await createIsolatedExecutor({network:true,readOnlyRuntimeRoots:runtimeRoots})('bash',['-lc',command],{workspaceRoot,allowedWritePaths:[workspaceRoot],shellTimeoutMs:timeoutMs,maxOutputBytes:2000000});}
 catch(error){result={error:String(error),...error.details};}
 const receipt={label,command,startedAt,finishedAt:new Date().toISOString(),workspaceRoot,result};
 await fs.writeFile(path.join(dest,'checks',`${label}.json`),JSON.stringify(receipt,null,2)+'\n');
 return receipt;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 if(process.argv[2]==='collect')console.log(JSON.stringify(await collectCompleted()));
 else if(process.argv[2]==='command')console.log(JSON.stringify(await evaluateCommand(process.argv[3],process.argv[4],process.argv[5])));
 else throw Error('Use collect or command KEY LABEL SHELL_COMMAND');
}
