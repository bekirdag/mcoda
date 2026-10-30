import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { terminalClientBuildHash } from '../../packages/codali/dist/eval/TerminalCorpusRunner.js';
export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const corpusRoot = path.join(repository, 'docs/benchmarks/codali-1000');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const jsonl = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
export async function writeNew(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2)+'\n', {flag:'wx',mode:0o600}); }
export function argumentsMap(args = process.argv.slice(2), allowed) {
  const out = {};
  for (let i=0;i<args.length;i++) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('Expected unique --name value arguments');
    const name=args[i].slice(2);
    if(Object.hasOwn(out,name))throw Error('Expected unique --name value arguments');
    if(allowed&&!allowed.includes(name))throw Error('Unknown argument: --'+name);
    out[name]=args[++i];
  }
  return out;
}
export async function benchmarkFingerprint() {
  const extras = ['pnpm-lock.yaml','packages/codali/package.json','packages/codali/config/AGENTS.md',
    'packages/codali/config/docdex-tools-0.2.99.json', 'packages/codali/config/deterministic/requirements.txt', 'packages/codali/config/documents/requirements.txt',
    'scripts/benchmarks/trust-common.mjs','scripts/benchmarks/trust-attempt.mjs','scripts/benchmarks/trust-full-tools.mjs','scripts/benchmarks/run-trust-benchmark.mjs'];
  const files = Object.fromEntries(await Promise.all(extras.map(async file => [file,hash(await fs.readFile(path.join(repository,file)))])));
  // These workspace dependencies can be linked by pnpm and must not silently drift.
  const dependencies = {};
  for (const name of ['shared','db']) dependencies[name] = await terminalClientBuildHash(path.join(repository,'packages',name,'dist'));
  return {client:await terminalClientBuildHash(),files,dependencies,node:process.version,platform:process.platform,arch:process.arch};
}
export const hasToolBaseline = task => task.domain === 'repository_and_docdex' || ['calculation','full'].includes(task.toolParity);
export async function readPublicCorpus(directory=corpusRoot) {
  const manifest=await json(path.join(directory,'manifest.json'));
  const bytes=await fs.readFile(path.join(directory,'prompts.jsonl'));
  if(hash(bytes)!==manifest.promptsSha256)throw Error('Public corpus hash mismatch');
  return {manifest,cases:bytes.toString().trim().split('\n').map(JSON.parse)};
}
export async function fixtureSnapshot(root) {
  const files={};
  async function visit(relative='') {
    for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
      const rel=path.posix.join(relative,entry.name);
      if(entry.isDirectory())await visit(rel);
      else if(entry.isFile())files[rel]=hash(await fs.readFile(path.join(root,rel)));
      else files[rel]='NONREGULAR';
    }
  }
  await visit();return files;
}
