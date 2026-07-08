export const CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION =
  "codali.improvement.v1" as const;

export const CODALI_IMPROVEMENT_CLI_JSON_SCHEMA_VERSION =
  "codali.improvement.cli.v1" as const;

export const CODALI_IMPROVEMENT_RELEASE_LEVELS = [0, 1, 2, 3, 4] as const;

export type CodaliImprovementReleaseLevel =
  (typeof CODALI_IMPROVEMENT_RELEASE_LEVELS)[number];

export const CODALI_IMPROVEMENT_ARTIFACT_TYPES = [
  "analysis_report",
  "gate_report",
  "scorecard",
  "eval_replay_fixture",
  "eval_suite",
  "prompt_patch",
  "schema_patch",
  "tool_metadata_patch",
  "branch_patch",
  "prerelease_tag",
  "canary_tag",
  "stable_npm_release",
  "release_notes",
] as const;

export type CodaliImprovementArtifactType =
  (typeof CODALI_IMPROVEMENT_ARTIFACT_TYPES)[number];

export type CodaliImprovementStorageMode =
  | "local_only"
  | "storage_service"
  | "hybrid";

export type CodaliImprovementRunStatus =
  | "planned"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type CodaliImprovementCandidateKind =
  | "analysis"
  | "eval_replay"
  | "model_router"
  | "prompt"
  | "schema"
  | "tool_metadata"
  | "release";

export type CodaliImprovementCandidateStatus =
  | "proposed"
  | "accepted"
  | "blocked"
  | "rejected"
  | "released";

export type CodaliImprovementGateType =
  | "policy"
  | "privacy"
  | "eval"
  | "replay"
  | "release"
  | "manual_review";

export type CodaliImprovementGateStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "skipped"
  | "warning";

export type CodaliImprovementScorecardStatus =
  | "passed"
  | "failed"
  | "degraded"
  | "blocked";

export type CodaliImprovementReleaseStatus =
  | "planned"
  | "blocked"
  | "created"
  | "failed"
  | "published";

export type CodaliImprovementOutcomeStatus =
  | "succeeded"
  | "failed"
  | "degraded"
  | "rolled_back"
  | "blocked";

export const CODALI_IMPROVEMENT_POLICY_ACTIONS = [
  "analyze",
  "add_eval_replay",
  "branch_metadata",
  "create_prerelease_tag",
  "publish_stable",
  "export",
  "training",
  "auto_tag",
  "auto_publish",
] as const;

export type CodaliImprovementPolicyAction =
  (typeof CODALI_IMPROVEMENT_POLICY_ACTIONS)[number];

export const CODALI_IMPROVEMENT_CLI_JSON_OUTPUT_TYPES = [
  "improvement.policy",
  "improvement.policy_decision",
  "improvement.release_levels",
  "improvement.run",
  "improvement.candidate",
  "improvement.propose",
  "improvement.artifact",
  "improvement.gate",
  "improvement.scorecard",
  "improvement.release",
  "improvement.outcome",
  "improvement.monitor",
  "improvement.inspect",
] as const;

export type CodaliImprovementCliJsonOutputType =
  (typeof CODALI_IMPROVEMENT_CLI_JSON_OUTPUT_TYPES)[number];

export type CodaliImprovementCliJsonStatus = "ok" | "blocked" | "error";

export interface CodaliImprovementValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type CodaliImprovementValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: CodaliImprovementValidationIssue[] };

export interface CodaliImprovementScope {
  tenantHash: string;
  productId: string;
  deploymentId?: string;
}

export interface CodaliImprovementPolicy {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  policyId: string;
  releaseLevel: CodaliImprovementReleaseLevel;
  scope: CodaliImprovementScope;
  allowedArtifactTypes: CodaliImprovementArtifactType[];
  maxExamples: number;
  maxObjectBytes: number;
  storageMode: CodaliImprovementStorageMode;
  exportEnabled: boolean;
  trainingEnabled: boolean;
  autoTagEnabled: boolean;
  autoPublishEnabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementRun {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  runId: string;
  policyId: string;
  scope: CodaliImprovementScope;
  releaseLevel: CodaliImprovementReleaseLevel;
  status: CodaliImprovementRunStatus;
  createdAt: string;
  sourceExportIds: string[];
  maxExamples: number;
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementArtifact {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  artifactId: string;
  artifactType: CodaliImprovementArtifactType;
  scope: CodaliImprovementScope;
  storageMode: CodaliImprovementStorageMode;
  byteSize: number;
  contentHash: string;
  exportAllowed: boolean;
  trainingAllowed: boolean;
  createdAt: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementCandidate {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  candidateId: string;
  runId: string;
  scope: CodaliImprovementScope;
  candidateKind: CodaliImprovementCandidateKind;
  status: CodaliImprovementCandidateStatus;
  artifactIds: string[];
  sourceExportIds: string[];
  exampleCount: number;
  objectBytes: number;
  createdAt: string;
  blockedReasons?: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementGate {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  gateId: string;
  candidateId: string;
  gateType: CodaliImprovementGateType;
  status: CodaliImprovementGateStatus;
  required: boolean;
  passed: boolean;
  createdAt: string;
  score?: number;
  reasons?: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementScorecard {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  scorecardId: string;
  candidateId: string;
  status: CodaliImprovementScorecardStatus;
  gates: CodaliImprovementGate[];
  scores: Record<string, number>;
  createdAt: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementRelease {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  releaseId: string;
  candidateId: string;
  scope: CodaliImprovementScope;
  releaseLevel: CodaliImprovementReleaseLevel;
  status: CodaliImprovementReleaseStatus;
  artifactIds: string[];
  createdAt: string;
  tagName?: string;
  packageName?: string;
  version?: string;
  blockedReasons?: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementOutcome {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  outcomeId: string;
  releaseId: string;
  scope: CodaliImprovementScope;
  status: CodaliImprovementOutcomeStatus;
  published: boolean;
  tagged: boolean;
  trainingUsed: boolean;
  exportUsed: boolean;
  createdAt: string;
  reasons?: string[];
  telemetry?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface CodaliImprovementReleaseLevelContract {
  level: CodaliImprovementReleaseLevel;
  name: string;
  description: string;
  minAction: CodaliImprovementPolicyAction;
  allowedActions: readonly CodaliImprovementPolicyAction[];
  allowedArtifactTypes: readonly CodaliImprovementArtifactType[];
}

export const CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS = {
  0: {
    level: 0,
    name: "analysis_only",
    description: "analysis only",
    minAction: "analyze",
    allowedActions: ["analyze"],
    allowedArtifactTypes: ["analysis_report", "gate_report", "scorecard"],
  },
  1: {
    level: 1,
    name: "eval_replay_additions",
    description: "eval/replay additions",
    minAction: "add_eval_replay",
    allowedActions: ["analyze", "add_eval_replay", "export"],
    allowedArtifactTypes: [
      "analysis_report",
      "gate_report",
      "scorecard",
      "eval_replay_fixture",
      "eval_suite",
      "release_notes",
    ],
  },
  2: {
    level: 2,
    name: "metadata_branch",
    description: "prompt/schema/tool metadata branch",
    minAction: "branch_metadata",
    allowedActions: [
      "analyze",
      "add_eval_replay",
      "branch_metadata",
      "export",
      "training",
    ],
    allowedArtifactTypes: [
      "analysis_report",
      "gate_report",
      "scorecard",
      "eval_replay_fixture",
      "eval_suite",
      "prompt_patch",
      "schema_patch",
      "tool_metadata_patch",
      "branch_patch",
      "release_notes",
    ],
  },
  3: {
    level: 3,
    name: "prerelease_canary_tag",
    description: "prerelease/canary tag",
    minAction: "create_prerelease_tag",
    allowedActions: [
      "analyze",
      "add_eval_replay",
      "branch_metadata",
      "create_prerelease_tag",
      "export",
      "training",
      "auto_tag",
    ],
    allowedArtifactTypes: [
      "analysis_report",
      "gate_report",
      "scorecard",
      "eval_replay_fixture",
      "eval_suite",
      "prompt_patch",
      "schema_patch",
      "tool_metadata_patch",
      "branch_patch",
      "prerelease_tag",
      "canary_tag",
      "release_notes",
    ],
  },
  4: {
    level: 4,
    name: "stable_npm_release",
    description: "stable npm release",
    minAction: "publish_stable",
    allowedActions: [
      "analyze",
      "add_eval_replay",
      "branch_metadata",
      "create_prerelease_tag",
      "publish_stable",
      "export",
      "training",
      "auto_tag",
      "auto_publish",
    ],
    allowedArtifactTypes: [
      "analysis_report",
      "gate_report",
      "scorecard",
      "eval_replay_fixture",
      "eval_suite",
      "prompt_patch",
      "schema_patch",
      "tool_metadata_patch",
      "branch_patch",
      "prerelease_tag",
      "canary_tag",
      "stable_npm_release",
      "release_notes",
    ],
  },
} as const satisfies Record<
  CodaliImprovementReleaseLevel,
  CodaliImprovementReleaseLevelContract
>;

export const DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS = {
  releaseLevel: 0,
  allowedArtifactTypes:
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[0].allowedArtifactTypes,
  maxExamples: 100,
  maxObjectBytes: 1_048_576,
  storageMode: "local_only",
  exportEnabled: false,
  trainingEnabled: false,
  autoTagEnabled: false,
  autoPublishEnabled: false,
} as const;

export interface CodaliImprovementPolicyEvaluationRequest {
  action: CodaliImprovementPolicyAction;
  scope?: CodaliImprovementScope;
  releaseLevel?: CodaliImprovementReleaseLevel;
  artifactType?: CodaliImprovementArtifactType;
  exampleCount?: number;
  objectBytes?: number;
}

export interface CodaliImprovementPolicyDecision {
  schemaVersion: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  policyId: string;
  action: CodaliImprovementPolicyAction;
  allowed: boolean;
  releaseLevel: CodaliImprovementReleaseLevel;
  requiredReleaseLevel: CodaliImprovementReleaseLevel;
  reasons: string[];
  blockedBy: string[];
  artifactType?: CodaliImprovementArtifactType;
  scope?: CodaliImprovementScope;
}

export interface CodaliImprovementCliJsonOutput<T = unknown> {
  schemaVersion: typeof CODALI_IMPROVEMENT_CLI_JSON_SCHEMA_VERSION;
  command: "improvement";
  outputType: CodaliImprovementCliJsonOutputType;
  status: CodaliImprovementCliJsonStatus;
  generatedAt: string;
  policy?: CodaliImprovementPolicy;
  decision?: CodaliImprovementPolicyDecision;
  data?: T;
  issues: CodaliImprovementValidationIssue[];
}

export interface BuildCodaliImprovementCliJsonOutputInput<T = unknown> {
  outputType: CodaliImprovementCliJsonOutputType;
  status: CodaliImprovementCliJsonStatus;
  generatedAt?: string;
  policy?: CodaliImprovementPolicy;
  decision?: CodaliImprovementPolicyDecision;
  data?: T;
  issues?: CodaliImprovementValidationIssue[];
}

type ValidationBag = { issues: CodaliImprovementValidationIssue[] };

const STRING_ARRAY_KEYS = new Set([
  "artifactIds",
  "sourceExportIds",
  "blockedReasons",
  "reasons",
]);

const ACTION_REQUIRED_LEVELS: Record<
  CodaliImprovementPolicyAction,
  CodaliImprovementReleaseLevel
> = {
  analyze: 0,
  add_eval_replay: 1,
  export: 1,
  branch_metadata: 2,
  training: 2,
  create_prerelease_tag: 3,
  auto_tag: 3,
  publish_stable: 4,
  auto_publish: 4,
};

const CODALI_IMPROVEMENT_MONITOR_REPORT_SCHEMA_VERSION =
  "codali.improvement.release_outcome_report.v1" as const;

const CODALI_IMPROVEMENT_MONITOR_RUNTIME_PACKAGE_KINDS = [
  "prompt_package",
  "router_policy",
  "retrieval_policy",
  "schema",
  "fine_tune_adapter",
] as const;

const CODALI_IMPROVEMENT_MONITOR_ROLLBACK_TRIGGER_CODES = [
  "schema_failures",
  "accepted_answer_rate_drop",
  "verifier_contradictions",
  "tool_failures",
  "latency_increase",
  "cost_increase",
  "privacy_security_warnings",
] as const;

export const isCodaliImprovementValidationOk = <T>(
  result: CodaliImprovementValidationResult<T>,
): result is { ok: true; value: T; issues: [] } => result.ok;

export const createCodaliImprovementPolicy = (
  input: Omit<CodaliImprovementPolicy, "schemaVersion"> & {
    schemaVersion?: typeof CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION;
  },
): CodaliImprovementPolicy => ({
  ...input,
  schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
});

export const getCodaliImprovementReleaseLevelContract = (
  level: CodaliImprovementReleaseLevel,
): CodaliImprovementReleaseLevelContract =>
  CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[level];

export const getCodaliImprovementAllowedArtifactTypesForLevel = (
  level: CodaliImprovementReleaseLevel,
): readonly CodaliImprovementArtifactType[] =>
  CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[level].allowedArtifactTypes;

export const evaluateCodaliImprovementPolicy = (
  policyInput: unknown,
  request: CodaliImprovementPolicyEvaluationRequest,
): CodaliImprovementPolicyDecision => {
  const policyResult = validateCodaliImprovementPolicy(policyInput);
  const reasons: string[] = [];
  const blockedBy: string[] = [];
  const policy = policyResult.ok ? policyResult.value : undefined;
  const releaseLevel = request.releaseLevel ?? policy?.releaseLevel ?? 0;
  const requiredReleaseLevel = ACTION_REQUIRED_LEVELS[request.action] ?? 4;

  if (!policyResult.ok) {
    reasons.push("invalid_policy");
    blockedBy.push("policy_validator");
  }

  if (!isReleaseLevel(releaseLevel)) {
    reasons.push("invalid_release_level");
    blockedBy.push("release_level");
  } else {
    if (policy && releaseLevel > policy.releaseLevel) {
      reasons.push("requested_release_level_exceeds_policy");
      blockedBy.push("release_level");
    }
    if (releaseLevel < requiredReleaseLevel) {
      reasons.push("release_level_too_low");
      blockedBy.push("release_level");
    }
    if (!levelAllowsAction(releaseLevel, request.action)) {
      reasons.push("action_not_allowed_at_release_level");
      blockedBy.push("release_level");
    }
  }

  if (policy) {
    if (request.action === "export" && !policy.exportEnabled) {
      reasons.push("export_disabled");
      blockedBy.push("export_enabled");
    }
    if (request.action === "training" && !policy.trainingEnabled) {
      reasons.push("training_disabled");
      blockedBy.push("training_enabled");
    }
    if (request.action === "auto_tag" && !policy.autoTagEnabled) {
      reasons.push("auto_tag_disabled");
      blockedBy.push("auto_tag_enabled");
    }
    if (request.action === "publish_stable" && !policy.autoPublishEnabled) {
      reasons.push("publish_disabled");
      blockedBy.push("auto_publish_enabled");
    }
    if (request.action === "auto_publish" && !policy.autoPublishEnabled) {
      reasons.push("auto_publish_disabled");
      blockedBy.push("auto_publish_enabled");
    }
    if (request.scope && !sameScope(policy.scope, request.scope)) {
      reasons.push("scope_not_allowed");
      blockedBy.push("tenant_product_scope");
    }
    if (
      typeof request.exampleCount === "number" &&
      request.exampleCount > policy.maxExamples
    ) {
      reasons.push("max_examples_exceeded");
      blockedBy.push("max_examples");
    }
    if (
      typeof request.objectBytes === "number" &&
      request.objectBytes > policy.maxObjectBytes
    ) {
      reasons.push("max_object_bytes_exceeded");
      blockedBy.push("max_object_bytes");
    }
    if (
      request.artifactType &&
      !policy.allowedArtifactTypes.includes(request.artifactType)
    ) {
      reasons.push("artifact_type_not_allowed_by_policy");
      blockedBy.push("allowed_artifact_types");
    }
    if (
      request.artifactType &&
      isReleaseLevel(releaseLevel) &&
      !getCodaliImprovementAllowedArtifactTypesForLevel(releaseLevel).includes(
        request.artifactType,
      )
    ) {
      reasons.push("artifact_type_not_allowed_at_release_level");
      blockedBy.push("release_level");
    }
  }

  return {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    policyId: policy?.policyId ?? "invalid-policy",
    action: request.action,
    allowed: reasons.length === 0,
    releaseLevel: isReleaseLevel(releaseLevel) ? releaseLevel : 0,
    requiredReleaseLevel,
    reasons: uniqueStrings(reasons),
    blockedBy: uniqueStrings(blockedBy),
    artifactType: request.artifactType,
    scope: request.scope,
  };
};

export const buildCodaliImprovementCliJsonOutput = <T = unknown>(
  input: BuildCodaliImprovementCliJsonOutputInput<T>,
): CodaliImprovementCliJsonOutput<T> =>
  withoutUndefined({
    schemaVersion: CODALI_IMPROVEMENT_CLI_JSON_SCHEMA_VERSION,
    command: "improvement" as const,
    outputType: input.outputType,
    status: input.status,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    policy: input.policy,
    decision: input.decision,
    data: input.data,
    issues: input.issues ?? [],
  });

export const validateCodaliImprovementPolicy = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementPolicy> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);

  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "policyId",
    "releaseLevel",
    "scope",
    "allowedArtifactTypes",
    "maxExamples",
    "maxObjectBytes",
    "storageMode",
    "exportEnabled",
    "trainingEnabled",
    "autoTagEnabled",
    "autoPublishEnabled",
    "metadata",
  ], bag);

  const schemaVersion = readConstString(
    record,
    "schemaVersion",
    CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    "$.schemaVersion",
    bag,
  );
  const releaseLevel = readReleaseLevel(record, "releaseLevel", "$.releaseLevel", bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const allowedArtifactTypes = readEnumArray(
    record,
    "allowedArtifactTypes",
    CODALI_IMPROVEMENT_ARTIFACT_TYPES,
    "$.allowedArtifactTypes",
    bag,
  );
  const policy: CodaliImprovementPolicy = withoutUndefined({
    schemaVersion,
    policyId: readNonEmptyString(record, "policyId", "$.policyId", bag),
    releaseLevel,
    scope: scope ?? fallbackScope(),
    allowedArtifactTypes,
    maxExamples: readNonNegativeInteger(record, "maxExamples", "$.maxExamples", bag),
    maxObjectBytes: readPositiveInteger(
      record,
      "maxObjectBytes",
      "$.maxObjectBytes",
      bag,
    ),
    storageMode: readEnumValue(
      record,
      "storageMode",
      ["local_only", "storage_service", "hybrid"] as const,
      "$.storageMode",
      bag,
    ),
    exportEnabled: readBoolean(record, "exportEnabled", "$.exportEnabled", bag),
    trainingEnabled: readBoolean(record, "trainingEnabled", "$.trainingEnabled", bag),
    autoTagEnabled: readBoolean(record, "autoTagEnabled", "$.autoTagEnabled", bag),
    autoPublishEnabled: readBoolean(
      record,
      "autoPublishEnabled",
      "$.autoPublishEnabled",
      bag,
    ),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });

  validatePolicyInvariants(policy, "$", bag);

  return bag.issues.length > 0 ? fail(bag) : ok(policy);
};

export const validateCodaliImprovementRun = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementRun> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "runId",
    "policyId",
    "scope",
    "releaseLevel",
    "status",
    "createdAt",
    "sourceExportIds",
    "maxExamples",
    "metadata",
  ], bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const run: CodaliImprovementRun = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    runId: readNonEmptyString(record, "runId", "$.runId", bag),
    policyId: readNonEmptyString(record, "policyId", "$.policyId", bag),
    scope: scope ?? fallbackScope(),
    releaseLevel: readReleaseLevel(record, "releaseLevel", "$.releaseLevel", bag),
    status: readEnumValue(
      record,
      "status",
      ["planned", "running", "blocked", "completed", "failed"] as const,
      "$.status",
      bag,
    ),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    sourceExportIds: readStringArray(
      record,
      "sourceExportIds",
      "$.sourceExportIds",
      bag,
    ),
    maxExamples: readNonNegativeInteger(record, "maxExamples", "$.maxExamples", bag),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  return bag.issues.length > 0 ? fail(bag) : ok(run);
};

export const validateCodaliImprovementArtifact = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementArtifact> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "artifactId",
    "artifactType",
    "scope",
    "storageMode",
    "byteSize",
    "contentHash",
    "exportAllowed",
    "trainingAllowed",
    "createdAt",
    "uri",
    "metadata",
  ], bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const artifact: CodaliImprovementArtifact = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    artifactId: readNonEmptyString(record, "artifactId", "$.artifactId", bag),
    artifactType: readEnumValue(
      record,
      "artifactType",
      CODALI_IMPROVEMENT_ARTIFACT_TYPES,
      "$.artifactType",
      bag,
    ),
    scope: scope ?? fallbackScope(),
    storageMode: readEnumValue(
      record,
      "storageMode",
      ["local_only", "storage_service", "hybrid"] as const,
      "$.storageMode",
      bag,
    ),
    byteSize: readNonNegativeInteger(record, "byteSize", "$.byteSize", bag),
    contentHash: readNonEmptyString(record, "contentHash", "$.contentHash", bag),
    exportAllowed: readBoolean(record, "exportAllowed", "$.exportAllowed", bag),
    trainingAllowed: readBoolean(record, "trainingAllowed", "$.trainingAllowed", bag),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    uri: readOptionalString(record, "uri", "$.uri", bag),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  return bag.issues.length > 0 ? fail(bag) : ok(artifact);
};

export const validateCodaliImprovementCandidate = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementCandidate> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "candidateId",
    "runId",
    "scope",
    "candidateKind",
    "status",
    "artifactIds",
    "sourceExportIds",
    "exampleCount",
    "objectBytes",
    "createdAt",
    "blockedReasons",
    "metadata",
  ], bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const candidate: CodaliImprovementCandidate = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    candidateId: readNonEmptyString(record, "candidateId", "$.candidateId", bag),
    runId: readNonEmptyString(record, "runId", "$.runId", bag),
    scope: scope ?? fallbackScope(),
    candidateKind: readEnumValue(
      record,
      "candidateKind",
      [
        "analysis",
        "eval_replay",
        "model_router",
        "prompt",
        "schema",
        "tool_metadata",
        "release",
      ] as const,
      "$.candidateKind",
      bag,
    ),
    status: readEnumValue(
      record,
      "status",
      ["proposed", "accepted", "blocked", "rejected", "released"] as const,
      "$.status",
      bag,
    ),
    artifactIds: readStringArray(record, "artifactIds", "$.artifactIds", bag),
    sourceExportIds: readStringArray(
      record,
      "sourceExportIds",
      "$.sourceExportIds",
      bag,
    ),
    exampleCount: readNonNegativeInteger(record, "exampleCount", "$.exampleCount", bag),
    objectBytes: readNonNegativeInteger(record, "objectBytes", "$.objectBytes", bag),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    blockedReasons: readOptionalStringArray(
      record,
      "blockedReasons",
      "$.blockedReasons",
      bag,
    ),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  return bag.issues.length > 0 ? fail(bag) : ok(candidate);
};

export const validateCodaliImprovementGate = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementGate> => {
  const bag: ValidationBag = { issues: [] };
  const gate = validateGateWithBag(input, "$", bag);
  return bag.issues.length > 0 ? fail(bag) : ok(gate ?? fallbackGate());
};

export const validateCodaliImprovementScorecard = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementScorecard> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "scorecardId",
    "candidateId",
    "status",
    "gates",
    "scores",
    "createdAt",
    "summary",
    "metadata",
  ], bag);
  const gates = readGateArray(record, "gates", "$.gates", bag);
  const scorecard: CodaliImprovementScorecard = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    scorecardId: readNonEmptyString(record, "scorecardId", "$.scorecardId", bag),
    candidateId: readNonEmptyString(record, "candidateId", "$.candidateId", bag),
    status: readEnumValue(
      record,
      "status",
      ["passed", "failed", "degraded", "blocked"] as const,
      "$.status",
      bag,
    ),
    gates,
    scores: readScores(record, "scores", "$.scores", bag),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    summary: readOptionalString(record, "summary", "$.summary", bag),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  return bag.issues.length > 0 ? fail(bag) : ok(scorecard);
};

export const validateCodaliImprovementRelease = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementRelease> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "releaseId",
    "candidateId",
    "scope",
    "releaseLevel",
    "status",
    "artifactIds",
    "createdAt",
    "tagName",
    "packageName",
    "version",
    "blockedReasons",
    "metadata",
  ], bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const release: CodaliImprovementRelease = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    releaseId: readNonEmptyString(record, "releaseId", "$.releaseId", bag),
    candidateId: readNonEmptyString(record, "candidateId", "$.candidateId", bag),
    scope: scope ?? fallbackScope(),
    releaseLevel: readReleaseLevel(record, "releaseLevel", "$.releaseLevel", bag),
    status: readEnumValue(
      record,
      "status",
      ["planned", "blocked", "created", "failed", "published"] as const,
      "$.status",
      bag,
    ),
    artifactIds: readStringArray(record, "artifactIds", "$.artifactIds", bag),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    tagName: readOptionalString(record, "tagName", "$.tagName", bag),
    packageName: readOptionalString(record, "packageName", "$.packageName", bag),
    version: readOptionalString(record, "version", "$.version", bag),
    blockedReasons: readOptionalStringArray(
      record,
      "blockedReasons",
      "$.blockedReasons",
      bag,
    ),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  validateReleaseInvariants(release, "$", bag);
  return bag.issues.length > 0 ? fail(bag) : ok(release);
};

export const validateCodaliImprovementOutcome = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementOutcome> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "outcomeId",
    "releaseId",
    "scope",
    "status",
    "published",
    "tagged",
    "trainingUsed",
    "exportUsed",
    "createdAt",
    "reasons",
    "telemetry",
    "metadata",
  ], bag);
  const scope = validateScope(record.scope, "$.scope", bag);
  const outcome: CodaliImprovementOutcome = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    outcomeId: readNonEmptyString(record, "outcomeId", "$.outcomeId", bag),
    releaseId: readNonEmptyString(record, "releaseId", "$.releaseId", bag),
    scope: scope ?? fallbackScope(),
    status: readEnumValue(
      record,
      "status",
      ["succeeded", "failed", "degraded", "rolled_back", "blocked"] as const,
      "$.status",
      bag,
    ),
    published: readBoolean(record, "published", "$.published", bag),
    tagged: readBoolean(record, "tagged", "$.tagged", bag),
    trainingUsed: readBoolean(record, "trainingUsed", "$.trainingUsed", bag),
    exportUsed: readBoolean(record, "exportUsed", "$.exportUsed", bag),
    createdAt: readIsoLikeString(record, "createdAt", "$.createdAt", bag),
    reasons: readOptionalStringArray(record, "reasons", "$.reasons", bag),
    telemetry: readOptionalNumberRecord(record, "telemetry", "$.telemetry", bag),
    metadata: readOptionalRecord(record, "metadata", "$.metadata", bag),
  });
  validateOutcomeInvariants(outcome, "$", bag);
  return bag.issues.length > 0 ? fail(bag) : ok(outcome);
};

export const validateCodaliImprovementPolicyDecision = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementPolicyDecision> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "policyId",
    "action",
    "allowed",
    "releaseLevel",
    "requiredReleaseLevel",
    "reasons",
    "blockedBy",
    "artifactType",
    "scope",
  ], bag);
  const scope = record.scope === undefined
    ? undefined
    : validateScope(record.scope, "$.scope", bag);
  const decision: CodaliImprovementPolicyDecision = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    policyId: readNonEmptyString(record, "policyId", "$.policyId", bag),
    action: readEnumValue(
      record,
      "action",
      CODALI_IMPROVEMENT_POLICY_ACTIONS,
      "$.action",
      bag,
    ),
    allowed: readBoolean(record, "allowed", "$.allowed", bag),
    releaseLevel: readReleaseLevel(record, "releaseLevel", "$.releaseLevel", bag),
    requiredReleaseLevel: readReleaseLevel(
      record,
      "requiredReleaseLevel",
      "$.requiredReleaseLevel",
      bag,
    ),
    reasons: readStringArray(record, "reasons", "$.reasons", bag),
    blockedBy: readStringArray(record, "blockedBy", "$.blockedBy", bag),
    artifactType: readOptionalEnumValue(
      record,
      "artifactType",
      CODALI_IMPROVEMENT_ARTIFACT_TYPES,
      "$.artifactType",
      bag,
    ),
    scope,
  });
  return bag.issues.length > 0 ? fail(bag) : ok(decision);
};

export const validateCodaliImprovementCliJsonOutput = (
  input: unknown,
): CodaliImprovementValidationResult<CodaliImprovementCliJsonOutput> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "command",
    "outputType",
    "status",
    "generatedAt",
    "policy",
    "decision",
    "data",
    "issues",
  ], bag);
  const policy = record.policy === undefined
    ? undefined
    : readNestedValidation(
      validateCodaliImprovementPolicy(record.policy),
      "$.policy",
      bag,
    );
  const decision = record.decision === undefined
    ? undefined
    : readNestedValidation(
      validateCodaliImprovementPolicyDecision(record.decision),
      "$.decision",
      bag,
    );
  const output: CodaliImprovementCliJsonOutput = withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CLI_JSON_SCHEMA_VERSION,
      "$.schemaVersion",
      bag,
    ),
    command: readConstString(record, "command", "improvement", "$.command", bag),
    outputType: readEnumValue(
      record,
      "outputType",
      CODALI_IMPROVEMENT_CLI_JSON_OUTPUT_TYPES,
      "$.outputType",
      bag,
    ),
    status: readEnumValue(
      record,
      "status",
      ["ok", "blocked", "error"] as const,
      "$.status",
      bag,
    ),
    generatedAt: readIsoLikeString(record, "generatedAt", "$.generatedAt", bag),
    policy,
    decision,
    data: record.data,
    issues: readIssueArray(record, "issues", "$.issues", bag),
  });
  validateCliJsonOutputInvariants(record, output, "$", bag);
  return bag.issues.length > 0 ? fail(bag) : ok(output);
};

const validateCliJsonOutputInvariants = (
  record: Record<string, unknown>,
  output: CodaliImprovementCliJsonOutput,
  path: string,
  bag: ValidationBag,
): void => {
  if (output.status === "ok" && output.issues.length > 0) {
    pushIssue(
      bag,
      `${path}.status`,
      "ok_output_cannot_have_issues",
      "OK improvement CLI output cannot include validation issues.",
    );
  }
  if (
    output.status === "blocked" &&
    output.outputType === "improvement.policy_decision" &&
    output.decision?.allowed !== false
  ) {
    pushIssue(
      bag,
      `${path}.decision`,
      "blocked_output_requires_blocking_decision",
      "Blocked improvement CLI output requires a decision with allowed=false.",
    );
  }
  if (output.status === "error" && output.issues.length === 0) {
    pushIssue(
      bag,
      `${path}.issues`,
      "error_output_requires_issues",
      "Error improvement CLI output must include validation issues.",
    );
  }

  switch (output.outputType) {
    case "improvement.policy":
      requireCliPolicy(output, path, bag);
      rejectCliDecision(output, path, bag);
      rejectCliData(record, path, bag);
      return;
    case "improvement.policy_decision":
      requireCliPolicy(output, path, bag);
      requireCliDecision(output, path, bag);
      rejectCliData(record, path, bag);
      return;
    case "improvement.release_levels":
      rejectCliPolicy(output, path, bag);
      rejectCliDecision(output, path, bag);
      validateReleaseLevelContractArray(record.data, `${path}.data`, bag);
      return;
    case "improvement.run":
      validateRequiredCliData(record, `${path}.data`, validateCodaliImprovementRun, bag);
      return;
    case "improvement.candidate":
      validateRequiredCliData(
        record,
        `${path}.data`,
        validateCodaliImprovementCandidate,
        bag,
      );
      return;
    case "improvement.artifact":
      validateRequiredCliData(
        record,
        `${path}.data`,
        validateCodaliImprovementArtifact,
        bag,
      );
      return;
    case "improvement.gate":
      validateRequiredCliData(record, `${path}.data`, validateCodaliImprovementGate, bag);
      return;
    case "improvement.scorecard":
      validateRequiredCliData(
        record,
        `${path}.data`,
        validateCodaliImprovementScorecard,
        bag,
      );
      return;
    case "improvement.release":
      validateRequiredCliData(
        record,
        `${path}.data`,
        validateCodaliImprovementRelease,
        bag,
      );
      return;
    case "improvement.outcome":
      validateRequiredCliData(
        record,
        `${path}.data`,
        validateCodaliImprovementOutcome,
        bag,
      );
      return;
    case "improvement.monitor":
      validateRequiredCliData(record, `${path}.data`, validateMonitorReportData, bag);
      return;
  }
};

const requireCliPolicy = (
  output: CodaliImprovementCliJsonOutput,
  path: string,
  bag: ValidationBag,
): void => {
  if (!output.policy) {
    pushIssue(
      bag,
      `${path}.policy`,
      "missing_policy",
      "This improvement CLI output type requires a policy payload.",
    );
  }
};

const rejectCliPolicy = (
  output: CodaliImprovementCliJsonOutput,
  path: string,
  bag: ValidationBag,
): void => {
  if (output.policy) {
    pushIssue(
      bag,
      `${path}.policy`,
      "unexpected_policy",
      "This improvement CLI output type must carry its payload in data.",
    );
  }
};

const requireCliDecision = (
  output: CodaliImprovementCliJsonOutput,
  path: string,
  bag: ValidationBag,
): void => {
  if (!output.decision) {
    pushIssue(
      bag,
      `${path}.decision`,
      "missing_decision",
      "This improvement CLI output type requires a policy decision payload.",
    );
  }
};

const rejectCliDecision = (
  output: CodaliImprovementCliJsonOutput,
  path: string,
  bag: ValidationBag,
): void => {
  if (output.decision) {
    pushIssue(
      bag,
      `${path}.decision`,
      "unexpected_decision",
      "This improvement CLI output type does not allow a policy decision payload.",
    );
  }
};

const rejectCliData = (
  record: Record<string, unknown>,
  path: string,
  bag: ValidationBag,
): void => {
  if (record.data !== undefined) {
    pushIssue(
      bag,
      `${path}.data`,
      "unexpected_data",
      "This improvement CLI output type does not allow a data payload.",
    );
  }
};

const validateRequiredCliData = <T>(
  record: Record<string, unknown>,
  path: string,
  validator: (input: unknown) => CodaliImprovementValidationResult<T>,
  bag: ValidationBag,
): void => {
  if (record.data === undefined) {
    pushIssue(
      bag,
      path,
      "missing_data",
      "This improvement CLI output type requires a data payload.",
    );
    return;
  }
  readNestedValidation(validator(record.data), path, bag);
};

const validateReleaseLevelContractArray = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(
      bag,
      path,
      "required_array",
      "Release level CLI data must be an array.",
    );
    return;
  }
  const seenLevels = new Set<CodaliImprovementReleaseLevel>();
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, [
      "level",
      "name",
      "description",
      "minAction",
      "allowedActions",
      "allowedArtifactTypes",
    ], bag);
    const rawLevel = record.level;
    const level = readReleaseLevel(record, "level", `${entryPath}.level`, bag);
    const name = readNonEmptyString(record, "name", `${entryPath}.name`, bag);
    const description = readNonEmptyString(
      record,
      "description",
      `${entryPath}.description`,
      bag,
    );
    const minAction = readEnumValue(
      record,
      "minAction",
      CODALI_IMPROVEMENT_POLICY_ACTIONS,
      `${entryPath}.minAction`,
      bag,
    );
    const allowedActions = readEnumArray(
      record,
      "allowedActions",
      CODALI_IMPROVEMENT_POLICY_ACTIONS,
      `${entryPath}.allowedActions`,
      bag,
    );
    const allowedArtifactTypes = readEnumArray(
      record,
      "allowedArtifactTypes",
      CODALI_IMPROVEMENT_ARTIFACT_TYPES,
      `${entryPath}.allowedArtifactTypes`,
      bag,
    );
    if (!isReleaseLevel(rawLevel)) return;
    if (seenLevels.has(level)) {
      pushIssue(
        bag,
        `${entryPath}.level`,
        "duplicate_release_level_contract",
        `Release level ${level} appears more than once.`,
      );
    }
    seenLevels.add(level);
    const expected = CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[level];
    if (
      name !== expected.name ||
      description !== expected.description ||
      minAction !== expected.minAction ||
      !sameStringSequence(allowedActions, expected.allowedActions) ||
      !sameStringSequence(allowedArtifactTypes, expected.allowedArtifactTypes)
    ) {
      pushIssue(
        bag,
        entryPath,
        "release_level_contract_mismatch",
        `Release level ${level} must match the canonical improvement contract.`,
      );
    }
  });
  for (const level of CODALI_IMPROVEMENT_RELEASE_LEVELS) {
    if (!seenLevels.has(level)) {
      pushIssue(
        bag,
        path,
        "missing_release_level_contract",
        `Release level ${level} is missing from CLI data.`,
      );
    }
  }
};

const validateMonitorReportData = (
  input: unknown,
): CodaliImprovementValidationResult<Record<string, unknown>> => {
  const bag: ValidationBag = { issues: [] };
  const record = requireRecord(input, "$", bag);
  if (!record) return fail(bag);
  assertAllowedKeys(record, "$", [
    "schemaVersion",
    "releaseId",
    "status",
    "generatedAt",
    "monitorWindow",
    "thresholds",
    "metrics",
    "runtimeFlags",
    "shadowTraffic",
    "rollbackTriggers",
    "rolloutEvents",
    "rollbackEvents",
    "outcome",
    "improvementCycleFeedback",
    "storageWrites",
  ], bag);
  readConstString(
    record,
    "schemaVersion",
    CODALI_IMPROVEMENT_MONITOR_REPORT_SCHEMA_VERSION,
    "$.schemaVersion",
    bag,
  );
  readNonEmptyString(record, "releaseId", "$.releaseId", bag);
  readEnumValue(
    record,
    "status",
    ["healthy", "watch", "rollback_required", "rolled_back"] as const,
    "$.status",
    bag,
  );
  readIsoLikeString(record, "generatedAt", "$.generatedAt", bag);
  validateMonitorWindow(record.monitorWindow, "$.monitorWindow", bag);
  validateMonitorThresholds(record.thresholds, "$.thresholds", bag);
  validateMonitorMetrics(record.metrics, "$.metrics", bag);
  validateMonitorRuntimeFlags(record.runtimeFlags, "$.runtimeFlags", bag);
  validateMonitorShadowTraffic(record.shadowTraffic, "$.shadowTraffic", bag);
  validateMonitorRollbackTriggers(record.rollbackTriggers, "$.rollbackTriggers", bag);
  validateMonitorRolloutEvents(record.rolloutEvents, "$.rolloutEvents", bag);
  validateMonitorRollbackEvents(record.rollbackEvents, "$.rollbackEvents", bag);
  readNestedValidation(validateCodaliImprovementOutcome(record.outcome), "$.outcome", bag);
  validateMonitorFeedback(
    record.improvementCycleFeedback,
    "$.improvementCycleFeedback",
    bag,
  );
  validateMonitorStorageWrites(record.storageWrites, "$.storageWrites", bag);
  return bag.issues.length > 0 ? fail(bag) : ok(record);
};

const validateMonitorWindow = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, ["startedAt", "endedAt", "durationMinutes"], bag);
  readIsoLikeString(record, "startedAt", `${path}.startedAt`, bag);
  readIsoLikeString(record, "endedAt", `${path}.endedAt`, bag);
  readPositiveInteger(record, "durationMinutes", `${path}.durationMinutes`, bag);
};

const validateMonitorThresholds = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, [
    "maxSchemaFailures",
    "minAcceptedAnswerRate",
    "maxAcceptedAnswerRateDrop",
    "maxVerifierContradictions",
    "maxToolFailures",
    "maxP95LatencyIncreaseRatio",
    "maxCostIncreaseRatio",
    "maxPrivacySecurityWarnings",
  ], bag);
  readNonNegativeInteger(record, "maxSchemaFailures", `${path}.maxSchemaFailures`, bag);
  readNonNegativeNumber(record, "minAcceptedAnswerRate", `${path}.minAcceptedAnswerRate`, bag);
  readNonNegativeNumber(
    record,
    "maxAcceptedAnswerRateDrop",
    `${path}.maxAcceptedAnswerRateDrop`,
    bag,
  );
  readNonNegativeInteger(
    record,
    "maxVerifierContradictions",
    `${path}.maxVerifierContradictions`,
    bag,
  );
  readNonNegativeInteger(record, "maxToolFailures", `${path}.maxToolFailures`, bag);
  readNonNegativeNumber(
    record,
    "maxP95LatencyIncreaseRatio",
    `${path}.maxP95LatencyIncreaseRatio`,
    bag,
  );
  readNonNegativeNumber(record, "maxCostIncreaseRatio", `${path}.maxCostIncreaseRatio`, bag);
  readNonNegativeInteger(
    record,
    "maxPrivacySecurityWarnings",
    `${path}.maxPrivacySecurityWarnings`,
    bag,
  );
};

const validateMonitorMetrics = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, [
    "eligibleRequestCount",
    "shadowRequestCount",
    "schemaFailures",
    "acceptedAnswerRate",
    "baselineAcceptedAnswerRate",
    "verifierContradictions",
    "toolFailures",
    "p95LatencyMs",
    "baselineP95LatencyMs",
    "costUsd",
    "baselineCostUsd",
    "privacySecurityWarnings",
  ], bag);
  readNonNegativeInteger(record, "eligibleRequestCount", `${path}.eligibleRequestCount`, bag);
  readNonNegativeInteger(record, "shadowRequestCount", `${path}.shadowRequestCount`, bag);
  readNonNegativeInteger(record, "schemaFailures", `${path}.schemaFailures`, bag);
  readOptionalRate(record, "acceptedAnswerRate", `${path}.acceptedAnswerRate`, bag);
  readOptionalRate(
    record,
    "baselineAcceptedAnswerRate",
    `${path}.baselineAcceptedAnswerRate`,
    bag,
  );
  readNonNegativeInteger(
    record,
    "verifierContradictions",
    `${path}.verifierContradictions`,
    bag,
  );
  readNonNegativeInteger(record, "toolFailures", `${path}.toolFailures`, bag);
  readOptionalNonNegativeNumber(record, "p95LatencyMs", `${path}.p95LatencyMs`, bag);
  readOptionalNonNegativeNumber(
    record,
    "baselineP95LatencyMs",
    `${path}.baselineP95LatencyMs`,
    bag,
  );
  readOptionalNonNegativeNumber(record, "costUsd", `${path}.costUsd`, bag);
  readOptionalNonNegativeNumber(record, "baselineCostUsd", `${path}.baselineCostUsd`, bag);
  readNonNegativeInteger(
    record,
    "privacySecurityWarnings",
    `${path}.privacySecurityWarnings`,
    bag,
  );
};

const validateMonitorRuntimeFlags = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(bag, path, "required_array", "runtimeFlags must be an array.");
    return;
  }
  const seen = new Set<string>();
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, [
      "packageKind",
      "version",
      "enabled",
      "disableOnRollback",
      "rollbackDisabled",
      "reason",
    ], bag);
    const packageKind = readEnumValue(
      record,
      "packageKind",
      CODALI_IMPROVEMENT_MONITOR_RUNTIME_PACKAGE_KINDS,
      `${entryPath}.packageKind`,
      bag,
    );
    if (seen.has(packageKind)) {
      pushIssue(
        bag,
        `${entryPath}.packageKind`,
        "duplicate_runtime_package_flag",
        `${packageKind} appears more than once.`,
      );
    }
    seen.add(packageKind);
    readNonEmptyString(record, "version", `${entryPath}.version`, bag);
    readBoolean(record, "enabled", `${entryPath}.enabled`, bag);
    readBoolean(record, "disableOnRollback", `${entryPath}.disableOnRollback`, bag);
    readBoolean(record, "rollbackDisabled", `${entryPath}.rollbackDisabled`, bag);
    readOptionalString(record, "reason", `${entryPath}.reason`, bag);
  });
  for (const packageKind of CODALI_IMPROVEMENT_MONITOR_RUNTIME_PACKAGE_KINDS) {
    if (!seen.has(packageKind)) {
      pushIssue(
        bag,
        path,
        "missing_runtime_package_flag",
        `${packageKind} must be represented in runtimeFlags.`,
      );
    }
  }
};

const validateMonitorShadowTraffic = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, [
    "enabled",
    "nonBlocking",
    "eligibleRequestCount",
    "shadowRequestCount",
    "coverageRate",
    "status",
  ], bag);
  readBoolean(record, "enabled", `${path}.enabled`, bag);
  if (record.nonBlocking !== true) {
    pushIssue(
      bag,
      `${path}.nonBlocking`,
      "non_blocking_shadow_required",
      "Shadow traffic must be non-blocking.",
    );
  }
  readNonNegativeInteger(record, "eligibleRequestCount", `${path}.eligibleRequestCount`, bag);
  readNonNegativeInteger(record, "shadowRequestCount", `${path}.shadowRequestCount`, bag);
  readNonNegativeNumber(record, "coverageRate", `${path}.coverageRate`, bag);
  readEnumValue(
    record,
    "status",
    ["not_eligible", "skipped", "partial", "completed"] as const,
    `${path}.status`,
    bag,
  );
};

const validateMonitorRollbackTriggers = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(bag, path, "required_array", "rollbackTriggers must be an array.");
    return;
  }
  const seen = new Set<string>();
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, [
      "code",
      "triggered",
      "observed",
      "threshold",
      "message",
    ], bag);
    const code = readEnumValue(
      record,
      "code",
      CODALI_IMPROVEMENT_MONITOR_ROLLBACK_TRIGGER_CODES,
      `${entryPath}.code`,
      bag,
    );
    if (seen.has(code)) {
      pushIssue(
        bag,
        `${entryPath}.code`,
        "duplicate_rollback_trigger",
        `${code} appears more than once.`,
      );
    }
    seen.add(code);
    readBoolean(record, "triggered", `${entryPath}.triggered`, bag);
    readNonNegativeNumber(record, "observed", `${entryPath}.observed`, bag);
    readNonNegativeNumber(record, "threshold", `${entryPath}.threshold`, bag);
    readNonEmptyString(record, "message", `${entryPath}.message`, bag);
  });
  for (const code of CODALI_IMPROVEMENT_MONITOR_ROLLBACK_TRIGGER_CODES) {
    if (!seen.has(code)) {
      pushIssue(
        bag,
        path,
        "missing_rollback_trigger",
        `${code} must be represented in rollbackTriggers.`,
      );
    }
  }
};

const validateMonitorRolloutEvents = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(bag, path, "required_array", "rolloutEvents must be an array.");
    return;
  }
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, [
      "eventId",
      "releaseId",
      "eventType",
      "createdAt",
      "metadata",
    ], bag);
    readNonEmptyString(record, "eventId", `${entryPath}.eventId`, bag);
    readNonEmptyString(record, "releaseId", `${entryPath}.releaseId`, bag);
    readEnumValue(
      record,
      "eventType",
      [
        "monitor_started",
        "runtime_flags_applied",
        "shadow_traffic_started",
        "shadow_traffic_completed",
      ] as const,
      `${entryPath}.eventType`,
      bag,
    );
    readIsoLikeString(record, "createdAt", `${entryPath}.createdAt`, bag);
    requireRecord(record.metadata, `${entryPath}.metadata`, bag);
  });
};

const validateMonitorRollbackEvents = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(bag, path, "required_array", "rollbackEvents must be an array.");
    return;
  }
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, [
      "eventId",
      "releaseId",
      "eventType",
      "createdAt",
      "triggerCodes",
      "runtimePackageKind",
      "runtimePackageVersion",
      "unpublishNpm",
      "metadata",
    ], bag);
    readNonEmptyString(record, "eventId", `${entryPath}.eventId`, bag);
    readNonEmptyString(record, "releaseId", `${entryPath}.releaseId`, bag);
    readEnumValue(
      record,
      "eventType",
      ["rollback_triggered", "runtime_package_disabled", "rollback_applied"] as const,
      `${entryPath}.eventType`,
      bag,
    );
    readIsoLikeString(record, "createdAt", `${entryPath}.createdAt`, bag);
    readEnumArray(
      record,
      "triggerCodes",
      CODALI_IMPROVEMENT_MONITOR_ROLLBACK_TRIGGER_CODES,
      `${entryPath}.triggerCodes`,
      bag,
    );
    readOptionalEnumValue(
      record,
      "runtimePackageKind",
      CODALI_IMPROVEMENT_MONITOR_RUNTIME_PACKAGE_KINDS,
      `${entryPath}.runtimePackageKind`,
      bag,
    );
    readOptionalString(
      record,
      "runtimePackageVersion",
      `${entryPath}.runtimePackageVersion`,
      bag,
    );
    if (record.unpublishNpm !== false) {
      pushIssue(
        bag,
        `${entryPath}.unpublishNpm`,
        "rollback_must_not_unpublish_npm",
        "Rollback events must disable runtime packages without unpublishing npm.",
      );
    }
    requireRecord(record.metadata, `${entryPath}.metadata`, bag);
  });
};

const validateMonitorFeedback = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, [
    "status",
    "releaseId",
    "nextCycleReasons",
    "recommendedArtifactTypes",
    "source",
  ], bag);
  readEnumValue(record, "status", ["recorded", "queued"] as const, `${path}.status`, bag);
  readNonEmptyString(record, "releaseId", `${path}.releaseId`, bag);
  readStringArray(record, "nextCycleReasons", `${path}.nextCycleReasons`, bag);
  readStringArray(record, "recommendedArtifactTypes", `${path}.recommendedArtifactTypes`, bag);
  readConstString(record, "source", "release_monitor", `${path}.source`, bag);
};

const validateMonitorStorageWrites = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  if (!Array.isArray(input)) {
    pushIssue(bag, path, "required_array", "storageWrites must be an array.");
    return;
  }
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, bag);
    if (!record) return;
    assertAllowedKeys(record, entryPath, ["accepted", "status", "scope"], bag);
    readBoolean(record, "accepted", `${entryPath}.accepted`, bag);
    readNonNegativeInteger(record, "status", `${entryPath}.status`, bag);
    validateMonitorStorageScope(record.scope, `${entryPath}.scope`, bag);
  });
};

const validateMonitorStorageScope = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): void => {
  const record = requireRecord(input, path, bag);
  if (!record) return;
  assertAllowedKeys(record, path, ["tenantId", "productId", "deploymentId", "runId"], bag);
  readNonEmptyString(record, "tenantId", `${path}.tenantId`, bag);
  readNonEmptyString(record, "productId", `${path}.productId`, bag);
  readNonEmptyString(record, "deploymentId", `${path}.deploymentId`, bag);
  readNonEmptyString(record, "runId", `${path}.runId`, bag);
};

const validatePolicyInvariants = (
  policy: CodaliImprovementPolicy,
  path: string,
  bag: ValidationBag,
): void => {
  const allowedForLevel = getCodaliImprovementAllowedArtifactTypesForLevel(
    policy.releaseLevel,
  );
  for (const artifactType of policy.allowedArtifactTypes) {
    if (!allowedForLevel.includes(artifactType)) {
      pushIssue(
        bag,
        `${path}.allowedArtifactTypes`,
        "artifact_type_exceeds_release_level",
        `${artifactType} is not allowed for release level ${policy.releaseLevel}`,
      );
    }
  }
  if (policy.autoTagEnabled && policy.releaseLevel < 3) {
    pushIssue(
      bag,
      `${path}.autoTagEnabled`,
      "auto_tag_requires_level_3",
      "auto-tagging requires release level 3 or higher.",
    );
  }
  if (policy.autoPublishEnabled && policy.releaseLevel < 4) {
    pushIssue(
      bag,
      `${path}.autoPublishEnabled`,
      "auto_publish_requires_level_4",
      "auto-publish requires release level 4.",
    );
  }
  if (policy.trainingEnabled && policy.maxExamples <= 0) {
    pushIssue(
      bag,
      `${path}.trainingEnabled`,
      "training_requires_examples",
      "Training cannot be enabled when maxExamples is zero.",
    );
  }
};

const validateReleaseInvariants = (
  release: CodaliImprovementRelease,
  path: string,
  bag: ValidationBag,
): void => {
  if (release.releaseLevel >= 3 && !release.tagName) {
    pushIssue(
      bag,
      `${path}.tagName`,
      "release_level_requires_tag",
      "Release levels 3 and 4 require an explicit tagName.",
    );
  }
  if (release.releaseLevel === 4 && (!release.packageName || !release.version)) {
    pushIssue(
      bag,
      path,
      "stable_release_requires_package_version",
      "Release level 4 requires packageName and version.",
    );
  }
  if (
    (release.status === "blocked" || release.status === "failed") &&
    (!release.blockedReasons || release.blockedReasons.length === 0)
  ) {
    pushIssue(
      bag,
      `${path}.blockedReasons`,
      "blocked_release_requires_reason",
      "Blocked or failed releases must retain at least one reason.",
    );
  }
};

const validateOutcomeInvariants = (
  outcome: CodaliImprovementOutcome,
  path: string,
  bag: ValidationBag,
): void => {
  if (
    (outcome.status === "failed" ||
      outcome.status === "degraded" ||
      outcome.status === "blocked") &&
    (!outcome.reasons || outcome.reasons.length === 0)
  ) {
    pushIssue(
      bag,
      `${path}.reasons`,
      "non_success_outcome_requires_reason",
      "Failed, degraded, or blocked outcomes must retain at least one reason.",
    );
  }
};

const levelAllowsAction = (
  level: CodaliImprovementReleaseLevel,
  action: CodaliImprovementPolicyAction,
): boolean => {
  const allowedActions: readonly CodaliImprovementPolicyAction[] =
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[level].allowedActions;
  return allowedActions.includes(action);
};

const sameScope = (
  left: CodaliImprovementScope,
  right: CodaliImprovementScope,
): boolean =>
  left.tenantHash === right.tenantHash &&
  left.productId === right.productId &&
  (left.deploymentId ?? "") === (right.deploymentId ?? "");

const isReleaseLevel = (value: unknown): value is CodaliImprovementReleaseLevel =>
  typeof value === "number" &&
  CODALI_IMPROVEMENT_RELEASE_LEVELS.includes(
    value as CodaliImprovementReleaseLevel,
  );

const validateScope = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliImprovementScope | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) return undefined;
  assertAllowedKeys(record, path, ["tenantHash", "productId", "deploymentId"], bag);
  return withoutUndefined({
    tenantHash: readNonEmptyString(record, "tenantHash", `${path}.tenantHash`, bag),
    productId: readNonEmptyString(record, "productId", `${path}.productId`, bag),
    deploymentId: readOptionalString(
      record,
      "deploymentId",
      `${path}.deploymentId`,
      bag,
    ),
  });
};

const validateGateWithBag = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): CodaliImprovementGate | undefined => {
  const record = requireRecord(input, path, bag);
  if (!record) return undefined;
  assertAllowedKeys(record, path, [
    "schemaVersion",
    "gateId",
    "candidateId",
    "gateType",
    "status",
    "required",
    "passed",
    "createdAt",
    "score",
    "reasons",
    "metadata",
  ], bag);
  const status = readEnumValue(
    record,
    "status",
    ["passed", "failed", "blocked", "skipped", "warning"] as const,
    `${path}.status`,
    bag,
  );
  const reasons = readOptionalStringArray(record, "reasons", `${path}.reasons`, bag);
  if (status === "skipped" && (!reasons || reasons.length === 0)) {
    pushIssue(
      bag,
      `${path}.reasons`,
      "skipped_gate_reasons_required",
      "Skipped gates must include at least one exact reason.",
    );
  }
  return withoutUndefined({
    schemaVersion: readConstString(
      record,
      "schemaVersion",
      CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      `${path}.schemaVersion`,
      bag,
    ),
    gateId: readNonEmptyString(record, "gateId", `${path}.gateId`, bag),
    candidateId: readNonEmptyString(
      record,
      "candidateId",
      `${path}.candidateId`,
      bag,
    ),
    gateType: readEnumValue(
      record,
      "gateType",
      ["policy", "privacy", "eval", "replay", "release", "manual_review"] as const,
      `${path}.gateType`,
      bag,
    ),
    status,
    required: readBoolean(record, "required", `${path}.required`, bag),
    passed: readBoolean(record, "passed", `${path}.passed`, bag),
    createdAt: readIsoLikeString(record, "createdAt", `${path}.createdAt`, bag),
    score: readOptionalNumber(record, "score", `${path}.score`, bag),
    reasons,
    metadata: readOptionalRecord(record, "metadata", `${path}.metadata`, bag),
  });
};

const readGateArray = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): CodaliImprovementGate[] => {
  const value = record[key];
  if (!Array.isArray(value)) {
    pushIssue(bag, path, "required_array", `${key} must be an array.`);
    return [];
  }
  return value
    .map((entry, index) => validateGateWithBag(entry, `${path}[${index}]`, bag))
    .filter((entry): entry is CodaliImprovementGate => Boolean(entry));
};

const readScores = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): Record<string, number> => {
  const value = record[key];
  if (!isRecord(value)) {
    pushIssue(bag, path, "required_object", `${key} must be an object.`);
    return {};
  }
  const scores: Record<string, number> = {};
  for (const [scoreKey, scoreValue] of Object.entries(value)) {
    if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue)) {
      pushIssue(
        bag,
        `${path}.${scoreKey}`,
        "invalid_number",
        "Score values must be finite numbers.",
      );
      continue;
    }
    scores[scoreKey] = scoreValue;
  }
  return scores;
};

const readIssueArray = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): CodaliImprovementValidationIssue[] => {
  const value = record[key];
  if (!Array.isArray(value)) {
    pushIssue(bag, path, "required_array", `${key} must be an array.`);
    return [];
  }
  const issues: CodaliImprovementValidationIssue[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const issueRecord = requireRecord(entry, entryPath, bag);
    if (!issueRecord) return;
    assertAllowedKeys(issueRecord, entryPath, ["path", "code", "message"], bag);
    issues.push({
      path: readNonEmptyString(issueRecord, "path", `${entryPath}.path`, bag),
      code: readNonEmptyString(issueRecord, "code", `${entryPath}.code`, bag),
      message: readNonEmptyString(
        issueRecord,
        "message",
        `${entryPath}.message`,
        bag,
      ),
    });
  });
  return issues;
};

const readNestedValidation = <T>(
  result: CodaliImprovementValidationResult<T>,
  path: string,
  bag: ValidationBag,
): T | undefined => {
  if (result.ok) return result.value;
  for (const issue of result.issues) {
    pushIssue(
      bag,
      `${path}${issue.path === "$" ? "" : issue.path.slice(1)}`,
      issue.code,
      issue.message,
    );
  }
  return undefined;
};

const readReleaseLevel = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): CodaliImprovementReleaseLevel => {
  const value = record[key];
  if (!isReleaseLevel(value)) {
    pushIssue(
      bag,
      path,
      "invalid_release_level",
      `${key} must be one of ${CODALI_IMPROVEMENT_RELEASE_LEVELS.join(", ")}.`,
    );
    return 0;
  }
  return value;
};

const readEnumArray = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  bag: ValidationBag,
): T[] => {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    pushIssue(bag, path, "required_array", `${key} must be a non-empty array.`);
    return [];
  }
  const seen = new Set<string>();
  const output: T[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !allowed.includes(entry as T)) {
      pushIssue(
        bag,
        `${path}[${index}]`,
        "invalid_enum",
        `${key} contains an unsupported value.`,
      );
      return;
    }
    if (seen.has(entry)) {
      pushIssue(
        bag,
        `${path}[${index}]`,
        "duplicate_value",
        `${key} cannot contain duplicate values.`,
      );
      return;
    }
    seen.add(entry);
    output.push(entry as T);
  });
  return output;
};

const readStringArray = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): string[] => {
  const value = record[key];
  if (!Array.isArray(value)) {
    pushIssue(bag, path, "required_array", `${key} must be an array.`);
    return [];
  }
  return normalizeStringArray(value, key, path, bag);
};

const readOptionalStringArray = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): string[] | undefined => {
  if (record[key] === undefined) return undefined;
  return readStringArray(record, key, path, bag);
};

const normalizeStringArray = (
  value: unknown[],
  key: string,
  path: string,
  bag: ValidationBag,
): string[] => {
  const output: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      pushIssue(
        bag,
        `${path}[${index}]`,
        "invalid_string",
        `${key} must contain only non-empty strings.`,
      );
      return;
    }
    output.push(entry);
  });
  return output;
};

const readEnumValue = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  bag: ValidationBag,
): T => {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    pushIssue(bag, path, "invalid_enum", `${key} contains an unsupported value.`);
    return allowed[0] as T;
  }
  return value as T;
};

const readOptionalEnumValue = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  bag: ValidationBag,
): T | undefined => {
  if (record[key] === undefined) return undefined;
  return readEnumValue(record, key, allowed, path, bag);
};

const readConstString = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: T,
  path: string,
  bag: ValidationBag,
): T => {
  if (record[key] !== expected) {
    pushIssue(bag, path, "invalid_const", `${key} must be ${expected}.`);
  }
  return expected;
};

const readNonEmptyString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    pushIssue(bag, path, "required_string", `${key} must be a non-empty string.`);
    return "";
  }
  return value;
};

const readOptionalString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): string | undefined => {
  if (record[key] === undefined) return undefined;
  return readNonEmptyString(record, key, path, bag);
};

const readIsoLikeString = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): string => {
  const value = readNonEmptyString(record, key, path, bag);
  if (value && Number.isNaN(Date.parse(value))) {
    pushIssue(bag, path, "invalid_timestamp", `${key} must be parseable as a timestamp.`);
  }
  return value;
};

const readBoolean = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): boolean => {
  const value = record[key];
  if (typeof value !== "boolean") {
    pushIssue(bag, path, "required_boolean", `${key} must be a boolean.`);
    return false;
  }
  return value;
};

const readNonNegativeInteger = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number => {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    pushIssue(
      bag,
      path,
      "required_non_negative_integer",
      `${key} must be a non-negative integer.`,
    );
    return 0;
  }
  return value as number;
};

const readPositiveInteger = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number => {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    pushIssue(
      bag,
      path,
      "required_positive_integer",
      `${key} must be a positive integer.`,
    );
    return 1;
  }
  return value as number;
};

const readNonNegativeNumber = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    pushIssue(
      bag,
      path,
      "required_non_negative_number",
      `${key} must be a finite non-negative number.`,
    );
    return 0;
  }
  return value;
};

const readOptionalNumber = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number | undefined => {
  if (record[key] === undefined) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(bag, path, "invalid_number", `${key} must be a finite number.`);
    return undefined;
  }
  return value;
};

const readOptionalNonNegativeNumber = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number | undefined => {
  if (record[key] === undefined) return undefined;
  const value = readOptionalNumber(record, key, path, bag);
  if (value !== undefined && value < 0) {
    pushIssue(
      bag,
      path,
      "invalid_non_negative_number",
      `${key} must be non-negative.`,
    );
    return undefined;
  }
  return value;
};

const readOptionalRate = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): number | undefined => {
  const value = readOptionalNonNegativeNumber(record, key, path, bag);
  if (value !== undefined && value > 1) {
    pushIssue(bag, path, "invalid_rate", `${key} must be between 0 and 1.`);
    return undefined;
  }
  return value;
};

const readOptionalRecord = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(bag, path, "invalid_object", `${key} must be an object.`);
    return undefined;
  }
  return value;
};

const readOptionalNumberRecord = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  bag: ValidationBag,
): Record<string, number> | undefined => {
  if (record[key] === undefined) return undefined;
  return readScores(record, key, path, bag);
};

const requireRecord = (
  input: unknown,
  path: string,
  bag: ValidationBag,
): Record<string, unknown> | undefined => {
  if (!isRecord(input)) {
    pushIssue(bag, path, "required_object", "Value must be an object.");
    return undefined;
  }
  return input;
};

const assertAllowedKeys = (
  record: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  bag: ValidationBag,
): void => {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      pushIssue(
        bag,
        `${path}.${key}`,
        "unknown_field",
        `${key} is not part of the strict improvement contract.`,
      );
    }
    if (
      record[key] === undefined &&
      !STRING_ARRAY_KEYS.has(key)
    ) {
      pushIssue(
        bag,
        `${path}.${key}`,
        "undefined_field",
        `${key} must be omitted instead of set to undefined.`,
      );
    }
  }
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const ok = <T>(value: T): CodaliImprovementValidationResult<T> => ({
  ok: true,
  value,
  issues: [],
});

const fail = <T>(
  bag: ValidationBag,
): CodaliImprovementValidationResult<T> => ({
  ok: false,
  issues: bag.issues,
});

const pushIssue = (
  bag: ValidationBag,
  path: string,
  code: string,
  message: string,
): void => {
  bag.issues.push({ path, code, message });
};

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values));

const sameStringSequence = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const fallbackScope = (): CodaliImprovementScope => ({
  tenantHash: "",
  productId: "",
});

const fallbackGate = (): CodaliImprovementGate => ({
  schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  gateId: "",
  candidateId: "",
  gateType: "policy",
  status: "blocked",
  required: true,
  passed: false,
  createdAt: new Date(0).toISOString(),
});

const withoutUndefined = <T extends Record<string, unknown>>(input: T): T => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
};
