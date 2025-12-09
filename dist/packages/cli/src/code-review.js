#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
import { ensureDeterministicBranches } from "@mcoda/core/git.js";
const usage = [
    "mcoda code-review --input <path/to/tasks-or-work.md> [--tasks TASK-1,TASK-2] [--decision approve|changes_requested|block|info_only] [--max 10] [--job-id <id>] [--checkpoint <path>] [--comments <path>] [--resume] [--out .mcoda/review/review-<name>.md] [--overwrite]",
    "",
    "Marks selected tasks with a review decision and writes a review report (telemetry stored in workspace DB).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "review", `review-${base}.md`);
};
const defaultJobId = () => `code-review-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "review", "checkpoint.json");
const defaultCommentsPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "review", "task_comments.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let targetIds = null;
    let decision = "approve";
    let jobId;
    let checkpointPath;
    let resume = false;
    let commentsPath;
    let maxTasks = null;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--input":
            case "-i":
                inputPath = argv[i + 1];
                i += 1;
                break;
            case "--out":
            case "-o":
                outputPath = argv[i + 1];
                i += 1;
                break;
            case "--project":
                project = argv[i + 1] ?? project;
                i += 1;
                break;
            case "--tasks":
                targetIds = new Set((argv[i + 1] ?? "")
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean));
                i += 1;
                break;
            case "--decision":
                decision = argv[i + 1] ?? decision;
                i += 1;
                break;
            case "--job-id":
                jobId = argv[i + 1];
                i += 1;
                break;
            case "--checkpoint":
                checkpointPath = argv[i + 1];
                i += 1;
                break;
            case "--token-usage":
                // deprecated; telemetry is stored in workspace DB
                i += 1;
                break;
            case "--comments":
                commentsPath = argv[i + 1];
                i += 1;
                break;
            case "--resume":
                resume = true;
                break;
            case "--max":
                maxTasks = Number(argv[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
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
    if (!inputPath) {
        throw new Error("Missing required --input <path/to/tasks-or-work.md> argument");
    }
    const allowedDecisions = ["approve", "changes_requested", "block", "info_only"];
    if (!allowedDecisions.includes(decision)) {
        throw new Error("--decision must be one of approve|changes_requested|block|info_only");
    }
    const resolvedInput = path.resolve(inputPath);
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedInput));
    const resolvedJobId = jobId ?? defaultJobId();
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        targetIds,
        decision,
        jobId: resolvedJobId,
        checkpointPath: path.resolve(checkpointPath ?? defaultCheckpointPath(resolvedJobId)),
        resume,
        commentsPath: path.resolve(commentsPath ?? defaultCommentsPath(resolvedJobId)),
        maxTasks,
    };
};
const fileExists = async (filePath) => {
    try {
        await fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
};
const parseTasks = (content) => {
    const lines = content.split(/\r?\n/);
    const tasks = [];
    let inTable = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!inTable) {
            if (trimmed.startsWith("| ID |") && trimmed.toLowerCase().includes("| title |")) {
                inTable = true;
            }
            continue;
        }
        if (!trimmed.startsWith("|")) {
            break;
        }
        if (/---/.test(trimmed))
            continue;
        const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length < 5)
            continue;
        const [id, title, status, estimate, notes] = cells;
        if (id.toLowerCase() === "id" && title.toLowerCase() === "title")
            continue;
        tasks.push({
            id: id || "UNKNOWN",
            title: title || "Untitled task",
            status: status || "not_started",
            estimate: estimate || "TBD",
            notes: notes || "",
        });
    }
    return tasks;
};
const allowedStatuses = new Set(["ready_to_review"]);
const applyReview = (tasks, targetIds, decision, maxTasks) => {
    const chosen = targetIds ?? new Set(tasks.map((t) => t.id));
    const outcomes = [];
    const skipped = [];
    const seen = new Set();
    const enforceLimit = (ids) => {
        if (!maxTasks || maxTasks <= 0)
            return ids;
        return ids.slice(0, maxTasks);
    };
    const limitedIds = enforceLimit(Array.from(chosen));
    const limited = new Set(limitedIds);
    const updated = tasks.map((task) => {
        if (!limited.has(task.id))
            return task;
        seen.add(task.id);
        if (!allowedStatuses.has(task.status)) {
            skipped.push({
                id: task.id,
                title: task.title,
                status: task.status,
                reason: `Status gating: expected ready_to_review, found ${task.status || "unknown"}`,
            });
            return task;
        }
        const from = task.status || "ready_to_review";
        const mapped = decision === "approve"
            ? { to: "ready_to_qa", comment: "Approved in review helper." }
            : decision === "changes_requested"
                ? { to: "in_progress", comment: "Changes requested in review helper; send back to in_progress." }
                : decision === "block"
                    ? { to: "blocked", comment: "Blocked in review helper; requires investigation." }
                    : { to: from, comment: "Informational review; no state change requested." };
        outcomes.push({ id: task.id, decision, from, to: mapped.to, title: task.title, comment: mapped.comment });
        return { ...task, status: mapped.to, notes: task.notes ? `${task.notes} | ${mapped.comment}` : mapped.comment };
    });
    const missing = Array.from(limited).filter((id) => !seen.has(id));
    return { updated, outcomes, skipped, missing };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, tasks, outcomes, skipped, missing) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = tasks.length === 0
        ? ["| (none) | - | - | - | - |"]
        : tasks.map((task, idx) => {
            const id = task.id || `TASK-${idx + 1}`;
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const safeNotes = (task.notes || "").replace(/\|/g, "\\|");
            return `| ${id} | ${safeTitle} | ${task.status} | ${task.estimate} | ${safeNotes || " "} |`;
        });
    const table = [
        "| ID | Title | Status | Estimate (SP) | Notes |",
        "| --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    const outcomeLines = outcomes.length === 0
        ? "- No tasks selected."
        : outcomes.map((o) => `- ${o.id}: ${o.from} → ${o.to} | ${o.title} | decision=${o.decision} | ${o.comment}`);
    return [
        `# Code review log for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Tasks reviewed: ${outcomes.length}`,
        `- Skipped (status-gated): ${skipped.length}`,
        `- Missing: ${missing.length}`,
        opts.maxTasks ? `- Max tasks: ${opts.maxTasks}` : "",
        `- Decision: ${opts.decision}`,
        "",
        "## Outcomes",
        ...outcomeLines,
        "",
        "## Skipped (status gated)",
        ...(skipped.length === 0
            ? ["- (none)"]
            : skipped.map((s) => `- ${s.id}: ${s.status} | ${s.title} | ${s.reason}`)),
        "",
        "## Missing",
        ...(missing.length === 0 ? ["- (none)"] : missing.map((id) => `- ${id}`)),
        "",
        "## Updated Tasks",
        table,
        "",
        "## Notes",
        "- Prototype helper; full mcoda code-review will drive agents, comments, jobs, and token usage.",
        "- Apply these decisions to your workflow/DB as needed.",
        "",
        "## Appendix A: Source tasks document",
        fence(sourceContent),
        "",
    ].join("\n");
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const readCheckpoint = async (checkpointPath) => {
    try {
        const raw = await fs.readFile(checkpointPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
const writeCheckpoint = async (checkpointPath, checkpoint) => {
    await ensureParentDirectory(checkpointPath);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
};
const appendJsonArray = async (filePath, record) => {
    try {
        await ensureParentDirectory(filePath);
        let existing = [];
        try {
            const raw = await fs.readFile(filePath, "utf8");
            existing = JSON.parse(raw);
        }
        catch {
            existing = [];
        }
        existing.push(record);
        await fs.writeFile(filePath, JSON.stringify(existing, null, 2), "utf8");
    }
    catch {
        // best-effort; do not block primary output
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const workspaceStore = await createWorkspaceService();
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    const startedAt = new Date().toISOString();
    let commandRunId;
    const recordPhase = (phase, status, details, taskId) => {
        workspaceStore.recordTaskRunLog({
            commandRunId,
            taskId,
            phase,
            status,
            detailsJson: details ? JSON.stringify(details) : undefined,
        });
    };
    const recordToken = (action) => {
        workspaceStore.recordTokenUsage({
            command: "code-review",
            jobId: options.jobId,
            commandRunId,
            action,
            operationId: "tasks.review",
            promptTokens: 0,
            completionTokens: 0,
        });
    };
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    if (options.resume) {
        const checkpoint = await readCheckpoint(options.checkpointPath);
        if (checkpoint) {
            // eslint-disable-next-line no-console
            console.log(`Resuming job ${checkpoint.jobId} from stage ${checkpoint.stage}`);
        }
    }
    try {
        const tasks = parseTasks(sourceContent);
        const primaryTaskId = options.targetIds?.values().next().value ?? tasks[0]?.id ?? "unknown-task";
        const gitMeta = ensureDeterministicBranches({
            taskId: primaryTaskId,
            slug: options.project,
        });
        commandRunId = workspaceStore.recordCommandRun({
            command: "code-review",
            jobId: options.jobId,
            status: "running",
            gitBranch: gitMeta.taskBranch,
            gitBaseBranch: gitMeta.integrationBranch,
            startedAt,
        });
        recordPhase("git:branches", "ok", { base: gitMeta.baseBranch, integration: gitMeta.integrationBranch, task: gitMeta.taskBranch, stash: gitMeta.stashRef });
        recordToken("git");
        const { updated, outcomes, skipped, missing } = applyReview(tasks, options.targetIds, options.decision, options.maxTasks);
        const output = buildOutput(options, sourceContent, updated, outcomes, skipped, missing);
        await ensureParentDirectory(options.outputPath);
        await fs.writeFile(options.outputPath, output, "utf8");
        const now = new Date().toISOString();
        const checkpoint = {
            jobId: options.jobId,
            command: "code-review",
            stage: "persisted",
            outputPath: options.outputPath,
            updatedAt: now,
        };
        await writeCheckpoint(options.checkpointPath, checkpoint);
        const parseStoryPoints = (estimate) => {
            const num = Number(estimate);
            return Number.isFinite(num) ? num : null;
        };
        for (const outcome of outcomes) {
            recordPhase("task:review", "ok", { from: outcome.from, to: outcome.to, comment: outcome.comment, decision: outcome.decision }, outcome.id);
            const estimate = updated.find((t) => t.id === outcome.id)?.estimate ?? "NaN";
            workspaceStore.recordTaskRun({
                taskId: outcome.id,
                command: "code-review",
                status: outcome.to,
                storyPoints: parseStoryPoints(estimate),
                notes: outcome.comment,
                jobId: options.jobId,
            });
            await appendJsonArray(options.commentsPath, {
                taskId: outcome.id,
                command: "code-review",
                jobId: options.jobId,
                fromStatus: outcome.from,
                toStatus: outcome.to,
                title: outcome.title,
                body: outcome.comment,
                decision: outcome.decision,
                createdAt: now,
            });
            recordToken(`task:${outcome.id}`);
        }
        workspaceStore.updateCommandRun(commandRunId, {
            status: "completed",
            completedAt: now,
            summary: `Reviewed: ${outcomes.length}, skipped: ${skipped.length}, missing: ${missing.length}`,
            outputPath: options.outputPath,
        });
        // eslint-disable-next-line no-console
        console.log(`Code review log written to ${options.outputPath}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (commandRunId) {
            workspaceStore.updateCommandRun(commandRunId, {
                status: "failed",
                completedAt: new Date().toISOString(),
                summary: message,
            });
        }
        recordPhase("error", "failed", { error: message });
        throw error;
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
