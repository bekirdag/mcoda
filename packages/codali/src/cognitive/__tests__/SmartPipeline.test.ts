import test from "node:test";
import assert from "node:assert/strict";
import { SmartPipeline } from "../SmartPipeline.js";
import type { ResearchToolExecution } from "../ContextAssembler.js";
import type { ContextBundle, Plan, CriticResult } from "../Types.js";
import type { BuilderRunResult } from "../BuilderRunner.js";
import { PatchApplyError, type PatchApplyFailure } from "../BuilderRunner.js";
import { PlanHintValidationError } from "../ArchitectPlanner.js";

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
  verification: ["Run unit tests: pnpm test --filter codali"],
};

const baseResearchOutput: ResearchToolExecution = {
  toolRuns: [{ tool: "docdex.search", ok: true }],
  warnings: [],
  outputs: {
    searchResults: [],
    snippets: [],
    symbols: [],
    ast: [],
    impact: [],
    impactDiagnostics: [],
  },
};

const minimalToolQuota = {
  search: 1,
  openOrSnippet: 0,
  symbolsOrAst: 0,
  impact: 0,
  tree: 0,
  dagExport: 0,
};

const minimalInvestigationBudget = {
  minCycles: 1,
  minSeconds: 0,
  maxCycles: 1,
};

const minimalEvidenceGate = {
  minSearchHits: 0,
  minOpenOrSnippet: 0,
  minSymbolsOrAst: 0,
  minImpact: 0,
  maxWarnings: 10,
};

const assertDeepInvestigationError = (error: unknown, code: string): boolean => {
  assert.ok(error && typeof error === "object");
  const record = error as { code?: string; remediation?: string[] };
  assert.equal(record.code, code);
  assert.ok(Array.isArray(record.remediation));
  return true;
};

class StubContextAssembler {
  calls = 0;
  researchCalls = 0;
  lastResearchRequest?: string;
  lastAssembleRequest?: string;
  lastAssembleOptions?: {
    additionalQueries?: string[];
    preferredFiles?: string[];
    recentFiles?: string[];
    forceFocusFiles?: string[];
  };
  private contexts: ContextBundle | ContextBundle[];
  private researchOutput: ResearchToolExecution;
  constructor(
    contexts: ContextBundle | ContextBundle[] = baseContext,
    researchOutput: ResearchToolExecution = baseResearchOutput,
  ) {
    this.contexts = contexts;
    this.researchOutput = researchOutput;
  }
  async assemble(
    request = "",
    options: {
      additionalQueries?: string[];
      preferredFiles?: string[];
      recentFiles?: string[];
      forceFocusFiles?: string[];
    } = {},
  ): Promise<ContextBundle> {
    this.calls += 1;
    this.lastAssembleRequest = request;
    this.lastAssembleOptions = options;
    if (Array.isArray(this.contexts)) {
      const index = Math.min(this.calls - 1, this.contexts.length - 1);
      return this.contexts[index] ?? baseContext;
    }
    return this.contexts;
  }

  async runResearchTools(request: string): Promise<ResearchToolExecution> {
    this.researchCalls += 1;
    this.lastResearchRequest = request;
    return this.researchOutput;
  }

  lastRequestId?: string;
  async fulfillAgentRequest(request: { request_id: string }) {
    this.lastRequestId = request.request_id;
    return { version: "v1", request_id: request.request_id, results: [], meta: {} };
  }
}

class StubArchitectPlanner {
  called = false;
  calls = 0;
  lastLaneId?: string;
  async plan(_context?: ContextBundle, options?: { laneId?: string }): Promise<Plan> {
    this.called = true;
    this.calls += 1;
    this.lastLaneId = options?.laneId;
    return basePlan;
  }
}

class StubArchitectPlannerPlanHintProbe {
  planHint = "PLAN:\n- Use hint\nTARGETS:\n- file.ts\nRISK: low\nVERIFY:\n- Verify behavior";
  lastPlanHintPresent = false;
  lastPlanHintValue: string | undefined;
  async planWithRequest(
    _context?: ContextBundle,
    options: { planHint?: string } = {},
  ): Promise<{ plan: Plan; warnings: string[] }> {
    this.lastPlanHintPresent = Object.prototype.hasOwnProperty.call(
      options,
      "planHint",
    );
    this.lastPlanHintValue = options.planHint;
    return { plan: basePlan, warnings: [] };
  }
}

class StubArchitectPlannerWithRequest {
  calls = 0;
  instructionHints: Array<string | undefined> = [];
  async planWithRequest(
    _context?: ContextBundle,
    options?: { instructionHint?: string },
  ): Promise<{ plan: Plan; request?: any }> {
    this.calls += 1;
    this.instructionHints.push(options?.instructionHint);
    if (this.calls === 1) {
      return {
        plan: basePlan,
        request: {
          version: "v1",
          role: "architect",
          request_id: "req-1",
          needs: [
            { type: "docdex.search", query: "needs context", limit: 5 },
            { type: "docdex.open", path: "src/index.ts", start_line: 1, end_line: 5 },
          ],
        },
      };
    }
    return { plan: basePlan };
  }
}

class StubArchitectPlannerRequestLoopNonDsl {
  calls = 0;
  responseFormats: Array<string | undefined> = [];
  async planWithRequest(
    _context?: ContextBundle,
    options?: { responseFormat?: { type?: string } },
  ): Promise<{ plan: Plan; request?: { request_id: string }; warnings: string[] }> {
    this.calls += 1;
    this.responseFormats.push(options?.responseFormat?.type);
    return {
      plan: basePlan,
      request: { request_id: `loop-req-${this.calls}` },
      warnings: ["architect_output_unstructured_plaintext"],
    };
  }
}

class StubArchitectPlannerRequestLoopNoWarning {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; request?: { request_id: string }; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: basePlan,
      request: { request_id: `loop-nowarn-req-${this.calls}` },
      warnings: [],
    };
  }
}

class StubArchitectPlannerWithRawOutput {
  async planWithRequest(): Promise<{ plan: Plan; raw: string; warnings: string[] }> {
    return {
      plan: basePlan,
      raw: "PLAN:\n- step\nTARGETS:\n- file.ts\nRISK: low\nVERIFY:\n- Run unit tests: pnpm test --filter codali",
      warnings: [],
    };
  }
}

class StubArchitectPlannerNonDslThenDsl {
  calls = 0;
  instructionHints: Array<string | undefined> = [];
  responseFormats: Array<string | undefined> = [];
  contexts: ContextBundle[] = [];
  async planWithRequest(
    context: ContextBundle,
    options?: { instructionHint?: string; responseFormat?: { type?: string } },
  ): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    this.instructionHints.push(options?.instructionHint);
    this.responseFormats.push(options?.responseFormat?.type);
    this.contexts.push(context);
    const scopedTarget = context.selection?.focus?.[0] ?? "file.ts";
    const scopedPlan: Plan = {
      ...basePlan,
      target_files: [scopedTarget],
    };
    if (this.calls === 1) {
      return {
        plan: scopedPlan,
        warnings: ["architect_output_unstructured_plaintext"],
      };
    }
    return { plan: scopedPlan, warnings: [] };
  }
}

class StubArchitectPlannerAlwaysNonDsl {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: basePlan,
      warnings: ["architect_output_unstructured_plaintext"],
    };
  }
}

class StubArchitectPlannerEmptyVerificationThenConcrete {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        plan: {
          ...basePlan,
          verification: [],
        },
        warnings: [],
      };
    }
    return { plan: basePlan, warnings: [] };
  }
}

class StubArchitectPlannerAlwaysEmptyVerification {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: {
        ...basePlan,
        verification: ["Verify changes."],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerFallbackRecovery {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        plan: {
          ...basePlan,
          steps: [
            "Review focus files for the request.",
            "Map request requirements to implementation targets.",
            "Apply changes aligned to the request and constraints.",
            "Run verification steps and summarize results.",
          ],
          risk_assessment: "medium: fallback plan generated from context",
          target_files: ["src/index.ts"],
        },
        warnings: ["architect_output_used_json_fallback"],
      };
    }
    return { plan: basePlan, warnings: [] };
  }
}

class StubArchitectPlannerRepeatedOutput {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls <= 2) {
      return {
        plan: basePlan,
        warnings: ["architect_output_used_json_fallback"],
      };
    }
    return { plan: basePlan, warnings: [] };
  }
}

class StubArchitectPlannerRepeatedOutputNonFallback {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls <= 2) {
      return {
        plan: basePlan,
        warnings: ["architect_plan_quality_warning"],
      };
    }
    return { plan: basePlan, warnings: [] };
  }
}

class StubArchitectPlannerEndpointGuard {
  calls = 0;
  targetHistory: string[][] = [];
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls === 1) {
      const target_files = ["src/public/app.js"];
      this.targetHistory.push(target_files);
      return {
        plan: {
          ...basePlan,
          target_files,
        },
        warnings: [],
      };
    }
    const target_files = ["src/server.js"];
    this.targetHistory.push(target_files);
    return {
      plan: {
        ...basePlan,
        target_files,
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerEndpointAlwaysFrontend {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: {
        ...basePlan,
        target_files: ["src/public/app.js"],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerLowAlignmentGuard {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        plan: {
          ...basePlan,
          target_files: ["src/ui/home.tsx"],
        },
        warnings: [],
      };
    }
    return {
      plan: {
        ...basePlan,
        target_files: ["src/payment/reconciliation.ts"],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerHighDrift {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        plan: {
          ...basePlan,
          target_files: ["src/runtime/engine.ts"],
        },
        warnings: ["architect_plan_quality_warning"],
      };
    }
    if (this.calls === 2) {
      return {
        plan: {
          ...basePlan,
          target_files: ["src/ui/shell.ts"],
        },
        warnings: ["architect_plan_quality_warning"],
      };
    }
    return {
      plan: {
        ...basePlan,
        target_files: ["src/ui/shell.ts"],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerAlwaysWeakPlan {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: {
        ...basePlan,
        target_files: ["path/to/file.ts"],
        verification: ["Run unit tests: pnpm test --filter codali"],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerInvalidTargetThenValid {
  calls = 0;
  instructionHints: Array<string | undefined> = [];
  async planWithRequest(
    _context?: ContextBundle,
    options?: { instructionHint?: string },
  ): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    this.instructionHints.push(options?.instructionHint);
    if (this.calls === 1) {
      return {
        plan: {
          ...basePlan,
          target_files: ["src/nonexistent.ts"],
        },
        warnings: [],
      };
    }
    return {
      plan: {
        ...basePlan,
        target_files: ["src/example.ts"],
      },
      warnings: [],
    };
  }
}

class StubArchitectPlannerOutsideScopeWarning {
  calls = 0;
  async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    return {
      plan: {
        ...basePlan,
        target_files: ["src/public/index.html"],
      },
      warnings: ["plan_targets_outside_context:src/public/index.html"],
    };
  }
}

class StubArchitectPlannerValidateOnlyFallback {
  calls = 0;
  validateOnlyCalls = 0;
  fullPlanningCalls = 0;
  async planWithRequest(
    _context?: ContextBundle,
    options?: { validateOnly?: boolean },
  ): Promise<{ plan: Plan; warnings: string[] }> {
    this.calls += 1;
    if (options?.validateOnly) {
      this.validateOnlyCalls += 1;
      throw new PlanHintValidationError({
        message: "invalid plan hint",
        warnings: ["plan_missing_steps"],
        issues: ["plan_hint_missing_required_fields"],
      });
    }
    this.fullPlanningCalls += 1;
    return { plan: basePlan, warnings: [] };
  }
}

class StubBuilderRunner {
  calls = 0;
  lastLaneId?: string;
  async run(
    _plan?: Plan,
    _context?: ContextBundle,
    options?: { laneId?: string; note?: string },
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
  private result: CriticResult;
  constructor(result: CriticResult) {
    this.result = result;
  }
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

class StubCriticWithRequest {
  calls = 0;
  lastLaneId?: string;
  async evaluate(
    _plan?: Plan,
    _builderOutput?: string,
    _touched?: string[],
    options?: { laneId?: string },
  ): Promise<CriticResult> {
    this.calls += 1;
    this.lastLaneId = options?.laneId;
    if (this.calls === 1) {
      return {
        status: "FAIL",
        reasons: ["needs context"],
        retryable: true,
        request: { version: "v1", role: "critic", request_id: "crit-1", needs: [] },
      };
    }
    return { status: "PASS", reasons: [], retryable: false };
  }
}

class StubMemoryWriteback {
  calls: Array<{ failures: number; maxRetries: number; lesson: string }> = [];
  async persist(input: { failures: number; maxRetries: number; lesson: string }): Promise<void> {
    this.calls.push(input);
  }
}

class StubArchitectPlannerReview extends StubArchitectPlanner {
  reviewCalls = 0;
  async reviewBuilderOutput(): Promise<{ status: "PASS" | "RETRY"; reasons: string[]; feedback: string[] }> {
    this.reviewCalls += 1;
    if (this.reviewCalls === 1) {
      return { status: "RETRY", reasons: ["request not satisfied"], feedback: ["fix output"] };
    }
    return { status: "PASS", reasons: ["request intent covered"], feedback: [] };
  }
}

class StubBuilderRunnerSemanticRetry extends StubBuilderRunner {
  async run(): Promise<BuilderRunResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        finalMessage: {
          role: "assistant",
          content: "Updated generic UI copy.",
        },
        messages: [],
        toolCallsExecuted: 0,
      };
    }
    return {
      finalMessage: {
        role: "assistant",
        content: JSON.stringify({
          patches: [
            {
              action: "replace",
              file: "src/server/healthz.ts",
              search_block: "return { ok: true };",
              replace_block: "appendUptimeLog(); return { ok: true };",
            },
          ],
        }),
      },
      messages: [],
      toolCallsExecuted: 0,
    };
  }
}

class StubLogger {
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  artifacts: Array<{ phase: string; kind: string; payload: unknown; path: string }> = [];
  async log(type: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ type, data });
  }
  async writePhaseArtifact(phase: string, kind: string, payload: unknown): Promise<string> {
    const path = `${phase}-${kind}.json`;
    this.artifacts.push({ phase, kind, payload, path });
    return path;
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
  assert.equal(architect.calls, 1);
  assert.equal(memory.calls.length, 0);
});

test("SmartPipeline runs research phase before architect in deep mode", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(assembler.researchCalls, 1);
  assert.ok(result.research?.toolRuns.length);
  const researchStart = logger.events.find(
    (event) => event.type === "phase_start" && event.data.phase === "research",
  );
  const researchEnd = logger.events.find(
    (event) => event.type === "phase_end" && event.data.phase === "research",
  );
  assert.ok(researchStart);
  assert.ok(researchEnd);
  const researchInputIndex = logger.artifacts.findIndex(
    (artifact) => artifact.phase === "research" && artifact.kind === "input",
  );
  const researchOutputIndex = logger.artifacts.findIndex(
    (artifact) => artifact.phase === "research" && artifact.kind === "output",
  );
  const architectInputIndex = logger.artifacts.findIndex(
    (artifact) => artifact.phase === "architect" && artifact.kind === "input",
  );
  const telemetryEvent = logger.events.find(
    (event) => event.type === "investigation_telemetry",
  );
  assert.ok(researchInputIndex >= 0);
  assert.ok(researchOutputIndex >= 0);
  assert.ok(architectInputIndex >= 0);
  assert.ok(researchInputIndex < architectInputIndex);
  assert.ok(researchOutputIndex < architectInputIndex);
  assert.ok(telemetryEvent);
  assert.equal(result.context.research?.status, "completed");
  assert.equal(result.context.research?.tool_usage?.search, 1);
  const telemetry = telemetryEvent?.data as Record<string, unknown>;
  assert.equal(telemetry.phase, "research");
  assert.equal(telemetry.status, "completed");
  const evidenceGate = telemetry.evidence_gate as { status?: string };
  const quota = telemetry.quota as { status?: string };
  const budget = telemetry.budget as { status?: string };
  assert.equal(evidenceGate?.status, "pass");
  assert.equal(quota?.status, "met");
  assert.equal(budget?.status, "met");
  assert.ok(typeof telemetry.duration_ms === "number");
  assert.ok(typeof telemetry.summary === "string");
  const toolUsage = telemetry.tool_usage as Record<string, { total?: number }>;
  assert.ok(toolUsage["docdex.search"]);
  assert.equal(toolUsage["docdex.search"]?.total, 1);
  const totals = telemetry.tool_usage_totals as { total?: number };
  assert.equal(totals.total, 1);
});

test("SmartPipeline suppresses plan hints in deep mode", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlannerPlanHintProbe();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(architect.lastPlanHintPresent, true);
  assert.equal(architect.lastPlanHintValue, undefined);
  const suppressionEvent = logger.events.find((event) => event.type === "plan_hint_suppressed");
  assert.ok(suppressionEvent);
});

test("SmartPipeline preserves plan hints when deep mode is disabled", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlannerPlanHintProbe();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(architect.lastPlanHintPresent, false);
  const suppressionEvent = logger.events.find((event) => event.type === "plan_hint_suppressed");
  assert.equal(suppressionEvent, undefined);
});

test("SmartPipeline blocks deep mode when tool quota is unmet", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: {
        search: 2,
        openOrSnippet: 0,
        symbolsOrAst: 0,
        impact: 0,
        tree: 0,
        dagExport: 0,
      },
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("do thing"),
    (error) =>
      assertDeepInvestigationError(error, "deep_investigation_quota_unmet"),
  );
  assert.equal(architect.called, false);
  const quotaEvent = logger.events.find(
    (event) => event.type === "investigation_quota_failed",
  );
  assert.ok(quotaEvent);
  const data = quotaEvent?.data as Record<string, unknown>;
  const missing = data.missing as string[] | undefined;
  assert.ok(missing?.includes("search"));
});

test("SmartPipeline tolerates tool quota misses when docdex tool failures are explicit", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler(baseContext, {
    toolRuns: [
      { tool: "docdex.search", ok: false, error: "internal error" },
      { tool: "docdex.symbols", ok: false, error: "internal error" },
      { tool: "docdex.ast", ok: false, error: "internal error" },
      { tool: "docdex.open", ok: true },
    ],
    warnings: [
      "research_docdex_search_failed",
      "research_docdex_symbols_failed:src/public/app.js",
      "research_docdex_ast_failed:src/public/app.js",
    ],
    outputs: {
      searchResults: [],
      snippets: [],
      symbols: [],
      ast: [],
      impact: [],
      impactDiagnostics: [],
    },
  });
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: {
        search: 1,
        openOrSnippet: 0,
        symbolsOrAst: 1,
        impact: 0,
        tree: 0,
        dagExport: 0,
      },
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(architect.called, true);
  const toleratedEvent = logger.events.find(
    (event) => event.type === "investigation_quota_warning_tolerated",
  );
  assert.ok(toleratedEvent);
  const failedEvent = logger.events.find(
    (event) => event.type === "investigation_quota_failed",
  );
  assert.equal(failedEvent, undefined);
});

test("SmartPipeline blocks deep mode when evidence gate is unmet", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: {
        minSearchHits: 1,
        minOpenOrSnippet: 0,
        minSymbolsOrAst: 0,
        minImpact: 0,
        maxWarnings: 0,
      },
    },
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("do thing"),
    (error) =>
      assertDeepInvestigationError(error, "deep_investigation_evidence_unmet"),
  );
  assert.equal(architect.called, false);
  const evidenceEvent = logger.events.find(
    (event) => event.type === "investigation_evidence_failed",
  );
  assert.ok(evidenceEvent);
  const data = evidenceEvent?.data as Record<string, unknown>;
  const missing = data.missing as string[] | undefined;
  assert.ok(missing?.includes("search_hits"));
});

test("SmartPipeline tolerates warnings-only evidence gate misses", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler(baseContext, {
    ...baseResearchOutput,
    warnings: ["research_docdex_search_failed"],
    outputs: {
      ...baseResearchOutput.outputs,
      searchResults: [
        {
          query: "do thing",
          hits: [{ doc_id: "hit-1", path: "src/a.ts", score: 0.1 }],
        },
      ],
    },
  });
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: {
        minSearchHits: 1,
        minOpenOrSnippet: 0,
        minSymbolsOrAst: 0,
        minImpact: 0,
        maxWarnings: 0,
      },
    },
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(architect.called, true);
  const toleratedEvent = logger.events.find(
    (event) => event.type === "investigation_evidence_warning_tolerated",
  );
  assert.ok(toleratedEvent);
  const evidenceFailedEvent = logger.events.find(
    (event) => event.type === "investigation_evidence_failed",
  );
  assert.equal(evidenceFailedEvent, undefined);
});

test("SmartPipeline runs additional research cycles to satisfy evidence gate", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  class EvidenceGateAssembler extends StubContextAssembler {
    async runResearchTools(request: string): Promise<ResearchToolExecution> {
      this.researchCalls += 1;
      this.lastResearchRequest = request;
      const hits =
        this.researchCalls === 1
          ? [{ doc_id: "evidence-hit-1", path: "src/a.ts", score: 0.1 }]
          : [
              { doc_id: "evidence-hit-1", path: "src/a.ts", score: 0.1 },
              { doc_id: "evidence-hit-2", path: "src/b.ts", score: 0.2 },
            ];
      return {
        ...baseResearchOutput,
        outputs: {
          ...baseResearchOutput.outputs,
          searchResults: [{ query: "evidence-gate", hits }],
        },
      };
    }
  }
  const assembler = new EvidenceGateAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: {
        minCycles: 1,
        minSeconds: 0,
        maxCycles: 2,
      },
      evidenceGate: {
        minSearchHits: 2,
        minOpenOrSnippet: 0,
        minSymbolsOrAst: 0,
        minImpact: 0,
        maxWarnings: 10,
      },
    },
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(assembler.researchCalls, 2);
  assert.equal(result.research?.evidenceGate?.status, "pass");
  assert.equal(architect.called, true);
});

test("SmartPipeline runs additional research cycles to satisfy budget", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: {
        minCycles: 2,
        minSeconds: 0,
        maxCycles: 2,
      },
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(assembler.researchCalls, 2);
  assert.equal(result.research?.cycles, 2);
  assert.equal(result.research?.budget?.status, "met");
  assert.equal(architect.called, true);
});

test("SmartPipeline fails when investigation budget remains unmet", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: {
        minCycles: 3,
        minSeconds: 0,
        maxCycles: 2,
      },
      evidenceGate: minimalEvidenceGate,
    },
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("do thing"),
    (error) =>
      assertDeepInvestigationError(error, "deep_investigation_budget_unmet"),
  );
  assert.equal(assembler.researchCalls, 2);
  const budgetEvent = logger.events.find(
    (event) => event.type === "investigation_budget_failed",
  );
  assert.ok(budgetEvent);
});

test("SmartPipeline skips research phase when deep mode is disabled", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(assembler.researchCalls, 0);
  const researchArtifact = logger.artifacts.find((artifact) => artifact.phase === "research");
  assert.equal(researchArtifact, undefined);
  const researchEvent = logger.events.find(
    (event) => event.data.phase === "research",
  );
  assert.equal(researchEvent, undefined);
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

test("SmartPipeline ignores fast path in deep mode", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = new StubArchitectPlanner();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
    fastPath: () => true,
    deepMode: true,
    deepInvestigation: {
      toolQuota: minimalToolQuota,
      investigationBudget: minimalInvestigationBudget,
      evidenceGate: minimalEvidenceGate,
    },
  });

  await pipeline.run("deep investigation");
  assert.equal(architect.called, true);
  const overrideEvent = logger.events.find(
    (event) => event.type === "fast_path_overridden",
  );
  assert.ok(overrideEvent);
});

test("SmartPipeline fulfills architect requests before planning", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerWithRequest();
  const refreshedContext: ContextBundle = {
    ...baseContext,
    queries: ["needs context"],
  };
  const assembler = new StubContextAssembler([baseContext, refreshedContext]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  await pipeline.run("needs context");
  assert.equal(assembler.lastRequestId, "req-1");
  assert.equal(assembler.calls, 2);
  assert.ok(
    assembler.lastAssembleOptions?.additionalQueries?.includes("needs context"),
  );
  assert.ok(
    assembler.lastAssembleOptions?.preferredFiles?.includes("src/index.ts"),
  );
  assert.ok(architect.calls >= 2);
  assert.ok((architect.instructionHints[1] ?? "").includes("REVISION REQUIRED"));
  assert.ok((architect.instructionHints[1] ?? "").includes("architect_request_recovery"));
  assert.ok((architect.instructionHints[1] ?? "").includes("Do not restart from scratch."));
});

test("SmartPipeline bounds repeated architect request loops and fail-closes non-DSL architect output", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerRequestLoopNonDsl();
  const refreshedContext: ContextBundle = {
    ...baseContext,
    queries: ["needs context", "retry loop"],
  };
  const assembler = new StubContextAssembler([baseContext, refreshedContext]);
  const builder = new StubBuilderRunner();
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("needs context"),
    /Architect quality gate failed before builder: (blocking_architect_warnings|unresolved_architect_request)/i,
  );
  assert.equal(architect.calls, 3);
  assert.equal(assembler.calls, 2);
  assert.equal(builder.calls, 0);
  assert.ok((assembler.lastRequestId ?? "").startsWith("loop-req-"));
  assert.equal(architect.responseFormats[0], undefined);
  assert.equal(architect.responseFormats[1], undefined);
  assert.equal(architect.responseFormats[2], undefined);
  const revisionRequested = logger.events.find(
    (event) => event.type === "architect_revision_requested",
  );
  assert.ok(revisionRequested);
  const qualityGateEvent = logger.events.find(
    (event) => event.type === "architect_quality_gate" && event.data.stage === "pre_builder",
  );
  assert.ok(qualityGateEvent);
});

test("SmartPipeline fail-closes unresolved architect request loops even without non-DSL warnings", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerRequestLoopNoWarning();
  const refreshedContext: ContextBundle = {
    ...baseContext,
    queries: ["needs context", "retry loop"],
  };
  const assembler = new StubContextAssembler([baseContext, refreshedContext]);
  const builder = new StubBuilderRunner();
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("needs context"),
    /Architect quality gate failed before builder: unresolved_architect_request/i,
  );
  assert.equal(architect.calls, 3);
  assert.equal(assembler.calls, 2);
  assert.equal(builder.calls, 0);
  const revisionRequested = logger.events.find(
    (event) => event.type === "architect_revision_requested",
  );
  assert.ok(revisionRequested);
  const qualityGateEvent = logger.events.find(
    (event) => event.type === "architect_quality_gate"
      && event.data.stage === "pre_builder"
      && Array.isArray(event.data.reasons)
      && event.data.reasons.includes("unresolved_architect_request"),
  );
  assert.ok(qualityGateEvent);
});

test("SmartPipeline stores raw and normalized architect outputs in artifacts", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlannerWithRawOutput() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  const architectOutput = logger.artifacts.find(
    (artifact) => artifact.phase === "architect" && artifact.kind === "output",
  );
  if (!architectOutput) {
    assert.fail("missing architect output artifact");
  }
  const payload = architectOutput.payload as Record<string, unknown>;
  assert.equal(typeof payload.raw_output, "string");
  assert.ok((payload.raw_output as string).includes("PLAN:"));
  assert.deepEqual(payload.normalized_output, basePlan);
  assert.equal(typeof payload.structural_grounding, "object");
  assert.ok(payload.structural_grounding !== null);
  assert.equal(typeof payload.target_drift, "object");
  assert.ok(payload.target_drift !== null);
});

test("SmartPipeline stores normalized architect output in fast path artifact payload", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
    fastPath: () => true,
  });

  await pipeline.run("do thing");
  const architectOutput = logger.artifacts.find(
    (artifact) => artifact.phase === "architect" && artifact.kind === "output",
  );
  if (!architectOutput) {
    assert.fail("missing architect output artifact");
  }
  const payload = architectOutput.payload as Record<string, unknown>;
  assert.equal(payload.source, "fast_path");
  assert.equal(payload.raw_output, "");
  assert.equal(typeof payload.normalized_output, "object");
  assert.ok(payload.normalized_output !== null);
  const normalized = payload.normalized_output as Record<string, unknown>;
  assert.ok(Array.isArray(normalized.steps));
  assert.ok(Array.isArray(normalized.target_files));
  assert.ok(Array.isArray(normalized.verification));
});

test("SmartPipeline revises non-DSL architect output in-place and proceeds when revision is valid", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerNonDslThenDsl();
  const builder = new StubBuilderRunner();
  const logger = new StubLogger();
  const context: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/index.ts"],
      periphery: ["docs/rfp.md"],
      all: ["src/index.ts", "docs/rfp.md"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/index.ts",
        role: "focus",
        content: "const value = 1;\n",
        size: 18,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
      {
        path: "docs/rfp.md",
        role: "periphery",
        content: "# spec\n",
        size: 7,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
    snippets: [{ path: "docs/rfp.md", content: "spec" }],
    symbols: [{ path: "docs/rfp.md", summary: "doc" }],
    ast: [{ path: "docs/rfp.md", nodes: [] }],
    impact: [{ file: "docs/rfp.md", inbound: [], outbound: [] }],
    impact_diagnostics: [{ file: "docs/rfp.md", diagnostics: {} }],
    memory: [{ text: "m1", source: "repo" }, { text: "m2", source: "repo" }, { text: "m3", source: "repo" }, { text: "m4", source: "repo" }],
    profile: [{ content: "p1", source: "profile" }, { content: "p2", source: "profile" }, { content: "p3", source: "profile" }, { content: "p4", source: "profile" }],
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 2);
  assert.equal(builder.calls, 1);
  assert.equal(architect.responseFormats[0], undefined);
  assert.ok((architect.instructionHints[1] ?? "").includes("REVISION REQUIRED"));
  const architectArtifacts = logger.artifacts.filter(
    (artifact) => artifact.phase === "architect" && artifact.kind === "output",
  );
  assert.equal(architectArtifacts.length, 2);
  const pass1 = architectArtifacts.find(
    (artifact) => (artifact.payload as Record<string, unknown>).pass === 1,
  );
  assert.ok(pass1);
  assert.equal((pass1?.payload as Record<string, unknown>).response_format_type, "default");
  const revisionArtifact = architectArtifacts.find(
    (artifact) => (artifact.payload as Record<string, unknown>).source === "revision_retry",
  );
  assert.ok(revisionArtifact);
});

test("Regression: repeated non-DSL architect output fails closed before builder", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerAlwaysNonDsl();
  const assembler = new StubContextAssembler();
  const builder = new StubBuilderRunner();
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("do thing"),
    /Architect quality gate failed before builder: blocking_architect_warnings/i,
  );
  assert.equal(architect.calls, 2);
  assert.equal(assembler.calls, 1);
  assert.equal(builder.calls, 0);
  const degradedEvent = logger.events.find(
    (event) =>
      event.type === "architect_degraded" &&
      event.data.reason === "non_dsl_repeated_after_strict_retry",
  );
  assert.equal(degradedEvent, undefined);
  const recoveryArtifact = logger.artifacts.find(
    (artifact) =>
      artifact.phase === "architect" &&
      artifact.kind === "output" &&
      (artifact.payload as Record<string, unknown>).source === "non_dsl_recovery",
  );
  assert.equal(recoveryArtifact, undefined);
});

test("SmartPipeline triggers AGENT_REQUEST recovery when structural grounding is weak", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/server/healthz-logging.ts"],
        },
        warnings: [],
      };
    },
  };
  const logger = new StubLogger();
  const events: Array<{ type: string; phase?: string; message?: string }> = [];
  const weakContext: ContextBundle = {
    ...baseContext,
    selection: { focus: [], periphery: [], all: [], low_confidence: true },
    warnings: [
      "docdex_symbols_failed:src/server/health.ts",
      "docdex_ast_failed:src/server/health.ts",
      "impact_graph_sparse:src/server/health.ts",
    ],
    symbols: [],
    ast: [],
    impact: [],
  };
  const recoveredContext: ContextBundle = {
      ...baseContext,
      selection: {
        focus: ["src/server/healthz-logging.ts"],
        periphery: [],
        all: ["src/server/healthz-logging.ts"],
        low_confidence: false,
      },
      warnings: [],
      symbols: [{ path: "src/server/healthz-logging.ts", summary: "health handler" }],
      ast: [{ path: "src/server/healthz-logging.ts", nodes: [] }],
      impact: [{ file: "src/server/healthz-logging.ts", inbound: [], outbound: [] }],
    };
  const assembler = new StubContextAssembler([weakContext, recoveredContext]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    onEvent: (event) => events.push(event as any),
    maxRetries: 1,
  });

  const result = await pipeline.run("add healthz endpoint logging");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  const recoveryArtifact = logger.artifacts.find(
    (artifact) =>
      artifact.phase === "architect" &&
      artifact.kind === "output" &&
      (artifact.payload as Record<string, unknown>).source === "structural_grounding_recovery",
  );
  assert.equal(recoveryArtifact, undefined);
  assert.ok(!events.some((event) => (event.message ?? "").includes("weak_structural_grounding")));
});

test("SmartPipeline does not trigger structural grounding recovery for not-applicable structural warnings", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html"],
          verification: ["Manual browser check: open http://localhost:3000 and confirm header renders."],
        },
        warnings: [],
      };
    },
  };
  const events: Array<{ type: string; phase?: string; message?: string }> = [];
  const neutralContext: ContextBundle = {
    ...baseContext,
    request: "Add summary text below welcome header",
    selection: {
      focus: ["src/public/index.html"],
      periphery: [],
      all: ["src/public/index.html"],
      low_confidence: false,
    },
    warnings: [
      "docdex_symbols_not_applicable:src/public/index.html",
      "docdex_ast_not_applicable:src/public/index.html",
    ],
    snippets: [{ path: "src/public/index.html", content: "<h1>Welcome</h1>" }],
    files: [
      {
        path: "src/public/index.html",
        role: "focus",
        content: "<h1>Welcome</h1>",
        size: 16,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const assembler = new StubContextAssembler(neutralContext);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    onEvent: (event) => events.push(event as any),
    maxRetries: 1,
  });

  const result = await pipeline.run("Add summary text below welcome header");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  assert.ok(!events.some((event) => (event.message ?? "").includes("weak_structural_grounding")));
});

test("SmartPipeline accepts wrapper-noise repaired architect output without strict retry", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html"],
          verification: ["Manual browser check: open http://localhost:3000 and verify the sample image appears."],
        },
        warnings: [
          "architect_output_contains_think",
          "architect_output_contains_fence",
          "architect_output_repaired",
          "architect_output_repair_reason:wrapper_noise",
        ],
      };
    },
  };
  const context: ContextBundle = {
    ...baseContext,
    request: "Add sample image under welcome header",
    selection: {
      focus: ["src/public/index.html"],
      periphery: [],
      all: ["src/public/index.html"],
      low_confidence: false,
    },
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add sample image under welcome header");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
});

test("SmartPipeline treats prose-request suppression warning as non-blocking", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html"],
          verification: ["Manual browser check: open http://localhost:3000 and verify task stats render under the header."],
        },
        warnings: ["architect_output_prose_request_suppressed"],
      };
    },
  };
  const context: ContextBundle = {
    ...baseContext,
    request: "Add task stats section under welcome header",
    selection: {
      focus: ["src/public/index.html"],
      periphery: [],
      all: ["src/public/index.html"],
      low_confidence: false,
    },
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add task stats section under welcome header");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
});

test("SmartPipeline accepts duplicate-section repaired architect output without strict retry", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html"],
          verification: ["Manual browser check: open http://localhost:3000 and verify section order."],
        },
        warnings: [
          "architect_output_multiple_section_blocks",
          "architect_output_repaired",
          "architect_output_repair_reason:duplicate_sections",
        ],
      };
    },
  };
  const context: ContextBundle = {
    ...baseContext,
    request: "Add info section above footer",
    selection: {
      focus: ["src/public/index.html"],
      periphery: [],
      all: ["src/public/index.html"],
      low_confidence: false,
    },
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add info section above footer");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
});

test("SmartPipeline stabilizes high pass-to-pass target drift without extra recovery pass", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerHighDrift();
  const logger = new StubLogger();
  const assembler = new StubContextAssembler([
    {
      ...baseContext,
      selection: {
        focus: ["src/runtime/engine.ts"],
        periphery: [],
        all: ["src/runtime/engine.ts"],
        low_confidence: false,
      },
      symbols: [{ path: "src/runtime/engine.ts", summary: "engine" }],
      ast: [{ path: "src/runtime/engine.ts", nodes: [] }],
      impact: [{ file: "src/runtime/engine.ts", inbound: [], outbound: [] }],
    },
    {
      ...baseContext,
      selection: {
        focus: ["src/ui/shell.ts"],
        periphery: [],
        all: ["src/ui/shell.ts"],
        low_confidence: false,
      },
      symbols: [{ path: "src/ui/shell.ts", summary: "ui shell" }],
      ast: [{ path: "src/ui/shell.ts", nodes: [] }],
      impact: [{ file: "src/ui/shell.ts", inbound: [], outbound: [] }],
    },
  ]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("stabilize runtime engine and shell module behavior");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
  assert.ok(result.plan.target_files.includes("src/runtime/engine.ts"));
  const recoveryArtifact = logger.artifacts.find(
    (artifact) =>
      artifact.phase === "architect" &&
      artifact.kind === "output" &&
      (artifact.payload as Record<string, unknown>).source === "target_drift_recovery",
  );
  assert.equal(recoveryArtifact, undefined);
});

test("SmartPipeline degrades empty architect verification into concrete checks", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerEmptyVerificationThenConcrete();
  const refreshedContext: ContextBundle = {
    ...baseContext,
    queries: ["verification retry"],
  };
  const assembler = new StubContextAssembler([baseContext, refreshedContext]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.ok(result.plan.verification.length > 0);
  assert.ok(
    result.plan.verification.some((step) => /unit tests|unit\/integration tests|manual browser check|manual api check/i.test(step)),
  );
  assert.equal(architect.calls, 2);
});

test("SmartPipeline degrades non-concrete architect verification when recovery has no new context", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerAlwaysEmptyVerification();
  const refreshedContext: ContextBundle = {
    ...baseContext,
    queries: ["verification degrade"],
  };
  const assembler = new StubContextAssembler([baseContext, refreshedContext]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.ok(result.plan.verification.length > 0);
  assert.ok(
    result.plan.verification.some((step) => /unit tests|unit\/integration tests|manual browser check|manual api check/i.test(step)),
  );
  assert.equal(architect.calls, 2);
  assert.equal(assembler.calls, 1);
});

test("SmartPipeline uses AGENT_REQUEST recovery before final pass for fallback/generic plans", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerFallbackRecovery();
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/index.ts"],
      periphery: [],
      all: ["src/index.ts"],
      low_confidence: false,
    },
  };
  const contextB: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/index.ts"],
      periphery: ["docs/spec.md"],
      all: ["src/index.ts", "docs/spec.md"],
      low_confidence: false,
    },
  };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Implement task state persistence");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  assert.equal(assembler.lastRequestId, undefined);
  assert.ok(result.plan.steps[0]?.includes("Review focus files"));
});

test("Regression: identical pass outputs stop after a single retry when architect passes are capped", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerRepeatedOutputNonFallback();
  const contextA: ContextBundle = { ...baseContext, request: "first" };
  const contextB: ContextBundle = { ...baseContext, request: "second" };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await pipeline.run("do thing");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  const retryEvent = logger.events.find(
    (event) => event.type === "architect_retry_strategy" && event.data.action === "context_refresh_with_alternate_hint",
  );
  assert.equal(retryEvent, undefined);
});

test("Regression: pre-builder quality gate fails closed for weak plans with invalid targets", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerAlwaysWeakPlan();
  const logger = new StubLogger();
  const context: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/taskStore.js"],
      periphery: [],
      all: ["src/taskStore.js"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/taskStore.js",
        role: "focus",
        content: "export const store = {};",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("Implement durable task retry queue"),
    /Architect quality gate failed before builder: (invalid_target_paths|missing_concrete_targets)/i,
  );
  const degradeArtifact = logger.artifacts.find(
    (artifact) =>
      artifact.phase === "architect" &&
      artifact.kind === "output" &&
      (artifact.payload as Record<string, unknown>).source === "quality_gate_degrade",
  );
  assert.ok(degradeArtifact);
});

test("SmartPipeline requests context recovery when architect targets are invalid", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerInvalidTargetThenValid();
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/example.ts"],
      periphery: [],
      all: ["src/example.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/example.ts",
        role: "focus",
        content: "export const value = 1;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
    queries: ["initial"],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["initial", "refreshed"],
  };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Update src/example.ts");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 2);
  assert.equal(assembler.lastRequestId, undefined);
  assert.equal(assembler.calls, 1);
  assert.ok((architect.instructionHints[1] ?? "").includes("invalid_target_paths"));
  assert.ok((architect.instructionHints[1] ?? "").includes("Do not restart from scratch."));
  assert.ok(result.plan.target_files.includes("src/example.ts"));
  assert.equal(builder.calls, 1);
});

test("SmartPipeline does not pre-builder fail on out-of-context warning when target exists in repo map", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerOutsideScopeWarning();
  const builder = new StubBuilderRunner();
  const context: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/public/app.js"],
      periphery: [],
      all: ["src/public/app.js"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/public/app.js",
        role: "focus",
        content: "export const render = () => {};",
        size: 31,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
    repo_map_raw: [
      "repo",
      "└── src",
      "    └── public",
      "        ├── app.js",
      "        └── index.html",
    ].join("\n"),
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add overdue badge to task list UI");
  assert.equal(result.criticResult.status, "PASS");
  assert.ok(result.plan.target_files.includes("src/public/index.html"));
  assert.equal(builder.calls, 1);
});

test("SmartPipeline fails closed before builder when invalid targets persist", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/nonexistent.ts"],
        },
        warnings: [],
      };
    },
  };
  const knownContext: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/existing.ts"],
      periphery: [],
      all: ["src/existing.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/existing.ts",
        role: "focus",
        content: "export const existing = true;\n",
        size: 29,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const assembler = new StubContextAssembler(knownContext);
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("Update src/nonexistent.ts"),
    /Architect quality gate failed before builder: invalid_target_paths/i,
  );
  assert.equal(builder.calls, 0);
});

test("SmartPipeline fail-closes degraded plans when unresolved targets remain invalid", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/index.ts"],
          verification: ["check behavior"],
        },
        warnings: [],
      };
    },
  };
  const knownContext: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/existing.ts"],
      periphery: [],
      all: ["src/existing.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/existing.ts",
        role: "focus",
        content: "export const existing = true;\n",
        size: 29,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
    repo_map_raw: [
      "repo",
      "└── src",
      "    └── existing.ts",
    ].join("\n"),
  };
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(knownContext) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("Update src/index.ts"),
    /Architect quality gate failed before builder: (invalid_target_paths|missing_concrete_targets)/i,
  );
  assert.equal(builder.calls, 0);
});

test("SmartPipeline allows repaired fallback plans when target change details are auto-enriched", { concurrency: false }, async () => {
  const architect = {
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html"],
          steps: ["Update UI."],
        },
        warnings: [
          "architect_output_used_json_fallback",
          "plan_missing_target_change_details:1",
        ],
      };
    },
  };
  const context: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/public/index.html"],
      periphery: [],
      all: ["src/public/index.html"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/public/index.html",
        role: "focus",
        content: "<main></main>\n",
        size: 14,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler(context) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add task completion stats section under the welcome header");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(builder.calls, 1);
});

test("Regression: endpoint intent with frontend-only targets triggers backend guardrail", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerEndpointGuard();
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/public/app.js"],
      periphery: ["src/server.js"],
      all: ["src/public/app.js", "src/server.js"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/public/app.js",
        role: "focus",
        content: "export const ui = true;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
      {
        path: "src/server.js",
        role: "periphery",
        content: "export const server = true;\n",
        size: 28,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["healthz backend handler"],
    symbols: [{ path: "src/server.js", summary: "health handler" }],
  };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Create a healthz endpoint for system health checks");
  assert.equal(architect.calls, 2);
  assert.equal(assembler.calls, 1);
  assert.deepEqual(architect.targetHistory[0], ["src/public/app.js"]);
  assert.deepEqual(architect.targetHistory[1], ["src/server.js"]);
  assert.equal(assembler.lastRequestId, undefined);
  assert.ok(result.plan.target_files.includes("src/server.js"));
});

test("Regression: endpoint intent degrades without hard-fail when backend targets stay missing", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerEndpointAlwaysFrontend();
  const logger = new StubLogger();
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/public/app.js"],
      periphery: ["src/server.js"],
      all: ["src/public/app.js", "src/server.js"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/public/app.js",
        role: "focus",
        content: "export const ui = true;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
      {
        path: "src/server.js",
        role: "periphery",
        content: "export const server = true;\n",
        size: 28,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["healthz backend guard"],
  };
  const contextC: ContextBundle = {
    ...contextA,
    queries: ["healthz backend guard", "backend missing"],
  };
  const assembler = new StubContextAssembler([contextA, contextB, contextC]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Create a healthz endpoint for system health checks");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 2);
  const degraded = logger.events.find(
    (event) => event.type === "architect_degraded" && event.data.reason === "relevance_endpoint_missing_backend",
  );
  assert.ok(degraded);
});

test("SmartPipeline low alignment guard refreshes context before finalizing plan", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerLowAlignmentGuard();
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/ui/home.tsx"],
      periphery: [],
      all: ["src/ui/home.tsx"],
      low_confidence: false,
    },
  };
  const contextB: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/payment/reconciliation.ts"],
      periphery: [],
      all: ["src/payment/reconciliation.ts"],
      low_confidence: false,
    },
  };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Implement home payment reconciliation ledger workflow");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  assert.ok(result.plan.target_files.includes("src/ui/home.tsx"));
});

test("SmartPipeline intent-aware alignment does not refresh valid UI target plans", { concurrency: false }, async () => {
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/public/index.html", "src/public/style.css"],
          verification: ["Manual browser check: open http://localhost:3000 and verify the contact form appears above footer."],
        },
        warnings: [],
      };
    },
  };
  const uiContext: ContextBundle = {
    ...baseContext,
    request: "Add a contact form on the main page above the footer",
    selection: {
      focus: ["src/public/index.html", "src/public/style.css"],
      periphery: [],
      all: ["src/public/index.html", "src/public/style.css"],
      low_confidence: false,
    },
  };
  const assembler = new StubContextAssembler(uiContext);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("Add a contact form on the main page above the footer");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.calls, 1);
  assert.equal(assembler.calls, 1);
  assert.ok(result.plan.target_files.includes("src/public/index.html"));
});

test("SmartPipeline falls back to full planning when validate-only plan hint fails", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerValidateOnlyFallback();
  const logger = new StubLogger();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.validateOnlyCalls, 1);
  assert.equal(architect.fullPlanningCalls, 1);
  const fallbackEvent = logger.events.find((event) => event.type === "architect_plan_hint_validate_fallback");
  assert.ok(fallbackEvent);
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

test("SmartPipeline retries builder when architect review requests changes", { concurrency: false }, async () => {
  const architect = new StubArchitectPlannerReview();
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
  });

  await pipeline.run("review me");
  assert.ok(architect.reviewCalls >= 2);
  assert.ok(builder.calls >= 2);
});

test("SmartPipeline skips architect replan loop for non-actionable architect review retry", { concurrency: false }, async () => {
  class StableBuilderRunner extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      return {
        finalMessage: {
          role: "assistant",
          content: JSON.stringify({
            patches: [
              {
                action: "replace",
                file: "src/server/healthz.ts",
                search_block: "return { ok: true };",
                replace_block: "appendUptimeLog(); return { ok: true };",
              },
            ],
          }),
        },
        messages: [],
        toolCallsExecuted: 0,
      };
    }
  }
  const logger = new StubLogger();
  const architect = {
    planCalls: 0,
    reviewCalls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.planCalls += 1;
      return {
        plan: {
          steps: ["Update src/server/healthz.ts to add uptime logging."],
          target_files: ["src/server/healthz.ts"],
          risk_assessment: "low",
          verification: ["Run integration tests for /healthz and validate uptime log output."],
        },
        warnings: [],
      };
    },
    async reviewBuilderOutput(): Promise<{
      status: "PASS" | "RETRY";
      reasons: string[];
      feedback: string[];
      warnings: string[];
    }> {
      this.reviewCalls += 1;
      return {
        status: "RETRY",
        reasons: [],
        feedback: [],
        warnings: ["architect_review_missing_status", "architect_review_missing_reasons"],
      };
    },
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler({
      ...baseContext,
      request: "Update src/server/healthz.ts",
      selection: {
        focus: ["src/server/healthz.ts"],
        periphery: [],
        all: ["src/server/healthz.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/server/healthz.ts",
          role: "focus",
          content: "export const healthz = () => ({ ok: true });\n",
          size: 44,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    }) as any,
    architectPlanner: architect as any,
    builderRunner: new StableBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("Update src/server/healthz.ts");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(architect.planCalls, 1);
  assert.equal(architect.reviewCalls, 1);
  const nonActionableEvent = logger.events.find(
    (event) => event.type === "architect_review_retry_non_actionable",
  );
  assert.ok(nonActionableEvent);
});

test("SmartPipeline logs low semantic plan coverage in architect quality gate", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = {
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      return {
        plan: {
          steps: ["Update src/server/healthz.ts"],
          target_files: ["src/server/healthz.ts"],
          risk_assessment: "low",
          verification: ["Run unit tests: pnpm test --filter healthz"],
        },
        warnings: [],
      };
    },
  };
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler({
      ...baseContext,
      request: "Add uptime logging feature to healthz endpoint and store uptime data in log file",
      selection: {
        focus: ["src/server/healthz.ts"],
        periphery: [],
        all: ["src/server/healthz.ts"],
        low_confidence: false,
      },
    }) as any,
    architectPlanner: architect as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 1,
  });

  await pipeline.run("Add uptime logging feature to healthz endpoint and store uptime data in log file");
  const qualityEvent = logger.events.find((event) =>
    event.type === "architect_quality_gate"
      && Array.isArray(event.data.reasons)
      && (event.data.reasons as string[]).includes("low_request_plan_semantic_coverage"),
  );
  assert.ok(qualityEvent);
});

test("SmartPipeline blocks pre-builder on critical low request-target alignment", { concurrency: false }, async () => {
  const architect = {
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      return {
        plan: {
          steps: ["Update src/server.js handlers."],
          target_files: ["src/server.js"],
          risk_assessment: "low",
          verification: ["Run unit tests for server handlers."],
        },
        warnings: [],
      };
    },
  };
  const builder = new StubBuilderRunner();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler({
      ...baseContext,
      request: "Add compact activity summary card showing completed pending tasks on homepage",
      selection: {
        focus: ["src/server.js"],
        periphery: [],
        all: ["src/server.js"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/server.js",
          role: "focus",
          content: "export function handler() {}\n",
          size: 32,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    }) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
  });

  await assert.rejects(
    () => pipeline.run("Add compact activity summary card showing completed pending tasks on homepage"),
    /low_request_target_alignment_critical/,
  );
  assert.equal(builder.calls, 0);
});

test("SmartPipeline retries builder when review PASS but semantic guard fails", { concurrency: false }, async () => {
  const logger = new StubLogger();
  const architect = {
    reviewCalls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      return {
        plan: {
          steps: ["Update src/server/healthz.ts to persist uptime log entries."],
          target_files: ["src/server/healthz.ts"],
          risk_assessment: "low",
          verification: ["Run integration tests for /healthz and check logs/healthz.log output."],
        },
        warnings: [],
      };
    },
    async reviewBuilderOutput(): Promise<{ status: "PASS" | "RETRY"; reasons: string[]; feedback: string[] }> {
      this.reviewCalls += 1;
      return { status: "PASS", reasons: ["looks acceptable"], feedback: [] };
    },
  };
  const builder = new StubBuilderRunnerSemanticRetry();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler({
      ...baseContext,
      request: "Add uptime logging feature to healthz endpoint and store uptime data in log file",
      selection: {
        focus: ["src/server/healthz.ts"],
        periphery: [],
        all: ["src/server/healthz.ts"],
        low_confidence: false,
      },
    }) as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    logger: logger as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("Add uptime logging feature to healthz endpoint and store uptime data in log file");
  assert.equal(result.criticResult.status, "PASS");
  assert.ok(builder.calls >= 2);
  const guardEvents = logger.events.filter((event) => event.type === "architect_review_semantic_guard");
  assert.ok(guardEvents.length >= 1);
  assert.ok(guardEvents.some((event) => event.data.ok === false));
});

test("SmartPipeline retries builder after patch apply failure", { concurrency: false }, async () => {
  class ApplyFailBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        const failure: PatchApplyFailure = {
          source: "interpreter_primary",
          error: "apply failed",
          patches: [],
          rollback: { attempted: true, ok: true },
          rawOutput: "patch output",
        };
        throw new PatchApplyError(failure);
      }
      return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
    }
  }
  const builder = new ApplyFailBuilder();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.ok(builder.calls >= 2);
});

test("SmartPipeline retries builder after provider auth/rate-limit fallback", { concurrency: false }, async () => {
  class ProviderFailBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        throw new Error(
          "AUTH_ERROR: codex CLI failed (exit 1): Error 429 Too Many Requests usage_limit_reached",
        );
      }
      return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
    }
  }
  const builder = new ProviderFailBuilder();
  let fallbackCalls = 0;
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler() as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
    onPhaseProviderFailure: async (input) => {
      fallbackCalls += 1;
      assert.equal(input.phase, "builder");
      assert.ok(/429/i.test(input.error.message));
      return { switched: true, note: "Switched builder agent after provider limit." };
    },
  });

  const result = await pipeline.run("do thing");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(fallbackCalls, 1);
  assert.equal(builder.calls, 2);
});

test("SmartPipeline performs one architect repair and no retry-budget increment on ENOENT apply failures", { concurrency: false }, async () => {
  class EnoentApplyFailBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        const failure: PatchApplyFailure = {
          source: "interpreter_primary",
          error: "ENOENT: no such file or directory, open 'src/missing.ts'",
          patches: [],
          rollback: { attempted: true, ok: true },
          rawOutput: "patch output",
        };
        throw new PatchApplyError(failure);
      }
      return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
    }
  }
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/example.ts"],
        },
        warnings: [],
      };
    },
    async plan(): Promise<Plan> {
      this.calls += 1;
      return {
        ...basePlan,
        target_files: ["src/example.ts"],
      };
    },
  };
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/example.ts"],
      periphery: [],
      all: ["src/example.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/example.ts",
        role: "focus",
        content: "export const value = 1;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["repair-pass"],
  };
  const builder = new EnoentApplyFailBuilder();
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("Update src/example.ts");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(result.attempts, 1);
  assert.equal(builder.calls, 2);
  assert.equal(architect.calls, 2);
});

test("SmartPipeline performs one architect repair for deterministic patch parsing failures", { concurrency: false }, async () => {
  class DeterministicParseFailBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        const failure: PatchApplyFailure = {
          source: "builder_patch_processing",
          error:
            "Patch parsing failed. initial=Patch payload must include patches array; retry=Patch references disallowed files: path/to/file.ts",
          patches: [],
          rollback: { attempted: false, ok: true },
          rawOutput: "invalid patch output",
        };
        throw new PatchApplyError(failure);
      }
      return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
    }
  }
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/example.ts"],
        },
        warnings: [],
      };
    },
    async plan(): Promise<Plan> {
      this.calls += 1;
      return {
        ...basePlan,
        target_files: ["src/example.ts"],
      };
    },
  };
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/example.ts"],
      periphery: [],
      all: ["src/example.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/example.ts",
        role: "focus",
        content: "export const value = 1;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["repair-pass"],
  };
  const builder = new DeterministicParseFailBuilder();
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("Update src/example.ts");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(result.attempts, 1);
  assert.equal(builder.calls, 2);
  assert.equal(architect.calls, 2);
});

test(
  "SmartPipeline treats mixed disallowed/parse failures as disallowed kind for deterministic repair",
  { concurrency: false },
  async () => {
    class MixedDeterministicFailBuilder extends StubBuilderRunner {
      async run(): Promise<BuilderRunResult> {
        this.calls += 1;
        if (this.calls === 1) {
          const failure: PatchApplyFailure = {
            source: "builder_patch_processing",
            error:
              "Patch parsing failed. initial=Patch output is not valid JSON; retry=Patch payload includes empty patches array",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        if (this.calls === 2) {
          const failure: PatchApplyFailure = {
            source: "builder_patch_processing",
            error:
              "Patch parsing failed. initial=Patch references disallowed files: src/server.js; retry=Patch payload includes empty patches array",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
      }
    }

    const architect = {
      calls: 0,
      async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
        this.calls += 1;
        return {
          plan: {
            ...basePlan,
            target_files: ["src/example.ts"],
          },
          warnings: [],
        };
      },
      async plan(): Promise<Plan> {
        this.calls += 1;
        return {
          ...basePlan,
          target_files: ["src/example.ts"],
        };
      },
    };

    const contextA: ContextBundle = {
      ...baseContext,
      selection: {
        focus: ["src/example.ts"],
        periphery: [],
        all: ["src/example.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/example.ts",
          role: "focus",
          content: "export const value = 1;\n",
          size: 24,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    };
    const contextB: ContextBundle = { ...contextA, queries: ["repair-pass-1"] };
    const contextC: ContextBundle = { ...contextA, queries: ["repair-pass-2"] };

    const logger = new StubLogger();
    const builder = new MixedDeterministicFailBuilder();
    const assembler = new StubContextAssembler([contextA, contextB, contextC]);
    const pipeline = new SmartPipeline({
      contextAssembler: assembler as any,
      architectPlanner: architect as any,
      builderRunner: builder as any,
      criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
      memoryWriteback: new StubMemoryWriteback() as any,
      logger: logger as any,
      maxRetries: 3,
    });

    const result = await pipeline.run("Update src/example.ts");
    assert.equal(result.criticResult.status, "PASS");
    assert.equal(result.attempts, 1);
    assert.equal(builder.calls, 3);
    assert.equal(architect.calls, 3);
    const deterministicKinds = logger.events
      .filter((event) => event.type === "builder_apply_failed_deterministic")
      .map((event) => String(event.data.kind));
    assert.ok(deterministicKinds.includes("patch_parse"));
    assert.ok(deterministicKinds.includes("disallowed_files"));
  },
);

test(
  "SmartPipeline fail-closes repeated deterministic patch parsing failures after one architect repair",
  { concurrency: false },
  async () => {
    class RepeatedDeterministicParseFailBuilder extends StubBuilderRunner {
      async run(): Promise<BuilderRunResult> {
        this.calls += 1;
        if (this.calls <= 2) {
          const failure: PatchApplyFailure = {
            source: "builder_patch_processing",
            error:
              "Patch parsing failed. initial=Patch output is not valid JSON; retry=Patch payload includes empty patches array",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
      }
    }

    const architect = {
      calls: 0,
      async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
        this.calls += 1;
        return {
          plan: {
            ...basePlan,
            target_files: ["src/example.ts"],
          },
          warnings: [],
        };
      },
      async plan(): Promise<Plan> {
        this.calls += 1;
        return {
          ...basePlan,
          target_files: ["src/example.ts"],
        };
      },
    };

    const contextA: ContextBundle = {
      ...baseContext,
      selection: {
        focus: ["src/example.ts"],
        periphery: [],
        all: ["src/example.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/example.ts",
          role: "focus",
          content: "export const value = 1;\n",
          size: 24,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    };
    const contextB: ContextBundle = {
      ...contextA,
      queries: ["repair-pass"],
    };

    const logger = new StubLogger();
    const builder = new RepeatedDeterministicParseFailBuilder();
    const assembler = new StubContextAssembler([contextA, contextB]);
    const pipeline = new SmartPipeline({
      contextAssembler: assembler as any,
      architectPlanner: architect as any,
      builderRunner: builder as any,
      criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
      memoryWriteback: new StubMemoryWriteback() as any,
      logger: logger as any,
      maxRetries: 3,
    });

    const result = await pipeline.run("Update src/example.ts");
    assert.equal(result.criticResult.status, "FAIL");
    assert.equal(result.attempts, 1);
    assert.equal(builder.calls, 2);
    assert.equal(architect.calls, 2);
    const failClosedEvent = logger.events.find(
      (event) =>
        event.type === "builder_apply_failed_deterministic_no_repair"
        && event.data.action === "fail_closed",
    );
    assert.ok(failClosedEvent);
  },
);

test(
  "SmartPipeline switches builder phase agent after repeated deterministic patch parsing failures",
  { concurrency: false },
  async () => {
    class RepeatedDeterministicParseFailThenPassBuilder extends StubBuilderRunner {
      async run(): Promise<BuilderRunResult> {
        this.calls += 1;
        if (this.calls <= 2) {
          const failure: PatchApplyFailure = {
            source: "builder_patch_processing",
            error:
              "Patch parsing failed. initial=Patch output is not valid JSON; retry=Patch payload includes empty patches array",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
      }
    }

    const architect = {
      calls: 0,
      async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
        this.calls += 1;
        return {
          plan: {
            ...basePlan,
            target_files: ["src/example.ts"],
          },
          warnings: [],
        };
      },
      async plan(): Promise<Plan> {
        this.calls += 1;
        return {
          ...basePlan,
          target_files: ["src/example.ts"],
        };
      },
    };

    const contextA: ContextBundle = {
      ...baseContext,
      selection: {
        focus: ["src/example.ts"],
        periphery: [],
        all: ["src/example.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/example.ts",
          role: "focus",
          content: "export const value = 1;\n",
          size: 24,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    };
    const contextB: ContextBundle = {
      ...contextA,
      queries: ["repair-pass"],
    };

    const logger = new StubLogger();
    const builder = new RepeatedDeterministicParseFailThenPassBuilder();
    const assembler = new StubContextAssembler([contextA, contextB]);
    let fallbackCalls = 0;
    const pipeline = new SmartPipeline({
      contextAssembler: assembler as any,
      architectPlanner: architect as any,
      builderRunner: builder as any,
      criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
      memoryWriteback: new StubMemoryWriteback() as any,
      logger: logger as any,
      maxRetries: 3,
      onPhaseProviderFailure: async ({ phase, error }) => {
        if (phase !== "builder") return { switched: false };
        fallbackCalls += 1;
        if (fallbackCalls > 1) return { switched: false };
        assert.match(error.message, /patch parsing failure/i);
        return { switched: true, note: "fallback switched for deterministic patch parse failure" };
      },
    });

    const result = await pipeline.run("Update src/example.ts");
    assert.equal(result.criticResult.status, "PASS");
    assert.equal(builder.calls, 3);
    assert.equal(architect.calls, 2);
    assert.equal(fallbackCalls, 1);
    const fallbackEvent = logger.events.find(
      (event) =>
        event.type === "phase_provider_fallback"
        && event.data.phase === "builder"
        && event.data.reason === "deterministic_patch_parse",
    );
    assert.ok(fallbackEvent);
  },
);

test("SmartPipeline performs one architect repair for deterministic search-block apply failures", { concurrency: false }, async () => {
  class SearchBlockFailBuilder extends StubBuilderRunner {
    async run(): Promise<BuilderRunResult> {
      this.calls += 1;
      if (this.calls === 1) {
        const failure: PatchApplyFailure = {
          source: "interpreter_primary",
          error: "Search block not found in file.",
          patches: [],
          rollback: { attempted: true, ok: true },
          rawOutput: "invalid patch output",
        };
        throw new PatchApplyError(failure);
      }
      return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
    }
  }
  const architect = {
    calls: 0,
    async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      return {
        plan: {
          ...basePlan,
          target_files: ["src/example.ts"],
        },
        warnings: [],
      };
    },
    async plan(): Promise<Plan> {
      this.calls += 1;
      return {
        ...basePlan,
        target_files: ["src/example.ts"],
      };
    },
  };
  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["src/example.ts"],
      periphery: [],
      all: ["src/example.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "src/example.ts",
        role: "focus",
        content: "export const value = 1;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["repair-pass"],
  };
  const builder = new SearchBlockFailBuilder();
  const assembler = new StubContextAssembler([contextA, contextB]);
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
  });

  const result = await pipeline.run("Update src/example.ts");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(result.attempts, 1);
  assert.equal(builder.calls, 2);
  assert.equal(architect.calls, 2);
});

test(
  "SmartPipeline allows deterministic architect repair once per failure kind",
  { concurrency: false },
  async () => {
    class MultiDeterministicFailureBuilder extends StubBuilderRunner {
      async run(): Promise<BuilderRunResult> {
        this.calls += 1;
        if (this.calls === 1) {
          const failure: PatchApplyFailure = {
            source: "builder_patch_processing",
            error:
              "Patch parsing failed. initial=Patch output is not valid JSON; retry=Patch payload includes empty patches array",
            patches: [],
            rollback: { attempted: false, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        if (this.calls === 2) {
          const failure: PatchApplyFailure = {
            source: "interpreter_retry",
            error: "Search block not found in file.",
            patches: [],
            rollback: { attempted: true, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        return {
          finalMessage: { role: "assistant", content: "done" },
          messages: [],
          toolCallsExecuted: 0,
        };
      }
    }

    const architect = {
      calls: 0,
      async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
        this.calls += 1;
        return {
          plan: {
            ...basePlan,
            target_files: ["src/example.ts"],
          },
          warnings: [],
        };
      },
      async plan(): Promise<Plan> {
        this.calls += 1;
        return {
          ...basePlan,
          target_files: ["src/example.ts"],
        };
      },
    };

    const contextA: ContextBundle = {
      ...baseContext,
      selection: {
        focus: ["src/example.ts"],
        periphery: [],
        all: ["src/example.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/example.ts",
          role: "focus",
          content: "export const value = 1;\n",
          size: 24,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    };
    const contextB: ContextBundle = {
      ...contextA,
      queries: ["repair-pass-1"],
    };
    const contextC: ContextBundle = {
      ...contextA,
      queries: ["repair-pass-2"],
    };

    const builder = new MultiDeterministicFailureBuilder();
    const assembler = new StubContextAssembler([contextA, contextB, contextC]);
    const pipeline = new SmartPipeline({
      contextAssembler: assembler as any,
      architectPlanner: architect as any,
      builderRunner: builder as any,
      criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
      memoryWriteback: new StubMemoryWriteback() as any,
      maxRetries: 3,
    });

    const result = await pipeline.run("Update src/example.ts");
    assert.equal(result.criticResult.status, "PASS");
    assert.equal(result.attempts, 1);
    assert.equal(builder.calls, 3);
    assert.equal(architect.calls, 3);
  },
);

test(
  "SmartPipeline degrades non-concrete architect repair plans after deterministic apply failure",
  { concurrency: false },
  async () => {
    class SearchBlockFailBuilder extends StubBuilderRunner {
      async run(): Promise<BuilderRunResult> {
        this.calls += 1;
        if (this.calls === 1) {
          const failure: PatchApplyFailure = {
            source: "interpreter_primary",
            error: "Search block not found in file.",
            patches: [],
            rollback: { attempted: true, ok: true },
            rawOutput: "invalid patch output",
          };
          throw new PatchApplyError(failure);
        }
        return { finalMessage: { role: "assistant", content: "done" }, messages: [], toolCallsExecuted: 0 };
      }
    }

    const architect = {
      planWithRequestCalls: 0,
      planCalls: 0,
      async planWithRequest(): Promise<{ plan: Plan; warnings: string[] }> {
        this.planWithRequestCalls += 1;
        return {
          plan: {
            ...basePlan,
            target_files: ["src/example.ts"],
          },
          warnings: [],
        };
      },
      async plan(): Promise<Plan> {
        this.planCalls += 1;
        return {
          ...basePlan,
          target_files: ["src/example.ts"],
          verification: ["Verify changes"],
        };
      },
    };

    const contextA: ContextBundle = {
      ...baseContext,
      request: "Update src/example.ts task summary value handling",
      selection: {
        focus: ["src/example.ts"],
        periphery: [],
        all: ["src/example.ts"],
        low_confidence: false,
      },
      files: [
        {
          path: "src/example.ts",
          role: "focus",
          content: "export const value = 1;\n",
          size: 24,
          truncated: false,
          sliceStrategy: "full",
          origin: "docdex",
        },
      ],
    };
    const contextB: ContextBundle = {
      ...contextA,
      queries: ["repair-pass"],
    };
    const builder = new SearchBlockFailBuilder();
    const assembler = new StubContextAssembler([contextA, contextB]);
    const pipeline = new SmartPipeline({
      contextAssembler: assembler as any,
      architectPlanner: architect as any,
      builderRunner: builder as any,
      criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
      memoryWriteback: new StubMemoryWriteback() as any,
      maxRetries: 2,
    });

    const result = await pipeline.run("Update src/example.ts task summary value handling");
    assert.equal(result.criticResult.status, "PASS");
    assert.equal(result.attempts, 1);
    assert.equal(builder.calls, 2);
    assert.equal(architect.planWithRequestCalls, 2);
    assert.equal(architect.planCalls, 0);
  },
);

test("SmartPipeline fulfills critic requests before finalizing", { concurrency: false }, async () => {
  const critic = new StubCriticWithRequest();
  const assembler = new StubContextAssembler();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: new StubBuilderRunner() as any,
    criticEvaluator: critic as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    maxContextRefreshes: 1,
  });

  const result = await pipeline.run("needs critic context");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(assembler.lastRequestId, "crit-1");
  assert.ok(critic.calls >= 2);
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
  const inputPhases = logger.events
    .filter((event) => event.type === "phase_input")
    .map((event) => event.data.phase);
  const outputPhases = logger.events
    .filter((event) => event.type === "phase_output")
    .map((event) => event.data.phase);
  assert.ok(inputPhases.includes("librarian"));
  assert.ok(inputPhases.includes("architect"));
  assert.ok(inputPhases.includes("builder"));
  assert.ok(inputPhases.includes("critic"));
  assert.ok(outputPhases.includes("librarian"));
  assert.ok(outputPhases.includes("architect"));
  assert.ok(outputPhases.includes("builder"));
  assert.ok(outputPhases.includes("critic"));
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

test("SmartPipeline uses fresh builder lanes for retries", { concurrency: false }, async () => {
  class RetryLaneBuilder extends StubBuilderRunner {
    laneIds: string[] = [];
    async run(
      _plan?: Plan,
      _context?: ContextBundle,
      options?: { laneId?: string },
    ): Promise<BuilderRunResult> {
      this.calls += 1;
      this.laneIds.push(options?.laneId ?? "");
      if (this.calls === 1) {
        const failure: PatchApplyFailure = {
          source: "interpreter_retry",
          error: "Search block not found in file.",
          patches: [],
          rollback: { attempted: true, ok: true },
          rawOutput: "invalid patch output",
        };
        throw new PatchApplyError(failure);
      }
      return {
        finalMessage: { role: "assistant", content: "done" },
        messages: [],
        toolCallsExecuted: 0,
      };
    }
  }

  const contextA: ContextBundle = {
    ...baseContext,
    selection: {
      focus: ["file.ts"],
      periphery: [],
      all: ["file.ts"],
      low_confidence: false,
    },
    files: [
      {
        path: "file.ts",
        role: "focus",
        content: "export const value = 1;\n",
        size: 24,
        truncated: false,
        sliceStrategy: "full",
        origin: "docdex",
      },
    ],
  };
  const contextB: ContextBundle = {
    ...contextA,
    queries: ["retry-pass"],
  };

  const builder = new RetryLaneBuilder();
  const pipeline = new SmartPipeline({
    contextAssembler: new StubContextAssembler([contextA, contextB]) as any,
    architectPlanner: new StubArchitectPlanner() as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 2,
    contextManager: {} as any,
    laneScope: { jobId: "job-x", taskId: "task-y" },
  });

  const result = await pipeline.run("update file");
  assert.equal(result.criticResult.status, "PASS");
  assert.equal(builder.calls, 2);
  assert.equal(builder.laneIds[0], "job-x:task-y:builder");
  assert.equal(builder.laneIds[1], "job-x:task-y:builder:attempt-2");
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

  class ContextRefreshArchitect {
    calls = 0;
    instructionHints: string[] = [];
    async planWithRequest(
      _context?: ContextBundle,
      options?: { instructionHint?: string },
    ): Promise<{ plan: Plan; warnings: string[] }> {
      this.calls += 1;
      this.instructionHints.push(options?.instructionHint ?? "");
      return { plan: basePlan, warnings: [] };
    }
  }

  const contextA: ContextBundle = { ...baseContext, request: "first" };
  const contextB: ContextBundle = { ...baseContext, request: "second" };
  const assembler = new StubContextAssembler([contextA, contextB]);
  const builder = new NeedsContextBuilder();
  const architect = new ContextRefreshArchitect();
  const pipeline = new SmartPipeline({
    contextAssembler: assembler as any,
    architectPlanner: architect as any,
    builderRunner: builder as any,
    criticEvaluator: new StubCriticEvaluator({ status: "PASS", reasons: [], retryable: false }) as any,
    memoryWriteback: new StubMemoryWriteback() as any,
    maxRetries: 1,
    maxContextRefreshes: 1,
  });

  await pipeline.run("needs more");
  assert.equal(assembler.calls, 2);
  assert.equal(builder.calls, 2);
  assert.equal(architect.calls, 2);
  assert.ok(
    architect.instructionHints.some((hint) => hint.includes("Do not restart from scratch.")),
  );
  assert.ok(
    architect.instructionHints.some((hint) => hint.includes("builder_needs_context")),
  );
  assert.deepEqual(assembler.lastAssembleOptions?.forceFocusFiles, ["src/auth.ts"]);
});
