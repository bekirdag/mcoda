import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeRuntime,validateRuntime } from './generalization-freeze.mjs';

test('snapshot cannot drift and launchers bind the frozen runtime',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codali-freeze-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pkg=path.join(root,'pkg'),bench=path.join(root,'bench'),destination=path.join(root,'frozen');
  for(const d of ['dist','config','scripts','node_modules'])await fs.mkdir(path.join(pkg,d),{recursive:true});
  await fs.mkdir(bench);await fs.writeFile(path.join(pkg,'dist','index.js'),'export const version=1;');
  await fs.writeFile(path.join(pkg,'package.json'),'{}');const lock=path.join(root,'lock');await fs.writeFile(lock,'pinned');
  await fs.writeFile(path.join(bench,'attempt.mjs'),"import '../../packages/codali/dist/index.js';");
  await freezeRuntime({packageRoot:pkg,benchmarkRoot:bench,destination,dependencyLock:lock});await validateRuntime(destination);
  assert.match(await fs.readFile(path.join(destination,'benchmarks','attempt.mjs'),'utf8'),/file:.*frozen\/dist\/index.js/);
  await fs.writeFile(path.join(pkg,'dist','index.js'),'export const version=2;');await validateRuntime(destination);
  await fs.writeFile(path.join(destination,'config','drift.json'),'{}');await assert.rejects(validateRuntime(destination),/changed/);
  await fs.unlink(path.join(destination,'config','drift.json'));await fs.writeFile(lock,'drift');await assert.rejects(validateRuntime(destination),/changed/);
  await assert.rejects(freezeRuntime({packageRoot:pkg,benchmarkRoot:bench,destination,dependencyLock:lock}),/EEXIST/);
});
