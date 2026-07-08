import { createHash } from "node:crypto";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  type CodaliImprovementOutcome,
  type CodaliImprovementScope,
} from "./ImprovementPolicy.js";
import {
  type StorageServiceImprovementClient,
  type StorageServiceImprovementWriteResult,
} from "./StorageServiceImprovementClient.js";
import type { GatewayDatasetStorageScope } from "../storage/GatewayDatasetStore.js";

export const CODALI_RELEASE_OUTCOME_REPORTER_SCHEMA_VERSION =
  "codali.improvement.release_outcome_report.v1" as const;

export const CODALI_RELEASE_RUNTIME_PACKAGE_KINDS = [
  "prompt_package",
  "router_policy",
  "retrieval_policy",
  "schema",
  "fine_tune_adapter",
] as const;

export type CodaliReleaseRuntimePackageKind =
  (typeof CODALI_RELEASE_RUNTIME_PACKAGE_KINDS)[number];

export const CODALI_RELEASE_ROLLBACK_TRIGGER_CODES = [
  "schema_failures",
  "accepted_answer_rate_drop",
  "verifier_contradictions",
  "tool_failures",
  "latency_increase",
  "cost_increase",
  "privacy_security_warnings",
] as const;

export type CodaliReleaseRollbackTriggerCode =
  (typeof CODALI_RELEASE_ROLLBACK_TRIGGER_CODES)[number];

export type CodaliReleaseMonitorStatus =
  | "healthy"
  | "watch"
  | "rollback_required"
  | "rolled_back";

export interface CodaliReleaseMonitorWindow {
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
}

export interface CodaliReleaseMonitorThresholds {
  maxSchemaFailures: number;
  minAcceptedAnswerRate: number;
  maxAcceptedAnswerRateDrop: number;
  maxVerifierContradictions: number;
  maxToolFailures: number;
  maxP95LatencyIncreaseRatio: number;
  maxCostIncreaseRatio: number;
  maxPrivacySecurityWarnings: number;
}

export interface CodaliReleaseObservedMetrics {
  eligibleRequestCount: number;
  shadowRequestCount: number;
  schemaFailures: number;
  acceptedAnswerRate?: number;
  baselineAcceptedAnswerRate?: number;
  verifierContradictions: number;
  toolFailures: number;
  p95LatencyMs?: number;
  baselineP95LatencyMs?: number;
  costUsd?: number;
  baselineCostUsd?: number;
  privacySecurityWarnings: number;
}

export interface CodaliReleaseRuntimePackageFlag {
  packageKind: CodaliReleaseRuntimePackageKind;
  version: string;
  enabled: boolean;
  disableOnRollback: boolean;
  rollbackDisabled: boolean;
  reason?: string;
}

export interface CodaliReleaseShadowTrafficReport {
  enabled: boolean;
  nonBlocking: true;
  eligibleRequestCount: number;
  shadowRequestCount: number;
  coverageRate: number;
  status: "not_eligible" | "skipped" | "partial" | "completed";
}

export interface CodaliReleaseRollbackTrigger {
  code: CodaliReleaseRollbackTriggerCode;
  triggered: boolean;
  observed: number;
  threshold: number;
  message: string;
}

export interface CodaliReleaseRolloutEvent {
  eventId: string;
  releaseId: string;
  eventType:
    | "monitor_started"
    | "runtime_flags_applied"
    | "shadow_traffic_started"
    | "shadow_traffic_completed";
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CodaliReleaseRollbackEvent {
  eventId: string;
  releaseId: string;
  eventType:
    | "rollback_triggered"
    | "runtime_package_disabled"
    | "rollback_applied";
  createdAt: string;
  triggerCodes: CodaliReleaseRollbackTriggerCode[];
  runtimePackageKind?: CodaliReleaseRuntimePackageKind;
  runtimePackageVersion?: string;
  unpublishNpm: false;
  metadata: Record<string, unknown>;
}

export interface CodaliReleaseImprovementCycleFeedback {
  status: "recorded" | "queued";
  releaseId: string;
  nextCycleReasons: string[];
  recommendedArtifactTypes: string[];
  source: "release_monitor";
}

export interface CodaliReleaseOutcomeReport {
  schemaVersion: typeof CODALI_RELEASE_OUTCOME_REPORTER_SCHEMA_VERSION;
  releaseId: string;
  status: CodaliReleaseMonitorStatus;
  generatedAt: string;
  monitorWindow: CodaliReleaseMonitorWindow;
  thresholds: CodaliReleaseMonitorThresholds;
  metrics: CodaliReleaseObservedMetrics;
  runtimeFlags: CodaliReleaseRuntimePackageFlag[];
  shadowTraffic: CodaliReleaseShadowTrafficReport;
  rollbackTriggers: CodaliReleaseRollbackTrigger[];
  rolloutEvents: CodaliReleaseRolloutEvent[];
  rollbackEvents: CodaliReleaseRollbackEvent[];
  outcome: CodaliImprovementOutcome;
  improvementCycleFeedback: CodaliReleaseImprovementCycleFeedback;
  storageWrites: Array<{
    accepted: boolean;
    status: number;
    scope: GatewayDatasetStorageScope;
  }>;
}

export interface RunCodaliReleaseOutcomeReporterInput {
  releaseId: string;
  scope?: CodaliImprovementScope;
  monitorWindowMinutes?: number;
  monitorWindowStartedAt?: string;
  monitorWindowEndedAt?: string;
  thresholds?: Partial<CodaliReleaseMonitorThresholds>;
  metrics?: Partial<CodaliReleaseObservedMetrics>;
  runtimeVersions?: Partial<Record<CodaliReleaseRuntimePackageKind, string>>;
  disabledRuntimePackages?: readonly CodaliReleaseRuntimePackageKind[];
  rollbackApplied?: boolean;
  published?: boolean;
  tagged?: boolean;
  trainingUsed?: boolean;
  exportUsed?: boolean;
  now?: () => Date;
}

export interface WriteCodaliReleaseOutcomeReportToStorageInput {
  report: CodaliReleaseOutcomeReport;
  scope: GatewayDatasetStorageScope;
  client: StorageServiceImprovementClient;
}

const DEFAULT_SCOPE: CodaliImprovementScope = {
  tenantHash: "local_tenant",
  productId: "local_product",
};

export const DEFAULT_CODALI_RELEASE_MONITOR_THRESHOLDS:
  CodaliReleaseMonitorThresholds = {
    maxSchemaFailures: 0,
    minAcceptedAnswerRate: 0.85,
    maxAcceptedAnswerRateDrop: 0.05,
    maxVerifierContradictions: 0,
    maxToolFailures: 0,
    maxP95LatencyIncreaseRatio: 0.2,
    maxCostIncreaseRatio: 0.15,
    maxPrivacySecurityWarnings: 0,
  };

const DEFAULT_MONITOR_WINDOW_MINUTES = 60;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16)}`;

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const nonNegativeInteger = (value: unknown, fallback = 0): number => {
  const numberValue = finiteNumber(value, fallback);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : fallback;
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const ratioIncrease = (current: number | undefined, baseline: number | undefined): number => {
  if (current === undefined || baseline === undefined || baseline <= 0) return 0;
  return Math.max(0, (current - baseline) / baseline);
};

const acceptedAnswerDrop = (
  current: number | undefined,
  baseline: number | undefined,
): number => {
  if (current === undefined || baseline === undefined) return 0;
  return Math.max(0, baseline - current);
};

const monitorWindowFor = (input: RunCodaliReleaseOutcomeReporterInput): CodaliReleaseMonitorWindow => {
  const now = input.now ?? (() => new Date());
  const endedAt = input.monitorWindowEndedAt ?? now().toISOString();
  const durationMinutes = input.monitorWindowMinutes ?? DEFAULT_MONITOR_WINDOW_MINUTES;
  const startedAt = input.monitorWindowStartedAt ??
    new Date(Date.parse(endedAt) - durationMinutes * 60_000).toISOString();
  return {
    startedAt,
    endedAt,
    durationMinutes,
  };
};

const metricsFor = (
  metrics: Partial<CodaliReleaseObservedMetrics> | undefined,
): CodaliReleaseObservedMetrics => {
  const acceptedAnswerRate = optionalNumber(metrics?.acceptedAnswerRate);
  const baselineAcceptedAnswerRate = optionalNumber(metrics?.baselineAcceptedAnswerRate);
  const p95LatencyMs = optionalNumber(metrics?.p95LatencyMs);
  const baselineP95LatencyMs = optionalNumber(metrics?.baselineP95LatencyMs);
  const costUsd = optionalNumber(metrics?.costUsd);
  const baselineCostUsd = optionalNumber(metrics?.baselineCostUsd);
  return {
    eligibleRequestCount: nonNegativeInteger(metrics?.eligibleRequestCount),
    shadowRequestCount: nonNegativeInteger(metrics?.shadowRequestCount),
    schemaFailures: nonNegativeInteger(metrics?.schemaFailures),
    ...(acceptedAnswerRate !== undefined ? { acceptedAnswerRate } : {}),
    ...(baselineAcceptedAnswerRate !== undefined ? { baselineAcceptedAnswerRate } : {}),
    verifierContradictions: nonNegativeInteger(metrics?.verifierContradictions),
    toolFailures: nonNegativeInteger(metrics?.toolFailures),
    ...(p95LatencyMs !== undefined ? { p95LatencyMs } : {}),
    ...(baselineP95LatencyMs !== undefined ? { baselineP95LatencyMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(baselineCostUsd !== undefined ? { baselineCostUsd } : {}),
    privacySecurityWarnings: nonNegativeInteger(metrics?.privacySecurityWarnings),
  };
};

const scopeFor = (scope: CodaliImprovementScope | undefined): CodaliImprovementScope => {
  const effectiveScope = scope ?? DEFAULT_SCOPE;
  return {
    tenantHash: effectiveScope.tenantHash,
    productId: effectiveScope.productId,
    ...(effectiveScope.deploymentId ? { deploymentId: effectiveScope.deploymentId } : {}),
  };
};

const triggerFor = (input: {
  code: CodaliReleaseRollbackTriggerCode;
  observed: number;
  threshold: number;
  triggered: boolean;
  message: string;
}): CodaliReleaseRollbackTrigger => ({
  code: input.code,
  observed: input.observed,
  threshold: input.threshold,
  triggered: input.triggered,
  message: input.message,
});

const rollbackTriggersFor = (
  metrics: CodaliReleaseObservedMetrics,
  thresholds: CodaliReleaseMonitorThresholds,
): CodaliReleaseRollbackTrigger[] => {
  const acceptedDrop = acceptedAnswerDrop(
    metrics.acceptedAnswerRate,
    metrics.baselineAcceptedAnswerRate,
  );
  const acceptedRate = metrics.acceptedAnswerRate ?? 1;
  const latencyIncrease = ratioIncrease(metrics.p95LatencyMs, metrics.baselineP95LatencyMs);
  const costIncrease = ratioIncrease(metrics.costUsd, metrics.baselineCostUsd);
  return [
    triggerFor({
      code: "schema_failures",
      observed: metrics.schemaFailures,
      threshold: thresholds.maxSchemaFailures,
      triggered: metrics.schemaFailures > thresholds.maxSchemaFailures,
      message: "Schema failures exceeded the release monitor threshold.",
    }),
    triggerFor({
      code: "accepted_answer_rate_drop",
      observed: Math.max(acceptedDrop, thresholds.minAcceptedAnswerRate - acceptedRate),
      threshold: Math.max(
        thresholds.maxAcceptedAnswerRateDrop,
        Math.max(0, thresholds.minAcceptedAnswerRate - acceptedRate),
      ),
      triggered:
        acceptedRate < thresholds.minAcceptedAnswerRate ||
        acceptedDrop > thresholds.maxAcceptedAnswerRateDrop,
      message: "Accepted-answer rate dropped below release expectations.",
    }),
    triggerFor({
      code: "verifier_contradictions",
      observed: metrics.verifierContradictions,
      threshold: thresholds.maxVerifierContradictions,
      triggered: metrics.verifierContradictions > thresholds.maxVerifierContradictions,
      message: "Verifier contradictions exceeded the release monitor threshold.",
    }),
    triggerFor({
      code: "tool_failures",
      observed: metrics.toolFailures,
      threshold: thresholds.maxToolFailures,
      triggered: metrics.toolFailures > thresholds.maxToolFailures,
      message: "Tool failures exceeded the release monitor threshold.",
    }),
    triggerFor({
      code: "latency_increase",
      observed: latencyIncrease,
      threshold: thresholds.maxP95LatencyIncreaseRatio,
      triggered: latencyIncrease > thresholds.maxP95LatencyIncreaseRatio,
      message: "p95 latency increased beyond the release monitor threshold.",
    }),
    triggerFor({
      code: "cost_increase",
      observed: costIncrease,
      threshold: thresholds.maxCostIncreaseRatio,
      triggered: costIncrease > thresholds.maxCostIncreaseRatio,
      message: "Cost increased beyond the release monitor threshold.",
    }),
    triggerFor({
      code: "privacy_security_warnings",
      observed: metrics.privacySecurityWarnings,
      threshold: thresholds.maxPrivacySecurityWarnings,
      triggered: metrics.privacySecurityWarnings > thresholds.maxPrivacySecurityWarnings,
      message: "Privacy or security warnings exceeded the release monitor threshold.",
    }),
  ];
};

const runtimeFlagsFor = (input: {
  runtimeVersions?: Partial<Record<CodaliReleaseRuntimePackageKind, string>>;
  disabledRuntimePackages?: readonly CodaliReleaseRuntimePackageKind[];
  rollbackRequired: boolean;
}): CodaliReleaseRuntimePackageFlag[] => {
  const disabled = new Set(input.disabledRuntimePackages ?? []);
  return CODALI_RELEASE_RUNTIME_PACKAGE_KINDS.map((packageKind) => {
    const rollbackDisabled = input.rollbackRequired || disabled.has(packageKind);
    return {
      packageKind,
      version: input.runtimeVersions?.[packageKind] ?? "baseline",
      enabled: !rollbackDisabled,
      disableOnRollback: true,
      rollbackDisabled,
      ...(rollbackDisabled
        ? { reason: "release_monitor_rollback_runtime_package_disable" }
        : {}),
    };
  });
};

const shadowTrafficFor = (
  metrics: CodaliReleaseObservedMetrics,
): CodaliReleaseShadowTrafficReport => {
  const coverageRate = metrics.eligibleRequestCount > 0
    ? metrics.shadowRequestCount / metrics.eligibleRequestCount
    : 0;
  const status = metrics.eligibleRequestCount === 0
    ? "not_eligible"
    : metrics.shadowRequestCount === 0
      ? "skipped"
      : metrics.shadowRequestCount >= metrics.eligibleRequestCount
        ? "completed"
        : "partial";
  return {
    enabled: metrics.eligibleRequestCount > 0,
    nonBlocking: true,
    eligibleRequestCount: metrics.eligibleRequestCount,
    shadowRequestCount: metrics.shadowRequestCount,
    coverageRate,
    status,
  };
};

const rolloutEventsFor = (input: {
  releaseId: string;
  createdAt: string;
  runtimeFlags: readonly CodaliReleaseRuntimePackageFlag[];
  shadowTraffic: CodaliReleaseShadowTrafficReport;
}): CodaliReleaseRolloutEvent[] => {
  const events: CodaliReleaseRolloutEvent[] = [
    {
      eventId: stableId("rollout-event", {
        releaseId: input.releaseId,
        eventType: "monitor_started",
        createdAt: input.createdAt,
      }),
      releaseId: input.releaseId,
      eventType: "monitor_started",
      createdAt: input.createdAt,
      metadata: { schemaVersion: CODALI_RELEASE_OUTCOME_REPORTER_SCHEMA_VERSION },
    },
    {
      eventId: stableId("rollout-event", {
        releaseId: input.releaseId,
        eventType: "runtime_flags_applied",
        runtimeFlags: input.runtimeFlags,
      }),
      releaseId: input.releaseId,
      eventType: "runtime_flags_applied",
      createdAt: input.createdAt,
      metadata: { runtimeFlags: input.runtimeFlags },
    },
  ];
  if (input.shadowTraffic.enabled) {
    events.push({
      eventId: stableId("rollout-event", {
        releaseId: input.releaseId,
        eventType: "shadow_traffic_started",
        eligibleRequestCount: input.shadowTraffic.eligibleRequestCount,
      }),
      releaseId: input.releaseId,
      eventType: "shadow_traffic_started",
      createdAt: input.createdAt,
      metadata: { shadowTraffic: input.shadowTraffic },
    });
    events.push({
      eventId: stableId("rollout-event", {
        releaseId: input.releaseId,
        eventType: "shadow_traffic_completed",
        shadowRequestCount: input.shadowTraffic.shadowRequestCount,
      }),
      releaseId: input.releaseId,
      eventType: "shadow_traffic_completed",
      createdAt: input.createdAt,
      metadata: { shadowTraffic: input.shadowTraffic },
    });
  }
  return events;
};

const rollbackEventsFor = (input: {
  releaseId: string;
  createdAt: string;
  triggers: readonly CodaliReleaseRollbackTrigger[];
  runtimeFlags: readonly CodaliReleaseRuntimePackageFlag[];
  rollbackApplied: boolean;
}): CodaliReleaseRollbackEvent[] => {
  const triggerCodes = input.triggers
    .filter((trigger) => trigger.triggered)
    .map((trigger) => trigger.code);
  if (triggerCodes.length === 0) return [];
  const events: CodaliReleaseRollbackEvent[] = [
    {
      eventId: stableId("rollback-event", {
        releaseId: input.releaseId,
        eventType: "rollback_triggered",
        triggerCodes,
      }),
      releaseId: input.releaseId,
      eventType: "rollback_triggered",
      createdAt: input.createdAt,
      triggerCodes,
      unpublishNpm: false,
      metadata: { triggers: input.triggers.filter((trigger) => trigger.triggered) },
    },
  ];
  for (const flag of input.runtimeFlags.filter((item) => item.rollbackDisabled)) {
    events.push({
      eventId: stableId("rollback-event", {
        releaseId: input.releaseId,
        eventType: "runtime_package_disabled",
        packageKind: flag.packageKind,
        version: flag.version,
      }),
      releaseId: input.releaseId,
      eventType: "runtime_package_disabled",
      createdAt: input.createdAt,
      triggerCodes,
      runtimePackageKind: flag.packageKind,
      runtimePackageVersion: flag.version,
      unpublishNpm: false,
      metadata: {
        enabled: false,
        reason: flag.reason,
        npmPackageUnpublished: false,
      },
    });
  }
  if (input.rollbackApplied) {
    events.push({
      eventId: stableId("rollback-event", {
        releaseId: input.releaseId,
        eventType: "rollback_applied",
        triggerCodes,
      }),
      releaseId: input.releaseId,
      eventType: "rollback_applied",
      createdAt: input.createdAt,
      triggerCodes,
      unpublishNpm: false,
      metadata: {
        rollbackApplied: true,
        npmPackageUnpublished: false,
      },
    });
  }
  return events;
};

const recommendedArtifactTypesFor = (
  triggers: readonly CodaliReleaseRollbackTrigger[],
): string[] => {
  const recommendations = new Set<string>();
  for (const trigger of triggers.filter((item) => item.triggered)) {
    if (trigger.code === "schema_failures") recommendations.add("schema");
    if (trigger.code === "accepted_answer_rate_drop") recommendations.add("eval");
    if (trigger.code === "verifier_contradictions") recommendations.add("eval");
    if (trigger.code === "tool_failures") recommendations.add("tool-metadata");
    if (trigger.code === "latency_increase") recommendations.add("model-router");
    if (trigger.code === "cost_increase") recommendations.add("model-router");
    if (trigger.code === "privacy_security_warnings") recommendations.add("policy");
  }
  return Array.from(recommendations).sort();
};

export const runCodaliReleaseOutcomeReporter = (
  input: RunCodaliReleaseOutcomeReporterInput,
): CodaliReleaseOutcomeReport => {
  const now = input.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const monitorWindow = monitorWindowFor(input);
  const thresholds = {
    ...DEFAULT_CODALI_RELEASE_MONITOR_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };
  const metrics = metricsFor(input.metrics);
  const triggers = rollbackTriggersFor(metrics, thresholds);
  const rollbackRequired = triggers.some((trigger) => trigger.triggered);
  const runtimeFlags = runtimeFlagsFor({
    runtimeVersions: input.runtimeVersions,
    disabledRuntimePackages: input.disabledRuntimePackages,
    rollbackRequired,
  });
  const shadowTraffic = shadowTrafficFor(metrics);
  const rollbackApplied = input.rollbackApplied === true && rollbackRequired;
  const status: CodaliReleaseMonitorStatus = rollbackRequired
    ? rollbackApplied ? "rolled_back" : "rollback_required"
    : metrics.eligibleRequestCount > 0 && metrics.shadowRequestCount === 0
      ? "watch"
      : "healthy";
  const rolloutEvents = rolloutEventsFor({
    releaseId: input.releaseId,
    createdAt: generatedAt,
    runtimeFlags,
    shadowTraffic,
  });
  const rollbackEvents = rollbackEventsFor({
    releaseId: input.releaseId,
    createdAt: generatedAt,
    triggers,
    runtimeFlags,
    rollbackApplied,
  });
  const triggeredCodes = triggers
    .filter((trigger) => trigger.triggered)
    .map((trigger) => trigger.code);
  const scope = scopeFor(input.scope);
  const outcome: CodaliImprovementOutcome = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    outcomeId: stableId("monitor-outcome", {
      releaseId: input.releaseId,
      status,
      triggeredCodes,
      generatedAt,
    }),
    releaseId: input.releaseId,
    scope,
    status: status === "rolled_back"
      ? "rolled_back"
      : rollbackRequired
        ? "degraded"
        : "succeeded",
    published: input.published ?? false,
    tagged: input.tagged ?? false,
    trainingUsed: input.trainingUsed ?? false,
    exportUsed: input.exportUsed ?? false,
    createdAt: generatedAt,
    ...(triggeredCodes.length ? { reasons: triggeredCodes } : {}),
    telemetry: {
      eligible_request_count: metrics.eligibleRequestCount,
      shadow_request_count: metrics.shadowRequestCount,
      schema_failures: metrics.schemaFailures,
      verifier_contradictions: metrics.verifierContradictions,
      tool_failures: metrics.toolFailures,
      privacy_security_warnings: metrics.privacySecurityWarnings,
      ...(metrics.acceptedAnswerRate !== undefined
        ? { accepted_answer_rate: metrics.acceptedAnswerRate }
        : {}),
      ...(metrics.p95LatencyMs !== undefined ? { p95_latency_ms: metrics.p95LatencyMs } : {}),
      ...(metrics.costUsd !== undefined ? { cost_usd: metrics.costUsd } : {}),
    },
    metadata: {
      schemaVersion: CODALI_RELEASE_OUTCOME_REPORTER_SCHEMA_VERSION,
      monitorWindow,
      thresholds,
      runtimeFlags,
      shadowTraffic,
      rolloutEvents,
      rollbackEvents,
      rollbackRequired,
      npmPackageUnpublished: false,
    },
  };
  return {
    schemaVersion: CODALI_RELEASE_OUTCOME_REPORTER_SCHEMA_VERSION,
    releaseId: input.releaseId,
    status,
    generatedAt,
    monitorWindow,
    thresholds,
    metrics,
    runtimeFlags,
    shadowTraffic,
    rollbackTriggers: triggers,
    rolloutEvents,
    rollbackEvents,
    outcome,
    improvementCycleFeedback: {
      status: triggeredCodes.length ? "queued" : "recorded",
      releaseId: input.releaseId,
      nextCycleReasons: triggeredCodes,
      recommendedArtifactTypes: recommendedArtifactTypesFor(triggers),
      source: "release_monitor",
    },
    storageWrites: [],
  };
};

export const writeCodaliReleaseOutcomeReportToStorageService = async (
  input: WriteCodaliReleaseOutcomeReportToStorageInput,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  const runWrite = await input.client.recordRun({
    scope: input.scope,
    idempotencyKey: `improvement-monitor:${input.report.releaseId}`,
    body: {
      improvement_run_id: input.scope.runId,
      run_kind: "release_monitor",
      status: input.report.status === "healthy" || input.report.status === "watch"
        ? "completed"
        : "blocked",
      source_export_id: input.report.releaseId,
      metadata: {
        schemaVersion: input.report.schemaVersion,
        releaseId: input.report.releaseId,
        monitorWindow: input.report.monitorWindow,
        thresholds: input.report.thresholds,
        metrics: input.report.metrics,
        runtimeFlags: input.report.runtimeFlags,
        shadowTraffic: input.report.shadowTraffic,
        rollbackTriggers: input.report.rollbackTriggers,
        rolloutEvents: input.report.rolloutEvents,
        rollbackEvents: input.report.rollbackEvents,
        outcome: input.report.outcome,
        improvementCycleFeedback: input.report.improvementCycleFeedback,
      },
    },
  });
  const candidateWrite = await input.client.recordCandidate({
    scope: input.scope,
    idempotencyKey: `improvement-monitor-candidate:${input.report.releaseId}`,
    body: {
      candidate_id: input.report.releaseId,
      improvement_run_id: input.scope.runId,
      source_export_id: input.report.releaseId,
      source_record_ids: [],
      candidate_kind: "release",
      candidate_ref: input.report.releaseId,
      status: input.report.status === "healthy" || input.report.status === "watch"
        ? "released"
        : "blocked",
      metadata: {
        schemaVersion: input.report.schemaVersion,
        outcome: input.report.outcome,
        rolloutEvents: input.report.rolloutEvents,
        rollbackEvents: input.report.rollbackEvents,
        improvementCycleFeedback: input.report.improvementCycleFeedback,
      },
    },
  });
  return [runWrite, candidateWrite];
};
