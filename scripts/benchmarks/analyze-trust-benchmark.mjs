import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsMap, hash, json, jsonl, readPublicCorpus, writeNew, hasToolBaseline } from './trust-common.mjs';

// Resample whole families, preserving their case counts. Variants are not independent.
export function pairedFamilyBootstrap(pairs, seed = 20261028, iterations = 10000) {
  if (!Array.isArray(pairs) || !Number.isInteger(iterations) || iterations < 1 || !Number.isFinite(seed)) {
    throw Error('Invalid bootstrap input');
  }
  if (!pairs.length) return null;
  const grouped = new Map();
  for (const pair of pairs) {
    if (!pair.family || typeof pair.candidatePassed !== 'boolean' || typeof pair.baselinePassed !== 'boolean') {
      throw Error('Pairs require family and boolean outcomes');
    }
    const group = grouped.get(pair.family) ?? { count: 0, difference: 0 };
    group.count++;
    group.difference += Number(pair.candidatePassed) - Number(pair.baselinePassed);
    grouped.set(pair.family, group);
  }
  const groups = [...grouped.keys()].sort().map(key => grouped.get(key));
  let state = (seed >>> 0) || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const draws = [];
  for (let i = 0; i < iterations; i++) {
    let difference = 0, count = 0;
    for (let j = 0; j < groups.length; j++) {
      const group = groups[Math.floor(random() * groups.length)];
      difference += group.difference; count += group.count;
    }
    draws.push(difference / count);
  }
  draws.sort((a, b) => a - b);
  return {
    cases: pairs.length, families: groups.length,
    accuracyGain: groups.reduce((n, group) => n + group.difference, 0) / pairs.length,
    familyBootstrap95: [draws[Math.floor(iterations * .025)], draws[Math.floor(iterations * .975)]],
  };
}

export function validateSelectionFreeze(freeze, report, scores) {
  const targets = freeze?.targets;
  const fields = ['semanticGainPercentagePoints', 'tokenRatioMaximum', 'medianLatencyRatioMaximum', 'p95LatencyRatioMaximum'];
  if (!targets || fields.some(field => !Number.isFinite(targets[field]) || targets[field] <= 0) || targets.semanticGainPercentagePoints > 100) {
    throw Error('Selection freeze requires explicit positive quality, token and latency targets');
  }
  if (freeze.corpusHash !== report.corpus.promptsSha256 || freeze.clientFingerprint !== report.runtimeFingerprint ||
      !scores.some(row => row.arm.startsWith('codali_') && row.configHash === freeze.configHash)) {
    throw Error('Selection freeze does not match corpus, runtime or candidate configuration');
  }
  const at = Date.parse(freeze.createdAt);
  if (!Number.isFinite(at) || scores.some(row => !Number.isFinite(Date.parse(row.startedAt)) || Date.parse(row.startedAt) < at)) {
    throw Error('Selection and targets must be frozen before every evaluated attempt');
  }
}

/** Cost comparisons use the exact same primary cases, including failed attempts. */
export function pairedMeasurements(matches, semanticOutcome = row => row.error ? false : row.grade.semanticPassed) {
  const candidates = matches.map(([a]) => a), baselines = matches.map(([, b]) => b);
  const percentile = (rows, p) => {
    const values = rows.map(row => row.elapsedMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    return values.length ? values[Math.ceil(values.length * p) - 1] : null;
  };
  const side = rows => ({
    tokens: rows.reduce((sum, row) => sum + (Number.isSafeInteger(row.usage?.tokens) && row.usage.tokens >= 0 ? row.usage.tokens : 0), 0),
    tokenUnknown: rows.filter(row => !Number.isSafeInteger(row.usage?.tokens) || row.usage.tokens < 0 || row.usage.estimated !== false || row.usage.pendingReservations?.length).length,
    latencyUnknown: rows.filter(row => !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0).length,
    latencyMs: { p50: percentile(rows, .5), p95: percentile(rows, .95) },
    errors: rows.filter(row => row.error).length,
    incompleteDispatch: rows.filter(row => !(row.modelRequests > 0 && row.modelResponses > 0)).length,
    semanticUnknown: rows.filter(row => typeof semanticOutcome(row) !== 'boolean').length,
    semanticPasses: rows.filter(row => semanticOutcome(row) === true).length,
    reviewPending: rows.filter(row => row.grade.status === 'needs_review' || row.critical && !row.criticalReviewed).length,
    criticalFailures: rows.filter(row => row.criticalFailure).length,
    toolEvidenceFailures: rows.filter(row => row.grade.toolEvidence?.required && row.grade.toolEvidence.passed !== true).length,
  });
  const candidate = side(candidates), baseline = side(baselines);
  const ratio = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null;
  const semantic = candidate.semanticUnknown + baseline.semanticUnknown === 0 ? pairedFamilyBootstrap(matches.map(([a, b]) => ({
    family: a.family, candidatePassed: semanticOutcome(a), baselinePassed: semanticOutcome(b),
  }))) : null;
  return { candidate, baseline, semantic,
    strictGain: matches.length ? matches.reduce((sum, [a, b]) => sum + Number(a.grade.passed) - Number(b.grade.passed), 0) / matches.length : null,
    ratios: { tokens: candidate.tokenUnknown + baseline.tokenUnknown ? null : ratio(candidate.tokens, baseline.tokens),
      p50Latency: candidate.latencyUnknown + baseline.latencyUnknown ? null : ratio(candidate.latencyMs.p50, baseline.latencyMs.p50),
      p95Latency: candidate.latencyUnknown + baseline.latencyUnknown ? null : ratio(candidate.latencyMs.p95, baseline.latencyMs.p95) } };
}

export function targetQualification({ scope, complete, measurement, targets, eligible, candidateMatchesFreeze }) {
  const reasons = [];
  if (scope !== 'held_out' || !eligible) reasons.push('Corpus/scope is exploratory, not an eligible independent holdout');
  if (!complete) reasons.push('Missing primary cases for this comparison');
  if (!targets || !candidateMatchesFreeze) reasons.push('No matching prospective selection and target freeze');
  for (const name of ['candidate', 'baseline']) {
    const side = measurement[name];
    if (side.tokenUnknown || side.latencyUnknown) reasons.push(`${name}: incomplete or estimated usage/timing`);
    if (side.errors || side.incompleteDispatch) reasons.push(`${name}: inference/infrastructure failures remain`);
    if (side.semanticUnknown || side.reviewPending) reasons.push(`${name}: semantic or critical reviews remain`);
    if (side.criticalFailures || side.toolEvidenceFailures) reasons.push(`${name}: critical or explicit tool-evidence failures`);
  }
  if (targets) {
    if (!measurement.semantic || measurement.semantic.accuracyGain + 1e-12 < targets.semanticGainPercentagePoints / 100 ||
        measurement.semantic.families < 2 || measurement.semantic.familyBootstrap95[0] <= 0) reasons.push('Semantic improvement or family uncertainty target not met');
    if (measurement.strictGain === null || measurement.strictGain < 0) reasons.push('Strict correctness regressed');
    for (const [metric, threshold] of [['tokens', 'tokenRatioMaximum'], ['p50Latency', 'medianLatencyRatioMaximum'], ['p95Latency', 'p95LatencyRatioMaximum']]) {
      if (measurement.ratios[metric] === null || measurement.ratios[metric] > targets[threshold]) reasons.push(`${metric} target not met or not measurable`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function analyzeTrustStudy(scores, report, tasks, semanticReviews = [], excludedFamilies = [], freeze) {
  const byId = new Map(scores.map(row => [row.attemptId, row]));
  if (byId.size !== scores.length || report.attempts !== scores.length) throw Error('Score/report attempt mismatch');
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const knownFamilies = new Set(tasks.map(task => task.family));
  if (excludedFamilies.some(family => !knownFamilies.has(family))) throw Error('Unknown excluded family');
  const first = new Map();
  for (const row of scores) {
    const task = taskMap.get(row.caseId);
    if (!task || row.family !== task.family || row.domain !== task.domain || row.split !== task.split) throw Error('Unknown/mismatched case');
    if (typeof row.grade?.passed !== 'boolean') throw Error('Missing grade');
    if (row.retryOf) {
      const previous = byId.get(row.retryOf);
      if (!previous || previous.caseId !== row.caseId || previous.arm !== row.arm || previous.configHash !== row.configHash) {
        throw Error('Retry must preserve original case, arm and configuration');
      }
      continue;
    }
    const key = JSON.stringify([row.arm, row.configGroup, row.caseId]);
    const previous = first.get(key);
    if (previous && (!Number.isFinite(Date.parse(previous.startedAt)) || !Number.isFinite(Date.parse(row.startedAt)))) {
      throw Error('Repeated first attempts require timestamps');
    }
    if (!previous || Date.parse(row.startedAt) < Date.parse(previous.startedAt)) first.set(key, row);
  }
  const primary = [...first.values()];
  if (report.primaryAttempts !== primary.length) throw Error('Primary score/report count mismatch');
  const semantics = new Map();
  for (const review of semanticReviews) {
    const row = byId.get(review.attemptId);
    if (!row || semantics.has(review.attemptId) || row.caseId !== review.caseId || row.grade.outputSha256 !== review.outputSha256 ||
        typeof review.semanticCorrect !== 'boolean' || !review.reviewer?.trim() || !review.evidence?.trim() ||
        review.changesStrictScore !== false || row.error || row.grade.status !== 'failed' || row.grade.semanticPassed === true) {
      throw Error('Secondary review must bind a failed grade without changing strict scores');
    }
    semantics.set(review.attemptId, review);
  }
  const semanticOutcome = row => row.error ? false : semantics.get(row.attemptId)?.semanticCorrect ?? row.grade.semanticPassed;
  const targets = freeze?.targets;
  if (freeze) validateSelectionFreeze(freeze, report, scores);
  const percentile = (rows, get, p) => {
    const values = rows.map(get).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? values[Math.ceil(values.length * p) - 1] : null;
  };
  const summarize = rows => ({
    attempts: rows.length, passed: rows.filter(row => row.grade.passed).length,
    strictAccuracy: rows.length ? rows.filter(row => row.grade.passed).length / rows.length : null,
    needsReview: rows.filter(row => row.grade.status === 'needs_review').length,
    errors: rows.filter(row => row.error).length,
    criticalFailures: rows.filter(row => row.criticalFailure).length,
    criticalUnreviewed: rows.filter(row => row.critical && !row.criticalReviewed).length,
    zeroDispatch: rows.filter(row => !row.modelRequests).length,
    unansweredDispatch: rows.filter(row => row.modelRequests > 0 && !row.modelResponses).length,
    latencyMs: { p50: percentile(rows, row => row.elapsedMs, .5), p95: percentile(rows, row => row.elapsedMs, .95) },
    tokens: { p50: percentile(rows, row => row.usage?.tokens, .5), p95: percentile(rows, row => row.usage?.tokens, .95),
      sum: rows.reduce((n, row) => n + (Number.isFinite(row.usage?.tokens) ? row.usage.tokens : 0), 0),
      known: rows.filter(row => Number.isFinite(row.usage?.tokens)).length, estimated: rows.filter(row => row.usage?.estimated).length },
    semantic: {
      gradedEligible: rows.filter(row => typeof row.grade.semanticPassed === 'boolean').length,
      gradedPassed: rows.filter(row => row.grade.semanticPassed === true).length,
      secondaryReviewed: rows.filter(row => semantics.has(row.attemptId)).length,
      secondaryCorrect: rows.filter(row => semantics.get(row.attemptId)?.semanticCorrect).length,
      qualification: 'Semantic grades include applied rubric reviews, so this is not an automatic-only metric. Secondary semantic review never changes strict correctness, tool evidence or critical grades.',
    },
  });
  const groups = [...new Set(primary.map(row => `${row.arm}:${row.configGroup}`))].sort();
  const aggregates = {};
  for (const key of groups) {
    const rows = primary.filter(row => `${row.arm}:${row.configGroup}` === key);
    const arm = rows[0].arm;
    const expected = tasks.filter(task => arm !== 'raw_tools' || hasToolBaseline(task));
    const allAttempts = scores.filter(row => `${row.arm}:${row.configGroup}` === key);
    const ids = new Set(rows.map(row => row.caseId));
    aggregates[key] = {
      all: summarize(rows),
      splits: Object.fromEntries(['development', 'validation', 'held_out'].map(split => [split, summarize(rows.filter(row => row.split === split))])),
      domains: Object.fromEntries([...new Set(rows.map(row => row.domain))].sort().map(domain => [domain, summarize(rows.filter(row => row.domain === domain))])),
      corpusCoverage: { expected: expected.length, firstAttemptCases: ids.size,
        missingCases: expected.filter(task => !ids.has(task.id)).map(task => task.id),
        splits: Object.fromEntries(['development', 'validation', 'held_out'].map(split => [split, {
          expected: expected.filter(task => task.split === split).length,
          firstAttemptCases: rows.filter(row => row.split === split).length,
          dispatchedCasesIncludingRetries: new Set(allAttempts.filter(row => row.split === split && row.modelRequests > 0).map(row => row.caseId)).size,
        }])),
        dispatchedCasesIncludingRetries: new Set(allAttempts.filter(row => row.modelRequests > 0).map(row => row.caseId)).size,
        answeredCasesIncludingRetries: new Set(allAttempts.filter(row => row.modelResponses > 0).map(row => row.caseId)).size },
      retries: summarize(allAttempts.filter(row => row.retryOf)),
    };
  }
  const comparisons = [];
  for (const candidate of groups.filter(key => key.startsWith('codali_'))) {
    const candidateRows = primary.filter(row => `${row.arm}:${row.configGroup}` === candidate);
    const group = candidateRows[0].configGroup;
    for (const baselineArm of ['raw_direct', 'raw_tools']) {
      const baseline = new Map(primary.filter(row => row.arm === baselineArm && row.configGroup === group).map(row => [row.caseId, row]));
      if (!baseline.size) continue;
      const views = [['all', () => true], ['held_out', row => row.split === 'held_out'],
        ...[...new Set(candidateRows.map(row => row.domain))].sort().map(domain => [`domain:${domain}`, row => row.domain === domain])];
      if (excludedFamilies.length) views.push(['sensitivity:excluded-families', row => !excludedFamilies.includes(row.family)]);
      for (const [scope, include] of views) {
        const matches = candidateRows.filter(row => include(row) && baseline.has(row.caseId)).map(row => [row, baseline.get(row.caseId)]);
        if (!matches.length) continue;
        const paired = pairedFamilyBootstrap(matches.map(([a, b]) => ({ family: a.family, candidatePassed: a.grade.passed, baselinePassed: b.grade.passed })));
        const expected = tasks.filter(include);
        const measurement = pairedMeasurements(matches, semanticOutcome);
        const complete = expected.length > 0 && expected.every(task => matches.some(([row]) => row.caseId === task.id));
        const qualification = targetQualification({ scope, complete, measurement, targets,
          eligible: report.corpus.qualificationEligible === true,
          candidateMatchesFreeze: !!freeze && matches.every(pair => pair.every(row => row.configHash === freeze.configHash)) });
        comparisons.push({ candidate, baselineArm, scope, ...paired,
          candidatePasses: matches.filter(([a]) => a.grade.passed).length, baselinePasses: matches.filter(([, b]) => b.grade.passed).length,
          wins: matches.filter(([a, b]) => a.grade.passed && !b.grade.passed).length,
          losses: matches.filter(([a, b]) => !a.grade.passed && b.grade.passed).length,
          pendingReviews: matches.filter(pair => pair.some(row => row.grade.status === 'needs_review' || (row.critical && !row.criticalReviewed))).length,
          expectedCases: expected.length, complete, measurement, qualification,
        });
      }
    }
  }
  return { schemaVersion: 1, attempts: scores.length, primaryAttempts: primary.length,
    corpusVersion: report.corpus.version, protocolVersion: report.protocolVersion, runtimeFingerprint: report.runtimeFingerprint,
    aggregates, comparisons, excludedFamilies, targets: targets ?? null,
    qualification: groups.filter(key => key.startsWith('codali_')).map(candidate => {
      const compared = comparisons.filter(row => row.candidate === candidate && row.scope === 'held_out');
      return { candidate, passed: ['raw_direct', 'raw_tools'].every(arm => compared.some(row => row.baselineArm === arm && row.qualification.passed)),
        comparisons: compared.map(row => ({ baselineArm: row.baselineArm, ...row.qualification })) };
    }),
    legacyScorerComparisons: report.paired,
    limitations: ['Family-correlated synthetic tasks; primary agent authored and reviewed rubrics.',
      'Shared-host latency is observational, not isolated performance measurement.',
      'First-attempt failures remain primary; successful retries only repair dispatch coverage.',
      'Domain intervals and repeated comparisons are descriptive and not multiplicity-adjusted.',
      'Single-family intervals cannot estimate uncertainty across unseen families.'] };
}

async function main() {
  const args = argumentsMap(undefined, ['scores', 'report', 'corpus-root', 'output', 'semantic-reviews', 'exclude-family', 'freeze']);
  if (!args.scores || !args.report || !args['corpus-root'] || !args.output) throw Error('Require --scores, --report, --corpus-root and --output NEW_DIR');
  const report = await json(args.report), scores = await jsonl(args.scores);
  const { cases, manifest } = await readPublicCorpus(path.resolve(args['corpus-root']));
  if (manifest.promptsSha256 !== report.corpus.promptsSha256) throw Error('Analysis corpus differs from score corpus');
  const reviews = args['semantic-reviews'] ? await jsonl(args['semantic-reviews']) : [];
  const freeze = args.freeze ? await json(args.freeze) : undefined;
  const analysis = analyzeTrustStudy(scores, report, cases, reviews, args['exclude-family']?.split(',') ?? [], freeze);
  analysis.at = new Date().toISOString();
  analysis.evidence = { scores: hash(await fs.readFile(args.scores)), report: hash(await fs.readFile(args.report)),
    analyzer: hash(await fs.readFile(new URL(import.meta.url))),
    analyzerDependencies: { 'trust-common.mjs': hash(await fs.readFile(new URL('./trust-common.mjs', import.meta.url))) },
    freeze: args.freeze ? hash(await fs.readFile(args.freeze)) : null,
    semanticReviews: args['semantic-reviews'] ? hash(await fs.readFile(args['semantic-reviews'])) : null };
  await fs.mkdir(args.output, { mode: 0o700 });
  await writeNew(path.join(args.output, 'analysis.json'), analysis);
  console.log(JSON.stringify({ output: args.output, attempts: scores.length, comparisons: analysis.comparisons.length }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
