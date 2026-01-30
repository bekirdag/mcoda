import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { LocalContextConfig } from "../Types.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchitectPlanner } from "../ArchitectPlanner.js";
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
    model: "gemma2:2b",
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
  const plan = await planner.plan(baseContext);
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.target_files.length > 0);
});

test("ArchitectPlanner falls back on missing fields", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "PLAN:\nTARGETS:\nRISK:\nVERIFY:" },
  });
  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(baseContext);
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
  const plan = await planner.plan(baseContext);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.target_files.length, 2);
  assert.equal(plan.verification.length, 2);
});
