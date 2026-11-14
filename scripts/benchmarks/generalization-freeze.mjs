// Runtime snapshots for prospective old/new/raw comparisons. Never reads gold.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function inventory(root, directories) {
  const files = {};
  const visit = async relative => {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Snapshot contains a symbolic link inside runtime assets: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files[file] = digest(await fs.readFile(path.join(root,file)));
    }
  };
  for (const directory of directories) await visit(directory);
  return files;
}

export async function freezeRuntime({ packageRoot, benchmarkRoot, destination, dependencyLock }) {
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  for (const directory of ['dist','config','scripts']) await fs.cp(path.join(packageRoot,directory),path.join(destination,directory),{recursive:true,errorOnExist:true,force:false});
  await fs.copyFile(path.join(packageRoot,'package.json'),path.join(destination,'package.json'));
  // Dependencies are shared, pinned by the repository lockfile. Its hash is
  // checked before each attempt; this is not a fully hermetic OS snapshot.
  await fs.symlink(path.join(packageRoot,'node_modules'),path.join(destination,'node_modules'),'dir');
  const target = path.join(destination,'benchmarks'); await fs.mkdir(target);
  for (const entry of await fs.readdir(benchmarkRoot)) {
    if (!entry.endsWith('.mjs')) continue;
    const original = await fs.readFile(path.join(benchmarkRoot,entry),'utf8');
    const rewritten = original.replaceAll('../../packages/codali/dist/',pathToFileURL(path.join(destination,'dist')).href+'/');
    await fs.writeFile(path.join(target,entry),rewritten,{flag:'wx'});
  }
  const manifest = { schemaVersion:1,createdAt:new Date().toISOString(),
    files:await inventory(destination,['dist','config','scripts','benchmarks']),
    packageSha256:digest(await fs.readFile(path.join(destination,'package.json'))),
    dependencyLock,dependencyLockSha256:digest(await fs.readFile(dependencyLock)),
    limitations:['Node dependencies and operating system are shared; lockfile and runtime assets are checked before each attempt.'] };
  await fs.writeFile(path.join(destination,'runtime-freeze.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}

export async function validateRuntime(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root,'runtime-freeze.json'),'utf8'));
  const actual = await inventory(root,['dist','config','scripts','benchmarks']);
  if (JSON.stringify(actual)!==JSON.stringify(manifest.files)
    || digest(await fs.readFile(path.join(root,'package.json')))!==manifest.packageSha256
    || digest(await fs.readFile(manifest.dependencyLock))!==manifest.dependencyLockSha256) throw Error('Frozen runtime or dependency lock changed; create a new study');
  return manifest;
}
