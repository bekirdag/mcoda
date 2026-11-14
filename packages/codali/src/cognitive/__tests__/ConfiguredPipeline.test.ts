import test from "node:test";
import assert from "node:assert/strict";
import { runConfiguredPipeline, type ConfiguredPipelineHost } from "../ConfiguredPipeline.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { DocdexClient } from "../../docdex/DocdexClient.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { createFileTools } from "../../tools/filesystem/FileTools.js";
import type { CriticEvaluator } from "../CriticEvaluator.js";
import type { MemoryWriteback } from "../MemoryWriteback.js";
import type { ConfiguredModelScope } from "../../providers/ConfiguredModelScope.js";

const configuration = (maxModelCalls = 6) => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "pipeline-test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { large: { provider: "local", catalogId: "large", revision: "v1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 1024, supportsTools: true } },
    bindings: { lead: { candidates: ["large"] }, router: { useBinding: "lead" }, architect: { useBinding: "lead" }, worker: { useBinding: "lead" }, repair: { useBinding: "lead" } },
    effort: { low: { maxModelCalls, maxOutputTokens: 1024, maxTotalTokens: 32000 } } };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};
const host = (scope: ConfiguredModelScope): ConfiguredPipelineHost => {
  const tools = new ToolRegistry(); for (const tool of createFileTools()) if (tool.readOnly) tools.register(tool);
  return {
  docdex: new DocdexClient({ baseUrl: "http://127.0.0.1:2", repoRoot: process.cwd(), signal: () => scope.signal }),
  builder: { tools, context: { workspaceRoot: process.cwd(), signal: scope.signal }, mode: "tool_calls", maxSteps: 2, maxToolCalls: 2 },
  pipeline: { maxRetries: 0, maxContextRefreshes: 0,
    initialContext: { request: "Explain README.md", queries: [], snippets: [], symbols: [], ast: [], impact: [], impact_diagnostics: [], memory: [], preferences_detected: [], profile: [], index: { last_updated_epoch_ms: 0, num_docs: 0 }, warnings: [] },
    criticEvaluator: { evaluate: async () => ({ status: "PASS", reasons: [], retryable: false }) } as unknown as CriticEvaluator,
    memoryWriteback: { persist: async () => ({ outcomes: [], ledgerPath: "unused" }) } as unknown as MemoryWriteback,
  },
  };
};

test("configured cognitive stages use one pinned scope and close it after completion", async () => {
  const original = globalThis.fetch; let requests = 0; let workerRequests = 0; let binding = ""; let scope: ConfiguredModelScope | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "large", supports_tools: true }] });
    assert.ok(String(url).endsWith("/chat/completions"));
    assert.equal(JSON.parse(String(init?.body)).model, "large"); requests++;
    const content = binding === "architect" ? "PLAN:\n- Explain README.md\nTARGETS:\n- README.md\nRISK: low\nVERIFY:\n- Check the explanation against the supplied context"
      : binding === "router" ? '{"queries":[]}' : "This project provides a configured orchestration pipeline.";
    const tool_calls = binding === "worker" && ++workerRequests === 1 ? [{ id: "read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }] : undefined;
    return Response.json({ choices: [{ message: { role: "assistant", content, tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  try {
    const output = await runConfiguredPipeline("Explain README.md", { orchestration: configuration(), effort: "low", onModelEvent: event => { if (event.type === "intent") binding = event.binding; }, configure: value => { scope = value; return host(value); } });
    assert.equal(output.result.criticResult.status, "PASS");
    assert.equal(output.toolCalls, 1);
    assert.ok(requests >= 2); assert.equal(output.usage.modelCalls, requests); assert.equal(output.usage.totalTokens, requests * 15);
    assert.equal(scope?.signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test("configured pipeline rejects legacy fallback overrides and observes host cancellation", async () => {
  const abort = new AbortController();
  await assert.rejects(runConfiguredPipeline("Task", { orchestration: configuration(), configure: scope => {
    const options = host(scope); (options.pipeline as unknown as Record<string, unknown>).onPhaseProviderFailure = () => true; return options;
  } }), /legacy onPhaseProviderFailure/);
  await assert.rejects(runConfiguredPipeline("Task", { orchestration: configuration(), signal: abort.signal, configure: scope => {
    abort.abort(new Error("Host stopped the pipeline")); return host(scope);
  } }), /Host stopped/);
});
