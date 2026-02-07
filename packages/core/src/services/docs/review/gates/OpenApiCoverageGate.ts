import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";
import {
  extractOpenApiPaths,
  findOpenApiPathLine,
  normalizeOpenApiPath,
} from "../../../openapi/OpenApiService.js";

export interface OpenApiCoverageGateInput {
  artifacts: DocgenArtifactInventory;
}

type CoverageIssueType = "doc_missing_openapi" | "openapi_missing_docs";

interface EndpointEntry {
  path: string;
  normalized: string;
  lineNumber: number;
  heading?: string;
  record: DocArtifactRecord;
}

const ISSUE_SEVERITY: Record<CoverageIssueType, ReviewSeverity> = {
  doc_missing_openapi: "high",
  openapi_missing_docs: "medium",
};

const RELEVANT_HEADING = /\b(interfaces?|api(?:s)?|endpoints?|routes?|contracts?)\b/i;
const EXAMPLE_HEADING = /example|sample/i;
const PATH_PATTERN = /\/[A-Za-z0-9._~{}-]+(?:\/[A-Za-z0-9._~{}-]+)*/g;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());
const isRelevantHeading = (title: string): boolean => RELEVANT_HEADING.test(title);
const isExampleHeading = (title: string): boolean => EXAMPLE_HEADING.test(title);

const sanitizePath = (candidate: string): string => {
  let cleaned = candidate.trim();
  cleaned = cleaned.replace(/^[`"'\\[(]+/, "");
  cleaned = cleaned.replace(/[`"',.;:!?]+$/g, "");
  cleaned = cleaned.replace(/[\]\)}]+$/g, "");
  return cleaned;
};

const extractPathsFromLine = (line: string): string[] => {
  const results: string[] = [];
  const urls = line.match(URL_PATTERN) ?? [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname && parsed.pathname !== "/") {
        results.push(parsed.pathname);
      }
    } catch {
      // ignore invalid URLs
    }
  }
  const scrubbed = line.replace(URL_PATTERN, " ");
  const matches = scrubbed.matchAll(PATH_PATTERN);
  for (const match of matches) {
    const candidate = sanitizePath(match[0] ?? "");
    if (!candidate || candidate === "/" || candidate.startsWith("//")) continue;
    results.push(candidate);
  }
  return results;
};

const extractDocEndpoints = async (
  record: DocArtifactRecord,
): Promise<{ entries: EndpointEntry[]; notes: string[] }> => {
  const entries: EndpointEntry[] = [];
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let capture = false;
    let sectionLevel = 0;
    let skipExample = false;
    let skipLevel = 0;
    let currentHeading: string | undefined;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      if (isFenceLine(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1]?.length ?? 0;
        if (skipExample && level <= skipLevel) {
          skipExample = false;
        }
        const title = headingMatch[2]?.trim() ?? "";
        currentHeading = title || undefined;
        const relevant = isRelevantHeading(title);
        if (relevant) {
          capture = true;
          sectionLevel = level;
          skipExample = isExampleHeading(title);
          skipLevel = skipExample ? level : 0;
          continue;
        }
        if (capture && level <= sectionLevel) {
          capture = false;
        }
        if (capture && isExampleHeading(title)) {
          skipExample = true;
          skipLevel = level;
        }
        continue;
      }

      if (!capture || skipExample || !trimmed) continue;

      const candidates = extractPathsFromLine(line);
      for (const candidate of candidates) {
        const normalized = normalizeOpenApiPath(candidate);
        if (!normalized || normalized === "/") continue;
        entries.push({
          path: candidate,
          normalized,
          lineNumber: i + 1,
          heading: currentHeading,
          record,
        });
      }
    }
  } catch (error) {
    notes.push(`Unable to read doc ${record.path}: ${(error as Error).message ?? String(error)}`);
  }
  return { entries, notes };
};

const extractOpenApiEndpoints = async (
  records: DocArtifactRecord[],
): Promise<{ entries: EndpointEntry[]; notes: string[] }> => {
  const entries: EndpointEntry[] = [];
  const notes: string[] = [];
  for (const record of records) {
    try {
      const raw = await fs.readFile(record.path, "utf8");
      const result = extractOpenApiPaths(raw);
      if (result.errors.length > 0) {
        notes.push(...result.errors.map((error) => `${record.path}: ${error}`));
      }
      for (const entry of result.paths) {
        const normalized = normalizeOpenApiPath(entry);
        if (!normalized || normalized === "/") continue;
        const lineNumber = findOpenApiPathLine(raw, entry) ?? 1;
        entries.push({
          path: entry,
          normalized,
          lineNumber,
          record,
        });
      }
    } catch (error) {
      notes.push(
        `Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`,
      );
    }
  }
  return { entries, notes };
};

const dedupeByNormalized = (entries: EndpointEntry[]): EndpointEntry[] => {
  const seen = new Set<string>();
  const result: EndpointEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    result.push(entry);
  }
  return result;
};

const summarizePaths = (label: string, entries: EndpointEntry[]): string | undefined => {
  if (entries.length === 0) return undefined;
  const preview = entries.slice(0, 5).map((entry) => entry.path).join(", ");
  const suffix = entries.length > 5 ? ` (+${entries.length - 5} more)` : "";
  return `${label} (${entries.length}): ${preview}${suffix}`;
};

const buildIssue = (input: { issueType: CoverageIssueType; entry: EndpointEntry }): ReviewIssue => {
  const { issueType, entry } = input;
  let message = "";
  let remediation = "";
  switch (issueType) {
    case "doc_missing_openapi":
      message = `Endpoint "${entry.path}" appears in docs but is missing from OpenAPI.`;
      remediation = "Add the endpoint to OpenAPI or remove it from the interface list.";
      break;
    case "openapi_missing_docs":
      message = `OpenAPI endpoint "${entry.path}" is not mentioned in docs interface/API sections.`;
      remediation = "Document the endpoint in the Interfaces/API sections.";
      break;
    default:
      message = `OpenAPI coverage issue detected for ${entry.path}.`;
      remediation = "Align doc interface lists with OpenAPI.";
  }
  return {
    id: `gate-openapi-endpoint-coverage-${entry.record.kind}-${issueType}-${entry.lineNumber}`,
    gateId: "gate-openapi-endpoint-coverage",
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
      normalizedPath: entry.normalized,
      heading: entry.heading,
    },
  };
};

export const runOpenApiCoverageGate = async (
  input: OpenApiCoverageGateInput,
): Promise<ReviewGateResult> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  const docRecords = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );
  const openapiRecords = input.artifacts.openapi ?? [];

  if (docRecords.length === 0 && openapiRecords.length === 0) {
    return {
      gateId: "gate-openapi-endpoint-coverage",
      gateName: "OpenAPI Endpoint Coverage",
      status: "skipped",
      issues,
      notes: ["No PDR/SDS or OpenAPI artifacts available for endpoint coverage checks."],
    };
  }

  if (docRecords.length === 0) {
    notes.push("No PDR/SDS artifacts available for endpoint coverage checks.");
  }
  if (openapiRecords.length === 0) {
    notes.push("No OpenAPI artifacts available for endpoint coverage checks.");
  }

  const docResults = await Promise.all(docRecords.map((record) => extractDocEndpoints(record)));
  const docEntries = docResults.flatMap((result) => result.entries);
  docResults.forEach((result) => notes.push(...result.notes));

  const openapiResult = await extractOpenApiEndpoints(openapiRecords);
  const openapiEntries = openapiResult.entries;
  notes.push(...openapiResult.notes);

  if (docEntries.length === 0 && openapiEntries.length === 0) {
    return {
      gateId: "gate-openapi-endpoint-coverage",
      gateName: "OpenAPI Endpoint Coverage",
      status: "skipped",
      issues,
      notes: notes.length > 0 ? notes : ["No endpoints detected in docs or OpenAPI."],
    };
  }

  const uniqueDocEntries = dedupeByNormalized(docEntries);
  const uniqueOpenapiEntries = dedupeByNormalized(openapiEntries);

  const openapiSet = new Set(uniqueOpenapiEntries.map((entry) => entry.normalized));
  const docSet = new Set(uniqueDocEntries.map((entry) => entry.normalized));

  const docMissing = uniqueDocEntries.filter((entry) => !openapiSet.has(entry.normalized));
  const openapiMissing = uniqueOpenapiEntries.filter((entry) => !docSet.has(entry.normalized));

  for (const entry of docMissing) {
    issues.push(buildIssue({ issueType: "doc_missing_openapi", entry }));
  }
  for (const entry of openapiMissing) {
    issues.push(buildIssue({ issueType: "openapi_missing_docs", entry }));
  }

  const docSummary = summarizePaths("Doc endpoints missing in OpenAPI", docMissing);
  if (docSummary) notes.push(docSummary);
  const openapiSummary = summarizePaths("OpenAPI endpoints missing in docs", openapiMissing);
  if (openapiSummary) notes.push(openapiSummary);

  const status = issues.length > 0 ? "fail" : "pass";
  return {
    gateId: "gate-openapi-endpoint-coverage",
    gateName: "OpenAPI Endpoint Coverage",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: {
      docPathCount: uniqueDocEntries.length,
      openapiPathCount: uniqueOpenapiEntries.length,
      docMissingCount: docMissing.length,
      openapiMissingCount: openapiMissing.length,
    },
  };
};
