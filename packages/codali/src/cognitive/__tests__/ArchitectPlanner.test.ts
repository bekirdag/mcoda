import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
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
      content: JSON.stringify({
        steps: ["1. Update file"],
        target_files: ["src/login.ts"],
        risk_assessment: "low",
        verification: ["npm test"],
      }),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(baseContext);
  assert.equal(plan.target_files[0], "src/login.ts");
});

test("ArchitectPlanner accepts plan alias fields", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: {
      role: "assistant",
      content: JSON.stringify({
        plan: ["1. Update file"],
        filesLikelyTouched: ["src/login.ts"],
        risk_assessment: "low",
        verification: [],
      }),
    },
  });

  const planner = new ArchitectPlanner(provider);
  const plan = await planner.plan(baseContext);
  assert.equal(plan.steps[0], "1. Update file");
  assert.equal(plan.target_files[0], "src/login.ts");
});

test("ArchitectPlanner uses responseFormat override", { concurrency: false }, async () => {
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
      content: JSON.stringify({
        steps: ["1. Update file"],
        target_files: ["src/login.ts"],
        risk_assessment: "low",
        verification: [],
      }),
    },
  });
  const planner = new ArchitectPlanner(provider, { contextManager, laneId: lane.id, model: "test" });
  await planner.plan(baseContext);

  const messages = provider.lastRequest?.messages ?? [];
  assert.ok(messages.some((msg) => msg.content.includes("prior note")));
});

test("ArchitectPlanner rejects invalid JSON", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: "not-json" },
  });
  const planner = new ArchitectPlanner(provider);
  await assert.rejects(() => planner.plan(baseContext), /not valid JSON/);
});

test("ArchitectPlanner rejects missing fields", { concurrency: false }, async () => {
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify({ steps: [] }) },
  });
  const planner = new ArchitectPlanner(provider);
  await assert.rejects(() => planner.plan(baseContext), /missing/);
});
