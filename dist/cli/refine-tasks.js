#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda refine-tasks --input <path/to/tasks.md> [--out .mcoda/tasks/refined-<name>.md] [--project <name>] [--job-id <id>] [--checkpoint <path>] [--token-usage <path>] [--runs <path>] [--resume] [--overwrite]",
    "",
    "Refines a tasks draft by deduplicating titles and summarizing actions. Intended for prototyping.",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "tasks", `refined-${base}.md`);
};
const defaultJobId = () => `refine-tasks-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "checkpoint.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
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
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|"))
            continue;
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
const normalizeTitle = (title) => title.toLowerCase().replace(/\s+/g, " ").trim();
const refineTasks = (tasks) => {
    const byTitle = new Map();
    let merged = 0;
    for (const task of tasks) {
        const key = normalizeTitle(task.title);
        const existing = byTitle.get(key);
        if (existing) {
            merged += 1;
            existing.notes = existing.notes
                ? `${existing.notes} | merged ${task.id}: ${task.notes || task.title}`
                : `merged ${task.id}: ${task.notes || task.title}`;
            existing.sourceIds.push(task.id);
            continue;
        }
        byTitle.set(key, {
            ...task,
            estimate: task.estimate || "TBD",
            status: task.status || "not_started",
            action: "kept",
            sourceIds: [task.id],
        });
    }
    const refined = Array.from(byTitle.values()).map((task) => {
        const action = task.sourceIds.length > 1 ? `merged duplicates (${task.sourceIds.length} tasks)` : "kept";
        return { ...task, action };
    });
    return { refined, merged };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, refined, meta) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = refined.length === 0
        ? ["| (none) | - | - | - | - | - |"]
        : refined.map((task, idx) => {
            const id = task.id || `TASK-${idx + 1}`;
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const safeNotes = (task.notes || "").replace(/\|/g, "\\|");
            const safeAction = task.action.replace(/\|/g, "\\|");
            return `| ${id} | ${safeTitle} | ${task.status} | ${task.estimate} | ${safeNotes || " "}| ${safeAction} |`;
        });
    const table = [
        "| ID | Title | Status | Estimate (SP) | Notes | Action |",
        "| --- | --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    return [
        `# Refined tasks for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Input tasks: ${meta.inputCount}`,
        `- Output tasks: ${refined.length}`,
        `- Duplicates merged: ${meta.merged}`,
        "",
        "## Refined Tasks",
        table,
        "",
        "## Next Steps",
        "- Fill in refined notes and dependencies.",
        "- Adjust estimates and statuses before running work-on-tasks.",
        "- Persist into the mcoda workflow when OpenAPI wiring is available.",
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
    const { refined, merged } = refineTasks(tasks);
    const output = buildOutput(options, sourceContent, refined, { merged, inputCount: tasks.length });
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    const checkpoint = {
        jobId: options.jobId,
        command: "refine-tasks",
        stage: "persisted",
        outputPath: options.outputPath,
        updatedAt: now,
    };
    await writeCheckpoint(options.checkpointPath, checkpoint);
    await appendJsonArray(options.commandRunPath, {
        command: "refine-tasks",
        jobId: options.jobId,
        status: "succeeded",
        outputPath: options.outputPath,
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "refine-tasks",
        jobId: options.jobId,
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Refined tasks written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
