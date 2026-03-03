import type { EvalMetrics } from "./MetricTypes.js";
import type { EvalRegressionComparison } from "./RegressionComparator.js";

export interface EvalGateThresholds {
  patch_apply_drop_max: number;
  verification_pass_rate_min: number;
  hallucination_rate_max: number;
  scope_violation_rate_max: number;
}

export interface EvalGateFailure {
  code: string;
  metric: string;
  message: string;
  threshold: number;
  actual: number | null;
  baseline?: number | null;
  delta?: number | null;
}

export interface EvalGateResult {
  schema_version: 1;
  passed: boolean;
  thresholds: EvalGateThresholds;
  failures: EvalGateFailure[];
}

export const DEFAULT_EVAL_GATE_THRESHOLDS: EvalGateThresholds = {
  patch_apply_drop_max: 0.02,
  verification_pass_rate_min: 0.9,
  hallucination_rate_max: 0.02,
  scope_violation_rate_max: 0,
};

const asRate = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

const normalizeThreshold = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${label}: expected a number between 0 and 1.`);
  }
  return value;
};

export const resolveGateThresholds = (
  ...sources: Array<Partial<EvalGateThresholds> | undefined>
): EvalGateThresholds => {
  const merged: Partial<EvalGateThresholds> = { ...DEFAULT_EVAL_GATE_THRESHOLDS };
  for (const source of sources) {
    if (!source) continue;
    if (source.patch_apply_drop_max !== undefined) {
      merged.patch_apply_drop_max = source.patch_apply_drop_max;
    }
    if (source.verification_pass_rate_min !== undefined) {
      merged.verification_pass_rate_min = source.verification_pass_rate_min;
    }
    if (source.hallucination_rate_max !== undefined) {
      merged.hallucination_rate_max = source.hallucination_rate_max;
    }
    if (source.scope_violation_rate_max !== undefined) {
      merged.scope_violation_rate_max = source.scope_violation_rate_max;
    }
  }
  return {
    patch_apply_drop_max: normalizeThreshold(
      merged.patch_apply_drop_max,
      DEFAULT_EVAL_GATE_THRESHOLDS.patch_apply_drop_max,
      "patch_apply_drop_max",
    ),
    verification_pass_rate_min: normalizeThreshold(
      merged.verification_pass_rate_min,
      DEFAULT_EVAL_GATE_THRESHOLDS.verification_pass_rate_min,
      "verification_pass_rate_min",
    ),
    hallucination_rate_max: normalizeThreshold(
      merged.hallucination_rate_max,
      DEFAULT_EVAL_GATE_THRESHOLDS.hallucination_rate_max,
      "hallucination_rate_max",
    ),
    scope_violation_rate_max: normalizeThreshold(
      merged.scope_violation_rate_max,
      DEFAULT_EVAL_GATE_THRESHOLDS.scope_violation_rate_max,
      "scope_violation_rate_max",
    ),
  };
};

const findDelta = (
  comparison: EvalRegressionComparison | undefined,
  key: string,
): { baseline: number | null; current: number | null; delta: number | null } | undefined => {
  if (!comparison || comparison.status !== "compared") return undefined;
  const entry = comparison.deltas.find((delta) => delta.key === key);
  if (!entry) return undefined;
  return {
    baseline: entry.baseline,
    current: entry.current,
    delta: entry.delta,
  };
};

export const evaluateGates = (params: {
  metrics: EvalMetrics;
  thresholds: EvalGateThresholds;
  comparison?: EvalRegressionComparison;
}): EvalGateResult => {
  const failures: EvalGateFailure[] = [];
  const { metrics, thresholds, comparison } = params;

  const patchDelta = findDelta(comparison, "m003_patch_apply_success_rate");
  if (patchDelta && patchDelta.baseline !== null && patchDelta.current !== null) {
    const drop = patchDelta.baseline - patchDelta.current;
    if (drop > thresholds.patch_apply_drop_max) {
      failures.push({
        code: "gate_patch_apply_drop_exceeded",
        metric: "m003_patch_apply_success_rate",
        message: "Patch apply success rate dropped more than the allowed threshold.",
        threshold: thresholds.patch_apply_drop_max,
        actual: patchDelta.current,
        baseline: patchDelta.baseline,
        delta: patchDelta.delta,
      });
    }
  }

  const verificationRate = asRate(metrics.m004_verification_pass_rate.value);
  if (verificationRate === null) {
    failures.push({
      code: "gate_verification_rate_missing",
      metric: "m004_verification_pass_rate",
      message: "Verification pass rate is unavailable.",
      threshold: thresholds.verification_pass_rate_min,
      actual: null,
    });
  } else if (verificationRate < thresholds.verification_pass_rate_min) {
    failures.push({
      code: "gate_verification_rate_below_min",
      metric: "m004_verification_pass_rate",
      message: "Verification pass rate is below threshold.",
      threshold: thresholds.verification_pass_rate_min,
      actual: verificationRate,
    });
  }

  const hallucinationRate = asRate(metrics.m005_hallucination_rate.value);
  if (hallucinationRate === null) {
    failures.push({
      code: "gate_hallucination_rate_missing",
      metric: "m005_hallucination_rate",
      message: "Hallucination rate is unavailable.",
      threshold: thresholds.hallucination_rate_max,
      actual: null,
    });
  } else if (hallucinationRate > thresholds.hallucination_rate_max) {
    failures.push({
      code: "gate_hallucination_rate_exceeded",
      metric: "m005_hallucination_rate",
      message: "Hallucination rate is above threshold.",
      threshold: thresholds.hallucination_rate_max,
      actual: hallucinationRate,
    });
  }

  const scopeRate = asRate(metrics.m006_scope_violation_rate.value);
  if (scopeRate === null) {
    failures.push({
      code: "gate_scope_violation_rate_missing",
      metric: "m006_scope_violation_rate",
      message: "Scope-violation rate is unavailable.",
      threshold: thresholds.scope_violation_rate_max,
      actual: null,
    });
  } else if (scopeRate > thresholds.scope_violation_rate_max) {
    failures.push({
      code: "gate_scope_violation_rate_exceeded",
      metric: "m006_scope_violation_rate",
      message: "Scope-violation rate is above threshold.",
      threshold: thresholds.scope_violation_rate_max,
      actual: scopeRate,
    });
  }

  return {
    schema_version: 1,
    passed: failures.length === 0,
    thresholds,
    failures,
  };
};
