#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda work-on-tasks --input <path/to/tasks-or-refined.md> [--tasks TASK-1,TASK-2] [--next ready_to_review] [--job-id <id>] [--checkpoint <path>] [--token-usage <path>] [--runs <path>] [--resume] [--out .mcoda/work/work-<name>.md] [--overwrite]",
    "",
    "Marks selected tasks as worked (status transition) and writes a work log for prototyping.",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "work", `work-${base}.md`);
};
const defaultJobId = () => `work-on-tasks-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "checkpoint.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let targetIds = null;
    let nextStatus = "ready_to_review";
    let jobId;
    let checkpointPath;
    let resume = false;
    let tokenUsagePath;
    let commandRunPath;
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
            case "--next":
                nextStatus = argv[i + 1] ?? nextStatus;
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
            case "--resume":
                resume = true;
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
        throw new Error("Missing required --input <path/to/tasks.md> argument");
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
        nextStatus,
        jobId: resolvedJobId,
        checkpointPath: path.resolve(checkpointPath ?? defaultCheckpointPath(resolvedJobId)),
        resume,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
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
            break; // stop after the first table block
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
const applyWork = (tasks, targetIds, nextStatus) => {
    const chosen = targetIds ?? new Set(tasks.map((t) => t.id));
    const transitions = [];
    const skipped = [];
    const allowedStatuses = new Set(["not_started", "in_progress", "blocked"]);
    const seen = new Set();
    const updated = tasks.map((task) => {
        if (!chosen.has(task.id))
            return task;
        seen.add(task.id);
        if (!allowedStatuses.has(task.status)) {
            skipped.push({
                id: task.id,
                title: task.title,
                status: task.status,
                reason: `Status gating: expected one of ${Array.from(allowedStatuses).join(", ")}`,
            });
            return task;
        }
        const from = task.status || "not_started";
        const to = nextStatus;
        const note = `Marked worked via helper (${from} → ${to})`;
        transitions.push({ id: task.id, from, to, title: task.title, note });
        return { ...task, status: to, notes: task.notes ? `${task.notes} | ${note}` : note };
    });
    const missing = Array.from(chosen).filter((id) => !seen.has(id));
    return { updated, transitions, skipped, missing };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, tasks, transitions, skipped, missing) => {
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
    const transitionLines = transitions.length === 0
        ? "- No tasks selected."
        : transitions.map((t) => `- ${t.id}: ${t.from} → ${t.to} | ${t.title}`);
    return [
        `# Work log for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Tasks targeted: ${transitions.length}`,
        `- Skipped (status-gated): ${skipped.length}`,
        `- Missing: ${missing.length}`,
        `- Next status: ${opts.nextStatus}`,
        "",
        "## Transitions",
        ...transitionLines,
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
        "- This helper is a prototype; real mcoda work-on-tasks will orchestrate git, agents, jobs, and token usage.",
        "- Persist these changes into your workflow or DB as needed.",
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
        // best-effort
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
    const { updated, transitions, skipped, missing } = applyWork(tasks, options.targetIds, options.nextStatus);
    const output = buildOutput(options, sourceContent, updated, transitions, skipped, missing);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    const checkpoint = {
        jobId: options.jobId,
        command: "work-on-tasks",
        stage: "persisted",
        outputPath: options.outputPath,
        updatedAt: now,
    };
    await writeCheckpoint(options.checkpointPath, checkpoint);
    await appendJsonArray(options.commandRunPath, {
        command: "work-on-tasks",
        jobId: options.jobId,
        status: "succeeded",
        outputPath: options.outputPath,
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "work-on-tasks",
        jobId: options.jobId,
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Work log written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
