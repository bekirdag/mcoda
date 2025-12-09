import { access, constants, readFile, stat } from "node:fs/promises";
import path from "node:path";
const fileExists = async (filePath) => {
    try {
        await access(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
const openapiRule = {
    id: "openapi-source-of-truth",
    title: "OpenAPI is present and readable",
    severity: "error",
    async check(context) {
        const openapiPath = context.openapiPath;
        const exists = await fileExists(openapiPath);
        if (!exists) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: `Missing OpenAPI spec at ${openapiPath}`,
                remediation: "Create openapi/mcoda.yaml per SDS 6 and regenerate clients.",
            };
        }
        const content = await readFile(openapiPath, "utf8");
        if (!content.trim().length) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: "OpenAPI spec is empty; cannot be treated as source of truth.",
                remediation: "Author the spec before implementing commands or migrations.",
            };
        }
        if (!/^openapi:\s*3\./m.test(content)) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "warn",
                message: "OpenAPI spec does not declare version 3.x.",
                remediation: "Align spec header with OpenAPI 3.x and SDS Section 6.",
            };
        }
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "pass",
            message: "OpenAPI spec found.",
        };
    },
};
const openapiVersionRule = {
    id: "openapi-version-alignment",
    title: "OpenAPI version matches CLI version",
    severity: "warn",
    async check(context) {
        const pkgPath = path.join(context.repoRoot, "package.json");
        let pkgVersion;
        try {
            const pkgRaw = await readFile(pkgPath, "utf8");
            const pkg = JSON.parse(pkgRaw);
            pkgVersion = pkg.version;
        }
        catch {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "warn",
                message: `Unable to read package.json at ${pkgPath}; cannot compare versions.`,
                remediation: "Ensure package.json exists with a version field to align with SDS Section 6.3.",
            };
        }
        let openapiRaw;
        try {
            openapiRaw = await readFile(context.openapiPath, "utf8");
        }
        catch {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "warn",
                message: `Unable to read OpenAPI spec at ${context.openapiPath}.`,
                remediation: "Ensure openapi/mcoda.yaml exists before running guardrails so version alignment can be checked.",
            };
        }
        const versionMatch = openapiRaw.match(/\bversion:\s*"?([0-9A-Za-z.+-]+)"?/);
        const openapiVersion = versionMatch?.[1];
        if (!pkgVersion || !openapiVersion) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "warn",
                message: "Missing version fields on package.json or OpenAPI info block.",
                remediation: "Set info.version in openapi/mcoda.yaml to match package.json version per SDS 6.3 (SemVer tied to CLI release).",
            };
        }
        if (pkgVersion !== openapiVersion) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: `OpenAPI info.version (${openapiVersion}) does not match package.json version (${pkgVersion}).`,
                remediation: "Update info.version in openapi/mcoda.yaml or bump package.json to keep CLI/OpenAPI versions in lockstep (SDS 6.3).",
            };
        }
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "pass",
            message: `OpenAPI version ${openapiVersion} matches CLI package version.`,
        };
    },
};
const gitignoreRule = {
    id: "gitignore-mcoda",
    title: ".mcoda is gitignored",
    severity: "error",
    async check(context) {
        const gitignorePath = context.gitignorePath;
        const exists = await fileExists(gitignorePath);
        if (!exists) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: `.gitignore missing at ${gitignorePath}; .mcoda/ must not be committed.`,
                remediation: "Add a .gitignore with .mcoda/ entry before running stateful commands.",
            };
        }
        const content = await readFile(gitignorePath, "utf8");
        const hasEntry = content
            .split(/\r?\n/)
            .some((line) => line.trim() === ".mcoda/" || line.trim() === ".mcoda");
        if (!hasEntry) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: ".gitignore does not contain .mcoda/ entry.",
                remediation: "Add `.mcoda/` to .gitignore to keep workspace state out of VCS.",
            };
        }
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "pass",
            message: ".mcoda/ is ignored by git.",
        };
    },
};
const workspaceStateRule = {
    id: "workspace-state-dir",
    title: "Workspace state directory exists",
    severity: "warn",
    async check(context) {
        const statePath = path.join(context.workspaceRoot, ".mcoda");
        const exists = await fileExists(statePath);
        if (!exists) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "warn",
                message: `Workspace state directory missing at ${statePath}.`,
                remediation: "Create <repo>/.mcoda before stateful commands so DBs/logs/prompts have a stable home.",
            };
        }
        const stats = await stat(statePath);
        if (!stats.isDirectory()) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: `${statePath} exists but is not a directory.`,
                remediation: "Replace with a directory to hold workspace DB, logs, prompts, and checkpoints.",
            };
        }
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "pass",
            message: "Workspace state directory present.",
        };
    },
};
const agentRegistryRule = {
    id: "global-agent-registry-only",
    title: "Agents remain global-only",
    severity: "warn",
    async check(context) {
        const workspaceAgentsPath = path.join(context.workspaceRoot, ".mcoda", "agents");
        const workspaceAgentFile = path.join(context.workspaceRoot, ".mcoda", "agents.json");
        const hasWorkspaceAgents = (await fileExists(workspaceAgentsPath)) || (await fileExists(workspaceAgentFile));
        if (hasWorkspaceAgents) {
            return {
                id: this.id,
                title: this.title,
                severity: this.severity,
                status: "fail",
                message: "Workspace-local agent definitions detected under .mcoda/.",
                remediation: "Remove workspace agent configs; use the global registry in ~/.mcoda/mcoda.db.",
            };
        }
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "pass",
            message: "No workspace-local agent registry detected (global-only guardrail upheld).",
        };
    },
};
const docdexRule = {
    id: "docdex-only",
    title: "docdex is the only document indexer",
    severity: "warn",
    async check(context) {
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "warn",
            message: "Manual check: ensure docdex client is used for doc retrieval; local embeddings/indexers are prohibited.",
            remediation: "Audit integrations and CLI commands to ensure all doc queries go through docdex.",
        };
    },
};
const secretsRule = {
    id: "local-first-secrets",
    title: "Secrets stored encrypted in mcoda DBs",
    severity: "warn",
    async check() {
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "warn",
            message: "Manual check: verify credentials are encrypted in ~/.mcoda/mcoda.db and not loaded from long-lived env vars.",
            remediation: "Add encryption routines and key handling per SDS Section 20 before storing secrets.",
        };
    },
};
const longRunningRule = {
    id: "resumable-jobs",
    title: "Long-running jobs use checkpoints/logs under .mcoda",
    severity: "warn",
    async check(context) {
        const jobDir = path.join(context.workspaceRoot, ".mcoda", "jobs");
        const hasJobDir = await fileExists(jobDir);
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: hasJobDir ? "pass" : "warn",
            message: hasJobDir
                ? "Job directory present for resumable runs."
                : "Manual check: ensure long-running commands persist checkpoints/logs under .mcoda/jobs/<job_id>/.",
            remediation: "Create .mcoda/jobs/ when implementing job engine per SDS Section 4.2.5.",
        };
    },
};
const telemetryRule = {
    id: "token-usage-telemetry",
    title: "Per-action token_usage recorded",
    severity: "warn",
    async check() {
        return {
            id: this.id,
            title: this.title,
            severity: this.severity,
            status: "warn",
            message: "Manual check: telemetry/token_usage recording must be linked to command/task runs (SDS 4.3.7, 7.2.5).",
            remediation: "Implement token_usage persistence and linking when wiring commands and adapters.",
        };
    },
};
export const defaultGuardrailSuite = [
    openapiRule,
    openapiVersionRule,
    gitignoreRule,
    workspaceStateRule,
    agentRegistryRule,
    docdexRule,
    secretsRule,
    longRunningRule,
    telemetryRule,
];
const normalizeContext = (context) => {
    const repoRoot = path.resolve(context.repoRoot);
    const workspaceRoot = path.resolve(context.workspaceRoot ?? repoRoot);
    return {
        repoRoot,
        workspaceRoot,
        openapiPath: context.openapiPath ?? path.join(repoRoot, "openapi", "mcoda.yaml"),
        gitignorePath: context.gitignorePath ?? path.join(repoRoot, ".gitignore"),
    };
};
export const runGuardrails = async (rules, context) => {
    const normalized = normalizeContext(context);
    const results = [];
    for (const rule of rules) {
        // eslint-disable-next-line no-await-in-loop
        const result = await rule.check(normalized);
        results.push(result);
    }
    return results;
};
export const hasGuardrailFailures = (results) => results.some((result) => result.status === "fail" || result.status === "skip");
