#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { DocdexClient } from "@mcoda/core/docdex.js";
import { JobEngine } from "@mcoda/core/job-engine.js";
import { createAgentService } from "@mcoda/core/services.js";
import { invokeAgent } from "@mcoda/core/agent-invoke.js";
import { estimateTokens } from "@mcoda/core/token-math.js";
import { selectAgent } from "./pdr-helpers.js";
const execAsync = promisify(exec);
const usage = [
    "mcoda create-tasks --project <name> [--from-spec <path>...] [--from-diff <base..head>] [--epic-id <id>] [--story-id <id>]",
    "                      [--include-type dev|docs|review|qa] [--max-epics N] [--max-stories N] [--max-tasks N]",
    "                      [--docdex-scope <scope>] [--docdex-max-snippets N] [--no-docdex] [--dry-run]",
    "                      [--job-id <id>] [--resume <job-id>] [--out .mcoda/tasks/<job>.md] [--overwrite]",
    "",
    "Implements SDS Section 12: create-tasks runs as a create_tasks job with docdex context, checkpoints, and per-phase telemetry.",
].join("\n");
const defaultJobId = () => `create-tasks-${Date.now()}`;
const defaultOutputPath = (jobId) => path.join(process.cwd(), ".mcoda", "tasks", `${jobId}.md`);
const parseNumber = (value, fallback) => {
    if (value === undefined)
        return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};
const parseArgs = (argv) => {
    let project = path.basename(process.cwd());
    const specPaths = [];
    let diffRange;
    let epicId;
    let storyId;
    const includeTypes = [];
    let component;
    const labels = [];
    let maxEpics;
    let maxStories;
    let maxTasks = 12;
    let docdexScope;
    let docdexMaxSnippets;
    let noDocdex = false;
    let dryRun = false;
    let jobId;
    let resumeFrom;
    let outputPath;
    let overwrite = false;
    let agentName;
    let storePath;
    let workspaceRoot;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--project":
                project = argv[i + 1] ?? project;
                i += 1;
                break;
            case "--from-spec":
            case "--input": // legacy alias
            case "-i":
                if (argv[i + 1])
                    specPaths.push(argv[i + 1]);
                i += 1;
                break;
            case "--from-diff":
                diffRange = argv[i + 1];
                i += 1;
                break;
            case "--epic-id":
                epicId = argv[i + 1];
                i += 1;
                break;
            case "--story-id":
                storyId = argv[i + 1];
                i += 1;
                break;
            case "--include-type":
                if (argv[i + 1])
                    includeTypes.push(argv[i + 1]);
                i += 1;
                break;
            case "--component":
                component = argv[i + 1];
                i += 1;
                break;
            case "--label":
                if (argv[i + 1])
                    labels.push(argv[i + 1]);
                i += 1;
                break;
            case "--max-epics":
                maxEpics = parseNumber(argv[i + 1], maxEpics);
                i += 1;
                break;
            case "--max-stories":
                maxStories = parseNumber(argv[i + 1], maxStories);
                i += 1;
                break;
            case "--max-tasks":
            case "--max":
                maxTasks = parseNumber(argv[i + 1], maxTasks) ?? maxTasks;
                i += 1;
                break;
            case "--docdex-scope":
                docdexScope = argv[i + 1];
                i += 1;
                break;
            case "--docdex-max-snippets":
                docdexMaxSnippets = parseNumber(argv[i + 1], docdexMaxSnippets);
                i += 1;
                break;
            case "--no-docdex":
                noDocdex = true;
                break;
            case "--dry-run":
                dryRun = true;
                break;
            case "--job-id":
                jobId = argv[i + 1];
                i += 1;
                break;
            case "--resume":
                resumeFrom = argv[i + 1];
                i += 1;
                break;
            case "--out":
            case "-o":
                outputPath = argv[i + 1];
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--agent":
                agentName = argv[i + 1];
                i += 1;
                break;
            case "--store":
                storePath = argv[i + 1];
                i += 1;
                break;
            case "--workspace":
                workspaceRoot = argv[i + 1];
                i += 1;
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
    if (!project) {
        throw new Error("Project is required (--project <name>) to bind generated epics/stories/tasks (SDS 12.1).");
    }
    if (!specPaths.length && !diffRange && !epicId && !storyId) {
        throw new Error("At least one input is required (--from-spec, --from-diff, --epic-id, or --story-id) per SDS 12.1.");
    }
    const dedupedSpecs = Array.from(new Set(specPaths)).map((p) => path.resolve(p));
    const resolvedJobId = resumeFrom ?? jobId ?? defaultJobId();
    const resolvedOutput = path.resolve(outputPath ?? defaultOutputPath(resolvedJobId));
    const resolvedWorkspace = path.resolve(workspaceRoot ?? (dedupedSpecs[0] ? path.dirname(dedupedSpecs[0]) : process.cwd()));
    return {
        project,
        epicId,
        storyId,
        specPaths: dedupedSpecs,
        diffRange,
        includeTypes,
        component,
        labels,
        maxEpics,
        maxStories,
        maxTasks: Math.max(1, maxTasks),
        docdexScope,
        docdexMaxSnippets,
        noDocdex,
        dryRun,
        jobId: resolvedJobId,
        resumeFrom,
        outputPath: resolvedOutput,
        overwrite,
        agentName,
        storePath: storePath ? path.resolve(storePath) : undefined,
        workspaceRoot: resolvedWorkspace,
    };
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
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
const truncate = (value, maxLen) => {
    if (value.length <= maxLen)
        return value;
    return `${value.slice(0, maxLen - 3)}...`;
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const preview = (content, maxLines = 8, maxLen = 480) => {
    const joined = content
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(0, maxLines)
        .join(" ");
    return truncate(joined, maxLen);
};
const readDiff = async (range) => {
    try {
        const { stdout } = await execAsync(`git diff ${range} --no-color`, { maxBuffer: 5 * 1024 * 1024 });
        return { range, content: stdout };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read diff ${range}: ${reason}`);
    }
};
const normalizeInputs = async (options) => {
    const client = new DocdexClient({
        workspaceRoot: options.workspaceRoot,
        allowPaths: options.specPaths.map((p) => path.resolve(p)),
    });
    const specs = options.specPaths.length ? await client.fetchSegments(options.specPaths) : [];
    const diff = options.diffRange ? await readDiff(options.diffRange) : undefined;
    const docdexUsed = !options.noDocdex && specs.length > 0;
    return { specs, diff, docdexUsed };
};
const summarizeDocdex = (segments, maxSnippets) => {
    const slice = typeof maxSnippets === "number" && maxSnippets > 0 ? segments.slice(0, maxSnippets) : segments;
    return slice.map((seg) => ({
        path: seg.path,
        summary: preview(seg.content, 6, 320),
    }));
};
const extractBullets = (content, limit) => {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*+]\s+/.test(line))
        .map((line) => line.replace(/^[-*+]\s+/, "").trim())
        .filter((line) => line.length > 0)
        .slice(0, Math.max(1, limit));
};
const buildTasks = (normalized, options) => {
    const combined = [
        ...normalized.specs.map((s) => s.content),
        normalized.diff?.content ? `Diff (${normalized.diff.range}):\n${normalized.diff.content}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
    const seeds = extractBullets(combined, options.maxTasks);
    if (seeds.length === 0) {
        return [
            {
                id: "TASK-1",
                title: "Review inputs and seed tasks",
                status: "not_started",
                estimate: "TBD",
                notes: "No bullet seeds found; add tasks manually or re-run with clearer spec bullets.",
            },
        ];
    }
    return seeds.map((text, index) => ({
        id: `TASK-${index + 1}`,
        title: truncate(text, 80),
        status: "not_started",
        estimate: "TBD",
        notes: `Derived from: ${truncate(text, 120)}`,
    }));
};
const buildTasksContent = (options, normalized, tasks, docSummaries) => {
    const now = new Date().toISOString();
    const table = [
        "| ID | Title | Status | Estimate (SP) | Notes |",
        "| --- | --- | --- | --- | --- |",
        tasks
            .map((task) => {
            const safeTitle = task.title.replace(/\|/g, "\\|");
            const safeNotes = task.notes.replace(/\|/g, "\\|");
            return `| ${task.id} | ${safeTitle} | ${task.status} | ${task.estimate} | ${safeNotes} |`;
        })
            .join("\n"),
    ].join("\n");
    const sources = normalized.specs.map((s) => `- ${path.relative(process.cwd(), s.path)}`);
    if (normalized.diff)
        sources.push(`- diff: ${normalized.diff.range}`);
    const docdexSummary = options.noDocdex
        ? "disabled (--no-docdex)"
        : `enabled (scope=${options.docdexScope ?? "workspace"}, maxSnippets=${options.docdexMaxSnippets ?? "default"})`;
    const includeTypes = options.includeTypes.length ? options.includeTypes.join(", ") : "all";
    const labels = options.labels.length ? options.labels.join(", ") : "(none)";
    const component = options.component ?? "(none)";
    const docdexSection = docSummaries.length === 0
        ? ["- (none)"]
        : docSummaries.map((summary) => `- ${path.basename(summary.path)}: ${summary.summary}`);
    const specAppendix = normalized.specs.length === 0
        ? ["(no spec files provided)"]
        : normalized.specs.flatMap((spec) => [
            `### ${path.relative(process.cwd(), spec.path)}`,
            fence(spec.content, "markdown"),
            "",
        ]);
    const diffAppendix = normalized.diff
        ? ["### Diff context", fence(normalized.diff.content, "diff"), ""]
        : [];
    return [
        `# Tasks for ${options.project}`,
        "",
        `- Job: ${options.jobId}`,
        `- Mode: ${options.dryRun ? "dry-run preview (no persistence)" : "draft persisted to file"}`,
        `- Sources:\n${sources.join("\n")}`,
        `- Docdex: ${docdexSummary}`,
        `- Component: ${component}`,
        `- Limits: epics=${options.maxEpics ?? "n/a"}, stories=${options.maxStories ?? "n/a"}, tasks=${options.maxTasks}`,
        `- Types: ${includeTypes}`,
        `- Labels: ${labels}`,
        `- Generated: ${now}`,
        "",
        "## Tasks",
        table,
        "",
        "## Docdex summaries",
        ...docdexSection,
        "",
        "## Next steps",
        "- Refine titles/descriptions and add dependencies.",
        "- Set estimates (SP) and assign owners.",
        "- Feed into mcoda workflow (refine-tasks, work-on-tasks, etc.).",
        "",
        "## Appendix A: Inputs",
        ...specAppendix,
        ...diffAppendix,
    ].join("\n");
};
const buildAgentPrompt = (options, normalized) => {
    const docsList = normalized.specs.length > 0
        ? normalized.specs.map((s) => s.path).join("\n- ")
        : "- (no specs provided)";
    const diffNote = normalized.diff ? `Diff: ${normalized.diff.range}` : "Diff: (none)";
    return [
        "# Task",
        "You are a delivery lead. Generate a concise backlog (epics/stories/tasks) based on the provided specs (and diff if present).",
        "",
        "# Output format (Markdown table)",
        "| ID | Title | Status | Estimate (SP) | Notes |",
        "| --- | --- | --- | --- | --- |",
        "| TASK-1 | <title> | not_started | TBD | <short note> |",
        "",
        "# Constraints",
        "- Stay within the provided specs/diff; do not invent unrelated scope.",
        "- Keep titles short; notes explain context or source doc.",
        `- Max tasks: ${options.maxTasks}`,
        "",
        "# Project context",
        `- Project: ${options.project}`,
        options.epicId ? `- Epic: ${options.epicId}` : "",
        options.storyId ? `- Story: ${options.storyId}` : "",
        diffNote,
        "",
        "# Specs (docdex paths)",
        docsList,
    ]
        .filter(Boolean)
        .join("\n");
};
const parseAgentTasks = (response, limit) => {
    const lines = response
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("|"));
    const rows = lines.slice(2); // skip header/separator
    const tasks = [];
    for (const row of rows) {
        const cells = row.split("|").map((c) => c.trim());
        if (cells.length < 6)
            continue;
        const id = cells[1] || `TASK-${tasks.length + 1}`;
        const title = cells[2] || "Untitled task";
        const status = cells[3] || "not_started";
        const estimate = cells[4] || "TBD";
        const notes = cells[5] || "";
        tasks.push({ id, title: truncate(title, 80), status, estimate, notes: truncate(notes, 120) });
        if (tasks.length >= limit)
            break;
    }
    return tasks;
};
const buildRequestPayload = (options) => {
    return {
        project: options.project,
        epicId: options.epicId,
        storyId: options.storyId,
        fromSpec: options.specPaths,
        fromDiff: options.diffRange,
        includeTypes: options.includeTypes.length ? options.includeTypes : undefined,
        component: options.component,
        labels: options.labels.length ? options.labels : undefined,
        maxEpics: options.maxEpics,
        maxStories: options.maxStories,
        maxTasks: options.maxTasks,
        docdexScope: options.docdexScope,
        docdexMaxSnippets: options.docdexMaxSnippets,
        noDocdex: options.noDocdex,
        dryRun: options.dryRun,
        resumeFrom: options.resumeFrom,
        jobId: options.jobId,
    };
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const engine = await JobEngine.create();
    const existing = options.resumeFrom ? await engine.loadCheckpoint(options.resumeFrom) : null;
    const checkpointPayload = (existing?.payload ?? null);
    if (existing && options.resumeFrom) {
        // eslint-disable-next-line no-console
        console.log(`Resuming job ${existing.jobId} from stage ${existing.stage}`);
    }
    if (!options.overwrite && checkpointPayload?.outputPath && (await fileExists(checkpointPayload.outputPath))) {
        options.outputPath = checkpointPayload.outputPath;
    }
    const outputExists = await fileExists(options.outputPath);
    if (!options.overwrite && outputExists && !existing) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    const requestPayload = buildRequestPayload(options);
    await engine.startJob("create-tasks", options.jobId, requestPayload, {
        jobType: "task_creation",
        resumeSupported: true,
        projectId: options.project,
    });
    if (existing?.stage) {
        await engine.checkpoint(existing.stage, existing.payload);
    }
    if (existing?.stage === "persisted" && outputExists && !options.overwrite) {
        engine.finalize("completed", "Checkpoint already persisted; nothing to do", options.outputPath);
        // eslint-disable-next-line no-console
        console.log(`Checkpoint already persisted at ${options.outputPath}; rerun with --overwrite to regenerate.`);
        return;
    }
    const normalized = checkpointPayload?.normalized ?? (await normalizeInputs(options));
    engine.logPhase("input_normalized", "ok", { specs: normalized.specs.length, diff: Boolean(normalized.diff), project: options.project });
    engine.recordTokenUsage({
        command: "create-tasks",
        action: "analyze-input",
        operationId: "tasks.create",
        promptTokens: 0,
        completionTokens: 0,
    });
    if (!checkpointPayload?.normalized) {
        await engine.checkpoint("input_normalized", { normalized, outputPath: options.outputPath, project: options.project, maxTasks: options.maxTasks });
    }
    const docSummaries = checkpointPayload?.generated?.docSummaries ?? (normalized.docdexUsed ? summarizeDocdex(normalized.specs, options.docdexMaxSnippets) : []);
    engine.logPhase("docdex", normalized.docdexUsed ? "ok" : "skipped", {
        scope: options.docdexScope ?? "workspace",
        snippets: docSummaries.length,
        disabled: options.noDocdex,
    });
    if (normalized.docdexUsed && !checkpointPayload?.generated?.docSummaries) {
        engine.recordTokenUsage({
            command: "create-tasks",
            action: "docdex-summarize",
            operationId: "tasks.create",
            promptTokens: 0,
            completionTokens: 0,
        });
    }
    const agentRegistry = await createAgentService({ dbPath: options.storePath });
    const agents = agentRegistry.listAgents();
    if (!agents.length) {
        throw new Error("No agents found in the registry. Add one with `pnpm mcoda:agent -- add ...`.");
    }
    const workspaceDefault = agentRegistry.getWorkspaceDefault(options.workspaceRoot);
    const globalDefault = agentRegistry.getWorkspaceDefault("__GLOBAL__");
    const workspaceRule = agentRegistry.listRoutingRules(options.workspaceRoot).find((r) => r.command === "create-tasks")?.agent ?? null;
    const globalRule = agentRegistry.listRoutingRules("__GLOBAL__").find((r) => r.command === "create-tasks")?.agent ?? null;
    const { agent, reason: selectionReason } = selectAgent(agents, {
        preferred: options.agentName,
        workspaceRule,
        globalRule,
        workspaceDefault,
        globalDefault,
    });
    let tasks = checkpointPayload?.generated?.tasks;
    if (!tasks) {
        const userPrompt = buildAgentPrompt(options, normalized);
        const docPaths = options.specPaths;
        const invocation = await invokeAgent({
            agent,
            command: "create-tasks",
            userPrompt,
            workspaceRoot: options.workspaceRoot,
            docPaths,
            docdexAllowPaths: options.specPaths,
            docdexChunkSize: 4000,
            docdexMaxSegments: 12,
            context: {
                project: options.project,
                ...(options.epicId ? { epicId: options.epicId } : {}),
                ...(options.storyId ? { storyId: options.storyId } : {}),
            },
        });
        const parsed = parseAgentTasks(invocation.response ?? "", options.maxTasks);
        tasks = parsed.length ? parsed : buildTasks(normalized, options);
        const now = new Date().toISOString();
        const promptTokens = estimateTokens(invocation.redactedPrompt ?? invocation.prompt ?? userPrompt);
        const completionTokens = estimateTokens(invocation.redactedResponse ?? invocation.response ?? "");
        engine.recordTokenUsage({
            command: "create-tasks",
            action: "generate-tasks",
            operationId: "tasks.create",
            agent: agent.name ?? "unknown",
            model: agent.model ?? "unknown",
            promptTokens,
            completionTokens,
            workspace: options.workspaceRoot,
            recordedAt: now,
        });
        await engine.checkpoint("tasks_generated", {
            normalized,
            generated: { tasks, docSummaries, agent: agent.name, selectionReason },
            outputPath: options.outputPath,
            project: options.project,
            dryRun: options.dryRun,
            maxTasks: options.maxTasks,
        }, { totalUnits: tasks.length, completedUnits: 0 });
    }
    const output = buildTasksContent(options, normalized, tasks, docSummaries);
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    await engine.checkpoint("persisted", {
        generated: { tasks, docSummaries },
        normalized,
        outputPath: options.outputPath,
        dryRun: options.dryRun,
    }, { totalUnits: tasks.length, completedUnits: tasks.length });
    engine.recordTokenUsage({
        command: "create-tasks",
        action: options.dryRun ? "dry-run" : "persist",
        operationId: "tasks.create",
        promptTokens: 0,
        completionTokens: 0,
    });
    engine.finalize("completed", `tasks=${tasks.length}, docdex=${normalized.docdexUsed ? "on" : "off"}`, options.outputPath);
    // eslint-disable-next-line no-console
    console.log(`Tasks draft created at ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
