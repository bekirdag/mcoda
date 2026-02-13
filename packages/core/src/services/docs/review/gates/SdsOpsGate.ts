import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsOpsGateInput {
  artifacts: DocgenArtifactInventory;
}

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const extractSection = (
  lines: string[],
  headingMatch: RegExp,
): { content: string[]; line: number } | undefined => {
  let inFence = false;
  let capture = false;
  let startLine = 0;
  const collected: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const title = heading[1]?.trim() ?? "";
      if (headingMatch.test(title)) {
        capture = true;
        startLine = i + 1;
        continue;
      }
      if (capture) break;
    }
    if (capture && trimmed) collected.push(trimmed);
  }
  if (!capture) return undefined;
  return { content: collected, line: startLine };
};

const containsAny = (lines: string[], patterns: RegExp[]): boolean =>
  lines.some((line) => patterns.some((pattern) => pattern.test(line)));

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  record: DocArtifactRecord;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-sds-ops-observability-testing",
  severity: "high",
  category: "completeness",
  artifact: "sds",
  message: input.message,
  remediation: input.remediation,
  location: {
    kind: "line_range",
    path: input.record.path,
    lineStart: input.line ?? 1,
    lineEnd: input.line ?? 1,
    excerpt: input.message,
  },
  metadata: input.metadata,
});

export const runSdsOpsGate = async (input: SdsOpsGateInput): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-ops-observability-testing",
      gateName: "SDS Ops & Observability",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for ops/observability validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);

    const opsSection = extractSection(lines, /operations|deployment|environment/i);
    const observabilitySection = extractSection(lines, /observability|monitoring|slo|alert/i);
    const testingSection = extractSection(lines, /testing|quality|test gates?/i);
    const failureSection = extractSection(lines, /failure|recovery|rollback|incident/i);

    if (!opsSection) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-missing-ops",
          message: "SDS is missing an operations/deployment section.",
          remediation: "Add environment, secrets strategy, and deployment details.",
          record: sds,
          metadata: { issueType: "missing_ops" },
        }),
      );
    } else if (!containsAny(opsSection.content, [/environment/i, /secrets?/i, /deploy/i])) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-incomplete-ops",
          message: "Operations section lacks environment/secrets details.",
          remediation: "Describe deployment environments and secrets handling.",
          record: sds,
          line: opsSection.line,
          metadata: { issueType: "incomplete_ops" },
        }),
      );
    }

    if (!observabilitySection) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-missing-observability",
          message: "SDS is missing an observability section.",
          remediation: "Add SLOs, alerting thresholds, and monitoring targets.",
          record: sds,
          metadata: { issueType: "missing_observability" },
        }),
      );
    } else if (!containsAny(observabilitySection.content, [/slo/i, /alert/i, /threshold/i])) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-incomplete-observability",
          message: "Observability section lacks SLOs or alert thresholds.",
          remediation: "Define SLOs and alert thresholds for critical metrics.",
          record: sds,
          line: observabilitySection.line,
          metadata: { issueType: "incomplete_observability" },
        }),
      );
    }

    if (!testingSection) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-missing-testing",
          message: "SDS is missing a testing gates section.",
          remediation: "Describe test gates and release validation steps.",
          record: sds,
          metadata: { issueType: "missing_testing" },
        }),
      );
    } else if (!containsAny(testingSection.content, [/test/i, /gate/i, /validation/i])) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-incomplete-testing",
          message: "Testing section lacks explicit test gates or validation criteria.",
          remediation: "List required test gates for deployment readiness.",
          record: sds,
          line: testingSection.line,
          metadata: { issueType: "incomplete_testing" },
        }),
      );
    }

    if (!failureSection) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-missing-failure",
          message: "SDS is missing failure modes and recovery procedures.",
          remediation: "Document failure modes and recovery/runbook steps.",
          record: sds,
          metadata: { issueType: "missing_failure" },
        }),
      );
    } else if (!containsAny(failureSection.content, [/failure/i, /recovery/i, /rollback/i])) {
      issues.push(
        buildIssue({
          id: "gate-sds-ops-observability-testing-incomplete-failure",
          message: "Failure section lacks recovery or rollback details.",
          remediation: "Include recovery procedures and rollback steps.",
          record: sds,
          line: failureSection.line,
          metadata: { issueType: "incomplete_failure" },
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-ops-observability-testing",
    gateName: "SDS Ops & Observability",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
