import { stableJsonStringify } from "./SuiteSchema.js";
import type { EvalGateResult } from "./GateEvaluator.js";
import type { EvalMetrics } from "./MetricTypes.js";
import type { EvalRegressionComparison } from "./RegressionComparator.js";
import type { EvalRunResult } from "./EvalRunner.js";

export interface EvalReport {
  schema_version: 1;
  report_id: string;
  created_at: string;
  suite: {
    suite_id: string;
    suite_name: string;
    suite_path: string;
    suite_fingerprint: string;
    task_count: number;
  };
  summary: {
    exit_code: number;
    passed: boolean;
    gate_passed: boolean;
    task_total: number;
    task_passed: number;
    task_failed: number;
    execution_errors: number;
  };
  run: EvalRunResult;
  metrics: EvalMetrics;
  regression: EvalRegressionComparison;
  gates: EvalGateResult;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

export const serializeEvalReport = (report: EvalReport, pretty = true): string => {
  const stable = stableJsonStringify(report);
  if (!pretty) return stable;
  const parsed = JSON.parse(stable);
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

export const parseEvalReport = (content: string): EvalReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Report JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = asRecord(parsed);
  if (!report) {
    throw new Error("Report payload must be an object.");
  }
  if (report.schema_version !== 1) {
    throw new Error("Unsupported report schema_version.");
  }
  if (typeof report.report_id !== "string" || !report.report_id.trim()) {
    throw new Error("Report report_id is required.");
  }
  return report as unknown as EvalReport;
};
