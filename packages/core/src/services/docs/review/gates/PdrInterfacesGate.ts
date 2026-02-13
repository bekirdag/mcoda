import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";
import { extractOpenApiPaths } from "../../../openapi/OpenApiService.js";

export interface PdrInterfacesGateInput {
  artifacts: DocgenArtifactInventory;
}

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  path?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-pdr-interfaces-pipeline",
  severity: "high",
  category: "completeness",
  artifact: "pdr",
  message: input.message,
  remediation: input.remediation,
  location: input.path
    ? {
        kind: "line_range",
        path: input.path,
        lineStart: input.line ?? 1,
        lineEnd: input.line ?? 1,
        excerpt: input.message,
      }
    : { kind: "heading", heading: "PDR", path: input.path },
  metadata: input.metadata,
});

const extractSection = (lines: string[], headingMatch: RegExp): { content: string[]; line: number } | undefined => {
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
    if (capture) {
      if (trimmed) collected.push(trimmed);
    }
  }
  if (!capture || collected.length === 0) return capture ? { content: [], line: startLine } : undefined;
  return { content: collected, line: startLine };
};

const hasApiPaths = (lines: string[]): boolean => lines.some((line) => /\b(GET|POST|PUT|PATCH|DELETE)\b/i.test(line) || /\/[a-zA-Z0-9]/.test(line));

const mentionsLandingZones = (lines: string[]): boolean =>
  lines.some((line) => /landing zone|staging|raw|warehouse|lake/i.test(line));

const mentionsNormalizationOwner = (lines: string[]): boolean =>
  lines.some((line) => /owner|steward|responsible|ownership|govern/i.test(line));

const loadOpenApiPaths = async (records: DocArtifactRecord[]): Promise<string[]> => {
  for (const record of records) {
    try {
      const raw = await fs.readFile(record.path, "utf8");
      const { paths } = extractOpenApiPaths(raw);
      if (paths.length > 0) return paths;
    } catch {
      // ignore parse issues here; OpenAPI gate handles validation.
    }
  }
  return [];
};

export const runPdrInterfacesGate = async (
  input: PdrInterfacesGateInput,
): Promise<ReviewGateResult> => {
  const pdr = input.artifacts.pdr;
  if (!pdr) {
    return {
      gateId: "gate-pdr-interfaces-pipeline",
      gateName: "PDR Interfaces & Pipeline",
      status: "skipped",
      issues: [],
      notes: ["No PDR artifact available for interface/pipeline validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  try {
    const content = await fs.readFile(pdr.path, "utf8");
    const lines = content.split(/\r?\n/);
    const interfacesSection = extractSection(lines, /interfaces?/i);
    const pipelineSection = extractSection(lines, /pipeline|data flow/i);

    if (!interfacesSection) {
      issues.push(
        buildIssue({
          id: "gate-pdr-interfaces-pipeline-missing-interfaces",
          message: "PDR is missing an Interfaces section.",
          remediation: "Add an Interfaces section listing system interfaces and APIs.",
          path: pdr.path,
          metadata: { issueType: "missing_interfaces" },
        }),
      );
    }

    if (!pipelineSection) {
      issues.push(
        buildIssue({
          id: "gate-pdr-interfaces-pipeline-missing-pipeline",
          message: "PDR is missing a data pipeline model section.",
          remediation: "Add a Pipeline/Data Flow section describing ingestion, normalization, and storage.",
          path: pdr.path,
          metadata: { issueType: "missing_pipeline" },
        }),
      );
    }

    if (interfacesSection && input.artifacts.openapi.length > 0) {
      const openapiPaths = await loadOpenApiPaths(input.artifacts.openapi);
      const hasPaths = hasApiPaths(interfacesSection.content);
      if (openapiPaths.length > 0 && !hasPaths) {
        issues.push(
          buildIssue({
            id: "gate-pdr-interfaces-pipeline-openapi-mismatch",
            message: "PDR interfaces section does not list any API paths while OpenAPI exists.",
            remediation: "List the primary API endpoints in the PDR Interfaces section.",
            path: pdr.path,
            line: interfacesSection.line,
            metadata: { issueType: "interfaces_missing_paths", openapiCount: openapiPaths.length },
          }),
        );
      }
    }

    if (pipelineSection) {
      if (!mentionsLandingZones(pipelineSection.content)) {
        issues.push(
          buildIssue({
            id: "gate-pdr-interfaces-pipeline-missing-landing-zones",
            message: "Pipeline section does not describe data landing zones or storage tiers.",
            remediation: "Include raw/staging/warehouse landing zones in the pipeline description.",
            path: pdr.path,
            line: pipelineSection.line,
            metadata: { issueType: "missing_landing_zones" },
          }),
        );
      }
      if (!mentionsNormalizationOwner(pipelineSection.content)) {
        issues.push(
          buildIssue({
            id: "gate-pdr-interfaces-pipeline-missing-ownership",
            message: "Pipeline section does not name ownership for normalization rules.",
            remediation: "Specify who owns or governs normalization rules in the pipeline model.",
            path: pdr.path,
            line: pipelineSection.line,
            metadata: { issueType: "missing_ownership" },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read PDR ${pdr.path}: ${(error as Error).message ?? String(error)}`);
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-pdr-interfaces-pipeline",
    gateName: "PDR Interfaces & Pipeline",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: { issueCount: issues.length },
  };
};
