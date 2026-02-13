import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface NoMaybesGateInput {
  artifacts: DocgenArtifactInventory;
  enabled: boolean;
}

interface IndecisivePattern {
  id: string;
  label: string;
  pattern: RegExp;
}

const INDECISIVE_PATTERNS: IndecisivePattern[] = [
  { id: "maybe", label: "Maybe language", pattern: /\bmaybe\b/i },
  { id: "optional", label: "Optional language", pattern: /\boptional\b/i },
  { id: "could", label: "Could language", pattern: /\bcould\b/i },
  { id: "might", label: "Might language", pattern: /\bmight\b/i },
  { id: "possibly", label: "Possibly language", pattern: /\bpossibly\b/i },
  { id: "either", label: "Either/Or language", pattern: /\beither\b/i },
  { id: "tbd", label: "TBD language", pattern: /\btbd\b/i },
];

const DECISION_HEADINGS = [
  /architecture/i,
  /technology stack/i,
  /tech stack/i,
  /deployment/i,
  /security/i,
  /data model/i,
  /interfaces/i,
  /operations/i,
  /ops/i,
];

const OPTIONS_HEADINGS = [/options considered/i, /alternatives/i, /trade-?offs/i, /choices/i];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const headingLevel = (heading: string): number => heading.match(/^#{1,6}/)?.[0].length ?? 0;

const matchesHeading = (heading: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(heading));

const buildIssue = (input: {
  record: DocArtifactRecord;
  lineNumber: number;
  pattern: IndecisivePattern;
  heading?: string;
}): ReviewIssue => {
  const severity: ReviewSeverity = "medium";
  const message = `${input.pattern.label} detected in decision-required section.`;
  return {
    id: `gate-no-maybes-${input.record.kind}-${input.pattern.id}-${input.lineNumber}`,
    gateId: "gate-no-maybes",
    severity,
    category: "decision",
    artifact: input.record.kind,
    message,
    remediation: "Replace indecisive language with a concrete decision.",
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: input.lineNumber,
      lineEnd: input.lineNumber,
      excerpt: input.pattern.label,
    },
    metadata: {
      patternId: input.pattern.id,
      heading: input.heading,
    },
  };
};

const scanRecord = async (
  record: DocArtifactRecord,
): Promise<{ issues: ReviewIssue[]; notes: string[] }> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(record.path, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let decisionLevel: number | null = null;
    let optionsLevel: number | null = null;
    let currentHeading: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }

      const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (headingMatch) {
        const level = headingLevel(trimmed);
        currentHeading = headingMatch[1]?.trim() || undefined;
        if (currentHeading && matchesHeading(currentHeading, OPTIONS_HEADINGS)) {
          optionsLevel = level;
        } else if (currentHeading && matchesHeading(currentHeading, DECISION_HEADINGS)) {
          decisionLevel = level;
          optionsLevel = null;
        } else {
          if (decisionLevel !== null && level <= decisionLevel) decisionLevel = null;
          if (optionsLevel !== null && level <= optionsLevel) optionsLevel = null;
        }
        continue;
      }

      if (inFence) continue;
      const inDecisionSection = decisionLevel !== null && optionsLevel === null;
      if (!inDecisionSection) continue;

      for (const pattern of INDECISIVE_PATTERNS) {
        if (!pattern.pattern.test(trimmed)) continue;
        issues.push(
          buildIssue({
            record,
            lineNumber: i + 1,
            pattern,
            heading: currentHeading,
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to scan ${record.path}: ${(error as Error).message ?? String(error)}`);
  }

  return { issues, notes };
};

export const runNoMaybesGate = async (input: NoMaybesGateInput): Promise<ReviewGateResult> => {
  if (!input.enabled) {
    return {
      gateId: "gate-no-maybes",
      gateName: "No Maybes",
      status: "skipped",
      issues: [],
      notes: ["No-maybes gate disabled."],
    };
  }

  const records = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );
  if (records.length === 0) {
    return {
      gateId: "gate-no-maybes",
      gateName: "No Maybes",
      status: "skipped",
      issues: [],
      notes: ["No PDR/SDS artifacts available for indecisive language checks."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  for (const record of records) {
    const result = await scanRecord(record);
    issues.push(...result.issues);
    notes.push(...result.notes);
  }

  const status = issues.length > 0 ? "fail" : "pass";
  return {
    gateId: "gate-no-maybes",
    gateName: "No Maybes",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
  };
};
