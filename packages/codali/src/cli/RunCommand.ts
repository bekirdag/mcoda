import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { loadConfig } from "../config/ConfigLoader.js";
import type { ToolConfig } from "../config/Config.js";
import { createProvider } from "../providers/ProviderRegistry.js";
import type { Provider, ProviderConfig, ProviderRequest, ProviderResponse } from "../providers/ProviderTypes.js";
import { OpenAiCompatibleProvider } from "../providers/OpenAiCompatibleProvider.js";
import { OllamaRemoteProvider } from "../providers/OllamaRemoteProvider.js";
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
import { SmartPipeline } from "../cognitive/SmartPipeline.js";
import { buildRoutedProvider, type PipelinePhase } from "../cognitive/ProviderRouting.js";
import type { ContextBundle, LaneScope } from "../cognitive/Types.js";
import { ContextManager } from "../cognitive/ContextManager.js";
import { ContextStore } from "../cognitive/ContextStore.js";
import { ContextSummarizer } from "../cognitive/ContextSummarizer.js";
import { ContextRedactor } from "../cognitive/ContextRedactor.js";
import { estimateCostFromChars, estimateCostFromUsage, resolvePricing } from "../cognitive/CostEstimator.js";
import { getGlobalWorkspaceDir } from "../runtime/StoragePaths.js";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  command?: string;
  commandRunId?: string;
  jobId?: string;
  runId?: string;
  taskId?: string;
  taskKey?: string;
  agentId?: string;
  agentSlug?: string;
  smart?: boolean;
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
  builderMode?: "tool_calls" | "patch_json";
  builderPatchFormat?: "search_replace" | "file_writes";
  streamingEnabled?: boolean;
  streamingFlushMs?: number;
  costMaxPerRun?: number;
  costCharPerToken?: number;
  costPricingOverrides?: string;
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
    if (arg === "--smart") {
      parsed.smart = true;
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
      if (next === "tool_calls" || next === "patch_json") parsed.builderMode = next;
      i += 1;
      continue;
    }
    if (arg === "--builder-patch-format" && next) {
      if (next === "search_replace" || next === "file_writes") parsed.builderPatchFormat = next;
      i += 1;
      continue;
    }
    if (arg === "--streaming-enabled" && next) {
      parsed.streamingEnabled = parseBooleanArg(next);
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
  }
  return parsed;
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

const createStreamState = (enabled: boolean, flushEveryMs: number) => {
  let buffer = "";
  let lastFlush = Date.now();
  let didStream = false;
  const flush = () => {
    if (buffer.length > 0) {
      process.stdout.write(buffer);
      buffer = "";
    }
    lastFlush = Date.now();
  };
  const onToken = enabled
    ? (token: string) => {
        didStream = true;
        buffer += token;
        const now = Date.now();
        if (now - lastFlush >= flushEveryMs) {
          flush();
        }
      }
    : undefined;
  return {
    onToken,
    flush,
    didStream: () => didStream,
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
  value === "librarian" || value === "architect" || value === "builder" || value === "critic";

export const isToolEnabled = (name: string, tools: ToolConfig): boolean => {
  if (name === "run_shell" && !tools.allowShell) {
    return false;
  }
  const enabled = tools.enabled?.length ? new Set(tools.enabled) : undefined;
  if (!enabled) return true;
  return enabled.has(name);
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
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
    if (request.responseFormat?.type === "json") {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            steps: ["1. Apply change"],
            target_files: ["src/index.ts"],
            risk_assessment: "low",
            verification: [],
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
    registerProvider("stub", () => new StubProvider());
  } catch {
    // ignore duplicate registrations
  }
};

export class RunCommand {
  static async run(argv: string[]): Promise<void> {
    registerBuiltins();
    const parsed = parseArgs(argv);

    const cliConfig: Record<string, unknown> = {};
    if (parsed.workspaceRoot) cliConfig.workspaceRoot = parsed.workspaceRoot;
    if (parsed.project) cliConfig.project = parsed.project;
    if (parsed.command) cliConfig.command = parsed.command;
    if (parsed.commandRunId) cliConfig.commandRunId = parsed.commandRunId;
    if (parsed.jobId) cliConfig.jobId = parsed.jobId;
    if (parsed.runId) cliConfig.runId = parsed.runId;
    if (parsed.taskId) cliConfig.taskId = parsed.taskId;
    if (parsed.taskKey) cliConfig.taskKey = parsed.taskKey;
    if (parsed.agentId) cliConfig.agentId = parsed.agentId;
    if (parsed.agentSlug) cliConfig.agentSlug = parsed.agentSlug;
    if (parsed.smart !== undefined) cliConfig.smart = parsed.smart;
    if (parsed.provider) cliConfig.provider = parsed.provider;
    if (parsed.model) cliConfig.model = parsed.model;
    if (parsed.apiKey) cliConfig.apiKey = parsed.apiKey;
    if (parsed.baseUrl) cliConfig.baseUrl = parsed.baseUrl;

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

    const streamingOverrides: Record<string, unknown> = {};
    if (parsed.streamingEnabled !== undefined) streamingOverrides.enabled = parsed.streamingEnabled;
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

    const config = await loadConfig({
      cli: cliConfig,
      configPath: parsed.configPath,
    });

    const taskInput = parsed.taskFile ? await readFile(parsed.taskFile, "utf8") : await readStdin();
    if (!taskInput.trim()) {
      throw new Error("Task input is empty; provide --task <file> or pass text via stdin.");
    }

    const runId = config.runId ?? randomUUID();
    const runContext = new RunContext(runId, config.workspaceRoot);
    const storageRoot = getGlobalWorkspaceDir(config.workspaceRoot);
    const lock = new WorkspaceLock(storageRoot, runId);
    await lock.acquire();
    const logger = new RunLogger(storageRoot, config.logging.directory, runId);
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
      });
      for (const tool of createDocdexTools(docdexClient)) registerIfEnabled(tool);

      const toolContext = {
        workspaceRoot: config.workspaceRoot,
        recordTouchedFile: (filePath: string) => runContext.recordTouchedFile(filePath),
        allowOutsideWorkspace: config.tools.allowOutsideWorkspace,
        allowShell: config.tools.allowShell,
        shellAllowlist: config.tools.shellAllowlist,
      };
      const streamState = createStreamState(config.streaming.enabled, config.streaming.flushEveryMs);

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
        const defaults = {
          provider: config.provider,
          config: {
            model: config.model,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            timeoutMs: config.limits.timeoutMs,
          },
        };

        const librarianRoute = config.routing?.librarian
          ? buildRoutedProvider("librarian", defaults, config.routing)
          : undefined;
        const librarianProvider = librarianRoute
          ? createProvider(librarianRoute.provider, librarianRoute.config)
          : undefined;
        const architectRoute = buildRoutedProvider("architect", defaults, config.routing);
        const builderRoute = buildRoutedProvider("builder", defaults, config.routing);
        const criticRoute = buildRoutedProvider("critic", defaults, config.routing);

        const architectProvider = createProvider(architectRoute.provider, architectRoute.config);
        const builderProvider = createProvider(builderRoute.provider, builderRoute.config);

        const profileAgentId = config.agentId ?? config.agentSlug;
        let contextManager: ContextManager | undefined;
        let laneScope: Omit<LaneScope, "role" | "ephemeral"> | undefined;
        if (config.localContext.enabled) {
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
          if (config.localContext.summarize.enabled) {
            const providerKey = config.localContext.summarize.provider;
            let summarizerProviderName = providerKey;
            let summarizerConfig: ProviderConfig = { ...defaults.config };
            let summarizerTemperature: number | undefined;
            if (isPhaseProvider(providerKey)) {
              const route = buildRoutedProvider(providerKey, defaults, config.routing);
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

          contextManager = new ContextManager({
            config: config.localContext,
            store,
            redactor,
            summarizer,
            logger,
            charPerToken: config.cost.charPerToken,
          });
          laneScope = {
            jobId: config.jobId ?? config.commandRunId,
            runId,
            taskId: config.taskId,
            taskKey: config.taskKey,
          };
        }
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
          contextManager,
          laneScope,
        });
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
          responseFormat: architectRoute.responseFormat ?? { type: "json" },
        });
        const builderResponseFormat =
          builderRoute.responseFormat ?? (config.builder.mode === "patch_json" ? { type: "json" } : undefined);
        const patchValidator = createPatchValidator(
          config.workspaceRoot,
          config.tools.allowShell ?? false,
          config.tools.shellAllowlist ?? [],
        );
        const patchApplier =
          config.builder.mode === "patch_json"
            ? new PatchApplier({ workspaceRoot: config.workspaceRoot, validateFile: patchValidator })
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
          stream: config.streaming.enabled,
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
        const pipeline = new SmartPipeline({
          contextAssembler,
          initialContext: preflightContext,
          architectPlanner,
          builderRunner,
          criticEvaluator,
          memoryWriteback,
          maxRetries: config.limits.maxRetries,
          maxContextRefreshes: config.context.maxContextRefreshes,
          fastPath: isTrivialRequest,
          getTouchedFiles: () => runContext.getTouchedFiles(),
          logger,
          contextManager,
          laneScope,
        });

        const result = await pipeline.run(taskInput);
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
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(finalMessageContent);
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
      await lock.release();
    }
  }
}
