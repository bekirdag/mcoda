import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayAgentResult } from "./GatewayAgentService.js";
import { buildDocdexUsageGuidance } from "../shared/DocdexGuidance.js";
import { PathHelper } from "@mcoda/shared";

export const GATEWAY_HANDOFF_ENV_PATH = "MCODA_GATEWAY_HANDOFF_PATH";

export interface GatewayHandoffContext {
  qaFailureSummary?: string;
  learningSummary?: string;
}

export const buildGatewayHandoffDocdexUsage = (): string => {
  return buildDocdexUsageGuidance({
    contextLabel: "docdexNotes or task comments",
    includeHeading: true,
    includeFallback: true,
  });
};

export const buildGatewayHandoffContent = (
  result: GatewayAgentResult,
  context?: GatewayHandoffContext,
): string => {
  const lines: string[] = [];
  const analysis = result.analysis;
  const filesLikelyTouched = analysis.filesLikelyTouched ?? [];
  const filesToCreate = analysis.filesToCreate ?? [];
  const dirsToCreate = analysis.dirsToCreate ?? [];
  const assumptions = analysis.assumptions ?? [];
  const risks = analysis.risks ?? [];
  const docdexNotes = analysis.docdexNotes ?? [];
  lines.push("# Gateway Handoff");
  lines.push("");
  lines.push(`Job: ${result.job}`);
  lines.push(`Gateway agent: ${result.gatewayAgent.slug}`);
  lines.push(`Chosen agent: ${result.chosenAgent.agentSlug}`);
  lines.push("");
  if (analysis.reasoningSummary?.trim()) {
    lines.push("## Reasoning Summary");
    lines.push(analysis.reasoningSummary.trim());
    lines.push("");
  }
  if (result.tasks?.length) {
    lines.push("## Task Context");
    result.tasks.forEach((task) => {
      lines.push(`- ${task.key}: ${task.title}`);
      if (task.description) lines.push(`  Description: ${task.description}`);
      if (task.acceptanceCriteria?.length) lines.push(`  Acceptance: ${task.acceptanceCriteria.join(" | ")}`);
      if (task.dependencies?.length) lines.push(`  Dependencies: ${task.dependencies.join(", ")}`);
    });
    lines.push("");
  }
  lines.push("## Summary");
  lines.push(analysis.summary || "(none)");
  lines.push("");
  lines.push("## Current State");
  lines.push(analysis.currentState || "(none)");
  lines.push("");
  lines.push("## Todo");
  lines.push(analysis.todo || "(none)");
  lines.push("");
  lines.push("## Understanding");
  lines.push(analysis.understanding || "(none)");
  lines.push("");
  lines.push("## Plan");
  if (analysis.plan.length) {
    analysis.plan.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Files Likely Touched");
  if (filesLikelyTouched.length) {
    filesLikelyTouched.forEach((file) => lines.push(`- ${file}`));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Files To Create");
  if (filesToCreate.length) {
    filesToCreate.forEach((file) => lines.push(`- ${file}`));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Dirs To Create");
  if (dirsToCreate.length) {
    dirsToCreate.forEach((dir) => lines.push(`- ${dir}`));
  } else {
    lines.push("(none)");
  }
  if (assumptions.length) {
    lines.push("");
    lines.push("## Assumptions");
    assumptions.forEach((item) => lines.push(`- ${item}`));
  }
  if (risks.length) {
    lines.push("");
    lines.push("## Risks");
    risks.forEach((item) => lines.push(`- ${item}`));
  }
  if (docdexNotes.length) {
    lines.push("");
    lines.push("## Docdex Notes");
    docdexNotes.forEach((item) => lines.push(`- ${item}`));
  }
  if (context?.qaFailureSummary?.trim()) {
    lines.push("");
    lines.push("## QA Failure Summary");
    lines.push(context.qaFailureSummary.trim());
  }
  if (context?.learningSummary?.trim()) {
    lines.push("");
    lines.push("## Revert Learning");
    lines.push(context.learningSummary.trim());
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
  const handoffDir = path.join(PathHelper.getWorkspaceDir(workspaceRoot), "handoffs");
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
