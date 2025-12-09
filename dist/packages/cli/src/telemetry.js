#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda telemetry <show|opt-in|opt-out> [--workspace-root <path>] [--store .mcoda/telemetry.json] [--since 7d] [--json] [--out <file>] [--overwrite]",
    "",
    "Shows telemetry status and aggregates, or toggles remote export opt-in/opt-out.",
].join("\n");
const defaultStorePath = () => path.join(process.cwd(), ".mcoda", "telemetry.json");
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
const parseArgs = (argv) => {
    let mode = "show";
    let workspaceRoot = process.cwd();
    let dbPath;
    let storePath = defaultStorePath();
    let json = false;
    let outputPath;
    let overwrite = false;
    let since;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("-") && ["show", "opt-in", "opt-out"].includes(arg)) {
            mode = arg;
            continue;
        }
        switch (arg) {
            case "--workspace-root":
            case "--root":
                workspaceRoot = path.resolve(argv[i + 1] ?? workspaceRoot);
                i += 1;
                break;
            case "--store":
                storePath = path.resolve(argv[i + 1] ?? storePath);
                i += 1;
                break;
            case "--db":
            case "--store-db":
                dbPath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--since":
                since = parseSince(argv[i + 1]);
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
    return { mode, workspaceRoot, dbPath, storePath, json, outputPath, overwrite, since };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const readPrefs = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            status: parsed.status === "opt_out" ? "opt_out" : "opt_in",
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        };
    }
    catch {
        const now = new Date().toISOString();
        return { status: "opt_in", updatedAt: now };
    }
};
const writePrefs = async (storePath, status) => {
    const prefs = { status, updatedAt: new Date().toISOString() };
    await ensureDir(storePath);
    await fs.writeFile(storePath, JSON.stringify(prefs, null, 2), "utf8");
    return prefs;
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
const aggregateUsage = (entries) => {
    const totals = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const buckets = new Map();
    for (const entry of entries) {
        const key = `${entry.command ?? "-"}::${entry.agent ?? "-"}`;
        const row = buckets.get(key) ?? {
            command: entry.command ?? "-",
            agent: entry.agent ?? "-",
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        };
        row.calls += 1;
        row.promptTokens += entry.promptTokens ?? 0;
        row.completionTokens += entry.completionTokens ?? 0;
        row.totalTokens += (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
        totals.calls += 1;
        totals.promptTokens += entry.promptTokens ?? 0;
        totals.completionTokens += entry.completionTokens ?? 0;
        totals.totalTokens += (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
        buckets.set(key, row);
    }
    return { totals, breakdown: Array.from(buckets.values()) };
};
const formatBreakdownTable = (rows) => {
    if (rows.length === 0) {
        return "| Command | Agent | Calls | Prompt | Completion | Total |\n| --- | --- | --- | --- | --- | --- |\n| (none) | - | 0 | 0 | 0 | 0 |";
    }
    const lines = rows.map((row) => `| ${row.command ?? "-"} | ${row.agent ?? "-"} | ${row.calls} | ${row.promptTokens} | ${row.completionTokens} | ${row.totalTokens} |`);
    return [
        "| Command | Agent | Calls | Prompt | Completion | Total |",
        "| --- | --- | --- | --- | --- | --- |",
        ...lines,
    ].join("\n");
};
const showStatus = async (options) => {
    const prefs = await readPrefs(options.storePath);
    const storePath = options.dbPath ?? path.join(options.workspaceRoot, ".mcoda", "mcoda.db");
    let entries = [];
    let warning;
    try {
        const store = await createWorkspaceService({ workspaceRoot: options.workspaceRoot, dbPath: options.dbPath });
        const raw = store.listTokenUsage({});
        entries = options.since
            ? raw.filter((entry) => {
                if (!entry.recordedAt)
                    return false;
                const ts = new Date(entry.recordedAt).getTime();
                return !Number.isNaN(ts) && ts >= options.since.getTime();
            })
            : raw;
    }
    catch (error) {
        warning = error instanceof Error ? error.message : String(error);
    }
    const aggregate = aggregateUsage(entries);
    if (options.json) {
        const payload = {
            store: storePath,
            prefs,
            since: options.since?.toISOString() ?? null,
            totals: aggregate.totals,
            breakdown: aggregate.breakdown,
            warning: warning ?? null,
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
    const text = [
        "# Telemetry status",
        "",
        `Store: ${storePath}`,
        `Pref: status=${prefs.status} (updated ${prefs.updatedAt})`,
        `Since: ${options.since?.toISOString() ?? "(not set)"}`,
        "Note: opt-out disables remote export; local token_usage rows remain unless disabled in strict configs.",
        warning ? `Warning: ${warning}` : "",
        "",
        "## Totals",
        `Calls=${aggregate.totals.calls}, prompt=${aggregate.totals.promptTokens}, completion=${aggregate.totals.completionTokens}, total=${aggregate.totals.totalTokens}`,
        "",
        "## Breakdown (command, agent)",
        formatBreakdownTable(aggregate.breakdown),
        "",
    ]
        .filter(Boolean)
        .join("\n");
    // eslint-disable-next-line no-console
    console.log(text);
    if (options.outputPath) {
        await writeOutputIfRequested(options.outputPath, text, options.overwrite);
        // eslint-disable-next-line no-console
        console.log(`Output written to ${options.outputPath}`);
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === "opt-in" || options.mode === "opt-out") {
        const prefs = await writePrefs(options.storePath, options.mode === "opt-out" ? "opt_out" : "opt_in");
        const message = `Telemetry ${prefs.status === "opt_out" ? "opted out" : "opted in"} (${prefs.updatedAt})`;
        if (options.json) {
            const payload = { store: options.storePath, prefs };
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(payload, null, 2));
        }
        else {
            // eslint-disable-next-line no-console
            console.log(message);
        }
        return;
    }
    await showStatus(options);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
