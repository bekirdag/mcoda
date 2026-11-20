// Post-run tools for a generalization cycle: grading, grader self-test, blind
// review packets and unblinding (with second reviewers), cost report, and
// pair reruns of attempts lost to infrastructure. Gold, maps and reviews stay in
// the private cycle directory; nothing here embeds them.
//
//   node cycle-tools.mjs grade     --cycle DIR [--python-runtime DIR]
//   node cycle-tools.mjs selftest  --gold grading.json --refs DIR [--python-runtime DIR]
//   node cycle-tools.mjs packets   --cycle DIR --kind design|research [--cases 41,42]
//   node cycle-tools.mjs unblind   --cycle DIR --kind design|research [--margin 10]
//   node cycle-tools.mjs cost      --cycle DIR
//   node cycle-tools.mjs reruns    --cycle DIR [--write --cases 45,46 --reason TEXT]
//   node cycle-tools.mjs summary   --cycle DIR
//
// A cycle directory holds study.json (its output is the results directory),
// private/grading.json, private/<kind>-blind-map.json, <kind>-packets/,
// reviews/ and optional rerun-N/study.json pair reruns.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readJsonl = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const exists = file => fs.stat(file).then(() => true, () => false);
const ARMS = ['after', 'raw_tools'];
const round1 = value => Math.round(value * 10) / 10;

// ---------- answer scoring (same rules as the frozen cycle graders, fence labels fixed in cycle 6) ----------

const FENCE = /```(?:python3?|py3?)[ \t]*\r?\n([\s\S]*?)```/gi;
const ONLY_FENCE = /^\s*```(?:python3?|py3?)[ \t]*\r?\n[\s\S]*?```\s*$/i;

/** The Python module to grade and the format cap (90 unless the answer is exactly one python block). */
export const codeAnswer = content => {
  const blocks = [...String(content ?? '').matchAll(FENCE)].map(match => match[1]);
  return { source: blocks.at(-1), formatCap: blocks.length === 1 && ONLY_FENCE.test(String(content ?? '')) ? 100 : 90 };
};

export const sameValue = (actual, expected) => typeof expected === 'number'
  ? typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1e-7, Math.abs(expected) * 1e-5)
  : JSON.stringify(actual) === JSON.stringify(expected);

/** Score a JSON-only numeric answer: 0 if it is not one JSON object, 90 cap if the key set differs. */
export const scoreNumeric = (rubric, content) => {
  let value; try { value = JSON.parse(String(content ?? '').trim()); } catch { value = undefined; }
  const object = value && typeof value === 'object' && !Array.isArray(value);
  const formatCap = !object ? 0 : JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(rubric.expected).sort()) ? 90 : 100;
  const criteria = Object.entries(rubric.expected).map(([key, expected]) => ({ criterion: key, points: sameValue(value?.[key], expected) ? 20 : 0, actual: value?.[key], expected }));
  return { formatCap, criteria, score: Math.min(formatCap, criteria.reduce((sum, item) => sum + item.points, 0)) };
};

/** Score a code answer; runPython(source, testBody) resolves to { passed, total } or throws. */
export const scoreCode = async (rubric, content, runPython) => {
  const { source, formatCap } = codeAnswer(content);
  const criteria = [];
  for (const test of rubric.pythonTests) {
    let receipt, error;
    if (source) { try { receipt = await runPython(source, test.body); } catch (caught) { error = String(caught); } }
    criteria.push({ criterion: test.criterion, points: receipt?.passed === true && receipt?.total === 1 ? 20 : 0, receipt, error: error ?? (source ? undefined : 'No delivered Python module') });
  }
  return { formatCap, criteria, score: Math.min(formatCap, criteria.reduce((sum, item) => sum + item.points, 0)) };
};

/** Run one check through Codali's python runner, exactly as the cycle graders do. */
export const pythonRunner = async runtime => {
  const { createVitestTool } = await import(pathToFileURL(path.join(runtime, 'dist/tools/verification/VitestTool.js')));
  return async (source, body, workspaceRoot) => {
    const test = `import unittest\nimport subject as s\nclass Independent(unittest.TestCase):\n def test_case(self):\n${body.split('\n').map(line => '  ' + line).join('\n')}\n`;
    const response = await createVitestTool().handler({ runner: 'python', files: [{ path: 'subject.py', content: source }, { path: 'test_subject.py', content: test }] }, { workspaceRoot, signal: AbortSignal.timeout(20000) });
    return response.data ?? JSON.parse(response.output);
  };
};

/**
 * Grader self-test, run before a cycle is frozen: every reference answer, in
 * every accepted presentation, must score 100, and every naive variant must
 * lose points. variants: [{ id, kind: 'numeric'|'code', content, expect: 'full'|'less' }].
 */
export const answerVariants = (rubric, references = {}) => {
  const out = [];
  if (rubric.expected) {
    const value = rubric.expected;
    out.push({ id: rubric.id, kind: 'numeric', label: 'compact', content: JSON.stringify(value), expect: 'full' });
    out.push({ id: rubric.id, kind: 'numeric', label: 'pretty+newline', content: JSON.stringify(value, null, 2) + '\n', expect: 'full' });
    out.push({ id: rubric.id, kind: 'numeric', label: 'reordered', content: JSON.stringify(Object.fromEntries(Object.entries(value).reverse())), expect: 'full' });
    const [firstKey] = Object.keys(value), first = value[firstKey];
    const wrong = typeof first === 'number' ? first + Math.max(1, Math.abs(first)) : Array.isArray(first) ? [...first, 'x'] : `${first}-wrong`;
    out.push({ id: rubric.id, kind: 'numeric', label: 'one-wrong', content: JSON.stringify({ ...value, [firstKey]: wrong }), expect: 'less' });
  }
  if (rubric.pythonTests && references.reference) {
    for (const [label, fence] of [['python', 'python'], ['python3', 'python3'], ['py', 'py'], ['Python', 'Python']]) {
      out.push({ id: rubric.id, kind: 'code', label: `fence ${label}`, content: '```' + fence + '\n' + references.reference.replace(/\s*$/, '\n') + '```', expect: 'full' });
    }
    out.push({ id: rubric.id, kind: 'code', label: 'crlf+trailing newline', content: ('```python\n' + references.reference.replace(/\s*$/, '\n') + '```\n').replace(/\n/g, '\r\n'), expect: 'full' });
    for (const [index, naive] of (references.naive ?? []).entries()) out.push({ id: rubric.id, kind: 'code', label: `naive-${index}`, content: '```python\n' + naive + '\n```', expect: 'less' });
  }
  return out;
};

export const selfTest = async (gold, references, runPython) => {
  const failures = [], checked = [];
  for (const rubric of gold) {
    for (const variant of answerVariants(rubric, references[rubric.id] ?? references[rubric.title])) {
      const { score } = variant.kind === 'numeric' ? scoreNumeric(rubric, variant.content) : await scoreCode(rubric, variant.content, runPython);
      const ok = variant.expect === 'full' ? score === 100 : score < 100;
      checked.push({ ...variant, content: undefined, score, ok });
      if (!ok) failures.push({ id: variant.id, label: variant.label, score, expect: variant.expect });
    }
    if (rubric.pythonTests && !(references[rubric.id] ?? references[rubric.title])?.reference) failures.push({ id: rubric.id, label: 'no reference solution supplied', score: null, expect: 'full' });
  }
  return { checked: checked.length, failures };
};

// ---------- attempts, with pair reruns superseding both arms ----------

/** Category of a case for reporting. Anchors are reported apart from unseen tasks. */
export const category = (task, rubric) => task.id.startsWith('anchor-') ? 'anchor'
  : task.comparison === 'implementation' ? 'apps'
    : task.domain === 'quantitative' ? 'numeric'
      : task.domain === 'research' ? 'research'
        : rubric?.pythonTests ? 'code' : 'design';

const ledgerResults = async output => {
  const results = new Map();
  if (!await exists(path.join(output, 'ledger.jsonl'))) return results;
  for (const record of await readJsonl(path.join(output, 'ledger.jsonl'))) if (record.type === 'result') results.set(record.key, record);
  return results;
};

/**
 * Resolve each case's attempts. A rerun replaces a case only when it holds a
 * result for every arm, so both answers always come from the same run.
 */
export const resolveAttempts = async cycleDir => {
  const study = await readJson(path.join(cycleDir, 'study.json'));
  const cases = (await readJsonl(study.casesFile));
  const main = await ledgerResults(study.output);
  const attempts = new Map(cases.map(task => [task.id, { task, run: 'main', arms: Object.fromEntries(ARMS.map(arm => [arm, main.get(`${task.id}:${arm}`)])) }]));
  const reruns = (await fs.readdir(cycleDir)).filter(name => /^rerun-\d+$/.test(name)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const incomplete = [];
  for (const name of reruns) {
    const rerunStudy = await readJson(path.join(cycleDir, name, 'study.json'));
    const results = await ledgerResults(rerunStudy.output);
    for (const id of new Set(rerunStudy.onlyKeys.map(key => key.split(':')[0]))) {
      const arms = Object.fromEntries(ARMS.map(arm => [arm, results.get(`${id}:${arm}`)]));
      if (ARMS.every(arm => arms[arm])) attempts.set(id, { ...attempts.get(id), run: name, arms });
      else incomplete.push({ id, run: name });
    }
  }
  return { study, cases, attempts, incomplete };
};

// ---------- infrastructure-lost attempts ----------

const INFRA = /model_unavailable|not entitled|not advertised|No eligible configured lead route|Service request timed out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|HTTP 50[234]/i;

/** Attempts whose error points at the model route or host, not the system under test. */
export const infraLost = attempts => {
  const lost = [];
  for (const [id, entry] of attempts) for (const arm of ARMS) {
    const record = entry.arms[arm];
    const error = record?.result?.error ?? record?.launchError;
    if (record && error && INFRA.test(String(error))) lost.push({ id, arm, run: entry.run, error: String(error).slice(0, 160), hasAnswer: !!String(record.result?.content ?? '').trim() });
  }
  return lost;
};

/** A pair-rerun study: both arms of every listed case, same frozen inputs, new output. */
export const rerunStudy = (study, ids, { number, reason, cycleDir, at = new Date().toISOString() }) => {
  if (!ids.length) throw Error('No cases to rerun');
  if (!reason || reason.length < 20) throw Error('A rerun needs a stated infrastructure reason (at least 20 characters)');
  const output = path.join(cycleDir, `rerun-${number}`, 'results');
  return {
    ...study, onlyKeys: ids.flatMap(id => ARMS.map(arm => `${id}:${arm}`)), output,
    rerunOf: study.output, rerunNumber: number, rerunAt: at, rerunReason: reason,
    limitations: [...(study.limitations ?? []), `Pair rerun ${number} (${at.slice(0, 16)}Z): ${ids.join(', ')}, both arms, same frozen runtime, configs and cases; the earlier attempts of these cases are kept but superseded. Reason: ${reason}`],
  };
};

// ---------- blind review ----------

/** Build X/Y packets; new cases merge into the existing map, an existing case is never remapped. */
export const buildPackets = ({ kind, ids, cases, gold, attempts, map = {}, random = () => crypto.randomInt(2) }) => {
  const criteria = new Map(gold.map(item => [item.id, item.criteria]));
  const packets = {}, summary = [];
  for (const id of ids) {
    if (map[id]) throw Error(`${id} already has a blind map entry`);
    const task = cases.find(item => item.id === id), entry = attempts.get(id);
    if (!task || !criteria.get(id)) throw Error(`missing case or criteria for ${id}`);
    const flip = random() === 1, letters = flip ? { X: 'raw_tools', Y: 'after' } : { X: 'after', Y: 'raw_tools' };
    let md = `# ${id}\n\n## Task given to both answers\n\n${task.prompt}\n\n## Criteria (0-20 points each)\n\n${criteria.get(id).map(item => '- ' + item).join('\n')}\n`;
    for (const letter of ['X', 'Y']) {
      const result = entry?.arms[letters[letter]]?.result, content = String(result?.content ?? '').trim();
      const delivered = content.length > 0 && !result?.error;
      md += `\n## Answer ${letter}\n\n${delivered ? content : '(No answer was delivered. Score 0 on every criterion.)'}\n`;
      summary.push({ id, letter, chars: content.length, delivered, run: entry?.run });
    }
    map[id] = letters; packets[id] = md;
  }
  return { packets, map, summary, kind };
};

const reviewTotal = side => side.criteria.reduce((sum, item) => sum + item.points, 0);

/**
 * Unblind every review of a kind. Each case keeps every reviewer's scores; the
 * case score is their mean. Close cases with a single reviewer are listed so a
 * second reviewer can score them; a winner that flips between reviewers is flagged.
 */
export const unblind = (map, reviews, { margin = 10 } = {}) => {
  const byCase = {};
  for (const { file, list } of reviews) for (const item of list) {
    const letters = map[item.caseId]; if (!letters) throw Error(`${file}: ${item.caseId} is not in the blind map`);
    (byCase[item.caseId] ??= []).push({ file, [letters.X]: reviewTotal(item.X), [letters.Y]: reviewTotal(item.Y) });
  }
  const cases = {}, needSecond = [], flipped = [];
  for (const [id, scores] of Object.entries(byCase).sort()) {
    const mean = arm => round1(scores.reduce((sum, item) => sum + item[arm], 0) / scores.length);
    cases[id] = { after: mean('after'), raw_tools: mean('raw_tools'), reviewers: scores.length, reviews: scores };
    if (scores.length === 1 && Math.abs(cases[id].after - cases[id].raw_tools) <= margin) needSecond.push(id);
    const signs = new Set(scores.map(item => Math.sign(item.after - item.raw_tools)));
    if (signs.size > 1) flipped.push(id);
  }
  const values = Object.values(cases), avg = arm => values.length ? round1(values.reduce((sum, item) => sum + item[arm], 0) / values.length) : null;
  return {
    cases, mean: { after: avg('after'), raw_tools: avg('raw_tools') },
    wins: { after: values.filter(item => item.after > item.raw_tools).length, raw_tools: values.filter(item => item.after < item.raw_tools).length, tie: values.filter(item => item.after === item.raw_tools).length },
    needSecondReviewer: needSecond, reviewersDisagreeOnWinner: flipped, margin,
  };
};

// ---------- cost ----------

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : null; };

/** Tokens and wall time per category and arm, over attempts that produced a result. */
export const costReport = (attempts, gold) => {
  const rubrics = new Map(gold.map(item => [item.id, item])), groups = {};
  for (const [id, entry] of attempts) for (const arm of ARMS) {
    const result = entry.arms[arm]?.result; if (!result) continue;
    const bucket = ((groups[category(entry.task, rubrics.get(id))] ??= {})[arm] ??= { attempts: 0, tokens: [], minutes: [], errors: 0 });
    bucket.attempts++; if (result.error) bucket.errors++;
    if (Number.isFinite(result.usage?.tokens)) bucket.tokens.push(result.usage.tokens);
    if (Number.isFinite(result.elapsedMs)) bucket.minutes.push(result.elapsedMs / 60000);
  }
  const out = {};
  for (const [name, arms] of Object.entries(groups)) {
    out[name] = Object.fromEntries(Object.entries(arms).map(([arm, b]) => [arm, {
      attempts: b.attempts, errors: b.errors, totalTokens: b.tokens.reduce((a, c) => a + c, 0), medianTokens: median(b.tokens),
      medianMinutes: b.minutes.length ? round1(median(b.minutes)) : null, totalHours: round1(b.minutes.reduce((a, c) => a + c, 0) / 60),
    }]));
    if (out[name].after?.medianTokens && out[name].raw_tools?.medianTokens) out[name].tokenRatio = round1(out[name].after.medianTokens / out[name].raw_tools.medianTokens);
  }
  return out;
};

// ---------- outages: what happened to the host and route while attempts ran ----------

/** Kernel OOM kills from `journalctl -k -o short-iso` text. */
export const parseOomKills = text => [...String(text).matchAll(/^(\S+) \S+ kernel: Out of memory: Killed process (\d+) \(([^)]+)\).*?anon-rss:(\d+)kB/gm)]
  .map(([, at, pid, process, anon]) => ({ type: 'oom_kill', at: new Date(at).toISOString(), pid: Number(pid), process, anonGB: round1(Number(anon) / 1048576) }));

/** Route and dependency waits recorded by the runner, as closed or still-open intervals. */
export const routeWaits = ledger => {
  const out = [], open = new Map();
  for (const record of ledger) {
    if (record.type === 'model_route_wait' || record.type === 'dependencies_wait') open.set(record.type, record);
    const start = record.type === 'model_route_ready' ? open.get('model_route_wait') : record.type === 'dependencies_ready' ? open.get('dependencies_wait') : undefined;
    if (start) { out.push({ type: start.type, at: start.at, until: record.at, key: start.key, minutes: round1((Date.parse(record.at) - Date.parse(start.at)) / 60000) }); open.delete(start.type); }
  }
  for (const start of open.values()) out.push({ type: start.type, at: start.at, until: null, key: start.key });
  return out;
};

/** Attempts whose run overlapped each event (start..result, or still running). */
export const affectedAttempts = (events, ledger, now = new Date().toISOString()) => {
  const spans = new Map();
  for (const record of ledger) {
    if (record.type === 'start') spans.set(record.key, { key: record.key, from: record.at, to: null });
    if (record.type === 'result' && spans.has(record.key)) spans.get(record.key).to = record.at ?? null;
  }
  return events.map(event => {
    const from = Date.parse(event.at), to = Date.parse(event.until ?? event.at);
    const affected = [...spans.values()].filter(span => Date.parse(span.from) <= to && Date.parse(span.to ?? now) >= from).map(span => span.key);
    return { ...event, affected };
  });
};

// ---------- how sure a category result is ----------

/** Correctness without presentation: a fenced JSON block is unwrapped and no key-set cap applies. */
export const numericSubstance = (rubric, content) => {
  const text = String(content ?? ''), fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)```\s*$/i.exec(text);
  return scoreNumeric(rubric, fenced ? fenced[1] : text).criteria.reduce((sum, item) => sum + item.points, 0);
};

/** Exact two-sided sign test on paired wins and losses (ties dropped). */
export const signTest = (wins, losses) => {
  const n = wins + losses; if (!n) return 1;
  const k = Math.min(wins, losses);
  let tail = 0, coefficient = 1;
  for (let i = 0; i <= k; i++) { if (i) coefficient = coefficient * (n - i + 1) / i; tail += coefficient; }
  return Math.min(1, 2 * tail / 2 ** n);
};

const seededRandom = seed => {
  let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
};

/** Paired comparison: means, mean difference with a 95% bootstrap interval, wins, sign test and a plain verdict. */
export const comparePaired = (pairs, { seed = 'paired', iterations = 10000 } = {}) => {
  const diffs = pairs.map(pair => pair.after - pair.raw_tools), n = diffs.length;
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const wins = diffs.filter(d => d > 0).length, losses = diffs.filter(d => d < 0).length;
  if (!n) return { n: 0 };
  const random = seededRandom(seed), boot = [];
  for (let i = 0; i < iterations; i++) { let sum = 0; for (let j = 0; j < n; j++) sum += diffs[Math.floor(random() * n)]; boot.push(sum / n); }
  boot.sort((a, b) => a - b);
  const ci95 = [round1(boot[Math.floor(iterations * 0.025)]), round1(boot[Math.ceil(iterations * 0.975) - 1])];
  const verdict = n < 5 ? 'too few cases' : ci95[0] > 0 ? 'Codali leads' : ci95[1] < 0 ? 'raw leads' : 'not distinguishable';
  return { n, after: round1(mean(pairs.map(p => p.after))), raw_tools: round1(mean(pairs.map(p => p.raw_tools))), meanDiff: round1(mean(diffs)), ci95,
    wins: { after: wins, raw_tools: losses, tie: n - wins - losses }, signTestP: Math.round(signTest(wins, losses) * 1000) / 1000, verdict };
};

// ---------- anchors: a fixed set of earlier tasks rerun every cycle ----------

/**
 * Pick auto-graded earlier tasks that still separate the arms (the arms
 * differed, or neither reached 100), so a fixed set can show change between
 * cycles. Research (facts drift), design (reviewer variance) and apps (cost)
 * are excluded. Selection is reproducible from the seed.
 */
export const selectAnchors = (entries, { numeric = 4, code = 4, seed = 'anchors-v1', shuffle }) => {
  // Both arms must have delivered an answer: an empty or failed attempt says nothing about the task.
  const useful = entry => entry.delivered !== false && Number.isFinite(entry.scores.after) && Number.isFinite(entry.scores.raw_tools)
    && (entry.scores.after !== entry.scores.raw_tools || entry.scores.after < 100);
  // First tasks Codali itself lost points on (room to improve or regress), then tasks where only raw lost points.
  const pick = (kind, count) => {
    const pool = entries.filter(entry => entry.kind === kind && useful(entry));
    const codaliMissed = shuffle(pool.filter(entry => entry.scores.after < 100), `${seed}:${kind}:missed`);
    const rest = shuffle(pool.filter(entry => entry.scores.after === 100), `${seed}:${kind}:rest`);
    return [...codaliMissed, ...rest].slice(0, count);
  };
  return [...pick('numeric', numeric), ...pick('code', code)].map(entry => ({
    task: { ...entry.task, id: `anchor-${entry.task.id}`, split: 'validation' },
    rubric: { ...entry.rubric, id: `anchor-${entry.task.id}` },
    source: { cycle: entry.cycle, id: entry.task.id, scores: entry.scores },
  }));
};

// ---------- CLI ----------

const option = (args, name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const caseIds = (value, cycle) => value.split(',').map(item => item.trim()).filter(Boolean).map(item => /^\d+$/.test(item) ? `cycle${cycle}-${item.padStart(2, '0')}` : item);
const KIND_CATEGORY = { design: 'design', research: 'research' };

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  const cycleDir = option(args, 'cycle') && path.resolve(option(args, 'cycle'));
  const goldFor = async () => readJson(path.join(cycleDir, 'private/grading.json'));
  const print = value => console.log(JSON.stringify(value, null, 1));
  if (command === 'selftest') {
    const gold = await readJson(option(args, 'gold'));
    const refsDir = option(args, 'refs'), references = {};
    // refs DIR: <case id or family>{.|__}reference.py and ...naive-N.py (code_refs.py --emit layout)
    for (const name of await fs.readdir(refsDir)) {
      const match = /^(.+?)(?:__|\.)(reference|naive-\d+)\.py$/.exec(name); if (!match) continue;
      const ref = (references[match[1]] ??= { naive: [] }), text = await fs.readFile(path.join(refsDir, name), 'utf8');
      if (match[2] === 'reference') ref.reference = text; else ref.naive.push(text);
    }
    const workspace = await fs.mkdtemp(path.join(refsDir, '.selftest-'));
    const run = await pythonRunner(option(args, 'python-runtime') ?? path.resolve(import.meta.dirname, '../../packages/codali'));
    const report = await selfTest(gold, references, (source, body) => run(source, body, workspace));
    print(report); if (report.failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'anchors') {
    // --from DIR,DIR --out FILE.json: cases and gold of the chosen anchors, for the next cycle's assembly (private).
    const { seededShuffle } = await import('./regression-pack.mjs');
    const entries = [];
    for (const dir of option(args, 'from').split(',').map(item => path.resolve(item))) {
      const resolved = await resolveAttempts(dir), gold = await readJson(path.join(dir, 'private/grading.json'));
      for (const [id, entry] of resolved.attempts) {
        const rubric = gold.find(item => item.id === id), kind = category(entry.task, rubric);
        if (!['numeric', 'code'].includes(kind)) continue;
        const scores = {};
        for (const arm of ARMS) { const file = entry.arms[arm] && path.join(entry.arms[arm].directory, 'independent-answer-score.json'); if (file && await exists(file)) scores[arm] = (await readJson(file)).score; }
        const delivered = ARMS.every(arm => !entry.arms[arm]?.result?.error && String(entry.arms[arm]?.result?.content ?? '').trim());
        entries.push({ cycle: resolved.study.cycle, kind, task: entry.task, rubric, scores, delivered });
      }
    }
    const chosen = selectAnchors(entries, { numeric: Number(option(args, 'numeric') ?? 4), code: Number(option(args, 'code') ?? 4), seed: option(args, 'seed') ?? 'anchors-v1', shuffle: seededShuffle });
    await fs.writeFile(path.resolve(option(args, 'out')), JSON.stringify({ createdAt: new Date().toISOString(), anchors: chosen }, null, 1), { flag: 'wx' });
    print(chosen.map(item => item.source)); return;
  }
  if (!cycleDir) throw Error('--cycle DIR is required');
  const { study, cases, attempts, incomplete } = await resolveAttempts(cycleDir);
  if (command === 'grade') {
    const gold = await goldFor(), run = await pythonRunner(option(args, 'python-runtime') ?? study.arms.after.runtime), rows = [];
    for (const [id, entry] of attempts) {
      const rubric = gold.find(item => item.id === id); if (!rubric || rubric.app) continue;
      for (const arm of ARMS) {
        const record = entry.arms[arm]; if (!record) continue;
        const file = path.join(record.directory, 'independent-answer-score.json');
        if (await exists(file)) { rows.push({ id, arm, run: entry.run, score: (await readJson(file)).score, cached: true }); continue; }
        const content = String(record.result?.content ?? '');
        let scored;
        if (rubric.expected) scored = scoreNumeric(rubric, content);
        else if (rubric.pythonTests) scored = await scoreCode(rubric, content, (source, body) => run(source, body, record.directory));
        else continue; // design and research go to blind review
        await fs.writeFile(file, JSON.stringify({ caseId: id, ...scored, answerPresent: !!content.trim(), inferenceError: record.result?.error, run: entry.run }, null, 2), { flag: 'wx' });
        rows.push({ id, arm, run: entry.run, score: scored.score });
      }
    }
    print({ rows, incomplete }); return;
  }
  if (command === 'packets') {
    const kind = option(args, 'kind'); if (!KIND_CATEGORY[kind]) throw Error('--kind design|research');
    const gold = await goldFor(), mapFile = path.join(cycleDir, 'private', `${kind}-blind-map.json`);
    const ids = option(args, 'cases') ? caseIds(option(args, 'cases'), study.cycle) : cases.filter(task => category(task, gold.find(g => g.id === task.id)) === KIND_CATEGORY[kind]).map(task => task.id);
    const map = await exists(mapFile) ? await readJson(mapFile) : {};
    const built = buildPackets({ kind, ids, cases, gold, attempts, map });
    await fs.mkdir(path.join(cycleDir, `${kind}-packets`), { recursive: true });
    for (const [id, md] of Object.entries(built.packets)) await fs.writeFile(path.join(cycleDir, `${kind}-packets`, `${id}.md`), md, { flag: 'wx' });
    await fs.writeFile(mapFile, JSON.stringify(built.map, null, 1));
    console.table(built.summary); return;
  }
  if (command === 'unblind') {
    const kind = option(args, 'kind'); if (!KIND_CATEGORY[kind]) throw Error('--kind design|research');
    const map = await readJson(path.join(cycleDir, 'private', `${kind}-blind-map.json`));
    const pattern = new RegExp(`^${kind}-(?:second-)?\\d+-\\d+\\.json$`), reviews = [];
    for (const file of (await fs.readdir(path.join(cycleDir, 'reviews'))).filter(name => pattern.test(name)).sort()) {
      const data = await readJson(path.join(cycleDir, 'reviews', file));
      reviews.push({ file, list: Array.isArray(data) ? data : Object.entries(data.cases).map(([caseId, value]) => ({ caseId, ...value })) });
    }
    const out = unblind(map, reviews, { margin: Number(option(args, 'margin') ?? 10) });
    await fs.writeFile(path.join(cycleDir, 'reviews', `${kind}-unblinded.json`), JSON.stringify(out, null, 1));
    print({ mean: out.mean, wins: out.wins, needSecondReviewer: out.needSecondReviewer, reviewersDisagreeOnWinner: out.reviewersDisagreeOnWinner }); return;
  }
  if (command === 'cost') { print(costReport(attempts, await goldFor())); return; }
  if (command === 'outages') {
    // Rewrites <cycle>/outages.json from the kernel log and the runner ledgers; --process filters OOM kills (default: all).
    const { execFileSync } = await import('node:child_process');
    let kernel = '';
    try { kernel = execFileSync('journalctl', ['-k', '-o', 'short-iso', '--no-pager', '--since', new Date(study.frozenAt).toISOString().replace('T', ' ').slice(0, 19)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
    catch (error) { kernel = String(error.stdout ?? ''); }
    const only = option(args, 'process') ? new RegExp(option(args, 'process')) : null;
    const ledgers = [study.output, ...(await fs.readdir(cycleDir)).filter(name => /^rerun-\d+$/.test(name)).map(name => path.join(cycleDir, name, 'results'))];
    const events = [];
    for (const output of ledgers) {
      const file = path.join(output, 'ledger.jsonl'); if (!await exists(file)) continue;
      const ledger = await readJsonl(file);
      const kills = parseOomKills(kernel).filter(kill => !only || only.test(kill.process));
      events.push(...affectedAttempts([...kills, ...routeWaits(ledger)], ledger).map(event => ({ ...event, ledger: path.relative(cycleDir, output) })));
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    await fs.writeFile(path.join(cycleDir, 'outages.json'), JSON.stringify({ updatedAt: new Date().toISOString(), events }, null, 1));
    for (const event of events) console.log(`${event.at.slice(0, 19)}Z ${event.type} ${event.process ?? event.key ?? ''}${event.minutes != null ? ` ${event.minutes} min` : ''} affected=${event.affected.join(',') || '-'}`);
    return;
  }
  if (command === 'reruns') {
    const lost = infraLost(attempts);
    if (!args.includes('--write')) { print({ lost, incomplete, pairsToRerun: [...new Set(lost.map(item => item.id))] }); return; }
    const ids = caseIds(option(args, 'cases') ?? '', study.cycle);
    const number = (await fs.readdir(cycleDir)).filter(name => /^rerun-\d+$/.test(name)).length + 1;
    const next = rerunStudy(study, ids, { number, reason: option(args, 'reason'), cycleDir });
    await fs.mkdir(path.join(cycleDir, `rerun-${number}`), { recursive: true });
    await fs.writeFile(path.join(cycleDir, `rerun-${number}`, 'study.json'), JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    print({ study: path.join(cycleDir, `rerun-${number}`, 'study.json'), onlyKeys: next.onlyKeys }); return;
  }
  if (command === 'summary') {
    const gold = await goldFor(), pairs = {};
    for (const [id, entry] of attempts) {
      const rubric = gold.find(item => item.id === id), name = category(entry.task, rubric), pair = { id };
      for (const arm of ARMS) {
        const file = entry.arms[arm] && path.join(entry.arms[arm].directory, 'independent-answer-score.json');
        if (!file || !await exists(file)) continue;
        const scored = await readJson(file);
        pair[arm] = scored.score;
        pair[`${arm}Substance`] = rubric?.expected ? numericSubstance(rubric, entry.arms[arm].result?.content) : scored.criteria.reduce((sum, item) => sum + item.points, 0);
      }
      if (ARMS.every(arm => Number.isFinite(pair[arm]))) (pairs[name] ??= []).push(pair);
    }
    for (const kind of Object.keys(KIND_CATEGORY)) {
      const file = path.join(cycleDir, 'reviews', `${kind}-unblinded.json`);
      if (await exists(file)) pairs[kind] = Object.entries((await readJson(file)).cases).map(([id, c]) => ({ id, after: c.after, raw_tools: c.raw_tools }));
    }
    const scores = Object.fromEntries(Object.entries(pairs).map(([name, list]) => [name, {
      ...comparePaired(list, { seed: name }),
      ...(list.every(item => Number.isFinite(item.afterSubstance)) ? { substance: comparePaired(list.map(item => ({ after: item.afterSubstance, raw_tools: item.raw_toolsSubstance })), { seed: name + ':substance' }) } : {}),
    }]));
    print({ scores, cost: costReport(attempts, gold), lost: infraLost(attempts), incomplete }); return;
  }
  throw Error('Usage: node cycle-tools.mjs grade|selftest|packets|unblind|cost|reruns|summary --cycle DIR ...');
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
