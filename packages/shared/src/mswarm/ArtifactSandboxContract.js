export const MSWARM_ARTIFACT_SANDBOX_SCHEMA_VERSION = "2026-06-14";
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
export function normalizeMswarmSafeRelativePath(path) {
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
export function assertMswarmSafeRelativePath(path, label = "path") {
    const result = normalizeMswarmSafeRelativePath(path);
    if (!result.ok || !result.normalized) {
        throw new Error(`${label}_${result.reason || "invalid"}`);
    }
    return result.normalized;
}
export function validateMswarmOutputSpecPath(output) {
    return normalizeMswarmSafeRelativePath(output.path);
}
export function validateMswarmArchiveEntry(entry) {
    const type = entry.type || "file";
    if (type === "symlink" || type === "hardlink" || type === "device" || type === "other") {
        return { ok: false, reason: `archive_${type}_not_allowed` };
    }
    if (Number.isFinite(entry.size_bytes) && entry.size_bytes !== undefined && entry.size_bytes < 0) {
        return { ok: false, reason: "negative_size_not_allowed" };
    }
    return normalizeMswarmSafeRelativePath(entry.path);
}
export function defaultMswarmArtifactAccessPolicy(visibility = "owner-local") {
    return {
        visibility,
        read_by: visibility === "tenant-scoped" ? ["runner", "tenant", "gateway"] : ["runner", "owner"],
        write_by: visibility === "tenant-scoped" ? ["runner", "gateway"] : ["runner", "owner"],
    };
}
export function defaultMswarmArtifactRetentionPolicy(retainForSeconds = 86400) {
    return {
        retain_for_seconds: retainForSeconds,
    };
}
export function buildMswarmLocalArtifactUri(jobId, relativePath) {
    const normalizedJobId = assertMswarmSafeRelativePath(jobId.replace(/[^a-zA-Z0-9_.-]/g, "_"), "job_id");
    const normalizedPath = assertMswarmSafeRelativePath(relativePath, "artifact_path");
    return `artifact://local/${normalizedJobId}/${normalizedPath}`;
}
export function buildMswarmSandboxProfile(input) {
    const containerized = input.containerized === true;
    const gpu = input.gpu || "none";
    const name = containerized
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
