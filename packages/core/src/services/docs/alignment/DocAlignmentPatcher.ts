import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DocAlignmentGraph } from "./DocAlignmentGraph.js";
import type { DocArtifactKind, DocArtifactRecord, DocgenRunContext } from "../DocgenRunContext.js";
import type { ReviewGateResult, ReviewIssue } from "../review/ReviewTypes.js";
import type { ReviewReportDelta } from "../review/ReviewReportSchema.js";
import { DocPatchEngine, type DocPatchRequest } from "../patch/DocPatchEngine.js";

export interface DocAlignmentPatchInput {
  runContext: DocgenRunContext;
  gateResults: ReviewGateResult[];
  dryRun?: boolean;
}

export interface DocAlignmentPatchResult {
  deltas: ReviewReportDelta[];
  warnings: string[];
}

const API_PREFIX_GATE = "gate-api-path-consistency";
const TERMINOLOGY_GATE = "gate-terminology-normalization";

const hashContent = (content: string): string =>
  crypto.createHash("sha256").update(content).digest("hex");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isLineRange = (issue: ReviewIssue): issue is ReviewIssue & {
  location: { kind: "line_range"; path: string; lineStart: number; lineEnd: number; excerpt?: string };
} => issue.location.kind === "line_range";

const findArtifactRecord = (
  runContext: DocgenRunContext,
  filePath: string,
): DocArtifactRecord | undefined => {
  const normalized = path.resolve(filePath);
  const { artifacts } = runContext;
  if (artifacts.pdr && path.resolve(artifacts.pdr.path) === normalized) return artifacts.pdr;
  if (artifacts.sds && path.resolve(artifacts.sds.path) === normalized) return artifacts.sds;
  if (artifacts.sql && path.resolve(artifacts.sql.path) === normalized) return artifacts.sql;
  for (const record of artifacts.openapi) {
    if (path.resolve(record.path) === normalized) return record;
  }
  for (const record of artifacts.blueprints) {
    if (path.resolve(record.path) === normalized) return record;
  }
  return undefined;
};

const collectIssues = (gateResults: ReviewGateResult[], gateId: string): ReviewIssue[] =>
  gateResults.flatMap((result) => (result.gateId === gateId ? result.issues : []));

const metadataString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const buildApiPrefixReplacement = (issue: ReviewIssue, line: string): {
  nextLine: string;
  summary: string;
} | undefined => {
  const metadata = (issue.metadata ?? {}) as Record<string, unknown>;
  const issueType = metadataString(metadata.issueType);
  if (issueType !== "prefix_mismatch") return undefined;
  const expectedPrefix =
    metadataString(metadata.expectedPrefix) ?? metadataString(metadata.canonicalPrefix);
  const actualPrefix = metadataString(metadata.actualPrefix);
  if (!expectedPrefix || !actualPrefix) return undefined;
  if (!line.includes(actualPrefix)) return undefined;

  const excerpt = isLineRange(issue) ? metadataString(issue.location.excerpt) : undefined;
  let nextLine = line;
  if (excerpt && line.includes(excerpt)) {
    const updated = excerpt.replace(actualPrefix, expectedPrefix);
    if (updated !== excerpt) {
      nextLine = line.replace(excerpt, updated);
    }
  } else {
    nextLine = line.replace(actualPrefix, expectedPrefix);
  }
  if (nextLine === line) return undefined;
  return {
    nextLine,
    summary: `Aligned API prefix to ${expectedPrefix}`,
  };
};

const buildTerminologyReplacement = (issue: ReviewIssue, line: string): {
  nextLine: string;
  summary: string;
} | undefined => {
  const metadata = (issue.metadata ?? {}) as Record<string, unknown>;
  const alias = metadataString(metadata.alias);
  const canonicalTerm = metadataString(metadata.canonicalTerm);
  if (!alias || !canonicalTerm) return undefined;
  const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i");
  if (!pattern.test(line)) return undefined;
  const nextLine = line.replace(pattern, canonicalTerm);
  if (nextLine === line) return undefined;
  return {
    nextLine,
    summary: `Replaced \"${alias}\" with \"${canonicalTerm}\"`,
  };
};

const isRuleTarget = (
  graph: DocAlignmentGraph,
  ruleId: string,
  record: DocArtifactRecord | undefined,
): record is DocArtifactRecord => {
  if (!record) return false;
  const nodes = graph.getImpactedSections(ruleId);
  return nodes.some(
    (node) =>
      node.artifact === record.kind &&
      (node.variant ? node.variant === record.variant : true),
  );
};

export class DocAlignmentPatcher {
  private graph: DocAlignmentGraph;

  constructor(graph?: DocAlignmentGraph) {
    this.graph = graph ?? DocAlignmentGraph.createDefault();
  }

  async apply(input: DocAlignmentPatchInput): Promise<DocAlignmentPatchResult> {
    const warnings: string[] = [];
    const summariesByPath = new Map<string, Set<string>>();
    const issuesByPath = new Map<string, ReviewIssue[]>();

    const apiIssues = collectIssues(input.gateResults, API_PREFIX_GATE);
    const terminologyIssues = collectIssues(input.gateResults, TERMINOLOGY_GATE);

    const queueIssue = (issue: ReviewIssue, ruleId: string): void => {
      if (!isLineRange(issue)) return;
      const record = findArtifactRecord(input.runContext, issue.location.path);
      if (!isRuleTarget(this.graph, ruleId, record)) return;
      const existing = issuesByPath.get(issue.location.path);
      if (existing) {
        existing.push(issue);
      } else {
        issuesByPath.set(issue.location.path, [issue]);
      }
    };

    for (const issue of apiIssues) {
      queueIssue(issue, "api-prefix");
    }
    for (const issue of terminologyIssues) {
      queueIssue(issue, "terminology");
    }

    if (issuesByPath.size === 0) {
      return { deltas: [], warnings: [] };
    }

    const patches: DocPatchRequest[] = [];
    const beforeChecksums = new Map<string, string>();

    for (const [filePath, issues] of issuesByPath.entries()) {
      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        warnings.push(`Alignment patch skipped for ${filePath}: ${(error as Error).message ?? String(error)}`);
        continue;
      }

      beforeChecksums.set(filePath, hashContent(content));
      const lines = content.split(/\r?\n/);
      const operations: DocPatchRequest["operations"] = [];
      const lineReplacements = new Map<number, { line: string; summaries: Set<string> }>();

      for (const issue of issues) {
        if (!isLineRange(issue)) continue;
        const lineIndex = issue.location.lineStart - 1;
        if (lineIndex < 0 || lineIndex >= lines.length) continue;
        const lineState = lineReplacements.get(lineIndex);
        const line = lineState?.line ?? lines[lineIndex] ?? "";
        let replacement:
          | { nextLine: string; summary: string }
          | undefined;

        if (issue.gateId === API_PREFIX_GATE) {
          replacement = buildApiPrefixReplacement(issue, line);
        } else if (issue.gateId === TERMINOLOGY_GATE) {
          replacement = buildTerminologyReplacement(issue, line);
        }

        if (!replacement) continue;
        if (!summariesByPath.has(filePath)) {
          summariesByPath.set(filePath, new Set());
        }
        summariesByPath.get(filePath)?.add(replacement.summary);

        const nextSummaries = lineState?.summaries ?? new Set<string>();
        nextSummaries.add(replacement.summary);
        lineReplacements.set(lineIndex, { line: replacement.nextLine, summaries: nextSummaries });
      }

      const sortedLineEntries = Array.from(lineReplacements.entries()).sort(
        (a, b) => a[0] - b[0],
      );
      for (const [lineIndex, lineState] of sortedLineEntries) {
        const lineNumber = lineIndex + 1;
        operations.push({
          type: "replace_section",
          location: {
            kind: "line_range",
            path: filePath,
            lineStart: lineNumber,
            lineEnd: lineNumber,
          },
          content: lineState.line,
        });
      }

      if (operations.length > 0) {
        patches.push({ path: filePath, operations });
      }
    }

    if (patches.length === 0) {
      return { deltas: [], warnings };
    }

    const engine = new DocPatchEngine();
    const applyResult = await engine.apply({
      runContext: input.runContext,
      patches,
      dryRun: input.dryRun ?? input.runContext.flags.dryRun,
    });

    const deltas: ReviewReportDelta[] = [];
    for (const result of applyResult.results) {
      if (!result.changed) continue;
      let afterContent = "";
      try {
        afterContent = await fs.readFile(result.path, "utf8");
      } catch (error) {
        warnings.push(`Alignment patch wrote ${result.path} but could not read it: ${(error as Error).message ?? String(error)}`);
        continue;
      }
      const beforeChecksum = beforeChecksums.get(result.path);
      const afterChecksum = hashContent(afterContent);
      const record = findArtifactRecord(input.runContext, result.path);
      if (!record) {
        warnings.push(`Alignment patch applied to ${result.path} but no artifact record was found.`);
        continue;
      }
      const summarySet = summariesByPath.get(result.path);
      const summary = summarySet && summarySet.size > 0
        ? Array.from(summarySet.values()).join("; ")
        : "Alignment patch applied.";
      deltas.push({
        artifact: record.kind as DocArtifactKind,
        path: result.path,
        summary,
        beforeChecksum,
        afterChecksum,
      });
    }

    const combinedWarnings = warnings.slice();
    if (applyResult.warnings?.length) {
      combinedWarnings.push(...applyResult.warnings);
    }

    return { deltas, warnings: combinedWarnings };
  }
}
