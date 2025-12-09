#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService, createAgentService, resolveWorkspaceContext, getGlobalLayout, } from "@mcoda/core/services.js";
import { mcodaCommands, mcodaOperationByCommand } from "../../../openapi/generated/types/index.js";
const GLOBAL_WORKSPACE = "__GLOBAL__";
const usage = [
    "mcoda routing <defaults|preview|explain> [--command work-on-tasks] [--store ~/.mcoda/mcoda.db] [--workspace <name>] [--out <file>] [--overwrite]",
    "",
    "Routing helper (SDS 8.5). Reads global routing rules from ~/.mcoda/mcoda.db and previews agent selection.",
].join("\n");
const canonicalCommands = new Set([...mcodaCommands]);
const defaultDbPath = () => getGlobalLayout().dbPath;
const validateCommand = (value) => {
    if (!value)
        return undefined;
    if (!canonicalCommands.has(value)) {
        throw new Error(`Unknown command: ${value}. Allowed: ${Array.from(canonicalCommands).join(", ")}`);
    }
    return value;
};
const parseArgs = (argv) => {
    const args = [...argv];
    let subcommand;
    let dbPath = defaultDbPath();
    let targetCommand;
    let outputPath;
    let overwrite = false;
    let workspace;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith("--") && !subcommand) {
            subcommand = arg;
            continue;
        }
        switch (arg) {
            case "--store":
                dbPath = path.resolve(args[i + 1] ?? dbPath);
                i += 1;
                break;
            case "--command":
                targetCommand = args[i + 1];
                i += 1;
                break;
            case "--workspace":
                workspace = args[i + 1];
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
        dbPath,
        targetCommand: validateCommand(targetCommand),
        outputPath,
        overwrite,
        workspace,
    };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const fence = (content, info = "json") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const formatRule = (r) => `- ${r.command} → ${r.agent}${r.notes ? ` (${r.notes})` : ""}`;
const formatHealth = (health) => {
    const suffix = health.reason ? ` (${health.reason})` : "";
    return `- ${health.name}: ${health.status}${suffix}`;
};
const specLinesForCommand = (command) => {
    if (!command)
        return [];
    const ops = mcodaOperationByCommand[command] ?? [];
    if (!ops.length)
        return [`- ${command}: not defined in OpenAPI.`];
    return ops.map((op) => {
        const tools = op.tools.length ? op.tools.join(", ") : "-";
        const ctx = op.requiredContext.length ? op.requiredContext.join(", ") : "-";
        const lane = op.lane ?? "-";
        return `- ${op.operationId} (${op.method} ${op.path}) lane=${lane} tools=${tools} ctx=${ctx}`;
    });
};
const summarizeCommand = (command) => {
    if (!command)
        return null;
    const op = (mcodaOperationByCommand[command] ?? [])[0];
    if (!op)
        return null;
    return {
        lane: op.lane ?? "-",
        tools: op.tools.length ? op.tools.join(", ") : "-",
        requiredContext: op.requiredContext.length ? op.requiredContext.join(", ") : "-",
        agentCapabilities: op.agentCapabilities.length ? op.agentCapabilities.join(", ") : "-",
    };
};
const healthForAgent = (name, registry) => {
    if (!name)
        return { name: "(unspecified)", status: "missing", reason: "No agent provided." };
    const found = registry.find((a) => a.name === name);
    if (!found)
        return { name, status: "missing", reason: "Agent not found in global registry." };
    if (found.health?.status === "unreachable")
        return { name, status: "unreachable", reason: "Last health check failed." };
    if (found.health?.status === "degraded")
        return { name, status: "degraded", reason: "Last health check reported degraded." };
    if (!found.hasAuth)
        return { name, status: "degraded", reason: "Agent has no stored auth (encrypted credential missing)." };
    return { name, status: "healthy" };
};
const loadRoutingView = async (opts) => {
    const agentRegistry = await createAgentService({ dbPath: opts.dbPath });
    const workspaceId = opts.workspace ?? GLOBAL_WORKSPACE;
    const agents = agentRegistry.listAgents();
    const workspaceRules = agentRegistry
        .listRoutingRules(workspaceId)
        .map((rule) => ({ command: rule.command, agent: rule.agent, notes: rule.notes }));
    const globalRules = workspaceId === GLOBAL_WORKSPACE
        ? []
        : agentRegistry.listRoutingRules(GLOBAL_WORKSPACE).map((rule) => ({ command: rule.command, agent: rule.agent, notes: rule.notes }));
    const workspaceDefault = agentRegistry.getWorkspaceDefault(workspaceId);
    const globalDefault = agentRegistry.getWorkspaceDefault(GLOBAL_WORKSPACE);
    return { workspace: workspaceId, workspaceDefault, globalDefault, workspaceRules, globalRules, agents };
};
const referencedHealth = (view) => {
    const names = new Set();
    if (view.workspaceDefault)
        names.add(view.workspaceDefault);
    if (view.globalDefault)
        names.add(view.globalDefault);
    view.workspaceRules.forEach((r) => names.add(r.agent));
    view.globalRules.forEach((r) => names.add(r.agent));
    return Array.from(names).map((name) => healthForAgent(name, view.agents));
};
const selectAgent = (view, targetCommand) => {
    if (targetCommand) {
        const workspaceRule = view.workspaceRules.find((r) => r.command === targetCommand);
        if (workspaceRule)
            return { agent: workspaceRule.agent, reason: `Matched workspace rule for ${targetCommand}`, matched: "workspace-rule" };
        const globalRule = view.globalRules.find((r) => r.command === targetCommand);
        if (globalRule)
            return { agent: globalRule.agent, reason: `Matched global rule for ${targetCommand}`, matched: "global-rule" };
    }
    if (view.workspaceDefault)
        return { agent: view.workspaceDefault, reason: "Workspace default agent", matched: "workspace-default" };
    if (view.globalDefault)
        return { agent: view.globalDefault, reason: "Global default agent", matched: "global-default" };
    const defaultAgent = view.agents.find((a) => a.default)?.name;
    if (defaultAgent)
        return { agent: defaultAgent, reason: "Agent flagged as default", matched: "agent-default" };
    return { agent: null, reason: "No routing rule or default configured", matched: "none" };
};
const buildDefaultsOutput = (view, health) => {
    return [
        "# Routing defaults",
        "",
        `Workspace: ${view.workspace}`,
        `Workspace default: ${view.workspaceDefault ?? "(none)"}`,
        `Global default: ${view.globalDefault ?? "(none)"}`,
        "",
        "## Workspace rules",
        ...(view.workspaceRules.length ? view.workspaceRules.map(formatRule) : ["- (none)"]),
        "",
        "## Global rules",
        ...(view.globalRules.length ? view.globalRules.map(formatRule) : ["- (none)"]),
        "",
        "## Agent health",
        ...(health.length ? health.map(formatHealth) : ["- (no referenced agents)"]),
        "",
        "## OpenAPI commands",
        ...(Array.from(canonicalCommands).length ? Array.from(canonicalCommands).map((cmd) => `- ${cmd}`) : ["- (none found in spec)"]),
        "",
    ]
        .filter(Boolean)
        .join("\n");
};
const buildPreviewOutput = (view, targetCommand, decision) => {
    const health = healthForAgent(decision.agent, view.agents);
    const summary = summarizeCommand(targetCommand);
    return [
        "# Routing preview",
        "",
        `Workspace: ${view.workspace}`,
        `Command: ${targetCommand ?? "(none)"}`,
        "",
        `Selected agent: ${decision.agent ?? "(none)"}`,
        `Reason: ${decision.reason}`,
        `Agent health: ${health.status}${health.reason ? ` (${health.reason})` : ""}`,
        summary ? `Lane: ${summary.lane}` : "",
        summary ? `Tools: ${summary.tools}` : "",
        summary ? `Required context: ${summary.requiredContext}` : "",
        summary ? `Agent capabilities: ${summary.agentCapabilities}` : "",
        "",
        "## Workspace rules",
        ...(view.workspaceRules.length ? view.workspaceRules.map(formatRule) : ["- (none)"]),
        "",
        "## Global rules",
        ...(view.globalRules.length ? view.globalRules.map(formatRule) : ["- (none)"]),
        "",
        "## OpenAPI metadata",
        ...(specLinesForCommand(targetCommand).length ? specLinesForCommand(targetCommand) : ["- (no command provided)"]),
        "",
    ]
        .filter(Boolean)
        .join("\n");
};
const buildExplainOutput = (view, health) => {
    const json = JSON.stringify({
        workspace: view.workspace,
        workspaceDefault: view.workspaceDefault,
        globalDefault: view.globalDefault,
        workspaceRules: view.workspaceRules,
        globalRules: view.globalRules,
    }, null, 2);
    return [
        "# Routing explain",
        "",
        `Workspace: ${view.workspace}`,
        "",
        "## Agent health",
        ...(health.length ? health.map(formatHealth) : ["- (no agents referenced)"]),
        "",
        "## Store JSON",
        fence(json, "json"),
        "",
        "## OpenAPI commands",
        ...(Array.from(canonicalCommands).length
            ? Array.from(canonicalCommands).map((cmd) => `- ${cmd}`)
            : ["- (none found in spec)"]),
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
    const workspaceContext = options.workspace === GLOBAL_WORKSPACE
        ? null
        : await resolveWorkspaceContext({ cwd: process.cwd(), explicitWorkspace: options.workspace });
    const workspaceId = workspaceContext?.id ?? GLOBAL_WORKSPACE;
    const workspaceStore = await createWorkspaceService({ workspaceRoot: workspaceContext?.rootDir });
    const view = await loadRoutingView({ ...options, workspace: workspaceId });
    const health = referencedHealth(view);
    let output;
    switch (options.command) {
        case "defaults":
            output = buildDefaultsOutput(view, health);
            break;
        case "preview": {
            const decision = selectAgent(view, options.targetCommand);
            output = buildPreviewOutput(view, options.targetCommand, decision);
            break;
        }
        case "explain":
            output = buildExplainOutput(view, health);
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
    const commandRunId = workspaceStore.recordCommandRun({
        command: `routing:${options.command}`,
        workspace: workspaceId,
        status: "completed",
        updatedAt: now,
    });
    workspaceStore.recordTokenUsage({
        command: `routing:${options.command}`,
        operationId: "routing.preview",
        action: options.command,
        workspace: workspaceId,
        commandRunId,
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
