#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda code-review --input <path/to/tasks-or-work.md> [--tasks TASK-1,TASK-2] [--decision approve|changes_requested] [--max 10] [--job-id <id>] [--checkpoint <path>] [--token-usage <path>] [--runs <path>] [--comments <path>] [--resume] [--out .mcoda/review/review-<name>.md] [--overwrite]",
    "",
    "Marks selected tasks with a review decision and writes a review report for prototyping.",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "review", `review-${base}.md`);
};
const defaultJobId = () => `code-review-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "checkpoint.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const defaultCommentsPath = () => path.join(process.cwd(), ".mcoda", "task_comments.json");
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
    let tokenUsagePath;
    let commandRunPath;
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
                tokenUsagePath = argv[i + 1];
                i += 1;
                break;
            case "--runs":
                commandRunPath = argv[i + 1];
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
    if (decision !== "approve" && decision !== "changes_requested") {
        throw new Error("--decision must be approve or changes_requested");
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
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
        commentsPath: path.resolve(commentsPath ?? defaultCommentsPath()),
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
        const from = task.status || "in_progress";
        const to = decision === "approve" ? "ready_to_qa" : "in_progress";
        const comment = decision === "approve" ? "Approved in review helper." : "Changes requested in review helper; send back to in_progress.";
        outcomes.push({ id: task.id, from, to, title: task.title, comment });
        return { ...task, status: to, notes: task.notes ? `${task.notes} | ${comment}` : comment };
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
        : outcomes.map((o) => `- ${o.id}: ${o.from} → ${o.to} | ${o.title} | ${o.comment}`);
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
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
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
    const tasks = parseTasks(sourceContent);
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
    await appendJsonArray(options.commandRunPath, {
        command: "code-review",
        jobId: options.jobId,
        status: "succeeded",
        outputPath: options.outputPath,
        updatedAt: now,
    });
    for (const outcome of outcomes) {
        await appendJsonArray(options.commentsPath, {
            taskId: outcome.id,
            command: "code-review",
            jobId: options.jobId,
            fromStatus: outcome.from,
            toStatus: outcome.to,
            title: outcome.title,
            body: outcome.comment,
            createdAt: now,
        });
    }
    await appendJsonArray(options.tokenUsagePath, {
        command: "code-review",
        jobId: options.jobId,
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Code review log written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
