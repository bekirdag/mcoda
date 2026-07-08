import { randomUUID } from "node:crypto";
import type { PercentileMetric, RateMetric } from "./MetricTypes.js";
import type { CodaliGatewayModelTier } from "../gateway/CodaliGatewayTypes.js";
import {
  CODALI_GATEWAY_DATASET_EVAL_PROMPT_VERSIONS,
  CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION,
  CODALI_GATEWAY_DATASET_EVAL_STAGES,
  createDefaultCodaliGatewayDatasetEvalImport,
  type CodaliGatewayDatasetEvalImportLineage,
  type CodaliGatewayDatasetEvalStage,
} from "./GatewayDatasetEval.js";

export type CodaliGatewayEvalTaskType =
  | "generic_question"
  | "code_repo_question"
  | "encrypted_docdex_search_question"
  | "product_tool_question"
  | "disabled_integration_question"
  | "image_generation_question"
  | "missing_evidence_question";

export type CodaliGatewayEvalRunStatus = "passed" | "failed";

export interface CodaliGatewayEvalDatasetSchemaVersions {
  gatewayEval: 1;
  datasetEval: typeof CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION;
  storageContract: string;
  datasetReplayFixture: string;
  datasetRecord: string;
}

export interface CodaliGatewayEvalDatasetMetadata {
  source: "dataset_replay_fixture";
  stage: CodaliGatewayDatasetEvalStage;
  sourceRecordId: string;
  sourceGatewayRecordId?: string;
  datasetKind: string;
  promptVersion: string;
  schemaVersions: CodaliGatewayEvalDatasetSchemaVersions;
  sourceObjectHashes: string[];
  replayFixtureId?: string;
  exportKind?: string;
  generatedAt?: string;
}

export interface CodaliGatewayEvalCaseExpectations {
  allowedTools?: string[];
  deniedTools?: string[];
  requiredTools?: string[];
  requiredSourceTypes?: string[];
  requiresEvidence?: boolean;
  expectsMissingEvidence?: boolean;
  requiresImageArtifact?: boolean;
  requiresFinalLargeModel?: boolean;
  minEvidencePrecision?: number;
  maxLatencyMs?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
  maxCostUsd?: number;
}

export interface CodaliGatewayEvalCase {
  id: string;
  type: CodaliGatewayEvalTaskType;
  prompt: string;
  expectations: CodaliGatewayEvalCaseExpectations;
  dataset?: CodaliGatewayEvalDatasetMetadata;
}

export interface CodaliGatewayEvalEvidenceRecord {
  id: string;
  sourceType: string;
  sourceId?: string;
  cited?: boolean;
  relevant?: boolean;
}

export interface CodaliGatewayEvalCitationRecord {
  evidenceId?: string;
  sourceType?: string;
  sourceId?: string;
}

export interface CodaliGatewayEvalImageArtifactRecord {
  id?: string;
  uri?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayEvalRunRecord {
  caseId: string;
  taskType: CodaliGatewayEvalTaskType;
  status: CodaliGatewayEvalRunStatus;
  plannerSchemaValid: boolean;
  selectedTaskType?: CodaliGatewayEvalTaskType;
  calledTools: string[];
  evidence: CodaliGatewayEvalEvidenceRecord[];
  citations: CodaliGatewayEvalCitationRecord[];
  finalAnswer: string;
  finalAnswerDirect?: boolean;
  finalModelTier?: CodaliGatewayModelTier;
  latencyMs?: number;
  tokensUsed?: number;
  costUsd?: number;
  toolCallCount?: number;
  modelCallCount?: number;
  imageArtifact?: CodaliGatewayEvalImageArtifactRecord;
  missingEvidenceHandled?: boolean;
  warnings?: string[];
  errors?: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayEvalCaseResult {
  caseId: string;
  taskType: CodaliGatewayEvalTaskType;
  status: CodaliGatewayEvalRunStatus;
  passed: boolean;
  plannerSchemaValid: boolean;
  evidencePrecision: number | null;
  evidencePrecisionPassed: boolean;
  citationSourceCorrect: boolean;
  disabledToolLeakageDetected: boolean;
  finalAnswerDirect: boolean;
  finalLargeModelUsed: boolean;
  budgetCompliant: boolean;
  imageArtifactPresent: boolean;
  missingEvidenceHandled: boolean;
  calledTools: string[];
  failures: string[];
  warnings: string[];
  errors: string[];
  latencyMs?: number;
  tokensUsed?: number;
  costUsd?: number;
  toolCallCount?: number;
  modelCallCount?: number;
  dataset?: CodaliGatewayEvalDatasetMetadata;
}

export interface CodaliGatewayEvalMetrics {
  schemaVersion: 1;
  generatedAt: string;
  taskCount: number;
  plannerSchemaValidityRate: RateMetric;
  evidencePrecisionRate: RateMetric;
  citationSourceCorrectnessRate: RateMetric;
  disabledToolLeakageRate: RateMetric;
  finalAnswerDirectnessRate: RateMetric;
  finalLargeModelRate: RateMetric;
  budgetComplianceRate: RateMetric;
  latencyMs: PercentileMetric;
  tokensUsed: PercentileMetric;
  costUsd: PercentileMetric;
  toolCallCount: PercentileMetric;
  modelCallCount: PercentileMetric;
  datasetCaseCount: number;
  datasetStageCoverageRate: RateMetric;
  datasetLineageCoverageRate: RateMetric;
  promptSchemaVersionCoverageRate: RateMetric;
}

export interface CodaliGatewayEvalThresholds {
  plannerSchemaValidityMin: number;
  evidencePrecisionMin: number;
  citationSourceCorrectnessMin: number;
  disabledToolLeakageMax: number;
  finalAnswerDirectnessMin: number;
  finalLargeModelRateMin: number;
  budgetComplianceMin: number;
  latencyP95MsMax?: number;
  costP95UsdMax?: number;
  latencyRegressionRatioMax: number;
  costRegressionRatioMax: number;
  datasetStageCoverageMin: number;
  datasetLineageCoverageMin: number;
  promptSchemaVersionCoverageMin: number;
}

export interface CodaliGatewayEvalMetricDelta {
  key: "latency_ms.p95" | "cost_usd.p95" | "tokens_used.p95";
  unit: "ms" | "usd" | "tokens";
  baseline: number | null;
  current: number | null;
  delta: number | null;
  relativeDelta: number | null;
  regression: boolean;
}

export interface CodaliGatewayEvalRegressionComparison {
  schemaVersion: 1;
  status: "baseline_missing" | "compared";
  baselineReportId?: string;
  baselineGeneratedAt?: string;
  deltas: CodaliGatewayEvalMetricDelta[];
  regressionCount: number;
}

export interface CodaliGatewayEvalGateFailure {
  code: string;
  metric: string;
  message: string;
  threshold: number;
  actual: number | null;
  baseline?: number | null;
  delta?: number | null;
}

export interface CodaliGatewayEvalGateResult {
  schemaVersion: 1;
  passed: boolean;
  thresholds: CodaliGatewayEvalThresholds;
  failures: CodaliGatewayEvalGateFailure[];
}

export interface CodaliGatewayEvalReportLineage {
  schemaVersion: 1;
  source: "static_cases" | "dataset_replay_fixture" | "mixed";
  staticCaseIds: string[];
  dataset?: CodaliGatewayDatasetEvalImportLineage;
  datasetSourceRecordIds: string[];
  datasetSourceGatewayRecordIds: string[];
  datasetSourceObjectHashes: string[];
  datasetStageCounts: Record<CodaliGatewayDatasetEvalStage, number>;
}

export interface CodaliGatewayEvalReportVersions {
  schemaVersion: 1;
  gatewayEval: 1;
  datasetEval: typeof CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION;
  promptVersions: Record<string, string>;
  schemaVersions: Record<string, string | number>;
}

export interface CodaliGatewayEvalReport {
  schemaVersion: 1;
  reportId: string;
  runId: string;
  runtime: "codali_gateway_eval";
  mode: "gateway_smoke";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  cases: CodaliGatewayEvalCaseResult[];
  metrics: CodaliGatewayEvalMetrics;
  regression: CodaliGatewayEvalRegressionComparison;
  gates: CodaliGatewayEvalGateResult;
  lineage: CodaliGatewayEvalReportLineage;
  versions: CodaliGatewayEvalReportVersions;
  summary: {
    status: CodaliGatewayEvalRunStatus;
    total: number;
    passed: number;
    failed: number;
  };
  warnings: string[];
  errors: string[];
}

export type CodaliGatewayEvalRunner = (
  evalCase: CodaliGatewayEvalCase,
) => Promise<CodaliGatewayEvalRunRecord>;

export interface CodaliGatewayEvalSuiteOptions {
  runId?: string;
  reportId?: string;
  cases?: CodaliGatewayEvalCase[];
  runner?: CodaliGatewayEvalRunner;
  thresholds?: Partial<CodaliGatewayEvalThresholds>;
  baseline?: CodaliGatewayEvalReport | CodaliGatewayEvalMetrics;
  datasetCases?: CodaliGatewayEvalCase[];
  datasetLineage?: CodaliGatewayDatasetEvalImportLineage;
  includeDatasetCases?: boolean;
}

export const DEFAULT_CODALI_GATEWAY_EVAL_THRESHOLDS: CodaliGatewayEvalThresholds = {
  plannerSchemaValidityMin: 1,
  evidencePrecisionMin: 1,
  citationSourceCorrectnessMin: 1,
  disabledToolLeakageMax: 0,
  finalAnswerDirectnessMin: 1,
  finalLargeModelRateMin: 1,
  budgetComplianceMin: 1,
  latencyP95MsMax: 120_000,
  costP95UsdMax: 10,
  latencyRegressionRatioMax: 0.25,
  costRegressionRatioMax: 0.25,
  datasetStageCoverageMin: 1,
  datasetLineageCoverageMin: 1,
  promptSchemaVersionCoverageMin: 1,
};

export const CODALI_GATEWAY_EVAL_CASES: CodaliGatewayEvalCase[] = [
  {
    id: "gateway-generic-question",
    type: "generic_question",
    prompt: "Answer a simple product-neutral question without calling tools.",
    expectations: {
      allowedTools: [],
      deniedTools: [
        "github_search",
        "jira_search",
        "microsoft_graph",
        "smartclick_search",
      ],
      requiresFinalLargeModel: true,
      maxLatencyMs: 2_000,
      maxTokens: 800,
      maxToolCalls: 0,
      maxModelCalls: 3,
      maxCostUsd: 0.05,
    },
  },
  {
    id: "gateway-code-repo-question",
    type: "code_repo_question",
    prompt: "Answer a repository question using Docdex evidence from the tenant repo.",
    expectations: {
      allowedTools: ["docdex_search", "docdex_open"],
      requiredTools: ["docdex_search"],
      requiredSourceTypes: ["docdex"],
      deniedTools: ["shell", "write_file", "git_push"],
      requiresEvidence: true,
      requiresFinalLargeModel: true,
      maxLatencyMs: 5_000,
      maxTokens: 2_000,
      maxToolCalls: 3,
      maxModelCalls: 4,
      maxCostUsd: 0.15,
    },
  },
  {
    id: "gateway-encrypted-docdex-search-question",
    type: "encrypted_docdex_search_question",
    prompt: "Answer a tenant-scoped encrypted Docdex search question.",
    expectations: {
      allowedTools: ["docdex_search", "docdex_open"],
      requiredTools: ["docdex_search"],
      requiredSourceTypes: ["encrypted_docdex"],
      deniedTools: ["shell", "write_file", "local_docdex_fallback"],
      requiresEvidence: true,
      requiresFinalLargeModel: true,
      maxLatencyMs: 8_000,
      maxTokens: 2_200,
      maxToolCalls: 4,
      maxModelCalls: 4,
      maxCostUsd: 0.2,
    },
  },
  {
    id: "gateway-product-tool-question",
    type: "product_tool_question",
    prompt: "Answer using a runtime-provided read-only app tool contract.",
    expectations: {
      allowedTools: ["app_tool_gateway"],
      requiredTools: ["app_tool_gateway"],
      requiredSourceTypes: ["app_tool_gateway"],
      deniedTools: ["shell", "write_file", "github_issue_create"],
      requiresEvidence: true,
      requiresFinalLargeModel: true,
      maxLatencyMs: 6_000,
      maxTokens: 2_000,
      maxToolCalls: 2,
      maxModelCalls: 4,
      maxCostUsd: 0.2,
    },
  },
  {
    id: "gateway-disabled-integration-question",
    type: "disabled_integration_question",
    prompt: "Handle a question that mentions disabled SmartClick/GitHub/Jira/Microsoft integrations.",
    expectations: {
      allowedTools: ["docdex_search"],
      deniedTools: [
        "smartclick_search",
        "github_search",
        "jira_search",
        "microsoft_graph",
      ],
      requiresFinalLargeModel: true,
      maxLatencyMs: 4_000,
      maxTokens: 1_000,
      maxToolCalls: 1,
      maxModelCalls: 3,
      maxCostUsd: 0.1,
    },
  },
  {
    id: "gateway-image-generation-question",
    type: "image_generation_question",
    prompt: "Route an image request to the image worker and preserve artifact metadata.",
    expectations: {
      allowedTools: ["image_generate"],
      requiredTools: ["image_generate"],
      deniedTools: ["shell", "write_file"],
      requiresImageArtifact: true,
      requiresFinalLargeModel: true,
      maxLatencyMs: 15_000,
      maxTokens: 2_500,
      maxToolCalls: 1,
      maxModelCalls: 5,
      maxCostUsd: 0.5,
    },
  },
  {
    id: "gateway-missing-evidence-question",
    type: "missing_evidence_question",
    prompt: "Handle a repo question with insufficient evidence without fabricating.",
    expectations: {
      allowedTools: ["docdex_search"],
      requiredTools: ["docdex_search"],
      deniedTools: ["shell", "write_file"],
      expectsMissingEvidence: true,
      requiresFinalLargeModel: true,
      maxLatencyMs: 4_000,
      maxTokens: 1_200,
      maxToolCalls: 2,
      maxModelCalls: 4,
      maxCostUsd: 0.15,
    },
  },
];

const rateMetric = (numerator: number, denominator: number, missing = 0): RateMetric => ({
  numerator,
  denominator,
  missing,
  value: denominator === 0 ? null : numerator / denominator,
});

const percentileMetric = (values: Array<number | undefined>): PercentileMetric => {
  const samples = values.filter((value): value is number => (
    value !== undefined && Number.isFinite(value)
  )).sort((left, right) => left - right);
  const missing = values.length - samples.length;
  if (samples.length === 0) {
    return { sample_size: 0, missing, median: null, p95: null };
  }
  const medianIndex = Math.floor((samples.length - 1) / 2);
  const p95Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
  return {
    sample_size: samples.length,
    missing,
    median: samples[medianIndex] ?? null,
    p95: samples[p95Index] ?? null,
  };
};

const includesAll = (actual: Iterable<string>, expected: string[] | undefined): boolean => {
  if (!expected || expected.length === 0) return true;
  const actualSet = new Set(actual);
  return expected.every((entry) => actualSet.has(entry));
};

const intersects = (actual: Iterable<string>, denied: string[] | undefined): boolean => {
  if (!denied || denied.length === 0) return false;
  const actualSet = new Set(actual);
  return denied.some((entry) => actualSet.has(entry));
};

const usedUnallowedTool = (
  calledTools: string[],
  allowedTools: string[] | undefined,
): boolean => {
  if (!allowedTools) return false;
  const allowed = new Set(allowedTools);
  return calledTools.some((tool) => !allowed.has(tool));
};

const calculateEvidencePrecision = (
  record: CodaliGatewayEvalRunRecord,
  evalCase: CodaliGatewayEvalCase,
): number | null => {
  if (!evalCase.expectations.requiresEvidence) return null;
  if (record.evidence.length === 0) return 0;
  const relevant = record.evidence.filter((item) => item.relevant !== false).length;
  return relevant / record.evidence.length;
};

const citationMatchesEvidence = (
  citation: CodaliGatewayEvalCitationRecord,
  evidenceById: Map<string, CodaliGatewayEvalEvidenceRecord>,
  evidenceSourceTypes: Set<string>,
): boolean => {
  if (citation.evidenceId && evidenceById.has(citation.evidenceId)) return true;
  if (citation.sourceType && evidenceSourceTypes.has(citation.sourceType)) return true;
  return false;
};

const hasCorrectCitations = (
  record: CodaliGatewayEvalRunRecord,
  evalCase: CodaliGatewayEvalCase,
): boolean => {
  const requiredSourceTypes = evalCase.expectations.requiredSourceTypes ?? [];
  if (!evalCase.expectations.requiresEvidence && requiredSourceTypes.length === 0) return true;
  if (record.citations.length === 0) return false;

  const evidenceById = new Map(record.evidence.map((item) => [item.id, item]));
  const evidenceSourceTypes = new Set(record.evidence.map((item) => item.sourceType));
  const citedSourceTypes = new Set<string>();

  for (const evidence of record.evidence) {
    if (evidence.cited) citedSourceTypes.add(evidence.sourceType);
  }
  for (const citation of record.citations) {
    if (!citationMatchesEvidence(citation, evidenceById, evidenceSourceTypes)) {
      return false;
    }
    if (citation.sourceType) citedSourceTypes.add(citation.sourceType);
    if (citation.evidenceId) {
      const evidence = evidenceById.get(citation.evidenceId);
      if (evidence) citedSourceTypes.add(evidence.sourceType);
    }
  }

  return includesAll(citedSourceTypes, requiredSourceTypes);
};

const isBudgetCompliant = (
  record: CodaliGatewayEvalRunRecord,
  evalCase: CodaliGatewayEvalCase,
): boolean => {
  const expectations = evalCase.expectations;
  const checks = [
    [record.latencyMs, expectations.maxLatencyMs],
    [record.tokensUsed, expectations.maxTokens],
    [record.toolCallCount ?? record.calledTools.length, expectations.maxToolCalls],
    [record.modelCallCount, expectations.maxModelCalls],
    [record.costUsd, expectations.maxCostUsd],
  ] as const;

  return checks.every(([actual, max]) => (
    max === undefined || (actual !== undefined && actual <= max)
  ));
};

export const evaluateCodaliGatewayEvalCase = (
  evalCase: CodaliGatewayEvalCase,
  record: CodaliGatewayEvalRunRecord,
  thresholds: CodaliGatewayEvalThresholds = DEFAULT_CODALI_GATEWAY_EVAL_THRESHOLDS,
): CodaliGatewayEvalCaseResult => {
  const failures: string[] = [];
  const warnings = [...(record.warnings ?? [])];
  const errors = [...(record.errors ?? [])];
  const expectations = evalCase.expectations;
  const plannerSchemaValid = record.plannerSchemaValid
    && record.taskType === evalCase.type
    && (!record.selectedTaskType || record.selectedTaskType === evalCase.type);
  const evidencePrecision = calculateEvidencePrecision(record, evalCase);
  const minEvidencePrecision = expectations.minEvidencePrecision ?? thresholds.evidencePrecisionMin;
  const evidencePrecisionPassed = !expectations.requiresEvidence
    || (evidencePrecision !== null && evidencePrecision >= minEvidencePrecision);
  const citationSourceCorrect = hasCorrectCitations(record, evalCase);
  const disabledToolLeakageDetected = intersects(record.calledTools, expectations.deniedTools);
  const unallowedToolCalled = usedUnallowedTool(record.calledTools, expectations.allowedTools);
  const finalAnswerDirect = record.finalAnswerDirect === true && record.finalAnswer.trim().length > 0;
  const finalLargeModelUsed = !expectations.requiresFinalLargeModel
    || record.finalModelTier === "large";
  const budgetCompliant = isBudgetCompliant(record, evalCase);
  const imageArtifactPresent = !expectations.requiresImageArtifact
    || !!record.imageArtifact?.uri
    || !!record.imageArtifact?.id;
  const missingEvidenceHandled = !expectations.expectsMissingEvidence
    || record.missingEvidenceHandled === true;

  if (record.status !== "passed") failures.push("gateway_eval_runner_status_failed");
  if (!plannerSchemaValid) failures.push("gateway_planner_schema_or_task_type_invalid");
  if (!includesAll(record.calledTools, expectations.requiredTools)) {
    failures.push("gateway_required_tool_not_called");
  }
  if (unallowedToolCalled) failures.push("gateway_unallowed_tool_called");
  if (!evidencePrecisionPassed) failures.push("gateway_evidence_precision_below_threshold");
  if (!citationSourceCorrect) failures.push("gateway_citation_source_incorrect");
  if (disabledToolLeakageDetected) failures.push("gateway_disabled_tool_leakage_detected");
  if (!finalAnswerDirect) failures.push("gateway_final_answer_not_direct");
  if (!finalLargeModelUsed) failures.push("gateway_final_large_model_missing");
  if (!budgetCompliant) failures.push("gateway_budget_exceeded");
  if (!imageArtifactPresent) failures.push("gateway_image_artifact_missing");
  if (!missingEvidenceHandled) failures.push("gateway_missing_evidence_not_handled");

  return {
    caseId: evalCase.id,
    taskType: evalCase.type,
    status: failures.length === 0 ? "passed" : "failed",
    passed: failures.length === 0,
    plannerSchemaValid,
    evidencePrecision,
    evidencePrecisionPassed,
    citationSourceCorrect,
    disabledToolLeakageDetected,
    finalAnswerDirect,
    finalLargeModelUsed,
    budgetCompliant,
    imageArtifactPresent,
    missingEvidenceHandled,
    calledTools: [...record.calledTools],
    failures,
    warnings,
    errors,
    latencyMs: record.latencyMs,
    tokensUsed: record.tokensUsed,
    costUsd: record.costUsd,
    toolCallCount: record.toolCallCount ?? record.calledTools.length,
    modelCallCount: record.modelCallCount,
    dataset: evalCase.dataset,
  };
};

const zeroDatasetStageCounts = (): Record<CodaliGatewayDatasetEvalStage, number> =>
  CODALI_GATEWAY_DATASET_EVAL_STAGES.reduce<Record<CodaliGatewayDatasetEvalStage, number>>(
    (output, stage) => {
      output[stage] = 0;
      return output;
    },
    {} as Record<CodaliGatewayDatasetEvalStage, number>,
  );

const hasDatasetLineage = (result: CodaliGatewayEvalCaseResult): boolean =>
  Boolean(
    result.dataset?.sourceRecordId
    && result.dataset.sourceObjectHashes.length > 0
    && result.dataset.stage,
  );

const hasPromptAndSchemaVersions = (result: CodaliGatewayEvalCaseResult): boolean =>
  Boolean(
    result.dataset?.promptVersion
    && result.dataset.schemaVersions.gatewayEval
    && result.dataset.schemaVersions.datasetEval
    && result.dataset.schemaVersions.storageContract
    && result.dataset.schemaVersions.datasetReplayFixture
    && result.dataset.schemaVersions.datasetRecord,
  );

export const aggregateCodaliGatewayEvalMetrics = (
  cases: CodaliGatewayEvalCaseResult[],
): CodaliGatewayEvalMetrics => {
  const taskCount = cases.length;
  const datasetCases = cases.filter((result) => result.dataset);
  const coveredDatasetStages = new Set(datasetCases.map((result) => result.dataset?.stage));
  const evidenceCases = cases.filter((result) => result.evidencePrecision !== null);
  const citationCases = cases.filter((result) => result.evidencePrecision !== null);
  const finalLargeCases = cases.filter((result) => (
    result.finalLargeModelUsed || result.failures.includes("gateway_final_large_model_missing")
  ));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    taskCount,
    plannerSchemaValidityRate: rateMetric(
      cases.filter((result) => result.plannerSchemaValid).length,
      taskCount,
    ),
    evidencePrecisionRate: rateMetric(
      evidenceCases.filter((result) => result.evidencePrecisionPassed).length,
      evidenceCases.length,
      taskCount - evidenceCases.length,
    ),
    citationSourceCorrectnessRate: rateMetric(
      citationCases.filter((result) => result.citationSourceCorrect).length,
      citationCases.length,
      taskCount - citationCases.length,
    ),
    disabledToolLeakageRate: rateMetric(
      cases.filter((result) => result.disabledToolLeakageDetected).length,
      taskCount,
    ),
    finalAnswerDirectnessRate: rateMetric(
      cases.filter((result) => result.finalAnswerDirect).length,
      taskCount,
    ),
    finalLargeModelRate: rateMetric(
      finalLargeCases.filter((result) => result.finalLargeModelUsed).length,
      finalLargeCases.length,
      taskCount - finalLargeCases.length,
    ),
    budgetComplianceRate: rateMetric(
      cases.filter((result) => result.budgetCompliant).length,
      taskCount,
    ),
    latencyMs: percentileMetric(cases.map((result) => result.latencyMs)),
    tokensUsed: percentileMetric(cases.map((result) => result.tokensUsed)),
    costUsd: percentileMetric(cases.map((result) => result.costUsd)),
    toolCallCount: percentileMetric(cases.map((result) => result.toolCallCount)),
    modelCallCount: percentileMetric(cases.map((result) => result.modelCallCount)),
    datasetCaseCount: datasetCases.length,
    datasetStageCoverageRate: rateMetric(
      CODALI_GATEWAY_DATASET_EVAL_STAGES.filter((stage) => coveredDatasetStages.has(stage)).length,
      CODALI_GATEWAY_DATASET_EVAL_STAGES.length,
      0,
    ),
    datasetLineageCoverageRate: rateMetric(
      datasetCases.filter(hasDatasetLineage).length,
      datasetCases.length,
      taskCount - datasetCases.length,
    ),
    promptSchemaVersionCoverageRate: rateMetric(
      datasetCases.filter(hasPromptAndSchemaVersions).length,
      datasetCases.length,
      taskCount - datasetCases.length,
    ),
  };
};

const comparisonInput = (
  baseline?: CodaliGatewayEvalReport | CodaliGatewayEvalMetrics,
): {
  metrics?: CodaliGatewayEvalMetrics;
  reportId?: string;
  generatedAt?: string;
} => {
  if (!baseline) return {};
  if ("metrics" in baseline) {
    return {
      metrics: baseline.metrics,
      reportId: baseline.reportId,
      generatedAt: baseline.metrics.generatedAt,
    };
  }
  return { metrics: baseline, generatedAt: baseline.generatedAt };
};

const metricDelta = (
  key: CodaliGatewayEvalMetricDelta["key"],
  unit: CodaliGatewayEvalMetricDelta["unit"],
  current: number | null,
  baseline: number | null,
): CodaliGatewayEvalMetricDelta => {
  if (current === null || baseline === null) {
    return {
      key,
      unit,
      baseline,
      current,
      delta: null,
      relativeDelta: null,
      regression: false,
    };
  }
  const delta = current - baseline;
  const relativeDelta = baseline === 0 ? null : delta / baseline;
  return {
    key,
    unit,
    baseline,
    current,
    delta,
    relativeDelta,
    regression: delta > 0,
  };
};

export const compareCodaliGatewayEvalBaseline = (params: {
  current: CodaliGatewayEvalMetrics;
  baseline?: CodaliGatewayEvalReport | CodaliGatewayEvalMetrics;
}): CodaliGatewayEvalRegressionComparison => {
  const baseline = comparisonInput(params.baseline);
  const deltas = [
    metricDelta(
      "latency_ms.p95",
      "ms",
      params.current.latencyMs.p95,
      baseline.metrics?.latencyMs.p95 ?? null,
    ),
    metricDelta(
      "cost_usd.p95",
      "usd",
      params.current.costUsd.p95,
      baseline.metrics?.costUsd.p95 ?? null,
    ),
    metricDelta(
      "tokens_used.p95",
      "tokens",
      params.current.tokensUsed.p95,
      baseline.metrics?.tokensUsed.p95 ?? null,
    ),
  ];
  return {
    schemaVersion: 1,
    status: baseline.metrics ? "compared" : "baseline_missing",
    baselineReportId: baseline.reportId,
    baselineGeneratedAt: baseline.generatedAt,
    deltas,
    regressionCount: deltas.filter((delta) => delta.regression).length,
  };
};

const valueBelowMinimum = (value: number | null, minimum: number): boolean => (
  value === null || value < minimum
);

const valueAboveMaximum = (value: number | null, maximum: number): boolean => (
  value === null || value > maximum
);

const addRateMinimumFailure = (
  failures: CodaliGatewayEvalGateFailure[],
  params: {
    code: string;
    metric: string;
    message: string;
    threshold: number;
    actual: number | null;
  },
): void => {
  if (valueBelowMinimum(params.actual, params.threshold)) {
    failures.push(params);
  }
};

const addRateMaximumFailure = (
  failures: CodaliGatewayEvalGateFailure[],
  params: {
    code: string;
    metric: string;
    message: string;
    threshold: number;
    actual: number | null;
  },
): void => {
  if (valueAboveMaximum(params.actual, params.threshold)) {
    failures.push(params);
  }
};

const findRegressionDelta = (
  regression: CodaliGatewayEvalRegressionComparison | undefined,
  key: CodaliGatewayEvalMetricDelta["key"],
): CodaliGatewayEvalMetricDelta | undefined => {
  if (!regression || regression.status !== "compared") return undefined;
  return regression.deltas.find((delta) => delta.key === key);
};

export const evaluateCodaliGatewayEvalGates = (params: {
  metrics: CodaliGatewayEvalMetrics;
  thresholds?: Partial<CodaliGatewayEvalThresholds>;
  regression?: CodaliGatewayEvalRegressionComparison;
}): CodaliGatewayEvalGateResult => {
  const thresholds = {
    ...DEFAULT_CODALI_GATEWAY_EVAL_THRESHOLDS,
    ...(params.thresholds ?? {}),
  };
  const failures: CodaliGatewayEvalGateFailure[] = [];
  const { metrics } = params;

  addRateMinimumFailure(failures, {
    code: "gateway_planner_schema_validity_below_min",
    metric: "plannerSchemaValidityRate",
    message: "Planner schema validity is below threshold.",
    threshold: thresholds.plannerSchemaValidityMin,
    actual: metrics.plannerSchemaValidityRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_evidence_precision_below_min",
    metric: "evidencePrecisionRate",
    message: "Evidence precision is below threshold.",
    threshold: thresholds.evidencePrecisionMin,
    actual: metrics.evidencePrecisionRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_citation_source_correctness_below_min",
    metric: "citationSourceCorrectnessRate",
    message: "Citation/source correctness is below threshold.",
    threshold: thresholds.citationSourceCorrectnessMin,
    actual: metrics.citationSourceCorrectnessRate.value,
  });
  addRateMaximumFailure(failures, {
    code: "gateway_disabled_tool_leakage_exceeded",
    metric: "disabledToolLeakageRate",
    message: "Disabled-tool leakage exceeded threshold.",
    threshold: thresholds.disabledToolLeakageMax,
    actual: metrics.disabledToolLeakageRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_final_answer_directness_below_min",
    metric: "finalAnswerDirectnessRate",
    message: "Final-answer directness is below threshold.",
    threshold: thresholds.finalAnswerDirectnessMin,
    actual: metrics.finalAnswerDirectnessRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_final_large_model_rate_below_min",
    metric: "finalLargeModelRate",
    message: "Final answers were not produced by the required large tier.",
    threshold: thresholds.finalLargeModelRateMin,
    actual: metrics.finalLargeModelRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_budget_compliance_below_min",
    metric: "budgetComplianceRate",
    message: "Gateway budget compliance is below threshold.",
    threshold: thresholds.budgetComplianceMin,
    actual: metrics.budgetComplianceRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_dataset_stage_coverage_below_min",
    metric: "datasetStageCoverageRate",
    message: "Dataset-backed eval stage coverage is below threshold.",
    threshold: thresholds.datasetStageCoverageMin,
    actual: metrics.datasetStageCoverageRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_dataset_lineage_coverage_below_min",
    metric: "datasetLineageCoverageRate",
    message: "Dataset-backed eval lineage coverage is below threshold.",
    threshold: thresholds.datasetLineageCoverageMin,
    actual: metrics.datasetLineageCoverageRate.value,
  });
  addRateMinimumFailure(failures, {
    code: "gateway_prompt_schema_version_coverage_below_min",
    metric: "promptSchemaVersionCoverageRate",
    message: "Prompt and schema version coverage is below threshold.",
    threshold: thresholds.promptSchemaVersionCoverageMin,
    actual: metrics.promptSchemaVersionCoverageRate.value,
  });
  if (thresholds.latencyP95MsMax !== undefined) {
    addRateMaximumFailure(failures, {
      code: "gateway_latency_p95_exceeded",
      metric: "latencyMs.p95",
      message: "Gateway p95 latency exceeded threshold.",
      threshold: thresholds.latencyP95MsMax,
      actual: metrics.latencyMs.p95,
    });
  }
  if (thresholds.costP95UsdMax !== undefined) {
    addRateMaximumFailure(failures, {
      code: "gateway_cost_p95_exceeded",
      metric: "costUsd.p95",
      message: "Gateway p95 cost exceeded threshold.",
      threshold: thresholds.costP95UsdMax,
      actual: metrics.costUsd.p95,
    });
  }

  const latencyDelta = findRegressionDelta(params.regression, "latency_ms.p95");
  if (
    latencyDelta?.relativeDelta !== null
    && latencyDelta?.relativeDelta !== undefined
    && latencyDelta.relativeDelta > thresholds.latencyRegressionRatioMax
  ) {
    failures.push({
      code: "gateway_latency_regression_exceeded",
      metric: "latency_ms.p95",
      message: "Gateway p95 latency regressed beyond the allowed ratio.",
      threshold: thresholds.latencyRegressionRatioMax,
      actual: latencyDelta.current,
      baseline: latencyDelta.baseline,
      delta: latencyDelta.relativeDelta,
    });
  }

  const costDelta = findRegressionDelta(params.regression, "cost_usd.p95");
  if (
    costDelta?.relativeDelta !== null
    && costDelta?.relativeDelta !== undefined
    && costDelta.relativeDelta > thresholds.costRegressionRatioMax
  ) {
    failures.push({
      code: "gateway_cost_regression_exceeded",
      metric: "cost_usd.p95",
      message: "Gateway p95 cost regressed beyond the allowed ratio.",
      threshold: thresholds.costRegressionRatioMax,
      actual: costDelta.current,
      baseline: costDelta.baseline,
      delta: costDelta.relativeDelta,
    });
  }

  return {
    schemaVersion: 1,
    passed: failures.length === 0,
    thresholds,
    failures,
  };
};

const defaultEvidenceForCase = (
  evalCase: CodaliGatewayEvalCase,
): CodaliGatewayEvalEvidenceRecord[] => {
  const [sourceType] = evalCase.expectations.requiredSourceTypes ?? [];
  if (!sourceType) return [];
  return [{
    id: `${evalCase.id}-evidence-1`,
    sourceType,
    sourceId: `${sourceType}:tenant-scope-1`,
    cited: true,
    relevant: true,
  }];
};

export const createDefaultCodaliGatewayEvalRunner = (): CodaliGatewayEvalRunner => (
  async (evalCase) => {
    const evidence = defaultEvidenceForCase(evalCase);
    const calledTools = evalCase.expectations.requiredTools
      ? [...evalCase.expectations.requiredTools]
      : [];
    const citations = evidence.map((item) => ({
      evidenceId: item.id,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
    }));

    return {
      caseId: evalCase.id,
      taskType: evalCase.type,
      status: "passed",
      plannerSchemaValid: true,
      selectedTaskType: evalCase.type,
      calledTools,
      evidence,
      citations,
      finalAnswer: evalCase.expectations.expectsMissingEvidence
        ? "I do not have enough tenant-scoped evidence to answer that directly."
        : "Tenant-scoped evidence supports this direct answer.",
      finalAnswerDirect: true,
      finalModelTier: evalCase.expectations.requiresFinalLargeModel ? "large" : "medium",
      latencyMs: Math.min(evalCase.expectations.maxLatencyMs ?? 1_000, 1_000),
      tokensUsed: Math.min(evalCase.expectations.maxTokens ?? 500, 500),
      costUsd: Math.min(evalCase.expectations.maxCostUsd ?? 0.01, 0.01),
      toolCallCount: calledTools.length,
      modelCallCount: Math.min(evalCase.expectations.maxModelCalls ?? 2, 2),
      imageArtifact: evalCase.expectations.requiresImageArtifact
        ? { id: `${evalCase.id}-artifact`, uri: "artifact://codali-gateway-eval/image.png", mimeType: "image/png" }
        : undefined,
      missingEvidenceHandled: evalCase.expectations.expectsMissingEvidence ? true : undefined,
      warnings: [],
      errors: [],
    };
  }
);

const uniqueInOrder = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
};

const resolveCodaliGatewayEvalCases = async (
  options: CodaliGatewayEvalSuiteOptions,
): Promise<{
  evalCases: CodaliGatewayEvalCase[];
  datasetLineage?: CodaliGatewayDatasetEvalImportLineage;
}> => {
  if (options.cases) {
    return { evalCases: options.cases, datasetLineage: options.datasetLineage };
  }
  if (options.includeDatasetCases === false) {
    return { evalCases: CODALI_GATEWAY_EVAL_CASES, datasetLineage: options.datasetLineage };
  }
  if (options.datasetCases) {
    return {
      evalCases: [...CODALI_GATEWAY_EVAL_CASES, ...options.datasetCases],
      datasetLineage: options.datasetLineage,
    };
  }
  const datasetImport = await createDefaultCodaliGatewayDatasetEvalImport();
  return {
    evalCases: [...CODALI_GATEWAY_EVAL_CASES, ...datasetImport.cases],
    datasetLineage: datasetImport.lineage,
  };
};

const buildCodaliGatewayEvalLineage = (
  evalCases: CodaliGatewayEvalCase[],
  datasetLineage?: CodaliGatewayDatasetEvalImportLineage,
): CodaliGatewayEvalReportLineage => {
  const staticCaseIds = evalCases
    .filter((evalCase) => !evalCase.dataset)
    .map((evalCase) => evalCase.id);
  const datasetCases = evalCases.filter((evalCase) => evalCase.dataset);
  const stageCounts = zeroDatasetStageCounts();
  for (const evalCase of datasetCases) {
    const stage = evalCase.dataset?.stage;
    if (stage) stageCounts[stage] += 1;
  }
  const datasetSourceRecordIds = uniqueInOrder(
    datasetCases.map((evalCase) => evalCase.dataset?.sourceRecordId),
  );
  const datasetSourceGatewayRecordIds = uniqueInOrder(
    datasetCases.map((evalCase) => evalCase.dataset?.sourceGatewayRecordId),
  );
  const datasetSourceObjectHashes = uniqueInOrder(
    datasetCases.flatMap((evalCase) => evalCase.dataset?.sourceObjectHashes ?? []),
  );
  return {
    schemaVersion: 1,
    source: datasetCases.length > 0 && staticCaseIds.length > 0
      ? "mixed"
      : (datasetCases.length > 0 ? "dataset_replay_fixture" : "static_cases"),
    staticCaseIds,
    dataset: datasetLineage,
    datasetSourceRecordIds,
    datasetSourceGatewayRecordIds,
    datasetSourceObjectHashes,
    datasetStageCounts: datasetLineage?.stageCounts ?? stageCounts,
  };
};

const buildCodaliGatewayEvalVersions = (
  evalCases: CodaliGatewayEvalCase[],
): CodaliGatewayEvalReportVersions => {
  const promptVersions: Record<string, string> = {
    static_gateway_smoke: "codali.gateway.eval.static-smoke.prompt.v1",
    ...CODALI_GATEWAY_DATASET_EVAL_PROMPT_VERSIONS,
  };
  for (const evalCase of evalCases) {
    if (evalCase.dataset) {
      promptVersions[evalCase.dataset.stage] = evalCase.dataset.promptVersion;
    }
  }
  return {
    schemaVersion: 1,
    gatewayEval: 1,
    datasetEval: CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION,
    promptVersions,
    schemaVersions: {
      gatewayEval: 1,
      datasetEval: CODALI_GATEWAY_DATASET_EVAL_SCHEMA_VERSION,
      datasetReplayFixture: "codali.dataset.replay.fixture.v1",
      storageContract: "codali.storage.v1",
    },
  };
};

export const runCodaliGatewayEvalSuite = async (
  options: CodaliGatewayEvalSuiteOptions = {},
): Promise<CodaliGatewayEvalReport> => {
  const runId = options.runId ?? randomUUID();
  const reportId = options.reportId ?? randomUUID();
  const { evalCases, datasetLineage } = await resolveCodaliGatewayEvalCases(options);
  const lineage = buildCodaliGatewayEvalLineage(evalCases, datasetLineage);
  const versions = buildCodaliGatewayEvalVersions(evalCases);
  const runner = options.runner ?? createDefaultCodaliGatewayEvalRunner();
  const thresholds = {
    ...DEFAULT_CODALI_GATEWAY_EVAL_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const results: CodaliGatewayEvalCaseResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const evalCase of evalCases) {
    try {
      const record = await runner(evalCase);
      const result = evaluateCodaliGatewayEvalCase(evalCase, record, thresholds);
      results.push(result);
      warnings.push(...result.warnings.map((warning) => `${evalCase.id}:${warning}`));
      errors.push(...result.errors.map((error) => `${evalCase.id}:${error}`));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${evalCase.id}:${message}`);
      results.push({
        caseId: evalCase.id,
        taskType: evalCase.type,
        status: "failed",
        passed: false,
        plannerSchemaValid: false,
        evidencePrecision: null,
        evidencePrecisionPassed: false,
        citationSourceCorrect: false,
        disabledToolLeakageDetected: false,
        finalAnswerDirect: false,
        finalLargeModelUsed: false,
        budgetCompliant: false,
        imageArtifactPresent: !evalCase.expectations.requiresImageArtifact,
        missingEvidenceHandled: !evalCase.expectations.expectsMissingEvidence,
        calledTools: [],
        failures: ["gateway_eval_runner_threw"],
        warnings: [],
        errors: [message],
        dataset: evalCase.dataset,
      });
    }
  }

  const metrics = aggregateCodaliGatewayEvalMetrics(results);
  const regression = compareCodaliGatewayEvalBaseline({
    current: metrics,
    baseline: options.baseline,
  });
  const gates = evaluateCodaliGatewayEvalGates({
    metrics,
    thresholds,
    regression,
  });
  const endedAtMs = Date.now();
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  return {
    schemaVersion: 1,
    reportId,
    runId,
    runtime: "codali_gateway_eval",
    mode: "gateway_smoke",
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    cases: results,
    metrics,
    regression,
    gates,
    lineage,
    versions,
    summary: {
      status: failed === 0 && gates.passed ? "passed" : "failed",
      total: results.length,
      passed,
      failed,
    },
    warnings,
    errors,
  };
};

const formatRate = (metric: RateMetric): string => (
  metric.value === null ? "n/a" : `${(metric.value * 100).toFixed(2)}%`
);

const formatValue = (value: number | null, suffix = ""): string => (
  value === null ? "n/a" : `${value.toFixed(2)}${suffix}`
);

export const formatCodaliGatewayEvalTextReport = (
  report: CodaliGatewayEvalReport,
): string => {
  const gateSummary = report.gates.passed
    ? "passed"
    : `failed (${report.gates.failures.map((failure) => failure.code).join(", ")})`;
  const lines = [
    `Codali gateway eval smoke: ${report.summary.status}`,
    `Run: ${report.runId}`,
    `Cases: ${report.summary.passed}/${report.summary.total} passed`,
    `Planner schema validity: ${formatRate(report.metrics.plannerSchemaValidityRate)}`,
    `Evidence precision: ${formatRate(report.metrics.evidencePrecisionRate)}`,
    `Citation/source correctness: ${formatRate(report.metrics.citationSourceCorrectnessRate)}`,
    `Disabled-tool leakage: ${formatRate(report.metrics.disabledToolLeakageRate)}`,
    `Final-answer directness: ${formatRate(report.metrics.finalAnswerDirectnessRate)}`,
    `Final large-model usage: ${formatRate(report.metrics.finalLargeModelRate)}`,
    `Budget compliance: ${formatRate(report.metrics.budgetComplianceRate)}`,
    `Dataset stage coverage: ${formatRate(report.metrics.datasetStageCoverageRate)}`,
    `Dataset lineage coverage: ${formatRate(report.metrics.datasetLineageCoverageRate)}`,
    `Prompt/schema version coverage: ${formatRate(report.metrics.promptSchemaVersionCoverageRate)}`,
    `Latency median/p95: ${formatValue(report.metrics.latencyMs.median, "ms")}/${formatValue(report.metrics.latencyMs.p95, "ms")}`,
    `Tokens median/p95: ${formatValue(report.metrics.tokensUsed.median)}/${formatValue(report.metrics.tokensUsed.p95)}`,
    `Cost median/p95: ${formatValue(report.metrics.costUsd.median, " USD")}/${formatValue(report.metrics.costUsd.p95, " USD")}`,
    `Lineage: ${report.lineage.source}`,
    `Regression: ${report.regression.status}`,
    `Gates: ${gateSummary}`,
  ];
  for (const result of report.cases) {
    const suffix = result.failures.length > 0 ? ` (${result.failures.join(", ")})` : "";
    lines.push(`Case ${result.caseId}: ${result.status}${suffix}`);
  }
  return lines.join("\n");
};
