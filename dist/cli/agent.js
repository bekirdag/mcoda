#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
const usage = [
    "mcoda agent <list|add|update|delete|set-default> [options]",
    "",
    "Examples:",
    "  mcoda agent list",
    "  mcoda agent add --name primary --provider openai --model gpt-4 --default",
    "  mcoda agent update --name primary --model gpt-4o",
    "  mcoda agent delete --name primary",
    "  mcoda agent set-default --name backup",
    "",
    "Options:",
    "  --store <path>   Override agent store path (default ~/.mcoda/agents.json)",
    "  --name <name>    Agent name (required for add/update/delete/set-default)",
    "  --provider <p>   Provider id (add/update)",
    "  --model <m>      Model id (add/update)",
    "  --default        Mark as default (add/update)",
    "  --auth <token>   Auth token/secret to store with the agent (add/update)",
    "  --prompt <path>  Prompt manifest path (repeatable) (add/update)",
    "  --token-usage <path>  Token usage log path (default ~/.mcoda/token_usage.json)",
    "  --runs <path>    Command run log path (default ~/.mcoda/command_runs.json)",
    "  -h, --help       Show help",
].join("\n");
const defaultStorePath = () => path.join(os.homedir(), ".mcoda", "agents.json");
const defaultTokenUsagePath = () => path.join(os.homedir(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(os.homedir(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    const args = [...argv];
    let command;
    let name;
    let provider;
    let model;
    let makeDefault = false;
    let storePath = defaultStorePath();
    let authToken;
    const prompts = [];
    let tokenUsagePath;
    let commandRunPath;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg.startsWith("--") && !command) {
            command = arg;
            continue;
        }
        switch (arg) {
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
            case "--store":
                storePath = path.resolve(args[i + 1] ?? storePath);
                i += 1;
                break;
            case "--auth":
                authToken = args[i + 1];
                i += 1;
                break;
            case "--prompt":
                prompts.push(args[i + 1]);
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
        prompts,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
    };
};
const ensureDir = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const readStore = async (storePath) => {
    try {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        parsed.agents = parsed.agents ?? [];
        return parsed;
    }
    catch {
        return { agents: [] };
    }
};
const writeStore = async (storePath, store) => {
    await ensureDir(storePath);
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
};
const listAgents = (store) => {
    if (store.agents.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No agents found.");
        return;
    }
    // eslint-disable-next-line no-console
    console.log("| Name | Provider | Model | Default | Updated |");
    // eslint-disable-next-line no-console
    console.log("| --- | --- | --- | --- | --- |");
    for (const agent of store.agents) {
        const def = agent.default ? "yes" : "";
        // eslint-disable-next-line no-console
        console.log(`| ${agent.name} | ${agent.provider} | ${agent.model} | ${def} | ${agent.updatedAt} |`);
    }
};
const addAgent = (store, opts) => {
    if (!opts.name || !opts.provider || !opts.model) {
        throw new Error("add requires --name, --provider, and --model");
    }
    if (store.agents.some((a) => a.name === opts.name)) {
        throw new Error(`Agent ${opts.name} already exists`);
    }
    const now = new Date().toISOString();
    const agent = {
        name: opts.name,
        provider: opts.provider,
        model: opts.model,
        default: opts.makeDefault || store.agents.length === 0,
        authToken: opts.authToken,
        prompts: opts.prompts && opts.prompts.length ? opts.prompts : undefined,
        createdAt: now,
        updatedAt: now,
    };
    const agents = opts.makeDefault
        ? store.agents.map((a) => ({ ...a, default: false })).concat(agent)
        : store.agents.concat(agent);
    return { agents };
};
const updateAgent = (store, opts) => {
    if (!opts.name)
        throw new Error("update requires --name");
    const now = new Date().toISOString();
    let found = false;
    let agents = store.agents.map((a) => {
        if (a.name !== opts.name)
            return a;
        found = true;
        return {
            ...a,
            provider: opts.provider ?? a.provider,
            model: opts.model ?? a.model,
            default: opts.makeDefault ? true : a.default,
            authToken: opts.authToken ?? a.authToken,
            prompts: opts.prompts.length ? opts.prompts : a.prompts,
            updatedAt: now,
        };
    });
    if (!found)
        throw new Error(`Agent ${opts.name} not found`);
    if (opts.makeDefault) {
        agents = agents.map((a) => ({ ...a, default: a.name === opts.name }));
    }
    return { agents };
};
const deleteAgent = (store, opts) => {
    if (!opts.name)
        throw new Error("delete requires --name");
    const agents = store.agents.filter((a) => a.name !== opts.name);
    if (agents.length === store.agents.length)
        throw new Error(`Agent ${opts.name} not found`);
    return { agents };
};
const setDefault = (store, opts) => {
    if (!opts.name)
        throw new Error("set-default requires --name");
    if (!store.agents.some((a) => a.name === opts.name))
        throw new Error(`Agent ${opts.name} not found`);
    const agents = store.agents.map((a) => ({ ...a, default: a.name === opts.name }));
    return { agents };
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
        // best-effort
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await readStore(options.storePath);
    let nextStore = store;
    switch (options.command) {
        case "list":
            listAgents(store);
            return;
        case "add":
            nextStore = addAgent(store, options);
            break;
        case "update":
            nextStore = updateAgent(store, options);
            break;
        case "delete":
            nextStore = deleteAgent(store, options);
            break;
        case "set-default":
            nextStore = setDefault(store, options);
            break;
        default:
            throw new Error(`Unknown command: ${options.command}`);
    }
    await writeStore(options.storePath, nextStore);
    // eslint-disable-next-line no-console
    console.log(`Agent ${options.command} succeeded. Store: ${options.storePath}`);
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: `agent:${options.command}`,
        name: options.name,
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: `agent:${options.command}`,
        name: options.name,
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
