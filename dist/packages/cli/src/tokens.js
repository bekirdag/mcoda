#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda tokens [--workspace-root <path>] [--store <dbPath>] [--workspace <name>] [--command work-on-tasks] [--agent primary]",
    "             [--group-by command,agent,day] [--since 7d] [--limit 50] [--json] [--out <file>] [--overwrite] [--no-entries]",
    "",
    "Lists token usage entries from the workspace SQLite DB (<repo>/.mcoda/mcoda.db) and optionally aggregates them.",
].join("\n");
const parseSince = (value) => {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const relativeMatch = /^([0-9]+)([dhm])$/i.exec(trimmed);
    if (relativeMatch) {
        const amount = Number(relativeMatch[1]);
        const unit = relativeMatch[2].toLowerCase();
        const now = new Date();
        if (unit === "d") {
            now.setDate(now.getDate() - amount);
        }
        else if (unit === "h") {
            now.setHours(now.getHours() - amount);
        }
        else if (unit === "m") {
            now.setMinutes(now.getMinutes() - amount);
        }
        return now;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid --since value: ${value}`);
    }
    return parsed;
};
const normalizeGroupBy = (value) => {
    if (!value)
        return ["command", "agent"];
    if (value.toLowerCase() === "none")
        return [];
    const allowed = ["workspace", "command", "agent", "model", "action", "operation", "day"];
    const fields = value
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    const invalid = fields.filter((f) => !allowed.includes(f));
    if (invalid.length) {
        throw new Error(`Invalid group-by values: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}, or 'none'.`);
    }
    return Array.from(new Set(fields));
};
const parseArgs = (argv) => {
    let workspaceRoot = process.cwd();
    let dbPath;
    let command;
    let agent;
    let workspace;
    let json = false;
    let outputPath;
    let overwrite = false;
    let limit = null;
    let groupBy = ["command", "agent"];
    let since;
    let includeEntries = true;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--workspace-root":
            case "--root":
                workspaceRoot = path.resolve(argv[i + 1] ?? workspaceRoot);
                i += 1;
                break;
            case "--store":
                dbPath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--command":
                command = argv[i + 1];
                i += 1;
                break;
            case "--agent":
                agent = argv[i + 1];
                i += 1;
                break;
            case "--group-by":
                groupBy = normalizeGroupBy(argv[i + 1]);
                i += 1;
                break;
            case "--since":
                since = parseSince(argv[i + 1]);
                i += 1;
                break;
            case "--workspace-filter":
            case "--workspace-filtered":
            case "--workspace-name":
            case "--workspace-name-filter":
            case "--workspace-id":
            case "--workspace-target":
            case "--workspace-select":
            case "--workspace-scope":
            case "--workspace-sel":
            case "--workspace-filtered-name":
                workspace = argv[i + 1];
                i += 1;
                break;
            case "--workspace":
                workspace = argv[i + 1];
                i += 1;
                break;
            case "--json":
                json = true;
                break;
            case "--out":
                outputPath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--limit":
                limit = Number(argv[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--no-entries":
                includeEntries = false;
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
    return { workspaceRoot, dbPath, command, agent, workspace, json, outputPath, overwrite, limit, groupBy, since, includeEntries };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const formatSummaryTable = (groupBy, summary) => {
    if (!summary || groupBy.length === 0) {
        return "(grouping disabled)";
    }
    if (summary.rows.length === 0) {
        return "| Group | Calls | Prompt | Completion | Total | Cost |\n| --- | --- | --- | --- | --- | --- |\n| (none) | 0 | 0 | 0 | 0 | - |";
    }
    const header = [...groupBy.map((g) => g.toUpperCase()), "CALLS", "TOKENS_IN", "TOKENS_OUT", "TOTAL", "COST"];
    const lines = summary.rows.map((row) => {
        const dims = groupBy.map((g) => row.group[g] ?? "-");
        const cost = row.costEstimate === null ? "-" : row.costEstimate.toFixed(4);
        return `| ${[...dims, row.calls, row.promptTokens, row.completionTokens, row.totalTokens, cost].join(" | ")} |`;
    });
    return [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...lines,
        `| ${groupBy.map(() => "TOTAL").join(" | ")} | ${summary.totals.calls} | ${summary.totals.promptTokens} | ${summary.totals.completionTokens} | ${summary.totals.totalTokens} | ${summary.totals.costEstimate === null ? "-" : summary.totals.costEstimate.toFixed(4)} |`,
    ].join("\n");
};
const formatEntriesTable = (entries) => {
    if (entries.length === 0) {
        return [
            "| Recorded | Workspace | Command | Agent | Model | Operation | Action | Prompt | Completion | Total | Task | Job | CmdRun | TaskRun |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            "| (none) | - | - | - | - | - | - | 0 | 0 | 0 | - | - | - | - |",
        ].join("\n");
    }
    const lines = entries.map((e) => {
        const total = e.promptTokens + e.completionTokens;
        return `| ${e.recordedAt} | ${e.workspace ?? "-"} | ${e.command ?? "-"} | ${e.agent ?? "-"} | ${e.model ?? "-"} | ${e.operationId ?? "-"} | ${e.action ?? "-"} | ${e.promptTokens} | ${e.completionTokens} | ${total} | ${e.taskId ?? "-"} | ${e.jobId ?? "-"} | ${e.commandRunId ?? "-"} | ${e.taskRunId ?? "-"} |`;
    });
    return [
        "| Recorded | Workspace | Command | Agent | Model | Operation | Action | Prompt | Completion | Total | Task | Job | CmdRun | TaskRun |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...lines,
    ].join("\n");
};
const writeOutputIfRequested = async (outputPath, content, overwrite) => {
    if (!outputPath)
        return;
    if (!overwrite) {
        try {
            await fs.access(outputPath);
            throw new Error(`Output already exists: ${outputPath}. Re-run with --overwrite to replace it.`);
        }
        catch {
            // ok
        }
    }
    await ensureDir(outputPath);
    await fs.writeFile(outputPath, content, "utf8");
};
const aggregateEntries = (entries, groupBy) => {
    if (groupBy.length === 0)
        return null;
    const buckets = new Map();
    let totalsCost = null;
    for (const entry of entries) {
        const group = {};
        for (const field of groupBy) {
            if (field === "operation") {
                group[field] = entry.operationId ?? "-";
            }
            else if (field === "day") {
                group[field] = entry.recordedAt?.slice(0, 10) ?? "-";
            }
            else {
                group[field] = entry[field] ?? "-";
            }
        }
        const key = groupBy.map((f) => group[f] ?? "-").join("::");
        const existing = buckets.get(key) ?? {
            group,
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costEstimate: null,
        };
        existing.calls += 1;
        existing.promptTokens += entry.promptTokens ?? 0;
        existing.completionTokens += entry.completionTokens ?? 0;
        existing.totalTokens += (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
        if (typeof entry.costEstimate === "number") {
            existing.costEstimate = (existing.costEstimate ?? 0) + entry.costEstimate;
            totalsCost = (totalsCost ?? 0) + entry.costEstimate;
        }
        buckets.set(key, existing);
    }
    const rows = Array.from(buckets.values());
    const totals = rows.reduce((acc, row) => {
        acc.calls += row.calls;
        acc.promptTokens += row.promptTokens;
        acc.completionTokens += row.completionTokens;
        acc.totalTokens += row.totalTokens;
        return acc;
    }, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    return {
        rows,
        totals: { ...totals, costEstimate: totalsCost },
    };
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await createWorkspaceService({ workspaceRoot: options.workspaceRoot, dbPath: options.dbPath });
    const entries = store.listTokenUsage({
        command: options.command,
        agent: options.agent,
        workspace: options.workspace,
        limit: options.limit,
    });
    const filteredEntries = options.since
        ? entries.filter((entry) => {
            if (!entry.recordedAt)
                return false;
            const timestamp = new Date(entry.recordedAt).getTime();
            return !Number.isNaN(timestamp) && timestamp >= options.since.getTime();
        })
        : entries;
    const summary = aggregateEntries(filteredEntries, options.groupBy);
    const storePath = options.dbPath ?? path.join(options.workspaceRoot, ".mcoda", "mcoda.db");
    if (options.json) {
        const payload = {
            store: storePath,
            filters: { command: options.command ?? null, agent: options.agent ?? null, workspace: options.workspace ?? null },
            groupBy: options.groupBy,
            since: options.since?.toISOString() ?? null,
            count: filteredEntries.length,
            summary,
            entries: options.includeEntries ? filteredEntries : [],
        };
        const json = JSON.stringify(payload, null, 2);
        // eslint-disable-next-line no-console
        console.log(json);
        if (options.outputPath) {
            await writeOutputIfRequested(options.outputPath, json, options.overwrite);
            // eslint-disable-next-line no-console
            console.log(`Output written to ${options.outputPath}`);
        }
        return;
    }
    const summaryTable = formatSummaryTable(options.groupBy, summary);
    const entryTable = options.includeEntries ? formatEntriesTable(filteredEntries) : undefined;
    const text = [
        "# Token usage",
        "",
        `Store: ${storePath}`,
        `Filters: command=${options.command ?? "(none)"}, agent=${options.agent ?? "(none)"}, workspace=${options.workspace ?? "(none)"}`,
        `Group by: ${options.groupBy.length ? options.groupBy.join(",") : "none"}`,
        `Since: ${options.since?.toISOString() ?? "(not set)"}`,
        `Entries: ${filteredEntries.length}${options.limit ? ` (limit ${options.limit})` : ""}`,
        "",
        "## Summary",
        summaryTable,
        "",
        options.includeEntries ? "## Entries" : "",
        options.includeEntries ? entryTable ?? "" : "",
        "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(text);
    if (options.outputPath) {
        await writeOutputIfRequested(options.outputPath, text, options.overwrite);
        // eslint-disable-next-line no-console
        console.log(`Output written to ${options.outputPath}`);
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
