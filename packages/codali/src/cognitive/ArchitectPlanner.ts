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

const buildContextNarrative = (context: ContextBundle): string => {
  if (context.serialized?.mode === "bundle_text") return context.serialized.content;
  return serializeContext(context, { mode: "bundle_text" }).content;
};

const buildUserMessage = (context: ContextBundle): ProviderMessage => ({
  role: "user",
  content: buildContextNarrative(context),
});

const normalizeStrings = (values: string[]): string[] =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));

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

const fallbackSteps = (context: ContextBundle): string[] => {
  const request = context.request?.trim();
  const steps = [
    "Review focus files and referenced context for the request.",
    "Apply minimal changes aligned to the request and constraints.",
    "Run verification steps if available.",
  ];
  if (request) {
    steps[0] = `Review focus files for the request: ${request}`;
  }
  return steps;
};

const fallbackPlan = (context: ContextBundle): Plan => ({
  steps: fallbackSteps(context),
  target_files: targetFilesFromContext(context),
  risk_assessment: "medium: fallback plan generated from context",
  verification: [],
});

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
    target_files: targetFiles && targetFiles.length > 0 ? targetFiles : targetFilesFromContext(context),
    risk_assessment: risk && risk.length > 0 ? risk : "medium: fallback plan generated from context",
    verification: verification ?? [],
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

const parsePlanDsl = (
  content: string,
  context: ContextBundle,
): { plan?: Plan; warnings: string[] } => {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return { warnings: ["architect_output_empty"] };

  const steps: string[] = [];
  const targets: string[] = [];
  const verification: string[] = [];
  let risk: string | undefined;
  let section: "steps" | "targets" | "verify" | "risk" | undefined;

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
      section = "steps";
      if (planMatch[1]) commitItem(steps, planMatch[1]);
      continue;
    }
    const targetsMatch = /^TARGETS\s*:\s*(.*)$/i.exec(line);
    if (targetsMatch) {
      section = "targets";
      if (targetsMatch[1]) commitItem(targets, targetsMatch[1]);
      continue;
    }
    const riskMatch = /^RISK\s*:\s*(.*)$/i.exec(line);
    if (riskMatch) {
      section = undefined;
      risk = riskMatch[1]?.trim() || risk;
      if (!risk) section = "risk";
      continue;
    }
    const verifyMatch = /^(VERIFY|VERIFICATION)\s*:\s*(.*)$/i.exec(line);
    if (verifyMatch) {
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

  if (steps.length === 0 && targets.length === 0 && !risk) {
    warnings.push("architect_output_not_dsl");
    return { warnings };
  }

  const plan: Plan = {
    steps: steps.length > 0 ? steps : fallbackSteps(context),
    target_files: targets.length > 0 ? targets : targetFilesFromContext(context),
    risk_assessment: risk && risk.length > 0 ? risk : "medium: fallback plan generated from context",
    verification,
  };
  return { plan, warnings };
};

const parsePlanOutput = (
  content: string,
  context: ContextBundle,
): { plan: Plan; warnings: string[]; parseError?: string } => {
  const dslResult = parsePlanDsl(content, context);
  if (dslResult.plan) return { plan: dslResult.plan, warnings: dslResult.warnings };
  const parsedResult = parseJsonLoose(content);
  const { plan, warnings } = coercePlan(parsedResult.parsed, context);
  return {
    plan,
    warnings: [...dslResult.warnings, ...warnings, "architect_output_used_json_fallback"],
    parseError: parsedResult.error,
  };
};

const parsePlanHint = (
  hint: string,
  context: ContextBundle,
): { plan?: Plan; warnings: string[]; parseError?: string } => {
  const dslResult = parsePlanDsl(hint, context);
  if (dslResult.plan) return { plan: dslResult.plan, warnings: dslResult.warnings };
  const parsedResult = parseJsonLoose(hint);
  if (parsedResult.parsed && typeof parsedResult.parsed === "object") {
    const { plan, warnings } = coercePlan(parsedResult.parsed, context);
    return { plan, warnings: [...dslResult.warnings, ...warnings], parseError: parsedResult.error };
  }
  return { warnings: [...dslResult.warnings, "plan_hint_not_parseable"], parseError: parsedResult.error };
};

const parseReviewDsl = (content: string): { status?: "PASS" | "RETRY"; feedback: string[]; warnings: string[] } => {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed) return { warnings: ["architect_review_empty"], feedback: [] };
  const lines = trimmed.split(/\r?\n/);
  let status: "PASS" | "RETRY" | undefined;
  const feedback: string[] = [];
  let inFeedback = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const statusMatch = /^STATUS:\s*(PASS|RETRY)/i.exec(line);
    if (statusMatch) {
      status = statusMatch[1].toUpperCase() as "PASS" | "RETRY";
      continue;
    }
    if (/^FEEDBACK\s*:/i.test(line)) {
      inFeedback = true;
      continue;
    }
    if (inFeedback) {
      const cleaned = line.replace(/^\s*[-*•]\s*/, "").trim();
      if (cleaned) feedback.push(cleaned);
    }
  }
  if (!status) warnings.push("architect_review_missing_status");
  return { status, feedback, warnings };
};

export interface ArchitectPlannerOptions {
  temperature?: number;
  logger?: RunLogger;
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  responseFormat?: ProviderResponseFormat;
  planHint?: string;
  validatePlanHint?: boolean;
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
  private validatePlanHint?: boolean;
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
    this.validatePlanHint = options.validatePlanHint;
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
      validatePlanHint?: boolean;
      stream?: boolean;
      onEvent?: (event: AgentEvent) => void;
    } = {},
  ): Promise<ArchitectPlanResult> {
    const contextManager = options.contextManager ?? this.contextManager;
    const laneId = options.laneId ?? this.laneId;
    const model = options.model ?? this.model;
    const planHint = options.planHint ?? this.planHint;
    const validatePlanHint = options.validatePlanHint ?? this.validatePlanHint;
    const stream = options.stream ?? this.stream;
    const onEvent = options.onEvent ?? this.onEvent;
    const requestedFormat: ProviderResponseFormat =
      options.responseFormat ?? this.responseFormat ?? { type: "gbnf", grammar: ARCHITECT_GBNF };
    const responseFormat: ProviderResponseFormat =
      requestedFormat.type === "gbnf" && !requestedFormat.grammar
        ? { type: "gbnf", grammar: ARCHITECT_GBNF }
        : requestedFormat;
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

    const systemPrompt = planHint
      ? [ARCHITECT_PROMPT, "PLAN HINT (must follow):", planHint].join("\n")
      : ARCHITECT_PROMPT;
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
    const { plan, warnings } = parsedPlan;
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
    if (request && this.logger) {
      await this.logger.log("architect_request_detected", {
        request_id: request.request_id,
        needs: request.needs.length,
      });
    }

    return { plan, request, raw: content, warnings };
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
    const requestedFormat: ProviderResponseFormat =
      options.responseFormat ?? this.responseFormat ?? { type: "gbnf", grammar: ARCHITECT_REVIEW_GBNF };
    const responseFormat: ProviderResponseFormat =
      requestedFormat.type === "gbnf" && !requestedFormat.grammar
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

    return { status, feedback: parsed.feedback, raw, warnings };
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
