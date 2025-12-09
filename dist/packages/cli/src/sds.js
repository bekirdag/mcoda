#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createAgentService, createWorkspaceService } from "@mcoda/core/services.js";
import { invokeAgent } from "@mcoda/core/agent-invoke.js";
import { estimateTokens } from "@mcoda/core/token-math.js";
import { selectAgent } from "./pdr-helpers.js";
const usage = [
    "mcoda sds --pdr <path/to/pdr.md> [--rfp <path/to/rfp.md>] [--docs path1 path2 ...] [--out <path/to/sds.md>] [--title <title>] [--project <name>] [--agent <name>] [--store <path>] [--workspace <path>] [--no-appendix] [--dry-run] [--overwrite]",
    "",
    "Defaults:",
    "  --out .mcoda/docs/sds/sds-<pdr-basename>.md",
    "  --project <workspace-basename>",
    "  --workspace <dir containing the PDR>",
].join("\n");
const deriveDefaultOutputPath = (pdrPath) => {
    const base = path.basename(pdrPath, path.extname(pdrPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "docs", "sds", `sds-${base}.md`);
};
const parseArgs = (argv) => {
    const args = [...argv];
    let pdrPath;
    let rfpPath;
    let outputPath;
    let overwrite = false;
    let project;
    let title;
    const extraDocs = [];
    let agentName;
    let storePath;
    let workspaceRoot;
    let noAppendix = false;
    let dryRun = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case "--pdr":
            case "-i": {
                pdrPath = args[i + 1];
                i += 1;
                break;
            }
            case "--rfp": {
                rfpPath = args[i + 1];
                i += 1;
                break;
            }
            case "--docs": {
                const maybeDoc = args[i + 1];
                if (maybeDoc && !maybeDoc.startsWith("--")) {
                    extraDocs.push(maybeDoc);
                    i += 1;
                }
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
    if (!pdrPath) {
        throw new Error("Missing required --pdr <path/to/pdr.md> argument");
    }
    const resolvedPdr = path.resolve(pdrPath);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot ?? path.dirname(resolvedPdr));
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedPdr));
    const resolvedDocs = extraDocs.map((doc) => path.resolve(doc));
    return {
        pdrPath: resolvedPdr,
        rfpPath: rfpPath ? path.resolve(rfpPath) : undefined,
        extraDocs: resolvedDocs,
        outputPath: resolvedOut,
        overwrite,
        project: project ?? path.basename(resolvedWorkspaceRoot),
        title: title ?? path.basename(resolvedPdr, path.extname(resolvedPdr)),
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
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildAgentPrompt = (opts, pdrContent, extraDocs) => {
    return [
        "# Task",
        "You are a senior systems architect. Draft a Software Design Specification (SDS) based strictly on the provided PDR (and RFP if present).",
        "Be precise, avoid fluff, and keep sections concise and actionable.",
        "",
        "# Output format (Markdown, REQUIRED headings)",
        "## 1. Overview",
        "- Summary of product, target users, success criteria.",
        "## 2. Goals",
        "- Bullets, clear outcomes.",
        "## 3. Non-Goals",
        "- Bullets, exclusions.",
        "## 4. Functional Scope",
        "- Capabilities/flows, acceptance criteria.",
        "## 5. Architecture & Components",
        "- Proposed architecture, components, data flow.",
        "## 6. Interfaces & Contracts",
        "- APIs, I/O, schemas, OpenAPI references if implied.",
        "## 7. Non-Functional Requirements",
        "- Performance, reliability, security, compliance.",
        "## 8. Risks and Mitigations",
        "- Risk → mitigation bullets.",
        "## 9. Open Questions",
        "- Unresolved questions.",
        "## 10. Acceptance Criteria",
        "- Testable, measurable outcomes.",
        "",
        "# Constraints",
        "- Stay within PDR (and RFP) scope; do not invent features.",
        "- Use concise bullets; avoid marketing language.",
        "- Note assumptions when information is missing.",
        "",
        "# Project context",
        `- Project: ${opts.project}`,
        opts.title ? `- Working title: ${opts.title}` : "",
        `- PDR path: ${opts.pdrPath}`,
        opts.rfpPath ? `- RFP path: ${opts.rfpPath}` : "",
        extraDocs.length ? `- Extra docs: ${extraDocs.map((d) => d.path).join(", ")}` : "- Extra docs: none",
    ]
        .filter(Boolean)
        .join("\n");
};
const requiredHeadings = [
    "## 1. overview",
    "## 2. goals",
    "## 3. non-goals",
    "## 4. functional scope",
    "## 5. architecture & components",
    "## 6. interfaces & contracts",
    "## 7. non-functional requirements",
    "## 8. risks and mitigations",
    "## 9. open questions",
    "## 10. acceptance criteria",
];
const validateBody = (body) => {
    const reasons = [];
    const normalized = body.toLowerCase();
    requiredHeadings.forEach((h) => {
        if (!normalized.includes(h))
            reasons.push(`Missing heading: ${h}`);
    });
    if (body.trim().length < 300)
        reasons.push("Body too short (<300 chars)");
    return { ok: reasons.length === 0, reasons };
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const buildOutput = (opts, agent, selectionReason, body, pdrContent, extraDocs) => {
    const now = new Date().toISOString();
    const header = [
        `# Software Design Specification${opts.title ? `: ${opts.title}` : ""}`,
        "",
        `- Project: ${opts.project}`,
        `- Source PDR: ${path.relative(opts.workspaceRoot, opts.pdrPath)}`,
        opts.rfpPath ? `- Source RFP: ${path.relative(opts.workspaceRoot, opts.rfpPath)}` : null,
        extraDocs.length ? `- Additional docs: ${extraDocs.map((d) => path.relative(opts.workspaceRoot, d.path)).join(", ")}` : "- Additional docs: (none provided)",
        `- Agent: ${agent.name ?? "unknown"} (${agent.provider ?? "unknown"}/${agent.model ?? "unknown"})`,
        `- Agent selection: ${selectionReason}`,
        `- Generated: ${now}`,
        "",
    ]
        .filter(Boolean)
        .join("\n");
    const appendixPdr = opts.noAppendix ? "" : ["## Appendix A: Source PDR", fence(pdrContent), ""].join("\n");
    const appendixExtra = opts.noAppendix || extraDocs.length === 0
        ? ""
        : extraDocs
            .map((doc, index) => {
            const label = `Appendix ${String.fromCharCode(66 + index)}: ${path.basename(doc.path)}`;
            return [label, "", fence(doc.content), ""].join("\n");
        })
            .join("\n");
    return [header, body.trim(), appendixPdr, appendixExtra].filter(Boolean).join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const pdrContent = await fs.readFile(options.pdrPath, "utf8");
    const extraDocs = await Promise.all(options.extraDocs.map(async (docPath) => ({ path: docPath, content: await fs.readFile(docPath, "utf8") })));
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    const agentRegistry = await createAgentService({ dbPath: options.storePath });
    const agents = agentRegistry.listAgents();
    if (!agents.length) {
        throw new Error("No agents found in the registry. Add one with `pnpm mcoda:agent -- add ...`.");
    }
    const workspaceDefault = agentRegistry.getWorkspaceDefault(options.workspaceRoot);
    const globalDefault = agentRegistry.getWorkspaceDefault("__GLOBAL__");
    const workspaceRule = agentRegistry.listRoutingRules(options.workspaceRoot).find((r) => r.command === "sds")?.agent ?? null;
    const globalRule = agentRegistry.listRoutingRules("__GLOBAL__").find((r) => r.command === "sds")?.agent ?? null;
    const { agent, reason: selectionReason } = selectAgent(agents, {
        preferred: options.agentName,
        workspaceRule,
        globalRule,
        workspaceDefault,
        globalDefault,
    });
    const userPrompt = buildAgentPrompt(options, pdrContent, extraDocs);
    const docPaths = [options.pdrPath, ...(options.rfpPath ? [options.rfpPath] : []), ...options.extraDocs];
    if (options.dryRun) {
        // eslint-disable-next-line no-console
        console.log(`# Dry run: SDS prompt (agent=${agent.name ?? "unknown"})\n\n${userPrompt}`);
        return;
    }
    const invocation = await invokeAgent({
        agent,
        command: "sds",
        userPrompt,
        workspaceRoot: options.workspaceRoot,
        docPaths,
        docdexAllowPaths: docPaths,
        docdexChunkSize: 4000,
        docdexMaxSegments: 12,
        context: { project: options.project, title: options.title ?? "SDS" },
    });
    const generatedBody = invocation.response?.trim() || "";
    const validation = validateBody(generatedBody);
    const usingFallback = !(validation.ok && generatedBody.length);
    if (usingFallback) {
        // eslint-disable-next-line no-console
        console.warn(generatedBody.length
            ? `Generated SDS draft failed validation (${validation.reasons.join("; ")}); writing fallback stub instead.`
            : "No response received from agent; writing fallback stub instead.");
    }
    const fallback = [
        "## 1. Overview",
        "TODO: Summarize the product, target users, and success criteria.",
        "## 2. Goals",
        "- TODO: extract goals from PDR/RFP.",
        "## 3. Non-Goals",
        "- TODO: exclusions.",
        "## 4. Functional Scope",
        "- TODO: capabilities, flows, acceptance criteria.",
        "## 5. Architecture & Components",
        "- TODO: architecture, components, data flow.",
        "## 6. Interfaces & Contracts",
        "- TODO: APIs, I/O, schemas.",
        "## 7. Non-Functional Requirements",
        "- TODO: performance, reliability, security, compliance.",
        "## 8. Risks and Mitigations",
        "- TODO: risks and mitigations.",
        "## 9. Open Questions",
        "- TODO: unresolved questions.",
        "## 10. Acceptance Criteria",
        "- TODO: measurable outcomes.",
    ].join("\n");
    const content = usingFallback ? fallback : generatedBody;
    await ensureParentDirectory(options.outputPath);
    await fs.writeFile(options.outputPath, buildOutput(options, agent, selectionReason, content, pdrContent, extraDocs), "utf8");
    // Telemetry
    const workspaceStore = await createWorkspaceService({ workspaceRoot: options.workspaceRoot });
    const now = new Date().toISOString();
    const promptTokens = estimateTokens(invocation.redactedPrompt ?? invocation.prompt ?? userPrompt);
    const completionTokens = estimateTokens(invocation.redactedResponse ?? invocation.response ?? "");
    workspaceStore.recordCommandRun({
        command: "sds",
        status: "completed",
        workspace: options.workspaceRoot,
        updatedAt: now,
        outputPath: options.outputPath,
    });
    workspaceStore.recordTokenUsage({
        command: "sds",
        action: "generate",
        operationId: "docs.sds.generate",
        agent: agent.name,
        model: agent.model,
        promptTokens,
        completionTokens,
        workspace: options.workspaceRoot,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`SDS created at ${options.outputPath} using agent ${agent.name ?? "(unknown)"} (provider=${agent.provider ?? "?"}, model=${agent.model ?? "?"})`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
