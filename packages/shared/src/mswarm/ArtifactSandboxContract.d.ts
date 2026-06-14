import type { MswarmArtifactRef, MswarmArtifactScope, MswarmJobLimits, MswarmJobNetworkPolicy, MswarmJobPolicy, MswarmJobTrustMode, MswarmOutputSpec } from "./GenericJobContract.js";
export declare const MSWARM_ARTIFACT_SANDBOX_SCHEMA_VERSION: "2026-06-14";
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
export declare function normalizeMswarmSafeRelativePath(path: unknown): MswarmPathValidationResult;
export declare function assertMswarmSafeRelativePath(path: unknown, label?: string): string;
export declare function validateMswarmOutputSpecPath(output: MswarmOutputSpec): MswarmPathValidationResult;
export declare function validateMswarmArchiveEntry(entry: MswarmArchiveEntryCheck): MswarmPathValidationResult;
export declare function defaultMswarmArtifactAccessPolicy(visibility?: MswarmArtifactVisibility): MswarmArtifactAccessPolicy;
export declare function defaultMswarmArtifactRetentionPolicy(retainForSeconds?: number): MswarmArtifactRetentionPolicy;
export declare function buildMswarmLocalArtifactUri(jobId: string, relativePath: string): string;
export declare function buildMswarmSandboxProfile(input: {
    policy: MswarmJobPolicy;
    limits?: MswarmJobLimits;
    containerized?: boolean;
    gpu?: "none" | "nvidia";
}): MswarmSandboxProfile;
//# sourceMappingURL=ArtifactSandboxContract.d.ts.map