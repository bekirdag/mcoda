import { DocArtifactKind } from "../DocgenRunContext.js";

export type ReviewSeverity = "blocker" | "high" | "medium" | "low" | "info";

export type ReviewIssueCategory =
  | "structure"
  | "content"
  | "consistency"
  | "completeness"
  | "compliance"
  | "terminology"
  | "open_questions"
  | "api"
  | "sql"
  | "deployment"
  | "decision"
  | "other";

export type ReviewIssueLocation =
  | {
      kind: "heading";
      heading: string;
      path?: string;
    }
  | {
      kind: "line_range";
      path: string;
      lineStart: number;
      lineEnd: number;
      excerpt?: string;
    };

export interface ReviewIssue {
  id: string;
  gateId: string;
  severity: ReviewSeverity;
  category: ReviewIssueCategory;
  artifact: DocArtifactKind;
  message: string;
  remediation: string;
  location: ReviewIssueLocation;
  metadata?: Record<string, unknown>;
}

export type ReviewGateStatus = "pass" | "warn" | "fail" | "skipped";

export interface ReviewGateResult {
  gateId: string;
  gateName: string;
  status: ReviewGateStatus;
  issues: ReviewIssue[];
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReviewDecision {
  id: string;
  summary: string;
  rationale: string;
  decidedAt: string;
  relatedIssueIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReviewFix {
  issueId: string;
  summary: string;
  appliedAt: string;
  metadata?: Record<string, unknown>;
}

export type ReviewOutcomeStatus = "pass" | "warn" | "fail";

export interface ReviewSummary {
  status: ReviewOutcomeStatus;
  issueCount: number;
  severityCounts: Record<ReviewSeverity, number>;
  gateCounts: Record<ReviewGateStatus, number>;
}

export interface ReviewOutcome {
  version: 1;
  generatedAt: string;
  gateResults: ReviewGateResult[];
  issues: ReviewIssue[];
  remainingOpenItems: ReviewIssue[];
  fixesApplied: ReviewFix[];
  decisions: ReviewDecision[];
  summary: ReviewSummary;
}

const severityOrder: Record<ReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const gateStatusOrder: Record<ReviewGateStatus, number> = {
  fail: 0,
  warn: 1,
  pass: 2,
  skipped: 3,
};

const emptySeverityCounts = (): Record<ReviewSeverity, number> => ({
  blocker: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

const emptyGateCounts = (): Record<ReviewGateStatus, number> => ({
  pass: 0,
  warn: 0,
  fail: 0,
  skipped: 0,
});

const locationKey = (location: ReviewIssueLocation): string => {
  if (location.kind === "heading") {
    return `${location.path ?? ""}#${location.heading}`;
  }
  return `${location.path}:${location.lineStart}-${location.lineEnd}`;
};

export const sortIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
  return issues.slice().sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const gateDiff = a.gateId.localeCompare(b.gateId);
    if (gateDiff !== 0) return gateDiff;
    const artifactDiff = a.artifact.localeCompare(b.artifact);
    if (artifactDiff !== 0) return artifactDiff;
    return locationKey(a.location).localeCompare(locationKey(b.location));
  });
};

export const flattenIssues = (gateResults: ReviewGateResult[]): ReviewIssue[] => {
  const collected: ReviewIssue[] = [];
  for (const result of gateResults) {
    collected.push(...result.issues);
  }
  return collected;
};

export const summarizeGateResults = (gateResults: ReviewGateResult[]): ReviewSummary => {
  const gateCounts = emptyGateCounts();
  const severityCounts = emptySeverityCounts();
  let status: ReviewOutcomeStatus = "pass";
  let issueCount = 0;

  for (const gate of gateResults) {
    gateCounts[gate.status] = (gateCounts[gate.status] ?? 0) + 1;
    if (gate.status === "fail") status = "fail";
    if (gate.status === "warn" && status === "pass") status = "warn";
    for (const issue of gate.issues) {
      issueCount += 1;
      severityCounts[issue.severity] = (severityCounts[issue.severity] ?? 0) + 1;
    }
  }

  return { status, issueCount, severityCounts, gateCounts };
};

export const aggregateReviewOutcome = (input: {
  gateResults: ReviewGateResult[];
  remainingOpenItems?: ReviewIssue[];
  fixesApplied?: ReviewFix[];
  decisions?: ReviewDecision[];
  generatedAt?: string;
}): ReviewOutcome => {
  const gateResults = input.gateResults.slice().sort((a, b) => {
    const statusDiff = gateStatusOrder[a.status] - gateStatusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.gateId.localeCompare(b.gateId);
  });
  const issues = sortIssues(flattenIssues(gateResults));
  const remainingOpenItems = sortIssues(input.remainingOpenItems ?? []);
  const fixesApplied = (input.fixesApplied ?? []).slice().sort((a, b) => a.issueId.localeCompare(b.issueId));
  const decisions = (input.decisions ?? []).slice().sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  const summary = summarizeGateResults(gateResults);

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    gateResults,
    issues,
    remainingOpenItems,
    fixesApplied,
    decisions,
    summary,
  };
};
