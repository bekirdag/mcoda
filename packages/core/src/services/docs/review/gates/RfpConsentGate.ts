import { promises as fs } from "node:fs";
import { loadGlossary } from "../Glossary.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface RfpConsentGateInput {
  rfpPath?: string;
}

const OVERBROAD_PATTERNS = [
  /\bstore all interactions\b/i,
  /\bcollect everything\b/i,
  /\bretain everything\b/i,
  /\bstore all data\b/i,
  /\blog everything\b/i,
  /\bkeep all records\b/i,
  /\bfull data retention\b/i,
];

const MINIMIZATION_HINTS = [
  /\bdata minimization\b/i,
  /\bminimi[sz]e data\b/i,
  /\blimit retention\b/i,
  /\bcollect only\b/i,
  /\bminimum necessary\b/i,
];

const ANON_HINTS = [/\banonymous\b/i, /\banon token\b/i, /\bno identifiers\b/i];
const IDENT_HINTS = [/\bidentified\b/i, /\buser id\b/i, /\baccount id\b/i, /\bnon-anonymous\b/i];

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  severity: ReviewSeverity;
  path: string;
  line: number;
  excerpt: string;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-rfp-consent-contradictions",
  severity: input.severity,
  category: "compliance",
  artifact: "pdr",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.path,
    lineStart: input.line,
    lineEnd: input.line,
    excerpt: input.excerpt,
  },
  metadata: input.metadata,
});

export const runRfpConsentGate = async (
  input: RfpConsentGateInput,
): Promise<ReviewGateResult> => {
  if (!input.rfpPath) {
    return {
      gateId: "gate-rfp-consent-contradictions",
      gateName: "RFP Consent & Minimization",
      status: "skipped",
      issues: [],
      notes: ["No RFP path provided for consent/minimization validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const glossary = loadGlossary();
  const consentPhrase = glossary.canonicalPhrases?.consent_flow ?? "consent flow";
  const anonymityPhrase = glossary.canonicalPhrases?.anonymity ?? "anonymous vs identified handling";

  try {
    const content = await fs.readFile(input.rfpPath, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let anonLine: number | undefined;
    let identLine: number | undefined;
    const minimizationDeclared = lines.some((line) =>
      MINIMIZATION_HINTS.some((pattern) => pattern.test(line)),
    );

    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i] ?? "";
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      if (anonLine === undefined && ANON_HINTS.some((pattern) => pattern.test(trimmed))) {
        anonLine = i + 1;
      }
      if (identLine === undefined && IDENT_HINTS.some((pattern) => pattern.test(trimmed))) {
        identLine = i + 1;
      }

      const overbroadMatch = OVERBROAD_PATTERNS.find((pattern) => pattern.test(trimmed));
      if (overbroadMatch) {
        const severity: ReviewSeverity = minimizationDeclared ? "high" : "medium";
        issues.push(
          buildIssue({
            id: `gate-rfp-consent-contradictions-overbroad-${i + 1}`,
            message: "Over-broad data retention statement conflicts with minimization goals.",
            remediation: `Align retention language with ${consentPhrase} and explicit minimization scope.`,
            severity,
            path: input.rfpPath,
            line: i + 1,
            excerpt: trimmed,
            metadata: {
              issueType: "overbroad_statement",
              minimizationDeclared,
              pattern: overbroadMatch.source,
            },
          }),
        );
      }
    }

    if (anonLine !== undefined && identLine !== undefined) {
      const line = Math.min(anonLine, identLine);
      issues.push(
        buildIssue({
          id: "gate-rfp-consent-contradictions-anon-ident",
          message: "RFP mentions both anonymous and identified handling without clarifying boundaries.",
          remediation: `Clarify ${anonymityPhrase} and reconcile consent requirements with minimization constraints.`,
          severity: "high",
          path: input.rfpPath,
          line,
          excerpt: lines[line - 1] ?? "",
          metadata: {
            issueType: "anon_ident_contradiction",
            anonymousLine: anonLine,
            identifiedLine: identLine,
          },
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read RFP at ${input.rfpPath}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-rfp-consent-contradictions",
    gateName: "RFP Consent & Minimization",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
