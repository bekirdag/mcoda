export const MSWARM_GENERIC_JOB_SCHEMA_VERSION = "2026-06-14";
export const MSWARM_GENERIC_JOB_SCHEMA_VERSIONS = [
    MSWARM_GENERIC_JOB_SCHEMA_VERSION,
];
export const MSWARM_KNOWN_JOB_TYPES = [
    "render.blender",
    "cuda.run",
    "ffmpeg.cuda",
    "python.gpu",
    "package.job",
];
export const MSWARM_JOB_STATUSES = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
];
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
];
export const MSWARM_JOB_TRUST_MODES = ["owner-local", "tenant-owned"];
export const MSWARM_JOB_NETWORK_POLICIES = ["none", "egress-allowlist"];
export const MSWARM_ARTIFACT_SCOPES = ["input", "output", "log", "manifest"];
const KNOWN_JOB_TYPE_SET = new Set(MSWARM_KNOWN_JOB_TYPES);
const SCHEMA_VERSION_SET = new Set(MSWARM_GENERIC_JOB_SCHEMA_VERSIONS);
const TRUST_MODE_SET = new Set(MSWARM_JOB_TRUST_MODES);
const NETWORK_POLICY_SET = new Set(MSWARM_JOB_NETWORK_POLICIES);
const ARTIFACT_SCOPE_SET = new Set(MSWARM_ARTIFACT_SCOPES);
const COMMON_REQUEST_KEYS = new Set([
    "schema_version",
    "job_type",
    "idempotency_key",
    "runner_hint",
    "inputs",
    "args",
    "resources",
    "limits",
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
export const MSWARM_KNOWN_JOB_ARG_KEYS = {
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
const JOB_TYPE_ARG_KEYS = {
    "render.blender": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["render.blender"]),
    "cuda.run": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["cuda.run"]),
    "ffmpeg.cuda": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["ffmpeg.cuda"]),
    "python.gpu": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["python.gpu"]),
    "package.job": new Set(MSWARM_KNOWN_JOB_ARG_KEYS["package.job"]),
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const asNonEmptyString = (value) => {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
const isPositiveInteger = (value) => typeof value === "number" && Number.isInteger(value) && value > 0;
const pushIssue = (issues, issue) => {
    issues.push(issue);
};
const isPathOrChildPath = (path, prefix) => path === prefix || path.startsWith(`${prefix}.`);
const validateStringArray = (value, path, issues) => {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        pushIssue(issues, {
            code: "invalid_request",
            path,
            message: "Expected an array of non-empty strings.",
            value,
        });
        return undefined;
    }
    const strings = [];
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
const validatePositiveIntegerField = (record, key, path, code, issues) => {
    const value = record[key];
    if (value === undefined)
        return undefined;
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
const validateRegisteredCatalogPolicy = (value, path, issues) => {
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
const findRegisteredCatalogEntry = (jobType, options, issues) => {
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
    const entry = catalog[index];
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
        args_schema: entry.args_schema,
        policy: entry.policy,
        runner,
    };
};
export function isMswarmKnownJobType(value) {
    const normalized = asNonEmptyString(value);
    return normalized ? KNOWN_JOB_TYPE_SET.has(normalized) : false;
}
export function isMswarmRegisteredJobType(value) {
    const normalized = asNonEmptyString(value);
    return Boolean(normalized &&
        (normalized.startsWith("tenant.") || normalized.startsWith("package.")) &&
        normalized.split(".").every((part) => /^[a-z0-9][a-z0-9-]*$/.test(part)));
}
export function isMswarmJobType(value) {
    return isMswarmKnownJobType(value) || isMswarmRegisteredJobType(value);
}
const validateSchemaVersion = (value, issues) => {
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
    return normalized;
};
const validateJobType = (value, options, issues) => {
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
        const catalogEntry = findRegisteredCatalogEntry(normalized, options, issues);
        if (!catalogEntry) {
            return undefined;
        }
    }
    return normalized;
};
const validatePolicy = (value, issues) => {
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
        if (![
            "trust_mode",
            "network",
            "allow_raw_command",
            "allowed_images",
            "allowed_package_publishers",
            "max_artifact_bytes",
        ].includes(key)) {
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
    const allowedPackagePublishers = validateStringArray(value.allowed_package_publishers, "policy.allowed_package_publishers", issues);
    const maxArtifactBytes = validatePositiveIntegerField(value, "max_artifact_bytes", "policy", "invalid_policy", issues);
    if (issues.some((issue) => isPathOrChildPath(issue.path, "policy"))) {
        return undefined;
    }
    return {
        trust_mode: trustMode,
        network: network,
        ...(value.allow_raw_command === false ? { allow_raw_command: false } : {}),
        ...(allowedImages ? { allowed_images: allowedImages } : {}),
        ...(allowedPackagePublishers ? { allowed_package_publishers: allowedPackagePublishers } : {}),
        ...(maxArtifactBytes !== undefined ? { max_artifact_bytes: maxArtifactBytes } : {}),
    };
};
const validateLimits = (value, issues) => {
    if (value === undefined)
        return undefined;
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
    const limits = {};
    for (const key of allowed) {
        const normalized = validatePositiveIntegerField(value, key, "limits", "invalid_limits", issues);
        if (normalized !== undefined) {
            limits[key] = normalized;
        }
    }
    return Object.keys(limits).length > 0 ? limits : undefined;
};
const validateRelativeSandboxPath = (value, path, issues) => {
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
    if (normalized.startsWith("/") ||
        normalized.startsWith("~") ||
        normalized.includes("\\") ||
        parts.some((part) => part === ".." || part === "")) {
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
const validateArtifactUri = (value, path, options, issues) => {
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
    if (normalized.startsWith("artifact://"))
        return normalized;
    if (options.allowSignedArtifactUrls && normalized.startsWith("https://"))
        return normalized;
    pushIssue(issues, {
        code: "unsafe_artifact_uri",
        path,
        message: "Artifact uri must be artifact:// unless a signed URL flow explicitly allows https://.",
        value,
    });
    return undefined;
};
const validateArtifactRef = (value, path, options, issues) => {
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
    const artifact = { uri: uri ?? "" };
    for (const key of ["id", "name", "content_type", "sha256"]) {
        if (value[key] !== undefined) {
            const normalized = asNonEmptyString(value[key]);
            if (!normalized) {
                pushIssue(issues, {
                    code: "invalid_artifact",
                    path: `${path}.${key}`,
                    message: "Expected a non-empty string.",
                    value: value[key],
                });
            }
            else {
                artifact[key] = normalized;
            }
        }
    }
    const sizeBytes = validatePositiveIntegerField(value, "size_bytes", path, "invalid_artifact", issues);
    if (sizeBytes !== undefined)
        artifact.size_bytes = sizeBytes;
    if (value.scope !== undefined) {
        const scope = asNonEmptyString(value.scope);
        if (!scope || !ARTIFACT_SCOPE_SET.has(scope)) {
            pushIssue(issues, {
                code: "invalid_artifact",
                path: `${path}.scope`,
                message: "Invalid artifact scope.",
                value: value.scope,
            });
        }
        else {
            artifact.scope = scope;
        }
    }
    return uri ? artifact : undefined;
};
const validateInputs = (value, options, issues) => {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        pushIssue(issues, {
            code: "invalid_artifact",
            path: "inputs",
            message: "Inputs must be an array.",
            value,
        });
        return undefined;
    }
    const inputs = [];
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
        const mountPath = item.mount_path === undefined
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
const validateOutputs = (value, issues) => {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        pushIssue(issues, {
            code: "invalid_output",
            path: "outputs",
            message: "Outputs must be an array.",
            value,
        });
        return undefined;
    }
    const outputs = [];
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
const validateResources = (value, issues) => {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        pushIssue(issues, {
            code: "invalid_resources",
            path: "resources",
            message: "Resources must be an object.",
            value,
        });
        return undefined;
    }
    const resources = {};
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
    if (memoryGb !== undefined)
        resources.memory_gb = memoryGb;
    if (diskGb !== undefined)
        resources.disk_gb = diskGb;
    if (value.cpu !== undefined) {
        if (!isRecord(value.cpu)) {
            pushIssue(issues, {
                code: "invalid_resources",
                path: "resources.cpu",
                message: "CPU resources must be an object.",
                value: value.cpu,
            });
        }
        else {
            const cores = validatePositiveIntegerField(value.cpu, "cores", "resources.cpu", "invalid_resources", issues);
            if (cores !== undefined)
                resources.cpu = { cores };
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
        }
        else {
            const gpu = {};
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
            const minVramGb = validatePositiveIntegerField(value.gpu, "min_vram_gb", "resources.gpu", "invalid_resources", issues);
            const vendor = value.gpu.vendor === undefined ? undefined : asNonEmptyString(value.gpu.vendor);
            const cudaMinVersion = value.gpu.cuda_min_version === undefined
                ? undefined
                : asNonEmptyString(value.gpu.cuda_min_version);
            const capabilities = validateStringArray(value.gpu.capabilities, "resources.gpu.capabilities", issues);
            if (count !== undefined)
                gpu.count = count;
            if (minVramGb !== undefined)
                gpu.min_vram_gb = minVramGb;
            if (vendor)
                gpu.vendor = vendor;
            if (value.gpu.vendor !== undefined && !vendor) {
                pushIssue(issues, {
                    code: "invalid_resources",
                    path: "resources.gpu.vendor",
                    message: "GPU vendor must be a non-empty string.",
                    value: value.gpu.vendor,
                });
            }
            if (cudaMinVersion)
                gpu.cuda_min_version = cudaMinVersion;
            if (value.gpu.cuda_min_version !== undefined && !cudaMinVersion) {
                pushIssue(issues, {
                    code: "invalid_resources",
                    path: "resources.gpu.cuda_min_version",
                    message: "CUDA minimum version must be a non-empty string.",
                    value: value.gpu.cuda_min_version,
                });
            }
            if (capabilities)
                gpu.capabilities = capabilities;
            if (Object.keys(gpu).length > 0)
                resources.gpu = gpu;
        }
    }
    return Object.keys(resources).length > 0 ? resources : undefined;
};
const validateArgs = (value, jobType, issues) => {
    if (value === undefined)
        return undefined;
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
const validateKnownJobArgKeys = (jobType, value, issues) => {
    const allowedKeys = JOB_TYPE_ARG_KEYS[jobType];
    for (const [key, fieldValue] of Object.entries(value)) {
        if (UNSAFE_ARG_KEYS.has(key))
            continue;
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
const validateRenderBlenderArgs = (value, issues) => {
    validateKnownJobArgKeys("render.blender", value, issues);
};
const validateCudaRunArgs = (value, issues) => {
    validateKnownJobArgKeys("cuda.run", value, issues);
};
const validateFfmpegCudaArgs = (value, issues) => {
    validateKnownJobArgKeys("ffmpeg.cuda", value, issues);
};
const validatePythonGpuArgs = (value, issues) => {
    validateKnownJobArgKeys("python.gpu", value, issues);
};
const validatePackageJobArgs = (value, issues) => {
    validateKnownJobArgKeys("package.job", value, issues);
};
const KNOWN_JOB_ARG_VALIDATORS = {
    "render.blender": validateRenderBlenderArgs,
    "cuda.run": validateCudaRunArgs,
    "ffmpeg.cuda": validateFfmpegCudaArgs,
    "python.gpu": validatePythonGpuArgs,
    "package.job": validatePackageJobArgs,
};
const validateMetadata = (value, issues) => {
    if (value === undefined)
        return undefined;
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
export function validateMswarmGenericJobRequest(input, options = {}) {
    const issues = [];
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
            ...(outputs ? { outputs } : {}),
            policy,
            ...(metadata ? { metadata } : {}),
        },
    };
}
export function isMswarmGenericJobRequest(input, options = {}) {
    return validateMswarmGenericJobRequest(input, options).ok;
}
//# sourceMappingURL=GenericJobContract.js.map