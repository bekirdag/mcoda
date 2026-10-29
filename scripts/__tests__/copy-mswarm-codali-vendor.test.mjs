import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-vendor-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const script=path.join(root,'scripts/copy-mswarm-codali-vendor.mjs');await fs.mkdir(path.dirname(script));await fs.copyFile(new URL('../copy-mswarm-codali-vendor.js',import.meta.url),script);
  for(const name of ['codali','mswarm']){await fs.mkdir(path.join(root,'packages',name,'dist'),{recursive:true});await fs.writeFile(path.join(root,'packages',name,'package.json'),JSON.stringify({dependencies:{fixture:'1'}}));}
  const config=path.join(root,'packages/codali/config');
  for(const name of ['skills/planning','deterministic','documents/__pycache__'])await fs.mkdir(path.join(config,name),{recursive:true});
  for(const name of ['AGENTS.md','docdex-runtime.json','docdex-tools-0.2.99.json','skills/planning/SKILL.md','deterministic/install-python.mjs','deterministic/requirements.txt','documents/install-python.mjs','documents/requirements.txt','documents/worker.py','documents/__pycache__/worker.pyc','documents/.env','unrelated-private.json'])await fs.writeFile(path.join(config,name),name);
  await fs.writeFile(path.join(root,'packages/codali/dist/index.js'),'export const fixture=true;');
  await fs.writeFile(path.join(root,'packages/codali/dist/fixture.test.js'),'must not ship');
  const dest=path.join(root,'packages/mswarm/dist/vendor');
  return {root,script,config,dest,run:()=>promisify(execFile)(process.execPath,[script])};
}

test('vendor includes runtime catalogs, document/deterministic installers and skills without tests or local residue',async t=>{
  const {run,dest}=await fixture(t);await run();
  for(const name of ['AGENTS.md','docdex-runtime.json','docdex-tools-0.2.99.json','skills/planning/SKILL.md','deterministic/install-python.mjs','documents/requirements.txt','documents/worker.py'])assert.equal(await fs.readFile(path.join(dest,'config',name),'utf8'),name);
  assert.match(await fs.readFile(path.join(dest,'codali/index.js'),'utf8'),/fixture=true/);
  for(const name of ['codali/fixture.test.js','config/documents/__pycache__','config/documents/.env','config/unrelated-private.json'])await assert.rejects(fs.access(path.join(dest,name)));
});

test('dependency drift and missing runtime assets refuse before replacing the previous build',async t=>{
  const {run,root,config,dest}=await fixture(t);await run();
  const sentinel=path.join(dest,'codali/keep');await fs.writeFile(sentinel,'old');
  await fs.writeFile(path.join(root,'packages/mswarm/package.json'),JSON.stringify({dependencies:{fixture:'2'}}));await assert.rejects(run(),/dependency fixture@1/);assert.equal(await fs.readFile(sentinel,'utf8'),'old');
  await fs.writeFile(path.join(root,'packages/mswarm/package.json'),JSON.stringify({dependencies:{fixture:'1'}}));await fs.unlink(path.join(config,'docdex-tools-0.2.99.json'));await assert.rejects(run(),/asset is missing/);assert.equal(await fs.readFile(sentinel,'utf8'),'old');
});
