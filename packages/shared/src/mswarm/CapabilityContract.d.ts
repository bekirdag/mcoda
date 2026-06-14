import type { MswarmGpuVendor, MswarmJobTrustMode, MswarmJobType } from "./GenericJobContract.js";
export declare const MSWARM_CAPABILITY_SCHEMA_VERSION: "2026-06-14";
export declare const MSWARM_CAPABILITY_PROBE_STATUSES: readonly ["available", "missing", "error", "unknown"];
export type MswarmCapabilitySchemaVersion = typeof MSWARM_CAPABILITY_SCHEMA_VERSION;
export type MswarmCapabilityProbeStatus = (typeof MSWARM_CAPABILITY_PROBE_STATUSES)[number];
export type MswarmSoftwareProbeName = "docker" | "docker-nvidia" | "blender" | "ffmpeg";
export type MswarmPublicVramTier = "none" | "lt8" | "8-15" | "16-31" | "32plus";
export interface MswarmSoftwareProbeResult {
    name: MswarmSoftwareProbeName;
    status: MswarmCapabilityProbeStatus;
    version?: string;
    message?: string;
}
export interface MswarmGpuDeviceCapability {
    id: string;
    vendor: MswarmGpuVendor;
    name?: string;
    vram_gb?: number;
    driver_version?: string;
    cuda_version?: string;
    compute_capability?: string;
    capabilities?: string[];
}
export interface MswarmGpuCapabilityProbe {
    status: MswarmCapabilityProbeStatus;
    count: number;
    vendors: MswarmGpuVendor[];
    devices: MswarmGpuDeviceCapability[];
    cuda_versions?: string[];
    max_vram_gb?: number;
    message?: string;
}
export interface MswarmRunnerCatalogCapability {
    job_type: MswarmJobType;
    runner: string;
    trust_modes: MswarmJobTrustMode[];
    required_capabilities?: string[];
}
export interface MswarmNodeCapabilitySnapshot {
    schema_version: MswarmCapabilitySchemaVersion;
    snapshot_id: string;
    captured_at: string;
    node_id?: string;
    platform?: string;
    arch?: string;
    generic_jobs_enabled: boolean;
    job_types: MswarmJobType[];
    trust_modes: MswarmJobTrustMode[];
    gpu: MswarmGpuCapabilityProbe;
    software: Record<MswarmSoftwareProbeName, MswarmSoftwareProbeResult>;
    runner_catalog: MswarmRunnerCatalogCapability[];
    diagnostics?: Array<{
        name: string;
        status: Exclude<MswarmCapabilityProbeStatus, "available">;
        message?: string;
    }>;
}
export interface MswarmSchedulerMatchInput {
    schema_version: MswarmCapabilitySchemaVersion;
    snapshot_id: string;
    node_id?: string;
    updated_at: string;
    generic_jobs_enabled: boolean;
    available_job_types: MswarmJobType[];
    trust_modes: MswarmJobTrustMode[];
    resources: {
        gpu_count: number;
        gpu_vendors: MswarmGpuVendor[];
        max_vram_gb?: number;
        has_cuda: boolean;
        software: {
            docker_nvidia: boolean;
            blender: boolean;
            ffmpeg: boolean;
        };
    };
    capabilities: string[];
}
export interface MswarmPublicCapabilityProjection {
    schema_version: MswarmCapabilitySchemaVersion;
    snapshot_id: string;
    captured_at: string;
    generic_jobs_enabled: boolean;
    job_types: MswarmJobType[];
    accelerators: {
        gpu: {
            available: boolean;
            count: number;
            vendors: MswarmGpuVendor[];
            cuda: boolean;
            vram_tier: MswarmPublicVramTier;
        };
    };
    software: {
        docker_nvidia: {
            available: boolean;
            status: MswarmCapabilityProbeStatus;
        };
        blender: {
            available: boolean;
            status: MswarmCapabilityProbeStatus;
        };
        ffmpeg: {
            available: boolean;
            status: MswarmCapabilityProbeStatus;
        };
    };
    capabilities: string[];
}
export interface MswarmPrivateCapabilityCatalogEntry {
    node_id?: string;
    snapshot_id: string;
    captured_at: string;
    snapshot: MswarmNodeCapabilitySnapshot;
    scheduler_match: MswarmSchedulerMatchInput;
    public_projection: MswarmPublicCapabilityProjection;
}
export interface MswarmCapabilitySignature {
    alg: "HS256";
    value: string;
    signed_at: string;
    key_id?: string;
}
export interface MswarmSignedCapabilityPayload {
    schema_version: MswarmCapabilitySchemaVersion;
    snapshot_id: string;
    private_catalog_entry: MswarmPrivateCapabilityCatalogEntry;
    scheduler_match: MswarmSchedulerMatchInput;
    public_projection: MswarmPublicCapabilityProjection;
    signature: MswarmCapabilitySignature;
}
export declare function buildMswarmCapabilityNames(snapshot: MswarmNodeCapabilitySnapshot): string[];
export declare function buildMswarmSchedulerMatchInput(snapshot: MswarmNodeCapabilitySnapshot): MswarmSchedulerMatchInput;
export declare function projectMswarmPublicCapabilities(snapshot: MswarmNodeCapabilitySnapshot): MswarmPublicCapabilityProjection;
export declare function buildMswarmPrivateCapabilityCatalogEntry(snapshot: MswarmNodeCapabilitySnapshot): MswarmPrivateCapabilityCatalogEntry;
//# sourceMappingURL=CapabilityContract.d.ts.map