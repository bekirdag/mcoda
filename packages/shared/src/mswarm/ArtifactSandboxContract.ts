import type {
  MswarmArtifactRef,
  MswarmArtifactScope,
  MswarmJobLimits,
  MswarmJobNetworkPolicy,
  MswarmJobPolicy,
  MswarmJobTrustMode,
  MswarmOutputSpec,
} from "./GenericJobContract.js";

export const MSWARM_ARTIFACT_SANDBOX_SCHEMA_VERSION = "2026-06-14" as const;

export type MswarmArtifactStorageBackend = "local-dev" | "gateway" | "object-storage";
export type MswarmArtifactVisibility = "owner-local" | "tenant-scoped";
export type MswarmSandboxProfileName = "owner-local-process" | "container-cpu" | "container-nvidia";
export type MswarmArchiveEntryType = "file" | "directory" | "symlink" | "hardlink" | "device" | "other";

export interface MswarmArtifactAccessPolicy {
  visibility: MswarmArtifactVisibility;
  read_by: Array<"runner" | "owner" | "tenant" | "gateway">;
  write_by: Array<"runner" | "owner" | "gateway">;
  expires_at?: string;
}

export interface MswarmArtifactRetentionPolicy {
  retain_for_seconds: number;
  delete_after?: string;
}

export interface MswarmArtifactStoreDescriptor {
  backend: MswarmArtifactStorageBackend;
  root_uri?: string;
  bucket?: string;
  gateway_base_url?: string;
}

export interface MswarmArtifactRegistrationRequest {
  job_id: string;
  name: string;
  artifact: MswarmArtifactRef;
  access?: MswarmArtifactAccessPolicy;
  retention?: MswarmArtifactRetentionPolicy;
}

export interface MswarmRegisteredArtifact extends MswarmArtifactRef {
  id: string;
  job_id: string;
  name: string;
  scope: MswarmArtifactScope;
  registered_at: string;
  store: MswarmArtifactStoreDescriptor;
  access: MswarmArtifactAccessPolicy;
  retention: MswarmArtifactRetentionPolicy;
  local_path?: string;
}

export interface MswarmOutputCollectionSpec extends MswarmOutputSpec {
  max_bytes?: number;
}

export interface MswarmArchiveEntryCheck {
  path: string;
  type?: MswarmArchiveEntryType;
  size_bytes?: number;
}

export interface MswarmPathValidationResult {
  ok: boolean;
  normalized?: string;
  reason?: string;
}

export interface MswarmSandboxProfile {
  schema_version: typeof MSWARM_ARTIFACT_SANDBOX_SCHEMA_VERSION;
  name: MswarmSandboxProfileName;
  trust_mode: MswarmJobTrustMode;
  network: MswarmJobNetworkPolicy;
  allow_raw_command: false;
  filesystem: {
    working_directory: "per-job";
    inputs: "read-only";
    outputs: "write-only";
    allow_host_paths: false;
    validate_output_paths: true;
    validate_archive_entries: true;
  };
  container: {
    enabled: boolean;
    rootless: boolean;
    user: string;
    privileged: false;
    read_only_root_fs: boolean;
    gpu: "none" | "nvidia";
    allowed_images?: string[];
  };
  limits: {
    timeout_sec?: number;
    max_stdout_bytes?: number;
    max_stderr_bytes?: number;
    max_output_bytes?: number;
    max_artifact_bytes?: number;
  };
}

const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export function normalizeMswarmSafeRelativePath(path: unknown): MswarmPathValidationResult {
  if (typeof path !== "string" || path.trim().length === 0) {
    return { ok: false, reason: "path_required" };
  }
  const raw = path.trim();
  if (raw.includes("\0")) {
    return { ok: false, reason: "null_byte" };
  }
  if (raw.includes("\\")) {
    return { ok: false, reason: "backslash_not_allowed" };
  }
  if (raw.startsWith("/") || raw.startsWith("//") || WINDOWS_DRIVE_PREFIX.test(raw)) {
    return { ok: false, reason: "absolute_path_not_allowed" };
  }
  if (URL_SCHEME_PREFIX.test(raw)) {
    return { ok: false, reason: "uri_path_not_allowed" };
  }
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    return { ok: false, reason: "path_required" };
  }
  for (const part of parts) {
    if (part === "..") {
      return { ok: false, reason: "parent_path_not_allowed" };
    }
    if (part.length > 255) {
      return { ok: false, reason: "path_segment_too_long" };
    }
  }
  return { ok: true, normalized: parts.join("/") };
}

export function assertMswarmSafeRelativePath(path: unknown, label = "path"): string {
  const result = normalizeMswarmSafeRelativePath(path);
  if (!result.ok || !result.normalized) {
    throw new Error(`${label}_${result.reason || "invalid"}`);
  }
  return result.normalized;
}

export function validateMswarmOutputSpecPath(output: MswarmOutputSpec): MswarmPathValidationResult {
  return normalizeMswarmSafeRelativePath(output.path);
}

export function validateMswarmArchiveEntry(entry: MswarmArchiveEntryCheck): MswarmPathValidationResult {
  const type = entry.type || "file";
  if (type === "symlink" || type === "hardlink" || type === "device" || type === "other") {
    return { ok: false, reason: `archive_${type}_not_allowed` };
  }
  if (Number.isFinite(entry.size_bytes) && entry.size_bytes !== undefined && entry.size_bytes < 0) {
    return { ok: false, reason: "negative_size_not_allowed" };
  }
  return normalizeMswarmSafeRelativePath(entry.path);
}

export function defaultMswarmArtifactAccessPolicy(
  visibility: MswarmArtifactVisibility = "owner-local"
): MswarmArtifactAccessPolicy {
  return {
    visibility,
    read_by: visibility === "tenant-scoped" ? ["runner", "tenant", "gateway"] : ["runner", "owner"],
    write_by: visibility === "tenant-scoped" ? ["runner", "gateway"] : ["runner", "owner"],
  };
}

export function defaultMswarmArtifactRetentionPolicy(retainForSeconds = 86_400): MswarmArtifactRetentionPolicy {
  return {
    retain_for_seconds: retainForSeconds,
  };
}

export function buildMswarmLocalArtifactUri(jobId: string, relativePath: string): string {
  const normalizedJobId = assertMswarmSafeRelativePath(jobId.replace(/[^a-zA-Z0-9_.-]/g, "_"), "job_id");
  const normalizedPath = assertMswarmSafeRelativePath(relativePath, "artifact_path");
  return `artifact://local/${normalizedJobId}/${normalizedPath}`;
}

export function buildMswarmSandboxProfile(input: {
  policy: MswarmJobPolicy;
  limits?: MswarmJobLimits;
  containerized?: boolean;
  gpu?: "none" | "nvidia";
}): MswarmSandboxProfile {
  const containerized = input.containerized === true;
  const gpu = input.gpu || "none";
  const name: MswarmSandboxProfileName = containerized
    ? gpu === "nvidia"
      ? "container-nvidia"
      : "container-cpu"
    : "owner-local-process";
  return {
    schema_version: MSWARM_ARTIFACT_SANDBOX_SCHEMA_VERSION,
    name,
    trust_mode: input.policy.trust_mode,
    network: input.policy.network || "none",
    allow_raw_command: false,
    filesystem: {
      working_directory: "per-job",
      inputs: "read-only",
      outputs: "write-only",
      allow_host_paths: false,
      validate_output_paths: true,
      validate_archive_entries: true,
    },
    container: {
      enabled: containerized,
      rootless: true,
      user: "65532:65532",
      privileged: false,
      read_only_root_fs: true,
      gpu,
      ...(input.policy.allowed_images?.length ? { allowed_images: [...input.policy.allowed_images] } : {}),
    },
    limits: {
      timeout_sec: input.limits?.timeout_sec,
      max_stdout_bytes: input.limits?.max_stdout_bytes,
      max_stderr_bytes: input.limits?.max_stderr_bytes,
      max_output_bytes: input.limits?.max_output_bytes,
      max_artifact_bytes: input.policy.max_artifact_bytes,
    },
  };
}
