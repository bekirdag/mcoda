#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const canonicalCommands = new Set([
    "create-tasks",
    "refine-tasks",
    "work-on-tasks",
    "code-review",
    "qa-tasks",
    "backlog",
    "estimate",
    "task-detail",
    "order-tasks",
    "agent",
    "test-agent",
    "routing",
    "tokens",
    "telemetry",
    "job",
    "update",
]);
const canonicalTaskTypes = new Set(["implementation", "review", "qa", "planning"]);
const usage = [
    "mcoda routing <defaults|preview|explain> [--command work-on-tasks] [--task-type implementation] [--store .mcoda/routing.json] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out <file>] [--overwrite]",
    "",
    "Routing helper (prototype). Shows default routing, previews agent selection for a command, or explains rules.",
].join("\n");
const defaultStorePath = () => path.join(process.cwd(), ".mcoda", "routing.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const validateCommand = (value) => {
    if (!value)
        return undefined;
    if (!canonicalCommands.has(value)) {
        throw new Error(`Unknown command: ${value}. Allowed: ${Array.from(canonicalCommands).join(", ")}`);
    }
    return value;
};
const validateTaskType = (value) => {
    if (!value)
        return undefined;
    if (!canonicalTaskTypes.has(value)) {
        throw new Error(`Unknown task type: ${value}. Allowed: ${Array.from(canonicalTaskTypes).join(", ")}`);
    }
    return value;
};
const parseArgs = (argv) => {
    const args = [...argv];
    let subcommand;
    let storePath = defaultStorePath();
    let targetCommand;
    let taskType;
    let outputPath;
    let overwrite = false;
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
            case "--store":
                storePath = path.resolve(args[i + 1] ?? storePath);
                i += 1;
                break;
            case "--command":
                targetCommand = args[i + 1];
                i += 1;
                break;
            case "--task-type":
                taskType = args[i + 1];
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
            case "--out":
                outputPath = path.resolve(args[i + 1] ?? "");
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
    if (!subcommand || !["defaults", "preview", "explain"].includes(subcommand)) {
        throw new Error(`Command must be one of defaults|preview|explain\n\n${usage}`);
    }
    return {
        command: subcommand,
        storePath,
        targetCommand: validateCommand(targetCommand),
        taskType: validateTaskType(taskType),
        outputPath,
        overwrite,
        workspace,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
    };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const normalizeStore = (raw) => {
    const commandRules = raw.commandRules ?? raw.rules ?? [];
    const taskTypeRules = raw.taskTypeRules ?? [];
    return {
        schemaVersion: raw.schemaVersion ?? 1,
        defaultAgent: raw.defaultAgent ?? "primary",
        commandRules,
        taskTypeRules,
        updatedAt: raw.updatedAt ?? new Date().toISOString(),
        workspace: raw.workspace,
    };
};
const readStore = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        return normalizeStore(parsed);
    }
    catch {
        const stub = {
            schemaVersion: 1,
            defaultAgent: "primary",
            commandRules: [
                { command: "code-review", agent: "reviewer", notes: "Route reviews to reviewer agent." },
                { command: "qa-tasks", agent: "qa", notes: "Route QA to qa agent." },
            ],
            taskTypeRules: [{ taskType: "implementation", agent: "primary", notes: "Default implementation lane." }],
            updatedAt: new Date().toISOString(),
        };
        return stub;
    }
};
const fence = (content, info = "json") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const formatCommandRule = (r) => `- ${r.command} → ${r.agent}${r.notes ? ` (${r.notes})` : ""}`;
const formatTaskTypeRule = (r) => `- ${r.taskType} → ${r.agent}${r.notes ? ` (${r.notes})` : ""}`;
const buildDefaultsOutput = (store, storePath) => {
    return [
        "# Routing defaults",
        "",
        `Store: ${storePath}`,
        `Schema version: ${store.schemaVersion ?? 1}`,
        store.workspace ? `Workspace: ${store.workspace}` : "",
        "",
        "## Defaults",
        `- Default agent: ${store.defaultAgent}`,
        "",
        "## Command rules",
        ...(store.commandRules.length ? store.commandRules.map(formatCommandRule) : ["- (none)"]),
        "",
        "## Task-type rules",
        ...(store.taskTypeRules.length ? store.taskTypeRules.map(formatTaskTypeRule) : ["- (none)"]),
        "",
    ]
        .filter(Boolean)
        .join("\n");
};
const preview = (store, targetCommand, taskType) => {
    if (targetCommand) {
        const match = store.commandRules.find((r) => r.command === targetCommand);
        if (match) {
            return { agent: match.agent, reason: `Matched command rule: ${targetCommand}`, matched: "command" };
        }
    }
    if (taskType) {
        const match = store.taskTypeRules.find((r) => r.taskType === taskType);
        if (match) {
            return { agent: match.agent, reason: `Matched task-type rule: ${taskType}`, matched: "taskType" };
        }
    }
    return { agent: store.defaultAgent, reason: "No rule matched; using default agent.", matched: "default" };
};
const buildPreviewOutput = (store, storePath, targetCommand, taskType, decision) => {
    return [
        "# Routing preview",
        "",
        `Store: ${storePath}`,
        store.workspace ? `Workspace: ${store.workspace}` : "",
        `Command: ${targetCommand ?? "(none)"}`,
        `Task type: ${taskType ?? "(none)"}`,
        "",
        `Selected agent: ${decision.agent}`,
        `Reason: ${decision.reason}`,
        "",
        "## Command rules",
        ...(store.commandRules.length ? store.commandRules.map(formatCommandRule) : ["- (none)"]),
        "",
        "## Task-type rules",
        ...(store.taskTypeRules.length ? store.taskTypeRules.map(formatTaskTypeRule) : ["- (none)"]),
        "",
    ].join("\n");
};
const buildExplainOutput = (store, storePath) => {
    const json = JSON.stringify(store, null, 2);
    return [
        "# Routing explain",
        "",
        `Store: ${storePath}`,
        "",
        "## Store JSON",
        fence(json, "json"),
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
        // best-effort; do not block the command
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await readStore(options.storePath);
    let output;
    switch (options.command) {
        case "defaults":
            output = buildDefaultsOutput(store, options.storePath);
            break;
        case "preview": {
            const decision = preview(store, options.targetCommand, options.taskType);
            output = buildPreviewOutput(store, options.storePath, options.targetCommand, options.taskType, decision);
            break;
        }
        case "explain":
            output = buildExplainOutput(store, options.storePath);
            break;
        default:
            throw new Error(`Unknown subcommand: ${options.command}`);
    }
    // eslint-disable-next-line no-console
    console.log(output);
    if (options.outputPath) {
        await writeOutputIfRequested(options.outputPath, output, options.overwrite);
        // eslint-disable-next-line no-console
        console.log(`Output written to ${options.outputPath}`);
    }
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: `routing:${options.command}`,
        workspace: options.workspace ?? "(unspecified)",
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: `routing:${options.command}`,
        workspace: options.workspace ?? "(unspecified)",
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
