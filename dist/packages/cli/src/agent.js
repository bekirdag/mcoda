#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentService, createWorkspaceService, resolveWorkspaceContext, getGlobalLayout } from "@mcoda/core/services.js";
import { registerSecret } from "@mcoda/core/redaction.js";
const usage = [
    "mcoda agent <list|add|update|delete|set-default> [options]",
    "",
    "Backed by global SQLite (~/.mcoda/mcoda.db); secrets are encrypted with the local key at ~/.mcoda/key.",
    "",
    "Examples:",
    "  mcoda agent list",
    "  mcoda agent add --name primary --provider openai --model gpt-4 --default",
    "  mcoda agent update --name primary --model gpt-4o",
    "  mcoda agent delete --name primary",
    "  mcoda agent set-default --name backup",
    "",
    "Options:",
    "  --store <path>   Override global DB path (default ~/.mcoda/mcoda.db)",
    "  --name <name>    Agent name (required for add/update/delete/set-default)",
    "  --provider <p>   Provider id (add/update)",
    "  --model <m>      Model id (add/update)",
    "  --default        Mark as default (add/update)",
    "  --auth <token>   Auth token/secret to store with the agent (add/update)",
    "  --capability <c> Capability to register (repeatable) (add/update)",
    "  --job-prompt <path> Job prompt path (add/update; default scaffolds under ~/.mcoda/agents/<name>/prompts/job.md)",
    "  --character-prompt <path> Character prompt path (add/update; default scaffolds under ~/.mcoda/agents/<name>/prompts/character.md)",
    "  --command-prompt <command:path> Command-specific prompt path (repeatable) (add/update)",
    "  --prompt <path>  Legacy prompt manifest path (repeatable) (add/update)",
    "  --workspace <path> Workspace root for run/telemetry logging (default: cwd)",
    "  -h, --help       Show help",
].join("\n");
const parseArgs = (argv) => {
    const args = [...argv];
    let command;
    let name;
    let provider;
    let model;
    let makeDefault = false;
    let storePath;
    let authToken;
    const capabilities = [];
    let jobPrompt;
    let characterPrompt;
    const commandPrompts = {};
    const legacyPrompts = [];
    let workspaceRoot = process.cwd();
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case "list":
            case "add":
            case "update":
            case "delete":
            case "set-default":
                command = arg;
                break;
            case "--list":
                command = "list";
                break;
            case "--add":
                command = "add";
                break;
            case "--update":
                command = "update";
                break;
            case "--delete":
                command = "delete";
                break;
            case "--set-default":
                command = "set-default";
                break;
            case "--name":
                name = args[i + 1];
                i += 1;
                break;
            case "--provider":
                provider = args[i + 1];
                i += 1;
                break;
            case "--model":
                model = args[i + 1];
                i += 1;
                break;
            case "--default":
                makeDefault = true;
                break;
            case "--capability":
                if (args[i + 1]) {
                    capabilities.push(args[i + 1]);
                }
                i += 1;
                break;
            case "--job-prompt":
                jobPrompt = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--character-prompt":
                characterPrompt = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--command-prompt": {
                const raw = args[i + 1];
                const [cmd, promptPath] = (raw ?? "").split(":", 2);
                if (!cmd || !promptPath) {
                    throw new Error("command-prompt requires <command:path>");
                }
                commandPrompts[cmd] = path.resolve(promptPath);
                i += 1;
                break;
            }
            case "--store":
                storePath = path.resolve(args[i + 1] ?? "");
                i += 1;
                break;
            case "--auth":
                authToken = args[i + 1];
                i += 1;
                break;
            case "--prompt":
                legacyPrompts.push(path.resolve(args[i + 1] ?? ""));
                i += 1;
                break;
            case "--workspace":
                workspaceRoot = path.resolve(args[i + 1] ?? workspaceRoot);
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
    if (!command || !["list", "add", "update", "delete", "set-default"].includes(command)) {
        throw new Error(`Command must be one of list|add|update|delete|set-default\n\n${usage}`);
    }
    return {
        command,
        name,
        provider,
        model,
        makeDefault,
        storePath,
        authToken,
        capabilities,
        jobPrompt,
        characterPrompt,
        commandPrompts,
        legacyPrompts,
        workspaceRoot,
    };
};
const isSubpath = (candidate, parent) => {
    const relative = path.relative(parent, candidate);
    if (!relative)
        return true;
    return !relative.startsWith("..") && !path.isAbsolute(relative);
};
const ensureGlobalStorePath = (storePath, workspaceRoot) => {
    if (!storePath)
        return;
    const resolvedStore = path.resolve(storePath);
    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (isSubpath(resolvedStore, resolvedWorkspace)) {
        throw new Error(`Agent registry path ${resolvedStore} is inside the workspace. Secrets must be stored in the global DB (~/.mcoda/mcoda.db) per SDS Section 20.`);
    }
};
const agentPromptsDir = (agentName, storePath) => {
    const layout = getGlobalLayout();
    const baseRoot = storePath ? path.dirname(storePath) : layout.root;
    return path.join(baseRoot, "agents", agentName, "prompts");
};
const scaffoldPrompt = async (filePath, title) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
        await access(filePath);
    }
    catch {
        const header = `# ${title}`;
        const body = `${header}\n\nDescribe the ${title.toLowerCase()} for this agent.`;
        await writeFile(filePath, body, "utf8");
    }
};
const buildPromptsInput = async (options) => {
    if (!options.name)
        return undefined;
    const commands = { ...options.commandPrompts };
    options.legacyPrompts.forEach((promptPath, idx) => {
        commands[`legacy-${idx + 1}`] = promptPath;
    });
    if (options.command === "add") {
        const promptsRoot = agentPromptsDir(options.name, options.storePath);
        const jobPath = options.jobPrompt ?? path.join(promptsRoot, "job.md");
        const characterPath = options.characterPrompt ?? path.join(promptsRoot, "character.md");
        await scaffoldPrompt(jobPath, `${options.name} job prompt`);
        await scaffoldPrompt(characterPath, `${options.name} character prompt`);
        return {
            job: jobPath,
            character: characterPath,
            commands: Object.keys(commands).length ? commands : undefined,
        };
    }
    const hasCommands = Object.keys(commands).length > 0;
    const hasPrompts = options.jobPrompt !== undefined || options.characterPrompt !== undefined || hasCommands;
    if (!hasPrompts)
        return undefined;
    if (options.jobPrompt) {
        await scaffoldPrompt(options.jobPrompt, `${options.name} job prompt`);
    }
    if (options.characterPrompt) {
        await scaffoldPrompt(options.characterPrompt, `${options.name} character prompt`);
    }
    return {
        job: options.jobPrompt,
        character: options.characterPrompt,
        commands: hasCommands ? commands : undefined,
    };
};
const listAgents = async (registry) => {
    const agents = registry.listAgents();
    if (agents.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No agents found.");
        return;
    }
    // eslint-disable-next-line no-console
    console.log("| Name | Provider | Model | Default | Has auth | Capabilities | Updated |");
    // eslint-disable-next-line no-console
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    for (const agent of agents) {
        const def = agent.default ? "yes" : "";
        const auth = agent.hasAuth ? "stored" : "";
        const caps = agent.capabilities?.length ? agent.capabilities.join(",") : "";
        // eslint-disable-next-line no-console
        console.log(`| ${agent.name} | ${agent.provider} | ${agent.model} | ${def} | ${auth} | ${caps} | ${agent.updatedAt} |`);
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const workspaceContext = await resolveWorkspaceContext({ cwd: options.workspaceRoot, explicitWorkspace: options.workspaceRoot });
    const workspaceId = workspaceContext.id;
    const workspaceRoot = workspaceContext.rootDir;
    ensureGlobalStorePath(options.storePath, workspaceRoot);
    const agentRegistry = await createAgentService({ dbPath: options.storePath });
    const workspaceStore = await createWorkspaceService({ workspaceRoot });
    const recordTelemetry = (commandRunId) => {
        const op = options.command === "list" ? "agents.list" : "agents.manage";
        const now = new Date().toISOString();
        workspaceStore.recordTokenUsage({
            command: `agent:${options.command}`,
            agent: options.name,
            operationId: op,
            commandRunId,
            promptTokens: 0,
            completionTokens: 0,
            workspace: workspaceId,
            recordedAt: now,
        });
    };
    switch (options.command) {
        case "list":
            await listAgents(agentRegistry);
            (() => {
                const recordedAt = new Date().toISOString();
                const runId = workspaceStore.recordCommandRun({ command: "agent:list", status: "completed", updatedAt: recordedAt });
                recordTelemetry(runId);
            })();
            return;
        case "add": {
            if (!options.name || !options.provider || !options.model) {
                throw new Error("add requires --name, --provider, and --model");
            }
            const prompts = await buildPromptsInput(options);
            if (options.authToken) {
                registerSecret(options.authToken, `agent.${options.name}`);
            }
            agentRegistry.addAgent({
                name: options.name,
                provider: options.provider,
                model: options.model,
                makeDefault: options.makeDefault,
                capabilities: options.capabilities,
                prompts,
                authToken: options.authToken,
            });
            // eslint-disable-next-line no-console
            console.log(`Agent ${options.name} added to ${options.storePath ?? "~/.mcoda/mcoda.db"}`);
            break;
        }
        case "update": {
            if (!options.name)
                throw new Error("update requires --name");
            const prompts = await buildPromptsInput(options);
            if (options.authToken) {
                registerSecret(options.authToken, `agent.${options.name}`);
            }
            agentRegistry.updateAgent({
                name: options.name,
                provider: options.provider,
                model: options.model,
                makeDefault: options.makeDefault,
                capabilities: options.capabilities.length ? options.capabilities : undefined,
                prompts,
                authToken: options.authToken,
            });
            // eslint-disable-next-line no-console
            console.log(`Agent ${options.name} updated.`);
            break;
        }
        case "delete": {
            if (!options.name)
                throw new Error("delete requires --name");
            agentRegistry.deleteAgent(options.name);
            // eslint-disable-next-line no-console
            console.log(`Agent ${options.name} deleted.`);
            break;
        }
        case "set-default": {
            if (!options.name)
                throw new Error("set-default requires --name");
            agentRegistry.setDefault(options.name);
            // eslint-disable-next-line no-console
            console.log(`Agent ${options.name} set as default.`);
            break;
        }
        default:
            throw new Error(`Unknown command: ${options.command}`);
    }
    const completedAt = new Date().toISOString();
    const commandRunId = workspaceStore.recordCommandRun({
        command: `agent:${options.command}`,
        status: "completed",
        workspace: workspaceId,
        updatedAt: completedAt,
    });
    recordTelemetry(commandRunId);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
