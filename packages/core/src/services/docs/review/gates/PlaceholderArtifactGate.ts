import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export type PlaceholderArtifactType = "placeholder" | "template_artifact";

export interface PlaceholderArtifactGateInput {
  artifacts: DocgenArtifactInventory;
  allowlist?: string[];
  denylist?: string[];
}

interface PlaceholderPattern {
  id: string;
  label: string;
  type: PlaceholderArtifactType;
  pattern: RegExp;
  severity: ReviewSeverity;
}

const DEFAULT_ALLOWLIST = ["for example", "example only", "sample data", "sample payload"];
const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  blocker: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const DEFAULT_PATTERNS: PlaceholderPattern[] = [
  {
    id: "placeholder.tbd",
    label: "TBD placeholder",
    type: "placeholder",
    pattern: /\bTBD\b/i,
    severity: "blocker",
  },
  {
    id: "placeholder.tbc",
    label: "TBC placeholder",
    type: "placeholder",
    pattern: /\bTBC\b/i,
    severity: "blocker",
  },
  {
    id: "placeholder.fixme",
    label: "FIXME placeholder",
    type: "placeholder",
    pattern: /\bFIXME\b/i,
    severity: "high",
  },
  {
    id: "placeholder.todo",
    label: "TODO placeholder",
    type: "placeholder",
    pattern: /\bTODO\b/,
    severity: "high",
  },
  {
    id: "placeholder.lorem",
    label: "Lorem ipsum placeholder",
    type: "placeholder",
    pattern: /\blorem ipsum\b/i,
    severity: "high",
  },
  {
    id: "placeholder.placeholder",
    label: "Placeholder text",
    type: "placeholder",
    pattern: /\bplaceholder\b/i,
    severity: "medium",
  },
  {
    id: "placeholder.tobe",
    label: "To be decided placeholder",
    type: "placeholder",
    pattern: /\bto be (decided|determined|filled)\b/i,
    severity: "high",
  },
  {
    id: "template.restaurant",
    label: "Restaurant template artifact",
    type: "template_artifact",
    pattern: /\brestaurant\b/i,
    severity: "high",
  },
  {
    id: "template.menu_items",
    label: "Menu items template artifact",
    type: "template_artifact",
    pattern: /\bmenu items?\b/i,
    severity: "medium",
  },
  {
    id: "template.reservation",
    label: "Reservation template artifact",
    type: "template_artifact",
    pattern: /\btable reservation(s)?\b/i,
    severity: "medium",
  },
  {
    id: "template.voting",
    label: "Voting template artifact",
    type: "template_artifact",
    pattern: /\b(voting|election|ballot)\b/i,
    severity: "high",
  },
  {
    id: "template.food_delivery",
    label: "Food delivery template artifact",
    type: "template_artifact",
    pattern: /\bfood delivery\b/i,
    severity: "medium",
  },
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildAllowlist = (allowlist?: string[]): RegExp[] => {
  const combined = [...DEFAULT_ALLOWLIST, ...(allowlist ?? [])];
  return combined.map((entry) => new RegExp(escapeRegExp(entry), "i"));
};

const buildCustomPatterns = (denylist?: string[]): PlaceholderPattern[] => {
  if (!denylist || denylist.length === 0) return [];
  return denylist.map((entry, index) => ({
    id: `custom.placeholder.${index + 1}`,
    label: `Custom placeholder: ${entry}`,
    type: "placeholder",
    pattern: new RegExp(escapeRegExp(entry), "i"),
    severity: "high",
  }));
};

const collectRecords = (artifacts: DocgenArtifactInventory): DocArtifactRecord[] => {
  const records: DocArtifactRecord[] = [];
  if (artifacts.pdr) records.push(artifacts.pdr);
  if (artifacts.sds) records.push(artifacts.sds);
  if (artifacts.sql) records.push(artifacts.sql);
  if (artifacts.openapi?.length) records.push(...artifacts.openapi);
  if (artifacts.blueprints?.length) records.push(...artifacts.blueprints);
  return records;
};

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const isExampleHeading = (heading: string): boolean => /example|sample/i.test(heading);

const selectHighestSeverity = (
  candidates: PlaceholderPattern[],
): PlaceholderPattern => {
  let chosen = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[chosen.severity]) {
      chosen = candidate;
    }
  }
  return chosen;
};

const buildIssue = (input: {
  record: DocArtifactRecord;
  pattern: PlaceholderPattern;
  line: string;
  lineNumber: number;
  heading?: string;
}): ReviewIssue => {
  const match = input.line.match(input.pattern.pattern);
  const excerpt = input.line.trim();
  const message = `${input.pattern.label} detected${match ? ` (${match[0]})` : ""}.`;
  const remediation =
    input.pattern.type === "placeholder"
      ? "Replace placeholders with concrete content."
      : "Replace unrelated template artifacts with project-specific content.";
  return {
    id: `gate-placeholder-artifacts-${input.record.kind}-${input.pattern.id}-${input.lineNumber}`,
    gateId: "gate-placeholder-artifacts",
    severity: input.pattern.severity,
    category: "content",
    artifact: input.record.kind,
    message,
    remediation,
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: input.lineNumber,
      lineEnd: input.lineNumber,
      excerpt,
    },
    metadata: {
      placeholderType: input.pattern.type,
      patternId: input.pattern.id,
      patternLabel: input.pattern.label,
      matchedText: match ? match[0] : undefined,
      heading: input.heading,
    },
  };
};

export const runPlaceholderArtifactGate = async (
  input: PlaceholderArtifactGateInput,
): Promise<ReviewGateResult> => {
  const allowlist = buildAllowlist(input.allowlist);
  const patterns = [...DEFAULT_PATTERNS, ...buildCustomPatterns(input.denylist)];
  const records = collectRecords(input.artifacts);
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  if (records.length === 0) {
    return {
      gateId: "gate-placeholder-artifacts",
      gateName: "Placeholder Artifacts",
      status: "skipped",
      issues,
      notes: ["No artifacts available for placeholder scanning."],
    };
  }

  for (const record of records) {
    let content: string;
    try {
      content = await fs.readFile(record.path, "utf8");
    } catch (error) {
      notes.push(`Placeholder scan skipped for ${record.path}: ${(error as Error).message}`);
      continue;
    }

    const lines = content.split(/\r?\n/);
    let inFence = false;
    let allowSection = false;
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
        currentHeading = headingMatch[1]?.trim() || undefined;
        allowSection = currentHeading ? isExampleHeading(currentHeading) : false;
      }

      if (inFence || allowSection) continue;
      if (allowlist.some((pattern) => pattern.test(line))) continue;

      const matches: PlaceholderPattern[] = [];
      for (const pattern of patterns) {
        if (!pattern.pattern.test(line)) continue;
        matches.push(pattern);
      }

      if (matches.length === 0) continue;

      const grouped = new Map<PlaceholderArtifactType, PlaceholderPattern[]>();
      for (const match of matches) {
        const existing = grouped.get(match.type);
        if (existing) {
          existing.push(match);
        } else {
          grouped.set(match.type, [match]);
        }
      }

      const typeOrder: PlaceholderArtifactType[] = ["placeholder", "template_artifact"];
      for (const type of typeOrder) {
        const candidates = grouped.get(type);
        if (!candidates || candidates.length === 0) continue;
        const selected = selectHighestSeverity(candidates);
        issues.push(
          buildIssue({
            record,
            pattern: selected,
            line,
            lineNumber: i + 1,
            heading: currentHeading,
          }),
        );
      }
    }
  }

  const status = issues.length > 0 ? "fail" : "pass";
  return {
    gateId: "gate-placeholder-artifacts",
    gateName: "Placeholder Artifacts",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      scannedArtifacts: records.length,
      patternCount: patterns.length,
      allowlistCount: allowlist.length,
    },
  };
};
