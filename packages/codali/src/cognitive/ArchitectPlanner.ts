import type {
  AgentEvent,
  Provider,
  ProviderMessage,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type { ContextBundle, Plan } from "./Types.js";
import { serializeContext } from "./ContextSerializer.js";
import {
  ARCHITECT_GBNF,
  ARCHITECT_PROMPT,
  ARCHITECT_REVIEW_GBNF,
  ARCHITECT_REVIEW_PROMPT,
  ARCHITECT_VALIDATE_GBNF,
  ARCHITECT_VALIDATE_PROMPT,
} from "./Prompts.js";
import type { ContextManager } from "./ContextManager.js";
import { parseAgentRequest, type AgentRequest } from "../agents/AgentProtocol.js";

export const ARCHITECT_WARNING_NON_DSL = "architect_output_not_dsl";
export const ARCHITECT_WARNING_CONTAINS_THINK = "architect_output_contains_think";
export const ARCHITECT_WARNING_CONTAINS_FENCE = "architect_output_contains_fence";
export const ARCHITECT_WARNING_MISSING_REQUIRED_SECTIONS =
  "architect_output_missing_required_sections";
export const ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS =
  "architect_output_multiple_section_blocks";
export const ARCHITECT_WARNING_USED_JSON_FALLBACK = "architect_output_used_json_fallback";
export const ARCHITECT_WARNING_REPAIRED = "architect_output_repaired";

const buildContextNarrative = (context: ContextBundle): string => {
  if (context.serialized?.mode === "bundle_text" && context.serialized.audience === "librarian") {
    return context.serialized.content;
  }
  return serializeContext(context, { mode: "bundle_text", audience: "librarian" }).content;
};

const buildUserMessage = (context: ContextBundle): ProviderMessage => ({
  role: "user",
  content: buildContextNarrative(context),
});

const normalizeStrings = (values: string[]): string[] =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();

const REQUEST_FILE_PATTERN = /(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+/g;
const ENDPOINT_INTENT_PATTERN = /\b(endpoint|route|router|handler|api|health|healthz|status|ping)\b/i;
const DOC_PATH_PATTERN = /(^|\/)(docs?|openapi|specs?)\//i;
const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|test)\//i;
const FRONTEND_PATH_PATTERN = /(^|\/)(public|frontend|client)\//i;
const IMPLEMENTATION_FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "cs",
  "php",
  "rb",
  "kt",
  "swift",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
]);

const REQUEST_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "and",
  "or",
  "with",
  "create",
  "add",
  "introduce",
  "scaffold",
  "bootstrap",
  "build",
  "develop",
  "implement",
  "setup",
  "set",
  "up",
  "check",
  "system",
  "script",
  "file",
  "endpoint",
  "route",
  "handler",
  "api",
]);

const PROSE_RECOVERY_STOPWORDS = new Set([
  "think",
  "thinking",
  "okay",
  "alright",
  "sure",
  "assistant",
  "role",
  "content",
  "json",
  "markdown",
  "dsl",
  "plan",
  "targets",
  "verify",
  "risk",
  "response",
  "output",
]);

const parseRepoMapPaths = (repoMap?: string): string[] => {
  if (!repoMap) return [];
  const lines = repoMap
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.length > 0);
  if (lines.length <= 1) return [];
  const stack: string[] = [];
  const paths: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
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
  const repoMapPaths = parseRepoMapPaths(context.repo_map_raw ?? context.repo_map);
  return uniqueStrings(
    [...selection, ...files, ...snippets, ...symbols, ...ast, ...impact, ...search, ...repoMapPaths]
      .map((entry) => normalizePath(entry))
      .filter(Boolean),
  );
};

const isDocPath = (value: string): boolean =>
  DOC_PATH_PATTERN.test(normalizePath(value)) || /\.(md|mdx|txt|rst)$/i.test(value);

const isTestPath = (value: string): boolean =>
  TEST_PATH_PATTERN.test(normalizePath(value)) || /\.(test|spec)\.[^.]+$/i.test(value);

const isSourceCodePath = (value: string): boolean => {
  const normalized = normalizePath(value);
  if (!normalized) return false;
  if (isDocPath(normalized) || isTestPath(normalized)) return false;
  const ext = normalized.slice(normalized.lastIndexOf(".") + 1).toLowerCase();
  return IMPLEMENTATION_FILE_EXTENSIONS.has(ext);
};

const extractRequestTokens = (request: string): string[] =>
  request
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !REQUEST_TOKEN_STOPWORDS.has(token));

const extractRequestedPaths = (request: string): string[] =>
  uniqueStrings((request.match(REQUEST_FILE_PATTERN) ?? []).map((entry) => normalizePath(entry)));

const toPascalCase = (value: string): string =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join("");

const scoreEndpointTarget = (value: string): number => {
  const normalized = normalizePath(value).toLowerCase();
  let score = 0;
  if (!isSourceCodePath(normalized)) return -100;
  if (FRONTEND_PATH_PATTERN.test(normalized)) score -= 40;
  if (isTestPath(normalized)) score -= 30;
  if (/server\.[^.]+$/.test(normalized)) score += 60;
  if (/(^|\/)(api|routes?|router|handlers?|controllers?)\//.test(normalized)) score += 45;
  if (/health|status|ping/.test(normalized)) score += 20;
  return score;
};

const deriveFallbackTargetFiles = (context: ContextBundle): string[] => {
  const request = context.request ?? "";
  const requestPaths = extractRequestedPaths(request);
  if (requestPaths.length > 0) return requestPaths;

  const discoveredPaths = collectContextPaths(context);
  const baseTargets = targetFilesFromContext(context).map((entry) => normalizePath(entry));
  const nonPlaceholderTargets = baseTargets.filter((entry) => entry !== "unknown");

  if (ENDPOINT_INTENT_PATTERN.test(request)) {
    const endpointCandidates = discoveredPaths
      .map((entry) => ({ path: normalizePath(entry), score: scoreEndpointTarget(entry) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.path);
    if (endpointCandidates.length > 0) {
      return uniqueStrings(endpointCandidates.slice(0, 2));
    }
  }

  const baseCodeTargets = nonPlaceholderTargets.filter((entry) => isSourceCodePath(entry));
  if (baseCodeTargets.length > 0 && !baseCodeTargets.every((entry) => isDocPath(entry) || isTestPath(entry))) {
    return uniqueStrings(baseCodeTargets);
  }

  const discoveredCodeTargets = discoveredPaths.filter((entry) => isSourceCodePath(entry));
  if (discoveredCodeTargets.length > 0) {
    return uniqueStrings(discoveredCodeTargets).slice(0, 6);
  }

  const nonDocTargets = nonPlaceholderTargets.filter(
    (entry) => !isDocPath(entry) && !isTestPath(entry),
  );
  if (nonDocTargets.length > 0) return uniqueStrings(nonDocTargets);
  return ["unknown"];
};

const computeCreateTargets = (context: ContextBundle, targetFiles: string[]): string[] => {
  const existingPathSet = new Set(collectContextPaths(context).map((entry) => normalizePath(entry)));
  return targetFiles.filter((path) => {
    const normalized = normalizePath(path);
    return normalized !== "unknown" && !existingPathSet.has(normalized);
  });
};

const collectPlannerScopePaths = (context: ContextBundle): string[] => {
  const focus = (context.selection?.focus ?? []).map((entry) => normalizePath(entry)).filter(Boolean);
  const periphery = (context.selection?.periphery ?? []).map((entry) => normalizePath(entry)).filter(Boolean);
  return uniqueStrings([...focus, ...periphery]);
};

type PlanTargetScopeAssessment = {
  scopePaths: string[];
  createTargets: string[];
  invalidTargets: string[];
};

const assessPlanTargetScope = (
  context: ContextBundle,
  plan: Plan,
): PlanTargetScopeAssessment => {
  const scopePaths = collectPlannerScopePaths(context);
  const scopeSet = new Set(scopePaths.map((entry) => entry.toLowerCase()));
  const createTargets = uniqueStrings(
    (plan.create_files ?? [])
      .map((entry) => normalizePath(entry))
      .filter((entry) => entry.length > 0 && entry !== "unknown"),
  );
  if (scopePaths.length === 0) {
    return {
      scopePaths,
      createTargets,
      invalidTargets: [],
    };
  }
  const createSet = new Set(createTargets.map((entry) => entry.toLowerCase()));
  const invalidTargets = uniqueStrings(
    (plan.target_files ?? [])
      .map((entry) => normalizePath(entry))
      .filter((entry) => entry.length > 0 && entry !== "unknown")
      .filter((entry) => !scopeSet.has(entry.toLowerCase()) && !createSet.has(entry.toLowerCase())),
  );
  return {
    scopePaths,
    createTargets,
    invalidTargets,
  };
};

const applyTargetScopeGuard = (
  context: ContextBundle,
  plan: Plan,
  warnings: string[],
): { plan: Plan; warnings: string[] } => {
  const assessment = assessPlanTargetScope(context, plan);
  if (assessment.scopePaths.length === 0) {
    return {
      plan: {
        ...plan,
        target_files: uniqueStrings(
          (plan.target_files ?? [])
            .map((entry) => normalizePath(entry))
            .filter((entry) => entry.length > 0 && entry !== "unknown"),
        ),
        create_files: assessment.createTargets.length > 0 ? assessment.createTargets : undefined,
      },
      warnings: uniqueStrings(warnings),
    };
  }
  const nextWarnings = [...warnings];
  if (assessment.invalidTargets.length > 0) {
    nextWarnings.push(`plan_targets_outside_context:${assessment.invalidTargets.join(",")}`);
  }
  const invalidSet = new Set(assessment.invalidTargets.map((entry) => entry.toLowerCase()));
  const createSet = new Set(assessment.createTargets.map((entry) => entry.toLowerCase()));
  let nextTargets = uniqueStrings(
    (plan.target_files ?? [])
      .map((entry) => normalizePath(entry))
      .filter((entry) => entry.length > 0 && entry !== "unknown")
      .filter((entry) => !invalidSet.has(entry.toLowerCase()) || createSet.has(entry.toLowerCase())),
  );
  if (nextTargets.length === 0) {
    nextWarnings.push("plan_target_scope_empty_after_filter");
  }
  return {
    plan: {
      ...plan,
      target_files: nextTargets,
      create_files: assessment.createTargets.length > 0 ? assessment.createTargets : undefined,
    },
    warnings: uniqueStrings(nextWarnings),
  };
};

const compactWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const summarizeRequestSubject = (request?: string): string => {
  const compact = compactWhitespace(request ?? "");
  if (!compact) return "the requested change";
  const tokens = extractRequestTokens(compact);
  return tokens.length > 0 ? tokens.slice(0, 6).join(" ") : compact;
};

const pathBasename = (value: string): string => {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
};

const stepMentionsTarget = (step: string, targetPath: string): boolean => {
  const normalizedTarget = normalizePath(targetPath).toLowerCase();
  const basename = pathBasename(targetPath).toLowerCase();
  const stepLower = step.toLowerCase();
  if (normalizedTarget && stepLower.includes(normalizedTarget)) return true;
  if (basename && basename.length >= 3 && stepLower.includes(basename)) return true;
  return false;
};

const endpointPathPattern = /(^|\/)(api|routes?|router|handlers?|controllers?|server|health|status|ping)/i;

const buildTargetChangeStep = (
  context: ContextBundle,
  targetPath: string,
  options: { create: boolean },
): string => {
  const normalized = normalizePath(targetPath);
  const subject = summarizeRequestSubject(context.request);
  if (options.create) {
    return `Create ${normalized}: add the module/function structure for ${subject}, then wire imports/exports and integration points needed by dependent files.`;
  }
  if (isDocPath(normalized)) {
    return `Update ${normalized}: revise the relevant documentation sections for ${subject} and add any missing examples or usage notes.`;
  }
  if (isTestPath(normalized)) {
    return `Update ${normalized}: change existing assertions for ${subject} and add coverage for the new behaviors introduced by this request.`;
  }
  if (ENDPOINT_INTENT_PATTERN.test(context.request ?? "") || endpointPathPattern.test(normalized)) {
    return `Update ${normalized}: change route/handler behavior for ${subject} and add missing request validation or response payload helpers in this file.`;
  }
  if (FRONTEND_PATH_PATTERN.test(normalized) || /\.(html|css)$/i.test(normalized)) {
    return `Update ${normalized}: change rendering/styling behavior for ${subject} and add any missing UI helpers or selectors needed by this file.`;
  }
  return `Update ${normalized}: change existing implementation for ${subject} and add any missing helper functions/constants needed in this file.`;
};

const enrichPlanWithTargetChangeDetails = (
  context: ContextBundle,
  plan: Plan,
): { plan: Plan; warnings: string[] } => {
  const normalizedTargets = uniqueStrings(
    plan.target_files
      .map((value) => normalizePath(value))
      .filter((value) => value.length > 0 && value !== "unknown"),
  );
  if (normalizedTargets.length === 0) return { plan, warnings: [] };
  const existingPathSet = new Set(collectContextPaths(context).map((entry) => normalizePath(entry)));
  const createTargetSet = new Set(computeCreateTargets(context, normalizedTargets).map((entry) => normalizePath(entry)));
  const nextSteps = [...plan.steps];
  let added = 0;

  for (const target of normalizedTargets) {
    if (nextSteps.some((step) => stepMentionsTarget(step, target))) continue;
    const create = createTargetSet.has(target) || !existingPathSet.has(target);
    nextSteps.push(buildTargetChangeStep(context, target, { create }));
    added += 1;
  }

  if (added === 0) {
    return {
      plan: {
        ...plan,
        target_files: normalizedTargets,
      },
      warnings: [],
    };
  }

  return {
    plan: {
      ...plan,
      steps: nextSteps,
      target_files: normalizedTargets,
    },
    warnings: [`plan_missing_target_change_details:${added}`],
  };
};

const buildImplementationOutlineStep = (context: ContextBundle, targetFiles: string[]): string => {
  const request = context.request ?? "";
  const tokens = extractRequestTokens(request);
  const feature = toPascalCase(tokens.slice(0, 2).join(" ")) || "Feature";
  const primaryTarget = targetFiles.find((entry) => entry !== "unknown") ?? "target module";
  if (ENDPOINT_INTENT_PATTERN.test(request)) {
    const routeFn = `register${feature}Route`;
    const handlerFn = `handle${feature}Request`;
    const payloadFn = `build${feature}Payload`;
    return `Define method responsibilities in ${primaryTarget}: ${routeFn} wires the route, ${handlerFn} handles request/response flow, and ${payloadFn} builds the health/status payload.`;
  }
  const moduleName = `${feature}Module`;
  const parseFn = `parse${feature}Input`;
  const executeFn = `execute${feature}`;
  const validateFn = `validate${feature}State`;
  return `Define object/method responsibilities in ${primaryTarget}: ${moduleName} orchestrates logic, ${parseFn} parses input, ${validateFn} enforces constraints, and ${executeFn} performs the core behavior.`;
};

const splitLines = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  const semi = trimmed.split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
  if (semi.length > 1) return semi;
  return [trimmed];
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length ? normalizeStrings(strings) : undefined;
  }
  if (typeof value === "string") {
    const parts = splitLines(value);
    return parts.length ? normalizeStrings(parts) : undefined;
  }
  return undefined;
};

const toFileArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length ? normalizeStrings(strings) : undefined;
  }
  if (typeof value === "string") {
    const parts = value
      .split(/[\n,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length ? normalizeStrings(parts) : undefined;
  }
  return undefined;
};

const targetFilesFromContext = (context: ContextBundle): string[] => {
  const focusFiles = context.files
    ?.filter((entry) => entry.role === "focus")
    .map((entry) => entry.path)
    .filter((file): file is string => Boolean(file)) ?? [];
  if (focusFiles.length > 0) return uniqueStrings(focusFiles);
  const selectionFocus = context.selection?.focus ?? [];
  const selectionAll = context.selection?.all ?? [];
  const allFiles =
    context.files?.map((entry) => entry.path).filter((file): file is string => Boolean(file)) ?? [];
  const snippets =
    context.snippets?.map((snippet) => snippet.path).filter((file): file is string => Boolean(file)) ?? [];
  const symbols =
    context.symbols?.map((symbol) => symbol.path).filter((file): file is string => Boolean(file)) ?? [];
  const ast = context.ast?.map((node) => node.path).filter((file): file is string => Boolean(file)) ?? [];
  const impact =
    context.impact?.map((entry) => entry.file).filter((file): file is string => Boolean(file)) ?? [];
  const combined = uniqueStrings(
    normalizeStrings([...selectionFocus, ...selectionAll, ...allFiles, ...snippets, ...symbols, ...ast, ...impact]),
  );
  return combined.length > 0 ? combined : ["unknown"];
};

const fallbackVerification = (context: ContextBundle, targetFiles: string[], createTargets: string[]): string[] => {
  const checks: string[] = [];
  if (createTargets.length > 0) {
    checks.push(`Confirm new file wiring and imports for: ${createTargets.join(", ")}.`);
  }
  if (ENDPOINT_INTENT_PATTERN.test(context.request ?? "")) {
    checks.push("Add/update endpoint tests for status code and response payload contract.");
    checks.push("Run a manual endpoint check to confirm healthy response semantics.");
  }
  checks.push("Run the repository tests that cover all target files.");
  return uniqueStrings(checks);
};

const fallbackSteps = (context: ContextBundle): string[] => {
  const request = context.request?.trim();
  const targetFiles = deriveFallbackTargetFiles(context);
  const createTargets = computeCreateTargets(context, targetFiles);
  const outlineStep = buildImplementationOutlineStep(context, targetFiles);
  const steps = [
    "Review focus files and referenced context for the request.",
    "Map request requirements to concrete implementation targets and interfaces.",
    "Apply changes aligned to the request and constraints.",
    "Run verification steps and summarize results.",
  ];
  if (request) {
    steps[0] = `Review focus files for the request: ${request}`;
  }
  if (createTargets.length > 0) {
    steps[1] = `Create missing implementation files: ${createTargets.join(", ")} and define module boundaries.`;
  }
  steps.splice(2, 0, outlineStep);
  return steps;
};

const fallbackPlan = (context: ContextBundle): Plan => {
  const targets = deriveFallbackTargetFiles(context);
  const createTargets = computeCreateTargets(context, targets);
  return {
    steps: fallbackSteps(context),
    target_files: targets,
    create_files: createTargets.length > 0 ? createTargets : undefined,
    risk_assessment: (() => {
      if (createTargets.length > 0) {
        return "medium: introduces new files and integration points";
      }
      if (ENDPOINT_INTENT_PATTERN.test(context.request ?? "")) {
        return "medium: endpoint behavior and contract changes";
      }
      return "medium: fallback plan generated from context";
    })(),
    verification: fallbackVerification(context, targets, createTargets),
  };
};

const coercePlan = (
  parsed: unknown,
  context: ContextBundle,
): { plan: Plan; warnings: string[] } => {
  const warnings: string[] = [];
  if (!parsed || typeof parsed !== "object") {
    warnings.push("architect_output_not_object");
    return { plan: fallbackPlan(context), warnings };
  }
  const record = parsed as Record<string, unknown>;
  const steps =
    toStringArray(record.steps) ??
    toStringArray(record.plan) ??
    toStringArray(record.todo) ??
    undefined;
  const targetFiles =
    toFileArray(record.target_files) ??
    toFileArray(record.filesLikelyTouched) ??
    toFileArray(record.files) ??
    undefined;
  const createFiles =
    toFileArray(record.create_files) ??
    toFileArray(record.createFiles) ??
    undefined;
  const riskAssessment =
    typeof record.risk_assessment === "string"
      ? record.risk_assessment
      : typeof record.risk === "string"
        ? record.risk
        : undefined;
  const risks = Array.isArray(record.risks)
    ? record.risks.filter((item) => typeof item === "string")
    : undefined;
  const risk = riskAssessment ?? (risks && risks.length ? risks.join("; ") : undefined);
  const verification =
    toStringArray(record.verification) ??
    toStringArray(record.tests) ??
    toStringArray(record.validate) ??
    undefined;

  const plan: Plan = {
    steps: steps && steps.length > 0 ? steps : fallbackSteps(context),
    target_files: targetFiles && targetFiles.length > 0 ? targetFiles : deriveFallbackTargetFiles(context),
    create_files: createFiles && createFiles.length > 0 ? createFiles : undefined,
    risk_assessment: risk && risk.length > 0 ? risk : "medium: fallback plan generated from context",
    verification:
      verification && verification.length > 0
        ? verification
        : (() => {
            const targets = targetFiles && targetFiles.length > 0
              ? targetFiles
              : deriveFallbackTargetFiles(context);
            const createTargets = computeCreateTargets(context, targets);
            return fallbackVerification(context, targets, createTargets);
          })(),
  };

  if (!steps || steps.length === 0) warnings.push("plan_missing_steps");
  if (!targetFiles || targetFiles.length === 0) warnings.push("plan_missing_target_files");
  if (!risk || risk.length === 0) warnings.push("plan_missing_risk_assessment");
  if (!verification) warnings.push("plan_missing_verification");
  return { plan, warnings };
};

const parseJsonLoose = (content: string): { parsed?: unknown; error?: string } => {
  const trimmed = content.trim();
  if (!trimmed) return { error: "empty" };
  const tryParse = (input: string): { parsed?: unknown } => {
    try {
      return { parsed: JSON.parse(input) };
    } catch {
      return {};
    }
  };
  const direct = tryParse(trimmed);
  if (direct.parsed !== undefined) {
    if (typeof direct.parsed === "string") {
      const nested = tryParse(direct.parsed);
      if (nested.parsed !== undefined) return nested;
    }
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced.parsed !== undefined) return sliced;
  }
  return { error: "invalid_json" };
};

const ARCHITECT_THINK_PATTERN = /<\/?think\b[^>]*>/i;
const ARCHITECT_FENCE_PATTERN = /```/;
const ARCHITECT_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const ARCHITECT_FENCE_BLOCK_PATTERN = /```[^\n]*\n?([\s\S]*?)```/g;
const ARCHITECT_PLAN_HEADER_PATTERN = /^\s*PLAN\s*:/im;
const ARCHITECT_TARGETS_HEADER_PATTERN = /^\s*TARGETS\s*:/im;
const ARCHITECT_RISK_HEADER_PATTERN = /^\s*RISK\s*:/im;
const ARCHITECT_VERIFY_HEADER_PATTERN = /^\s*(VERIFY|VERIFICATION)\s*:/im;

const countHeaderMatches = (pattern: RegExp, content: string): number => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let count = 0;
  while (globalPattern.exec(content)) count += 1;
  return count;
};

const detectDslHeaders = (content: string): {
  plan: boolean;
  targets: boolean;
  risk: boolean;
  verify: boolean;
} => ({
  plan: ARCHITECT_PLAN_HEADER_PATTERN.test(content),
  targets: ARCHITECT_TARGETS_HEADER_PATTERN.test(content),
  risk: ARCHITECT_RISK_HEADER_PATTERN.test(content),
  verify: ARCHITECT_VERIFY_HEADER_PATTERN.test(content),
});

const detectDslHeaderCounts = (content: string): {
  plan: number;
  targets: number;
  risk: number;
  verify: number;
} => ({
  plan: countHeaderMatches(ARCHITECT_PLAN_HEADER_PATTERN, content),
  targets: countHeaderMatches(ARCHITECT_TARGETS_HEADER_PATTERN, content),
  risk: countHeaderMatches(ARCHITECT_RISK_HEADER_PATTERN, content),
  verify: countHeaderMatches(ARCHITECT_VERIFY_HEADER_PATTERN, content),
});

const normalizeArchitectDslCandidate = (content: string): string => {
  const withoutThinkBlocks = content.replace(ARCHITECT_THINK_BLOCK_PATTERN, "\n");
  const withoutThinkTags = withoutThinkBlocks.replace(ARCHITECT_THINK_PATTERN, "");
  const unwrappedFences = withoutThinkTags.replace(
    ARCHITECT_FENCE_BLOCK_PATTERN,
    (_full, inner: string) => inner ?? "",
  );
  return unwrappedFences.trim();
};

const classifyArchitectOutput = (content: string): string[] => {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return ["architect_output_empty"];
  // Treat <think> wrappers as ignorable noise; they should not trigger protocol warnings.
  if (ARCHITECT_FENCE_PATTERN.test(trimmed)) {
    warnings.push(ARCHITECT_WARNING_CONTAINS_FENCE, ARCHITECT_WARNING_NON_DSL);
  }
  const headers = detectDslHeaders(trimmed);
  const headerCounts = detectDslHeaderCounts(trimmed);
  const duplicateSections = Object.values(headerCounts).some((count) => count > 1);
  if (duplicateSections) {
    warnings.push(ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS, ARCHITECT_WARNING_NON_DSL);
  }
  const headerCount = [headers.plan, headers.targets, headers.risk, headers.verify].filter(Boolean).length;
  if (headerCount > 0 && headerCount < 4) {
    warnings.push(ARCHITECT_WARNING_MISSING_REQUIRED_SECTIONS, ARCHITECT_WARNING_NON_DSL);
  } else if (headerCount === 0) {
    const parsed = parseJsonLoose(trimmed);
    const record =
      parsed.parsed && typeof parsed.parsed === "object" && !Array.isArray(parsed.parsed)
        ? (parsed.parsed as Record<string, unknown>)
        : undefined;
    const hasPlanShape = Boolean(
      record &&
      (Object.prototype.hasOwnProperty.call(record, "steps") ||
        Object.prototype.hasOwnProperty.call(record, "target_files") ||
        Object.prototype.hasOwnProperty.call(record, "risk_assessment") ||
        Object.prototype.hasOwnProperty.call(record, "verification") ||
        Object.prototype.hasOwnProperty.call(record, "plan")),
    );
    if (!hasPlanShape) warnings.push(ARCHITECT_WARNING_NON_DSL);
  }
  return uniqueStrings(warnings);
};

const withRepairWarnings = (
  warnings: string[],
  reason:
    | "dsl_missing_fields"
    | "json_fallback"
    | "classifier"
    | "wrapper_noise"
    | "duplicate_sections",
): string[] => {
  const repaired = [...warnings];
  if (!repaired.includes(ARCHITECT_WARNING_REPAIRED)) {
    repaired.push(ARCHITECT_WARNING_REPAIRED);
  }
  repaired.push(`architect_output_repair_reason:${reason}`);
  return uniqueStrings(repaired);
};

const REQUIRED_MISSING_PLAN_WARNINGS = new Set([
  "plan_missing_steps",
  "plan_missing_target_files",
  "plan_missing_risk_assessment",
  "plan_missing_verification",
]);

const parsePlanDsl = (
  content: string,
  context: ContextBundle,
): { plan?: Plan; warnings: string[] } => {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return { warnings: ["architect_output_empty"] };

  const steps: string[] = [];
  const targets: string[] = [];
  const createFiles: string[] = [];
  const verification: string[] = [];
  let risk: string | undefined;
  let section: "steps" | "targets" | "create" | "verify" | "risk" | undefined;
  const headerCounts = {
    plan: 0,
    targets: 0,
    create: 0,
    risk: 0,
    verify: 0,
  };
  let duplicateSectionDetected = false;

  const commitItem = (items: string[], line: string) => {
    const cleaned = line.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
    if (cleaned) items.push(cleaned);
  };

  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const planMatch = /^PLAN\s*:\s*(.*)$/i.exec(line);
    if (planMatch) {
      headerCounts.plan += 1;
      if (headerCounts.plan > 1) {
        duplicateSectionDetected = true;
        section = undefined;
        continue;
      }
      section = "steps";
      if (planMatch[1]) commitItem(steps, planMatch[1]);
      continue;
    }
    const targetsMatch = /^TARGETS\s*:\s*(.*)$/i.exec(line);
    if (targetsMatch) {
      headerCounts.targets += 1;
      if (headerCounts.targets > 1) {
        duplicateSectionDetected = true;
        section = undefined;
        continue;
      }
      section = "targets";
      if (targetsMatch[1]) commitItem(targets, targetsMatch[1]);
      continue;
    }
    const createMatch = /^CREATE(?:_FILES?| FILES?)\s*:\s*(.*)$/i.exec(line);
    if (createMatch) {
      headerCounts.create += 1;
      if (headerCounts.create > 1) {
        duplicateSectionDetected = true;
        section = undefined;
        continue;
      }
      section = "create";
      if (createMatch[1]) commitItem(createFiles, createMatch[1]);
      continue;
    }
    const riskMatch = /^RISK\s*:\s*(.*)$/i.exec(line);
    if (riskMatch) {
      headerCounts.risk += 1;
      if (headerCounts.risk > 1) {
        duplicateSectionDetected = true;
        section = undefined;
        continue;
      }
      section = undefined;
      risk = riskMatch[1]?.trim() || risk;
      if (!risk) section = "risk";
      continue;
    }
    const verifyMatch = /^(VERIFY|VERIFICATION)\s*:\s*(.*)$/i.exec(line);
    if (verifyMatch) {
      headerCounts.verify += 1;
      if (headerCounts.verify > 1) {
        duplicateSectionDetected = true;
        section = undefined;
        continue;
      }
      section = "verify";
      if (verifyMatch[2]) commitItem(verification, verifyMatch[2]);
      continue;
    }

    if (section === "steps") {
      commitItem(steps, line);
      continue;
    }
    if (section === "targets") {
      commitItem(targets, line);
      continue;
    }
    if (section === "create") {
      commitItem(createFiles, line);
      continue;
    }
    if (section === "verify") {
      commitItem(verification, line);
      continue;
    }
    if (section === "risk") {
      risk = risk ? `${risk} ${line}` : line;
    }
  }

  if (steps.length === 0) warnings.push("plan_missing_steps");
  if (targets.length === 0) warnings.push("plan_missing_target_files");
  if (!risk) warnings.push("plan_missing_risk_assessment");
  if (verification.length === 0) warnings.push("plan_missing_verification");
  if (duplicateSectionDetected) {
    warnings.push(ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS, ARCHITECT_WARNING_NON_DSL);
  }

  if (steps.length === 0 && targets.length === 0 && !risk) {
    warnings.push(ARCHITECT_WARNING_NON_DSL);
    return { warnings };
  }

  const plan: Plan = {
    steps: steps.length > 0 ? steps : fallbackSteps(context),
    target_files: targets.length > 0 ? targets : deriveFallbackTargetFiles(context),
    create_files: createFiles.length > 0 ? uniqueStrings(createFiles.map((entry) => normalizePath(entry))) : undefined,
    risk_assessment: risk && risk.length > 0 ? risk : "medium: fallback plan generated from context",
    verification:
      verification.length > 0
        ? verification
        : (() => {
            const resolvedTargets = targets.length > 0 ? targets : deriveFallbackTargetFiles(context);
            const createTargets = computeCreateTargets(context, resolvedTargets);
            return fallbackVerification(context, resolvedTargets, createTargets);
          })(),
  };
  return { plan, warnings };
};

const parsePlanOutput = (
  content: string,
  context: ContextBundle,
): { plan: Plan; warnings: string[]; parseError?: string } => {
  const classifiedWarnings = classifyArchitectOutput(content);
  const normalizedContent = normalizeArchitectDslCandidate(content);
  const dslResult = parsePlanDsl(normalizedContent, context);
  if (dslResult.plan) {
    const enriched = enrichPlanWithTargetChangeDetails(context, dslResult.plan);
    const scoped = applyTargetScopeGuard(
      context,
      enriched.plan,
      uniqueStrings([...classifiedWarnings, ...dslResult.warnings, ...enriched.warnings]),
    );
    let warnings = scoped.warnings;
    const hasMissingFields = warnings.some((warning) => REQUIRED_MISSING_PLAN_WARNINGS.has(warning));
    const hasNonDslWarning = warnings.includes(ARCHITECT_WARNING_NON_DSL);
    const hasDuplicateSections = warnings.includes(ARCHITECT_WARNING_MULTIPLE_SECTION_BLOCKS);
    const hasHardProtocolIssue = warnings.includes(ARCHITECT_WARNING_MISSING_REQUIRED_SECTIONS);
    if (hasMissingFields) {
      warnings = withRepairWarnings(warnings, "dsl_missing_fields");
    } else if (hasNonDslWarning) {
      if (hasHardProtocolIssue) {
        warnings = withRepairWarnings(warnings, "classifier");
      } else if (hasDuplicateSections) {
        warnings = withRepairWarnings(
          warnings.filter((warning) => warning !== ARCHITECT_WARNING_NON_DSL),
          "duplicate_sections",
        );
      } else {
        warnings = withRepairWarnings(
          warnings.filter((warning) => warning !== ARCHITECT_WARNING_NON_DSL),
          "wrapper_noise",
        );
      }
    }
    return {
      plan: scoped.plan,
      warnings,
    };
  }
  const parsedResult = parseJsonLoose(normalizedContent);
  const { plan, warnings } = coercePlan(parsedResult.parsed, context);
  const enriched = enrichPlanWithTargetChangeDetails(context, plan);
  const scoped = applyTargetScopeGuard(context, enriched.plan, [...warnings, ...enriched.warnings]);
  const repairedWarnings = withRepairWarnings(
    [
      ...classifiedWarnings,
      ...dslResult.warnings,
      ...scoped.warnings,
      ARCHITECT_WARNING_USED_JSON_FALLBACK,
    ],
    "json_fallback",
  );
  return {
    plan: scoped.plan,
    warnings: repairedWarnings,
    parseError: parsedResult.error,
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const extractStringField = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

const isPlanLikeObject = (record: Record<string, unknown>): boolean => {
  const planCandidate = record.plan;
  if (planCandidate && typeof planCandidate === "object" && !Array.isArray(planCandidate)) {
    return true;
  }
  return (
    Object.prototype.hasOwnProperty.call(record, "steps") ||
    Object.prototype.hasOwnProperty.call(record, "target_files") ||
    Object.prototype.hasOwnProperty.call(record, "risk_assessment") ||
    Object.prototype.hasOwnProperty.call(record, "verification")
  );
};

const buildRequestId = (prefix: string): string => `${prefix}-${Date.now()}`;

const sanitizeRecoveryTokens = (tokens: string[]): string[] =>
  tokens
    .map((token) => token.replace(/^[\/_-]+|[\/_-]+$/g, ""))
    .filter((token) => token.length >= 3)
    .filter((token) => !REQUEST_TOKEN_STOPWORDS.has(token))
    .filter((token) => !PROSE_RECOVERY_STOPWORDS.has(token))
    .filter((token) => /[a-z]/.test(token));

const buildProseRecoveryQuery = (content: string, request: string): string => {
  const requestTokens = sanitizeRecoveryTokens(extractRequestTokens(request)).slice(0, 6);
  const proseTokens = sanitizeRecoveryTokens(extractRequestTokens(content))
    .filter((token) => !requestTokens.includes(token))
    .slice(0, 6);
  const combined = uniqueStrings([...requestTokens, ...proseTokens]).slice(0, 8);
  if (combined.length > 0) return combined.join(" ");
  const compactRequest = compactWhitespace(request);
  if (compactRequest.length > 0) return compactRequest;
  return "implementation context";
};

const shouldAdaptProseNonDslOutput = (content: string): boolean => {
  const normalized = normalizeArchitectDslCandidate(content);
  if (!normalized) return false;
  const headers = detectDslHeaders(normalized);
  if (headers.plan || headers.targets || headers.risk || headers.verify) return false;
  const parsed = parseJsonLoose(normalized);
  if (parsed.parsed !== undefined) return false;
  if (normalized.length < 24) return false;
  const sentenceSignals =
    /[.!?]/.test(normalized) ||
    /\b(i|we|you|please|should|need|implement|update|add|create|develop|explain)\b/i.test(normalized);
  return sentenceSignals;
};

const adaptNonDslPayloadToRequest = (
  content: string,
  context: ContextBundle,
): AgentRequest | undefined => {
  const parsed = parseJsonLoose(content);
  const record = asRecord(parsed.parsed);
  if (record && isPlanLikeObject(record)) return undefined;

  if (record) {
    const query = extractStringField(record, ["query", "search_query", "question", "prompt"]);
    if (query) {
      return {
        version: "v1",
        role: "architect",
        request_id: buildRequestId("architect-adapt-query"),
        needs: [{ type: "docdex.search", query, limit: 8 }],
        context: {
          summary:
            "Architect returned a query payload instead of DSL. Fetch focused retrieval context and retry planning.",
        },
      };
    }

    const file = extractStringField(record, ["file", "path", "target_file", "target_path"]);
    if (file) {
      const normalizedFile = normalizePath(file);
      const symbol = extractStringField(record, ["symbol", "symbol_id", "symbol_name"]);
      const needs: AgentRequest["needs"] = [{ type: "file.read", path: normalizedFile }];
      if (symbol) {
        needs.push({
          type: "docdex.search",
          query: `${normalizedFile} ${symbol}`,
          limit: 8,
        });
      }
      return {
        version: "v1",
        role: "architect",
        request_id: buildRequestId("architect-adapt-file"),
        needs,
        context: {
          summary:
            "Architect returned file/symbol metadata instead of DSL. Load file context and related symbol evidence before retrying.",
        },
      };
    }

    const symbolOnly = extractStringField(record, ["symbol", "symbol_id", "symbol_name"]);
    if (symbolOnly) {
      return {
        version: "v1",
        role: "architect",
        request_id: buildRequestId("architect-adapt-symbol"),
        needs: [{ type: "docdex.search", query: `${context.request} ${symbolOnly}`, limit: 8 }],
        context: {
          summary:
            "Architect returned symbol metadata without a DSL plan. Retrieve symbol-related context and retry planning.",
        },
      };
    }
  }

  if (shouldAdaptProseNonDslOutput(content)) {
    const query = buildProseRecoveryQuery(content, context.request ?? "");
    return {
      version: "v1",
      role: "architect",
      request_id: buildRequestId("architect-adapt-prose"),
      needs: [
        { type: "docdex.search", query, limit: 8 },
        { type: "file.list", root: "src", pattern: "*" },
        { type: "file.list", root: "docs", pattern: "*" },
      ],
      context: {
        summary:
          "Architect returned prose/non-DSL output. Retrieve focused implementation context and retry with strict structured output.",
      },
    };
  }

  return undefined;
};

const parsePlanHint = (
  hint: string,
  context: ContextBundle,
): { plan?: Plan; warnings: string[]; parseError?: string } => {
  const dslResult = parsePlanDsl(hint, context);
  if (dslResult.plan) {
    const enriched = enrichPlanWithTargetChangeDetails(context, dslResult.plan);
    const scoped = applyTargetScopeGuard(
      context,
      enriched.plan,
      [...dslResult.warnings, ...enriched.warnings],
    );
    return {
      plan: scoped.plan,
      warnings: scoped.warnings,
    };
  }
  const parsedResult = parseJsonLoose(hint);
  if (parsedResult.parsed && typeof parsedResult.parsed === "object") {
    const { plan, warnings } = coercePlan(parsedResult.parsed, context);
    const enriched = enrichPlanWithTargetChangeDetails(context, plan);
    const scoped = applyTargetScopeGuard(context, enriched.plan, [...warnings, ...enriched.warnings]);
    return {
      plan: scoped.plan,
      warnings: [...dslResult.warnings, ...scoped.warnings],
      parseError: parsedResult.error,
    };
  }
  return { warnings: [...dslResult.warnings, "plan_hint_not_parseable"], parseError: parsedResult.error };
};

const parsePlanHintForValidation = (
  hint: string,
  context: ContextBundle,
): { plan?: Plan; warnings: string[]; parseError?: string } => {
  const parsedResult = parseJsonLoose(hint);
  if (parsedResult.parsed && typeof parsedResult.parsed === "object") {
    const { plan, warnings } = coercePlan(parsedResult.parsed, context);
    const enriched = enrichPlanWithTargetChangeDetails(context, plan);
    const scopeAssessment = assessPlanTargetScope(context, enriched.plan);
    const scopeWarnings =
      scopeAssessment.invalidTargets.length > 0
        ? [`plan_targets_outside_context:${scopeAssessment.invalidTargets.join(",")}`]
        : [];
    return {
      plan: enriched.plan,
      warnings: [...warnings, ...enriched.warnings, ...scopeWarnings],
      parseError: parsedResult.error,
    };
  }
  const dslResult = parsePlanDsl(hint, context);
  if (dslResult.plan) {
    const enriched = enrichPlanWithTargetChangeDetails(context, dslResult.plan);
    const scopeAssessment = assessPlanTargetScope(context, enriched.plan);
    const scopeWarnings =
      scopeAssessment.invalidTargets.length > 0
        ? [`plan_targets_outside_context:${scopeAssessment.invalidTargets.join(",")}`]
        : [];
    return {
      plan: enriched.plan,
      warnings: [...dslResult.warnings, ...enriched.warnings, ...scopeWarnings],
    };
  }
  return { warnings: [...dslResult.warnings, "plan_hint_not_parseable"], parseError: parsedResult.error };
};

const PLAN_HINT_BLOCKING_WARNING_PREFIXES = ["plan_missing_steps", "plan_missing_target_files", "plan_missing_risk_assessment"] as const;

const PLAN_HINT_PLACEHOLDER_TARGET_PATTERNS = [/^unknown$/i, /^path\/to\//i, /^<.+>$/];

const validatePlanHintPlan = (
  plan: Plan,
  warnings: string[],
  context: ContextBundle,
): {
  issues: string[];
  blockingWarnings: string[];
} => {
  const issues: string[] = [];
  const normalizedTargets = uniqueStrings(plan.target_files.map((value) => normalizePath(value)).filter(Boolean));
  if (plan.steps.length === 0) issues.push("plan_hint_missing_steps");
  if (normalizedTargets.length === 0) issues.push("plan_hint_missing_targets");
  if (!plan.risk_assessment.trim()) issues.push("plan_hint_missing_risk");
  const invalidTargets = normalizedTargets.filter((target) =>
    PLAN_HINT_PLACEHOLDER_TARGET_PATTERNS.some((pattern) => pattern.test(target)),
  );
  if (invalidTargets.length > 0) {
    issues.push(`plan_hint_invalid_targets:${invalidTargets.join(",")}`);
  }
  const scopeAssessment = assessPlanTargetScope(context, plan);
  if (scopeAssessment.invalidTargets.length > 0) {
    issues.push(`plan_hint_targets_outside_context:${scopeAssessment.invalidTargets.join(",")}`);
  }
  const blockingWarnings = warnings.filter((warning) =>
    PLAN_HINT_BLOCKING_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix)),
  );
  if (blockingWarnings.length > 0) {
    issues.push("plan_hint_missing_required_fields");
  }
  return { issues: uniqueStrings(issues), blockingWarnings };
};

export class PlanHintValidationError extends Error {
  readonly name = "PlanHintValidationError";
  readonly code = "plan_hint_validation_failed";
  readonly warnings: string[];
  readonly issues: string[];
  readonly parseError?: string;

  constructor(input: { message: string; warnings: string[]; issues: string[]; parseError?: string }) {
    super(input.message);
    this.warnings = input.warnings;
    this.issues = input.issues;
    this.parseError = input.parseError;
  }
}

const parseReviewDsl = (
  content: string,
): { status?: "PASS" | "RETRY"; feedback: string[]; reasons: string[]; warnings: string[] } => {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return { warnings: ["architect_review_empty"], feedback: [], reasons: [] };
  const lines = trimmed.split(/\r?\n/);
  let status: "PASS" | "RETRY" | undefined;
  const feedback: string[] = [];
  const reasons: string[] = [];
  let section: "feedback" | "reasons" | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const statusMatch = /^STATUS:\s*(PASS|RETRY)/i.exec(line);
    if (statusMatch) {
      status = statusMatch[1].toUpperCase() as "PASS" | "RETRY";
      continue;
    }
    if (/^REASONS\s*:/i.test(line)) {
      section = "reasons";
      continue;
    }
    if (/^FEEDBACK\s*:/i.test(line)) {
      section = "feedback";
      continue;
    }
    const cleaned = line.replace(/^\s*[-*•]\s*/, "").trim();
    if (!cleaned) continue;
    if (section === "reasons") {
      reasons.push(cleaned);
      continue;
    }
    if (section === "feedback") {
      feedback.push(cleaned);
    }
  }
  if (!status) warnings.push("architect_review_missing_status");
  if (status === "RETRY" && feedback.length === 0) {
    warnings.push("architect_review_retry_missing_feedback");
  }
  if (reasons.length === 0) {
    warnings.push("architect_review_missing_reasons");
  }
  return { status, feedback, reasons, warnings };
};

export interface ArchitectPlannerOptions {
  temperature?: number;
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  responseFormat?: ProviderResponseFormat;
  planHint?: string;
  instructionHint?: string;
  validatePlanHint?: boolean;
  validateOnly?: boolean;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

export interface ArchitectPlanResult {
  plan: Plan;
  request?: AgentRequest;
  raw: string;
  warnings: string[];
}

export interface ArchitectReviewResult {
  status: "PASS" | "RETRY";
  feedback: string[];
  reasons: string[];
  raw: string;
  warnings: string[];
}

export class ArchitectPlanner {
  private temperature?: number;
  private logger?: RunLogger;
  private contextManager?: ContextManager;
  private laneId?: string;
  private model?: string;
  private responseFormat?: ProviderResponseFormat;
  private planHint?: string;
  private instructionHint?: string;
  private validatePlanHint?: boolean;
  private validateOnly?: boolean;
  private stream?: boolean;
  private onEvent?: (event: AgentEvent) => void;

  constructor(private provider: Provider, options: ArchitectPlannerOptions = {}) {
    this.temperature = options.temperature;
    this.logger = options.logger;
    this.contextManager = options.contextManager;
    this.laneId = options.laneId;
    this.model = options.model;
    this.responseFormat = options.responseFormat;
    this.planHint = options.planHint;
    this.instructionHint = options.instructionHint;
    this.validatePlanHint = options.validatePlanHint;
    this.validateOnly = options.validateOnly;
    this.stream = options.stream;
    this.onEvent = options.onEvent;
  }

  async plan(
    context: ContextBundle,
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      responseFormat?: ProviderResponseFormat;
      planHint?: string;
      instructionHint?: string;
      stream?: boolean;
      onEvent?: (event: AgentEvent) => void;
    } = {},
  ): Promise<Plan> {
    const result = await this.planWithRequest(context, options);
    return result.plan;
  }

  async planWithRequest(
    context: ContextBundle,
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      responseFormat?: ProviderResponseFormat;
      planHint?: string;
      instructionHint?: string;
      validatePlanHint?: boolean;
      validateOnly?: boolean;
      stream?: boolean;
      onEvent?: (event: AgentEvent) => void;
    } = {},
  ): Promise<ArchitectPlanResult> {
    const hasPlanHintOverride = Object.prototype.hasOwnProperty.call(options, "planHint");
    const hasInstructionHintOverride = Object.prototype.hasOwnProperty.call(
      options,
      "instructionHint",
    );
    const contextManager = options.contextManager ?? this.contextManager;
    const laneId = options.laneId ?? this.laneId;
    const model = options.model ?? this.model;
    const planHint = hasPlanHintOverride ? options.planHint : this.planHint;
    const instructionHint = hasInstructionHintOverride
      ? options.instructionHint
      : this.instructionHint;
    const validatePlanHint = options.validatePlanHint ?? this.validatePlanHint;
    const validateOnly = options.validateOnly ?? this.validateOnly;
    const stream = options.stream ?? this.stream;
    const onEvent = options.onEvent ?? this.onEvent;
    const requestedFormat = options.responseFormat ?? this.responseFormat;
    const responseFormat: ProviderResponseFormat | undefined =
      requestedFormat?.type === "gbnf" && !requestedFormat.grammar
        ? { type: "gbnf", grammar: ARCHITECT_GBNF }
        : requestedFormat;
    if (validateOnly && planHint) {
      const hintParsed = parsePlanHintForValidation(planHint, context);
      if (!hintParsed.plan) {
        throw new PlanHintValidationError({
          message: "Plan hint validation failed: plan hint is not parseable.",
          warnings: hintParsed.warnings,
          issues: ["plan_hint_not_parseable"],
          parseError: hintParsed.parseError,
        });
      }
      const validation = validatePlanHintPlan(hintParsed.plan, hintParsed.warnings, context);
      if (validation.issues.length > 0) {
        throw new PlanHintValidationError({
          message: "Plan hint validation failed: required fields or targets are invalid.",
          warnings: hintParsed.warnings,
          issues: validation.issues,
          parseError: hintParsed.parseError,
        });
      }
      if (this.logger) {
        await this.logger.log("architect_plan_hint_validated", {
          mode: "validate_only",
          steps: hintParsed.plan.steps.length,
          target_files: hintParsed.plan.target_files.length,
          warnings: hintParsed.warnings,
        });
      }
      return {
        plan: hintParsed.plan,
        raw: planHint,
        warnings: [],
      };
    }
    if (planHint) {
      const hintParsed = parsePlanHint(planHint, context);
      if (hintParsed.plan) {
        if (hintParsed.warnings.length && this.logger) {
          await this.logger.log("architect_plan_hint_normalized", {
            warnings: hintParsed.warnings,
            parseError: hintParsed.parseError,
          });
        }
        if (this.logger) {
          await this.logger.log("architect_plan_hint_used", {
            hasWarnings: hintParsed.warnings.length > 0,
            validated: !!validatePlanHint,
          });
        }
        if (validatePlanHint) {
          return this.validatePlanWithProvider(hintParsed.plan, context, {
            contextManager,
            laneId,
            model,
            stream,
            onEvent,
          });
        }
        return {
          plan: hintParsed.plan,
          raw: planHint,
          warnings: hintParsed.warnings,
        };
      }
    }

    const promptSections: string[] = [ARCHITECT_PROMPT];
    if (instructionHint?.trim()) {
      promptSections.push("ADDITIONAL ARCHITECT INSTRUCTIONS:");
      promptSections.push(instructionHint.trim());
    }
    if (planHint) {
      promptSections.push("PLAN HINT (must follow):");
      promptSections.push(planHint);
    }
    const systemPrompt = promptSections.join("\n");
    const systemMessage: ProviderMessage = { role: "system", content: systemPrompt };
    const userMessage = buildUserMessage(context);
    const history =
      contextManager && laneId
        ? await contextManager.prepare(laneId, {
            systemPrompt: systemMessage.content,
            bundle: userMessage.content,
            model,
          })
        : [];
    let response;
    try {
      onEvent?.({ type: "status", phase: "thinking", message: "architect" });
      if (this.logger) {
        await this.logger.log("provider_request", {
          provider: this.provider.name,
          model,
          messages: [systemMessage, ...history, userMessage],
          responseFormat,
          temperature: this.temperature,
          stream: stream ?? false,
        });
      }
      response = await this.provider.generate({
        messages: [
          systemMessage,
          ...history,
          userMessage,
        ],
        responseFormat,
        temperature: this.temperature,
        stream,
        onEvent,
      });
      onEvent?.({ type: "status", phase: "done", message: "architect" });
    } catch (error) {
      onEvent?.({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (response.usage && this.logger) {
      await this.logger.log("phase_usage", { phase: "architect", usage: response.usage });
    }

    const content = response.message.content?.trim() ?? "";
    const parsedPlan = parsePlanOutput(content, context);
    const { plan } = parsedPlan;
    const warnings = [...parsedPlan.warnings];
    if (warnings.length && this.logger) {
      await this.logger.log("architect_plan_normalized", {
        warnings,
        parseError: parsedPlan.parseError,
      });
    }

    if (contextManager && laneId) {
      await contextManager.append(laneId, userMessage, { role: "architect", model });
      await contextManager.append(laneId, response.message, {
        role: "architect",
        model,
        tokens: response.usage?.totalTokens,
      });
    }

    let request: AgentRequest | undefined;
    try {
      request = parseAgentRequest(content);
    } catch {
      request = undefined;
    }
    if (!request) {
      request = adaptNonDslPayloadToRequest(content, context);
      if (request) {
        warnings.push("architect_output_adapted_to_request");
      }
    }
    if (request && this.logger) {
      await this.logger.log("architect_request_detected", {
        request_id: request.request_id,
        needs: request.needs.length,
      });
    }

    return { plan, request, raw: content, warnings: uniqueStrings(warnings) };
  }

  async reviewBuilderOutput(
    plan: Plan,
    builderOutput: string,
    context: ContextBundle,
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      responseFormat?: ProviderResponseFormat;
      stream?: boolean;
      onEvent?: (event: AgentEvent) => void;
    } = {},
  ): Promise<ArchitectReviewResult> {
    const contextManager = options.contextManager ?? this.contextManager;
    const laneId = options.laneId ?? this.laneId;
    const model = options.model ?? this.model;
    const stream = options.stream ?? this.stream;
    const onEvent = options.onEvent ?? this.onEvent;
    const requestedFormat = options.responseFormat ?? this.responseFormat;
    const responseFormat: ProviderResponseFormat | undefined =
      requestedFormat?.type === "gbnf" && !requestedFormat.grammar
        ? { type: "gbnf", grammar: ARCHITECT_REVIEW_GBNF }
        : requestedFormat;

    const systemMessage: ProviderMessage = { role: "system", content: ARCHITECT_REVIEW_PROMPT };
    const contextContent = buildContextNarrative(context);
    const userMessage: ProviderMessage = {
      role: "user",
      content: [
        "PLAN (read-only):",
        JSON.stringify(plan, null, 2),
        "",
        "BUILDER OUTPUT:",
        builderOutput,
        "",
        "CONTEXT (read-only):",
        contextContent,
      ].join("\n"),
    };

    const history =
      contextManager && laneId
        ? await contextManager.prepare(laneId, {
            systemPrompt: systemMessage.content,
            bundle: userMessage.content,
            model,
          })
        : [];

    onEvent?.({ type: "status", phase: "thinking", message: "architect_review" });
    if (this.logger) {
      await this.logger.log("provider_request", {
        provider: this.provider.name,
        model,
        messages: [systemMessage, ...history, userMessage],
        responseFormat,
        temperature: this.temperature,
        stream: stream ?? false,
      });
    }
    const response = await this.provider.generate({
      messages: [systemMessage, ...history, userMessage],
      responseFormat,
      temperature: this.temperature,
      stream,
      onEvent,
    });
    onEvent?.({ type: "status", phase: "done", message: "architect_review" });

    if (response.usage && this.logger) {
      await this.logger.log("phase_usage", { phase: "architect_review", usage: response.usage });
    }

    const raw = response.message.content?.trim() ?? "";
    const parsed = parseReviewDsl(raw);
    const status = parsed.status ?? "RETRY";
    const warnings = parsed.warnings;

    if (warnings.length && this.logger) {
      await this.logger.log("architect_review_normalized", {
        warnings,
        status,
      });
    }

    if (contextManager && laneId) {
      await contextManager.append(laneId, userMessage, { role: "architect", model });
      await contextManager.append(laneId, response.message, {
        role: "architect",
        model,
        tokens: response.usage?.totalTokens,
      });
    }

    return { status, feedback: parsed.feedback, reasons: parsed.reasons, raw, warnings };
  }

  async validatePlanWithProvider(
    plan: Plan,
    context: ContextBundle,
    options: {
      contextManager?: ContextManager;
      laneId?: string;
      model?: string;
      stream?: boolean;
      onEvent?: (event: AgentEvent) => void;
    } = {},
  ): Promise<ArchitectPlanResult> {
    const contextManager = options.contextManager;
    const laneId = options.laneId;
    const model = options.model ?? this.model;
    const stream = options.stream;
    const onEvent = options.onEvent;

    const systemMessage: ProviderMessage = { role: "system", content: ARCHITECT_VALIDATE_PROMPT };
    const contextContent = buildContextNarrative(context);
    const userMessage: ProviderMessage = {
      role: "user",
      content: [
        "PROPOSED PLAN:",
        JSON.stringify(plan, null, 2),
        "",
        "CONTEXT:",
        contextContent,
      ].join("\n"),
    };

    const history =
      contextManager && laneId
        ? await contextManager.prepare(laneId, {
            systemPrompt: systemMessage.content,
            bundle: userMessage.content,
            model,
          })
        : [];

    onEvent?.({ type: "status", phase: "thinking", message: "architect_validate" });
    if (this.logger) {
      await this.logger.log("provider_request", {
        provider: this.provider.name,
        model,
        messages: [systemMessage, ...history, userMessage],
        responseFormat: { type: "gbnf", grammar: ARCHITECT_VALIDATE_GBNF },
        temperature: this.temperature,
        stream: stream ?? false,
      });
    }
    const response = await this.provider.generate({
      messages: [systemMessage, ...history, userMessage],
      responseFormat: { type: "gbnf", grammar: ARCHITECT_VALIDATE_GBNF },
      temperature: this.temperature,
      stream,
      onEvent,
    });
    onEvent?.({ type: "status", phase: "done", message: "architect_validate" });

    if (response.usage && this.logger) {
      await this.logger.log("phase_usage", { phase: "architect_validate", usage: response.usage });
    }

    const content = response.message.content?.trim() ?? "";
    const parsedPlan = parsePlanOutput(content, context);
    const { plan: validatedPlan, warnings } = parsedPlan;

    if (warnings.length && this.logger) {
      await this.logger.log("architect_plan_normalized", {
        warnings,
        parseError: parsedPlan.parseError,
        source: "validation",
      });
    }

    if (contextManager && laneId) {
      await contextManager.append(laneId, userMessage, { role: "architect", model });
      await contextManager.append(laneId, response.message, {
        role: "architect",
        model,
        tokens: response.usage?.totalTokens,
      });
    }

    return { plan: validatedPlan, raw: content, warnings };
  }
}
