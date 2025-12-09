import { DocdexClient } from "./docdex.js";
import { defaultRedactionRules, redactText } from "./redaction.js";
const formatList = (label, values) => {
    if (!values.length)
        return "";
    return [`## ${label}`, ...values.map((v) => `- ${v}`)].join("\n");
};
export const assemblePrompt = async (request) => {
    const redactionRules = request.redactionRules ?? defaultRedactionRules;
    const docdexClient = new DocdexClient({
        workspaceRoot: request.workspaceRoot,
        allowPaths: request.docdexAllowPaths,
        maxBytes: request.docdexMaxBytes,
        chunkSize: request.docdexChunkSize,
        maxSegments: request.docdexMaxSegments,
    });
    const docSegments = request.docPaths?.length ? await docdexClient.fetchSegments(request.docPaths) : [];
    const sections = [
        `# Command: ${request.command}`,
        `# Agent: ${request.agent}`,
        request.context && Object.keys(request.context).length
            ? ["## Context", ...Object.entries(request.context).map(([key, value]) => `- ${key}: ${value}`)].join("\n")
            : "",
        request.history?.length ? formatList("Task history (summaries)", request.history) : "",
        request.comments?.length ? formatList("Task comments (summaries)", request.comments) : "",
        docSegments.length
            ? ["## Documents (docdex)", ...docSegments.map((seg) => `- ${seg.path}\n\n${seg.content.trimEnd()}`)].join("\n")
            : "",
        "## Instruction",
        request.userPrompt.trim(),
    ].filter(Boolean);
    const prompt = sections.join("\n\n");
    const redactedPrompt = redactText(prompt, redactionRules);
    return { prompt, redactedPrompt, docSegments };
};
