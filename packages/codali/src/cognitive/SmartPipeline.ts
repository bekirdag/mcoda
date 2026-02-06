import type {
  AgentEvent,
  AgentStatusPhase,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import { createHash } from "node:crypto";
import type { ContextBundle, Plan, CriticResult, LaneScope } from "./Types.js";
import { ContextAssembler } from "./ContextAssembler.js";
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
  getTouchedFiles?: () => string[];
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
  onEvent?: (event: AgentEvent) => void;
}

export interface SmartPipelineResult {
  context: ContextBundle;
  plan: Plan;
  builderResult: BuilderRunResult;
  criticResult: CriticResult;
  attempts: number;
}

const ARCHITECT_NON_DSL_WARNING = ARCHITECT_WARNING_NON_DSL;

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

type PlanQualityGate = {
  ok: boolean;
  reasons: string[];
  concreteTargets: string[];
  verification: VerificationQuality;
  alignmentScore: number;
  alignmentKeywords: string[];
  semanticScore: number;
  semanticAnchors: string[];
  semanticMatches: string[];
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

const assessPlanQualityGate = (request: string, plan: Plan): PlanQualityGate => {
  const requestAnchors = extractRequestAnchors(request);
  const concreteTargets = uniqueStrings((plan.target_files ?? []).filter((target) => isConcreteTargetPath(target)));
  const reasons: string[] = [];
  if (concreteTargets.length === 0) reasons.push("missing_concrete_targets");
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
    alignmentScore: alignment.score,
    alignmentKeywords: alignment.keywords,
    semanticScore: semanticCoverage.score,
    semanticAnchors: semanticCoverage.anchors,
    semanticMatches: semanticCoverage.matches,
  };
};

const buildQualityDegradedPlan = (request: string, context: ContextBundle, priorPlan: Plan): Plan => {
  const fallbackTargets = uniqueStrings(
    [
      ...(priorPlan.target_files ?? []).filter((target) => isConcreteTargetPath(target)),
      ...((context.selection?.focus ?? []).filter((target) => isConcreteTargetPath(target))),
      ...((context.selection?.all ?? []).filter((target) => isConcreteTargetPath(target))),
      ...((context.files ?? []).map((entry) => entry.path).filter((target) => isConcreteTargetPath(target))),
    ].filter(Boolean),
  );
  const targets = fallbackTargets.length > 0 ? fallbackTargets.slice(0, 6) : (priorPlan.target_files ?? []);
  const normalizedRequest = request.trim() || "the requested change";
  const verify = [
    `Run unit/integration tests that cover: ${targets.join(", ")}.`,
    `Perform a manual verification for "${normalizedRequest}" against ${targets[0] ?? "the affected target"}.`,
  ];
  const steps = [
    ...((priorPlan.steps ?? []).filter((step) => step.trim().length > 0)),
    `Finalize implementation details for ${targets.join(", ")} with request-specific behavior for "${normalizedRequest}".`,
  ];
  return {
    steps: uniqueStrings(steps),
    target_files: targets.length > 0 ? targets : (priorPlan.target_files ?? []),
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
      sanitized.serialized = serializeContext(sanitized, { mode });
      return sanitized;
    };
    const buildSerializedContext = (bundle: ContextBundle) => {
      const sanitized = sanitizeContextBundleForOutput(bundle);
      return serializeContext(sanitized, { mode: "bundle_text" });
    };
    const formatCodaliResponse = (response: CodaliResponse): string =>
      ["CODALI_RESPONSE v1", JSON.stringify(response, null, 2)].join("\n");
    const emitAgentRequestRecoveryStatus = (reason: string): void => {
      this.emitStatus("thinking", `architect: AGENT_REQUEST recovery (${reason})`);
    };
    const appendArchitectHistory = async (content: string): Promise<void> => {
      if (!this.options.contextManager || !architectLaneId) return;
      await this.options.contextManager.append(
        architectLaneId,
        { role: "system", content },
        { role: "architect" },
      );
    };
    const appendCriticHistory = async (content: string): Promise<void> => {
      if (!this.options.contextManager || !criticLaneId) return;
      await this.options.contextManager.append(
        criticLaneId,
        { role: "system", content },
        { role: "critic" },
      );
    };
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
    const useFastPath = this.options.fastPath?.(request) ?? false;
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
      const architectContext = options.contextOverride ?? context;
      await logPhaseArtifact("architect", "input", {
        pass,
        request,
        context: buildSerializedContext(architectContext),
        plan_hint: options.planHint ?? null,
        instruction_hint: options.instructionHint ?? null,
        validate_only: options.validateOnly ?? false,
      });
      if (planner.planWithRequest) {
        try {
          return await this.runPhase("architect", () =>
            planner.planWithRequest!(architectContext, {
                contextManager: this.options.contextManager,
                laneId: architectLaneId,
                planHint: options.planHint,
                instructionHint: options.instructionHint,
                validateOnly: options.validateOnly ?? false,
                responseFormat: options.responseFormat,
              }),
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
        planner.plan(architectContext, {
          contextManager: this.options.contextManager,
          laneId: architectLaneId,
          planHint: options.planHint,
          instructionHint: options.instructionHint,
          responseFormat: options.responseFormat,
        }),
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
      const maxPasses = 3;
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
      let requestRecoveryCount = 0;
      let previousRequestFingerprint: string | undefined;
      while (pass <= maxPasses) {
        const strictRetryPass = strictRetryTriggered && pass === 2;
        const recoveryPass = pass === maxPasses;
        const hintParts: string[] = [];
        if (pass > 1) hintParts.push(reflectionHint);
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
        const qualityGate = assessPlanQualityGate(request, result.plan);
        const structuralGrounding = assessStructuralGrounding(passContext, result.plan);
        const targetDrift = assessTargetDrift(previousConcreteTargets, qualityGate.concreteTargets);
        const nonDsl = isArchitectNonDsl(warnings);
        if (result.request) {
          if (nonDsl && pass === 1) {
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
              planHint: undefined,
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
          if (pass >= maxPasses || requestRecoveryCount >= maxPasses) {
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
          pass += 1;
          continue;
        }
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
            planHint: undefined,
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
        if (nonDsl && pass === 1) {
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
          if (pass < maxPasses) {
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
          if (pass < maxPasses && !structuralRecoveryTriggered) {
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
          if (pass < maxPasses) {
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
        if (fallbackGenericAssessment.fallback_or_generic && !fallbackRecoveryTriggered && pass < maxPasses) {
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
        if ((lowAlignment || endpointMissingBackend) && pass <= maxPasses) {
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
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
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
          if (pass < maxPasses && !driftRecoveryTriggered) {
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
            });
          }
          if (pass < maxPasses) {
            const recovery = buildFallbackRecoveryRequest(request, context, pass);
            emitAgentRequestRecoveryStatus("quality_gate");
            const response = await this.options.contextAssembler.fulfillAgentRequest(recovery.requestPayload);
            await appendArchitectHistory(formatCodaliResponse(response));
            await logPhaseArtifact("architect", "output", {
              request_id: recovery.requestPayload.request_id,
              response,
              source: "quality_gate_recovery",
              quality_gate: qualityGate,
            });
            await logPhaseArtifact("librarian", "input", {
              request,
              reason: "architect_quality_gate",
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
            previousPlanHash = undefined;
            previousConcreteTargets = qualityGate.concreteTargets;
            pass += 1;
            continue;
          }
          warnings.push("architect_degraded_quality_gate");
          const degradedPlan = buildQualityDegradedPlan(request, context, result.plan);
          lastPlan = { ...result, plan: degradedPlan, warnings: uniqueStrings(warnings) };
          if (this.options.logger) {
            await this.options.logger.log("architect_degraded", {
              pass,
              reason: "quality_gate_failed_after_retries",
              warnings: uniqueStrings(warnings),
              quality_gate: qualityGate,
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
        if (repeatedOutput && !alternateStrategyUsed && pass < maxPasses) {
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
        pass += 1;
      }
      if (!lastPlan) {
        throw new Error("Architect failed to produce a plan");
      }
      plan = lastPlan.plan;
      const finalPlanQuality = assessPlanQualityGate(request, plan);
      if (!finalPlanQuality.ok) {
        const degradedPlan = buildQualityDegradedPlan(request, context, plan);
        const degradedQuality = assessPlanQualityGate(request, degradedPlan);
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
            degraded_ok: degradedQuality.ok,
          });
        }
        await logPhaseArtifact("architect", "output", {
          source: "quality_gate_degrade",
          plan_before: plan,
          quality_before: finalPlanQuality,
          plan_after: degradedPlan,
          quality_after: degradedQuality,
        });
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

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      const note = builderNote;
      builderNote = undefined;
      const touchedBefore = this.options.getTouchedFiles?.() ?? [];
      const builderContext = buildSerializedContext(context);
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
          if (attempts <= this.options.maxRetries) {
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

    return { context, plan, builderResult, criticResult, attempts };
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
