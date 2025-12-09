#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda estimate --input <path/to/tasks.md> [--status not_started,in_progress,ready_to_review,ready_to_qa] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out .mcoda/estimate/estimate-<name>.md] [--overwrite]",
    "",
    "Summarizes SP totals/averages for a task set (prototype helper).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "estimate", `estimate-${base}.md`);
};
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let statuses = null;
    let workspace;
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
            case "--status": {
                const raw = argv[i + 1] ?? "";
                const parts = raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                statuses = new Set(parts);
                i += 1;
                break;
            }
            case "--workspace":
                workspace = argv[i + 1];
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
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        statuses,
        workspace,
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
const parseEstimate = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toUpperCase() === "TBD")
        return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
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
            estimate: parseEstimate(estimate),
            notes: notes || "",
        });
    }
    return tasks;
};
const filterTasks = (tasks, statuses) => {
    return statuses ? tasks.filter((t) => statuses.has(t.status)) : tasks;
};
const summarize = (tasks) => {
    const totalSp = tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
    const withEstimates = tasks.filter((t) => t.estimate !== null);
    const avgSp = withEstimates.length ? totalSp / withEstimates.length : 0;
    return {
        count: tasks.length,
        totalSp,
        avgSp,
        withEstimates: withEstimates.length,
        withoutEstimates: tasks.length - withEstimates.length,
    };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
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
const buildOutput = (opts, sourceContent, tasks, summary, appliedStatuses) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = tasks.length === 0
        ? ["| (none) | - | - | - | - |"]
        : tasks.map((task, idx) => {
            const id = task.id || `TASK-${idx + 1}`;
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const est = task.estimate ?? "TBD";
            const safeNotes = (task.notes || "").replace(/\|/g, "\\|");
            return `| ${id} | ${task.status} | ${est} | ${safeTitle} | ${safeNotes || " "} |`;
        });
    const table = [
        "| ID | Status | Estimate (SP) | Title | Notes |",
        "| --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    return [
        `# Estimate snapshot for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        opts.workspace ? `- Workspace: ${opts.workspace}` : "",
        `- Filters: statuses=${appliedStatuses.length ? appliedStatuses.join(",") : "(none)"}`,
        `- Count: ${summary.count}, With estimates: ${summary.withEstimates}, Without estimates: ${summary.withoutEstimates}`,
        `- Total SP: ${summary.totalSp}, Avg SP (est. only): ${summary.avgSp.toFixed(2)}`,
        "",
        "## Tasks considered",
        table,
        "",
        "## Notes",
        "- Prototype helper; full mcoda estimate will use OpenAPI-backed data, SP/h modes, and grouping.",
        "- Fill in missing estimates to improve accuracy.",
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
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    const tasks = parseTasks(sourceContent);
    const filtered = filterTasks(tasks, options.statuses);
    const summary = summarize(filtered);
    const appliedStatuses = options.statuses ? Array.from(options.statuses.values()) : [];
    const output = buildOutput(options, sourceContent, filtered, summary, appliedStatuses);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: "estimate",
        workspace: options.workspace ?? "(unspecified)",
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "estimate",
        workspace: options.workspace ?? "(unspecified)",
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Estimate snapshot written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
