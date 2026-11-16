// Pre-release regression pack: rerun past Codali failures plus a sample of past
// passes on a candidate build, before publishing it. Gold stays in the private
// cycle directories and the pack directory, never in this repository.
//
//   node regression-pack.mjs build  --out DIR --cycle DIR [--cycle DIR ...] [--sample N] [--seed S] [--include-reviewed] [--only id,id]
//     (lost blind reviews are opt-in: they cannot be re-graded automatically and research runs 45 minutes)
//   node regression-pack.mjs freeze --out DIR --config after.json --raw-config raw.json [--repo PATH]
//   node scripts/benchmarks/run-generalization-study.mjs DIR/study.json   (runs the Codali side only)
//   node regression-pack.mjs report --out DIR --grader grade_answers.mjs
//
// A cycle directory holds private/cases.jsonl, private/grading.json and
// results/ (attempt directories), plus optional reviews/*-unblinded.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { triageAttempt, triageStudy } from './cycle-triage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readJsonl = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const exists = file => fs.stat(file).then(() => true, () => false);

/** Deterministic shuffle so a pack is reproducible from its seed. */
export const seededShuffle = (items, seed) => {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
};

/** Choose pack cases from one cycle's earlier Codali attempts. */
export const selectFromCycle = ({ cases, gold, attempts, reviewScores = {} }, { includeReviewed = false } = {}) => {
  const failures = [], passes = [];
  const goldById = new Map(gold.map(item => [item.id, item]));
  for (const task of cases) {
    if (task.comparison === 'implementation') continue; // 24-hour builds are reviewed separately
    const attempt = attempts.get(task.id);
    if (!attempt) continue;
    const reasons = [];
    const rubric = goldById.get(task.id);
    const automatic = Boolean(rubric?.expected || rubric?.pythonTests);
    if (automatic && attempt.score !== undefined && attempt.score < 100) reasons.push(`scored ${attempt.score}`);
    for (const item of attempt.flags.filter(flag => flag.severity === 'high')) reasons.push(item.code);
    const review = reviewScores[task.id];
    if (includeReviewed && review && review.after !== undefined && review.raw_tools !== undefined && review.raw_tools - review.after >= 10) reasons.push(`lost blind review ${review.after} vs ${review.raw_tools}`);
    const entry = { id: task.id, domain: task.domain, previousScore: attempt.score, reasons };
    if (reasons.length) failures.push(entry);
    else if (automatic && attempt.score === 100) passes.push(entry);
  }
  return { failures, passes };
};

const loadCycle = async directory => {
  const cases = await readJsonl(path.join(directory, 'private/cases.jsonl'));
  const gold = await readJson(path.join(directory, 'private/grading.json'));
  const attempts = new Map();
  for (const name of await fs.readdir(path.join(directory, 'results'))) {
    const attemptDir = path.join(directory, 'results', name);
    if (!(await exists(path.join(attemptDir, 'result.json')))) continue;
    const request = await readJson(path.join(attemptDir, 'request.json'));
    if (request.arm === 'raw_tools') continue;
    const result = await readJson(path.join(attemptDir, 'result.json'));
    const scoreFile = path.join(attemptDir, 'independent-answer-score.json');
    const score = (await exists(scoreFile)) ? (await readJson(scoreFile)).score : undefined;
    const eventsText = await fs.readFile(path.join(attemptDir, 'events.jsonl'), 'utf8').catch(() => '');
    const events = eventsText.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
    attempts.set(request.task.id, { score, flags: triageAttempt({ request, result, events }) });
  }
  const reviewScores = {};
  for (const kind of ['design', 'research']) {
    const file = path.join(directory, 'reviews', `${kind}-unblinded.json`);
    if (await exists(file)) Object.assign(reviewScores, (await readJson(file)).cases ?? {});
  }
  return { cases, gold, attempts, reviewScores };
};

const insideRepo = async target => {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here }).toString().trim();
  const resolved = path.resolve(target);
  return resolved === repo || resolved.startsWith(repo + path.sep);
};

const build = async ({ out, cycles, sample, seed, includeReviewed, only }) => {
  if (await insideRepo(out)) throw Error('The pack holds private gold; put it outside the repository');
  await fs.mkdir(out, { recursive: false, mode: 0o700 });
  const selection = [], allCases = [], allGold = [];
  for (const directory of cycles) {
    const cycle = await loadCycle(directory);
    let { failures, passes } = selectFromCycle(cycle, { includeReviewed: includeReviewed || Boolean(only) });
    let sampled = seededShuffle(passes, `${seed}:${directory}`).slice(0, sample);
    if (only) { failures = failures.filter(item => only.has(item.id)); sampled = passes.filter(item => only.has(item.id)); }
    for (const [kind, list] of [['failure', failures], ['sample', sampled]]) for (const entry of list) {
      selection.push({ cycle: path.basename(directory), kind, ...entry });
      allCases.push(cycle.cases.find(task => task.id === entry.id));
      allGold.push(cycle.gold.find(item => item.id === entry.id));
    }
  }
  if (new Set(allCases.map(task => task.id)).size !== allCases.length) throw Error('Case ids collide across cycles');
  await fs.writeFile(path.join(out, 'cases.jsonl'), allCases.map(task => JSON.stringify(task)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(out, 'grading.json'), JSON.stringify(allGold), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(out, 'selection.json'), JSON.stringify(selection, null, 1), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ cases: allCases.length, failures: selection.filter(item => item.kind === 'failure').length, sampled: selection.filter(item => item.kind === 'sample').length }));
};

const freeze = async ({ out, config, rawConfig, repo }) => {
  const { freezeRuntime } = await import(path.join(repo, 'scripts/benchmarks/generalization-freeze.mjs'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain', 'packages/codali/src', 'scripts/benchmarks'], { cwd: repo }).toString().trim();
  await freezeRuntime({ packageRoot: path.join(repo, 'packages/codali'), benchmarkRoot: path.join(repo, 'scripts/benchmarks'), destination: path.join(out, 'runtime'), dependencyLock: path.join(repo, 'pnpm-lock.yaml') });
  for (const [source, name] of [[config, 'after.json'], [rawConfig, 'raw.json']]) await fs.copyFile(source, path.join(out, name), fs.constants.COPYFILE_EXCL);
  const cases = await readJsonl(path.join(out, 'cases.jsonl'));
  const study = { protocol: 'codali-generalization-v1', frozenAt: new Date().toISOString(), purpose: 'regression-pack', runtimeCommit: commit, workingTreeDirty: Boolean(dirty),
    comparisonArms: ['after', 'raw_tools'], expectedCases: cases.length, expectedBuilds: 0, onlyKeys: cases.map(task => `${task.id}:after`),
    casesFile: path.join(out, 'cases.jsonl'), casesSha256: await sha(path.join(out, 'cases.jsonl')), gradingFile: path.join(out, 'grading.json'), gradingSha256: await sha(path.join(out, 'grading.json')),
    arms: { after: { runtime: path.join(out, 'runtime'), config: path.join(out, 'after.json'), configSha256: await sha(path.join(out, 'after.json')) },
      raw_tools: { runtime: path.join(out, 'runtime'), config: path.join(out, 'raw.json'), configSha256: await sha(path.join(out, 'raw.json')) } },
    output: path.join(out, 'results'), dependencyHealthUrls: ['http://127.0.0.1:28491/healthz'] };
  await fs.writeFile(path.join(out, 'study.json'), JSON.stringify(study, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ commit, dirty: Boolean(dirty), cases: cases.length }));
};

const report = async ({ out, grader }) => {
  execFileSync(process.execPath, [grader, path.join(out, 'study.json')], { stdio: 'ignore' });
  const selection = await readJson(path.join(out, 'selection.json'));
  const findings = await triageStudy(path.join(out, 'results'));
  const scores = new Map();
  for (const name of await fs.readdir(path.join(out, 'results'))) {
    const file = path.join(out, 'results', name, 'independent-answer-score.json');
    if (await exists(file)) { const value = await readJson(file); scores.set(value.caseId, value.score); }
  }
  const rows = selection.map(item => {
    const high = findings.filter(finding => finding.key === `${item.id}:after` && finding.severity === 'high').map(finding => finding.code);
    const score = scores.get(item.id);
    const ok = high.length === 0 && (score === undefined || score === 100);
    // A failure that now scores lower than before, or loses its answer, also regressed.
    const worse = item.kind !== 'sample' && !ok && ((score ?? 100) < (item.previousScore ?? 0) || (high.length && !item.reasons.some(reason => !/^scored/.test(reason))));
    const status = item.kind === 'sample' ? (ok ? 'still passing' : 'REGRESSED') : ok ? 'fixed' : worse ? 'REGRESSED' : 'still failing';
    return { ...item, score, flags: high, status };
  });
  const summary = Object.fromEntries(['fixed', 'still failing', 'still passing', 'REGRESSED'].map(status => [status, rows.filter(row => row.status === status).length]));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ summary, rows }, null, 1));
  console.log(JSON.stringify(summary));
  for (const row of rows) console.log(`${row.status.padEnd(14)} ${row.id.padEnd(12)} was ${row.previousScore ?? '-'} (${row.reasons.join('; ') || 'pass'}) now ${row.score ?? '-'} ${row.flags.join(',')}`);
  return summary.REGRESSED === 0;
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const value = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const values = name => rest.flatMap((arg, index) => arg === name ? [rest[index + 1]] : []);
  const out = value('--out') && path.resolve(value('--out'));
  if (!out) throw Error('--out is required');
  if (command === 'build') return build({ out, cycles: values('--cycle').map(dir => path.resolve(dir)), sample: Number(value('--sample') ?? 2), seed: value('--seed') ?? 'pack', includeReviewed: rest.includes('--include-reviewed'), only: value('--only') ? new Set(value('--only').split(',')) : undefined });
  if (command === 'freeze') return freeze({ out, config: value('--config'), rawConfig: value('--raw-config'), repo: path.resolve(value('--repo') ?? path.join(here, '../..')) });
  if (command === 'report') { if (!(await report({ out, grader: path.resolve(value('--grader')) }))) process.exitCode = 1; return; }
  throw Error('Usage: regression-pack.mjs build|freeze|report --out DIR ...');
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
