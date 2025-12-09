#!/usr/bin/env node
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda backlog [--project <KEY>] [--epic <ID>] [--status not_started,in_progress] [--order-by default|dependencies|story_points]",
    "             [--limit <N>] [--json] [--workspace-root <path>]",
    "",
    "Loads tasks from the workspace DB, buckets them by status, and shows backlog summaries.",
].join("\n");
const parseArgs = (argv) => {
    let project;
    let epic;
    let statuses = null;
    let orderBy = "default";
    let limit = null;
    let json = false;
    let workspaceRoot;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--project":
                project = argv[i + 1];
                i += 1;
                break;
            case "--epic":
                epic = argv[i + 1];
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
            case "--order-by":
                if (argv[i + 1] === "dependencies" || argv[i + 1] === "story_points" || argv[i + 1] === "default") {
                    orderBy = argv[i + 1];
                }
                i += 1;
                break;
            case "--limit":
                limit = Number(argv[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--json":
                json = true;
                break;
            case "--workspace-root":
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
    return {
        project,
        epic,
        statuses,
        orderBy,
        limit,
        json,
        workspaceRoot,
    };
};
const bucketForStatus = (status) => {
    if (status === "not_started" || status === "in_progress" || status === "blocked")
        return "implementation";
    if (status === "ready_to_review")
        return "review";
    if (status === "ready_to_qa")
        return "qa";
    if (status === "completed" || status === "cancelled")
        return "done";
    return "other";
};
const emptyTotals = () => ({
    implementation: { tasks: 0, storyPoints: 0 },
    review: { tasks: 0, storyPoints: 0 },
    qa: { tasks: 0, storyPoints: 0 },
    done: { tasks: 0, storyPoints: 0 },
    other: { tasks: 0, storyPoints: 0 },
});
const bumpTotals = (totals, bucket, storyPoints) => {
    totals[bucket].tasks += 1;
    totals[bucket].storyPoints += storyPoints;
};
const summarize = (tasks) => {
    const summary = { totals: emptyTotals(), epics: new Map() };
    for (const task of tasks) {
        const bucket = bucketForStatus(task.status);
        const sp = Number.isFinite(task.storyPoints ?? null) ? Number(task.storyPoints) : 0;
        bumpTotals(summary.totals, bucket, sp);
        const epicKey = task.epicId ?? "(none)";
        const epicEntry = summary.epics.get(epicKey) ??
            {
                epicId: task.epicId ?? null,
                epicTitle: task.epicTitle ?? null,
                totals: emptyTotals(),
                stories: new Map(),
            };
        bumpTotals(epicEntry.totals, bucket, sp);
        const storyKey = task.storyId ?? "(none)";
        const storyEntry = epicEntry.stories.get(storyKey) ??
            {
                storyId: task.storyId ?? null,
                storyTitle: task.storyTitle ?? null,
                totals: emptyTotals(),
            };
        bumpTotals(storyEntry.totals, bucket, sp);
        epicEntry.stories.set(storyKey, storyEntry);
        summary.epics.set(epicKey, epicEntry);
    }
    return summary;
};
const pad = (value, width) => {
    const str = String(value);
    return str.length >= width ? str : `${str}${" ".repeat(width - str.length)}`;
};
const formatTotalsTable = (totals) => {
    const lines = [
        `${pad("Bucket", 16)} ${pad("Tasks", 6)} ${pad("SP", 8)}`,
        `${pad("Implementation", 16)} ${pad(totals.implementation.tasks, 6)} ${pad(totals.implementation.storyPoints, 8)}`,
        `${pad("Review", 16)} ${pad(totals.review.tasks, 6)} ${pad(totals.review.storyPoints, 8)}`,
        `${pad("QA", 16)} ${pad(totals.qa.tasks, 6)} ${pad(totals.qa.storyPoints, 8)}`,
        `${pad("Done", 16)} ${pad(totals.done.tasks, 6)} ${pad(totals.done.storyPoints, 8)}`,
        `${pad("Other", 16)} ${pad(totals.other.tasks, 6)} ${pad(totals.other.storyPoints, 8)}`,
    ];
    return lines.join("\n");
};
const formatEpicsTable = (epics) => {
    if (epics.size === 0)
        return "(no epics)";
    const lines = [`${pad("Epic", 24)} ${pad("Impl_SP", 8)} ${pad("Review_SP", 10)} ${pad("QA_SP", 7)} ${pad("Done_SP", 8)} ${pad("Tasks", 6)}`];
    for (const epic of epics.values()) {
        const totals = epic.totals;
        const taskCount = totals.implementation.tasks +
            totals.review.tasks +
            totals.qa.tasks +
            totals.done.tasks +
            totals.other.tasks;
        const label = epic.epicTitle || epic.epicId || "(none)";
        lines.push(`${pad(label, 24)} ${pad(totals.implementation.storyPoints, 8)} ${pad(totals.review.storyPoints, 10)} ${pad(totals.qa.storyPoints, 7)} ${pad(totals.done.storyPoints, 8)} ${pad(taskCount, 6)}`);
    }
    return lines.join("\n");
};
const formatTasksTable = (tasks) => {
    if (tasks.length === 0)
        return "(no tasks)";
    const header = ["ID", "Status", "SP", "Epic", "Story", "Title"];
    const rows = tasks.map((task) => [
        task.id,
        task.status,
        Number.isFinite(task.storyPoints ?? null) ? String(task.storyPoints) : "TBD",
        task.epicTitle || task.epicId || "",
        task.storyTitle || task.storyId || "",
        task.title,
    ]);
    const widths = header.map((h, idx) => Math.max(h.length, ...rows.map((r) => r[idx].length)));
    const formatRow = (cols) => cols.map((c, idx) => pad(c, widths[idx])).join(" | ");
    return [formatRow(header), formatRow(widths.map((w) => "-".repeat(w))), ...rows.map((r) => formatRow(r))].join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    const store = await createWorkspaceService({ workspaceRoot });
    const tasks = store.listTasks({
        status: options.statuses ? Array.from(options.statuses) : undefined,
        epicId: options.epic,
        limit: options.limit,
        orderBy: options.orderBy,
    });
    const dependencies = store.listTaskDependencies({ taskIds: tasks.map((t) => t.id) });
    const summary = summarize(tasks);
    const commandRunId = store.recordCommandRun({
        command: "backlog",
        workspace: workspaceRoot,
        status: "completed",
        updatedAt: new Date().toISOString(),
    });
    store.recordTokenUsage({
        command: "backlog",
        workspace: workspaceRoot,
        commandRunId,
        operationId: "backlog.list",
        action: "snapshot",
        promptTokens: 0,
        completionTokens: 0,
    });
    if (options.json) {
        const payload = {
            tasks: tasks.map((t) => ({
                id: t.id,
                storyId: t.storyId ?? undefined,
                epicId: t.epicId ?? undefined,
                title: t.title,
                status: t.status,
                storyPoints: t.storyPoints ?? undefined,
                notes: t.notes ?? undefined,
                assigneeHuman: t.assignee ?? undefined,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
            })),
            dependencies: dependencies.map((d) => ({
                taskId: d.taskId,
                dependsOnTaskId: d.dependsOnTaskId,
                relationType: d.relationType ?? undefined,
            })),
        };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    const projectLabel = options.project ?? path.basename(workspaceRoot);
    const statusFilter = options.statuses ? Array.from(options.statuses).join(",") : "(all)";
    const lines = [
        `Backlog for ${projectLabel}`,
        `Workspace: ${workspaceRoot}`,
        `Epic filter: ${options.epic ?? "(none)"}`,
        `Statuses: ${statusFilter}`,
        `Order by: ${options.orderBy}`,
        `Limit: ${options.limit ?? "none"}`,
        "",
        "Summary (tasks and SP by bucket)",
        formatTotalsTable(summary.totals),
        "",
        "Epics",
        formatEpicsTable(summary.epics),
        "",
        "Tasks",
        formatTasksTable(tasks),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
