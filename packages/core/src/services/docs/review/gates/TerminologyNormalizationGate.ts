import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { GlossaryData, loadGlossary } from "../Glossary.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface TerminologyNormalizationGateInput {
  artifacts: DocgenArtifactInventory;
  glossary?: GlossaryData;
}

interface TermPattern {
  key: string;
  term: string;
  canonical: RegExp;
  canonicalStripper: RegExp;
  aliases: { alias: string; pattern: RegExp }[];
}

interface TermOccurrence {
  key: string;
  term: string;
  record: DocArtifactRecord;
  lineNumber: number;
  heading?: string;
}

const CONTRADICTION_GROUPS: { id: string; label: string; keys: string[] }[] = [
  {
    id: "token_identity",
    label: "Anonymous vs identified token terminology",
    keys: ["anonymous_token", "identified_token"],
  },
];

const SEVERITY_ALIAS: ReviewSeverity = "medium";
const SEVERITY_CONTRADICTION: ReviewSeverity = "blocker";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildPattern = (term: string): RegExp => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");

const buildStripper = (pattern: RegExp): RegExp => new RegExp(pattern.source, "gi");

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const isExampleHeading = (heading: string): boolean => /example|sample/i.test(heading);

const buildPatterns = (glossary: GlossaryData): TermPattern[] => {
  return glossary.entries.map((entry) => {
    const canonical = buildPattern(entry.term);
    const aliases = (entry.aliases ?? []).map((alias) => ({
      alias,
      pattern: buildPattern(alias),
    }));
    return {
      key: entry.key,
      term: entry.term,
      canonical,
      canonicalStripper: buildStripper(canonical),
      aliases,
    };
  });
};

const buildAliasIssue = (input: {
  record: DocArtifactRecord;
  lineNumber: number;
  heading?: string;
  alias: string;
  canonical: string;
  key: string;
}): ReviewIssue => {
  const message = `Non-canonical term "${input.alias}" detected; use "${input.canonical}".`;
  return {
    id: `gate-terminology-normalization-${input.record.kind}-${input.key}-${input.lineNumber}`,
    gateId: "gate-terminology-normalization",
    severity: SEVERITY_ALIAS,
    category: "terminology",
    artifact: input.record.kind,
    message,
    remediation: `Replace "${input.alias}" with the canonical term "${input.canonical}".`,
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: input.lineNumber,
      lineEnd: input.lineNumber,
      excerpt: input.alias,
    },
    metadata: {
      entryKey: input.key,
      canonicalTerm: input.canonical,
      alias: input.alias,
      heading: input.heading,
    },
  };
};

const buildContradictionIssue = (input: {
  record: DocArtifactRecord;
  lineNumber: number;
  terms: string[];
  keys: string[];
  label: string;
}): ReviewIssue => {
  const termList = input.terms.join(" vs ");
  return {
    id: `gate-terminology-normalization-contradiction-${input.lineNumber}`,
    gateId: "gate-terminology-normalization",
    severity: SEVERITY_CONTRADICTION,
    category: "terminology",
    artifact: input.record.kind,
    message: `Conflicting canonical terminology detected (${termList}).`,
    remediation: `Select one canonical term or explicitly define how both apply. (${input.label})`,
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: input.lineNumber,
      lineEnd: input.lineNumber,
      excerpt: termList,
    },
    metadata: {
      issueType: "contradiction",
      conflictKeys: input.keys,
      conflictTerms: input.terms,
      label: input.label,
    },
  };
};

const scanRecord = async (
  record: DocArtifactRecord,
  patterns: TermPattern[],
): Promise<{ issues: ReviewIssue[]; canonicalHits: TermOccurrence[]; notes: string[] }> => {
  const issues: ReviewIssue[] = [];
  const canonicalHits: TermOccurrence[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(record.path, "utf8");
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

      for (const pattern of patterns) {
        if (pattern.canonical.test(line)) {
          canonicalHits.push({
            key: pattern.key,
            term: pattern.term,
            record,
            lineNumber: i + 1,
            heading: currentHeading,
          });
        }

        if (pattern.aliases.length === 0) continue;
        const lineWithoutCanonical = line.replace(pattern.canonicalStripper, "");
        for (const alias of pattern.aliases) {
          if (!alias.pattern.test(lineWithoutCanonical)) continue;
          issues.push(
            buildAliasIssue({
              record,
              lineNumber: i + 1,
              heading: currentHeading,
              alias: alias.alias,
              canonical: pattern.term,
              key: pattern.key,
            }),
          );
        }
      }
    }
  } catch (error) {
    notes.push(`Unable to scan ${record.path}: ${(error as Error).message ?? String(error)}`);
  }

  return { issues, canonicalHits, notes };
};

const groupCanonicalHits = (hits: TermOccurrence[]): Map<string, TermOccurrence[]> => {
  const grouped = new Map<string, TermOccurrence[]>();
  for (const hit of hits) {
    const existing = grouped.get(hit.key);
    if (existing) {
      existing.push(hit);
    } else {
      grouped.set(hit.key, [hit]);
    }
  }
  return grouped;
};

export const runTerminologyNormalizationGate = async (
  input: TerminologyNormalizationGateInput,
): Promise<ReviewGateResult> => {
  const glossary = input.glossary ?? loadGlossary();
  if (!glossary.entries.length) {
    return {
      gateId: "gate-terminology-normalization",
      gateName: "Terminology Normalization",
      status: "skipped",
      issues: [],
      notes: ["Glossary is empty; terminology normalization skipped."],
    };
  }

  const patterns = buildPatterns(glossary);
  const records = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );

  if (records.length === 0) {
    return {
      gateId: "gate-terminology-normalization",
      gateName: "Terminology Normalization",
      status: "skipped",
      issues: [],
      notes: ["No PDR/SDS artifacts available for terminology checks."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const canonicalHits: TermOccurrence[] = [];

  for (const record of records) {
    const result = await scanRecord(record, patterns);
    issues.push(...result.issues);
    canonicalHits.push(...result.canonicalHits);
    notes.push(...result.notes);
  }

  const groupedHits = groupCanonicalHits(canonicalHits);
  for (const group of CONTRADICTION_GROUPS) {
    const hits = group.keys
      .map((key) => groupedHits.get(key) ?? [])
      .filter((entry) => entry.length > 0);
    if (hits.length < 2) continue;
    const flattened = hits.flat();
    const first = flattened[0];
    const terms = hits.map((entry) => entry[0]?.term).filter(Boolean) as string[];
    issues.push(
      buildContradictionIssue({
        record: first.record,
        lineNumber: first.lineNumber,
        terms,
        keys: group.keys,
        label: group.label,
      }),
    );
  }

  const hasContradiction = issues.some(
    (issue) => issue.severity === SEVERITY_CONTRADICTION,
  );
  const status = hasContradiction ? "fail" : issues.length > 0 ? "warn" : "pass";

  return {
    gateId: "gate-terminology-normalization",
    gateName: "Terminology Normalization",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      glossaryEntries: glossary.entries.length,
      contradictionGroups: CONTRADICTION_GROUPS.length,
    },
  };
};
