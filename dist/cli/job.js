#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda job <list|status|watch|resume> [--id JOB_ID] [--store .mcoda/jobs.json] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out <file>] [--overwrite] [--interval 2000] [--iterations 10]",
    "",
    "Prototype job helper for inspecting long-running commands.",
].join("\n");
const defaultStorePath = () => path.join(process.cwd(), ".mcoda", "jobs.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    const args = [...argv];
    let subcommand;
    let jobId;
    let storePath = defaultStorePath();
    let outputPath;
    let overwrite = false;
    let intervalMs = 2000;
    let maxIterations = null;
    let workspace;
    let tokenUsagePath;
    let commandRunPath;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith("--") && !subcommand) {
            subcommand = arg;
            continue;
        }
        switch (arg) {
            case "--id":
                jobId = args[i + 1];
                i += 1;
                break;
            case "--store":
                storePath = path.resolve(args[i + 1] ?? storePath);
                i += 1;
                break;
            case "--out":
                outputPath = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--interval":
                intervalMs = Number(args[i + 1] ?? intervalMs);
                i += 1;
                break;
            case "--iterations":
                maxIterations = Number(args[i + 1] ?? "0") || null;
                i += 1;
                break;
            case "--workspace":
                workspace = args[i + 1];
                i += 1;
                break;
            case "--token-usage":
                tokenUsagePath = args[i + 1];
                i += 1;
                break;
            case "--runs":
                commandRunPath = args[i + 1];
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
    if (!subcommand || !["list", "status", "watch", "resume"].includes(subcommand)) {
        throw new Error(`Command must be one of list|status|watch|resume\n\n${usage}`);
    }
    if (["status", "watch", "resume"].includes(subcommand) && !jobId) {
        throw new Error(`${subcommand} requires --id JOB_ID`);
    }
    return {
        subcommand,
        jobId,
        storePath,
        outputPath,
        overwrite,
        intervalMs,
        maxIterations,
        workspace,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
    };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const readStore = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        parsed.jobs = parsed.jobs ?? [];
        return parsed;
    }
    catch {
        const now = new Date().toISOString();
        return {
            updatedAt: now,
            jobs: [
                { id: "job-1", command: "work-on-tasks", status: "running", createdAt: now, updatedAt: now, notes: "Stub running job" },
                { id: "job-2", command: "code-review", status: "succeeded", createdAt: now, updatedAt: now, notes: "Stub completed job" },
            ],
        };
    }
};
const formatTable = (jobs) => {
    if (jobs.length === 0) {
        return "| ID | Command | Status | Updated | Notes |\n| --- | --- | --- | --- | --- |\n| (none) | - | - | - | - |";
    }
    const lines = jobs.map((job) => {
        const safeNotes = (job.notes ?? "").replace(/\|/g, "\\|");
        return `| ${job.id} | ${job.command} | ${job.status} | ${job.updatedAt} | ${safeNotes} |`;
    });
    return ["| ID | Command | Status | Updated | Notes |", "| --- | --- | --- | --- | --- |", ...lines].join("\n");
};
const fence = (content, info = "json") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildListOutput = (storePath, store) => {
    return [
        "# Jobs",
        "",
        `Store: ${storePath}`,
        `Updated: ${store.updatedAt}`,
        "",
        "## List",
        formatTable(store.jobs),
        "",
    ].join("\n");
};
const buildStatusOutput = (storePath, job) => {
    return [
        `# Job status (${job.id})`,
        "",
        `Store: ${storePath}`,
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| ID | ${job.id} |`,
        `| Command | ${job.command} |`,
        `| Status | ${job.status} |`,
        `| Created | ${job.createdAt} |`,
        `| Updated | ${job.updatedAt} |`,
        `| Workspace | ${job.workspace ?? "-"} |`,
        `| Notes | ${(job.notes ?? "").replace(/\|/g, "\\|")} |`,
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appendJsonArray = async (filePath, record) => {
    try {
        await ensureDir(filePath);
        let existing = [];
        try {
            const raw = await fs.readFile(filePath, "utf8");
            existing = JSON.parse(raw);
        }
        catch {
            existing = [];
        }
        existing.push(record);
        await fs.writeFile(filePath, JSON.stringify(existing, null, 2), "utf8");
    }
    catch {
        // best-effort
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await readStore(options.storePath);
    const printAndMaybeWrite = async (content) => {
        // eslint-disable-next-line no-console
        console.log(content);
        if (options.outputPath) {
            await writeOutputIfRequested(options.outputPath, content, options.overwrite);
            // eslint-disable-next-line no-console
            console.log(`Output written to ${options.outputPath}`);
        }
    };
    switch (options.subcommand) {
        case "list": {
            const output = buildListOutput(options.storePath, store);
            await printAndMaybeWrite(output);
            const now = new Date().toISOString();
            await appendJsonArray(options.commandRunPath, {
                command: "job:list",
                workspace: options.workspace ?? "(unspecified)",
                status: "succeeded",
                updatedAt: now,
            });
            await appendJsonArray(options.tokenUsagePath, {
                command: "job:list",
                workspace: options.workspace ?? "(unspecified)",
                promptTokens: 0,
                completionTokens: 0,
                recordedAt: now,
            });
            break;
        }
        case "status": {
            const job = store.jobs.find((j) => j.id === options.jobId);
            if (!job)
                throw new Error(`Job ${options.jobId} not found`);
            const output = buildStatusOutput(options.storePath, job);
            await printAndMaybeWrite(output);
            const now = new Date().toISOString();
            await appendJsonArray(options.commandRunPath, {
                command: "job:status",
                workspace: options.workspace ?? "(unspecified)",
                jobId: options.jobId,
                status: "succeeded",
                updatedAt: now,
            });
            await appendJsonArray(options.tokenUsagePath, {
                command: "job:status",
                workspace: options.workspace ?? "(unspecified)",
                jobId: options.jobId,
                promptTokens: 0,
                completionTokens: 0,
                recordedAt: now,
            });
            break;
        }
        case "watch": {
            if (!options.jobId)
                throw new Error("watch requires --id JOB_ID");
            let iterations = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                iterations += 1;
                const refreshed = await readStore(options.storePath);
                const job = refreshed.jobs.find((j) => j.id === options.jobId);
                if (!job)
                    throw new Error(`Job ${options.jobId} not found`);
                const output = buildStatusOutput(options.storePath, job);
                // eslint-disable-next-line no-console
                console.log(output);
                if (options.outputPath) {
                    await writeOutputIfRequested(options.outputPath, output, true);
                }
                if (job.status === "succeeded" || job.status === "failed") {
                    const now = new Date().toISOString();
                    await appendJsonArray(options.commandRunPath, {
                        command: "job:watch",
                        workspace: options.workspace ?? "(unspecified)",
                        jobId: options.jobId,
                        status: job.status,
                        updatedAt: now,
                    });
                    await appendJsonArray(options.tokenUsagePath, {
                        command: "job:watch",
                        workspace: options.workspace ?? "(unspecified)",
                        jobId: options.jobId,
                        promptTokens: 0,
                        completionTokens: 0,
                        recordedAt: now,
                    });
                    break;
                }
                if (options.maxIterations && iterations >= options.maxIterations) {
                    break;
                }
                await sleep(options.intervalMs);
            }
            break;
        }
        case "resume": {
            const job = store.jobs.find((j) => j.id === options.jobId);
            if (!job)
                throw new Error(`Job ${options.jobId} not found`);
            const now = new Date().toISOString();
            const updated = { ...job, status: "running", updatedAt: now, notes: `${job.notes ?? ""} | resumed` };
            const nextStore = {
                ...store,
                updatedAt: now,
                jobs: store.jobs.map((j) => (j.id === job.id ? updated : j)),
            };
            await ensureDir(options.storePath);
            await fs.writeFile(options.storePath, JSON.stringify(nextStore, null, 2), "utf8");
            const output = buildStatusOutput(options.storePath, updated);
            await printAndMaybeWrite(output);
            const now = new Date().toISOString();
            await appendJsonArray(options.commandRunPath, {
                command: "job:resume",
                workspace: options.workspace ?? "(unspecified)",
                jobId: options.jobId,
                status: "running",
                updatedAt: now,
            });
            await appendJsonArray(options.tokenUsagePath, {
                command: "job:resume",
                workspace: options.workspace ?? "(unspecified)",
                jobId: options.jobId,
                promptTokens: 0,
                completionTokens: 0,
                recordedAt: now,
            });
            break;
        }
        default:
            throw new Error(`Unknown subcommand: ${options.subcommand}`);
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
