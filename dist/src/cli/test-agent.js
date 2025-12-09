#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
const usage = [
    "mcoda test-agent --name <agent> [--prompt \"What is 2+2?\"] [--store ~/.mcoda/agents.json] [--token-usage <path>] [--runs <path>] [--out .mcoda/test-agent/test-<agent>.md] [--overwrite]",
    "",
    "Resolves an agent from the prototype registry and runs a trivial health probe (simulated).",
].join("\n");
const defaultStorePath = () => path.join(os.homedir(), ".mcoda", "agents.json");
const defaultTokenUsagePath = () => path.join(os.homedir(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(os.homedir(), ".mcoda", "command_runs.json");
const deriveDefaultOutputPath = (agentName) => {
    return path.join(process.cwd(), ".mcoda", "test-agent", `test-${agentName}.md`);
};
const parseArgs = (argv) => {
    let name;
    let prompt = "What is 2+2?";
    let storePath = defaultStorePath();
    let outputPath;
    let overwrite = false;
    let tokenUsagePath;
    let commandRunPath;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--name":
                name = argv[i + 1];
                i += 1;
                break;
            case "--prompt":
                prompt = argv[i + 1] ?? prompt;
                i += 1;
                break;
            case "--store":
                storePath = path.resolve(argv[i + 1] ?? storePath);
                i += 1;
                break;
            case "--token-usage":
                tokenUsagePath = argv[i + 1];
                i += 1;
                break;
            case "--runs":
                commandRunPath = argv[i + 1];
                i += 1;
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
    if (!name) {
        throw new Error("Missing required --name <agent>");
    }
    return {
        name,
        prompt,
        storePath,
        outputPath: outputPath ?? deriveDefaultOutputPath(name),
        overwrite,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
    };
};
const ensureDir = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
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
const findAgent = (store, name) => {
    return store.agents.find((a) => a.name === name);
};
const fence = (content, info = "text") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, agent, prompt, answer) => {
    const now = new Date().toISOString();
    return [
        `# Test agent result (${agent.name})`,
        "",
        `- Store: ${opts.storePath}`,
        `- Prompt: ${prompt}`,
        `- Provider: ${agent.provider}`,
        `- Model: ${agent.model}`,
        `- Default: ${agent.default ? "yes" : "no"}`,
        agent.authToken ? `- Auth: (stored)` : "- Auth: (none)",
        agent.prompts && agent.prompts.length ? `- Prompts: ${agent.prompts.join(", ")}` : "- Prompts: (none)",
        `- Generated: ${now}`,
        "",
        "## Probe",
        fence(prompt, "text"),
        "",
        "## Simulated response",
        fence(answer, "text"),
        "",
        "## Notes",
        "- Prototype helper; real mcoda test-agent will invoke the configured agent and check adapters.",
        "",
    ].join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const store = await readStore(options.storePath);
    const agent = findAgent(store, options.name);
    if (!agent) {
        throw new Error(`Agent ${options.name} not found in ${options.storePath}`);
    }
    if (!options.overwrite) {
        try {
            await fs.access(options.outputPath);
            throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
        }
        catch {
            // continue if not exists
        }
    }
    const simulatedAnswer = "4 (simulated response)";
    const output = buildOutput(options, agent, options.prompt, simulatedAnswer);
    await ensureDir(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    await appendJsonArray(options.commandRunPath, {
        command: "test-agent",
        name: options.name,
        status: "succeeded",
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "test-agent",
        name: options.name,
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Test agent result written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
