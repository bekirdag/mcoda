import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsTechStackRationaleGateInput {
  artifacts: DocgenArtifactInventory;
}

const SECTION_HEADING = /platform model|technology stack|tech stack/i;
const CHOSEN_STACK_PATTERNS = [/chosen stack/i, /selected stack/i, /primary stack/i, /\bwe use\b/i];
const ALTERNATIVES_PATTERNS = [/alternatives? considered/i, /\balternative\b/i, /options? considered/i];
const RATIONALE_PATTERNS = [/rationale/i, /trade[- ]?off/i, /\bbecause\b/i, /why (this|the) stack/i];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const extractSection = (
  lines: string[],
  headingMatch: RegExp,
): { content: string[]; line: number } | undefined => {
  let inFence = false;
  let capture = false;
  let startLine = 0;
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = heading[1]?.trim() ?? "";
      if (headingMatch.test(title)) {
        capture = true;
        startLine = i + 1;
        continue;
      }
      if (capture) break;
    }
    if (capture && trimmed) collected.push(trimmed);
  }
  if (!capture) return undefined;
  return { content: collected, line: startLine };
};

const containsAny = (lines: string[], patterns: RegExp[]): boolean =>
  lines.some((line) => patterns.some((pattern) => pattern.test(line)));

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-sds-tech-stack-rationale",
  severity: "high",
  category: "decision",
  artifact: "sds",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line ?? 1,
    lineEnd: input.line ?? 1,
    excerpt: input.message,
  },
  metadata: input.metadata,
});

export const runSdsTechStackRationaleGate = async (
  input: SdsTechStackRationaleGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-tech-stack-rationale",
      gateName: "SDS Tech Stack Rationale",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for tech stack rationale validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);
    const stackSection = extractSection(lines, SECTION_HEADING);
    if (!stackSection) {
      issues.push(
        buildIssue({
          id: "gate-sds-tech-stack-rationale-missing-section",
          message: "SDS is missing a platform model / technology stack section.",
          remediation:
            "Add a section that defines the selected stack, alternatives considered, and decision rationale.",
          record: sds,
          metadata: { issueType: "missing_tech_stack_section" },
        }),
      );
    } else {
      if (!containsAny(stackSection.content, CHOSEN_STACK_PATTERNS)) {
        issues.push(
          buildIssue({
            id: "gate-sds-tech-stack-rationale-missing-chosen",
            message: "Tech stack section does not explicitly state the chosen stack baseline.",
            remediation:
              "Add explicit chosen/selected stack statements for runtime, language, persistence, and tooling.",
            record: sds,
            line: stackSection.line,
            metadata: { issueType: "missing_chosen_stack" },
          }),
        );
      }
      if (!containsAny(stackSection.content, ALTERNATIVES_PATTERNS)) {
        issues.push(
          buildIssue({
            id: "gate-sds-tech-stack-rationale-missing-alternatives",
            message: "Tech stack section does not document alternatives considered.",
            remediation:
              "Document at least one realistic alternative and explain why it was not selected.",
            record: sds,
            line: stackSection.line,
            metadata: { issueType: "missing_alternatives" },
          }),
        );
      }
      if (!containsAny(stackSection.content, RATIONALE_PATTERNS)) {
        issues.push(
          buildIssue({
            id: "gate-sds-tech-stack-rationale-missing-rationale",
            message: "Tech stack section does not include explicit decision rationale/trade-offs.",
            remediation:
              "Add rationale that explains trade-offs and why the selected stack is preferred for this phase.",
            record: sds,
            line: stackSection.line,
            metadata: { issueType: "missing_rationale" },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-tech-stack-rationale",
    gateName: "SDS Tech Stack Rationale",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
