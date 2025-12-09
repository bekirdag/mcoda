#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { JobEngine } from "@mcoda/core/job-engine.js";
const usage = [
    "mcoda refine-tasks --input <tasks.md>",
    "  [--project <KEY>] [--epic <KEY>] [--story <KEY>]",
    "  [--task TASK-1,TASK-2] [--status not_started,in_progress,blocked] [--max-tasks <N>]",
    "  [--strategy split|merge|enrich|estimate|auto] [--plan-out <path>] [--plan-in <path>] [--dry-run]",
    "  [--agent <NAME>] [--job-id <id>] [--resume] [--json] [--out <path>] [--overwrite]",
    "",
    "Aligns with SDS Section 13: builds/applies a refinement plan, enforces status limits, and records job/token telemetry.",
].join("\n");
const DEFAULT_STATUS_FILTER = ["not_started", "in_progress", "blocked"];
const ALL_STATUSES = [
    "not_started",
    "in_progress",
    "ready_to_review",
    "ready_to_qa",
    "completed",
    "blocked",
    "cancelled",
];
const BANNED_TARGET_STATUSES = ["ready_to_review", "ready_to_qa", "completed"];
const STRATEGIES = new Set(["split", "merge", "enrich", "estimate", "auto"]);
const defaultJobId = () => `refine-tasks-${Date.now()}`;
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "tasks", `refined-${base}.md`);
};
const deriveDefaultPlanOutPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "tasks", `refine-plan-${base}.json`);
};
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let planOutPath;
    let planInPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let epic;
    let story;
    let taskKeys = null;
    let statusFilter = new Set(DEFAULT_STATUS_FILTER);
    let strategy = "auto";
    let maxTasks = null;
    let dryRun = false;
    let agent;
    let jobId;
    let resume = false;
    let json = false;
    let planOutRequested = false;
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
            case "--plan-out":
                planOutRequested = true;
                planOutPath = argv[i + 1];
                i += 1;
                break;
            case "--plan-in":
                planInPath = argv[i + 1];
                i += 1;
                break;
            case "--project":
                project = argv[i + 1] ?? project;
                i += 1;
                break;
            case "--epic":
                epic = argv[i + 1];
                i += 1;
                break;
            case "--story":
                story = argv[i + 1];
                i += 1;
                break;
            case "--task":
            case "--tasks": {
                const raw = argv[i + 1] ?? "";
                const ids = raw
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                taskKeys = ids.length ? new Set(ids) : null;
                i += 1;
                break;
            }
            case "--status": {
                const raw = argv[i + 1] ?? "";
                const parts = raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (parts.length === 0) {
                    statusFilter = null;
                }
                else {
                    const set = new Set();
                    for (const part of parts) {
                        if (!ALL_STATUSES.includes(part)) {
                            throw new Error(`Unsupported status "${part}". Allowed: ${ALL_STATUSES.join(", ")}`);
                        }
                        set.add(part);
                    }
                    statusFilter = set;
                }
                i += 1;
                break;
            }
            case "--max-tasks":
                maxTasks = Number(argv[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--strategy": {
                const value = argv[i + 1];
                if (!value || !STRATEGIES.has(value)) {
                    throw new Error(`--strategy must be one of ${Array.from(STRATEGIES).join("|")}`);
                }
                strategy = value;
                i += 1;
                break;
            }
            case "--dry-run":
                dryRun = true;
                break;
            case "--agent":
                agent = argv[i + 1];
                i += 1;
                break;
            case "--job-id":
                jobId = argv[i + 1];
                i += 1;
                break;
            case "--resume":
                resume = true;
                break;
            case "--json":
                json = true;
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
    const resolvedPlanOut = planOutPath
        ? path.resolve(planOutPath)
        : planOutRequested
            ? deriveDefaultPlanOutPath(resolvedInput)
            : undefined;
    const resolvedPlanIn = planInPath ? path.resolve(planInPath) : undefined;
    const resolvedJobId = jobId ?? defaultJobId();
    const normalizedStatusFilter = statusFilter && statusFilter.size > 0 ? statusFilter : new Set(DEFAULT_STATUS_FILTER);
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        planOutPath: resolvedPlanOut,
        planInPath: resolvedPlanIn,
        overwrite,
        project,
        epic,
        story,
        taskKeys,
        statusFilter: normalizedStatusFilter,
        strategy,
        maxTasks,
        dryRun,
        agent,
        jobId: resolvedJobId,
        resume,
        json,
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
const normalizeStatus = (value) => {
    if (ALL_STATUSES.includes(value))
        return value;
    return "not_started";
};
const parseStoryPoints = (estimate) => {
    const num = Number(estimate);
    return Number.isFinite(num) ? num : undefined;
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
            key: id || "UNKNOWN",
            title: title || "Untitled task",
            status: normalizeStatus(status || "not_started"),
            storyPoints: parseStoryPoints(estimate),
            notes: notes || "",
        });
    }
    return tasks;
};
const selectTasks = (tasks, opts) => {
    let selected = tasks.map((t) => ({
        ...t,
        id: t.id ?? "UNKNOWN",
        key: t.key ?? t.id ?? "UNKNOWN",
    }));
    if (opts.taskKeys) {
        selected = selected.filter((t) => opts.taskKeys?.has(t.id));
    }
    const statusFilter = opts.statusFilter ?? new Set(DEFAULT_STATUS_FILTER);
    selected = selected.filter((t) => statusFilter.has(t.status ?? "not_started"));
    if (opts.maxTasks && opts.maxTasks > 0) {
        selected = selected.slice(0, opts.maxTasks);
    }
    return selected;
};
const normalizeTitle = (title) => title.toLowerCase().replace(/\s+/g, " ").trim();
const buildPlanFromTasks = (tasks, opts) => {
    const byTitle = new Map();
    const operations = [];
    const summary = {
        updated: 0,
        split: 0,
        merged: 0,
        cancelled: 0,
        estimated: 0,
        skipped: 0,
        total: tasks.length,
    };
    for (const task of tasks) {
        const key = normalizeTitle(task.title ?? task.id);
        const group = byTitle.get(key) ?? [];
        group.push(task);
        byTitle.set(key, group);
    }
    for (const group of byTitle.values()) {
        const [target, ...dupes] = group;
        if (dupes.length > 0) {
            const sourceIds = dupes.map((t) => t.id);
            operations.push({
                op: "merge_target",
                targetTaskId: target.id,
                sourceTaskIds: sourceIds,
                note: `Merge duplicates by title (${group.length} tasks)`,
            });
            summary.merged = (summary.merged ?? 0) + dupes.length;
            summary.cancelled = (summary.cancelled ?? 0) + dupes.length;
            for (const dup of dupes) {
                operations.push({
                    op: "merge_cancelled",
                    targetTaskId: dup.id,
                    note: `Cancel duplicate merged into ${target.id}`,
                });
            }
        }
        else {
            operations.push({ op: "noop", targetTaskId: target.id, note: "kept" });
        }
    }
    return {
        strategy: opts.strategy,
        operations,
        summary,
        inputCount: tasks.length,
        generatedAt: new Date().toISOString(),
    };
};
const applyPlan = (plan, tasks) => {
    const byId = new Map();
    for (const task of tasks) {
        byId.set(task.id, { ...task });
    }
    const summary = {
        updated: 0,
        split: 0,
        merged: 0,
        cancelled: 0,
        estimated: 0,
        skipped: 0,
        total: plan.summary?.total ?? plan.inputCount ?? tasks.length,
    };
    const actions = new Map();
    const skipped = [];
    const bannedStatuses = new Set(BANNED_TARGET_STATUSES);
    const appendNote = (task, note) => {
        if (!note)
            return;
        task.notes = task.notes ? `${task.notes} | ${note}` : note;
    };
    const applyFields = (task, fields) => {
        if (!fields)
            return false;
        if (fields.status && bannedStatuses.has(fields.status)) {
            summary.skipped = (summary.skipped ?? 0) + 1;
            skipped.push(`Skipped status change for ${task.id}: ${fields.status} is owned by other commands`);
            return false;
        }
        if (fields.title)
            task.title = fields.title;
        if (fields.description)
            task.description = fields.description;
        if (fields.type)
            task.type = fields.type;
        if (fields.labels)
            task.labels = fields.labels;
        if (fields.metadata)
            task.metadata = fields.metadata;
        if (fields.notes)
            appendNote(task, fields.notes);
        if (fields.storyPoints !== undefined) {
            task.storyPoints = fields.storyPoints;
            summary.estimated = (summary.estimated ?? 0) + 1;
        }
        if (fields.status)
            task.status = fields.status;
        summary.updated = (summary.updated ?? 0) + 1;
        return true;
    };
    for (const op of plan.operations ?? []) {
        const targetId = op.targetTaskId;
        if (!targetId) {
            summary.skipped = (summary.skipped ?? 0) + 1;
            skipped.push("Operation missing targetTaskId");
            continue;
        }
        const target = byId.get(targetId);
        switch (op.op) {
            case "merge_target": {
                if (!target) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    skipped.push(`Missing target ${targetId} for merge_target`);
                    break;
                }
                const mergedIds = op.sourceTaskIds ?? [];
                const mergeNotes = mergedIds
                    .map((id) => {
                    const source = byId.get(id);
                    return source ? `merged ${id}: ${source.title || source.notes || "duplicate"}` : `merged ${id}`;
                })
                    .filter(Boolean);
                appendNote(target, mergeNotes.join(" | "));
                appendNote(target, op.note);
                summary.merged = (summary.merged ?? 0) + mergedIds.length;
                actions.set(target.id, "merge_target");
                break;
            }
            case "merge_cancelled": {
                if (!target) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    skipped.push(`Missing target ${targetId} for merge_cancelled`);
                    break;
                }
                target.status = "cancelled";
                appendNote(target, op.note ?? `Cancelled as duplicate of ${op.sourceTaskIds?.[0] ?? "merge target"}`);
                summary.cancelled = (summary.cancelled ?? 0) + 1;
                actions.set(target.id, "merge_cancelled");
                break;
            }
            case "update": {
                if (!target) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    skipped.push(`Missing target ${targetId} for update`);
                    break;
                }
                applyFields(target, op.fields);
                actions.set(target.id, "update");
                break;
            }
            case "estimate": {
                if (!target) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    skipped.push(`Missing target ${targetId} for estimate`);
                    break;
                }
                applyFields(target, op.fields);
                actions.set(target.id, "estimate");
                break;
            }
            case "cancel": {
                if (!target) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    skipped.push(`Missing target ${targetId} for cancel`);
                    break;
                }
                target.status = "cancelled";
                appendNote(target, op.note);
                summary.cancelled = (summary.cancelled ?? 0) + 1;
                actions.set(target.id, "cancel");
                break;
            }
            case "split_parent":
            case "split_child": {
                summary.skipped = (summary.skipped ?? 0) + 1;
                skipped.push(`Split operations are not implemented; skipping ${targetId}`);
                actions.set(targetId, op.op);
                break;
            }
            case "noop": {
                if (target)
                    actions.set(target.id, "noop");
                break;
            }
            default: {
                summary.skipped = (summary.skipped ?? 0) + 1;
                skipped.push(`Unsupported op ${op.op ?? "unknown"} for ${targetId}`);
                break;
            }
        }
    }
    const refined = [];
    const seen = new Set();
    for (const task of tasks) {
        const updated = byId.get(task.id);
        if (updated && !seen.has(updated.id)) {
            refined.push(updated);
            seen.add(updated.id);
        }
    }
    for (const [id, task] of byId.entries()) {
        if (!seen.has(id))
            refined.push(task);
    }
    for (const task of refined) {
        if (!actions.has(task.id))
            actions.set(task.id, "kept");
    }
    return { refined, summary, actions, skipped };
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, sourceContent, refined, actions, plan, summary, selection) => {
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const filters = opts.statusFilter ? Array.from(opts.statusFilter.values()).join(",") : DEFAULT_STATUS_FILTER.join(",");
    const rows = refined.length === 0
        ? ["| (none) | - | - | - | - | - |"]
        : refined.map((task, idx) => {
            const id = task.id || `TASK-${idx + 1}`;
            const safeTitle = (task.title ?? "").replace(/\|/g, "\\|");
            const safeNotes = (task.notes ?? "").replace(/\|/g, "\\|");
            const action = actions.get(task.id) ?? "kept";
            const estimate = task.storyPoints ?? "TBD";
            return `| ${id} | ${safeTitle} | ${task.status ?? "not_started"} | ${estimate} | ${safeNotes || " "} | ${action} |`;
        });
    const table = [
        "| ID | Title | Status | Estimate (SP) | Notes | Action |",
        "| --- | --- | --- | --- | --- | --- |",
        rows.join("\n"),
    ].join("\n");
    const scopeParts = [`project=${opts.project}`];
    if (opts.epic)
        scopeParts.push(`epic=${opts.epic}`);
    if (opts.story)
        scopeParts.push(`story=${opts.story}`);
    const summaryLines = [
        `- Job: ${opts.jobId}`,
        `- Scope: ${scopeParts.join(", ")}`,
        `- Strategy: ${plan.strategy}`,
        `- Filters: status=${filters}, taskKeys=${opts.taskKeys ? Array.from(opts.taskKeys.values()).join(",") : "(all)"}, max_tasks=${opts.maxTasks ?? "none"}`,
        `- Dry run: ${opts.dryRun ? "yes" : "no"}`,
        `- Input tasks: ${selection.inputCount}`,
        `- Selected: ${selection.selectedCount}`,
        `- Plan operations: ${plan.operations.length}`,
        `- Output tasks: ${refined.length}`,
        `- Summary: merged=${summary.merged ?? 0}, cancelled=${summary.cancelled ?? 0}, updated=${summary.updated ?? 0}, estimated=${summary.estimated ?? 0}, skipped=${summary.skipped ?? 0}`,
        opts.planOutPath ? `- Plan out: ${path.relative(process.cwd(), opts.planOutPath)}` : "",
        opts.planInPath ? `- Plan in: ${path.relative(process.cwd(), opts.planInPath)}` : "",
    ].filter(Boolean);
    const skippedSection = selection.skipped.length === 0
        ? ["- (none)"]
        : selection.skipped.map((reason) => `- ${reason}`);
    return [
        `# Refined tasks for ${opts.project}`,
        "",
        ...summaryLines,
        "",
        "## Refined Tasks",
        table,
        "",
        "## Skipped operations",
        ...skippedSection,
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
    const engine = await JobEngine.create();
    const checkpoint = options.resume ? await engine.loadCheckpoint(options.jobId) : null;
    if (options.resume && checkpoint) {
        // eslint-disable-next-line no-console
        console.log(`Resuming job ${checkpoint.jobId} from stage ${checkpoint.stage}`);
    }
    let jobStarted = false;
    try {
        const sourceContent = await fs.readFile(options.inputPath, "utf8");
        const tasks = parseTasks(sourceContent);
        if (tasks.length === 0) {
            throw new Error("No tasks found in the input document.");
        }
        if (!options.overwrite && !options.dryRun && (await fileExists(options.outputPath))) {
            throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
        }
        if (options.planOutPath && !options.overwrite && (await fileExists(options.planOutPath))) {
            throw new Error(`Plan file already exists: ${options.planOutPath}. Re-run with --overwrite to replace it.`);
        }
        const selection = selectTasks(tasks, options);
        await engine.startJob("refine-tasks", options.jobId, {
            project: options.project,
            epic: options.epic,
            story: options.story,
            taskKeys: options.taskKeys ? Array.from(options.taskKeys.values()) : undefined,
            statusFilter: Array.from((options.statusFilter ?? new Set(DEFAULT_STATUS_FILTER)).values()),
            strategy: options.strategy,
            agent: options.agent,
            planIn: options.planInPath,
            dryRun: options.dryRun,
            maxTasks: options.maxTasks ?? undefined,
        }, {
            jobType: "task_refinement",
            resumeSupported: true,
            projectId: options.project,
            totalUnits: selection.length,
        });
        jobStarted = true;
        engine.logPhase("selection", "ok", {
            input: tasks.length,
            selected: selection.length,
            epic: options.epic ?? null,
            story: options.story ?? null,
            taskKeys: options.taskKeys ? Array.from(options.taskKeys.values()) : null,
            statusFilter: Array.from((options.statusFilter ?? new Set(DEFAULT_STATUS_FILTER)).values()),
            maxTasks: options.maxTasks ?? null,
        });
        engine.recordTokenUsage({
            command: "refine-tasks",
            action: "selection",
            operationId: "tasks.refine",
            promptTokens: 0,
            completionTokens: 0,
        });
        let plan;
        if (options.planInPath) {
            const raw = await fs.readFile(options.planInPath, "utf8");
            plan = JSON.parse(raw);
            plan.strategy = plan.strategy ?? options.strategy;
            plan.inputCount = plan.inputCount ?? selection.length;
            plan.generatedAt = plan.generatedAt ?? new Date().toISOString();
        }
        else {
            plan = buildPlanFromTasks(selection, options);
        }
        engine.logPhase("plan", "ok", { operations: plan.operations.length, strategy: plan.strategy });
        engine.recordTokenUsage({
            command: "refine-tasks",
            action: "plan",
            operationId: "tasks.refine",
            promptTokens: 0,
            completionTokens: 0,
        });
        if (options.planOutPath) {
            await ensureParentDirectory(options.planOutPath);
            await fs.writeFile(options.planOutPath, JSON.stringify(plan, null, 2), "utf8");
        }
        await engine.checkpoint("planned", {
            planOutPath: options.planOutPath,
            planInPath: options.planInPath,
            selected: selection.length,
            input: tasks.length,
        }, { totalUnits: selection.length, completedUnits: 0 });
        const result = applyPlan(plan, selection);
        const output = buildOutput(options, sourceContent, result.refined, result.actions, plan, result.summary, {
            inputCount: tasks.length,
            selectedCount: selection.length,
            skipped: result.skipped,
        });
        if (!options.dryRun) {
            await ensureParentDirectory(options.outputPath);
            await fs.writeFile(options.outputPath, output, "utf8");
            await engine.checkpoint("persisted", { outputPath: options.outputPath, planOutPath: options.planOutPath }, { totalUnits: selection.length, completedUnits: result.refined.length });
            engine.logPhase("apply", "ok", { written: result.refined.length, cancelled: result.summary.cancelled ?? 0 });
            engine.recordTokenUsage({
                command: "refine-tasks",
                action: "apply",
                operationId: "tasks.refine",
                promptTokens: 0,
                completionTokens: 0,
            });
        }
        else {
            engine.logPhase("apply", "skipped", { reason: "dry-run" });
        }
        const summaryText = `plan=${plan.operations.length}, refined=${result.refined.length}, skipped=${result.summary.skipped ?? 0}`;
        engine.finalize("completed", summaryText, options.dryRun ? undefined : options.outputPath);
        const message = options.dryRun
            ? "Plan ready (dry-run; no output file written)."
            : `Refined tasks written to ${options.outputPath}`;
        // eslint-disable-next-line no-console
        console.log(message);
        if (options.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({ plan, summary: result.summary, tasks: result.refined }, null, 2));
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (jobStarted) {
            engine.logPhase("error", "failed", { error: message });
            engine.finalize("failed", message);
        }
        throw error;
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
