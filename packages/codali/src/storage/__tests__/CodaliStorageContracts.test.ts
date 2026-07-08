import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODALI_STORAGE_CONTRACT_DISTRIBUTION,
  CODALI_STORAGE_CONTRACT_JSON_SCHEMAS,
  CODALI_STORAGE_CONTRACT_MIN_COMPATIBLE_SCHEMA_VERSION,
  CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY,
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS,
  isCodaliStoragePrivacyTrainingAllowed,
  isCodaliStorageRecordExportAllowed,
  validateCodaliStorageContractFixtureSet,
  validateCodaliStorageExportManifest,
  validateCodaliStorageFeedbackRecord,
  validateCodaliStorageGatewayRecord,
  validateCodaliStorageImprovementRecord,
  validateCodaliStorageObjectRef,
  validateCodaliStoragePrivacyMetadata,
  validateCodaliStorageRecord,
  validateCodaliStorageReviewRecord,
} from "../CodaliStorageContracts.js";

const findRepoRoot = (start: string): string => {
  let current = start;
  for (;;) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    assert.notEqual(parent, current, "Could not locate repo root");
    current = parent;
  }
};

const loadFixturePayload = (): unknown => {
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const fixturePath = path.join(
    repoRoot,
    "docs/contracts/codali-storage/v1/contract-fixtures.json",
  );
  return JSON.parse(readFileSync(fixturePath, "utf8"));
};

test("validates shared codali storage contract fixtures", () => {
  const result = validateCodaliStorageContractFixtureSet(loadFixturePayload());

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.value.schemaVersion, "codali.storage.fixtures.v1");
  assert.equal(result.value.contractSchemaVersion, CODALI_STORAGE_CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(result.value.distribution, CODALI_STORAGE_CONTRACT_DISTRIBUTION);
  assert.equal(result.value.fixtures.gatewayRecord.runId, "run-001");
  assert.equal(result.value.fixtures.gatewayRecord.answerRef?.refId, "obj-gateway-answer-001");
  assert.equal(result.value.fixtures.datasetRecord.inputRef.refId, "obj-dataset-input-001");
  assert.equal(
    result.value.fixtures.objectRef.contentHash,
    "sha256:6f6b7c0a2fb8e6e43ab64a04b8930c88f8aadcdb71e9f3c3a7fd6a7fb9f5d001",
  );
  assert.equal(result.value.fixtures.objectRef.byteSize, 512);
  assert.equal(result.value.fixtures.objectRef.mimeType, "application/json");
  assert.equal(result.value.fixtures.objectRef.privacyFlags.trainingAllowed, false);
  assert.equal(result.value.fixtures.objectRef.privacyFlags.evalAllowed, true);
  assert.equal(result.value.fixtures.objectRef.ownerScope.tenantHash, "scope_hash_fixture");
  assert.equal(result.value.fixtures.objectRef.ownerScope.ownerType, "gateway_record");
  assert.equal(result.value.fixtures.objectRef.deletionGroupId, "delete-group-run-001");
  assert.equal(result.value.fixtures.objectRef.retentionClass, "standard");
  assert.equal(result.value.fixtures.feedbackRecord.runId, "run-001");
  assert.equal(result.value.fixtures.feedbackRecord.deletionGroupId, "delete-group-run-001");
  assert.equal(result.value.fixtures.feedbackRecord.productScope.productId, "product-alpha");
  assert.equal(result.value.fixtures.feedbackRecord.requesterScope.visibility, "requester");
  assert.equal(result.value.fixtures.feedbackRecord.requesterScope.tenantWide, false);
  assert.equal(result.value.fixtures.feedbackRecord.candidateRecords[0]?.recordId, "dataset-001");
  assert.equal(result.value.fixtures.reviewRecord.promotionTarget, "gold");
  assert.deepEqual(result.value.fixtures.reviewRecord.promotedRecordIds, ["dataset-001"]);
  assert.equal(result.value.fixtures.privacyMetadata.uploadAllowed, false);
  assert.equal(isCodaliStorageRecordExportAllowed(result.value.fixtures.datasetRecord), true);
  assert.equal(isCodaliStoragePrivacyTrainingAllowed(result.value.fixtures.privacyMetadata), false);
});

test("exposes json schema metadata with explicit versions and required fields", () => {
  const gatewaySchemaVersionProperty = CODALI_STORAGE_CONTRACT_JSON_SCHEMAS
    .gatewayRecord.properties.schema_version as { const: string };
  const privacySchemaVersionProperty = CODALI_STORAGE_CONTRACT_JSON_SCHEMAS
    .privacyMetadata.properties.schema_version as { const: string };

  assert.deepEqual(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.gatewayRecord.properties.schema_version,
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.privacyMetadata.properties.schema_version,
  );
  assert.deepEqual(CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY, {
    current: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    minCompatible: CODALI_STORAGE_CONTRACT_MIN_COMPATIBLE_SCHEMA_VERSION,
    supported: CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS,
    fixture: "codali.storage.fixtures.v1",
  });
  assert.equal(
    gatewaySchemaVersionProperty.const,
    CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  );
  assert.equal(
    privacySchemaVersionProperty.const,
    CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.gatewayRecord.required.includes("schema_version"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.datasetRecord.required.includes("privacy"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.improvementRecord.required.includes(
      "training_eligible",
    ),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.feedbackRecord.required.includes("requester_scope"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.feedbackRecord.required.includes("candidate_records"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.reviewRecord.required.includes("product_scope"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.reviewRecord.required.includes("deletion_group_id"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.objectRef.required.includes("content_hash"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.objectRef.required.includes("privacy_flags"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.objectRef.required.includes("owner_scope"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.objectRef.required.includes("deletion_group_id"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.objectRef.required.includes("retention_class"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.exportManifest.required.includes("artifact_refs"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.exportManifest.required.includes("checksum"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.exportManifest.required.includes("privacy_summary"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.exportManifest.required.includes("lineage"),
    true,
  );
  assert.equal(
    CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.exportManifest.required.includes("deletion_group_snapshot"),
    true,
  );
});

test("normalizes camelCase internal structures from the same contract payloads", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageGatewayRecord({
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    recordType: "gateway_record",
    recordId: "gwrec-camel-001",
    runId: "run-camel-001",
    createdAt: "2026-07-02T10:07:00.000Z",
    status: "succeeded",
    query: "Check camelCase compatibility.",
    answerRef: fixtureSet.value.fixtures.objectRef,
    privacy: fixtureSet.value.fixtures.privacyMetadata,
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.value.schemaVersion, CODALI_STORAGE_CONTRACT_SCHEMA_VERSION);
  assert.equal(result.value.answerRef?.refId, "obj-gateway-answer-001");
});

test("dispatches versioned records by snake_case record_type", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageRecord({
    ...fixtureSet.value.fixtures.feedbackRecord,
    record_type: "feedback_record",
    target_type: "dataset_record",
    target_id: "dataset-001",
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.value.recordType, "feedback_record");
});

test("links feedback and review records to run, deletion group, scopes, and candidates", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const feedback = validateCodaliStorageFeedbackRecord(fixtureSet.value.fixtures.feedbackRecord);
  const review = validateCodaliStorageReviewRecord(fixtureSet.value.fixtures.reviewRecord);

  assert.equal(feedback.ok, true, JSON.stringify(feedback.issues, null, 2));
  assert.equal(review.ok, true, JSON.stringify(review.issues, null, 2));
  assert.equal(feedback.value.runId, "run-001");
  assert.equal(feedback.value.productScope.tenantHash, "scope_hash_fixture");
  assert.equal(feedback.value.requesterScope.requesterType, "employee");
  assert.equal(feedback.value.candidateRecords[0]?.datasetKind, "gateway_answer");
  assert.equal(review.value.promotionTarget, "gold");
  assert.deepEqual(review.value.labels, ["grounded_answer", "safe_for_eval"]);
});

test("prevents requester feedback from becoming tenant-wide by omission", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageFeedbackRecord({
    ...fixtureSet.value.fixtures.feedbackRecord,
    requesterScope: {
      ...fixtureSet.value.fixtures.feedbackRecord.requesterScope,
      visibility: "tenant",
      tenantWide: false,
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "tenant_wide_scope_requires_explicit_allowance",
    ),
  );
});

test("requires feedback targets to be present in candidate records", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageReviewRecord({
    ...fixtureSet.value.fixtures.reviewRecord,
    targetId: "dataset-missing",
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "target_not_in_candidate_records"),
  );
});

test("rejects unsupported schema versions", () => {
  const result = validateCodaliStoragePrivacyMetadata({
    schema_version: "codali.storage.v0",
    classification: "internal",
    contains_personal_data: false,
    redaction_status: "not_required",
    upload_allowed: false,
    export_allowed: false,
    training_allowed: false,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "unsupported_schema_version"),
  );
});

test("rejects object refs without a location hint", () => {
  const result = validateCodaliStorageObjectRef({
    schema_version: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    ref_id: "obj-missing-location",
    kind: "payload",
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    byte_size: 1,
    mime_type: "application/json",
    privacy_flags: {
      contains_personal_data: false,
      contains_secrets: false,
      contains_tenant_private_data: false,
      contains_source_code: false,
      contains_customer_data: false,
      training_allowed: false,
      eval_allowed: true,
      replay_allowed: true,
      export_allowed: false,
    },
    owner_scope: {
      tenant_hash: "scope_hash_fixture",
      product_id: "product-alpha",
      owner_type: "test",
      owner_id: "obj-missing-location",
    },
    deletion_group_id: "delete-group-test",
    retention_class: "standard",
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "object_location_required"));
});

test("requires phase 4 object metadata on every object ref", () => {
  const result = validateCodaliStorageObjectRef({
    schema_version: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    ref_id: "obj-missing-phase4-metadata",
    kind: "payload",
    uri: "local://codali-storage/objects/obj-missing-phase4-metadata.json",
    content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    byte_size: 1,
    mime_type: "application/json",
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.privacyFlags"));
  assert.ok(result.issues.some((issue) => issue.path === "$.ownerScope"));
  assert.ok(result.issues.some((issue) => issue.path === "$.deletionGroupId"));
  assert.ok(result.issues.some((issue) => issue.path === "$.retentionClass"));
});

test("rejects object refs marked do_not_store", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageObjectRef({
    ...fixtureSet.value.fixtures.objectRef,
    retentionClass: "do_not_store",
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "object_ref_do_not_store"));
});

test("rejects export manifest count mismatches", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageExportManifest({
    ...fixtureSet.value.fixtures.exportManifest,
    recordCount: 99,
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "record_count_mismatch"));
});

test("rejects unsupported export manifest kinds", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageExportManifest({
    ...fixtureSet.value.fixtures.exportManifest,
    exportKind: "unsupported-kind",
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.exportKind"));
});

test("requires export manifests to include reproducibility audit fields", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);
  const requiredFields = [
    ["artifactRefs", "$.artifactRefs"],
    ["checksum", "$.checksum"],
    ["privacySummary", "$.privacySummary"],
    ["lineage", "$.lineage"],
    ["deletionGroupSnapshot", "$.deletionGroupSnapshot"],
  ] as const;

  for (const [field, path] of requiredFields) {
    const manifest: Record<string, unknown> = {
      ...fixtureSet.value.fixtures.exportManifest,
    };
    delete manifest[field];
    const result = validateCodaliStorageExportManifest(manifest);

    assert.equal(result.ok, false, `expected ${field} to be required`);
    assert.ok(
      result.issues.some((issue) => issue.path === path && issue.code === "required"),
      JSON.stringify(result.issues, null, 2),
    );
  }
});

test("rejects export manifests with inconsistent reproducibility metadata", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);
  const manifest = fixtureSet.value.fixtures.exportManifest;

  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      checksum: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    }).issues.some((issue) => issue.code === "checksum_not_in_artifact_refs"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      privacySummary: {
        ...manifest.privacySummary,
        recordCount: manifest.recordCount + 1,
      },
    }).issues.some((issue) => issue.path === "$.privacySummary.recordCount"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      lineage: {
        ...manifest.lineage,
        exportKind: "eval-replay",
      },
    }).issues.some((issue) => issue.code === "export_kind_mismatch"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      lineage: {
        ...manifest.lineage,
        sourceRecordIds: ["dataset-001"],
      },
    }).issues.some((issue) => issue.code === "lineage_missing_record_id"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      lineage: {
        ...manifest.lineage,
        sourceObjectHashes: [],
      },
    }).issues.some((issue) => issue.code === "lineage_missing_object_hash"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      records: manifest.records.map((record, index) =>
        index === 0
          ? {
              recordType: record.recordType,
              recordId: record.recordId,
              schemaVersion: record.schemaVersion,
            }
          : record,
      ),
    }).issues.some((issue) => issue.code === "manifest_record_object_ref_required"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      deletionGroupSnapshot: {
        ...manifest.deletionGroupSnapshot,
        byRecordId: {
          "dataset-001": ["delete-group-export-001"],
        },
      },
    }).issues.some((issue) => issue.code === "deletion_snapshot_missing_record_id"),
    true,
  );
  assert.equal(
    validateCodaliStorageExportManifest({
      ...manifest,
      records: manifest.records.map((record, index) =>
        index === 0 && record.objectRef
          ? {
              ...record,
              objectRef: {
                ...record.objectRef,
                deletionGroupId: "delete-group-not-snapshotted",
              },
            }
          : record,
      ),
    }).issues.some((issue) => issue.code === "deletion_snapshot_missing_object_group"),
    true,
  );
});

test("requires redaction before personal data can be uploaded, exported, or trained", () => {
  const result = validateCodaliStoragePrivacyMetadata({
    schema_version: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    classification: "confidential",
    contains_personal_data: true,
    redaction_status: "pending",
    upload_allowed: true,
    export_allowed: true,
    training_allowed: true,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "privacy_allowance_requires_redaction",
    ),
  );
});

test("rejects improvement training eligibility when privacy does not allow training", () => {
  const fixtureSet = validateCodaliStorageContractFixtureSet(loadFixturePayload());
  assert.equal(fixtureSet.ok, true);

  const result = validateCodaliStorageImprovementRecord({
    ...fixtureSet.value.fixtures.improvementRecord,
    trainingEligible: true,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "training_not_allowed_by_privacy"),
  );
});
