#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDeterministicBranches } from "@mcoda/core/git.js";
import { JobEngine } from "@mcoda/core/job-engine.js";
import { getWorkspaceLayout } from "@mcoda/core/services.js";
const usage = [
    "mcoda work-on-tasks --input <path/to/tasks-or-refined.md> [--tasks TASK-1,TASK-2] [--status not_started,in_progress[,blocked]] [--limit N] [--parallel N]",
    "                        [--next ready_to_review] [--allow-blocked] [--allow-rework] [--branch <name>] [--reuse-branch]",
    "                        [--job-id <id>] [--resume-from <job-id>] [--resume] [--out .mcoda/work/work-<name>.md] [--overwrite]",
    "",
    "Marks selected tasks as worked (status transition) and writes a work log (telemetry stored in workspace DB).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "work", `work-${base}.md`);
};
const defaultJobId = () => `work-on-tasks-${Date.now()}`;
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let targetIds = null;
    let nextStatus = "ready_to_review";
    let jobId;
    let resume = false;
    let statusFilter = null;
    let allowBlocked = false;
    let allowRework = false;
    let limit;
    let parallel;
    let branch;
    let reuseBranch = false;
    let resumeFrom;
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
            case "--status": {
                const raw = argv[i + 1];
                if (raw) {
                    statusFilter = new Set(raw
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean));
                }
                i += 1;
                break;
            }
            case "--limit": {
                const value = Number(argv[i + 1]);
                limit = Number.isFinite(value) && value > 0 ? value : limit;
                i += 1;
                break;
            }
            case "--parallel": {
                const value = Number(argv[i + 1]);
                parallel = Number.isFinite(value) && value > 0 ? value : parallel;
                i += 1;
                break;
            }
            case "--allow-blocked":
                allowBlocked = true;
                break;
            case "--allow-rework":
                allowRework = true;
                break;
            case "--job-id":
                jobId = argv[i + 1];
                i += 1;
                break;
            case "--branch":
                branch = argv[i + 1];
                i += 1;
                break;
            case "--reuse-branch":
                reuseBranch = true;
                break;
            case "--checkpoint":
                i += 1; // kept for compatibility but ignored (job engine manages checkpoint path)
                break;
            case "--resume-from":
                resumeFrom = argv[i + 1];
                resume = true;
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
    const resolvedJobId = jobId ?? resumeFrom ?? defaultJobId();
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        targetIds,
        nextStatus,
        jobId: resolvedJobId,
        resume,
        statusFilter,
        allowBlocked,
        allowRework,
        limit,
        parallel,
        branch,
        reuseBranch,
        resumeFrom,
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
const doneStatuses = new Set(["completed", "cancelled", "ready_to_review", "ready_to_qa"]);
const defaultStatusFilter = () => new Set(["not_started", "in_progress", "blocked"]);
const extractDependencies = (notes) => {
    const matches = notes.match(/depends on\s*[:\-]?\s*([A-Za-z0-9_,\s-]+)/i);
    if (!matches)
        return [];
    return (matches[1] ?? "")
        .split(/[, ]+/)
        .map((dep) => dep.trim())
        .filter(Boolean);
};
const topoSelected = (tasks) => {
    const graph = new Map();
    const indegree = new Map();
    const byId = new Map();
    for (const task of tasks) {
        byId.set(task.id, task);
        graph.set(task.id, new Set());
        indegree.set(task.id, 0);
    }
    for (const task of tasks) {
        for (const dep of task.dependencies) {
            if (!byId.has(dep))
                continue;
            graph.get(dep)?.add(task.id);
            indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
        }
    }
    const queue = Array.from(indegree.entries())
        .filter(([, deg]) => (deg ?? 0) === 0)
        .map(([id]) => id);
    const ordered = [];
    while (queue.length > 0) {
        const id = queue.shift();
        const task = byId.get(id);
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
    const remaining = Array.from(indegree.entries())
        .filter(([, deg]) => (deg ?? 0) > 0)
        .map(([id]) => id);
    return { ordered, cycles: remaining };
};
const selectTasks = (tasks, options) => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const chosen = options.targetIds ?? new Set(tasks.map((t) => t.id));
    const missing = options.targetIds ? Array.from(chosen).filter((id) => !taskMap.has(id)) : [];
    const statusFilter = options.statusFilter ?? defaultStatusFilter();
    const skipped = [];
    const eligible = [];
    for (const task of tasks) {
        if (!chosen.has(task.id))
            continue;
        const statusAllowed = statusFilter.has(task.status);
        const canRework = options.allowRework && task.status !== "completed" && task.status !== "cancelled";
        if (!statusAllowed && !canRework) {
            skipped.push({
                id: task.id,
                title: task.title,
                status: task.status,
                reason: `status_gating: expected one of ${Array.from(statusFilter).join(", ")}`,
            });
            continue;
        }
        const dependencies = extractDependencies(task.notes);
        const blockedBy = dependencies
            .map((dep) => taskMap.get(dep))
            .filter((dep) => Boolean(dep))
            .filter((dep) => !doneStatuses.has(dep.status))
            .map((dep) => dep.id);
        if (blockedBy.length > 0 && !options.allowBlocked) {
            skipped.push({
                id: task.id,
                title: task.title,
                status: task.status,
                reason: `dependency_not_ready: ${blockedBy.join(", ")}`,
            });
            continue;
        }
        eligible.push({ ...task, dependencies, blockedBy });
    }
    const { ordered, cycles } = topoSelected(eligible);
    const limited = [];
    let selected = ordered;
    if (options.limit && options.limit > 0 && ordered.length > options.limit) {
        const trimmed = ordered.slice(options.limit);
        selected = ordered.slice(0, options.limit);
        for (const task of trimmed) {
            limited.push({ id: task.id, title: task.title, status: task.status, reason: `limit_exceeded: limit=${options.limit}` });
        }
    }
    const cycleSkipped = cycles.length === 0
        ? []
        : cycles.map((id) => {
            const task = taskMap.get(id);
            return { id, title: task?.title ?? "Unknown task", status: task?.status ?? "unknown", reason: "dependency_cycle" };
        });
    return { selected, skipped: [...skipped, ...limited, ...cycleSkipped], missing, statusFilter, cycles };
};
const applyWork = (tasks, selection, nextStatus) => {
    const transitions = [];
    const selectedMap = new Map(selection.selected.map((task) => [task.id, task]));
    const updated = tasks.map((task) => {
        const chosen = selectedMap.get(task.id);
        if (!chosen)
            return task;
        const from = task.status || "not_started";
        const notes = [`Marked worked via helper (${from} → ${nextStatus})`];
        if (chosen.blockedBy.length > 0) {
            notes.push(`Dependency-blocked: ${chosen.blockedBy.join(", ")}`);
        }
        const note = notes.join("; ");
        transitions.push({ id: task.id, from, to: nextStatus, title: task.title, note });
        return { ...task, status: nextStatus, notes: task.notes ? `${task.notes} | ${note}` : note };
    });
    return { updated, transitions, skipped: selection.skipped, missing: selection.missing };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, tasks, transitions, skipped, missing, selectionMeta) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const statusLine = selectionMeta.statusFilter.size > 0 ? Array.from(selectionMeta.statusFilter).join(", ") : "(none)";
    const summary = [
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Tasks targeted: ${transitions.length}`,
        `- Skipped (gated/blocked/limited): ${skipped.length}`,
        `- Missing: ${missing.length}`,
        `- Next status: ${opts.nextStatus}`,
        `- Status filter: ${statusLine}`,
        `- Allow blocked deps: ${selectionMeta.allowBlocked ? "yes" : "no"}`,
        `- Allow rework: ${selectionMeta.allowRework ? "yes" : "no"}`,
        `- Limit: ${selectionMeta.limit ?? "none"}`,
        selectionMeta.parallel ? `- Parallel: ${selectionMeta.parallel}` : null,
    ].filter(Boolean);
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
    const cycleLines = selectionMeta.cycles.length === 0
        ? ["- (none detected)"]
        : selectionMeta.cycles.map((cycle) => `- ${cycle}`);
    const transitionLines = transitions.length === 0
        ? "- No tasks selected."
        : transitions.map((t) => `- ${t.id}: ${t.from} → ${t.to} | ${t.title}`);
    return [
        `# Work log for ${opts.project}`,
        "",
        ...summary,
        "",
        "## Transitions",
        ...transitionLines,
        "",
        "## Skipped (gated/blocked/limited)",
        ...(skipped.length === 0
            ? ["- (none)"]
            : skipped.map((s) => `- ${s.id}: ${s.status} | ${s.title} | ${s.reason}`)),
        "",
        "## Missing",
        ...(missing.length === 0 ? ["- (none)"] : missing.map((id) => `- ${id}`)),
        "",
        "## Dependency cycles",
        ...cycleLines,
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
const writeManifest = async (options, selection) => {
    const layout = getWorkspaceLayout(process.cwd());
    const manifestPath = path.join(layout.jobsDir, options.jobId, "manifest.json");
    const payload = {
        jobId: options.jobId,
        command: "work-on-tasks",
        project: options.project,
        input: options.inputPath,
        output: options.outputPath,
        statusFilter: Array.from(selection.statusFilter),
        limit: options.limit ?? null,
        allowBlocked: options.allowBlocked,
        allowRework: options.allowRework,
        parallel: options.parallel ?? null,
        branch: options.branch ?? null,
        reuseBranch: options.reuseBranch,
        selected: selection.selected.map((t) => t.id),
        skipped: selection.skipped,
        missing: selection.missing,
        cycles: selection.cycles,
        generatedAt: new Date().toISOString(),
    };
    await ensureParentDirectory(manifestPath);
    await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), "utf8");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    const engine = await JobEngine.create();
    const checkpoint = options.resume || options.resumeFrom ? await engine.loadCheckpoint(options.resumeFrom ?? options.jobId) : null;
    if ((options.resume || options.resumeFrom) && checkpoint) {
        // eslint-disable-next-line no-console
        console.log(`Resuming job ${checkpoint.jobId} from stage ${checkpoint.stage}`);
    }
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    try {
        const tasks = parseTasks(sourceContent);
        const selection = selectTasks(tasks, {
            targetIds: options.targetIds,
            statusFilter: options.statusFilter,
            allowBlocked: options.allowBlocked,
            allowRework: options.allowRework,
            limit: options.limit,
        });
        await engine.startJob("work-on-tasks", options.jobId, {
            project: options.project,
            statusFilter: options.statusFilter ? Array.from(options.statusFilter) : undefined,
            limit: options.limit,
            allowBlocked: options.allowBlocked,
            allowRework: options.allowRework,
            parallel: options.parallel,
            branch: options.branch,
            reuseBranch: options.reuseBranch,
            resumeFrom: options.resumeFrom,
        }, {
            jobType: "work",
            resumeSupported: true,
            projectId: options.project,
            totalUnits: selection.selected.length,
        });
        const selectionStatus = selection.cycles.length > 0 ? "warning" : "ok";
        engine.logPhase("selection", selectionStatus, {
            selected: selection.selected.length,
            skipped: selection.skipped.length,
            missing: selection.missing.length,
            statusFilter: Array.from(selection.statusFilter),
            limit: options.limit ?? null,
            allowBlocked: options.allowBlocked,
            allowRework: options.allowRework,
            parallel: options.parallel ?? null,
            cycles: selection.cycles,
        });
        engine.recordTokenUsage({
            command: "work-on-tasks",
            jobId: options.jobId,
            action: "selection",
            operationId: "tasks.work",
            promptTokens: 0,
            completionTokens: 0,
        });
        const primaryTaskId = selection.selected[0]?.id ?? options.targetIds?.values().next().value ?? tasks[0]?.id ?? "unknown-task";
        const gitMeta = ensureDeterministicBranches({
            taskId: primaryTaskId,
            slug: options.project,
            reuseBranch: options.branch,
        });
        engine.logPhase("git:branches", "ok", { base: gitMeta.baseBranch, integration: gitMeta.integrationBranch, task: gitMeta.taskBranch, stash: gitMeta.stashRef });
        engine.updateCommandRun({ gitBranch: gitMeta.taskBranch, gitBaseBranch: gitMeta.integrationBranch, status: "running" });
        engine.recordTokenUsage({
            command: "work-on-tasks",
            jobId: options.jobId,
            action: "git",
            operationId: "tasks.work",
            promptTokens: 0,
            completionTokens: 0,
        });
        const { updated, transitions, skipped, missing } = applyWork(tasks, selection, options.nextStatus);
        const output = buildOutput(options, sourceContent, updated, transitions, skipped, missing, {
            statusFilter: selection.statusFilter,
            limit: options.limit,
            allowBlocked: options.allowBlocked,
            allowRework: options.allowRework,
            parallel: options.parallel,
            cycles: selection.cycles,
        });
        await ensureParentDirectory(options.outputPath);
        await fs.writeFile(options.outputPath, output, "utf8");
        await writeManifest(options, selection);
        await engine.checkpoint("persisted", {
            outputPath: options.outputPath,
            selection: {
                selected: selection.selected.map((t) => t.id),
                skipped,
                missing,
            },
        }, { totalUnits: selection.selected.length, completedUnits: transitions.length });
        const parseStoryPoints = (estimate) => {
            const num = Number(estimate);
            return Number.isFinite(num) ? num : null;
        };
        for (const transition of transitions) {
            engine.logPhase("task:transition", "ok", { from: transition.from, to: transition.to }, transition.id);
            const taskRunId = engine.recordTaskRun({
                taskId: transition.id,
                command: "work-on-tasks",
                status: transition.to,
                storyPoints: parseStoryPoints(updated.find((t) => t.id === transition.id)?.estimate ?? "NaN"),
                notes: transition.note,
                jobId: options.jobId,
            });
            engine.recordTokenUsage({
                command: "work-on-tasks",
                action: `task:${transition.id}`,
                operationId: "tasks.work",
                taskId: transition.id,
                taskRunId,
                jobId: options.jobId,
                promptTokens: 0,
                completionTokens: 0,
            });
        }
        engine.finalize("completed", `Transitions: ${transitions.length}, skipped: ${skipped.length}, missing: ${missing.length}`, options.outputPath);
        // eslint-disable-next-line no-console
        console.log(`Work log written to ${options.outputPath}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        engine.logPhase("error", "failed", { error: message });
        engine.finalize("failed", message);
        throw error;
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
