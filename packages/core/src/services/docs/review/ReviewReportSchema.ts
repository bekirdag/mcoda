import {
  type ReviewDecision,
  type ReviewFix,
  type ReviewGateResult,
  type ReviewIssue,
  type ReviewOutcomeStatus,
  type ReviewSummary,
  summarizeGateResults,
} from "./ReviewTypes.js";
import { DocArtifactKind } from "../DocgenRunContext.js";

export interface ReviewReportIteration {
  current: number;
  max: number;
  status: "in_progress" | "completed" | "max_iterations";
}

export interface ReviewReportDelta {
  artifact: DocArtifactKind;
  path: string;
  summary: string;
  beforeChecksum?: string;
  afterChecksum?: string;
}

export interface ReviewReportV1 {
  version: 1;
  generatedAt: string;
  iteration: ReviewReportIteration;
  status: ReviewOutcomeStatus;
  summary: ReviewSummary;
  gateResults: ReviewGateResult[];
  issues: ReviewIssue[];
  remainingOpenItems: ReviewIssue[];
  fixesApplied: ReviewFix[];
  decisions: ReviewDecision[];
  deltas: ReviewReportDelta[];
  metadata?: {
    commandName?: string;
    commandRunId?: string;
    jobId?: string;
    projectKey?: string;
    iterationReports?: string[];
  };
}

export type ReviewReport = ReviewReportV1;

const ensureString = (value: unknown, label: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Review report validation failed: ${label} must be a non-empty string.`);
  }
};

const ensureNumber = (value: unknown, label: string): void => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Review report validation failed: ${label} must be a number.`);
  }
};

const ensureArray = (value: unknown, label: string): void => {
  if (!Array.isArray(value)) {
    throw new Error(`Review report validation failed: ${label} must be an array.`);
  }
};

export const normalizeReviewReport = (report: ReviewReport): ReviewReportV1 => {
  if (report.version !== 1) {
    throw new Error(`Unsupported review report version: ${report.version}`);
  }
  return {
    ...report,
    issues: report.issues ?? [],
    remainingOpenItems: report.remainingOpenItems ?? [],
    fixesApplied: report.fixesApplied ?? [],
    decisions: report.decisions ?? [],
    deltas: report.deltas ?? [],
    summary: report.summary ?? summarizeGateResults(report.gateResults ?? []),
  };
};

export const validateReviewReport = (report: ReviewReport): ReviewReportV1 => {
  const normalized = normalizeReviewReport(report);
  ensureString(normalized.generatedAt, "generatedAt");
  ensureNumber(normalized.iteration?.current, "iteration.current");
  ensureNumber(normalized.iteration?.max, "iteration.max");
  ensureArray(normalized.gateResults, "gateResults");
  ensureArray(normalized.issues, "issues");
  ensureArray(normalized.remainingOpenItems, "remainingOpenItems");
  ensureArray(normalized.fixesApplied, "fixesApplied");
  ensureArray(normalized.decisions, "decisions");
  ensureArray(normalized.deltas, "deltas");
  return normalized;
};

export const serializeReviewReport = (report: ReviewReport): string => {
  const validated = validateReviewReport(report);
  return JSON.stringify(validated, null, 2);
};
