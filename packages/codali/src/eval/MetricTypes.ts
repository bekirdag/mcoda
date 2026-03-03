export interface RateMetric {
  numerator: number;
  denominator: number;
  missing: number;
  value: number | null;
}

export interface PercentileMetric {
  sample_size: number;
  missing: number;
  median: number | null;
  p95: number | null;
}

export interface EvalMetrics {
  schema_version: 1;
  generated_at: string;
  task_count: number;
  m001_task_success_rate: RateMetric;
  m002_first_pass_success_rate: RateMetric;
  m003_patch_apply_success_rate: RateMetric;
  m004_verification_pass_rate: RateMetric;
  m005_hallucination_rate: RateMetric;
  m006_scope_violation_rate: RateMetric;
  m007_latency_ms: PercentileMetric;
  m008_success_tokens: PercentileMetric;
  m008_success_cost_usd: PercentileMetric;
}

export type EvalMetricKey =
  | "m001_task_success_rate"
  | "m002_first_pass_success_rate"
  | "m003_patch_apply_success_rate"
  | "m004_verification_pass_rate"
  | "m005_hallucination_rate"
  | "m006_scope_violation_rate"
  | "m007_latency_ms.median"
  | "m007_latency_ms.p95"
  | "m008_success_tokens.median"
  | "m008_success_tokens.p95"
  | "m008_success_cost_usd.median"
  | "m008_success_cost_usd.p95";
