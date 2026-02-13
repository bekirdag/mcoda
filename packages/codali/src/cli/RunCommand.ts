import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { loadConfig } from "../config/ConfigLoader.js";
import type { ToolConfig } from "../config/Config.js";
import { createProvider } from "../providers/ProviderRegistry.js";
import type {
  AgentEvent,
  AgentStatusPhase,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import { OpenAiCompatibleProvider } from "../providers/OpenAiCompatibleProvider.js";
import { OllamaRemoteProvider } from "../providers/OllamaRemoteProvider.js";
import { CodexCliProvider } from "../providers/CodexCliProvider.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { createFileTools } from "../tools/filesystem/FileTools.js";
import { createDiffTool } from "../tools/diff/DiffTool.js";
import { createSearchTool } from "../tools/search/SearchTool.js";
import { createShellTool } from "../tools/shell/ShellTool.js";
import { DocdexClient } from "../docdex/DocdexClient.js";
import { createDocdexTools } from "../tools/docdex/DocdexTools.js";
import { RunContext } from "../runtime/RunContext.js";
import { WorkspaceLock } from "../runtime/WorkspaceLock.js";
import { Runner } from "../runtime/Runner.js";
import { RunLogger } from "../runtime/RunLogger.js";
import { registerProvider } from "../providers/ProviderRegistry.js";
import type { ToolDefinition } from "../tools/ToolTypes.js";
import { ContextAssembler } from "../cognitive/ContextAssembler.js";
import { ArchitectPlanner } from "../cognitive/ArchitectPlanner.js";
import { BuilderRunner } from "../cognitive/BuilderRunner.js";
import { CriticEvaluator } from "../cognitive/CriticEvaluator.js";
import { ValidationRunner } from "../cognitive/ValidationRunner.js";
import { MemoryWriteback } from "../cognitive/MemoryWriteback.js";
import { PatchApplier } from "../cognitive/PatchApplier.js";
import { PatchInterpreter } from "../cognitive/PatchInterpreter.js";
import { SmartPipeline } from "../cognitive/SmartPipeline.js";
import { buildRoutedProvider, type PipelinePhase } from "../cognitive/ProviderRouting.js";
import type { ContextBundle, LaneScope } from "../cognitive/Types.js";
import { ContextManager } from "../cognitive/ContextManager.js";
import { ContextStore } from "../cognitive/ContextStore.js";
import { ContextSummarizer } from "../cognitive/ContextSummarizer.js";
import { ContextRedactor } from "../cognitive/ContextRedactor.js";
import { estimateCostFromChars, estimateCostFromUsage, resolvePricing } from "../cognitive/CostEstimator.js";
import { getGlobalWorkspaceDir } from "../runtime/StoragePaths.js";
import { resolveAgentConfig } from "../agents/AgentResolver.js";
import { selectPhaseAgents, type PhaseAgentSelection } from "../agents/PhaseAgentSelector.js";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  command?: string;
  commandRunId?: string;
  jobId?: string;
  runId?: string;
  taskId?: string;
  taskKey?: string;
  agent?: string;
  agentId?: string;
  agentSlug?: string;
  agentLibrarian?: string;
  agentArchitect?: string;
  agentBuilder?: string;
  agentCritic?: string;
  agentInterpreter?: string;
  smart?: boolean;
  deepInvestigationEnabled?: boolean;
  planHint?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  taskFile?: string;
  configPath?: string;
  docdexBaseUrl?: string;
  docdexRepoId?: string;
  docdexRepoRoot?: string;
  contextMode?: "bundle_text" | "json";
  contextMaxFiles?: number;
  contextMaxTotalBytes?: number;
  contextTokenBudget?: number;
  contextFocusMaxBytes?: number;
  contextPeripheryMaxBytes?: number;
  contextIncludeRepoMap?: boolean;
  contextIncludeImpact?: boolean;
  contextIncludeSnippets?: boolean;
  contextReadStrategy?: "docdex" | "fs";
  contextMaxRefreshes?: number;
  contextSkeletonize?: boolean;
  contextRedactSecrets?: boolean;
  contextIgnoreFilesFrom?: string[];
  securityRedactPatterns?: string[];
  builderMode?: "tool_calls" | "patch_json" | "freeform";
  builderPatchFormat?: "search_replace" | "file_writes";
  interpreterProvider?: string;
  interpreterModel?: string;
  interpreterFormat?: string;
  interpreterGrammar?: string;
  interpreterMaxRetries?: number;
  interpreterTimeoutMs?: number;
  streamingFlushMs?: number;
  costMaxPerRun?: number;
  costCharPerToken?: number;
  costPricingOverrides?: string;
  inlineTask?: string;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const parseNumberArg = (value?: string): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const parseBooleanArg = (value?: string): boolean | undefined => {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return undefined;
  };
  const parseListArg = (value?: string): string[] | undefined => {
    if (!value) return undefined;
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  };

  const parsed: ParsedArgs = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--workspace-root" && next) {
      parsed.workspaceRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--project" && next) {
      parsed.project = next;
      i += 1;
      continue;
    }
    if (arg === "--command" && next) {
      parsed.command = next;
      i += 1;
      continue;
    }
    if (arg === "--command-run-id" && next) {
      parsed.commandRunId = next;
      i += 1;
      continue;
    }
    if (arg === "--job-id" && next) {
      parsed.jobId = next;
      i += 1;
      continue;
    }
    if (arg === "--run-id" && next) {
      parsed.runId = next;
      i += 1;
      continue;
    }
    if (arg === "--task-id" && next) {
      parsed.taskId = next;
      i += 1;
      continue;
    }
    if (arg === "--task-key" && next) {
      parsed.taskKey = next;
      i += 1;
      continue;
    }
    if (arg === "--agent" && next) {
      parsed.agent = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-id" && next) {
      parsed.agentId = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-slug" && next) {
      parsed.agentSlug = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-librarian" && next) {
      parsed.agentLibrarian = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-architect" && next) {
      parsed.agentArchitect = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-builder" && next) {
      parsed.agentBuilder = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-critic" && next) {
      parsed.agentCritic = next;
      i += 1;
      continue;
    }
    if (arg === "--agent-interpreter" && next) {
      parsed.agentInterpreter = next;
      i += 1;
      continue;
    }
    if (arg === "--plan-hint" && next) {
      parsed.planHint = next;
      i += 1;
      continue;
    }
    if (arg === "--smart") {
      parsed.smart = true;
      continue;
    }
    if (arg === "--no-deep-investigation") {
      parsed.deepInvestigationEnabled = false;
      continue;
    }
    if (arg === "--provider" && next) {
      parsed.provider = next;
      i += 1;
      continue;
    }
    if (arg === "--model" && next) {
      parsed.model = next;
      i += 1;
      continue;
    }
    if (arg === "--api-key" && next) {
      parsed.apiKey = next;
      i += 1;
      continue;
    }
    if (arg === "--base-url" && next) {
      parsed.baseUrl = next;
      i += 1;
      continue;
    }
    if ((arg === "--task" || arg === "--task-file") && next) {
      parsed.taskFile = next;
      i += 1;
      continue;
    }
    if (arg === "--config" && next) {
      parsed.configPath = next;
      i += 1;
      continue;
    }
    if (arg === "--docdex-base-url" && next) {
      parsed.docdexBaseUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--docdex-repo-id" && next) {
      parsed.docdexRepoId = next;
      i += 1;
      continue;
    }
    if (arg === "--docdex-repo-root" && next) {
      parsed.docdexRepoRoot = next;
      i += 1;
      continue;
    }
    if (arg === "--context-mode" && next) {
      if (next === "bundle_text" || next === "json") parsed.contextMode = next;
      i += 1;
      continue;
    }
    if (arg === "--context-max-files" && next) {
      parsed.contextMaxFiles = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-max-total-bytes" && next) {
      parsed.contextMaxTotalBytes = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-token-budget" && next) {
      parsed.contextTokenBudget = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-focus-max-bytes" && next) {
      parsed.contextFocusMaxBytes = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-periphery-max-bytes" && next) {
      parsed.contextPeripheryMaxBytes = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-include-repo-map" && next) {
      parsed.contextIncludeRepoMap = parseBooleanArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-include-impact" && next) {
      parsed.contextIncludeImpact = parseBooleanArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-include-snippets" && next) {
      parsed.contextIncludeSnippets = parseBooleanArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-read-strategy" && next) {
      if (next === "docdex" || next === "fs") parsed.contextReadStrategy = next;
      i += 1;
      continue;
    }
    if (arg === "--context-max-refreshes" && next) {
      parsed.contextMaxRefreshes = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-skeletonize" && next) {
      parsed.contextSkeletonize = parseBooleanArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-redact-secrets" && next) {
      parsed.contextRedactSecrets = parseBooleanArg(next);
      i += 1;
      continue;
    }
    if (arg === "--context-ignore-files-from" && next) {
      parsed.contextIgnoreFilesFrom = parseListArg(next);
      i += 1;
      continue;
    }
    if (arg === "--security-redact-patterns" && next) {
      parsed.securityRedactPatterns = parseListArg(next);
      i += 1;
      continue;
    }
    if (arg === "--builder-mode" && next) {
      if (next === "tool_calls" || next === "patch_json" || next === "freeform") {
        parsed.builderMode = next;
      }
      i += 1;
      continue;
    }
    if (arg === "--builder-patch-format" && next) {
      if (next === "search_replace" || next === "file_writes") parsed.builderPatchFormat = next;
      i += 1;
      continue;
    }
    if (arg === "--interpreter-provider" && next) {
      parsed.interpreterProvider = next;
      i += 1;
      continue;
    }
    if (arg === "--interpreter-model" && next) {
      parsed.interpreterModel = next;
      i += 1;
      continue;
    }
    if (arg === "--interpreter-format" && next) {
      parsed.interpreterFormat = next;
      i += 1;
      continue;
    }
    if (arg === "--interpreter-grammar" && next) {
      parsed.interpreterGrammar = next;
      i += 1;
      continue;
    }
    if (arg === "--interpreter-max-retries" && next) {
      parsed.interpreterMaxRetries = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--interpreter-timeout-ms" && next) {
      parsed.interpreterTimeoutMs = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--streaming-flush-ms" && next) {
      parsed.streamingFlushMs = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--cost-max" && next) {
      parsed.costMaxPerRun = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--cost-char-per-token" && next) {
      parsed.costCharPerToken = parseNumberArg(next);
      i += 1;
      continue;
    }
    if (arg === "--cost-pricing-overrides" && next) {
      parsed.costPricingOverrides = next;
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  if (positionals.length) {
    parsed.inlineTask = positionals.join(" ");
  }
  return parsed;
};

const ROOT_MARKERS = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "codali.config.json",
  ".codalirc",
];

export const resolveWorkspaceRoot = (
  cwd: string,
  explicitRoot?: string,
): string => {
  if (explicitRoot) {
    return path.resolve(cwd, explicitRoot);
  }
  let current = path.resolve(cwd);
  let previous = "";
  while (current !== previous) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(path.join(current, marker))) {
        return current;
      }
    }
    previous = current;
    current = path.dirname(current);
  }
  return path.resolve(cwd);
};

const formatCost = (cost?: number): string => {
  if (cost === undefined) return "unknown";
  return `$${cost.toFixed(4)}`;
};

const summarizeContext = (context: ContextBundle | undefined, fallbackContent?: string) => {
  const files = context?.files ?? [];
  const focusCount = files.filter((file) => file.role === "focus").length;
  const peripheryCount = files.filter((file) => file.role === "periphery").length;
  const content = context?.serialized?.content ?? fallbackContent ?? "";
  return {
    focusCount,
    peripheryCount,
    content,
    charCount: content.length,
  };
};

const confirmOverage = async (message: string): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(message);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
};

const createStreamState = (flushEveryMs: number, outputStream?: NodeJS.WritableStream) => {
  let buffer = "";
  let lastFlush = Date.now();
  let didStream = false;
  const forceColor = process.env.FORCE_COLOR;
  const supportsColor =
    (forceColor && forceColor !== "0") || (!!process.stderr.isTTY && !process.env.NO_COLOR);
  const colorize = (code: string, text: string) =>
    supportsColor ? `\u001b[${code}m${text}\u001b[0m` : text;
  const indent = "  ";
  const statusColor = (phase: AgentStatusPhase) => {
    if (phase === "executing") return "35";
    if (phase === "patching") return "33";
    if (phase === "done") return "32";
    return "36";
  };
  const tag = (phase: AgentStatusPhase) => colorize(statusColor(phase), `[${phase}]`);
  const toolTag = (name: string) => colorize("34", `[tool:${name}]`);
  const toolLead = () => colorize("34", "[tool]");
  const okTag = () => colorize("32", "ok");
  const errTag = () => colorize("31", "error");
  const errorLine = (message: string) => colorize("31", message);
  const flush = () => {
    if (buffer.length > 0) {
      process.stdout.write(buffer);
      outputStream?.write(buffer);
      buffer = "";
    }
    lastFlush = Date.now();
  };
  const writeStatus = (line: string) => {
    flush();
    process.stderr.write(`${line}\n`);
    outputStream?.write(`${line.replace(/\u001b\[[0-9;]*m/g, "")}\n`);
  };
  const onEvent = (event: AgentEvent) => {
    if (event.type === "token") {
      didStream = true;
      buffer += event.content;
      const now = Date.now();
      if (now - lastFlush >= flushEveryMs) {
        flush();
      }
      return;
    }
    if (event.type === "status") {
      const suffix = event.message ? ` ${event.message}` : "";
      writeStatus(`${indent}${tag(event.phase)}${suffix}`);
      return;
    }
    if (event.type === "tool_call") {
      writeStatus(`${indent}${toolLead()} ${event.name}`);
      return;
    }
    if (event.type === "tool_result") {
      const outcome = event.ok === false ? errTag() : okTag();
      writeStatus(`${indent}${toolTag(event.name)} ${outcome}`);
      return;
    }
    if (event.type === "error") {
      writeStatus(`${indent}${colorize("31", "[error]")} ${errorLine(event.message)}`);
    }
  };
  const onToken = (token: string) => {
    didStream = true;
    buffer += token;
    const now = Date.now();
    if (now - lastFlush >= flushEveryMs) {
      flush();
    }
  };
  return {
    onEvent,
    onToken,
    flush,
    didStream: () => didStream,
    writeOutput: (text: string) => {
      outputStream?.write(text);
    },
  };
};

const createPatchValidator = (
  workspaceRoot: string,
  allowShell: boolean,
  shellAllowlist: string[],
) => {
  if (!allowShell) return undefined;
  const allowlist = new Set(shellAllowlist ?? []);
  return async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (![".js", ".mjs", ".cjs"].includes(ext)) {
      return;
    }
    if (!allowlist.has("node")) {
      return;
    }
    const result = spawnSync("node", ["--check", filePath], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || "node --check failed");
    }
  };
};

const isPhaseProvider = (value: string): value is PipelinePhase =>
  value === "librarian" ||
  value === "architect" ||
  value === "builder" ||
  value === "critic" ||
  value === "interpreter";

const resolveInterpreterRoute = (
  config: {
    interpreter: { provider: string; model: string; timeoutMs: number };
    model: string;
    apiKey?: string;
    baseUrl?: string;
  },
  phaseRoutes: Record<PipelinePhase, { provider: string; config: ProviderConfig; temperature?: number }>,
): { provider: string; config: ProviderConfig; temperature?: number } => {
  const requestedProvider = config.interpreter.provider?.trim() || "auto";
  const requestedModel = config.interpreter.model?.trim() || "auto";
  const fallbackRoute =
    phaseRoutes.interpreter ??
    phaseRoutes.critic ??
    phaseRoutes.architect ??
    phaseRoutes.builder ??
    phaseRoutes.librarian;
  const routed =
    requestedProvider === "auto"
      ? fallbackRoute
      : isPhaseProvider(requestedProvider)
        ? phaseRoutes[requestedProvider]
        : undefined;
  const provider = routed?.provider ?? requestedProvider;
  const baseConfig: ProviderConfig = routed
    ? { ...routed.config }
    : {
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        timeoutMs: config.interpreter.timeoutMs,
      };
  if (!baseConfig.baseUrl) {
    const sameProviderBaseUrl = Object.values(phaseRoutes)
      .map((route) => (route.provider === provider ? route.config.baseUrl : undefined))
      .find((value): value is string => typeof value === "string" && value.length > 0);
    baseConfig.baseUrl = sameProviderBaseUrl ?? config.baseUrl ?? baseConfig.baseUrl;
  }
  const resolvedModel =
    requestedModel !== "auto"
      ? requestedModel
      : baseConfig.model ?? fallbackRoute?.config.model ?? config.model;
  return {
    provider,
    config: {
      ...baseConfig,
      model: resolvedModel,
      timeoutMs: config.interpreter.timeoutMs ?? baseConfig.timeoutMs,
    },
    temperature: routed?.temperature,
  };
};

export const isToolEnabled = (name: string, tools: ToolConfig): boolean => {
  if (name === "run_shell" && !tools.allowShell) {
    return false;
  }
  const enabled = tools.enabled?.length ? new Set(tools.enabled) : undefined;
  if (!enabled) return true;
  return enabled.has(name);
};

const PATCH_JSON_STRUCTURED_CAPABILITIES = [
  "strict_instruction_following",
  "json_formatting",
  "schema_adherence",
  "structured_output",
];

const PATCH_JSON_CODE_CAPABILITIES = [
  "code_write",
  "iterative_coding",
  "simple_refactor",
  "minimal_diff_generation",
  "migration_scripts",
  "debugging",
  "refactor_support",
];

const countCapabilityMatches = (capabilities: string[], required: string[]): number =>
  required.filter((capability) => capabilities.includes(capability)).length;

export const assessPhaseFallbackSuitability = (
  phase: PipelinePhase,
  builderMode: "tool_calls" | "patch_json" | "freeform",
  selection: Pick<PhaseAgentSelection, "capabilities"> & { supportsTools?: boolean },
): {
  ok: boolean;
  reason: string;
  details?: Record<string, number | string>;
  builderMode?: "tool_calls" | "patch_json" | "freeform";
} => {
  if (phase !== "builder") {
    return { ok: true, reason: "not_builder_phase", builderMode };
  }
  if (builderMode !== "patch_json") {
    return { ok: true, reason: "builder_mode_not_patch_json", builderMode };
  }
  const capabilities = selection.capabilities ?? [];
  const structuredHits = countCapabilityMatches(capabilities, PATCH_JSON_STRUCTURED_CAPABILITIES);
  const codeHits = countCapabilityMatches(capabilities, PATCH_JSON_CODE_CAPABILITIES);
  if (codeHits <= 0) {
    return {
      ok: false,
      reason: "missing_patch_code_capability",
      details: { codeHits },
    };
  }
  if (structuredHits > 0) {
    return {
      ok: true,
      reason: "capability_requirements_met",
      details: { structuredHits, codeHits },
      builderMode: "patch_json",
    };
  }
  const hasToolRunner = capabilities.includes("tool_runner");
  if (selection.supportsTools || hasToolRunner) {
    return {
      ok: true,
      reason: "fallback_patch_json_without_structured_capability",
      details: { structuredHits, codeHits, hasToolRunner: hasToolRunner ? 1 : 0 },
      // Keep patch_json mode so fallback builders stay in the same patch contract path.
      builderMode: "patch_json",
    };
  }
  return {
    ok: false,
    reason: "missing_structured_output_capability",
    details: { structuredHits, codeHits },
  };
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
};

const resolveTaskInput = async (parsed: ParsedArgs): Promise<string> => {
  if (parsed.taskFile) {
    return readFile(parsed.taskFile, "utf8");
  }
  if (parsed.inlineTask) {
    return parsed.inlineTask;
  }
  if (process.stdin.isTTY) {
    return "";
  }
  return readStdin();
};

const isTrivialRequest = (request: string): boolean => {
  const normalized = request.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const shortEnough = normalized.length <= 120;
  const signals = ["typo", "spelling", "format", "whitespace", "rename", "readme", "comment"];
  return shortEnough && signals.some((signal) => normalized.includes(signal));
};

class StubProvider implements Provider {
  name = "stub";

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const last = request.messages[request.messages.length - 1];
    const promptText = request.messages.map((message) => message.content ?? "").join("\n");
    const lowerPrompt = promptText.toLowerCase();
    const isArchitectPrompt = /ROLE:\s*Technical Architect/i.test(promptText);
    const isArchitectReviewPrompt =
      isArchitectPrompt
      && (
        /TASK:\s*Review the builder output/i.test(promptText)
        || (/OUTPUT FORMAT \(PLAIN TEXT\):/i.test(promptText) && /STATUS:\s*PASS\|RETRY/i.test(promptText))
      );
    if (isArchitectReviewPrompt) {
      return {
        message: {
          role: "assistant",
          content: [
            "STATUS: PASS",
            "REASONS:",
            "- Request intent and plan targets are covered.",
            "FEEDBACK:",
          ].join("\n"),
        },
      };
    }
    const isArchitectPlanPrompt =
      isArchitectPrompt
      && (
        /TASK:\s*Produce an implementation plan/i.test(promptText)
        || /PREFERRED OUTPUT SHAPE \(PLAIN TEXT\)/i.test(promptText)
      );
    if (isArchitectPlanPrompt) {
      return {
        message: {
          role: "assistant",
          content: [
            "WHAT IS REQUIRED:",
            "- Apply the requested behavior update for the current task.",
            "CURRENT CONTEXT:",
            "- Existing implementation lives in src/index.ts.",
            "FOLDER STRUCTURE:",
            "- src/index.ts",
            "FILES TO TOUCH:",
            "- src/index.ts",
            "IMPLEMENTATION PLAN:",
            "- Update src/index.ts to implement the requested behavior change.",
            "RISK: low scoped single-file update.",
            "VERIFY:",
            "- Run unit/integration tests that cover src/index.ts behavior.",
          ].join("\n"),
        },
      };
    }
    if (lowerPrompt.includes("\"patches\"") || lowerPrompt.includes("search_replace")) {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            patches: [
              {
                action: "replace",
                file: "src/index.ts",
                search_block: "const value = 1;",
                replace_block: "const value = 2;",
              },
            ],
          }),
        },
      };
    }
    if (lowerPrompt.includes("\"files\"") || lowerPrompt.includes("file_writes")) {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            files: [{ path: "src/index.ts", content: "const value = 2;\n" }],
            delete: [],
          }),
        },
      };
    }
    if (request.responseFormat?.type === "json" || request.responseFormat?.type === "gbnf") {
      if (promptText.includes("\"files\"")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              files: [{ path: "src/index.ts", content: "const value = 2;\n" }],
              delete: [],
            }),
          },
        };
      }
      if (promptText.includes("\"patches\"")) {
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              patches: [
                {
                  action: "replace",
                  file: "src/index.ts",
                  search_block: "const value = 1;",
                  replace_block: "const value = 2;",
                },
              ],
            }),
          },
        };
      }
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            steps: ["1. Apply change"],
            target_files: ["src/index.ts"],
            risk_assessment: "low",
            verification: ["Run unit tests: pnpm test --filter codali"],
          }),
        },
      };
    }
    return { message: { role: "assistant", content: `stub:${last?.content ?? ""}` } };
  }
}

const registerBuiltins = () => {
  try {
    registerProvider("openai-compatible", (config: ProviderConfig) => new OpenAiCompatibleProvider(config));
  } catch {
    // ignore duplicate registrations
  }
  try {
    registerProvider("ollama-remote", (config: ProviderConfig) => new OllamaRemoteProvider(config));
  } catch {
    // ignore duplicate registrations
  }
  try {
    registerProvider("codex-cli", (config: ProviderConfig) => new CodexCliProvider(config));
  } catch {
    // ignore duplicate registrations
  }
  try {
    registerProvider("stub", () => new StubProvider());
  } catch {
    // ignore duplicate registrations
  }
};

export class RunCommand {
  static async run(argv: string[]): Promise<void> {
    registerBuiltins();
    const parsed = parseArgs(argv);
    const resolvedWorkspaceRoot = resolveWorkspaceRoot(process.cwd(), parsed.workspaceRoot);

    const agentRef = parsed.agent ?? parsed.agentId ?? parsed.agentSlug;
    const resolvedAgent = agentRef
      ? await resolveAgentConfig(agentRef, {
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey,
        })
      : undefined;

    const provider = parsed.provider ?? resolvedAgent?.provider;
    const model = parsed.model ?? resolvedAgent?.model;
    const apiKey = parsed.apiKey ?? resolvedAgent?.apiKey;
    const baseUrl = parsed.baseUrl ?? resolvedAgent?.baseUrl;
    const agentId = resolvedAgent?.agent.id ?? parsed.agentId;
    const agentSlug = resolvedAgent?.agent.slug ?? parsed.agentSlug;

    const cliConfig: Record<string, unknown> = {};
    if (parsed.workspaceRoot) cliConfig.workspaceRoot = parsed.workspaceRoot;
    if (parsed.project) cliConfig.project = parsed.project;
    if (parsed.command) cliConfig.command = parsed.command;
    if (parsed.commandRunId) cliConfig.commandRunId = parsed.commandRunId;
    if (parsed.jobId) cliConfig.jobId = parsed.jobId;
    if (parsed.runId) cliConfig.runId = parsed.runId;
    if (parsed.taskId) cliConfig.taskId = parsed.taskId;
    if (parsed.taskKey) cliConfig.taskKey = parsed.taskKey;
    if (agentId) cliConfig.agentId = agentId;
    if (agentSlug) cliConfig.agentSlug = agentSlug;
    if (parsed.smart !== undefined) cliConfig.smart = parsed.smart;
    if (parsed.deepInvestigationEnabled !== undefined) {
      cliConfig.deepInvestigation = { enabled: parsed.deepInvestigationEnabled };
    }
    if (parsed.planHint) cliConfig.planHint = parsed.planHint;
    if (provider) cliConfig.provider = provider;
    if (model) cliConfig.model = model;
    if (apiKey) cliConfig.apiKey = apiKey;
    if (baseUrl) cliConfig.baseUrl = baseUrl;

    const docdexOverrides: Record<string, string> = {};
    if (parsed.docdexBaseUrl) docdexOverrides.baseUrl = parsed.docdexBaseUrl;
    if (parsed.docdexRepoId) docdexOverrides.repoId = parsed.docdexRepoId;
    if (parsed.docdexRepoRoot) docdexOverrides.repoRoot = parsed.docdexRepoRoot;
    if (Object.keys(docdexOverrides).length) {
      cliConfig.docdex = docdexOverrides;
    }

    const contextOverrides: Record<string, unknown> = {};
    if (parsed.contextMode) contextOverrides.mode = parsed.contextMode;
    if (parsed.contextMaxFiles !== undefined) contextOverrides.maxFiles = parsed.contextMaxFiles;
    if (parsed.contextMaxTotalBytes !== undefined) contextOverrides.maxTotalBytes = parsed.contextMaxTotalBytes;
    if (parsed.contextTokenBudget !== undefined) contextOverrides.tokenBudget = parsed.contextTokenBudget;
    if (parsed.contextFocusMaxBytes !== undefined) contextOverrides.focusMaxFileBytes = parsed.contextFocusMaxBytes;
    if (parsed.contextPeripheryMaxBytes !== undefined) contextOverrides.peripheryMaxBytes = parsed.contextPeripheryMaxBytes;
    if (parsed.contextIncludeRepoMap !== undefined) contextOverrides.includeRepoMap = parsed.contextIncludeRepoMap;
    if (parsed.contextIncludeImpact !== undefined) contextOverrides.includeImpact = parsed.contextIncludeImpact;
    if (parsed.contextIncludeSnippets !== undefined) contextOverrides.includeSnippets = parsed.contextIncludeSnippets;
    if (parsed.contextReadStrategy) contextOverrides.readStrategy = parsed.contextReadStrategy;
    if (parsed.contextMaxRefreshes !== undefined) contextOverrides.maxContextRefreshes = parsed.contextMaxRefreshes;
    if (parsed.contextSkeletonize !== undefined) contextOverrides.skeletonizeLargeFiles = parsed.contextSkeletonize;
    if (parsed.contextRedactSecrets !== undefined) contextOverrides.redactSecrets = parsed.contextRedactSecrets;
    if (parsed.contextIgnoreFilesFrom) contextOverrides.ignoreFilesFrom = parsed.contextIgnoreFilesFrom;
    if (Object.keys(contextOverrides).length) {
      cliConfig.context = contextOverrides;
    }

    const securityOverrides: Record<string, unknown> = {};
    if (parsed.securityRedactPatterns) securityOverrides.redactPatterns = parsed.securityRedactPatterns;
    if (Object.keys(securityOverrides).length) {
      cliConfig.security = securityOverrides;
    }

    const builderOverrides: Record<string, unknown> = {};
    if (parsed.builderMode) builderOverrides.mode = parsed.builderMode;
    if (parsed.builderPatchFormat) builderOverrides.patchFormat = parsed.builderPatchFormat;
    if (Object.keys(builderOverrides).length) {
      cliConfig.builder = builderOverrides;
    }

    const interpreterOverrides: Record<string, unknown> = {};
    if (parsed.interpreterProvider) interpreterOverrides.provider = parsed.interpreterProvider;
    if (parsed.interpreterModel) interpreterOverrides.model = parsed.interpreterModel;
    if (parsed.interpreterFormat) interpreterOverrides.format = parsed.interpreterFormat;
    if (parsed.interpreterGrammar) interpreterOverrides.grammar = parsed.interpreterGrammar;
    if (parsed.interpreterMaxRetries !== undefined) {
      interpreterOverrides.maxRetries = parsed.interpreterMaxRetries;
    }
    if (parsed.interpreterTimeoutMs !== undefined) {
      interpreterOverrides.timeoutMs = parsed.interpreterTimeoutMs;
    }
    if (Object.keys(interpreterOverrides).length) {
      cliConfig.interpreter = interpreterOverrides;
    }

    const streamingOverrides: Record<string, unknown> = {};
    if (parsed.streamingFlushMs !== undefined) streamingOverrides.flushEveryMs = parsed.streamingFlushMs;
    if (Object.keys(streamingOverrides).length) {
      cliConfig.streaming = streamingOverrides;
    }

    const costOverrides: Record<string, unknown> = {};
    if (parsed.costMaxPerRun !== undefined) costOverrides.maxCostPerRun = parsed.costMaxPerRun;
    if (parsed.costCharPerToken !== undefined) costOverrides.charPerToken = parsed.costCharPerToken;
    if (parsed.costPricingOverrides) {
      try {
        costOverrides.pricingOverrides = JSON.parse(parsed.costPricingOverrides);
      } catch {
        // ignore malformed pricing overrides
      }
    }
    if (Object.keys(costOverrides).length) {
      cliConfig.cost = costOverrides;
    }

    const routingOverrides: Record<string, unknown> = {};
    const setRoutingOverride = (
      phase: "librarian" | "architect" | "builder" | "critic" | "interpreter",
      key: "agent",
      value?: string,
    ): void => {
      if (!value) return;
      routingOverrides[phase] = {
        ...(routingOverrides[phase] ?? {}),
        [key]: value,
      };
    };
    setRoutingOverride("librarian", "agent", parsed.agentLibrarian);
    setRoutingOverride("architect", "agent", parsed.agentArchitect);
    setRoutingOverride("builder", "agent", parsed.agentBuilder);
    setRoutingOverride("critic", "agent", parsed.agentCritic);
    setRoutingOverride("interpreter", "agent", parsed.agentInterpreter);
    if (Object.keys(routingOverrides).length) {
      cliConfig.routing = routingOverrides;
    }

    const config = await loadConfig({
      cli: cliConfig,
      configPath: parsed.configPath,
      cwd: resolvedWorkspaceRoot,
    });

    if (config.deepInvestigation?.enabled && !config.smart) {
      throw new Error(
        "Deep investigation requires --smart. Enable smart mode or disable deep investigation.",
      );
    }

    if (!config.smart && resolvedAgent?.agent) {
      const { contextWindow, maxOutputTokens, supportsTools } = resolvedAgent.agent;
      if (contextWindow && model) {
        config.localContext.modelTokenLimits = {
          ...config.localContext.modelTokenLimits,
          [model]: contextWindow,
        };
      }
      if (maxOutputTokens && config.limits.maxTokens === undefined) {
        config.limits.maxTokens = maxOutputTokens;
      }
      if (supportsTools === false && config.builder.mode === "tool_calls") {
        config.builder.mode = "patch_json";
      }
    }

    const taskInput = await resolveTaskInput(parsed);
    if (!taskInput.trim()) {
      throw new Error("Task input is empty; provide --task <file>, inline text, or pass text via stdin.");
    }

    const runId = config.runId ?? randomUUID();
    const runContext = new RunContext(runId, config.workspaceRoot);
    const storageRoot = getGlobalWorkspaceDir(config.workspaceRoot);
    const lock = new WorkspaceLock(storageRoot, runId);
    await lock.acquire();
    const logger = new RunLogger(storageRoot, config.logging.directory, runId);
    const outputLogPath = path.join(path.dirname(logger.logPath), `${runId}.output.log`);
    await mkdir(path.dirname(outputLogPath), { recursive: true });
    const outputStream = createWriteStream(outputLogPath, { flags: "a" });
    const unregisterSignals = lock.registerSignalHandlers({
      onSignal: async (signal) => {
        try {
          await logger.log("run_cancelled", {
            runId,
            signal,
            command: config.command,
            commandRunId: config.commandRunId,
            jobId: config.jobId,
            project: config.project,
            taskId: config.taskId,
            taskKey: config.taskKey,
          });
        } catch {
          // ignore logging failures during shutdown
        }
      },
    });
    await logger.log("run_start", {
      runId,
      command: config.command,
      commandRunId: config.commandRunId,
      jobId: config.jobId,
      project: config.project,
      taskId: config.taskId,
      taskKey: config.taskKey,
      agentId: config.agentId,
      agentSlug: config.agentSlug,
      provider: config.provider,
      model: config.model,
    });

    try {
      const registry = new ToolRegistry();
      const registerIfEnabled = (tool: ToolDefinition) => {
        if (isToolEnabled(tool.name, config.tools)) {
          registry.register(tool);
        }
      };
      for (const tool of createFileTools()) registerIfEnabled(tool);
      registerIfEnabled(createDiffTool());
      registerIfEnabled(createSearchTool());
      registerIfEnabled(createShellTool());

      const docdexClient = new DocdexClient({
        baseUrl: config.docdex.baseUrl,
        repoId: config.docdex.repoId,
        repoRoot: config.docdex.repoRoot ?? config.workspaceRoot,
        dagSessionId: runId,
      });
      for (const tool of createDocdexTools(docdexClient)) registerIfEnabled(tool);

      const toolContext = {
        workspaceRoot: config.workspaceRoot,
        recordTouchedFile: (filePath: string) => runContext.recordTouchedFile(filePath),
        allowOutsideWorkspace: config.tools.allowOutsideWorkspace,
        allowShell: config.tools.allowShell,
        shellAllowlist: config.tools.shellAllowlist,
      };
      const streamState = createStreamState(config.streaming.flushEveryMs, outputStream);

      let finalMessageContent = "";
      let usage;
      let toolCallsExecuted = 0;
      let pricingSpec: ReturnType<typeof resolvePricing>["pricing"];
      let pricingSource: string | undefined;
      let estimatedCost: number | undefined;
      let estimatedTokens: number | undefined;
      let estimatedChars: number | undefined;
      let estimatedFocus = 0;
      let estimatedPeriphery = 0;

      if (config.smart) {
        const hasRoutingAgent = Object.values(config.routing ?? {}).some((phase) =>
          Boolean(phase?.agent),
        );
        const hasExplicitProvider = Boolean(
          parsed.provider || parsed.model || parsed.baseUrl || parsed.apiKey,
        );
        const shouldForceAgentDefaults =
          !agentRef && !hasRoutingAgent && !hasExplicitProvider;
        const shouldSelectAgents = config.provider !== "stub";
        const emptySelection = (phase: PipelinePhase): PhaseAgentSelection => ({
          phase,
          capabilities: [],
          source: "none" as const,
        });
        const phaseOverrides: Partial<Record<PipelinePhase, string>> = {
          librarian: config.routing?.librarian?.agent,
          architect: config.routing?.architect?.agent,
          builder: config.routing?.builder?.agent,
          critic: config.routing?.critic?.agent,
          interpreter: config.routing?.interpreter?.agent,
        };
        const phaseExclusions: Partial<Record<PipelinePhase, string[]>> = {};
        let phaseSelections = shouldSelectAgents
          ? await selectPhaseAgents({
              overrides: phaseOverrides,
              builderMode: config.builder.mode,
              fallbackAgent: resolvedAgent,
              allowCloudModels: config.security.allowCloudModels,
              excludeAgentIds: phaseExclusions,
            })
          : {
              librarian: emptySelection("librarian"),
              architect: emptySelection("architect"),
              builder: emptySelection("builder"),
              critic: emptySelection("critic"),
              interpreter: emptySelection("interpreter"),
            };

        if (shouldSelectAgents) {
          const unresolvedPhases = Object.values(phaseSelections)
            .filter((selection) => !selection.resolved)
            .map((selection) => selection.phase);
          if (unresolvedPhases.length > 0) {
            throw new Error(
              `No eligible mcoda agents found for phase(s): ${unresolvedPhases.join(", ")}. ` +
                "Add/configure agents and verify with `mcoda agent list --json`.",
            );
          }
        }

        const fallbackResolved =
          phaseSelections.builder.resolved ??
          phaseSelections.architect.resolved ??
          phaseSelections.critic.resolved ??
          phaseSelections.librarian.resolved ??
          phaseSelections.interpreter.resolved ??
          resolvedAgent;

        if (shouldForceAgentDefaults) {
          if (!fallbackResolved) {
            throw new Error(
              "No eligible agents found in the mcoda agent registry. Run `mcoda agent list` or supply --agent/--provider/--model.",
            );
          }
          config.provider = fallbackResolved.provider;
          config.model = fallbackResolved.model;
          config.apiKey = fallbackResolved.apiKey;
          config.baseUrl = fallbackResolved.baseUrl;
        } else if (!config.provider || !config.model) {
          if (fallbackResolved) {
            config.provider = config.provider || fallbackResolved.provider;
            config.model = config.model || fallbackResolved.model;
            config.apiKey = config.apiKey ?? fallbackResolved.apiKey;
            config.baseUrl = config.baseUrl ?? fallbackResolved.baseUrl;
          }
        }

        if (!config.provider || !config.model) {
          throw new Error(
            "Missing provider/model after agent resolution. Provide --agent or configure routing defaults.",
          );
        }

        const defaults = {
          provider: config.provider,
          config: {
            model: config.model,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            timeoutMs: config.limits.timeoutMs,
          },
        };

        const selectedPhaseModels = new Set<string>(
          Object.values(phaseSelections)
            .map((selection) => selection.resolved?.model)
            .filter((value): value is string => Boolean(value)),
        );
        if (
          shouldSelectAgents &&
          config.localContext.summarize.model &&
          !selectedPhaseModels.has(config.localContext.summarize.model)
        ) {
          throw new Error(
            `CODALI_LOCAL_CONTEXT_SUMMARIZE_MODEL (${config.localContext.summarize.model}) ` +
              "must match a model from selected mcoda agents.",
          );
        }

        for (const selection of Object.values(phaseSelections)) {
          if (!selection.resolved) continue;
          const contextWindow = selection.resolved.agent.contextWindow;
          if (contextWindow) {
            config.localContext.modelTokenLimits = {
              ...config.localContext.modelTokenLimits,
              [selection.resolved.model]: contextWindow,
            };
          }
        }
        const builderSelection = phaseSelections.builder;
        if (builderSelection.resolved?.agent.maxOutputTokens && config.limits.maxTokens === undefined) {
          config.limits.maxTokens = builderSelection.resolved.agent.maxOutputTokens;
        }
        if (
          builderSelection.resolved?.agent.supportsTools === false &&
          config.builder.mode === "tool_calls"
        ) {
          config.builder.mode = "patch_json";
        }

        for (const selection of Object.values(phaseSelections)) {
          if (!selection.resolved) continue;
          await logger.log("phase_agent_selected", {
            phase: selection.phase,
            agentId: selection.resolved.agent.id,
            agentSlug: selection.resolved.agent.slug,
            provider: selection.resolved.provider,
            model: selection.resolved.model,
            source: selection.source,
            score: selection.score,
            reason: selection.reason,
          });
        }

        const buildDefaultsForPhase = (phase: PipelinePhase) => {
          const selected = phaseSelections[phase].resolved;
          return selected
            ? {
                provider: selected.provider,
                config: {
                  model: selected.model,
                  apiKey: selected.apiKey,
                  baseUrl: selected.baseUrl,
                  timeoutMs: config.limits.timeoutMs,
                },
              }
            : defaults;
        };

        const librarianDefaults = buildDefaultsForPhase("librarian");
        const architectDefaults = buildDefaultsForPhase("architect");
        const builderDefaults = buildDefaultsForPhase("builder");
        const criticDefaults = buildDefaultsForPhase("critic");
        const interpreterDefaults = buildDefaultsForPhase("interpreter");

        const librarianRoute = buildRoutedProvider(
          "librarian",
          librarianDefaults,
          config.routing,
          Boolean(phaseSelections.librarian.resolved),
        );
        const architectRoute = buildRoutedProvider(
          "architect",
          architectDefaults,
          config.routing,
          Boolean(phaseSelections.architect.resolved),
        );
        const builderRoute = buildRoutedProvider(
          "builder",
          builderDefaults,
          config.routing,
          Boolean(phaseSelections.builder.resolved),
        );
        const criticRoute = buildRoutedProvider(
          "critic",
          criticDefaults,
          config.routing,
          Boolean(phaseSelections.critic.resolved),
        );
        const interpreterPhaseRoute = buildRoutedProvider(
          "interpreter",
          interpreterDefaults,
          config.routing,
          Boolean(phaseSelections.interpreter.resolved),
        );

        const phaseRoutes: Record<PipelinePhase, typeof builderRoute> = {
          librarian: librarianRoute,
          architect: architectRoute,
          builder: builderRoute,
          critic: criticRoute,
          interpreter: interpreterPhaseRoute,
        };

        const librarianProvider = createProvider(librarianRoute.provider, librarianRoute.config);
        const architectProvider = createProvider(architectRoute.provider, architectRoute.config);
        const builderProvider = createProvider(builderRoute.provider, builderRoute.config);

        const profileAgentId =
          config.agentId ??
          config.agentSlug ??
          phaseSelections.architect.resolved?.agent.id ??
          phaseSelections.critic.resolved?.agent.id ??
          phaseSelections.librarian.resolved?.agent.id ??
          phaseSelections.builder.resolved?.agent.id ??
          phaseSelections.interpreter.resolved?.agent.id ??
          "codali";
        const store = new ContextStore({
          workspaceRoot: storageRoot,
          storageDir: config.localContext.storageDir,
        });
        const redactor = config.context.redactSecrets
          ? new ContextRedactor({
              workspaceRoot: config.workspaceRoot,
              ignoreFilesFrom: config.context.ignoreFilesFrom,
              redactPatterns: config.security.redactPatterns,
            })
          : undefined;
        if (redactor) {
          await redactor.loadIgnoreMatchers();
        }

        let summarizer: ContextSummarizer | undefined;
        if (config.localContext.enabled && config.localContext.summarize.enabled) {
          const providerKey = config.localContext.summarize.provider;
          let summarizerProviderName = providerKey;
          let summarizerConfig: ProviderConfig = { ...defaults.config };
          let summarizerTemperature: number | undefined;
          if (isPhaseProvider(providerKey)) {
            const route = phaseRoutes[providerKey];
            summarizerProviderName = route.provider;
            summarizerConfig = { ...route.config };
            summarizerTemperature = route.temperature;
          }
          if (config.localContext.summarize.model) {
            summarizerConfig = {
              ...summarizerConfig,
              model: config.localContext.summarize.model,
            };
          }
          const summarizerProvider = createProvider(summarizerProviderName, summarizerConfig);
          summarizer = new ContextSummarizer(summarizerProvider, {
            maxTokens: config.localContext.summarize.targetTokens,
            temperature: summarizerTemperature,
            logger,
          });
        }

        const contextManager = new ContextManager({
          config: config.localContext,
          store,
          redactor,
          summarizer,
          logger,
          charPerToken: config.cost.charPerToken,
        });
        const laneScope: Omit<LaneScope, "role" | "ephemeral"> = {
          jobId: config.jobId ?? config.commandRunId,
          runId,
          taskId: config.taskId,
          taskKey: config.taskKey,
        };
        const deepMode = Boolean(config.deepInvestigation?.enabled);
        const contextAssembler = new ContextAssembler(docdexClient, {
          workspaceRoot: config.workspaceRoot,
          queryProvider: librarianProvider,
          queryTemperature: librarianRoute?.temperature,
          agentId: profileAgentId,
          maxFiles: config.context.maxFiles,
          maxTotalBytes: config.context.maxTotalBytes,
          tokenBudget: config.context.tokenBudget,
          includeRepoMap: config.context.includeRepoMap,
          includeImpact: config.context.includeImpact,
          includeSnippets: config.context.includeSnippets,
          readStrategy: config.context.readStrategy,
          focusMaxFileBytes: config.context.focusMaxFileBytes,
          peripheryMaxBytes: config.context.peripheryMaxBytes,
          skeletonizeLargeFiles: config.context.skeletonizeLargeFiles,
          serializationMode: config.context.mode,
          redactSecrets: config.context.redactSecrets,
          redactPatterns: config.security.redactPatterns,
          ignoreFilesFrom: config.context.ignoreFilesFrom,
          preferredFiles: config.context.preferredFiles,
          recentFiles: config.context.recentFiles,
          readOnlyPaths: config.security.readOnlyPaths,
          allowDocEdits: config.security.allowDocEdits,
          deepMode,
          contextManager,
          laneScope,
          onEvent: streamState.onEvent,
          logger,
        });
        const deepScanPreset = Boolean(
          config.deepInvestigation?.enabled && config.deepInvestigation?.deepScanPreset,
        );
        if (deepScanPreset) {
          contextAssembler.applyDeepScanPreset();
        }
        const preflightContext = await contextAssembler.assemble(taskInput);
        const pricingResolution = resolvePricing(
          config.cost.pricingOverrides,
          builderRoute.provider,
          builderRoute.config.model,
        );
        pricingSpec = pricingResolution.pricing;
        pricingSource = pricingResolution.source;
        const summary = summarizeContext(preflightContext, taskInput);
        estimatedFocus = summary.focusCount;
        estimatedPeriphery = summary.peripheryCount;
        const estimate = estimateCostFromChars(
          summary.charCount,
          config.cost.charPerToken,
          pricingSpec,
          pricingSource,
        );
        estimatedCost = estimate.estimatedCost;
        estimatedTokens = estimate.estimatedTotalTokens;
        estimatedChars = estimate.charCount;
        await logger.log("cost_estimate", {
          provider: builderRoute.provider,
          model: builderRoute.config.model,
          focusCount: estimatedFocus,
          peripheryCount: estimatedPeriphery,
          charCount: estimatedChars,
          estimatedTokens,
          estimatedCost,
          pricingSource,
        });
        process.stderr.write(
          `[codali] Preflight: focus=${estimatedFocus} periphery=${estimatedPeriphery} ` +
            `chars=${estimatedChars} tokens~${estimatedTokens} est_cost=${formatCost(estimatedCost)}\n`,
        );
        if (estimatedCost !== undefined && estimatedCost > config.cost.maxCostPerRun) {
          const proceed = await confirmOverage(
            `Estimated cost ${formatCost(estimatedCost)} exceeds max ${formatCost(config.cost.maxCostPerRun)}. Continue? [y/N] `,
          );
          if (!proceed) {
            throw new Error("Run cancelled due to cost limit");
          }
        }
        const architectPlanner = new ArchitectPlanner(architectProvider, {
          temperature: architectRoute.temperature,
          logger,
          model: architectRoute.config.model,
          // Architect is intentionally plain-text first; avoid hard response-format constraints.
          responseFormat: undefined,
          planHint: config.planHint,
          stream: config.streaming.enabled,
          onEvent: streamState.onEvent,
        });
        const builderResponseFormat =
          builderRoute.responseFormat ?? (config.builder.mode === "patch_json" ? { type: "json" } : undefined);
        const patchValidator = createPatchValidator(
          config.workspaceRoot,
          config.tools.allowShell ?? false,
          config.tools.shellAllowlist ?? [],
        );
        const needsPatchApplier =
          config.builder.mode === "patch_json" || config.builder.mode === "freeform" || config.builder.mode === "tool_calls";
        const patchApplier = needsPatchApplier
          ? new PatchApplier({ workspaceRoot: config.workspaceRoot, validateFile: patchValidator })
          : undefined;
        const wantsInterpreter =
          config.builder.mode === "freeform" || config.builder.fallbackToInterpreter === true;
        const interpreterRoute = wantsInterpreter
          ? resolveInterpreterRoute(config, phaseRoutes)
          : undefined;
        const interpreterProvider = interpreterRoute
          ? createProvider(interpreterRoute.provider, {
              ...interpreterRoute.config,
              timeoutMs:
                config.interpreter.timeoutMs ??
                interpreterRoute.config.timeoutMs ??
                config.limits.timeoutMs,
            })
          : undefined;
        const interpreterResponseFormat: ProviderResponseFormat = config.interpreter.format
          ? {
              type: config.interpreter.format as ProviderResponseFormat["type"],
              grammar: config.interpreter.grammar,
            }
          : { type: "json" };
        const patchInterpreter =
          interpreterProvider && wantsInterpreter
            ? new PatchInterpreter({
                provider: interpreterProvider,
                patchFormat: config.builder.patchFormat,
                responseFormat: interpreterResponseFormat,
                maxRetries: config.interpreter.maxRetries,
                timeoutMs: config.interpreter.timeoutMs,
                logger,
                model: interpreterRoute?.config.model,
                temperature: interpreterRoute?.temperature,
              })
            : undefined;
        const builderRunner = new BuilderRunner({
          provider: builderProvider,
          tools: registry,
          context: toolContext,
          maxSteps: config.limits.maxSteps,
          maxToolCalls: config.limits.maxToolCalls,
          maxTokens: config.limits.maxTokens,
          timeoutMs: config.limits.timeoutMs,
          temperature: builderRoute.temperature,
          responseFormat: builderResponseFormat,
          mode: config.builder.mode,
          patchFormat: config.builder.patchFormat,
          patchApplier,
          interpreter: patchInterpreter,
          fallbackToInterpreter: config.builder.fallbackToInterpreter ?? false,
          stream: config.streaming.enabled,
          onEvent: streamState.onEvent,
          onToken: streamState.onToken,
          streamFlushMs: config.streaming.flushEveryMs,
          logger,
          model: builderRoute.config.model,
        });
        const validator = new ValidationRunner({
          allowShell: config.tools.allowShell ?? false,
          shellAllowlist: config.tools.shellAllowlist ?? [],
          workspaceRoot: config.workspaceRoot,
          docdexClient,
        });
        const criticEvaluator = new CriticEvaluator(validator, { model: criticRoute.config.model });
        const memoryWriteback = new MemoryWriteback(docdexClient, { agentId: profileAgentId });
        const phaseFallbackCounts: Partial<Record<PipelinePhase, number>> = {};
        const maxPhaseFallbacks = 3;
        const recoverPhaseProvider = async (
          input: { phase: PipelinePhase; attempt: number; error: Error },
        ): Promise<{ switched: boolean; note?: string }> => {
          if (!shouldSelectAgents) return { switched: false };
          const phase = input.phase;
          const currentSelection = phaseSelections[phase];
          const currentResolved = currentSelection.resolved;
          if (!currentResolved) return { switched: false };
          const currentAgentId = currentResolved.agent.id;
          if (!currentAgentId) return { switched: false };
          const fallbackCount = phaseFallbackCounts[phase] ?? 0;
          if (fallbackCount >= maxPhaseFallbacks) {
            await logger.log("phase_agent_fallback_skipped", {
              phase,
              reason: "fallback_limit_reached",
              limit: maxPhaseFallbacks,
              error: input.error.message,
            });
            return { switched: false };
          }
          const excluded = Array.from(
            new Set([...(phaseExclusions[phase] ?? []), currentAgentId]),
          );
          phaseExclusions[phase] = excluded;
          let currentExcluded = excluded;
          const evaluatedAgentIds = new Set<string>();
          let reselection: Record<PipelinePhase, PhaseAgentSelection> | undefined;
          let nextSelection: PhaseAgentSelection | undefined;
          let nextResolved = undefined as typeof currentResolved | undefined;
          let selectedBuilderMode = config.builder.mode;
          while (true) {
            reselection = await selectPhaseAgents({
              overrides: phaseOverrides,
              builderMode: config.builder.mode,
              fallbackAgent: resolvedAgent,
              allowCloudModels: config.security.allowCloudModels,
              excludeAgentIds: {
                ...phaseExclusions,
                [phase]: currentExcluded,
              },
            });
            nextSelection = reselection[phase];
            nextResolved = nextSelection.resolved;
            if (!nextResolved || nextResolved.agent.id === currentAgentId) {
              await logger.log("phase_agent_fallback_skipped", {
                phase,
                reason: "no_alternate_agent",
                currentAgentId,
                excluded: currentExcluded,
                error: input.error.message,
              });
              return { switched: false };
            }
            const nextAgentId = nextResolved.agent.id;
            if (evaluatedAgentIds.has(nextAgentId)) {
              await logger.log("phase_agent_fallback_skipped", {
                phase,
                reason: "no_eligible_alternate_agent",
                currentAgentId,
                excluded: currentExcluded,
                error: input.error.message,
              });
              return { switched: false };
            }
            evaluatedAgentIds.add(nextAgentId);
            const suitability = assessPhaseFallbackSuitability(
              phase,
              config.builder.mode,
              {
                capabilities: nextSelection.capabilities,
                supportsTools: nextResolved.agent.supportsTools ?? false,
              },
            );
            if (suitability.ok) {
              selectedBuilderMode = suitability.builderMode ?? config.builder.mode;
              break;
            }
            currentExcluded = Array.from(new Set([...currentExcluded, nextAgentId]));
            phaseExclusions[phase] = currentExcluded;
            await logger.log("phase_agent_fallback_rejected", {
              phase,
              reason: suitability.reason,
              agentId: nextAgentId,
              agentSlug: nextResolved.agent.slug,
              currentAgentId,
              excluded: currentExcluded,
              details: suitability.details ?? null,
              error: input.error.message,
            });
          }
          phaseExclusions[phase] = currentExcluded;
          if (!reselection || !nextSelection || !nextResolved) {
            await logger.log("phase_agent_fallback_skipped", {
              phase,
              reason: "reselection_failed",
              currentAgentId,
              excluded: currentExcluded,
              error: input.error.message,
            });
            return { switched: false };
          }
          phaseSelections = reselection;
          phaseFallbackCounts[phase] = fallbackCount + 1;
          const phaseDefaults = {
            provider: nextResolved.provider,
            config: {
              model: nextResolved.model,
              apiKey: nextResolved.apiKey,
              baseUrl: nextResolved.baseUrl,
              timeoutMs: config.limits.timeoutMs,
            },
          };
          const nextRoute = buildRoutedProvider(
            phase,
            phaseDefaults,
            config.routing,
            true,
          );
          if (phase === "builder") {
            const priorBuilderMode = config.builder.mode;
            if (selectedBuilderMode !== priorBuilderMode) {
              config.builder.mode = selectedBuilderMode;
              await logger.log("phase_agent_fallback_mode_change", {
                phase,
                fromMode: priorBuilderMode,
                toMode: selectedBuilderMode,
                reason: "fallback_suitability",
              });
            }
            const nextProvider = createProvider(nextRoute.provider, nextRoute.config);
            const nextResponseFormat =
              nextRoute.responseFormat
              ?? (config.builder.mode === "patch_json" ? { type: "json" } : undefined);
            builderRunner.setProvider(nextProvider, {
              model: nextRoute.config.model,
              temperature: nextRoute.temperature,
              responseFormat: nextResponseFormat,
              mode: config.builder.mode,
            });
          }
          await logger.log("phase_agent_selected", {
            phase,
            agentId: nextResolved.agent.id,
            agentSlug: nextResolved.agent.slug,
            provider: nextResolved.provider,
            model: nextResolved.model,
            source: "fallback",
            reason: `provider_failure_recovery:${input.error.message}`,
          });
          await logger.log("phase_agent_fallback", {
            phase,
            fromAgentId: currentAgentId,
            toAgentId: nextResolved.agent.id,
            attempt: input.attempt,
            fallback_count: phaseFallbackCounts[phase],
            error: input.error.message,
          });
          return {
            switched: true,
            note:
              `Provider failure (${input.error.message}). ` +
              `Switched ${phase} agent to ${nextResolved.agent.slug ?? nextResolved.agent.id}; continue with current plan.`,
          };
        };
        const pipeline = new SmartPipeline({
          contextAssembler,
          initialContext: preflightContext,
          architectPlanner,
          builderRunner,
          criticEvaluator,
          memoryWriteback,
          maxRetries: config.limits.maxRetries,
          maxContextRefreshes: config.context.maxContextRefreshes,
          fastPath: undefined,
          deepMode,
          deepScanPreset,
          deepInvestigation: config.deepInvestigation,
          getTouchedFiles: () => runContext.getTouchedFiles(),
          logger,
          contextManager,
          laneScope,
          onEvent: streamState.onEvent,
          onPhaseProviderFailure: recoverPhaseProvider,
        });

        const result = await pipeline.run(taskInput);
        for (const file of result.builderResult.touchedFiles ?? []) {
          runContext.recordTouchedFile(file);
        }
        if (result.criticResult.status !== "PASS") {
          const failureReasons = result.criticResult.reasons?.length
            ? result.criticResult.reasons
            : ["smart_pipeline_failed"];
          await logger.log("run_failed", {
            stage: "smart_pipeline",
            reasons: failureReasons,
            retryable: result.criticResult.retryable ?? null,
            report: result.criticResult.report ?? null,
          });
          throw new Error(`Smart pipeline failed: ${failureReasons.join("; ")}`);
        }
        finalMessageContent = result.builderResult.finalMessage.content;
        usage = result.builderResult.usage;
        toolCallsExecuted = result.builderResult.toolCallsExecuted;
      } else {
        const pricingResolution = resolvePricing(
          config.cost.pricingOverrides,
          config.provider,
          config.model,
        );
        pricingSpec = pricingResolution.pricing;
        pricingSource = pricingResolution.source;
        const summary = summarizeContext(undefined, taskInput);
        estimatedFocus = summary.focusCount;
        estimatedPeriphery = summary.peripheryCount;
        const estimate = estimateCostFromChars(
          summary.charCount,
          config.cost.charPerToken,
          pricingSpec,
          pricingSource,
        );
        estimatedCost = estimate.estimatedCost;
        estimatedTokens = estimate.estimatedTotalTokens;
        estimatedChars = estimate.charCount;
        await logger.log("cost_estimate", {
          provider: config.provider,
          model: config.model,
          focusCount: estimatedFocus,
          peripheryCount: estimatedPeriphery,
          charCount: estimatedChars,
          estimatedTokens,
          estimatedCost,
          pricingSource,
        });
        process.stderr.write(
          `[codali] Preflight: focus=${estimatedFocus} periphery=${estimatedPeriphery} ` +
            `chars=${estimatedChars} tokens~${estimatedTokens} est_cost=${formatCost(estimatedCost)}\n`,
        );
        if (estimatedCost !== undefined && estimatedCost > config.cost.maxCostPerRun) {
          const proceed = await confirmOverage(
            `Estimated cost ${formatCost(estimatedCost)} exceeds max ${formatCost(config.cost.maxCostPerRun)}. Continue? [y/N] `,
          );
          if (!proceed) {
            throw new Error("Run cancelled due to cost limit");
          }
        }
        const provider = createProvider(config.provider, {
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeoutMs: config.limits.timeoutMs,
        });

        const runner = new Runner({
          provider,
          tools: registry,
          context: toolContext,
          maxSteps: config.limits.maxSteps,
          maxToolCalls: config.limits.maxToolCalls,
          maxTokens: config.limits.maxTokens,
          timeoutMs: config.limits.timeoutMs,
          stream: config.streaming.enabled,
          onEvent: streamState.onEvent,
          onToken: streamState.onToken,
          streamFlushMs: config.streaming.flushEveryMs,
          logger,
        });

        const result = await runner.run([{ role: "user", content: taskInput }]);
        finalMessageContent = result.finalMessage.content;
        usage = result.usage;
        toolCallsExecuted = result.toolCallsExecuted;
      }

      streamState.flush();
      if (streamState.didStream()) {
        if (!finalMessageContent.endsWith("\n")) {
          process.stdout.write("\n");
          streamState.writeOutput("\n");
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(finalMessageContent);
        streamState.writeOutput(`${finalMessageContent}\n`);
      }
      const actualCost = estimateCostFromUsage(usage, pricingSpec);
      await logger.log("run_summary", {
        toolCallsExecuted,
        touchedFiles: runContext.getTouchedFiles(),
        durationMs: Date.now() - runContext.startedAt,
        usage,
        costEstimate: {
          charCount: estimatedChars,
          estimatedTokens,
          estimatedCost,
          pricingSource,
        },
        actualCost,
        command: config.command,
        commandRunId: config.commandRunId,
        jobId: config.jobId,
        project: config.project,
        taskId: config.taskId,
        taskKey: config.taskKey,
        agentId: config.agentId,
        agentSlug: config.agentSlug,
        smart: config.smart ?? false,
      });
      const meta = {
        runId,
        logPath: logger.logPath,
        outputLogPath,
        touchedFiles: runContext.getTouchedFiles(),
        command: config.command,
        commandRunId: config.commandRunId,
        jobId: config.jobId,
        project: config.project,
        taskId: config.taskId,
        taskKey: config.taskKey,
        agentId: config.agentId,
        agentSlug: config.agentSlug,
      };
      try {
        process.stderr.write(`CODALI_RUN_META ${JSON.stringify(meta)}\n`);
      } catch {
        // ignore stderr write failures
      }
    } finally {
      outputStream.end();
      unregisterSignals();
      await lock.release();
    }
  }
}
