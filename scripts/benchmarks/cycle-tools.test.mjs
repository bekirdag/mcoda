import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codeAnswer, scoreNumeric, scoreCode, answerVariants, selfTest, category, resolveAttempts,
  infraLost, rerunStudy, buildPackets, unblind, costReport,
} from './cycle-tools.mjs';
import * as tools from './cycle-tools.mjs';

const numericRubric = { id: 'c-01', expected: { a: 1.5, b: 3, c: [1, 2], d: "x", e: 0 } };
const codeRubric = { id: 'c-21', pythonTests: [{ criterion: 'one', body: 'pass' }, { criterion: 'two', body: 'pass' }] };

test('code fences: python, python3, py and py3 all count; prose caps at 90', () => {
  for (const label of ['python', 'python3', 'py', 'py3', 'Python']) {
    assert.deepEqual(codeAnswer('```' + label + '\nx = 1\n```'), { source: 'x = 1\n', formatCap: 100 }, label);
  }
  assert.equal(codeAnswer('```python\r\nx = 1\r\n```\r\n').formatCap, 100);
  assert.equal(codeAnswer('Here:\n```python\nx = 1\n```').formatCap, 90);
  assert.equal(codeAnswer('```python\nx\n```\n```python\ny\n```').source, 'y\n');
  assert.equal(codeAnswer('```\nx = 1\n```').source, undefined);
});

test('numeric: exact JSON scores 100, extra keys cap at 90, prose scores 0', () => {
  assert.equal(scoreNumeric(numericRubric, '{"a":1.5,"b":3,"c":[1,2],"d":"x","e":0}').score, 100);
  assert.equal(scoreNumeric(numericRubric, '{"a":1.500001,"b":3,"c":[1,2],"d":"x","e":0}').score, 100);
  assert.equal(scoreNumeric(numericRubric, '{"a":1.5,"b":3,"c":[1,2],"d":"x","e":0,"f":1}').score, 90);
  assert.equal(scoreNumeric(numericRubric, '{"a":1.5,"b":3,"c":[1,2],"d":"x","e":0,"f":1}').formatCap, 90);
  assert.equal(scoreNumeric(numericRubric, 'The answer is {"a":1.5}').score, 0);
});

test('code: each passing check is 20 points, missing module scores 0', async () => {
  const pass = async () => ({ passed: true, total: 1 });
  assert.equal((await scoreCode(codeRubric, '```python\nx=1\n```', pass)).score, 40);
  const none = await scoreCode(codeRubric, 'no code', pass);
  assert.equal(none.score, 0); assert.equal(none.criteria[0].error, 'No delivered Python module');
  const throws = await scoreCode(codeRubric, '```py\nx=1\n```', async () => { throw Error('boom'); });
  assert.equal(throws.score, 0); assert.match(throws.criteria[0].error, /boom/);
});

test('grader self-test: references score 100 in every presentation, naive variants lose points', async () => {
  const gold = [numericRubric, { ...codeRubric, pythonTests: Array.from({ length: 5 }, (_, i) => ({ criterion: `k${i}`, body: 'pass' })) }];
  const references = { 'c-21': { reference: 'def f():\n    return 1', naive: ['def f():\n    return 0'] } };
  const runPython = async source => ({ passed: /return 1/.test(source), total: 1 });
  const good = await selfTest(gold, references, runPython);
  assert.deepEqual(good.failures, []);
  assert.ok(good.checked >= 9);
  // The cycle 4-6 bug class: a presentation the prompt allows (```python3) must not score 0.
  assert.ok(answerVariants(gold[1], references['c-21']).some(v => v.label === 'fence python3' && v.expect === 'full'));
  // A runner that cannot pass the reference (broken sandbox, wrong import) fails the self-test.
  const broken = await selfTest(gold, references, async () => ({ passed: false, total: 1 }));
  assert.ok(broken.failures.some(f => f.label === 'fence python' && f.score === 0));
  // A check suite that the naive solution also passes is too weak to grade.
  const weak = await selfTest(gold, references, async () => ({ passed: true, total: 1 }));
  assert.deepEqual(weak.failures.map(f => f.label), ['naive-0']);
  assert.equal((await selfTest([codeRubric], {}, runPython)).failures[0].label, 'no reference solution supplied');
});

test('categories: anchors are reported apart from unseen tasks', () => {
  assert.equal(category({ id: 'anchor-cycle4-03', domain: 'quantitative' }), 'anchor');
  assert.equal(category({ id: 'c-21', domain: 'software', comparison: 'answer' }, codeRubric), 'code');
  assert.equal(category({ id: 'c-31', domain: 'software', comparison: 'answer' }, { criteria: [] }), 'design');
  assert.equal(category({ id: 'c-51', domain: 'web', comparison: 'implementation' }), 'apps');
});

const ledgerLine = (key, directory, result) => JSON.stringify({ type: 'result', key, label: key.split(':')[1], directory, result });

async function fixtureCycle() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-tools-'));
  const cases = [{ id: 'c-41', domain: 'research', comparison: 'answer', prompt: 'Q41' }, { id: 'c-42', domain: 'research', comparison: 'answer', prompt: 'Q42' }, { id: 'c-43', domain: 'research', comparison: 'answer', prompt: 'Q43' }];
  await fs.writeFile(path.join(root, 'cases.jsonl'), cases.map(c => JSON.stringify(c)).join('\n') + '\n');
  await fs.mkdir(path.join(root, 'results'));
  const ok = (content, tokens = 100) => ({ content, usage: { tokens }, elapsedMs: 60000 });
  await fs.writeFile(path.join(root, 'results', 'ledger.jsonl'), [
    ledgerLine('c-41:after', '/r/41a', ok('A41')), ledgerLine('c-41:raw_tools', '/r/41r', ok('R41', 50)),
    ledgerLine('c-42:after', '/r/42a', ok('A42')), ledgerLine('c-42:raw_tools', '/r/42r', { error: 'ModelServiceError: Model service HTTP 404: model_unavailable', content: '' }),
    ledgerLine('c-43:after', '/r/43a', { error: 'Error: Service request timed out', content: '' }), ledgerLine('c-43:raw_tools', '/r/43r', ok('R43')),
  ].join('\n') + '\n');
  const study = { cycle: 9, casesFile: path.join(root, 'cases.jsonl'), output: path.join(root, 'results'), limitations: ['base'] };
  await fs.writeFile(path.join(root, 'study.json'), JSON.stringify(study));
  return { root, study };
}

test('pair reruns: a complete rerun replaces both arms, an incomplete one replaces nothing', async () => {
  const { root, study } = await fixtureCycle();
  let resolved = await resolveAttempts(root);
  assert.deepEqual(infraLost(resolved.attempts).map(item => `${item.id}:${item.arm}`), ['c-42:raw_tools', 'c-43:after']);

  const rerun = rerunStudy(study, ['c-42', 'c-43'], { number: 1, reason: 'host OOM killed the model server', cycleDir: root, at: '2026-11-20T18:00:00.000Z' });
  assert.deepEqual(rerun.onlyKeys, ['c-42:after', 'c-42:raw_tools', 'c-43:after', 'c-43:raw_tools']);
  assert.match(rerun.limitations.at(-1), /Pair rerun 1 .*c-42, c-43, both arms.*host OOM/);
  assert.throws(() => rerunStudy(study, ['c-42'], { number: 1, reason: 'oom', cycleDir: root }), /stated infrastructure reason/);

  await fs.mkdir(path.join(root, 'rerun-1', 'results'), { recursive: true });
  await fs.writeFile(path.join(root, 'rerun-1', 'study.json'), JSON.stringify(rerun));
  await fs.writeFile(path.join(rerun.output, 'ledger.jsonl'), [
    ledgerLine('c-42:after', '/x/42a', { content: 'A42 again' }), ledgerLine('c-42:raw_tools', '/x/42r', { content: 'R42 again' }),
    ledgerLine('c-43:after', '/x/43a', { content: 'A43 again' }),
  ].join('\n') + '\n');
  resolved = await resolveAttempts(root);
  assert.equal(resolved.attempts.get('c-42').run, 'rerun-1');
  assert.equal(resolved.attempts.get('c-42').arms.after.result.content, 'A42 again', 'the surviving main-run answer is superseded too');
  assert.equal(resolved.attempts.get('c-43').run, 'main');
  assert.deepEqual(resolved.incomplete, [{ id: 'c-43', run: 'rerun-1' }]);
  assert.deepEqual(infraLost(resolved.attempts).map(item => item.id), ['c-43']);
});

test('packets: blind letters are recorded, lost answers say so, nothing is remapped', async () => {
  const { root } = await fixtureCycle();
  const { cases, attempts } = await resolveAttempts(root);
  const gold = cases.map(c => ({ id: c.id, criteria: ['Accurate'] }));
  const flips = [0, 1];
  const built = buildPackets({ kind: 'research', ids: ['c-41', 'c-42'], cases, gold, attempts, random: () => flips.shift() });
  assert.deepEqual(built.map['c-41'], { X: 'after', Y: 'raw_tools' });
  assert.deepEqual(built.map['c-42'], { X: 'raw_tools', Y: 'after' });
  assert.match(built.packets['c-42'], /## Answer X\n\n\(No answer was delivered/);
  assert.doesNotMatch(built.packets['c-41'], /after|raw_tools|codali/i);
  assert.throws(() => buildPackets({ kind: 'research', ids: ['c-41'], cases, gold, attempts, map: built.map }), /already has a blind map entry/);
});

const review = (caseId, x, y) => ({ caseId, X: { criteria: [{ points: x }] }, Y: { criteria: [{ points: y }] } });

test('unblind: reviewers are averaged, close single-review cases and winner flips are listed', () => {
  const map = { a: { X: 'after', Y: 'raw_tools' }, b: { X: 'raw_tools', Y: 'after' }, c: { X: 'after', Y: 'raw_tools' } };
  const out = unblind(map, [
    { file: 'design-1.json', list: [review('a', 80, 60), review('b', 70, 75), review('c', 50, 58)] },
    { file: 'design-second-1.json', list: [review('b', 78, 72)] },
  ]);
  assert.deepEqual([out.cases.a.after, out.cases.a.raw_tools], [80, 60]);
  assert.deepEqual([out.cases.b.after, out.cases.b.raw_tools, out.cases.b.reviewers], [73.5, 74, 2]);
  assert.deepEqual(out.needSecondReviewer, ['c']);
  assert.deepEqual(out.reviewersDisagreeOnWinner, ['b']);
  assert.deepEqual(out.wins, { after: 1, raw_tools: 2, tie: 0 });
  assert.throws(() => unblind(map, [{ file: 'f', list: [review('zz', 1, 1)] }]), /not in the blind map/);
});

test('cost: tokens and minutes per category and arm, with the token ratio', async () => {
  const { root } = await fixtureCycle();
  const { cases, attempts } = await resolveAttempts(root);
  const report = costReport(attempts, cases.map(c => ({ id: c.id })));
  assert.equal(report.research.after.attempts, 3);
  assert.equal(report.research.after.errors, 1);
  assert.equal(report.research.after.medianTokens, 100);
  assert.equal(report.research.raw_tools.medianTokens, 75);
  assert.equal(report.research.tokenRatio, 1.3);
});

test('anchors: tasks Codali lost points on come first, never ceiling-for-both or undelivered, reproducible', () => {
  const { selectAnchors } = tools;
  const entry = (id, kind, after, raw, delivered = true) => ({ cycle: 4, kind, delivered, task: { id, split: 'held_out' }, rubric: { id }, scores: { after, raw_tools: raw } });
  const entries = [entry('n1', 'numeric', 100, 100), entry('n2', 'numeric', 80, 100), entry('n3', 'numeric', 60, 60), entry('n4', 'numeric', 100, 40), entry('n5', 'numeric', 40, 0, false), entry('c1', 'code', 100, 100), entry('c2', 'code', 90, 100)];
  const identity = list => list;
  const chosen = selectAnchors(entries, { numeric: 2, code: 2, shuffle: identity });
  assert.deepEqual(chosen.map(item => item.source.id), ['n2', 'n3', 'c2']);
  assert.equal(chosen[0].task.id, 'anchor-n2'); assert.equal(chosen[0].task.split, 'validation'); assert.equal(chosen[0].rubric.id, 'anchor-n2');
  assert.deepEqual(selectAnchors(entries, { numeric: 5, code: 0, shuffle: identity }).map(item => item.source.id), ['n2', 'n3', 'n4']);
});
