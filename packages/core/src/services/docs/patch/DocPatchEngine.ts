import path from "node:path";
import { promises as fs } from "node:fs";
import { buildDocInventory } from "../DocInventory.js";
import type { DocgenArtifactInventory, DocgenRunContext } from "../DocgenRunContext.js";
import type { ReviewIssueLocation } from "../review/ReviewTypes.js";

export type DocPatchFormat = "markdown" | "yaml" | "text";
export type DocPatchPosition = "after" | "before" | "append";

export type ReplaceSectionOperation = {
  type: "replace_section";
  location: ReviewIssueLocation;
  content: string;
  headingLevel?: number;
};

export type InsertSectionOperation = {
  type: "insert_section";
  heading: string;
  content: string;
  location?: ReviewIssueLocation;
  position?: DocPatchPosition;
  headingLevel?: number;
};

export type RemoveBlockOperation = {
  type: "remove_block";
  location: ReviewIssueLocation;
};

export type DocPatchOperation =
  | ReplaceSectionOperation
  | InsertSectionOperation
  | RemoveBlockOperation;

export interface DocPatchRequest {
  path: string;
  format?: DocPatchFormat;
  operations: DocPatchOperation[];
}

export interface DocPatchPlanStep {
  operation: DocPatchOperation;
  applied: boolean;
  reason?: string;
  range?: { lineStart: number; lineEnd: number };
}

export interface DocPatchResult {
  path: string;
  format: DocPatchFormat;
  changed: boolean;
  steps: DocPatchPlanStep[];
}

export interface DocPatchApplyInput {
  runContext: DocgenRunContext;
  patches: DocPatchRequest[];
  dryRun?: boolean;
}

export interface DocPatchApplyResult {
  results: DocPatchResult[];
  updatedArtifacts?: DocgenArtifactInventory;
  warnings: string[];
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

const inferFormat = (filePath: string): DocPatchFormat => {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (YAML_EXTENSIONS.has(ext)) return "yaml";
  return "text";
};

const normalizeHeading = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const parseHeadingLine = (line: string): { level: number; text: string } | undefined => {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
  if (!match) return undefined;
  const level = match[1].length;
  const text = match[2].replace(/\s+#*\s*$/, "").trim();
  return { level, text };
};

const splitLines = (content: string): { lines: string[]; hadTrailingNewline: boolean } => {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (hadTrailingNewline && lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { lines, hadTrailingNewline };
};

const joinLines = (lines: string[], hadTrailingNewline: boolean): string => {
  const joined = lines.join("\n");
  if (hadTrailingNewline) return `${joined}\n`;
  return joined;
};

const trimEmptyLines = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
};

const normalizeLineRange = (
  lineStart: number,
  lineEnd: number,
  totalLines: number,
): { start: number; end: number } | undefined => {
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return undefined;
  if (lineStart < 1 || lineEnd < 1) return undefined;
  if (lineStart > lineEnd) return undefined;
  if (totalLines === 0) return undefined;
  const start = Math.max(1, Math.min(totalLines, Math.floor(lineStart)));
  const end = Math.max(1, Math.min(totalLines, Math.floor(lineEnd)));
  if (start > end) return undefined;
  return { start, end };
};

const removeRange = (lines: string[], startIdx: number, endIdx: number): string[] => {
  const next = lines.slice(0, startIdx).concat(lines.slice(endIdx + 1));
  while (startIdx > 0 && startIdx < next.length && next[startIdx] === "" && next[startIdx - 1] === "") {
    next.splice(startIdx, 1);
  }
  if (next[0] === "") next.shift();
  return next;
};

const findHeadingIndex = (lines: string[], heading: string): { index: number; level: number } | undefined => {
  const target = normalizeHeading(heading);
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseHeadingLine(lines[i] ?? "");
    if (!parsed) continue;
    if (normalizeHeading(parsed.text) === target) {
      return { index: i, level: parsed.level };
    }
  }
  return undefined;
};

const findSectionRange = (
  lines: string[],
  headingIndex: number,
  headingLevel: number,
): { start: number; end: number } => {
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const parsed = parseHeadingLine(lines[i] ?? "");
    if (!parsed) continue;
    if (parsed.level <= headingLevel) {
      end = i;
      break;
    }
  }
  return { start: headingIndex, end };
};

const withSectionSpacing = (lines: string[], insertAt: number, sectionLines: string[]): string[] => {
  const needsLeadingBlank = insertAt > 0 && (lines[insertAt - 1]?.trim() ?? "") !== "";
  const needsTrailingBlank = insertAt < lines.length && (lines[insertAt]?.trim() ?? "") !== "";
  const padded = sectionLines.slice();
  if (needsLeadingBlank) padded.unshift("");
  if (needsTrailingBlank) padded.push("");
  return padded;
};

const buildSectionLines = (heading: string, content: string, level?: number): string[] => {
  const headingLevel = Math.min(6, Math.max(1, level ?? 2));
  const headingLine = `${"#".repeat(headingLevel)} ${heading.trim()}`;
  const bodyLines = trimEmptyLines(content.split(/\r?\n/));
  const lines = [headingLine];
  lines.push("");
  if (bodyLines.length > 0) {
    lines.push(...bodyLines);
  }
  return lines;
};

const resolvePreferred = (artifacts: DocgenArtifactInventory): { pdrPath?: string; sdsPath?: string } => ({
  pdrPath: artifacts.pdr?.path,
  sdsPath: artifacts.sds?.path,
});

const applyReplaceSection = (
  lines: string[],
  op: ReplaceSectionOperation,
  format: DocPatchFormat,
  filePath: string,
): { lines: string[]; step: DocPatchPlanStep } => {
  if (op.location.path && path.resolve(op.location.path) !== path.resolve(filePath)) {
    return { lines, step: { operation: op, applied: false, reason: "location path mismatch" } };
  }

  if (op.location.kind === "heading") {
    if (format !== "markdown") {
      return { lines, step: { operation: op, applied: false, reason: "heading replace requires markdown" } };
    }
    const headingMatch = findHeadingIndex(lines, op.location.heading);
    if (!headingMatch) {
      const appended = lines.slice();
      const sectionLines = buildSectionLines(op.location.heading, op.content, op.headingLevel);
      appended.push(...withSectionSpacing(appended, appended.length, sectionLines));
      return {
        lines: appended,
        step: {
          operation: op,
          applied: true,
          reason: "heading not found; appended section",
          range: { lineStart: Math.max(1, appended.length - sectionLines.length + 1), lineEnd: appended.length },
        },
      };
    }
    const { start, end } = findSectionRange(lines, headingMatch.index, headingMatch.level);
    const replacement = buildSectionLines(lines[headingMatch.index] ?? op.location.heading, op.content, headingMatch.level)
      .map((line, idx) => (idx === 0 ? lines[headingMatch.index] ?? line : line));
    const nextLines = lines.slice(0, start).concat(replacement, lines.slice(end));
    return {
      lines: nextLines,
      step: {
        operation: op,
        applied: true,
        range: { lineStart: start + 1, lineEnd: start + replacement.length },
      },
    };
  }

  const range = normalizeLineRange(op.location.lineStart, op.location.lineEnd, lines.length);
  if (!range) {
    return { lines, step: { operation: op, applied: false, reason: "invalid line range" } };
  }
  const bodyLines = trimEmptyLines(op.content.split(/\r?\n/));
  const replacement = bodyLines.length > 0 ? bodyLines : [""];
  const nextLines = lines
    .slice(0, range.start - 1)
    .concat(replacement, lines.slice(range.end));
  return {
    lines: nextLines,
    step: {
      operation: op,
      applied: true,
      range: { lineStart: range.start, lineEnd: range.start + replacement.length - 1 },
    },
  };
};

const applyInsertSection = (
  lines: string[],
  op: InsertSectionOperation,
  format: DocPatchFormat,
  filePath: string,
): { lines: string[]; step: DocPatchPlanStep } => {
  if (format !== "markdown") {
    return { lines, step: { operation: op, applied: false, reason: "insert requires markdown" } };
  }

  const sectionLines = buildSectionLines(op.heading, op.content, op.headingLevel);
  const position = op.position ?? "append";
  let insertAt = lines.length;

  if (position !== "append" && op.location) {
    if (op.location.path && path.resolve(op.location.path) !== path.resolve(filePath)) {
      return { lines, step: { operation: op, applied: false, reason: "location path mismatch" } };
    }
    if (op.location.kind === "heading") {
      const headingMatch = findHeadingIndex(lines, op.location.heading);
      if (headingMatch) {
        if (position === "before") {
          insertAt = headingMatch.index;
        } else {
          const range = findSectionRange(lines, headingMatch.index, headingMatch.level);
          insertAt = range.end;
        }
      }
    } else {
      const range = normalizeLineRange(op.location.lineStart, op.location.lineEnd, lines.length);
      if (range) {
        insertAt = position === "before" ? range.start - 1 : range.end;
      }
    }
  }

  const padded = withSectionSpacing(lines, insertAt, sectionLines);
  const nextLines = lines.slice(0, insertAt).concat(padded, lines.slice(insertAt));
  return {
    lines: nextLines,
    step: {
      operation: op,
      applied: true,
      range: { lineStart: insertAt + 1, lineEnd: insertAt + padded.length },
    },
  };
};

const applyRemoveBlock = (
  lines: string[],
  op: RemoveBlockOperation,
  format: DocPatchFormat,
  filePath: string,
): { lines: string[]; step: DocPatchPlanStep } => {
  if (op.location.path && path.resolve(op.location.path) !== path.resolve(filePath)) {
    return { lines, step: { operation: op, applied: false, reason: "location path mismatch" } };
  }

  if (op.location.kind === "heading") {
    if (format !== "markdown") {
      return { lines, step: { operation: op, applied: false, reason: "heading remove requires markdown" } };
    }
    const headingMatch = findHeadingIndex(lines, op.location.heading);
    if (!headingMatch) {
      return { lines, step: { operation: op, applied: false, reason: "heading not found" } };
    }
    const range = findSectionRange(lines, headingMatch.index, headingMatch.level);
    const nextLines = removeRange(lines, range.start, range.end - 1);
    return {
      lines: nextLines,
      step: {
        operation: op,
        applied: true,
        range: { lineStart: range.start + 1, lineEnd: range.end },
      },
    };
  }

  const range = normalizeLineRange(op.location.lineStart, op.location.lineEnd, lines.length);
  if (!range) {
    return { lines, step: { operation: op, applied: false, reason: "invalid line range" } };
  }
  const nextLines = removeRange(lines, range.start - 1, range.end - 1);
  return {
    lines: nextLines,
    step: {
      operation: op,
      applied: true,
      range: { lineStart: range.start, lineEnd: range.end },
    },
  };
};

export class DocPatchEngine {
  async apply(input: DocPatchApplyInput): Promise<DocPatchApplyResult> {
    const { runContext, patches, dryRun } = input;
    const results: DocPatchResult[] = [];
    const warnings: string[] = [];
    let changedAny = false;

    for (const patch of patches) {
      const format = patch.format ?? inferFormat(patch.path);
      let content = "";
      let steps: DocPatchPlanStep[] = [];
      let hadTrailingNewline = false;
      let lines: string[] = [];

      try {
        content = await fs.readFile(patch.path, "utf8");
        const split = splitLines(content);
        lines = split.lines;
        hadTrailingNewline = split.hadTrailingNewline;
      } catch (error) {
        const message = `Doc patch skipped for ${patch.path}: ${(error as Error).message ?? String(error)}`;
        warnings.push(message);
        steps = patch.operations.map((operation) => ({
          operation,
          applied: false,
          reason: "failed to read file",
        }));
        results.push({ path: patch.path, format, changed: false, steps });
        continue;
      }

      for (const operation of patch.operations) {
        let outcome: { lines: string[]; step: DocPatchPlanStep } | undefined;
        if (operation.type === "replace_section") {
          outcome = applyReplaceSection(lines, operation, format, patch.path);
        } else if (operation.type === "insert_section") {
          outcome = applyInsertSection(lines, operation, format, patch.path);
        } else if (operation.type === "remove_block") {
          outcome = applyRemoveBlock(lines, operation, format, patch.path);
        }
        if (!outcome) continue;
        steps.push(outcome.step);
        if (outcome.step.applied) {
          lines = outcome.lines;
        }
      }

      const nextContent = joinLines(lines, hadTrailingNewline);
      const changed = nextContent !== content;
      changedAny = changedAny || changed;

      if (!dryRun && changed) {
        await fs.writeFile(patch.path, nextContent, "utf8");
      }

      results.push({ path: patch.path, format, changed, steps });
    }

    if (!dryRun && changedAny) {
      try {
        const updatedArtifacts = await buildDocInventory({
          workspace: runContext.workspace,
          preferred: resolvePreferred(runContext.artifacts),
        });
        runContext.artifacts = updatedArtifacts;
      } catch (error) {
        warnings.push(`Doc inventory refresh failed: ${(error as Error).message ?? String(error)}`);
      }
    }

    if (warnings.length > 0) {
      runContext.warnings.push(...warnings);
    }

    return { results, updatedArtifacts: runContext.artifacts, warnings };
  }
}
