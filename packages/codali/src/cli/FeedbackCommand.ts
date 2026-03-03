import path from "node:path";
import process from "node:process";
import { MemoryWriteback, type LearningWriteOutcome } from "../cognitive/MemoryWriteback.js";
import { PostMortemAnalyzer } from "../cognitive/PostMortemAnalyzer.js";
import type { CodaliConfig } from "../config/Config.js";
import { loadConfig } from "../config/ConfigLoader.js";
import { DocdexClient } from "../docdex/DocdexClient.js";
import { createProvider } from "../providers/ProviderRegistry.js";
import type { Provider } from "../providers/ProviderTypes.js";
import { resolveWorkspaceRoot } from "./RunCommand.js";

const USAGE =
  "Usage: codali learn --file <path/to/file> [--confirm <dedupe_key> ...]\n"
  + "   or: codali learn --confirm <dedupe_key> [--confirm <dedupe_key> ...]";

class FeedbackCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "FeedbackCommandError";
    this.exitCode = exitCode;
  }
}

interface ParsedFeedbackArgs {
  filePath?: string;
  confirmKeys: string[];
}

interface FeedbackCommandDependencies {
  cwd?: () => string;
  loadConfig?: (options: { cwd: string }) => Promise<CodaliConfig>;
  createDocdexClient?: (config: CodaliConfig) => DocdexClient;
  createProvider?: typeof createProvider;
  createMemoryWriteback?: (
    client: DocdexClient,
    options: ConstructorParameters<typeof MemoryWriteback>[1],
  ) => Pick<MemoryWriteback, "persist">;
  createAnalyzer?: (provider: Provider, workspaceRoot: string) => Pick<PostMortemAnalyzer, "analyze">;
  log?: (line: string) => void;
}

const parseArgs = (argv: string[]): ParsedFeedbackArgs => {
  const parsed: ParsedFeedbackArgs = { confirmKeys: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--file" && next) {
      parsed.filePath = next;
      index += 1;
      continue;
    }
    if (arg === "--confirm" && next) {
      parsed.confirmKeys.push(next);
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !parsed.filePath) {
      parsed.filePath = arg;
      continue;
    }
  }
  parsed.confirmKeys = Array.from(
    new Set(
      parsed.confirmKeys
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  return parsed;
};

const formatOutcome = (outcome: LearningWriteOutcome): string => {
  const key = outcome.dedupe_key ? ` (${outcome.dedupe_key})` : "";
  const score = outcome.confidence_score !== undefined
    ? ` score=${outcome.confidence_score.toFixed(2)}`
    : "";
  const lifecycle = outcome.lifecycle_state ? ` lifecycle=${outcome.lifecycle_state}` : "";
  return `- ${outcome.status}:${outcome.code}${key}${lifecycle}${score} - ${outcome.message}`;
};

const summarizeOutcomes = (outcomes: LearningWriteOutcome[]) => {
  const summary = {
    accepted: 0,
    promoted: 0,
    deferred: 0,
    suppressed: 0,
    rejected: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.status === "accepted") summary.accepted += 1;
    if (outcome.status === "promoted") summary.promoted += 1;
    if (outcome.status === "deferred") summary.deferred += 1;
    if (outcome.status === "suppressed") summary.suppressed += 1;
    if (outcome.status === "rejected") summary.rejected += 1;
  }
  return summary;
};

export class FeedbackCommand {
  static async run(argv: string[], deps: FeedbackCommandDependencies = {}): Promise<void> {
    const args = parseArgs(argv);
    if (!args.filePath && args.confirmKeys.length === 0) {
      throw new FeedbackCommandError(USAGE, 2);
    }

    const log = deps.log ?? ((line: string) => console.log(line)); // eslint-disable-line no-console
    const cwd = deps.cwd?.() ?? process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const configLoader = deps.loadConfig ?? loadConfig;
    const config = await configLoader({ cwd: workspaceRoot });
    const docdexClient = deps.createDocdexClient
      ? deps.createDocdexClient(config)
      : new DocdexClient({
        baseUrl: config.docdex.baseUrl,
        repoId: config.docdex.repoId,
        repoRoot: config.docdex.repoRoot ?? config.workspaceRoot,
      });
    const memoryWriteback = deps.createMemoryWriteback
      ? deps.createMemoryWriteback(docdexClient, {
        agentId: config.agentId ?? "codali",
        workspaceRoot,
        learning: config.learning,
      })
      : new MemoryWriteback(docdexClient, {
      agentId: config.agentId ?? "codali",
      workspaceRoot,
      learning: config.learning,
    });

    if (args.confirmKeys.length > 0) {
      const promotionResult = await memoryWriteback.persist({
        failures: 0,
        maxRetries: 0,
        lesson: "",
        promotions: args.confirmKeys.map((dedupe_key) => ({
          dedupe_key,
          agentId: config.agentId ?? "codali",
        })),
      });
      const promotionSummary = summarizeOutcomes(promotionResult.outcomes);
      log(`Promotion outcomes (${promotionResult.outcomes.length}):`);
      for (const outcome of promotionResult.outcomes) {
        log(formatOutcome(outcome));
      }
      log(
        `Summary: promoted=${promotionSummary.promoted} suppressed=${promotionSummary.suppressed} rejected=${promotionSummary.rejected}`,
      );
      if (promotionSummary.rejected > 0) {
        throw new FeedbackCommandError("One or more promotions failed.", 3);
      }
    }

    if (!args.filePath) {
      return;
    }

    const providerName = config.routing?.architect?.provider ?? config.provider;
    const providerModel = config.routing?.architect?.model ?? config.model;
    if (!providerName || !providerModel) {
      throw new FeedbackCommandError(
        "No provider/model configured. Use --provider/--model or configure codali.",
      );
    }
    const providerFactory = deps.createProvider ?? createProvider;
    const provider = providerFactory(providerName, {
      model: providerModel,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    const analyzer = deps.createAnalyzer
      ? deps.createAnalyzer(provider, workspaceRoot)
      : new PostMortemAnalyzer(provider, workspaceRoot);
    const absoluteFilePath = path.resolve(workspaceRoot, args.filePath);

    log(`Analyzing history for ${absoluteFilePath}...`);
    const analysis = await analyzer.analyze(absoluteFilePath);
    if (analysis.status === "no_change" || analysis.rules.length === 0) {
      log(`No rule persisted: ${analysis.message}`);
      return;
    }

    const writebackResult = await memoryWriteback.persist({
      failures: 0,
      maxRetries: config.limits.maxRetries,
      lesson: "",
      rules: analysis.rules,
    });
    const summary = summarizeOutcomes(writebackResult.outcomes);
    log(`Extracted rule: "${analysis.rule ?? analysis.rules[0]?.content ?? ""}"`);
    log(`Learning outcomes (${writebackResult.outcomes.length}):`);
    for (const outcome of writebackResult.outcomes) {
      log(formatOutcome(outcome));
    }
    log(
      `Summary: accepted=${summary.accepted} deferred=${summary.deferred} suppressed=${summary.suppressed} rejected=${summary.rejected}`,
    );
    if (summary.rejected > 0) {
      throw new FeedbackCommandError("Learning writeback failed for one or more rules.", 4);
    }
  }
}
