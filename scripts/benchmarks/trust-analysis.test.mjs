import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrustStudy, pairedFamilyBootstrap } from './analyze-trust-benchmark.mjs';

test('bootstrap resamples whole families and weights their original case counts', () => {
  const pairs = [...Array.from({ length: 9 }, () => ({ family: 'large', candidatePassed: true, baselinePassed: false })),
    { family: 'small', candidatePassed: false, baselinePassed: true }];
  const result = pairedFamilyBootstrap(pairs);
  assert.equal(result.accuracyGain, .8);
  assert.deepEqual(result.familyBootstrap95, [-1, 1]);
  assert.deepEqual(pairedFamilyBootstrap([...pairs].reverse()), result);
  assert.equal(pairedFamilyBootstrap([]), null);
  assert.throws(() => pairedFamilyBootstrap(pairs, NaN));
  assert.throws(() => pairedFamilyBootstrap(pairs, 1, 0));
});

const tasks = [{ id: 'a', family: 'f', domain: 'math_and_data', split: 'held_out', toolParity: 'calculation' },
  { id: 'b', family: 'g', domain: 'general_knowledge', split: 'held_out' }];
const row = (id, arm, pass, extra = {}) => ({ attemptId: id, caseId: 'a', family: 'f', domain: 'math_and_data', split: 'held_out',
  arm, configGroup: 'chosen', configHash: 'hash', startedAt: '2026-01-01T00:00:00Z',
  grade: { passed: pass, status: pass ? 'passed' : 'failed', semanticPassed: pass, outputSha256: 'output' },
  modelRequests: 1, modelResponses: 1, elapsedMs: 10, usage: { tokens: 20 }, ...extra });
const report = (attempts, primaryAttempts = attempts) => ({ attempts, primaryAttempts, corpus: { version: 'test' }, paired: [] });

test('a successful retry repairs dispatch coverage but never replaces a first failure', () => {
  const scores = [row('raw', 'raw_direct', true), row('first', 'codali_selected', false, { modelRequests: 0, modelResponses: 0, error: '429' }),
    row('retry', 'codali_selected', true, { retryOf: 'first', startedAt: '2026-01-02T00:00:00Z' }), row('tool', 'raw_tools', true)];
  const analysis = analyzeTrustStudy(scores, report(4, 3), tasks);
  const selected = analysis.aggregates['codali_selected:chosen'];
  assert.equal(selected.all.passed, 0);
  assert.equal(selected.retries.passed, 1);
  assert.equal(selected.corpusCoverage.dispatchedCasesIncludingRetries, 1);
  assert.deepEqual(selected.corpusCoverage.missingCases, ['b']);
  assert.equal(analysis.comparisons.find(x => x.scope === 'held_out' && x.baselineArm === 'raw_direct').accuracyGain, -1);
  assert.equal(analysis.aggregates['raw_tools:chosen'].corpusCoverage.expected, 1);
  assert.throws(() => analyzeTrustStudy([{ ...scores[2], configHash: 'different' }, scores[1]], report(2, 1), tasks), /Retry/);
});

test('secondary semantic review is hash-bound and cannot change strict or critical outcomes', () => {
  const scores = [row('raw', 'raw_direct', true), row('selected', 'codali_selected', false, { critical: true, criticalReviewed: true, criticalFailure: true })];
  const review = { attemptId: 'selected', caseId: 'a', outputSha256: 'output', semanticCorrect: true,
    changesStrictScore: false, reviewer: 'primary-agent', evidence: 'Correct value in prose; strict JSON failed.' };
  const analysis = analyzeTrustStudy(scores, report(2), tasks, [review]);
  const selected = analysis.aggregates['codali_selected:chosen'].all;
  assert.equal(selected.passed, 0); assert.equal(selected.criticalFailures, 1);
  assert.equal(selected.semantic.gradedEligible, 1);
  assert.equal(selected.semantic.gradedPassed, 0);
  assert.equal(Object.hasOwn(selected.semantic, 'automaticPassed'), false);
  assert.equal(selected.semantic.secondaryCorrect, 1);
  assert.throws(() => analyzeTrustStudy(scores, report(2), tasks, [{ ...review, outputSha256: 'wrong' }]), /Secondary/);
  assert.throws(() => analyzeTrustStudy(scores, report(2), tasks, [review, review]), /Secondary/);
  assert.throws(() => analyzeTrustStudy(scores, report(2), tasks, [{ ...review, changesStrictScore: true }]), /Secondary/);
});

test('missing rubric and critical reviews remain visible in paired results', () => {
  const scores = [row('raw', 'raw_direct', true), row('selected', 'codali_selected', false,
    { grade: { passed: false, status: 'needs_review' }, critical: true, criticalReviewed: false })];
  const analysis = analyzeTrustStudy(scores, report(2), tasks);
  assert.equal(analysis.comparisons.find(x => x.scope === 'held_out').pendingReviews, 1);
  assert.equal(analysis.aggregates['codali_selected:chosen'].all.needsReview, 1);
  assert.throws(() => analyzeTrustStudy(scores, report(1), tasks), /mismatch/);
});
