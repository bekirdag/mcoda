#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda tokens [--store .mcoda/token_usage.json] [--command work-on-tasks] [--agent primary] [--workspace name] [--limit 50] [--json] [--out <file>] [--overwrite]",
    "",
    "Lists token usage entries with optional filters. Prototype placeholder; real CLI should query DB/OpenAPI.",
].join("\n");
const defaultStorePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const parseArgs = (argv) => {
    let storePath = defaultStorePath();
    let command;
    let agent;
    let workspace;
    let json = false;
    let outputPath;
    let overwrite = false;
    let limit = null;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--store":
                storePath = path.resolve(argv[i + 1] ?? storePath);
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
    return { storePath, command, agent, workspace, json, outputPath, overwrite, limit };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const readStore = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
const filterEntries = (entries, filters) => {
    return entries.filter((entry) => {
        if (filters.command && entry.command !== filters.command)
            return false;
        if (filters.agent && entry.agent !== filters.agent)
            return false;
        if (filters.workspace && entry.workspace !== filters.workspace)
            return false;
        return true;
    });
};
const formatTable = (entries) => {
    if (entries.length === 0) {
        return ["| Recorded | Workspace | Command | Agent | Prompt | Completion | Total | Task | Job |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", "| (none) | - | - | - | 0 | 0 | 0 | - | - |"].join("\n");
    }
    const lines = entries.map((e) => {
        const total = e.promptTokens + e.completionTokens;
        return `| ${e.recordedAt} | ${e.workspace ?? "-"} | ${e.command ?? "-"} | ${e.agent ?? "-"} | ${e.promptTokens} | ${e.completionTokens} | ${total} | ${e.taskId ?? "-"} | ${e.jobId ?? "-"} |`;
    });
    return ["| Recorded | Workspace | Command | Agent | Prompt | Completion | Total | Task | Job |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...lines].join("\n");
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
    const entries = filterEntries(await readStore(options.storePath), {
        command: options.command,
        agent: options.agent,
        workspace: options.workspace,
    });
    const limited = options.limit && options.limit > 0 ? entries.slice(0, options.limit) : entries;
    if (options.json) {
        const payload = {
            store: options.storePath,
            filters: { command: options.command ?? null, agent: options.agent ?? null, workspace: options.workspace ?? null },
            count: limited.length,
            entries: limited,
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
    const table = formatTable(limited);
    const text = [
        "# Token usage",
        "",
        `Store: ${options.storePath}`,
        `Filters: command=${options.command ?? "(none)"}, agent=${options.agent ?? "(none)"}, workspace=${options.workspace ?? "(none)"}`,
        `Entries: ${limited.length}${options.limit ? ` (limit ${options.limit})` : ""}`,
        "",
        "## Entries",
        table,
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
