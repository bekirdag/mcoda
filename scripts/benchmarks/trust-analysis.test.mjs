import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrustStudy, pairedFamilyBootstrap, pairedMeasurements, targetQualification, validateSelectionFreeze } from './analyze-trust-benchmark.mjs';

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

const targets = { semanticGainPercentagePoints: 10, tokenRatioMaximum: 1.5,
  medianLatencyRatioMaximum: 1.5, p95LatencyRatioMaximum: 1.5 };
const pairedRows = () => Array.from({ length: 100 }, (_, index) => [
  row(`candidate-${index}`, 'codali_selected', true, { family: `family-${index}`, usage: { tokens: 150, estimated: false }, elapsedMs: 150 }),
  row(`raw-${index}`, 'raw_direct', index >= 10, { family: `family-${index}`, usage: { tokens: 100, estimated: false }, elapsedMs: 100 }),
]);
const qualify = measurement => targetQualification({ measurement, targets, scope: 'held_out', complete: true,
  eligible: true, candidateMatchesFreeze: true });

test('qualification measures semantic gain and inclusive 1.5x paired cost boundaries', () => {
  const measurement = pairedMeasurements(pairedRows());
  assert.equal(measurement.semantic.accuracyGain, .1);
  assert.deepEqual(measurement.ratios, { tokens: 1.5, p50Latency: 1.5, p95Latency: 1.5 });
  assert.equal(qualify(measurement).passed, true);
  const expensive = pairedRows(); expensive[0][0].usage.tokens++;
  assert.match(qualify(pairedMeasurements(expensive)).reasons.join(), /tokens target/);
  const slow = pairedRows(); for (let i = 0; i < 6; i++) slow[i][0].elapsedMs = 151;
  assert.match(qualify(pairedMeasurements(slow)).reasons.join(), /p95Latency target/);
  const formatOnly = pairedRows(); for (const [, baseline] of formatOnly) baseline.grade.semanticPassed = true;
  assert.equal(pairedMeasurements(formatOnly).semantic.accuracyGain, 0);
  assert.equal(qualify(pairedMeasurements(formatOnly)).passed, false);
});

test('estimated usage, missing reviews, failed tool evidence and zero dispatch cannot qualify', () => {
  for (const mutate of [
    row => { row.usage.estimated = true; },
    row => { delete row.usage.estimated; },
    row => { row.usage.pendingReservations = ['unsettled']; },
    row => { row.usage.tokens = NaN; },
    row => { row.elapsedMs = null; },
    row => { row.modelRequests = 0; },
    row => { row.error = 'Timeout'; },
    row => { row.critical = true; row.criticalReviewed = false; },
    row => { row.criticalFailure = true; },
    row => { row.grade.status = 'needs_review'; },
    row => { delete row.grade.semanticPassed; },
    row => { row.grade.toolEvidence = { required: true, passed: false }; },
  ]) {
    const pairs = pairedRows(); mutate(pairs[0][0]);
    assert.equal(qualify(pairedMeasurements(pairs)).passed, false, String(mutate));
  }
  const base = { measurement: pairedMeasurements(pairedRows()), targets, scope: 'held_out', complete: true, eligible: true, candidateMatchesFreeze: true };
  for (const change of [{ complete: false }, { eligible: false }, { candidateMatchesFreeze: false }, { scope: 'all' }, { targets: undefined }]) {
    assert.equal(targetQualification({ ...base, ...change }).passed, false);
  }
});

test('a prospective freeze binds runtime, corpus, selected config and every attempt timestamp', () => {
  const scores = [row('candidate', 'codali_selected', true)];
  const report = { corpus: { promptsSha256: 'corpus' }, runtimeFingerprint: 'runtime' };
  const freeze = { targets, configHash: 'hash', corpusHash: 'corpus', clientFingerprint: 'runtime', createdAt: '2025-12-31T00:00:00Z' };
  assert.doesNotThrow(() => validateSelectionFreeze(freeze, report, scores));
  for (const change of [{ corpusHash: 'wrong' }, { clientFingerprint: 'wrong' }, { configHash: 'wrong' },
    { createdAt: '2026-01-02T00:00:00Z' }, { createdAt: '' }, { targets: { ...targets, tokenRatioMaximum: NaN } }]) {
    assert.throws(() => validateSelectionFreeze({ ...freeze, ...change }, report, scores));
  }
});

test('secondary semantic review covers a formatting failure without erasing its strict failure', () => {
  const scores = [row('candidate', 'codali_selected', false, { grade: { status: 'failed', passed: false, outputSha256: 'output', failures: ['word limit'] } }), row('raw', 'raw_direct', true)];
  const review = { attemptId: 'candidate', caseId: 'a', outputSha256: 'output', semanticCorrect: true,
    changesStrictScore: false, reviewer: 'reviewer', evidence: 'Value independently checked; word limit still fails.' };
  const analysis = analyzeTrustStudy(scores, report(2), tasks, [review]);
  assert.equal(analysis.aggregates['codali_selected:chosen'].all.passed, 0);
  assert.equal(analysis.comparisons[0].measurement.semantic.accuracyGain, 0);
  assert.equal(analysis.qualification[0].passed, false);
});

test('qualification needs all cases and both raw baselines, never an exposed development replay', () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `case-${i}`, family: `family-${i}`, domain: 'math_and_data', split: 'held_out', toolParity: 'full' }));
  const scores = pairedRows().flatMap(([candidate, baseline], i) => [candidate, baseline,
    { ...baseline, attemptId: `tool-${i}`, arm: 'raw_tools' }].map(row => ({ ...row, caseId: tasks[i].id })));
  const report = { attempts: 300, primaryAttempts: 300, corpus: { version: 'new100', promptsSha256: 'corpus', qualificationEligible: true }, runtimeFingerprint: 'runtime', paired: [] };
  const freeze = { targets, configHash: 'hash', corpusHash: 'corpus', clientFingerprint: 'runtime', createdAt: '2025-12-31T00:00:00Z' };
  assert.equal(analyzeTrustStudy(scores, report, tasks, [], [], freeze).qualification[0].passed, true);
  const noTools = scores.filter(row => row.arm !== 'raw_tools');
  assert.equal(analyzeTrustStudy(noTools, { ...report, attempts: 200, primaryAttempts: 200 }, tasks, [], [], freeze).qualification[0].passed, false);
  assert.equal(analyzeTrustStudy(scores, { ...report, corpus: { ...report.corpus, qualificationEligible: false } }, tasks, [], [], freeze).qualification[0].passed, false);
});
