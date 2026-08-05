import assert from "node:assert/strict";
import test from "node:test";
import { parseAskArgs, runAsk } from "../AskCommand.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly responses: ProviderResponse[],
    readonly supportsToolCalls = true,
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("ScriptedProvider ran out of responses");
    return response;
  }
}

const json = (value: unknown): ProviderResponse => ({
  message: { role: "assistant", content: JSON.stringify(value) },
});

const text = (content: string): ProviderResponse => ({
  message: { role: "assistant", content },
});

const classifier = (overrides: Record<string, unknown> = {}) => ({
  queryType: "general",
  needsPrivateData: false,
  needsFreshData: false,
  needsDocdex: false,
  needsAppTools: false,
  needsImageWorker: false,
  confidence: "high",
  ...overrides,
});

const emptyPlan = {
  queryType: "general",
  subquestions: [],
  workerTasks: [],
};

const inventory = () => ({
  agents: [
    {
      id: "a1",
      slug: "orchestrator-agent",
      adapter: "openai-cli",
      defaultModel: "small",
      model: "small",
      supportsTools: true,
      supportsJsonSchema: true,
      contextWindow: 32_000,
      capabilities: ["chat", "plan"],
      tier: "medium",
      health: { status: "healthy" },
    },
    {
      id: "a2",
      slug: "synth-agent",
      adapter: "openai-cli",
      defaultModel: "large",
      model: "large",
      supportsTools: true,
      contextWindow: 128_000,
      capabilities: ["chat", "deep_reasoning"],
      tier: "large",
      health: { status: "healthy" },
    },
  ],
  warnings: [],
  source: "mcoda" as const,
});

const runWith = async (
  argv: string[],
  provider: Provider,
  registry = new ToolRegistry(),
) => {
  const lines: string[] = [];
  const outcome = await runAsk(argv, {
    loadInventory: async () => inventory(),
    resolveRunContext: async (workspaceRoot) => ({ repo: { root: workspaceRoot } }),
    buildRegistry: () => registry,
    createProvider: () => provider,
    write: (line) => lines.push(line),
  });
  return { outcome, output: lines.join("\n") };
};

test("parses a question and its options", () => {
  const options = parseAskArgs([
    "What is Codali?",
    "--trace",
    "--max-rounds",
    "2",
    "--mode",
    "fast",
  ]);
  assert.equal(options.query, "What is Codali?");
  assert.equal(options.trace, true);
  assert.equal(options.maxRounds, 2);
  assert.equal(options.mode, "fast");
});

test("joins a multi-word question given as separate arguments", () => {
  const options = parseAskArgs(["What", "is", "Codali?"]);
  assert.equal(options.query, "What is Codali?");
});

test("an empty question is rejected rather than sent to a model", () => {
  assert.throws(() => parseAskArgs(["--trace"]), /requires a question/);
});

test("a positive integer is required for numeric flags", () => {
  assert.throws(() => parseAskArgs(["q", "--max-rounds", "0"]), /positive integer/);
});

test("a generation task with no tool tasks answers in one pass", async () => {
  // Example #1 from the requirements: repo-independent code generation.
  const provider = new ScriptedProvider([
    json(classifier({ queryType: "code_generation" })),
    json(emptyPlan),
    text("<html>…pingpong…</html>"),
  ]);

  const { outcome, output } = await runWith(
    ["Write me a simple html/js pingpong game", "--no-tools"],
    provider,
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result?.status, "succeeded");
  assert.match(output, /pingpong/);
  assert.equal(outcome.result?.trace.toolCallCount, 0);
});

test("the run fails cleanly when no agent can be resolved", async () => {
  const lines: string[] = [];
  const outcome = await runAsk(["Anything"], {
    loadInventory: async () => ({ agents: [], warnings: [], source: "empty" as const }),
    resolveRunContext: async () => ({}),
    buildRegistry: () => new ToolRegistry(),
    write: (line) => lines.push(line),
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(lines.join("\n"), /No usable mcoda agent/);
});

test("--json emits the full result contract including artifacts and warnings", async () => {
  const provider = new ScriptedProvider([
    json(classifier()),
    json(emptyPlan),
    text("An answer."),
  ]);

  const { output } = await runWith(["A question", "--no-tools", "--json"], provider);
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "succeeded");
  assert.ok(Array.isArray(parsed.artifacts), "artifacts must always be present");
  assert.ok(Array.isArray(parsed.warnings), "warnings must always be present");
  assert.ok(Array.isArray(parsed.sources));
  assert.equal(typeof parsed.runId, "string");
});

test("--trace prints the run trace, including why the run ended", async () => {
  const provider = new ScriptedProvider([
    json(classifier()),
    json(emptyPlan),
    text("An answer."),
  ]);

  const { output } = await runWith(["A question", "--no-tools", "--trace"], provider);

  assert.match(output, /status: succeeded/);
  assert.match(output, /completion: complete/);
  assert.match(output, /agents:/);
  assert.match(output, /orchestrator: /);
  assert.match(output, /tool calls: none/);
});

test("the planner is told what each tool does, not just its name", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "docdex_search",
    description: "Search the indexed repository for code and docs.",
    capability: "docdex",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    handler: async () => ({ output: "{}" }),
  });

  const provider = new ScriptedProvider([
    json(classifier({ needsDocdex: true, capabilities: ["docdex"] })),
    json(emptyPlan),
    text("An answer."),
  ]);

  await runWith(["Where is the planner defined?"], provider, registry);

  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.match(plannerPrompt, /docdex_search: Search the indexed repository/);
  assert.match(plannerPrompt, /args: \{ query: string \}/);
});

test("the classifier sees capability summaries rather than raw tool schemas", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "docdex_search",
    description: "Search the indexed repository for code and docs.",
    capability: "docdex",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    handler: async () => ({ output: "{}" }),
  });

  const provider = new ScriptedProvider([
    json(classifier()),
    json(emptyPlan),
    text("An answer."),
  ]);

  await runWith(["A question"], provider, registry);

  const classifierPrompt = provider.requests[0]?.messages[1]?.content ?? "";
  assert.match(classifierPrompt, /Available capabilities:/);
  assert.match(classifierPrompt, /- docdex — /);
  // Stage 1 must stay cheap: argument shapes belong to stage 2 only.
  assert.ok(!classifierPrompt.includes("args:"));
});

test("when no provider can emit tool calls, no tools are offered at all", async () => {
  // A CLI-backed agent advertises supportsTools because the CLI has tools, but
  // this adapter drives it through text and can never surface a call. Planning
  // retrieval tasks that physically cannot run wastes the budget and buries the
  // real cause, so tools are withheld and the reason is recorded.
  const registry = new ToolRegistry();
  registry.register({
    name: "docdex_search",
    description: "Search the indexed repository.",
    capability: "docdex",
    readOnly: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    handler: async () => ({ output: "{}" }),
  });

  const provider = new ScriptedProvider(
    [json(classifier({ needsDocdex: true })), json(emptyPlan), text("An answer.")],
    false,
  );

  const { outcome } = await runWith(["Where is the planner?", "--trace"], provider, registry);

  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.match(plannerPrompt, /Allowed tools[^\n]*:\n- none/);
  assert.ok(
    outcome.tracer
      .snapshot()
      .warnings.some((warning) => warning.startsWith("tools_unavailable:")),
    "the reason tools are unavailable must be recorded",
  );
});

test("budgets from the CLI reach the request policy", async () => {
  const provider = new ScriptedProvider([
    json(classifier()),
    json(emptyPlan),
    text("An answer."),
  ]);

  const { outcome } = await runWith(
    ["A question", "--no-tools", "--max-tool-calls", "4", "--max-rounds", "1"],
    provider,
  );

  assert.equal(outcome.result?.status, "succeeded");
  // maxIterations is what bounds the orchestration loop.
  assert.equal(outcome.tracer.snapshot().rounds, 1);
});

test("discovered MCP tools reach the planner instead of being silently dropped", async () => {
  // The capability compiler predates connectors and drops anything it considers
  // `not_declared` — which was every MCP tool. Discovery is the declaration, so
  // the tools must be passed to the compiler as actual tools. Without this the
  // run plans with docdex only and nothing explains why.
  const registry = new ToolRegistry();
  registry.register({
    name: "docdex_search",
    description: "Search the indexed repository.",
    capability: "docdex",
    readOnly: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    handler: async () => ({ output: "{}" }),
  });

  const provider = new ScriptedProvider([
    json(classifier({ needsAppTools: true, capabilities: ["fs"] })),
    json(emptyPlan),
    text("An answer."),
  ]);

  const lines: string[] = [];
  await runAsk(["List the files"], {
    loadInventory: async () => inventory(),
    resolveRunContext: async (workspaceRoot) => ({ repo: { root: workspaceRoot } }),
    buildRegistry: () => registry,
    createProvider: () => provider,
    attachMcp: async ({ toolRegistry }) => {
      toolRegistry.register({
        name: "mcp:fs:list_directory",
        description: "List files in a directory.",
        capability: "fs",
        readOnly: true,
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        handler: async () => ({ output: "a.ts" }),
      });
      return { registry: undefined, health: [], registered: ["mcp:fs:list_directory"], warnings: [] };
    },
    write: (line) => lines.push(line),
  });

  const classifierPrompt = provider.requests[0]?.messages[1]?.content ?? "";
  assert.match(classifierPrompt, /- fs — /, "the fs capability must be offered");

  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.match(plannerPrompt, /mcp:fs:list_directory: List files in a directory\./);
  assert.match(plannerPrompt, /args: \{ path: string \}/);
});

test("MCP write tools are withheld from the model but stay visible", async () => {
  // Phase 2 keeps external connectors read-only. A server's own readOnlyHint is
  // not trusted, so an undeclared tool is treated as capable of mutation.
  const registry = new ToolRegistry();
  const provider = new ScriptedProvider([
    json(classifier({ needsAppTools: true })),
    json(emptyPlan),
    text("An answer."),
  ]);

  const outcome = await runAsk(["Do something", "--trace"], {
    loadInventory: async () => inventory(),
    resolveRunContext: async (workspaceRoot) => ({ repo: { root: workspaceRoot } }),
    buildRegistry: () => registry,
    createProvider: () => provider,
    attachMcp: async ({ toolRegistry }) => {
      toolRegistry.register({
        name: "mcp:fs:edit_file",
        description: "Edit a file.",
        capability: "fs",
        readOnly: false,
        handler: async () => ({ output: "" }),
      });
      return { registry: undefined, health: [], registered: ["mcp:fs:edit_file"], warnings: [] };
    },
    write: () => {},
  });

  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.ok(
    !plannerPrompt.includes("mcp:fs:edit_file"),
    "a write tool must not be offered to the model",
  );
  assert.ok(
    outcome.tracer.snapshot().warnings.some((w) => w.startsWith("mcp_write_tools_withheld:")),
    "withholding must be recorded, not silent",
  );
});

test("an ambiguous request asks a question instead of guessing an identity", async () => {
  // Spending a research budget guessing which "Bekir" was meant produces a
  // confident answer about the wrong person.
  const provider = new ScriptedProvider([
    json(classifier({ needsClarification: "Which Bekir do you mean — there are three?" })),
  ]);

  const { outcome, output } = await runWith(
    ["How is Bekir doing?", "--no-tools"],
    provider,
  );

  assert.equal(outcome.result?.status, "needs_clarification");
  assert.match(output, /Which Bekir do you mean/);
  // Only the classifier ran: no planner call, no synthesizer call.
  assert.equal(provider.requests.length, 1);
  assert.equal(outcome.result?.evidence.length, 0);
});

test("the resolved time range is stamped on the plan so runs are reproducible", async () => {
  const provider = new ScriptedProvider([
    json(classifier()),
    json(emptyPlan),
    text("An answer."),
  ]);

  await runWith(["What changed in the last two weeks?", "--no-tools"], provider);

  const classifierPrompt = provider.requests[0]?.messages[1]?.content ?? "";
  assert.match(classifierPrompt, /Resolved time range for "last two weeks"/);
  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.match(plannerPrompt, /Do not compute your own dates/);
});
