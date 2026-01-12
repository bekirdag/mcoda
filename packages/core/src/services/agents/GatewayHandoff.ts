import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayAgentResult } from "./GatewayAgentService.js";

export const GATEWAY_HANDOFF_ENV_PATH = "MCODA_GATEWAY_HANDOFF_PATH";

export const buildGatewayHandoffDocdexUsage = (): string => {
  const lines: string[] = [];
  lines.push("## Docdex Usage (required)");
  lines.push("- Use docdexd CLI (daemon-backed), not curl or MCP.");
  lines.push("- Search: `docdexd chat --repo <repo> --query \"...\" --limit 8` (HTTP: `GET /search`).");
  lines.push("- Web: `docdexd web-search`, `docdexd web-fetch`, `docdexd web-rag` (HTTP: `/v1/web/*`).");
  lines.push("- Memory: `docdexd memory-store` / `memory-recall` (HTTP: `/v1/memory/store`, `/v1/memory/recall`).");
  lines.push(
    "- Agent profile: `docdexd profile add/search` (HTTP: `/v1/profile/add`, `/v1/profile/search`, `/v1/profile/save`).",
  );
  lines.push("- AST/impact/snippets use daemon endpoints (`/v1/ast`, `/v1/graph/impact`, `/snippet/:doc_id`).");
  lines.push(
    "- Reasoning DAG: capture session_id (docdex request_id) and export with `docdexd dag view --repo <repo> <session_id> --format text|dot|json`.",
  );
  lines.push("- HTTP DAG export: `GET /v1/dag/export?session_id=<id>&format=json|text|dot&max_nodes=<n>`.");
  lines.push("- Note any docdex failures/disabled memory/profile in task comments or docdexNotes.");
  return lines.join("\n");
};

export const buildGatewayHandoffContent = (result: GatewayAgentResult): string => {
  const lines: string[] = [];
  lines.push("# Gateway Handoff");
  lines.push("");
  lines.push(`Job: ${result.job}`);
  lines.push(`Gateway agent: ${result.gatewayAgent.slug}`);
  lines.push(`Chosen agent: ${result.chosenAgent.agentSlug}`);
  lines.push("");
  if (result.analysis.reasoningSummary?.trim()) {
    lines.push("## Reasoning Summary");
    lines.push(result.analysis.reasoningSummary.trim());
    lines.push("");
  }
  lines.push("## Summary");
  lines.push(result.analysis.summary || "(none)");
  lines.push("");
  lines.push("## Current State");
  lines.push(result.analysis.currentState || "(none)");
  lines.push("");
  lines.push("## Todo");
  lines.push(result.analysis.todo || "(none)");
  lines.push("");
  lines.push("## Understanding");
  lines.push(result.analysis.understanding || "(none)");
  lines.push("");
  lines.push("## Plan");
  if (result.analysis.plan.length) {
    result.analysis.plan.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Files Likely Touched");
  if (result.analysis.filesLikelyTouched.length) {
    result.analysis.filesLikelyTouched.forEach((file) => lines.push(`- ${file}`));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Files To Create");
  if (result.analysis.filesToCreate.length) {
    result.analysis.filesToCreate.forEach((file) => lines.push(`- ${file}`));
  } else {
    lines.push("(none)");
  }
  if (result.analysis.assumptions.length) {
    lines.push("");
    lines.push("## Assumptions");
    result.analysis.assumptions.forEach((item) => lines.push(`- ${item}`));
  }
  if (result.analysis.risks.length) {
    lines.push("");
    lines.push("## Risks");
    result.analysis.risks.forEach((item) => lines.push(`- ${item}`));
  }
  if (result.analysis.docdexNotes.length) {
    lines.push("");
    lines.push("## Docdex Notes");
    result.analysis.docdexNotes.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push("");
  lines.push(buildGatewayHandoffDocdexUsage());
  return lines.join("\n");
};

export const writeGatewayHandoffFile = async (
  workspaceRoot: string,
  commandRunId: string,
  content: string,
  prefix = "gateway",
): Promise<string> => {
  const handoffDir = path.join(workspaceRoot, ".mcoda", "handoffs");
  await fs.mkdir(handoffDir, { recursive: true });
  const handoffPath = path.join(handoffDir, `${prefix}-${commandRunId}.md`);
  await fs.writeFile(handoffPath, content, "utf8");
  return handoffPath;
};

export const withGatewayHandoff = async <T>(handoffPath: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const previousHandoff = process.env[GATEWAY_HANDOFF_ENV_PATH];
  if (handoffPath) {
    process.env[GATEWAY_HANDOFF_ENV_PATH] = handoffPath;
  }
  try {
    return await fn();
  } finally {
    if (previousHandoff === undefined) {
      delete process.env[GATEWAY_HANDOFF_ENV_PATH];
    } else {
      process.env[GATEWAY_HANDOFF_ENV_PATH] = previousHandoff;
    }
  }
};
