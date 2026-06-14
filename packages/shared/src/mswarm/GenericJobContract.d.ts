export declare const MSWARM_GENERIC_JOB_SCHEMA_VERSION: "2026-06-14";
export declare const MSWARM_GENERIC_JOB_SCHEMA_VERSIONS: readonly ["2026-06-14"];
export type MswarmJobSchemaVersion = (typeof MSWARM_GENERIC_JOB_SCHEMA_VERSIONS)[number];
export declare const MSWARM_KNOWN_JOB_TYPES: readonly ["render.blender", "cuda.run", "ffmpeg.cuda", "python.gpu", "package.job"];
export type MswarmKnownJobType = (typeof MSWARM_KNOWN_JOB_TYPES)[number];
export type MswarmRegisteredJobType = `tenant.${string}` | `package.${string}`;
export type MswarmJobType = MswarmKnownJobType | MswarmRegisteredJobType;
export declare const MSWARM_JOB_STATUSES: readonly ["queued", "running", "succeeded", "failed", "cancelled", "expired"];
export type MswarmJobStatus = (typeof MSWARM_JOB_STATUSES)[number];
export declare const MSWARM_JOB_EVENT_TYPES: readonly ["queued", "scheduled", "started", "heartbeat", "stdout", "stderr", "log_truncated", "progress", "metric", "artifact", "completed", "failed", "cancelled"];
export type MswarmJobEventType = (typeof MSWARM_JOB_EVENT_TYPES)[number];
export declare const MSWARM_JOB_TRUST_MODES: readonly ["owner-local", "tenant-owned"];
export type MswarmJobTrustMode = (typeof MSWARM_JOB_TRUST_MODES)[number];
export declare const MSWARM_JOB_NETWORK_POLICIES: readonly ["none", "egress-allowlist"];
export type MswarmJobNetworkPolicy = (typeof MSWARM_JOB_NETWORK_POLICIES)[number];
export type MswarmGpuVendor = "nvidia" | "amd" | "apple" | (string & {});
export declare const MSWARM_ARTIFACT_SCOPES: readonly ["input", "output", "log", "manifest"];
export type MswarmArtifactScope = (typeof MSWARM_ARTIFACT_SCOPES)[number];
export type MswarmGenericJobErrorCode = "invalid_request" | "invalid_schema_version" | "invalid_job_type" | "unregistered_job_type" | "invalid_registered_job_catalog" | "invalid_policy" | "invalid_limits" | "invalid_resources" | "invalid_artifact" | "invalid_output" | "invalid_args" | "unknown_field" | "llm_field_not_allowed" | "unsafe_field" | "unsafe_artifact_uri" | "unsafe_path";
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
export declare const MSWARM_KNOWN_JOB_ARG_KEYS: Record<MswarmKnownJobType, readonly string[]>;
export declare function isMswarmKnownJobType(value: unknown): value is MswarmKnownJobType;
export declare function isMswarmRegisteredJobType(value: unknown): value is MswarmRegisteredJobType;
export declare function isMswarmJobType(value: unknown): value is MswarmJobType;
export declare function validateMswarmGenericJobRequest(input: unknown, options?: MswarmGenericJobValidationOptions): MswarmGenericJobValidationResult;
export declare function isMswarmGenericJobRequest(input: unknown, options?: MswarmGenericJobValidationOptions): input is MswarmJobRequest;
//# sourceMappingURL=GenericJobContract.d.ts.map