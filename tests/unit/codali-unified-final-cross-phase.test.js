import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const storageServiceRoot = process.env.CODALI_STORAGE_SERVICE_TEST_ROOT
  ? path.resolve(process.env.CODALI_STORAGE_SERVICE_TEST_ROOT)
  : path.resolve(repoRoot, "..", "codali-storage-service");
const storageServiceBaselinePath = "docs/baselines/codali-unified-phase0/codali-storage-service-baseline.json";
const storageServiceReleaseAuditPath = "docs/planning/codali-unified-release-audit-2026-07-08.md";

const readText = (root, relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const readJson = (root, relativePath) =>
  JSON.parse(readText(root, relativePath));

const exists = (root, relativePath) =>
  fs.existsSync(path.join(root, relativePath));

const storageServiceExists = () =>
  fs.existsSync(storageServiceRoot);

const readStorageServiceBaseline = () =>
  readJson(repoRoot, storageServiceBaselinePath);

const assertStorageServiceReleaseEvidence = () => {
  const baseline = readStorageServiceBaseline();
  const auditText = readText(repoRoot, storageServiceReleaseAuditPath);
  assert.equal(baseline.repo.label, "codali-storage-service");
  assert.equal(baseline.repo.git_status_at_audit.state, "clean");
  assert.equal(baseline.repo.git_status_at_audit.remote, "https://github.com/bekirdag/codali-storage-service.git");
  assert.equal(baseline.repo_readiness.package_manager.status, "implemented");
  assert.equal(baseline.repo_readiness.docker.status, "implemented");
  assert.match(auditText, /`codali-storage-service` validation passed locally:/);
  assert.match(auditText, /pnpm run openapi:check/);
  assert.match(auditText, /pnpm run test:integration/);
  assert.match(auditText, /pnpm test -- improvement/);
};

const requireFiles = (root, files) => {
  for (const file of files) {
    assert.equal(exists(root, file), true, `missing required file: ${file}`);
  }
};

const listFiles = (root, relativeDir, options = {}) => {
  const start = path.join(root, relativeDir);
  if (!fs.existsSync(start)) return [];
  const excludes = new Set(options.excludes ?? []);
  const output = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excludes.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (!options.extensions || options.extensions.some((ext) => entry.name.endsWith(ext))) {
        output.push(path.relative(root, fullPath).split(path.sep).join("/"));
      }
    }
  };
  visit(start);
  return output.sort();
};

const sourceFiles = (root, dirs) =>
  dirs.flatMap((dir) =>
    listFiles(root, dir, {
      extensions: [".js", ".mjs", ".ts", ".json", ".md", ".yml", ".yaml"],
      excludes: [
        ".git",
        ".pnpm",
        "node_modules",
        "dist",
        "build",
        "coverage",
        "vendor",
        "__pycache__",
      ],
    }),
  );

const runtimeTsFiles = (root, dirs) =>
  dirs.flatMap((dir) =>
    listFiles(root, dir, {
      extensions: [".ts", ".js", ".mjs"],
      excludes: ["__tests__", "dist", "build", "node_modules", "vendor"],
    }),
  );

const expectedStorageOperations = [
  "/v1/gateway/runs",
  "/v1/gateway/runs/{runId}",
  "/v1/gateway/runs/{runId}/tasks",
  "/v1/gateway/runs/{runId}/tasks/{taskId}",
  "/v1/gateway/runs/{runId}/evidence",
  "/v1/gateway/runs/{runId}/tool-calls",
  "/v1/gateway/runs/{runId}/model-calls",
  "/v1/gateway/runs/{runId}/context-pack",
  "/v1/gateway/runs/{runId}/artifacts",
  "/v1/gateway/runs/{runId}/events",
  "/v1/gateway/runs/{runId}/trace",
  "/v1/gateway/batches",
  "/v1/dataset/collect/{runId}",
  "/v1/dataset/examples",
  "/v1/dataset/examples/{exampleId}",
  "/v1/dataset/feedback",
  "/v1/dataset/reviews",
  "/v1/dataset/labels",
  "/v1/dataset/exports",
  "/v1/dataset/exports/{exportId}",
  "/v1/dataset/exports/{exportId}/download",
  "/v1/dataset/batches",
  "/v1/admin/stats",
  "/v1/admin/audit-log",
  "/v1/admin/upload-outbox",
  "/v1/admin/upload-outbox/drain",
  "/v1/admin/retention/prune",
  "/v1/admin/deletion/run/{runId}",
  "/v1/admin/deletion/conversation/{conversationHash}",
  "/v1/admin/deletion/tenant/{tenantHash}",
  "/v1/improvement/runs",
  "/v1/improvement/runs/{runId}",
  "/v1/improvement/candidates",
  "/v1/improvement/candidates/{candidateId}",
  "/v1/improvement/eval-runs",
  "/v1/improvement/releases",
  "/v1/improvement/releases/{releaseId}",
  "/v1/improvement/release-outcomes",
  "/v1/improvement/releases/{releaseId}/lineage",
  "/v1/improvement/lineage/{releaseId}",
  "/v1/improvement/products/{productId}/quality-summary",
];

test("final cross-phase plan and validation commands are source-backed", () => {
  const planText = readText(
    repoRoot,
    "docs/planning/codali-unified-data-storage-improvement-build-plan.md",
  );
  const phases = Array.from(
    planText.matchAll(/^### Phase (\d+): (.+)$/gm),
    (match) => ({ number: Number(match[1]), title: match[2] }),
  );
  assert.equal(phases.length, 36);
  assert.deepEqual(
    phases.map((phase) => phase.number),
    Array.from({ length: 36 }, (_, index) => index),
  );
  assert.equal(phases.at(0).title, "Baseline Audit And Repo Readiness");
  assert.equal(phases.at(-1).title, "Production Rollout And Governance");

  const rootPackage = readJson(repoRoot, "package.json");
  const codaliPackage = readJson(repoRoot, "packages/codali/package.json");
  const mswarmPackage = readJson(repoRoot, "packages/mswarm/package.json");

  assert.equal(rootPackage.scripts.test, "node tests/all.js");
  assert.equal(
    rootPackage.scripts["release:publish:npm:dry-run"],
    "node scripts/publish-npm-packages.js --dry-run",
  );
  assert.equal(codaliPackage.bin.codali, "dist/cli.js");
  assert.equal(codaliPackage.bin.dataset, "dist/dataset-cli.js");
  assert.match(codaliPackage.scripts.test, /run-node-tests\.js dist$/);
  assert.match(mswarmPackage.scripts.build, /@mcoda\/codali run build/);
  if (storageServiceExists()) {
    const storagePackage = readJson(storageServiceRoot, "package.json");
    assert.equal(storagePackage.scripts["openapi:check"], "node scripts/openapi-check.mjs");
    assert.equal(storagePackage.scripts["test:integration"], "pnpm run build && node scripts/run-tests.mjs integration");
  } else {
    assertStorageServiceReleaseEvidence();
  }
});

test("final cross-phase Codali surfaces cover dataset, improvement, gates, rollout, and mswarm metadata", () => {
  requireFiles(repoRoot, [
    "docs/contracts/codali-storage/v1/contract-fixtures.json",
    "packages/codali/src/cli/DatasetCommand.ts",
    "packages/codali/src/cli/FeedbackCommand.ts",
    "packages/codali/src/cli/ImprovementCommand.ts",
    "packages/codali/src/dataset-cli.ts",
    "packages/codali/src/eval/GatewayDatasetEval.ts",
    "packages/codali/src/storage/CodaliDatasetPrivacyEngine.ts",
    "packages/codali/src/storage/CodaliFeedbackReviewIngestion.ts",
    "packages/codali/src/storage/CodaliStorageContracts.ts",
    "packages/codali/src/storage/DatasetExportJob.ts",
    "packages/codali/src/storage/DatasetReviewQueue.ts",
    "packages/codali/src/storage/GatewayDatasetStore.ts",
    "packages/codali/src/improvement/CandidateReleaseBuilder.ts",
    "packages/codali/src/improvement/DatasetEligibilityGate.ts",
    "packages/codali/src/improvement/DatasetExportManifestReader.ts",
    "packages/codali/src/improvement/DocdexRetrievalCandidateBuilder.ts",
    "packages/codali/src/improvement/EvalReplayCandidateBuilder.ts",
    "packages/codali/src/improvement/FineTuneJobPlanner.ts",
    "packages/codali/src/improvement/ImprovementEvalRunner.ts",
    "packages/codali/src/improvement/ImprovementPolicy.ts",
    "packages/codali/src/improvement/ModelRouterCandidateBuilder.ts",
    "packages/codali/src/improvement/OperatorInspector.ts",
    "packages/codali/src/improvement/ProductionGovernance.ts",
    "packages/codali/src/improvement/PromptSchemaToolMetadataCandidateBuilder.ts",
    "packages/codali/src/improvement/PublishOrchestrator.ts",
    "packages/codali/src/improvement/ReleaseOutcomeReporter.ts",
    "packages/codali/src/improvement/StorageServiceImprovementClient.ts",
    "packages/mswarm/src/codali-executor.ts",
    "packages/mswarm/src/runtime.ts",
  ]);

  const gatewayText = readText(repoRoot, "packages/codali/src/gateway/CodaliGateway.ts");
  const datasetStoreText = readText(repoRoot, "packages/codali/src/storage/GatewayDatasetStore.ts");
  const storageContractText = readText(repoRoot, "packages/codali/src/storage/CodaliStorageContracts.ts");
  const contractFixtures = readJson(repoRoot, "docs/contracts/codali-storage/v1/contract-fixtures.json");
  const datasetExportText = readText(repoRoot, "packages/codali/src/storage/DatasetExportJob.ts");
  const manifestReaderText = readText(
    repoRoot,
    "packages/codali/src/improvement/DatasetExportManifestReader.ts",
  );
  const candidateReleaseText = readText(repoRoot, "packages/codali/src/improvement/CandidateReleaseBuilder.ts");
  const policyText = readText(repoRoot, "packages/codali/src/improvement/ImprovementPolicy.ts");
  const governanceText = readText(repoRoot, "packages/codali/src/improvement/ProductionGovernance.ts");
  const releaseText = readText(repoRoot, "packages/codali/src/improvement/ReleaseOutcomeReporter.ts");
  const mswarmExecutorText = readText(repoRoot, "packages/mswarm/src/codali-executor.ts");
  const mswarmRuntimeText = readText(repoRoot, "packages/mswarm/src/runtime.ts");

  assert.match(gatewayText, /collectDatasetResult\(request, result\)/);
  assert.match(datasetStoreText, /export const collectGatewayDatasetResultNonBlocking/);
  assert.match(datasetStoreText, /status: "queued"/);
  assert.match(datasetStoreText, /queueMicrotask/);
  assert.match(datasetStoreText, /input\.onError\?\.\(error\)/);
  assert.match(storageContractText, /CODALI_STORAGE_CONTRACT_SCHEMA_VERSION = "codali\.storage\.v1"/);
  assert.match(storageContractText, /CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY/);
  assert.match(storageContractText, /validateCodaliStorageExportManifest/);
  assert.equal(contractFixtures.schema_version, "codali.storage.fixtures.v1");
  assert.equal(contractFixtures.contract_schema_version, "codali.storage.v1");
  assert.equal(contractFixtures.distribution.package_name, "@mcoda/codali");
  assert.equal(contractFixtures.fixtures.privacy_metadata.upload_allowed, false);
  assert.equal(contractFixtures.fixtures.privacy_metadata.training_allowed, false);
  assert.match(datasetExportText, /CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION = "codali\.dataset\.export\.job\.v1"/);
  assert.match(datasetExportText, /validateCodaliStorageExportManifest/);
  assert.match(datasetExportText, /deletionGroupSnapshotForRecords/);
  assert.match(manifestReaderText, /CODALI_IMPROVEMENT_MANIFEST_READER_SCHEMA_VERSION/);
  assert.match(manifestReaderText, /validateCodaliStorageExportManifest/);
  assert.match(manifestReaderText, /revokedDeletionGroupIds/);
  assert.match(candidateReleaseText, /DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS/);
  assert.match(candidateReleaseText, /CodaliCandidateReleaseWorkspace/);
  assert.match(candidateReleaseText, /patchOutput/);
  assert.match(candidateReleaseText, /unrelatedDirtyFileCount/);
  assert.match(candidateReleaseText, /sourceExportIds/);
  assert.match(candidateReleaseText, /rawCustomerDataIncluded: false/);
  assert.match(policyText, /autoTagEnabled: false/);
  assert.match(policyText, /autoPublishEnabled: false/);
  assert.match(governanceText, /CODALI_STORAGE_UPLOAD_ENABLED/);
  assert.match(governanceText, /rollback_monitor_gate_inactive/);
  assert.match(governanceText, /Stable auto-publish only with policy, CI, provenance, audit, rollback, and hard gates/);
  assert.match(releaseText, /nonBlocking: true/);
  assert.match(releaseText, /unpublishNpm: false/);
  assert.match(policyText, /rollback_must_not_unpublish_npm/);
  assert.match(mswarmExecutorText, /codali_product_metadata/);
  assert.match(mswarmExecutorText, /dataset_collection/);
  assert.match(mswarmExecutorText, /privacy_flags/);
  assert.match(mswarmExecutorText, /raw_trace_included/);
  assert.match(mswarmExecutorText, /agentInventory/);
  assert.match(mswarmRuntimeText, /resolveMcodaAgentForJob/);
  assert.match(mswarmRuntimeText, /codali_product_metadata/);
});

test("final cross-phase storage-service routes, defaults, and governance are aligned", () => {
  if (!storageServiceExists()) {
    assertStorageServiceReleaseEvidence();
    return;
  }

  requireFiles(storageServiceRoot, [
    "scripts/openapi-check.mjs",
    "src/config/ServiceConfig.ts",
    "src/contracts/SharedContractValidation.ts",
    "src/db/CodaliStorageMigrations.ts",
    "src/object-store/FilesystemObjectStore.ts",
    "src/object-store/InMemoryObjectStore.ts",
    "src/object-store/S3CompatibleObjectStore.ts",
    "src/routes/dataset/DatasetRoutes.ts",
    "src/routes/gateway/GatewayRoutes.ts",
    "src/routes/improvement/ImprovementRoutes.ts",
    "src/services/dataset/DatasetCollectorService.ts",
    "src/services/improvement/ImprovementStorageService.ts",
    "src/services/upload/UploadOutboxService.ts",
    "src/server/App.ts",
    "src/retention-cli.ts",
    "docs/ops/backup-restore-runbook.md",
    "docs/openapi/codali-storage-service.openapi.json",
  ]);

  const openapi = readJson(storageServiceRoot, "docs/openapi/codali-storage-service.openapi.json");
  const openapiCheckText = readText(storageServiceRoot, "scripts/openapi-check.mjs");
  const checkedOperations = Array.from(
    openapiCheckText.matchAll(/^\s+"([^"]+)":\s+\[/gm),
    (match) => match[1],
  );
  assert.deepEqual(checkedOperations, expectedStorageOperations);

  for (const route of expectedStorageOperations) {
    assert.ok(openapi.paths[route], `OpenAPI missing ${route}`);
    assert.match(openapiCheckText, new RegExp(route.replace(/[{}]/g, "\\$&")));
  }

  const contractText = readText(storageServiceRoot, "src/contracts/SharedContractValidation.ts");
  const appText = readText(storageServiceRoot, "src/server/App.ts");
  const datasetRoutesText = readText(storageServiceRoot, "src/routes/dataset/DatasetRoutes.ts");
  const improvementRoutesText = readText(storageServiceRoot, "src/routes/improvement/ImprovementRoutes.ts");
  const uploadText = readText(storageServiceRoot, "src/services/upload/UploadOutboxService.ts");

  assert.match(contractText, /CODALI_STORAGE_SERVICE_DEFAULT_STORAGE_MODE = "local_only"/);
  assert.match(contractText, /CODALI_STORAGE_SERVICE_UPLOAD_ENABLED_DEFAULT = false/);
  assert.match(appText, /registerGatewayRoutes/);
  assert.match(appText, /registerDatasetRoutes/);
  assert.match(appText, /registerImprovementRoutes/);
  assert.match(datasetRoutesText, /missing_idempotency_key/);
  assert.match(datasetRoutesText, /idempotency_conflict/);
  assert.match(datasetRoutesText, /privacy\.exportAllowed === true/);
  assert.match(datasetRoutesText, /eligibility\.eligible === true/);
  assert.match(improvementRoutesText, /app\.patch\("\/v1\/improvement\/runs\/:runId"/);
  assert.match(improvementRoutesText, /readProductQualitySummary/);
  assert.match(uploadText, /redactionStatus/);
  assert.match(uploadText, /uploadAllowed/);
  assert.match(uploadText, /exportAllowed/);
});

test("final cross-phase source scans ignore generated dependencies but catch real leaks", () => {
  const conflictMarker = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m;
  const scanRoots = storageServiceExists() ? [repoRoot, storageServiceRoot] : [repoRoot];
  for (const root of scanRoots) {
    const files = sourceFiles(root, ["docs", "scripts", "src", "tests", "packages"].filter((dir) => exists(root, dir)));
    for (const file of files) {
      assert.doesNotMatch(readText(root, file), conflictMarker, `${file} contains a merge conflict marker`);
    }
  }

  const coreFiles = [
    ...runtimeTsFiles(repoRoot, [
      "packages/codali/src/gateway",
      "packages/codali/src/runtime",
      "packages/codali/src/storage",
      "packages/codali/src/improvement",
      "packages/mswarm/src",
    ]),
    ...(storageServiceExists() ? runtimeTsFiles(storageServiceRoot, ["src"]) : []),
  ];
  const productSpecific = /\b(okacam|sukunahikona|suku|tenant-alpha|model-alpha|tool-alpha)\b/i;
  for (const file of coreFiles) {
    const root = file.startsWith("src/") ? storageServiceRoot : repoRoot;
    assert.doesNotMatch(readText(root, file), productSpecific, `${file} leaks product-specific policy text`);
  }
});
