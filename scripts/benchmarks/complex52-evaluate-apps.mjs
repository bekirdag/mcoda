// Post-run independent checks on copies. No generated source is repaired.
import {promises as fs} from 'node:fs';import path from 'node:path';import net from 'node:net';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';
import {createIsolatedExecutor} from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import {snapshotWorkflowWorkspace} from './appbuild-workspace.mjs';
const exec=promisify(execFile),root=process.argv[2];
if(!root||!path.isAbsolute(root))throw Error('Supply absolute exported app-results directory');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const availablePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
for(const name of (await fs.readdir(root)).filter(n=>/^build-0[12]-(custody|workshop)-(raw_tools|codali_candidate)$/.test(n)).sort()){
 const folder=path.join(root,name),source=path.join(folder,'project'),workspace=path.join(folder,'evaluation'),checks=path.join(folder,'checks');
 try{await fs.access(path.join(checks,'summary.json'));console.log(name+' already evaluated');continue;}catch{}
 await fs.mkdir(checks,{recursive:true});const before=await snapshotWorkflowWorkspace(source);
 await fs.cp(source,workspace,{recursive:true,dereference:false,errorOnExist:true,force:false});
 const isolated=createIsolatedExecutor({network:true});
 const prefix='export DATABASE_PATH="$PWD/.evaluation-data.sqlite"; export NOW=2033-01-01T00:00:00Z; ';
 const receipts=[];
 async function command(label,script,timeout=180000){
  const start=Date.now();let result;
  try{result=await isolated('bash',['-lc',prefix+script],{workspaceRoot:workspace,allowedWritePaths:[workspace],shellTimeoutMs:timeout,maxOutputBytes:1000000});}
  catch(e){result={error:String(e),details:e.details};}
  const r={label,script,elapsedMs:Date.now()-start,result};receipts.push(r);await fs.writeFile(path.join(checks,label+'.json'),JSON.stringify(r,null,2));return r;
 }
 await command('install','if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi',300000);
 await command('setup','npm run setup');await command('build','npm run build');await command('declared-tests','npm test',180000);
 const port=await availablePort(),base=`http://127.0.0.1:${port}`,abort=new AbortController();let serverExited=false;
 const server=isolated('bash',['-lc',prefix+`export PORT=${port} APP_PORT=${port}; npm start`],{workspaceRoot:workspace,allowedWritePaths:[workspace],shellTimeoutMs:180000,maxOutputBytes:500000,signal:abort.signal}).then(result=>({result}),error=>({error:String(error),details:error.details})).finally(()=>{serverExited=true;});
 let ready=false,api,browser;
 try{
  for(let i=0;i<60&&!serverExited;i++){try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok&&(await r.json()).ok===true){ready=true;break;}}catch{}await pause(500);}
  if(ready){
   const kind=name.includes('custody')?'custody':'workshop';
   try{const r=await exec(process.execPath,[path.resolve('scripts/benchmarks/complex52-app-checks.mjs'),kind,base],{timeout:90000,maxBuffer:1000000});api=JSON.parse(r.stdout);}catch(e){api={error:String(e),stdout:e.stdout,stderr:e.stderr};}
   await fs.writeFile(path.join(checks,'independent-api.json'),JSON.stringify(api,null,2));
   let engine;
   try{
    const require=createRequire('/home/wodo/.local/state/codali-complex52-20261105/browser-tools/package.json');const {chromium}=require('playwright');
    engine=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});const context=await engine.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));await page.goto(base,{waitUntil:'networkidle',timeout:20000});
    await page.screenshot({path:path.join(checks,'login-desktop.png'),fullPage:true});
    await page.getByLabel('Email',{exact:true}).fill(kind==='custody'?'admin@north.test':'manager@birch.test');
    await page.getByLabel('Password',{exact:true}).fill('Demo-Forest-731!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForTimeout(1500);
    await page.screenshot({path:path.join(checks,'signed-in-desktop.png'),fullPage:true});
    const desktop=await page.evaluate(()=>({text:document.body.innerText.slice(0,15000),overflow:document.documentElement.scrollWidth>innerWidth,unlabeledInputs:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')).length}));
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(checks,'signed-in-mobile.png'),fullPage:true});
    const mobile=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText.slice(0,15000)}));
    await page.keyboard.press('Tab');const focused=await page.evaluate(()=>document.activeElement?.tagName);
    browser={desktop,mobile,focused,errors,url:page.url()};
   }catch(e){browser={error:String(e)};}finally{await engine?.close();}
   await fs.writeFile(path.join(checks,'browser.json'),JSON.stringify(browser,null,2));
  }
 }finally{abort.abort(Error('Independent checks finished'));await fs.writeFile(path.join(checks,'server.json'),JSON.stringify({ready,base,...await server},null,2));}
 const after=await snapshotWorkflowWorkspace(source);if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Original submission changed during evaluation');
 await fs.writeFile(path.join(checks,'summary.json'),JSON.stringify({name,sourcePreserved:true,serverReady:ready,productReady:null,readinessNote:'Server startup is not product acceptance; manual rubric review remains required.',api,browser,commands:receipts.map(r=>({label:r.label,result:r.result,elapsedMs:r.elapsedMs}))},null,2));
 console.log(JSON.stringify({name,serverReady:ready,productReady:null,apiPassed:api?.passed,apiTotal:api?.total,browserError:browser?.error}));
}
