import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFromCycle, seededShuffle } from './regression-pack.mjs';

const task = (id, domain, comparison = 'answer') => ({ id, domain, comparison });
const attempts = new Map([
  ['n1', { score: 100, flags: [] }], ['n2', { score: 60, flags: [] }],
  ['c1', { score: 0, flags: [{ severity: 'high', code: 'NO_CODE_BLOCK' }] }],
  ['d1', { flags: [] }], ['r1', { flags: [{ severity: 'high', code: 'EMPTY_ANSWER' }] }], ['a1', { flags: [{ severity: 'high', code: 'ATTEMPT_ERROR' }] }],
]);
const cycle = { cases: [task('n1', 'quantitative'), task('n2', 'quantitative'), task('c1', 'software'), task('d1', 'software'), task('r1', 'research'), task('a1', 'web', 'implementation')],
  gold: [{ id: 'n1', expected: {} }, { id: 'n2', expected: {} }, { id: 'c1', pythonTests: [] }, { id: 'd1' }, { id: 'r1' }, { id: 'a1', app: true }],
  attempts, reviewScores: { d1: { after: 60, raw_tools: 80 } } };

test('failures are automatic-score misses and hard triage flags; app builds are left out', () => {
  const { failures, passes } = selectFromCycle(cycle);
  assert.deepEqual(failures.map(item => item.id), ['n2', 'c1', 'r1']);
  assert.deepEqual(passes.map(item => item.id), ['n1']);
});

test('lost blind reviews are included only on request', () => {
  assert.ok(selectFromCycle(cycle, { includeReviewed: true }).failures.some(item => item.id === 'd1' && /lost blind review 60 vs 80/.test(item.reasons[0])));
});

test('sampling is reproducible from its seed', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(seededShuffle(items, 's'), seededShuffle(items, 's'));
  assert.notDeepEqual(seededShuffle(items, 's'), seededShuffle(items, 't'));
  assert.deepEqual([...seededShuffle(items, 's')].sort((a, b) => a - b), items);
});
