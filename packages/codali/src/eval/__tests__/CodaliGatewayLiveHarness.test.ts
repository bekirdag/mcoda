import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodaliGatewayLiveAgents,
  formatCodaliGatewayLiveHarnessTextReport,
  parseCodaliGatewayLiveInventory,
  redactCodaliGatewayLiveValue,
  runCodaliGatewayLiveHarness,
  type CodaliGatewayLiveCommandRunner,
  type CodaliGatewayLiveScenarioRunner,
} from "../CodaliGatewayLiveHarness.js";

const agent = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  adapter: "ollama-remote",
  defaultModel: "model",
  healthStatus: "healthy",
  rating: 7,
  reasoningRating: 7,
  capabilities: ["structured_output", "json_schema"],
  ...overrides,
});

const inventory = (): unknown[] => [
  agent({
    slug: "small-json",
    tier: "small",
    defaultModel: "tiny-json",
    supportsJsonSchema: true,
    contextWindow: 8_000,
  }),
  agent({
    slug: "medium-planner",
    tier: "medium",
    defaultModel: "medium-plan",
    supportsJsonSchema: true,
    supportsTools: true,
    contextWindow: 16_000,
    capabilities: ["structured_output", "json_schema", "tool_runner"],
  }),
  agent({
    slug: "medium-shadow",
    tier: "medium",
    defaultModel: "medium-shadow",
    supportsJsonSchema: true,
    supportsTools: true,
    rating: 5,
    reasoningRating: 5,
    costPerMillion: 0.25,
    contextWindow: 16_000,
    capabilities: ["structured_output", "json_schema", "tool_runner"],
  }),
  agent({
    slug: "large-final",
    tier: "large",
    defaultModel: "large-final",
    contextWindow: 64_000,
    reasoningRating: 9,
    capabilities: ["final_answer_synthesis"],
  }),
  agent({
    slug: "image-worker",
    tier: "image",
    defaultModel: "image-model",
    supportsImageGeneration: true,
    capabilities: ["image_generation", "text_to_image"],
  }),
];

test("classifyCodaliGatewayLiveAgents resolves small, medium, large, and image roles", () => {
  const result = classifyCodaliGatewayLiveAgents({
    inventory: inventory(),
    allowImageWorker: true,
  });

  assert.equal(result.roles.small_json.status, "assigned");
  assert.equal(result.roles.medium_planner.status, "assigned");
  assert.equal(result.roles.medium_verifier.status, "assigned");
  assert.equal(result.roles.large_final.agentSlug, "large-final");
  assert.equal(result.roles.image_worker.agentSlug, "image-worker");
  assert.equal(result.errors.length, 0);
});

test("runCodaliGatewayLiveHarness records passed live smoke results from an injected gateway runner", async () => {
  const runner: CodaliGatewayLiveScenarioRunner = async ({ scenario, assignment }) => ({
    id: scenario.id,
    label: scenario.label,
    status: "passed",
    role: scenario.role,
    agentSlug: assignment?.candidate.slug,
    tier: assignment?.candidate.tier,
    model: assignment?.candidate.model,
    adapter: assignment?.candidate.adapter,
    latencyMs: 12,
    jsonValid: scenario.expectsJson ? true : undefined,
    toolCallCount: scenario.requiresGatewayToolTelemetry ? 1 : 0,
    calledTools: scenario.requiresGatewayToolTelemetry ? ["docdex_search"] : [],
    finalAnswerStatus: scenario.id === "final_answer_large_model" ? "succeeded" : undefined,
    finalModelTier: scenario.id === "final_answer_large_model" ? "large" : undefined,
    finalModelAgentSlug: scenario.id === "final_answer_large_model" ? assignment?.candidate.slug : undefined,
    artifact: scenario.id === "image_generation"
      ? { kind: "image", uri: "artifact://image-1", mimeType: "image/png" }
      : undefined,
    warnings: [],
    errors: [],
  });

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    scenarioRunner: runner,
    allowImageWorker: true,
  });

  assert.equal(result.summary.status, "passed");
  assert.equal(result.summary.largeFinalSynthesizerOk, true);
  assert.equal(result.summary.imageArtifactOk, true);
  assert.ok(result.summary.jsonValidAgents.includes("small-json"));
  assert.ok(result.scenarios.some((scenario) => scenario.calledTools?.includes("docdex_search")));
  assert.equal(result.shadowComparison.status, "disabled");
  assert.equal(result.shadowComparison.records.length, 0);
});

test("runCodaliGatewayLiveHarness records policy-gated shadow comparison metrics", async () => {
  const seenAgents: string[] = [];
  const runner: CodaliGatewayLiveScenarioRunner = async ({ scenario, assignment }) => {
    seenAgents.push(assignment?.candidate.slug ?? "missing");
    const isShadow = assignment?.candidate.slug === "medium-shadow";
    return {
      id: scenario.id,
      label: scenario.label,
      status: isShadow ? "degraded" : "passed",
      role: scenario.role,
      agentSlug: assignment?.candidate.slug,
      tier: assignment?.candidate.tier,
      model: assignment?.candidate.model,
      adapter: assignment?.candidate.adapter,
      latencyMs: isShadow ? 2_000 : 1_000,
      jsonValid: true,
      toolCallCount: 1,
      calledTools: ["docdex_search"],
      warnings: isShadow ? ["shadow_quality_warning"] : [],
      errors: [],
      metadata: {
        usage: {
          inputTokens: isShadow ? 30 : 20,
          outputTokens: isShadow ? 15 : 10,
          totalTokens: isShadow ? 45 : 30,
        },
        costUsd: isShadow ? 0.00001125 : 0.00001,
        queue: { waitMs: isShadow ? 8 : 3, depth: isShadow ? 2 : 1, status: "ready" },
        throughput: { requestsPerMinute: 12 },
        localInference: {
          backend: "local-runtime",
          evalCount: isShadow ? 15 : 10,
        },
      },
    };
  };

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    scenarioRunner: runner,
    scenarios: ["docdex_encrypted_repo_search"],
    shadowComparison: {
      enabled: true,
      maxCandidatesPerScenario: 1,
    },
  });

  assert.deepEqual(seenAgents, ["medium-planner", "medium-shadow"]);
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.shadowComparison.status, "compared");
  assert.equal(result.shadowComparison.records.length, 2);
  const primary = result.shadowComparison.records.find((record) => record.primary);
  const shadow = result.shadowComparison.records.find((record) => !record.primary);
  assert.equal(primary?.agentSlug, "medium-planner");
  assert.equal(primary?.metrics.quality.score, 1);
  assert.equal(primary?.metrics.tokenUse?.totalTokens, 30);
  assert.equal(primary?.metrics.queue?.waitMs, 3);
  assert.equal(primary?.metrics.throughput?.tokensPerSecond, 10);
  assert.equal(primary?.metrics.failure.status, "none");
  assert.equal(primary?.metrics.localInference?.backend, "local-runtime");
  assert.equal(shadow?.agentSlug, "medium-shadow");
  assert.equal(shadow?.comparisonRole, "shadow");
  assert.equal(shadow?.candidateRank, 1);
  assert.equal(shadow?.metrics.quality.score, 0.5);
  assert.equal(shadow?.metrics.latencyMs, 2_000);
  assert.equal(shadow?.metrics.costUsd, 0.00001125);
  assert.equal(shadow?.metrics.tokenUse?.inputTokens, 30);
  assert.equal(shadow?.metrics.queue?.depth, 2);
  assert.equal(shadow?.metrics.throughput?.tokensPerSecond, 7.5);
  assert.equal(shadow?.metrics.failure.status, "degraded");
  assert.ok(shadow?.metrics.failure.reasons.includes("shadow_quality_warning"));
});

test("default mcoda agent-run runner preserves response metric metadata", async () => {
  const commandRunner: CodaliGatewayLiveCommandRunner = async () => ({
    stdout: JSON.stringify({
      responses: [
        {
          output: JSON.stringify({
            status: "ok",
            answer: "agentic orchestration gateway",
            json_valid: true,
          }),
          adapter: "ollama-remote",
          model: "stub",
          metadata: {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
            },
            costUsd: 0.00123,
            queue: { waitMs: 4, depth: 1, status: "ready" },
            throughput: { tokensPerSecond: 16 },
            localInference: {
              backend: "ollama",
              evalCount: 8,
              queue: { waitMs: 4 },
              throughput: { tokensPerSecond: 16 },
            },
          },
        },
      ],
    }),
    stderr: "",
    exitCode: 0,
    latencyMs: 500,
  });

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    commandRunner,
    scenarios: ["generic_question"],
    shadowComparison: { enabled: true },
  });

  const primary = result.shadowComparison.records.find((record) => record.primary);
  assert.equal(result.shadowComparison.status, "compared");
  assert.equal(primary?.metrics.tokenUse?.inputTokens, 12);
  assert.equal(primary?.metrics.tokenUse?.outputTokens, 8);
  assert.equal(primary?.metrics.tokenUse?.totalTokens, 20);
  assert.equal(primary?.metrics.costUsd, 0.00123);
  assert.equal(primary?.metrics.queue?.waitMs, 4);
  assert.equal(primary?.metrics.queue?.depth, 1);
  assert.equal(primary?.metrics.throughput?.tokensPerSecond, 16);
  assert.equal(primary?.metrics.localInference?.backend, "ollama");
  assert.equal(primary?.metrics.failure.status, "none");
});

test("default mcoda agent-run runner degrades gateway-tool scenarios without tool telemetry", async () => {
  const calls: string[][] = [];
  const commandRunner: CodaliGatewayLiveCommandRunner = async (command, args, options) => {
    calls.push([command, ...args]);
    const input = options.input ?? "";
    const output = input.includes("docdex_encrypted_repo_search")
      ? JSON.stringify({
          status: "needs_tool",
          selected_tools: ["docdex_search"],
          tenant_scoped: true,
        })
      : JSON.stringify({ status: "ok", answer: "agentic orchestration gateway" });
    return {
      stdout: JSON.stringify({
        responses: [{ output, adapter: "ollama-remote", model: "stub" }],
      }),
      stderr: "",
      exitCode: 0,
      latencyMs: 5,
    };
  };

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    commandRunner,
    scenarios: ["generic_question", "docdex_encrypted_repo_search"],
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(0, 3), ["mcoda", "agent-run", "small-json"]);
  assert.equal(result.scenarios[0]?.status, "passed");
  assert.equal(result.scenarios[1]?.status, "degraded");
  assert.ok(result.scenarios[1]?.warnings.includes("gateway_tool_telemetry_unavailable_with_agent_run"));
  assert.equal(result.summary.status, "degraded");
});

test("default mcoda agent-run runner degrades known model catalog mismatches", async () => {
  const commandRunner: CodaliGatewayLiveCommandRunner = async () => ({
    stdout: "",
    stderr: "OpenRouter error: 400 {\"error\":{\"message\":\"bad-model is not a valid model ID\"}}",
    exitCode: 1,
    latencyMs: 11,
  });

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    commandRunner,
    scenarios: ["generic_question"],
  });

  assert.equal(result.scenarios[0]?.status, "degraded");
  assert.ok(result.scenarios[0]?.warnings.includes("agent_run_model_catalog_mismatch"));
  assert.equal(
    result.scenarios[0]?.metadata?.failureClass,
    "agent_run_model_catalog_mismatch",
  );
  assert.ok(result.environmentWarnings.some((warning) =>
    warning.code === "GATEWAY_LIVE_AGENT_RUN_DEGRADED" &&
    warning.reason === "agent_run_model_catalog_mismatch"));
  assert.ok(result.warnings.includes("GATEWAY_LIVE_AGENT_RUN_DEGRADED"));
  assert.equal(result.summary.status, "degraded");
});

test("default mcoda agent-run runner degrades self-hosted upstream availability failures", async () => {
  const commandRunner: CodaliGatewayLiveCommandRunner = async () => ({
    stdout: "",
    stderr: "OpenAI chat completions failed (503): {\"error\":\"mswarm_error\",\"code\":\"upstream_error\",\"message\":\"Self-hosted node is not currently reachable\"}",
    exitCode: 1,
    latencyMs: 13,
  });

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    commandRunner,
    scenarios: ["generic_question"],
  });

  assert.equal(result.scenarios[0]?.status, "degraded");
  assert.ok(result.scenarios[0]?.warnings.includes("agent_run_upstream_unavailable"));
  assert.equal(
    result.scenarios[0]?.metadata?.failureClass,
    "agent_run_upstream_unavailable",
  );
  assert.ok(result.environmentWarnings.some((warning) =>
    warning.code === "GATEWAY_LIVE_AGENT_RUN_DEGRADED" &&
    warning.reason === "agent_run_upstream_unavailable" &&
    warning.role === "small_json" &&
    warning.agentSlug === "small-json" &&
    String(warning.details?.errors).includes("Self-hosted node is not currently reachable")));
  assert.ok(result.warnings.includes("GATEWAY_LIVE_AGENT_RUN_DEGRADED"));
  assert.equal(result.summary.status, "degraded");
});

test("default mcoda agent-run runner records image artifact references", async () => {
  const commandRunner: CodaliGatewayLiveCommandRunner = async () => ({
    stdout: JSON.stringify({
      responses: [
        {
          output: JSON.stringify({
            status: "ok",
            artifact: {
              kind: "image",
              uri: "artifact://smoke-image",
              mime_type: "image/png",
              metadata: { apiKey: "sk_secret_should_not_escape" },
            },
          }),
        },
      ],
    }),
    stderr: "",
    exitCode: 0,
    latencyMs: 9,
  });

  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory(),
    commandRunner,
    scenarios: ["image_generation"],
  });

  assert.equal(result.scenarios[0]?.status, "passed");
  assert.equal(result.scenarios[0]?.artifact?.uri, "artifact://smoke-image");
  assert.equal(result.scenarios[0]?.artifact?.metadata?.apiKey, "[redacted]");
});

test("missing image tier degrades clearly", async () => {
  const result = await runCodaliGatewayLiveHarness({
    inventory: inventory().filter((entry) => (entry as Record<string, unknown>).slug !== "image-worker"),
    scenarios: ["image_generation"],
  });

  assert.equal(result.scenarios[0]?.status, "skipped");
  assert.deepEqual(result.summary.missingRoles, ["image_worker"]);
  assert.equal(result.summary.status, "degraded");
  assert.ok(result.environmentWarnings.some((warning) =>
    warning.code === "GATEWAY_LIVE_ROLE_UNAVAILABLE" &&
    warning.role === "image_worker" &&
    warning.reason === "GATEWAY_AGENT_ROLE_UNRESOLVED"));
});

test("inventory parsing, redaction, and text formatting are stable", () => {
  assert.equal(parseCodaliGatewayLiveInventory({ agents: inventory() }).length, 5);
  assert.equal(parseCodaliGatewayLiveInventory(JSON.stringify({ data: inventory() })).length, 5);
  assert.deepEqual(
    redactCodaliGatewayLiveValue({
      apiKey: "sk_secret_should_not_escape",
      nested: { authorization: "Bearer abc123" },
      message: "Token in prose is not keyed",
    }),
    {
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]" },
      message: "Token in prose is not keyed",
    },
  );

  const text = formatCodaliGatewayLiveHarnessTextReport({
    schemaVersion: 1,
    runId: "run-1",
    runtime: "codali_gateway_live_harness",
    mode: "live",
    startedAt: "2026-07-02T00:00:00.000Z",
    endedAt: "2026-07-02T00:00:01.000Z",
    durationMs: 1_000,
    discovery: {
      source: "provided",
      status: "succeeded",
      latencyMs: 0,
      inventoryCount: 0,
      errors: [],
    },
    classification: classifyCodaliGatewayLiveAgents({ inventory: [], allowImageWorker: true }),
    scenarios: [],
    shadowComparison: {
      policy: {
        enabled: false,
        maxCandidatesPerScenario: 1,
        includePrimary: true,
        requireHealthy: true,
        roles: ["small_json"],
      },
      status: "disabled",
      records: [],
      environmentWarnings: [],
    },
    environmentWarnings: [],
    summary: {
      status: "degraded",
      passed: 0,
      failed: 0,
      degraded: 0,
      skipped: 0,
      jsonValidAgents: [],
      largeFinalSynthesizerOk: false,
      imageArtifactOk: false,
      missingRoles: ["small_json"],
    },
    warnings: [],
    errors: [],
  });

  assert.match(text, /Codali gateway live smoke: degraded/);
  assert.match(text, /Role small_json: unavailable/);
  assert.match(text, /Shadow comparison: disabled/);
  assert.match(text, /Environment warnings: none/);
});
