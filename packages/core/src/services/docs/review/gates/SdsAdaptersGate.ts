import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";

export interface SdsAdaptersGateInput {
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
  gateId: "gate-sds-external-adapters",
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

const EXTERNAL_SERVICE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "Brave", pattern: /\bBrave(?:\s+Search)?\b/i },
  { name: "OpenRouter", pattern: /\bOpenRouter\b/i },
  { name: "OpenAI", pattern: /\bOpenAI\b/i },
  { name: "Anthropic", pattern: /\bAnthropic\b/i },
  { name: "Cohere", pattern: /\bCohere\b/i },
  { name: "Mistral", pattern: /\bMistral\b/i },
  { name: "Stripe", pattern: /\bStripe\b/i },
  { name: "Twilio", pattern: /\bTwilio\b/i },
  { name: "SendGrid", pattern: /\bSendGrid\b/i },
  { name: "Sentry", pattern: /\bSentry\b/i },
  { name: "Datadog", pattern: /\bDatadog\b/i },
  { name: "PostHog", pattern: /\bPostHog\b/i },
  { name: "Algolia", pattern: /\bAlgolia\b/i },
];

const ADAPTER_SECTION = /adapter|integration|external|third[- ]?party|provider|vendor|connector|dependency|contract/i;

const CONSTRAINT_PATTERNS = [
  /rate limit/i,
  /quota/i,
  /sla/i,
  /contract/i,
  /auth/i,
  /api key/i,
  /token/i,
  /timeout/i,
  /latency/i,
  /limit/i,
  /pricing/i,
];

const ERROR_HANDLING_PATTERNS = [
  /error/i,
  /retry/i,
  /backoff/i,
  /circuit/i,
  /failover/i,
  /dead[- ]?letter/i,
];

const FALLBACK_PATTERNS = [/fallback/i, /degrade/i, /alternate/i, /secondary/i, /backup/i, /switch/i];

export const runSdsAdaptersGate = async (
  input: SdsAdaptersGateInput,
): Promise<ReviewGateResult> => {
  const sds = input.artifacts.sds;
  if (!sds) {
    return {
      gateId: "gate-sds-external-adapters",
      gateName: "SDS External Adapters",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for external adapter validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(sds.path, "utf8");
    const lines = content.split(/\r?\n/);
    const references = new Map<string, number>();
    let inFence = false;

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      for (const entry of EXTERNAL_SERVICE_PATTERNS) {
        if (entry.pattern.test(line)) {
          if (!references.has(entry.name)) {
            references.set(entry.name, index + 1);
          }
        }
      }
    });

    if (references.size === 0) {
      return {
        gateId: "gate-sds-external-adapters",
        gateName: "SDS External Adapters",
        status: "pass",
        issues: [],
        metadata: { issueCount: 0 },
      };
    }

    const adapterSection = extractSection(lines, ADAPTER_SECTION);
    if (!adapterSection) {
      for (const [service, line] of references.entries()) {
        issues.push(
          buildIssue({
            id: `gate-sds-external-adapters-missing-section-${service.toLowerCase()}`,
            message: `SDS references ${service} but lacks an external adapter section.`,
            remediation: `Add an External Integrations/Adapters section describing constraints, error handling, and fallback for ${service}.`,
            record: sds,
            line,
            metadata: { issueType: "missing_adapter_section", service },
          }),
        );
      }
    } else {
      const adapterText = adapterSection.content.join(" ");
      for (const [service, line] of references.entries()) {
        const pattern = EXTERNAL_SERVICE_PATTERNS.find((entry) => entry.name === service)?.pattern;
        if (pattern && !pattern.test(adapterText)) {
          issues.push(
            buildIssue({
              id: `gate-sds-external-adapters-missing-${service.toLowerCase()}`,
              message: `SDS references ${service} but the adapter details are missing.`,
              remediation: `Describe the ${service} adapter/contract, including constraints, error handling, and fallback behavior.`,
              record: sds,
              line,
              metadata: { issueType: "missing_adapter_description", service },
            }),
          );
        }
      }

      const missing: string[] = [];
      if (!containsAny(adapterSection.content, CONSTRAINT_PATTERNS)) {
        missing.push("constraints");
      }
      if (!containsAny(adapterSection.content, ERROR_HANDLING_PATTERNS)) {
        missing.push("error_handling");
      }
      if (!containsAny(adapterSection.content, FALLBACK_PATTERNS)) {
        missing.push("fallback");
      }
      if (missing.length > 0) {
        issues.push(
          buildIssue({
            id: "gate-sds-external-adapters-missing-details",
            message: `External adapter section is missing ${missing.join(", ")} details.`,
            remediation:
              "Expand the adapter section to document integration constraints, error handling, and fallback behavior.",
            record: sds,
            line: adapterSection.line,
            metadata: { issueType: "missing_adapter_details", missing },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read SDS ${sds.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-sds-external-adapters",
    gateName: "SDS External Adapters",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
