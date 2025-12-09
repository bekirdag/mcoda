#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda telemetry [--store .mcoda/telemetry.json] [--command work-on-tasks] [--agent primary] [--json] [--out <file>] [--overwrite]",
    "",
    "Summarizes token usage by command/agent (prototype helper).",
].join("\n");
const defaultStorePath = () => path.join(process.cwd(), ".mcoda", "telemetry.json");
const parseArgs = (argv) => {
    let storePath = defaultStorePath();
    let commandFilter;
    let agentFilter;
    let json = false;
    let outputPath;
    let overwrite = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--store":
                storePath = path.resolve(argv[i + 1] ?? storePath);
                i += 1;
                break;
            case "--command":
                commandFilter = argv[i + 1];
                i += 1;
                break;
            case "--agent":
                agentFilter = argv[i + 1];
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
    return { storePath, commandFilter, agentFilter, json, outputPath, overwrite };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const readStore = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        parsed.entries = parsed.entries ?? [];
        return parsed;
    }
    catch {
        const now = new Date().toISOString();
        return {
            updatedAt: now,
            entries: [
                { timestamp: now, command: "work-on-tasks", agent: "primary", promptTokens: 1200, completionTokens: 800 },
                { timestamp: now, command: "code-review", agent: "reviewer", promptTokens: 900, completionTokens: 300 },
            ],
        };
    }
};
const filterEntries = (entries, command, agent) => {
    return entries.filter((e) => {
        if (command && e.command !== command)
            return false;
        if (agent && e.agent !== agent)
            return false;
        return true;
    });
};
const aggregate = (entries) => {
    const byKey = new Map();
    for (const entry of entries) {
        const key = `${entry.command}::${entry.agent}`;
        const bucket = byKey.get(key) ?? { command: entry.command, agent: entry.agent, calls: 0, prompt: 0, completion: 0 };
        bucket.calls += 1;
        bucket.prompt += entry.promptTokens;
        bucket.completion += entry.completionTokens;
        byKey.set(key, bucket);
    }
    const rows = Array.from(byKey.values());
    const totals = rows.reduce((acc, row) => {
        acc.calls += row.calls;
        acc.prompt += row.prompt;
        acc.completion += row.completion;
        return acc;
    }, { calls: 0, prompt: 0, completion: 0 });
    return { rows, totals };
};
const formatTable = (rows) => {
    if (rows.length === 0) {
        return "| Command | Agent | Calls | Prompt | Completion | Total |\n| --- | --- | --- | --- | --- | --- |\n| (none) | - | 0 | 0 | 0 | 0 |";
    }
    const lines = rows.map((row) => {
        const total = row.prompt + row.completion;
        return `| ${row.command} | ${row.agent} | ${row.calls} | ${row.prompt} | ${row.completion} | ${total} |`;
    });
    return ["| Command | Agent | Calls | Prompt | Completion | Total |", "| --- | --- | --- | --- | --- | --- |", ...lines].join("\n");
};
const fence = (content, info = "json") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildTextOutput = (storePath, filters, agg) => {
    const table = formatTable(agg.rows);
    return [
        "# Telemetry summary",
        "",
        `Store: ${storePath}`,
        `Filters: command=${filters.command ?? "(none)"}, agent=${filters.agent ?? "(none)"}`,
        `Totals: calls=${agg.totals.calls}, prompt=${agg.totals.prompt}, completion=${agg.totals.completion}, total=${agg.totals.prompt + agg.totals.completion}`,
        "",
        "## Breakdown",
        table,
        "",
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
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await readStore(options.storePath);
    const filtered = filterEntries(store.entries, options.commandFilter, options.agentFilter);
    const agg = aggregate(filtered);
    if (options.json) {
        const payload = {
            store: options.storePath,
            filters: { command: options.commandFilter ?? null, agent: options.agentFilter ?? null },
            totals: {
                calls: agg.totals.calls,
                promptTokens: agg.totals.prompt,
                completionTokens: agg.totals.completion,
                totalTokens: agg.totals.prompt + agg.totals.completion,
            },
            rows: agg.rows.map((row) => ({
                command: row.command,
                agent: row.agent,
                calls: row.calls,
                promptTokens: row.prompt,
                completionTokens: row.completion,
                totalTokens: row.prompt + row.completion,
            })),
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
    const text = buildTextOutput(options.storePath, { command: options.commandFilter, agent: options.agentFilter }, agg);
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
