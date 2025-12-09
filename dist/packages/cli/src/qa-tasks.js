#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
import { ensureDeterministicBranches } from "@mcoda/core/git.js";
const usage = [
    "mcoda qa-tasks --input <path/to/tasks-or-review.md> [--tasks TASK-1,TASK-2] [--mode auto|manual] [--result pass|fail|blocked] [--recommendation pass|fix_required|infra_issue|unclear] [--profile <qa-profile>] [--level unit|integration|acceptance] [--runner cli|chromium|maestro|custom] [--test-command \"<cmd>\"] [--agent <name>] [--allow-rework] [--reopen] [--job-id <id>] [--checkpoint <path>] [--resume] [--out .mcoda/qa/qa-<name>.md] [--notes \"...\"] [--evidence-url <url>] [--dry-run] [--overwrite]",
    "",
    "Marks selected tasks with a QA result and writes a QA log (telemetry stored in workspace DB).",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "qa", `qa-${base}.md`);
};
const defaultJobId = () => `qa-tasks-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "qa", "checkpoint.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let targetIds = null;
    let mode = "auto";
    let profile;
    let level;
    let runner;
    let testCommand;
    let agent;
    let allowRework = false;
    let reopen = false;
    let result = "pass";
    let recommendation;
    let notes;
    const evidenceUrls = [];
    let dryRun = false;
    let jobId;
    let checkpointPath;
    let resume = false;
    const nextArg = (index) => argv[index + 1];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--input":
            case "-i":
                inputPath = nextArg(i);
                i += 1;
                break;
            case "--out":
            case "-o":
                outputPath = nextArg(i);
                i += 1;
                break;
            case "--project":
                project = nextArg(i) ?? project;
                i += 1;
                break;
            case "--tasks":
                targetIds = new Set((nextArg(i) ?? "")
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean));
                i += 1;
                break;
            case "--mode":
                mode = nextArg(i) ?? mode;
                i += 1;
                break;
            case "--profile":
                profile = nextArg(i) ?? profile;
                i += 1;
                break;
            case "--level":
                level = nextArg(i);
                i += 1;
                break;
            case "--runner":
                runner = nextArg(i) ?? runner;
                i += 1;
                break;
            case "--test-command":
                testCommand = nextArg(i) ?? testCommand;
                i += 1;
                break;
            case "--agent":
                agent = nextArg(i) ?? agent;
                i += 1;
                break;
            case "--allow-rework":
                allowRework = true;
                break;
            case "--reopen":
                reopen = true;
                break;
            case "--result":
            case "--decision":
                result = nextArg(i) ?? result;
                i += 1;
                break;
            case "--recommendation":
                recommendation = nextArg(i);
                i += 1;
                break;
            case "--notes":
                notes = nextArg(i) ?? notes;
                i += 1;
                break;
            case "--evidence-url": {
                const url = nextArg(i);
                if (url)
                    evidenceUrls.push(url);
                i += 1;
                break;
            }
            case "--dry-run":
                dryRun = true;
                break;
            case "--job-id":
                jobId = nextArg(i);
                i += 1;
                break;
            case "--checkpoint":
                checkpointPath = nextArg(i);
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
        throw new Error("Missing required --input <path/to/tasks-or-review.md> argument");
    }
    if (!["auto", "manual"].includes(mode)) {
        throw new Error("--mode must be auto or manual");
    }
    if (!["pass", "fail", "blocked"].includes(result)) {
        throw new Error("--result must be pass, fail, or blocked");
    }
    if (recommendation && !["pass", "fix_required", "infra_issue", "unclear"].includes(recommendation)) {
        throw new Error("--recommendation must be pass|fix_required|infra_issue|unclear when provided");
    }
    if (level && !["unit", "integration", "acceptance"].includes(level)) {
        throw new Error("--level must be unit, integration, or acceptance");
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
        mode,
        profile,
        level,
        runner,
        testCommand,
        agent,
        allowRework,
        reopen,
        result,
        recommendation,
        notes,
        evidenceUrls,
        jobId: resolvedJobId,
        checkpointPath: path.resolve(checkpointPath ?? defaultCheckpointPath(resolvedJobId)),
        resume,
        dryRun,
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
const inferRecommendation = (opts) => {
    if (opts.recommendation)
        return opts.recommendation;
    if (opts.result === "pass")
        return "pass";
    if (opts.result === "blocked")
        return "infra_issue";
    return "fix_required";
};
const applyQa = (tasks, opts) => {
    const chosen = opts.targetIds ?? new Set(tasks.map((t) => t.id));
    const outcomes = [];
    const skipped = [];
    const allowedStatuses = new Set(["ready_to_qa"]);
    if (opts.allowRework)
        allowedStatuses.add("in_progress");
    if (opts.reopen)
        allowedStatuses.add("completed");
    const seen = new Set();
    const recommendationForRun = inferRecommendation(opts);
    const baseNote = opts.notes ?? (opts.mode === "manual" ? "Manual QA result recorded." : "Automated QA outcome recorded.");
    const updated = tasks.map((task) => {
        if (!chosen.has(task.id))
            return task;
        seen.add(task.id);
        const currentStatus = task.status || "ready_to_qa";
        if (!allowedStatuses.has(currentStatus)) {
            const allowed = ["ready_to_qa", opts.allowRework ? "in_progress" : null, opts.reopen ? "completed" : null]
                .filter(Boolean)
                .join("/");
            skipped.push({
                id: task.id,
                title: task.title,
                status: currentStatus,
                reason: `Status gating: expected ${allowed || "ready_to_qa"}, found ${currentStatus || "unknown"}`,
            });
            return task;
        }
        const from = currentStatus;
        const recommendation = recommendationForRun;
        let to = from;
        if (opts.mode === "manual") {
            if (opts.result === "pass") {
                to = "completed";
            }
            else if (opts.result === "blocked") {
                to = "blocked";
            }
            else {
                to = "in_progress";
            }
        }
        else {
            if (recommendation === "pass") {
                to = "completed";
            }
            else if (recommendation === "fix_required") {
                to = "in_progress";
            }
            else if (recommendation === "infra_issue") {
                to = "blocked";
            }
            else {
                to = from || "ready_to_qa";
            }
        }
        const auditNoteParts = [
            baseNote,
            `mode=${opts.mode}`,
            `result=${opts.result}`,
            `recommendation=${recommendation}`,
            opts.profile ? `profile=${opts.profile}` : null,
            opts.runner ? `runner=${opts.runner}` : null,
        ].filter(Boolean);
        const comment = auditNoteParts.join(" | ");
        outcomes.push({
            id: task.id,
            from,
            to,
            title: task.title,
            mode: opts.mode,
            result: opts.result,
            recommendation,
            profile: opts.profile,
            runner: opts.runner,
            notes: baseNote,
            evidenceUrls: opts.evidenceUrls,
        });
        return { ...task, status: to, notes: task.notes ? `${task.notes} | ${comment}` : comment };
    });
    const missing = Array.from(chosen).filter((id) => !seen.has(id));
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
    const recommendation = outcomes[0]?.recommendation ?? inferRecommendation(opts);
    const summaryLines = [
        `- Source tasks: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Job: ${opts.jobId}${opts.resume ? " (resumed)" : ""}`,
        `- Mode: ${opts.mode}`,
        `- Profile: ${opts.profile ?? "(unset)"} | Level: ${opts.level ?? "(unset)"} | Runner: ${opts.runner ?? "cli"}`,
        `- Raw result: ${opts.result} | Recommendation: ${recommendation}`,
        `- Test command override: ${opts.testCommand ?? "(profile default)"}`,
        `- Agent: ${opts.agent ?? "(workspace default)"}`,
        `- Notes: ${opts.notes ?? "none"}`,
        `- Evidence URLs: ${opts.evidenceUrls.length ? opts.evidenceUrls.join(", ") : "(none)"}`,
        `- Tasks tested: ${outcomes.length}`,
        `- Skipped (status-gated): ${skipped.length}`,
        `- Missing: ${missing.length}`,
    ];
    if (opts.dryRun) {
        summaryLines.push("- Dry-run enabled: no output file or task_run records persisted.");
    }
    const outcomeLines = outcomes.length === 0
        ? ["- No tasks selected."]
        : outcomes.map((o) => {
            const fields = [
                `${o.id}: ${o.from} → ${o.to}`,
                `mode=${o.mode}`,
                `result=${o.result}`,
                `recommendation=${o.recommendation}`,
                o.profile ? `profile=${o.profile}` : null,
                o.runner ? `runner=${o.runner}` : null,
                o.notes ? o.notes : null,
                o.evidenceUrls.length ? `evidence=${o.evidenceUrls.join(", ")}` : null,
            ].filter(Boolean);
            return `- ${fields.join(" | ")}`;
        });
    return [
        `# QA log for ${opts.project}`,
        "",
        ...summaryLines,
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
        "- Prototype helper; full mcoda qa-tasks will drive QA profiles, agents/adapters, jobs, and token usage.",
        "- Apply these outcomes to your workflow/DB as needed.",
        ...(opts.dryRun ? ["- Dry-run run only; no checkpoint or file writes were persisted."] : []),
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
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const workspaceStore = await createWorkspaceService();
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    const startedAt = new Date().toISOString();
    let commandRunId;
    const recordPhase = (phase, status, details, taskId) => {
        workspaceStore.recordTaskRunLog({
            commandRunId,
            taskId,
            phase,
            status,
            detailsJson: details ? JSON.stringify(details) : undefined,
        });
    };
    const recordToken = (action, taskId) => {
        workspaceStore.recordTokenUsage({
            command: "qa-tasks",
            jobId: options.jobId,
            commandRunId,
            taskId,
            agent: options.agent,
            action,
            operationId: "tasks.qa",
            promptTokens: 0,
            completionTokens: 0,
        });
    };
    if (!options.dryRun && !options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    let checkpoint = null;
    if (options.resume) {
        checkpoint = await readCheckpoint(options.checkpointPath);
        if (!checkpoint) {
            throw new Error(`No checkpoint found at ${options.checkpointPath}`);
        }
        // eslint-disable-next-line no-console
        console.log(`Resuming job ${checkpoint.jobId} from stage ${checkpoint.stage}`);
        options.jobId = checkpoint.jobId;
        options.mode = checkpoint.mode ?? options.mode;
        options.profile = checkpoint.profile ?? options.profile;
        options.level = checkpoint.level ?? options.level;
        options.runner = checkpoint.runner ?? options.runner;
        options.result = checkpoint.result ?? options.result;
        options.recommendation = checkpoint.recommendation ?? options.recommendation;
        options.notes = options.notes ?? checkpoint.notes;
        options.evidenceUrls = options.evidenceUrls.length ? options.evidenceUrls : checkpoint.evidenceUrls ?? [];
        options.allowRework = checkpoint.allowRework ?? options.allowRework;
        options.reopen = checkpoint.reopen ?? options.reopen;
        options.outputPath = checkpoint.outputPath ?? options.outputPath;
    }
    try {
        const tasks = parseTasks(sourceContent);
        const primaryTaskId = options.targetIds?.values().next().value ?? tasks[0]?.id ?? "unknown-task";
        const gitMeta = ensureDeterministicBranches({
            taskId: primaryTaskId,
            slug: options.project,
        });
        commandRunId = workspaceStore.recordCommandRun({
            command: "qa-tasks",
            jobId: options.jobId,
            status: "running",
            gitBranch: gitMeta.taskBranch,
            gitBaseBranch: gitMeta.integrationBranch,
            agent: options.agent,
            startedAt,
        });
        recordPhase("git:branches", "ok", { base: gitMeta.baseBranch, integration: gitMeta.integrationBranch, task: gitMeta.taskBranch, stash: gitMeta.stashRef });
        recordToken("prepare");
        recordPhase("qa:prepare", "ok", {
            mode: options.mode,
            profile: options.profile,
            level: options.level,
            runner: options.runner ?? "cli",
            testCommand: options.testCommand,
            allowRework: options.allowRework,
            reopen: options.reopen,
            dryRun: options.dryRun,
            evidenceUrls: options.evidenceUrls,
        });
        recordPhase("qa:run-tests", options.mode === "auto" ? "skipped" : "manual", {
            runner: options.runner ?? "cli",
            testCommand: options.testCommand,
            mode: options.mode,
            reason: options.mode === "auto" ? "Prototype helper does not execute adapters." : "Manual QA result supplied.",
        });
        const { updated, outcomes, skipped, missing } = applyQa(tasks, options);
        const output = buildOutput(options, sourceContent, updated, outcomes, skipped, missing);
        if (!options.dryRun) {
            await ensureParentDirectory(options.outputPath);
            await fs.writeFile(options.outputPath, output, "utf8");
        }
        else {
            // eslint-disable-next-line no-console
            console.log("Dry-run: previewing QA log; no files written.");
        }
        const now = new Date().toISOString();
        if (!options.dryRun) {
            const checkpointPayload = {
                jobId: options.jobId,
                command: "qa-tasks",
                stage: "persisted",
                outputPath: options.outputPath,
                updatedAt: now,
                mode: options.mode,
                profile: options.profile,
                level: options.level,
                runner: options.runner,
                result: options.result,
                recommendation: options.recommendation ?? inferRecommendation(options),
                notes: options.notes,
                evidenceUrls: options.evidenceUrls,
                allowRework: options.allowRework,
                reopen: options.reopen,
            };
            await writeCheckpoint(options.checkpointPath, checkpointPayload);
        }
        const parseStoryPoints = (estimate) => {
            const num = Number(estimate);
            return Number.isFinite(num) ? num : null;
        };
        for (const outcome of outcomes) {
            recordPhase("qa:interpret-results", options.dryRun ? "planned" : "ok", {
                from: outcome.from,
                to: outcome.to,
                mode: outcome.mode,
                result: outcome.result,
                recommendation: outcome.recommendation,
                profile: outcome.profile,
                runner: outcome.runner,
                notes: outcome.notes,
                evidenceUrls: outcome.evidenceUrls,
            }, outcome.id);
            if (!options.dryRun) {
                const estimate = updated.find((t) => t.id === outcome.id)?.estimate ?? "NaN";
                workspaceStore.recordTaskRun({
                    taskId: outcome.id,
                    command: "qa-tasks",
                    status: outcome.to,
                    storyPoints: parseStoryPoints(estimate),
                    notes: outcome.notes,
                    jobId: options.jobId,
                });
            }
            recordPhase("qa:apply-state-transition", options.dryRun ? "planned" : "ok", { from: outcome.from, to: outcome.to }, outcome.id);
            recordToken("interpret-results", outcome.id);
            recordToken("apply-state-transition", outcome.id);
        }
        workspaceStore.updateCommandRun(commandRunId, {
            status: "completed",
            completedAt: now,
            summary: `${options.dryRun ? "Dry-run " : ""}QA outcomes: ${outcomes.length}, skipped: ${skipped.length}, missing: ${missing.length}`,
            outputPath: options.dryRun ? undefined : options.outputPath,
        });
        // eslint-disable-next-line no-console
        console.log(options.dryRun ? "QA dry-run complete (no output written)." : `QA log written to ${options.outputPath}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (commandRunId) {
            workspaceStore.updateCommandRun(commandRunId, {
                status: "failed",
                completedAt: new Date().toISOString(),
                summary: message,
            });
        }
        recordPhase("error", "failed", { error: message });
        throw error;
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
