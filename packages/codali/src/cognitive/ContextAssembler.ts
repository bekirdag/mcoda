import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { AgentEvent, AgentStatusPhase, Provider } from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import { createDeepInvestigationDocdexError } from "../runtime/DeepInvestigationErrors.js";
import type {
  AgentRequest,
  CodaliResponse,
  CodaliResponseResult,
  NormalizedNeed,
} from "../agents/AgentProtocol.js";
import { normalizeAgentRequest } from "../agents/AgentProtocol.js";
import {
  expandQueriesWithProvider,
  extractQueries,
  extractQuerySignals,
  type QuerySignals,
} from "./QueryExtraction.js";
import { RunHistoryIndexer } from "./RunHistoryIndexer.js";
import { GoldenExampleIndexer } from "./GoldenExampleIndexer.js";
import { GoldenSetStore } from "./GoldenSetStore.js";
import { extractPreferences } from "./PreferenceExtraction.js";
import { selectContextFiles } from "./ContextSelector.js";
import { ContextFileLoader } from "./ContextFileLoader.js";
import { ContextRedactor } from "./ContextRedactor.js";
import { sanitizeContextBundleForOutput, serializeContext } from "./ContextSerializer.js";
import { deriveIntentSignals, type IntentSignals } from "./IntentSignals.js";
import type { ContextManager } from "./ContextManager.js";
import type {
  ContextBundle,
  ContextFileEntry,
  ContextImpactSummary,
  ContextImpactDiagnostics,
  ContextSnippet,
  ContextSymbolSummary,
  ContextAstSummary,
  ContextProjectInfo,
  ContextSearchResult,
  ContextSelection,
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
  deepMode?: boolean;
  queryProvider?: Provider;
  queryTemperature?: number;
  agentId?: string;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
  onEvent?: (event: AgentEvent) => void;
  logger?: RunLogger;
}

export interface ResearchToolRun {
  tool: string;
  ok: boolean;
  skipped?: boolean;
  durationMs?: number;
  notes?: string;
  error?: string;
}

export interface ResearchToolExecution {
  toolRuns: ResearchToolRun[];
  warnings: string[];
  outputs: {
    searchResults: ContextSearchResult[];
    snippets: ContextSnippet[];
    symbols: ContextSymbolSummary[];
    ast: ContextAstSummary[];
    impact: ContextImpactSummary[];
    impactDiagnostics: ContextImpactDiagnostics[];
    repoMap?: string;
    repoMapRaw?: string;
    dagSummary?: string;
  };
}

const toStringPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const extractTreeText = (payload: unknown): string | undefined => {
  if (typeof payload === "string") {
    const text = payload.trim();
    return text.length > 0 ? text : undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as {
    tree?: unknown;
    data?: { tree?: unknown };
  };
  if (typeof record.tree === "string" && record.tree.trim().length > 0) {
    return record.tree;
  }
  if (record.data && typeof record.data.tree === "string" && record.data.tree.trim().length > 0) {
    return record.data.tree;
  }
  return undefined;
};

const compactTreeForPrompt = (treeText: string): string => {
  const lines = treeText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0);
  const compacted: string[] = [];
  for (const line of lines) {
    if (compacted[compacted.length - 1] === line) continue;
    compacted.push(line);
  }
  return compacted.join("\n");
};

const SECTION_LIMITS = {
  snippetChars: 2_400,
  symbolChars: 3_200,
  symbolEntries: 40,
  astNodes: 80,
};

const CONTEXT_DEPTH_LIMITS = {
  maxQueries: { min: 1, max: 12 },
  maxHitsPerQuery: { min: 1, max: 20 },
  snippetWindow: { min: 40, max: 600 },
  impactMaxDepth: { min: 1, max: 6 },
  impactMaxEdges: { min: 10, max: 200 },
};

const DEEP_SCAN_PRESET = {
  maxQueries: 6,
  maxHitsPerQuery: 6,
  snippetWindow: 220,
  impactMaxDepth: 4,
  impactMaxEdges: 160,
  maxFiles: 16,
  maxTotalBytes: 120_000,
  tokenBudget: 220_000,
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const resolveDepthOption = (
  value: number | undefined,
  fallback: number,
  limits: { min: number; max: number },
  label: string,
  logger?: RunLogger,
): number => {
  const requested = value ?? fallback;
  const normalized = Number.isFinite(requested) ? Math.round(requested) : fallback;
  const resolved = clampNumber(normalized, limits.min, limits.max);
  if (value !== undefined && resolved !== normalized) {
    void logger?.log("context_option_clamped", {
      option: label,
      requested: normalized,
      resolved,
      min: limits.min,
      max: limits.max,
    });
  }
  return resolved;
};

const truncateText = (content: string, maxChars: number): string => {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  const marker = "\n/* ...truncated... */\n";
  if (maxChars <= marker.length) return content.slice(0, maxChars);
  return `${content.slice(0, maxChars - marker.length)}${marker}`;
};

const truncateSummary = (content: string, maxChars: number): string => {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  if (maxChars <= 3) return content.slice(0, maxChars);
  return `${content.slice(0, maxChars - 3)}...`;
};

const buildDeepModeDocdexError = (missing: string[], remediation: string[]): Error =>
  createDeepInvestigationDocdexError(missing, remediation);

const extractDocdexContent = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as {
      content?: unknown;
      text?: unknown;
      snippet?: { text?: unknown };
      data?: { content?: unknown };
    };
    if (typeof record.content === "string") return record.content;
    if (typeof record.text === "string") return record.text;
    if (record.snippet && typeof record.snippet.text === "string") return record.snippet.text;
    if (record.data && typeof record.data.content === "string") return record.data.content;
  }
  return toStringPayload(payload);
};

const extractSnippetContent = (payload: unknown): string => {
  if (typeof payload === "string") {
    return truncateText(payload, SECTION_LIMITS.snippetChars);
  }
  if (payload && typeof payload === "object") {
    const record = payload as {
      snippet?: { text?: unknown };
      content?: unknown;
      text?: unknown;
      doc?: { summary?: unknown };
    };
    const snippetText = record.snippet && typeof record.snippet.text === "string"
      ? record.snippet.text
      : undefined;
    if (snippetText && snippetText.trim().length > 0) {
      return truncateText(snippetText, SECTION_LIMITS.snippetChars);
    }
    if (typeof record.text === "string" && record.text.trim().length > 0) {
      return truncateText(record.text, SECTION_LIMITS.snippetChars);
    }
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return truncateText(record.content, SECTION_LIMITS.snippetChars);
    }
    if (record.doc && typeof record.doc.summary === "string" && record.doc.summary.trim().length > 0) {
      return truncateText(record.doc.summary, SECTION_LIMITS.snippetChars);
    }
  }
  return truncateText(toStringPayload(payload), SECTION_LIMITS.snippetChars);
};

const simplifyRange = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const simplified: Record<string, unknown> = {};
  for (const key of ["start_line", "start_col", "end_line", "end_col"]) {
    if (typeof record[key] === "number") simplified[key] = record[key];
  }
  return Object.keys(simplified).length > 0 ? simplified : undefined;
};

const summarizeSymbolsPayload = (payload: unknown): string => {
  if (payload && typeof payload === "object") {
    const record = payload as {
      file?: unknown;
      symbols?: unknown;
      outcome?: unknown;
    };
    if (Array.isArray(record.symbols)) {
      const simplified = record.symbols.slice(0, SECTION_LIMITS.symbolEntries).map((symbol) => {
        if (!symbol || typeof symbol !== "object") return symbol;
        const item = symbol as Record<string, unknown>;
        const mapped: Record<string, unknown> = {};
        for (const key of ["kind", "name", "signature", "symbol_id"]) {
          if (typeof item[key] === "string" && item[key].length > 0) {
            mapped[key] = item[key];
          }
        }
        const range = simplifyRange(item.range);
        if (range) mapped.range = range;
        return mapped;
      });
      const normalized = {
        file: typeof record.file === "string" ? record.file : undefined,
        symbol_count: record.symbols.length,
        symbols: simplified,
        truncated: record.symbols.length > SECTION_LIMITS.symbolEntries,
      };
      return truncateText(JSON.stringify(normalized, null, 2), SECTION_LIMITS.symbolChars);
    }
  }
  return truncateText(toStringPayload(payload), SECTION_LIMITS.symbolChars);
};

const simplifyAstNode = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const key of ["kind", "name", "field", "is_named"]) {
    if (typeof item[key] === "string" || typeof item[key] === "boolean") {
      mapped[key] = item[key];
    }
  }
  if (typeof item.id === "number") mapped.id = item.id;
  if (typeof item.parent_id === "number") mapped.parent_id = item.parent_id;
  const range = simplifyRange(item.range);
  if (range) mapped.range = range;
  return mapped;
};

const compactAstNodes = (payload: unknown): unknown[] => {
  const nodes = (payload as { nodes?: unknown[] } | undefined)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const trimmed = nodes.slice(0, SECTION_LIMITS.astNodes).map((entry) => simplifyAstNode(entry));
  if (nodes.length > SECTION_LIMITS.astNodes) {
    trimmed.push({
      kind: "__truncated__",
      remaining: nodes.length - SECTION_LIMITS.astNodes,
    });
  }
  return trimmed;
};

const execFileAsync = promisify(execFile);

const collectHits = (
  result: unknown,
): Array<{ doc_id?: string; path?: string; score?: number }> => {
  if (!result || typeof result !== "object") return [];
  const hits = (
    result as { hits?: Array<{ doc_id?: string; path?: string; score?: number }> }
  ).hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((hit) => ({
    doc_id: hit.doc_id,
    path: hit.path,
    score: typeof hit.score === "number" ? hit.score : undefined,
  }));
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

const SYMBOL_ANALYSIS_EXTENSIONS = new Set([
  ".rs",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
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

const AST_ANALYSIS_EXTENSIONS = new Set([
  ...Array.from(SYMBOL_ANALYSIS_EXTENSIONS),
  ".json",
  ".yaml",
  ".yml",
]);

const CONFIG_FILE_EXTENSIONS = new Set([".yaml", ".yml"]);

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

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const STYLE_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
]);

const FRONTEND_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

const FRONTEND_DIR_HINT_PATTERN = /(^|\/)(public|frontend|client|web|ui)(\/|$)/i;
const INFRA_PATH_PATTERN =
  /(^|\/)(\.github\/workflows|\.github\/actions|\.circleci|buildkite|jenkins|infra|deploy|ops|k8s|kubernetes|helm|terraform|ansible)(\/|$)/i;
const INFRA_FILE_PATTERN =
  /(dockerfile|docker-compose|compose\.ya?ml|makefile|jenkinsfile|\.gitlab-ci\.ya?ml)$/i;
const SECURITY_PATH_PATTERN =
  /(^|\/)(auth|security|permissions?|rbac|acl|policy|oauth|jwt|sso|crypto|secrets?)(\/|$|[._-])/i;
const PERFORMANCE_PATH_PATTERN =
  /(^|\/)(perf|performance|benchmark|profil(e|ing)|cache|rate[-_]?limit|throttle|batch|queue)(\/|$|[._-])/i;
const OBSERVABILITY_PATH_PATTERN =
  /(^|\/)(log|logger|metrics?|monitor|monitoring|trace|tracing|otel|sentry|datadog|prometheus|grafana|alert)(\/|$|[._-])/i;

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

const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "tests/**"];
const INFRA_GLOBS = [
  ".github/workflows/**",
  ".github/actions/**",
  ".circleci/**",
  "infra/**",
  "deploy/**",
  "ops/**",
  "k8s/**",
  "kubernetes/**",
  "helm/**",
  "terraform/**",
  "ansible/**",
  "Dockerfile",
  "docker-compose.*",
  "compose.y*ml",
  "Makefile",
  "Jenkinsfile",
  ".gitlab-ci.y*ml",
];

const isFrontendPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = normalized.slice(dot);
  if (FRONTEND_EXTENSIONS.has(ext)) return true;
  return FRONTEND_SCRIPT_EXTENSIONS.has(ext) && FRONTEND_DIR_HINT_PATTERN.test(normalized);
};

const isInfraPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  return INFRA_PATH_PATTERN.test(normalized) || INFRA_FILE_PATTERN.test(normalized);
};

const isSecurityPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  return SECURITY_PATH_PATTERN.test(normalized);
};

const isPerformancePath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  return PERFORMANCE_PATH_PATTERN.test(normalized);
};

const isObservabilityPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  return OBSERVABILITY_PATH_PATTERN.test(normalized);
};

const isHtmlPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  return HTML_EXTENSIONS.has(normalized.slice(dot));
};

const isStylePath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot === -1) return false;
  return STYLE_EXTENSIONS.has(normalized.slice(dot));
};

const hasUiScaffold = (paths: string[]): boolean => {
  let hasHtml = false;
  let hasStyle = false;
  for (const entry of paths) {
    if (!hasHtml && isHtmlPath(entry)) hasHtml = true;
    if (!hasStyle && isStylePath(entry)) hasStyle = true;
    if (hasHtml && hasStyle) return true;
  }
  return false;
};

const INTENT_HINTS: Record<IntentSignals["intents"][number], string[]> = {
  ui: ["index", "home", "landing", "public", "view", "page", "template", "ui", "app", "client"],
  content: ["copy", "content", "text", "strings", "locale", "i18n"],
  behavior: ["service", "handler", "controller", "api", "server", "logic", "process"],
  data: ["model", "schema", "db", "data", "store", "migration"],
  testing: [
    "test",
    "tests",
    "spec",
    "specs",
    "snapshot",
    "coverage",
    "fixture",
    "mock",
    "pytest",
    "junit",
  ],
  infra: [
    "ci",
    "cd",
    "pipeline",
    "workflow",
    "runner",
    "deploy",
    "docker",
    "k8s",
    "terraform",
    "infra",
    "github",
    "gitlab",
  ],
  security: ["auth", "rbac", "policy", "jwt", "oauth", "security", "secret", "csrf", "xss"],
  performance: [
    "perf",
    "performance",
    "cache",
    "latency",
    "throughput",
    "benchmark",
    "profiling",
    "optimize",
  ],
  observability: [
    "logging",
    "metrics",
    "tracing",
    "monitor",
    "alert",
    "otel",
    "telemetry",
    "instrumentation",
  ],
};

const EXCLUDED_WALK_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".docdex",
  ".docdex_state",
  ".mcoda",
  ".cache",
  ".tmp",
  ".temp",
  "tmp",
  "logs",
  "dist",
  "build",
  "out",
  "coverage",
  "lib-cov",
  "target",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".serverless",
  ".parcel-cache",
  ".nyc_output",
  ".gradle",
  ".m2",
  ".idea",
  ".vscode",
  ".yarn",
  ".pnpm-store",
  ".npm",
  ".bun",
  ".cargo",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "Pods",
  "Carthage",
  "DerivedData",
  ".bundle",
  ".stack-work",
  "deps",
  "_build",
  ".dart_tool",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
]);

const EXCLUDED_WALK_DIRS_LOWER = new Set(
  Array.from(EXCLUDED_WALK_DIRS, (entry) => entry.toLowerCase()),
);

const isExcludedDirName = (value: string): boolean => {
  if (!value) return false;
  return (
    EXCLUDED_WALK_DIRS.has(value) ||
    EXCLUDED_WALK_DIRS_LOWER.has(value.toLowerCase())
  );
};

const isExcludedPath = (value: string): boolean => {
  if (!value) return false;
  const normalized = normalizePath(value);
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => isExcludedDirName(segment));
};

const EXCLUDED_RG_GLOBS = Array.from(EXCLUDED_WALK_DIRS).flatMap((dir) => {
  const lower = dir.toLowerCase();
  if (lower === dir) return [`!**/${dir}/**`];
  return [`!**/${dir}/**`, `!**/${lower}/**`];
});

const REPO_TREE_EXCLUDES = [
  ".docdex",
  ".docdex_state",
  ".mcoda",
  ".git",
  ".DS_Store",
];

const filterExcludedPaths = (paths: string[]): string[] =>
  paths.filter((entry) => !isExcludedPath(entry));

const PLACEHOLDER_PATH_PATTERN = /^path\/to\/file\.[a-z0-9]+$/i;

const isPlaceholderPath = (value: string): boolean => {
  if (!value) return false;
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("<") || normalized.includes(">")) return true;
  if (normalized.startsWith("path/to/")) return true;
  return PLACEHOLDER_PATH_PATTERN.test(normalized);
};

const filterPlaceholderPaths = (paths: string[], request: string): string[] => {
  if (!paths.length) return [];
  const requestLower = request.toLowerCase();
  return paths.filter((entry) => {
    if (!isPlaceholderPath(entry)) return true;
    const normalized = normalizePath(entry).toLowerCase();
    return requestLower.includes(normalized);
  });
};

const applyForcedFocusSelection = (
  selection: ContextSelection,
  forcedFocusFiles: string[],
  maxFiles: number,
): ContextSelection => {
  if (!forcedFocusFiles.length) return selection;
  const limit = Math.max(1, maxFiles);
  const combined = uniqueValues([
    ...forcedFocusFiles.map((entry) => normalizePath(entry)),
    ...selection.focus.map((entry) => normalizePath(entry)),
    ...selection.periphery.map((entry) => normalizePath(entry)),
    ...selection.all.map((entry) => normalizePath(entry)),
  ]).slice(0, limit);
  const focusTargetSize = Math.min(
    limit,
    Math.max(selection.focus.length, forcedFocusFiles.length, 1),
  );
  const focusSeed = uniqueValues([
    ...forcedFocusFiles.map((entry) => normalizePath(entry)),
    ...selection.focus.map((entry) => normalizePath(entry)),
  ]);
  const focus: string[] = [];
  for (const candidate of focusSeed) {
    if (!combined.includes(candidate)) continue;
    focus.push(candidate);
    if (focus.length >= focusTargetSize) break;
  }
  if (focus.length < focusTargetSize) {
    for (const candidate of combined) {
      if (focus.includes(candidate)) continue;
      focus.push(candidate);
      if (focus.length >= focusTargetSize) break;
    }
  }
  const periphery = combined.filter((entry) => !focus.includes(entry));
  return {
    ...selection,
    focus,
    periphery,
    all: combined,
  };
};

const isBackoffError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("backoff") ||
    normalized.includes("index writer unavailable")
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const retryDocdexCall = async <T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 150,
): Promise<{ ok: true; value: T } | { ok: false; backoff: boolean; error: unknown }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      lastError = error;
      const backoff = isBackoffError(error);
      if (!backoff || attempt === retries) {
        return { ok: false, backoff, error: lastError };
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
  return { ok: false, backoff: false, error: lastError };
};

const DOC_SUPPORT_PATTERNS = [
  /(^|\/)docs\/rfp\.md$/i,
  /(^|\/)docs\/sds\/.+\.md$/i,
  /(^|\/)docs\/pdr\/.+\.md$/i,
  /(^|\/)docs\/pdr\/.+\.mdx$/i,
];

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
];

const supportsImpactGraph = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = normalized.slice(lastDot);
  return IMPACT_GRAPH_EXTENSIONS.has(ext);
};

const supportsSymbolAnalysis = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = normalized.slice(lastDot);
  return SYMBOL_ANALYSIS_EXTENSIONS.has(ext);
};

const supportsAstAnalysis = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = normalized.slice(lastDot);
  return AST_ANALYSIS_EXTENSIONS.has(ext);
};

const isDocPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  return (
    normalized.startsWith("docs/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  );
};

const isConfigPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  const base = path.posix.basename(normalized);
  if (base.startsWith(".env")) return true;
  const ext = path.extname(base);
  return CONFIG_FILE_EXTENSIONS.has(ext);
};

const isSupportDoc = (value: string): boolean =>
  DOC_SUPPORT_PATTERNS.some((pattern) => pattern.test(normalizePath(value)));

const extractFileTypes = (paths: string[]): string[] => {
  const types = new Set<string>();
  for (const value of paths) {
    const normalized = normalizePath(value).toLowerCase();
    const dot = normalized.lastIndexOf(".");
    if (dot === -1) continue;
    types.add(normalized.slice(dot));
  }
  return Array.from(types).sort();
};

const detectManifests = async (workspaceRoot?: string): Promise<string[]> => {
  if (!workspaceRoot) return [];
  const found: string[] = [];
  await Promise.all(
    MANIFEST_FILES.map(async (name) => {
      try {
        await readFile(path.join(workspaceRoot, name), "utf8");
        found.push(name);
      } catch {
        // ignore missing manifests
      }
    }),
  );
  return found.sort();
};

const README_CANDIDATES = [
  "README.md",
  "README.mdx",
  "README.rst",
  "README.txt",
  "README",
  "readme.md",
  "readme.mdx",
  "readme.rst",
  "readme.txt",
  "readme",
];

const stripReadmeContent = (content: string): string[] => {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const cleaned: string[] = [];
  let inFence = false;
  let inFrontMatter = false;
  let sawContent = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inFrontMatter && !sawContent && line === "---") {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (line === "---") {
        inFrontMatter = false;
      }
      continue;
    }
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("<!--")) continue;
    cleaned.push(line);
    if (line.length > 0) sawContent = true;
  }
  return cleaned;
};

const summarizeReadme = (content: string): string => {
  const cleaned = stripReadmeContent(content);
  const nonEmpty = cleaned.filter((line) => line.length > 0);
  if (nonEmpty.length === 0) return "";

  let title = "";
  let startIndex = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (line.startsWith("#")) {
      title = line.replace(/^#+\s*/, "").trim();
      startIndex = i + 1;
      break;
    }
  }

  let paragraph = "";
  const bullets: string[] = [];
  for (let i = startIndex; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (!line) {
      if (paragraph || bullets.length > 0) break;
      continue;
    }
    if (line.startsWith("#")) {
      if (paragraph || bullets.length > 0) break;
      continue;
    }
    const bulletMatch = line.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      if (!paragraph) {
        bullets.push(bulletMatch[1].trim());
        if (bullets.length >= 3) break;
        continue;
      }
    }
    paragraph = paragraph ? `${paragraph} ${line}` : line;
    if (paragraph.length >= 480) break;
  }

  let body = paragraph;
  if (!body && bullets.length > 0) body = bullets.join("; ");
  if (!body) body = nonEmpty[0] ?? "";

  let summary = "";
  if (title && body) {
    summary = `${title}: ${body}`;
  } else {
    summary = title || body;
  }
  return truncateSummary(summary.trim(), 600);
};

const loadReadmeSummary = async (
  workspaceRoot?: string,
): Promise<{ path: string; summary: string } | undefined> => {
  if (!workspaceRoot) return undefined;
  for (const candidate of README_CANDIDATES) {
    try {
      const content = await readFile(path.join(workspaceRoot, candidate), "utf8");
      return { path: candidate, summary: summarizeReadme(content) };
    } catch {
      // ignore missing readme
    }
  }
  return undefined;
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

const inferPreferredFiles = (
  request: string,
  fileHints: string[],
  intent: IntentSignals,
  docTask: boolean,
): string[] => {
  if (!fileHints.length) return [];
  const requestTokens = tokenizeRequest(request);
  const uiIntent = intent.intents.includes("ui");
  const testingIntent = intent.intents.includes("testing");
  const infraIntent = intent.intents.includes("infra");
  const securityIntent = intent.intents.includes("security");
  const performanceIntent = intent.intents.includes("performance");
  const observabilityIntent = intent.intents.includes("observability");
  const wantsHtml =
    /\b(html|index\.html|root page|landing page|landing|home page|homepage|welcome|header|hero)\b/i.test(
      request,
    );
  const wantsCss = /\b(css|styles?|styling|theme|layout|colors?)\b/i.test(request);
  const ranked = uniqueValues(fileHints.map(normalizePath))
    .map((value) => {
      const normalized = value.toLowerCase();
      const ext = path.extname(normalized);
      let points = 0;
      for (const token of requestTokens) {
        if (normalized.includes(token)) points += 2;
      }
      if (intent.intents.includes("ui") && isFrontendPath(normalized)) points += 4;
      if (intent.intents.includes("behavior") && isSourceScriptPath(normalized)) points += 2;
      if (intent.intents.includes("data") && isSourceScriptPath(normalized)) points += 2;
      if (testingIntent && isTestPath(normalized)) points += 4;
      if (infraIntent && isInfraPath(normalized)) points += 4;
      if (securityIntent && isSecurityPath(normalized)) points += 3;
      if (performanceIntent && isPerformancePath(normalized)) points += 3;
      if (observabilityIntent && isObservabilityPath(normalized)) points += 3;
      if (wantsHtml && (ext === ".html" || ext === ".htm")) points += 4;
      if (wantsCss && [".css", ".scss", ".sass", ".less", ".styl"].includes(ext)) points += 4;
      if (uiIntent && HTML_EXTENSIONS.has(ext)) points += 2;
      if (uiIntent && STYLE_EXTENSIONS.has(ext)) points += 2;
      if (normalized.endsWith("index.html") || normalized.endsWith("index.htm")) points += 3;
      if (normalized.includes("/public/") || normalized.includes("src/public")) points += 2;
      if (normalized.includes("/server/") || normalized.includes("/api/")) points += 2;
      if (!docTask && (isDocPath(normalized) || isSupportDoc(normalized))) points -= 3;
      if (!docTask && isTestPath(normalized)) points -= 2;
      return { value, score: points };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (a.score === b.score) return a.value.length - b.value.length;
      return b.score - a.score;
    });
  return ranked.slice(0, 6).map((entry) => entry.value);
};

const COMPANION_CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".php",
  ".rb",
  ".kt",
  ".swift",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".vue",
  ".svelte",
]);

const stemOf = (value: string): string => {
  const base = path.posix.basename(normalizePath(value));
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.toLowerCase();
  return base.slice(0, dot).toLowerCase();
};

const inferCompanionFiles = (
  anchors: string[],
  fileHints: string[],
  limit = 4,
): string[] => {
  if (!anchors.length || !fileHints.length) return [];
  const normalizedAnchors = new Set(anchors.map((entry) => normalizePath(entry).toLowerCase()));
  const anchorDirs = new Set(
    anchors
      .map((entry) => normalizePath(entry).toLowerCase())
      .map((entry) => path.posix.dirname(entry)),
  );
  const anchorStems = new Set(anchors.map((entry) => stemOf(entry)));
  const scored = uniqueValues(fileHints.map((entry) => normalizePath(entry)))
    .filter((entry) => !normalizedAnchors.has(entry.toLowerCase()))
    .map((entry) => {
      const normalized = entry.toLowerCase();
      const dir = path.posix.dirname(normalized);
      const ext = path.extname(normalized);
      let score = 0;
      if (anchorDirs.has(dir)) score += 3;
      if (anchorStems.has(stemOf(normalized))) score += 2;
      if (COMPANION_CODE_EXTENSIONS.has(ext)) score += 1;
      if (isDocPath(normalized) || isSupportDoc(normalized)) score -= 2;
      if (isTestPath(normalized)) score -= 1;
      return { path: entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (a.score === b.score) return a.path.length - b.path.length;
      return b.score - a.score;
    });
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.path);
};

const buildFileQueryHints = (paths: string[], maxHints = 3): string[] => {
  if (!paths.length || maxHints <= 0) return [];
  const normalizedPaths = uniqueValues(paths.map(normalizePath));
  const hints: string[] = [];
  for (const value of normalizedPaths) {
    hints.push(value);
    const base = value.split("/").pop();
    if (base && base !== value) {
      hints.push(base);
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem && stem !== base) hints.push(stem);
    }
    if (hints.length >= maxHints * 3) break;
  }
  return uniqueValues(hints).slice(0, maxHints);
};

const buildSearchExecutionQueries = (
  request: string,
  baseQueries: string[],
  querySignals: QuerySignals,
  maxQueries: number,
): string[] => {
  const cap = Math.max(maxQueries, Math.min(12, maxQueries * 3));
  const prioritized = uniqueValues([
    request.trim(),
    ...baseQueries,
    ...querySignals.phrases,
    ...querySignals.file_tokens,
    ...querySignals.keyword_phrases,
    ...querySignals.keywords,
  ]).filter((entry) => entry.length > 0);
  return prioritized.slice(0, cap);
};

const buildAdaptiveSearchQueries = (
  request: string,
  queries: string[],
  intent: IntentSignals,
  preferredFiles: string[],
  maxQueries: number,
): string[] => {
  const requestTokens = tokenizeRequest(request).slice(0, 8);
  const requestPhrase = requestTokens.slice(0, 4).join(" ");
  const pathTokens = uniqueValues(
    preferredFiles
      .flatMap((entry) => normalizePath(entry).toLowerCase().split(/[/.\\-_]+/g))
      .filter((token) => token.length >= 3),
  ).slice(0, 4);
  const intentTokens = uniqueValues(
    intent.intents.flatMap((bucket) => INTENT_HINTS[bucket]).filter((entry) => entry.length >= 3),
  ).slice(0, 2);
  const adaptive = uniqueValues([
    requestPhrase,
    [...requestTokens.slice(0, 2), ...pathTokens.slice(0, 2)].filter(Boolean).join(" "),
    ...pathTokens,
    ...intentTokens,
    request,
    ...queries,
  ]).filter((entry) => entry.trim().length > 0);
  return adaptive.slice(0, Math.max(1, maxQueries));
};

const isUiSourceHintPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  if (isFrontendPath(normalized)) return true;
  return /(^|\/)src\/taskstore\.[^.]+$/.test(normalized);
};

const isDocDominantHits = (hits: Array<{ path?: string }>): boolean => {
  if (!hits.length) return false;
  let docLike = 0;
  for (const hit of hits) {
    const pathValue = hit.path ?? "";
    if (!pathValue) continue;
    if (isDocPath(pathValue) || isSupportDoc(pathValue)) {
      docLike += 1;
    }
  }
  if (docLike === 0) return false;
  return docLike / hits.length >= 0.6;
};

const buildUiSourceBiasedQueries = (
  request: string,
  queries: string[],
  preferredFiles: string[],
  fileHints: string[],
  maxQueries: number,
): string[] => {
  const sourcePaths = uniqueValues([...preferredFiles, ...fileHints])
    .filter((entry) => isUiSourceHintPath(entry))
    .slice(0, 6);
  const sourceTokens = uniqueValues(
    sourcePaths
      .flatMap((entry) => normalizePath(entry).toLowerCase().split(/[/.\\_-]+/g))
      .filter((entry) => entry.length >= 3),
  ).slice(0, 6);
  const sourceQueries = uniqueValues([
    request,
    ...queries,
    ...sourcePaths,
    sourceTokens.join(" "),
    "src/public/*",
    "src/public/index.html",
    "src/taskStore.js",
  ]).filter((entry) => entry.trim().length > 0);
  return sourceQueries.slice(0, Math.max(1, maxQueries));
};

const isTestPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("__tests__") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
};

const BACKEND_PATH_PATTERN =
  /(^|\/)(server|backend|api|routes?|router|handlers?|controllers?|services?|middleware|healthz?|status)($|\/|[._-])/i;
const ENDPOINT_BACKEND_REQUEST_PATTERN =
  /\b(endpoint|route|router|handler|api|healthz?|status|server|backend|logging|logger|uptime)\b/i;
const SOURCE_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".php",
  ".rb",
  ".kt",
  ".swift",
]);

const CODE_REQUEST_VERB_PATTERN =
  /\b(add|create|implement|write|update|change|refactor|fix|build|develop|remove|rename)\b/i;
const CODE_REQUEST_ARTIFACT_PATTERN =
  /\b(function|method|class|module|script|endpoint|route|handler|service|api|component|logic|controller|model|file|test|stats?|estimate|estimation|calculation|compute)\b/i;

const isSourceScriptPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized || isDocPath(normalized) || isSupportDoc(normalized)) return false;
  const ext = path.extname(normalized);
  return SOURCE_CODE_EXTENSIONS.has(ext);
};

const requestNeedsCodeContext = (request: string, intent?: IntentSignals): boolean => {
  if (!request.trim()) return false;
  const hasVerb = CODE_REQUEST_VERB_PATTERN.test(request);
  const hasArtifact = CODE_REQUEST_ARTIFACT_PATTERN.test(request);
  if (hasVerb && hasArtifact) return true;
  if (
    intent?.intents.includes("behavior") ||
    intent?.intents.includes("data") ||
    intent?.intents.includes("testing") ||
    intent?.intents.includes("infra") ||
    intent?.intents.includes("security") ||
    intent?.intents.includes("performance") ||
    intent?.intents.includes("observability")
  ) {
    return true;
  }
  return false;
};

const isBackendPath = (value: string): boolean => {
  const normalized = normalizePath(value).toLowerCase();
  if (!normalized) return false;
  if (isDocPath(normalized) || isSupportDoc(normalized) || isTestPath(normalized) || isFrontendPath(normalized)) {
    return false;
  }
  if (BACKEND_PATH_PATTERN.test(normalized)) return true;
  const ext = path.extname(normalized);
  return normalized.startsWith("src/") && SOURCE_CODE_EXTENSIONS.has(ext);
};

const collectBackendCandidates = async (
  workspaceRoot: string,
  request: string,
  limit = 20,
): Promise<string[]> => {
  const allFiles = await listWorkspaceFilesByPattern(workspaceRoot, ".", undefined);
  if (allFiles.length === 0) return [];
  const tokens = tokenizeRequest(request);
  const scored = allFiles
    .map((file) => {
      const normalized = normalizePath(file);
      let score = 0;
      if (isBackendPath(normalized)) score += 8;
      for (const token of tokens) {
        if (normalized.toLowerCase().includes(token)) score += 2;
      }
      if (
        normalized.startsWith("src/") &&
        !isFrontendPath(normalized) &&
        !isDocPath(normalized) &&
        !isTestPath(normalized)
      ) {
        score += 1;
      }
      return { file: normalized, score };
    })
    .sort((a, b) => b.score - a.score);

  const backendOnly = scored.filter((entry) => isBackendPath(entry.file));
  const selected = (backendOnly.length > 0 ? backendOnly : scored.filter((entry) => entry.score > 0)).slice(0, limit);
  return selected.map((entry) => entry.file);
};

const collectCodeCandidates = async (
  workspaceRoot: string,
  request: string,
  preferredFiles: string[],
  fileHints: string[],
  limit = 20,
): Promise<string[]> => {
  const allFiles = uniqueValues([
    ...fileHints.map((entry) => normalizePath(entry)),
    ...(await listWorkspaceFilesByPattern(workspaceRoot, ".", undefined)),
  ]);
  if (!allFiles.length) return [];
  const requestTokens = tokenizeRequest(request);
  const preferredTokens = uniqueValues(
    preferredFiles
      .flatMap((entry) => normalizePath(entry).toLowerCase().split(/[/.\\-_]+/g))
      .filter((entry) => entry.length >= 3),
  );
  const scored = allFiles
    .map((entry) => {
      const normalized = normalizePath(entry);
      if (!isSourceScriptPath(normalized)) return { file: normalized, score: -1000 };
      let score = 0;
      if (isBackendPath(normalized)) score += 3;
      if (isFrontendPath(normalized)) score += 3;
      for (const token of requestTokens) {
        if (normalized.toLowerCase().includes(token)) score += 2;
      }
      for (const token of preferredTokens) {
        if (normalized.toLowerCase().includes(token)) score += 1;
      }
      if (isTestPath(normalized)) score -= 2;
      return { file: normalized, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.file);
};

const collectPatternCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  matcher: (value: string) => boolean,
  limit = 20,
): Promise<string[]> => {
  const tokens = tokenizeRequest(request);
  const allFiles = await listWorkspaceFilesByPattern(workspaceRoot, ".", undefined);
  if (allFiles.length === 0) return [];
  const scored = allFiles
    .map((file) => {
      const normalized = normalizePath(file);
      if (!matcher(normalized)) return { file: normalized, score: -1000 };
      const score = scoreCandidate(normalized, tokens, intent) + 5;
      return { file: normalized, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.file);
};

const collectTestCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => {
  const globHits = await Promise.all(
    TEST_GLOBS.map((pattern) => listWorkspaceFilesByPattern(workspaceRoot, ".", pattern)),
  );
  const candidates = uniqueValues(globHits.flat()).filter((entry) => isTestPath(entry));
  if (candidates.length > 0) {
    return candidates.slice(0, limit);
  }
  return collectPatternCandidates(workspaceRoot, request, intent, isTestPath, limit);
};

const collectInfraCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => {
  const globHits = await Promise.all(
    INFRA_GLOBS.map((pattern) => listWorkspaceFilesByPattern(workspaceRoot, ".", pattern)),
  );
  const candidates = uniqueValues(globHits.flat()).filter((entry) => isInfraPath(entry));
  if (candidates.length > 0) {
    return candidates.slice(0, limit);
  }
  return collectPatternCandidates(workspaceRoot, request, intent, isInfraPath, limit);
};

const collectSecurityCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => collectPatternCandidates(workspaceRoot, request, intent, isSecurityPath, limit);

const collectPerformanceCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => collectPatternCandidates(workspaceRoot, request, intent, isPerformancePath, limit);

const collectObservabilityCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => collectPatternCandidates(workspaceRoot, request, intent, isObservabilityPath, limit);

const selectAnalysisPaths = (
  paths: string[],
  options: {
    intent?: IntentSignals;
    docTask: boolean;
    preferred: string[];
    focus: string[];
    maxPaths: number;
  },
): string[] => {
  if (!paths.length) return [];
  const focus = uniqueValues(options.focus.map((entry) => normalizePath(entry)));
  const preferred = new Set(options.preferred.map((entry) => normalizePath(entry)));
  for (const focusPath of focus) {
    preferred.add(focusPath);
  }
  const intents = options.intent?.intents ?? [];
  const uiOnlyIntent = intents.includes("ui") && intents.every((intent) => intent === "ui" || intent === "content");
  const ranked = uniqueValues(paths.map((entry) => normalizePath(entry)))
    .map((pathValue, index) => {
      let score = 0;
      if (preferred.has(pathValue)) score += 600;
      if (options.intent?.intents.includes("ui") && isFrontendPath(pathValue)) score += 140;
      if (options.intent?.intents.includes("behavior") && supportsImpactGraph(pathValue)) score += 40;
      if (options.intent?.intents.includes("data") && supportsImpactGraph(pathValue)) score += 30;
      if (options.intent?.intents.includes("testing") && isTestPath(pathValue)) score += 120;
      if (options.intent?.intents.includes("infra") && isInfraPath(pathValue)) score += 80;
      if (options.intent?.intents.includes("security") && isSecurityPath(pathValue)) score += 70;
      if (options.intent?.intents.includes("performance") && isPerformancePath(pathValue)) score += 70;
      if (options.intent?.intents.includes("observability") && isObservabilityPath(pathValue)) score += 70;
      if (!options.docTask && isDocPath(pathValue)) score -= 120;
      if (!options.docTask && isSupportDoc(pathValue)) score -= 80;
      if (
        !options.docTask &&
        isTestPath(pathValue) &&
        uiOnlyIntent &&
        !options.intent?.intents.includes("testing")
      ) {
        score -= 50;
      }
      return { path: pathValue, score, index };
    })
    .sort((a, b) => {
      if (a.score === b.score) return a.index - b.index;
      return b.score - a.score;
    });

  const base = ranked.map((entry) => entry.path);
  if (options.docTask) {
    return uniqueValues([...focus, ...base]).slice(0, Math.max(1, options.maxPaths));
  }
  const nonDoc = base.filter((entry) => !isDocPath(entry) && !isSupportDoc(entry));
  if (uiOnlyIntent) {
    const uiNonTest = nonDoc.filter((entry) => !isTestPath(entry));
    if (uiNonTest.length > 0) {
      return uniqueValues([...focus, ...uiNonTest]).slice(0, Math.max(1, options.maxPaths));
    }
  }
  const chosen = nonDoc.length > 0 ? nonDoc : base;
  return uniqueValues([...focus, ...chosen]).slice(0, Math.max(1, options.maxPaths));
};

const MEMORY_NEGATIVE_PATTERN =
  /\b(no|not|missing|misses|lacks|lack|absent|without|does not|doesn't|is not|isn't)\b/i;
const MEMORY_POSITIVE_PATTERN =
  /\b(has|have|contains|includes|exists|present|already|available)\b/i;
const MEMORY_STALE_MARKER_PATTERN = /\b(superseded|obsolete|deprecated|outdated|legacy|old run|previous run)\b/i;
const MEMORY_POLICY_MARKER_PATTERN =
  /\b(write policy|allow_write_paths|read_only_paths|allowed write paths|read-only paths)\b/i;
const MEMORY_TASK_MARKER_PATTERN = /\btask[-_\s]*[a-z0-9-]{4,}\b/i;
const MEMORY_PATCH_INTERPRETER_PATTERN =
  /\b(patch interpreter|patch payload|top-level "patches"|top-level "files"|respond with json only|schema[- ]only|file_writes|search_replace)\b/i;
const REQUEST_PATCH_WORKFLOW_PATTERN =
  /\b(patch|interpreter|schema|json|builder output|search_replace|file_writes)\b/i;
const MEMORY_TOKEN_PATTERN = /[a-z0-9_./-]{3,}/gi;
const MEMORY_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "task",
  "file",
  "path",
  "page",
  "root",
  "main",
  "user",
  "request",
  "develop",
  "developed",
  "developing",
  "build",
  "built",
  "implement",
  "implemented",
  "engine",
]);

type MemoryFact = {
  text: string;
  score: number;
  pathHint?: string;
  polarity: -1 | 0 | 1;
  tokens: Set<string>;
};

const extractPathHint = (text: string): string | undefined => {
  const match = text.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+/);
  return match ? normalizePath(match[0]).toLowerCase() : undefined;
};

const extractMemoryTokens = (text: string): Set<string> => {
  const tokens = new Set<string>();
  const matches = text.toLowerCase().match(MEMORY_TOKEN_PATTERN) ?? [];
  for (const token of matches) {
    if (MEMORY_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
};

const detectPolarity = (text: string): -1 | 0 | 1 => {
  const negative = MEMORY_NEGATIVE_PATTERN.test(text);
  const positive = MEMORY_POSITIVE_PATTERN.test(text);
  if (negative && !positive) return -1;
  if (positive && !negative) return 1;
  return 0;
};

const tokenOverlap = (a: Set<string>, b: Set<string>): number => {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
};

const memoryFactsConflict = (a: MemoryFact, b: MemoryFact): boolean => {
  if (a.polarity === 0 || b.polarity === 0) return false;
  if (a.polarity === b.polarity) return false;
  const overlap = tokenOverlap(a.tokens, b.tokens);
  if (a.pathHint && b.pathHint && a.pathHint === b.pathHint && overlap >= 2) {
    return true;
  }
  return overlap >= 4;
};

const pruneConflictingMemoryFacts = (
  entries: Array<{ content?: string; score?: number }>,
): { facts: Array<{ text: string; source: string }>; pruned: number } => {
  const normalized: MemoryFact[] = entries
    .map((entry, index) => ({
      text: typeof entry.content === "string" ? entry.content.trim() : "",
      score:
        typeof entry.score === "number" && Number.isFinite(entry.score)
          ? entry.score
          : Number.MIN_SAFE_INTEGER + index,
    }))
    .filter((entry) => entry.text.length > 0)
    .map((entry) => ({
      ...entry,
      pathHint: extractPathHint(entry.text),
      polarity: detectPolarity(entry.text),
      tokens: extractMemoryTokens(entry.text),
    }))
    .sort((a, b) => b.score - a.score);

  const kept: MemoryFact[] = [];
  let pruned = 0;
  for (const candidate of normalized) {
    const conflict = kept.some((existing) => memoryFactsConflict(existing, candidate));
    if (conflict) {
      pruned += 1;
      continue;
    }
    kept.push(candidate);
  }
  return {
    facts: kept.map((entry) => ({ text: entry.text, source: "repo" })),
    pruned,
  };
};

const extractPathTokens = (paths: string[]): Set<string> => {
  const tokens = new Set<string>();
  for (const value of paths) {
    const normalized = normalizePath(value).toLowerCase();
    for (const piece of normalized.split(/[/._-]+/)) {
      if (piece.length < 3) continue;
      if (MEMORY_STOP_WORDS.has(piece)) continue;
      tokens.add(piece);
    }
  }
  return tokens;
};

const filterRelevantMemoryFacts = (
  entries: Array<{ text: string; source: string }>,
  request: string,
  focusPaths: string[],
): { facts: Array<{ text: string; source: string }>; filtered: number } => {
  if (!entries.length) return { facts: [], filtered: 0 };
  const normalizedFocusPaths = new Set(
    uniqueValues(focusPaths.map((entry) => normalizePath(entry).toLowerCase())),
  );
  const requestTokens = extractMemoryTokens(request);
  const focusTokens = extractPathTokens(focusPaths);
  const requestPatchWorkflow = REQUEST_PATCH_WORKFLOW_PATTERN.test(request.toLowerCase());
  const scored = entries.map((entry) => {
    const text = entry.text.toLowerCase();
    const memoryTokens = extractMemoryTokens(entry.text);
    const overlapRequest = tokenOverlap(memoryTokens, requestTokens);
    const overlapFocus = tokenOverlap(memoryTokens, focusTokens);
    let score = overlapRequest * 2 + overlapFocus;
    if (MEMORY_STALE_MARKER_PATTERN.test(text)) {
      score -= 4;
    }
    if (MEMORY_POLICY_MARKER_PATTERN.test(text) && overlapRequest === 0 && overlapFocus === 0) {
      score -= 4;
    }
    if (MEMORY_TASK_MARKER_PATTERN.test(text) && overlapRequest === 0 && overlapFocus === 0) {
      score -= 2;
    }
    if (MEMORY_PATCH_INTERPRETER_PATTERN.test(text) && !requestPatchWorkflow) {
      score -= 8;
    }
    const pathHint = extractPathHint(entry.text);
    if (pathHint && normalizedFocusPaths.has(pathHint)) {
      score += 3;
    } else if (pathHint && normalizedFocusPaths.size > 0) {
      score -= 2;
    }
    for (const focusPath of normalizedFocusPaths) {
      if (text.includes(focusPath)) {
        score += 4;
      }
    }
    return { entry, score };
  });

  const kept = scored
    .filter((candidate) => {
      if (normalizedFocusPaths.size === 0 && requestTokens.size === 0) return true;
      const loweredText = candidate.entry.text.toLowerCase();
      if (MEMORY_PATCH_INTERPRETER_PATTERN.test(loweredText) && !requestPatchWorkflow) {
        const hint = extractPathHint(candidate.entry.text);
        if (!(hint && normalizedFocusPaths.has(hint))) {
          return false;
        }
      }
      const minScore = normalizedFocusPaths.size > 0 ? 2 : 3;
      if (candidate.score >= minScore) return true;
      if (normalizedFocusPaths.size > 0) {
        const hint = extractPathHint(candidate.entry.text);
        if (hint && normalizedFocusPaths.has(hint)) return true;
      }
      return false;
    })
    .map((candidate) => candidate.entry);

  return {
    facts: kept,
    filtered: Math.max(0, entries.length - kept.length),
  };
};

const reconcileWarnings = (
  warnings: string[],
  context: {
    intent?: IntentSignals;
    selection?: ContextBundle["selection"];
    index: { last_updated_epoch_ms: number; num_docs: number };
    filesSucceeded: boolean;
    statsSucceeded: boolean;
    snippets: ContextSnippet[];
    files?: ContextBundle["files"];
  },
): string[] => {
  const uniqueWarnings = uniqueValues(warnings);
  const filtered = uniqueWarnings.filter((warning) => {
    if (
      warning === "librarian_ui_candidates" &&
      context.intent?.intents.includes("ui") &&
      context.selection &&
      !context.selection.low_confidence &&
      context.selection.all.some((entry) => isFrontendPath(entry))
    ) {
      return false;
    }
    if (warning === "docdex_low_confidence" && context.selection && !context.selection.low_confidence) {
      return false;
    }
    if (warning === "docdex_ui_no_hits" && context.selection?.all.some((entry) => isFrontendPath(entry))) {
      return false;
    }
    if (
      warning === "docdex_index_empty" &&
      context.statsSucceeded &&
      context.filesSucceeded &&
      context.index.num_docs > 0
    ) {
      return false;
    }
    if (
      warning === "docdex_index_stale" &&
      context.statsSucceeded &&
      context.filesSucceeded &&
      (context.index.last_updated_epoch_ms > 0 || context.snippets.length > 0)
    ) {
      return false;
    }
    if (warning === "docdex_no_hits") {
      const hasActionableContext = (context.selection?.focus.length ?? 0) > 0 ||
        context.snippets.length > 0 ||
        (context.files?.length ?? 0) > 0;
      if (hasActionableContext) {
        return false;
      }
    }
    return true;
  });
  return filtered;
};

const buildRequestDigest = (options: {
  request: string;
  intent: IntentSignals;
  querySignals: QuerySignals;
  selection?: ContextBundle["selection"];
  searchResults: ContextSearchResult[];
  warnings: string[];
}): NonNullable<ContextBundle["request_digest"]> => {
  const focusFiles = options.selection?.focus ?? [];
  const peripheryFiles = options.selection?.periphery ?? [];
  const MARKUP_EXTENSIONS = new Set([
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".styl",
    ".md",
    ".mdx",
  ]);
  const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
  const getExtension = (value: string): string =>
    path.extname(normalizePath(value)).toLowerCase();
  const isMarkup = (value: string): boolean => MARKUP_EXTENSIONS.has(getExtension(value));
  const isScript = (value: string): boolean => SCRIPT_EXTENSIONS.has(getExtension(value));
  const markupOnlyFocus =
    focusFiles.length > 0 && focusFiles.every((entry) => isMarkup(entry));
  const scriptCandidates = (() => {
    if (!markupOnlyFocus) return [];
    const focusDirs = new Set(
      focusFiles.map((entry) => path.posix.dirname(normalizePath(entry))),
    );
    const focusStems = new Set(
      focusFiles.map((entry) => path.posix.basename(normalizePath(entry), getExtension(entry))),
    );
    const ranked = peripheryFiles
      .filter((entry) => isScript(entry))
      .map((entry) => {
        const normalized = normalizePath(entry);
        let score = 0;
        const dir = path.posix.dirname(normalized);
        if (focusDirs.has(dir)) score += 2;
        const stem = path.posix.basename(normalized, getExtension(normalized));
        if (focusStems.has(stem)) score += 1;
        return { path: normalized, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.path);
    return uniqueValues(ranked).slice(0, 2);
  })();
  const signalTerms = uniqueValues([
    ...options.querySignals.keyword_phrases,
    ...options.querySignals.keywords,
    ...options.intent.intents,
    ...Object.values(options.intent.matches).flat(),
  ]).slice(0, 8);
  const topFiles = uniqueValues([...focusFiles, ...scriptCandidates]).slice(0, 4);
  const refinedQuery = uniqueValues([
    options.request.trim(),
    ...signalTerms.slice(0, 5),
    ...topFiles.map((entry) => path.posix.basename(normalizePath(entry))),
  ])
    .filter((entry) => entry.length > 0)
    .slice(0, 6)
    .join(" ");
  const totalHits = options.searchResults.reduce((sum, result) => sum + result.hits.length, 0);
  const lowConfidence = Boolean(options.selection?.low_confidence);
  let confidence: "high" | "medium" | "low" = lowConfidence || totalHits === 0
    ? "low"
    : totalHits < 4 || topFiles.length === 0
      ? "medium"
      : "high";
  if (markupOnlyFocus && scriptCandidates.length > 0 && confidence === "high") {
    confidence = "medium";
  }
  const summaryParts = [
    `Intent buckets: ${options.intent.intents.join(", ") || "behavior"}.`,
    topFiles.length > 0
      ? `Likely implementation surfaces: ${topFiles.join(", ")}.`
      : "Likely implementation surfaces are not yet strongly grounded; treat focus as exploratory.",
    options.warnings.some((warning) => warning.startsWith("docdex_no_hits") || warning === "docdex_low_confidence")
      ? "Request interpretation relies on fuzzy matching and should be validated against selected files."
      : "Request interpretation is grounded in current repository hits and selected files.",
    markupOnlyFocus && scriptCandidates.length > 0
      ? `Focus is markup-only; interactive behavior may require script files (e.g., ${scriptCandidates.join(", ")}).`
      : null,
  ];
  return {
    summary: summaryParts.filter((part): part is string => Boolean(part)).join(" "),
    refined_query: refinedQuery,
    confidence,
    signals: signalTerms,
    candidate_files: topFiles,
  };
};

const listWorkspaceFiles = async (workspaceRoot: string, globs: string[]): Promise<string[]> => {
  try {
    const args = [
      "--files",
      ...EXCLUDED_RG_GLOBS.flatMap((glob) => ["-g", glob]),
      ...globs.flatMap((glob) => ["-g", glob]),
    ];
    const { stdout } = await execFileAsync("rg", args, { cwd: workspaceRoot });
    return filterExcludedPaths(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
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
          if (isExcludedDirName(entry.name)) continue;
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
    return filterExcludedPaths(results);
  }
};

const tokenizeRequest = (request: string): string[] =>
  request
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, " ")
    .split(/\\s+/)
    .filter((token) => token.length >= 3);

const scoreCandidate = (candidate: string, tokens: string[], intent: IntentSignals): number => {
  const normalized = normalizePath(candidate).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) score += 2;
  }
  if (intent.intents.includes("ui")) {
    const ext = path.extname(normalized);
    if (FRONTEND_EXTENSIONS.has(ext)) score += 4;
  }
  for (const bucket of intent.intents) {
    for (const hint of INTENT_HINTS[bucket]) {
      if (normalized.includes(hint)) score += 1;
    }
  }
  return score;
};

const filterRecentFilesForRequest = (
  paths: string[],
  request: string,
  intent: IntentSignals,
): string[] => {
  if (!paths.length) return [];
  const trimmed = filterPlaceholderPaths(paths, request);
  if (trimmed.length === 0) return [];
  const tokens = tokenizeRequest(request);
  if (tokens.length === 0) return trimmed;
  const scored = trimmed.map((entry) => ({
    entry,
    score: scoreCandidate(entry, tokens, intent),
  }));
  const relevant = scored.filter((item) => item.score > 0).map((item) => item.entry);
  return relevant.length > 0 ? relevant : trimmed;
};

const filterSelectionHits = (
  hits: Array<{ doc_id?: string; path?: string; score?: number }>,
  request: string,
  intent: IntentSignals,
  docTask: boolean,
): Array<{ doc_id?: string; path?: string; score?: number }> => {
  if (!hits.length) return hits;
  const tokens = tokenizeRequest(request);
  const requestLower = request.toLowerCase();
  const filtered = hits.filter((hit) => {
    if (!hit.path) return true;
    const normalized = normalizePath(hit.path);
    if (isPlaceholderPath(normalized) && !requestLower.includes(normalized.toLowerCase())) {
      return false;
    }
    const score = tokens.length > 0 ? scoreCandidate(normalized, tokens, intent) : 0;
    if (score > 0) return true;
    if (!docTask && isConfigPath(normalized)) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : hits;
};

const collectFallbackCandidates = async (
  workspaceRoot: string,
  request: string,
  intent: IntentSignals,
  limit = 20,
): Promise<string[]> => {
  const tokens = tokenizeRequest(request);
  const allFiles = await listWorkspaceFilesByPattern(workspaceRoot, ".", undefined);
  if (allFiles.length === 0) return [];
  const scored = allFiles
    .map((file) => ({ file, score: scoreCandidate(file, tokens, intent) }))
    .sort((a, b) => b.score - a.score);
  const nonZero = scored.filter((entry) => entry.score > 0);
  const selected = (nonZero.length ? nonZero : scored).slice(0, limit);
  return selected.map((entry) => entry.file);
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
  const args = ["--files", ...EXCLUDED_RG_GLOBS.flatMap((glob) => ["-g", glob])];
  if (pattern) {
    args.push("-g", pattern);
  }
  if (normalizedRoot && normalizedRoot !== ".") {
    args.push(normalizedRoot);
  }
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd: workspaceRoot });
    return filterExcludedPaths(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
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
          if (isExcludedDirName(entry.name)) continue;
          queue.push(path.join(current, entry.name));
          continue;
        }
        const rel = path.relative(workspaceRoot, path.join(current, entry.name));
        if (!matchPattern(rel, pattern)) continue;
        results.push(rel);
        if (results.length >= 5000) break;
      }
    }
    return filterExcludedPaths(results);
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
  for (const value of Object.values(record)) {
    if (Array.isArray(value) && value.length > 0) return true;
    if (typeof value === "string" && value.trim().length > 0) return true;
    if (typeof value === "number" && Number.isFinite(value)) return true;
    if (typeof value === "boolean" && value) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value as Record<string, unknown>).length > 0) return true;
    }
  }
  return false;
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
  private deepScanPresetApplied = false;

  constructor(client: DocdexClient, options: ContextAssemblerOptions = {}) {
    this.client = client;
    this.logger = options.logger;
    const maxQueries = resolveDepthOption(
      options.maxQueries,
      3,
      CONTEXT_DEPTH_LIMITS.maxQueries,
      "maxQueries",
      this.logger,
    );
    const maxHitsPerQuery = resolveDepthOption(
      options.maxHitsPerQuery,
      3,
      CONTEXT_DEPTH_LIMITS.maxHitsPerQuery,
      "maxHitsPerQuery",
      this.logger,
    );
    const snippetWindow = resolveDepthOption(
      options.snippetWindow,
      120,
      CONTEXT_DEPTH_LIMITS.snippetWindow,
      "snippetWindow",
      this.logger,
    );
    const impactMaxDepth = resolveDepthOption(
      options.impactMaxDepth,
      2,
      CONTEXT_DEPTH_LIMITS.impactMaxDepth,
      "impactMaxDepth",
      this.logger,
    );
    const impactMaxEdges = resolveDepthOption(
      options.impactMaxEdges,
      80,
      CONTEXT_DEPTH_LIMITS.impactMaxEdges,
      "impactMaxEdges",
      this.logger,
    );
    this.options = {
      maxQueries,
      maxHitsPerQuery,
      snippetWindow,
      impactMaxDepth,
      impactMaxEdges,
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
      deepMode: options.deepMode ?? false,
    };
    this.queryProvider = options.queryProvider;
    this.queryTemperature = options.queryTemperature;
    this.agentId = options.agentId ?? "codali";
    this.contextManager = options.contextManager;
    this.laneScope = options.laneScope;
    this.onEvent = options.onEvent;
  }

  applyDeepScanPreset(): void {
    if (this.deepScanPresetApplied) return;
    const before = {
      maxQueries: this.options.maxQueries,
      maxHitsPerQuery: this.options.maxHitsPerQuery,
      snippetWindow: this.options.snippetWindow,
      impactMaxDepth: this.options.impactMaxDepth,
      impactMaxEdges: this.options.impactMaxEdges,
      maxFiles: this.options.maxFiles,
      maxTotalBytes: this.options.maxTotalBytes,
      tokenBudget: this.options.tokenBudget,
    };
    const maxQueries = resolveDepthOption(
      Math.max(this.options.maxQueries, DEEP_SCAN_PRESET.maxQueries),
      this.options.maxQueries,
      CONTEXT_DEPTH_LIMITS.maxQueries,
      "maxQueries",
      this.logger,
    );
    const maxHitsPerQuery = resolveDepthOption(
      Math.max(this.options.maxHitsPerQuery, DEEP_SCAN_PRESET.maxHitsPerQuery),
      this.options.maxHitsPerQuery,
      CONTEXT_DEPTH_LIMITS.maxHitsPerQuery,
      "maxHitsPerQuery",
      this.logger,
    );
    const snippetWindow = resolveDepthOption(
      Math.max(this.options.snippetWindow, DEEP_SCAN_PRESET.snippetWindow),
      this.options.snippetWindow,
      CONTEXT_DEPTH_LIMITS.snippetWindow,
      "snippetWindow",
      this.logger,
    );
    const impactMaxDepth = resolveDepthOption(
      Math.max(this.options.impactMaxDepth, DEEP_SCAN_PRESET.impactMaxDepth),
      this.options.impactMaxDepth,
      CONTEXT_DEPTH_LIMITS.impactMaxDepth,
      "impactMaxDepth",
      this.logger,
    );
    const impactMaxEdges = resolveDepthOption(
      Math.max(this.options.impactMaxEdges, DEEP_SCAN_PRESET.impactMaxEdges),
      this.options.impactMaxEdges,
      CONTEXT_DEPTH_LIMITS.impactMaxEdges,
      "impactMaxEdges",
      this.logger,
    );
    this.options = {
      ...this.options,
      maxQueries,
      maxHitsPerQuery,
      snippetWindow,
      impactMaxDepth,
      impactMaxEdges,
      maxFiles: Math.max(this.options.maxFiles, DEEP_SCAN_PRESET.maxFiles),
      maxTotalBytes: Math.max(this.options.maxTotalBytes, DEEP_SCAN_PRESET.maxTotalBytes),
      tokenBudget: Math.max(this.options.tokenBudget, DEEP_SCAN_PRESET.tokenBudget),
    };
    this.deepScanPresetApplied = true;
    void this.logger?.log("context_deep_scan_preset", {
      applied: true,
      before,
      after: {
        maxQueries: this.options.maxQueries,
        maxHitsPerQuery: this.options.maxHitsPerQuery,
        snippetWindow: this.options.snippetWindow,
        impactMaxDepth: this.options.impactMaxDepth,
        impactMaxEdges: this.options.impactMaxEdges,
        maxFiles: this.options.maxFiles,
        maxTotalBytes: this.options.maxTotalBytes,
        tokenBudget: this.options.tokenBudget,
      },
    });
  }

  async runResearchTools(request: string, context: ContextBundle): Promise<ResearchToolExecution> {
    const warnings: string[] = [];
    const toolRuns: ResearchToolRun[] = [];
    const outputs: ResearchToolExecution["outputs"] = {
      searchResults: [],
      snippets: [],
      symbols: [],
      ast: [],
      impact: [],
      impactDiagnostics: [],
    };
    const pushWarning = (warning: string): void => {
      if (!warnings.includes(warning)) warnings.push(warning);
    };
    const emit = this.onEvent;
    const emitToolCall = (name: string, args?: unknown) => {
      emit?.({ type: "tool_call", name, args: args ?? {} });
    };
    const emitToolResult = (name: string, output: string, ok = true) => {
      emit?.({ type: "tool_result", name, output, ok });
    };
    const formatToolNotes = (args: Record<string, unknown>): string | undefined => {
      if (typeof args.query === "string") return `query:${args.query}`;
      if (typeof args.file === "string") return `file:${args.file}`;
      if (typeof args.doc_id === "string") return `doc_id:${args.doc_id}`;
      if (typeof args.path === "string") return `path:${args.path}`;
      if (typeof args.sessionId === "string") return `session:${args.sessionId}`;
      if (typeof args.session_id === "string") return `session:${args.session_id}`;
      return undefined;
    };
    const recordToolRun = (
      tool: string,
      ok: boolean,
      extra: Partial<ResearchToolRun> = {},
    ): void => {
      toolRuns.push({ tool, ok, ...extra });
    };

    const maxQueries = Math.max(1, this.options.maxQueries);
    let queries = uniqueValues(context.queries ?? []);
    if (queries.length === 0) {
      const requestQuery = request.trim();
      queries = uniqueValues([requestQuery, ...extractQueries(request, maxQueries)]);
    }
    queries = queries.filter(Boolean).slice(0, maxQueries);
    if (queries.length === 0) {
      pushWarning("research_no_queries");
    }

    const hitList: Array<{ doc_id?: string; path?: string; score?: number }> = [];
    const searchResults: ContextSearchResult[] = [];
    for (const query of queries) {
      const args = {
        query,
        limit: this.options.maxHitsPerQuery,
        dagSessionId: this.laneScope?.runId,
      };
      emitToolCall("docdex.search", args);
      const startedAt = Date.now();
      try {
        const result = await this.client.search(query, {
          limit: this.options.maxHitsPerQuery,
          dagSessionId: this.laneScope?.runId,
        });
        const hits = collectHits(result).filter(
          (hit) => !hit.path || !isExcludedPath(hit.path),
        );
        hitList.push(...hits);
        searchResults.push({ query, hits });
        emitToolResult("docdex.search", "ok", true);
        recordToolRun("docdex.search", true, {
          durationMs: Date.now() - startedAt,
          notes: `query:${query} hits:${hits.length}`,
        });
      } catch (error) {
        searchResults.push({ query, hits: [] });
        emitToolResult(
          "docdex.search",
          error instanceof Error ? error.message : String(error),
          false,
        );
        pushWarning("research_docdex_search_failed");
        recordToolRun("docdex.search", false, {
          durationMs: Date.now() - startedAt,
          notes: formatToolNotes(args),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    outputs.searchResults = searchResults;

    const uniqueHits = hitList.filter((hit, index, self) => {
      const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
      return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
    });
    const intent = context.intent ?? deriveIntentSignals(request);
    const docTask = /\b(doc|docs|documentation|readme|rfp|sds|pdr)\b/i.test(request);
    const selection = context.selection;
    const selectionPaths = uniqueValues([
      ...(selection?.all ?? []),
      ...(selection?.focus ?? []),
      ...(selection?.periphery ?? []),
      ...(context.files ?? []).map((entry) => entry.path),
      ...uniqueHits
        .map((hit) => hit.path)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ]);
    const analysisPaths = selectAnalysisPaths(selectionPaths, {
      intent,
      docTask,
      preferred: selection?.focus ?? [],
      focus: selection?.focus ?? [],
      maxPaths: Math.min(this.options.maxFiles, 6),
    });
    const analysisPathSet = new Set(analysisPaths.map((entry) => normalizePath(entry)));

    const includeSnippets = this.options.includeSnippets || this.options.deepMode;
    if (includeSnippets) {
      for (const hit of uniqueHits) {
        if (!hit.doc_id) continue;
        if (analysisPathSet.size && hit.path && !analysisPathSet.has(normalizePath(hit.path))) {
          continue;
        }
        const args = { doc_id: hit.doc_id, window: this.options.snippetWindow };
        emitToolCall("docdex.snippet", args);
        const startedAt = Date.now();
        try {
          const snippetResult = await this.client.openSnippet(hit.doc_id, {
            window: this.options.snippetWindow,
          });
          outputs.snippets.push({
            doc_id: hit.doc_id,
            path: hit.path,
            content: extractSnippetContent(snippetResult),
          });
          emitToolResult("docdex.snippet", "ok", true);
          recordToolRun("docdex.snippet", true, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
          });
        } catch (error) {
          emitToolResult(
            "docdex.snippet",
            error instanceof Error ? error.message : String(error),
            false,
          );
          pushWarning(`research_docdex_snippet_failed:${hit.doc_id}`);
          recordToolRun("docdex.snippet", false, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const snippetPathSet = new Set(
        outputs.snippets
          .map((entry) => entry.path)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .map((entry) => normalizePath(entry)),
      );
      const clientWithOpen = this.client as unknown as {
        openFile?: (pathValue: string, options?: unknown) => Promise<unknown>;
      };
      if (typeof clientWithOpen.openFile === "function") {
        for (const focusPath of selection?.focus ?? []) {
          const normalizedFocus = normalizePath(focusPath);
          if (snippetPathSet.has(normalizedFocus)) continue;
          const args = { path: focusPath, head: this.options.snippetWindow, clamp: true };
          emitToolCall("docdex.open", args);
          const startedAt = Date.now();
          try {
            const openResult = await clientWithOpen.openFile(focusPath, {
              head: this.options.snippetWindow,
              clamp: true,
            });
            outputs.snippets.push({
              path: focusPath,
              content: extractSnippetContent(openResult),
            });
            snippetPathSet.add(normalizedFocus);
            emitToolResult("docdex.open", "ok", true);
            recordToolRun("docdex.open", true, {
              durationMs: Date.now() - startedAt,
              notes: formatToolNotes(args),
            });
          } catch (error) {
            emitToolResult(
              "docdex.open",
              error instanceof Error ? error.message : String(error),
              false,
            );
            pushWarning(`research_docdex_open_failed:${focusPath}`);
            recordToolRun("docdex.open", false, {
              durationMs: Date.now() - startedAt,
              notes: formatToolNotes(args),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    const includeImpact = this.options.includeImpact || this.options.deepMode;
    for (const file of analysisPaths) {
      if (supportsSymbolAnalysis(file)) {
        const args = { file };
        emitToolCall("docdex.symbols", args);
        const startedAt = Date.now();
        try {
          const symbolsResult = await this.client.symbols(file);
          outputs.symbols.push({ path: file, summary: summarizeSymbolsPayload(symbolsResult) });
          emitToolResult("docdex.symbols", "ok", true);
          recordToolRun("docdex.symbols", true, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
          });
        } catch (error) {
          emitToolResult(
            "docdex.symbols",
            error instanceof Error ? error.message : String(error),
            false,
          );
          pushWarning(`research_docdex_symbols_failed:${file}`);
          recordToolRun("docdex.symbols", false, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!isDocPath(file) && !isSupportDoc(file) && supportsAstAnalysis(file)) {
        const args = { file };
        emitToolCall("docdex.ast", args);
        const startedAt = Date.now();
        try {
          const astResult = await this.client.ast(file);
          outputs.ast.push({ path: file, nodes: compactAstNodes(astResult) });
          emitToolResult("docdex.ast", "ok", true);
          recordToolRun("docdex.ast", true, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
          });
        } catch (error) {
          emitToolResult(
            "docdex.ast",
            error instanceof Error ? error.message : String(error),
            false,
          );
          pushWarning(`research_docdex_ast_failed:${file}`);
          recordToolRun("docdex.ast", false, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (includeImpact && supportsImpactGraph(file)) {
        const args = {
          file,
          maxDepth: this.options.impactMaxDepth,
          maxEdges: this.options.impactMaxEdges,
        };
        emitToolCall("docdex.impact", args);
        const startedAt = Date.now();
        try {
          const impactResult = await this.client.impactGraph(file, {
            maxDepth: this.options.impactMaxDepth,
            maxEdges: this.options.impactMaxEdges,
          });
          const inbound = (impactResult as { inbound?: string[] } | undefined)?.inbound ?? [];
          const outbound = (impactResult as { outbound?: string[] } | undefined)?.outbound ?? [];
          outputs.impact.push({ file, inbound, outbound });
          emitToolResult("docdex.impact", "ok", true);
          recordToolRun("docdex.impact", true, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
          });
          if (!inbound.length && !outbound.length) {
            const diagArgs = { file, limit: 20 };
            emitToolCall("docdex.impact_diagnostics", diagArgs);
            const diagStarted = Date.now();
            try {
              const diagnostics = await this.client.impactDiagnostics({
                file,
                limit: 20,
              });
              outputs.impactDiagnostics.push({ file, diagnostics });
              emitToolResult("docdex.impact_diagnostics", "ok", true);
              recordToolRun("docdex.impact_diagnostics", true, {
                durationMs: Date.now() - diagStarted,
                notes: formatToolNotes(diagArgs),
              });
            } catch (error) {
              emitToolResult(
                "docdex.impact_diagnostics",
                error instanceof Error ? error.message : String(error),
                false,
              );
              pushWarning(`research_docdex_impact_diagnostics_failed:${file}`);
              recordToolRun("docdex.impact_diagnostics", false, {
                durationMs: Date.now() - diagStarted,
                notes: formatToolNotes(diagArgs),
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          emitToolResult(
            "docdex.impact",
            error instanceof Error ? error.message : String(error),
            false,
          );
          pushWarning(`research_docdex_impact_failed:${file}`);
          recordToolRun("docdex.impact", false, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(args),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const includeRepoMap = this.options.includeRepoMap || this.options.deepMode;
    const cachedRepoMapRaw = context.repo_map_raw ?? context.repo_map;
    if (includeRepoMap && cachedRepoMapRaw) {
      outputs.repoMapRaw = cachedRepoMapRaw;
      outputs.repoMap = context.repo_map ?? compactTreeForPrompt(cachedRepoMapRaw);
      recordToolRun("docdex.tree", true, {
        skipped: true,
        notes: "repo_map_cached",
      });
    } else if (includeRepoMap) {
      const clientWithTree = this.client as unknown as { tree?: (options?: unknown) => Promise<unknown> };
      if (typeof clientWithTree.tree === "function") {
        const treeOptions = {
          includeHidden: true,
          path: ".",
          maxDepth: 64,
          extraExcludes: REPO_TREE_EXCLUDES,
        };
        emitToolCall("docdex.tree", treeOptions);
        const startedAt = Date.now();
        try {
          const treeResult = await clientWithTree.tree(treeOptions);
          const treeText = extractTreeText(treeResult) ?? toStringPayload(treeResult);
          outputs.repoMapRaw = treeText;
          outputs.repoMap = compactTreeForPrompt(treeText);
          emitToolResult("docdex.tree", "ok", true);
          recordToolRun("docdex.tree", true, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(treeOptions),
          });
        } catch (error) {
          emitToolResult(
            "docdex.tree",
            error instanceof Error ? error.message : String(error),
            false,
          );
          pushWarning("research_docdex_tree_failed");
          recordToolRun("docdex.tree", false, {
            durationMs: Date.now() - startedAt,
            notes: formatToolNotes(treeOptions),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const clientWithDag = this.client as unknown as {
      dagExport?: (
        sessionId: string,
        options?: { format?: "json" | "text" | "dot"; maxNodes?: number },
      ) => Promise<unknown>;
    };
    if (context.dag_summary) {
      outputs.dagSummary = context.dag_summary;
      recordToolRun("docdex.dag_export", true, {
        skipped: true,
        notes: "dag_summary_cached",
      });
    } else if (this.laneScope?.runId && typeof clientWithDag.dagExport === "function") {
      const dagOptions = { format: "text" as const, maxNodes: 160 };
      emitToolCall("docdex.dag_export", { sessionId: this.laneScope.runId, ...dagOptions });
      const startedAt = Date.now();
      try {
        const dagResult = await clientWithDag.dagExport(this.laneScope.runId, dagOptions);
        outputs.dagSummary = typeof dagResult === "string"
          ? dagResult
          : truncateText(toStringPayload(dagResult), 4_000);
        emitToolResult("docdex.dag_export", "ok", true);
        recordToolRun("docdex.dag_export", true, {
          durationMs: Date.now() - startedAt,
          notes: `session:${this.laneScope.runId}`,
        });
      } catch (error) {
        emitToolResult(
          "docdex.dag_export",
          error instanceof Error ? error.message : String(error),
          false,
        );
        pushWarning("research_docdex_dag_export_failed");
        recordToolRun("docdex.dag_export", false, {
          durationMs: Date.now() - startedAt,
          notes: `session:${this.laneScope.runId}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      recordToolRun("docdex.dag_export", false, {
        skipped: true,
        notes: this.laneScope?.runId ? "dag_export_unavailable" : "missing_run_id",
      });
    }

    return { toolRuns, warnings, outputs };
  }

  async assemble(
    request: string,
    options: {
      additionalQueries?: string[];
      preferredFiles?: string[];
      recentFiles?: string[];
      forceFocusFiles?: string[];
    } = {},
  ): Promise<ContextBundle> {
    const warnings: string[] = [];
    const pushWarning = (warning: string): void => {
      if (!warnings.includes(warning)) warnings.push(warning);
    };
    if (this.deepScanPresetApplied) {
      pushWarning("deep_scan_preset_applied");
    }
    let searchResults: ContextSearchResult[] = [];
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
    const requestQuery = request.trim();
    const querySignals = extractQuerySignals(request);
    const maxQueries = Math.max(1, this.options.maxQueries);
    const baseQueries = extractQueries(request, maxQueries);
    const intent = deriveIntentSignals(request);
    const docTask = /\b(doc|docs|documentation|readme|rfp|sds|pdr)\b/i.test(request);
    const supplementalQueries = uniqueValues(options.additionalQueries ?? []);
    let queries = uniqueValues([requestQuery, ...supplementalQueries, ...baseQueries]).slice(0, maxQueries);
    const preferencesDetected = extractPreferences(request);
    const preferredSeed = filterPlaceholderPaths(
      filterExcludedPaths(
        uniqueValues([
          ...(this.options.preferredFiles ?? []),
          ...(options.preferredFiles ?? []),
        ]),
      ),
      request,
    );
    const recentFiles = filterRecentFilesForRequest(
      filterExcludedPaths(
        uniqueValues([
          ...(this.options.recentFiles ?? []),
          ...(options.recentFiles ?? []),
        ]),
      ),
      request,
      intent,
    );
    const forceFocusFiles = filterPlaceholderPaths(
      filterExcludedPaths(uniqueValues(options.forceFocusFiles ?? [])),
      request,
    );
    const contextManager = this.contextManager;
    const laneScope = this.laneScope;

    let healthOk = false;
    emitToolCall("docdex.health", {});
    try {
      await this.client.healthCheck();
      emitToolResult("docdex.health", "ok", true);
      healthOk = true;
    } catch (error) {
      emitToolResult(
        "docdex.health",
        error instanceof Error ? error.message : String(error),
        false,
      );
      if (this.options.deepMode) {
        const missing = ["docdex_health"];
        const remediation = [
          "Ensure docdex daemon is running",
          "Verify CODALI_DOCDEX_BASE_URL/DOCDEX_HTTP_BASE_URL",
          "Run docdexd index for this repo",
        ];
        void this.logger?.log("deep_mode_docdex_failure", {
          missing,
          remediation,
          error: error instanceof Error ? error.message : String(error),
        });
        throw buildDeepModeDocdexError(missing, remediation);
      }
      pushWarning("docdex_unavailable");
      const maxFiles = Math.max(1, this.options.maxFiles);
      let fallbackFocus = filterExcludedPaths(
        uniqueValues([...forceFocusFiles, ...preferredSeed]),
      ).slice(0, maxFiles);
      if (fallbackFocus.length === 0 && this.options.workspaceRoot) {
        try {
          fallbackFocus = filterExcludedPaths(
            await collectFallbackCandidates(this.options.workspaceRoot, requestQuery, intent, maxFiles),
          ).slice(0, maxFiles);
        } catch {
          fallbackFocus = [];
        }
      }
      let contextFiles: ContextFileEntry[] = [];
      if (fallbackFocus.length > 0) {
        try {
          const loader = new ContextFileLoader(this.client, {
            workspaceRoot: this.options.workspaceRoot,
            readStrategy: "fs",
            focusMaxFileBytes: this.options.focusMaxFileBytes,
            peripheryMaxBytes: this.options.peripheryMaxBytes,
            skeletonizeLargeFiles: this.options.skeletonizeLargeFiles,
          });
          contextFiles = await loader.loadFocus(fallbackFocus);
          if (loader.loadErrors.length > 0) {
            for (const entry of loader.loadErrors) {
              pushWarning(`context_file_load_failed:${entry.path}`);
            }
          }
          if (contextFiles.length > 0) {
            pushWarning("context_fs_fallback");
          }
        } catch {
          contextFiles = [];
        }
      }
      const focusPaths = contextFiles.map((entry) => entry.path);
      const selection = focusPaths.length > 0
        ? {
            focus: focusPaths,
            periphery: [] as string[],
            all: focusPaths,
            low_confidence: true,
          }
        : undefined;
      const missing: string[] = ["docdex_unavailable"];
      if (contextFiles.length === 0) missing.push("no_context_files_loaded");
      if (!selection || selection.focus.length === 0) missing.push("no_focus_files_selected");
      const readmeSummary = await loadReadmeSummary(this.options.workspaceRoot);
      const projectInfo: ContextProjectInfo | undefined = this.options.workspaceRoot
        ? {
            workspace_root: this.options.workspaceRoot,
            readme_path: readmeSummary?.path,
            readme_summary: readmeSummary?.summary,
          }
        : undefined;
      const bundle: ContextBundle = {
        request,
        intent,
        query_signals: querySignals,
        queries,
        snippets: [],
        symbols: [],
        ast: [],
        impact: [],
        impact_diagnostics: [],
        memory: [],
        preferences_detected: preferencesDetected,
        profile: [],
        files: contextFiles.length > 0 ? contextFiles : undefined,
        project_info: projectInfo,
        selection,
        index: { last_updated_epoch_ms: 0, num_docs: 0 },
        warnings,
        missing,
      };
      bundle.request_digest = buildRequestDigest({
        request,
        intent,
        querySignals,
        selection,
        searchResults: [],
        warnings,
      });
      const sanitizedBundle = sanitizeContextBundleForOutput(bundle);
      bundle.serialized = serializeContext(sanitizedBundle, {
        mode: this.options.serializationMode ?? "bundle_text",
        audience: "librarian",
      });
      return bundle;
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
    emitToolCall("docdex.stats", {});
    const statsResult = await retryDocdexCall(() => this.client.stats());
    if (statsResult.ok) {
      stats = statsResult.value;
      statsSucceeded = true;
      emitToolResult("docdex.stats", "ok", true);
    } else {
      emitToolResult(
        "docdex.stats",
        statsResult.error instanceof Error
          ? statsResult.error.message
          : String(statsResult.error),
        false,
      );
      pushWarning("docdex_stats_failed");
      if (statsResult.backoff) {
        pushWarning("docdex_stats_backoff");
      }
    }
    let fileHints: string[] = [];
    let filesSucceeded = false;
    emitToolCall("docdex.files", { limit: 20, offset: 0 });
    const filesResult = await retryDocdexCall(() => this.client.files(20, 0));
    if (filesResult.ok) {
      fileHints = filterExcludedPaths(extractFileHints(filesResult.value));
      filesSucceeded = true;
      emitToolResult("docdex.files", "ok", true);
    } else {
      emitToolResult(
        "docdex.files",
        filesResult.error instanceof Error
          ? filesResult.error.message
          : String(filesResult.error),
        false,
      );
      pushWarning("docdex_files_failed");
      if (filesResult.backoff) {
        pushWarning("docdex_files_backoff");
      }
    }

    if (this.options.deepMode) {
      const missing: string[] = [];
      if (!healthOk) missing.push("docdex_health");
      if (!statsSucceeded) missing.push("docdex_stats");
      if (!filesSucceeded) missing.push("docdex_files");
      const statsRecord = stats as { num_docs?: number; last_updated_epoch_ms?: number };
      const numDocs = typeof statsRecord.num_docs === "number" ? statsRecord.num_docs : 0;
      const lastUpdated = typeof statsRecord.last_updated_epoch_ms === "number"
        ? statsRecord.last_updated_epoch_ms
        : 0;
      if (statsSucceeded && numDocs <= 0) missing.push("docdex_index_empty");
      if (statsSucceeded && lastUpdated === 0) missing.push("docdex_index_stale");
      if (filesSucceeded && fileHints.length === 0) missing.push("docdex_file_coverage");
      if (missing.length) {
        const remediation = [
          "Run docdexd index for this repo",
          "Verify docdex repo root/id configuration",
          "Check docdex daemon health",
        ];
        void this.logger?.log("deep_mode_docdex_failure", { missing, remediation });
        throw buildDeepModeDocdexError(missing, remediation);
      }
    }

    let inferredPreferred = filterExcludedPaths(
      inferPreferredFiles(request, fileHints, intent, docTask),
    );
    const uiIntent = intent.intents.includes("ui");
    const needsUiScaffoldHints =
      uiIntent && this.options.workspaceRoot && !hasUiScaffold(inferredPreferred);
    if (needsUiScaffoldHints) {
      const fsHints = await listWorkspaceFiles(this.options.workspaceRoot, FRONTEND_GLOBS);
      if (fsHints.length) {
        fileHints = filterExcludedPaths(uniqueValues([...fileHints, ...fsHints]));
        inferredPreferred = filterExcludedPaths(
          inferPreferredFiles(request, fileHints, intent, docTask),
        );
      }
    }
    let supportDocs = filterExcludedPaths(fileHints.filter(isSupportDoc));
    if (supportDocs.length === 0 && this.options.workspaceRoot) {
      const docsFromDisk = await listWorkspaceFilesByPattern(this.options.workspaceRoot, "docs", "**/*");
      supportDocs = filterExcludedPaths(docsFromDisk.filter(isSupportDoc));
    }
    const companionAnchorPaths = uniqueValues([...preferredSeed, ...inferredPreferred]);
    let companionPreferred = filterExcludedPaths(
      inferCompanionFiles(companionAnchorPaths, fileHints),
    );
    if (companionPreferred.length === 0 && this.options.workspaceRoot && companionAnchorPaths.length > 0) {
      const siblingHints = await Promise.all(
        companionAnchorPaths.slice(0, 4).map(async (anchorPath) => {
          const anchorDir = path.posix.dirname(normalizePath(anchorPath));
          return listWorkspaceFilesByPattern(
            this.options.workspaceRoot!,
            anchorDir && anchorDir !== "." ? anchorDir : ".",
            "**/*",
          );
        }),
      );
      const siblingFiles = filterExcludedPaths(uniqueValues(siblingHints.flat()));
      if (siblingFiles.length > 0) {
        fileHints = filterExcludedPaths(uniqueValues([...fileHints, ...siblingFiles]));
        companionPreferred = filterExcludedPaths(
          inferCompanionFiles(companionAnchorPaths, fileHints),
        );
      }
    }
    if (companionPreferred.length > 0) {
      pushWarning("librarian_companion_candidates");
    }
    let preferredFiles = filterExcludedPaths(
      uniqueValues([...preferredSeed, ...inferredPreferred, ...companionPreferred]),
    );
    preferredFiles = filterPlaceholderPaths(preferredFiles, request);
    if (docTask && supportDocs.length > 0) {
      preferredFiles = filterExcludedPaths(
        uniqueValues([...preferredFiles, ...supportDocs]),
      );
    }
    const queryHintSources =
      inferredPreferred.length > 0 || companionPreferred.length > 0
        ? uniqueValues([...inferredPreferred, ...companionPreferred])
        : preferredSeed.filter((path) => !isDocPath(path));
    const hintBudget = Math.max(0, maxQueries - (requestQuery ? 1 : 0));
    const fileQueryHints = buildFileQueryHints(queryHintSources, hintBudget);
    if (requestQuery || fileQueryHints.length > 0) {
      const remaining = queries.filter((query) => query !== requestQuery);
      queries = uniqueValues([
        ...(requestQuery ? [requestQuery] : []),
        ...fileQueryHints,
        ...remaining,
      ]).slice(0, maxQueries);
    }
    let searchExecutionQueries = buildSearchExecutionQueries(
      request,
      queries,
      querySignals,
      maxQueries,
    );
    const skipSearchWhenPreferred =
      this.options.skipSearchWhenPreferred && preferredFiles.length > 0;

    const runSearch = async (queriesToUse: string[]) => {
      const hitList: Array<{ doc_id?: string; path?: string; score?: number }> = [];
      const results: ContextSearchResult[] = [];
      let searchSucceeded = false;
      for (const query of queriesToUse) {
        try {
          emitToolCall("docdex.search", {
            query,
            limit: this.options.maxHitsPerQuery,
            dagSessionId: laneScope?.runId,
          });
          const result = await this.client.search(query, {
            limit: this.options.maxHitsPerQuery,
            dagSessionId: laneScope?.runId,
          });
          const hits = collectHits(result).filter(
            (hit) => !hit.path || !isExcludedPath(hit.path),
          );
          hitList.push(...hits);
          results.push({ query, hits });
          searchSucceeded = true;
          emitToolResult("docdex.search", "ok", true);
        } catch {
          results.push({ query, hits: [] });
          emitToolResult("docdex.search", "failed", false);
          pushWarning("docdex_search_failed");
        }
      }
      return { hitList, searchSucceeded, searchResults: results };
    };

    let hitList: Array<{ doc_id?: string; path?: string }> = [];
    let searchSucceeded = false;
    if (skipSearchWhenPreferred) {
      searchSucceeded = true;
      warnings.push("docdex_search_skipped");
    } else {
      emitStatus("thinking", "librarian: search");
      const initialSearch = await runSearch(searchExecutionQueries);
      hitList = initialSearch.hitList;
      searchSucceeded = initialSearch.searchSucceeded;
      searchResults = initialSearch.searchResults;
    }

    let uniqueHits = hitList.filter((hit, index, self) => {
      const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
      return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
    });

    const lowHitThreshold = Math.min(2, this.options.maxHitsPerQuery);
    const shouldExpandQueries =
      !skipSearchWhenPreferred &&
      (uniqueHits.length < lowHitThreshold || !searchSucceeded || searchExecutionQueries.length === 0);
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
          searchExecutionQueries = buildSearchExecutionQueries(
            request,
            queries,
            querySignals,
            maxQueries,
          );
          const expandedSearch = await runSearch(searchExecutionQueries);
          hitList = expandedSearch.hitList;
          searchSucceeded = expandedSearch.searchSucceeded;
          searchResults = expandedSearch.searchResults;
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

    const shouldAdaptiveRetry =
      !skipSearchWhenPreferred &&
      searchSucceeded &&
      uniqueHits.length === 0;
    if (shouldAdaptiveRetry) {
      const adaptiveQueries = buildAdaptiveSearchQueries(
        request,
        queries,
        intent,
        preferredFiles,
        Math.max(1, this.options.maxQueries),
      );
      if (adaptiveQueries.join("\n") !== queries.join("\n")) {
        emitStatus("thinking", "librarian: adaptive query refresh");
        queries = adaptiveQueries;
        searchExecutionQueries = buildSearchExecutionQueries(
          request,
          queries,
          querySignals,
          maxQueries,
        );
        const adaptiveSearch = await runSearch(searchExecutionQueries);
        hitList = adaptiveSearch.hitList;
        searchSucceeded = adaptiveSearch.searchSucceeded;
        searchResults = adaptiveSearch.searchResults;
        uniqueHits = hitList.filter((hit, index, self) => {
          const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
          return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
        });
        if (uniqueHits.length > 0) {
          pushWarning("docdex_adaptive_search_retry");
        }
      }
    }

    const shouldUiSourceBiasRetry =
      !skipSearchWhenPreferred &&
      searchSucceeded &&
      intent.intents.includes("ui") &&
      uniqueHits.length > 0 &&
      isDocDominantHits(uniqueHits);
    if (shouldUiSourceBiasRetry) {
      const sourceBiasedQueries = buildUiSourceBiasedQueries(
        request,
        queries,
        preferredFiles,
        fileHints,
        Math.max(1, this.options.maxQueries + 2),
      );
      emitStatus("thinking", "librarian: ui source-biased refresh");
      const sourceBiasedSearch = await runSearch(sourceBiasedQueries);
      const sourceUniqueHits = sourceBiasedSearch.hitList.filter((hit, index, self) => {
        const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
        return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
      });
      const sourceHasNonDoc = sourceUniqueHits.some((hit) => {
        const pathValue = hit.path ?? "";
        return Boolean(pathValue) && !isDocPath(pathValue) && !isSupportDoc(pathValue);
      });
      if (sourceHasNonDoc) {
        searchExecutionQueries = sourceBiasedQueries;
        queries = uniqueValues([...sourceBiasedQueries, ...queries]).slice(0, Math.max(1, this.options.maxQueries));
        hitList = sourceBiasedSearch.hitList;
        searchSucceeded = sourceBiasedSearch.searchSucceeded;
        searchResults = sourceBiasedSearch.searchResults;
        uniqueHits = sourceUniqueHits;
        pushWarning("docdex_ui_source_bias_retry");
      } else if (sourceBiasedSearch.searchSucceeded) {
        pushWarning("docdex_ui_source_bias_retry_no_source_hits");
      }
    }

    uniqueHits = reorderHits(uniqueHits);
    const selectionHits = filterSelectionHits(uniqueHits, request, intent, docTask);
    const hitsForSelection = selectionHits.length > 0 ? selectionHits : uniqueHits;

    const selectionOptions = {
      maxFiles: this.options.maxFiles,
      minHitCount: Math.min(2, this.options.maxHitsPerQuery),
    };
    const computeSelection = (impactInput: ContextImpactSummary[]) => {
      const selected = selectContextFiles(
        {
          hits: hitsForSelection,
          impact: impactInput,
          intent,
          docTask,
          recentFiles,
          preferredFiles,
        },
        selectionOptions,
      );
      return applyForcedFocusSelection(
        selected,
        forceFocusFiles,
        selectionOptions.maxFiles,
      );
    };
    let selection = computeSelection([]);

    const needsUiFallback =
      intent?.intents.includes("ui") &&
      selection?.all &&
      !hasUiScaffold(selection.all);
    if (needsUiFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: ui fallback discovery");
      const uiCandidates = await listWorkspaceFiles(this.options.workspaceRoot, FRONTEND_GLOBS);
      if (uiCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...uiCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_ui_candidates");
      }
    }

    const needsTestingFallback =
      intent?.intents.includes("testing") &&
      selection?.all &&
      !selection.all.some((entry) => isTestPath(entry));
    if (needsTestingFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: testing fallback discovery");
      const testingCandidates = await collectTestCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (testingCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...testingCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_testing_candidates");
      }
    }

    const needsInfraFallback =
      intent?.intents.includes("infra") &&
      selection?.all &&
      !selection.all.some((entry) => isInfraPath(entry));
    if (needsInfraFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: infra fallback discovery");
      const infraCandidates = await collectInfraCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (infraCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...infraCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_infra_candidates");
      }
    }

    const needsSecurityFallback =
      intent?.intents.includes("security") &&
      selection?.all &&
      !selection.all.some((entry) => isSecurityPath(entry));
    if (needsSecurityFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: security fallback discovery");
      const securityCandidates = await collectSecurityCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (securityCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...securityCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_security_candidates");
      }
    }

    const needsObservabilityFallback =
      intent?.intents.includes("observability") &&
      selection?.all &&
      !selection.all.some((entry) => isObservabilityPath(entry));
    if (needsObservabilityFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: observability fallback discovery");
      const observabilityCandidates = await collectObservabilityCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (observabilityCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...observabilityCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_observability_candidates");
      }
    }

    const needsPerformanceFallback =
      intent?.intents.includes("performance") &&
      selection?.all &&
      !selection.all.some((entry) => isPerformancePath(entry));
    if (needsPerformanceFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: performance fallback discovery");
      const performanceCandidates = await collectPerformanceCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (performanceCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...performanceCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_performance_candidates");
      }
    }

    const wantsBackendIntent =
      Boolean(intent?.intents.includes("behavior")) && ENDPOINT_BACKEND_REQUEST_PATTERN.test(request);
    const needsBackendFallback =
      wantsBackendIntent &&
      Boolean(selection?.all) &&
      !selection.all.some((entry) => isBackendPath(entry));
    if (needsBackendFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: backend fallback discovery");
      const backendCandidates = await collectBackendCandidates(
        this.options.workspaceRoot,
        request,
        Math.max(10, this.options.maxFiles),
      );
      if (backendCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...backendCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_backend_candidates");
      }
    }

    const needsCodeFallback =
      requestNeedsCodeContext(request, intent) &&
      Boolean(selection?.all) &&
      !selection.all.some((entry) => isSourceScriptPath(entry));
    if (needsCodeFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: code fallback discovery");
      const codeCandidates = await collectCodeCandidates(
        this.options.workspaceRoot,
        request,
        preferredFiles,
        fileHints,
        Math.max(10, this.options.maxFiles),
      );
      if (codeCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...codeCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_code_candidates");
      }
    }

    const needsFallback =
      selection.low_confidence && (uniqueHits.length === 0 || !searchSucceeded);
    if (needsFallback && this.options.workspaceRoot) {
      emitStatus("thinking", "librarian: fallback file discovery");
      const fallbackCandidates = await collectFallbackCandidates(
        this.options.workspaceRoot,
        request,
        intent,
        Math.max(10, this.options.maxFiles),
      );
      if (fallbackCandidates.length > 0) {
        preferredFiles = uniqueValues([...preferredFiles, ...fallbackCandidates]);
        selection = computeSelection([]);
        pushWarning("librarian_fallback_candidates");
      }
    }

    const filePaths = Array.from(
      new Set([
        ...selection.all,
        ...uniqueHits
          .map((hit) => hit.path)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
        ...preferredFiles,
        ...recentFiles,
      ]),
    );
    const analysisPaths = selectAnalysisPaths(filePaths, {
      intent,
      docTask,
      preferred: preferredFiles,
      focus: selection.focus,
      maxPaths: Math.min(this.options.maxFiles, 6),
    });
    const analysisPathSet = new Set(analysisPaths.map((entry) => normalizePath(entry)));

    const snippets: ContextSnippet[] = [];
    if (this.options.includeSnippets) {
      emitStatus("thinking", "librarian: snippets");
      for (const hit of uniqueHits) {
        if (!hit.doc_id) continue;
        if (hit.path && !analysisPathSet.has(normalizePath(hit.path))) continue;
        try {
          emitToolCall("docdex.snippet", { doc_id: hit.doc_id, window: this.options.snippetWindow });
          const snippetResult = await this.client.openSnippet(hit.doc_id, { window: this.options.snippetWindow });
          snippets.push({
            doc_id: hit.doc_id,
            path: hit.path,
            content: extractSnippetContent(snippetResult),
          });
          emitToolResult("docdex.snippet", "ok", true);
        } catch {
          emitToolResult("docdex.snippet", "failed", false);
          pushWarning(`docdex_snippet_failed:${hit.doc_id}`);
        }
      }
      const snippetPathSet = new Set(
        snippets
          .map((entry) => entry.path)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .map((entry) => normalizePath(entry)),
      );
      const clientWithOpen = this.client as unknown as {
        openFile?: (pathValue: string, options?: unknown) => Promise<unknown>;
      };
      if (typeof clientWithOpen.openFile === "function") {
        for (const focusPath of selection.focus) {
          const normalizedFocus = normalizePath(focusPath);
          if (snippetPathSet.has(normalizedFocus)) continue;
          try {
            const openOptions = { head: this.options.snippetWindow, clamp: true };
            emitToolCall("docdex.open", { path: focusPath, ...openOptions });
            const openResult = await clientWithOpen.openFile(focusPath, openOptions);
            snippets.push({
              path: focusPath,
              content: extractSnippetContent(openResult),
            });
            snippetPathSet.add(normalizedFocus);
            emitToolResult("docdex.open", "ok", true);
          } catch {
            emitToolResult("docdex.open", "failed", false);
            pushWarning(`docdex_open_failed:${focusPath}`);
          }
        }
      }
    }

    const symbols: ContextSymbolSummary[] = [];
    const ast: ContextAstSummary[] = [];
    const impact: ContextImpactSummary[] = [];
    const impactDiagnostics: ContextImpactDiagnostics[] = [];
    let dagSummary: string | undefined;
    if (analysisPaths.length) {
      emitStatus("thinking", "librarian: symbols/ast/impact");
    }
    for (const file of analysisPaths) {
      if (supportsSymbolAnalysis(file)) {
        try {
          emitToolCall("docdex.symbols", { file });
          const symbolsResult = await this.client.symbols(file);
          symbols.push({ path: file, summary: summarizeSymbolsPayload(symbolsResult) });
          emitToolResult("docdex.symbols", "ok", true);
        } catch {
          emitToolResult("docdex.symbols", "failed", false);
          pushWarning(`docdex_symbols_failed:${file}`);
        }
      } else {
        pushWarning(`docdex_symbols_not_applicable:${file}`);
      }

      if (!isDocPath(file) && !isSupportDoc(file)) {
        if (supportsAstAnalysis(file)) {
          try {
            emitToolCall("docdex.ast", { file });
            const astResult = await this.client.ast(file);
            const nodes = compactAstNodes(astResult);
            ast.push({ path: file, nodes });
            emitToolResult("docdex.ast", "ok", true);
          } catch {
            emitToolResult("docdex.ast", "failed", false);
            pushWarning(`docdex_ast_failed:${file}`);
          }
        } else {
          pushWarning(`docdex_ast_not_applicable:${file}`);
        }
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
                pushWarning(`impact_graph_sparse:${file}`);
              }
            } catch {
              emitToolResult("docdex.impact_diagnostics", "failed", false);
              pushWarning(`impact_diagnostics_failed:${file}`);
            }
          }
        } catch {
          emitToolResult("docdex.impact", "failed", false);
          pushWarning(`docdex_impact_failed:${file}`);
        }
      }
    }

    const hasImpactEdges = impact.some((entry) => entry.inbound.length > 0 || entry.outbound.length > 0);
    if (hasImpactEdges && laneScope?.runId) {
      const clientWithDag = this.client as unknown as {
        dagExport?: (sessionId: string, options?: { format?: "json" | "text" | "dot"; maxNodes?: number }) => Promise<unknown>;
      };
      if (typeof clientWithDag.dagExport === "function") {
        try {
          const dagOptions = { format: "text" as const, maxNodes: 160 };
          emitToolCall("docdex.dag_export", { sessionId: laneScope.runId, ...dagOptions });
          const dagResult = await clientWithDag.dagExport(laneScope.runId, dagOptions);
          dagSummary = typeof dagResult === "string" ? dagResult : truncateText(toStringPayload(dagResult), 4_000);
          emitToolResult("docdex.dag_export", "ok", true);
        } catch {
          emitToolResult("docdex.dag_export", "failed", false);
          pushWarning("docdex_dag_export_failed");
        }
      }
    }

    selection = computeSelection(impact);

    const uiMissing =
      intent?.intents.includes("ui") &&
      selection?.all &&
      !selection.all.some((entry) => isFrontendPath(entry));
    if (uiMissing) {
      pushWarning("docdex_ui_no_hits");
      selection = { ...selection, low_confidence: true };
    }
    if (selection.low_confidence) {
      pushWarning("docdex_low_confidence");
    }

    let repoMap: string | undefined;
    let repoMapRaw: string | undefined;
    if (this.options.includeRepoMap) {
      const clientWithTree = this.client as unknown as { tree?: (options?: unknown) => Promise<unknown> };
      if (typeof clientWithTree.tree === "function") {
        try {
          const treeOptions = {
            includeHidden: true,
            path: ".",
            maxDepth: 64,
            extraExcludes: REPO_TREE_EXCLUDES,
          };
          emitToolCall("docdex.tree", treeOptions);
          const treeResult = await clientWithTree.tree(treeOptions);
          const treeText = extractTreeText(treeResult) ?? toStringPayload(treeResult);
          repoMapRaw = treeText;
          repoMap = compactTreeForPrompt(treeText);
          emitToolResult("docdex.tree", "ok", true);
        } catch {
          emitToolResult("docdex.tree", "failed", false);
          pushWarning("docdex_tree_failed");
        }
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
      if (loader.loadErrors.length > 0) {
        for (const entry of loader.loadErrors) {
          pushWarning(`context_file_load_failed:${entry.path}`);
        }
      }
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

    let memoryItems: Array<{ content?: string; score?: number }> = [];
    try {
      emitToolCall("docdex.memory_recall", { query: request, top_k: 5 });
      const memoryResult = await this.client.memoryRecall(request, 5);
      memoryItems = (memoryResult as { results?: Array<{ content?: string; score?: number }> } | undefined)?.results ?? [];
      emitToolResult("docdex.memory_recall", "ok", true);
    } catch {
      emitToolResult("docdex.memory_recall", "failed", false);
      pushWarning("docdex_memory_recall_failed");
    }
    const memoryPruneResult = pruneConflictingMemoryFacts(memoryItems);
    if (memoryPruneResult.pruned > 0) {
      pushWarning("memory_conflicts_pruned");
    }
    const memoryFilterResult = filterRelevantMemoryFacts(
      memoryPruneResult.facts,
      request,
      selection?.all ?? [],
    );
    if (memoryFilterResult.filtered > 0) {
      pushWarning("memory_irrelevant_filtered");
    }
    const memory = memoryFilterResult.facts;

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

    const runIndexer = new RunHistoryIndexer(this.client);
    const episodicMemory = await runIndexer.findSimilarRuns(request);

    let goldenExamples: Array<{ intent: string; patch: string; score?: number }> = [];
    if (this.options.workspaceRoot) {
      try {
        const goldenStore = new GoldenSetStore({ workspaceRoot: this.options.workspaceRoot });
        goldenExamples = await goldenStore.findExamples(request);
      } catch {
        pushWarning("golden_set_store_failed");
      }
    }
    if (goldenExamples.length < 3) {
      const goldenIndexer = new GoldenExampleIndexer(this.client);
      const fallback = await goldenIndexer.findExamples(request, 3);
      const merged = [...goldenExamples];
      for (const entry of fallback) {
        if (merged.some((existing) => existing.intent === entry.intent && existing.patch === entry.patch)) {
          continue;
        }
        merged.push(entry);
        if (merged.length >= 3) break;
      }
      goldenExamples = merged;
    }

    const indexInfo = statsSucceeded
      ? {
          last_updated_epoch_ms:
            (stats as { last_updated_epoch_ms?: number }).last_updated_epoch_ms ??
            0,
          num_docs: (stats as { num_docs?: number }).num_docs ?? 0,
        }
      : { last_updated_epoch_ms: -1, num_docs: -1 };
    if (statsSucceeded) {
      const indexEmpty =
        filesSucceeded &&
        indexInfo.num_docs === 0 &&
        fileHints.length === 0 &&
        snippets.length === 0;
      const indexStale =
        filesSucceeded &&
        indexInfo.last_updated_epoch_ms === 0 &&
        indexInfo.num_docs === 0;
      if (indexEmpty) {
        pushWarning("docdex_index_empty");
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

    const missing: string[] = [];
    if (!selection || selection.focus.length === 0) {
      missing.push("no_focus_files_selected");
    }
    if (selection?.low_confidence) {
      missing.push("low_confidence_selection");
    }
    if (intent?.intents.includes("ui") && selection?.all) {
      const hasUiFile = selection.all.some((entry) => isFrontendPath(entry));
      if (!hasUiFile) {
        missing.push("no_ui_files_selected");
      }
    }
    if (!contextFiles || contextFiles.length === 0) {
      missing.push("no_context_files_loaded");
    } else if (selection) {
      const loadedPaths = new Set(contextFiles.map((entry) => normalizePath(entry.path)));
      for (const path of selection.focus) {
        if (!loadedPaths.has(normalizePath(path))) {
          missing.push(`focus_content_missing:${path}`);
        }
      }
      for (const path of selection.periphery) {
        if (!loadedPaths.has(normalizePath(path))) {
          missing.push(`periphery_content_missing:${path}`);
        }
      }
    }

    const manifestFiles = await detectManifests(this.options.workspaceRoot);
    const readmeSummary = await loadReadmeSummary(this.options.workspaceRoot);
    const fileTypeInputs = uniqueValues([
      ...fileHints,
      ...(selection?.all ?? []),
      ...preferredFiles,
      ...recentFiles,
    ]);
    const projectInfo: ContextProjectInfo = {
      workspace_root: this.options.workspaceRoot,
      readme_path: readmeSummary?.path,
      readme_summary: readmeSummary?.summary,
      docs: supportDocs.length > 0 ? supportDocs : undefined,
      manifests: manifestFiles.length > 0 ? manifestFiles : undefined,
      file_types: fileTypeInputs.length > 0 ? extractFileTypes(fileTypeInputs) : undefined,
    };
    const finalWarnings = reconcileWarnings(warnings, {
      intent,
      selection,
      index: indexInfo,
      filesSucceeded,
      statsSucceeded,
      snippets,
      files: contextFiles,
    });
    const requestDigest = buildRequestDigest({
      request,
      intent,
      querySignals,
      selection,
      searchResults,
      warnings: finalWarnings,
    });

    const bundle: ContextBundle = {
      request,
      intent,
      query_signals: querySignals,
      request_digest: requestDigest,
      queries,
      search_results: searchResults,
      snippets,
      symbols,
      ast,
      impact,
      impact_diagnostics: impactDiagnostics,
      dag_summary: dagSummary,
      repo_map: repoMap,
      repo_map_raw: repoMapRaw,
      project_info: projectInfo,
      selection,
      files: contextFiles,
      redaction: redactionInfo,
      memory,
      episodic_memory: episodicMemory,
      golden_examples: goldenExamples,
      preferences_detected: preferencesDetected,
      profile,
      index: indexInfo,
      warnings: finalWarnings,
      missing,
    };
    const sanitizedBundle = sanitizeContextBundleForOutput(bundle);
    bundle.serialized = serializeContext(sanitizedBundle, {
      mode: this.options.serializationMode ?? "bundle_text",
      audience: "librarian",
    });
    emitStatus("done", "librarian: bundle ready");
    return bundle;
  }

  buildContextRefreshOptions(request: AgentRequest): {
    additionalQueries: string[];
    preferredFiles: string[];
  } {
    const needs = normalizeAgentRequest(request);
    const additionalQueries: string[] = [];
    const preferredFiles: string[] = [];
    for (const need of needs) {
      if (need.tool === "docdex.search" || need.tool === "docdex.web") {
        if (need.params.query) additionalQueries.push(need.params.query);
        continue;
      }
      if (need.tool === "docdex.open") {
        preferredFiles.push(need.params.path);
        continue;
      }
      if (
        need.tool === "docdex.symbols"
        || need.tool === "docdex.ast"
        || need.tool === "docdex.impact"
      ) {
        preferredFiles.push(need.params.file);
        continue;
      }
      if (need.tool === "docdex.impact_diagnostics") {
        if (need.params.file) preferredFiles.push(need.params.file);
        continue;
      }
      if (need.tool === "file.read") {
        preferredFiles.push(need.params.path);
      }
    }
    return {
      additionalQueries: uniqueValues(additionalQueries.filter(Boolean)),
      preferredFiles: uniqueValues(preferredFiles.filter(Boolean)),
    };
  }

  async fulfillAgentRequest(request: AgentRequest): Promise<CodaliResponse> {
    const warnings: string[] = [];
    const results: CodaliResponseResult[] = [];
    const needs = normalizeAgentRequest(request);
    const laneScope = this.laneScope;
    for (const need of needs) {
      try {
        if (need.tool === "docdex.search") {
          const hits = await this.client.search(need.params.query, {
            limit: need.params.limit,
            dagSessionId: laneScope?.runId,
          });
          results.push({ type: "docdex.search", query: need.params.query, hits: hits as unknown[] });
          continue;
        }
        if (need.tool === "docdex.open") {
          const payload = await this.client.openFile(need.params.path, {
            startLine: need.params.start_line,
            endLine: need.params.end_line,
            head: need.params.head,
            clamp: need.params.clamp,
          });
          results.push({
            type: "docdex.open",
            path: need.params.path,
            content: extractDocdexContent(payload),
          });
          continue;
        }
        if (need.tool === "docdex.snippet") {
          const payload = await this.client.openSnippet(need.params.doc_id, {
            window: need.params.window,
          });
          results.push({
            type: "docdex.snippet",
            doc_id: need.params.doc_id,
            content: extractDocdexContent(payload),
          });
          continue;
        }
        if (need.tool === "docdex.symbols") {
          const payload = await this.client.symbols(need.params.file);
          results.push({
            type: "docdex.symbols",
            file: need.params.file,
            symbols: payload as unknown,
          });
          continue;
        }
        if (need.tool === "docdex.ast") {
          const payload = await this.client.ast(need.params.file, need.params.max_nodes);
          results.push({
            type: "docdex.ast",
            file: need.params.file,
            nodes: payload as unknown,
          });
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
        if (need.tool === "docdex.impact_diagnostics") {
          const payload = await this.client.impactDiagnostics({
            file: need.params.file,
            limit: need.params.limit,
            offset: need.params.offset,
          });
          results.push({
            type: "docdex.impact_diagnostics",
            file: need.params.file,
            diagnostics: payload as unknown,
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
        if (need.tool === "docdex.tree") {
          const payload = await this.client.tree({
            path: need.params.path,
            maxDepth: need.params.max_depth,
            dirsOnly: need.params.dirs_only,
            includeHidden: need.params.include_hidden,
          });
          results.push({
            type: "docdex.tree",
            tree: extractTreeText(payload) ?? toStringPayload(payload),
          });
          continue;
        }
        if (need.tool === "docdex.dag_export") {
          const sessionId = need.params.session_id ?? laneScope?.runId;
          if (!sessionId) {
            throw new Error("docdex.dag_export requires session_id");
          }
          const payload = await this.client.dagExport(sessionId, {
            format: need.params.format,
            maxNodes: need.params.max_nodes,
          });
          results.push({
            type: "docdex.dag_export",
            session_id: sessionId,
            format: need.params.format,
            content: payload as unknown,
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
