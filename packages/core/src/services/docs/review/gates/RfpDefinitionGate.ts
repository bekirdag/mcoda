import { promises as fs } from "node:fs";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface RfpDefinitionGateInput {
  rfpPath?: string;
  allowlist?: string[];
}

const DEFAULT_ALLOWLIST = [
  "api",
  "http",
  "https",
  "tls",
  "oauth",
  "sso",
  "jwt",
  "cli",
  "ui",
  "sdk",
  "db",
  "sql",
  "rest",
  "graphql",
];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const normalizeTerm = (term: string): string =>
  term
    .replace(/[`*_]/g, "")
    .replace(/\(.*\)/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .toLowerCase()
    .trim();

const extractDefinitionTerm = (line: string): string | undefined => {
  const trimmed = line.trim();
  const bullet = trimmed.replace(/^[-*+]\s+/, "");
  const boldMatch = bullet.match(/\*\*([^*]+)\*\*/);
  if (boldMatch) return boldMatch[1]?.trim();
  const backtickMatch = bullet.match(/`([^`]+)`/);
  if (backtickMatch) return backtickMatch[1]?.trim();
  const colonMatch = bullet.match(/^([A-Za-z][A-Za-z0-9 _-]{1,40})\s*:/);
  if (colonMatch) return colonMatch[1]?.trim();
  return undefined;
};

const extractReferencedTerms = (line: string): string[] => {
  const terms: string[] = [];
  const boldMatches = line.matchAll(/\*\*([^*]+)\*\*/g);
  for (const match of boldMatches) {
    if (match[1]) terms.push(match[1]);
  }
  const codeMatches = line.matchAll(/`([^`]+)`/g);
  for (const match of codeMatches) {
    if (match[1]) terms.push(match[1]);
  }
  return terms;
};

const buildIssue = (input: {
  id: string;
  term: string;
  path: string;
  line: number;
  excerpt: string;
  issueType: string;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-rfp-definition-coverage",
  severity: "medium",
  category: "compliance",
  artifact: "pdr",
  message: `Undefined term referenced in RFP: ${input.term}.`,
  remediation: `Add a definition for \"${input.term}\" in the RFP Definitions section.`,
  location: {
    kind: "line_range",
    path: input.path,
    lineStart: input.line,
    lineEnd: input.line,
    excerpt: input.excerpt,
  },
  metadata: {
    issueType: input.issueType,
    term: input.term,
  },
});

export const runRfpDefinitionGate = async (
  input: RfpDefinitionGateInput,
): Promise<ReviewGateResult> => {
  if (!input.rfpPath) {
    return {
      gateId: "gate-rfp-definition-coverage",
      gateName: "RFP Definition Coverage",
      status: "skipped",
      issues: [],
      notes: ["No RFP path provided for definition coverage validation."],
    };
  }

  const allowlist = new Set(
    [...DEFAULT_ALLOWLIST, ...(input.allowlist ?? [])].map((item) => normalizeTerm(item)),
  );
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(input.rfpPath, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let inDefinitions = false;
    let definitionsHeadingLevel = 0;
    const definedTerms = new Set<string>();
    const referencedTerms: { term: string; line: number; excerpt: string }[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1]?.length ?? 0;
        const heading = headingMatch[2]?.trim() ?? "";
        if (/definitions|glossary/i.test(heading)) {
          inDefinitions = true;
          definitionsHeadingLevel = level;
        } else if (inDefinitions && level <= definitionsHeadingLevel) {
          inDefinitions = false;
        }
        continue;
      }

      if (inDefinitions) {
        const term = extractDefinitionTerm(trimmed);
        if (term) {
          definedTerms.add(normalizeTerm(term));
        }
        continue;
      }

      const refs = extractReferencedTerms(trimmed);
      if (refs.length > 0) {
        for (const ref of refs) {
          const normalized = normalizeTerm(ref);
          if (!normalized || allowlist.has(normalized)) continue;
          referencedTerms.push({ term: ref, line: i + 1, excerpt: trimmed });
        }
      }
    }

    const reported = new Set<string>();
    for (const ref of referencedTerms) {
      const normalized = normalizeTerm(ref.term);
      if (!normalized || definedTerms.has(normalized) || reported.has(normalized)) continue;
      reported.add(normalized);
      issues.push(
        buildIssue({
          id: `gate-rfp-definition-coverage-${normalized}`,
          term: ref.term,
          path: input.rfpPath,
          line: ref.line,
          excerpt: ref.excerpt,
          issueType: "undefined_term",
        }),
      );
    }

    if (definedTerms.size === 0 && referencedTerms.length > 0) {
      issues.push(
        buildIssue({
          id: "gate-rfp-definition-coverage-missing-section",
          term: "Definitions section",
          path: input.rfpPath,
          line: referencedTerms[0]?.line ?? 1,
          excerpt: referencedTerms[0]?.excerpt ?? "",
          issueType: "missing_definitions_section",
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read RFP at ${input.rfpPath}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-rfp-definition-coverage",
    gateName: "RFP Definition Coverage",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
