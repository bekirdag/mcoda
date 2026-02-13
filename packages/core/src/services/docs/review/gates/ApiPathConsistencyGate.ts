import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";
import { extractOpenApiPaths, normalizeOpenApiPath } from "../../../openapi/OpenApiService.js";

export interface ApiPathConsistencyGateInput {
  artifacts: DocgenArtifactInventory;
}

type ApiPathIssueType = "prefix_mismatch" | "doc_missing_openapi" | "openapi_missing_docs";

interface ExtractedPath {
  path: string;
  normalized: string;
  prefix: string;
  lineNumber: number;
  heading?: string;
  record: DocArtifactRecord;
}

const ISSUE_SEVERITY: Record<ApiPathIssueType, ReviewSeverity> = {
  prefix_mismatch: "high",
  doc_missing_openapi: "high",
  openapi_missing_docs: "medium",
};

const PREFIX_HINTS = new Set(["api", "apis", "internal", "public", "private", "admin"]);
const VERSION_PATTERN = /^v\d+(?:\.\d+)?$/i;
const PATH_PATTERN = /\/[A-Za-z0-9._~{}-]+(?:\/[A-Za-z0-9._~{}-]+)*/g;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const isExampleHeading = (heading: string): boolean => /example|sample/i.test(heading);

const sanitizePath = (candidate: string): string => {
  let cleaned = candidate.trim();
  cleaned = cleaned.replace(/^[`"']+/, "");
  cleaned = cleaned.replace(/[`"'\])},.;:!?]+$/g, "");
  return cleaned;
};

const derivePrefix = (value: string): string => {
  const normalized = normalizeOpenApiPath(value);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0]?.toLowerCase();
  const second = segments[1]?.toLowerCase();
  if (first && PREFIX_HINTS.has(first)) {
    if (second && VERSION_PATTERN.test(second)) {
      return `/${first}/${second}`;
    }
    return `/${first}`;
  }
  if (first && VERSION_PATTERN.test(first)) {
    return `/${first}`;
  }
  return "/";
};

const selectCanonicalPrefix = (paths: ExtractedPath[]): string | undefined => {
  if (paths.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const entry of paths) {
    counts.set(entry.prefix, (counts.get(entry.prefix) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    return a[0].localeCompare(b[0]);
  });
  return sorted[0]?.[0];
};

const buildIssue = (input: {
  issueType: ApiPathIssueType;
  entry: ExtractedPath;
  canonicalPrefix: string;
  expectedPrefix?: string;
  actualPrefix?: string;
}): ReviewIssue => {
  const { issueType, entry, canonicalPrefix, expectedPrefix, actualPrefix } = input;
  let message = "";
  let remediation = "";
  switch (issueType) {
    case "prefix_mismatch":
      message = `Expected API prefix "${expectedPrefix}" but found "${actualPrefix}" in ${entry.path}.`;
      remediation = `Align endpoints to use the canonical prefix "${canonicalPrefix}".`;
      break;
    case "doc_missing_openapi":
      message = `Endpoint "${entry.path}" appears in docs but is not present in OpenAPI.`;
      remediation = "Update OpenAPI paths or remove/adjust the docs endpoint list.";
      break;
    case "openapi_missing_docs":
      message = `OpenAPI endpoint "${entry.path}" is not described in docs.`;
      remediation = "Add this endpoint to PDR/SDS interface sections.";
      break;
    default:
      message = `API path consistency issue detected for ${entry.path}.`;
      remediation = "Align docs and OpenAPI paths.";
  }
  return {
    id: `gate-api-path-consistency-${entry.record.kind}-${issueType}-${entry.lineNumber}`,
    gateId: "gate-api-path-consistency",
    severity: ISSUE_SEVERITY[issueType],
    category: "api",
    artifact: entry.record.kind,
    message,
    remediation,
    location: {
      kind: "line_range",
      path: entry.record.path,
      lineStart: entry.lineNumber,
      lineEnd: entry.lineNumber,
      excerpt: entry.path,
    },
    metadata: {
      issueType,
      canonicalPrefix,
      expectedPrefix,
      actualPrefix,
      normalizedPath: entry.normalized,
      heading: entry.heading,
    },
  };
};

const dedupeByNormalized = (entries: ExtractedPath[]): ExtractedPath[] => {
  const seen = new Set<string>();
  const result: ExtractedPath[] = [];
  for (const entry of entries) {
    const key = `${entry.record.kind}:${entry.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
};

const extractDocPaths = async (record: DocArtifactRecord): Promise<{ paths: ExtractedPath[]; notes: string[] }> => {
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    const lines = content.split(/\r?\n/);
    const paths: ExtractedPath[] = [];
    let inFence = false;
    let allowSection = false;
    let currentHeading: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }

      const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (headingMatch) {
        currentHeading = headingMatch[1]?.trim() || undefined;
        allowSection = currentHeading ? isExampleHeading(currentHeading) : false;
      }

      if (inFence || allowSection) continue;

      const matches = line.matchAll(PATH_PATTERN);
      for (const match of matches) {
        const candidate = sanitizePath(match[0]);
        if (!candidate || candidate === "/" || candidate.startsWith("//")) continue;
        const normalized = normalizeOpenApiPath(candidate);
        if (!normalized || normalized === "/") continue;
        paths.push({
          path: candidate,
          normalized,
          prefix: derivePrefix(normalized),
          lineNumber: i + 1,
          heading: currentHeading,
          record,
        });
      }
    }

    return { paths, notes };
  } catch (error) {
    notes.push(`Unable to scan ${record.path}: ${(error as Error).message ?? String(error)}`);
    return { paths: [], notes };
  }
};

const findOpenApiLine = (lines: string[], target: string): number | undefined => {
  const escaped = escapeRegExp(target);
  const pattern = new RegExp(`^\\s*['"]?${escaped}['"]?\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i] ?? "")) {
      return i + 1;
    }
  }
  return undefined;
};

const extractOpenApiRecords = async (
  records: DocArtifactRecord[],
): Promise<{ paths: ExtractedPath[]; notes: string[] }> => {
  const notes: string[] = [];
  const paths: ExtractedPath[] = [];
  for (const record of records) {
    try {
      const raw = await fs.readFile(record.path, "utf8");
      const result = extractOpenApiPaths(raw);
      if (result.errors.length > 0) {
        notes.push(...result.errors.map((err) => `${record.path}: ${err}`));
      }
      const lines = raw.split(/\r?\n/);
      for (const entry of result.paths) {
        const normalized = normalizeOpenApiPath(entry);
        if (!normalized || normalized === "/") continue;
        const lineNumber = findOpenApiLine(lines, entry) ?? 1;
        paths.push({
          path: entry,
          normalized,
          prefix: derivePrefix(normalized),
          lineNumber,
          record,
        });
      }
    } catch (error) {
      notes.push(`Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`);
    }
  }
  return { paths, notes };
};

export const runApiPathConsistencyGate = async (
  input: ApiPathConsistencyGateInput,
): Promise<ReviewGateResult> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const docRecords = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );
  const openapiCandidates = input.artifacts.openapi ?? [];
  const primaryOpenapi = openapiCandidates.filter((record) => record.variant !== "admin");
  const openapiRecords = primaryOpenapi.length > 0 ? primaryOpenapi : openapiCandidates;

  if (docRecords.length === 0 && openapiRecords.length === 0) {
    return {
      gateId: "gate-api-path-consistency",
      gateName: "API Path Consistency",
      status: "skipped",
      issues,
      notes: ["No PDR/SDS or OpenAPI artifacts available for path consistency checks."],
    };
  }

  const docPathResults = await Promise.all(docRecords.map((record) => extractDocPaths(record)));
  const docPaths = docPathResults.flatMap((result) => result.paths);
  docPathResults.forEach((result) => notes.push(...result.notes));

  const openapiResult = await extractOpenApiRecords(openapiRecords);
  const openapiPaths = openapiResult.paths;
  notes.push(...openapiResult.notes);
  if (openapiRecords.length === 0) {
    notes.push("OpenAPI spec not found; canonical prefix derived from docs.");
  }

  if (docPaths.length === 0 && openapiPaths.length === 0) {
    return {
      gateId: "gate-api-path-consistency",
      gateName: "API Path Consistency",
      status: "skipped",
      issues,
      notes: notes.length > 0 ? notes : ["No API endpoints detected in docs or OpenAPI."],
    };
  }

  const uniqueDocPaths = dedupeByNormalized(docPaths);
  const uniqueOpenapiPaths = dedupeByNormalized(openapiPaths);
  const canonicalPrefix = selectCanonicalPrefix(
    uniqueOpenapiPaths.length > 0 ? uniqueOpenapiPaths : uniqueDocPaths,
  );

  if (!canonicalPrefix) {
    return {
      gateId: "gate-api-path-consistency",
      gateName: "API Path Consistency",
      status: "skipped",
      issues,
      notes: notes.length > 0 ? notes : ["Unable to determine canonical API prefix."],
    };
  }

  for (const entry of uniqueDocPaths) {
    if (entry.prefix !== canonicalPrefix) {
      issues.push(
        buildIssue({
          issueType: "prefix_mismatch",
          entry,
          canonicalPrefix,
          expectedPrefix: canonicalPrefix,
          actualPrefix: entry.prefix,
        }),
      );
    }
  }

  for (const entry of uniqueOpenapiPaths) {
    if (entry.prefix !== canonicalPrefix) {
      issues.push(
        buildIssue({
          issueType: "prefix_mismatch",
          entry,
          canonicalPrefix,
          expectedPrefix: canonicalPrefix,
          actualPrefix: entry.prefix,
        }),
      );
    }
  }

  if (uniqueOpenapiPaths.length > 0) {
    const openapiSet = new Set(uniqueOpenapiPaths.map((entry) => entry.normalized));
    for (const entry of uniqueDocPaths) {
      if (!openapiSet.has(entry.normalized)) {
        issues.push(
          buildIssue({
            issueType: "doc_missing_openapi",
            entry,
            canonicalPrefix,
          }),
        );
      }
    }
  }

  if (uniqueDocPaths.length > 0) {
    const docSet = new Set(uniqueDocPaths.map((entry) => entry.normalized));
    for (const entry of uniqueOpenapiPaths) {
      if (!docSet.has(entry.normalized)) {
        issues.push(
          buildIssue({
            issueType: "openapi_missing_docs",
            entry,
            canonicalPrefix,
          }),
        );
      }
    }
  }

  const status = issues.length > 0 ? "fail" : "pass";
  return {
    gateId: "gate-api-path-consistency",
    gateName: "API Path Consistency",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      canonicalPrefix,
      docPathCount: uniqueDocPaths.length,
      openapiPathCount: uniqueOpenapiPaths.length,
    },
  };
};
