import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodaliStorageReviewPromotion,
  buildCodaliStorageFeedbackRecord,
  buildCodaliStorageReviewRecord,
  CodaliFeedbackReviewIngestionError,
} from "../CodaliFeedbackReviewIngestion.js";
import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  type CodaliStorageCandidateRecordRef,
  type CodaliStorageDatasetRecord,
  type CodaliStorageObjectRef,
  type CodaliStorageProductScope,
} from "../CodaliStorageContracts.js";

const productScope: CodaliStorageProductScope = {
  productId: "product-alpha",
  tenantHash: "tenant-scope-hash",
  deploymentId: "deployment-local",
  environment: "test",
};

const candidateRecords: CodaliStorageCandidateRecordRef[] = [
  {
    recordType: "dataset_record",
    recordId: "dataset-answer-001",
    datasetKind: "gateway_answer",
    role: "answer_candidate",
  },
];

const requesterScope = {
  requesterHash: "requester-scope-hash",
  conversationHash: "conversation-scope-hash",
  requesterType: "staff",
};

const objectRef = (refId: string): CodaliStorageObjectRef => ({
  schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  refId,
  kind: "payload",
  contentHash: `sha256:${"1".repeat(64)}`,
  byteSize: 64,
  mimeType: "application/json",
  privacyFlags: {
    containsPersonalData: false,
    containsSecrets: false,
    containsTenantPrivateData: true,
    containsSourceCode: false,
    containsCustomerData: false,
    trainingAllowed: false,
    evalAllowed: true,
    replayAllowed: false,
    exportAllowed: false,
  },
  ownerScope: {
    tenantHash: "tenant-scope-hash",
    productId: "product-alpha",
    runId: "run-feedback-001",
    ownerType: "dataset_record",
    ownerId: refId,
  },
  deletionGroupId: "delete-group-run-feedback-001",
  retentionClass: "standard",
});

test("builds requester-scoped local-only feedback records", () => {
  const feedback = buildCodaliStorageFeedbackRecord({
    feedbackId: "feedback-001",
    createdAt: "2026-07-06T10:00:00.000Z",
    source: "user",
    runId: "run-feedback-001",
    productScope,
    requesterScope,
    candidateRecords,
    targetType: "dataset_record",
    targetId: "dataset-answer-001",
    rating: 1,
    labels: ["helpful"],
  });

  assert.equal(feedback.deletionGroupId, "delete-group-run-feedback-001");
  assert.equal(feedback.productScope.productId, "product-alpha");
  assert.equal(feedback.requesterScope.visibility, "requester");
  assert.equal(feedback.requesterScope.tenantWide, false);
  assert.equal(feedback.candidateRecords[0]?.recordId, "dataset-answer-001");
  assert.equal(feedback.privacy.uploadAllowed, false);
  assert.equal(feedback.privacy.exportAllowed, false);
  assert.equal(feedback.privacy.trainingAllowed, false);
});

test("rejects tenant-wide feedback scope without explicit allowance", () => {
  assert.throws(
    () =>
      buildCodaliStorageFeedbackRecord({
        feedbackId: "feedback-tenant-wide",
        source: "user",
        runId: "run-feedback-001",
        productScope,
        requesterScope: {
          ...requesterScope,
          visibility: "tenant",
          tenantWide: false,
        },
        candidateRecords,
        targetType: "dataset_record",
        targetId: "dataset-answer-001",
      }),
    (error) =>
      error instanceof CodaliFeedbackReviewIngestionError &&
      error.issues.some(
        (issue) => issue.code === "tenant_wide_scope_requires_explicit_allowance",
      ),
  );
});

test("maps review decisions to default promotion targets", () => {
  const approved = buildCodaliStorageReviewRecord({
    reviewId: "review-approved",
    reviewerType: "human",
    runId: "run-feedback-001",
    productScope,
    requesterScope,
    candidateRecords,
    targetType: "dataset_record",
    targetId: "dataset-answer-001",
    decision: "approved",
  });
  const rejected = buildCodaliStorageReviewRecord({
    reviewId: "review-rejected",
    reviewerType: "human",
    runId: "run-feedback-001",
    productScope,
    requesterScope,
    candidateRecords,
    targetType: "dataset_record",
    targetId: "dataset-answer-001",
    decision: "rejected",
  });
  const needsChanges = buildCodaliStorageReviewRecord({
    reviewId: "review-needs-changes",
    reviewerType: "human",
    runId: "run-feedback-001",
    productScope,
    requesterScope,
    candidateRecords,
    targetType: "dataset_record",
    targetId: "dataset-answer-001",
    decision: "needs_changes",
  });

  assert.equal(approved.promotionTarget, "gold");
  assert.equal(rejected.promotionTarget, "reject");
  assert.equal(needsChanges.promotionTarget, "silver");
});

test("promotes review labels without exposing raw trace data", () => {
  const review = buildCodaliStorageReviewRecord({
    reviewId: "review-gold-001",
    createdAt: "2026-07-06T11:00:00.000Z",
    reviewerType: "human",
    reviewerId: "reviewer-scope-hash",
    runId: "run-feedback-001",
    productScope,
    requesterScope,
    candidateRecords,
    targetType: "dataset_record",
    targetId: "dataset-answer-001",
    decision: "approved",
    labels: ["grounded_answer"],
    reasons: ["matches cited evidence"],
    promotedRecordIds: ["dataset-answer-001"],
  });
  const datasetRecord: CodaliStorageDatasetRecord = {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    recordType: "dataset_record",
    recordId: "dataset-answer-001",
    datasetKind: "gateway_answer",
    createdAt: "2026-07-06T10:00:00.000Z",
    sourceGatewayRecordId: "gateway-record-001",
    inputRef: objectRef("obj-input-001"),
    outputRef: objectRef("obj-output-001"),
    quality: {
      score: 0.4,
      labels: ["candidate"],
      reviewed: false,
    },
    privacy: {
      schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      classification: "internal",
      containsPersonalData: false,
      redactionStatus: "not_required",
      uploadAllowed: false,
      exportAllowed: false,
      trainingAllowed: false,
    },
    metadata: {
      rawTraceRef: "trace-ref-kept-out-of-promotion",
    },
  };

  const [promoted] = applyCodaliStorageReviewPromotion({
    review,
    records: [datasetRecord],
    reviewedAt: "2026-07-06T11:05:00.000Z",
  });

  assert.equal(promoted.quality?.reviewed, true);
  assert.equal(promoted.quality?.score, 0.95);
  assert.deepEqual(promoted.quality?.labels, [
    "candidate",
    "grounded_answer",
    "review:approved",
    "review:gold",
  ]);
  assert.equal(promoted.metadata?.reviewId, "review-gold-001");
  assert.equal(promoted.metadata?.reviewPromotionTarget, "gold");
  assert.equal(promoted.metadata?.rawTraceIncluded, false);
  assert.equal(Object.prototype.hasOwnProperty.call(promoted.metadata ?? {}, "rawTrace"), false);
});
