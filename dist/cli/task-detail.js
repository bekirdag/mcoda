#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda task-detail --input <path/to/tasks.md> --tasks TASK-1[,TASK-2] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out .mcoda/task-detail/task-<name>.md] [--overwrite]",
    "",
    "Shows details for specific tasks from a task/backlog/review file (prototype helper).",
].join("\n");
const deriveDefaultOutputPath = (inputPath, taskIds) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "task";
    const suffix = taskIds.length === 1 ? taskIds[0].toLowerCase() : "multi";
    return path.join(process.cwd(), ".mcoda", "task-detail", `task-${base}-${suffix}.md`);
};
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let targets;
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
            case "--tasks": {
                const raw = argv[i + 1] ?? "";
                const parts = raw
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                targets = new Set(parts);
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
    if (!targets || targets.size === 0) {
        throw new Error("Missing required --tasks TASK-1[,TASK-2] argument");
    }
    const resolvedInput = path.resolve(inputPath);
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedInput, Array.from(targets)));
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        targetIds: targets,
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
const buildOutput = (opts, sourceContent, found, missing) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = found.length === 0
        ? ["| (none) | - | - | - | - |"]
        : found.map((task, idx) => {
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
    const missingLines = missing.length === 0 ? ["- (none)"] : missing.map((id) => `- ${id}`);
    return [
        `# Task detail for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Requested: ${Array.from(opts.targetIds).join(", ")}`,
        opts.workspace ? `- Workspace: ${opts.workspace}` : "",
        "",
        "## Tasks",
        table,
        "",
        "## Missing",
        ...missingLines,
        "",
        "## Notes",
        "- Prototype helper; full mcoda task show will pull from workspace DB and include history/comments/logs.",
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
    const found = tasks.filter((t) => options.targetIds.has(t.id));
    const missing = Array.from(options.targetIds).filter((id) => !found.some((t) => t.id === id));
    const output = buildOutput(options, sourceContent, found, missing);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: "task-detail",
        workspace: options.workspace ?? "(unspecified)",
        requested: Array.from(options.targetIds),
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "task-detail",
        workspace: options.workspace ?? "(unspecified)",
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Task detail written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
