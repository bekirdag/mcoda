#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda order-tasks --input <path/to/tasks.md> [--workspace <name>] [--out .mcoda/order/order-<name>.md] [--overwrite]",
    "",
    "Produces a simple dependency-ordered task list (telemetry stored in workspace DB).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "order", `order-${base}.md`);
};
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let workspace;
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
            case "--workspace":
                workspace = argv[i + 1];
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
        workspace,
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
const extractDeps = (notes) => {
    const matches = notes.match(/depends on\s*[:\-]?\s*([A-Za-z0-9_,\s-]+)/i);
    if (!matches)
        return [];
    const depsRaw = matches[1] ?? "";
    return depsRaw
        .split(/[, ]+/)
        .map((d) => d.trim())
        .filter(Boolean);
};
const topoSort = (tasks) => {
    const graph = new Map();
    const indegree = new Map();
    for (const task of tasks) {
        graph.set(task.id, new Set());
        indegree.set(task.id, 0);
    }
    for (const task of tasks) {
        const deps = extractDeps(task.notes);
        for (const dep of deps) {
            if (!graph.has(dep))
                continue; // ignore unknown deps
            graph.get(dep)?.add(task.id);
            indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
        }
    }
    const queue = [];
    for (const [node, deg] of indegree.entries()) {
        if (deg === 0)
            queue.push(node);
    }
    const ordered = [];
    while (queue.length > 0) {
        const id = queue.shift();
        const task = tasks.find((t) => t.id === id);
        if (task) {
            ordered.push(task);
            for (const neighbor of graph.get(id) ?? []) {
                indegree.set(neighbor, (indegree.get(neighbor) ?? 0) - 1);
                if ((indegree.get(neighbor) ?? 0) === 0) {
                    queue.push(neighbor);
                }
            }
        }
    }
    const cycles = [];
    const remaining = Array.from(indegree.entries())
        .filter(([, deg]) => (deg ?? 0) > 0)
        .map(([id]) => id);
    if (remaining.length > 0) {
        cycles.push(remaining);
    }
    return { ordered, cycles };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, ordered, cycles) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const rows = ordered.length === 0
        ? ["| (none) | - | - | - | - |"]
        : ordered.map((task, idx) => {
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const safeNotes = (task.notes || "").replace(/\|/g, "\\|");
            return `| ${idx + 1} | ${task.id} | ${task.status} | ${task.estimate} | ${safeTitle} | ${safeNotes || " "} |`;
        });
    const table = [
        "| Order | ID | Status | Estimate (SP) | Title | Notes |",
        "| --- | --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    const cycleLines = cycles.length === 0
        ? ["- (none detected)"]
        : cycles.map((cycle) => `- Cycle: ${cycle.join(" -> ")}`);
    return [
        `# Dependency-ordered tasks for ${opts.project}`,
        "",
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        opts.workspace ? `- Workspace: ${opts.workspace}` : "",
        `- Tasks ordered: ${ordered.length}`,
        "",
        "## Ordered Tasks",
        table,
        "",
        "## Cycles / unresolved deps",
        ...cycleLines,
        "",
        "## Notes",
        "- Prototype helper; full mcoda order-tasks will use explicit dependencies from the DB/OpenAPI and richer heuristics.",
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
    const workspaceStore = await createWorkspaceService();
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    const tasks = parseTasks(sourceContent);
    const { ordered, cycles } = topoSort(tasks);
    const output = buildOutput(options, sourceContent, ordered, cycles);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    const commandRunId = workspaceStore.recordCommandRun({
        command: "order-tasks",
        workspace: options.workspace ?? process.cwd(),
        status: "completed",
        updatedAt: now,
    });
    workspaceStore.recordTokenUsage({
        command: "order-tasks",
        workspace: options.workspace ?? process.cwd(),
        commandRunId,
        operationId: "tasks.orderByDeps",
        action: "order",
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Ordered tasks written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
