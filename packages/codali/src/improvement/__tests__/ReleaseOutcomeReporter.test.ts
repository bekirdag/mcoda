import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../../cli.js";
import {
  buildCodaliImprovementCliJsonOutput,
  validateCodaliImprovementCliJsonOutput,
} from "../ImprovementPolicy.js";
import { StorageServiceImprovementClient } from "../StorageServiceImprovementClient.js";
import {
  CODALI_RELEASE_ROLLBACK_TRIGGER_CODES,
  CODALI_RELEASE_RUNTIME_PACKAGE_KINDS,
  DEFAULT_CODALI_RELEASE_MONITOR_THRESHOLDS,
  runCodaliReleaseOutcomeReporter,
  writeCodaliReleaseOutcomeReportToStorageService,
} from "../ReleaseOutcomeReporter.js";
import type {
  GatewayDatasetFetch,
  GatewayDatasetFetchRequest,
  GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const storageScope: GatewayDatasetStorageScope = {
  tenantId: "tenant-phase-33",
  productId: "product-neutral",
  deploymentId: "phase-33",
  runId: "improvement-monitor-phase-33",
};

const response = (input: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}) => ({
  ok: input.ok ?? true,
  status: input.status ?? 201,
  statusText: input.statusText,
  text: async () => input.body === undefined ? "" : JSON.stringify(input.body),
});

const captureLog = async (run: () => Promise<void>): Promise<string> => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += `${String(value ?? "")}\n`;
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return output;
};

test("ReleaseOutcomeReporter records monitor windows, thresholds, runtime flags, and shadow rollout", () => {
  const report = runCodaliReleaseOutcomeReporter({
    releaseId: "phase-33-healthy-release",
    scope: {
      tenantHash: "tenant-phase-33",
      productId: "product-neutral",
      deploymentId: "phase-33",
    },
    monitorWindowMinutes: 30,
    monitorWindowEndedAt: "2026-07-08T12:00:00.000Z",
    metrics: {
      eligibleRequestCount: 10,
      shadowRequestCount: 10,
      acceptedAnswerRate: 0.97,
      baselineAcceptedAnswerRate: 0.96,
      p95LatencyMs: 100,
      baselineP95LatencyMs: 100,
      costUsd: 1,
      baselineCostUsd: 1,
    },
    runtimeVersions: {
      prompt_package: "prompt-v2",
      router_policy: "router-v3",
      retrieval_policy: "retrieval-v4",
      schema: "schema-v5",
      fine_tune_adapter: "fine-tune-v6",
    },
    now: fixedNow,
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.monitorWindow.startedAt, "2026-07-08T11:30:00.000Z");
  assert.equal(report.monitorWindow.endedAt, "2026-07-08T12:00:00.000Z");
  assert.equal(report.monitorWindow.durationMinutes, 30);
  assert.deepEqual(report.thresholds, DEFAULT_CODALI_RELEASE_MONITOR_THRESHOLDS);
  assert.deepEqual(
    report.runtimeFlags.map((flag) => flag.packageKind),
    [...CODALI_RELEASE_RUNTIME_PACKAGE_KINDS],
  );
  assert.deepEqual(
    Object.fromEntries(report.runtimeFlags.map((flag) => [flag.packageKind, flag.version])),
    {
      prompt_package: "prompt-v2",
      router_policy: "router-v3",
      retrieval_policy: "retrieval-v4",
      schema: "schema-v5",
      fine_tune_adapter: "fine-tune-v6",
    },
  );
  assert.equal(report.runtimeFlags.every((flag) => flag.enabled), true);
  assert.equal(report.shadowTraffic.nonBlocking, true);
  assert.equal(report.shadowTraffic.status, "completed");
  assert.equal(report.shadowTraffic.coverageRate, 1);
  assert.deepEqual(
    report.rolloutEvents.map((event) => event.eventType),
    [
      "monitor_started",
      "runtime_flags_applied",
      "shadow_traffic_started",
      "shadow_traffic_completed",
    ],
  );
  assert.equal(report.rollbackEvents.length, 0);
  assert.equal(report.improvementCycleFeedback.status, "recorded");

  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.monitor",
    status: "ok",
    data: report,
  });
  const validation = validateCodaliImprovementCliJsonOutput(output);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
});

test("ReleaseOutcomeReporter triggers rollback and disables runtime packages without npm unpublish", () => {
  const report = runCodaliReleaseOutcomeReporter({
    releaseId: "phase-33-rollback-release",
    monitorWindowEndedAt: "2026-07-08T12:00:00.000Z",
    metrics: {
      eligibleRequestCount: 8,
      shadowRequestCount: 4,
      schemaFailures: 1,
      acceptedAnswerRate: 0.72,
      baselineAcceptedAnswerRate: 0.91,
      verifierContradictions: 1,
      toolFailures: 2,
      p95LatencyMs: 1600,
      baselineP95LatencyMs: 1000,
      costUsd: 2,
      baselineCostUsd: 1,
      privacySecurityWarnings: 1,
    },
    runtimeVersions: {
      prompt_package: "prompt-v2",
      router_policy: "router-v3",
      retrieval_policy: "retrieval-v4",
      schema: "schema-v5",
      fine_tune_adapter: "fine-tune-v6",
    },
    rollbackApplied: true,
    now: fixedNow,
  });

  assert.equal(report.status, "rolled_back");
  assert.deepEqual(
    report.rollbackTriggers.filter((trigger) => trigger.triggered).map((trigger) => trigger.code),
    [...CODALI_RELEASE_ROLLBACK_TRIGGER_CODES],
  );
  assert.equal(report.runtimeFlags.every((flag) => !flag.enabled), true);
  assert.equal(report.runtimeFlags.every((flag) => flag.rollbackDisabled), true);
  assert.deepEqual(
    report.rollbackEvents.map((event) => event.eventType),
    [
      "rollback_triggered",
      "runtime_package_disabled",
      "runtime_package_disabled",
      "runtime_package_disabled",
      "runtime_package_disabled",
      "runtime_package_disabled",
      "rollback_applied",
    ],
  );
  assert.equal(report.rollbackEvents.every((event) => event.unpublishNpm === false), true);
  assert.deepEqual(
    report.rollbackEvents
      .filter((event) => event.eventType === "runtime_package_disabled")
      .map((event) => event.runtimePackageKind),
    [...CODALI_RELEASE_RUNTIME_PACKAGE_KINDS],
  );
  assert.equal(report.outcome.status, "rolled_back");
  assert.deepEqual(report.outcome.reasons, [...CODALI_RELEASE_ROLLBACK_TRIGGER_CODES]);
  assert.equal(report.outcome.metadata?.npmPackageUnpublished, false);
  assert.equal(report.improvementCycleFeedback.status, "queued");
  assert.deepEqual(report.improvementCycleFeedback.nextCycleReasons, [
    ...CODALI_RELEASE_ROLLBACK_TRIGGER_CODES,
  ]);
  assert.deepEqual(report.improvementCycleFeedback.recommendedArtifactTypes, [
    "eval",
    "model-router",
    "policy",
    "schema",
    "tool-metadata",
  ]);

  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.monitor",
    status: "blocked",
    data: report,
  });
  const validation = validateCodaliImprovementCliJsonOutput(output);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
});

test("ReleaseOutcomeReporter writes rollout and rollback events to storage-service improvement records", async () => {
  const report = runCodaliReleaseOutcomeReporter({
    releaseId: "phase-33-storage-release",
    monitorWindowEndedAt: "2026-07-08T12:00:00.000Z",
    metrics: {
      eligibleRequestCount: 2,
      shadowRequestCount: 1,
      schemaFailures: 1,
      privacySecurityWarnings: 1,
    },
    rollbackApplied: true,
    now: fixedNow,
  });
  const requests: Array<{ url: string; request: GatewayDatasetFetchRequest }> = [];
  const fetchImpl: GatewayDatasetFetch = async (url, request) => {
    requests.push({ url, request });
    return response({
      body: {
        accepted: true,
        scope: storageScope,
      },
    });
  };
  const client = new StorageServiceImprovementClient({
    baseUrl: "http://storage.local/",
    serviceToken: "service-token",
    fetch: fetchImpl,
    now: fixedNow,
    nonceFactory: () => `nonce-${requests.length + 1}`,
  });

  const writes = await writeCodaliReleaseOutcomeReportToStorageService({
    report,
    scope: storageScope,
    client,
  });

  assert.equal(writes.length, 2);
  assert.equal(writes.every((write) => write.accepted), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "http://storage.local/v1/improvement/runs");
  assert.equal(requests[1]?.url, "http://storage.local/v1/improvement/candidates");

  const runBody = JSON.parse(String(requests[0]?.request.body ?? "{}"));
  const candidateBody = JSON.parse(String(requests[1]?.request.body ?? "{}"));
  assert.equal(runBody.run_kind, "release_monitor");
  assert.equal(runBody.status, "blocked");
  assert.equal(runBody.metadata.releaseId, "phase-33-storage-release");
  assert.equal(runBody.metadata.rolloutEvents.length >= 3, true);
  assert.equal(runBody.metadata.rollbackEvents.length >= 3, true);
  assert.equal(runBody.metadata.improvementCycleFeedback.status, "queued");
  assert.equal(candidateBody.candidate_kind, "release");
  assert.equal(candidateBody.status, "blocked");
  assert.equal(candidateBody.metadata.rollbackEvents.length, report.rollbackEvents.length);
});

test("codali improve monitor emits validated JSON with runtime flags and rollback status", async () => {
  const output = await captureLog(() => runCli([
    "improve",
    "monitor",
    "--release",
    "phase-33-cli-release",
    "--output",
    "json",
    "--monitor-window-minutes",
    "45",
    "--monitor-ended-at",
    "2026-07-08T12:00:00.000Z",
    "--prompt-package-version",
    "prompt-v2",
    "--router-policy-version",
    "router-v3",
    "--retrieval-policy-version",
    "retrieval-v4",
    "--schema-version",
    "schema-v5",
    "--fine-tune-adapter-version",
    "fine-tune-v6",
    "--eligible-requests",
    "4",
    "--shadow-requests",
    "2",
    "--schema-failures",
    "1",
    "--threshold-schema-failures",
    "0",
    "--rollback-applied",
  ]));
  const parsed = JSON.parse(output);
  const validation = validateCodaliImprovementCliJsonOutput(parsed);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(parsed.outputType, "improvement.monitor");
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.data.releaseId, "phase-33-cli-release");
  assert.equal(parsed.data.status, "rolled_back");
  assert.equal(parsed.data.monitorWindow.durationMinutes, 45);
  assert.equal(parsed.data.monitorWindow.startedAt, "2026-07-08T11:15:00.000Z");
  assert.equal(parsed.data.shadowTraffic.nonBlocking, true);
  assert.equal(parsed.data.shadowTraffic.status, "partial");
  assert.equal(parsed.data.storageWrites.length, 0);
  assert.deepEqual(
    parsed.data.runtimeFlags.map((flag: { packageKind: string; enabled: boolean }) => [
      flag.packageKind,
      flag.enabled,
    ]),
    CODALI_RELEASE_RUNTIME_PACKAGE_KINDS.map((packageKind) => [packageKind, false]),
  );
});
