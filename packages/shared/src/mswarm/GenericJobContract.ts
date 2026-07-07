export const MSWARM_GENERIC_JOB_SCHEMA_VERSION = "2026-06-14" as const;

export const MSWARM_GENERIC_JOB_SCHEMA_VERSIONS = [
  MSWARM_GENERIC_JOB_SCHEMA_VERSION,
] as const;

export type MswarmJobSchemaVersion = (typeof MSWARM_GENERIC_JOB_SCHEMA_VERSIONS)[number];

export const MSWARM_KNOWN_JOB_TYPES = [
  "render.blender",
  "cuda.run",
  "ffmpeg.cuda",
  "python.gpu",
  "package.job",
] as const;

export type MswarmKnownJobType = (typeof MSWARM_KNOWN_JOB_TYPES)[number];
export type MswarmRegisteredJobType = `tenant.${string}` | `package.${string}`;
export type MswarmJobType = MswarmKnownJobType | MswarmRegisteredJobType;

export const MSWARM_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export type MswarmJobStatus = (typeof MSWARM_JOB_STATUSES)[number];

export const MSWARM_JOB_EVENT_TYPES = [
  "queued",
  "scheduled",
  "started",
  "heartbeat",
  "stdout",
  "stderr",
  "log_truncated",
  "progress",
  "metric",
  "artifact",
  "completed",
  "failed",
  "cancelled",
] as const;

export type MswarmJobEventType = (typeof MSWARM_JOB_EVENT_TYPES)[number];

export const MSWARM_JOB_TRUST_MODES = ["owner-local", "tenant-owned"] as const;
export type MswarmJobTrustMode = (typeof MSWARM_JOB_TRUST_MODES)[number];

export const MSWARM_JOB_NETWORK_POLICIES = ["none", "egress-allowlist"] as const;
export type MswarmJobNetworkPolicy = (typeof MSWARM_JOB_NETWORK_POLICIES)[number];

export type MswarmGpuVendor = "nvidia" | "amd" | "apple" | (string & {});

export const MSWARM_ARTIFACT_SCOPES = ["input", "output", "log", "manifest"] as const;
export type MswarmArtifactScope = (typeof MSWARM_ARTIFACT_SCOPES)[number];

export type MswarmGenericJobErrorCode =
  | "invalid_request"
  | "invalid_schema_version"
  | "invalid_job_type"
  | "unregistered_job_type"
  | "invalid_registered_job_catalog"
  | "invalid_policy"
  | "invalid_limits"
  | "invalid_scheduling"
  | "invalid_resources"
  | "invalid_artifact"
  | "invalid_output"
  | "invalid_args"
  | "unknown_field"
  | "llm_field_not_allowed"
  | "unsafe_field"
  | "unsafe_artifact_uri"
  | "unsafe_path";

export interface MswarmGenericJobValidationIssue {
  code: MswarmGenericJobErrorCode;
  path: string;
  message: string;
  value?: unknown;
}

export interface MswarmRegisteredJobCatalogEntry {
  job_type: MswarmRegisteredJobType;
  args_schema: Record<string, unknown>;
  policy: MswarmJobPolicy;
  runner: string;
}

export interface MswarmJobPolicy {
  trust_mode: MswarmJobTrustMode;
  network?: MswarmJobNetworkPolicy;
  allow_raw_command?: false;
  allowed_images?: string[];
  allowed_package_publishers?: string[];
  max_artifact_bytes?: number;
}

export interface MswarmResourceRequest {
  gpu?: {
    count?: number;
    min_vram_gb?: number;
    vendor?: MswarmGpuVendor;
    cuda_min_version?: string;
    capabilities?: string[];
  };
  cpu?: {
    cores?: number;
  };
  memory_gb?: number;
  disk_gb?: number;
}

export interface MswarmJobLimits {
  timeout_sec?: number;
  max_stdout_bytes?: number;
  max_stderr_bytes?: number;
  max_output_bytes?: number;
}

export interface MswarmJobScheduling {
  priority?: number;
  deadline_at?: string;
  fairness_key?: string;
  reason_code?: string;
  preemptible?: boolean;
}

export interface MswarmArtifactRef {
  id?: string;
  uri: string;
  name?: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
  scope?: MswarmArtifactScope;
}

export interface MswarmArtifactInput {
  name: string;
  artifact: MswarmArtifactRef;
  mount_path?: string;
  required?: boolean;
}

export interface MswarmOutputSpec {
  name: string;
  path: string;
  content_type?: string;
  required?: boolean;
}

export interface MswarmJobRequest {
  schema_version: MswarmJobSchemaVersion;
  job_type: MswarmJobType;
  idempotency_key?: string;
  runner_hint?: string;
  inputs?: MswarmArtifactInput[];
  args?: Record<string, unknown>;
  resources?: MswarmResourceRequest;
  limits?: MswarmJobLimits;
  scheduling?: MswarmJobScheduling;
  outputs?: MswarmOutputSpec[];
  policy: MswarmJobPolicy;
  metadata?: Record<string, unknown>;
}

export interface MswarmJobResult {
  job_id: string;
  status: MswarmJobStatus;
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
  artifacts?: MswarmArtifactRef[];
  metrics?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface MswarmJobEvent {
  job_id: string;
  type: MswarmJobEventType;
  sequence: number;
  timestamp: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface MswarmGenericJobValidationOptions {
  /**
   * Deprecated compatibility input. A registered type name alone is not enough
   * to validate tenant/package jobs; use registeredJobCatalog instead.
   */
  registeredJobTypes?: readonly string[];
  registeredJobCatalog?: readonly MswarmRegisteredJobCatalogEntry[];
  allowSignedArtifactUrls?: boolean;
}

export interface MswarmGenericJobValidationResult {
  ok: boolean;
  value?: MswarmJobRequest;
  issues: MswarmGenericJobValidationIssue[];
}

const KNOWN_JOB_TYPE_SET = new Set<string>(MSWARM_KNOWN_JOB_TYPES);
const SCHEMA_VERSION_SET = new Set<string>(MSWARM_GENERIC_JOB_SCHEMA_VERSIONS);
const TRUST_MODE_SET = new Set<string>(MSWARM_JOB_TRUST_MODES);
const NETWORK_POLICY_SET = new Set<string>(MSWARM_JOB_NETWORK_POLICIES);
const ARTIFACT_SCOPE_SET = new Set<string>(MSWARM_ARTIFACT_SCOPES);

const COMMON_REQUEST_KEYS = new Set([
  "schema_version",
  "job_type",
  "idempotency_key",
  "runner_hint",
  "inputs",
  "args",
  "resources",
  "limits",
  "scheduling",
  "outputs",
  "policy",
  "metadata",
]);

const LLM_REQUEST_KEYS = new Set([
  "openai_request",
  "messages",
  "model",
  "agent_slug",
  "adapter",
  "source_agent_slug",
  "execution_runtime",
]);

const UNSAFE_ARG_KEYS = new Set([
  "command",
  "cmd",
  "shell",
  "image",
  "runtime",
  "network",
  "mount",
  "mounts",
  "device",
  "devices",
  "privileged",
  "hostNetwork",
  "host_network",
  "volumes",
  "binds",
]);

const UNSAFE_METADATA_KEYS = new Set([
  ...UNSAFE_ARG_KEYS,
  "allow_raw_command",
  "allowed_images",
  "allowed_package_publishers",
  "host_path",
  "host_paths",
]);

export const MSWARM_KNOWN_JOB_ARG_KEYS: Record<MswarmKnownJobType, readonly string[]> = {
  "render.blender": [
    "frames",
    "engine",
    "resolution",
    "output_format",
    "camera",
    "scene",
  ],
  "cuda.run": ["manifest_path", "profile", "target"],
  "ffmpeg.cuda": ["input", "output", "filter", "codec", "preset"],
  "python.gpu": ["manifest_path", "entrypoint", "profile"],
  "package.job": ["manifest_path", "package_ref", "task", "profile"],
};

const JOB_TYPE_ARG_KEYS: Record<MswarmKnownJobType, ReadonlySet<string>> = {
  "render.blender": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["render.blender"]),
  "cuda.run": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["cuda.run"]),
  "ffmpeg.cuda": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["ffmpeg.cuda"]),
  "python.gpu": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["python.gpu"]),
  "package.job": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["package.job"]),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const pushIssue = (
  issues: MswarmGenericJobValidationIssue[],
  issue: MswarmGenericJobValidationIssue,
): void => {
  issues.push(issue);
};

const isPathOrChildPath = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`);

const SAFE_GENERIC_ARG_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_GENERIC_ARG_PATH_SEGMENT = /^[a-zA-Z0-9_.-]+$/;

const isSafeGenericArgPath = (value: string): boolean => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  const parts = value.split("/").filter((part) => part.length > 0 && part !== ".");
  return parts.length > 0 && parts.every((part) => part !== ".." && SAFE_GENERIC_ARG_PATH_SEGMENT.test(part));
};

const validateRequiredSafeArgPath = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  const value = asNonEmptyString(record[key]);
  if (!value) {
    pushIssue(issues, {
      code: "invalid_args",
      path: `${path}.${key}`,
      message: `${key} must be a non-empty relative path.`,
      value: record[key],
    });
    return;
  }
  if (!isSafeGenericArgPath(value)) {
    pushIssue(issues, {
      code: "unsafe_path",
      path: `${path}.${key}`,
      message: `${key} must be a safe relative path.`,
      value: record[key],
    });
  }
};

const validateRequiredSafeArgIdentifier = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  const value = asNonEmptyString(record[key]);
  if (!value) {
    pushIssue(issues, {
      code: "invalid_args",
      path: `${path}.${key}`,
      message: `${key} must be a non-empty identifier.`,
      value: record[key],
    });
    return;
  }
  if (!SAFE_GENERIC_ARG_IDENTIFIER.test(value)) {
    pushIssue(issues, {
      code: "invalid_args",
      path: `${path}.${key}`,
      message: `${key} may only contain letters, numbers, dots, underscores, and hyphens.`,
      value: record[key],
    });
  }
};

const validateStringArray = (
  value: unknown,
  path: string,
  issues: MswarmGenericJobValidationIssue[],
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    pushIssue(issues, {
      code: "invalid_request",
      path,
      message: "Expected an array of non-empty strings.",
      value,
    });
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((item, index) => {
    const normalized = asNonEmptyString(item);
    if (!normalized) {
      pushIssue(issues, {
        code: "invalid_request",
        path: `${path}.${index}`,
        message: "Expected a non-empty string.",
        value: item,
      });
      return;
    }
    strings.push(normalized);
  });
  return strings;
};

const validatePositiveIntegerField = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  code: MswarmGenericJobErrorCode,
  issues: MswarmGenericJobValidationIssue[],
): number | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value)) {
    pushIssue(issues, {
      code,
      path: `${path}.${key}`,
      message: "Expected a positive integer.",
      value,
    });
    return undefined;
  }
  return value;
};

const validateRegisteredCatalogPolicy = (
  value: unknown,
  path: string,
  issues: MswarmGenericJobValidationIssue[],
): boolean => {
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path,
      message: "Registered job catalog entries must include a policy object.",
      value,
    });
    return false;
  }
  const trustMode = asNonEmptyString(value.trust_mode);
  const network = value.network === undefined ? undefined : asNonEmptyString(value.network);
  let ok = true;
  if (!trustMode || !TRUST_MODE_SET.has(trustMode)) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path: `${path}.trust_mode`,
      message: "Registered job catalog policy must include a valid trust_mode.",
      value: value.trust_mode,
    });
    ok = false;
  }
  if (network !== undefined && !NETWORK_POLICY_SET.has(network)) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path: `${path}.network`,
      message: "Registered job catalog policy network must be none or egress-allowlist.",
      value: value.network,
    });
    ok = false;
  }
  if (value.allow_raw_command !== undefined && value.allow_raw_command !== false) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path: `${path}.allow_raw_command`,
      message: "Registered job catalog policy cannot allow raw command execution.",
      value: value.allow_raw_command,
    });
    ok = false;
  }
  return ok;
};

const findRegisteredCatalogEntry = (
  jobType: MswarmRegisteredJobType,
  options: MswarmGenericJobValidationOptions,
  issues: MswarmGenericJobValidationIssue[],
): MswarmRegisteredJobCatalogEntry | undefined => {
  const catalog = options.registeredJobCatalog ?? [];
  const index = catalog.findIndex((entry) => isRecord(entry) && entry.job_type === jobType);
  if (index < 0) {
    const legacyNameOnly = new Set(options.registeredJobTypes ?? []).has(jobType);
    pushIssue(issues, {
      code: legacyNameOnly ? "invalid_registered_job_catalog" : "unregistered_job_type",
      path: "job_type",
      message: legacyNameOnly
        ? "Registered job type names require a catalog entry with args_schema, policy, and runner mapping."
        : "Registered job types must be present in the tenant job catalog before validation accepts them.",
      value: jobType,
    });
    return undefined;
  }
  const entry = catalog[index] as unknown;
  const path = `registeredJobCatalog.${index}`;
  if (!isRecord(entry)) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path,
      message: "Registered job catalog entry must be an object.",
      value: entry,
    });
    return undefined;
  }
  const allowed = new Set(["job_type", "args_schema", "policy", "runner"]);
  for (const [key, fieldValue] of Object.entries(entry)) {
    if (!allowed.has(key)) {
      pushIssue(issues, {
        code: "invalid_registered_job_catalog",
        path: `${path}.${key}`,
        message: "Unknown registered job catalog field.",
        value: fieldValue,
      });
    }
  }
  const runner = asNonEmptyString(entry.runner);
  if (!runner) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path: `${path}.runner`,
      message: "Registered job catalog entries must include a non-empty runner mapping.",
      value: entry.runner,
    });
  }
  if (!isRecord(entry.args_schema)) {
    pushIssue(issues, {
      code: "invalid_registered_job_catalog",
      path: `${path}.args_schema`,
      message: "Registered job catalog entries must include an args schema object.",
      value: entry.args_schema,
    });
  }
  const policyOk = validateRegisteredCatalogPolicy(entry.policy, `${path}.policy`, issues);
  if (issues.some((issue) => isPathOrChildPath(issue.path, path)) || !runner || !policyOk) {
    return undefined;
  }
  return {
    job_type: jobType,
    args_schema: entry.args_schema as Record<string, unknown>,
    policy: entry.policy as MswarmJobPolicy,
    runner,
  };
};

export function isMswarmKnownJobType(value: unknown): value is MswarmKnownJobType {
  const normalized = asNonEmptyString(value);
  return normalized ? KNOWN_JOB_TYPE_SET.has(normalized) : false;
}

export function isMswarmRegisteredJobType(value: unknown): value is MswarmRegisteredJobType {
  const normalized = asNonEmptyString(value);
  return Boolean(
    normalized &&
      (normalized.startsWith("tenant.") || normalized.startsWith("package.")) &&
      normalized.split(".").every((part) => /^[a-z0-9][a-z0-9-]*$/.test(part)),
  );
}

export function isMswarmJobType(value: unknown): value is MswarmJobType {
  return isMswarmKnownJobType(value) || isMswarmRegisteredJobType(value);
}

const validateSchemaVersion = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmJobSchemaVersion | undefined => {
  const normalized = asNonEmptyString(value);
  if (!normalized || !SCHEMA_VERSION_SET.has(normalized)) {
    pushIssue(issues, {
      code: "invalid_schema_version",
      path: "schema_version",
      message: `Unsupported mswarm generic job schema version; expected ${MSWARM_GENERIC_JOB_SCHEMA_VERSION}.`,
      value,
    });
    return undefined;
  }
  return normalized as MswarmJobSchemaVersion;
};

const validateJobType = (
  value: unknown,
  options: MswarmGenericJobValidationOptions,
  issues: MswarmGenericJobValidationIssue[],
): MswarmJobType | undefined => {
  const normalized = asNonEmptyString(value);
  if (!normalized || !isMswarmJobType(normalized)) {
    pushIssue(issues, {
      code: "invalid_job_type",
      path: "job_type",
      message: "Job type must be a known type or a registered tenant/package namespace.",
      value,
    });
    return undefined;
  }
  if (!isMswarmKnownJobType(normalized)) {
    const catalogEntry = findRegisteredCatalogEntry(
      normalized as MswarmRegisteredJobType,
      options,
      issues,
    );
    if (!catalogEntry) {
      return undefined;
    }
  }
  return normalized;
};

const validatePolicy = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmJobPolicy | undefined => {
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_policy",
      path: "policy",
      message: "Generic job policy is required and must be an object.",
      value,
    });
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (
      ![
        "trust_mode",
        "network",
        "allow_raw_command",
        "allowed_images",
        "allowed_package_publishers",
        "max_artifact_bytes",
      ].includes(key)
    ) {
      pushIssue(issues, {
        code: "unknown_field",
        path: `policy.${key}`,
        message: "Unknown policy field.",
        value: value[key],
      });
    }
  }
  const trustMode = asNonEmptyString(value.trust_mode);
  if (!trustMode || !TRUST_MODE_SET.has(trustMode)) {
    pushIssue(issues, {
      code: "invalid_policy",
      path: "policy.trust_mode",
      message: "Policy trust_mode must be owner-local or tenant-owned.",
      value: value.trust_mode,
    });
  }
  const network = value.network === undefined ? "none" : asNonEmptyString(value.network);
  if (!network || !NETWORK_POLICY_SET.has(network)) {
    pushIssue(issues, {
      code: "invalid_policy",
      path: "policy.network",
      message: "Policy network must be none or egress-allowlist.",
      value: value.network,
    });
  }
  if (value.allow_raw_command !== undefined && value.allow_raw_command !== false) {
    pushIssue(issues, {
      code: "unsafe_field",
      path: "policy.allow_raw_command",
      message: "Raw command execution is not allowed in the generic job contract.",
      value: value.allow_raw_command,
    });
  }
  const allowedImages = validateStringArray(value.allowed_images, "policy.allowed_images", issues);
  const allowedPackagePublishers = validateStringArray(
    value.allowed_package_publishers,
    "policy.allowed_package_publishers",
    issues,
  );
  const maxArtifactBytes = validatePositiveIntegerField(
    value,
    "max_artifact_bytes",
    "policy",
    "invalid_policy",
    issues,
  );
  if (issues.some((issue) => isPathOrChildPath(issue.path, "policy"))) {
    return undefined;
  }
  return {
    trust_mode: trustMode as MswarmJobTrustMode,
    network: network as MswarmJobNetworkPolicy,
    ...(value.allow_raw_command === false ? { allow_raw_command: false } : {}),
    ...(allowedImages ? { allowed_images: allowedImages } : {}),
    ...(allowedPackagePublishers ? { allowed_package_publishers: allowedPackagePublishers } : {}),
    ...(maxArtifactBytes !== undefined ? { max_artifact_bytes: maxArtifactBytes } : {}),
  };
};

const validateLimits = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmJobLimits | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_limits",
      path: "limits",
      message: "Limits must be an object.",
      value,
    });
    return undefined;
  }
  const allowed = new Set([
    "timeout_sec",
    "max_stdout_bytes",
    "max_stderr_bytes",
    "max_output_bytes",
  ]);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.has(key)) {
      pushIssue(issues, {
        code: key === "network" ? "unsafe_field" : "unknown_field",
        path: `limits.${key}`,
        message: key === "network" ? "Network policy belongs under policy.network." : "Unknown limits field.",
        value: fieldValue,
      });
    }
  }
  const limits: MswarmJobLimits = {};
  for (const key of allowed) {
    const normalized = validatePositiveIntegerField(value, key, "limits", "invalid_limits", issues);
    if (normalized !== undefined) {
      limits[key as keyof MswarmJobLimits] = normalized;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
};

const validateScheduling = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmJobScheduling | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_scheduling",
      path: "scheduling",
      message: "Scheduling must be an object.",
      value,
    });
    return undefined;
  }
  const allowed = new Set(["priority", "deadline_at", "fairness_key", "reason_code", "preemptible"]);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.has(key)) {
      pushIssue(issues, {
        code: "unknown_field",
        path: `scheduling.${key}`,
        message: "Unknown scheduling field.",
        value: fieldValue,
      });
    }
  }
  const scheduling: MswarmJobScheduling = {};
  const priority = value.priority;
  if (priority !== undefined) {
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -100 || priority > 100) {
      pushIssue(issues, {
        code: "invalid_scheduling",
        path: "scheduling.priority",
        message: "Scheduling priority must be an integer from -100 to 100; lower numbers dispatch earlier.",
        value: priority,
      });
    } else {
      scheduling.priority = priority;
    }
  }
  const deadlineAt = value.deadline_at === undefined ? undefined : asNonEmptyString(value.deadline_at);
  if (value.deadline_at !== undefined) {
    if (!deadlineAt || Number.isNaN(Date.parse(deadlineAt))) {
      pushIssue(issues, {
        code: "invalid_scheduling",
        path: "scheduling.deadline_at",
        message: "Scheduling deadline_at must be a valid timestamp string.",
        value: value.deadline_at,
      });
    } else {
      scheduling.deadline_at = deadlineAt;
    }
  }
  const fairnessKey = value.fairness_key === undefined ? undefined : asNonEmptyString(value.fairness_key);
  if (value.fairness_key !== undefined) {
    if (!fairnessKey) {
      pushIssue(issues, {
        code: "invalid_scheduling",
        path: "scheduling.fairness_key",
        message: "Scheduling fairness_key must be a non-empty string.",
        value: value.fairness_key,
      });
    } else {
      scheduling.fairness_key = fairnessKey;
    }
  }
  const reasonCode = value.reason_code === undefined ? undefined : asNonEmptyString(value.reason_code);
  if (value.reason_code !== undefined) {
    if (!reasonCode) {
      pushIssue(issues, {
        code: "invalid_scheduling",
        path: "scheduling.reason_code",
        message: "Scheduling reason_code must be a non-empty string.",
        value: value.reason_code,
      });
    } else {
      scheduling.reason_code = reasonCode;
    }
  }
  if (value.preemptible !== undefined) {
    if (typeof value.preemptible !== "boolean") {
      pushIssue(issues, {
        code: "invalid_scheduling",
        path: "scheduling.preemptible",
        message: "Scheduling preemptible must be a boolean.",
        value: value.preemptible,
      });
    } else {
      scheduling.preemptible = value.preemptible;
    }
  }
  return Object.keys(scheduling).length > 0 ? scheduling : undefined;
};

const validateRelativeSandboxPath = (
  value: unknown,
  path: string,
  issues: MswarmGenericJobValidationIssue[],
): string | undefined => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    pushIssue(issues, {
      code: "unsafe_path",
      path,
      message: "Expected a non-empty relative sandbox path.",
      value,
    });
    return undefined;
  }
  const parts = normalized.split(/[\\/]+/);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.includes("\\") ||
    parts.some((part) => part === ".." || part === "")
  ) {
    pushIssue(issues, {
      code: "unsafe_path",
      path,
      message: "Path must be relative and must not escape the job sandbox.",
      value,
    });
    return undefined;
  }
  return normalized;
};

const validateArtifactUri = (
  value: unknown,
  path: string,
  options: MswarmGenericJobValidationOptions,
  issues: MswarmGenericJobValidationIssue[],
): string | undefined => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    pushIssue(issues, {
      code: "invalid_artifact",
      path,
      message: "Artifact uri is required.",
      value,
    });
    return undefined;
  }
  if (normalized.startsWith("artifact://")) return normalized;
  if (options.allowSignedArtifactUrls && normalized.startsWith("https://")) return normalized;
  pushIssue(issues, {
    code: "unsafe_artifact_uri",
    path,
    message: "Artifact uri must be artifact:// unless a signed URL flow explicitly allows https://.",
    value,
  });
  return undefined;
};

const validateArtifactRef = (
  value: unknown,
  path: string,
  options: MswarmGenericJobValidationOptions,
  issues: MswarmGenericJobValidationIssue[],
): MswarmArtifactRef | undefined => {
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_artifact",
      path,
      message: "Artifact reference must be an object.",
      value,
    });
    return undefined;
  }
  const allowed = new Set(["id", "uri", "name", "content_type", "size_bytes", "sha256", "scope"]);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.has(key)) {
      pushIssue(issues, {
        code: "unknown_field",
        path: `${path}.${key}`,
        message: "Unknown artifact field.",
        value: fieldValue,
      });
    }
  }
  const uri = validateArtifactUri(value.uri, `${path}.uri`, options, issues);
  const artifact: MswarmArtifactRef = { uri: uri ?? "" };
  for (const key of ["id", "name", "content_type", "sha256"] as const) {
    if (value[key] !== undefined) {
      const normalized = asNonEmptyString(value[key]);
      if (!normalized) {
        pushIssue(issues, {
          code: "invalid_artifact",
          path: `${path}.${key}`,
          message: "Expected a non-empty string.",
          value: value[key],
        });
      } else {
        artifact[key] = normalized;
      }
    }
  }
  const sizeBytes = validatePositiveIntegerField(value, "size_bytes", path, "invalid_artifact", issues);
  if (sizeBytes !== undefined) artifact.size_bytes = sizeBytes;
  if (value.scope !== undefined) {
    const scope = asNonEmptyString(value.scope);
    if (!scope || !ARTIFACT_SCOPE_SET.has(scope)) {
      pushIssue(issues, {
        code: "invalid_artifact",
        path: `${path}.scope`,
        message: "Invalid artifact scope.",
        value: value.scope,
      });
    } else {
      artifact.scope = scope as MswarmArtifactScope;
    }
  }
  return uri ? artifact : undefined;
};

const validateInputs = (
  value: unknown,
  options: MswarmGenericJobValidationOptions,
  issues: MswarmGenericJobValidationIssue[],
): MswarmArtifactInput[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    pushIssue(issues, {
      code: "invalid_artifact",
      path: "inputs",
      message: "Inputs must be an array.",
      value,
    });
    return undefined;
  }
  const inputs: MswarmArtifactInput[] = [];
  value.forEach((item, index) => {
    const path = `inputs.${index}`;
    if (!isRecord(item)) {
      pushIssue(issues, {
        code: "invalid_artifact",
        path,
        message: "Input must be an object.",
        value: item,
      });
      return;
    }
    const allowed = new Set(["name", "artifact", "mount_path", "required"]);
    for (const [key, fieldValue] of Object.entries(item)) {
      if (!allowed.has(key)) {
        pushIssue(issues, {
          code: "unknown_field",
          path: `${path}.${key}`,
          message: "Unknown input field.",
          value: fieldValue,
        });
      }
    }
    const name = asNonEmptyString(item.name);
    if (!name) {
      pushIssue(issues, {
        code: "invalid_artifact",
        path: `${path}.name`,
        message: "Input name is required.",
        value: item.name,
      });
      return;
    }
    const artifact = validateArtifactRef(item.artifact, `${path}.artifact`, options, issues);
    const mountPath =
      item.mount_path === undefined
        ? undefined
        : validateRelativeSandboxPath(item.mount_path, `${path}.mount_path`, issues);
    if (item.required !== undefined && typeof item.required !== "boolean") {
      pushIssue(issues, {
        code: "invalid_artifact",
        path: `${path}.required`,
        message: "Input required must be a boolean.",
        value: item.required,
      });
    }
    if (artifact) {
      inputs.push({
        name,
        artifact,
        ...(mountPath ? { mount_path: mountPath } : {}),
        ...(typeof item.required === "boolean" ? { required: item.required } : {}),
      });
    }
  });
  return inputs.length > 0 ? inputs : undefined;
};

const validateOutputs = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmOutputSpec[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    pushIssue(issues, {
      code: "invalid_output",
      path: "outputs",
      message: "Outputs must be an array.",
      value,
    });
    return undefined;
  }
  const outputs: MswarmOutputSpec[] = [];
  value.forEach((item, index) => {
    const path = `outputs.${index}`;
    if (!isRecord(item)) {
      pushIssue(issues, {
        code: "invalid_output",
        path,
        message: "Output must be an object.",
        value: item,
      });
      return;
    }
    const allowed = new Set(["name", "path", "content_type", "required"]);
    for (const [key, fieldValue] of Object.entries(item)) {
      if (!allowed.has(key)) {
        pushIssue(issues, {
          code: "unknown_field",
          path: `${path}.${key}`,
          message: "Unknown output field.",
          value: fieldValue,
        });
      }
    }
    const name = asNonEmptyString(item.name);
    if (!name) {
      pushIssue(issues, {
        code: "invalid_output",
        path: `${path}.name`,
        message: "Output name is required.",
        value: item.name,
      });
      return;
    }
    const outputPath = validateRelativeSandboxPath(item.path, `${path}.path`, issues);
    const contentType = item.content_type === undefined ? undefined : asNonEmptyString(item.content_type);
    if (item.content_type !== undefined && !contentType) {
      pushIssue(issues, {
        code: "invalid_output",
        path: `${path}.content_type`,
        message: "Output content_type must be a non-empty string.",
        value: item.content_type,
      });
    }
    if (item.required !== undefined && typeof item.required !== "boolean") {
      pushIssue(issues, {
        code: "invalid_output",
        path: `${path}.required`,
        message: "Output required must be a boolean.",
        value: item.required,
      });
    }
    if (outputPath) {
      outputs.push({
        name,
        path: outputPath,
        ...(contentType ? { content_type: contentType } : {}),
        ...(typeof item.required === "boolean" ? { required: item.required } : {}),
      });
    }
  });
  return outputs.length > 0 ? outputs : undefined;
};

const validateResources = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): MswarmResourceRequest | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_resources",
      path: "resources",
      message: "Resources must be an object.",
      value,
    });
    return undefined;
  }
  const resources: MswarmResourceRequest = {};
  const allowed = new Set(["gpu", "cpu", "memory_gb", "disk_gb"]);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.has(key)) {
      pushIssue(issues, {
        code: "unknown_field",
        path: `resources.${key}`,
        message: "Unknown resources field.",
        value: fieldValue,
      });
    }
  }
  const memoryGb = validatePositiveIntegerField(value, "memory_gb", "resources", "invalid_resources", issues);
  const diskGb = validatePositiveIntegerField(value, "disk_gb", "resources", "invalid_resources", issues);
  if (memoryGb !== undefined) resources.memory_gb = memoryGb;
  if (diskGb !== undefined) resources.disk_gb = diskGb;
  if (value.cpu !== undefined) {
    if (!isRecord(value.cpu)) {
      pushIssue(issues, {
        code: "invalid_resources",
        path: "resources.cpu",
        message: "CPU resources must be an object.",
        value: value.cpu,
      });
    } else {
      const cores = validatePositiveIntegerField(
        value.cpu,
        "cores",
        "resources.cpu",
        "invalid_resources",
        issues,
      );
      if (cores !== undefined) resources.cpu = { cores };
    }
  }
  if (value.gpu !== undefined) {
    if (!isRecord(value.gpu)) {
      pushIssue(issues, {
        code: "invalid_resources",
        path: "resources.gpu",
        message: "GPU resources must be an object.",
        value: value.gpu,
      });
    } else {
      const gpu: NonNullable<MswarmResourceRequest["gpu"]> = {};
      for (const [key, fieldValue] of Object.entries(value.gpu)) {
        if (!["count", "min_vram_gb", "vendor", "cuda_min_version", "capabilities"].includes(key)) {
          pushIssue(issues, {
            code: "unknown_field",
            path: `resources.gpu.${key}`,
            message: "Unknown GPU resource field.",
            value: fieldValue,
          });
        }
      }
      const count = validatePositiveIntegerField(value.gpu, "count", "resources.gpu", "invalid_resources", issues);
      const minVramGb = validatePositiveIntegerField(
        value.gpu,
        "min_vram_gb",
        "resources.gpu",
        "invalid_resources",
        issues,
      );
      const vendor = value.gpu.vendor === undefined ? undefined : asNonEmptyString(value.gpu.vendor);
      const cudaMinVersion =
        value.gpu.cuda_min_version === undefined
          ? undefined
          : asNonEmptyString(value.gpu.cuda_min_version);
      const capabilities = validateStringArray(
        value.gpu.capabilities,
        "resources.gpu.capabilities",
        issues,
      );
      if (count !== undefined) gpu.count = count;
      if (minVramGb !== undefined) gpu.min_vram_gb = minVramGb;
      if (vendor) gpu.vendor = vendor;
      if (value.gpu.vendor !== undefined && !vendor) {
        pushIssue(issues, {
          code: "invalid_resources",
          path: "resources.gpu.vendor",
          message: "GPU vendor must be a non-empty string.",
          value: value.gpu.vendor,
        });
      }
      if (cudaMinVersion) gpu.cuda_min_version = cudaMinVersion;
      if (value.gpu.cuda_min_version !== undefined && !cudaMinVersion) {
        pushIssue(issues, {
          code: "invalid_resources",
          path: "resources.gpu.cuda_min_version",
          message: "CUDA minimum version must be a non-empty string.",
          value: value.gpu.cuda_min_version,
        });
      }
      if (capabilities) gpu.capabilities = capabilities;
      if (Object.keys(gpu).length > 0) resources.gpu = gpu;
    }
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
};

const validateArgs = (
  value: unknown,
  jobType: MswarmJobType | undefined,
  issues: MswarmGenericJobValidationIssue[],
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_args",
      path: "args",
      message: "Args must be an object.",
      value,
    });
    return undefined;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (UNSAFE_ARG_KEYS.has(key)) {
      pushIssue(issues, {
        code: "unsafe_field",
        path: `args.${key}`,
        message: "Unsafe runtime controls are not allowed in generic job args.",
        value: fieldValue,
      });
      continue;
    }
  }
  if (jobType && isMswarmKnownJobType(jobType)) {
    KNOWN_JOB_ARG_VALIDATORS[jobType](value, issues);
  }
  return { ...value };
};

const validateKnownJobArgKeys = (
  jobType: MswarmKnownJobType,
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  const allowedKeys = JOB_TYPE_ARG_KEYS[jobType];
  for (const [key, fieldValue] of Object.entries(value)) {
    if (UNSAFE_ARG_KEYS.has(key)) continue;
    if (!allowedKeys.has(key)) {
      pushIssue(issues, {
        code: "unknown_field",
        path: `args.${key}`,
        message: `Unknown args field for ${jobType}.`,
        value: fieldValue,
      });
    }
  }
};

const validateRenderBlenderArgs = (
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  validateKnownJobArgKeys("render.blender", value, issues);
};

const validateCudaRunArgs = (
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  validateKnownJobArgKeys("cuda.run", value, issues);
  validateRequiredSafeArgPath(value, "manifest_path", "args", issues);
  validateRequiredSafeArgIdentifier(value, "profile", "args", issues);
  validateRequiredSafeArgIdentifier(value, "target", "args", issues);
};

const validateFfmpegCudaArgs = (
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  validateKnownJobArgKeys("ffmpeg.cuda", value, issues);
};

const validatePythonGpuArgs = (
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  validateKnownJobArgKeys("python.gpu", value, issues);
};

const validatePackageJobArgs = (
  value: Record<string, unknown>,
  issues: MswarmGenericJobValidationIssue[],
): void => {
  validateKnownJobArgKeys("package.job", value, issues);
};

const KNOWN_JOB_ARG_VALIDATORS: Record<
  MswarmKnownJobType,
  (value: Record<string, unknown>, issues: MswarmGenericJobValidationIssue[]) => void
> = {
  "render.blender": validateRenderBlenderArgs,
  "cuda.run": validateCudaRunArgs,
  "ffmpeg.cuda": validateFfmpegCudaArgs,
  "python.gpu": validatePythonGpuArgs,
  "package.job": validatePackageJobArgs,
};

const validateMetadata = (
  value: unknown,
  issues: MswarmGenericJobValidationIssue[],
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(issues, {
      code: "invalid_request",
      path: "metadata",
      message: "Metadata must be an object.",
      value,
    });
    return undefined;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (UNSAFE_METADATA_KEYS.has(key)) {
      pushIssue(issues, {
        code: "unsafe_field",
        path: `metadata.${key}`,
        message: "Metadata cannot override runtime, network, shell, mount, device, or image behavior.",
        value: fieldValue,
      });
    }
  }
  return { ...value };
};

export function validateMswarmGenericJobRequest(
  input: unknown,
  options: MswarmGenericJobValidationOptions = {},
): MswarmGenericJobValidationResult {
  const issues: MswarmGenericJobValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_request",
          path: "",
          message: "Generic job request must be an object.",
          value: input,
        },
      ],
    };
  }
  for (const [key, value] of Object.entries(input)) {
    if (LLM_REQUEST_KEYS.has(key)) {
      pushIssue(issues, {
        code: "llm_field_not_allowed",
        path: key,
        message: "LLM invocation fields are not part of the generic job contract.",
        value,
      });
      continue;
    }
    if (!COMMON_REQUEST_KEYS.has(key)) {
      pushIssue(issues, {
        code: "unknown_field",
        path: key,
        message: "Unknown generic job request field.",
        value,
      });
    }
  }

  const schemaVersion = validateSchemaVersion(input.schema_version, issues);
  const jobType = validateJobType(input.job_type, options, issues);
  const policy = validatePolicy(input.policy, issues);
  const limits = validateLimits(input.limits, issues);
  const inputs = validateInputs(input.inputs, options, issues);
  const outputs = validateOutputs(input.outputs, issues);
  const resources = validateResources(input.resources, issues);
  const scheduling = validateScheduling(input.scheduling, issues);
  const args = validateArgs(input.args, jobType, issues);
  const idempotencyKey = input.idempotency_key === undefined ? undefined : asNonEmptyString(input.idempotency_key);
  if (input.idempotency_key !== undefined && !idempotencyKey) {
    pushIssue(issues, {
      code: "invalid_request",
      path: "idempotency_key",
      message: "Idempotency key must be a non-empty string.",
      value: input.idempotency_key,
    });
  }
  const runnerHint = input.runner_hint === undefined ? undefined : asNonEmptyString(input.runner_hint);
  if (input.runner_hint !== undefined && !runnerHint) {
    pushIssue(issues, {
      code: "invalid_request",
      path: "runner_hint",
      message: "Runner hint must be a non-empty string.",
      value: input.runner_hint,
    });
  }
  const metadata = validateMetadata(input.metadata, issues);
  if (issues.length > 0 || !schemaVersion || !jobType || !policy) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    issues: [],
    value: {
      schema_version: schemaVersion,
      job_type: jobType,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(runnerHint ? { runner_hint: runnerHint } : {}),
      ...(inputs ? { inputs } : {}),
      ...(args ? { args } : {}),
      ...(resources ? { resources } : {}),
      ...(limits ? { limits } : {}),
      ...(scheduling ? { scheduling } : {}),
      ...(outputs ? { outputs } : {}),
      policy,
      ...(metadata ? { metadata } : {}),
    },
  };
}

export function isMswarmGenericJobRequest(
  input: unknown,
  options: MswarmGenericJobValidationOptions = {},
): input is MswarmJobRequest {
  return validateMswarmGenericJobRequest(input, options).ok;
}
