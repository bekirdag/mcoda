import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  validateCodaliStorageFeedbackRecord,
  validateCodaliStorageReviewRecord,
  type CodaliStorageCandidateRecordRef,
  type CodaliStorageDatasetRecord,
  type CodaliStorageFeedbackRecord,
  type CodaliStorageFeedbackSource,
  type CodaliStoragePrivacyMetadata,
  type CodaliStorageProductScope,
  type CodaliStorageRecordType,
  type CodaliStorageRequesterScope,
  type CodaliStorageReviewDecision,
  type CodaliStorageReviewerType,
  type CodaliStorageReviewPromotionTarget,
  type CodaliStorageReviewRecord,
  type CodaliStorageValidationIssue,
} from "./CodaliStorageContracts.js";

export class CodaliFeedbackReviewIngestionError extends Error {
  constructor(
    message: string,
    readonly issues: CodaliStorageValidationIssue[],
  ) {
    super(message);
    this.name = "CodaliFeedbackReviewIngestionError";
  }
}

export type CodaliFeedbackReviewRequesterScopeInput =
  Omit<CodaliStorageRequesterScope, "visibility" | "tenantWide"> &
  Partial<Pick<CodaliStorageRequesterScope, "visibility" | "tenantWide">>;

export interface CodaliFeedbackReviewScopeInput {
  runId: string;
  deletionGroupId?: string;
  productScope: CodaliStorageProductScope;
  requesterScope: CodaliFeedbackReviewRequesterScopeInput;
  candidateRecords: CodaliStorageCandidateRecordRef[];
  privacy?: Partial<CodaliStoragePrivacyMetadata>;
  metadata?: Record<string, unknown>;
}

export interface BuildCodaliStorageFeedbackRecordInput
  extends CodaliFeedbackReviewScopeInput {
  feedbackId: string;
  createdAt?: string;
  source: CodaliStorageFeedbackSource;
  targetType: CodaliStorageRecordType;
  targetId: string;
  rating?: number;
  comment?: string;
  labels?: string[];
}

export interface BuildCodaliStorageReviewRecordInput
  extends CodaliFeedbackReviewScopeInput {
  reviewId: string;
  createdAt?: string;
  reviewerType: CodaliStorageReviewerType;
  reviewerId?: string;
  targetType: CodaliStorageRecordType;
  targetId: string;
  decision: CodaliStorageReviewDecision;
  reasons?: string[];
  labels?: string[];
  promotionTarget?: CodaliStorageReviewPromotionTarget;
  promotedRecordIds?: string[];
}

export interface ApplyCodaliStorageReviewPromotionInput {
  review: CodaliStorageReviewRecord;
  records: CodaliStorageDatasetRecord[];
  reviewedAt?: string;
}

export const createCodaliFeedbackReviewLocalOnlyPrivacy = (
  overrides: Partial<CodaliStoragePrivacyMetadata> = {},
): CodaliStoragePrivacyMetadata => ({
  schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  classification: overrides.classification ?? "internal",
  containsPersonalData: overrides.containsPersonalData ?? false,
  redactionStatus: overrides.redactionStatus ?? "not_required",
  uploadAllowed: overrides.uploadAllowed ?? false,
  exportAllowed: overrides.exportAllowed ?? false,
  trainingAllowed: overrides.trainingAllowed ?? false,
  ...(overrides.policyTags ? { policyTags: overrides.policyTags } : {}),
  ...(overrides.retentionUntil ? { retentionUntil: overrides.retentionUntil } : {}),
  ...(overrides.deletionRequestedAt ? { deletionRequestedAt: overrides.deletionRequestedAt } : {}),
  ...(overrides.redactionSummary ? { redactionSummary: overrides.redactionSummary } : {}),
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
});

export const defaultCodaliStorageReviewPromotionTarget = (
  decision: CodaliStorageReviewDecision,
): CodaliStorageReviewPromotionTarget => {
  if (decision === "approved") return "gold";
  if (decision === "rejected") return "reject";
  return "silver";
};

export const normalizeCodaliFeedbackReviewRequesterScope = (
  requesterScope: CodaliFeedbackReviewRequesterScopeInput,
): CodaliStorageRequesterScope => ({
  ...requesterScope,
  visibility: requesterScope.visibility ?? "requester",
  tenantWide: requesterScope.tenantWide ?? false,
});

export const buildCodaliStorageFeedbackRecord = (
  input: BuildCodaliStorageFeedbackRecordInput,
): CodaliStorageFeedbackRecord => {
  const record: CodaliStorageFeedbackRecord = {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    recordType: "feedback_record",
    feedbackId: input.feedbackId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: input.source,
    runId: input.runId,
    deletionGroupId: input.deletionGroupId ?? `delete-group-${input.runId}`,
    productScope: input.productScope,
    requesterScope: normalizeCodaliFeedbackReviewRequesterScope(input.requesterScope),
    candidateRecords: input.candidateRecords,
    targetType: input.targetType,
    targetId: input.targetId,
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    privacy: createCodaliFeedbackReviewLocalOnlyPrivacy(input.privacy),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const result = validateCodaliStorageFeedbackRecord(record);
  if (!result.ok) {
    throw new CodaliFeedbackReviewIngestionError("Invalid Codali feedback record.", result.issues);
  }
  return result.value;
};

export const buildCodaliStorageReviewRecord = (
  input: BuildCodaliStorageReviewRecordInput,
): CodaliStorageReviewRecord => {
  const promotionTarget =
    input.promotionTarget ?? defaultCodaliStorageReviewPromotionTarget(input.decision);
  const record: CodaliStorageReviewRecord = {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    recordType: "review_record",
    reviewId: input.reviewId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    reviewerType: input.reviewerType,
    ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
    runId: input.runId,
    deletionGroupId: input.deletionGroupId ?? `delete-group-${input.runId}`,
    productScope: input.productScope,
    requesterScope: normalizeCodaliFeedbackReviewRequesterScope(input.requesterScope),
    candidateRecords: input.candidateRecords,
    targetType: input.targetType,
    targetId: input.targetId,
    decision: input.decision,
    ...(input.reasons ? { reasons: input.reasons } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    promotionTarget,
    ...(input.promotedRecordIds ? { promotedRecordIds: input.promotedRecordIds } : {}),
    privacy: createCodaliFeedbackReviewLocalOnlyPrivacy(input.privacy),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const result = validateCodaliStorageReviewRecord(record);
  if (!result.ok) {
    throw new CodaliFeedbackReviewIngestionError("Invalid Codali review record.", result.issues);
  }
  return result.value;
};

export const applyCodaliStorageReviewPromotion = (
  input: ApplyCodaliStorageReviewPromotionInput,
): CodaliStorageDatasetRecord[] => {
  const promotionTarget =
    input.review.promotionTarget ??
    defaultCodaliStorageReviewPromotionTarget(input.review.decision);
  const promotedIds = new Set(
    (input.review.promotedRecordIds?.length
      ? input.review.promotedRecordIds
      : input.review.candidateRecords
          .filter((candidate) => candidate.recordType === "dataset_record")
          .map((candidate) => candidate.recordId)
    ),
  );
  const reviewLabels = uniqueStrings([
    ...(input.review.labels ?? []),
    `review:${input.review.decision}`,
    `review:${promotionTarget}`,
  ]);
  const reviewedAt = input.reviewedAt ?? input.review.createdAt;

  return input.records.map((record) => {
    if (!promotedIds.has(record.recordId)) return record;
    const labels = uniqueStrings([
      ...(record.quality?.labels ?? []),
      ...reviewLabels,
    ]);
    return {
      ...record,
      quality: {
        ...(record.quality ?? {}),
        score: promotedQualityScore(promotionTarget, record.quality?.score),
        labels,
        reviewed: true,
      },
      metadata: {
        ...(record.metadata ?? {}),
        reviewId: input.review.reviewId,
        reviewRunId: input.review.runId,
        reviewDecision: input.review.decision,
        reviewPromotionTarget: promotionTarget,
        reviewLabels,
        reviewReasons: input.review.reasons ?? [],
        reviewDeletionGroupId: input.review.deletionGroupId,
        rawTraceIncluded: false,
        reviewedAt,
      },
    };
  });
};

const promotedQualityScore = (
  promotionTarget: CodaliStorageReviewPromotionTarget,
  existingScore: number | undefined,
): number => {
  if (promotionTarget === "reject") return 0;
  const floor = promotionTarget === "gold" ? 0.95 : 0.7;
  return Math.max(existingScore ?? 0, floor);
};

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));
