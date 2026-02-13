import { DocArtifactKind } from "../DocgenRunContext.js";
import { normalizeReviewReport, type ReviewReport } from "./ReviewReportSchema.js";
import { sortIssues, type ReviewIssue } from "./ReviewTypes.js";

const ARTIFACT_ORDER: DocArtifactKind[] = ["pdr", "sds", "openapi", "sql", "deployment"];

const statusLabel = (status: string): string => status.toUpperCase();

const formatLocation = (issue: ReviewIssue): string => {
  const location = issue.location;
  if (location.kind === "heading") {
    return location.heading ? `Heading: ${location.heading}` : "Heading: (unspecified)";
  }
  return `Lines ${location.lineStart}-${location.lineEnd}`;
};

const formatIssueLine = (issue: ReviewIssue): string => {
  const location = formatLocation(issue);
  return `- (${issue.severity}) [${issue.gateId}] ${issue.message} (${location}) -> ${issue.remediation}`;
};

const sortArtifacts = (artifacts: DocArtifactKind[]): DocArtifactKind[] => {
  return artifacts.slice().sort((a, b) => {
    const ai = ARTIFACT_ORDER.indexOf(a);
    const bi = ARTIFACT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
};

export const renderReviewReport = (input: ReviewReport): string => {
  const report = normalizeReviewReport(input);
  const lines: string[] = [];

  lines.push("# Docgen Review Report");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Iteration: ${report.iteration.current}/${report.iteration.max} (${report.iteration.status})`);
  lines.push(`- Status: ${statusLabel(report.status)}`);
  lines.push(`- Total issues: ${report.summary.issueCount}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Status: ${statusLabel(report.summary.status)}`);
  lines.push(
    `- Issues: ${report.summary.issueCount} (blocker: ${report.summary.severityCounts.blocker}, high: ${report.summary.severityCounts.high}, medium: ${report.summary.severityCounts.medium}, low: ${report.summary.severityCounts.low}, info: ${report.summary.severityCounts.info})`,
  );
  lines.push(
    `- Gates: fail: ${report.summary.gateCounts.fail}, warn: ${report.summary.gateCounts.warn}, pass: ${report.summary.gateCounts.pass}, skipped: ${report.summary.gateCounts.skipped}`,
  );
  lines.push("");

  if (report.metadata?.iterationReports?.length) {
    lines.push("## Prior Iterations");
    for (const entry of report.metadata.iterationReports) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  lines.push("## Gate Summary");
  if (report.gateResults.length === 0) {
    lines.push("- None");
  } else {
    const sortedGates = report.gateResults.slice().sort((a, b) => a.gateId.localeCompare(b.gateId));
    for (const gate of sortedGates) {
      lines.push(`- ${statusLabel(gate.status)} ${gate.gateId} (${gate.issues.length} issues)`);
    }
  }
  lines.push("");

  lines.push("## Issues by Artifact");
  if (report.issues.length === 0) {
    lines.push("- None");
  } else {
    const grouped = new Map<DocArtifactKind, ReviewIssue[]>();
    for (const issue of sortIssues(report.issues)) {
      const current = grouped.get(issue.artifact) ?? [];
      current.push(issue);
      grouped.set(issue.artifact, current);
    }
    const artifacts = sortArtifacts(Array.from(grouped.keys()));
    for (const artifact of artifacts) {
      lines.push(`### ${artifact}`);
      for (const issue of grouped.get(artifact) ?? []) {
        lines.push(formatIssueLine(issue));
      }
      lines.push("");
    }
  }

  lines.push("## Fixes Applied");
  if (report.fixesApplied.length === 0) {
    lines.push("- None");
  } else {
    const fixes = report.fixesApplied.slice().sort((a, b) => a.issueId.localeCompare(b.issueId));
    for (const fix of fixes) {
      lines.push(`- ${fix.issueId}: ${fix.summary}`);
    }
  }
  lines.push("");

  lines.push("## Remaining Open Items");
  if (report.remainingOpenItems.length === 0) {
    lines.push("- None");
  } else {
    for (const issue of sortIssues(report.remainingOpenItems)) {
      lines.push(formatIssueLine(issue));
    }
  }
  lines.push("");

  lines.push("## Decisions");
  if (report.decisions.length === 0) {
    lines.push("- None");
  } else {
    const decisions = report.decisions.slice().sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    for (const decision of decisions) {
      const related = decision.relatedIssueIds?.length
        ? ` (issues: ${decision.relatedIssueIds.join(", ")})`
        : "";
      lines.push(`- ${decision.summary}: ${decision.rationale}${related}`);
    }
  }
  lines.push("");

  lines.push("## Cross-Document Deltas");
  if (report.deltas.length === 0) {
    lines.push("- None");
  } else {
    const deltas = report.deltas.slice().sort((a, b) => {
      const artifactDiff = sortArtifacts([a.artifact, b.artifact])[0] === a.artifact ? -1 : 1;
      if (a.artifact === b.artifact) return a.path.localeCompare(b.path);
      return artifactDiff;
    });
    for (const delta of deltas) {
      lines.push(`- ${delta.artifact}: ${delta.path} -> ${delta.summary}`);
    }
  }

  return lines.join("\n");
};
