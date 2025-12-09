#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createAgentService, createWorkspaceService } from "@mcoda/core/services.js";
import { invokeAgent } from "@mcoda/core/agent-invoke.js";
import { estimateTokens } from "@mcoda/core/token-math.js";
const usage = [
    "mcoda test-agent --name <agent> [--prompt \"What is 2+2?\"] [--doc path/to/spec.md] [--store ~/.mcoda/mcoda.db] [--out .mcoda/test-agent/test-<agent>.md] [--overwrite]",
    "",
    "Resolves an agent from the global SQLite registry (~/.mcoda/mcoda.db), assembles a redacted prompt (docdex boundary enforcement), and runs a simulated health probe via the central agent pipeline.",
].join("\n");
const deriveDefaultOutputPath = (agentName) => {
    return path.join(process.cwd(), ".mcoda", "test-agent", `test-${agentName}.md`);
};
const parseArgs = (argv) => {
    let name;
    let prompt = "What is 2+2?";
    let storePath;
    let outputPath;
    let overwrite = false;
    let workspaceRoot = process.cwd();
    const docPaths = [];
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
            case "--doc":
            case "-d":
                docPaths.push(argv[i + 1]);
                i += 1;
                break;
            case "--store":
                storePath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--out":
                outputPath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--workspace":
                workspaceRoot = path.resolve(argv[i + 1] ?? workspaceRoot);
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
    if (!name) {
        throw new Error("Missing required --name <agent>");
    }
    return {
        name,
        prompt,
        storePath,
        outputPath: outputPath ?? deriveDefaultOutputPath(name),
        overwrite,
        workspaceRoot,
        docPaths,
    };
};
const fence = (content, info = "text") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const ensureDir = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const buildOutput = (opts, agent, invocation) => {
    const now = new Date().toISOString();
    const name = agent.name ?? "unknown";
    const provider = agent.provider ?? "unknown";
    const model = agent.model ?? "unknown";
    const isDefault = Boolean(agent.default);
    const authOptional = ["codex", "gemini"].includes(provider.toLowerCase());
    const hasAuth = Boolean(agent.hasAuth || authOptional);
    return [
        `# Test agent result (${name})`,
        "",
        `- Store: ${opts.storePath ?? "~/.mcoda/mcoda.db"}`,
        `- Provider: ${provider}`,
        `- Model: ${model}`,
        `- Default: ${isDefault ? "yes" : "no"}`,
        agent.hasAuth ? "- Auth: stored (encrypted)" : authOptional ? "- Auth: (not required for local client)" : "- Auth: (none)",
        `- Status: ${hasAuth ? "ok" : "warning (no auth)"}`,
        `- Latency (simulated): ${invocation.latencyMs} ms`,
        `- Doc segments: ${invocation.docSegmentsCount}`,
        `- Generated: ${now}`,
        "",
        "## Prompt (redacted for logs)",
        fence(invocation.redactedPrompt, "text"),
        "",
        "## Response (redacted)",
        fence(invocation.redactedResponse ?? "(no response)", "text"),
        "",
        "## Explain",
        "- Resolves agent from global registry (SQLite, encrypted secrets).",
        "- Central prompt assembly applies SDS 4.3 redaction, docdex boundary enforcement, and uses simulated invoke. Replace with real adapter call when wired.",
        "",
    ]
        .filter(Boolean)
        .join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const agentRegistry = await createAgentService({ dbPath: options.storePath });
    const workspaceStore = await createWorkspaceService({ workspaceRoot: options.workspaceRoot });
    const agent = agentRegistry.getAgent(options.name);
    if (!agent) {
        throw new Error(`Agent ${options.name} not found in ${options.storePath ?? "~/.mcoda/mcoda.db"}`);
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
    const invocation = await invokeAgent({
        agent,
        command: "test-agent",
        userPrompt: options.prompt,
        workspaceRoot: options.workspaceRoot,
        docPaths: options.docPaths,
    });
    const output = buildOutput(options, agent, invocation);
    await ensureDir(options.outputPath);
    await fs.writeFile(options.outputPath, output, "utf8");
    const now = new Date().toISOString();
    const commandStatus = agent.hasAuth || ["codex", "gemini"].includes((agent.provider ?? "").toLowerCase()) ? "completed" : "failed";
    const commandRunId = workspaceStore.recordCommandRun({
        command: "test-agent",
        status: commandStatus,
        workspace: options.workspaceRoot,
        updatedAt: now,
    });
    workspaceStore.recordTokenUsage({
        command: "test-agent",
        agent: options.name,
        model: agent.model,
        operationId: "agents.test",
        action: "probe",
        commandRunId,
        promptTokens: estimateTokens(invocation.redactedPrompt),
        completionTokens: estimateTokens(invocation.redactedResponse),
        workspace: options.workspaceRoot,
        recordedAt: now,
    });
    agentRegistry.recordHealth({
        agent: options.name,
        status: commandStatus === "completed" ? "healthy" : "degraded",
        latencyMs: invocation.latencyMs,
        detailsJson: commandStatus === "completed" ? undefined : "missing auth token",
        checkedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Test agent result written to ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
