import type { EvalMetrics, PercentileMetric, RateMetric } from "./MetricTypes.js";
import type { EvalRunResult } from "./EvalRunner.js";
import type { EvalTaskExecution } from "./EvalTaskExecutor.js";

const computeRate = (samples: Array<boolean | null>): RateMetric => {
  let numerator = 0;
  let denominator = 0;
  let missing = 0;
  for (const sample of samples) {
    if (sample === null) {
      missing += 1;
      continue;
    }
    denominator += 1;
    if (sample) numerator += 1;
  }
  return {
    numerator,
    denominator,
    missing,
    value: denominator > 0 ? numerator / denominator : null,
  };
};

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lower === upper) return lowerValue;
  const weight = index - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
};

const computePercentiles = (samples: Array<number | null>): PercentileMetric => {
  const values = samples.filter((entry): entry is number => entry !== null);
  return {
    sample_size: values.length,
    missing: samples.length - values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
};

const toFirstPassSample = (result: EvalTaskExecution): boolean | null => {
  if (!result.task_passed) return false;
  if (result.first_pass === null) return null;
  return result.first_pass;
};

const toPatchApplySample = (result: EvalTaskExecution): boolean | null => {
  if (result.patch_apply_success !== null) return result.patch_apply_success;
  const hasPatchExpectation = result.assertion_results.some(
    (assertion) => assertion.code === "assert_expect_patch_apply",
  );
  if (!hasPatchExpectation) return null;
  return false;
};

const toVerificationSample = (result: EvalTaskExecution): boolean | null => result.verification_passed;

const toHallucinationSample = (result: EvalTaskExecution): boolean | null => {
  if (result.hallucination_detected === null) return null;
  return result.hallucination_detected;
};

const toScopeViolationSample = (result: EvalTaskExecution): boolean | null => {
  if (result.scope_violation_detected === null) return null;
  return result.scope_violation_detected;
};

export const aggregateMetrics = (run: EvalRunResult): EvalMetrics => {
  const taskSuccess = run.task_results.map((result) => result.task_passed);
  const firstPass = run.task_results.map((result) => toFirstPassSample(result));
  const patchApply = run.task_results.map((result) => toPatchApplySample(result));
  const verificationPass = run.task_results.map((result) => toVerificationSample(result));
  const hallucinationRate = run.task_results.map((result) => toHallucinationSample(result));
  const scopeViolationRate = run.task_results.map((result) => toScopeViolationSample(result));
  const latency = run.task_results.map((result) => result.latency_ms);
  const successfulTasks = run.task_results.filter((result) => result.task_passed);
  const successfulTokens = successfulTasks.map((result) => result.tokens_used);
  const successfulCost = successfulTasks.map((result) => result.cost_usd);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task_count: run.summary.total,
    m001_task_success_rate: computeRate(taskSuccess.map((value) => value)),
    m002_first_pass_success_rate: computeRate(firstPass),
    m003_patch_apply_success_rate: computeRate(patchApply),
    m004_verification_pass_rate: computeRate(verificationPass),
    m005_hallucination_rate: computeRate(hallucinationRate),
    m006_scope_violation_rate: computeRate(scopeViolationRate),
    m007_latency_ms: computePercentiles(latency),
    m008_success_tokens: computePercentiles(successfulTokens),
    m008_success_cost_usd: computePercentiles(successfulCost),
  };
};
