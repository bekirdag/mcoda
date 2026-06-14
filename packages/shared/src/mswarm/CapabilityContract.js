export const MSWARM_CAPABILITY_SCHEMA_VERSION = "2026-06-14";
export const MSWARM_CAPABILITY_PROBE_STATUSES = [
    "available",
    "missing",
    "error",
    "unknown",
];
function sortedUnique(values) {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0))).sort();
}
function softwareAvailable(result) {
    return result?.status === "available";
}
function hasCuda(snapshot) {
    return (Boolean(snapshot.gpu.cuda_versions?.length) ||
        snapshot.gpu.devices.some((device) => {
            const caps = device.capabilities || [];
            return Boolean(device.cuda_version) || caps.some((capability) => capability.toLowerCase() === "cuda");
        }));
}
function publicVramTier(maxVramGb) {
    if (!Number.isFinite(maxVramGb) || !maxVramGb || maxVramGb <= 0)
        return "none";
    if (maxVramGb < 8)
        return "lt8";
    if (maxVramGb < 16)
        return "8-15";
    if (maxVramGb < 32)
        return "16-31";
    return "32plus";
}
export function buildMswarmCapabilityNames(snapshot) {
    const names = [];
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
export function buildMswarmSchedulerMatchInput(snapshot) {
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
export function projectMswarmPublicCapabilities(snapshot) {
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
export function buildMswarmPrivateCapabilityCatalogEntry(snapshot) {
    return {
        node_id: snapshot.node_id,
        snapshot_id: snapshot.snapshot_id,
        captured_at: snapshot.captured_at,
        snapshot,
        scheduler_match: buildMswarmSchedulerMatchInput(snapshot),
        public_projection: projectMswarmPublicCapabilities(snapshot),
    };
}
