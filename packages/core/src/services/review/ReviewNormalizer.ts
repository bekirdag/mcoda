import type { ReviewAgentResult, ReviewFinding } from "./CodeReviewService.js";

export interface ReviewNormalizationResult {
  result: ReviewAgentResult;
  parsedFromJson: boolean;
  usedFallback: boolean;
  issues: string[];
}

const VALID_DECISIONS: ReviewAgentResult["decision"][] = [
  "approve",
  "changes_requested",
  "block",
  "info_only",
];

const DEFAULT_SUMMARY = "Review output was unstructured; treated as informational.";

const normalizeDecision = (value: string | undefined): ReviewAgentResult["decision"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "approved") return "approve";
  if ((VALID_DECISIONS as string[]).includes(normalized)) {
    return normalized as ReviewAgentResult["decision"];
  }
  return undefined;
};

const decisionFromText = (raw: string): ReviewAgentResult["decision"] => {
  const normalized = raw.toLowerCase();
  const explicit = normalized.match(/decision\\s*[:=-]?\\s*(approve|approved|changes_requested|changes requested|block|info_only)/i);
  if (explicit) {
    const mapped = explicit[1]?.replace(" ", "_");
    return normalizeDecision(mapped) ?? "info_only";
  }
  if (/(block|reject|fatal|critical)/i.test(normalized)) return "block";
  if (/(changes_requested|changes requested|request changes)/i.test(normalized)) return "changes_requested";
  if (/(approve|approved|looks good|ship it)/i.test(normalized)) return "approve";
  return "info_only";
};

const summaryFromText = (raw: string): string | undefined => {
  const match = raw.match(/summary\\s*[:=-]?\\s*(.+)/i);
  if (match?.[1]) {
    const summary = match[1].trim();
    if (summary) return summary;
  }
  const firstLine = raw.split(/\\r?\\n/).find((line) => line.trim());
  return firstLine?.trim() || undefined;
};

const sanitizeFindings = (findings: ReviewFinding[] | undefined): ReviewFinding[] => {
  if (!Array.isArray(findings)) return [];
  return findings.filter((finding) => Boolean(finding && typeof finding === "object")) as ReviewFinding[];
};

const coerceResult = (
  raw: string,
  partial: Partial<ReviewAgentResult>,
  forcedDecision?: ReviewAgentResult["decision"],
): ReviewAgentResult => {
  const decision = normalizeDecision(partial.decision) ?? forcedDecision ?? decisionFromText(raw);
  const summary = partial.summary?.trim() || summaryFromText(raw) || DEFAULT_SUMMARY;
  return {
    decision,
    summary,
    findings: sanitizeFindings(partial.findings),
    testRecommendations: Array.isArray(partial.testRecommendations) ? partial.testRecommendations : [],
    resolvedSlugs: Array.isArray(partial.resolvedSlugs) ? partial.resolvedSlugs : undefined,
    unresolvedSlugs: Array.isArray(partial.unresolvedSlugs) ? partial.unresolvedSlugs : undefined,
    raw,
  };
};

const extractJsonCandidates = (raw: string): string[] => {
  const candidates: string[] = [];
  if (!raw) return candidates;
  const fenceRegex = /```(?:json)?\\s*([\\s\\S]*?)```/gi;
  let match = fenceRegex.exec(raw);
  while (match) {
    const fenced = match[1]?.trim();
    if (fenced) candidates.push(fenced);
    match = fenceRegex.exec(raw);
  }

  const text = raw;
  let inString = false;
  let escape = false;
  let depth = 0;
  let startIndex = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) startIndex = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        const candidate = text.slice(startIndex, i + 1).trim();
        if (candidate) candidates.push(candidate);
        startIndex = -1;
      }
    }
  }

  return candidates;
};

const parseJsonCandidate = (candidate: string): Partial<ReviewAgentResult> | undefined => {
  try {
    const parsed = JSON.parse(candidate) as Partial<ReviewAgentResult>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

export const normalizeReviewOutput = (raw: string): ReviewNormalizationResult => {
  const issues: string[] = [];
  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed) {
      const result = coerceResult(raw, parsed);
      if (!normalizeDecision(parsed.decision)) {
        issues.push("coerced_decision");
      }
      if (!parsed.summary) {
        issues.push("coerced_summary");
      }
      return { result, parsedFromJson: true, usedFallback: false, issues };
    }
  }

  const fallback = coerceResult(raw, {}, "info_only");
  issues.push("non_json_output");
  return { result: fallback, parsedFromJson: false, usedFallback: true, issues };
};
