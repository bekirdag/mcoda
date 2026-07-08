import { createHmac } from "node:crypto";
import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  isCodaliStoragePrivacyExportAllowed,
  isCodaliStoragePrivacyTrainingAllowed,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStorageObjectRef,
  type CodaliStorageObjectRetentionClass,
  type CodaliStoragePrivacyClassification,
  type CodaliStoragePrivacyMetadata,
} from "./CodaliStorageContracts.js";

export type CodaliDatasetPrivacyPurpose =
  | "training"
  | "export"
  | "eval"
  | "replay"
  | "durable_persistence";

export type CodaliDatasetSecretFindingKind =
  | "sensitive_key"
  | "bearer_token"
  | "openai_api_key"
  | "cloud_access_key"
  | "github_token"
  | "jwt"
  | "private_key"
  | "env_secret_assignment";

export type CodaliDatasetEligibilityBlockerCode =
  | "secrets_detected"
  | "privacy_training_not_allowed"
  | "privacy_export_not_allowed"
  | "object_training_not_allowed"
  | "object_export_not_allowed"
  | "object_eval_not_allowed"
  | "object_replay_not_allowed"
  | "retention_do_not_store"
  | "redaction_required"
  | "policy_override_requires_admin_audit"
  | "policy_override_not_requested"
  | "policy_override_hard_blocked";

export interface CodaliDatasetSecretFinding {
  kind: CodaliDatasetSecretFindingKind;
  path: string;
  redacted: boolean;
}

export interface CodaliDatasetSecretDetectionResult<TPayload = unknown> {
  containsSecrets: boolean;
  findings: CodaliDatasetSecretFinding[];
  redactedPayload: TPayload;
}

export interface CodaliDatasetTenantScope {
  tenantId: string;
  tenantSalt: string;
}

export interface CodaliDatasetIdentifierInput {
  tenantId: string;
  requesterId?: string;
  conversationId?: string;
  repoId?: string;
  sourceId?: string;
  reviewerId?: string;
  deletionGroupId?: string;
}

export interface CodaliDatasetHashedIdentifiers {
  tenantHash: string;
  requesterHash?: string;
  conversationHash?: string;
  repoHash?: string;
  sourceHash?: string;
  reviewerHash?: string;
  deletionGroupHash?: string;
}

export interface CodaliDatasetPrivacyAllowances {
  uploadAllowed?: boolean;
  trainingAllowed?: boolean;
  evalAllowed?: boolean;
  replayAllowed?: boolean;
  exportAllowed?: boolean;
}

export interface CodaliDatasetPrivacyMetadataInput {
  tenant: CodaliDatasetTenantScope;
  identifiers: Omit<CodaliDatasetIdentifierInput, "tenantId">;
  inputPayload?: unknown;
  outputPayload?: unknown;
  evidencePayloads?: unknown[];
  classification?: CodaliStoragePrivacyClassification;
  containsPersonalData?: boolean;
  containsTenantPrivateData?: boolean;
  containsSourceCode?: boolean;
  containsCustomerData?: boolean;
  personalDataRedacted?: boolean;
  allowances?: CodaliDatasetPrivacyAllowances;
  retentionClass?: CodaliStorageObjectRetentionClass;
  policyTags?: string[];
  retentionUntil?: string;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface CodaliDatasetPrivacyEnvelope {
  privacy: CodaliStoragePrivacyMetadata;
  privacyFlags: CodaliStorageObjectPrivacyFlags;
  hashedIdentifiers: CodaliDatasetHashedIdentifiers;
  redactedPayloads: {
    inputPayload?: unknown;
    outputPayload?: unknown;
    evidencePayloads?: unknown[];
  };
  secretFindings: CodaliDatasetSecretFinding[];
  eligibility: {
    trainingAllowed: boolean;
    evalAllowed: boolean;
    replayAllowed: boolean;
    exportAllowed: boolean;
    durablePersistenceAllowed: boolean;
    blockers: CodaliDatasetEligibilityBlocker[];
  };
}

export interface CodaliDatasetEligibilityBlocker {
  code: CodaliDatasetEligibilityBlockerCode;
  message: string;
  path?: string;
}

export interface CodaliDatasetEligibilityDecision {
  purpose: CodaliDatasetPrivacyPurpose;
  allowed: boolean;
  blockers: CodaliDatasetEligibilityBlocker[];
  auditEvents?: CodaliDatasetPolicyAuditEvent[];
}

export interface CodaliDatasetPolicyOverride {
  purpose: CodaliDatasetPrivacyPurpose;
  allow: boolean;
  adminActorId?: string;
  auditEventId?: string;
  reason?: string;
  approvedAt?: string;
}

export interface CodaliDatasetPolicyAuditEvent {
  auditEventId: string;
  adminActorId: string;
  purpose: CodaliDatasetPrivacyPurpose;
  reason: string;
  approvedAt: string;
  originalBlockers: CodaliDatasetEligibilityBlockerCode[];
}

export interface CodaliDatasetPayloadReadInput<TPayload> {
  purpose: Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">;
  objectRef: CodaliStorageObjectRef;
  privacy: CodaliStoragePrivacyMetadata;
  policyOverride?: CodaliDatasetPolicyOverride;
  readPayload: (objectRef: CodaliStorageObjectRef) => Promise<TPayload> | TPayload;
}

export type CodaliDatasetPayloadReadResult<TPayload> =
  | {
      ok: true;
      decision: CodaliDatasetEligibilityDecision;
      payload: TPayload;
    }
  | {
      ok: false;
      decision: CodaliDatasetEligibilityDecision;
    };

export class CodaliDatasetPrivacyError extends Error {
  readonly decision: CodaliDatasetEligibilityDecision;

  constructor(decision: CodaliDatasetEligibilityDecision) {
    super(
      `Codali dataset privacy check failed for ${decision.purpose}: ${decision.blockers
        .map((blocker) => blocker.code)
        .join(", ")}`,
    );
    this.name = "CodaliDatasetPrivacyError";
    this.decision = decision;
  }
}

const REDACTION_TOKEN = "[redacted]";

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /(^|[_-])(api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|authorization|auth[_-]?token|private[_-]?key|signing[_-]?key)([_-]|$)/i,
];

const SECRET_VALUE_PATTERNS: readonly {
  kind: CodaliDatasetSecretFindingKind;
  pattern: RegExp;
}[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g },
  { kind: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "cloud_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: "env_secret_assignment",
    pattern:
      /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)=["']?[^"'\s]{8,}["']?/gi,
  },
];

const PERSONAL_KEY_PATTERNS: readonly RegExp[] = [
  /(^|[_-])(email|phone|ssn|person|user[_-]?id|requester)([_-]|$)/i,
];

const PERSONAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
];

const HARD_OVERRIDE_BLOCKERS = new Set<CodaliDatasetEligibilityBlockerCode>([
  "secrets_detected",
  "retention_do_not_store",
  "redaction_required",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeIdentifier = (value: string | undefined): string | undefined => {
  if (!hasText(value)) return undefined;
  return value.trim();
};

const pathForKey = (basePath: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${basePath}.${key}`
    : `${basePath}[${JSON.stringify(key)}]`;

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));

const isPersonalKey = (key: string): boolean =>
  PERSONAL_KEY_PATTERNS.some((pattern) => pattern.test(key));

const stringContainsPersonalData = (value: string): boolean =>
  PERSONAL_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });

const redactString = (
  value: string,
  path: string,
  findings: CodaliDatasetSecretFinding[],
): string => {
  let redacted = value;
  for (const { kind, pattern } of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(redacted)) continue;
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, () => {
      findings.push({ kind, path, redacted: true });
      return REDACTION_TOKEN;
    });
  }
  return redacted;
};

const redactPayloadValue = (
  value: unknown,
  path: string,
  findings: CodaliDatasetSecretFinding[],
): unknown => {
  if (typeof value === "string") return redactString(value, path, findings);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactPayloadValue(item, `${path}[${index}]`, findings),
    );
  }
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = pathForKey(path, key);
    if (isSensitiveKey(key) && child !== null && child !== undefined && child !== "") {
      findings.push({ kind: "sensitive_key", path: childPath, redacted: true });
      redacted[key] = REDACTION_TOKEN;
      continue;
    }
    redacted[key] = redactPayloadValue(child, childPath, findings);
  }
  return redacted;
};

const payloadContainsPersonalData = (value: unknown): boolean => {
  if (typeof value === "string") return stringContainsPersonalData(value);
  if (Array.isArray(value)) return value.some(payloadContainsPersonalData);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => isPersonalKey(key) || payloadContainsPersonalData(child),
  );
};

const metadataContainsSecrets = (privacy: CodaliStoragePrivacyMetadata): boolean =>
  privacy.metadata?.containsSecrets === true ||
  privacy.metadata?.contains_secrets === true;

const addBlocker = (
  blockers: CodaliDatasetEligibilityBlocker[],
  code: CodaliDatasetEligibilityBlockerCode,
  message: string,
  path?: string,
): void => {
  blockers.push(path ? { code, message, path } : { code, message });
};

export const detectAndRedactCodaliDatasetSecrets = <TPayload = unknown>(
  payload: TPayload,
): CodaliDatasetSecretDetectionResult<TPayload> => {
  const findings: CodaliDatasetSecretFinding[] = [];
  const redactedPayload = redactPayloadValue(payload, "$", findings) as TPayload;
  return {
    containsSecrets: findings.length > 0,
    findings,
    redactedPayload,
  };
};

export const hashCodaliDatasetIdentifier = (
  tenant: CodaliDatasetTenantScope,
  scope: keyof CodaliDatasetHashedIdentifiers,
  value: string,
): string => {
  const normalizedTenantId = tenant.tenantId.trim();
  const normalizedTenantSalt = tenant.tenantSalt.trim();
  const normalizedValue = value.trim();
  if (!normalizedTenantId) {
    throw new Error("tenantId is required for Codali dataset identifier hashing");
  }
  if (!normalizedTenantSalt) {
    throw new Error("tenantSalt is required for Codali dataset identifier hashing");
  }
  if (!normalizedValue) {
    throw new Error("value is required for Codali dataset identifier hashing");
  }
  const digest = createHmac(
    "sha256",
    `${normalizedTenantSalt}:${normalizedTenantId}`,
  )
    .update(`${scope}:${normalizedValue}`)
    .digest("hex");
  return `sha256:${digest}`;
};

export const hashCodaliDatasetIdentifiers = (
  tenant: CodaliDatasetTenantScope,
  identifiers: Omit<CodaliDatasetIdentifierInput, "tenantId">,
): CodaliDatasetHashedIdentifiers => {
  const tenantId = normalizeIdentifier(tenant.tenantId);
  if (!tenantId) {
    throw new Error("tenantId is required for Codali dataset identifier hashing");
  }

  const hashOptional = (
    scope: keyof CodaliDatasetHashedIdentifiers,
    value: string | undefined,
  ): string | undefined => {
    const normalized = normalizeIdentifier(value);
    return normalized
      ? hashCodaliDatasetIdentifier(tenant, scope, normalized)
      : undefined;
  };

  return {
    tenantHash: hashCodaliDatasetIdentifier(tenant, "tenantHash", tenantId),
    requesterHash: hashOptional("requesterHash", identifiers.requesterId),
    conversationHash: hashOptional("conversationHash", identifiers.conversationId),
    repoHash: hashOptional("repoHash", identifiers.repoId),
    sourceHash: hashOptional("sourceHash", identifiers.sourceId),
    reviewerHash: hashOptional("reviewerHash", identifiers.reviewerId),
    deletionGroupHash: hashOptional(
      "deletionGroupHash",
      identifiers.deletionGroupId,
    ),
  };
};

export const evaluateCodaliDatasetDurablePersistence = (
  retentionClass: CodaliStorageObjectRetentionClass,
): CodaliDatasetEligibilityDecision => {
  const blockers: CodaliDatasetEligibilityBlocker[] = [];
  if (retentionClass === "do_not_store") {
    addBlocker(
      blockers,
      "retention_do_not_store",
      "Durable persistence is rejected for retention_class=do_not_store.",
      "$.retentionClass",
    );
  }
  return {
    purpose: "durable_persistence",
    allowed: blockers.length === 0,
    blockers,
  };
};

export const evaluateCodaliDatasetObjectPayloadRead = (
  purpose: Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">,
  objectRef: CodaliStorageObjectRef,
  privacy: CodaliStoragePrivacyMetadata,
): CodaliDatasetEligibilityDecision => {
  const blockers: CodaliDatasetEligibilityBlocker[] = [];

  if (objectRef.retentionClass === "do_not_store") {
    addBlocker(
      blockers,
      "retention_do_not_store",
      "Object payload reads are rejected for retention_class=do_not_store.",
      "$.retentionClass",
    );
  }

  const containsSecrets =
    objectRef.privacyFlags.containsSecrets || metadataContainsSecrets(privacy);
  if ((purpose === "training" || purpose === "export") && containsSecrets) {
    addBlocker(
      blockers,
      "secrets_detected",
      "Records containing secrets cannot be training or export eligible.",
      "$.privacyFlags.containsSecrets",
    );
  }

  if (
    (purpose === "training" || purpose === "export") &&
    privacy.containsPersonalData &&
    privacy.redactionStatus !== "redacted"
  ) {
    addBlocker(
      blockers,
      "redaction_required",
      "Personal data must be redacted before training or export reads.",
      "$.privacy.redactionStatus",
    );
  }

  if (purpose === "training") {
    if (!isCodaliStoragePrivacyTrainingAllowed(privacy)) {
      addBlocker(
        blockers,
        "privacy_training_not_allowed",
        "Privacy metadata does not allow training.",
        "$.privacy.trainingAllowed",
      );
    }
    if (!objectRef.privacyFlags.trainingAllowed) {
      addBlocker(
        blockers,
        "object_training_not_allowed",
        "Object privacy flags do not allow training.",
        "$.privacyFlags.trainingAllowed",
      );
    }
  }

  if (purpose === "export") {
    if (!isCodaliStoragePrivacyExportAllowed(privacy)) {
      addBlocker(
        blockers,
        "privacy_export_not_allowed",
        "Privacy metadata does not allow export.",
        "$.privacy.exportAllowed",
      );
    }
    if (!objectRef.privacyFlags.exportAllowed) {
      addBlocker(
        blockers,
        "object_export_not_allowed",
        "Object privacy flags do not allow export.",
        "$.privacyFlags.exportAllowed",
      );
    }
  }

  if (purpose === "eval" && !objectRef.privacyFlags.evalAllowed) {
    addBlocker(
      blockers,
      "object_eval_not_allowed",
      "Object privacy flags do not allow eval reads.",
      "$.privacyFlags.evalAllowed",
    );
  }

  if (purpose === "replay" && !objectRef.privacyFlags.replayAllowed) {
    addBlocker(
      blockers,
      "object_replay_not_allowed",
      "Object privacy flags do not allow replay reads.",
      "$.privacyFlags.replayAllowed",
    );
  }

  return {
    purpose,
    allowed: blockers.length === 0,
    blockers,
  };
};

type CodaliDatasetAuditedPolicyOverride = CodaliDatasetPolicyOverride & {
  adminActorId: string;
  auditEventId: string;
  reason: string;
};

const hasAdminAudit = (
  override: CodaliDatasetPolicyOverride,
): override is CodaliDatasetAuditedPolicyOverride =>
  override.allow === true &&
  hasText(override.adminActorId) &&
  hasText(override.auditEventId) &&
  hasText(override.reason);

export const applyCodaliDatasetPolicyOverride = (
  decision: CodaliDatasetEligibilityDecision,
  override?: CodaliDatasetPolicyOverride,
): CodaliDatasetEligibilityDecision => {
  if (!override) return decision;

  if (!override.allow || override.purpose !== decision.purpose) {
    return decision.allowed
      ? decision
      : {
          ...decision,
          blockers: [
            ...decision.blockers,
            {
              code: "policy_override_not_requested",
              message: "No matching policy override was requested.",
            },
          ],
        };
  }

  if (!hasAdminAudit(override)) {
    return {
      ...decision,
      allowed: false,
      blockers: [
        ...decision.blockers,
        {
          code: "policy_override_requires_admin_audit",
          message:
            "Policy overrides require an admin actor, audit event id, reason, and explicit allow=true.",
        },
      ],
    };
  }

  const hardBlockers = decision.blockers.filter((blocker) =>
    HARD_OVERRIDE_BLOCKERS.has(blocker.code),
  );
  if (hardBlockers.length > 0) {
    return {
      ...decision,
      allowed: false,
      blockers: [
        ...decision.blockers,
        {
          code: "policy_override_hard_blocked",
          message:
            "Policy override cannot bypass secrets, required redaction, or do_not_store retention.",
        },
      ],
    };
  }

  const auditEvent: CodaliDatasetPolicyAuditEvent = {
    auditEventId: override.auditEventId.trim(),
    adminActorId: override.adminActorId.trim(),
    purpose: decision.purpose,
    reason: override.reason.trim(),
    approvedAt: override.approvedAt ?? new Date().toISOString(),
    originalBlockers: decision.blockers.map((blocker) => blocker.code),
  };

  return {
    purpose: decision.purpose,
    allowed: true,
    blockers: [],
    auditEvents: [...(decision.auditEvents ?? []), auditEvent],
  };
};

export const assertCodaliDatasetObjectPayloadReadAllowed = (
  purpose: Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">,
  objectRef: CodaliStorageObjectRef,
  privacy: CodaliStoragePrivacyMetadata,
): void => {
  const decision = evaluateCodaliDatasetObjectPayloadRead(
    purpose,
    objectRef,
    privacy,
  );
  if (!decision.allowed) throw new CodaliDatasetPrivacyError(decision);
};

export const assertCodaliDatasetDurablePersistenceAllowed = (
  retentionClass: CodaliStorageObjectRetentionClass,
): void => {
  const decision = evaluateCodaliDatasetDurablePersistence(retentionClass);
  if (!decision.allowed) throw new CodaliDatasetPrivacyError(decision);
};

export const readCodaliDatasetObjectPayload = async <TPayload>(
  input: CodaliDatasetPayloadReadInput<TPayload>,
): Promise<CodaliDatasetPayloadReadResult<TPayload>> => {
  const baseDecision = evaluateCodaliDatasetObjectPayloadRead(
    input.purpose,
    input.objectRef,
    input.privacy,
  );
  const decision = applyCodaliDatasetPolicyOverride(
    baseDecision,
    input.policyOverride,
  );
  if (!decision.allowed) return { ok: false, decision };

  return {
    ok: true,
    decision,
    payload: await input.readPayload(input.objectRef),
  };
};

export const generateCodaliDatasetPrivacyMetadata = (
  input: CodaliDatasetPrivacyMetadataInput,
): CodaliDatasetPrivacyEnvelope => {
  const inputSecrets = detectAndRedactCodaliDatasetSecrets(input.inputPayload);
  const outputSecrets = detectAndRedactCodaliDatasetSecrets(input.outputPayload);
  const evidenceSecrets = (input.evidencePayloads ?? []).map((payload) =>
    detectAndRedactCodaliDatasetSecrets(payload),
  );
  const secretFindings = [
    ...inputSecrets.findings.map((finding) => ({
      ...finding,
      path: `$.inputPayload${finding.path.slice(1)}`,
    })),
    ...outputSecrets.findings.map((finding) => ({
      ...finding,
      path: `$.outputPayload${finding.path.slice(1)}`,
    })),
    ...evidenceSecrets.flatMap((result, index) =>
      result.findings.map((finding) => ({
        ...finding,
        path: `$.evidencePayloads[${index}]${finding.path.slice(1)}`,
      })),
    ),
  ];

  const containsSecrets = secretFindings.length > 0;
  const containsPersonalData =
    input.containsPersonalData === true ||
    payloadContainsPersonalData(input.inputPayload) ||
    payloadContainsPersonalData(input.outputPayload) ||
    (input.evidencePayloads ?? []).some(payloadContainsPersonalData);
  const retentionClass = input.retentionClass ?? "dataset";
  const durablePersistence = evaluateCodaliDatasetDurablePersistence(retentionClass);
  const durablePersistenceAllowed = durablePersistence.allowed;
  const personalDataRedacted = input.personalDataRedacted === true;
  const redactionStatus = containsSecrets
    ? containsPersonalData && !personalDataRedacted
      ? "pending"
      : "redacted"
    : containsPersonalData
      ? personalDataRedacted
        ? "redacted"
        : "pending"
      : "not_required";
  const redactionReady =
    !containsPersonalData || redactionStatus === "redacted";
  const trainingAllowed =
    input.allowances?.trainingAllowed === true &&
    durablePersistenceAllowed &&
    !containsSecrets &&
    redactionReady;
  const exportAllowed =
    input.allowances?.exportAllowed === true &&
    durablePersistenceAllowed &&
    !containsSecrets &&
    redactionReady;
  const uploadAllowed =
    input.allowances?.uploadAllowed === true &&
    durablePersistenceAllowed &&
    redactionReady &&
    !containsSecrets;
  const evalAllowed =
    input.allowances?.evalAllowed === true && durablePersistenceAllowed;
  const replayAllowed =
    input.allowances?.replayAllowed === true && durablePersistenceAllowed;
  const hashedIdentifiers = hashCodaliDatasetIdentifiers(input.tenant, {
    ...input.identifiers,
  });
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    containsSecrets,
    secretFindingCount: secretFindings.length,
    secretFindingKinds: Array.from(
      new Set(secretFindings.map((finding) => finding.kind)),
    ),
    hashedIdentifiers,
    retentionClass,
    generatedAt: input.now ?? new Date().toISOString(),
  };

  const privacy: CodaliStoragePrivacyMetadata = {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    classification: input.classification ?? "internal",
    containsPersonalData,
    redactionStatus,
    uploadAllowed,
    exportAllowed,
    trainingAllowed,
    policyTags: input.policyTags,
    retentionUntil: input.retentionUntil,
    redactionSummary: containsSecrets
      ? `${secretFindings.length} secret finding(s) redacted.`
      : undefined,
    metadata,
  };

  const privacyFlags: CodaliStorageObjectPrivacyFlags = {
    containsPersonalData,
    containsSecrets,
    containsTenantPrivateData: input.containsTenantPrivateData === true,
    containsSourceCode: input.containsSourceCode === true,
    containsCustomerData: input.containsCustomerData === true,
    trainingAllowed,
    evalAllowed,
    replayAllowed,
    exportAllowed,
  };

  const blockers: CodaliDatasetEligibilityBlocker[] = [
    ...durablePersistence.blockers,
  ];
  if (containsSecrets) {
    addBlocker(
      blockers,
      "secrets_detected",
      "Records containing secrets cannot be training or export eligible.",
      "$.metadata.containsSecrets",
    );
  }
  if (containsPersonalData && redactionStatus !== "redacted") {
    addBlocker(
      blockers,
      "redaction_required",
      "Personal data must be redacted before training or export eligibility.",
      "$.redactionStatus",
    );
  }
  if (input.allowances?.trainingAllowed === true && !trainingAllowed) {
    addBlocker(
      blockers,
      "privacy_training_not_allowed",
      "Requested training eligibility was denied by privacy policy.",
      "$.trainingAllowed",
    );
  }
  if (input.allowances?.exportAllowed === true && !exportAllowed) {
    addBlocker(
      blockers,
      "privacy_export_not_allowed",
      "Requested export eligibility was denied by privacy policy.",
      "$.exportAllowed",
    );
  }

  return {
    privacy,
    privacyFlags,
    hashedIdentifiers,
    redactedPayloads: {
      inputPayload: inputSecrets.redactedPayload,
      outputPayload: outputSecrets.redactedPayload,
      evidencePayloads: evidenceSecrets.map((result) => result.redactedPayload),
    },
    secretFindings,
    eligibility: {
      trainingAllowed,
      evalAllowed,
      replayAllowed,
      exportAllowed,
      durablePersistenceAllowed,
      blockers,
    },
  };
};
