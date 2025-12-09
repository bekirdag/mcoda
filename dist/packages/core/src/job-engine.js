import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { openWorkspaceStore } from "@mcoda/db/store.js";
import { resolveWorkspaceContext } from "@mcoda/db/workspace.js";
const JOB_TYPE_BY_COMMAND = {
    "create-tasks": "task_creation",
    "refine-tasks": "task_refinement",
    "work-on-tasks": "work",
    "code-review": "review",
    "qa-tasks": "qa",
    "openapi-change": "openapi_change",
};
const ensureDir = async (dirPath) => {
    await mkdir(dirPath, { recursive: true });
};
const writeJsonAtomic = async (filePath, payload) => {
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(tempPath, filePath);
};
const normalizeJobState = (value) => {
    const normalized = (value ?? "").toLowerCase();
    if (normalized === "succeeded")
        return "completed";
    if (["queued", "running", "checkpointing", "paused", "completed", "failed", "cancelled"].includes(normalized)) {
        return normalized;
    }
    return "queued";
};
export class JobEngine {
    constructor(workspace, store) {
        this.resumeSupported = true;
        this.workspace = workspace;
        this.store = store;
        this.jobsDir = workspace.jobsDir;
    }
    static async create(options = {}) {
        const workspace = options.workspace ??
            (await resolveWorkspaceContext({ cwd: options.workspaceRoot ?? process.cwd(), explicitWorkspace: options.workspaceRoot }));
        const store = await openWorkspaceStore({ workspaceRoot: workspace.rootDir, workspace });
        return new JobEngine(workspace, store);
    }
    jobRoot(jobId) {
        return path.join(this.jobsDir, jobId);
    }
    manifestPath(jobId) {
        return path.join(this.jobRoot(jobId), "manifest.json");
    }
    checkpointsDir(jobId) {
        return path.join(this.jobRoot(jobId), "checkpoints");
    }
    legacyCheckpointPath(jobId) {
        return path.join(this.jobRoot(jobId), "checkpoint.json");
    }
    deriveJobType(command, explicit) {
        if (explicit)
            return explicit;
        return JOB_TYPE_BY_COMMAND[command] ?? "other";
    }
    async readManifest(jobId) {
        try {
            const raw = await readFile(this.manifestPath(jobId), "utf8");
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async writeManifest(jobId, manifest) {
        await ensureDir(this.jobRoot(jobId));
        await writeJsonAtomic(this.manifestPath(jobId), manifest);
    }
    async nextCheckpointSeq(jobId) {
        try {
            const entries = await readdir(this.checkpointsDir(jobId));
            const sequences = entries
                .filter((name) => name.endsWith(".ckpt.json"))
                .map((name) => Number.parseInt(name.slice(0, 6), 10))
                .filter((num) => Number.isFinite(num));
            const maxSeq = sequences.length ? Math.max(...sequences) : 0;
            return maxSeq + 1;
        }
        catch {
            return 1;
        }
    }
    async writeCheckpointFile(jobId, checkpoint) {
        const now = new Date().toISOString();
        await ensureDir(this.checkpointsDir(jobId));
        const seq = await this.nextCheckpointSeq(jobId);
        const normalizedStatus = normalizeJobState(checkpoint.status ?? "running");
        const payload = {
            schema_version: 1,
            job_id: jobId,
            command_name: checkpoint.command_name,
            job_type: checkpoint.job_type,
            checkpoint_seq: seq,
            checkpoint_id: randomUUID(),
            created_at: now,
            status: normalizedStatus,
            reason: checkpoint.reason,
            stage: checkpoint.stage,
            payload: checkpoint.payload,
            engine: checkpoint.engine,
            progress: checkpoint.progress,
            indexes: {
                tags: checkpoint.indexes?.tags ?? (checkpoint.stage ? [checkpoint.stage] : []),
                cursor: checkpoint.indexes?.cursor,
                parents: checkpoint.indexes?.parents,
            },
        };
        const filePath = path.join(this.checkpointsDir(jobId), `${String(seq).padStart(6, "0")}.ckpt.json`);
        await writeJsonAtomic(filePath, payload);
        return payload;
    }
    mergeJob(partial) {
        const existing = this.store.getJob(partial.id);
        const updatedAt = partial.updatedAt ?? new Date().toISOString();
        const createdAt = partial.createdAt ?? existing?.createdAt ?? updatedAt;
        const resumeSupported = partial.resumeSupported ?? existing?.resumeSupported ?? this.resumeSupported ?? true;
        const commandName = partial.commandName ?? existing?.commandName ?? this.command ?? "";
        return {
            id: partial.id,
            type: partial.type ?? existing?.type ?? this.jobType,
            commandName,
            command: partial.command ?? existing?.command ?? this.command ?? commandName,
            jobState: normalizeJobState(partial.jobState ?? partial.status ?? existing?.jobState ?? existing?.status),
            status: partial.status ?? existing?.status ?? undefined,
            workspaceId: partial.workspaceId ?? existing?.workspaceId ?? this.workspace.id,
            workspace: partial.workspace ?? existing?.workspace ?? this.workspace.id,
            projectId: partial.projectId ?? existing?.projectId ?? undefined,
            epicId: partial.epicId ?? existing?.epicId ?? undefined,
            userStoryId: partial.userStoryId ?? existing?.userStoryId ?? undefined,
            taskId: partial.taskId ?? existing?.taskId ?? undefined,
            agentId: partial.agentId ?? existing?.agentId ?? undefined,
            jobStateDetail: partial.jobStateDetail ?? existing?.jobStateDetail ?? undefined,
            totalUnits: partial.totalUnits ?? existing?.totalUnits ?? null,
            completedUnits: partial.completedUnits ?? existing?.completedUnits ?? null,
            payloadJson: partial.payloadJson ?? existing?.payloadJson ?? undefined,
            resultJson: partial.resultJson ?? existing?.resultJson ?? undefined,
            errorCode: partial.errorCode ?? existing?.errorCode ?? undefined,
            errorMessage: partial.errorMessage ?? existing?.errorMessage ?? undefined,
            resumeSupported,
            checkpointPath: partial.checkpointPath ?? existing?.checkpointPath ?? this.jobRoot(partial.id),
            notes: partial.notes ?? existing?.notes ?? undefined,
            startedAt: partial.startedAt ?? existing?.startedAt ?? undefined,
            lastCheckpointAt: partial.lastCheckpointAt ?? existing?.lastCheckpointAt ?? undefined,
            completedAt: partial.completedAt ?? existing?.completedAt ?? undefined,
            rowVersion: partial.rowVersion ?? existing?.rowVersion ?? undefined,
            createdAt,
            updatedAt,
        };
    }
    saveJob(partial) {
        const merged = this.mergeJob(partial);
        this.store.saveJob(merged);
    }
    async loadCheckpoint(jobId) {
        const manifest = await this.readManifest(jobId);
        if (manifest && manifest.job_id && manifest.job_id !== jobId) {
            throw new Error(`Checkpoint mismatch: expected job ${jobId}, found manifest for ${manifest.job_id}`);
        }
        const checkpointsDir = this.checkpointsDir(jobId);
        try {
            const entries = await readdir(checkpointsDir);
            const latest = entries
                .filter((name) => name.endsWith(".ckpt.json"))
                .sort()
                .pop();
            if (latest) {
                const checkpointPath = path.join(checkpointsDir, latest);
                const raw = await readFile(checkpointPath, "utf8");
                const parsed = JSON.parse(raw);
                if (parsed.job_id && parsed.job_id !== jobId) {
                    throw new Error(`Checkpoint mismatch: expected job ${jobId}, found ${parsed.job_id}`);
                }
                return {
                    jobId,
                    command: parsed.command_name,
                    stage: parsed.stage,
                    payload: parsed.payload,
                    status: parsed.status,
                    reason: parsed.reason,
                    checkpointSeq: parsed.checkpoint_seq,
                    checkpointId: parsed.checkpoint_id,
                    createdAt: parsed.created_at,
                    checkpointPath,
                    commandRunId: this.commandRunId,
                    manifest,
                };
            }
        }
        catch {
            // fall back to legacy path
        }
        try {
            const raw = await readFile(this.legacyCheckpointPath(jobId), "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.jobId && parsed.jobId !== jobId) {
                throw new Error(`Checkpoint mismatch: expected job ${jobId}, found ${parsed.jobId}`);
            }
            return {
                jobId,
                command: parsed.command,
                stage: parsed.stage,
                payload: parsed.payload,
                status: "running",
                checkpointSeq: 1,
                checkpointId: parsed.updatedAt ?? randomUUID(),
                createdAt: parsed.updatedAt,
                checkpointPath: this.legacyCheckpointPath(jobId),
                commandRunId: this.commandRunId ?? parsed.commandRunId,
                manifest,
            };
        }
        catch {
            return null;
        }
    }
    async startJob(command, jobId, payload, options = {}) {
        this.jobId = jobId;
        this.command = command;
        this.jobType = this.deriveJobType(command, options.jobType);
        this.resumeSupported = options.resumeSupported ?? true;
        await ensureDir(this.jobsDir);
        await ensureDir(this.jobRoot(jobId));
        await ensureDir(this.checkpointsDir(jobId));
        const now = new Date().toISOString();
        const existing = this.store.getJob(jobId);
        const manifest = {
            schema_version: 1,
            job_id: jobId,
            workspace_root: this.workspace.rootDir,
            workspace_id: this.workspace.id,
            command_name: command,
            job_type: this.jobType,
            created_at: existing?.createdAt ?? now,
            resume_supported: this.resumeSupported,
            payload,
        };
        await this.writeManifest(jobId, manifest);
        this.saveJob({
            id: jobId,
            type: this.jobType,
            commandName: command,
            command,
            jobState: "running",
            status: "running",
            workspaceId: this.workspace.id,
            projectId: options.projectId ?? existing?.projectId,
            agentId: options.agentId ?? existing?.agentId,
            totalUnits: options.totalUnits ?? existing?.totalUnits ?? null,
            completedUnits: options.completedUnits ?? existing?.completedUnits ?? null,
            payloadJson: payload ? JSON.stringify(payload) : existing?.payloadJson,
            resumeSupported: this.resumeSupported,
            checkpointPath: this.jobRoot(jobId),
            createdAt: manifest.created_at,
            startedAt: existing?.startedAt ?? now,
            lastCheckpointAt: now,
            updatedAt: now,
        });
        this.commandRunId = this.store.recordCommandRun({
            command,
            jobId,
            status: "running",
            workspace: this.workspace.id,
            startedAt: now,
            updatedAt: now,
        });
        await this.writeCheckpointFile(jobId, {
            command_name: command,
            job_type: this.jobType,
            status: "running",
            stage: "started",
            payload,
            engine: { runtime_version: process.env.npm_package_version ?? "dev", platform: `${process.platform}-${process.arch}` },
            progress: { step: 0 },
        });
        return { jobId, commandRunId: this.commandRunId, checkpointPath: this.jobRoot(jobId), manifestPath: this.manifestPath(jobId) };
    }
    async checkpoint(stage, payload, options = {}) {
        if (!this.jobId || !this.command)
            return;
        const status = normalizeJobState(options.status ?? "running");
        const now = new Date().toISOString();
        await this.writeCheckpointFile(this.jobId, {
            command_name: this.command,
            job_type: this.jobType,
            status,
            stage,
            payload,
            reason: options.reason,
            engine: { runtime_version: process.env.npm_package_version ?? "dev", platform: `${process.platform}-${process.arch}` },
            progress: { step: options.completedUnits ?? undefined, estimated_total_steps: options.totalUnits ?? undefined },
        });
        this.saveJob({
            id: this.jobId,
            commandName: this.command,
            command: this.command,
            type: this.jobType,
            jobState: status === "checkpointing" ? "running" : status,
            status: status === "checkpointing" ? "running" : status,
            jobStateDetail: stage,
            totalUnits: options.totalUnits ?? undefined,
            completedUnits: options.completedUnits ?? undefined,
            lastCheckpointAt: now,
            updatedAt: now,
        });
    }
    updateProgress(progress) {
        if (!this.jobId)
            return;
        this.saveJob({
            id: this.jobId,
            totalUnits: progress.totalUnits ?? undefined,
            completedUnits: progress.completedUnits ?? undefined,
            jobStateDetail: progress.jobStateDetail ?? undefined,
        });
    }
    logPhase(phase, status, details, taskId) {
        this.store.recordTaskRunLog({
            commandRunId: this.commandRunId,
            taskId,
            phase,
            status,
            detailsJson: details ? JSON.stringify(details) : undefined,
        });
    }
    recordTaskRun(run) {
        const jobId = run.jobId ?? this.jobId;
        return this.store.recordTaskRun({ ...run, jobId });
    }
    recordTokenUsage(usage) {
        return this.store.recordTokenUsage({
            ...usage,
            jobId: usage.jobId ?? this.jobId,
            commandRunId: usage.commandRunId ?? this.commandRunId,
            workspace: usage.workspace ?? this.workspace.id,
        });
    }
    updateCommandRun(fields) {
        if (!this.commandRunId)
            return;
        this.store.updateCommandRun(this.commandRunId, {
            status: fields.status,
            completedAt: fields.completedAt,
            summary: fields.summary,
            outputPath: fields.outputPath,
            gitBranch: fields.gitBranch,
            gitBaseBranch: fields.gitBaseBranch,
        });
    }
    finalize(status, summary, outputPath, options = {}) {
        const completedAt = new Date().toISOString();
        const normalizedStatus = status === "succeeded" ? "completed" : status;
        this.updateCommandRun({ status: normalizedStatus, summary, completedAt, outputPath });
        if (this.jobId && this.command) {
            this.saveJob({
                id: this.jobId,
                type: this.jobType,
                commandName: this.command,
                command: this.command,
                jobState: normalizeJobState(normalizedStatus),
                status: normalizedStatus,
                jobStateDetail: summary,
                completedAt,
                resultJson: options.result ? JSON.stringify(options.result) : undefined,
                errorCode: options.errorCode ?? undefined,
                errorMessage: options.errorMessage ?? (normalizedStatus === "failed" ? summary : undefined),
            });
        }
    }
    getCommandRunId() {
        return this.commandRunId;
    }
}
