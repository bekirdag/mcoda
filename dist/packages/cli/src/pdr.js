#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createAgentService, createWorkspaceService } from "@mcoda/core/services.js";
import { invokeAgent } from "@mcoda/core/agent-invoke.js";
import { estimateTokens } from "@mcoda/core/token-math.js";
import { selectAgent } from "./pdr-helpers.js";
const usage = [
    "mcoda pdr --rfp <path/to/rfp.md> [--out <path/to/pdr.md>] [--title <title>] [--project <name>] [--agent <name>] [--store <path>] [--workspace <path>] [--no-appendix] [--dry-run] [--overwrite]",
    "",
    "Defaults:",
    "  --out .mcoda/docs/pdr/pdr-<rfp-basename>.md",
    "  --project <current-directory-name>",
    "  --workspace <dir containing the RFP>",
    "If no --agent is provided, the command resolves the workspace default, global default, default agent flag, or the first agent in the registry.",
    "Requires a configured agent with provider/model/auth (e.g., openai + token).",
].join("\n");
const deriveDefaultOutputPath = (rfpPath) => {
    const base = path.basename(rfpPath, path.extname(rfpPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "docs", "pdr", `pdr-${base}.md`);
};
const parseArgs = (argv) => {
    const args = [...argv];
    let rfpPath;
    let outputPath;
    let overwrite = false;
    let project;
    let title;
    let agentName;
    let storePath;
    let workspaceRoot;
    let noAppendix = false;
    let dryRun = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case "--rfp":
            case "-i": {
                rfpPath = args[i + 1];
                i += 1;
                break;
            }
            case "--out":
            case "-o": {
                outputPath = args[i + 1];
                i += 1;
                break;
            }
            case "--project": {
                project = args[i + 1] ?? project;
                i += 1;
                break;
            }
            case "--title": {
                title = args[i + 1];
                i += 1;
                break;
            }
            case "--agent": {
                agentName = args[i + 1];
                i += 1;
                break;
            }
            case "--store": {
                storePath = args[i + 1];
                i += 1;
                break;
            }
            case "--workspace": {
                workspaceRoot = args[i + 1];
                i += 1;
                break;
            }
            case "--no-appendix": {
                noAppendix = true;
                break;
            }
            case "--dry-run": {
                dryRun = true;
                break;
            }
            case "--overwrite": {
                overwrite = true;
                break;
            }
            case "--help":
            case "-h": {
                // eslint-disable-next-line no-console
                console.log(usage);
                process.exit(0);
                break;
            }
            default:
                break;
        }
    }
    if (!rfpPath) {
        throw new Error("Missing required --rfp <path/to/rfp.md> argument");
    }
    const resolvedRfp = path.resolve(rfpPath);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot ?? path.dirname(resolvedRfp));
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedRfp));
    return {
        rfpPath: resolvedRfp,
        outputPath: resolvedOut,
        overwrite,
        project: project ?? path.basename(resolvedWorkspaceRoot),
        title: title ?? path.basename(resolvedRfp, path.extname(resolvedRfp)),
        agentName,
        storePath: storePath ? path.resolve(storePath) : undefined,
        workspaceRoot: resolvedWorkspaceRoot,
        noAppendix,
        dryRun,
    };
};
const fileExists = async (filePath) => {
    try {
        await fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
};
const extractRfpBullets = (rfpContent) => {
    return rfpContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*+]\s+/.test(line))
        .map((line) => line.replace(/^[-*+]\s+/, "").trim())
        .filter((line) => line.length > 0)
        .slice(0, 20);
};
const formatBullets = (items, placeholder) => {
    if (items.length === 0) {
        return `- ${placeholder}`;
    }
    return items.map((item) => `- ${item}`).join("\n");
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const GLOBAL_WORKSPACE = "__GLOBAL__";
const buildAgentPrompt = (opts, rfpContent) => {
    const bullets = extractRfpBullets(rfpContent);
    const condensed = bullets.length ? bullets.slice(0, 12).join("\n- ") : "(no bullets detected)";
    return [
        "# Task",
        "You are an expert product requirements author. Draft a concise, unambiguous Product Design Review (PDR) based only on the provided RFP text.",
        "Keep it actionable, avoid fluff, and structure clearly. Do not invent scope beyond the RFP.",
        "",
        "# Output format (Markdown, headings REQUIRED exactly as written)",
        "## Summary",
        "- 2–4 sentences.",
        "## Goals",
        "- Bullets, clear outcomes.",
        "## Non-Goals",
        "- Bullets, explicit exclusions.",
        "## Functional Scope",
        "- Bullets for key capabilities/flows.",
        "## Non-Functional Requirements",
        "- Bullets for performance/reliability/security/usability constraints.",
        "## Risks and Mitigations",
        "- Bullets: risk → mitigation.",
        "## Open Questions",
        "- Bullets for unresolved items.",
        "## Acceptance Criteria",
        "- Bullets, testable/checkable.",
        "",
        "# Constraints",
        "- Stay within the RFP. Prefer precision over verbosity.",
        "- Use concise bullets; avoid marketing language.",
        "- If information is missing, state the assumption briefly.",
        "",
        "# Project context",
        `- Project: ${opts.project}`,
        opts.title ? `- Working title: ${opts.title}` : "",
        `- RFP path: ${opts.rfpPath}`,
        "",
        "# RFP (verbatim)",
        rfpContent.trim(),
        "",
        bullets.length ? "# Extracted headline bullets" : "",
        bullets.length ? `- ${condensed}` : "",
    ]
        .filter(Boolean)
        .join("\n");
};
const buildFallbackContent = (opts, rfpContent) => {
    const now = new Date().toISOString();
    const rfpRel = path.relative(opts.workspaceRoot, opts.rfpPath);
    const bullets = extractRfpBullets(rfpContent);
    return [
        `# Product Design Review${opts.title ? `: ${opts.title}` : ""}`,
        "",
        `- Project: ${opts.project}`,
        `- Source RFP: ${rfpRel}`,
        `- Generated: ${now}`,
        "",
        "## Summary",
        "TODO: Summarize the product direction.",
        "",
        "## Goals",
        formatBullets(bullets, "TODO: extract goals from the RFP"),
        "",
        "## Non-Goals",
        "- TODO: clarify items explicitly out of scope.",
        "",
        "## Functional Scope",
        "- TODO: describe key capabilities and constraints.",
        "",
        "## Non-Functional Requirements",
        "- TODO: performance, reliability, security, compliance expectations.",
        "",
        "## Risks and Mitigations",
        "- TODO: note risks raised in the RFP and proposed mitigations.",
        "",
        "## Open Questions",
        "- TODO: unresolved questions for stakeholders.",
        "",
        "## Acceptance Criteria",
        "- TODO: measurable outcomes for sign-off.",
        "",
    ].join("\n");
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildOutput = (opts, agent, selectionReason, body, rfpContent) => {
    const now = new Date().toISOString();
    const rfpRel = path.relative(opts.workspaceRoot, opts.rfpPath);
    const header = [
        `# Product Design Review${opts.title ? `: ${opts.title}` : ""}`,
        "",
        `- Project: ${opts.project}`,
        `- Source RFP: ${rfpRel}`,
        `- Agent: ${agent.name ?? "unknown"} (${agent.provider ?? "unknown"}/${agent.model ?? "unknown"})`,
        `- Agent selection: ${selectionReason}`,
        `- Generated: ${now}`,
        "",
    ].join("\n");
    const appendix = opts.noAppendix
        ? ""
        : ["## Appendix A: Source RFP", fence(rfpContent, "markdown"), ""].join("\n");
    return [header, body.trim(), appendix].filter(Boolean).join("\n");
};
const requiredHeadings = [
    "summary",
    "goals",
    "non-goals",
    "functional scope",
    "non-functional requirements",
    "risks and mitigations",
    "open questions",
    "acceptance criteria",
];
const validateBody = (body) => {
    const reasons = [];
    const normalized = body.toLowerCase();
    requiredHeadings.forEach((h) => {
        if (!normalized.includes(`## ${h}`)) {
            reasons.push(`Missing heading: ${h}`);
        }
    });
    if (body.trim().length < 200) {
        reasons.push("Body too short (<200 chars)");
    }
    if (/todo/i.test(body) && body.trim().length < 400) {
        reasons.push("Contains TODO placeholders and too short");
    }
    return { ok: reasons.length === 0, reasons };
};
const selectAgentForCommand = async (registry, command, workspaceId, preferred) => {
    const agents = registry.listAgents();
    const workspaceDefault = registry.getWorkspaceDefault(workspaceId);
    const globalDefault = registry.getWorkspaceDefault(GLOBAL_WORKSPACE);
    const workspaceRule = registry.listRoutingRules(workspaceId).find((r) => r.command === command)?.agent ?? null;
    const globalRule = workspaceId === GLOBAL_WORKSPACE
        ? null
        : registry.listRoutingRules(GLOBAL_WORKSPACE).find((r) => r.command === command)?.agent ?? null;
    const { agent, reason } = selectAgent(agents, {
        preferred,
        workspaceRule,
        globalRule,
        workspaceDefault,
        globalDefault,
    });
    const withSecret = registry.getAgent(agent.name ?? "", { includeSecret: true }) ?? agent;
    return { agent: withSecret, reason };
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const rfpContent = await fs.readFile(options.rfpPath, "utf8");
    const workspaceStore = await createWorkspaceService({ workspaceRoot: options.workspaceRoot });
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    const agentRegistry = await createAgentService({ dbPath: options.storePath });
    const { agent, reason: selectionReason } = await selectAgentForCommand(agentRegistry, "pdr", options.workspaceRoot, options.agentName);
    const userPrompt = buildAgentPrompt(options, rfpContent);
    if (options.dryRun) {
        // eslint-disable-next-line no-console
        console.log(`# Dry run: PDR prompt (agent=${agent.name ?? "unknown"})\n\n${userPrompt}`);
        return;
    }
    const invocation = await invokeAgent({
        agent,
        command: "pdr",
        userPrompt,
        workspaceRoot: options.workspaceRoot,
        docPaths: [options.rfpPath],
        docdexAllowPaths: [options.rfpPath],
        docdexChunkSize: 4000,
        docdexMaxSegments: 8,
        context: { project: options.project, title: options.title ?? "PDR" },
    });
    const generatedBody = invocation.response?.trim() || "";
    const validation = validateBody(generatedBody);
    const usingFallback = !(validation.ok && generatedBody.length);
    if (usingFallback && generatedBody.length) {
        // eslint-disable-next-line no-console
        console.warn(`Generated PDR draft failed validation (${validation.reasons.join("; ")}); writing fallback stub instead. Re-run after adjusting the prompt/agent.`);
    }
    if (usingFallback && !generatedBody.length) {
        // eslint-disable-next-line no-console
        console.warn("No response received from agent; writing fallback stub instead.");
    }
    const content = usingFallback ? buildFallbackContent(options, rfpContent) : generatedBody;
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, buildOutput(options, agent, selectionReason, content, rfpContent), "utf8");
    // Record command run + telemetry
    const now = new Date().toISOString();
    const commandRunId = workspaceStore.recordCommandRun({
        command: "pdr",
        status: "completed",
        workspace: options.workspaceRoot,
        updatedAt: now,
        outputPath: options.outputPath,
    });
    const promptTokens = estimateTokens(invocation.redactedPrompt ?? invocation.prompt ?? userPrompt);
    const completionTokens = estimateTokens(invocation.redactedResponse ?? invocation.response ?? "");
    workspaceStore.recordTokenUsage({
        command: "pdr",
        action: "generate",
        operationId: "docs.pdr.generate",
        agent: agent.name,
        model: agent.model,
        promptTokens,
        completionTokens,
        workspace: options.workspaceRoot,
        commandRunId,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`PDR created at ${options.outputPath} using agent ${agent.name ?? "(unknown)"} (provider=${agent.provider ?? "?"}, model=${agent.model ?? "?"})`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
