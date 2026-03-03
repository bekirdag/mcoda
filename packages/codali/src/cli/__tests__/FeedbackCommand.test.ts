import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryWritebackInput } from "../../cognitive/MemoryWriteback.js";
import type { CodaliConfig } from "../../config/Config.js";
import { FeedbackCommand } from "../FeedbackCommand.js";

const makeConfig = (): CodaliConfig =>
  ({
    workspaceRoot: process.cwd(),
    provider: "stub",
    model: "stub-model",
    apiKey: undefined,
    baseUrl: undefined,
    routing: undefined,
    docdex: {
      baseUrl: "http://127.0.0.1:28491",
    },
    limits: {
      maxSteps: 10,
      maxToolCalls: 20,
      maxRetries: 3,
      timeoutMs: 60_000,
    },
    tools: {},
    context: {
      mode: "bundle_text",
      maxFiles: 8,
      maxTotalBytes: 10_000,
      tokenBudget: 10_000,
      focusMaxFileBytes: 4000,
      peripheryMaxBytes: 2000,
      includeRepoMap: true,
      includeImpact: true,
      includeSnippets: true,
      readStrategy: "docdex",
      maxContextRefreshes: 1,
      skeletonizeLargeFiles: true,
      redactSecrets: true,
      ignoreFilesFrom: [],
    },
    security: {
      redactPatterns: [],
      readOnlyPaths: [],
      allowDocEdits: false,
      allowCloudModels: false,
    },
    builder: {
      mode: "patch_json",
      patchFormat: "search_replace",
      fallbackToInterpreter: true,
    },
    interpreter: {
      provider: "auto",
      model: "auto",
      format: "json",
      maxRetries: 1,
      timeoutMs: 60_000,
    },
    streaming: {
      enabled: true,
      flushEveryMs: 250,
    },
    cost: {
      maxCostPerRun: 1,
      charPerToken: 4,
      pricingOverrides: {},
    },
    localContext: {
      enabled: false,
      storageDir: "codali/context",
      persistToolMessages: false,
      maxMessages: 100,
      maxBytesPerLane: 10000,
      modelTokenLimits: {},
      summarize: {
        enabled: false,
        provider: "librarian",
        targetTokens: 500,
        thresholdPct: 0.9,
      },
    },
    eval: {
      report_dir: "logs/codali/eval",
      gates: {
        patch_apply_drop_max: 0.2,
        verification_pass_rate_min: 0.5,
        hallucination_rate_max: 0.5,
        scope_violation_rate_max: 0.5,
      },
    },
    learning: {
      persistence_min_confidence: 0.45,
      enforcement_min_confidence: 0.85,
      require_confirmation_for_low_confidence: true,
      auto_enforce_high_confidence: true,
      candidate_store_file: "logs/codali/learning-rules.json",
    },
    logging: {
      directory: "logs/codali",
    },
  }) as CodaliConfig;

test("FeedbackCommand requires --file or --confirm", { concurrency: false }, async () => {
  await assert.rejects(async () => {
    await FeedbackCommand.run([], {
      loadConfig: async () => makeConfig(),
    });
  }, /Usage: codali learn/);
});

test("FeedbackCommand returns non-zero when promotion contains rejections", {
  concurrency: false,
}, async () => {
  await assert.rejects(async () => {
    await FeedbackCommand.run(["--confirm", "profile_memory::constraint::do not use moment.js"], {
      loadConfig: async () => makeConfig(),
      createMemoryWriteback: () => ({
        persist: async () => ({
          outcomes: [
            {
              status: "rejected",
              code: "candidate_not_found",
              message: "No candidate",
            },
          ],
          ledgerPath: "x",
        }),
      }),
      log: () => {},
    });
  }, /One or more promotions failed/);
});

test("FeedbackCommand prints no_change result without persistence", { concurrency: false }, async () => {
  let persisted = false;
  const logs: string[] = [];
  await FeedbackCommand.run(["--file", "src/index.ts"], {
    loadConfig: async () => makeConfig(),
    createProvider: () => ({ name: "stub", generate: async () => ({ message: { role: "assistant", content: "" } }) }) as never,
    createAnalyzer: () => ({
      analyze: async () => ({
        runId: "run-1",
        status: "no_change",
        message: "No meaningful user deviation detected; no rule persisted.",
        rules: [],
        evidence: [],
      }),
    }),
    createMemoryWriteback: () => ({
      persist: async () => {
        persisted = true;
        return { outcomes: [], ledgerPath: "x" };
      },
    }),
    log: (line) => logs.push(line),
  });
  assert.equal(persisted, false);
  assert.ok(logs.some((line) => line.includes("No rule persisted")));
});

test("FeedbackCommand persists extracted rule outcomes", { concurrency: false }, async () => {
  const logs: string[] = [];
  const calls: MemoryWritebackInput[] = [];
  await FeedbackCommand.run(["--file", "src/index.ts"], {
    loadConfig: async () => makeConfig(),
    createProvider: () => ({ name: "stub", generate: async () => ({ message: { role: "assistant", content: "" } }) }) as never,
    createAnalyzer: () => ({
      analyze: async () => ({
        runId: "run-2",
        status: "rule_extracted",
        message: "Extracted post-mortem learning rule.",
        rule: "Do not use moment.js",
        evidence: [{ kind: "run", ref: "run-2" }],
        rules: [
          {
            category: "constraint",
            content: "Do not use moment.js",
            source: "post_mortem_inferred_rule",
            scope: "profile_memory",
            confidence_score: 0.7,
            confidence_band: "medium",
            confidence_reasons: ["post_mortem_source"],
            evidence: [{ kind: "run", ref: "run-2" }],
          },
        ],
      }),
    }),
    createMemoryWriteback: () => ({
      persist: async (input: MemoryWritebackInput) => {
        calls.push(input);
        return {
          outcomes: [
            {
              status: "accepted",
              code: "accepted_candidate",
              message: "Rule accepted as candidate.",
              dedupe_key: "profile_memory::constraint::do not use moment.js",
            },
          ],
          ledgerPath: "x",
        };
      },
    }),
    log: (line) => logs.push(line),
  });
  assert.equal(calls.length, 1);
  assert.ok(logs.some((line) => line.includes("Extracted rule")));
  assert.ok(logs.some((line) => line.includes("accepted=1")));
});
