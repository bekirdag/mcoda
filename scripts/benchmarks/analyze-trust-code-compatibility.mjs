import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedExecutor } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { equalTrustValue } from '../../packages/codali/dist/eval/TrustBenchmark.js';
import { argumentsMap, hash, json, jsonl, readPublicCorpus, writeNew } from './trust-common.mjs';

// These three prompts omit a module format. Debugging prompts supply ESM code.
export const affectedFamilies = new Set([
  'code_generation.lru_simulation',
  'code_generation.html_text_escape',
  'code_generation.interval_pair_intersection',
]);

export async function observeCode(source, inputs, extension) {
  if (!['.mjs', '.cjs'].includes(extension)) throw Error('Unsupported module extension');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 65536) throw Error('Missing or oversized code');
  if (!Array.isArray(inputs) || !inputs.length) throw Error('Missing independent inputs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-compat-'));
  try {
    await fs.chmod(root, 0o700);
    await fs.writeFile(path.join(root, `submission${extension}`), source, { flag: 'wx', mode: 0o600 });
    await writeNew(path.join(root, 'inputs.json'), inputs);
    // No expected values or host credentials enter the submission sandbox.
    await fs.writeFile(path.join(root, 'observe.mjs'), `import {readFileSync} from 'node:fs';
const stringify=JSON.stringify.bind(JSON),parse=JSON.parse.bind(JSON),output=process.stdout.write.bind(process.stdout);
const inputs=parse(readFileSync(new URL('./inputs.json',import.meta.url),'utf8'));
const mod=await import('./submission${extension}');
const solve=typeof mod.solve==='function'?mod.solve:typeof mod.default?.solve==='function'?mod.default.solve:mod.default;
if(typeof solve!=='function')throw Error('No exported callable');
const observations=[];
for(const input of inputs){const before=stringify(input);const value=await solve(input);observations.push({value,unchanged:before===stringify(input)});}
output(stringify(observations));`, { flag: 'wx', mode: 0o600 });
    const execute = createIsolatedExecutor({ network: false });
    const observed = await execute(process.execPath, ['--max-old-space-size=96', 'observe.mjs'], {
      workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000, shellMaxOutputBytes: 131072,
    });
    const observations = JSON.parse(observed.output);
    if (!Array.isArray(observations) || observations.length !== inputs.length) throw Error('Incomplete observations');
    return observations;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function gradeCodeCompatibility(spec, content) {
  if (spec.kind !== 'code' || !spec.tests?.length || spec.complexityProbe || spec.distinctOutputFrom !== undefined) {
    throw Error('Unsupported compatibility specification');
  }
  const blocks = [...content.matchAll(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)\n```/g)];
  const source = blocks.length === 1 ? blocks[0][1] : blocks.length ? '' : content;
  const formats = [];
  for (const extension of ['.mjs', '.cjs']) {
    try {
      const observations = await observeCode(source, spec.tests.map(t => t.input), extension);
      const failures = [];
      for (let i = 0; i < observations.length; i++) {
        if (!equalTrustValue(observations[i]?.value, spec.tests[i].expected)) failures.push(`Independent input ${i + 1}: wrong value`);
        if (spec.preserveInput && observations[i]?.unchanged !== true) failures.push(`Independent input ${i + 1}: input mutated`);
      }
      formats.push({ extension, passed: !failures.length, checks: observations.length, failures });
      if (!failures.length) return { passed: true, acceptedFormat: extension, formats };
    } catch (error) {
      formats.push({ extension, passed: false, failures: [String(error).slice(0, 1200)] });
    }
  }
  return { passed: false, formats };
}

async function main() {
  const args = argumentsMap(undefined, ['scores', 'corpus-root', 'output']);
  if (!args.scores || !args['corpus-root'] || !args.output) throw Error('Use --scores FILE --corpus-root DIRECTORY --output NEW_DIRECTORY');
  const directory = path.resolve(args['corpus-root']);
  const { manifest, cases } = await readPublicCorpus(directory);
  const gradingBytes = await fs.readFile(path.join(directory, 'grading.jsonl'));
  if (hash(gradingBytes) !== manifest.gradingSha256) throw Error('Grading specification drift');
  const specs = new Map(gradingBytes.toString().trim().split('\n').map(line => { const x = JSON.parse(line); return [x.id, x]; }));
  const tasks = new Map(cases.map(x => [x.id, x]));
  const scoresBytes = await fs.readFile(args.scores);
  const scores = await jsonl(args.scores);
  const output = path.resolve(args.output);
  await fs.mkdir(output, { mode: 0o700 });
  const results = [], seen = new Set(), aggregates = {};
  for (const score of scores) {
    if (seen.has(score.attemptId)) throw Error('Duplicate attempt');
    seen.add(score.attemptId);
    const task = tasks.get(score.caseId);
    if (!task) throw Error('Unknown scored case');
    if (score.retryOf || !affectedFamilies.has(task.family)) continue;
    const result = await json(path.join(score.artifact, 'result.json'));
    const outputHash = hash(result.content ?? '');
    if (result.attemptId !== score.attemptId || result.caseId !== score.caseId || outputHash !== score.grade.outputSha256 ||
        (result.outputSha256 !== undefined && result.outputSha256 !== outputHash)) {
      throw Error('Output provenance mismatch');
    }
    const failedExecution = score.grade.failures.some(failure => failure.startsWith('attempt_error:') || failure === 'Read-only fixture changed');
    const diagnostic = result.error || score.error || failedExecution || result.workspacePreserved === false
      ? { passed: false, formats: [], skipped: 'Retained runtime error or workspace mutation' }
      : await gradeCodeCompatibility(specs.get(score.caseId), result.content ?? '');
    const row = { attemptId: score.attemptId, caseId: score.caseId, family: task.family, split: task.split,
      arm: score.arm, configGroup: score.configGroup, outputSha256: score.grade.outputSha256,
      primaryPassed: score.grade.passed, compatibility: diagnostic };
    results.push(row);
    const key = `${score.arm}:${score.configGroup ?? score.configHash}`;
    const aggregate = aggregates[key] ??= { attempts: 0, primaryPassed: 0, compatibilityPassed: 0 };
    aggregate.attempts++; aggregate.primaryPassed += Number(row.primaryPassed); aggregate.compatibilityPassed += Number(diagnostic.passed);
  }
  await writeNew(path.join(output, 'report.json'), { schemaVersion: 1, at: new Date().toISOString(),
    purpose: 'Secondary module-format sensitivity only; does not alter primary grades, selection, or promotion gates.',
    corpusHash: manifest.promptsSha256, gradingHash: manifest.gradingSha256, scoresHash: hash(scoresBytes),
    analyzerHash: hash(await fs.readFile(fileURLToPath(import.meta.url))), affectedFamilies: [...affectedFamilies], aggregates,
    limitations: ['Agent-authored synthetic cases; module format was omitted from these prompts.',
      'Original source is executed unchanged under ESM, then CommonJS if necessary, within the existing isolated executor.',
      'Functional checks and input preservation are assessed; no broader correctness or security proof.'] });
  await fs.writeFile(path.join(output, 'results.jsonl'), results.map(x => JSON.stringify(x)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, attempts: results.length, aggregates }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
