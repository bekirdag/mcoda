export const CODALI_STORAGE_CONTRACT_SCHEMA_VERSION = "codali.storage.v1" as const;

export const CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS = [
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
] as const;

export const CODALI_STORAGE_CONTRACT_MIN_COMPATIBLE_SCHEMA_VERSION =
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION;

export const CODALI_STORAGE_CONTRACT_FIXTURE_SCHEMA_VERSION =
  "codali.storage.fixtures.v1" as const;

export const CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY = {
  current: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  minCompatible: CODALI_STORAGE_CONTRACT_MIN_COMPATIBLE_SCHEMA_VERSION,
  supported: CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS,
  fixture: CODALI_STORAGE_CONTRACT_FIXTURE_SCHEMA_VERSION,
} as const;

export const CODALI_STORAGE_CONTRACT_DISTRIBUTION = {
  mode: "published_package",
  packageName: "@mcoda/codali",
  modulePath: "@mcoda/codali",
  sourcePath: "packages/codali/src/storage/CodaliStorageContracts.ts",
  fixturePath: "docs/contracts/codali-storage/v1/contract-fixtures.json",
} as const;

export type CodaliStorageSchemaVersion =
  (typeof CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS)[number];

export type CodaliStorageContractDistribution =
  typeof CODALI_STORAGE_CONTRACT_DISTRIBUTION;

export type CodaliStorageRecordType =
  | "gateway_record"
  | "dataset_record"
  | "export_manifest"
  | "feedback_record"
  | "review_record"
  | "improvement_record";

export type CodaliStoragePrivacyClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type CodaliStorageRedactionStatus =
  | "not_required"
  | "pending"
  | "redacted"
  | "blocked";

export type CodaliStorageObjectRefKind =
  | "payload"
  | "trace"
  | "artifact"
  | "dataset"
  | "export"
  | "evidence";

export type CodaliStorageObjectRetentionClass =
  | "transient"
  | "standard"
  | "dataset"
  | "legal_hold"
  | "do_not_store";

export type CodaliStorageGatewayStatus =
  | "succeeded"
  | "failed"
  | "partial"
  | "needs_clarification";

export type CodaliStorageDatasetKind =
  | "gateway_answer"
  | "tool_trace"
  | "model_call"
  | "evaluation"
  | "curated_example";

export type CodaliStorageExportFormat = "jsonl" | "json" | "parquet" | "bundle";

export type CodaliStorageExportKind =
  | "eval-replay"
  | "prompt-regression"
  | "extractor-sft"
  | "tool-router-sft"
  | "planner-sft"
  | "verifier-sft"
  | "query-expander-sft"
  | "repair-sft"
  | "context-refiner-sft"
  | "rag-reranker"
  | "model-router";

export type CodaliStorageFeedbackSource =
  | "user"
  | "operator"
  | "automated_eval";

export type CodaliStorageReviewDecision =
  | "approved"
  | "rejected"
  | "needs_changes"
  | "escalated";

export type CodaliStorageReviewerType = "human" | "automated";

export type CodaliStorageRequesterScopeVisibility =
  | "requester"
  | "conversation"
  | "product"
  | "tenant";

export type CodaliStorageReviewPromotionTarget = "gold" | "silver" | "reject";

export type CodaliStorageImprovementKind =
  | "prompt"
  | "policy"
  | "model_selection"
  | "tooling"
  | "evaluation"
  | "other";

export type CodaliStorageImprovementStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "applied";

export interface CodaliStorageValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type CodaliStorageValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: CodaliStorageValidationIssue[] };

export interface CodaliStoragePrivacyMetadata {
  schemaVersion: CodaliStorageSchemaVersion;
  classification: CodaliStoragePrivacyClassification;
  containsPersonalData: boolean;
  redactionStatus: CodaliStorageRedactionStatus;
  uploadAllowed: boolean;
  exportAllowed: boolean;
  trainingAllowed: boolean;
  policyTags?: string[];
  retentionUntil?: string;
  deletionRequestedAt?: string;
  redactionSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageObjectPrivacyFlags {
  containsPersonalData: boolean;
  containsSecrets: boolean;
  containsTenantPrivateData: boolean;
  containsSourceCode: boolean;
  containsCustomerData: boolean;
  trainingAllowed: boolean;
  evalAllowed: boolean;
  replayAllowed: boolean;
  exportAllowed: boolean;
}

export interface CodaliStorageObjectOwnerScope {
  tenantHash: string;
  productId: string;
  deploymentId?: string;
  runId?: string;
  ownerType: string;
  ownerId: string;
}

export interface CodaliStorageObjectRef {
  schemaVersion: CodaliStorageSchemaVersion;
  refId: string;
  kind: CodaliStorageObjectRefKind;
  uri?: string;
  bucket?: string;
  key?: string;
  contentHash: string;
  byteSize: number;
  mimeType: string;
  privacyFlags: CodaliStorageObjectPrivacyFlags;
  ownerScope: CodaliStorageObjectOwnerScope;
  ownerScopeHash?: string;
  deletionGroupId: string;
  retentionClass: CodaliStorageObjectRetentionClass;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageGatewayRecord {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "gateway_record";
  recordId: string;
  runId: string;
  createdAt: string;
  status: CodaliStorageGatewayStatus;
  query: string;
  answerSummary?: string;
  requestRef?: CodaliStorageObjectRef;
  responseRef?: CodaliStorageObjectRef;
  traceRef?: CodaliStorageObjectRef;
  answerRef?: CodaliStorageObjectRef;
  model?: {
    provider?: string;
    model?: string;
    agentId?: string;
    role?: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageDatasetRecord {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "dataset_record";
  recordId: string;
  datasetKind: CodaliStorageDatasetKind;
  createdAt: string;
  sourceGatewayRecordId?: string;
  inputRef: CodaliStorageObjectRef;
  outputRef?: CodaliStorageObjectRef;
  evidenceRefs?: CodaliStorageObjectRef[];
  quality?: {
    score?: number;
    labels?: string[];
    reviewed?: boolean;
  };
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageExportManifestRecordRef {
  recordType: CodaliStorageRecordType;
  recordId: string;
  schemaVersion: CodaliStorageSchemaVersion;
  objectRef?: CodaliStorageObjectRef;
}

export interface CodaliStorageExportPrivacySummary {
  recordCount: number;
  containsPersonalData: boolean;
  containsSecrets: boolean;
  containsTenantPrivateData: boolean;
  containsSourceCode: boolean;
  containsCustomerData: boolean;
  exportAllowedCount: number;
  trainingAllowedCount: number;
  evalAllowedCount: number;
  replayAllowedCount: number;
  classifications: Record<string, number>;
  redactionStatuses: Record<string, number>;
  policyTags?: string[];
}

export interface CodaliStorageExportLineage {
  exportKind: CodaliStorageExportKind;
  sourceRecordIds: string[];
  sourceGatewayRecordIds?: string[];
  sourceObjectHashes: string[];
  generatedBy?: string;
}

export interface CodaliStorageExportDeletionGroupSnapshot {
  capturedAt: string;
  deletionGroupIds: string[];
  byRecordId: Record<string, string[]>;
}

export interface CodaliStorageExportManifest {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "export_manifest";
  manifestId: string;
  createdAt: string;
  exportKind: CodaliStorageExportKind;
  exportFormat: CodaliStorageExportFormat;
  recordCount: number;
  records: CodaliStorageExportManifestRecordRef[];
  artifactRefs: CodaliStorageObjectRef[];
  checksum: string;
  privacySummary: CodaliStorageExportPrivacySummary;
  lineage: CodaliStorageExportLineage;
  deletionGroupSnapshot: CodaliStorageExportDeletionGroupSnapshot;
  generatedBy?: string;
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageProductScope {
  productId: string;
  tenantHash: string;
  deploymentId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageRequesterScope {
  requesterHash: string;
  conversationHash?: string;
  requesterType?: string;
  visibility: CodaliStorageRequesterScopeVisibility;
  tenantWide: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageCandidateRecordRef {
  recordType: CodaliStorageRecordType;
  recordId: string;
  datasetKind?: CodaliStorageDatasetKind;
  objectRef?: CodaliStorageObjectRef;
  labels?: string[];
  role?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageFeedbackRecord {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "feedback_record";
  feedbackId: string;
  createdAt: string;
  source: CodaliStorageFeedbackSource;
  runId: string;
  deletionGroupId: string;
  productScope: CodaliStorageProductScope;
  requesterScope: CodaliStorageRequesterScope;
  candidateRecords: CodaliStorageCandidateRecordRef[];
  targetType: CodaliStorageRecordType;
  targetId: string;
  rating?: number;
  comment?: string;
  labels?: string[];
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageReviewRecord {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "review_record";
  reviewId: string;
  createdAt: string;
  reviewerType: CodaliStorageReviewerType;
  reviewerId?: string;
  runId: string;
  deletionGroupId: string;
  productScope: CodaliStorageProductScope;
  requesterScope: CodaliStorageRequesterScope;
  candidateRecords: CodaliStorageCandidateRecordRef[];
  targetType: CodaliStorageRecordType;
  targetId: string;
  decision: CodaliStorageReviewDecision;
  reasons?: string[];
  labels?: string[];
  promotionTarget?: CodaliStorageReviewPromotionTarget;
  promotedRecordIds?: string[];
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export interface CodaliStorageImprovementRecord {
  schemaVersion: CodaliStorageSchemaVersion;
  recordType: "improvement_record";
  improvementId: string;
  createdAt: string;
  improvementKind: CodaliStorageImprovementKind;
  status: CodaliStorageImprovementStatus;
  summary: string;
  sourceRecordIds: string[];
  trainingEligible: boolean;
  exportManifestId?: string;
  candidateRef?: CodaliStorageObjectRef;
  privacy: CodaliStoragePrivacyMetadata;
  metadata?: Record<string, unknown>;
}

export type CodaliStorageRecord =
  | CodaliStorageGatewayRecord
  | CodaliStorageDatasetRecord
  | CodaliStorageExportManifest
  | CodaliStorageFeedbackRecord
  | CodaliStorageReviewRecord
  | CodaliStorageImprovementRecord;

export interface CodaliStorageContractFixtureSet {
  schemaVersion: typeof CODALI_STORAGE_CONTRACT_FIXTURE_SCHEMA_VERSION;
  contractSchemaVersion: CodaliStorageSchemaVersion;
  distribution: CodaliStorageContractDistribution;
  fixtures: {
    privacyMetadata: CodaliStoragePrivacyMetadata;
    objectRef: CodaliStorageObjectRef;
    gatewayRecord: CodaliStorageGatewayRecord;
    datasetRecord: CodaliStorageDatasetRecord;
    exportManifest: CodaliStorageExportManifest;
    feedbackRecord: CodaliStorageFeedbackRecord;
    reviewRecord: CodaliStorageReviewRecord;
    improvementRecord: CodaliStorageImprovementRecord;
  };
}

export type CodaliStorageContractJsonSchema = {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly $id: string;
  readonly title: string;
  readonly type: "object";
  readonly additionalProperties: true;
  readonly required: readonly string[];
  readonly properties: Record<string, unknown>;
};

export type CodaliStorageContractSchemaName =
  | "privacyMetadata"
  | "objectRef"
  | "gatewayRecord"
  | "datasetRecord"
  | "exportManifest"
  | "feedbackRecord"
  | "reviewRecord"
  | "improvementRecord";

const stringSchema = { type: "string" } as const;
const booleanSchema = { type: "boolean" } as const;
const integerSchema = { type: "integer", minimum: 0 } as const;
const numberSchema = { type: "number" } as const;

const schema = (
  name: CodaliStorageContractSchemaName,
  title: string,
  required: readonly string[],
  properties: Record<string, unknown>,
): CodaliStorageContractJsonSchema => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://mcoda.local/contracts/codali-storage/${CODALI_STORAGE_CONTRACT_SCHEMA_VERSION}/${name}.schema.json`,
  title,
  type: "object",
  additionalProperties: true,
  required,
  properties: {
    schema_version: {
      const: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
      description: "External payload schema version. Internal structures expose schemaVersion.",
    },
    ...properties,
  },
});

export const CODALI_STORAGE_CONTRACT_JSON_SCHEMAS = {
  privacyMetadata: schema(
    "privacyMetadata",
    "Codali storage privacy metadata",
    [
      "schema_version",
      "classification",
      "contains_personal_data",
      "redaction_status",
      "upload_allowed",
      "export_allowed",
      "training_allowed",
    ],
    {
      classification: { enum: ["public", "internal", "confidential", "restricted"] },
      contains_personal_data: booleanSchema,
      redaction_status: { enum: ["not_required", "pending", "redacted", "blocked"] },
      upload_allowed: booleanSchema,
      export_allowed: booleanSchema,
      training_allowed: booleanSchema,
      policy_tags: { type: "array", items: stringSchema },
      retention_until: stringSchema,
      deletion_requested_at: stringSchema,
      redaction_summary: stringSchema,
      metadata: { type: "object" },
    },
  ),
  objectRef: schema(
    "objectRef",
    "Codali storage object reference",
    [
      "schema_version",
      "ref_id",
      "kind",
      "content_hash",
      "byte_size",
      "mime_type",
      "privacy_flags",
      "owner_scope",
      "deletion_group_id",
      "retention_class",
    ],
    {
      ref_id: stringSchema,
      kind: { enum: ["payload", "trace", "artifact", "dataset", "export", "evidence"] },
      uri: stringSchema,
      bucket: stringSchema,
      key: stringSchema,
      content_hash: stringSchema,
      byte_size: integerSchema,
      mime_type: stringSchema,
      privacy_flags: { type: "object" },
      owner_scope: { type: "object" },
      owner_scope_hash: stringSchema,
      deletion_group_id: stringSchema,
      retention_class: {
        enum: ["transient", "standard", "dataset", "legal_hold", "do_not_store"],
      },
      media_type: stringSchema,
      size_bytes: integerSchema,
      sha256: stringSchema,
      created_at: stringSchema,
      metadata: { type: "object" },
    },
  ),
  gatewayRecord: schema(
    "gatewayRecord",
    "Codali storage gateway record",
    [
      "schema_version",
      "record_type",
      "record_id",
      "run_id",
      "created_at",
      "status",
      "query",
      "privacy",
    ],
    {
      record_type: { const: "gateway_record" },
      record_id: stringSchema,
      run_id: stringSchema,
      created_at: stringSchema,
      status: { enum: ["succeeded", "failed", "partial", "needs_clarification"] },
      query: stringSchema,
      answer_summary: stringSchema,
      request_ref: { type: "object" },
      response_ref: { type: "object" },
      trace_ref: { type: "object" },
      answer_ref: { type: "object" },
      model: { type: "object" },
      usage: { type: "object" },
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
  datasetRecord: schema(
    "datasetRecord",
    "Codali storage dataset record",
    [
      "schema_version",
      "record_type",
      "record_id",
      "dataset_kind",
      "created_at",
      "input_ref",
      "privacy",
    ],
    {
      record_type: { const: "dataset_record" },
      record_id: stringSchema,
      dataset_kind: {
        enum: ["gateway_answer", "tool_trace", "model_call", "evaluation", "curated_example"],
      },
      created_at: stringSchema,
      source_gateway_record_id: stringSchema,
      input_ref: { type: "object" },
      output_ref: { type: "object" },
      evidence_refs: { type: "array", items: { type: "object" } },
      quality: { type: "object" },
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
  exportManifest: schema(
    "exportManifest",
    "Codali storage export manifest",
    [
      "schema_version",
      "record_type",
      "manifest_id",
      "created_at",
      "export_kind",
      "export_format",
      "record_count",
      "records",
      "artifact_refs",
      "checksum",
      "privacy_summary",
      "lineage",
      "deletion_group_snapshot",
      "privacy",
    ],
    {
      record_type: { const: "export_manifest" },
      manifest_id: stringSchema,
      created_at: stringSchema,
      export_kind: {
        enum: [
          "eval-replay",
          "prompt-regression",
          "extractor-sft",
          "tool-router-sft",
          "planner-sft",
          "verifier-sft",
          "query-expander-sft",
          "repair-sft",
          "context-refiner-sft",
          "rag-reranker",
          "model-router",
        ],
      },
      export_format: { enum: ["jsonl", "json", "parquet", "bundle"] },
      record_count: integerSchema,
      records: { type: "array", items: { type: "object" } },
      artifact_refs: { type: "array", items: { type: "object" } },
      checksum: stringSchema,
      privacy_summary: { type: "object" },
      lineage: { type: "object" },
      deletion_group_snapshot: { type: "object" },
      generated_by: stringSchema,
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
  feedbackRecord: schema(
    "feedbackRecord",
    "Codali storage feedback record",
    [
      "schema_version",
      "record_type",
      "feedback_id",
      "created_at",
      "source",
      "run_id",
      "deletion_group_id",
      "product_scope",
      "requester_scope",
      "candidate_records",
      "target_type",
      "target_id",
      "privacy",
    ],
    {
      record_type: { const: "feedback_record" },
      feedback_id: stringSchema,
      created_at: stringSchema,
      source: { enum: ["user", "operator", "automated_eval"] },
      run_id: stringSchema,
      deletion_group_id: stringSchema,
      product_scope: { type: "object" },
      requester_scope: { type: "object" },
      candidate_records: { type: "array", items: { type: "object" } },
      target_type: stringSchema,
      target_id: stringSchema,
      rating: numberSchema,
      comment: stringSchema,
      labels: { type: "array", items: stringSchema },
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
  reviewRecord: schema(
    "reviewRecord",
    "Codali storage review record",
    [
      "schema_version",
      "record_type",
      "review_id",
      "created_at",
      "reviewer_type",
      "run_id",
      "deletion_group_id",
      "product_scope",
      "requester_scope",
      "candidate_records",
      "target_type",
      "target_id",
      "decision",
      "privacy",
    ],
    {
      record_type: { const: "review_record" },
      review_id: stringSchema,
      created_at: stringSchema,
      reviewer_type: { enum: ["human", "automated"] },
      reviewer_id: stringSchema,
      run_id: stringSchema,
      deletion_group_id: stringSchema,
      product_scope: { type: "object" },
      requester_scope: { type: "object" },
      candidate_records: { type: "array", items: { type: "object" } },
      target_type: stringSchema,
      target_id: stringSchema,
      decision: { enum: ["approved", "rejected", "needs_changes", "escalated"] },
      reasons: { type: "array", items: stringSchema },
      labels: { type: "array", items: stringSchema },
      promotion_target: { enum: ["gold", "silver", "reject"] },
      promoted_record_ids: { type: "array", items: stringSchema },
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
  improvementRecord: schema(
    "improvementRecord",
    "Codali storage improvement record",
    [
      "schema_version",
      "record_type",
      "improvement_id",
      "created_at",
      "improvement_kind",
      "status",
      "summary",
      "source_record_ids",
      "training_eligible",
      "privacy",
    ],
    {
      record_type: { const: "improvement_record" },
      improvement_id: stringSchema,
      created_at: stringSchema,
      improvement_kind: {
        enum: ["prompt", "policy", "model_selection", "tooling", "evaluation", "other"],
      },
      status: { enum: ["proposed", "accepted", "rejected", "applied"] },
      summary: stringSchema,
      source_record_ids: { type: "array", items: stringSchema },
      training_eligible: booleanSchema,
      export_manifest_id: stringSchema,
      candidate_ref: { type: "object" },
      privacy: { type: "object" },
      metadata: { type: "object" },
    },
  ),
} as const satisfies Record<
  CodaliStorageContractSchemaName,
  CodaliStorageContractJsonSchema
>;

const PRIVACY_CLASSIFICATIONS: readonly CodaliStoragePrivacyClassification[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

const REDACTION_STATUSES: readonly CodaliStorageRedactionStatus[] = [
  "not_required",
  "pending",
  "redacted",
  "blocked",
] as const;

const OBJECT_REF_KINDS: readonly CodaliStorageObjectRefKind[] = [
  "payload",
  "trace",
  "artifact",
  "dataset",
  "export",
  "evidence",
] as const;

const OBJECT_RETENTION_CLASSES: readonly CodaliStorageObjectRetentionClass[] = [
  "transient",
  "standard",
  "dataset",
  "legal_hold",
  "do_not_store",
] as const;

const RECORD_TYPES: readonly CodaliStorageRecordType[] = [
  "gateway_record",
  "dataset_record",
  "export_manifest",
  "feedback_record",
  "review_record",
  "improvement_record",
] as const;

const GATEWAY_STATUSES: readonly CodaliStorageGatewayStatus[] = [
  "succeeded",
  "failed",
  "partial",
  "needs_clarification",
] as const;

const DATASET_KINDS: readonly CodaliStorageDatasetKind[] = [
  "gateway_answer",
  "tool_trace",
  "model_call",
  "evaluation",
  "curated_example",
] as const;

const EXPORT_FORMATS: readonly CodaliStorageExportFormat[] = [
  "jsonl",
  "json",
  "parquet",
  "bundle",
] as const;

export const CODALI_STORAGE_EXPORT_KINDS: readonly CodaliStorageExportKind[] = [
  "eval-replay",
  "prompt-regression",
  "extractor-sft",
  "tool-router-sft",
  "planner-sft",
  "verifier-sft",
  "query-expander-sft",
  "repair-sft",
  "context-refiner-sft",
  "rag-reranker",
  "model-router",
] as const;

const FEEDBACK_SOURCES: readonly CodaliStorageFeedbackSource[] = [
  "user",
  "operator",
  "automated_eval",
] as const;

const REVIEWER_TYPES: readonly CodaliStorageReviewerType[] = [
  "human",
  "automated",
] as const;

const REVIEW_DECISIONS: readonly CodaliStorageReviewDecision[] = [
  "approved",
  "rejected",
  "needs_changes",
  "escalated",
] as const;

const REQUESTER_SCOPE_VISIBILITIES: readonly CodaliStorageRequesterScopeVisibility[] = [
  "requester",
  "conversation",
  "product",
  "tenant",
] as const;

const REVIEW_PROMOTION_TARGETS: readonly CodaliStorageReviewPromotionTarget[] = [
  "gold",
  "silver",
  "reject",
] as const;

const IMPROVEMENT_KINDS: readonly CodaliStorageImprovementKind[] = [
  "prompt",
  "policy",
  "model_selection",
  "tooling",
  "evaluation",
  "other",
] as const;

const IMPROVEMENT_STATUSES: readonly CodaliStorageImprovementStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "applied",
] as const;

type ValidationBag = { issues: CodaliStorageValidationIssue[] };

export const isCodaliStorageValidationOk = <T>(
  result: CodaliStorageValidationResult<T>,
): result is { ok: true; value: T; issues: [] } => result.ok;

export const isCodaliStoragePrivacyExportAllowed = (
  privacy: CodaliStoragePrivacyMetadata,
): boolean =>
  privacy.exportAllowed &&
  (!privacy.containsPersonalData || privacy.redactionStatus === "redacted");

export const isCodaliStoragePrivacyTrainingAllowed = (
  privacy: CodaliStoragePrivacyMetadata,
): boolean =>
  privacy.trainingAllowed &&
  (!privacy.containsPersonalData || privacy.redactionStatus === "redacted");

export const isCodaliStoragePrivacyUploadAllowed = (
  privacy: CodaliStoragePrivacyMetadata,
): boolean =>
  privacy.uploadAllowed &&
  (!privacy.containsPersonalData || privacy.redactionStatus === "redacted");

export const isCodaliStorageRecordExportAllowed = (
  record: { privacy: CodaliStoragePrivacyMetadata },
): boolean => isCodaliStoragePrivacyExportAllowed(record.privacy);

export const validateCodaliStoragePrivacyMetadata = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStoragePrivacyMetadata> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const classification = readRequiredEnum(
    record,
    ["classification"],
    PRIVACY_CLASSIFICATIONS,
    "$.classification",
    bag,
  );
  const containsPersonalData = readRequiredBoolean(
    record,
    ["containsPersonalData", "contains_personal_data"],
    "$.containsPersonalData",
    bag,
  );
  const redactionStatus = readRequiredEnum(
    record,
    ["redactionStatus", "redaction_status"],
    REDACTION_STATUSES,
    "$.redactionStatus",
    bag,
  );
  const uploadAllowed = readRequiredBoolean(
    record,
    ["uploadAllowed", "upload_allowed"],
    "$.uploadAllowed",
    bag,
  );
  const exportAllowed = readRequiredBoolean(
    record,
    ["exportAllowed", "export_allowed"],
    "$.exportAllowed",
    bag,
  );
  const trainingAllowed = readRequiredBoolean(
    record,
    ["trainingAllowed", "training_allowed"],
    "$.trainingAllowed",
    bag,
  );

  if (
    containsPersonalData === true &&
    redactionStatus !== undefined &&
    redactionStatus !== "redacted" &&
    (uploadAllowed === true || exportAllowed === true || trainingAllowed === true)
  ) {
    addIssue(
      bag,
      "$.privacy",
      "privacy_allowance_requires_redaction",
      "Personal data must be redacted before upload, export, or training can be allowed.",
    );
  }

  if (
    !schemaVersion ||
    !classification ||
    containsPersonalData === undefined ||
    !redactionStatus ||
    uploadAllowed === undefined ||
    exportAllowed === undefined ||
    trainingAllowed === undefined
  ) {
    return fail(bag);
  }

  const privacy: CodaliStoragePrivacyMetadata = {
    schemaVersion,
    classification,
    containsPersonalData,
    redactionStatus,
    uploadAllowed,
    exportAllowed,
    trainingAllowed,
  };

  copyOptionalStringArray(
    record,
    privacy,
    "policyTags",
    ["policyTags", "policy_tags"],
    "$.policyTags",
    bag,
  );
  copyOptionalString(record, privacy, "retentionUntil", ["retentionUntil", "retention_until"], "$.retentionUntil", bag);
  copyOptionalString(
    record,
    privacy,
    "deletionRequestedAt",
    ["deletionRequestedAt", "deletion_requested_at"],
    "$.deletionRequestedAt",
    bag,
  );
  copyOptionalString(
    record,
    privacy,
    "redactionSummary",
    ["redactionSummary", "redaction_summary"],
    "$.redactionSummary",
    bag,
  );
  copyOptionalMetadata(record, privacy, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(privacy);
};

export const validateCodaliStorageObjectRef = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageObjectRef> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const refId = readRequiredNonEmptyString(record, ["refId", "ref_id"], "$.refId", bag);
  const kind = readRequiredEnum(record, ["kind"], OBJECT_REF_KINDS, "$.kind", bag);
  const contentHash = readRequiredNonEmptyString(
    record,
    ["contentHash", "content_hash", "sha256"],
    "$.contentHash",
    bag,
  );
  const byteSize = readRequiredNonNegativeInteger(
    record,
    ["byteSize", "byte_size", "sizeBytes", "size_bytes"],
    "$.byteSize",
    bag,
  );
  const mimeType = readRequiredNonEmptyString(
    record,
    ["mimeType", "mime_type", "mediaType", "media_type"],
    "$.mimeType",
    bag,
  );
  const privacyFlags = readObjectPrivacyFlags(record, "$.privacyFlags", bag);
  const ownerScope = readObjectOwnerScope(record, "$.ownerScope", bag);
  const deletionGroupId = readRequiredNonEmptyString(
    record,
    ["deletionGroupId", "deletion_group_id"],
    "$.deletionGroupId",
    bag,
  );
  const retentionClass = readRequiredEnum(
    record,
    ["retentionClass", "retention_class"],
    OBJECT_RETENTION_CLASSES,
    "$.retentionClass",
    bag,
  );

  if (retentionClass === "do_not_store") {
    addIssue(
      bag,
      "$.retentionClass",
      "object_ref_do_not_store",
      "Object refs with do_not_store retention cannot be persisted.",
    );
  }

  if (
    !schemaVersion ||
    !refId ||
    !kind ||
    !contentHash ||
    byteSize === undefined ||
    !mimeType ||
    !privacyFlags ||
    !ownerScope ||
    !deletionGroupId ||
    !retentionClass
  ) {
    return fail(bag);
  }

  const objectRef: CodaliStorageObjectRef = {
    schemaVersion,
    refId,
    kind,
    contentHash,
    byteSize,
    mimeType,
    privacyFlags,
    ownerScope,
    deletionGroupId,
    retentionClass,
    mediaType: mimeType,
    sizeBytes: byteSize,
    sha256: contentHash,
  };

  copyOptionalString(record, objectRef, "uri", ["uri"], "$.uri", bag);
  copyOptionalString(record, objectRef, "bucket", ["bucket"], "$.bucket", bag);
  copyOptionalString(record, objectRef, "key", ["key"], "$.key", bag);
  copyOptionalString(
    record,
    objectRef,
    "ownerScopeHash",
    ["ownerScopeHash", "owner_scope_hash"],
    "$.ownerScopeHash",
    bag,
  );
  copyOptionalString(record, objectRef, "createdAt", ["createdAt", "created_at"], "$.createdAt", bag);
  copyOptionalMetadata(record, objectRef, bag);

  if (!objectRef.uri && !objectRef.bucket && !objectRef.key) {
    addIssue(
      bag,
      "$",
      "object_location_required",
      "Object refs must include at least one location hint: uri, bucket, or key.",
    );
  }

  return bag.issues.length > 0 ? fail(bag) : ok(objectRef);
};

export const validateCodaliStorageGatewayRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageGatewayRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "gateway_record", bag);
  const recordId = readRequiredNonEmptyString(record, ["recordId", "record_id"], "$.recordId", bag);
  const runId = readRequiredNonEmptyString(record, ["runId", "run_id"], "$.runId", bag);
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const status = readRequiredEnum(record, ["status"], GATEWAY_STATUSES, "$.status", bag);
  const query = readRequiredNonEmptyString(record, ["query"], "$.query", bag);
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (!schemaVersion || !recordType || !recordId || !runId || !createdAt || !status || !query || !privacy) {
    return fail(bag);
  }

  const gatewayRecord: CodaliStorageGatewayRecord = {
    schemaVersion,
    recordType,
    recordId,
    runId,
    createdAt,
    status,
    query,
    privacy,
  };

  copyOptionalString(
    record,
    gatewayRecord,
    "answerSummary",
    ["answerSummary", "answer_summary"],
    "$.answerSummary",
    bag,
  );
  copyOptionalObjectRef(record, gatewayRecord, "requestRef", ["requestRef", "request_ref"], "$.requestRef", bag);
  copyOptionalObjectRef(record, gatewayRecord, "responseRef", ["responseRef", "response_ref"], "$.responseRef", bag);
  copyOptionalObjectRef(record, gatewayRecord, "traceRef", ["traceRef", "trace_ref"], "$.traceRef", bag);
  copyOptionalObjectRef(record, gatewayRecord, "answerRef", ["answerRef", "answer_ref"], "$.answerRef", bag);
  copyOptionalModel(record, gatewayRecord, bag);
  copyOptionalUsage(record, gatewayRecord, bag);
  copyOptionalMetadata(record, gatewayRecord, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(gatewayRecord);
};

export const validateCodaliStorageDatasetRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageDatasetRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "dataset_record", bag);
  const recordId = readRequiredNonEmptyString(record, ["recordId", "record_id"], "$.recordId", bag);
  const datasetKind = readRequiredEnum(
    record,
    ["datasetKind", "dataset_kind"],
    DATASET_KINDS,
    "$.datasetKind",
    bag,
  );
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const inputRef = readRequiredObjectRef(record, ["inputRef", "input_ref"], "$.inputRef", bag);
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (!schemaVersion || !recordType || !recordId || !datasetKind || !createdAt || !inputRef || !privacy) {
    return fail(bag);
  }

  const datasetRecord: CodaliStorageDatasetRecord = {
    schemaVersion,
    recordType,
    recordId,
    datasetKind,
    createdAt,
    inputRef,
    privacy,
  };

  copyOptionalString(
    record,
    datasetRecord,
    "sourceGatewayRecordId",
    ["sourceGatewayRecordId", "source_gateway_record_id"],
    "$.sourceGatewayRecordId",
    bag,
  );
  copyOptionalObjectRef(record, datasetRecord, "outputRef", ["outputRef", "output_ref"], "$.outputRef", bag);
  const evidenceRefs = readOptionalObjectRefArray(record, ["evidenceRefs", "evidence_refs"], "$.evidenceRefs", bag);
  if (evidenceRefs) datasetRecord.evidenceRefs = evidenceRefs;
  copyOptionalQuality(record, datasetRecord, bag);
  copyOptionalMetadata(record, datasetRecord, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(datasetRecord);
};

export const validateCodaliStorageExportManifest = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageExportManifest> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "export_manifest", bag);
  const manifestId = readRequiredNonEmptyString(record, ["manifestId", "manifest_id"], "$.manifestId", bag);
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const exportKind = readRequiredEnum(
    record,
    ["exportKind", "export_kind"],
    CODALI_STORAGE_EXPORT_KINDS,
    "$.exportKind",
    bag,
  );
  const exportFormat = readRequiredEnum(
    record,
    ["exportFormat", "export_format"],
    EXPORT_FORMATS,
    "$.exportFormat",
    bag,
  );
  const recordCount = readRequiredNonNegativeInteger(
    record,
    ["recordCount", "record_count"],
    "$.recordCount",
    bag,
  );
  const records = readManifestRecordRefs(record, bag);
  const artifactRefs = readOptionalObjectRefArray(record, ["artifactRefs", "artifact_refs"], "$.artifactRefs", bag);
  if (readAlias(record, ["artifactRefs", "artifact_refs"]) === undefined) {
    addIssue(
      bag,
      "$.artifactRefs",
      "required",
      "Export manifest artifact_refs are required.",
    );
  } else if (artifactRefs && artifactRefs.length === 0) {
    addIssue(
      bag,
      "$.artifactRefs",
      "expected_non_empty_array",
      "Export manifest artifact_refs must include at least one artifact.",
    );
  }
  const checksum = readRequiredNonEmptyString(record, ["checksum"], "$.checksum", bag);
  const privacySummary = readOptionalExportPrivacySummary(record, bag);
  if (readAlias(record, ["privacySummary", "privacy_summary"]) === undefined) {
    addIssue(
      bag,
      "$.privacySummary",
      "required",
      "Export manifest privacy_summary is required.",
    );
  }
  const lineage = readOptionalExportLineage(record, bag);
  if (readAlias(record, ["lineage"]) === undefined) {
    addIssue(
      bag,
      "$.lineage",
      "required",
      "Export manifest lineage is required.",
    );
  }
  const deletionGroupSnapshot = readOptionalExportDeletionGroupSnapshot(
    record,
    ["deletionGroupSnapshot", "deletion_group_snapshot"],
    bag,
  );
  if (readAlias(record, ["deletionGroupSnapshot", "deletion_group_snapshot"]) === undefined) {
    addIssue(
      bag,
      "$.deletionGroupSnapshot",
      "required",
      "Export manifest deletion_group_snapshot is required.",
    );
  }
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (
    !schemaVersion ||
    !recordType ||
    !manifestId ||
    !createdAt ||
    !exportKind ||
    !exportFormat ||
    recordCount === undefined ||
    !records ||
    !artifactRefs ||
    !checksum ||
    !privacySummary ||
    !lineage ||
    !deletionGroupSnapshot ||
    !privacy
  ) {
    return fail(bag);
  }

  if (recordCount !== records.length) {
    addIssue(
      bag,
      "$.recordCount",
      "record_count_mismatch",
      "Export manifest record_count must match records length.",
    );
  }

  if (privacySummary.recordCount !== recordCount) {
    addIssue(
      bag,
      "$.privacySummary.recordCount",
      "record_count_mismatch",
      "Export manifest privacy_summary record_count must match record_count.",
    );
  }

  if (lineage.exportKind !== exportKind) {
    addIssue(
      bag,
      "$.lineage.exportKind",
      "export_kind_mismatch",
      "Export manifest lineage export_kind must match export_kind.",
    );
  }

  if (!artifactRefs.some((ref) => ref.contentHash === checksum)) {
    addIssue(
      bag,
      "$.checksum",
      "checksum_not_in_artifact_refs",
      "Export manifest checksum must match one artifact content_hash.",
    );
  }

  const lineageRecordIds = new Set(lineage.sourceRecordIds);
  const lineageObjectHashes = new Set(lineage.sourceObjectHashes);
  for (const ref of records) {
    if (!lineageRecordIds.has(ref.recordId)) {
      addIssue(
        bag,
        "$.lineage.sourceRecordIds",
        "lineage_missing_record_id",
        "Export manifest lineage must include every manifest record id.",
      );
      break;
    }
    if (ref.objectRef && !lineageObjectHashes.has(ref.objectRef.contentHash)) {
      addIssue(
        bag,
        "$.lineage.sourceObjectHashes",
        "lineage_missing_object_hash",
        "Export manifest lineage must include every manifest record object content_hash.",
      );
      break;
    }
  }

  const deletionSnapshotIds = new Set(deletionGroupSnapshot.deletionGroupIds);
  for (const ref of records) {
    const recordDeletionGroups = deletionGroupSnapshot.byRecordId[ref.recordId];
    if (!recordDeletionGroups || recordDeletionGroups.length === 0) {
      addIssue(
        bag,
        "$.deletionGroupSnapshot.byRecordId",
        "deletion_snapshot_missing_record_id",
        "Export manifest deletion_group_snapshot must include every manifest record id.",
      );
      break;
    }
    if (ref.objectRef && !recordDeletionGroups.includes(ref.objectRef.deletionGroupId)) {
      addIssue(
        bag,
        "$.deletionGroupSnapshot.byRecordId",
        "deletion_snapshot_missing_object_group",
        "Export manifest deletion_group_snapshot must include every manifest record object deletion_group_id.",
      );
      break;
    }
    for (const deletionGroupId of recordDeletionGroups) {
      if (!deletionSnapshotIds.has(deletionGroupId)) {
        addIssue(
          bag,
          "$.deletionGroupSnapshot.deletionGroupIds",
          "deletion_snapshot_missing_group_id",
          "Export manifest deletion_group_snapshot deletion_group_ids must include every by_record_id group.",
        );
        break;
      }
    }
  }

  const manifest: CodaliStorageExportManifest = {
    schemaVersion,
    recordType,
    manifestId,
    createdAt,
    exportKind,
    exportFormat,
    recordCount,
    records,
    artifactRefs,
    checksum,
    privacySummary,
    lineage,
    deletionGroupSnapshot,
    privacy,
  };

  copyOptionalString(record, manifest, "generatedBy", ["generatedBy", "generated_by"], "$.generatedBy", bag);
  copyOptionalMetadata(record, manifest, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(manifest);
};

export const validateCodaliStorageFeedbackRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageFeedbackRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "feedback_record", bag);
  const feedbackId = readRequiredNonEmptyString(record, ["feedbackId", "feedback_id"], "$.feedbackId", bag);
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const source = readRequiredEnum(record, ["source"], FEEDBACK_SOURCES, "$.source", bag);
  const runId = readRequiredNonEmptyString(record, ["runId", "run_id"], "$.runId", bag);
  const deletionGroupId = readRequiredNonEmptyString(
    record,
    ["deletionGroupId", "deletion_group_id"],
    "$.deletionGroupId",
    bag,
  );
  const productScope = readProductScope(record, "$.productScope", bag);
  const requesterScope = readRequesterScope(record, "$.requesterScope", bag);
  const candidateRecords = readCandidateRecordRefs(record, "$.candidateRecords", bag);
  const targetType = readRequiredEnum(
    record,
    ["targetType", "target_type"],
    RECORD_TYPES,
    "$.targetType",
    bag,
  );
  const targetId = readRequiredNonEmptyString(record, ["targetId", "target_id"], "$.targetId", bag);
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (
    !schemaVersion ||
    !recordType ||
    !feedbackId ||
    !createdAt ||
    !source ||
    !runId ||
    !deletionGroupId ||
    !productScope ||
    !requesterScope ||
    !candidateRecords ||
    !targetType ||
    !targetId ||
    !privacy
  ) {
    return fail(bag);
  }

  requireTargetInCandidateRecords(candidateRecords, targetType, targetId, "$.targetId", bag);

  const feedback: CodaliStorageFeedbackRecord = {
    schemaVersion,
    recordType,
    feedbackId,
    createdAt,
    source,
    runId,
    deletionGroupId,
    productScope,
    requesterScope,
    candidateRecords,
    targetType,
    targetId,
    privacy,
  };

  copyOptionalUnitNumber(record, feedback, "rating", ["rating"], "$.rating", bag);
  copyOptionalString(record, feedback, "comment", ["comment"], "$.comment", bag);
  copyOptionalStringArray(record, feedback, "labels", ["labels"], "$.labels", bag);
  copyOptionalMetadata(record, feedback, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(feedback);
};

export const validateCodaliStorageReviewRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageReviewRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "review_record", bag);
  const reviewId = readRequiredNonEmptyString(record, ["reviewId", "review_id"], "$.reviewId", bag);
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const reviewerType = readRequiredEnum(
    record,
    ["reviewerType", "reviewer_type"],
    REVIEWER_TYPES,
    "$.reviewerType",
    bag,
  );
  const runId = readRequiredNonEmptyString(record, ["runId", "run_id"], "$.runId", bag);
  const deletionGroupId = readRequiredNonEmptyString(
    record,
    ["deletionGroupId", "deletion_group_id"],
    "$.deletionGroupId",
    bag,
  );
  const productScope = readProductScope(record, "$.productScope", bag);
  const requesterScope = readRequesterScope(record, "$.requesterScope", bag);
  const candidateRecords = readCandidateRecordRefs(record, "$.candidateRecords", bag);
  const targetType = readRequiredEnum(
    record,
    ["targetType", "target_type"],
    RECORD_TYPES,
    "$.targetType",
    bag,
  );
  const targetId = readRequiredNonEmptyString(record, ["targetId", "target_id"], "$.targetId", bag);
  const decision = readRequiredEnum(record, ["decision"], REVIEW_DECISIONS, "$.decision", bag);
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (
    !schemaVersion ||
    !recordType ||
    !reviewId ||
    !createdAt ||
    !reviewerType ||
    !runId ||
    !deletionGroupId ||
    !productScope ||
    !requesterScope ||
    !candidateRecords ||
    !targetType ||
    !targetId ||
    !decision ||
    !privacy
  ) {
    return fail(bag);
  }

  requireTargetInCandidateRecords(candidateRecords, targetType, targetId, "$.targetId", bag);

  const review: CodaliStorageReviewRecord = {
    schemaVersion,
    recordType,
    reviewId,
    createdAt,
    reviewerType,
    runId,
    deletionGroupId,
    productScope,
    requesterScope,
    candidateRecords,
    targetType,
    targetId,
    decision,
    privacy,
  };

  copyOptionalString(record, review, "reviewerId", ["reviewerId", "reviewer_id"], "$.reviewerId", bag);
  copyOptionalStringArray(record, review, "reasons", ["reasons"], "$.reasons", bag);
  copyOptionalStringArray(record, review, "labels", ["labels"], "$.labels", bag);
  const promotionTarget = readOptionalEnum(
    record,
    ["promotionTarget", "promotion_target"],
    REVIEW_PROMOTION_TARGETS,
    "$.promotionTarget",
    bag,
  );
  if (promotionTarget) review.promotionTarget = promotionTarget;
  copyOptionalStringArray(
    record,
    review,
    "promotedRecordIds",
    ["promotedRecordIds", "promoted_record_ids"],
    "$.promotedRecordIds",
    bag,
  );
  copyOptionalMetadata(record, review, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(review);
};

export const validateCodaliStorageImprovementRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageImprovementRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readSchemaVersion(record, "$", bag);
  const recordType = readRecordType(record, "improvement_record", bag);
  const improvementId = readRequiredNonEmptyString(
    record,
    ["improvementId", "improvement_id"],
    "$.improvementId",
    bag,
  );
  const createdAt = readRequiredNonEmptyString(record, ["createdAt", "created_at"], "$.createdAt", bag);
  const improvementKind = readRequiredEnum(
    record,
    ["improvementKind", "improvement_kind"],
    IMPROVEMENT_KINDS,
    "$.improvementKind",
    bag,
  );
  const status = readRequiredEnum(record, ["status"], IMPROVEMENT_STATUSES, "$.status", bag);
  const summary = readRequiredNonEmptyString(record, ["summary"], "$.summary", bag);
  const sourceRecordIds = readRequiredStringArray(
    record,
    ["sourceRecordIds", "source_record_ids"],
    "$.sourceRecordIds",
    bag,
  );
  const trainingEligible = readRequiredBoolean(
    record,
    ["trainingEligible", "training_eligible"],
    "$.trainingEligible",
    bag,
  );
  const privacy = readPrivacy(record, "$.privacy", bag);

  if (
    !schemaVersion ||
    !recordType ||
    !improvementId ||
    !createdAt ||
    !improvementKind ||
    !status ||
    !summary ||
    !sourceRecordIds ||
    trainingEligible === undefined ||
    !privacy
  ) {
    return fail(bag);
  }

  if (trainingEligible && !isCodaliStoragePrivacyTrainingAllowed(privacy)) {
    addIssue(
      bag,
      "$.trainingEligible",
      "training_not_allowed_by_privacy",
      "training_eligible can only be true when privacy metadata allows training on eligible redacted data.",
    );
  }

  const improvement: CodaliStorageImprovementRecord = {
    schemaVersion,
    recordType,
    improvementId,
    createdAt,
    improvementKind,
    status,
    summary,
    sourceRecordIds,
    trainingEligible,
    privacy,
  };

  copyOptionalString(
    record,
    improvement,
    "exportManifestId",
    ["exportManifestId", "export_manifest_id"],
    "$.exportManifestId",
    bag,
  );
  copyOptionalObjectRef(record, improvement, "candidateRef", ["candidateRef", "candidate_ref"], "$.candidateRef", bag);
  copyOptionalMetadata(record, improvement, bag);

  return bag.issues.length > 0 ? fail(bag) : ok(improvement);
};

export const validateCodaliStorageRecord = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageRecord> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const recordType = readAlias(record, ["recordType", "record_type"]);
  switch (recordType) {
    case "gateway_record":
      return validateCodaliStorageGatewayRecord(input);
    case "dataset_record":
      return validateCodaliStorageDatasetRecord(input);
    case "export_manifest":
      return validateCodaliStorageExportManifest(input);
    case "feedback_record":
      return validateCodaliStorageFeedbackRecord(input);
    case "review_record":
      return validateCodaliStorageReviewRecord(input);
    case "improvement_record":
      return validateCodaliStorageImprovementRecord(input);
    default:
      addIssue(
        bag,
        "$.recordType",
        "unsupported_record_type",
        "Storage record type must be one of the versioned Codali storage record types.",
      );
      return fail(bag);
  }
};

export const validateCodaliStorageContractFixtureSet = (
  input: unknown,
): CodaliStorageValidationResult<CodaliStorageContractFixtureSet> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  const schemaVersion = readRequiredLiteral(
    record,
    ["schemaVersion", "schema_version"],
    CODALI_STORAGE_CONTRACT_FIXTURE_SCHEMA_VERSION,
    "$.schemaVersion",
    bag,
  );
  const contractSchemaVersion = readRequiredLiteral(
    record,
    ["contractSchemaVersion", "contract_schema_version"],
    CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    "$.contractSchemaVersion",
    bag,
  );
  const distribution = readDistribution(record, bag);
  const fixturesRecord = readRequiredRecord(record, ["fixtures"], "$.fixtures", bag);

  if (!schemaVersion || !contractSchemaVersion || !distribution || !fixturesRecord) {
    return fail(bag);
  }

  const privacyMetadata = validateNested(
    validateCodaliStoragePrivacyMetadata,
    fixturesRecord.privacy_metadata ?? fixturesRecord.privacyMetadata,
    "$.fixtures.privacyMetadata",
    bag,
  );
  const objectRef = validateNested(
    validateCodaliStorageObjectRef,
    fixturesRecord.object_ref ?? fixturesRecord.objectRef,
    "$.fixtures.objectRef",
    bag,
  );
  const gatewayRecord = validateNested(
    validateCodaliStorageGatewayRecord,
    fixturesRecord.gateway_record ?? fixturesRecord.gatewayRecord,
    "$.fixtures.gatewayRecord",
    bag,
  );
  const datasetRecord = validateNested(
    validateCodaliStorageDatasetRecord,
    fixturesRecord.dataset_record ?? fixturesRecord.datasetRecord,
    "$.fixtures.datasetRecord",
    bag,
  );
  const exportManifest = validateNested(
    validateCodaliStorageExportManifest,
    fixturesRecord.export_manifest ?? fixturesRecord.exportManifest,
    "$.fixtures.exportManifest",
    bag,
  );
  const feedbackRecord = validateNested(
    validateCodaliStorageFeedbackRecord,
    fixturesRecord.feedback_record ?? fixturesRecord.feedbackRecord,
    "$.fixtures.feedbackRecord",
    bag,
  );
  const reviewRecord = validateNested(
    validateCodaliStorageReviewRecord,
    fixturesRecord.review_record ?? fixturesRecord.reviewRecord,
    "$.fixtures.reviewRecord",
    bag,
  );
  const improvementRecord = validateNested(
    validateCodaliStorageImprovementRecord,
    fixturesRecord.improvement_record ?? fixturesRecord.improvementRecord,
    "$.fixtures.improvementRecord",
    bag,
  );

  if (
    !privacyMetadata ||
    !objectRef ||
    !gatewayRecord ||
    !datasetRecord ||
    !exportManifest ||
    !feedbackRecord ||
    !reviewRecord ||
    !improvementRecord
  ) {
    return fail(bag);
  }

  const fixtureSet: CodaliStorageContractFixtureSet = {
    schemaVersion,
    contractSchemaVersion,
    distribution,
    fixtures: {
      privacyMetadata,
      objectRef,
      gatewayRecord,
      datasetRecord,
      exportManifest,
      feedbackRecord,
      reviewRecord,
      improvementRecord,
    },
  };

  return bag.issues.length > 0 ? fail(bag) : ok(fixtureSet);
};

const ok = <T>(value: T): CodaliStorageValidationResult<T> => ({
  ok: true,
  value,
  issues: [],
});

const fail = <T>(bag: ValidationBag): CodaliStorageValidationResult<T> => ({
  ok: false,
  issues: bag.issues,
});

const addIssue = (
  bag: ValidationBag,
  path: string,
  code: string,
  message: string,
) => {
  bag.issues.push({ path, code, message });
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const requireRecord = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  if (isRecord(input)) return input;
  addIssue(bag, path, "expected_object", "Expected an object.");
  return undefined;
};

const readRequiredRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Required object is missing.");
    return undefined;
  }
  if (!isRecord(value)) {
    addIssue(bag, path, "expected_object", "Expected an object.");
    return undefined;
  }
  return value;
};

const readAlias = (
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
};

const readSchemaVersion = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageSchemaVersion | undefined => {
  const value = readRequiredNonEmptyString(
    record,
    ["schemaVersion", "schema_version"],
    `${path}.schemaVersion`,
    bag,
  );
  if (!value) return undefined;
  if (
    !(CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS as readonly string[]).includes(value)
  ) {
    addIssue(
      bag,
      `${path}.schemaVersion`,
      "unsupported_schema_version",
      `Unsupported schema version: ${value}.`,
    );
    return undefined;
  }
  return value as CodaliStorageSchemaVersion;
};

const readRequiredLiteral = <T extends string>(
  record: Record<string, unknown>,
  keys: readonly string[],
  expected: T,
  path: string,
  bag: ValidationBag,
): T | undefined => {
  const value = readRequiredNonEmptyString(record, keys, path, bag);
  if (!value) return undefined;
  if (value !== expected) {
    addIssue(bag, path, "unexpected_literal", `Expected ${expected}.`);
    return undefined;
  }
  return expected;
};

const readRequiredNonEmptyString = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): string | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Required string is missing.");
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(bag, path, "expected_non_empty_string", "Expected a non-empty string.");
    return undefined;
  }
  return value;
};

const readOptionalString = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): string | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    addIssue(bag, path, "expected_string", "Expected a string.");
    return undefined;
  }
  return value;
};

const readRequiredBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): boolean | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Required boolean is missing.");
    return undefined;
  }
  if (typeof value !== "boolean") {
    addIssue(bag, path, "expected_boolean", "Expected a boolean.");
    return undefined;
  }
  return value;
};

const readOptionalBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): boolean | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    addIssue(bag, path, "expected_boolean", "Expected a boolean.");
    return undefined;
  }
  return value;
};

const readRequiredEnum = <T extends string>(
  record: Record<string, unknown>,
  keys: readonly string[],
  allowed: readonly T[],
  path: string,
  bag: ValidationBag,
): T | undefined => {
  const value = readRequiredNonEmptyString(record, keys, path, bag);
  if (!value) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    addIssue(bag, path, "expected_enum", `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return value as T;
};

const readOptionalEnum = <T extends string>(
  record: Record<string, unknown>,
  keys: readonly string[],
  allowed: readonly T[],
  path: string,
  bag: ValidationBag,
): T | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(bag, path, "expected_non_empty_string", "Expected a non-empty string.");
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    addIssue(bag, path, "expected_enum", `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return value as T;
};

const readRequiredNonNegativeInteger = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): number | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Required integer is missing.");
    return undefined;
  }
  return validateNonNegativeInteger(value, path, bag);
};

const readOptionalNonNegativeInteger = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): number | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  return validateNonNegativeInteger(value, path, bag);
};

const validateNonNegativeInteger = (
  value: unknown,
  path: string,
  bag: ValidationBag,
): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    addIssue(bag, path, "expected_non_negative_integer", "Expected a non-negative integer.");
    return undefined;
  }
  return value;
};

const readOptionalUnitNumber = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): number | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    addIssue(bag, path, "expected_unit_number", "Expected a number between 0 and 1.");
    return undefined;
  }
  return value;
};

const readRequiredStringArray = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): string[] | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Required string array is missing.");
    return undefined;
  }
  return validateStringArray(value, path, bag);
};

const readOptionalStringArray = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): string[] | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  return validateStringArray(value, path, bag);
};

const validateStringArray = (
  value: unknown,
  path: string,
  bag: ValidationBag,
): string[] | undefined => {
  if (!Array.isArray(value)) {
    addIssue(bag, path, "expected_array", "Expected an array.");
    return undefined;
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      addIssue(
        bag,
        `${path}[${index}]`,
        "expected_non_empty_string",
        "Expected a non-empty string.",
      );
      return;
    }
    result.push(item);
  });
  return result;
};

const readRecordType = <T extends CodaliStorageRecordType>(
  record: Record<string, unknown>,
  expected: T,
  bag: ValidationBag,
): T | undefined =>
  readRequiredLiteral(record, ["recordType", "record_type"], expected, "$.recordType", bag);

const readPrivacy = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStoragePrivacyMetadata | undefined => {
  const value = readAlias(record, ["privacy"]);
  if (value === undefined) {
    addIssue(bag, path, "required", "Privacy metadata is required.");
    return undefined;
  }
  return validateNested(validateCodaliStoragePrivacyMetadata, value, path, bag);
};

const readObjectPrivacyFlags = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageObjectPrivacyFlags | undefined => {
  const value = readRequiredRecord(record, ["privacyFlags", "privacy_flags"], path, bag);
  if (!value) return undefined;

  const containsPersonalData = readRequiredBoolean(
    value,
    ["containsPersonalData", "contains_personal_data"],
    `${path}.containsPersonalData`,
    bag,
  );
  const containsSecrets = readRequiredBoolean(
    value,
    ["containsSecrets", "contains_secrets"],
    `${path}.containsSecrets`,
    bag,
  );
  const containsTenantPrivateData = readRequiredBoolean(
    value,
    ["containsTenantPrivateData", "contains_tenant_private_data"],
    `${path}.containsTenantPrivateData`,
    bag,
  );
  const containsSourceCode = readRequiredBoolean(
    value,
    ["containsSourceCode", "contains_source_code"],
    `${path}.containsSourceCode`,
    bag,
  );
  const containsCustomerData = readRequiredBoolean(
    value,
    ["containsCustomerData", "contains_customer_data"],
    `${path}.containsCustomerData`,
    bag,
  );
  const trainingAllowed = readRequiredBoolean(
    value,
    ["trainingAllowed", "training_allowed"],
    `${path}.trainingAllowed`,
    bag,
  );
  const evalAllowed = readRequiredBoolean(
    value,
    ["evalAllowed", "eval_allowed"],
    `${path}.evalAllowed`,
    bag,
  );
  const replayAllowed = readRequiredBoolean(
    value,
    ["replayAllowed", "replay_allowed"],
    `${path}.replayAllowed`,
    bag,
  );
  const exportAllowed = readRequiredBoolean(
    value,
    ["exportAllowed", "export_allowed"],
    `${path}.exportAllowed`,
    bag,
  );

  if (
    containsPersonalData === undefined ||
    containsSecrets === undefined ||
    containsTenantPrivateData === undefined ||
    containsSourceCode === undefined ||
    containsCustomerData === undefined ||
    trainingAllowed === undefined ||
    evalAllowed === undefined ||
    replayAllowed === undefined ||
    exportAllowed === undefined
  ) {
    return undefined;
  }

  return {
    containsPersonalData,
    containsSecrets,
    containsTenantPrivateData,
    containsSourceCode,
    containsCustomerData,
    trainingAllowed,
    evalAllowed,
    replayAllowed,
    exportAllowed,
  };
};

const readObjectOwnerScope = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageObjectOwnerScope | undefined => {
  const value = readRequiredRecord(record, ["ownerScope", "owner_scope"], path, bag);
  if (!value) return undefined;

  const tenantHash = readRequiredNonEmptyString(
    value,
    ["tenantHash", "tenant_hash"],
    `${path}.tenantHash`,
    bag,
  );
  const productId = readRequiredNonEmptyString(
    value,
    ["productId", "product_id"],
    `${path}.productId`,
    bag,
  );
  const ownerType = readRequiredNonEmptyString(
    value,
    ["ownerType", "owner_type"],
    `${path}.ownerType`,
    bag,
  );
  const ownerId = readRequiredNonEmptyString(
    value,
    ["ownerId", "owner_id"],
    `${path}.ownerId`,
    bag,
  );

  if (!tenantHash || !productId || !ownerType || !ownerId) return undefined;

  const ownerScope: CodaliStorageObjectOwnerScope = {
    tenantHash,
    productId,
    ownerType,
    ownerId,
  };
  copyOptionalString(
    value,
    ownerScope,
    "deploymentId",
    ["deploymentId", "deployment_id"],
    `${path}.deploymentId`,
    bag,
  );
  copyOptionalString(
    value,
    ownerScope,
    "runId",
    ["runId", "run_id"],
    `${path}.runId`,
    bag,
  );
  return ownerScope;
};

const readProductScope = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageProductScope | undefined => {
  const value = readRequiredRecord(record, ["productScope", "product_scope"], path, bag);
  if (!value) return undefined;

  const productId = readRequiredNonEmptyString(
    value,
    ["productId", "product_id"],
    `${path}.productId`,
    bag,
  );
  const tenantHash = readRequiredNonEmptyString(
    value,
    ["tenantHash", "tenant_hash"],
    `${path}.tenantHash`,
    bag,
  );

  if (!productId || !tenantHash) return undefined;

  const productScope: CodaliStorageProductScope = {
    productId,
    tenantHash,
  };
  copyOptionalString(
    value,
    productScope,
    "deploymentId",
    ["deploymentId", "deployment_id"],
    `${path}.deploymentId`,
    bag,
  );
  copyOptionalString(value, productScope, "environment", ["environment"], `${path}.environment`, bag);
  copyOptionalMetadata(value, productScope, bag);
  return productScope;
};

const readRequesterScope = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageRequesterScope | undefined => {
  const value = readRequiredRecord(record, ["requesterScope", "requester_scope"], path, bag);
  if (!value) return undefined;

  const requesterHash = readRequiredNonEmptyString(
    value,
    ["requesterHash", "requester_hash"],
    `${path}.requesterHash`,
    bag,
  );
  const visibility = readRequiredEnum(
    value,
    ["visibility"],
    REQUESTER_SCOPE_VISIBILITIES,
    `${path}.visibility`,
    bag,
  );
  const tenantWide = readOptionalBoolean(
    value,
    ["tenantWide", "tenant_wide"],
    `${path}.tenantWide`,
    bag,
  ) ?? false;

  if (visibility === "tenant" && tenantWide !== true) {
    addIssue(
      bag,
      `${path}.tenantWide`,
      "tenant_wide_scope_requires_explicit_allowance",
      "Requester feedback cannot become tenant-wide visible unless tenant_wide is explicitly true.",
    );
  }

  if (!requesterHash || !visibility) return undefined;

  const requesterScope: CodaliStorageRequesterScope = {
    requesterHash,
    visibility,
    tenantWide,
  };
  copyOptionalString(
    value,
    requesterScope,
    "conversationHash",
    ["conversationHash", "conversation_hash"],
    `${path}.conversationHash`,
    bag,
  );
  copyOptionalString(
    value,
    requesterScope,
    "requesterType",
    ["requesterType", "requester_type"],
    `${path}.requesterType`,
    bag,
  );
  copyOptionalMetadata(value, requesterScope, bag);
  return requesterScope;
};

const readRequiredObjectRef = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): CodaliStorageObjectRef | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) {
    addIssue(bag, path, "required", "Object ref is required.");
    return undefined;
  }
  return validateNested(validateCodaliStorageObjectRef, value, path, bag);
};

const readCandidateRecordRefs = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): CodaliStorageCandidateRecordRef[] | undefined => {
  const value = readAlias(record, ["candidateRecords", "candidate_records"]);
  if (value === undefined) {
    addIssue(bag, path, "required", "Candidate record links are required.");
    return undefined;
  }
  if (!Array.isArray(value)) {
    addIssue(bag, path, "expected_array", "Expected an array.");
    return undefined;
  }
  if (value.length === 0) {
    addIssue(bag, path, "candidate_records_required", "At least one candidate record link is required.");
    return undefined;
  }

  const refs: CodaliStorageCandidateRecordRef[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const itemRecord = requireRecord(item, itemPath, bag);
    if (!itemRecord) return;
    const recordType = readRequiredEnum(
      itemRecord,
      ["recordType", "record_type"],
      RECORD_TYPES,
      `${itemPath}.recordType`,
      bag,
    );
    const recordId = readRequiredNonEmptyString(
      itemRecord,
      ["recordId", "record_id"],
      `${itemPath}.recordId`,
      bag,
    );
    if (!recordType || !recordId) return;

    const ref: CodaliStorageCandidateRecordRef = {
      recordType,
      recordId,
    };
    const datasetKind = readOptionalEnum(
      itemRecord,
      ["datasetKind", "dataset_kind"],
      DATASET_KINDS,
      `${itemPath}.datasetKind`,
      bag,
    );
    if (datasetKind) ref.datasetKind = datasetKind;
    copyOptionalObjectRef(
      itemRecord,
      ref,
      "objectRef",
      ["objectRef", "object_ref"],
      `${itemPath}.objectRef`,
      bag,
    );
    copyOptionalStringArray(itemRecord, ref, "labels", ["labels"], `${itemPath}.labels`, bag);
    copyOptionalString(itemRecord, ref, "role", ["role"], `${itemPath}.role`, bag);
    copyOptionalMetadata(itemRecord, ref, bag);
    refs.push(ref);
  });

  return refs.length > 0 ? refs : undefined;
};

const requireTargetInCandidateRecords = (
  candidateRecords: CodaliStorageCandidateRecordRef[],
  targetType: CodaliStorageRecordType,
  targetId: string,
  path: string,
  bag: ValidationBag,
) => {
  if (
    !candidateRecords.some(
      (candidate) => candidate.recordType === targetType && candidate.recordId === targetId,
    )
  ) {
    addIssue(
      bag,
      path,
      "target_not_in_candidate_records",
      "Feedback and review targets must also be listed in candidate_records.",
    );
  }
};

const readOptionalObjectRefArray = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): CodaliStorageObjectRef[] | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addIssue(bag, path, "expected_array", "Expected an array.");
    return undefined;
  }
  const result: CodaliStorageObjectRef[] = [];
  value.forEach((item, index) => {
    const validated = validateNested(
      validateCodaliStorageObjectRef,
      item,
      `${path}[${index}]`,
      bag,
    );
    if (validated) result.push(validated);
  });
  return result;
};

const readManifestRecordRefs = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliStorageExportManifestRecordRef[] | undefined => {
  const value = readAlias(record, ["records"]);
  if (value === undefined) {
    addIssue(bag, "$.records", "required", "Export manifest records are required.");
    return undefined;
  }
  if (!Array.isArray(value)) {
    addIssue(bag, "$.records", "expected_array", "Expected an array.");
    return undefined;
  }
  const refs: CodaliStorageExportManifestRecordRef[] = [];
  value.forEach((item, index) => {
    const path = `$.records[${index}]`;
    const itemRecord = requireRecord(item, path, bag);
    if (!itemRecord) return;
    const recordType = readRequiredEnum(
      itemRecord,
      ["recordType", "record_type"],
      RECORD_TYPES,
      `${path}.recordType`,
      bag,
    );
    const recordId = readRequiredNonEmptyString(
      itemRecord,
      ["recordId", "record_id"],
      `${path}.recordId`,
      bag,
    );
    const schemaVersion = readSchemaVersion(itemRecord, path, bag);
    const objectRef = readOptionalObjectRef(itemRecord, ["objectRef", "object_ref"], `${path}.objectRef`, bag);
    if (readAlias(itemRecord, ["objectRef", "object_ref"]) === undefined) {
      addIssue(
        bag,
        `${path}.objectRef`,
        "manifest_record_object_ref_required",
        "Export manifest records must include object_ref for reproducibility.",
      );
    }
    if (recordType && recordId && schemaVersion) {
      refs.push({ recordType, recordId, schemaVersion, ...(objectRef ? { objectRef } : {}) });
    }
  });
  return refs;
};

const readRequiredCountRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): Record<string, number> | undefined => {
  const value = readRequiredRecord(record, keys, path, bag);
  if (!value) return undefined;
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!key.trim()) {
      addIssue(bag, `${path}.${key}`, "expected_non_empty_string", "Count keys must be non-empty.");
      continue;
    }
    const validated = validateNonNegativeInteger(count, `${path}.${key}`, bag);
    if (validated !== undefined) output[key] = validated;
  }
  return output;
};

const readOptionalExportPrivacySummary = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliStorageExportPrivacySummary | undefined => {
  const value = readAlias(record, ["privacySummary", "privacy_summary"]);
  if (value === undefined) return undefined;
  const summaryRecord = requireRecord(value, "$.privacySummary", bag);
  if (!summaryRecord) return undefined;

  const recordCount = readRequiredNonNegativeInteger(
    summaryRecord,
    ["recordCount", "record_count"],
    "$.privacySummary.recordCount",
    bag,
  );
  const containsPersonalData = readRequiredBoolean(
    summaryRecord,
    ["containsPersonalData", "contains_personal_data"],
    "$.privacySummary.containsPersonalData",
    bag,
  );
  const containsSecrets = readRequiredBoolean(
    summaryRecord,
    ["containsSecrets", "contains_secrets"],
    "$.privacySummary.containsSecrets",
    bag,
  );
  const containsTenantPrivateData = readRequiredBoolean(
    summaryRecord,
    ["containsTenantPrivateData", "contains_tenant_private_data"],
    "$.privacySummary.containsTenantPrivateData",
    bag,
  );
  const containsSourceCode = readRequiredBoolean(
    summaryRecord,
    ["containsSourceCode", "contains_source_code"],
    "$.privacySummary.containsSourceCode",
    bag,
  );
  const containsCustomerData = readRequiredBoolean(
    summaryRecord,
    ["containsCustomerData", "contains_customer_data"],
    "$.privacySummary.containsCustomerData",
    bag,
  );
  const exportAllowedCount = readRequiredNonNegativeInteger(
    summaryRecord,
    ["exportAllowedCount", "export_allowed_count"],
    "$.privacySummary.exportAllowedCount",
    bag,
  );
  const trainingAllowedCount = readRequiredNonNegativeInteger(
    summaryRecord,
    ["trainingAllowedCount", "training_allowed_count"],
    "$.privacySummary.trainingAllowedCount",
    bag,
  );
  const evalAllowedCount = readRequiredNonNegativeInteger(
    summaryRecord,
    ["evalAllowedCount", "eval_allowed_count"],
    "$.privacySummary.evalAllowedCount",
    bag,
  );
  const replayAllowedCount = readRequiredNonNegativeInteger(
    summaryRecord,
    ["replayAllowedCount", "replay_allowed_count"],
    "$.privacySummary.replayAllowedCount",
    bag,
  );
  const classifications = readRequiredCountRecord(
    summaryRecord,
    ["classifications"],
    "$.privacySummary.classifications",
    bag,
  );
  const redactionStatuses = readRequiredCountRecord(
    summaryRecord,
    ["redactionStatuses", "redaction_statuses"],
    "$.privacySummary.redactionStatuses",
    bag,
  );

  if (
    recordCount === undefined ||
    containsPersonalData === undefined ||
    containsSecrets === undefined ||
    containsTenantPrivateData === undefined ||
    containsSourceCode === undefined ||
    containsCustomerData === undefined ||
    exportAllowedCount === undefined ||
    trainingAllowedCount === undefined ||
    evalAllowedCount === undefined ||
    replayAllowedCount === undefined ||
    !classifications ||
    !redactionStatuses
  ) {
    return undefined;
  }

  const summary: CodaliStorageExportPrivacySummary = {
    recordCount,
    containsPersonalData,
    containsSecrets,
    containsTenantPrivateData,
    containsSourceCode,
    containsCustomerData,
    exportAllowedCount,
    trainingAllowedCount,
    evalAllowedCount,
    replayAllowedCount,
    classifications,
    redactionStatuses,
  };
  const policyTags = readOptionalStringArray(
    summaryRecord,
    ["policyTags", "policy_tags"],
    "$.privacySummary.policyTags",
    bag,
  );
  if (policyTags) summary.policyTags = policyTags;
  return summary;
};

const readOptionalExportLineage = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliStorageExportLineage | undefined => {
  const value = readAlias(record, ["lineage"]);
  if (value === undefined) return undefined;
  const lineageRecord = requireRecord(value, "$.lineage", bag);
  if (!lineageRecord) return undefined;

  const exportKind = readRequiredEnum(
    lineageRecord,
    ["exportKind", "export_kind"],
    CODALI_STORAGE_EXPORT_KINDS,
    "$.lineage.exportKind",
    bag,
  );
  const sourceRecordIds = readRequiredStringArray(
    lineageRecord,
    ["sourceRecordIds", "source_record_ids"],
    "$.lineage.sourceRecordIds",
    bag,
  );
  const sourceObjectHashes = readRequiredStringArray(
    lineageRecord,
    ["sourceObjectHashes", "source_object_hashes"],
    "$.lineage.sourceObjectHashes",
    bag,
  );

  if (!exportKind || !sourceRecordIds || !sourceObjectHashes) return undefined;

  const lineage: CodaliStorageExportLineage = {
    exportKind,
    sourceRecordIds,
    sourceObjectHashes,
  };
  const sourceGatewayRecordIds = readOptionalStringArray(
    lineageRecord,
    ["sourceGatewayRecordIds", "source_gateway_record_ids"],
    "$.lineage.sourceGatewayRecordIds",
    bag,
  );
  if (sourceGatewayRecordIds) lineage.sourceGatewayRecordIds = sourceGatewayRecordIds;
  copyOptionalString(lineageRecord, lineage, "generatedBy", ["generatedBy", "generated_by"], "$.lineage.generatedBy", bag);
  return lineage;
};

const readRequiredStringArrayRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): Record<string, string[]> | undefined => {
  const value = readRequiredRecord(record, keys, path, bag);
  if (!value) return undefined;
  const output: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) {
      addIssue(bag, `${path}.${key}`, "expected_non_empty_string", "String-array keys must be non-empty.");
      continue;
    }
    const validated = validateStringArray(item, `${path}.${key}`, bag);
    if (validated) output[key] = validated;
  }
  return output;
};

const readOptionalExportDeletionGroupSnapshot = (
  record: Record<string, unknown>,
  keys: readonly string[],
  bag: ValidationBag,
): CodaliStorageExportDeletionGroupSnapshot | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  const snapshotRecord = requireRecord(value, "$.deletionGroupSnapshot", bag);
  if (!snapshotRecord) return undefined;

  const capturedAt = readRequiredNonEmptyString(
    snapshotRecord,
    ["capturedAt", "captured_at"],
    "$.deletionGroupSnapshot.capturedAt",
    bag,
  );
  const deletionGroupIds = readRequiredStringArray(
    snapshotRecord,
    ["deletionGroupIds", "deletion_group_ids"],
    "$.deletionGroupSnapshot.deletionGroupIds",
    bag,
  );
  const byRecordId = readRequiredStringArrayRecord(
    snapshotRecord,
    ["byRecordId", "by_record_id"],
    "$.deletionGroupSnapshot.byRecordId",
    bag,
  );

  if (!capturedAt || !deletionGroupIds || !byRecordId) return undefined;
  return {
    capturedAt,
    deletionGroupIds,
    byRecordId,
  };
};

const readOptionalObjectRef = (
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
): CodaliStorageObjectRef | undefined => {
  const value = readAlias(record, keys);
  if (value === undefined) return undefined;
  return validateNested(validateCodaliStorageObjectRef, value, path, bag);
};

const copyOptionalObjectRef = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readOptionalObjectRef(record, keys, path, bag);
  if (value) {
    Object.assign(output, { [target]: value });
  }
};

const copyOptionalString = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readOptionalString(record, keys, path, bag);
  if (value !== undefined) {
    Object.assign(output, { [target]: value });
  }
};

const copyOptionalStringArray = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readOptionalStringArray(record, keys, path, bag);
  if (value) {
    Object.assign(output, { [target]: value });
  }
};

const copyOptionalNonNegativeInteger = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readOptionalNonNegativeInteger(record, keys, path, bag);
  if (value !== undefined) {
    Object.assign(output, { [target]: value });
  }
};

const copyOptionalUnitNumber = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readOptionalUnitNumber(record, keys, path, bag);
  if (value !== undefined) {
    Object.assign(output, { [target]: value });
  }
};

const copyOptionalMetadata = (
  record: Record<string, unknown>,
  output: { metadata?: Record<string, unknown> },
  bag: ValidationBag,
) => {
  const value = readAlias(record, ["metadata"]);
  if (value === undefined) return;
  if (!isRecord(value)) {
    addIssue(bag, "$.metadata", "expected_object", "Expected metadata to be an object.");
    return;
  }
  output.metadata = value;
};

const copyOptionalRecord = <T extends object, K extends keyof T>(
  record: Record<string, unknown>,
  output: T,
  target: K,
  keys: readonly string[],
  path: string,
  bag: ValidationBag,
) => {
  const value = readAlias(record, keys);
  if (value === undefined) return;
  if (!isRecord(value)) {
    addIssue(bag, path, "expected_object", "Expected an object.");
    return;
  }
  Object.assign(output, { [target]: value });
};

const copyOptionalModel = (
  record: Record<string, unknown>,
  output: CodaliStorageGatewayRecord,
  bag: ValidationBag,
) => {
  const value = readAlias(record, ["model"]);
  if (value === undefined) return;
  const modelRecord = requireRecord(value, "$.model", bag);
  if (!modelRecord) return;
  const model = {
    provider: readOptionalString(modelRecord, ["provider"], "$.model.provider", bag),
    model: readOptionalString(modelRecord, ["model"], "$.model.model", bag),
    agentId: readOptionalString(modelRecord, ["agentId", "agent_id"], "$.model.agentId", bag),
    role: readOptionalString(modelRecord, ["role"], "$.model.role", bag),
  };
  output.model = withoutUndefined(model);
};

const copyOptionalUsage = (
  record: Record<string, unknown>,
  output: CodaliStorageGatewayRecord,
  bag: ValidationBag,
) => {
  const value = readAlias(record, ["usage"]);
  if (value === undefined) return;
  const usageRecord = requireRecord(value, "$.usage", bag);
  if (!usageRecord) return;
  const usage = {
    inputTokens: readOptionalNonNegativeInteger(
      usageRecord,
      ["inputTokens", "input_tokens"],
      "$.usage.inputTokens",
      bag,
    ),
    outputTokens: readOptionalNonNegativeInteger(
      usageRecord,
      ["outputTokens", "output_tokens"],
      "$.usage.outputTokens",
      bag,
    ),
    totalTokens: readOptionalNonNegativeInteger(
      usageRecord,
      ["totalTokens", "total_tokens"],
      "$.usage.totalTokens",
      bag,
    ),
  };
  output.usage = withoutUndefined(usage);
};

const copyOptionalQuality = (
  record: Record<string, unknown>,
  output: CodaliStorageDatasetRecord,
  bag: ValidationBag,
) => {
  const value = readAlias(record, ["quality"]);
  if (value === undefined) return;
  const qualityRecord = requireRecord(value, "$.quality", bag);
  if (!qualityRecord) return;
  const quality = {
    score: readOptionalUnitNumber(qualityRecord, ["score"], "$.quality.score", bag),
    labels: readOptionalStringArray(qualityRecord, ["labels"], "$.quality.labels", bag),
    reviewed: readOptionalBoolean(qualityRecord, ["reviewed"], "$.quality.reviewed", bag),
  };
  output.quality = withoutUndefined(quality);
};

const readDistribution = (
  record: Record<string, unknown>,
  bag: ValidationBag,
): CodaliStorageContractDistribution | undefined => {
  const value = readRequiredRecord(record, ["distribution"], "$.distribution", bag);
  if (!value) return undefined;
  const mode = readRequiredLiteral(
    value,
    ["mode"],
    CODALI_STORAGE_CONTRACT_DISTRIBUTION.mode,
    "$.distribution.mode",
    bag,
  );
  const packageName = readRequiredLiteral(
    value,
    ["packageName", "package_name"],
    CODALI_STORAGE_CONTRACT_DISTRIBUTION.packageName,
    "$.distribution.packageName",
    bag,
  );
  const modulePath = readRequiredLiteral(
    value,
    ["modulePath", "module_path"],
    CODALI_STORAGE_CONTRACT_DISTRIBUTION.modulePath,
    "$.distribution.modulePath",
    bag,
  );
  const sourcePath = readRequiredLiteral(
    value,
    ["sourcePath", "source_path"],
    CODALI_STORAGE_CONTRACT_DISTRIBUTION.sourcePath,
    "$.distribution.sourcePath",
    bag,
  );
  const fixturePath = readRequiredLiteral(
    value,
    ["fixturePath", "fixture_path"],
    CODALI_STORAGE_CONTRACT_DISTRIBUTION.fixturePath,
    "$.distribution.fixturePath",
    bag,
  );

  return mode && packageName && modulePath && sourcePath && fixturePath
    ? CODALI_STORAGE_CONTRACT_DISTRIBUTION
    : undefined;
};

const validateNested = <T>(
  validator: (input: unknown) => CodaliStorageValidationResult<T>,
  input: unknown,
  path: string,
  bag: ValidationBag,
): T | undefined => {
  const result = validator(input);
  if (result.ok) return result.value;
  for (const issue of result.issues) {
    addIssue(
      bag,
      issue.path === "$" ? path : `${path}${issue.path.slice(1)}`,
      issue.code,
      issue.message,
    );
  }
  return undefined;
};

const withoutUndefined = <T extends Record<string, unknown>>(input: T): T => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
};
