import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsNoUnresolvedItemsGateInput {
  artifacts: DocgenArtifactInventory;
}

const UNRESOLVED_PATTERNS = [
  /\bTBD\b/i,
  /\bTBC\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bto be (determined|decided|filled)\b/i,
  /\bunknown\b/i,
  /\bunresolved\b/i,
];

const OPEN_QUESTIONS_HEADING = /open questions?/i;
const RESOLVED_LINE = /^[-*+\d.)\s]*resolved:/i;
const NO_OPEN_ITEMS_LINE = /no unresolved questions remain|no open questions remain/i;

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line: number;
  excerpt: string;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-sds-no-unresolved-items",
  severity: "high",
  category: "open_questions",
  artifact: "sds",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line,
    lineEnd: input.line,
    excerpt: input.excerpt,
  },
  metadata: input.metadata,
});

export const runSdsNoUnresolvedItemsGate = async (
  input: SdsNoUnresolvedItemsGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-no-unresolved-items",
      gateName: "SDS No Unresolved Items",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for unresolved item validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let inOpenQuestions = false;

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
        inOpenQuestions = OPEN_QUESTIONS_HEADING.test(title);
        continue;
      }

      if (inOpenQuestions) {
        if (NO_OPEN_ITEMS_LINE.test(trimmed)) continue;
        if (RESOLVED_LINE.test(trimmed)) continue;
        issues.push(
          buildIssue({
            id: `gate-sds-no-unresolved-items-open-${i + 1}`,
            message: "Open Questions section contains an unresolved entry.",
            remediation:
              "Rewrite entries as resolved decisions (prefix each line with 'Resolved:') or remove unresolved items.",
            record: sds,
            line: i + 1,
            excerpt: trimmed,
            metadata: { issueType: "unresolved_open_question" },
          }),
        );
        continue;
      }

      const unresolvedPattern = UNRESOLVED_PATTERNS.find((pattern) => pattern.test(trimmed));
      if (unresolvedPattern) {
        issues.push(
          buildIssue({
            id: `gate-sds-no-unresolved-items-marker-${i + 1}`,
            message: "SDS contains unresolved placeholder language.",
            remediation:
              "Replace unresolved markers with explicit decisions and concrete implementation details.",
            record: sds,
            line: i + 1,
            excerpt: trimmed,
            metadata: { issueType: "unresolved_marker", pattern: unresolvedPattern.source },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-no-unresolved-items",
    gateName: "SDS No Unresolved Items",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
