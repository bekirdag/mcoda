import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsDecisionsGateInput {
  artifacts: DocgenArtifactInventory;
}

const DECISION_HEADINGS = /architecture|tech stack|technology|database|storage|runtime|language|framework|deployment/i;
const OPTIONS_HEADING = /options considered|alternatives/i;

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const isAmbiguousDecision = (line: string): boolean => {
  const trimmed = line.toLowerCase();
  if (trimmed.includes("either ") || trimmed.includes(" or ") || trimmed.includes("/")) {
    return /\b\w+\s+(or|\/)+\s+\w+/.test(trimmed) || /either\s+\w+\s+or\s+\w+/.test(trimmed);
  }
  return false;
};

const buildIssue = (input: {
  record: DocArtifactRecord;
  line: number;
  excerpt: string;
}): ReviewIssue => ({
  id: `gate-sds-explicit-decisions-${input.line}`,
  gateId: "gate-sds-explicit-decisions",
  severity: "high",
  category: "decision",
  artifact: "sds",
  message: "SDS decision section contains ambiguous technology choice.",
  remediation: "Replace ambiguous choices with a single explicit decision.",
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line,
    lineEnd: input.line,
    excerpt: input.excerpt,
  },
  metadata: { issueType: "ambiguous_decision" },
});

export const runSdsDecisionsGate = async (
  input: SdsDecisionsGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-explicit-decisions",
      gateName: "SDS Explicit Decisions",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for explicit decision validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let inDecisionSection = false;
    let inOptionsSection = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        const title = heading[1]?.trim() ?? "";
        inOptionsSection = OPTIONS_HEADING.test(title);
        inDecisionSection = DECISION_HEADINGS.test(title) && !inOptionsSection;
        continue;
      }

      if (!inDecisionSection || inOptionsSection) continue;
      if (!isAmbiguousDecision(trimmed)) continue;

      issues.push(
        buildIssue({
          record: sds,
          line: i + 1,
          excerpt: trimmed,
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-explicit-decisions",
    gateName: "SDS Explicit Decisions",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
