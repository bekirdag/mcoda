import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsPolicyTelemetryGateInput {
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
  gateId: "gate-sds-policy-telemetry-metering",
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

export const runSdsPolicyTelemetryGate = async (
  input: SdsPolicyTelemetryGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-policy-telemetry-metering",
      gateName: "SDS Policy, Telemetry & Metering",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for policy/telemetry validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);

    const policySection = extractSection(lines, /policy|cache|consent/i);
    const telemetrySection = extractSection(lines, /telemetry|metrics|logging|events?/i);
    const meteringSection = extractSection(lines, /metering|usage|billing|rate limits?/i);

    if (!policySection) {
      issues.push(
        buildIssue({
          id: "gate-sds-policy-telemetry-metering-missing-policy",
          message: "SDS is missing a policy/cache section.",
          remediation: "Add cache key policy, TTL tiers, and consent matrix details.",
          record: sds,
          metadata: { issueType: "missing_policy" },
        }),
      );
    } else {
      const policyOk = containsAny(policySection.content, [
        /cache key/i,
        /ttl/i,
        /consent matrix/i,
        /consent/i,
      ]);
      if (!policyOk) {
        issues.push(
          buildIssue({
            id: "gate-sds-policy-telemetry-metering-incomplete-policy",
            message: "Policy section lacks cache key/TTL/consent matrix details.",
            remediation: "Include cache key rules, TTL tiers, and a consent matrix.",
            record: sds,
            line: policySection.line,
            metadata: { issueType: "incomplete_policy" },
          }),
        );
      }
    }

    if (!telemetrySection) {
      issues.push(
        buildIssue({
          id: "gate-sds-policy-telemetry-metering-missing-telemetry",
          message: "SDS is missing a telemetry schema section.",
          remediation: "Add telemetry schema definitions for anonymous and identified data.",
          record: sds,
          metadata: { issueType: "missing_telemetry" },
        }),
      );
    } else {
      const telemetryOk = containsAny(telemetrySection.content, [
        /schema/i,
        /anonymous/i,
        /identified/i,
      ]);
      if (!telemetryOk) {
        issues.push(
          buildIssue({
            id: "gate-sds-policy-telemetry-metering-incomplete-telemetry",
            message: "Telemetry section lacks schema details for anonymous/identified data.",
            remediation: "Describe telemetry schemas and how anonymous vs identified data are captured.",
            record: sds,
            line: telemetrySection.line,
            metadata: { issueType: "incomplete_telemetry" },
          }),
        );
      }
    }

    if (!meteringSection) {
      issues.push(
        buildIssue({
          id: "gate-sds-policy-telemetry-metering-missing-metering",
          message: "SDS is missing a metering/usage section.",
          remediation: "Add metering rules and enforcement details.",
          record: sds,
          metadata: { issueType: "missing_metering" },
        }),
      );
    } else {
      const meteringOk = containsAny(meteringSection.content, [
        /meter/i,
        /usage/i,
        /rate/i,
        /limit/i,
        /enforce/i,
      ]);
      if (!meteringOk) {
        issues.push(
          buildIssue({
            id: "gate-sds-policy-telemetry-metering-incomplete-metering",
            message: "Metering section lacks usage tracking or enforcement rules.",
            remediation: "Describe usage tracking, rate limits, and enforcement actions.",
            record: sds,
            line: meteringSection.line,
            metadata: { issueType: "incomplete_metering" },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-policy-telemetry-metering",
    gateName: "SDS Policy, Telemetry & Metering",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
