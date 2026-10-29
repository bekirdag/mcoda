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

export function analyzeTrustStudy(scores, report, tasks, semanticReviews = [], excludedFamilies = []) {
  const byId = new Map(scores.map(row => [row.attemptId, row]));
  if (byId.size !== scores.length || report.attempts !== scores.length) throw Error('Score/report attempt mismatch');
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const knownFamilies = new Set(tasks.map(task => task.family));
  if (excludedFamilies.some(family => !knownFamilies.has(family))) throw Error('Unknown excluded family');
  const first = new Map();
  for (const row of scores) {
    if (!taskMap.has(row.caseId) || row.family !== taskMap.get(row.caseId).family) throw Error('Unknown/mismatched case');
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
        review.changesStrictScore !== false || row.error || row.grade.semanticPassed !== false) {
      throw Error('Secondary review must bind a failed automatic semantic grade without changing strict scores');
    }
    semantics.set(review.attemptId, review);
  }
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
      automaticEligible: rows.filter(row => typeof row.grade.semanticPassed === 'boolean').length,
      automaticPassed: rows.filter(row => row.grade.semanticPassed === true).length,
      secondaryReviewed: rows.filter(row => semantics.has(row.attemptId)).length,
      secondaryCorrect: rows.filter(row => semantics.get(row.attemptId)?.semanticCorrect).length,
      qualification: 'Secondary semantic review never changes strict correctness, tool evidence or critical grades.',
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
        comparisons.push({ candidate, baselineArm, scope, ...paired,
          candidatePasses: matches.filter(([a]) => a.grade.passed).length, baselinePasses: matches.filter(([, b]) => b.grade.passed).length,
          wins: matches.filter(([a, b]) => a.grade.passed && !b.grade.passed).length,
          losses: matches.filter(([a, b]) => !a.grade.passed && b.grade.passed).length,
          pendingReviews: matches.filter(pair => pair.some(row => row.grade.status === 'needs_review' || (row.critical && !row.criticalReviewed))).length,
          qualification: scope === 'held_out' ? 'Use the frozen study promotion rules; no automatic promotion here.' : 'Descriptive/exploratory comparison, not an independent promotion test.',
        });
      }
    }
  }
  return { schemaVersion: 1, attempts: scores.length, primaryAttempts: primary.length,
    corpusVersion: report.corpus.version, protocolVersion: report.protocolVersion, runtimeFingerprint: report.runtimeFingerprint,
    aggregates, comparisons, excludedFamilies, officialHeldOutGate: report.paired,
    limitations: ['Family-correlated synthetic tasks; primary agent authored and reviewed rubrics.',
      'Shared-host latency is observational, not isolated performance measurement.',
      'First-attempt failures remain primary; successful retries only repair dispatch coverage.',
      'Domain intervals and repeated comparisons are descriptive and not multiplicity-adjusted.',
      'Single-family intervals cannot estimate uncertainty across unseen families.'] };
}

async function main() {
  const args = argumentsMap(undefined, ['scores', 'report', 'corpus-root', 'output', 'semantic-reviews', 'exclude-family']);
  if (!args.scores || !args.report || !args['corpus-root'] || !args.output) throw Error('Require --scores, --report, --corpus-root and --output NEW_DIR');
  const report = await json(args.report), scores = await jsonl(args.scores);
  const { cases, manifest } = await readPublicCorpus(path.resolve(args['corpus-root']));
  if (manifest.promptsSha256 !== report.corpus.promptsSha256) throw Error('Analysis corpus differs from score corpus');
  const reviews = args['semantic-reviews'] ? await jsonl(args['semantic-reviews']) : [];
  const analysis = analyzeTrustStudy(scores, report, cases, reviews, args['exclude-family']?.split(',') ?? []);
  analysis.at = new Date().toISOString();
  analysis.evidence = { scores: hash(await fs.readFile(args.scores)), report: hash(await fs.readFile(args.report)),
    analyzer: hash(await fs.readFile(new URL(import.meta.url))),
    semanticReviews: args['semantic-reviews'] ? hash(await fs.readFile(args['semantic-reviews'])) : null };
  await fs.mkdir(args.output, { mode: 0o700 });
  await writeNew(path.join(args.output, 'analysis.json'), analysis);
  console.log(JSON.stringify({ output: args.output, attempts: scores.length, comparisons: analysis.comparisons.length }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
