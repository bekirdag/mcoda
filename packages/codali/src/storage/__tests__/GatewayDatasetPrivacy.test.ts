import assert from "node:assert/strict";
import test from "node:test";
import {
  CodaliDatasetPrivacyError,
  applyCodaliDatasetPolicyOverride,
  assertCodaliDatasetDurablePersistenceAllowed,
  evaluateCodaliDatasetDurablePersistence,
  evaluateCodaliDatasetObjectPayloadRead,
  generateCodaliDatasetPrivacyMetadata,
  hashCodaliDatasetIdentifiers,
  readCodaliDatasetObjectPayload,
} from "../CodaliDatasetPrivacyEngine.js";
import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  type CodaliStorageObjectRef,
  type CodaliStoragePrivacyMetadata,
} from "../CodaliStorageContracts.js";

const tenant = { tenantId: "tenant-alpha", tenantSalt: "tenant-alpha-salt" };

const buildPrivacy = (
  overrides: Partial<CodaliStoragePrivacyMetadata> = {},
): CodaliStoragePrivacyMetadata => ({
  schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  classification: "internal",
  containsPersonalData: false,
  redactionStatus: "not_required",
  uploadAllowed: false,
  exportAllowed: true,
  trainingAllowed: true,
  ...overrides,
});

const buildObjectRef = (
  overrides: Partial<CodaliStorageObjectRef> = {},
): CodaliStorageObjectRef => ({
  schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  refId: "obj-privacy-test",
  kind: "payload",
  uri: "local://codali-storage/objects/obj-privacy-test.json",
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  byteSize: 128,
  mimeType: "application/json",
  privacyFlags: {
    containsPersonalData: false,
    containsSecrets: false,
    containsTenantPrivateData: false,
    containsSourceCode: false,
    containsCustomerData: false,
    trainingAllowed: true,
    evalAllowed: true,
    replayAllowed: true,
    exportAllowed: true,
    ...(overrides.privacyFlags ?? {}),
  },
  ownerScope: {
    tenantHash: "sha256:tenant-alpha",
    productId: "product-neutral",
    ownerType: "dataset_record",
    ownerId: "dataset-privacy-test",
    ...(overrides.ownerScope ?? {}),
  },
  deletionGroupId: "delete-group-alpha",
  retentionClass: "dataset",
  ...overrides,
});

test("GatewayDatasetPrivacy redacts secrets and denies training/export eligibility", () => {
  const envelope = generateCodaliDatasetPrivacyMetadata({
    tenant,
    identifiers: {
      requesterId: "requester-1",
      conversationId: "conversation-1",
      repoId: "repo-1",
      sourceId: "source-1",
      reviewerId: "reviewer-1",
      deletionGroupId: "delete-group-1",
    },
    inputPayload: {
      prompt: "Summarize the attached trace.",
      apiKey: "local-secret-value",
    },
    outputPayload: {
      headers: {
        authorization: "Bearer verylongopaquecredential",
      },
    },
    allowances: {
      trainingAllowed: true,
      exportAllowed: true,
      evalAllowed: true,
      replayAllowed: true,
    },
    now: "2026-07-03T10:00:00.000Z",
  });

  const redacted = JSON.stringify(envelope.redactedPayloads);
  assert.match(redacted, /\[redacted\]/);
  assert.doesNotMatch(redacted, /local-secret-value/);
  assert.doesNotMatch(redacted, /verylongopaquecredential/);
  assert.equal(envelope.privacy.metadata?.containsSecrets, true);
  assert.equal(envelope.privacy.trainingAllowed, false);
  assert.equal(envelope.privacy.exportAllowed, false);
  assert.equal(envelope.privacyFlags.containsSecrets, true);
  assert.equal(envelope.privacyFlags.trainingAllowed, false);
  assert.equal(envelope.privacyFlags.exportAllowed, false);
  assert.equal(envelope.privacyFlags.evalAllowed, true);
  assert.equal(envelope.privacyFlags.replayAllowed, true);
  assert.equal(envelope.hashedIdentifiers.tenantHash.startsWith("sha256:"), true);
  assert.equal(envelope.privacy.schemaVersion, CODALI_STORAGE_CONTRACT_SCHEMA_VERSION);
  assert.ok(
    envelope.eligibility.blockers.some(
      (blocker) => blocker.code === "secrets_detected",
    ),
  );
});

test("GatewayDatasetPrivacy hashes identifiers stably inside a tenant and isolates tenants", () => {
  const identifiers = {
    requesterId: "requester-1",
    conversationId: "conversation-1",
    repoId: "repo-1",
    sourceId: "source-1",
    reviewerId: "reviewer-1",
    deletionGroupId: "delete-group-1",
  };
  const first = hashCodaliDatasetIdentifiers(tenant, identifiers);
  const second = hashCodaliDatasetIdentifiers(tenant, identifiers);
  const otherTenant = hashCodaliDatasetIdentifiers(
    { tenantId: "tenant-beta", tenantSalt: "tenant-alpha-salt" },
    identifiers,
  );

  assert.deepEqual(first, second);
  assert.notEqual(first.tenantHash, otherTenant.tenantHash);
  assert.notEqual(first.requesterHash, otherTenant.requesterHash);
  assert.notEqual(first.conversationHash, otherTenant.conversationHash);
  assert.notEqual(first.repoHash, otherTenant.repoHash);
  assert.notEqual(first.sourceHash, otherTenant.sourceHash);
  assert.notEqual(first.reviewerHash, otherTenant.reviewerHash);
  assert.notEqual(first.deletionGroupHash, otherTenant.deletionGroupHash);
});

test("GatewayDatasetPrivacy enforces training and export flags before object payload reads", async () => {
  let readCount = 0;
  const trainingResult = await readCodaliDatasetObjectPayload({
    purpose: "training",
    objectRef: buildObjectRef({
      privacyFlags: {
        containsPersonalData: false,
        containsSecrets: false,
        containsTenantPrivateData: false,
        containsSourceCode: false,
        containsCustomerData: false,
        trainingAllowed: false,
        evalAllowed: true,
        replayAllowed: true,
        exportAllowed: true,
      },
    }),
    privacy: buildPrivacy({ trainingAllowed: true }),
    readPayload: () => {
      readCount += 1;
      return { shouldNotRead: true };
    },
  });

  assert.equal(trainingResult.ok, false);
  assert.equal(readCount, 0);
  assert.ok(
    trainingResult.decision.blockers.some(
      (blocker) => blocker.code === "object_training_not_allowed",
    ),
  );

  const exportResult = await readCodaliDatasetObjectPayload({
    purpose: "export",
    objectRef: buildObjectRef(),
    privacy: buildPrivacy({ exportAllowed: false }),
    readPayload: () => {
      readCount += 1;
      return { shouldNotRead: true };
    },
  });

  assert.equal(exportResult.ok, false);
  assert.equal(readCount, 0);
  assert.ok(
    exportResult.decision.blockers.some(
      (blocker) => blocker.code === "privacy_export_not_allowed",
    ),
  );
});

test("GatewayDatasetPrivacy rejects durable persistence for do_not_store", () => {
  const decision = evaluateCodaliDatasetDurablePersistence("do_not_store");

  assert.equal(decision.allowed, false);
  assert.ok(
    decision.blockers.some(
      (blocker) => blocker.code === "retention_do_not_store",
    ),
  );
  assert.throws(
    () => assertCodaliDatasetDurablePersistenceAllowed("do_not_store"),
    CodaliDatasetPrivacyError,
  );
});

test("GatewayDatasetPrivacy requires admin audit for policy overrides", () => {
  const blockedEval = evaluateCodaliDatasetObjectPayloadRead(
    "eval",
    buildObjectRef({
      privacyFlags: {
        containsPersonalData: false,
        containsSecrets: false,
        containsTenantPrivateData: false,
        containsSourceCode: false,
        containsCustomerData: false,
        trainingAllowed: true,
        evalAllowed: false,
        replayAllowed: true,
        exportAllowed: true,
      },
    }),
    buildPrivacy(),
  );

  const missingAudit = applyCodaliDatasetPolicyOverride(blockedEval, {
    purpose: "eval",
    allow: true,
    adminActorId: "admin-1",
    reason: "Approved for a deterministic replay test.",
  });
  assert.equal(missingAudit.allowed, false);
  assert.ok(
    missingAudit.blockers.some(
      (blocker) => blocker.code === "policy_override_requires_admin_audit",
    ),
  );

  const approved = applyCodaliDatasetPolicyOverride(blockedEval, {
    purpose: "eval",
    allow: true,
    adminActorId: "admin-1",
    auditEventId: "audit-1",
    reason: "Approved for a deterministic replay test.",
    approvedAt: "2026-07-03T10:00:00.000Z",
  });
  assert.equal(approved.allowed, true);
  assert.deepEqual(approved.auditEvents?.[0]?.originalBlockers, [
    "object_eval_not_allowed",
  ]);

  const secretExport = evaluateCodaliDatasetObjectPayloadRead(
    "export",
    buildObjectRef({
      privacyFlags: {
        containsPersonalData: false,
        containsSecrets: true,
        containsTenantPrivateData: false,
        containsSourceCode: false,
        containsCustomerData: false,
        trainingAllowed: true,
        evalAllowed: true,
        replayAllowed: true,
        exportAllowed: true,
      },
    }),
    buildPrivacy({ metadata: { containsSecrets: true } }),
  );
  const secretOverride = applyCodaliDatasetPolicyOverride(secretExport, {
    purpose: "export",
    allow: true,
    adminActorId: "admin-1",
    auditEventId: "audit-2",
    reason: "Attempt to override secret export.",
  });

  assert.equal(secretOverride.allowed, false);
  assert.ok(
    secretOverride.blockers.some(
      (blocker) => blocker.code === "policy_override_hard_blocked",
    ),
  );
});
