#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda backlog --input <path/to/tasks.md> [--status not_started,in_progress,ready_to_review] [--limit 20] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out .mcoda/backlog/backlog-<name>.md] [--overwrite]",
    "",
    "Filters and orders tasks for a backlog snapshot (prototype helper).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "backlog", `backlog-${base}.md`);
};
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let statuses = null;
    let limit = null;
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
            case "--limit":
                limit = Number(argv[i + 1] ?? "0") || null;
                i += 1;
                break;
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
    return { inputPath: resolvedInput, outputPath: resolvedOut, overwrite, project, statuses, limit };
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        statuses,
        limit,
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
const statusOrder = [
    "not_started",
    "blocked",
    "in_progress",
    "ready_to_review",
    "ready_to_qa",
    "completed",
    "cancelled",
];
const scoreStatus = (status) => {
    const idx = statusOrder.indexOf(status);
    return idx === -1 ? statusOrder.length + 1 : idx;
};
const filterAndSort = (tasks, statuses) => {
    const filtered = statuses ? tasks.filter((t) => statuses.has(t.status)) : tasks.filter((t) => t.status !== "completed");
    return filtered.sort((a, b) => {
        const scoreDiff = scoreStatus(a.status) - scoreStatus(b.status);
        if (scoreDiff !== 0)
            return scoreDiff;
        return a.id.localeCompare(b.id);
    });
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
const buildOutput = (opts, sourceContent, tasks, appliedStatuses) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = tasks.length === 0
        ? ["| (none) | - | - | - | - |"]
        : tasks.map((task, idx) => {
            const id = task.id || `TASK-${idx + 1}`;
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const safeNotes = (task.notes || "").replace(/\|/g, "\\|");
            return `| ${id} | ${task.status} | ${task.estimate} | ${safeTitle} | ${safeNotes || " "} |`;
        });
    const table = [
        "| ID | Status | Estimate (SP) | Title | Notes |",
        "| --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    return [
        `# Backlog snapshot for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        opts.workspace ? `- Workspace: ${opts.workspace}` : "",
        `- Filters: statuses=${appliedStatuses.length ? appliedStatuses.join(",") : "(all except completed)"}, limit=${opts.limit ?? "none"}`,
        `- Items: ${tasks.length}`,
        "",
        "## Backlog",
        table,
        "",
        "## Notes",
        "- Prototype helper; full mcoda backlog will read from the DB/OpenAPI and support grouping/SP buckets.",
        "- Use this as a scratch view or export.",
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
    let filtered = filterAndSort(tasks, options.statuses);
    const appliedStatuses = options.statuses ? Array.from(options.statuses.values()) : [];
    if (options.limit && options.limit > 0) {
        filtered = filtered.slice(0, options.limit);
    }
    const output = buildOutput(options, sourceContent, filtered, appliedStatuses);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: "backlog",
        workspace: options.workspace ?? "(unspecified)",
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "backlog",
        workspace: options.workspace ?? "(unspecified)",
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Backlog snapshot written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
