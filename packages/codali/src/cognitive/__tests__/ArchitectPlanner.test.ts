import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { LocalContextConfig } from "../Types.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchitectPlanner, PlanHintValidationError } from "../ArchitectPlanner.js";
import type { ContextBundle } from "../Types.js";

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return this.response;
  }
}

const makeConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {},
  summarize: {
    enabled: false,
    provider: "librarian",
    model: "test-model",
    targetTokens: 1200,
    thresholdPct: 0.9,
  },
  ...overrides,
});

const baseContext: ContextBundle = {
  request: "Update login flow",
  queries: ["login"],
  snippets: [],
  symbols: [],
  ast: [],
  impact: [],
  impact_diagnostics: [],
  files: [
    {
      path: "src/login.ts",
      role: "focus",
      content: "",
      size: 0,
      truncated: false,
      sliceStrategy: "test",
      origin: "docdex",
    },
  ],
  selection: {
    focus: ["src/login.ts"],
    periphery: [],
    all: ["src/login.ts"],
    low_confidence: false,
  },
  memory: [],
  preferences_detected: [],
  profile: [],
  index: { last_updated_epoch_ms: 0, num_docs: 0 },
  warnings: [],
};

const scopeAgnosticContext = (overrides: Partial<ContextBundle> = {}): ContextBundle => ({
  ...baseContext,
  files: [],
  snippets: [],
  symbols: [],
  ast: [],
  impact: [],
  impact_diagnostics: [],
  selection: undefined,
  ...overrides,
});

test("ArchitectPlanner returns a valid plan", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low minimal change",
        "VERIFY:",
        "- npm test",
      ].join("\n"),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(baseContext);
  assert.equal(plan.target_files[0], "src/login.ts");
});

test("ArchitectPlanner parses DSL steps/targets", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
      ].join("\n"),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(baseContext);
  assert.equal(plan.steps[0], "Update file");
  assert.equal(plan.target_files[0], "src/login.ts");
  assert.ok(plan.steps.some((step) => step.includes("src/login.ts")));
});

test("ArchitectPlanner fails closed on out-of-scope targets when create_files is not declared", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Implement behavior",
        "TARGETS:",
        "- src/nonexistent.ts",
        "RISK: low",
        "VERIFY:",
        "- Run unit tests: pnpm test --filter codali",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(baseContext);
  assert.equal(result.plan.target_files.length, 0);
  assert.ok(
    result.warnings.some((warning) => warning.startsWith("plan_targets_outside_context:")),
  );
  assert.ok(result.warnings.includes("plan_target_scope_empty_after_filter"));
});

test("ArchitectPlanner allows explicit create_files targets outside focus/periphery", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Create a new handler module",
        "TARGETS:",
        "- src/nonexistent.ts",
        "CREATE_FILES:",
        "- src/nonexistent.ts",
        "RISK: low",
        "VERIFY:",
        "- Run unit tests: pnpm test --filter codali",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(result.plan.target_files.includes("src/nonexistent.ts"));
  assert.ok(result.plan.create_files?.includes("src/nonexistent.ts"));
  assert.ok(
    !result.warnings.some((warning) => warning.startsWith("plan_targets_outside_context:")),
  );
});

test("Regression: empty VERIFY is normalized to concrete fallback verification", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update login flow in src/login.ts",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low small behavior change",
        "VERIFY:",
      ].join("\n"),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(result.warnings.includes("plan_missing_verification"));
  assert.ok(result.plan.verification.length > 0);
});

test("ArchitectPlanner adds per-file change details when plan steps are generic", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Apply requested update",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
        "- npm test",
      ].join("\n"),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(scopeAgnosticContext());
  const detailedStep = plan.steps.find((step) => step.includes("src/login.ts"));
  assert.ok(detailedStep);
  assert.ok((detailedStep ?? "").toLowerCase().includes("add"));
});

test("ArchitectPlanner uses DSL plan hint without calling provider", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/ignored.ts",
        "RISK: low",
        "VERIFY:",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider, {
    planHint: [
      "PLAN:",
      "- Use hint",
      "TARGETS:",
      "- src/login.ts",
      "RISK: low",
      "VERIFY:",
    ].join("\n"),
  });
  const plan = await planner.plan(baseContext);
  assert.equal(plan.steps[0], "Use hint");
  assert.equal(plan.target_files[0], "src/login.ts");
  assert.equal(provider.lastRequest, undefined);
});

test("ArchitectPlanner allows clearing constructor planHint with explicit undefined override", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Use provider output",
        "TARGETS:",
        "- src/from-provider.ts",
        "RISK: low",
        "VERIFY:",
        "- Run unit tests: pnpm test --filter provider",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider, {
    planHint: [
      "PLAN:",
      "- Use constructor hint",
      "TARGETS:",
      "- src/from-hint.ts",
      "RISK: low",
      "VERIFY:",
      "- placeholder",
    ].join("\n"),
  });

  const result = await planner.plan(scopeAgnosticContext(), { planHint: undefined });
  assert.equal(result.target_files[0], "src/from-provider.ts");
  assert.ok(provider.lastRequest);
});

test("ArchitectPlanner validate-only accepts valid plan hint without provider call", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "should not be used" },
  });
  const planner = new ArchitectPlanner(provider, {
    validateOnly: true,
    planHint: JSON.stringify({
      steps: ["Update src/login.ts for new login guard."],
      target_files: ["src/login.ts"],
      risk_assessment: "low: localized login behavior change",
      verification: [],
    }),
  });
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.equal(provider.lastRequest, undefined);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.plan.target_files.includes("src/login.ts"));
});

test("ArchitectPlanner validate-only throws structured error for invalid plan hint targets", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "should not be used" },
  });
  const planner = new ArchitectPlanner(provider, {
    validateOnly: true,
    planHint: JSON.stringify({
      steps: ["Do work"],
      target_files: ["unknown", "path/to/file.ts"],
      risk_assessment: "low",
      verification: [],
    }),
  });
  await assert.rejects(
    () => planner.planWithRequest(baseContext),
    (error) => {
      assert.ok(error instanceof PlanHintValidationError);
      assert.ok(error.issues.some((issue) => issue.startsWith("plan_hint_invalid_targets")));
      return true;
    },
  );
  assert.equal(provider.lastRequest, undefined);
});

test("ArchitectPlanner validate-only rejects out-of-scope targets unless create_files is present", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "should not be used" },
  });
  const planner = new ArchitectPlanner(provider, {
    validateOnly: true,
    planHint: JSON.stringify({
      steps: ["Do work"],
      target_files: ["src/nonexistent.ts"],
      risk_assessment: "low",
      verification: ["Run unit tests: pnpm test --filter codali"],
    }),
  });
  await assert.rejects(
    () => planner.planWithRequest(baseContext),
    (error) => {
      assert.ok(error instanceof PlanHintValidationError);
      assert.ok(error.issues.some((issue) => issue.startsWith("plan_hint_targets_outside_context")));
      return true;
    },
  );
  assert.equal(provider.lastRequest, undefined);
});

test("ArchitectPlanner injects text plan hint into prompt", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({
        steps: ["1. Update file"],
        target_files: ["src/login.ts"],
        risk_assessment: "low",
        verification: [],
      }),
    },
  });
  const planner = new ArchitectPlanner(provider, { planHint: "Follow gateway plan strictly." });
  await planner.plan(baseContext);
  const systemPrompt = provider.lastRequest?.messages[0]?.content ?? "";
  assert.ok(systemPrompt.includes("PLAN HINT"));
  assert.ok(systemPrompt.includes("Follow gateway plan strictly."));
});

test("ArchitectPlanner treats instruction hints as prompt guidance and still calls provider", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Implement concrete request changes",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
        "- Run unit tests: pnpm test --filter login",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider, {
    instructionHint: [
      "STRICT MODE: Output DSL only.",
      "PLAN:",
      "- <step>",
      "TARGETS:",
      "- <path>",
      "RISK: <low|medium|high> <reason>",
      "VERIFY:",
      "- <verification step>",
    ].join("\n"),
  });

  const plan = await planner.plan(scopeAgnosticContext());
  assert.equal(plan.target_files[0], "src/login.ts");
  assert.notEqual(plan.target_files[0], "<path>");
  assert.ok(provider.lastRequest);
  const systemPrompt = provider.lastRequest?.messages[0]?.content ?? "";
  assert.ok(systemPrompt.includes("ADDITIONAL ARCHITECT INSTRUCTIONS:"));
});

test("ArchitectPlanner adapts non-DSL query JSON into AGENT_REQUEST recovery", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({
        query: "Find server route handlers for healthz endpoint",
      }),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(result.request);
  assert.equal(result.request?.needs[0]?.type, "docdex.search");
  if (result.request?.needs[0]?.type === "docdex.search") {
    assert.match(result.request.needs[0].query, /healthz endpoint/i);
  }
  assert.ok(result.warnings.includes("architect_output_adapted_to_request"));
});

test("ArchitectPlanner adapts prose non-DSL output into AGENT_REQUEST recovery", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content:
        "I will first review the repository and then explain possible approaches before coding. " +
        "Please provide route handlers, server entrypoints, and API specification context so I can proceed.",
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(result.request);
  assert.equal(result.request?.needs[0]?.type, "docdex.search");
  assert.ok(result.warnings.includes("architect_output_adapted_to_request"));
});

test("ArchitectPlanner prose recovery query filters prompt-noise tokens", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content:
        "<think>Okay, assistant content JSON DSL plan targets verify risk</think> " +
        "I should inspect healthz uptime logging handlers and storage pipeline before coding.",
    },
  });
  const context: ContextBundle = {
    ...baseContext,
    request: "Add uptime logging to healthz endpoint",
  };
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(context);
  assert.ok(result.request);
  assert.equal(result.request?.needs[0]?.type, "docdex.search");
  if (result.request?.needs[0]?.type === "docdex.search") {
    const query = result.request.needs[0].query.toLowerCase();
    assert.ok(query.includes("healthz"));
    assert.ok(query.includes("uptime"));
    assert.ok(!query.includes("think"));
    assert.ok(!query.includes("assistant"));
    assert.ok(!query.includes("json"));
    assert.ok(!query.includes("dsl"));
  }
});

test("ArchitectPlanner ignores think-tag wrapper warnings while repairing non-DSL output", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: "<think>internal reasoning</think>\nI will review files and apply changes.",
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(!result.warnings.includes("architect_output_contains_think"));
  assert.ok(result.warnings.includes("architect_output_not_dsl"));
  assert.ok(result.warnings.includes("architect_output_repaired"));
  assert.ok(result.warnings.some((warning) => warning.startsWith("architect_output_repair_reason:")));
});

test("ArchitectPlanner classifies fenced output as non-DSL and repaired", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: "```json\n{\"query\":\"find server handlers\"}\n```",
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(baseContext);
  assert.ok(result.warnings.includes("architect_output_contains_fence"));
  assert.ok(result.warnings.includes("architect_output_not_dsl"));
  assert.ok(result.warnings.includes("architect_output_repaired"));
  assert.ok(result.request);
});

test("ArchitectPlanner normalizes noisy wrapped DSL output into canonical plan", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "<think>hidden chain of thought</think>",
        "```dsl",
        "PLAN:",
        "- Update server route implementation",
        "TARGETS:",
        "- src/server/routes/healthz.ts",
        "RISK: low: localized update",
        "VERIFY:",
        "- Run unit tests: pnpm test --filter healthz",
        "```",
        "Additional chatter outside DSL should be ignored.",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.equal(result.plan.target_files[0], "src/server/routes/healthz.ts");
  assert.ok(result.plan.steps[0]?.toLowerCase().includes("route"));
  assert.ok(!result.warnings.includes("architect_output_contains_think"));
  assert.ok(result.warnings.includes("architect_output_contains_fence"));
  assert.ok(!result.warnings.includes("architect_output_not_dsl"));
  assert.ok(result.warnings.includes("architect_output_repaired"));
  assert.ok(result.warnings.includes("architect_output_repair_reason:wrapper_noise"));
});

test("ArchitectPlanner keeps first DSL block when duplicate sections are emitted", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update welcome section",
        "TARGETS:",
        "- src/public/index.html",
        "RISK: low: html-only change",
        "VERIFY:",
        "- Manual browser check: open http://localhost:3000",
        "",
        "PLAN:",
        "- Replace with unrelated implementation",
        "TARGETS:",
        "- src/unrelated/placeholder.ts",
        "RISK: medium: drift",
        "VERIFY:",
        "- Run unit tests",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(scopeAgnosticContext());
  assert.ok(result.plan.target_files.includes("src/public/index.html"));
  assert.ok(!result.plan.target_files.includes("src/unrelated/placeholder.ts"));
  assert.ok(result.warnings.includes("architect_output_multiple_section_blocks"));
  assert.ok(!result.warnings.includes("architect_output_not_dsl"));
  assert.ok(result.warnings.includes("architect_output_repaired"));
  assert.ok(result.warnings.includes("architect_output_repair_reason:duplicate_sections"));
});

test("ArchitectPlanner adapts non-DSL file/symbol JSON into context requests", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({
        file: "docs/pdr/test-web-app.md",
        symbol_id: "abc123",
        symbol_name: "Non-Functional Requirements",
      }),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const result = await planner.planWithRequest(baseContext);
  assert.ok(result.request);
  assert.equal(result.request?.needs[0]?.type, "file.read");
  if (result.request?.needs[0]?.type === "file.read") {
    assert.equal(result.request.needs[0].path, "docs/pdr/test-web-app.md");
  }
  assert.ok(result.request?.needs.some((need) => need.type === "docdex.search"));
  assert.ok(result.warnings.includes("architect_output_adapted_to_request"));
});

test("ArchitectPlanner uses responseFormat override", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
      ].join("\n"),
    },
  });

  const planner = new ArchitectPlanner(provider, {
    responseFormat: { type: "gbnf", grammar: "root ::= \"ok\"" },
  });
  await planner.plan(baseContext);
  assert.deepEqual(provider.lastRequest?.responseFormat, {
    type: "gbnf",
    grammar: "root ::= \"ok\"",
  });
});

test("ArchitectPlanner prepends context history when configured", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-architect-"));
  const store = new ContextStore({ workspaceRoot, storageDir: "codali/context" });
  const contextManager = new ContextManager({ config: makeConfig(), store });
  const lane = await contextManager.getLane({ jobId: "job-arch", taskId: "task-arch", role: "architect" });
  await contextManager.append(lane.id, { role: "assistant", content: "prior note" }, { role: "architect" });

  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider, { contextManager, laneId: lane.id, model: "test" });
  await planner.plan(baseContext);

  const messages = provider.lastRequest?.messages ?? [];
  assert.ok(messages.some((msg) => msg.content.includes("prior note")));
});

test("ArchitectPlanner emits status events and forwards stream", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "PLAN:",
        "- Update file",
        "TARGETS:",
        "- src/login.ts",
        "RISK: low",
        "VERIFY:",
      ].join("\n"),
    },
  });
  const events: AgentEvent[] = [];
  const planner = new ArchitectPlanner(provider, {
    onEvent: (event) => events.push(event),
    stream: true,
  });

  await planner.plan(baseContext);

  assert.equal(provider.lastRequest?.stream, true);
  assert.ok(events.some((event) => event.type === "status" && event.phase === "thinking"));
  assert.ok(events.some((event) => event.type === "status" && event.phase === "done"));
});

test("ArchitectPlanner falls back on invalid output", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "not-json" },
  });
  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(scopeAgnosticContext());
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.target_files.length > 0);
});

test("ArchitectPlanner falls back on missing fields", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "PLAN:\nTARGETS:\nRISK:\nVERIFY:" },
  });
  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(scopeAgnosticContext());
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.target_files.length > 0);
});

test("ArchitectPlanner coerces string fields into arrays", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({
        plan: "Inspect handler\nUpdate response",
        target_files: "src/server.js, openapi/mcoda.yaml",
        risk: "low",
        verification: "npm test; npm run lint",
      }),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(scopeAgnosticContext());
  assert.ok(plan.steps.length >= 2);
  assert.ok(plan.steps.some((step) => step.includes("src/server.js")));
  assert.equal(plan.target_files.length, 2);
  assert.equal(plan.verification.length, 2);
});

test("ArchitectPlanner fallback prefers backend targets for endpoint requests", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({ query: "impact graph" }),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const context: ContextBundle = {
    ...baseContext,
    request: "Create a heathz endpoint to check the health of the system",
    selection: {
      focus: ["src/public/app.js", "tests/footer.test.js"],
      periphery: ["docs/rfp.md", "src/server.js"],
      all: ["src/public/app.js", "tests/footer.test.js", "docs/rfp.md", "src/server.js"],
      low_confidence: false,
    },
    files: [
      ...(baseContext.files ?? []),
      {
        path: "src/public/app.js",
        role: "focus",
        content: "",
        size: 0,
        truncated: false,
        sliceStrategy: "test",
        origin: "docdex",
      },
      {
        path: "tests/footer.test.js",
        role: "focus",
        content: "",
        size: 0,
        truncated: false,
        sliceStrategy: "test",
        origin: "docdex",
      },
      {
        path: "src/server.js",
        role: "periphery",
        content: "",
        size: 0,
        truncated: false,
        sliceStrategy: "test",
        origin: "docdex",
      },
    ],
    repo_map_raw: [
      "test-web-app",
      "├── docs",
      "│   └── rfp.md",
      "└── src",
      "    ├── public",
      "    │   └── app.js",
      "    └── server.js",
    ].join("\n"),
  };
  const plan = await planner.plan(context);
  assert.ok(plan.target_files.includes("src/server.js"));
  assert.ok(plan.steps.some((step) => step.includes("wires the route")));
  assert.ok(plan.verification.length > 0);
});

test("ArchitectPlanner fallback plans new file creation when target script is missing", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: "not-json",
    },
  });
  const planner = new ArchitectPlanner(provider);
  const context: ContextBundle = {
    ...baseContext,
    request: "Create payment reconciliation script",
    selection: {
      focus: [],
      periphery: ["docs/rfp.md"],
      all: ["docs/rfp.md"],
      low_confidence: false,
    },
    files: [],
    repo_map_raw: [
      "test-web-app",
      "├── docs",
      "│   └── rfp.md",
      "└── src",
      "    └── api",
    ].join("\n"),
    project_info: {
      workspace_root: "/repo",
      file_types: [".js", ".md"],
    },
  };
  const plan = await planner.plan(context);
  assert.ok(plan.target_files.some((file) => file.startsWith("src/") && file.includes("payment")));
  assert.ok(plan.steps.some((step) => step.includes("Create missing implementation files")));
  assert.ok(plan.verification.length > 0);
});

test("ArchitectPlanner review parser captures reasons and feedback", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "REVIEW:",
        "STATUS: RETRY",
        "REASONS:",
        "- Request asks for uptime logging but builder output only adds static UI copy.",
        "FEEDBACK:",
        "- Update src/server/healthz.ts to append uptime data into logs/healthz.log.",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const review = await planner.reviewBuilderOutput(
    {
      steps: ["Update src/server/healthz.ts to log uptime data"],
      target_files: ["src/server/healthz.ts"],
      risk_assessment: "low",
      verification: ["Run integration tests for /healthz and check logs/healthz.log output."],
    },
    "builder output",
    baseContext,
  );
  assert.equal(review.status, "RETRY");
  assert.equal(review.reasons.length, 1);
  assert.equal(review.feedback.length, 1);
  assert.equal(review.warnings.length, 0);
});

test("ArchitectPlanner review parser flags RETRY without actionable feedback", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: [
        "REVIEW:",
        "STATUS: RETRY",
        "REASONS:",
        "- Request intent not implemented.",
        "FEEDBACK:",
      ].join("\n"),
    },
  });
  const planner = new ArchitectPlanner(provider);
  const review = await planner.reviewBuilderOutput(
    {
      steps: ["Update src/server/healthz.ts to log uptime data"],
      target_files: ["src/server/healthz.ts"],
      risk_assessment: "low",
      verification: ["Run integration tests for /healthz and check logs/healthz.log output."],
    },
    "builder output",
    baseContext,
  );
  assert.equal(review.status, "RETRY");
  assert.ok(review.warnings.includes("architect_review_retry_missing_feedback"));
});
