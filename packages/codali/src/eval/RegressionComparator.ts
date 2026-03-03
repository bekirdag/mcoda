import type { EvalMetricKey, EvalMetrics } from "./MetricTypes.js";

export interface EvalMetricDelta {
  key: EvalMetricKey;
  unit: "ratio" | "ms" | "tokens" | "usd";
  higher_is_better: boolean;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  direction: "up" | "down" | "flat" | "unknown";
  regression: boolean;
  improved: boolean;
}

export interface EvalRegressionComparison {
  schema_version: 1;
  status: "baseline_missing" | "compared";
  baseline_report_id?: string;
  baseline_created_at?: string;
  deltas: EvalMetricDelta[];
  regression_count: number;
  improved_count: number;
  unchanged_count: number;
}

const EPSILON = 1e-12;

interface FlattenedMetricEntry {
  key: EvalMetricKey;
  value: number | null;
  unit: EvalMetricDelta["unit"];
  higher_is_better: boolean;
}

const flattenMetrics = (metrics: EvalMetrics): FlattenedMetricEntry[] => [
  {
    key: "m001_task_success_rate",
    value: metrics.m001_task_success_rate.value,
    unit: "ratio",
    higher_is_better: true,
  },
  {
    key: "m002_first_pass_success_rate",
    value: metrics.m002_first_pass_success_rate.value,
    unit: "ratio",
    higher_is_better: true,
  },
  {
    key: "m003_patch_apply_success_rate",
    value: metrics.m003_patch_apply_success_rate.value,
    unit: "ratio",
    higher_is_better: true,
  },
  {
    key: "m004_verification_pass_rate",
    value: metrics.m004_verification_pass_rate.value,
    unit: "ratio",
    higher_is_better: true,
  },
  {
    key: "m005_hallucination_rate",
    value: metrics.m005_hallucination_rate.value,
    unit: "ratio",
    higher_is_better: false,
  },
  {
    key: "m006_scope_violation_rate",
    value: metrics.m006_scope_violation_rate.value,
    unit: "ratio",
    higher_is_better: false,
  },
  {
    key: "m007_latency_ms.median",
    value: metrics.m007_latency_ms.median,
    unit: "ms",
    higher_is_better: false,
  },
  {
    key: "m007_latency_ms.p95",
    value: metrics.m007_latency_ms.p95,
    unit: "ms",
    higher_is_better: false,
  },
  {
    key: "m008_success_tokens.median",
    value: metrics.m008_success_tokens.median,
    unit: "tokens",
    higher_is_better: false,
  },
  {
    key: "m008_success_tokens.p95",
    value: metrics.m008_success_tokens.p95,
    unit: "tokens",
    higher_is_better: false,
  },
  {
    key: "m008_success_cost_usd.median",
    value: metrics.m008_success_cost_usd.median,
    unit: "usd",
    higher_is_better: false,
  },
  {
    key: "m008_success_cost_usd.p95",
    value: metrics.m008_success_cost_usd.p95,
    unit: "usd",
    higher_is_better: false,
  },
];

const compareMetric = (
  current: FlattenedMetricEntry,
  baseline: FlattenedMetricEntry,
): EvalMetricDelta => {
  if (current.value === null || baseline.value === null) {
    return {
      key: current.key,
      unit: current.unit,
      higher_is_better: current.higher_is_better,
      baseline: baseline.value,
      current: current.value,
      delta: null,
      direction: "unknown",
      regression: false,
      improved: false,
    };
  }

  const delta = current.value - baseline.value;
  const direction =
    Math.abs(delta) <= EPSILON ? "flat" : (delta > 0 ? "up" : "down");
  const regression = current.higher_is_better ? delta < -EPSILON : delta > EPSILON;
  const improved = current.higher_is_better ? delta > EPSILON : delta < -EPSILON;
  return {
    key: current.key,
    unit: current.unit,
    higher_is_better: current.higher_is_better,
    baseline: baseline.value,
    current: current.value,
    delta: Math.abs(delta) <= EPSILON ? 0 : delta,
    direction,
    regression,
    improved,
  };
};

export const compareAgainstBaseline = (params: {
  current: EvalMetrics;
  baseline?: EvalMetrics;
  baseline_report_id?: string;
  baseline_created_at?: string;
}): EvalRegressionComparison => {
  const currentEntries = flattenMetrics(params.current);
  if (!params.baseline) {
    return {
      schema_version: 1,
      status: "baseline_missing",
      baseline_report_id: params.baseline_report_id,
      baseline_created_at: params.baseline_created_at,
      deltas: currentEntries.map((entry) => ({
        key: entry.key,
        unit: entry.unit,
        higher_is_better: entry.higher_is_better,
        baseline: null,
        current: entry.value,
        delta: null,
        direction: "unknown",
        regression: false,
        improved: false,
      })),
      regression_count: 0,
      improved_count: 0,
      unchanged_count: currentEntries.length,
    };
  }

  const baselineEntries = flattenMetrics(params.baseline);
  const baselineByKey = new Map<EvalMetricKey, FlattenedMetricEntry>();
  for (const entry of baselineEntries) {
    baselineByKey.set(entry.key, entry);
  }
  const deltas: EvalMetricDelta[] = [];
  for (const entry of currentEntries) {
    const baselineEntry = baselineByKey.get(entry.key);
    if (!baselineEntry) continue;
    deltas.push(compareMetric(entry, baselineEntry));
  }
  const regressionCount = deltas.filter((entry) => entry.regression).length;
  const improvedCount = deltas.filter((entry) => entry.improved).length;
  const unchangedCount = deltas.length - regressionCount - improvedCount;
  return {
    schema_version: 1,
    status: "compared",
    baseline_report_id: params.baseline_report_id,
    baseline_created_at: params.baseline_created_at,
    deltas,
    regression_count: regressionCount,
    improved_count: improvedCount,
    unchanged_count: unchangedCount,
  };
};
