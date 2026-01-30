import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { AgentEvent, AgentStatusPhase, Provider } from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type {
  AgentRequest,
  CodaliResponse,
  CodaliResponseResult,
  NormalizedNeed,
} from "../agents/AgentProtocol.js";
import { normalizeAgentRequest } from "../agents/AgentProtocol.js";
import { expandQueriesWithProvider, extractQueries } from "./QueryExtraction.js";
import { extractPreferences } from "./PreferenceExtraction.js";
import { selectContextFiles } from "./ContextSelector.js";
import { ContextFileLoader } from "./ContextFileLoader.js";
import { ContextRedactor } from "./ContextRedactor.js";
import { serializeContext } from "./ContextSerializer.js";
import type { ContextManager } from "./ContextManager.js";
import type {
  ContextBundle,
  ContextFileEntry,
  ContextImpactSummary,
  ContextImpactDiagnostics,
  ContextSnippet,
  ContextSymbolSummary,
  ContextAstSummary,
  LaneScope,
} from "./Types.js";

export interface ContextAssemblerOptions {
  maxQueries?: number;
  maxHitsPerQuery?: number;
  snippetWindow?: number;
  impactMaxDepth?: number;
  impactMaxEdges?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  tokenBudget?: number;
  includeRepoMap?: boolean;
  includeImpact?: boolean;
  includeSnippets?: boolean;
  workspaceRoot?: string;
  readStrategy?: "docdex" | "fs";
  focusMaxFileBytes?: number;
  peripheryMaxBytes?: number;
  skeletonizeLargeFiles?: boolean;
  serializationMode?: "bundle_text" | "json";
  redactSecrets?: boolean;
  redactPatterns?: string[];
  ignoreFilesFrom?: string[];
  readOnlyPaths?: string[];
  allowDocEdits?: boolean;
  preferredFiles?: string[];
  recentFiles?: string[];
  skipSearchWhenPreferred?: boolean;
  queryProvider?: Provider;
  queryTemperature?: number;
  agentId?: string;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
  onEvent?: (event: AgentEvent) => void;
  logger?: RunLogger;
}

const toStringPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const execFileAsync = promisify(execFile);

const collectHits = (result: unknown): Array<{ doc_id?: string; path?: string }> => {
  if (!result || typeof result !== "object") return [];
  const hits = (result as { hits?: Array<{ doc_id?: string; path?: string }> }).hits;
  if (!Array.isArray(hits)) return [];
  return hits;
};

const extractFileHints = (result: unknown): string[] => {
  if (!result || typeof result !== "object") return [];
  const record = result as {
    results?: Array<{ rel_path?: string; path?: string }>;
    files?: string[];
  };
  if (Array.isArray(record.files)) {
    return record.files.filter((entry) => typeof entry === "string" && entry.length > 0);
  }
  if (!Array.isArray(record.results)) return [];
  return record.results
    .map((entry) => entry.rel_path ?? entry.path)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

const uniqueValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.?\//, "");

const resolveWorkspacePath = (workspaceRoot: string, targetPath: string): string => {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace root");
  }
  return resolved;
};

const IMPACT_GRAPH_EXTENSIONS = new Set([
  ".rs",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hh",
  ".hpp",
  ".hxx",
  ".php",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".lua",
  ".dart",
]);

const FRONTEND_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
]);

const FRONTEND_GLOBS = [
  "*.html",
  "*.htm",
  "*.css",
  "*.scss",
  "*.sass",
  "*.less",
  "*.styl",
  "*.jsx",
  "*.tsx",
  "*.vue",
  "*.svelte",
];

const EXCLUDED_WALK_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".docdex",
  ".mcoda",
  ".cache",
  "tmp",
]);

const supportsImpactGraph = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = normalized.slice(lastDot);
  return IMPACT_GRAPH_EXTENSIONS.has(ext);
};

const isDocPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  return (
    normalized.startsWith("docs/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  );
};

const reorderHits = (
  hits: Array<{ doc_id?: string; path?: string }>,
): Array<{ doc_id?: string; path?: string }> => {
  const hasNonDoc = hits.some(
    (hit) => hit.path && !isDocPath(hit.path),
  );
  if (!hasNonDoc) return hits;
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => {
      const aDoc = a.hit.path ? isDocPath(a.hit.path) : false;
      const bDoc = b.hit.path ? isDocPath(b.hit.path) : false;
      if (aDoc === bDoc) return a.index - b.index;
      return aDoc ? 1 : -1;
    })
    .map(({ hit }) => hit);
};

const inferPreferredFiles = (request: string, fileHints: string[]): string[] => {
  if (!fileHints.length) return [];
  const wantsHtml =
    /\b(html|index\.html|root page|landing page|landing|home page|homepage|welcome|header|hero)\b/i.test(
      request,
    );
  const wantsCss = /\b(css|styles?|styling|theme|layout|colors?)\b/i.test(request);
  if (!wantsHtml && !wantsCss) return [];
  const normalizedHints = fileHints.map(normalizePath);
  const extensions = new Set<string>();
  if (wantsHtml) {
    extensions.add(".html");
    extensions.add(".htm");
  }
  if (wantsCss) {
    extensions.add(".css");
    extensions.add(".scss");
    extensions.add(".sass");
    extensions.add(".less");
    extensions.add(".styl");
  }
  const candidates = normalizedHints.filter((value) => {
    const normalized = value.toLowerCase();
    const dot = normalized.lastIndexOf(".");
    if (dot === -1) return false;
    return extensions.has(normalized.slice(dot));
  });
  if (!candidates.length) return [];
  const score = (value: string) => {
    const normalized = value.toLowerCase();
    let points = 0;
    if (normalized.endsWith("index.html") || normalized.endsWith("index.htm")) {
      points += 5;
    }
    if (normalized.includes("/public/") || normalized.includes("src/public")) {
      points += 3;
    }
    if (normalized.includes("index")) points += 2;
    if (normalized.includes("style") || normalized.includes("theme")) points += 1;
    return points;
  };
  return candidates
    .map((value) => ({ value, score: score(value) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.value)
    .slice(0, 3);
};

const listWorkspaceFiles = async (workspaceRoot: string, globs: string[]): Promise<string[]> => {
  try {
    const args = ["--files", ...globs.flatMap((glob) => ["-g", glob])];
    const { stdout } = await execFileAsync("rg", args, { cwd: workspaceRoot });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    const results: string[] = [];
    const queue: string[] = [workspaceRoot];
    while (queue.length > 0 && results.length < 2000) {
      const current = queue.shift();
      if (!current) continue;
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          if (EXCLUDED_WALK_DIRS.has(entry.name)) continue;
          queue.push(path.join(current, entry.name));
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!FRONTEND_EXTENSIONS.has(ext)) continue;
        const rel = path.relative(workspaceRoot, path.join(current, entry.name));
        results.push(rel);
        if (results.length >= 2000) break;
      }
    }
    return results;
  }
};

const matchPattern = (relativePath: string, pattern?: string): boolean => {
  if (!pattern || pattern === "*" || pattern === "**/*") return true;
  const extMatch = pattern.match(/\*\.\*$/);
  if (extMatch) return true;
  const extOnly = pattern.match(/\*\.([a-z0-9]+)$/i);
  if (extOnly) {
    return relativePath.toLowerCase().endsWith(`.${extOnly[1].toLowerCase()}`);
  }
  const normalizedPattern = pattern.replace(/\*\*/g, "").replace(/\*/g, "");
  if (!normalizedPattern) return true;
  return relativePath.includes(normalizedPattern);
};

const listWorkspaceFilesByPattern = async (
  workspaceRoot: string,
  root: string,
  pattern?: string,
): Promise<string[]> => {
  const normalizedRoot = normalizePath(root || ".");
  const args = ["--files"];
  if (pattern) {
    args.push("-g", pattern);
  }
  if (normalizedRoot && normalizedRoot !== ".") {
    args.push(normalizedRoot);
  }
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd: workspaceRoot });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    const results: string[] = [];
    const resolvedRoot = resolveWorkspacePath(workspaceRoot, normalizedRoot || ".");
    const queue: string[] = [resolvedRoot];
    while (queue.length > 0 && results.length < 5000) {
      const current = queue.shift();
      if (!current) continue;
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          if (EXCLUDED_WALK_DIRS.has(entry.name)) continue;
          queue.push(path.join(current, entry.name));
          continue;
        }
        const rel = path.relative(workspaceRoot, path.join(current, entry.name));
        if (!matchPattern(rel, pattern)) continue;
        results.push(rel);
        if (results.length >= 5000) break;
      }
    }
    return results;
  }
};

const hasDiagnostics = (diagnostics: unknown): boolean => {
  if (!diagnostics) return false;
  if (Array.isArray(diagnostics)) return diagnostics.length > 0;
  if (typeof diagnostics !== "object") return false;
  const record = diagnostics as Record<string, unknown>;
  const candidates = [
    record.diagnostics,
    record.unresolved,
    record.errors,
    record.missing,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return true;
  }
  return Object.keys(record).length > 0;
};

const estimateTokens = (content: string, provided?: number): number => {
  if (typeof provided === "number" && Number.isFinite(provided)) return provided;
  return Math.max(1, Math.ceil(content.length / 4));
};

const truncateWithMarker = (content: string, maxBytes: number): string => {
  if (content.length <= maxBytes) return content;
  const marker = "\n/* ...truncated... */\n";
  if (maxBytes <= marker.length) {
    return content.slice(0, maxBytes);
  }
  return `${content.slice(0, maxBytes - marker.length)}${marker}`;
};

const applyContextBudget = (
  files: ContextFileEntry[],
  maxTotalBytes: number,
  tokenBudget: number,
): {
  files: ContextFileEntry[];
  droppedPaths: string[];
  trimmed: boolean;
  totalBytes: number;
  totalTokens: number;
} => {
  const maxBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 0;
  const maxTokens = Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : 0;
  const clone = files.map((file) => ({
    ...file,
    warnings: file.warnings ? [...file.warnings] : undefined,
  }));
  const droppedPaths: string[] = [];
  let trimmed = false;

  const totals = () => {
    const totalBytes = clone.reduce((sum, entry) => sum + entry.content.length, 0);
    const totalTokens = clone.reduce(
      (sum, entry) => sum + estimateTokens(entry.content, entry.token_estimate),
      0,
    );
    return { totalBytes, totalTokens };
  };

  const overBudget = () => {
    const { totalBytes, totalTokens } = totals();
    if (maxBytes && totalBytes > maxBytes) return true;
    if (maxTokens && totalTokens > maxTokens) return true;
    return false;
  };

  const dropPeriphery = () => {
    const index = [...clone].reverse().findIndex((entry) => entry.role === "periphery");
    if (index === -1) return false;
    const removeIndex = clone.length - 1 - index;
    const [removed] = clone.splice(removeIndex, 1);
    if (removed) {
      droppedPaths.push(removed.path);
      trimmed = true;
    }
    return true;
  };

  while (overBudget() && dropPeriphery()) {
    // drop periphery until within budget
  }

  let guard = 0;
  while (overBudget() && clone.length > 0 && guard < clone.length * 4) {
    const { totalBytes, totalTokens } = totals();
    const bytesOver = maxBytes ? Math.max(0, totalBytes - maxBytes) : 0;
    const tokensOver = maxTokens ? Math.max(0, totalTokens - maxTokens) : 0;
    const reduceBy = Math.max(bytesOver, tokensOver * 4);
    if (reduceBy <= 0) break;
    const index = clone.length - 1;
    const entry = clone[index];
    const targetLength = Math.max(1, entry.content.length - reduceBy);
    if (targetLength >= entry.content.length) break;
    const updatedContent = truncateWithMarker(entry.content, targetLength);
    clone[index] = {
      ...entry,
      content: updatedContent,
      truncated: true,
      sliceStrategy: "budget_trim",
      token_estimate: estimateTokens(updatedContent),
      warnings: entry.warnings?.includes("budget_trim")
        ? entry.warnings
        : [...(entry.warnings ?? []), "budget_trim"],
    };
    trimmed = true;
    guard += 1;
  }

  const { totalBytes, totalTokens } = totals();
  return { files: clone, droppedPaths, trimmed, totalBytes, totalTokens };
};

type ContextAssemblerResolvedOptions = Required<
  Omit<
    ContextAssemblerOptions,
    | "queryProvider"
    | "queryTemperature"
    | "agentId"
    | "contextManager"
    | "laneScope"
    | "onEvent"
    | "logger"
  >
>;

export class ContextAssembler {
  private client: DocdexClient;
  private options: ContextAssemblerResolvedOptions;
  private queryProvider?: Provider;
  private queryTemperature?: number;
  private agentId?: string;
  private contextManager?: ContextManager;
  private laneScope?: Omit<LaneScope, "role" | "ephemeral">;
  private onEvent?: (event: AgentEvent) => void;
  private logger?: RunLogger;

  constructor(client: DocdexClient, options: ContextAssemblerOptions = {}) {
    this.client = client;
    this.options = {
      maxQueries: options.maxQueries ?? 3,
      maxHitsPerQuery: options.maxHitsPerQuery ?? 3,
      snippetWindow: options.snippetWindow ?? 120,
      impactMaxDepth: options.impactMaxDepth ?? 2,
      impactMaxEdges: options.impactMaxEdges ?? 80,
      maxFiles: options.maxFiles ?? 8,
      maxTotalBytes: options.maxTotalBytes ?? 40_000,
      tokenBudget: options.tokenBudget ?? 120_000,
      includeRepoMap: options.includeRepoMap ?? true,
      includeImpact: options.includeImpact ?? true,
      includeSnippets: options.includeSnippets ?? true,
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      readStrategy: options.readStrategy ?? "docdex",
      focusMaxFileBytes: options.focusMaxFileBytes ?? 12_000,
      peripheryMaxBytes: options.peripheryMaxBytes ?? 4_000,
      skeletonizeLargeFiles: options.skeletonizeLargeFiles ?? true,
      serializationMode: options.serializationMode ?? "bundle_text",
      redactSecrets: options.redactSecrets ?? false,
      redactPatterns: options.redactPatterns ?? [],
      ignoreFilesFrom: options.ignoreFilesFrom ?? [],
      readOnlyPaths: options.readOnlyPaths ?? [],
      allowDocEdits: options.allowDocEdits ?? false,
      preferredFiles: options.preferredFiles ?? [],
      recentFiles: options.recentFiles ?? [],
      skipSearchWhenPreferred: options.skipSearchWhenPreferred ?? false,
    };
    this.queryProvider = options.queryProvider;
    this.queryTemperature = options.queryTemperature;
    this.agentId = options.agentId ?? "codali";
    this.contextManager = options.contextManager;
    this.laneScope = options.laneScope;
    this.onEvent = options.onEvent;
    this.logger = options.logger;
  }

  async assemble(
    request: string,
    options: {
      additionalQueries?: string[];
      preferredFiles?: string[];
      recentFiles?: string[];
    } = {},
  ): Promise<ContextBundle> {
    const warnings: string[] = [];
    const pushWarning = (warning: string): void => {
      if (!warnings.includes(warning)) warnings.push(warning);
    };
    const emit = this.onEvent;
    const emitStatus = (phase: AgentStatusPhase, message?: string) => {
      emit?.({ type: "status", phase, message });
    };
    const emitToolCall = (name: string, args?: unknown) => {
      emit?.({ type: "tool_call", name, args: args ?? {} });
    };
    const emitToolResult = (name: string, output: string, ok = true) => {
      emit?.({ type: "tool_result", name, output, ok });
    };
    emitStatus("thinking", "librarian: start");
    const baseQueries = extractQueries(request, this.options.maxQueries);
    const supplementalQueries = uniqueValues(options.additionalQueries ?? []);
    let queries = uniqueValues([...supplementalQueries, ...baseQueries]).slice(
      0,
      Math.max(1, this.options.maxQueries),
    );
    const preferencesDetected = extractPreferences(request);
    const preferredSeed = uniqueValues([
      ...(this.options.preferredFiles ?? []),
      ...(options.preferredFiles ?? []),
    ]);
    const recentFiles = uniqueValues([
      ...(this.options.recentFiles ?? []),
      ...(options.recentFiles ?? []),
    ]);
    const contextManager = this.contextManager;
    const laneScope = this.laneScope;

    emitToolCall("docdex.health", {});
    try {
      await this.client.healthCheck();
      emitToolResult("docdex.health", "ok", true);
    } catch (error) {
      emitToolResult(
        "docdex.health",
        error instanceof Error ? error.message : String(error),
        false,
      );
      pushWarning("docdex_unavailable");
      return {
        request,
        queries,
        snippets: [],
        symbols: [],
        ast: [],
        impact: [],
        impact_diagnostics: [],
        memory: [],
        preferences_detected: preferencesDetected,
        profile: [],
        index: { last_updated_epoch_ms: 0, num_docs: 0 },
        warnings,
      };
    }
    if (!this.client.getRepoId()) {
      const repoRoot = this.client.getRepoRoot();
      if (repoRoot) {
        const rootUri = repoRoot.startsWith("file://") ? repoRoot : `file://${repoRoot}`;
        try {
          emitToolCall("docdex.initialize", { rootUri });
          await this.client.initialize(rootUri);
          emitToolResult("docdex.initialize", "ok", true);
        } catch {
          emitToolResult("docdex.initialize", "failed", false);
          pushWarning("docdex_initialize_failed");
        }
      }
    }
    let stats: unknown = { last_updated_epoch_ms: 0, num_docs: 0 };
    let statsSucceeded = false;
    try {
      emitToolCall("docdex.stats", {});
      stats = await this.client.stats();
      statsSucceeded = true;
      emitToolResult("docdex.stats", "ok", true);
    } catch {
      emitToolResult("docdex.stats", "failed", false);
      pushWarning("docdex_stats_failed");
    }
    let fileHints: string[] = [];
    let filesSucceeded = false;
    try {
      emitToolCall("docdex.files", { limit: 20, offset: 0 });
      const filesResult = await this.client.files(20, 0);
      fileHints = extractFileHints(filesResult);
      filesSucceeded = true;
      emitToolResult("docdex.files", "ok", true);
    } catch {
      emitToolResult("docdex.files", "failed", false);
      pushWarning("docdex_files_failed");
    }

    let inferredPreferred = inferPreferredFiles(request, fileHints);
    const wantsFrontend = /\\b(html|css|landing page|homepage|style|theme)\\b/i.test(request);
    if (wantsFrontend && inferredPreferred.length === 0 && fileHints.length < 5 && this.options.workspaceRoot) {
      const fsHints = await listWorkspaceFiles(this.options.workspaceRoot, FRONTEND_GLOBS);
      if (fsHints.length) {
        fileHints = uniqueValues([...fileHints, ...fsHints]);
        inferredPreferred = inferPreferredFiles(request, fileHints);
      }
    }
    const preferredFiles = uniqueValues([...preferredSeed, ...inferredPreferred]);
    const skipSearchWhenPreferred =
      this.options.skipSearchWhenPreferred && preferredFiles.length > 0;

    const runSearch = async (queriesToUse: string[]) => {
      const hitList: Array<{ doc_id?: string; path?: string }> = [];
      let searchSucceeded = false;
      for (const query of queriesToUse) {
        try {
          emitToolCall("docdex.search", { query, limit: this.options.maxHitsPerQuery });
          const result = await this.client.search(query, { limit: this.options.maxHitsPerQuery });
          hitList.push(...collectHits(result));
          searchSucceeded = true;
          emitToolResult("docdex.search", "ok", true);
        } catch {
          emitToolResult("docdex.search", "failed", false);
          pushWarning("docdex_search_failed");
        }
      }
      return { hitList, searchSucceeded };
    };

    let hitList: Array<{ doc_id?: string; path?: string }> = [];
    let searchSucceeded = false;
    if (skipSearchWhenPreferred) {
      searchSucceeded = true;
      warnings.push("docdex_search_skipped");
    } else {
      emitStatus("thinking", "librarian: search");
      const initialSearch = await runSearch(queries);
      hitList = initialSearch.hitList;
      searchSucceeded = initialSearch.searchSucceeded;
    }

    let uniqueHits = hitList.filter((hit, index, self) => {
      const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
      return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
    });

    const lowHitThreshold = Math.min(2, this.options.maxHitsPerQuery);
    const shouldExpandQueries =
      !skipSearchWhenPreferred &&
      (uniqueHits.length < lowHitThreshold || !searchSucceeded || queries.length === 0);
    const queryProvider = this.queryProvider;
    if (queryProvider && shouldExpandQueries) {
      const baseQueries = [...queries];
      let laneId: string | undefined;
      emitStatus("thinking", "librarian: expand queries");
      if (contextManager) {
        const lane = await contextManager.getLane({
          ...(laneScope ?? {}),
          role: "librarian",
          ephemeral: true,
        });
        laneId = lane.id;
        await contextManager.append(
          laneId,
          {
            role: "user",
            content: JSON.stringify(
              {
                request,
                base_queries: baseQueries,
                max_queries: this.options.maxQueries,
                file_hints: fileHints,
              },
              null,
              2,
            ),
          },
          { role: "librarian", persisted: false },
        );
      }
      try {
        const expanded = await expandQueriesWithProvider(
          queryProvider,
          request,
          baseQueries,
          this.options.maxQueries,
          this.queryTemperature,
          fileHints,
          this.logger,
        );
        if (laneId && contextManager) {
          await contextManager.append(
            laneId,
            {
              role: "assistant",
              content: JSON.stringify({ expanded_queries: expanded }, null, 2),
            },
            { role: "librarian", persisted: false },
          );
        }
        if (expanded.length > 0) {
          queries = uniqueValues(expanded).slice(0, Math.max(1, this.options.maxQueries));
          const expandedSearch = await runSearch(queries);
          hitList = expandedSearch.hitList;
          searchSucceeded = expandedSearch.searchSucceeded;
          uniqueHits = hitList.filter((hit, index, self) => {
            const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
            return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
          });
        }
      } catch (error) {
        if (laneId && contextManager) {
          await contextManager.append(
            laneId,
            {
              role: "assistant",
              content: `Query expansion failed: ${error instanceof Error ? error.message : String(error)}`,
            },
            { role: "librarian", persisted: false },
          );
        }
        warnings.push("query_expansion_failed");
      }
    }

    uniqueHits = reorderHits(uniqueHits);

    const snippets: ContextSnippet[] = [];
    if (this.options.includeSnippets) {
      emitStatus("thinking", "librarian: snippets");
      for (const hit of uniqueHits) {
        if (!hit.doc_id) continue;
        try {
          emitToolCall("docdex.snippet", { doc_id: hit.doc_id, window: this.options.snippetWindow });
          const snippetResult = await this.client.openSnippet(hit.doc_id, { window: this.options.snippetWindow });
          snippets.push({
            doc_id: hit.doc_id,
            path: hit.path,
            content: toStringPayload(snippetResult),
          });
          emitToolResult("docdex.snippet", "ok", true);
        } catch {
          emitToolResult("docdex.snippet", "failed", false);
          pushWarning(`docdex_snippet_failed:${hit.doc_id}`);
        }
      }
    }

    const filePaths = Array.from(
      new Set([
        ...uniqueHits
          .map((hit) => hit.path)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
        ...preferredFiles,
        ...recentFiles,
      ]),
    );

    const symbols: ContextSymbolSummary[] = [];
    const ast: ContextAstSummary[] = [];
    const impact: ContextImpactSummary[] = [];
    const impactDiagnostics: ContextImpactDiagnostics[] = [];
    if (filePaths.length) {
      emitStatus("thinking", "librarian: symbols/ast/impact");
    }
    for (const file of filePaths) {
      try {
        emitToolCall("docdex.symbols", { file });
        const symbolsResult = await this.client.symbols(file);
        symbols.push({ path: file, summary: toStringPayload(symbolsResult) });
        emitToolResult("docdex.symbols", "ok", true);
      } catch {
        emitToolResult("docdex.symbols", "failed", false);
        pushWarning(`docdex_symbols_failed:${file}`);
      }

      try {
        emitToolCall("docdex.ast", { file });
        const astResult = await this.client.ast(file);
        const nodes = (astResult as { nodes?: unknown[] } | undefined)?.nodes ?? [];
        ast.push({ path: file, nodes });
        emitToolResult("docdex.ast", "ok", true);
      } catch {
        emitToolResult("docdex.ast", "failed", false);
        pushWarning(`docdex_ast_failed:${file}`);
      }

      if (this.options.includeImpact && supportsImpactGraph(file)) {
        try {
          emitToolCall("docdex.impact", {
            file,
            maxDepth: this.options.impactMaxDepth,
            maxEdges: this.options.impactMaxEdges,
          });
          const impactResult = await this.client.impactGraph(file, {
            maxDepth: this.options.impactMaxDepth,
            maxEdges: this.options.impactMaxEdges,
          });
          const inbound = (impactResult as { inbound?: string[] } | undefined)?.inbound ?? [];
          const outbound = (impactResult as { outbound?: string[] } | undefined)?.outbound ?? [];
          impact.push({ file, inbound, outbound });
          emitToolResult("docdex.impact", "ok", true);
          if (!inbound.length && !outbound.length) {
            try {
              emitToolCall("docdex.impact_diagnostics", { file, limit: 20 });
              const diagnostics = await this.client.impactDiagnostics({ file, limit: 20 });
              impactDiagnostics.push({ file, diagnostics });
              emitToolResult("docdex.impact_diagnostics", "ok", true);
              if (hasDiagnostics(diagnostics)) {
                warnings.push(`impact_graph_sparse:${file}`);
              }
            } catch {
              emitToolResult("docdex.impact_diagnostics", "failed", false);
              warnings.push(`impact_diagnostics_failed:${file}`);
            }
          }
        } catch {
          emitToolResult("docdex.impact", "failed", false);
          pushWarning(`docdex_impact_failed:${file}`);
        }
      }
    }

    let selection = selectContextFiles(
      {
        hits: uniqueHits,
        impact,
        recentFiles,
        preferredFiles,
      },
      { maxFiles: this.options.maxFiles, minHitCount: Math.min(2, this.options.maxHitsPerQuery) },
    );
    if (selection.low_confidence) {
      warnings.push("docdex_low_confidence");
    }

    let repoMap: string | undefined;
    if (this.options.includeRepoMap && (selection.low_confidence || uniqueHits.length === 0)) {
      const clientWithTree = this.client as unknown as { tree?: (options?: unknown) => Promise<unknown> };
      if (typeof clientWithTree.tree === "function") {
        try {
          emitToolCall("docdex.tree", { maxDepth: 3 });
          const treeResult = await clientWithTree.tree({ maxDepth: 3 });
          repoMap = toStringPayload(treeResult);
          emitToolResult("docdex.tree", "ok", true);
        } catch {
          emitToolResult("docdex.tree", "failed", false);
          pushWarning("docdex_tree_failed");
        }
      }
    }
    if (this.options.includeRepoMap && !repoMap) {
      const entries: string[] = [];
      const seen = new Set<string>();
      for (const entry of symbols) {
        if (!entry.path || seen.has(entry.path)) continue;
        seen.add(entry.path);
        entries.push(`## ${entry.path}\n${entry.summary}`);
        if (entries.length >= 20) break;
      }
      if (entries.length < 20 && fileHints.length > 0) {
        const remaining = fileHints.filter((file) => !seen.has(file)).slice(0, 20 - entries.length);
        for (const file of remaining) {
          try {
            emitToolCall("docdex.symbols", { file });
            const symbolsResult = await this.client.symbols(file);
            entries.push(`## ${file}\n${toStringPayload(symbolsResult)}`);
            emitToolResult("docdex.symbols", "ok", true);
          } catch {
            emitToolResult("docdex.symbols", "failed", false);
            pushWarning(`docdex_symbols_failed:${file}`);
          }
        }
      }
      if (entries.length > 0) {
        repoMap = entries.join("\n\n");
      }
    }

    let contextFiles: ContextBundle["files"] | undefined;
    let redactionInfo: ContextBundle["redaction"] | undefined;
    if (selection.all.length > 0) {
      emitStatus("executing", "librarian: load context files");
      let redactor: ContextRedactor | undefined;
      if (this.options.redactSecrets && (this.options.redactPatterns.length || this.options.ignoreFilesFrom.length)) {
        redactor = new ContextRedactor({
          workspaceRoot: this.options.workspaceRoot,
          ignoreFilesFrom: this.options.ignoreFilesFrom,
          redactPatterns: this.options.redactPatterns,
        });
        await redactor.loadIgnoreMatchers();
      }
      const loader = new ContextFileLoader(this.client, {
        workspaceRoot: this.options.workspaceRoot,
        readStrategy: this.options.readStrategy,
        focusMaxFileBytes: this.options.focusMaxFileBytes,
        peripheryMaxBytes: this.options.peripheryMaxBytes,
        skeletonizeLargeFiles: this.options.skeletonizeLargeFiles,
        redactor,
      });
      const focusEntries = await loader.loadFocus(selection.focus);
      const peripheryEntries = await loader.loadPeriphery(selection.periphery);
      contextFiles = [...focusEntries, ...peripheryEntries];
      const budgetResult = applyContextBudget(
        contextFiles,
        this.options.maxTotalBytes,
        this.options.tokenBudget,
      );
      contextFiles = budgetResult.files;
      if (budgetResult.droppedPaths.length > 0 && selection) {
        const included = new Set(contextFiles.map((entry) => entry.path));
        selection = {
          ...selection,
          focus: selection.focus.filter((path) => included.has(path)),
          periphery: selection.periphery.filter((path) => included.has(path)),
          all: selection.all.filter((path) => included.has(path)),
        };
        warnings.push("context_budget_pruned");
      }
      if (budgetResult.trimmed) {
        warnings.push("context_budget_trimmed");
      }
      if (loader.redactionCount > 0 || loader.ignoredPaths.length > 0) {
        redactionInfo = {
          count: loader.redactionCount,
          ignored: loader.ignoredPaths,
        };
      }
    }

    let memoryItems: Array<{ content?: string }> = [];
    try {
      emitToolCall("docdex.memory_recall", { query: request, top_k: 5 });
      const memoryResult = await this.client.memoryRecall(request, 5);
      memoryItems = (memoryResult as { results?: Array<{ content?: string }> } | undefined)?.results ?? [];
      emitToolResult("docdex.memory_recall", "ok", true);
    } catch {
      emitToolResult("docdex.memory_recall", "failed", false);
      pushWarning("docdex_memory_recall_failed");
    }
    const memory = memoryItems
      .map((item) => item.content)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .map((text) => ({ text, source: "repo" }));

    let profileEntries: Array<{ content?: string }> = [];
    try {
      emitToolCall("docdex.profile", { agentId: this.agentId });
      const profileResult = await this.client.getProfile(this.agentId);
      profileEntries =
        (profileResult as { preferences?: Array<{ content?: string }> } | undefined)?.preferences ?? [];
      emitToolResult("docdex.profile", "ok", true);
    } catch {
      emitToolResult("docdex.profile", "failed", false);
      pushWarning("docdex_profile_failed");
    }
    const profile = profileEntries
      .map((entry) => entry.content)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .map((content) => ({ content, source: "agent" }));

    const indexInfo = {
      last_updated_epoch_ms: (stats as { last_updated_epoch_ms?: number }).last_updated_epoch_ms ?? 0,
      num_docs: (stats as { num_docs?: number }).num_docs ?? 0,
    };
    if (statsSucceeded) {
      const hasFileHints = filesSucceeded && fileHints.length > 0;
      const indexEmpty = filesSucceeded && indexInfo.num_docs === 0 && !hasFileHints;
      const indexStale = filesSucceeded && indexInfo.last_updated_epoch_ms === 0 && !hasFileHints;
      if (indexEmpty) {
        warnings.push("docdex_index_empty");
      }
      if (indexStale) {
        pushWarning("docdex_index_stale");
      }
      if (indexEmpty) {
        const clientWithRebuild = this.client as unknown as { indexRebuild?: () => Promise<unknown> };
        if (typeof clientWithRebuild.indexRebuild === "function") {
          emitToolCall("docdex.index_rebuild", {});
          void clientWithRebuild
            .indexRebuild()
            .then(() => emitToolResult("docdex.index_rebuild", "ok", true))
            .catch(() => {
              emitToolResult("docdex.index_rebuild", "failed", false);
              pushWarning("docdex_index_rebuild_failed");
            });
        }
      }
    }

    if (!uniqueHits.length && !skipSearchWhenPreferred) {
      if (!searchSucceeded) {
        pushWarning("docdex_search_failed");
      } else {
        pushWarning("docdex_no_hits");
      }
    }

    const explicitReadOnly = this.options.readOnlyPaths ?? [];
    const docReadOnly = this.options.allowDocEdits
      ? []
      : [
          "docs",
          ...((selection?.all ?? []).filter((entry) => isDocPath(entry))),
        ];
    const readOnlySeed = uniqueValues([...explicitReadOnly, ...docReadOnly]).map(normalizePath);
    const isReadOnlyPath = (value: string) => {
      const normalized = normalizePath(value);
      return readOnlySeed.some(
        (entry) => normalized === entry || normalized.startsWith(`${entry}/`),
      );
    };
    const allowWriteSeed = uniqueValues([
      ...(selection?.all ?? []),
      ...preferredFiles,
      ...recentFiles,
    ]).map(normalizePath);
    const allowWritePaths = allowWriteSeed.filter((path) => !isReadOnlyPath(path));
    const readOnlyPaths = readOnlySeed;

    const bundle: ContextBundle = {
      request,
      queries,
      snippets,
      symbols,
      ast,
      impact,
      impact_diagnostics: impactDiagnostics,
      repo_map: repoMap,
      selection,
      allow_write_paths: allowWritePaths,
      read_only_paths: readOnlyPaths,
      files: contextFiles,
      redaction: redactionInfo,
      memory,
      preferences_detected: preferencesDetected,
      profile,
      index: indexInfo,
      warnings,
    };
    if ((contextFiles && contextFiles.length > 0) || repoMap) {
      bundle.serialized = serializeContext(bundle, { mode: this.options.serializationMode });
    }
    emitStatus("done", "librarian: bundle ready");
    return bundle;
  }

  async fulfillAgentRequest(request: AgentRequest): Promise<CodaliResponse> {
    const warnings: string[] = [];
    const results: CodaliResponseResult[] = [];
    const needs = normalizeAgentRequest(request);
    for (const need of needs) {
      try {
        if (need.tool === "docdex.search") {
          const hits = await this.client.search(need.params.query, { limit: need.params.limit });
          results.push({ type: "docdex.search", query: need.params.query, hits: hits as unknown[] });
          continue;
        }
        if (need.tool === "docdex.web") {
          const payload = await this.client.webResearch(need.params.query, {
            forceWeb: need.params.force_web,
          });
          results.push({
            type: "docdex.web",
            query: need.params.query,
            results: payload as unknown[],
          });
          continue;
        }
        if (need.tool === "docdex.impact") {
          const graph = await this.client.impactGraph(need.params.file, {
            maxDepth: this.options.impactMaxDepth,
            maxEdges: this.options.impactMaxEdges,
          });
          const graphRecord = graph as { inbound?: unknown[]; outbound?: unknown[] };
          results.push({
            type: "docdex.impact",
            file: need.params.file,
            inbound: Array.isArray(graphRecord.inbound) ? graphRecord.inbound : [],
            outbound: Array.isArray(graphRecord.outbound) ? graphRecord.outbound : [],
          });
          continue;
        }
        if (need.tool === "file.read") {
          const requestedPath = need.params.path.trim();
          const home = process.env.HOME ?? "";
          const docdexAgentsPath = home ? path.join(home, ".docdex", "agents.md") : "";
          const normalizedRequested =
            requestedPath.startsWith("~/") && home
              ? path.join(home, requestedPath.slice(2))
              : requestedPath;
          if (docdexAgentsPath && normalizedRequested === docdexAgentsPath) {
            const content = await readFile(docdexAgentsPath, "utf8");
            results.push({ type: "file.read", path: requestedPath, content });
            continue;
          }
          const resolved = resolveWorkspacePath(this.options.workspaceRoot, requestedPath);
          const content = await readFile(resolved, "utf8");
          results.push({ type: "file.read", path: requestedPath, content });
          continue;
        }
        if (need.tool === "file.list") {
          const files = await listWorkspaceFilesByPattern(
            this.options.workspaceRoot,
            need.params.root,
            need.params.pattern,
          );
          results.push({
            type: "file.list",
            root: need.params.root,
            files,
          });
          continue;
        }
        if (need.tool === "file.diff") {
          const args = ["diff", "--"];
          if (need.params.paths && need.params.paths.length > 0) {
            args.push(...need.params.paths);
          }
          const { stdout } = await execFileAsync("git", args, {
            cwd: this.options.workspaceRoot,
          });
          results.push({
            type: "file.diff",
            paths: need.params.paths,
            diff: stdout ?? "",
          });
          continue;
        }
      } catch (error) {
        warnings.push(
          `agent_request_failed:${need.tool}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      version: "v1",
      request_id: request.request_id,
      results,
      meta: {
        repo_root: this.options.workspaceRoot,
        warnings: warnings.length ? warnings : undefined,
      },
    };
  }
}
