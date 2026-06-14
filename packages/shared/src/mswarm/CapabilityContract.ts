import type {
  MswarmGpuVendor,
  MswarmJobTrustMode,
  MswarmJobType,
} from "./GenericJobContract.js";

export const MSWARM_CAPABILITY_SCHEMA_VERSION = "2026-06-14" as const;

export const MSWARM_CAPABILITY_PROBE_STATUSES = [
  "available",
  "missing",
  "error",
  "unknown",
] as const;

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
    docker_nvidia: { available: boolean; status: MswarmCapabilityProbeStatus };
    blender: { available: boolean; status: MswarmCapabilityProbeStatus };
    ffmpeg: { available: boolean; status: MswarmCapabilityProbeStatus };
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

function sortedUnique<T extends string>(values: Array<T | undefined | null>): T[] {
  return Array.from(
    new Set(values.filter((value): value is T => typeof value === "string" && value.length > 0))
  ).sort();
}

function softwareAvailable(result: MswarmSoftwareProbeResult | undefined): boolean {
  return result?.status === "available";
}

function hasCuda(snapshot: MswarmNodeCapabilitySnapshot): boolean {
  return (
    Boolean(snapshot.gpu.cuda_versions?.length) ||
    snapshot.gpu.devices.some((device) => {
      const caps = device.capabilities || [];
      return Boolean(device.cuda_version) || caps.some((capability) => capability.toLowerCase() === "cuda");
    })
  );
}

function publicVramTier(maxVramGb: number | undefined): MswarmPublicVramTier {
  if (!Number.isFinite(maxVramGb) || !maxVramGb || maxVramGb <= 0) return "none";
  if (maxVramGb < 8) return "lt8";
  if (maxVramGb < 16) return "8-15";
  if (maxVramGb < 32) return "16-31";
  return "32plus";
}

export function buildMswarmCapabilityNames(snapshot: MswarmNodeCapabilitySnapshot): string[] {
  const names: string[] = [];
  if (snapshot.generic_jobs_enabled) {
    names.push("generic_jobs");
  }
  for (const jobType of snapshot.job_types) {
    names.push(`job_type:${jobType}`);
  }
  if (snapshot.gpu.status === "available" && snapshot.gpu.count > 0) {
    names.push("gpu");
    for (const vendor of snapshot.gpu.vendors) {
      names.push(`gpu.${vendor}`);
    }
  }
  if (hasCuda(snapshot)) {
    names.push("cuda");
  }
  if (softwareAvailable(snapshot.software.docker)) {
    names.push("software.docker");
  }
  if (softwareAvailable(snapshot.software["docker-nvidia"])) {
    names.push("docker.nvidia");
  }
  if (softwareAvailable(snapshot.software.blender)) {
    names.push("software.blender");
  }
  if (softwareAvailable(snapshot.software.ffmpeg)) {
    names.push("software.ffmpeg");
  }
  return sortedUnique(names);
}

export function buildMswarmSchedulerMatchInput(
  snapshot: MswarmNodeCapabilitySnapshot
): MswarmSchedulerMatchInput {
  return {
    schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
    snapshot_id: snapshot.snapshot_id,
    node_id: snapshot.node_id,
    updated_at: snapshot.captured_at,
    generic_jobs_enabled: snapshot.generic_jobs_enabled,
    available_job_types: sortedUnique(snapshot.job_types),
    trust_modes: sortedUnique(snapshot.trust_modes),
    resources: {
      gpu_count: snapshot.gpu.count,
      gpu_vendors: sortedUnique(snapshot.gpu.vendors),
      ...(Number.isFinite(snapshot.gpu.max_vram_gb) ? { max_vram_gb: snapshot.gpu.max_vram_gb } : {}),
      has_cuda: hasCuda(snapshot),
      software: {
        docker_nvidia: softwareAvailable(snapshot.software["docker-nvidia"]),
        blender: softwareAvailable(snapshot.software.blender),
        ffmpeg: softwareAvailable(snapshot.software.ffmpeg),
      },
    },
    capabilities: buildMswarmCapabilityNames(snapshot),
  };
}

export function projectMswarmPublicCapabilities(
  snapshot: MswarmNodeCapabilitySnapshot
): MswarmPublicCapabilityProjection {
  return {
    schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
    snapshot_id: snapshot.snapshot_id,
    captured_at: snapshot.captured_at,
    generic_jobs_enabled: snapshot.generic_jobs_enabled,
    job_types: sortedUnique(snapshot.job_types),
    accelerators: {
      gpu: {
        available: snapshot.gpu.status === "available" && snapshot.gpu.count > 0,
        count: snapshot.gpu.count,
        vendors: sortedUnique(snapshot.gpu.vendors),
        cuda: hasCuda(snapshot),
        vram_tier: publicVramTier(snapshot.gpu.max_vram_gb),
      },
    },
    software: {
      docker_nvidia: {
        available: softwareAvailable(snapshot.software["docker-nvidia"]),
        status: snapshot.software["docker-nvidia"].status,
      },
      blender: {
        available: softwareAvailable(snapshot.software.blender),
        status: snapshot.software.blender.status,
      },
      ffmpeg: {
        available: softwareAvailable(snapshot.software.ffmpeg),
        status: snapshot.software.ffmpeg.status,
      },
    },
    capabilities: buildMswarmCapabilityNames(snapshot),
  };
}

export function buildMswarmPrivateCapabilityCatalogEntry(
  snapshot: MswarmNodeCapabilitySnapshot
): MswarmPrivateCapabilityCatalogEntry {
  return {
    node_id: snapshot.node_id,
    snapshot_id: snapshot.snapshot_id,
    captured_at: snapshot.captured_at,
    snapshot,
    scheduler_match: buildMswarmSchedulerMatchInput(snapshot),
    public_projection: projectMswarmPublicCapabilities(snapshot),
  };
}
