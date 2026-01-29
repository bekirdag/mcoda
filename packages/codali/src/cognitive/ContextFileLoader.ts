import { promises as fs } from "node:fs";
import path from "node:path";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { ContextFileEntry } from "./Types.js";
import type { ContextRedactor } from "./ContextRedactor.js";

export interface ContextFileLoaderOptions {
  workspaceRoot: string;
  readStrategy: "docdex" | "fs";
  focusMaxFileBytes: number;
  peripheryMaxBytes: number;
  skeletonizeLargeFiles: boolean;
  redactor?: ContextRedactor;
}

const normalizePath = (workspaceRoot: string, targetPath: string): string => {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace root");
  }
  return resolved;
};

const estimateTokens = (content: string): number => {
  return Math.max(1, Math.ceil(content.length / 4));
};

const readLineValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "line" in value) {
    const line = (value as { line?: unknown }).line;
    if (typeof line === "number" && Number.isFinite(line)) return line;
  }
  return undefined;
};

const findAstRange = (payload: unknown): { start: number; end: number } | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const nodes = (payload as { nodes?: unknown[] }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const start =
      readLineValue(record.start_line) ??
      readLineValue(record.startLine) ??
      readLineValue(record.start);
    const end =
      readLineValue(record.end_line) ??
      readLineValue(record.endLine) ??
      readLineValue(record.end);
    if (typeof start === "number" && typeof end === "number" && end >= start) {
      ranges.push({ start, end });
    }
  }
  if (!ranges.length) return undefined;
  return ranges.reduce((best, current) => {
    const bestSpan = best.end - best.start;
    const currentSpan = current.end - current.start;
    return currentSpan < bestSpan ? current : best;
  });
};

const buildSkeleton = (
  content: string,
  maxBytes: number,
  symbols?: string,
  forceTruncate = false,
): string => {
  const needsSlice = content.length > maxBytes;
  if (!needsSlice && !forceTruncate) return content;
  const sliceSize = Math.max(1, Math.floor(maxBytes / 2));
  const head = needsSlice ? content.slice(0, sliceSize) : content;
  const tail = needsSlice ? content.slice(-sliceSize) : "";
  const separator = "\n/* ...truncated... */\n";
  const symbolBlock = symbols ? `\n/* symbols */\n${symbols}` : "";
  if (!needsSlice) {
    return `${content}${separator}${symbolBlock}`;
  }
  return `${head}${separator}${tail}${symbolBlock}`;
};

const buildAstSlice = (
  content: string,
  range: { start: number; end: number },
  maxBytes: number,
  symbols?: string,
): { content: string; truncated: boolean } => {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, Math.min(lines.length - 1, range.start - 1));
  const endIndex = Math.max(startIndex, Math.min(lines.length - 1, range.end - 1));
  const slice = lines.slice(startIndex, endIndex + 1).join("\n");
  const separator = "\n/* ...truncated... */\n";
  const symbolBlock = symbols ? `\n/* symbols */\n${symbols}` : "";
  const header = `/* ast_slice lines ${range.start}-${range.end} */\n`;
  const candidate = `${header}${slice}${separator}${symbolBlock}`;
  if (candidate.length > maxBytes) {
    const available = maxBytes - header.length;
    if (available <= 0) {
      return { content: "", truncated: false };
    }
    const skeleton = buildSkeleton(slice, available, symbols, true);
    return { content: `${header}${skeleton}`, truncated: true };
  }
  return { content: candidate, truncated: true };
};

const truncateWithMarker = (content: string, maxBytes: number): string => {
  if (content.length <= maxBytes) return content;
  const marker = "\n/* ...truncated... */\n";
  if (maxBytes <= marker.length) {
    return content.slice(0, maxBytes);
  }
  return `${content.slice(0, maxBytes - marker.length)}${marker}`;
};

const toStringPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

export class ContextFileLoader {
  readonly ignoredPaths: string[] = [];
  redactionCount = 0;

  constructor(private client: DocdexClient, private options: ContextFileLoaderOptions) {}

  async loadFocus(paths: string[]): Promise<ContextFileEntry[]> {
    const results: ContextFileEntry[] = [];
    for (const filePath of paths) {
      if (this.options.redactor?.shouldIgnore(filePath)) {
        this.ignoredPaths.push(filePath);
        continue;
      }
      const resolved = normalizePath(this.options.workspaceRoot, filePath);
      const stats = await fs.stat(resolved);
      const size = stats.size;
      const content = await this.readContent(filePath, this.options.focusMaxFileBytes);
      let truncated = false;
      let sliceStrategy = "full";
      let finalContent = content;
      let redactions = 0;
      const warnings: string[] = [];
      if (size > this.options.focusMaxFileBytes) {
        truncated = true;
        const symbols = await this.safeSymbols(filePath);
        const astRange = await this.safeAstRange(filePath);
        if (this.options.skeletonizeLargeFiles) {
          if (astRange) {
            const astSlice = buildAstSlice(content, astRange, this.options.focusMaxFileBytes, symbols);
            if (astSlice.content) {
              sliceStrategy = "ast_slice";
              finalContent = astSlice.content;
            } else {
              sliceStrategy = "head_tail";
              finalContent = buildSkeleton(content, this.options.focusMaxFileBytes, symbols, true);
            }
          } else {
            sliceStrategy = "head_tail";
            finalContent = buildSkeleton(content, this.options.focusMaxFileBytes, symbols, true);
          }
        } else {
          sliceStrategy = "head";
          finalContent = truncateWithMarker(content, this.options.focusMaxFileBytes);
        }
      }
      if (this.options.redactor) {
        const redacted = this.options.redactor.redact(finalContent);
        finalContent = redacted.content;
        redactions = redacted.redactions;
        if (redactions > 0) {
          warnings.push("redacted");
          this.redactionCount += redactions;
        }
      }
      results.push({
        path: filePath,
        role: "focus",
        content: finalContent,
        size,
        truncated,
        sliceStrategy,
        origin: this.options.readStrategy === "docdex" ? "docdex" : "fs",
        token_estimate: estimateTokens(finalContent),
        warnings: warnings.length ? warnings : undefined,
        redactions: redactions || undefined,
      });
    }
    return results;
  }

  async loadPeriphery(paths: string[]): Promise<ContextFileEntry[]> {
    const results: ContextFileEntry[] = [];
    for (const filePath of paths) {
      if (this.options.redactor?.shouldIgnore(filePath)) {
        this.ignoredPaths.push(filePath);
        continue;
      }
      const symbols = await this.safeSymbols(filePath);
      let content = symbols ?? "";
      const warnings: string[] = [];
      let redactions = 0;
      let truncated = false;
      if (this.options.redactor) {
        const redacted = this.options.redactor.redact(content);
        content = redacted.content;
        redactions = redacted.redactions;
        if (redactions > 0) {
          warnings.push("redacted");
          this.redactionCount += redactions;
        }
      }
      if (content.length > this.options.peripheryMaxBytes) {
        truncated = true;
        content = truncateWithMarker(content, this.options.peripheryMaxBytes);
      }
      results.push({
        path: filePath,
        role: "periphery",
        content,
        size: content.length,
        truncated,
        sliceStrategy: truncated ? "symbols_truncated" : "symbols",
        origin: "docdex",
        token_estimate: estimateTokens(content),
        warnings: warnings.length ? warnings : undefined,
        redactions: redactions || undefined,
      });
    }
    return results;
  }

  private async safeSymbols(filePath: string): Promise<string> {
    try {
      const result = await this.client.symbols(filePath);
      return toStringPayload(result);
    } catch {
      return "";
    }
  }

  private async safeAstRange(filePath: string): Promise<{ start: number; end: number } | undefined> {
    try {
      const result = await this.client.ast(filePath);
      return findAstRange(result);
    } catch {
      return undefined;
    }
  }

  private async readContent(filePath: string, maxBytes: number): Promise<string> {
    if (this.options.readStrategy === "docdex") {
      try {
        const result = await this.client.openFile(filePath, { clamp: true, head: maxBytes });
        return toStringPayload(result);
      } catch {
        // fallback to fs
      }
    }
    const resolved = normalizePath(this.options.workspaceRoot, filePath);
    return fs.readFile(resolved, "utf8");
  }
}
