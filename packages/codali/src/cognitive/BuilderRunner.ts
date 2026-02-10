import type {
  AgentEvent,
  Provider,
  ProviderMessage,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import type { ToolContext } from "../tools/ToolTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import { Runner, type RunnerResult } from "../runtime/Runner.js";
import type { ContextBundle, ContextRequest, Plan } from "./Types.js";
import {
  buildBuilderPrompt,
  BUILDER_PATCH_GBNF_FILE_WRITES,
  BUILDER_PATCH_GBNF_SEARCH_REPLACE,
} from "./Prompts.js";
import { serializeContext } from "./ContextSerializer.js";
import {
  parsePatchOutput,
  FILES_ARRAY_EMPTY_ERROR,
  FILES_ARRAY_MISSING_ERROR,
  FILES_ARRAY_TYPE_ERROR,
  PATCHES_ARRAY_EMPTY_ERROR,
  PATCHES_ARRAY_MISSING_ERROR,
  PATCHES_ARRAY_TYPE_ERROR,
  type PatchAction,
  type PatchFormat,
  type PatchPayload,
} from "./BuilderOutputParser.js";
import { PatchApplier } from "./PatchApplier.js";
import type { ContextManager } from "./ContextManager.js";
import type { PatchInterpreterClient } from "./PatchInterpreter.js";

export interface BuilderRunResult extends RunnerResult {
  contextRequest?: ContextRequest;
  touchedFiles?: string[];
}

export interface PatchApplyFailure {
  source: string;
  error: string;
  patches: PatchAction[];
  rollback: { attempted: boolean; ok: boolean; error?: string };
  rawOutput: string;
}

export class PatchApplyError extends Error {
  readonly details: PatchApplyFailure;

  constructor(details: PatchApplyFailure) {
    super(`Patch apply failed (${details.source}): ${details.error}`);
    this.details = details;
  }
}

export interface BuilderRunnerOptions {
  provider: Provider;
  tools: ToolRegistry;
  context: ToolContext;
  maxSteps: number;
  maxToolCalls: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  responseFormat?: ProviderResponseFormat;
  logger?: RunLogger;
  mode?: "tool_calls" | "patch_json" | "freeform";
  patchFormat?: PatchFormat;
  patchApplier?: PatchApplier;
  interpreter?: PatchInterpreterClient;
  fallbackToInterpreter?: boolean;
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onToken?: (token: string) => void;
  streamFlushMs?: number;
}

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values));

const PROSE_PATCH_INTENT_PATTERN = /\b(add|update|modify|replace|insert|create|remove|delete|change|refactor|rename)\b/i;

const looksLikeTargetedProsePatchIntent = (content: string, plan: Plan): boolean => {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 40) return false;
  if (looksLikeJsonPatchCandidate(trimmed)) return false;
  if (!PROSE_PATCH_INTENT_PATTERN.test(trimmed)) return false;
  const normalized = trimmed.replace(/\s+/g, " ").toLowerCase();
  const targetPaths = uniqueStrings(
    [...(plan.target_files ?? []), ...(plan.create_files ?? [])]
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length >= 3),
  );
  if (targetPaths.length === 0) return false;
  return targetPaths.some((target) => normalized.includes(target));
};

const looksLikeJsonPatchCandidate = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (!/"patches"\s*:|"files"\s*:/.test(trimmed)) return false;
  if (/```/i.test(trimmed)) {
    const embedded = parseEmbeddedJsonObject(trimmed);
    if (!embedded) return false;
    return (
      Object.prototype.hasOwnProperty.call(embedded, "patches")
      || Object.prototype.hasOwnProperty.call(embedded, "files")
    );
  }
  return true;
};

// Keep parse non-recoverable list explicit. Empty arrays are now retryable once via schema repair.
const NON_RECOVERABLE_PATCH_PARSE_PATTERNS: string[] = [];

const isNonRecoverablePatchParseError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return NON_RECOVERABLE_PATCH_PARSE_PATTERNS.some((pattern) => normalized.includes(pattern));
};

const isSchemaDefinitionError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes(PATCHES_ARRAY_MISSING_ERROR.toLowerCase()) ||
    normalized.includes(PATCHES_ARRAY_TYPE_ERROR.toLowerCase()) ||
    normalized.includes(FILES_ARRAY_MISSING_ERROR.toLowerCase()) ||
    normalized.includes(FILES_ARRAY_TYPE_ERROR.toLowerCase()) ||
    normalized.includes("patch payload must include patches array") ||
    normalized.includes("patch payload must include files array")
  );
};

const isInterpreterParseRetryCandidate = (message: string): boolean => {
  if (isNonRecoverablePatchParseError(message)) return false;
  const normalized = message.toLowerCase();
  if (isSchemaDefinitionError(message)) return false;
  if (normalized.includes("patch entry must be an object")) return false;
  if (normalized.includes("patch file entry must be an object")) return false;
  if (normalized.includes("patch action must be")) return false;
  if (normalized.includes("patch field")) return false;
  if (normalized.includes("patch output is empty")) return false;
  if (normalized.includes("placeholder")) return false;
  if (normalized.includes("delete action without delete intent")) return false;
  return true;
};

const shouldRetrySchemaRepair = (message: string): boolean => {
  if (isNonRecoverablePatchParseError(message)) return false;
  const normalized = message.toLowerCase();
  if (
    normalized.includes("enoent")
    || normalized.includes("no such file or directory")
    || normalized.includes("disallowed files")
    || normalized.includes("outside architect plan targets")
    || normalized.includes("search block not found")
    || normalized.includes("read-only")
  ) {
    return false;
  }
  return true;
};

const RETRYABLE_PATCH_APPLY_PATTERNS = [
  "patch output used placeholder file paths",
  "patch contains placeholder replace blocks",
  "patch contains placeholder create content",
  PATCHES_ARRAY_EMPTY_ERROR.toLowerCase(),
  FILES_ARRAY_EMPTY_ERROR.toLowerCase(),
];

const NON_RETRYABLE_PATCH_APPLY_PATTERNS = [
  "enoent",
  "no such file or directory",
  "disallowed files",
  "delete action without delete intent",
  "read-only",
  "outside architect plan targets",
  "search block not found",
];

const shouldRetrySchemaRepairFromPatchApplyError = (error: PatchApplyError): boolean => {
  const message = (error.details.error ?? error.message ?? "").toLowerCase();
  if (!message) return false;
  if (NON_RETRYABLE_PATCH_APPLY_PATTERNS.some((pattern) => message.includes(pattern))) return false;
  if (isSchemaDefinitionError(message)) return true;
  return RETRYABLE_PATCH_APPLY_PATTERNS.some((pattern) => message.includes(pattern));
};

const isSearchBlockNotFoundError = (message: string): boolean =>
  message.toLowerCase().includes("search block not found");

const PATCH_PLACEHOLDER_PATTERN = /^(?:\.\.\.|<[^>]+>|todo|tbd|fixme|placeholder)$/i;

const hasMeaningfulPatchText = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (PATCH_PLACEHOLDER_PATTERN.test(trimmed)) return false;
  if (trimmed.length < 3) return false;
  return true;
};

const planAllowsDeleteAction = (plan: Plan): boolean => {
  const corpus = [
    ...(plan.steps ?? []),
    plan.risk_assessment ?? "",
    ...(plan.verification ?? []),
  ].join(" ");
  return /\b(delete|remove|drop|cleanup|clean up|retire|deprecat|prune)\b/i.test(corpus);
};

const validatePatchPayloadQuality = (
  patches: PatchAction[],
  options: { allowDelete: boolean },
): string | undefined => {
  for (const patch of patches) {
    if (patch.action === "replace") {
      if (!hasMeaningfulPatchText(patch.search_block) || !hasMeaningfulPatchText(patch.replace_block)) {
        return "Patch contains placeholder replace blocks";
      }
      continue;
    }
    if (patch.action === "create") {
      if (!hasMeaningfulPatchText(patch.content)) {
        return "Patch contains placeholder create content";
      }
      continue;
    }
    if (patch.action === "delete" && !options.allowDelete) {
      return "Patch contains delete action without delete intent in plan";
    }
  }
  return undefined;
};

const parseEmbeddedJsonObject = (content: string): Record<string, unknown> | undefined => {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const candidate = content.slice(start, end + 1).trim();
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore invalid embedded JSON
  }
  return undefined;
};

const parseContextRequestRecord = (
  parsed: Record<string, unknown>,
): ContextRequest | undefined => {
  const needsContext =
    parsed.needs_context === true ||
    parsed.request_context === true ||
    parsed.context_request === true ||
    parsed.type === "needs_context";
  if (!needsContext) return undefined;
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.map((entry) => String(entry)).filter(Boolean)
    : undefined;
  const files = Array.isArray(parsed.files)
    ? parsed.files.map((entry) => String(entry)).filter(Boolean)
    : undefined;
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  return { reason, queries, files };
};

const parseContextRequest = (
  content: string,
  mode: "tool_calls" | "patch_json" | "freeform",
): ContextRequest | undefined => {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return parseContextRequestRecord(parsed);
  } catch {
    // ignore invalid JSON
  }

  // In strict patch-json mode, only pure JSON context requests are accepted.
  // Mixed prose + JSON should fail patch parsing and trigger deterministic recovery.
  if (mode === "patch_json") {
    if (!trimmed.startsWith("```")) return undefined;
    const embedded = parseEmbeddedJsonObject(trimmed);
    if (!embedded) return undefined;
    return parseContextRequestRecord(embedded);
  }

  const embedded = parseEmbeddedJsonObject(trimmed);
  if (embedded) {
    const fromEmbedded = parseContextRequestRecord(embedded);
    if (fromEmbedded) return fromEmbedded;
  }
  if (/^needs_context$/i.test(trimmed)) {
    return { reason: "needs_context" };
  }
  return undefined;
};

export class BuilderRunner {
  private options: BuilderRunnerOptions;

  constructor(options: BuilderRunnerOptions) {
    this.options = options;
  }

  setProvider(
    provider: Provider,
    options: {
      model?: string;
      temperature?: number;
      responseFormat?: ProviderResponseFormat;
      mode?: "tool_calls" | "patch_json" | "freeform";
    } = {},
  ): void {
    this.options = {
      ...this.options,
      provider,
      model: options.model ?? this.options.model,
      temperature: options.temperature ?? this.options.temperature,
      responseFormat: options.responseFormat ?? this.options.responseFormat,
      mode: options.mode ?? this.options.mode,
    };
  }

  private isToolSupportError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("does not support tools") ||
      normalized.includes("tools are not supported") ||
      normalized.includes("tool is not supported") ||
      (normalized.includes("tool") && normalized.includes("not supported"))
    );
  }

  async run(
    plan: Plan,
    contextBundle: ContextBundle,
    options: { contextManager?: ContextManager; laneId?: string; model?: string; note?: string } = {},
  ): Promise<BuilderRunResult> {
    let mode = this.options.mode ?? "tool_calls";
    const patchFormat = this.options.patchFormat ?? "search_replace";
    const emitPatchStatus = (message?: string) => {
      this.options.onEvent?.({ type: "status", phase: "patching", message });
    };
    const contextContent =
      contextBundle.serialized?.mode === "bundle_text" &&
      contextBundle.serialized.audience === "builder"
        ? contextBundle.serialized.content
        : serializeContext(contextBundle, { mode: "bundle_text", audience: "builder" }).content;
    const buildSystemMessage = (modeOverride: typeof mode): ProviderMessage => ({
      role: "system",
      content: buildBuilderPrompt(modeOverride, patchFormat),
    });
    const planTargets = Array.isArray(plan.target_files) ? plan.target_files.filter(Boolean) : [];
    const planCreateTargets = Array.isArray(plan.create_files) ? plan.create_files.filter(Boolean) : [];
    const bundlePaths = (contextBundle.files ?? []).map((entry) => entry.path).filter(Boolean);
    const normalizePath = (value: string) =>
      value.replace(/\\/g, "/").replace(/^\.?\//, "");
    const bundleReadOnly = (contextBundle.read_only_paths ?? []).map(normalizePath).filter(Boolean);
    const readOnlyPaths = bundleReadOnly;
    const looksLikePlaceholderPath = (value: string) =>
      value.startsWith("path/to/") || value.includes("<") || value.includes("...") || value.startsWith("your/");
    const isReadOnlyPath = (value: string) => {
      const normalized = normalizePath(value);
      return readOnlyPaths.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
    };
    const bundleAllow = (contextBundle.allow_write_paths ?? [])
      .map(normalizePath)
      .filter(Boolean)
      .filter((path) => path !== "unknown")
      .filter((path) => !isReadOnlyPath(path));
    const normalizedPlanTargets = uniqueStrings(
      [...planTargets, ...planCreateTargets]
        .map(normalizePath)
        .filter(Boolean)
        .filter((path) => path !== "unknown")
        .filter((path) => !isReadOnlyPath(path))
        .filter((path) => !looksLikePlaceholderPath(path)),
    );
    const fallbackAllow = [...normalizedPlanTargets, ...bundlePaths]
      .map(normalizePath)
      .filter(Boolean)
      .filter((path) => path !== "unknown")
      .filter((path) => !isReadOnlyPath(path));
    const preferredPaths = uniqueStrings(
      [...normalizedPlanTargets, ...bundlePaths]
        .map(normalizePath)
        .filter(Boolean)
        .filter((path) => path !== "unknown")
        .filter((path) => !isReadOnlyPath(path))
        .filter((path) => !looksLikePlaceholderPath(path)),
    );
    // Prefer architect-declared targets (including explicit create targets).
    // Fall back to librarian-provided allow list only when plan targets are absent.
    const allowedPathValues = normalizedPlanTargets.length > 0
      ? normalizedPlanTargets
      : bundleAllow.length > 0
        ? uniqueStrings([...bundleAllow, ...fallbackAllow])
        : [];
    const allowedPaths = new Set(allowedPathValues);
    const preferredRetryPaths = preferredPaths.filter(
      (path) => allowedPaths.size === 0 || allowedPaths.has(path),
    );
    const concreteRetryPaths = preferredRetryPaths.length > 0
      ? preferredRetryPaths
      : (allowedPaths.size > 0 ? Array.from(allowedPaths) : preferredPaths);
    const validatePatchTargets = (paths: string[]) => {
      const invalid = paths.filter((path) => {
        if (!path.trim()) return true;
        if (looksLikePlaceholderPath(path)) return true;
        const normalized = normalizePath(path);
        if (isReadOnlyPath(normalized)) return true;
        if (allowedPaths.size === 0) return false;
        return !allowedPaths.has(normalized);
      });
      if (invalid.length) {
        throw new Error(`Patch references disallowed files: ${invalid.join(", ")}`);
      }
    };
    const allowDeleteActions = planAllowsDeleteAction(plan);
    const touchedFiles = new Set<string>();
    const logPatchPayload = async (payload: { patches: Array<{ file: string }> }, source: string) => {
      if (!this.options.logger) return;
      const path = await this.options.logger.writePhaseArtifact("builder", "patch", payload);
      await this.options.logger.log("builder_patch", {
        patches: payload.patches.length,
        source,
        path,
      });
    };
    const applyPayload = async (
      payload: PatchPayload,
      source: string,
      rawOutput: string,
    ): Promise<void> => {
      const patchApplier = this.options.patchApplier;
      if (!patchApplier) {
        throw new Error("PatchApplier is required to apply patches");
      }
      const patchQualityError = validatePatchPayloadQuality(payload.patches, {
        allowDelete: allowDeleteActions,
      });
      if (patchQualityError) {
        throw new PatchApplyError({
          source,
          error: patchQualityError,
          patches: payload.patches,
          rollback: { attempted: false, ok: true },
          rawOutput,
        });
      }
      validatePatchTargets(payload.patches.map((patch) => patch.file));
      emitPatchStatus("applying patches");
      const rollbackPlan = await patchApplier.createRollback(payload.patches);
      try {
        const applyResult = await patchApplier.apply(payload.patches);
        if (this.options.logger) {
          await this.options.logger.log("patch_applied", {
            patches: payload.patches.length,
            touchedFiles: applyResult.touched,
            source,
          });
        }
        for (const file of applyResult.touched) touchedFiles.add(file);
      } catch (error) {
        let rollbackOk = false;
        let rollbackError: string | undefined;
        try {
          await patchApplier.rollback(rollbackPlan);
          rollbackOk = true;
        } catch (rollbackErr) {
          rollbackError =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        }
        if (this.options.logger) {
          await this.options.logger.log("patch_rollback", {
            source,
            ok: rollbackOk,
            error: rollbackError ?? null,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new PatchApplyError({
          source,
          error: message,
          patches: payload.patches,
          rollback: { attempted: true, ok: rollbackOk, error: rollbackError },
          rawOutput,
        });
      }
    };
    const buildUserContent = (note?: string) =>
      [
        note ? `RETRY NOTE: ${note}` : null,
        "PLAN (read-only):",
        JSON.stringify(plan, null, 2),
        "",
        "CONTEXT BUNDLE (read-only; do not output):",
        contextContent,
      ]
        .filter(Boolean)
        .join("\n");
    const buildSchemaOnlyContent = (note: string) => {
      const allowList =
        allowedPaths.size > 0
          ? Array.from(allowedPaths).join(", ")
          : "all (except read-only)";
      const readOnlyList = readOnlyPaths.length ? readOnlyPaths.join(", ") : "none";
      const preferredList = concreteRetryPaths.length ? concreteRetryPaths.join(", ") : "none";
      return [
        note,
        "Return ONLY the JSON payload that matches the schema in the system prompt.",
        "Do not include any prose, markdown, or extra keys.",
        "Do NOT include plan or context.",
        "Never include changes for read-only paths.",
        "Do NOT repeat prior rejected payloads or schema examples.",
        `Allowed paths: ${allowList}`,
        `Read-only paths: ${readOnlyList}`,
        `Preferred concrete paths: ${preferredList}`,
        concreteRetryPaths.length > 0
          ? "Use these repo-relative paths instead of placeholders like path/to/file.ts."
          : null,
      ].join("\n");
    };
    const parseDisallowed = (message: string): string | undefined => {
      const match = message.match(/disallowed files:\\s*(.+)$/i);
      return match ? match[1]?.trim() : undefined;
    };
    const isDisallowedError = (message: string): boolean => /disallowed files/i.test(message);
    const buildDisallowedNote = (message: string) => {
      const disallowed = parseDisallowed(message) ?? "unknown";
      const preferred = concreteRetryPaths.length > 0
        ? ` Preferred concrete paths: ${concreteRetryPaths.join(", ")}.`
        : "";
      return `Your patch included disallowed files: ${disallowed}. Remove any changes to read-only paths and return JSON for allowed paths only.${preferred}`;
    };
    const buildUserMessage = (): ProviderMessage => ({
      role: "user",
      content: buildUserContent(options.note),
    });
    const finalizeResult = (
      base: RunnerResult,
      overrides: Partial<BuilderRunResult> = {},
    ): BuilderRunResult => ({
      ...base,
      ...overrides,
      ...(touchedFiles.size > 0
        ? { touchedFiles: Array.from(touchedFiles).sort() }
        : {}),
    });
    const contextManager = options.contextManager ?? this.options.contextManager;
    const laneId = options.laneId ?? this.options.laneId;
    const model = options.model ?? this.options.model;
    const buildMessages = async (modeOverride: typeof mode) => {
      const systemMessage = buildSystemMessage(modeOverride);
      const userMessage = buildUserMessage();
      const history =
        contextManager && laneId
          ? await contextManager.prepare(laneId, {
              systemPrompt: systemMessage.content,
              bundle: userMessage.content,
              model,
            })
          : [];
      const historyForMode =
        modeOverride === "patch_json"
          ? history.filter((message) => message.role !== "system")
          : history;
      return {
        systemMessage,
        userMessage,
        history: historyForMode,
        messages: [systemMessage, ...historyForMode, userMessage],
      };
    };
    let messageState = await buildMessages(mode);

    const resolveResponseFormat = (modeOverride: typeof mode): ProviderResponseFormat | undefined =>
      modeOverride === "patch_json" && this.options.provider.name === "ollama-remote"
        ? {
            type: "gbnf",
            grammar:
              patchFormat === "file_writes"
                ? BUILDER_PATCH_GBNF_FILE_WRITES
                : BUILDER_PATCH_GBNF_SEARCH_REPLACE,
          }
        : this.options.responseFormat;

    const buildRunner = (
      modeOverride: typeof mode = mode,
      responseFormat: ProviderResponseFormat | undefined = resolveResponseFormat(modeOverride),
    ) =>
      new Runner({
        provider: this.options.provider,
        tools: this.options.tools,
        context: this.options.context,
        maxSteps: this.options.maxSteps,
        maxToolCalls: this.options.maxToolCalls,
        maxTokens: this.options.maxTokens,
        timeoutMs: this.options.timeoutMs,
        temperature: this.options.temperature,
        responseFormat,
        toolChoice: modeOverride === "patch_json" || modeOverride === "freeform" ? "none" : "auto",
        stream: this.options.stream,
        onEvent: this.options.onEvent,
        onToken: this.options.onToken,
        streamFlushMs: this.options.streamFlushMs,
        logger: this.options.logger,
      });
    const mergeUsage = (a?: RunnerResult["usage"], b?: RunnerResult["usage"]) => {
      if (!a) return b;
      if (!b) return a;
      return {
        inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
        outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
        totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
      };
    };

    let result: RunnerResult;
    try {
      result = await buildRunner(mode).run(messageState.messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === "tool_calls" && this.isToolSupportError(message)) {
        this.options.onEvent?.({
          type: "status",
          phase: "executing",
          message: "builder: tools unsupported, retrying with patch_json",
        });
        if (this.options.logger) {
          await this.options.logger.log("builder_tool_fallback", {
            from: "tool_calls",
            to: "patch_json",
            error: message,
          });
        }
        mode = "patch_json";
        messageState = await buildMessages(mode);
        result = await buildRunner(mode).run(messageState.messages);
      } else {
        throw error;
      }
    }
    const initialOutput = result.finalMessage.content;

    if (contextManager && laneId) {
      await contextManager.append(laneId, messageState.userMessage, {
        role: "builder",
        model,
      });
      await contextManager.append(laneId, result.finalMessage, {
        role: "builder",
        model,
        tokens: result.usage?.totalTokens,
      });
    }

    const contextRequest = parseContextRequest(result.finalMessage.content, mode);
    if (contextRequest) {
      if (this.options.logger) {
        await this.options.logger.log("context_request", {
          reason: contextRequest.reason,
          queries: contextRequest.queries,
          files: contextRequest.files,
        });
      }
      return finalizeResult(result, { contextRequest });
    }
    if (mode === "tool_calls" && result.toolCallsExecuted === 0) {
      const tryApplyDirectPatch = async (): Promise<boolean> => {
        const formats: PatchFormat[] =
          patchFormat === "file_writes"
            ? ["file_writes", "search_replace"]
            : ["search_replace", "file_writes"];
        for (const format of formats) {
          try {
            const payload = parsePatchOutput(result.finalMessage.content, format);
            if (this.options.logger) {
              await this.options.logger.log("patch_direct_parse", {
                length: result.finalMessage.content.length,
                format,
                source: "tool_calls_direct",
              });
            }
            await logPatchPayload(payload, `tool_calls_direct_${format}`);
            await applyPayload(payload, `tool_calls_direct_${format}`, result.finalMessage.content);
            return true;
          } catch {
            // try next format
          }
        }
        return false;
      };
      const applied = await tryApplyDirectPatch();
      if (applied) {
        return finalizeResult(result);
      }
      if (this.options.logger) {
        await this.options.logger.log("builder_tool_calls_no_actions", {
          length: result.finalMessage.content.length,
          preview: result.finalMessage.content.slice(0, 200),
          action: "retry_patch_json",
        });
      }
      this.options.onEvent?.({
        type: "status",
        phase: "executing",
        message: "builder: no tool actions produced, retrying with patch_json",
      });
      mode = "patch_json";
      messageState = await buildMessages(mode);
      result = await buildRunner(mode).run(messageState.messages);
      const retryContextRequest = parseContextRequest(result.finalMessage.content, mode);
      if (retryContextRequest) {
        if (this.options.logger) {
          await this.options.logger.log("context_request", {
            reason: retryContextRequest.reason,
            queries: retryContextRequest.queries,
            files: retryContextRequest.files,
          });
        }
        return finalizeResult(result, { contextRequest: retryContextRequest });
      }
    }
    if (mode === "freeform") {
      const patchApplier = this.options.patchApplier;
      const interpreter = this.options.interpreter;
      if (!patchApplier) {
        throw new Error("PatchApplier is required for freeform mode");
      }
      if (!interpreter) {
        throw new Error("PatchInterpreter is required for freeform mode");
      }
      if (this.options.logger) {
        await this.options.logger.log("builder_freeform_output", {
          length: result.finalMessage.content.length,
          preview: result.finalMessage.content.slice(0, 200),
        });
      }
      const payload = await interpreter.interpret(result.finalMessage.content);
      await logPatchPayload(payload, "interpreter_freeform");
      await applyPayload(payload, "interpreter_freeform", result.finalMessage.content);
      return finalizeResult(result);
    }

    if (mode === "patch_json") {
      const interpreter = this.options.interpreter;
      const fallbackToInterpreter = this.options.fallbackToInterpreter === true;
      const parseAndApply = async (
        content: string,
        format: PatchFormat,
        source: string,
      ) => {
        const normalized = content.toLowerCase();
        if (
          normalized.includes("path/to/file.")
          || normalized.includes("path/to/new.")
          || normalized.includes("path/to/old.")
        ) {
          throw new PatchApplyError({
            source,
            error: "Patch output used placeholder file paths",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: content,
          });
        }
        try {
          const payload = parsePatchOutput(content, format);
          if (this.options.logger) {
            await this.options.logger.log("patch_direct_parse", {
              length: content.length,
              format,
              source,
            });
          }
          await logPatchPayload(payload, source);
          await applyPayload(payload, source, content);
          return;
        } catch (parseError) {
          if (parseError instanceof PatchApplyError) {
            throw parseError;
          }
          const parseErrorMessage =
            parseError instanceof Error ? parseError.message : String(parseError);
          const hasJsonCandidate = looksLikeJsonPatchCandidate(content);
          const hasTargetedProseIntent = looksLikeTargetedProsePatchIntent(content, plan);
          const canUseInterpreter =
            fallbackToInterpreter
            && Boolean(interpreter)
            && (hasJsonCandidate || hasTargetedProseIntent)
            && isInterpreterParseRetryCandidate(parseErrorMessage);
          if (!canUseInterpreter) {
            throw parseError;
          }
          if (this.options.logger) {
            await this.options.logger.log("patch_interpreter_precheck", {
              length: content.length,
              format,
              source,
              reason: hasJsonCandidate ? "json_candidate" : "prose_targeted_intent",
            });
          }
          const payload = await interpreter!.interpret(content, format);
          await logPatchPayload(payload, source);
          await applyPayload(payload, source, content);
        }
      };

      let processingError: Error | undefined;
      const attemptFileWritesRecovery = async (
        reason: string,
        source: string,
      ): Promise<BuilderRunResult> => {
        const recoverySystem: ProviderMessage = {
          role: "system",
          content: buildBuilderPrompt(mode, "file_writes"),
        };
        const recoveryUser: ProviderMessage = {
          role: "user",
          content: buildSchemaOnlyContent(
            `${reason} Return JSON with a top-level "files" array and full updated content for each changed file.`,
          ),
        };
        if (this.options.logger) {
          await this.options.logger.log("patch_search_block_recovery", {
            format: "file_writes",
            reason,
            source,
          });
        }
        const recoveryResult = await buildRunner(
          mode,
          {
            type: "gbnf",
            grammar: BUILDER_PATCH_GBNF_FILE_WRITES,
          },
        ).run([recoverySystem, ...messageState.history, messageState.userMessage, recoveryUser]);
        const merged = {
          ...recoveryResult,
          usage: mergeUsage(result.usage, recoveryResult.usage),
        };
        result = merged;
        await parseAndApply(merged.finalMessage.content, "file_writes", source);
        return finalizeResult(merged);
      };
      try {
        await parseAndApply(result.finalMessage.content, patchFormat, "interpreter_primary");
        return finalizeResult(result);
      } catch (error) {
        if (error instanceof PatchApplyError) {
          if (!shouldRetrySchemaRepairFromPatchApplyError(error)) {
            if (patchFormat === "search_replace" && isSearchBlockNotFoundError(error.details.error)) {
              return attemptFileWritesRecovery(
                `Search-replace patch failed: ${error.details.error}`,
                "interpreter_search_block_recovery",
              );
            }
            throw error;
          }
          processingError = new Error(error.details.error);
        } else {
          processingError = error instanceof Error ? error : new Error(String(error));
        }
      }

      if (processingError && this.options.logger) {
        await this.options.logger.log("patch_parse_failed", {
          format: patchFormat,
          error: processingError.message,
          preview: result.finalMessage.content.slice(0, 200),
        });
      }
      const schemaRetryAllowed =
        processingError !== undefined ? shouldRetrySchemaRepair(processingError.message) : false;
      if (processingError && !schemaRetryAllowed && this.options.logger) {
        await this.options.logger.log("patch_retry_skipped", {
          format: patchFormat,
          reason: "non_recoverable_schema_error",
          error: processingError.message,
        });
      }

      if (processingError && schemaRetryAllowed && patchFormat === "file_writes") {
        const retryNote = isDisallowedError(processingError.message)
          ? buildDisallowedNote(processingError.message)
          : 'Your output did not match schema. Respond ONLY with JSON and include a top-level "files" array.';
        const retrySystem: ProviderMessage = {
          role: "system",
          content: buildBuilderPrompt(mode, "file_writes"),
        };
        const retryUser: ProviderMessage = {
          role: "user",
          content: buildSchemaOnlyContent(retryNote),
        };
        if (this.options.logger) {
          await this.options.logger.log("patch_retry", { format: "file_writes", error: processingError.message });
        }
        const retryResult = await buildRunner(
          mode,
          {
            type: "gbnf",
            grammar: BUILDER_PATCH_GBNF_FILE_WRITES,
          },
        ).run([retrySystem, ...messageState.history, messageState.userMessage, retryUser]);
        result = { ...retryResult, usage: mergeUsage(result.usage, retryResult.usage) };
        try {
          await parseAndApply(result.finalMessage.content, "file_writes", "interpreter_retry");
          return finalizeResult(result);
        } catch (retryError) {
          if (retryError instanceof PatchApplyError) {
            throw retryError;
          }
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          if (this.options.logger) {
            await this.options.logger.log("patch_retry_failed", { format: "file_writes", error: retryMessage });
          }
          const fallbackNote = isDisallowedError(retryMessage)
            ? buildDisallowedNote(retryMessage)
            : 'Fallback required. Respond ONLY with JSON patch schema using a top-level "patches" array.';
          const fallbackSystem: ProviderMessage = {
            role: "system",
            content: buildBuilderPrompt(mode, "search_replace"),
          };
          const fallbackUser: ProviderMessage = {
            role: "user",
            content: buildSchemaOnlyContent(fallbackNote),
          };
          if (this.options.logger) {
            await this.options.logger.log("patch_fallback", { format: "search_replace" });
          }
          const fallbackResult = await buildRunner(
            mode,
            {
              type: "gbnf",
              grammar: BUILDER_PATCH_GBNF_SEARCH_REPLACE,
            },
          ).run([fallbackSystem, ...messageState.history, messageState.userMessage, fallbackUser]);
          result = { ...fallbackResult, usage: mergeUsage(result.usage, fallbackResult.usage) };
          try {
            await parseAndApply(result.finalMessage.content, "search_replace", "interpreter_fallback");
            return finalizeResult(result);
          } catch (fallbackError) {
            if (fallbackError instanceof PatchApplyError) {
              throw fallbackError;
            }
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            if (isDisallowedError(fallbackMessage)) {
              const guardSystem: ProviderMessage = {
                role: "system",
                content: buildBuilderPrompt(mode, "search_replace"),
              };
              const guardUser: ProviderMessage = {
                role: "user",
                content: buildSchemaOnlyContent(buildDisallowedNote(fallbackMessage)),
              };
              const guardResult = await buildRunner(
                mode,
                {
                  type: "gbnf",
                  grammar: BUILDER_PATCH_GBNF_SEARCH_REPLACE,
                },
              ).run([guardSystem, ...messageState.history, messageState.userMessage, guardUser]);
              result = { ...guardResult, usage: mergeUsage(result.usage, guardResult.usage) };
              try {
                await parseAndApply(result.finalMessage.content, "search_replace", "interpreter_guard");
                return finalizeResult(result);
              } catch (guardError) {
                if (guardError instanceof PatchApplyError) {
                  throw guardError;
                }
                const guardMessage =
                  guardError instanceof Error ? guardError.message : String(guardError);
                processingError = new Error(
                  `Patch parsing failed. initial=${processingError.message}; retry=${retryMessage}; fallback=${fallbackMessage}; guard=${guardMessage}`,
                );
              }
            } else {
              processingError = new Error(
                `Patch parsing failed. initial=${processingError.message}; retry=${retryMessage}; fallback=${fallbackMessage}`,
              );
            }
          }
        }
      }

      if (processingError && schemaRetryAllowed && patchFormat === "search_replace") {
        const initialMessage = processingError.message;
        const retryNote = isDisallowedError(initialMessage)
          ? buildDisallowedNote(initialMessage)
          : 'Your output did not match schema. Respond ONLY with JSON and include a top-level "patches" array.';
        const retrySystem: ProviderMessage = {
          role: "system",
          content: buildBuilderPrompt(mode, "search_replace"),
        };
        const retryUser: ProviderMessage = {
          role: "user",
          content: buildSchemaOnlyContent(retryNote),
        };
        if (this.options.logger) {
          await this.options.logger.log("patch_retry", {
            format: "search_replace",
            error: initialMessage,
          });
        }
        const retryResult = await buildRunner(
          mode,
          {
            type: "gbnf",
            grammar: BUILDER_PATCH_GBNF_SEARCH_REPLACE,
          },
        ).run([retrySystem, ...messageState.history, messageState.userMessage, retryUser]);
        result = { ...retryResult, usage: mergeUsage(result.usage, retryResult.usage) };
        try {
          await parseAndApply(result.finalMessage.content, "search_replace", "interpreter_retry");
          return finalizeResult(result);
        } catch (retryError) {
          if (retryError instanceof PatchApplyError) {
            if (isSearchBlockNotFoundError(retryError.details.error)) {
              return attemptFileWritesRecovery(
                `Search-replace retry failed: ${retryError.details.error}`,
                "interpreter_search_block_retry_recovery",
              );
            }
            throw retryError;
          }
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          if (this.options.logger) {
            await this.options.logger.log("patch_retry_failed", {
              format: "search_replace",
              error: retryMessage,
            });
          }
          processingError = new Error(
            `Patch parsing failed. initial=${initialMessage}; retry=${retryMessage}`,
          );
        }
      }

      if (processingError) {
        throw new PatchApplyError({
          source: "builder_patch_processing",
          error: processingError.message,
          patches: [],
          rollback: { attempted: false, ok: true },
          rawOutput: result.finalMessage.content,
        });
      }
    }
    return finalizeResult(result);
  }
}
