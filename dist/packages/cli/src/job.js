#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
import { JobEngine } from "@mcoda/core/job-engine.js";
const normalizeState = (state) => {
    const normalized = (state ?? "").toLowerCase();
    if (normalized === "succeeded")
        return "completed";
    if (["queued", "running", "checkpointing", "paused", "completed", "failed", "cancelled"].includes(normalized)) {
        return normalized;
    }
    return "queued";
};
const usage = [
    "mcoda job <list|status|watch|resume> [--id JOB_ID] [--workspace-root <path>] [--store <dbPath>] [--out <file>] [--overwrite] [--interval 2000] [--iterations 10]",
    "",
    "Job helper backed by the workspace SQLite DB (<repo>/.mcoda/mcoda.db).",
].join("\n");
const parseArgs = (argv) => {
    const args = [...argv];
    let subcommand;
    let jobId;
    let workspaceRoot = process.cwd();
    let dbPath;
    let outputPath;
    let overwrite = false;
    let intervalMs = 2000;
    let maxIterations = null;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith("--") && !subcommand) {
            subcommand = arg;
            continue;
        }
        switch (arg) {
            case "--id":
                jobId = args[i + 1];
                i += 1;
                break;
            case "--workspace-root":
            case "--root":
                workspaceRoot = path.resolve(args[i + 1] ?? workspaceRoot);
                i += 1;
                break;
            case "--store":
                dbPath = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--out":
                outputPath = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--interval":
                intervalMs = Number(args[i + 1] ?? intervalMs);
                i += 1;
                break;
            case "--iterations":
                maxIterations = Number(args[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--help":
            case "-h":
                // eslint-disable-next-line no-console
                console.log(usage);
                process.exit(0);
                break;
            default:
                break;
        }
    }
    if (!subcommand || !["list", "status", "watch", "resume"].includes(subcommand)) {
        throw new Error(`Command must be one of list|status|watch|resume\n\n${usage}`);
    }
    if (["status", "watch", "resume"].includes(subcommand) && !jobId) {
        throw new Error(`${subcommand} requires --id JOB_ID`);
    }
    return {
        subcommand,
        jobId,
        workspaceRoot,
        dbPath,
        outputPath,
        overwrite,
        intervalMs,
        maxIterations,
    };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const formatTable = (jobs) => {
    if (jobs.length === 0) {
        return "| ID | Type | Command | State | Progress | Updated | Resume? | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| (none) | - | - | - | - | - | - | - |";
    }
    const lines = jobs.map((job) => {
        const safeNotes = (job.notes ?? "").replace(/\|/g, "\\|");
        const state = normalizeState(job.jobState ?? job.status);
        const progress = typeof job.totalUnits === "number" && job.totalUnits > 0
            ? `${job.completedUnits ?? 0}/${job.totalUnits}`
            : "-";
        const resume = job.resumeSupported === false ? "no" : "yes";
        return `| ${job.id} | ${job.type ?? "-"} | ${job.commandName ?? job.command ?? "-"} | ${state} | ${progress} | ${job.updatedAt} | ${resume} | ${safeNotes} |`;
    });
    return [
        "| ID | Type | Command | State | Progress | Updated | Resume? | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...lines,
    ].join("\n");
};
const buildListOutput = (dbPath, jobs) => {
    return [
        "# Jobs",
        "",
        `Store: ${dbPath}`,
        "",
        "## List",
        formatTable(jobs),
        "",
    ].join("\n");
};
const buildStatusOutput = (dbPath, job) => {
    const state = normalizeState(job.jobState ?? job.status);
    const progress = typeof job.totalUnits === "number" && job.totalUnits > 0
        ? `${job.completedUnits ?? 0}/${job.totalUnits}`
        : "-";
    const resume = job.resumeSupported === false ? "no" : "yes";
    const detail = job.jobStateDetail ?? job.notes ?? "-";
    const checkpoint = job.checkpointPath ?? "-";
    const error = job.errorCode ? `${job.errorCode}${job.errorMessage ? `: ${job.errorMessage}` : ""}` : "-";
    return [
        `# Job status (${job.id})`,
        "",
        `Store: ${dbPath}`,
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| ID | ${job.id} |`,
        `| Type | ${job.type ?? "-"} |`,
        `| Command | ${job.commandName ?? job.command ?? "-"} |`,
        `| State | ${state} |`,
        `| Progress | ${progress} |`,
        `| Resume supported | ${resume} |`,
        `| Created | ${job.createdAt} |`,
        `| Started | ${job.startedAt ?? "-"} |`,
        `| Updated | ${job.updatedAt} |`,
        `| Last checkpoint | ${job.lastCheckpointAt ?? "-"} |`,
        `| Completed | ${job.completedAt ?? "-"} |`,
        `| Workspace | ${job.workspaceId ?? job.workspace ?? "-"} |`,
        `| Checkpoint path | ${checkpoint} |`,
        `| Detail | ${detail.replace(/\|/g, "\\|")} |`,
        `| Error | ${error.replace(/\|/g, "\\|")} |`,
        "",
    ].join("\n");
};
const writeOutputIfRequested = async (outputPath, content, overwrite) => {
    if (!outputPath)
        return;
    if (!overwrite) {
        try {
            await fs.access(outputPath);
            throw new Error(`Output already exists: ${outputPath}. Re-run with --overwrite to replace it.`);
        }
        catch {
            // ok
        }
    }
    await ensureDir(outputPath);
    await fs.writeFile(outputPath, content, "utf8");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await createWorkspaceService({ workspaceRoot: options.workspaceRoot, dbPath: options.dbPath });
    const dbPath = options.dbPath ?? path.join(options.workspaceRoot, ".mcoda", "mcoda.db");
    const printAndMaybeWrite = async (content) => {
        // eslint-disable-next-line no-console
        console.log(content);
        if (options.outputPath) {
            await writeOutputIfRequested(options.outputPath, content, options.overwrite);
            // eslint-disable-next-line no-console
            console.log(`Output written to ${options.outputPath}`);
        }
    };
    switch (options.subcommand) {
        case "list": {
            const jobs = store.listJobs();
            const output = buildListOutput(dbPath, jobs);
            await printAndMaybeWrite(output);
            const now = new Date().toISOString();
            const commandRunId = store.recordCommandRun({ command: "job:list", status: "completed", workspace: options.workspaceRoot, updatedAt: now });
            store.recordTokenUsage({ command: "job:list", operationId: "jobs.status", action: "list", commandRunId, promptTokens: 0, completionTokens: 0, workspace: options.workspaceRoot, recordedAt: now });
            break;
        }
        case "status": {
            const job = store.getJob(options.jobId);
            if (!job)
                throw new Error(`Job ${options.jobId} not found`);
            const output = buildStatusOutput(dbPath, job);
            await printAndMaybeWrite(output);
            const now = new Date().toISOString();
            const commandRunId = store.recordCommandRun({ command: "job:status", jobId: options.jobId, status: "completed", workspace: options.workspaceRoot, updatedAt: now });
            store.recordTokenUsage({ command: "job:status", jobId: options.jobId, operationId: "jobs.status", action: "status", commandRunId, promptTokens: 0, completionTokens: 0, workspace: options.workspaceRoot, recordedAt: now });
            break;
        }
        case "watch": {
            if (!options.jobId)
                throw new Error("watch requires --id JOB_ID");
            let iterations = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                iterations += 1;
                const job = store.getJob(options.jobId);
                if (!job)
                    throw new Error(`Job ${options.jobId} not found`);
                const output = buildStatusOutput(dbPath, job);
                // eslint-disable-next-line no-console
                console.log(output);
                if (options.outputPath) {
                    await writeOutputIfRequested(options.outputPath, output, true);
                }
                const state = normalizeState(job.jobState ?? job.status);
                if (["completed", "failed", "cancelled"].includes(state)) {
                    const now = new Date().toISOString();
                    const normalizedStatus = state;
                    const commandRunId = store.recordCommandRun({
                        command: "job:watch",
                        jobId: options.jobId,
                        status: normalizedStatus,
                        workspace: options.workspaceRoot,
                        updatedAt: now,
                    });
                    store.recordTokenUsage({
                        command: "job:watch",
                        jobId: options.jobId,
                        operationId: "jobs.status",
                        action: "watch",
                        commandRunId,
                        promptTokens: 0,
                        completionTokens: 0,
                        workspace: options.workspaceRoot,
                        recordedAt: now,
                    });
                    break;
                }
                if (options.maxIterations && iterations >= options.maxIterations) {
                    break;
                }
                await sleep(options.intervalMs);
            }
            break;
        }
        case "resume": {
            const existing = store.getJob(options.jobId);
            if (!existing)
                throw new Error(`Job ${options.jobId} not found`);
            const state = normalizeState(existing.jobState ?? existing.status);
            if (["completed", "cancelled"].includes(state)) {
                throw new Error(`Job ${existing.id} is ${state} and cannot be resumed`);
            }
            if (existing.resumeSupported === false) {
                throw new Error(`Job ${existing.id} is not resumable (resume_supported=0)`);
            }
            const engine = await JobEngine.create({ workspaceRoot: options.workspaceRoot });
            const checkpoint = await engine.loadCheckpoint(existing.id);
            if (!checkpoint) {
                throw new Error(`No checkpoint found for job ${existing.id}`);
            }
            const now = new Date().toISOString();
            const updated = {
                ...existing,
                jobState: "running",
                status: "running",
                updatedAt: now,
                jobStateDetail: `resume requested at ${now}`,
                lastCheckpointAt: checkpoint.createdAt ?? existing.lastCheckpointAt ?? existing.updatedAt,
                checkpointPath: checkpoint.checkpointPath ?? existing.checkpointPath,
            };
            store.saveJob(updated);
            const output = buildStatusOutput(dbPath, updated);
            await printAndMaybeWrite(output);
            const commandRunId = store.recordCommandRun({ command: "job:resume", jobId: options.jobId, status: "running", workspace: options.workspaceRoot, updatedAt: now });
            store.recordTokenUsage({ command: "job:resume", jobId: options.jobId, operationId: "jobs.resume", action: "resume", commandRunId, promptTokens: 0, completionTokens: 0, workspace: options.workspaceRoot, recordedAt: now });
            break;
        }
        default:
            throw new Error(`Unknown subcommand: ${options.subcommand}`);
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
