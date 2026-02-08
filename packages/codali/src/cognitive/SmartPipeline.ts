import type {
  AgentEvent,
  AgentStatusPhase,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import { createHash } from "node:crypto";
import type {
  ContextBundle,
  ContextResearchEvidence,
  ContextResearchSummary,
  ContextResearchToolUsage,
  EvidenceGateAssessment,
  Plan,
  CriticResult,
  LaneScope,
} from "./Types.js";
import { ContextAssembler, type ResearchToolExecution } from "./ContextAssembler.js";
import {
  DEFAULT_DEEP_INVESTIGATION_BUDGET,
  DEFAULT_DEEP_INVESTIGATION_EVIDENCE,
  DEFAULT_DEEP_INVESTIGATION_TOOL_QUOTA,
  type DeepInvestigationBudgetConfig,
  type DeepInvestigationEvidenceConfig,
  type DeepInvestigationToolQuotaConfig,
} from "../config/Config.js";
import { evaluateEvidenceGate } from "./EvidenceGate.js";
import {
  ArchitectPlanner,
  ARCHITECT_WARNING_CONTAINS_FENCE,
  ARCHITECT_WARNING_CONTAINS_THINK,
  ARCHITECT_WARNING_MISSING_REQUIRED_SECTIONS,
  ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS,
  ARCHITECT_WARNING_NON_DSL,
  ARCHITECT_WARNING_REPAIRED,
  ARCHITECT_WARNING_USED_JSON_FALLBACK,
  PlanHintValidationError,
  type ArchitectPlanResult,
} from "./ArchitectPlanner.js";
import {
  BuilderRunner,
  type BuilderRunResult,
  PatchApplyError,
  type PatchApplyFailure,
} from "./BuilderRunner.js";
import { CriticEvaluator } from "./CriticEvaluator.js";
import { MemoryWriteback } from "./MemoryWriteback.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import {
  createDeepInvestigationBudgetError,
  createDeepInvestigationEvidenceError,
  createDeepInvestigationQuotaError,
} from "../runtime/DeepInvestigationErrors.js";
import type { ContextManager } from "./ContextManager.js";
import { buildLaneId } from "./ContextManager.js";
import { sanitizeContextBundleForOutput, serializeContext } from "./ContextSerializer.js";
import type { AgentRequest, CodaliResponse } from "../agents/AgentProtocol.js";

export interface SmartPipelineOptions {
  contextAssembler: ContextAssembler;
  architectPlanner: ArchitectPlanner;
  builderRunner: BuilderRunner;
  criticEvaluator: CriticEvaluator;
  memoryWriteback: MemoryWriteback;
  maxRetries: number;
  maxContextRefreshes?: number;
  initialContext?: ContextBundle;
  fastPath?: (request: string) => boolean;
  deepMode?: boolean;
  deepScanPreset?: boolean;
  deepInvestigation?: {
    toolQuota?: DeepInvestigationToolQuotaConfig;
    investigationBudget?: DeepInvestigationBudgetConfig;
    evidenceGate?: DeepInvestigationEvidenceConfig;
  };
  getTouchedFiles?: () => string[];
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
  onEvent?: (event: AgentEvent) => void;
}

export interface ResearchPhaseResult {
  status: "skipped" | "completed";
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  cycles?: number;
  budget?: {
    status: "met" | "unmet";
    minCycles: number;
    minSeconds: number;
    maxCycles: number;
    elapsedMs: number;
    cycles: number;
  };
  warnings: string[];
  notes?: string[];
  toolRuns: ResearchToolExecution["toolRuns"];
  outputs?: ResearchToolExecution["outputs"];
  evidence?: ContextResearchEvidence;
  toolUsage?: ContextResearchToolUsage;
  evidenceGate?: EvidenceGateAssessment;
}

type ToolUsageCounts = {
  ok: number;
  failed: number;
  skipped: number;
  total: number;
};

type ToolUsageSummary = {
  totals: ToolUsageCounts;
  byTool: Record<string, ToolUsageCounts>;
};

type ToolQuotaAssessment = {
  ok: boolean;
  missing: Array<keyof DeepInvestigationToolQuotaConfig>;
  required: DeepInvestigationToolQuotaConfig;
  observed: Record<keyof DeepInvestigationToolQuotaConfig, number>;
};

export interface SmartPipelineResult {
  context: ContextBundle;
  research?: ResearchPhaseResult;
  plan: Plan;
  builderResult: BuilderRunResult;
  criticResult: CriticResult;
  attempts: number;
}

const ARCHITECT_NON_DSL_WARNING = ARCHITECT_WARNING_NON_DSL;

const emptyToolUsageCounts = (): ToolUsageCounts => ({
  ok: 0,
  failed: 0,
  skipped: 0,
  total: 0,
});

const buildToolUsageSummary = (
  toolRuns: ResearchToolExecution["toolRuns"],
): ToolUsageSummary => {
  const totals = emptyToolUsageCounts();
  const byTool: Record<string, ToolUsageCounts> = {};
  for (const run of toolRuns ?? []) {
    const tool = run.tool || "unknown";
    const bucket = byTool[tool] ?? emptyToolUsageCounts();
    if (run.skipped) {
      bucket.skipped += 1;
      totals.skipped += 1;
    } else if (run.ok) {
      bucket.ok += 1;
      totals.ok += 1;
    } else {
      bucket.failed += 1;
      totals.failed += 1;
    }
    bucket.total += 1;
    totals.total += 1;
    byTool[tool] = bucket;
  }
  return { totals, byTool };
};

const formatToolUsageSummary = (summary: ToolUsageSummary): string => {
  const entries = Object.entries(summary.byTool);
  if (entries.length === 0) return "none";
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, counts]) => `${tool}=${counts.total}`)
    .join(", ");
};

const TOOL_QUOTA_CATEGORIES: Array<keyof DeepInvestigationToolQuotaConfig> = [
  "search",
  "openOrSnippet",
  "symbolsOrAst",
  "impact",
  "tree",
  "dagExport",
];

const TOOL_QUOTA_CATEGORY_MAP: Record<string, keyof DeepInvestigationToolQuotaConfig> = {
  "docdex.search": "search",
  "docdex.snippet": "openOrSnippet",
  "docdex.open": "openOrSnippet",
  "docdex.symbols": "symbolsOrAst",
  "docdex.ast": "symbolsOrAst",
  "docdex.impact": "impact",
  "docdex.impact_diagnostics": "impact",
  "docdex.tree": "tree",
  "docdex.dag_export": "dagExport",
};

const resolveToolQuota = (
  override?: Partial<DeepInvestigationToolQuotaConfig>,
): DeepInvestigationToolQuotaConfig => ({
  ...DEFAULT_DEEP_INVESTIGATION_TOOL_QUOTA,
  ...(override ?? {}),
});

const resolveInvestigationBudget = (
  override?: Partial<DeepInvestigationBudgetConfig>,
): DeepInvestigationBudgetConfig => ({
  ...DEFAULT_DEEP_INVESTIGATION_BUDGET,
  ...(override ?? {}),
});

const resolveEvidenceGate = (
  override?: Partial<DeepInvestigationEvidenceConfig>,
): DeepInvestigationEvidenceConfig => ({
  ...DEFAULT_DEEP_INVESTIGATION_EVIDENCE,
  ...(override ?? {}),
});

const buildToolQuotaAssessment = (
  toolRuns: ResearchToolExecution["toolRuns"],
  quota: DeepInvestigationToolQuotaConfig,
): ToolQuotaAssessment => {
  const observed: Record<keyof DeepInvestigationToolQuotaConfig, number> = {
    search: 0,
    openOrSnippet: 0,
    symbolsOrAst: 0,
    impact: 0,
    tree: 0,
    dagExport: 0,
  };
  for (const run of toolRuns ?? []) {
    if (!run.ok) continue;
    const category = TOOL_QUOTA_CATEGORY_MAP[run.tool];
    if (!category) continue;
    observed[category] += 1;
  }
  const missing: Array<keyof DeepInvestigationToolQuotaConfig> = [];
  for (const category of TOOL_QUOTA_CATEGORIES) {
    if (quota[category] > observed[category]) {
      missing.push(category);
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    required: { ...quota },
    observed,
  };
};

const TOOL_USAGE_CATEGORY_MAP: Record<
  string,
  keyof ContextResearchToolUsage
> = {
  "docdex.search": "search",
  "docdex.snippet": "open_or_snippet",
  "docdex.open": "open_or_snippet",
  "docdex.symbols": "symbols_or_ast",
  "docdex.ast": "symbols_or_ast",
  "docdex.impact": "impact",
  "docdex.impact_diagnostics": "impact",
  "docdex.tree": "tree",
  "docdex.dag_export": "dag_export",
};

const buildResearchToolUsage = (
  toolRuns: ResearchToolExecution["toolRuns"],
): ContextResearchToolUsage => {
  const counts: ContextResearchToolUsage = {
    search: 0,
    open_or_snippet: 0,
    symbols_or_ast: 0,
    impact: 0,
    tree: 0,
    dag_export: 0,
  };
  for (const run of toolRuns ?? []) {
    if (!run.ok) continue;
    const category = TOOL_USAGE_CATEGORY_MAP[run.tool];
    if (!category) continue;
    counts[category] += 1;
  }
  return counts;
};

const buildResearchEvidence = (
  outputs: ResearchToolExecution["outputs"] | undefined,
  warnings: string[],
): ContextResearchEvidence => {
  const searchHitKeys = new Set<string>();
  for (const result of outputs?.searchResults ?? []) {
    for (const hit of result.hits ?? []) {
      const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
      if (key !== ":") searchHitKeys.add(key);
    }
  }
  const searchHits = searchHitKeys.size;
  const snippetKeys = new Set<string>();
  for (const snippet of outputs?.snippets ?? []) {
    if (snippet.doc_id) {
      snippetKeys.add(`doc:${snippet.doc_id}`);
      continue;
    }
    if (snippet.path) {
      snippetKeys.add(`path:${snippet.path}`);
      continue;
    }
    if (snippet.content) {
      snippetKeys.add(
        `content:${createHash("sha1").update(snippet.content).digest("hex")}`,
      );
    }
  }
  const snippetCount = snippetKeys.size;
  const symbolFiles = new Set(
    (outputs?.symbols ?? []).map((entry) => entry.path).filter(Boolean),
  ).size;
  const astFiles = new Set(
    (outputs?.ast ?? []).map((entry) => entry.path).filter(Boolean),
  ).size;
  const impactFiles = new Set(
    (outputs?.impact ?? []).map((entry) => entry.file).filter(Boolean),
  ).size;
  const impactEdgeKeys = new Set<string>();
  for (const entry of outputs?.impact ?? []) {
    const file = entry.file ?? "";
    for (const inbound of entry.inbound ?? []) {
      impactEdgeKeys.add(`${file}|in|${inbound}`);
    }
    for (const outbound of entry.outbound ?? []) {
      impactEdgeKeys.add(`${file}|out|${outbound}`);
    }
  }
  const impactEdges = impactEdgeKeys.size;
  const repoMap = Boolean(outputs?.repoMap || outputs?.repoMapRaw);
  const dagSummary = Boolean(outputs?.dagSummary);
  const warningList = warnings.length ? Array.from(new Set(warnings)) : [];
  return {
    search_hits: searchHits,
    snippet_count: snippetCount,
    symbol_files: symbolFiles,
    ast_files: astFiles,
    impact_files: impactFiles,
    impact_edges: impactEdges,
    repo_map: repoMap,
    dag_summary: dagSummary,
    warnings: warningList.length ? warningList : undefined,
  };
};

const mergeResearchEvidence = (
  evidence: ContextResearchEvidence | undefined,
  evidenceGate?: EvidenceGateAssessment,
): ContextResearchEvidence | undefined => {
  if (!evidence) return evidence;
  const warnings = uniqueStrings([
    ...(evidence.warnings ?? []),
    ...(evidenceGate?.warnings ?? []),
  ]);
  const gaps = uniqueStrings([
    ...(evidence.gaps ?? []),
    ...(evidenceGate?.gaps ?? []),
  ]);
  return {
    ...evidence,
    warnings: warnings.length ? warnings : undefined,
    gaps: gaps.length ? gaps : undefined,
  };
};

const buildResearchSummary = (
  phase?: ResearchPhaseResult,
): ContextResearchSummary | undefined => {
  if (!phase) return undefined;
  return {
    status: phase.status,
    started_at_ms: phase.startedAt,
    ended_at_ms: phase.endedAt,
    duration_ms: phase.durationMs,
    key_findings: buildResearchKeyFindings(phase),
    tool_usage: phase.toolUsage,
    evidence: mergeResearchEvidence(phase.evidence, phase.evidenceGate),
    warnings: phase.warnings?.length ? uniqueStrings(phase.warnings) : undefined,
    notes: phase.notes?.length ? uniqueStrings(phase.notes) : undefined,
  };
};

const ARCHITECT_STRICT_DSL_HINT = [
  "STRICT MODE: Your previous response was low-quality or hard to normalize.",
  "Output a concise plain-text plan using the PLAN/TARGETS/RISK/VERIFY sections.",
  "Avoid JSON blobs, markdown fences, and long prose paragraphs.",
  "If context is insufficient, output an AGENT_REQUEST v1 block instead of freeform text.",
  "Preferred section skeleton:",
  "PLAN:",
  "- <step>",
  "TARGETS:",
  "- <path>",
  "RISK: <low|medium|high> <reason>",
  "VERIFY:",
  "- <verification step>",
].join("\n");

const ARCHITECT_VERIFY_QUALITY_HINT = [
  "VERIFY QUALITY: The VERIFY section cannot be empty.",
  "Include at least one concrete verification step (unit/integration/component/API test, or manual curl/browser check).",
  "Examples:",
  "- Run unit tests: `pnpm test --filter <target>`",
  "- Run integration/API check: `curl -sf http://localhost:3000/healthz`",
  "- Manual browser check: open http://localhost:3000 and verify expected behavior",
].join("\n");

const ARCHITECT_RECOVERY_HINT = [
  "RECOVERY MODE: Prior architect passes were low-quality or non-DSL.",
  "Respond with request-specific, implementation-ready plain-text sections only.",
  "Every PLAN/TARGET/VERIFY line must include concrete target nouns tied to the current request.",
  "If context is still insufficient, emit AGENT_REQUEST v1 with concrete retrieval needs.",
].join("\n");

const ARCHITECT_ALTERNATE_RETRY_HINT = [
  "ALTERNATE RETRY MODE: Prior architect outputs repeated without quality improvement.",
  "Keep output in plain-text PLAN/TARGETS/RISK/VERIFY sections and avoid repeating prior text.",
  "Use request-specific nouns and concrete target file paths in every PLAN/TARGETS/VERIFY line.",
].join("\n");

const isArchitectNonDsl = (warnings: string[] | undefined): boolean =>
  Array.isArray(warnings)
  && warnings.some((warning) => warning === ARCHITECT_NON_DSL_WARNING)
  && !warnings.some((warning) => warning === ARCHITECT_WARNING_USED_JSON_FALLBACK);

const isNonBlockingArchitectWarning = (warning: string): boolean => {
  if (warning === ARCHITECT_WARNING_CONTAINS_THINK) return true;
  if (warning === ARCHITECT_WARNING_CONTAINS_FENCE) return true;
  if (warning === ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS) return true;
  if (warning === ARCHITECT_WARNING_REPAIRED) return true;
  if (warning === ARCHITECT_WARNING_USED_JSON_FALLBACK) return true;
  if (warning === "architect_output_repair_reason:wrapper_noise") return true;
  if (warning === "architect_output_repair_reason:duplicate_sections") return true;
  if (warning.startsWith("plan_missing_target_change_details:")) return true;
  return false;
};

const isBlockingArchitectWarning = (warning: string): boolean => {
  if (isNonBlockingArchitectWarning(warning)) return false;
  if (warning === ARCHITECT_WARNING_NON_DSL) return true;
  if (warning === ARCHITECT_WARNING_MISSING_REQUIRED_SECTIONS) return true;
  if (warning === ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS) return true;
  if (warning.startsWith("architect_output_repair_reason:")) return true;
  if (warning.startsWith("plan_missing_")) return true;
  return true;
};

const hashArchitectResult = (result: ArchitectPlanResult): string => {
  const raw = (result.raw ?? "").trim();
  const content = raw.length > 0
    ? `raw:${raw}`
    : `plan:${JSON.stringify({
        steps: result.plan.steps,
        target_files: result.plan.target_files,
        risk_assessment: result.plan.risk_assessment,
        verification: result.plan.verification,
      })}`;
  return createHash("sha256").update(content).digest("hex");
};

const hashAgentRequestShape = (request: AgentRequest): string => {
  const content = JSON.stringify({
    role: request.role,
    needs: request.needs ?? [],
    context: request.context ?? {},
  });
  return createHash("sha256").update(content).digest("hex");
};

const narrowContextForStrictArchitectRetry = (context: ContextBundle): ContextBundle => {
  const focusFromSelection = context.selection?.focus ?? [];
  const focusFromFiles = (context.files ?? [])
    .filter((entry) => entry.role === "focus")
    .map((entry) => entry.path);
  const focusPaths = new Set(
    [...focusFromSelection, ...focusFromFiles]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const keepPath = (value?: string): boolean => {
    if (!value) return false;
    return focusPaths.has(value);
  };
  const narrowedFiles = (context.files ?? []).filter((entry) => {
    if (entry.role !== "focus") return false;
    if (focusPaths.size === 0) return true;
    return focusPaths.has(entry.path);
  });
  const narrowedSnippets = (context.snippets ?? []).filter((entry) =>
    focusPaths.size === 0 ? Boolean(entry.path) : keepPath(entry.path),
  );
  const narrowedSymbols = (context.symbols ?? []).filter((entry) =>
    focusPaths.size === 0 ? true : keepPath(entry.path),
  );
  const narrowedAst = (context.ast ?? []).filter((entry) =>
    focusPaths.size === 0 ? true : keepPath(entry.path),
  );
  const narrowedImpact = (context.impact ?? []).filter((entry) =>
    focusPaths.size === 0 ? true : keepPath(entry.file),
  );
  const narrowedImpactDiagnostics = (context.impact_diagnostics ?? []).filter((entry) =>
    focusPaths.size === 0 ? true : keepPath(entry.file),
  );
  const narrowedSearch = (context.search_results ?? [])
    .map((result) => ({
      ...result,
      hits: (result.hits ?? [])
        .filter((hit) => (focusPaths.size === 0 ? true : keepPath(hit.path)))
        .slice(0, 3),
    }))
    .filter((result) => result.hits.length > 0)
    .slice(0, 3);
  const focusList = focusPaths.size > 0 ? Array.from(focusPaths) : (context.selection?.focus ?? []);
  return {
    ...context,
    queries: (context.queries ?? []).slice(0, 3),
    search_results: narrowedSearch,
    snippets: narrowedSnippets.slice(0, 4),
    symbols: narrowedSymbols.slice(0, 4),
    ast: narrowedAst.slice(0, 2),
    impact: narrowedImpact.slice(0, 2),
    impact_diagnostics: narrowedImpactDiagnostics.slice(0, 2),
    repo_map: undefined,
    repo_map_raw: undefined,
    files: narrowedFiles,
    selection: {
      focus: focusList,
      periphery: [],
      all: focusList,
      low_confidence: context.selection?.low_confidence ?? false,
    },
    memory: (context.memory ?? []).slice(0, 3),
    profile: (context.profile ?? []).slice(0, 3),
    serialized: undefined,
    warnings: [...context.warnings, "architect_context_narrowed_strict_retry"],
  };
};

const ENDPOINT_SERVER_INTENT_PATTERN = /\b(endpoint|route|router|handler|api|healthz?|status|server|backend)\b/i;
const BACKEND_TARGET_PATTERN = /(^|\/)(server|backend|api|routes?|router|handlers?|controllers?|services?)($|\/|[._-])/i;
const FRONTEND_TARGET_PATTERN = /(^|\/)(public|web|ui|views?|pages?|components?|templates?)($|\/|[._-])/i;
const UI_REQUEST_INTENT_PATTERN =
  /\b(ui|page|screen|header|footer|form|button|image|style|css|html|landing|homepage|welcome)\b/i;
const SEMANTIC_STRICT_INTENT_PATTERN =
  /\b(calculate|compute|estimate|estimation|count|total|store|persist|log|validate|security|secure|auth|engine|workflow|state)\b/i;
const REQUEST_KEYWORD_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "and",
  "or",
  "with",
  "for",
  "from",
  "into",
  "onto",
  "create",
  "add",
  "change",
  "update",
  "fix",
  "implement",
  "develop",
  "build",
  "make",
  "do",
  "thing",
  "review",
  "context",
  "needs",
  "more",
  "request",
  "task",
  "tasks",
  "system",
  "engine",
]);

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));

const normalizeContextSignatureList = (
  values?: Array<string | undefined>,
  limit = 24,
): string[] => {
  if (!values) return [];
  const cleaned = values
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) return [];
  return uniqueStrings(cleaned).sort().slice(0, limit);
};

const buildContextSignature = (context: ContextBundle): string => {
  const signature = {
    queries: normalizeContextSignatureList(context.queries, 24),
    selection: context.selection
      ? {
          focus: normalizeContextSignatureList(context.selection.focus, 24),
          periphery: normalizeContextSignatureList(
            context.selection.periphery,
            24,
          ),
          all: normalizeContextSignatureList(context.selection.all, 24),
          low_confidence: context.selection.low_confidence ?? false,
        }
      : null,
    search_results: (context.search_results ?? []).map((result) => ({
      query: result.query,
      hits: normalizeContextSignatureList(
        (result.hits ?? []).map((hit) => hit.path ?? hit.doc_id ?? ""),
        12,
      ),
    })),
    snippets: normalizeContextSignatureList(
      (context.snippets ?? []).map((entry) => entry.path ?? entry.doc_id ?? ""),
      24,
    ),
    symbols: normalizeContextSignatureList(
      (context.symbols ?? []).map((entry) => entry.path),
      24,
    ),
    ast: normalizeContextSignatureList(
      (context.ast ?? []).map((entry) => entry.path),
      24,
    ),
    impact: (context.impact ?? []).map((entry) => ({
      file: entry.file,
      inbound: normalizeContextSignatureList(entry.inbound, 12),
      outbound: normalizeContextSignatureList(entry.outbound, 12),
    })),
    files: normalizeContextSignatureList(
      (context.files ?? []).map((entry) => entry.path),
      24,
    ),
    research: context.research
      ? {
          status: context.research.status,
          key_findings: normalizeContextSignatureList(
            context.research.key_findings,
            12,
          ),
          tool_usage: context.research.tool_usage ?? null,
          evidence: context.research.evidence ?? null,
          warnings: normalizeContextSignatureList(context.research.warnings, 12),
          notes: normalizeContextSignatureList(context.research.notes, 12),
        }
      : null,
    repo_map: Boolean(context.repo_map ?? context.repo_map_raw),
    dag_summary: Boolean(context.dag_summary),
    request_digest: context.request_digest
      ? {
          summary: context.request_digest.summary,
          refined_query: context.request_digest.refined_query,
          confidence: context.request_digest.confidence,
          candidate_files: normalizeContextSignatureList(
            context.request_digest.candidate_files,
            24,
          ),
        }
      : null,
  };
  return createHash("sha256").update(JSON.stringify(signature)).digest("hex");
};

const truncateText = (value: string, maxChars: number): string => {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
};

const buildPathHints = (paths: string[], maxHints = 3): string[] => {
  if (maxHints <= 0) return [];
  const hints: string[] = [];
  for (const raw of paths) {
    const normalized = normalizePath(raw);
    if (!normalized) continue;
    hints.push(normalized);
    const base = normalized.split("/").pop();
    if (base && base !== normalized) {
      hints.push(base);
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem && stem !== base) hints.push(stem);
    }
    if (hints.length >= maxHints * 3) break;
  }
  return uniqueStrings(hints).slice(0, maxHints);
};

const collectResearchPaths = (
  outputs?: ResearchToolExecution["outputs"],
): { search: string[]; snippets: string[]; symbols: string[]; impact: string[] } => {
  if (!outputs) {
    return { search: [], snippets: [], symbols: [], impact: [] };
  }
  const searchPaths = uniqueStrings(
    (outputs.searchResults ?? [])
      .flatMap((result) => result.hits ?? [])
      .map((hit) => hit.path ?? "")
      .filter((value) => value.length > 0),
  );
  const snippetPaths = uniqueStrings(
    (outputs.snippets ?? [])
      .map((snippet) => snippet.path ?? "")
      .filter((value) => value.length > 0),
  );
  const symbolPaths = uniqueStrings(
    [
      ...(outputs.symbols ?? []).map((entry) => entry.path),
      ...(outputs.ast ?? []).map((entry) => entry.path),
    ].filter((value) => value.length > 0),
  );
  const impactPaths = uniqueStrings(
    (outputs.impact ?? []).map((entry) => entry.file).filter((value) => value.length > 0),
  );
  return { search: searchPaths, snippets: snippetPaths, symbols: symbolPaths, impact: impactPaths };
};

const buildResearchKeyFindings = (
  phase?: ResearchPhaseResult,
): string[] | undefined => {
  const outputs = phase?.outputs;
  if (!outputs) return undefined;
  const findings: string[] = [];
  const paths = collectResearchPaths(outputs);
  const topSearch = paths.search.slice(0, 5);
  const topSnippets = paths.snippets.slice(0, 4);
  const topSymbols = paths.symbols.slice(0, 4);
  const topImpact = paths.impact.slice(0, 4);
  if (topSearch.length) findings.push(`Top search hits: ${topSearch.join(", ")}`);
  if (topSnippets.length) findings.push(`Snippets reviewed: ${topSnippets.join(", ")}`);
  if (topSymbols.length) findings.push(`Symbols/AST reviewed: ${topSymbols.join(", ")}`);
  if (topImpact.length) findings.push(`Impact checked: ${topImpact.join(", ")}`);
  if (outputs.repoMap || outputs.repoMapRaw) findings.push("Repo map captured");
  if (outputs.dagSummary) findings.push("Dependency graph snapshot captured");
  return findings.length ? findings : undefined;
};

const buildResearchContextRefresh = (
  context: ContextBundle,
  outputs: ResearchToolExecution["outputs"],
  missingSignals: string[] = [],
): { context: ContextBundle; changed: boolean } => {
  const missing = new Set(missingSignals);
  const needsFiles = missing.has("open_or_snippet")
    || missing.has("symbols_or_ast")
    || missing.has("impact");
  const needsSearch = missing.has("search_hits") || missingSignals.length === 0;
  const paths = collectResearchPaths(outputs);
  const focusCandidates = uniqueStrings([
    ...paths.search,
    ...paths.snippets,
    ...paths.symbols,
    ...paths.impact,
  ]).slice(0, 8);
  const currentSelection = context.selection ?? {
    focus: [],
    periphery: [],
    all: [],
    low_confidence: false,
  };
  const nextFocus = needsFiles
    ? uniqueStrings([...currentSelection.focus, ...focusCandidates]).slice(0, 8)
    : currentSelection.focus;
  const nextAll = uniqueStrings([
    ...currentSelection.all,
    ...currentSelection.periphery,
    ...nextFocus,
  ]);

  const currentQueries = context.queries ?? [];
  const queryHints = needsSearch ? buildPathHints(focusCandidates, 4) : [];
  const nextQueries = uniqueStrings([...currentQueries, ...queryHints]).slice(0, 8);

  const focusChanged = nextFocus.join("\n") !== currentSelection.focus.join("\n");
  const queriesChanged = nextQueries.join("\n") !== currentQueries.join("\n");
  const repoMapChanged = Boolean(outputs.repoMap || outputs.repoMapRaw)
    && !context.repo_map
    && !context.repo_map_raw;
  const dagChanged = Boolean(outputs.dagSummary) && !context.dag_summary;
  if (!focusChanged && !queriesChanged && !repoMapChanged && !dagChanged) {
    return { context, changed: false };
  }
  return {
    context: {
      ...context,
      queries: nextQueries,
      repo_map: repoMapChanged ? outputs.repoMap ?? context.repo_map : context.repo_map,
      repo_map_raw: repoMapChanged
        ? outputs.repoMapRaw ?? context.repo_map_raw
        : context.repo_map_raw,
      dag_summary: dagChanged ? outputs.dagSummary ?? context.dag_summary : context.dag_summary,
      selection: {
        ...currentSelection,
        focus: nextFocus,
        all: nextAll,
      },
    },
    changed: true,
  };
};

const extractAgentRequestContextInputs = (
  request?: AgentRequest,
): { additionalQueries: string[]; preferredFiles: string[] } => {
  if (!request) return { additionalQueries: [], preferredFiles: [] };
  const additionalQueries: string[] = [];
  const preferredFiles: string[] = [];
  for (const need of request.needs ?? []) {
    if (need.type === "docdex.search" || need.type === "docdex.web") {
      if (need.query) additionalQueries.push(need.query);
      continue;
    }
    if (need.type === "docdex.open") {
      preferredFiles.push(need.path);
      continue;
    }
    if (
      need.type === "docdex.symbols"
      || need.type === "docdex.ast"
      || need.type === "docdex.impact"
    ) {
      preferredFiles.push(need.file);
      continue;
    }
    if (need.type === "docdex.impact_diagnostics") {
      if (need.file) preferredFiles.push(need.file);
      continue;
    }
    if (need.type === "file.read") {
      preferredFiles.push(need.path);
    }
  }
  return {
    additionalQueries: uniqueStrings(additionalQueries.filter(Boolean)),
    preferredFiles: uniqueStrings(preferredFiles.filter(Boolean)),
  };
};

type RequestAnchorSet = {
  keywords: string[];
  phrases: string[];
  all: string[];
};

const extractRequestKeywords = (request: string): string[] =>
  request
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !REQUEST_KEYWORD_STOPWORDS.has(token));

const extractRequestPhrases = (request: string, keywords: string[]): string[] => {
  const explicitQuoted = Array.from(
    request.matchAll(/\"([^\"\\n]{3,})\"|'([^'\\n]{3,})'/g),
  )
    .map((match) => (match[1] ?? match[2] ?? "").trim().toLowerCase())
    .map((entry) => entry.replace(/[^a-z0-9/_ -]/g, " ").replace(/\s+/g, " ").trim())
    .filter((entry) => entry.length >= 4 && entry.split(/\s+/).length >= 2);
  const biGrams: string[] = [];
  for (let index = 0; index < keywords.length - 1; index += 1) {
    const left = keywords[index];
    const right = keywords[index + 1];
    if (!left || !right) continue;
    biGrams.push(`${left} ${right}`);
  }
  return uniqueStrings([...explicitQuoted, ...biGrams]).slice(0, 10);
};

const extractRequestAnchors = (request: string): RequestAnchorSet => {
  const keywords = extractRequestKeywords(request);
  const phrases = extractRequestPhrases(request, keywords);
  const all = uniqueStrings([...phrases, ...keywords]).slice(0, 14);
  return { keywords, phrases, all };
};

const normalizeSemanticText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9/_ -]/g, " ").replace(/\s+/g, " ").trim();

const hasBackendTarget = (targets: string[]): boolean =>
  targets.some((target) => BACKEND_TARGET_PATTERN.test(normalizePath(target).toLowerCase()));

const hasFrontendTarget = (targets: string[]): boolean =>
  targets.some((target) => {
    const normalized = normalizePath(target).toLowerCase();
    return FRONTEND_TARGET_PATTERN.test(normalized) || /\.(html|css|scss|sass|less|styl|tsx|jsx|vue|svelte)$/i.test(normalized);
  });

const collectContextPaths = (context: ContextBundle): string[] => {
  const selection = context.selection?.all ?? [];
  const files = (context.files ?? []).map((entry) => entry.path);
  const snippets = (context.snippets ?? []).map((entry) => entry.path ?? "");
  const symbols = (context.symbols ?? []).map((entry) => entry.path);
  const ast = (context.ast ?? []).map((entry) => entry.path);
  const impact = (context.impact ?? []).map((entry) => entry.file);
  const search = (context.search_results ?? [])
    .flatMap((result) => result.hits ?? [])
    .map((hit) => hit.path ?? "");
  return uniqueStrings(
    [...selection, ...files, ...snippets, ...symbols, ...ast, ...impact, ...search]
      .map((entry) => normalizePath(entry))
      .filter(Boolean),
  );
};

const parseRepoMapPaths = (repoMap?: string): string[] => {
  if (!repoMap) return [];
  const lines = repoMap
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0);
  if (lines.length <= 1) return [];
  const stack: string[] = [];
  const paths: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const branchIndex = line.indexOf("├── ");
    const leafIndex = line.indexOf("└── ");
    const markerIndex =
      branchIndex >= 0 ? branchIndex : leafIndex >= 0 ? leafIndex : -1;
    if (markerIndex < 0) continue;
    const nameRaw = line.slice(markerIndex + 4).trim();
    if (!nameRaw) continue;
    const name = nameRaw.replace(/\s+\(.*\)\s*$/g, "").trim();
    if (!name) continue;
    const depth = Math.floor(markerIndex / 4);
    stack[depth] = name;
    stack.length = depth + 1;
    paths.push(normalizePath(stack.join("/")));
  }
  return uniqueStrings(paths).filter(Boolean);
};

const collectKnownContextPaths = (context: ContextBundle): string[] => {
  const repoMapPaths = parseRepoMapPaths(context.repo_map_raw ?? context.repo_map);
  return uniqueStrings([
    ...collectContextPaths(context),
    ...repoMapPaths,
  ]);
};

const backendCandidatesFromContext = (context: ContextBundle): string[] =>
  collectContextPaths(context).filter((path) => BACKEND_TARGET_PATTERN.test(path.toLowerCase()));

const scoreRequestTargetAlignment = (request: string, targetFiles: string[]): {
  score: number;
  keywords: string[];
  matches: string[];
} => {
  const keywords = extractRequestAnchors(request).keywords;
  if (keywords.length === 0) {
    return { score: 1, keywords, matches: [] };
  }
  const normalizedTargets = targetFiles.map((entry) => normalizePath(entry).toLowerCase());
  const matches = keywords.filter((keyword) =>
    normalizedTargets.some((target) => target.includes(keyword)),
  );
  let score = matches.length / keywords.length;
  const endpointIntent = ENDPOINT_SERVER_INTENT_PATTERN.test(request);
  const uiIntent = UI_REQUEST_INTENT_PATTERN.test(request) && !endpointIntent;
  if (uiIntent && hasFrontendTarget(targetFiles)) {
    score = Math.max(score, 0.45);
    if (!matches.includes("__intent_frontend__")) {
      matches.push("__intent_frontend__");
    }
  }
  if (endpointIntent && hasBackendTarget(targetFiles)) {
    score = Math.max(score, 0.45);
    if (!matches.includes("__intent_backend__")) {
      matches.push("__intent_backend__");
    }
  }
  return { score: Number(Math.min(score, 1).toFixed(3)), keywords, matches };
};

const FALLBACK_WARNING_PATTERNS = [
  /^plan_missing_/i,
  new RegExp(`^${ARCHITECT_WARNING_USED_JSON_FALLBACK}$`, "i"),
  /^architect_output_not_object$/i,
  /^architect_output_repair_reason:(dsl_missing_fields|json_fallback|classifier)$/i,
];
const GENERIC_PLAN_STEP_PATTERNS = [
  /^review focus files/i,
  /^map request requirements/i,
  /^apply changes aligned/i,
  /^run verification steps/i,
  /^implement the requested change/i,
];

const collectTargetTokens = (targets: string[]): string[] =>
  uniqueStrings(
    targets
      .map((entry) => normalizePath(entry).toLowerCase())
      .flatMap((entry) => {
        const file = entry.split("/").pop() ?? "";
        return [entry, file].filter(Boolean);
      })
      .filter((entry) => entry !== "unknown"),
  );

const hasTargetReferenceInSteps = (steps: string[], targetFiles: string[]): boolean => {
  const targetTokens = collectTargetTokens(targetFiles);
  if (targetTokens.length === 0) return false;
  return steps.some((step) => {
    const normalized = step.toLowerCase();
    return targetTokens.some((token) => normalized.includes(token));
  });
};

const assessFallbackOrGenericPlan = (
  plan: Plan,
  warnings: string[],
): {
  fallback_or_generic: boolean;
  reasons: string[];
  generic_step_hits: number;
} => {
  const reasons: string[] = [];
  if (warnings.some((warning) => FALLBACK_WARNING_PATTERNS.some((pattern) => pattern.test(warning)))) {
    reasons.push("architect_plan_fallback_warning");
  }
  if ((plan.target_files ?? []).some((target) => normalizePath(target) === "unknown")) {
    reasons.push("architect_plan_unknown_target");
  }
  if ((plan.risk_assessment ?? "").toLowerCase().includes("fallback")) {
    reasons.push("architect_plan_fallback_risk");
  }
  const steps = (plan.steps ?? []).map((entry) => entry.trim()).filter(Boolean);
  const generic_step_hits = steps.filter((step) =>
    GENERIC_PLAN_STEP_PATTERNS.some((pattern) => pattern.test(step))
  ).length;
  if (generic_step_hits >= 2 && !hasTargetReferenceInSteps(steps, plan.target_files ?? [])) {
    reasons.push("architect_plan_generic_steps");
  }
  return {
    fallback_or_generic: reasons.length > 0,
    reasons,
    generic_step_hits,
  };
};

type BuilderSemanticAssessment = {
  ok: boolean;
  score: number;
  anchors: string[];
  matches: string[];
  targetSignals: string[];
  reasons: string[];
  source: "patch_payload" | "text";
};

const inferBuilderTouchedFiles = (output: string): string[] => {
  const trimmed = output.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return [];
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const patches = Array.isArray(payload.patches) ? payload.patches : [];
    if (patches.length > 0) {
      return uniqueStrings(
        patches
          .map((patch) => (patch as { file?: unknown }).file)
          .filter((file): file is string => typeof file === "string" && file.length > 0)
          .map((file) => normalizePath(file)),
      );
    }
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (files.length > 0) {
      return uniqueStrings(
        files
          .map((entry) => (entry as { path?: unknown }).path)
          .filter((file): file is string => typeof file === "string" && file.length > 0)
          .map((file) => normalizePath(file)),
      );
    }
  } catch {
    return [];
  }
  return [];
};

const assessBuilderSemanticAlignment = (
  request: string,
  plan: Plan,
  builderOutput: string,
): BuilderSemanticAssessment => {
  const requestAnchors = extractRequestAnchors(request);
  const anchors = requestAnchors.all;
  const normalizedOutput = normalizeSemanticText(builderOutput);
  const matches = anchors.filter((anchor) => normalizedOutput.includes(normalizeSemanticText(anchor)));
  const rawScore = anchors.length > 0 ? matches.length / anchors.length : 1;
  const touchedFiles = inferBuilderTouchedFiles(builderOutput);
  const normalizedTargets = uniqueStrings((plan.target_files ?? []).map((target) => normalizePath(target)).filter(Boolean));
  const targetSignals = uniqueStrings([
    ...touchedFiles.filter((file) => normalizedTargets.includes(file)),
    ...normalizedTargets.filter((target) => normalizedOutput.includes(target.toLowerCase())),
  ]);
  const hasActionSignal = /\\b(add|update|change|create|remove|refactor|implement|wire|persist|store|render|validate|handle|log)\\b/i.test(
    builderOutput,
  ) || touchedFiles.length > 0;
  const strongPatchTargetSignal = touchedFiles.length > 0 && targetSignals.length > 0 && hasActionSignal;
  const score = Number(Math.min(rawScore, 1).toFixed(3));
  const reasons: string[] = [];
  const hasRichRequestAnchors = requestAnchors.keywords.length >= 3;
  const minSemanticScore = strongPatchTargetSignal ? 0.1 : 0.25;
  if (hasRichRequestAnchors && score < minSemanticScore) {
    reasons.push("builder_request_semantic_low");
  }
  if (hasRichRequestAnchors && normalizedTargets.length > 0 && targetSignals.length === 0) {
    reasons.push("builder_missing_plan_target_signal");
  }
  if (hasRichRequestAnchors && !hasActionSignal) {
    reasons.push("builder_missing_action_signal");
  }
  return {
    ok: reasons.length === 0,
    score,
    anchors,
    matches,
    targetSignals,
    reasons,
    source: touchedFiles.length > 0 ? "patch_payload" : "text",
  };
};

const buildFallbackRecoveryQueries = (request: string, context: ContextBundle): string[] => {
  const keywords = extractRequestKeywords(request).slice(0, 5);
  const keywordPhrase = keywords.join(" ");
  const endpointIntent = ENDPOINT_SERVER_INTENT_PATTERN.test(request);
  const candidates = [
    request,
    keywordPhrase ? `${keywordPhrase} implementation` : "",
    endpointIntent
      ? `${request} route handlers server entrypoint`
      : `${request} module entrypoint implementation`,
    endpointIntent
      ? `${request} api specification openapi contract`
      : `${request} api specification contract interface`,
    ...((context.queries ?? []).slice(0, 2)),
  ];
  return uniqueStrings(candidates.filter(Boolean)).slice(0, 4);
};

const keywordMatchedPathsFromContext = (context: ContextBundle, request: string): string[] => {
  const keywords = extractRequestKeywords(request);
  if (keywords.length === 0) return [];
  return collectContextPaths(context)
    .filter((path) => {
      const normalized = path.toLowerCase();
      return keywords.some((keyword) => normalized.includes(keyword));
    })
    .slice(0, 8);
};

const buildFallbackRecoveryRequest = (
  request: string,
  context: ContextBundle,
  pass: number,
): {
  requestPayload: AgentRequest;
  additionalQueries: string[];
  preferredFiles: string[];
  recentFiles: string[];
} => {
  const additionalQueries = buildFallbackRecoveryQueries(request, context);
  const endpointIntent = ENDPOINT_SERVER_INTENT_PATTERN.test(request);
  const needs: AgentRequest["needs"] = additionalQueries.map((query) => ({
    type: "docdex.search",
    query,
    limit: 8,
  }));
  if (endpointIntent) {
    needs.push(
      { type: "file.list", root: "src", pattern: "*server*" },
      { type: "file.list", root: "src", pattern: "*route*" },
      { type: "file.list", root: "docs", pattern: "*api*" },
    );
  } else {
    needs.push(
      { type: "file.list", root: "src", pattern: "*" },
      { type: "file.list", root: "docs", pattern: "*spec*" },
    );
  }
  const preferredFiles = uniqueStrings([
    ...(endpointIntent ? backendCandidatesFromContext(context).slice(0, 8) : keywordMatchedPathsFromContext(context, request)),
    ...(context.selection?.focus ?? []),
  ]).slice(0, 12);
  const recentFiles = uniqueStrings([...(context.selection?.all ?? []), ...preferredFiles]).slice(0, 24);
  return {
    requestPayload: {
      version: "v1",
      role: "architect",
      request_id: `architect-fallback-${Date.now()}-${pass}`,
      needs,
      context: {
        summary:
          "Architect plan appears fallback/generic. Gather concrete implementation context (entrypoints, handlers, and API/spec references) before finalizing.",
      },
    },
    additionalQueries,
    preferredFiles,
    recentFiles,
  };
};

const VERIFICATION_COMMAND_PATTERN =
  /\b(pnpm|npm|yarn|bun|node|jest|vitest|mocha|ava|pytest|cargo|go|dotnet|mvn|gradle)\b.*\b(test|tests?|spec|check)\b/i;
const VERIFICATION_ACTION_PATTERN =
  /\b(run|execute|verify|check|assert|validate|curl|open|visit|navigate|request|hit|test)\b/i;
const VERIFICATION_TYPE_PATTERN =
  /\b(unit|integration|component|e2e|end[- ]to[- ]end|api|curl|httpie|wget|browser|manual)\b/i;
const VERIFICATION_HTTP_URL_PATTERN = /\bhttps?:\/\/\S+/i;

const isConcreteVerificationStep = (step: string): boolean => {
  const value = step.trim();
  if (!value) return false;
  if (VERIFICATION_COMMAND_PATTERN.test(value)) return true;
  if (/\bcurl\b/i.test(value) && VERIFICATION_HTTP_URL_PATTERN.test(value)) return true;
  if (/\b(open|visit|navigate)\b/i.test(value) && /\b(browser|localhost|https?:\/\/)\b/i.test(value)) {
    return true;
  }
  return VERIFICATION_ACTION_PATTERN.test(value) && VERIFICATION_TYPE_PATTERN.test(value);
};

type VerificationQuality =
  | { ok: true; steps: string[]; matched_step: string }
  | { ok: false; steps: string[]; reason: "empty" | "non_concrete" };

const assessVerificationQuality = (verification: string[] | undefined): VerificationQuality => {
  const steps = (verification ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (steps.length === 0) return { ok: false, steps, reason: "empty" };
  const matched_step = steps.find((step) => isConcreteVerificationStep(step));
  if (!matched_step) return { ok: false, steps, reason: "non_concrete" };
  return { ok: true, steps, matched_step };
};

const isConcreteTargetPath = (target: string): boolean => {
  const normalized = normalizePath(target).toLowerCase();
  if (!normalized || normalized === "unknown") return false;
  if (normalized.includes("<path")) return false;
  if (/^path\/to\/file\.[a-z0-9]+$/.test(normalized)) return false;
  if (!normalized.includes(".")) return false;
  return !/^<[^>]+>$/.test(normalized);
};

const isDeterministicPatchApplyFailure = (failure: PatchApplyFailure): boolean => {
  const message = `${failure.error} ${failure.source}`.toLowerCase();
  return message.includes("enoent") || message.includes("no such file or directory");
};

type PlanQualityGate = {
  ok: boolean;
  reasons: string[];
  concreteTargets: string[];
  verification: VerificationQuality;
  targetValidation?: {
    ok: boolean;
    knownTargets: string[];
    createTargets: string[];
    unresolvedTargets: string[];
  };
  alignmentScore: number;
  alignmentKeywords: string[];
  semanticScore: number;
  semanticAnchors: string[];
  semanticMatches: string[];
};

const BLOCKING_PLAN_QUALITY_REASONS = new Set([
  "missing_concrete_targets",
  "invalid_target_paths",
  "verification_empty",
  "verification_non_concrete",
]);

const collectBlockingPlanQualityReasons = (quality: PlanQualityGate): string[] =>
  quality.reasons.filter((reason) => BLOCKING_PLAN_QUALITY_REASONS.has(reason));

const assessPlanTargetValidation = (
  plan: Plan,
  context: ContextBundle,
): {
  ok: boolean;
  knownTargets: string[];
  existingTargets: string[];
  createTargets: string[];
  unresolvedTargets: string[];
} => {
  const knownTargets = collectKnownContextPaths(context);
  const repoMapTargets = parseRepoMapPaths(context.repo_map_raw ?? context.repo_map);
  const existingTargets = repoMapTargets.length > 0 ? repoMapTargets : knownTargets;
  if (knownTargets.length === 0) {
    return {
      ok: true,
      knownTargets,
      existingTargets,
      createTargets: uniqueStrings(
        (plan.create_files ?? [])
          .filter((target) => isConcreteTargetPath(target))
          .map((target) => normalizePath(target)),
      ),
      unresolvedTargets: [],
    };
  }
  const existingTargetSet = new Set(existingTargets.map((entry) => entry.toLowerCase()));
  const createTargets = uniqueStrings(
    (plan.create_files ?? [])
      .filter((target) => isConcreteTargetPath(target))
      .map((target) => normalizePath(target)),
  );
  const createTargetSet = new Set(createTargets.map((entry) => entry.toLowerCase()));
  const concreteTargets = uniqueStrings(
    (plan.target_files ?? [])
      .filter((target) => isConcreteTargetPath(target))
      .map((target) => normalizePath(target)),
  );
  const unresolvedTargets = concreteTargets.filter((target) =>
    !existingTargetSet.has(target.toLowerCase()) && !createTargetSet.has(target.toLowerCase())
  );
  return {
    ok: unresolvedTargets.length === 0,
    knownTargets,
    existingTargets,
    createTargets,
    unresolvedTargets,
  };
};

type StructuralGroundingAssessment = {
  ok: boolean;
  score: number;
  reasons: string[];
  warningHits: string[];
  hasFocus: boolean;
  hasStructuralSignals: boolean;
  hasFallbackSignals: boolean;
};

type TargetDriftAssessment = {
  high: boolean;
  similarity: number;
  drift: number;
  previous: string[];
  current: string[];
};

const STRUCTURAL_WARNING_PREFIXES = [
  "docdex_symbols_failed:",
  "docdex_ast_failed:",
  "docdex_impact_failed:",
  "impact_graph_sparse:",
  "docdex_snippet_failed:",
  "docdex_open_failed:",
  "docdex_search_failed:",
];

const STRUCTURAL_WARNING_EXACT = new Set([
  "docdex_no_hits",
  "docdex_low_confidence",
  "docdex_index_empty",
  "docdex_unavailable",
  "docdex_initialize_failed",
]);

const collectStructuralWarningHits = (warnings: string[] | undefined): string[] => {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  return warnings.filter((warning) => {
    if (STRUCTURAL_WARNING_EXACT.has(warning)) return true;
    return STRUCTURAL_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix));
  });
};

const assessStructuralGrounding = (
  context: ContextBundle,
  plan: Plan,
): StructuralGroundingAssessment => {
  const warningHits = collectStructuralWarningHits(context.warnings);
  const lowConfidence = context.selection?.low_confidence === true;
  const hasFocus = [
    ...(context.selection?.focus ?? []),
    ...(plan.target_files ?? []),
  ].some((entry) => isConcreteTargetPath(entry));
  const hasStructuralSignals =
    (context.symbols ?? []).length > 0 ||
    (context.ast ?? []).length > 0 ||
    (context.impact ?? []).length > 0;
  const hasFallbackSignals =
    (context.snippets ?? []).length > 0 ||
    (context.files ?? []).length > 0 ||
    (context.selection?.focus.length ?? 0) > 0 ||
    collectContextPaths(context).length > 0 ||
    ((context.repo_map ?? "").trim().length > 0);
  if (warningHits.length === 0 && !lowConfidence && (hasStructuralSignals || hasFallbackSignals)) {
    return {
      ok: true,
      score: 1,
      reasons: [],
      warningHits: [],
      hasFocus,
      hasStructuralSignals,
      hasFallbackSignals,
    };
  }
  const reasons: string[] = [];
  let score = 1;
  if (!hasFocus) {
    reasons.push("no_concrete_focus");
    score -= 0.35;
  }
  if (!hasStructuralSignals && !hasFallbackSignals) {
    reasons.push("missing_structural_signals");
    score -= 0.25;
  } else if (!hasStructuralSignals && hasFallbackSignals) {
    reasons.push("fallback_signals_only");
    score -= 0.08;
  }
  if (warningHits.length > 0) {
    reasons.push("structural_tool_warnings");
    score -= Math.min(0.4, warningHits.length * 0.1);
  }
  if (lowConfidence) {
    reasons.push("low_confidence_selection");
    score -= 0.2;
  }
  const clampedScore = Math.max(0, Number(score.toFixed(3)));
  const ok = clampedScore >= 0.45;
  return {
    ok,
    score: clampedScore,
    reasons,
    warningHits,
    hasFocus,
    hasStructuralSignals,
    hasFallbackSignals,
  };
};

const jaccardSimilarity = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left.map((value) => value.toLowerCase()));
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  let intersection = 0;
  for (const entry of leftSet) {
    if (rightSet.has(entry)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return 1;
  return Number((intersection / union).toFixed(3));
};

const assessTargetDrift = (
  previousTargets: string[] | undefined,
  currentTargets: string[] | undefined,
): TargetDriftAssessment => {
  const previous = uniqueStrings((previousTargets ?? []).filter((entry) => entry.trim().length > 0));
  const current = uniqueStrings((currentTargets ?? []).filter((entry) => entry.trim().length > 0));
  if (previous.length === 0 || current.length === 0) {
    return { high: false, similarity: 1, drift: 0, previous, current };
  }
  const similarity = jaccardSimilarity(previous, current);
  const drift = Number((1 - similarity).toFixed(3));
  const high = similarity < 0.2;
  return { high, similarity, drift, previous, current };
};

const scoreRequestPlanSemanticCoverage = (
  request: string,
  plan: Plan,
): {
  score: number;
  anchors: string[];
  matches: string[];
} => {
  const anchors = extractRequestAnchors(request).all;
  if (anchors.length === 0) {
    return { score: 1, anchors, matches: [] };
  }
  const corpus = normalizeSemanticText(
    [
      ...(plan.steps ?? []),
      ...(plan.target_files ?? []),
      plan.risk_assessment ?? "",
      ...(plan.verification ?? []),
    ].join(" "),
  );
  if (!corpus) {
    return { score: 0, anchors, matches: [] };
  }
  const matches = anchors.filter((anchor) => corpus.includes(normalizeSemanticText(anchor)));
  const score = matches.length / anchors.length;
  return {
    score: Number(Math.min(score, 1).toFixed(3)),
    anchors,
    matches,
  };
};

const assessPlanQualityGate = (
  request: string,
  plan: Plan,
  context?: ContextBundle,
): PlanQualityGate => {
  const requestAnchors = extractRequestAnchors(request);
  const concreteTargets = uniqueStrings((plan.target_files ?? []).filter((target) => isConcreteTargetPath(target)));
  const reasons: string[] = [];
  if (concreteTargets.length === 0) reasons.push("missing_concrete_targets");
  const targetValidation = context ? assessPlanTargetValidation(plan, context) : undefined;
  if (targetValidation && !targetValidation.ok) {
    reasons.push("invalid_target_paths");
  }
  const verification = assessVerificationQuality(plan.verification);
  if (!verification.ok) reasons.push(`verification_${verification.reason}`);
  const alignment = scoreRequestTargetAlignment(request, concreteTargets);
  const needsAlignment = alignment.keywords.length >= 3;
  if (needsAlignment && alignment.score < 0.2) {
    reasons.push("low_request_target_alignment");
  }
  const semanticCoverage = scoreRequestPlanSemanticCoverage(request, plan);
  const strictSemanticIntent = SEMANTIC_STRICT_INTENT_PATTERN.test(request);
  if (strictSemanticIntent && requestAnchors.keywords.length >= 3 && semanticCoverage.score < 0.3) {
    reasons.push("low_request_plan_semantic_coverage");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    concreteTargets,
    verification,
    targetValidation,
    alignmentScore: alignment.score,
    alignmentKeywords: alignment.keywords,
    semanticScore: semanticCoverage.score,
    semanticAnchors: semanticCoverage.anchors,
    semanticMatches: semanticCoverage.matches,
  };
};

const buildQualityDegradedPlan = (request: string, context: ContextBundle, priorPlan: Plan): Plan => {
  const existingTargets = parseRepoMapPaths(context.repo_map_raw ?? context.repo_map);
  const effectiveKnownTargets = existingTargets.length > 0
    ? existingTargets
    : collectKnownContextPaths(context);
  const knownTargetSet = new Set(
    effectiveKnownTargets.map((entry) => normalizePath(entry).toLowerCase()),
  );
  const hasKnownTargets = knownTargetSet.size > 0;
  const explicitCreateTargets = uniqueStrings(
    (priorPlan.create_files ?? [])
      .filter((target) => isConcreteTargetPath(target))
      .map((target) => normalizePath(target)),
  );
  const explicitCreateTargetSet = new Set(explicitCreateTargets.map((entry) => entry.toLowerCase()));
  const priorConcreteTargets = uniqueStrings(
    (priorPlan.target_files ?? [])
      .filter((target) => isConcreteTargetPath(target))
      .map((target) => normalizePath(target)),
  );
  const priorHasConcreteTargets = priorConcreteTargets.length > 0;
  const unresolvedPriorTargets = priorConcreteTargets.filter((target) =>
    hasKnownTargets
      ? !knownTargetSet.has(target.toLowerCase()) && !explicitCreateTargetSet.has(target.toLowerCase())
      : false
  );
  const priorHasUnresolvedTargets = unresolvedPriorTargets.length > 0;
  const contextTargets = uniqueStrings(
    [
      ...((context.selection?.focus ?? []).filter((target) => isConcreteTargetPath(target))),
      ...((context.selection?.all ?? []).filter((target) => isConcreteTargetPath(target))),
      ...((context.files ?? []).map((entry) => entry.path).filter((target) => isConcreteTargetPath(target))),
    ].map((target) => normalizePath(target)),
  );
  const fallbackTargets = uniqueStrings(
    [
      ...(priorPlan.target_files ?? [])
        .filter((target) => isConcreteTargetPath(target))
        .map((target) => normalizePath(target))
        .filter((target) => {
          if (!hasKnownTargets) return true;
          return (
            knownTargetSet.has(target.toLowerCase())
            || explicitCreateTargetSet.has(target.toLowerCase())
          );
        }),
      ...(!priorHasUnresolvedTargets && priorHasConcreteTargets
        ? contextTargets.filter((target) => {
            if (!hasKnownTargets) return true;
            return knownTargetSet.has(target.toLowerCase());
          })
        : []),
      ...explicitCreateTargets,
    ].filter(Boolean),
  );
  const targets = fallbackTargets.length > 0 ? fallbackTargets.slice(0, 6) : [];
  const targetSet = new Set(targets.map((target) => target.toLowerCase()));
  const createTargets = explicitCreateTargets.filter((target) => targetSet.has(target.toLowerCase()));
  const normalizedRequest = request.trim() || "the requested change";
  const verify = [
    targets.length > 0
      ? `Run unit/integration tests that cover: ${targets.join(", ")}.`
      : `Run unit/integration tests that validate "${normalizedRequest}".`,
    `Perform a manual verification for "${normalizedRequest}" against ${targets[0] ?? "the affected target"}.`,
  ];
  const steps = [
    ...((priorPlan.steps ?? []).filter((step) => step.trim().length > 0)),
    targets.length > 0
      ? `Finalize implementation details for ${targets.join(", ")} with request-specific behavior for "${normalizedRequest}".`
      : `Refine plan targets for "${normalizedRequest}" to concrete in-repo files before implementation.`,
  ];
  return {
    steps: uniqueStrings(steps),
    target_files: targets,
    create_files: createTargets.length > 0 ? createTargets : undefined,
    risk_assessment:
      priorPlan.risk_assessment && priorPlan.risk_assessment.trim().length > 0
        ? priorPlan.risk_assessment
        : `medium: degraded architect quality gate fallback for "${normalizedRequest}"`,
    verification: uniqueStrings(verify),
  };
};

const buildDriftStabilizedPlan = (
  request: string,
  priorPlan: Plan,
  previousTargets: string[],
): Plan => {
  const stableTargets = previousTargets.filter((entry) => isConcreteTargetPath(entry));
  if (stableTargets.length === 0) return priorPlan;
  const normalizedRequest = request.trim() || "the requested change";
  const steps = uniqueStrings([
    ...(priorPlan.steps ?? []),
    `Stabilize target scope for "${normalizedRequest}" and avoid cross-pass drift into unrelated files.`,
  ]);
  return {
    ...priorPlan,
    steps,
    target_files: stableTargets,
  };
};

const buildArchitectOutputArtifactPayload = (input: {
  pass: number;
  strictRetry: boolean;
  planHint?: string;
  instructionHint?: string;
  result: ArchitectPlanResult;
  requestResponse?: CodaliResponse;
  source?: string;
  qualityGate?: PlanQualityGate;
  planHash?: string;
  classification?: string;
  repairApplied?: boolean;
  recoveryAction?: string;
  structuralGrounding?: StructuralGroundingAssessment;
  targetDrift?: TargetDriftAssessment;
  responseFormat?: ProviderResponseFormat;
}): Record<string, unknown> => ({
  pass: input.pass,
  strict_retry: input.strictRetry,
  source: input.source ?? "architect_pass",
  plan_hint_present: Boolean(input.planHint && input.planHint.trim().length > 0),
  instruction_hint_present: Boolean(
    input.instructionHint && input.instructionHint.trim().length > 0,
  ),
  warnings: input.result.warnings ?? [],
  raw_output: input.result.raw ?? "",
  normalized_output: input.result.plan,
  request: input.result.request ?? null,
  request_response: input.requestResponse ?? null,
  plan_hash: input.planHash ?? null,
  classification: input.classification ?? null,
  repair_applied: input.repairApplied ?? false,
  recovery_action: input.recoveryAction ?? null,
  quality_gate: input.qualityGate ?? null,
  structural_grounding: input.structuralGrounding ?? null,
  target_drift: input.targetDrift ?? null,
  response_format_type: input.responseFormat?.type ?? "default",
  response_format_schema: input.responseFormat?.type === "json_schema"
    ? (input.responseFormat.schema ?? null)
    : null,
  response_format_grammar_present:
    input.responseFormat?.type === "gbnf" ? Boolean(input.responseFormat.grammar) : false,
});

const classifyArchitectWarnings = (warnings: string[]): string => {
  if (warnings.some((warning) => warning === ARCHITECT_NON_DSL_WARNING)) return "non_dsl";
  if (warnings.some((warning) => warning === ARCHITECT_WARNING_REPAIRED)) return "repaired";
  return "dsl";
};

const hasRepairWarnings = (warnings: string[]): boolean =>
  warnings.some(
    (warning) =>
      warning === ARCHITECT_WARNING_REPAIRED || warning.startsWith("architect_output_repair_reason:"),
  );

const buildFastPlan = (context: ContextBundle): Plan => {
  const targetFiles = context.snippets
    .map((snippet) => snippet.path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  return {
    steps: ["Implement the requested change."],
    target_files: targetFiles.length ? targetFiles : ["unknown"],
    risk_assessment: "low",
    verification: [],
  };
};

export class SmartPipeline {
  private options: SmartPipelineOptions;

  constructor(options: SmartPipelineOptions) {
    this.options = options;
  }

  async run(request: string): Promise<SmartPipelineResult> {
    if (this.options.deepScanPreset) {
      this.options.contextAssembler.applyDeepScanPreset();
    }
    const deepMode = this.options.deepMode ?? false;
    const architectPlannerWithHint = this.options
      .architectPlanner as unknown as { planHint?: string };
    const configuredPlanHint =
      typeof architectPlannerWithHint.planHint === "string"
        ? architectPlannerWithHint.planHint
        : undefined;
    let planHintSuppressedLogged = false;
    const laneScope = this.options.laneScope ?? {};
    const architectLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "architect" })
      : undefined;
    const builderLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "builder" })
      : undefined;
    const criticLaneId = this.options.contextManager
      ? buildLaneId({ ...laneScope, role: "critic" })
      : undefined;
    const logLaneSummary = async (role: "architect" | "builder" | "critic", laneId?: string) => {
      if (!this.options.contextManager || !this.options.logger || !laneId) return;
      const lane = await this.options.contextManager.getLane({ ...laneScope, role });
      await this.options.logger.log("context_lane_summary", {
        role,
        laneId: lane.id,
        messageCount: lane.messages.length,
        tokenEstimate: lane.tokenEstimate,
      });
    };
    const logPhaseArtifact = async (
      phase: string,
      kind: string,
      payload: unknown,
    ): Promise<string | undefined> => {
      if (!this.options.logger) return undefined;
      const path = await this.options.logger.writePhaseArtifact(phase, kind, payload);
      await this.options.logger.log(`phase_${kind}`, { phase, path });
      return path;
    };
    const sanitizeForOutput = (bundle: ContextBundle): ContextBundle => {
      const sanitized = sanitizeContextBundleForOutput(bundle);
      const mode = bundle.serialized?.mode ?? "bundle_text";
      sanitized.serialized = serializeContext(sanitized, { mode, audience: "librarian" });
      return sanitized;
    };
    const buildSerializedContext = (
      bundle: ContextBundle,
      audience: "librarian" | "builder" = "librarian",
    ) => {
      const mode = bundle.serialized?.mode ?? "bundle_text";
      const target = audience === "librarian" ? sanitizeContextBundleForOutput(bundle) : bundle;
      return serializeContext(target, { mode, audience });
    };
    const formatCodaliResponse = (response: CodaliResponse): string =>
      ["CODALI_RESPONSE v1", JSON.stringify(response, null, 2)].join("\n");
    const buildResearchProtocolResponse = (
      phase: ResearchPhaseResult,
    ): CodaliResponse | undefined => {
      const outputs = phase.outputs;
      if (!outputs) return undefined;
      const results: CodaliResponse["results"] = [];
      const searchResults = outputs.searchResults ?? [];
      for (const entry of searchResults.slice(0, 3)) {
        results.push({
          type: "docdex.search",
          query: entry.query,
          hits: (entry.hits ?? []).slice(0, 5).map((hit) => ({
            path: hit.path,
            doc_id: hit.doc_id,
            score: hit.score,
          })),
        });
      }
      const snippets = outputs.snippets ?? [];
      for (const snippet of snippets.slice(0, 3)) {
        if (snippet.doc_id) {
          results.push({
            type: "docdex.snippet",
            doc_id: snippet.doc_id,
            content: truncateText(snippet.content ?? "", 600),
          });
        } else if (snippet.path) {
          results.push({
            type: "docdex.open",
            path: snippet.path,
            content: truncateText(snippet.content ?? "", 600),
          });
        }
      }
      const symbols = outputs.symbols ?? [];
      for (const symbol of symbols.slice(0, 3)) {
        results.push({
          type: "docdex.symbols",
          file: symbol.path,
          symbols: { summary: symbol.summary },
        });
      }
      const ast = outputs.ast ?? [];
      for (const node of ast.slice(0, 2)) {
        results.push({
          type: "docdex.ast",
          file: node.path,
          nodes: Array.isArray(node.nodes) ? node.nodes.slice(0, 6) : node.nodes,
        });
      }
      const impact = outputs.impact ?? [];
      for (const entry of impact.slice(0, 3)) {
        results.push({
          type: "docdex.impact",
          file: entry.file,
          inbound: (entry.inbound ?? []).slice(0, 6),
          outbound: (entry.outbound ?? []).slice(0, 6),
        });
      }
      if (!results.length) return undefined;
      return {
        version: "v1",
        request_id: `research-${Date.now()}`,
        results,
        meta: {
          warnings: uniqueStrings([
            ...(phase.warnings ?? []),
            ...(phase.evidenceGate?.warnings ?? []),
          ]),
        },
      };
    };
    const formatGbfnMemory = (
      requestText: string,
      phase: ResearchPhaseResult,
      quotaAssessment: ToolQuotaAssessment,
      budgetStatus: ResearchPhaseResult["budget"],
    ): string => {
      const findings = buildResearchKeyFindings(phase) ?? [];
      const blockers: string[] = [];
      if (!quotaAssessment.ok) {
        blockers.push(`quota_unmet:${quotaAssessment.missing.join(",")}`);
      }
      if (budgetStatus?.status !== "met") {
        blockers.push(
          `budget_unmet:cycles=${budgetStatus?.cycles ?? 0}/${budgetStatus?.minCycles ?? 0},elapsed_s=${Math.round((budgetStatus?.elapsedMs ?? 0) / 1000)}/${budgetStatus?.minSeconds ?? 0}`,
        );
      }
      if (phase.evidenceGate?.status && phase.evidenceGate.status !== "pass") {
        blockers.push(
          `evidence_unmet:${(phase.evidenceGate.missing ?? []).join(",")}`,
        );
      }
      const warningList = uniqueStrings([
        ...(phase.warnings ?? []),
        ...(phase.evidenceGate?.warnings ?? []),
      ]);
      if (warningList.length) blockers.push(`warnings:${warningList.join(",")}`);

      const facts: Array<{
        id: string;
        type: string;
        value: string;
        confidence?: "high" | "medium" | "low";
      }> = [];
      const relations: Array<{ from: string; to: string; relation: string }> = [];

      const goalId = "goal_request";
      facts.push({ id: goalId, type: "goal", value: requestText, confidence: "high" });

      if (phase.evidence) {
        const evidenceId = "research_evidence";
        facts.push({
          id: evidenceId,
          type: "evidence",
          value: [
            `search_hits=${phase.evidence.search_hits}`,
            `snippet_count=${phase.evidence.snippet_count}`,
            `symbol_files=${phase.evidence.symbol_files}`,
            `ast_files=${phase.evidence.ast_files}`,
            `impact_files=${phase.evidence.impact_files}`,
            `impact_edges=${phase.evidence.impact_edges}`,
            `repo_map=${phase.evidence.repo_map ? "yes" : "no"}`,
            `dag_summary=${phase.evidence.dag_summary ? "yes" : "no"}`,
          ].join(", "),
          confidence: "medium",
        });
        relations.push({ from: goalId, to: evidenceId, relation: "supported_by" });
      }

      findings.slice(0, 6).forEach((finding, index) => {
        const id = `finding_${index + 1}`;
        facts.push({ id, type: "finding", value: finding, confidence: "medium" });
        relations.push({ from: goalId, to: id, relation: "supported_by" });
      });

      const researchPaths = collectResearchPaths(phase.outputs);
      const fileCandidates = researchPaths.search
        .concat(researchPaths.snippets)
        .concat(researchPaths.symbols)
        .concat(researchPaths.impact)
        .filter(Boolean);
      const uniqueFiles = uniqueStrings(fileCandidates).slice(0, 6);
      uniqueFiles.forEach((file, index) => {
        const id = `file_${index + 1}`;
        facts.push({ id, type: "file_candidate", value: file, confidence: "medium" });
        relations.push({ from: goalId, to: id, relation: "potential_target" });
      });

      blockers.slice(0, 6).forEach((blocker, index) => {
        const id = `blocker_${index + 1}`;
        facts.push({ id, type: "blocker", value: blocker, confidence: "high" });
        relations.push({ from: goalId, to: id, relation: "blocked_by" });
      });

      const memory = {
        memory: {
          facts,
          relations,
          ttl: {
            thread: "ephemeral",
            memory: "persistent_opt_in",
          },
        },
      };
      return ["GBFN MEMORY v1", JSON.stringify(memory, null, 2)].join("\n");
    };
    const emitAgentRequestRecoveryStatus = (reason: string): void => {
      this.emitStatus("thinking", `architect: AGENT_REQUEST recovery (${reason})`);
    };
    const appendLaneHistory = async (
      laneId: string | undefined,
      role: "architect" | "builder" | "critic",
      content: string,
    ): Promise<boolean> => {
      if (!this.options.contextManager || !laneId) return false;
      if (typeof this.options.contextManager.append !== "function") return false;
      await this.options.contextManager.append(
        laneId,
        { role: "system", content },
        { role },
      );
      return true;
    };
    const appendArchitectHistory = async (content: string): Promise<void> => {
      await appendLaneHistory(architectLaneId, "architect", content);
    };
    const appendBuilderHistory = async (content: string): Promise<void> => {
      await appendLaneHistory(builderLaneId, "builder", content);
    };
    const appendCriticHistory = async (content: string): Promise<void> => {
      await appendLaneHistory(criticLaneId, "critic", content);
    };
    const appendProtocolToLanes = async (
      content: string,
      label: string,
    ): Promise<void> => {
      const appended: string[] = [];
      if (await appendLaneHistory(architectLaneId, "architect", content)) {
        appended.push("architect");
      }
      if (await appendLaneHistory(builderLaneId, "builder", content)) {
        appended.push("builder");
      }
      if (await appendLaneHistory(criticLaneId, "critic", content)) {
        appended.push("critic");
      }
      if (appended.length) {
        this.emitStatus(
          "thinking",
          `${label}: appended to ${appended.join(", ")}`,
        );
      }
    };
    const logPlanHintSuppressed = async (hint?: string): Promise<void> => {
      if (!deepMode || planHintSuppressedLogged) return;
      if (typeof hint !== "string" || hint.trim().length === 0) return;
      if (!this.options.logger) return;
      await this.options.logger.log("plan_hint_suppressed", {
        reason: "deep_mode",
      });
      planHintSuppressedLogged = true;
    };
    if (deepMode) {
      await logPlanHintSuppressed(configuredPlanHint);
    }
    const buildApplyFailureResponse = (failure: PatchApplyFailure): CodaliResponse => ({
      version: "v1",
      request_id: `apply-failure-${Date.now()}`,
      results: [
        {
          type: "patch.apply_failure",
          error: failure.error,
          patches: failure.patches.map((patch) => patch.file),
          rollback: failure.rollback,
        },
      ],
      meta: {
        warnings: ["patch_apply_failed"],
      },
    });
    const buildCriticResponse = (critic: CriticResult): CodaliResponse => ({
      version: "v1",
      request_id: `critic-${Date.now()}`,
      results: [
        {
          type: "critic.result",
          status: critic.report?.status ?? critic.status,
          reasons: critic.report?.reasons ?? critic.reasons,
          suggested_fixes: critic.report?.suggested_fixes ?? [],
          touched_files: critic.report?.touched_files,
          plan_targets: critic.report?.plan_targets,
          guardrail: critic.report?.guardrail ?? critic.guardrail,
        },
      ],
      meta: {
        warnings: critic.status === "FAIL" ? ["critic_failed"] : undefined,
      },
    });

    const runDeepResearchPhase = async (
      bundle: ContextBundle,
      reason?: string,
    ): Promise<ResearchPhaseResult> => {
      await logPhaseArtifact("research", "input", {
        request,
        context_digest: bundle.request_digest ?? null,
        focus_files: bundle.selection?.focus ?? [],
        queries: bundle.queries ?? [],
        reason: reason ?? null,
      });
      const resolvedQuota = resolveToolQuota(
        this.options.deepInvestigation?.toolQuota,
      );
      const resolvedBudget = resolveInvestigationBudget(
        this.options.deepInvestigation?.investigationBudget,
      );
      const resolvedEvidenceGate = resolveEvidenceGate(
        this.options.deepInvestigation?.evidenceGate,
      );
      const minCycles = Math.max(0, Math.floor(resolvedBudget.minCycles ?? 0));
      const minSeconds = Math.max(0, resolvedBudget.minSeconds ?? 0);
      const maxCycles = Math.max(
        0,
        Math.floor(resolvedBudget.maxCycles ?? minCycles),
      );
      const researchStartedAt = Date.now();
      const notes: string[] = [];
      const pushNote = (note: string): void => {
        if (!notes.includes(note)) notes.push(note);
      };
      const phaseResult = await this.runPhase<ResearchPhaseResult>(
        "research",
        async () => {
          const researchRunner = this.options.contextAssembler as ContextAssembler & {
            runResearchTools?: (
              requestText: string,
              bundle: ContextBundle,
            ) => Promise<ResearchToolExecution>;
          };
          const outputs: ResearchToolExecution["outputs"] = {
            searchResults: [],
            snippets: [],
            symbols: [],
            ast: [],
            impact: [],
            impactDiagnostics: [],
          };
          const toolRuns: ResearchToolExecution["toolRuns"] = [];
          const warnings: string[] = [];
          const buildEvidenceGateAssessment = (): {
            evidence: ContextResearchEvidence;
            toolUsage: ContextResearchToolUsage;
            evidenceGate: EvidenceGateAssessment;
          } => {
            const evidence = buildResearchEvidence(outputs, warnings);
            const toolUsage = buildResearchToolUsage(toolRuns);
            const evidenceGate = evaluateEvidenceGate({
              config: resolvedEvidenceGate,
              evidence,
              toolUsage,
              warnings,
            });
            return { evidence, toolUsage, evidenceGate };
          };
          if (typeof researchRunner.runResearchTools !== "function") {
            warnings.push("research_executor_missing");
            const { evidence, toolUsage, evidenceGate } =
              buildEvidenceGateAssessment();
            return {
              status: "completed",
              startedAt: researchStartedAt,
              warnings: uniqueStrings(warnings),
              toolRuns: [],
              outputs,
              cycles: 0,
              budget: {
                status: "unmet",
                minCycles,
                minSeconds,
                maxCycles,
                elapsedMs: 0,
                cycles: 0,
              },
              evidence,
              toolUsage,
              evidenceGate,
            };
          }
          let cycles = 0;
          let researchContext = bundle;
          let lastRefreshSignature = "";
          let lastEvidenceSignature = "";
          let stalledEvidenceCycles = 0;
          while (true) {
            cycles += 1;
            const execution = await researchRunner.runResearchTools(
              request,
              researchContext,
            );
            toolRuns.push(...execution.toolRuns);
            warnings.push(...execution.warnings);
            outputs.searchResults.push(...execution.outputs.searchResults);
            outputs.snippets.push(...execution.outputs.snippets);
            outputs.symbols.push(...execution.outputs.symbols);
            outputs.ast.push(...execution.outputs.ast);
            outputs.impact.push(...execution.outputs.impact);
            outputs.impactDiagnostics.push(...execution.outputs.impactDiagnostics);
            if (execution.outputs.repoMap) outputs.repoMap = execution.outputs.repoMap;
            if (execution.outputs.repoMapRaw) outputs.repoMapRaw = execution.outputs.repoMapRaw;
            if (execution.outputs.dagSummary) outputs.dagSummary = execution.outputs.dagSummary;
            const elapsedMs = Date.now() - researchStartedAt;
            const quotaAssessment = buildToolQuotaAssessment(
              toolRuns,
              resolvedQuota,
            );
            const budgetMet = cycles >= minCycles && elapsedMs >= minSeconds * 1000;
            const { evidence, toolUsage, evidenceGate } =
              buildEvidenceGateAssessment();
            const evidenceMet = evidenceGate.status === "pass";
            const needsMore = !budgetMet || !quotaAssessment.ok || !evidenceMet;
            if (
              quotaAssessment.ok
              && evidenceMet
              && !budgetMet
              && minSeconds > 0
              && cycles >= minCycles
            ) {
              const remainingMs = minSeconds * 1000 - elapsedMs;
              if (remainingMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, remainingMs));
              }
              const waitedElapsed = Date.now() - researchStartedAt;
              return {
                status: "completed",
                startedAt: researchStartedAt,
                warnings: uniqueStrings(warnings),
                toolRuns,
                outputs,
                cycles,
                budget: {
                  status: "met",
                  minCycles,
                  minSeconds,
                  maxCycles,
                  elapsedMs: waitedElapsed,
                  cycles,
                },
                evidence,
                toolUsage,
                evidenceGate,
              };
            }
            if (!needsMore || cycles >= maxCycles) {
              return {
                status: "completed",
                startedAt: researchStartedAt,
                warnings: uniqueStrings(warnings),
                toolRuns,
                outputs,
                cycles,
                budget: {
                  status: budgetMet ? "met" : "unmet",
                  minCycles,
                  minSeconds,
                  maxCycles,
                  elapsedMs,
                  cycles,
                },
                evidence,
                toolUsage,
                evidenceGate,
              };
            }
            const refresh = buildResearchContextRefresh(
              researchContext,
              outputs,
              evidenceGate.missing,
            );
            const { warnings: _ignoredWarnings, gaps: _ignoredGaps, ...evidenceCore } =
              evidence;
            const evidenceSignature = createHash("sha1")
              .update(JSON.stringify({ evidence: evidenceCore, toolUsage }))
              .digest("hex");
            const evidenceUnchanged = evidenceSignature === lastEvidenceSignature;
            if (!evidenceUnchanged) {
              lastEvidenceSignature = evidenceSignature;
              stalledEvidenceCycles = 0;
            }
            if (!refresh.changed) {
              warnings.push("research_stalled_no_new_inputs");
              if (evidenceUnchanged) {
                stalledEvidenceCycles += 1;
                warnings.push("research_no_new_evidence");
                pushNote(
                  `Research cycle ${cycles} produced no new evidence; stopping additional tool calls.`,
                );
                if (cycles >= minCycles) {
                  const remainingMs = minSeconds * 1000 - elapsedMs;
                  if (remainingMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remainingMs));
                  }
                  const waitedElapsed = Date.now() - researchStartedAt;
                  return {
                    status: "completed",
                    startedAt: researchStartedAt,
                    warnings: uniqueStrings(warnings),
                    toolRuns,
                    outputs,
                    cycles,
                    budget: {
                      status: waitedElapsed >= minSeconds * 1000 ? "met" : "unmet",
                      minCycles,
                      minSeconds,
                      maxCycles,
                      elapsedMs: waitedElapsed,
                      cycles,
                    },
                    evidence,
                    toolUsage,
                    evidenceGate,
                  };
                }
              }
              if (needsMore && cycles >= minCycles && evidenceMet && quotaAssessment.ok) {
                return {
                  status: "completed",
                  startedAt: researchStartedAt,
                  warnings: uniqueStrings(warnings),
                  toolRuns,
                  outputs,
                  cycles,
                  budget: {
                    status: budgetMet ? "met" : "unmet",
                    minCycles,
                    minSeconds,
                    maxCycles,
                    elapsedMs,
                    cycles,
                  },
                  evidence,
                  toolUsage,
                  evidenceGate,
                };
              }
            } else {
              if (evidenceUnchanged) {
                stalledEvidenceCycles = 0;
              }
              const signature = JSON.stringify({
                queries: refresh.context.queries ?? [],
                focus: refresh.context.selection?.focus ?? [],
              });
              if (signature === lastRefreshSignature) {
                warnings.push("research_stalled_no_new_inputs");
              } else {
                lastRefreshSignature = signature;
                researchContext = refresh.context;
              }
            }
          }
        },
      );
      const researchEndedAt = Date.now();
      const evidence =
        phaseResult.evidence ??
        buildResearchEvidence(phaseResult.outputs, phaseResult.warnings);
      const researchToolUsage =
        phaseResult.toolUsage ?? buildResearchToolUsage(phaseResult.toolRuns);
      const evidenceGate =
        phaseResult.evidenceGate ??
        evaluateEvidenceGate({
          config: resolvedEvidenceGate,
          evidence,
          toolUsage: researchToolUsage,
          warnings: phaseResult.warnings,
        });
      const mergedNotes = uniqueStrings([...(phaseResult.notes ?? []), ...notes]);
      const researchPhase: ResearchPhaseResult = {
        ...phaseResult,
        endedAt: researchEndedAt,
        durationMs: researchEndedAt - researchStartedAt,
        evidence,
        toolUsage: researchToolUsage,
        evidenceGate,
        notes: mergedNotes.length ? mergedNotes : undefined,
      };
      await logPhaseArtifact("research", "output", researchPhase);
      const toolUsage = buildToolUsageSummary(researchPhase.toolRuns);
      const quotaAssessment = buildToolQuotaAssessment(
        researchPhase.toolRuns,
        resolvedQuota,
      );
      const budgetStatus = researchPhase.budget ?? {
        status: "unmet",
        minCycles,
        minSeconds,
        maxCycles,
        elapsedMs: researchPhase.durationMs ?? 0,
        cycles: researchPhase.cycles ?? 0,
      };
      const researchProtocol = buildResearchProtocolResponse(researchPhase);
      if (researchProtocol) {
        await appendProtocolToLanes(
          formatCodaliResponse(researchProtocol),
          "research protocol",
        );
      }
      await appendProtocolToLanes(
        formatGbfnMemory(request, researchPhase, quotaAssessment, budgetStatus),
        "research memory",
      );
      if (this.options.logger) {
        const evidenceGate = researchPhase.evidenceGate ?? {
          status: "not_checked",
          reason: "evidence_gate_not_enforced",
        };
        const quota = {
          status: quotaAssessment.ok ? "met" : "unmet",
          missing: quotaAssessment.missing,
          required: quotaAssessment.required,
          observed: quotaAssessment.observed,
        };
        const budget = {
          status: budgetStatus.status,
          required_cycles: budgetStatus.minCycles,
          cycles: budgetStatus.cycles,
          required_ms: budgetStatus.minSeconds * 1000,
          elapsed_ms: budgetStatus.elapsedMs,
        };
        const summary = [
          `Research ${researchPhase.status} in ${researchPhase.durationMs ?? 0}ms.`,
          `Cycles: ${budgetStatus.cycles}/${budgetStatus.minCycles}.`,
          `Tools: ${formatToolUsageSummary(toolUsage)}.`,
          `Evidence gate: ${evidenceGate.status}.`,
          `Quota: ${quota.status}.`,
          `Budget: ${budget.status}.`,
        ].join(" ");
        await this.options.logger.log("investigation_telemetry", {
          phase: "research",
          status: researchPhase.status,
          duration_ms: researchPhase.durationMs ?? 0,
          tool_usage: toolUsage.byTool,
          tool_usage_totals: toolUsage.totals,
          evidence_gate: evidenceGate,
          quota,
          budget,
          warnings: researchPhase.warnings,
          summary,
        });
      }
      if (!quotaAssessment.ok) {
        if (this.options.logger) {
          await this.options.logger.log("investigation_quota_failed", {
            status: "unmet",
            missing: quotaAssessment.missing,
            required: quotaAssessment.required,
            observed: quotaAssessment.observed,
          });
        }
        throw createDeepInvestigationQuotaError({
          missing: quotaAssessment.missing,
          required: quotaAssessment.required,
          observed: quotaAssessment.observed,
        });
      }
      if (budgetStatus.status !== "met") {
        if (this.options.logger) {
          await this.options.logger.log("investigation_budget_failed", {
            status: "unmet",
            required_cycles: budgetStatus.minCycles,
            cycles: budgetStatus.cycles,
            required_ms: budgetStatus.minSeconds * 1000,
            elapsed_ms: budgetStatus.elapsedMs,
          });
        }
        throw createDeepInvestigationBudgetError({
          minCycles: budgetStatus.minCycles,
          minSeconds: budgetStatus.minSeconds,
          maxCycles: budgetStatus.maxCycles,
          cycles: budgetStatus.cycles,
          elapsedMs: budgetStatus.elapsedMs,
        });
      }
      if (researchPhase.evidenceGate?.status !== "pass") {
        if (this.options.logger) {
          await this.options.logger.log("investigation_evidence_failed", {
            status: "unmet",
            missing: researchPhase.evidenceGate?.missing ?? [],
            required: researchPhase.evidenceGate?.required ?? {},
            observed: researchPhase.evidenceGate?.observed ?? {},
            warnings: researchPhase.evidenceGate?.warnings ?? [],
            gaps: researchPhase.evidenceGate?.gaps ?? [],
          });
        }
        const emptyEvidenceMetrics = {
          search_hits: 0,
          open_or_snippet: 0,
          symbols_or_ast: 0,
          impact: 0,
          warnings: 0,
        };
        throw createDeepInvestigationEvidenceError({
          missing: researchPhase.evidenceGate?.missing ?? [],
          required: researchPhase.evidenceGate?.required ?? emptyEvidenceMetrics,
          observed: researchPhase.evidenceGate?.observed ?? emptyEvidenceMetrics,
          warnings: researchPhase.evidenceGate?.warnings ?? [],
          gaps: researchPhase.evidenceGate?.gaps ?? [],
        });
      }
      return researchPhase;
    };

    let context: ContextBundle;
    if (this.options.initialContext) {
      await logPhaseArtifact("librarian", "input", { request });
      context = this.options.initialContext;
      await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
      if (this.options.logger) {
        await this.options.logger.log("phase_start", { phase: "librarian" });
        await this.options.logger.log("phase_end", { phase: "librarian", duration_ms: 0 });
      }
      this.emitStatus("thinking", "librarian: using preflight context");
    } else {
      await logPhaseArtifact("librarian", "input", { request });
      context = await this.runPhase("librarian", () => this.options.contextAssembler.assemble(request));
      await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
    }
    if (this.options.logger) {
      const files = context.files ?? [];
      const focusCount = files.filter((file) => file.role === "focus").length;
      const peripheryCount = files.filter((file) => file.role === "periphery").length;
      await this.options.logger.log("context_summary", {
        focusCount,
        peripheryCount,
        serializedMode: context.serialized?.mode ?? null,
        serializedBytes: context.serialized?.content.length ?? 0,
        warnings: context.warnings.length,
        redactionCount: context.redaction?.count ?? 0,
        ignoredFiles: context.redaction?.ignored ?? [],
      });
    }
    let researchPhase: ResearchPhaseResult | undefined = {
      status: "skipped",
      warnings: [],
      toolRuns: [],
    };
    if (deepMode) {
      researchPhase = await runDeepResearchPhase(context, "initial");
      const researchSummary = buildResearchSummary(researchPhase);
      if (researchSummary) {
        const updated = { ...context, research: researchSummary };
        updated.serialized = buildSerializedContext(updated);
        context = updated;
      }
    }
    let contextSignature = buildContextSignature(context);
    const updateContextSignature = async (
      reason: string,
      pass: number,
      extra: Record<string, unknown> = {},
    ): Promise<boolean> => {
      const nextSignature = buildContextSignature(context);
      if (nextSignature === contextSignature) {
        if (this.options.logger) {
          await this.options.logger.log("architect_retry_skipped_no_new_context", {
            pass,
            reason,
            ...extra,
          });
        }
        return false;
      }
      contextSignature = nextSignature;
      return true;
    };
    const configuredFastPath = this.options.fastPath?.(request) ?? false;
    const useFastPath = deepMode ? false : configuredFastPath;
    if (deepMode && configuredFastPath && this.options.logger) {
      await this.options.logger.log("fast_path_overridden", {
        reason: "deep_mode",
      });
    }
    let lastPlanHintUsed: string | undefined;
    const runArchitectPass = async (
      pass: number,
      options: {
        planHint?: string;
        instructionHint?: string;
        contextOverride?: ContextBundle;
        validateOnly?: boolean;
        responseFormat?: ProviderResponseFormat;
      } = {},
    ): Promise<ArchitectPlanResult> => {
      const planner = this.options.architectPlanner as unknown as {
        planWithRequest?: (context: ContextBundle, opts: Record<string, unknown>) => Promise<ArchitectPlanResult>;
        plan: (context: ContextBundle, opts: Record<string, unknown>) => Promise<Plan>;
      };
      const hasPlanHintOverride = Object.prototype.hasOwnProperty.call(
        options,
        "planHint",
      );
      const effectivePlanHint = deepMode
        ? undefined
        : hasPlanHintOverride
          ? options.planHint
          : configuredPlanHint;
      if (deepMode) {
        await logPlanHintSuppressed(options.planHint);
      }
      lastPlanHintUsed = effectivePlanHint;
      const architectContext = options.contextOverride ?? context;
      await logPhaseArtifact("architect", "input", {
        pass,
        request,
        context: buildSerializedContext(architectContext),
        plan_hint: effectivePlanHint ?? null,
        instruction_hint: options.instructionHint ?? null,
        validate_only: options.validateOnly ?? false,
      });
      const buildPlannerOptions = (
        extra: Record<string, unknown> = {},
      ): Record<string, unknown> => {
        const baseOptions: Record<string, unknown> = {
          contextManager: this.options.contextManager,
          laneId: architectLaneId,
          instructionHint: options.instructionHint,
          responseFormat: options.responseFormat,
          ...extra,
        };
        if (deepMode || hasPlanHintOverride) {
          baseOptions.planHint = effectivePlanHint;
        }
        return baseOptions;
      };
      if (planner.planWithRequest) {
        try {
          return await this.runPhase("architect", () =>
            planner.planWithRequest!(
              architectContext,
              buildPlannerOptions({
                validateOnly: options.validateOnly ?? false,
              }),
            ),
          );
        } catch (error) {
          if (options.validateOnly && error instanceof PlanHintValidationError) {
            if (this.options.logger) {
              await this.options.logger.log("architect_plan_hint_validate_fallback", {
                pass,
                issues: error.issues,
                warnings: error.warnings,
                parseError: error.parseError,
              });
            }
            lastPlanHintUsed = undefined;
            return this.runPhase("architect", () =>
              planner.planWithRequest!(architectContext, {
                contextManager: this.options.contextManager,
                laneId: architectLaneId,
                planHint: "",
                instructionHint: options.instructionHint,
                validateOnly: false,
                responseFormat: options.responseFormat,
              }),
            );
          }
          throw error;
        }
      }
      const plan = await this.runPhase("architect", () =>
        planner.plan(architectContext, buildPlannerOptions()),
      );
      return { plan, raw: "", warnings: [] };
    };

    let plan: Plan;
    if (useFastPath) {
      plan = buildFastPlan(context);
      await logPhaseArtifact("architect", "output", {
        pass: 0,
        source: "fast_path",
        raw_output: "",
        normalized_output: plan,
        warnings: [],
      });
    } else {
      let pass = 1;
      let lastPlan: ArchitectPlanResult | undefined;
      const allowAutoRetry = false;
      const maxRequestRecovery = 1;
      const maxPasses = 1 + maxRequestRecovery;
      const reflectionHint =
        "REFINE the previous plan. Re-check constraints and request specificity. Output the full DSL plan.";
      let strictRetryTriggered = false;
      let verificationRetryTriggered = false;
      let fallbackRecoveryTriggered = false;
      let previousPlanHash: string | undefined;
      let previousConcreteTargets: string[] | undefined;
      let alternateStrategyUsed = false;
      let alternateHintPending = false;
      let structuralRecoveryTriggered = false;
      let driftRecoveryTriggered = false;
      let invalidTargetRecoveryTriggered = false;
      let requestRecoveryCount = 0;
      let previousRequestFingerprint: string | undefined;
      let requestRecoveryPending = false;
      while (pass <= maxPasses) {
        if (pass > 1 && !allowAutoRetry && !requestRecoveryPending) {
          break;
        }
        const strictRetryPass = allowAutoRetry && strictRetryTriggered && pass === 2;
        const recoveryPass = allowAutoRetry && maxPasses > 1 && pass === maxPasses;
        const hintParts: string[] = [];
        if (allowAutoRetry && pass > 1) hintParts.push(reflectionHint);
        if (strictRetryPass) hintParts.push(ARCHITECT_STRICT_DSL_HINT);
        if (verificationRetryTriggered) hintParts.push(ARCHITECT_VERIFY_QUALITY_HINT);
        if (recoveryPass) hintParts.push(ARCHITECT_RECOVERY_HINT);
        if (alternateHintPending) {
          hintParts.push(ARCHITECT_ALTERNATE_RETRY_HINT);
          alternateHintPending = false;
        }
        const instructionHint = hintParts.length > 0 ? hintParts.join("\n\n") : undefined;
        const passContext = strictRetryPass
          ? narrowContextForStrictArchitectRetry(context)
          : context;
        const responseFormat = undefined;
        const result = await runArchitectPass(pass, {
          instructionHint,
          contextOverride: passContext,
          validateOnly: pass === 1,
          responseFormat,
        });
        const warnings = [...(result.warnings ?? [])];
        const planHash = hashArchitectResult(result);
        const classification = classifyArchitectWarnings(warnings);
        const repairApplied = hasRepairWarnings(warnings);
        const qualityGate = assessPlanQualityGate(request, result.plan, passContext);
        const structuralGrounding = assessStructuralGrounding(passContext, result.plan);
        const targetDrift = assessTargetDrift(previousConcreteTargets, qualityGate.concreteTargets);
        const nonDsl = isArchitectNonDsl(warnings);
        if (result.request) {
          if (nonDsl && pass === 1 && allowAutoRetry) {
            strictRetryTriggered = true;
          }
          requestRecoveryCount += 1;
          const requestFingerprint = hashAgentRequestShape(result.request);
          const repeatedRequest = previousRequestFingerprint === requestFingerprint;
          previousRequestFingerprint = requestFingerprint;
          if (repeatedRequest && !alternateStrategyUsed) {
            alternateStrategyUsed = true;
            alternateHintPending = true;
            if (this.options.logger) {
              await this.options.logger.log("architect_retry_strategy", {
                pass,
                action: "repeat_request_with_alternate_hint",
                request_recovery_count: requestRecoveryCount,
              });
            }
          }
          emitAgentRequestRecoveryStatus("architect_request");
          const response = await this.options.contextAssembler.fulfillAgentRequest(result.request);
          const responseText = formatCodaliResponse(response);
          if (this.options.logger) {
            await this.options.logger.log("architect_request_fulfilled", {
              request_id: result.request.request_id,
              results: response.results.length,
              warnings: response.meta?.warnings ?? [],
            });
          }
          await appendArchitectHistory(responseText);
          await logPhaseArtifact(
            "architect",
            "output",
            buildArchitectOutputArtifactPayload({
              pass,
              strictRetry: strictRetryPass,
              planHint: lastPlanHintUsed,
              instructionHint,
              result,
              requestResponse: response,
              source: "architect_request",
              planHash,
              classification,
              repairApplied,
              recoveryAction: "architect_request_fulfilled",
              structuralGrounding,
              targetDrift,
              responseFormat,
            }),
          );
          let contextRefreshed = false;
          if (pass < maxPasses && requestRecoveryCount <= maxRequestRecovery) {
            let refreshInputs = extractAgentRequestContextInputs(result.request);
            if (typeof this.options.contextAssembler.buildContextRefreshOptions === "function") {
              try {
                refreshInputs = this.options.contextAssembler.buildContextRefreshOptions(
                  result.request,
                );
              } catch (error) {
                if (this.options.logger) {
                  await this.options.logger.log("architect_request_refresh_failed", {
                    request_id: result.request.request_id,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            const additionalQueries = uniqueStrings(refreshInputs.additionalQueries ?? []);
            const preferredFiles = uniqueStrings(refreshInputs.preferredFiles ?? []);
            const recentFiles = uniqueStrings([
              ...(context.selection?.all ?? []),
              ...preferredFiles,
            ]).slice(0, 24);
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_request",
              request_id: result.request.request_id,
              additional_queries: additionalQueries,
              preferred_files: preferredFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries,
                preferredFiles,
                recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            if (deepMode) {
              researchPhase = await runDeepResearchPhase(context, "architect_request");
              const researchSummary = buildResearchSummary(researchPhase);
              if (researchSummary) {
                const updated = { ...context, research: researchSummary };
                updated.serialized = buildSerializedContext(updated);
                context = updated;
              }
            }
            contextRefreshed = await updateContextSignature("architect_request", pass, {
              request_id: result.request.request_id,
            });
          }
          if (
            pass < maxPasses
            && requestRecoveryCount <= maxRequestRecovery
            && !contextRefreshed
          ) {
            warnings.push("architect_retry_skipped_no_new_context");
            lastPlan = { ...result, warnings: uniqueStrings(warnings) };
            if (this.options.logger) {
              await this.options.logger.log("architect_degraded", {
                pass,
                reason: "request_loop_no_new_context",
                request_recovery_count: requestRecoveryCount,
                warnings: uniqueStrings(warnings),
              });
            }
            break;
          }
          if (pass >= maxPasses || requestRecoveryCount > maxRequestRecovery) {
            warnings.push("architect_degraded_request_loop");
            lastPlan = { ...result, warnings: uniqueStrings(warnings) };
            if (this.options.logger) {
              await this.options.logger.log("architect_degraded", {
                pass,
                reason: "request_loop_after_recovery",
                request_recovery_count: requestRecoveryCount,
                warnings: uniqueStrings(warnings),
              });
            }
            break;
          }
          requestRecoveryPending = true;
          pass += 1;
          continue;
        }
        requestRecoveryPending = false;
        requestRecoveryCount = 0;
        previousRequestFingerprint = undefined;
        lastPlan = result;
        if (this.options.logger) {
          await this.options.logger.log("architect_output", {
            steps: result.plan.steps.length,
            target_files: result.plan.target_files.length,
            pass,
            warnings,
            strict_retry: strictRetryPass,
            classification,
            repair_applied: repairApplied,
            structural_grounding_score: structuralGrounding.score,
            structural_grounding_reasons: structuralGrounding.reasons,
            target_drift: targetDrift.drift,
            target_similarity: targetDrift.similarity,
          });
        }
        await logPhaseArtifact(
          "architect",
          "output",
          buildArchitectOutputArtifactPayload({
            pass,
            strictRetry: strictRetryPass,
            planHint: lastPlanHintUsed,
            instructionHint,
            result,
            planHash,
            classification,
            repairApplied,
            qualityGate,
            structuralGrounding,
            targetDrift,
            responseFormat,
          }),
        );
        const repeatedOutput = previousPlanHash === planHash;
        if (allowAutoRetry && nonDsl && pass === 1) {
          previousPlanHash = planHash;
          previousConcreteTargets = qualityGate.concreteTargets;
          strictRetryTriggered = true;
          if (this.options.logger) {
            await this.options.logger.log("architect_non_dsl_detected", {
              pass,
              warnings,
              action: "strict_retry",
            });
          }
          pass += 1;
          continue;
        }
        if (nonDsl && strictRetryPass) {
          if (allowAutoRetry && pass < maxPasses) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus("non_dsl_repeated_after_strict_retry");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: "non_dsl_recovery",
            });
            if (this.options.logger) {
              await this.options.logger.log("architect_guardrail_request", {
                pass,
                reason: "non_dsl_repeated_after_strict_retry",
                request_id: recovery.requestPayload.request_id,
                warnings,
              });
            }
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_non_dsl_recovery",
              additional_queries: recovery.additionalQueries,
              preferred_files: recovery.preferredFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recovery.additionalQueries,
                preferredFiles: recovery.preferredFiles,
                recentFiles: recovery.recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            const contextRefreshed = await updateContextSignature(
              "non_dsl_recovery",
              pass,
              { request_id: recovery.requestPayload.request_id },
            );
            if (!contextRefreshed) {
              warnings.push("architect_retry_skipped_no_new_context");
              warnings.push("architect_degraded_non_dsl");
              lastPlan = { ...result, warnings: uniqueStrings(warnings) };
              if (this.options.logger) {
                await this.options.logger.log("architect_degraded", {
                  pass,
                  reason: "non_dsl_recovery_no_new_context",
                  warnings: uniqueStrings(warnings),
                });
              }
              break;
            }
            fallbackRecoveryTriggered = true;
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
          }
          warnings.push("architect_degraded_non_dsl");
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: "non_dsl_repeated_after_strict_retry",
              warnings,
            });
          }
          break;
        }
        if (nonDsl && recoveryPass) {
          warnings.push("architect_degraded_non_dsl");
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: "non_dsl_after_recovery_pass",
              warnings,
            });
          }
          break;
        }
        if (!structuralGrounding.ok) {
          if (this.options.logger) {
            await this.options.logger.log("architect_structural_grounding", {
              pass,
              ok: false,
              score: structuralGrounding.score,
              reasons: structuralGrounding.reasons,
              warning_hits: structuralGrounding.warningHits,
              has_focus: structuralGrounding.hasFocus,
              has_structural_signals: structuralGrounding.hasStructuralSignals,
              has_fallback_signals: structuralGrounding.hasFallbackSignals,
            });
          }
          if (allowAutoRetry && pass < maxPasses && !structuralRecoveryTriggered) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus("weak_structural_grounding");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: "structural_grounding_recovery",
              structural_grounding: structuralGrounding,
            });
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_structural_grounding",
              additional_queries: recovery.additionalQueries,
              preferred_files: recovery.preferredFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recovery.additionalQueries,
                preferredFiles: recovery.preferredFiles,
                recentFiles: recovery.recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            const contextRefreshed = await updateContextSignature(
              "structural_grounding_recovery",
              pass,
              { request_id: recovery.requestPayload.request_id },
            );
            if (!contextRefreshed) {
              warnings.push("architect_retry_skipped_no_new_context");
              warnings.push("architect_degraded_structural_grounding");
              const degradedPlan = buildQualityDegradedPlan(
                request,
                context,
                result.plan,
              );
              lastPlan = {
                ...result,
                plan: degradedPlan,
                warnings: uniqueStrings(warnings),
              };
              if (this.options.logger) {
                await this.options.logger.log("architect_degraded", {
                  pass,
                  reason: "structural_grounding_no_new_context",
                  warnings: uniqueStrings(warnings),
                });
              }
              break;
            }
            structuralRecoveryTriggered = true;
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
          }
          warnings.push("architect_degraded_structural_grounding");
          const degradedPlan = buildQualityDegradedPlan(request, context, result.plan);
          lastPlan = { ...result, plan: degradedPlan, warnings: uniqueStrings(warnings) };
          break;
        }
        structuralRecoveryTriggered = false;
        const verificationQuality = assessVerificationQuality(result.plan.verification);
        if (!verificationQuality.ok) {
          if (this.options.logger) {
            await this.options.logger.log("architect_verification_insufficient", {
              pass,
              reason: verificationQuality.reason,
              verification_steps: verificationQuality.steps,
            });
          }
          if (allowAutoRetry && pass < maxPasses) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus("verification_quality");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: "verification_recovery",
              verification_reason: verificationQuality.reason,
            });
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_verification_insufficient",
              additional_queries: recovery.additionalQueries,
              preferred_files: recovery.preferredFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recovery.additionalQueries,
                preferredFiles: recovery.preferredFiles,
                recentFiles: recovery.recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            const contextRefreshed = await updateContextSignature(
              "verification_recovery",
              pass,
              { request_id: recovery.requestPayload.request_id },
            );
            if (!contextRefreshed) {
              warnings.push("architect_retry_skipped_no_new_context");
              warnings.push("architect_degraded_verification_quality");
              const degradedPlan = buildQualityDegradedPlan(
                request,
                context,
                result.plan,
              );
              lastPlan = {
                ...result,
                plan: degradedPlan,
                warnings: uniqueStrings(warnings),
              };
              if (this.options.logger) {
                await this.options.logger.log("architect_degraded", {
                  pass,
                  reason: "verification_quality_no_new_context",
                  verification_reason: verificationQuality.reason,
                  verification_steps: verificationQuality.steps,
                  warnings: uniqueStrings(warnings),
                });
              }
              break;
            }
            fallbackRecoveryTriggered = true;
            verificationRetryTriggered = true;
            previousPlanHash = planHash;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
          }
          const degradedPlan = buildQualityDegradedPlan(request, context, result.plan);
          warnings.push("architect_degraded_verification_quality");
          lastPlan = { ...result, plan: degradedPlan, warnings: uniqueStrings(warnings) };
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: "verification_quality_insufficient_after_retries",
              verification_reason: verificationQuality.reason,
              verification_steps: verificationQuality.steps,
              warnings: uniqueStrings(warnings),
            });
          }
          break;
        }
        verificationRetryTriggered = false;
        const fallbackGenericAssessment = assessFallbackOrGenericPlan(result.plan, warnings);
        if (
          allowAutoRetry
          && fallbackGenericAssessment.fallback_or_generic
          && !fallbackRecoveryTriggered
          && pass < maxPasses
        ) {
          const recovery = buildFallbackRecoveryRequest(request, context, pass);
          emitAgentRequestRecoveryStatus("fallback_or_generic_plan");
          const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
          await appendArchitectHistory(formatCodaliResponse(response));
          await logPhaseArtifact("architect", "output", {
            request_id: recovery.requestPayload.request_id,
            response,
            source: "fallback_generic_recovery",
          });
          if (this.options.logger) {
            await this.options.logger.log("architect_guardrail_request", {
              pass,
              reason: "fallback_or_generic_plan",
              request_id: recovery.requestPayload.request_id,
              generic_step_hits: fallbackGenericAssessment.generic_step_hits,
              reasons: fallbackGenericAssessment.reasons,
            });
          }
          await logPhaseArtifact("librarian", "input", {
            request,
            reason: "architect_fallback_or_generic_plan",
            additional_queries: recovery.additionalQueries,
            preferred_files: recovery.preferredFiles,
          });
          context = await this.runPhase("librarian", () =>
            this.options.contextAssembler.assemble(request, {
              additionalQueries: recovery.additionalQueries,
              preferredFiles: recovery.preferredFiles,
              recentFiles: recovery.recentFiles,
            }),
          );
          await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
          const contextRefreshed = await updateContextSignature(
            "fallback_generic_recovery",
            pass,
            { request_id: recovery.requestPayload.request_id },
          );
          if (!contextRefreshed) {
            warnings.push("architect_retry_skipped_no_new_context");
            lastPlan = { ...result, warnings: uniqueStrings(warnings) };
            if (this.options.logger) {
              await this.options.logger.log("architect_degraded", {
                pass,
                reason: "fallback_generic_no_new_context",
                warnings: uniqueStrings(warnings),
              });
            }
            break;
          }
          fallbackRecoveryTriggered = true;
          previousPlanHash = undefined;
          previousConcreteTargets = qualityGate.concreteTargets;
          pass += 1;
          continue;
        }
        const alignment = scoreRequestTargetAlignment(request, result.plan.target_files ?? []);
        const endpointIntent = ENDPOINT_SERVER_INTENT_PATTERN.test(request);
        const backendTargetPresent = hasBackendTarget(result.plan.target_files ?? []);
        const backendCandidates = backendCandidatesFromContext(context);
        const lowAlignment = !endpointIntent && alignment.keywords.length >= 3 && alignment.score < 0.2;
        const endpointMissingBackend = endpointIntent && !backendTargetPresent;
        if (this.options.logger) {
          await this.options.logger.log("architect_relevance", {
            pass,
            alignment_score: alignment.score,
            alignment_keywords: alignment.keywords,
            alignment_matches: alignment.matches,
            endpoint_intent: endpointIntent,
            backend_target_present: backendTargetPresent,
            backend_candidates: backendCandidates.slice(0, 8),
          });
        }
        if (lowAlignment || endpointMissingBackend) {
          if (allowAutoRetry && pass <= maxPasses) {
            if (endpointMissingBackend) {
              const guardRequest: AgentRequest = {
                version: "v1",
                role: "architect",
                request_id: `architect-guard-${Date.now()}-${pass}`,
                needs: [
                  {
                    type: "docdex.search",
                    query: `${request} backend server route handler api`,
                    limit: 8,
                  },
                  {
                    type: "file.list",
                    root: "src",
                    pattern: "*server*",
                  },
                ],
                context: {
                  summary:
                    "Endpoint/server intent detected, but plan has no backend/server target. Need backend candidates before finalizing plan.",
                },
              };
              emitAgentRequestRecoveryStatus("endpoint_missing_backend_target");
              const response = await this.options.contextAssembler.fulfillAgentRequest(guardRequest);
              await appendArchitectHistory(formatCodaliResponse(response));
              await logPhaseArtifact("architect", "output", {
                request_id: guardRequest.request_id,
                response,
                source: "relevance_guard",
              });
              if (this.options.logger) {
                await this.options.logger.log("architect_guardrail_request", {
                  pass,
                  reason: "endpoint_missing_backend_target",
                  request_id: guardRequest.request_id,
                });
              }
            }
            if (pass < maxPasses) {
              const additionalQueries = uniqueStrings(
                [
                  `${request} backend server route handler`,
                  ...((context.queries ?? []).slice(0, 2)),
                ].filter(Boolean),
              );
              const preferredFiles = uniqueStrings([
                ...backendCandidates.slice(0, 8),
                ...(context.selection?.focus ?? []),
              ]);
              const recentFiles = uniqueStrings([
                ...(context.selection?.all ?? []),
                ...preferredFiles,
              ]);
              await logPhaseArtifact("librarian", "input", {
                request,
                reason: endpointMissingBackend
                  ? "architect_relevance_endpoint_missing_backend"
                  : "architect_relevance_low_alignment",
                additional_queries: additionalQueries,
                preferred_files: preferredFiles,
              });
              context = await this.runPhase("librarian", () =>
                this.options.contextAssembler.assemble(request, {
                  additionalQueries,
                  preferredFiles,
                  recentFiles,
                }),
              );
              await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
              const contextRefreshed = await updateContextSignature(
                endpointMissingBackend
                  ? "relevance_endpoint_missing_backend"
                  : "relevance_low_alignment",
                pass,
              );
              if (!contextRefreshed) {
                warnings.push("architect_retry_skipped_no_new_context");
                warnings.push(
                  endpointMissingBackend
                    ? "architect_degraded_relevance_endpoint_missing_backend"
                    : "architect_degraded_relevance_low_alignment",
                );
                lastPlan = { ...result, warnings: uniqueStrings(warnings) };
                if (this.options.logger) {
                  await this.options.logger.log("architect_degraded", {
                    pass,
                    reason: endpointMissingBackend
                      ? "relevance_endpoint_missing_backend_no_new_context"
                      : "relevance_low_alignment_no_new_context",
                    alignment_score: alignment.score,
                    alignment_keywords: alignment.keywords,
                    alignment_matches: alignment.matches,
                    warnings: uniqueStrings(warnings),
                  });
                }
                break;
              }
              previousPlanHash = undefined;
              previousConcreteTargets = qualityGate.concreteTargets;
              pass += 1;
              continue;
            }
          }
          warnings.push(
            endpointMissingBackend
              ? "architect_degraded_relevance_endpoint_missing_backend"
              : "architect_degraded_relevance_low_alignment",
          );
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: endpointMissingBackend
                ? "relevance_endpoint_missing_backend"
                : "relevance_low_alignment",
              alignment_score: alignment.score,
              alignment_keywords: alignment.keywords,
              alignment_matches: alignment.matches,
              warnings,
            });
          }
          break;
        }
        if (targetDrift.high && warnings.length > 0 && !fallbackRecoveryTriggered && !verificationRetryTriggered) {
          if (this.options.logger) {
            await this.options.logger.log("architect_target_drift", {
              pass,
              high: true,
              similarity: targetDrift.similarity,
              drift: targetDrift.drift,
              previous: targetDrift.previous,
              current: targetDrift.current,
            });
          }
          if (allowAutoRetry && pass < maxPasses && !driftRecoveryTriggered) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus("high_target_drift");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: "target_drift_recovery",
              target_drift: targetDrift,
            });
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_target_drift",
              additional_queries: recovery.additionalQueries,
              preferred_files: recovery.preferredFiles,
              target_drift: targetDrift,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recovery.additionalQueries,
                preferredFiles: recovery.preferredFiles,
                recentFiles: recovery.recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            const contextRefreshed = await updateContextSignature(
              "target_drift_recovery",
              pass,
              { request_id: recovery.requestPayload.request_id },
            );
            if (!contextRefreshed) {
              warnings.push("architect_retry_skipped_no_new_context");
              warnings.push("architect_degraded_target_drift");
              const stabilizedPlan = buildDriftStabilizedPlan(
                request,
                result.plan,
                targetDrift.previous,
              );
              lastPlan = {
                ...result,
                plan: stabilizedPlan,
                warnings: uniqueStrings(warnings),
              };
              if (this.options.logger) {
                await this.options.logger.log("architect_degraded", {
                  pass,
                  reason: "target_drift_no_new_context",
                  warnings: uniqueStrings(warnings),
                });
              }
              break;
            }
            driftRecoveryTriggered = true;
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
          }
          warnings.push("architect_degraded_target_drift");
          const stabilizedPlan = buildDriftStabilizedPlan(request, result.plan, targetDrift.previous);
          lastPlan = { ...result, plan: stabilizedPlan, warnings: uniqueStrings(warnings) };
          break;
        }
        driftRecoveryTriggered = false;
        if (!qualityGate.ok) {
          const unresolvedTargets = qualityGate.targetValidation?.unresolvedTargets ?? [];
          const hasInvalidTargets = unresolvedTargets.length > 0;
          if (this.options.logger) {
            await this.options.logger.log("architect_quality_gate", {
              stage: "architect_pass",
              pass,
              ok: false,
              reasons: qualityGate.reasons,
              concrete_targets: qualityGate.concreteTargets,
              alignment_score: qualityGate.alignmentScore,
              alignment_keywords: qualityGate.alignmentKeywords,
              semantic_score: qualityGate.semanticScore,
              semantic_anchors: qualityGate.semanticAnchors,
              semantic_matches: qualityGate.semanticMatches,
              target_validation: qualityGate.targetValidation ?? null,
              unresolved_targets: unresolvedTargets,
            });
          }
          const canAttemptInvalidTargetRecovery =
            hasInvalidTargets && !invalidTargetRecoveryTriggered && pass < maxPasses;
          if ((allowAutoRetry && pass < maxPasses) || canAttemptInvalidTargetRecovery) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus(hasInvalidTargets ? "invalid_targets" : "quality_gate");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: hasInvalidTargets ? "invalid_target_recovery" : "quality_gate_recovery",
              quality_gate: qualityGate,
            });
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: hasInvalidTargets ? "architect_invalid_targets" : "architect_quality_gate",
              additional_queries: recovery.additionalQueries,
              preferred_files: recovery.preferredFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recovery.additionalQueries,
                preferredFiles: recovery.preferredFiles,
                recentFiles: recovery.recentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            const contextRefreshed = await updateContextSignature(
              hasInvalidTargets ? "invalid_target_recovery" : "quality_gate_recovery",
              pass,
              { request_id: recovery.requestPayload.request_id },
            );
            if (!contextRefreshed) {
              warnings.push("architect_retry_skipped_no_new_context");
              warnings.push("architect_degraded_quality_gate");
              if (hasInvalidTargets) warnings.push("architect_invalid_targets");
              lastPlan = {
                ...result,
                warnings: uniqueStrings(warnings),
              };
              if (this.options.logger) {
                await this.options.logger.log("architect_degraded", {
                  pass,
                  reason: hasInvalidTargets
                    ? "invalid_targets_no_new_context"
                    : "quality_gate_no_new_context",
                  warnings: uniqueStrings(warnings),
                  quality_gate: qualityGate,
                  semantic_score: qualityGate.semanticScore,
                  semantic_anchors: qualityGate.semanticAnchors,
                  semantic_matches: qualityGate.semanticMatches,
                });
              }
              break;
            }
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            if (hasInvalidTargets) {
              invalidTargetRecoveryTriggered = true;
            }
            requestRecoveryPending = true;
            pass += 1;
            continue;
          }
          warnings.push("architect_degraded_quality_gate");
          if (hasInvalidTargets) warnings.push("architect_invalid_targets");
          const degradedPlan = hasInvalidTargets
            ? result.plan
            : buildQualityDegradedPlan(request, context, result.plan);
          const degradedQuality = assessPlanQualityGate(request, degradedPlan, context);
          lastPlan = { ...result, plan: degradedPlan, warnings: uniqueStrings(warnings) };
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: "quality_gate_failed_after_retries",
              warnings: uniqueStrings(warnings),
              quality_gate: qualityGate,
              degraded_quality: degradedQuality,
              semantic_score: qualityGate.semanticScore,
              semantic_anchors: qualityGate.semanticAnchors,
              semantic_matches: qualityGate.semanticMatches,
            });
          }
          break;
        }
        const blockingWarnings = warnings.filter((warning) => isBlockingArchitectWarning(warning));
        if (blockingWarnings.length === 0) {
          previousPlanHash = planHash;
          previousConcreteTargets = qualityGate.concreteTargets;
          if (this.options.logger) {
            await this.options.logger.log("architect_early_stop", {
              pass,
              reason: warnings.length === 0
                ? "acceptable_plan_quality"
                : "acceptable_plan_quality_with_non_blocking_warnings",
              warnings,
            });
          }
          break;
        }
        if (allowAutoRetry && repeatedOutput && !alternateStrategyUsed && pass < maxPasses) {
          alternateStrategyUsed = true;
          alternateHintPending = true;
          const additionalQueries = (context.queries ?? []).slice(0, 3);
          const preferredFiles = context.selection?.focus ?? [];
          const recentFiles = context.selection?.all ?? preferredFiles;
          await logPhaseArtifact("librarian", "input", {
            request,
            reason: "architect_identical_output",
            additional_queries: additionalQueries,
            preferred_files: preferredFiles,
          });
          context = await this.runPhase("librarian", () =>
            this.options.contextAssembler.assemble(request, {
              additionalQueries,
              preferredFiles,
              recentFiles,
            }),
          );
          await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
          const contextRefreshed = await updateContextSignature(
            "identical_output_refresh",
            pass,
          );
          if (!contextRefreshed) {
            warnings.push("architect_retry_skipped_no_new_context");
            lastPlan = { ...result, warnings: uniqueStrings(warnings) };
            if (this.options.logger) {
              await this.options.logger.log("architect_degraded", {
                pass,
                reason: "identical_output_no_new_context",
                warnings: uniqueStrings(warnings),
              });
            }
            break;
          }
          if (this.options.logger) {
            await this.options.logger.log("architect_retry_strategy", {
              pass,
              action: "context_refresh_with_alternate_hint",
              repeated_output_hash: planHash,
            });
          }
          previousPlanHash = undefined;
          previousConcreteTargets = qualityGate.concreteTargets;
          pass += 1;
          continue;
        }
        previousPlanHash = planHash;
        previousConcreteTargets = qualityGate.concreteTargets;
        if (!allowAutoRetry) {
          break;
        }
        pass += 1;
      }
      if (!lastPlan) {
        throw new Error("Architect failed to produce a plan");
      }
      plan = lastPlan.plan;
      const finalPlanQuality = assessPlanQualityGate(request, plan, context);
      if (!finalPlanQuality.ok) {
        const hadInvalidTargetFailures = (lastPlan.warnings ?? []).includes("architect_invalid_targets");
        const hasInvalidTargets = finalPlanQuality.reasons.includes("invalid_target_paths");
        const unresolved = finalPlanQuality.targetValidation?.unresolvedTargets ?? [];
        const unresolvedPart = unresolved.length > 0 ? ` unresolved_targets=${unresolved.join(",")}` : "";
        if (hasInvalidTargets || (hadInvalidTargetFailures && finalPlanQuality.reasons.includes("missing_concrete_targets"))) {
          throw new Error(
            `Architect quality gate failed before builder: invalid_target_paths.${unresolvedPart}`,
          );
        }
        const degradedPlan = buildQualityDegradedPlan(request, context, plan);
        const degradedQuality = assessPlanQualityGate(request, degradedPlan, context);
        const degradedBlockingReasons = collectBlockingPlanQualityReasons(degradedQuality);
        if (this.options.logger) {
          await this.options.logger.log("architect_quality_gate", {
            stage: "pre_builder",
            pass: "final",
            ok: false,
            reasons: finalPlanQuality.reasons,
            concrete_targets: finalPlanQuality.concreteTargets,
            alignment_score: finalPlanQuality.alignmentScore,
            alignment_keywords: finalPlanQuality.alignmentKeywords,
            semantic_score: finalPlanQuality.semanticScore,
            semantic_anchors: finalPlanQuality.semanticAnchors,
            semantic_matches: finalPlanQuality.semanticMatches,
            target_validation: finalPlanQuality.targetValidation ?? null,
            degraded_ok: degradedQuality.ok,
            degraded_target_validation: degradedQuality.targetValidation ?? null,
          });
        }
        await logPhaseArtifact("architect", "output", {
          source: "quality_gate_degrade",
          plan_before: plan,
          quality_before: finalPlanQuality,
          plan_after: degradedPlan,
          quality_after: degradedQuality,
          blocking_reasons_after: degradedBlockingReasons,
        });
        if (degradedBlockingReasons.length > 0) {
          const unresolved = degradedQuality.targetValidation?.unresolvedTargets ?? [];
          const unresolvedPart = unresolved.length > 0 ? ` unresolved_targets=${unresolved.join(",")}` : "";
          throw new Error(
            `Architect quality gate failed before builder: ${degradedBlockingReasons.join(", ")}.${unresolvedPart}`,
          );
        }
        plan = degradedPlan;
      }
      if (this.options.logger) {
        const planPath = await this.options.logger.writePhaseArtifact("architect", "plan", plan);
        await this.options.logger.log("plan_json", { phase: "architect", path: planPath });
      }
      await logLaneSummary("architect", architectLaneId);
    }

    let attempts = 0;
    let builderResult: BuilderRunResult | undefined;
    let criticResult: CriticResult | undefined;
    let refreshes = 0;
    const maxContextRefreshes = this.options.maxContextRefreshes ?? 0;
    let builderNote: string | undefined;
    let deterministicApplyRepairUsed = false;

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      const note = builderNote;
      builderNote = undefined;
      const touchedBefore = this.options.getTouchedFiles?.() ?? [];
      const builderContext = buildSerializedContext(context, "builder");
      const builderInputPath = await logPhaseArtifact("builder", "input", {
        plan,
        context: builderContext,
      });
      if (this.options.logger) {
        await this.options.logger.log("builder_input", {
          plan_targets: plan.target_files.length,
          context_bytes: builderContext.content.length,
          path: builderInputPath ?? null,
        });
      }
      let built: BuilderRunResult;
      try {
        built = await this.runPhase("builder", () =>
          this.options.builderRunner.run(plan, context, {
            contextManager: this.options.contextManager,
            laneId: builderLaneId,
            note,
          }),
        );
      } catch (error) {
        if (error instanceof PatchApplyError) {
          const failure = error.details;
          const deterministicApplyFailure = isDeterministicPatchApplyFailure(failure);
          builderResult = {
            finalMessage: { role: "assistant", content: failure.rawOutput },
            messages: [],
            toolCallsExecuted: 0,
          };
          const failurePath = await logPhaseArtifact("builder", "apply_failure", failure);
          if (this.options.logger) {
            await this.options.logger.log("builder_apply_failed", {
              error: failure.error,
              source: failure.source,
              rollback: failure.rollback,
              path: failurePath ?? null,
            });
          }
          await appendArchitectHistory(formatCodaliResponse(buildApplyFailureResponse(failure)));
          if (deterministicApplyFailure && !deterministicApplyRepairUsed) {
            deterministicApplyRepairUsed = true;
            if (this.options.logger) {
              await this.options.logger.log("builder_apply_failed_deterministic", {
                error: failure.error,
                source: failure.source,
                action: "architect_repair_once",
              });
            }
            const recoveryQueries = uniqueStrings(
              [
                `${request} fix missing target paths`,
                ...((context.queries ?? []).slice(0, 2)),
              ].filter(Boolean),
            );
            const recoveryFiles = uniqueStrings(plan.target_files ?? []);
            const recoveryRecentFiles = uniqueStrings([
              ...(context.selection?.all ?? []),
              ...recoveryFiles,
            ]).slice(0, 24);
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "builder_apply_failed_deterministic",
              additional_queries: recoveryQueries,
              preferred_files: recoveryFiles,
            });
            context = await this.runPhase("librarian", () =>
              this.options.contextAssembler.assemble(request, {
                additionalQueries: recoveryQueries,
                preferredFiles: recoveryFiles,
                recentFiles: recoveryRecentFiles,
              }),
            );
            await logPhaseArtifact("librarian", "output", sanitizeForOutput(context));
            await logPhaseArtifact("architect", "input", {
              request,
              reason: "builder_apply_failed_deterministic",
              context: buildSerializedContext(context),
            });
            plan = useFastPath
              ? buildFastPlan(context)
              : await this.runPhase("architect", () =>
                  this.options.architectPlanner.plan(context, {
                    contextManager: this.options.contextManager,
                    laneId: architectLaneId,
                  }),
                );
            const repairedPlanQuality = assessPlanQualityGate(request, plan, context);
            if (!repairedPlanQuality.ok) {
              throw new Error(
                `Architect repair failed after deterministic apply error: ${repairedPlanQuality.reasons.join(", ")}`,
              );
            }
            if (this.options.logger) {
              const planPath = await this.options.logger.writePhaseArtifact("architect", "plan", plan);
              await this.options.logger.log("plan_json", { phase: "architect", path: planPath });
              await this.options.logger.log("architect_repair_after_builder_apply_failure", {
                deterministic: true,
                reasons: repairedPlanQuality.reasons,
              });
            }
            attempts -= 1;
            builderNote =
              `Patch apply failed with deterministic error (${failure.error}). ` +
              `Use existing repository targets only (${plan.target_files.join(", ") || "none"}).`;
            continue;
          }
          if (!deterministicApplyFailure && attempts <= this.options.maxRetries) {
            builderNote = `Patch apply failed: ${failure.error}. Rollback ok=${failure.rollback.ok}. Fix the patch output and avoid disallowed paths.`;
            continue;
          }
          criticResult = {
            status: "FAIL",
            reasons: [`patch_apply_failed: ${failure.error}`],
            retryable: false,
            report: {
              status: "FAIL",
              reasons: [`patch_apply_failed: ${failure.error}`],
              suggested_fixes: ["Provide a corrected patch that applies cleanly."],
            },
          };
          break;
        }
        throw error;
      }
      builderResult = built;
      await logPhaseArtifact("builder", "output", {
        finalMessage: built.finalMessage,
        contextRequest: built.contextRequest ?? null,
        usage: built.usage ?? null,
      });
      if (this.options.logger) {
        await this.options.logger.log("builder_output", {
          length: built.finalMessage.content.length,
          context_request: Boolean(built.contextRequest),
        });
      }
      await logLaneSummary("builder", builderLaneId);
      if (built.contextRequest) {
        const contextRequest = built.contextRequest;
        if (refreshes < maxContextRefreshes) {
          refreshes += 1;
          attempts -= 1;
          if (this.options.logger) {
            await this.options.logger.log("context_refresh", {
              refresh: refreshes,
              queries: contextRequest.queries ?? [],
              files: contextRequest.files ?? [],
            });
          }
          await logPhaseArtifact("librarian", "input", {
            request,
            additional_queries: contextRequest.queries ?? [],
            preferred_files: contextRequest.files ?? [],
          });
          context = await this.runPhase("librarian", () =>
            this.options.contextAssembler.assemble(request, {
              additionalQueries: contextRequest.queries,
              preferredFiles: contextRequest.files,
              recentFiles: contextRequest.files,
            }),
          );
          await logPhaseArtifact("librarian", "output", context);
          await logPhaseArtifact("architect", "input", {
            request,
            context: buildSerializedContext(context),
          });
          plan = useFastPath
            ? buildFastPlan(context)
            : await this.runPhase("architect", () =>
                this.options.architectPlanner.plan(context, {
                  contextManager: this.options.contextManager,
                  laneId: architectLaneId,
                }),
              );
          if (this.options.logger) {
            const planPath = await this.options.logger.writePhaseArtifact("architect", "plan", plan);
            await this.options.logger.log("architect_output", {
              steps: plan.steps.length,
              target_files: plan.target_files.length,
            });
            await this.options.logger.log("plan_json", { phase: "architect", path: planPath });
          }
          await logPhaseArtifact("architect", "output", plan);
          continue;
        }
        criticResult = {
          status: "FAIL",
          reasons: ["context request limit reached"],
          retryable: false,
        };
        break;
      }
      if (built.usage) {
        await this.options.logger?.log("phase_usage", { phase: "builder", usage: built.usage });
      }

      const reviewer = this.options.architectPlanner as unknown as {
        reviewBuilderOutput?: (
          plan: Plan,
          builderOutput: string,
          context: ContextBundle,
          options?: Record<string, unknown>,
        ) => Promise<{ status: "PASS" | "RETRY"; feedback: string[]; reasons?: string[]; warnings?: string[] }>;
      };
      if (reviewer.reviewBuilderOutput) {
        await logPhaseArtifact("architect_review", "input", {
          plan,
          builder_output: built.finalMessage.content,
        });
        const review = await this.runPhase("architect_review", () =>
          reviewer.reviewBuilderOutput!(plan, built.finalMessage.content, context, {
            contextManager: this.options.contextManager,
            laneId: architectLaneId,
          }),
        );
        await logPhaseArtifact("architect_review", "output", review);
        if (this.options.logger) {
          await this.options.logger.log("architect_review", {
            status: review.status,
            reasons: review.reasons ?? [],
            feedback: review.feedback,
            warnings: review.warnings ?? [],
          });
        }
        if (review.status === "RETRY") {
          if (attempts <= this.options.maxRetries) {
            builderNote =
              review.feedback.length > 0
                ? `Architect review requested fixes: ${review.feedback.join("; ")}`
                : "Architect review requested changes. Provide a corrected output.";
            continue;
          }
          criticResult = {
            status: "FAIL",
            reasons: ["architect_review_failed", ...review.feedback],
            retryable: false,
          };
          break;
        }
        const builderSemantic = assessBuilderSemanticAlignment(request, plan, built.finalMessage.content);
        await logPhaseArtifact("architect_review", "semantic_guard", {
          assessment: builderSemantic,
          review_status: review.status,
          review_reasons: review.reasons ?? [],
        });
        if (this.options.logger) {
          await this.options.logger.log("architect_review_semantic_guard", {
            ok: builderSemantic.ok,
            score: builderSemantic.score,
            reasons: builderSemantic.reasons,
            matches: builderSemantic.matches,
            target_signals: builderSemantic.targetSignals,
            source: builderSemantic.source,
          });
        }
        if (!builderSemantic.ok) {
          if (attempts <= this.options.maxRetries) {
            builderNote =
              `Semantic guard requested fixes: ${builderSemantic.reasons.join("; ")}. ` +
              `Ensure output directly addresses request anchors (${builderSemantic.anchors.slice(0, 6).join(", ")}) ` +
              `and concrete plan targets (${plan.target_files.join(", ")}).`;
            continue;
          }
          criticResult = {
            status: "FAIL",
            reasons: ["architect_review_semantic_guard_failed", ...builderSemantic.reasons],
            retryable: false,
          };
          break;
        }
      }
      const touchedAfter = this.options.getTouchedFiles?.() ?? touchedBefore;
      const touchedBeforeSet = new Set(touchedBefore);
      const touchedDelta = touchedAfter.filter((file) => !touchedBeforeSet.has(file));
      const touchedFiles = touchedDelta.length ? touchedDelta : undefined;
      await logPhaseArtifact("critic", "input", {
        plan,
        builder_output: built.finalMessage.content,
        touched_files: touchedFiles ?? [],
      });
      let criticRefreshes = 0;
      while (true) {
        const criticAllowedPaths = Array.from(new Set([...(plan.target_files ?? [])]));
        criticResult = await this.runPhase("critic", () =>
          this.options.criticEvaluator.evaluate(plan, built.finalMessage.content, touchedFiles, {
            contextManager: this.options.contextManager,
            laneId: criticLaneId,
            allowedPaths: criticAllowedPaths,
            allowProtocolRequest: true,
          }),
        );
        if (criticResult.request && criticRefreshes < maxContextRefreshes) {
          const response = await this.options.contextAssembler.fulfillAgentRequest(
            criticResult.request,
          );
          await appendCriticHistory(formatCodaliResponse(response));
          if (this.options.logger) {
            await this.options.logger.log("critic_request_fulfilled", {
              request_id: criticResult.request.request_id,
              results: response.results.length,
              warnings: response.meta?.warnings ?? [],
            });
          }
          criticRefreshes += 1;
          continue;
        }
        break;
      }
      await logPhaseArtifact("critic", "output", criticResult);
      if (this.options.logger) {
        await this.options.logger.log("critic_output", {
          status: criticResult.status,
          guardrail: criticResult.report?.guardrail ?? criticResult.guardrail ?? null,
        });
      }
      this.emitStatus("done", `critic result: ${criticResult.status}`);
      await logLaneSummary("critic", criticLaneId);
      if (criticResult.status === "PASS") break;
      await appendArchitectHistory(formatCodaliResponse(buildCriticResponse(criticResult)));
      if (criticResult.retryable && attempts <= this.options.maxRetries) {
        builderNote = criticResult.reasons.length
          ? `Critic failed: ${criticResult.reasons.join("; ")}`
          : "Critic failed. Provide a corrected output.";
        continue;
      }
      if (!criticResult.retryable) break;
    }

    if (!builderResult || !criticResult) {
      throw new Error("SmartPipeline failed to produce results");
    }

    const preferences = context.preferences_detected ?? [];
    if (criticResult.status === "FAIL") {
      await this.options.memoryWriteback.persist({
        failures: attempts,
        maxRetries: this.options.maxRetries,
        lesson: criticResult.reasons.join("; "),
        preferences: preferences.length ? preferences : undefined,
      });
    } else if (preferences.length) {
      await this.options.memoryWriteback.persist({
        failures: 0,
        maxRetries: this.options.maxRetries,
        lesson: "",
        preferences,
      });
    }

    return { context, research: researchPhase, plan, builderResult, criticResult, attempts };
  }

  private async runPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this.emitStatus(this.phaseStatus(phase), `${phase}: start`);
    if (this.options.logger) {
      await this.options.logger.log("phase_start", { phase });
    }
    try {
      const result = await fn();
      if (this.options.logger) {
        await this.options.logger.log("phase_end", { phase, duration_ms: Date.now() - startedAt });
      }
      this.emitStatus("done", `${phase}: done`);
      return result;
    } catch (error) {
      if (this.options.logger) {
        await this.options.logger.log("phase_end", {
          phase,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.emitStatus("done", `${phase}: failed`);
      throw error;
    }
  }

  private emitStatus(phase: AgentStatusPhase, message?: string): void {
    this.options.onEvent?.({ type: "status", phase, message });
  }

  private phaseStatus(phase: string): AgentStatusPhase {
    if (phase === "builder") return "executing";
    if (phase === "critic") return "thinking";
    if (phase === "librarian" || phase === "architect") return "thinking";
    return "thinking";
  }
}
