import test from "node:test";
import assert from "node:assert/strict";
import { SmartPipeline } from "../SmartPipeline.js";
import type { ContextBundle, Plan, CriticResult } from "../Types.js";
import type { BuilderRunResult } from "../BuilderRunner.js";

const baseContext: ContextBundle = {
  request: "do thing",
  queries: [],
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

const basePlan: Plan = {
  steps: ["step"],
  target_files: ["file.ts"],
  risk_assessment: "low",
  verification: [],
};

class StubContextAssembler {
  calls = 0;
  constructor(private contexts: ContextBundle | ContextBundle[] = baseContext) {}
  async assemble(): Promise<ContextBundle> {
    this.calls += 1;
    if (Array.isArray(this.contexts)) {
      const index = Math.min(this.calls - 1, this.contexts.length - 1);
      return this.contexts[index] ?? baseContext;
    }
    return this.contexts;
  }
}

class StubArchitectPlanner {
  called = false;
  lastLaneId?: string;
  async plan(_context?: ContextBundle, options?: { laneId?: string }): Promise<Plan> {
    this.called = true;
    this.lastLaneId = options?.laneId;
    return basePlan;
  }
}

class StubBuilderRunner {
  calls = 0;
  lastLaneId?: string;
  async run(
    _plan?: Plan,
    _context?: ContextBundle,
    options?: { laneId?: string },
  ): Promise<BuilderRunResult> {
    this.calls += 1;
    this.lastLaneId = options?.laneId;
    return {
      finalMessage: { role: "assistant", content: "done" },
      messages: [],
      toolCallsExecuted: 0,
    };
  }
}

class StubCriticEvaluator {
  constructor(private result: CriticResult) {}
  lastLaneId?: string;
  async evaluate(
    _plan?: Plan,
    _builderOutput?: string,
    _touched?: string[],
    options?: { laneId?: string },
  ): Promise<CriticResult> {
    this.lastLaneId = options?.laneId;
    return this.result;
  }
}

class StubMemoryWriteback {
  calls: Array<{ failures: number; maxRetries: number; lesson: string }> = [];
  async persist(input: { failures: number; maxRetries: number; lesson: string }): Promise<void> {
    this.calls.push(input);
  }
}

class StubLogger {
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  async log(type: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ type, data });
  }
}

test("SmartPipeline runs architect and passes", { concurrency: false }, async () => {
  const architect = new StubArchitectPlanner();
  const memory = new StubMemoryWriteback();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: memory as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.called, true);
  assert.equal(memory.calls.length, 0);
});

test("SmartPipeline skips architect on fast path", { concurrency: false }, async () => {
  const architect = new StubArchitectPlanner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    fastPath: () => true,
  });

  await pipeline.run("quick fix");
  assert.equal(architect.called, false);
});

test("SmartPipeline writes memory on repeated failure", { concurrency: false }, async () => {
  const memory = new StubMemoryWriteback();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "FAIL", reasons: ["bad"], retryable: true }) as any,
    memoryWriteback: memory as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "FAIL");
  assert.equal(memory.calls.length, 1);
});

test("SmartPipeline stops when critic marks failure non-retryable", { concurrency: false }, async () => {
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "FAIL", reasons: ["stop"], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 3,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "FAIL");
  assert.equal(builder.calls, 1);
  assert.equal(result.attempts, 1);
});

test("SmartPipeline writes preferences on success", { concurrency: false }, async () => {
  const memory = new StubMemoryWriteback();
  const contextWithPref: ContextBundle = {
    ...baseContext,
    preferences_detected: [{ category: "constraint", content: "use date-fns" }],
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(contextWithPref) as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: memory as any,
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(memory.calls.length, 1);
  assert.ok(memory.calls[0]?.lesson === "");
});

test("SmartPipeline logs phase events", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    logger: logger as any,
  });

  await pipeline.run("do thing");
  const phases = logger.events.filter((event) => event.type === "phase_start").map((event) => event.data.phase);
  assert.ok(phases.includes("librarian"));
  assert.ok(phases.includes("architect"));
  assert.ok(phases.includes("builder"));
  assert.ok(phases.includes("critic"));
});

test("SmartPipeline passes lane ids to phases when context manager configured", { concurrency: false }, async () => {
  const architect = new StubArchitectPlanner();
  const builder = new StubBuilderRunner();
  const critic = new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false });
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: critic as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    contextManager: {} as any,
    laneScope: { jobId: "job-x", taskId: "task-y" },
  });

  await pipeline.run("do thing");
  assert.equal(architect.lastLaneId, "job-x:task-y:architect");
  assert.equal(builder.lastLaneId, "job-x:task-y:builder");
  assert.equal(critic.lastLaneId, "job-x:task-y:critic");
});

test("SmartPipeline refreshes context when builder requests it", { concurrency: false }, async () => {
  class NeedsContextBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          finalMessage: {
            role: "assistant",
            content: JSON.stringify({ needs_context: true, queries: ["auth"], files: ["src/auth.ts"] }),
          },
          messages: [],
          toolCallsExecuted: 0,
          contextRequest: { queries: ["auth"], files: ["src/auth.ts"] },
        };
      }
      return {
        finalMessage: { role: "assistant", content: "done" },
        messages: [],
        toolCallsExecuted: 0,
      };
    }
  }

  const contextA: ContextBundle = { ...baseContext, request: "first" };
  const contextB: ContextBundle = { ...baseContext, request: "second" };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const builder = new NeedsContextBuilder();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    maxContextRefreshes: 1,
  });

  await pipeline.run("needs more");
  assert.equal(assembler.calls, 2);
  assert.equal(builder.calls, 2);
});
