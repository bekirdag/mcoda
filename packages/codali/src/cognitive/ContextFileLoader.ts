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

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);

const isDocPath = (value: string): boolean => {
  const normalized = value.replace(/\\\\/g, "/").toLowerCase();
  if (normalized.startsWith("docs/")) return true;
  const ext = path.extname(normalized);
  if (!ext) return false;
  return DOC_EXTENSIONS.has(ext);
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
  const sliceSize = Math.max(1, Math.floor(maxBytes / 3));
  const head = needsSlice ? content.slice(0, sliceSize) : content;
  const middleStart = Math.max(0, Math.floor(content.length / 2) - Math.floor(sliceSize / 2));
  const middle = needsSlice ? content.slice(middleStart, middleStart + sliceSize) : "";
  const tail = needsSlice ? content.slice(-sliceSize) : "";
  const separator = "\n/* ...truncated... */\n";
  const symbolBlock = symbols ? `\n/* symbols */\n${symbols}` : "";
  if (!needsSlice) {
    return `${content}${separator}${symbolBlock}`;
  }
  return `${head}${separator}${middle}${separator}${tail}${symbolBlock}`;
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

const extractDocdexOpenContent = (payload: unknown): string | undefined => {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as {
    content?: unknown;
    text?: unknown;
    snippet?: { text?: unknown };
    data?: { content?: unknown; text?: unknown };
    file?: { content?: unknown; text?: unknown };
    lines?: unknown;
  };
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  if (record.snippet && typeof record.snippet.text === "string") return record.snippet.text;
  if (record.data && typeof record.data.content === "string") return record.data.content;
  if (record.data && typeof record.data.text === "string") return record.data.text;
  if (record.file && typeof record.file.content === "string") return record.file.content;
  if (record.file && typeof record.file.text === "string") return record.file.text;
  if (Array.isArray(record.lines)) {
    const lines = record.lines
      .map((line) => {
        if (typeof line === "string") return line;
        if (!line || typeof line !== "object") return "";
        const row = line as { text?: unknown; content?: unknown };
        if (typeof row.text === "string") return row.text;
        if (typeof row.content === "string") return row.content;
        return "";
      })
      .filter((line) => line.length > 0);
    if (lines.length > 0) return lines.join("\n");
  }
  return undefined;
};

export class ContextFileLoader {
  readonly ignoredPaths: string[] = [];
  readonly loadErrors: Array<{ path: string; role: "focus" | "periphery"; error: string }> = [];
  redactionCount = 0;

  constructor(private client: DocdexClient, private options: ContextFileLoaderOptions) {}

  async loadFocus(paths: string[]): Promise<ContextFileEntry[]> {
    const results: ContextFileEntry[] = [];
    for (const filePath of paths) {
      if (this.options.redactor?.shouldIgnore(filePath)) {
        this.ignoredPaths.push(filePath);
        continue;
      }
      try {
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
            const astHint = astRange
              ? `/* ast_focus lines ${astRange.start}-${astRange.end} */\n`
              : "";
            sliceStrategy = astRange ? "head_middle_tail_ast_hint" : "head_middle_tail";
            finalContent =
              `${astHint}${buildSkeleton(content, this.options.focusMaxFileBytes, symbols, true)}`;
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
        } else {
          // no-op: keep readable branch for clarity
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
      } catch (error) {
        this.recordLoadError(filePath, "focus", error);
      }
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
      try {
        const docFile = isDocPath(filePath);
        const symbols = docFile ? "" : await this.safeSymbols(filePath);
        let content = docFile
          ? await this.readContent(filePath, this.options.peripheryMaxBytes)
          : symbols ?? "";
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
          sliceStrategy: docFile
            ? truncated
              ? "doc_truncated"
              : "doc_full"
            : truncated
              ? "symbols_truncated"
              : "symbols",
          origin: docFile
            ? this.options.readStrategy === "docdex"
              ? "docdex"
              : "fs"
            : "docdex",
          token_estimate: estimateTokens(content),
          warnings: warnings.length ? warnings : undefined,
          redactions: redactions || undefined,
        });
      } catch (error) {
        this.recordLoadError(filePath, "periphery", error);
      }
    }
    return results;
  }

  private recordLoadError(
    filePath: string,
    role: "focus" | "periphery",
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.loadErrors.push({ path: filePath, role, error: message });
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

  private async readContent(filePath: string, _maxBytes: number): Promise<string> {
    if (this.options.readStrategy === "docdex") {
      try {
        const result = await this.client.openFile(filePath, { clamp: true });
        const extracted = extractDocdexOpenContent(result);
        if (typeof extracted === "string" && extracted.trim().length > 0) {
          return extracted;
        }
      } catch {
        // fallback to fs
      }
    }
    const resolved = normalizePath(this.options.workspaceRoot, filePath);
    return fs.readFile(resolved, "utf8");
  }
}
