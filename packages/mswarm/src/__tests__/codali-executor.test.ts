import assert from "node:assert/strict";
import test from "node:test";
import {
  MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
  MSWARM_CODALI_PRODUCT_METADATA_SCHEMA_VERSION,
  MswarmCodaliExecutor,
  type CodaliGatewayOptions,
  type CodaliGatewayResult,
  type CodaliJobRuntimeInput,
  type CodaliJobRuntimeResult,
  type CodaliRuntimeInput,
  type CodaliRuntimeResult,
  type MswarmCodaliGateway,
} from "../codali-executor.js";

process.env.MSWARM_CODALI_VENDOR_ONLY = "1";

test("MswarmCodaliExecutor maps jobs to Codali and emits OpenAI stream chunks", async () => {
  const executor = new MswarmCodaliExecutor();
  const chunks: Record<string, unknown>[] = [];
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  const result = await executor.invoke({
    jobId: "job-stream",
    requestId: "req-stream",
    model: "mcoda-qwen",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Write ping pong HTML." },
    ],
    agent: {
      slug: "qwen-coder",
      adapter: "ollama-remote",
      model: "qwen3-coder:latest",
      baseUrl: "http://ollama.test",
      supportsTools: false,
      maxOutputTokens: 2048,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "http://docdex.test",
      repoRoot: "/tmp/workspace",
      allowWeb: false,
      allowMemoryWrite: false,
      allowProfileWrite: false,
      allowIndexRebuild: false,
    },
    policy: {
      allowTools: false,
      allowShell: false,
      allowWrites: false,
      maxRuntimeMs: 30_000,
    },
    responseFormat: {
      type: "json_schema",
      json_schema: {
        schema: {
          type: "object",
          required: ["html"],
          properties: { html: { type: "string" } },
        },
      },
    },
    stream: true,
    onOpenAIChunk: async (chunk) => {
      chunks.push(chunk);
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      await input.onEvent?.({
        type: "token",
        content: "{\"html\":\"",
        at: "2026-04-30T00:00:00.000Z",
      });
      await input.onEvent?.({
        type: "tool_result",
        id: "call-1",
        name: "docdex_search",
        ok: true,
        output: "internal tool output",
        at: "2026-04-30T00:00:00.000Z",
      });
      await input.onEvent?.({
        type: "final",
        content: "{\"html\":\"<canvas></canvas>\"}",
        at: "2026-04-30T00:00:00.000Z",
      });
      return {
        finalMessage: "{\"html\":\"<canvas></canvas>\"}",
        messages: [{ role: "assistant", content: "{\"html\":\"<canvas></canvas>\"}" }],
        toolCallsExecuted: 0,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-stream",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.provider.name, "ollama-remote");
  assert.equal(capturedInput.provider.model, "qwen3-coder:latest");
  assert.equal(capturedInput.provider.baseUrl, "http://ollama.test");
  assert.equal(capturedInput.policy.mode, "freeform");
  assert.equal(capturedInput.policy.maxToolCalls, 0);
  assert.deepEqual(capturedInput.response?.schema, {
    type: "object",
    required: ["html"],
    properties: { html: { type: "string" } },
  });
  assert.equal(result.output, "{\"html\":\"<canvas></canvas>\"}");
  assert.equal(result.metadata.provider, "ollama-remote");
  assert.equal(result.metadata.local_model, "qwen3-coder:latest");
  assert.equal(chunks.length, 2);
  assert.equal(JSON.stringify(chunks).includes("internal tool output"), false);
  assert.equal(
    (chunks[0]?.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content,
    "{\"html\":\"",
  );
  assert.equal(
    (chunks[1]?.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason,
    "stop",
  );
});

test("MswarmCodaliExecutor routes non-tool agents to protocol_loop when tools are allowed", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  const result = await executor.invoke({
    jobId: "job-protocol",
    requestId: "req-protocol",
    model: "mcoda-local",
    messages: [{ role: "user", content: "Search Docdex before answering." }],
    agent: {
      slug: "local-ollama",
      adapter: "ollama-remote",
      model: "llama-local:latest",
      baseUrl: "http://ollama.test",
      supportsTools: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "http://docdex.test",
      repoRoot: "/tmp/workspace",
      allowWeb: true,
      allowMemoryWrite: false,
      allowProfileWrite: false,
      allowIndexRebuild: false,
    },
    policy: {
      allowShell: false,
      allowWrites: false,
      maxToolCalls: 7,
      allowedTools: ["docdex_search", "docdex_web_research", "read_file"],
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 2,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-protocol",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.policy.mode, "protocol_loop");
  assert.equal(capturedInput.policy.maxSteps, 24);
  assert.equal(capturedInput.policy.maxToolCalls, 7);
  assert.deepEqual(capturedInput.policy.allowedTools, [
    "docdex_search",
    "docdex_web_research",
    "read_file",
  ]);
  assert.equal(capturedInput.docdex?.allowWeb, true);
  assert.equal(result.metadata.mode, "protocol_loop");
  assert.equal(result.metadata.tool_calls_executed, 2);
});

test("MswarmCodaliExecutor forwards runtime app tool contracts and telemetry", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  const result = await executor.invoke({
    jobId: "job-runtime-tools",
    requestId: "req-runtime-tools",
    model: "mcoda-local",
    messages: [{ role: "user", content: "Search tenant context." }],
    agent: {
      slug: "local-tool-agent",
      adapter: "openai-compatible-local",
      model: "tool-agent",
      supportsTools: true,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "http://docdex.test",
      repoRoot: "/tmp/workspace",
      allowWeb: false,
      allowMemoryWrite: false,
      allowProfileWrite: false,
      allowIndexRebuild: false,
      toolManifest: {
        actualTools: ["docdex_search"],
        virtualTools: ["app_daily_logs"],
      },
    },
    policy: {
      allowShell: false,
      allowWrites: false,
      allowedTools: ["docdex_search", "app_daily_logs"],
      appToolContracts: {
        app_daily_logs: {
          executionMode: "server_supplied_snapshot_plus_docdex",
          callSchema: { type: "object" },
          resultContract: "daily log results",
          backingTools: ["docdex_search"],
        },
      },
      appVirtualTools: ["app_daily_logs"],
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 1,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-runtime-tools",
        telemetry: {
          runId: "run-runtime-tools",
          runtime: "codali",
          mode: input.policy.mode,
          toolCallCount: 1,
          calledTools: ["app_daily_logs"],
          consideredTools: ["docdex_search", "app_daily_logs"],
          registeredDynamicTools: ["app_daily_logs"],
          skippedDynamicTools: [],
          dynamicToolCalls: [
            {
              name: "app_daily_logs",
              backingTool: "docdex_search",
              status: "success",
              latencyMs: 12,
            },
          ],
          warnings: [],
        },
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.deepEqual(capturedInput.docdex?.toolManifest, {
    actualTools: ["docdex_search"],
    virtualTools: ["app_daily_logs"],
  });
  assert.deepEqual(capturedInput.policy.appToolContracts, {
    app_daily_logs: {
      executionMode: "server_supplied_snapshot_plus_docdex",
      callSchema: { type: "object" },
      resultContract: "daily log results",
      backingTools: ["docdex_search"],
    },
  });
  assert.deepEqual(capturedInput.policy.appVirtualTools, ["app_daily_logs"]);
  assert.equal(result.metadata.runtime, "codali");
  assert.deepEqual(result.metadata.called_tools, ["app_daily_logs"]);
  assert.deepEqual(result.metadata.dynamic_tools_registered, ["app_daily_logs"]);
  assert.equal(result.metadata.tool_call_details[0]?.backingTool, "docdex_search");
  assert.equal(result.metadata.telemetry?.runId, "run-runtime-tools");
});

test("MswarmCodaliExecutor invokes runCodaliJob for codaliJob payloads and returns job telemetry", async () => {
  const executor = new MswarmCodaliExecutor();
  const captured: { value?: CodaliJobRuntimeInput } = {};
  const jobEvents: Record<string, unknown>[] = [];

  const result = await executor.invoke({
    jobId: "job-multistage",
    requestId: "req-multistage",
    model: "mcoda-local",
    messages: [{ role: "user", content: "Answer from tenant runtime tools." }],
    agent: {
      slug: "local-tool-agent",
      adapter: "openai-compatible-local",
      model: "tool-agent",
      supportsTools: true,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "http://docdex.test",
      repoRoot: "/tmp/workspace",
      toolManifest: {
        actualTools: ["docdex_search"],
        virtualTools: ["tenant_daily_logs"],
      },
    },
    policy: {
      allowShell: false,
      allowWrites: false,
      allowedTools: ["docdex_search", "tenant_daily_logs"],
      maxToolCalls: 5,
    },
    codaliJob: {
      jobType: "tenant_chat",
      input: "Answer from tenant runtime tools.",
      stages: [
        { id: "worker", kind: "worker", maxToolCalls: 1 },
        { id: "synthesizer", kind: "synthesizer", dependsOn: ["worker"], maxToolCalls: 0 },
      ],
      budgets: { maxToolCalls: 1 },
    },
    onJobEvent: async (event) => {
      jobEvents.push(event);
    },
    runCodali: async () => {
      throw new Error("runCodaliTask should not be used for codaliJob payloads");
    },
    runCodaliJob: async (input) => {
      captured.value = input;
      await input.onEvent?.({
        type: "stage_start",
        runId: "run-job",
        jobId: "job-multistage",
        stageId: "worker",
        kind: "worker",
        at: "2026-07-01T00:00:00.000Z",
      });
      return {
        output: "job answer",
        status: "succeeded",
        runId: "run-job",
        jobId: "job-multistage",
        jobType: "tenant_chat",
        stages: [
          {
            id: "worker",
            kind: "worker",
            status: "completed",
            attempt: 1,
            output: "worker answer",
            toolCallsExecuted: 1,
            warnings: [],
            durationMs: 7,
          },
        ],
        usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        toolCallsExecuted: 1,
        touchedFiles: [],
        warnings: [],
        errors: [],
        telemetry: {
          runId: "run-job",
          runtime: "codali",
          mode: "job",
          jobId: "job-multistage",
          jobType: "tenant_chat",
          status: "succeeded",
          stageCount: 1,
          toolCallCount: 1,
          calledTools: ["tenant_daily_logs"],
          consideredTools: ["docdex_search", "tenant_daily_logs"],
          warnings: [],
          errors: [],
          stages: [
            {
              id: "worker",
              kind: "worker",
              status: "completed",
              attempt: 1,
              durationMs: 7,
              toolCallsExecuted: 1,
            },
          ],
        },
      } satisfies CodaliJobRuntimeResult;
    },
  });

  const capturedInput = captured.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.request.id, "job-multistage");
  assert.equal(capturedInput.request.jobType, "tenant_chat");
  assert.deepEqual(capturedInput.request.toolManifest, {
    actualTools: ["docdex_search"],
    virtualTools: ["tenant_daily_logs"],
  });
  assert.equal(capturedInput.runtime.policy.maxToolCalls, 5);
  assert.equal(result.output, "job answer");
  assert.equal(result.metadata.codali_job_status, "succeeded");
  assert.equal(result.metadata.codali_job_stage_count, 1);
  assert.deepEqual(result.metadata.called_tools, ["tenant_daily_logs"]);
  assert.equal(result.metadata.telemetry?.mode, "job");
  assert.equal(jobEvents[0]?.type, "stage_start");
});

test("MswarmCodaliExecutor invokes runCodaliGateway for codaliGateway payloads and returns gateway telemetry", async () => {
  const executor = new MswarmCodaliExecutor();
  const captured: {
    request?: MswarmCodaliGateway;
    options?: CodaliGatewayOptions;
  } = {};
  const chunks: Record<string, unknown>[] = [];
  const gatewayEvents: Record<string, unknown>[] = [];

  const result = await executor.invoke({
    jobId: "job-gateway",
    requestId: "req-gateway",
    model: "mcoda-gateway",
    messages: [{ role: "user", content: "What changed in tenant logs?" }],
    agent: {
      slug: "large-final-agent",
      adapter: "openai-compatible-local",
      model: "large-final-model",
      supportsTools: true,
      supportsJsonSchema: true,
      contextWindow: 131_072,
      capabilities: ["final_answer_synthesis"],
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "https://docdex.tenant.test",
      repoRoot: "/tmp/workspace",
      repoId: "repo-tenant-a",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search", "open"],
      toolManifest: {
        actualTools: ["docdex_search"],
        virtualTools: ["tenant_daily_logs"],
      },
    },
    attachedMswarmApiKey: "attached-secret",
    policy: {
      allowShell: false,
      allowWrites: false,
      allowedTools: ["docdex_search", "tenant_daily_logs"],
      deniedTools: ["github_search"],
      appToolContracts: {
        tenant_daily_logs: {
          executionMode: "server_supplied_snapshot_plus_docdex",
          callSchema: { type: "object" },
          resultContract: "daily log search results",
          backingTools: ["docdex_search"],
        },
      },
      appVirtualTools: ["tenant_daily_logs"],
      maxToolCalls: 4,
    },
    session: { id: "chat-session-1" },
    codaliGateway: {
      query: "What changed in tenant logs?",
      mode: "balanced",
      product: { id: "product-alpha", deploymentId: "deployment-local" },
      tenant: { id: "tenant-a" },
      docdex: {
        baseUrl: "https://docdex.tenant.test",
        repoId: "repo-tenant-a",
        credentialSource: "attached_mswarm_api_key",
        required: true,
        allowedOperations: ["search", "open"],
        capabilities: { search: true, open: true },
      },
      requester: {
        requesterHash: "requester-scope-hash",
        visibility: "tenant",
      },
      policy: {
        maxModelCalls: 6,
        requireFinalLargeModel: false,
      },
      agentPolicy: {
        stageAgents: {
          synthesizer: {
            slug: "tenant-large-final-agent",
            adapter: "openai-compatible-local",
            provider: "openai-compatible",
            model: "tenant-large-model",
            tier: "large",
            supportsTools: false,
            supportsJsonSchema: true,
            capabilities: ["final_answer_synthesis"],
          },
        },
      },
      response: { format: "text" },
    },
    stream: true,
    onOpenAIChunk: async (chunk) => {
      chunks.push(chunk);
    },
    onGatewayEvent: async (event) => {
      gatewayEvents.push(event);
    },
    runCodali: async () => {
      throw new Error("runCodaliTask should not be used for codaliGateway payloads");
    },
    runCodaliJob: async () => {
      throw new Error("runCodaliJob should not be used for codaliGateway payloads");
    },
    runCodaliGateway: async (request, options) => {
      captured.request = request;
      captured.options = options;
      return {
        runId: "run-gateway",
        status: "succeeded",
        answer: "gateway answer",
        sources: [{ evidenceId: "ev-1", sourceType: "docdex", title: "Daily logs" }],
        confidence: "high",
        evidence: [{ id: "ev-1", claim: "A tenant log changed." }],
        contextPack: { id: "ctx-run-gateway" },
        finalModel: {
          tier: "large",
          model: "large-final-model",
          provider: "openai-compatible",
          agentSlug: "large-final-agent",
        },
        trace: {
          runId: "run-gateway",
          mode: "balanced",
          status: "succeeded",
          iterations: 1,
          toolCallCount: 1,
          modelCallCount: 4,
          consideredTools: ["docdex_search", "tenant_daily_logs"],
          calledTools: ["tenant_daily_logs"],
          warnings: ["gateway-warning"],
          errors: [],
          toolCalls: [{ tool: "tenant_daily_logs", status: "success", latencyMs: 9 }],
          modelCalls: [
            { role: "classifier", status: "success", model: "small-classifier", latencyMs: 10 },
            { role: "planner", status: "success", model: "small-planner", latencyMs: 11 },
            { role: "worker", status: "success", model: "worker-model", latencyMs: 12 },
            {
              role: "final_synthesizer",
              status: "success",
              tier: "large",
              model: "large-final-model",
              provider: "openai-compatible",
              agentSlug: "large-final-agent",
              latencyMs: 13,
            },
          ],
          events: [],
          metadata: { traceId: "trace-run-gateway" },
        },
        telemetry: { finalAttempts: 1 },
        metadata: {
          datasetCollection: {
            accepted: true,
            status: "queued",
            recordCount: 1,
            objectCount: 0,
            idempotencyKey: "private-dataset-id",
            batchId: "private-batch-id",
            errors: ["dataset-warning"],
          },
          privacyFlags: {
            uploadAllowed: false,
            exportAllowed: false,
            trainingAllowed: false,
            containsPersonalData: true,
            containsTenantPrivateData: true,
            containsCustomerData: true,
          },
        },
      } satisfies CodaliGatewayResult;
    },
  });

  const request = captured.request;
  assert.ok(request);
  assert.equal(request.id, "job-gateway");
  assert.equal(request.docdex?.apiKey, "attached-secret");
  assert.equal(request.docdex?.immutableRuntimeContext, true);
  assert.equal(request.docdex?.repoId, "repo-tenant-a");
  assert.deepEqual(request.tools, {
    actualTools: ["docdex_search"],
    virtualTools: ["tenant_daily_logs"],
  });
  assert.deepEqual(request.policy?.allowedTools, ["docdex_search", "tenant_daily_logs"]);
  assert.deepEqual(request.policy?.deniedTools, ["github_search"]);
  assert.deepEqual(request.policy?.appVirtualTools, ["tenant_daily_logs"]);
  assert.deepEqual(request.policy?.appToolContracts, {
    tenant_daily_logs: {
      executionMode: "server_supplied_snapshot_plus_docdex",
      callSchema: { type: "object" },
      resultContract: "daily log search results",
      backingTools: ["docdex_search"],
    },
  });
  assert.equal(request.policy?.maxToolCalls, 4);
  assert.equal(request.policy?.maxModelCalls, 6);
  assert.equal(request.policy?.allowWrites, false);
  assert.equal(request.conversation?.id, "chat-session-1");
  assert.equal(captured.options?.provider.name, "openai-compatible");
  assert.equal(Array.isArray(captured.options?.agentInventory), true);
  const gatewayAgentInventory = captured.options?.agentInventory as Array<Record<string, unknown>> | undefined;
  assert.equal(
    gatewayAgentInventory?.some(
      (candidate) =>
        candidate.slug === "tenant-large-final-agent" &&
        candidate.tier === "large" &&
        candidate.contextWindow === 16_000 &&
        candidate.context_window === 16_000,
    ),
    true,
  );
  assert.equal(result.output, "gateway answer");
  assert.equal(result.metadata.codali_gateway_status, "succeeded");
  assert.equal(result.metadata.codali_gateway_task_count, 1);
  assert.equal(result.metadata.codali_gateway_source_count, 1);
  assert.equal(result.metadata.codali_gateway_evidence_count, 1);
  assert.deepEqual(result.metadata.called_tools, ["tenant_daily_logs"]);
  assert.equal(result.metadata.telemetry?.mode, "gateway");
  assert.equal(result.metadata.session_id, "chat-session-1");
  const feedbackSubmission = result.metadata.feedback_submission;
  assert.ok(feedbackSubmission);
  assert.equal(
    feedbackSubmission.schema_version,
    MSWARM_CODALI_FEEDBACK_SUBMISSION_SCHEMA_VERSION,
  );
  assert.equal(feedbackSubmission.run_id, "run-gateway");
  assert.equal(feedbackSubmission.deletion_group_id, "delete-group-run-gateway");
  assert.equal(feedbackSubmission.target.record_id, "run-gateway");
  assert.equal(feedbackSubmission.target.role, "codali_gateway_answer");
  assert.equal(feedbackSubmission.candidate_records[0]?.record_id, "run-gateway");
  assert.equal(feedbackSubmission.product_scope?.product_id, "product-alpha");
  assert.equal(feedbackSubmission.requester_scope.visibility, "requester");
  assert.equal(feedbackSubmission.requester_scope.tenant_wide, false);
  assert.equal(feedbackSubmission.requester_scope.requester_hash, "requester-scope-hash");
  assert.equal(feedbackSubmission.raw_trace_included, false);
  assert.equal(JSON.stringify(feedbackSubmission).includes("toolCalls"), false);
  const productMetadata = result.metadata.codali_product_metadata;
  assert.ok(productMetadata);
  assert.equal(
    productMetadata.schema_version,
    MSWARM_CODALI_PRODUCT_METADATA_SCHEMA_VERSION,
  );
  assert.equal(productMetadata.run_id, "run-gateway");
  assert.equal(productMetadata.trace_id, "trace-run-gateway");
  assert.equal(productMetadata.context_pack_id, "ctx-run-gateway");
  assert.equal(productMetadata.dataset_collection.status, "queued");
  assert.equal(productMetadata.dataset_collection.record_count, 1);
  assert.equal(productMetadata.dataset_collection.object_count, 0);
  assert.deepEqual(productMetadata.dataset_collection.errors, ["dataset-warning"]);
  assert.equal(productMetadata.privacy_flags.local_only, true);
  assert.equal(productMetadata.privacy_flags.upload_allowed, false);
  assert.equal(productMetadata.privacy_flags.export_allowed, false);
  assert.equal(productMetadata.privacy_flags.training_allowed, false);
  assert.equal(productMetadata.privacy_flags.raw_trace_included, false);
  assert.equal(productMetadata.record_counts.dataset_records, 1);
  assert.equal(productMetadata.record_counts.sources, 1);
  assert.equal(productMetadata.record_counts.evidence, 1);
  assert.equal(productMetadata.record_counts.tool_calls, 1);
  assert.equal(productMetadata.record_counts.model_calls, 4);
  assert.equal(productMetadata.record_counts.context_packs, 1);
  assert.equal(productMetadata.record_counts.final_answers, 1);
  assert.equal(productMetadata.feedback_ref.target.role, "codali_gateway_answer");
  assert.equal(productMetadata.feedback_ref.deletion_group_id, "delete-group-run-gateway");
  assert.deepEqual(productMetadata.called_tools, ["tenant_daily_logs"]);
  assert.equal(productMetadata.model_tiers.some((entry) => entry.tier === "large"), true);
  assert.equal(productMetadata.warnings.includes("gateway-warning"), true);
  assert.equal(productMetadata.errors.length, 0);
  assert.equal(productMetadata.latency_ms, 55);
  assert.equal(productMetadata.latency.model_ms, 46);
  assert.equal(productMetadata.latency.tool_ms, 9);
  assert.equal(JSON.stringify(productMetadata).includes("private-dataset-id"), false);
  assert.equal(JSON.stringify(productMetadata).includes("private-batch-id"), false);
  assert.equal(chunks.length, 2);
  assert.equal(
    (chunks[0]?.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content,
    "gateway answer",
  );
  assert.equal(
    (chunks[1]?.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason,
    "stop",
  );
  assert.deepEqual(gatewayEvents.map((event) => event.type), ["gateway_start", "gateway_result"]);
});

test("MswarmCodaliExecutor maps Ollama CLI agents to the Ollama runtime provider", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  await executor.invoke({
    jobId: "job-ollama-cli",
    requestId: "req-ollama-cli",
    model: "mcoda-local-qwen",
    messages: [{ role: "user", content: "Search Docdex before answering." }],
    agent: {
      slug: "qwen-35b",
      adapter: "ollama-cli",
      model: "qwen3.5:35b",
      supportsTools: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    policy: {
      allowShell: false,
      allowWrites: false,
      allowedTools: ["docdex_search"],
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 1,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-ollama-cli",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.provider.name, "ollama-remote");
  assert.equal(capturedInput.agent?.provider, "ollama-remote");
  assert.equal(capturedInput.policy.mode, "protocol_loop");
});

test("MswarmCodaliExecutor maps OpenAI API agents to the OpenAI-compatible runtime provider", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  await executor.invoke({
    jobId: "job-openai-api",
    requestId: "req-openai-api",
    model: "qwen3.6-llama.cpp",
    messages: [{ role: "user", content: "Return OK." }],
    agent: {
      slug: "qwen3.6-llama.cpp",
      adapter: "openai-api",
      provider: "openai-api",
      model: "qwen3.6-llama.cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      supportsTools: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    policy: {
      allowShell: false,
      allowWrites: false,
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "OK",
        messages: [{ role: "assistant", content: "OK" }],
        toolCallsExecuted: 0,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-openai-api",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.provider.name, "openai-compatible");
  assert.equal(capturedInput.agent?.provider, "openai-compatible");
});

test("MswarmCodaliExecutor maps local OpenAI-compatible agents and forwards runner metadata", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  await executor.invoke({
    jobId: "job-vllm-local",
    requestId: "req-vllm-local",
    model: "mcoda-local-vllm",
    messages: [{ role: "user", content: "Use local vLLM." }],
    agent: {
      slug: "local-vllm",
      adapter: "vllm-local",
      model: "Qwen/Qwen3-32B",
      baseUrl: "http://127.0.0.1:8000/v1",
      localRunner: {
        baseUrl: "http://127.0.0.1:8000/v1",
        runnerKind: "vllm",
        authMode: "dummy-bearer",
        dummyBearerToken: "local",
        headers: { "x-mswarm-node": "local" },
        extraBody: { guided_choice: ["approve", "reject"] },
        responseFormatStrategy: "json-object",
        healthPath: "/health",
        modelsPath: "/v1/models",
        requireModelInRequest: true,
        supportsStreaming: true,
        supportsTools: true,
        supportsJsonSchema: true,
        supportsGbnf: false,
      },
      runnerKind: "vllm",
      authMode: "dummy-bearer",
      dummyBearerToken: "local",
      headers: { "x-mswarm-node": "local" },
      extraBody: { guided_choice: ["approve", "reject"] },
      responseFormatStrategy: "json-object",
      healthPath: "/health",
      modelsPath: "/v1/models",
      requireModelInRequest: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonSchema: true,
      supportsGbnf: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 0,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-vllm-local",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.provider.name, "openai-compatible");
  assert.equal(capturedInput.provider.model, "Qwen/Qwen3-32B");
  assert.equal(capturedInput.provider.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(capturedInput.provider.runnerKind, "vllm");
  assert.equal(capturedInput.provider.authMode, "dummy-bearer");
  assert.equal(capturedInput.provider.dummyBearerToken, "local");
  assert.deepEqual(capturedInput.provider.headers, { "x-mswarm-node": "local" });
  assert.deepEqual(capturedInput.provider.extraBody, { guided_choice: ["approve", "reject"] });
  assert.equal(capturedInput.provider.responseFormatStrategy, "json-object");
  assert.equal(capturedInput.provider.healthPath, "/health");
  assert.equal(capturedInput.provider.modelsPath, "/v1/models");
  assert.equal(capturedInput.provider.requireModelInRequest, true);
  assert.equal(capturedInput.provider.supportsStreaming, true);
  assert.equal(capturedInput.provider.supportsTools, true);
  assert.equal(capturedInput.provider.supportsJsonSchema, true);
  assert.equal(capturedInput.provider.supportsGbnf, false);
  assert.equal(capturedInput.agent?.provider, "openai-compatible");
  assert.equal(capturedInput.agent?.runnerKind, "vllm");
  assert.equal(capturedInput.agent?.authMode, "dummy-bearer");
  assert.deepEqual(capturedInput.agent?.headers, { "x-mswarm-node": "local" });
  assert.deepEqual(capturedInput.agent?.extraBody, { guided_choice: ["approve", "reject"] });
  assert.equal(capturedInput.agent?.responseFormatStrategy, "json-object");
  assert.equal(capturedInput.agent?.supportsJsonSchema, true);
  assert.equal(capturedInput.agent?.supportsGbnf, false);
});

test("MswarmCodaliExecutor attaches encrypted Docdex runtime key only to Codali docdex context", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  const result = await executor.invoke({
    jobId: "job-docdex-secure",
    requestId: "req-docdex-secure",
    model: "mcoda-local",
    messages: [{ role: "user", content: "Search encrypted Docdex context." }],
    agent: {
      slug: "local-ollama",
      adapter: "ollama-remote",
      model: "qwen3.5:35b",
      baseUrl: "http://ollama.test",
      supportsTools: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    docdex: {
      baseUrl: "http://docdex.secure.test",
      repoRoot: "/tmp/workspace",
      repoId: "repo-secure",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search", "snippet"],
      capabilities: { search: true, snippet: true, open: false },
    },
    attachedMswarmApiKey: "msw_docdex_secret",
    policy: {
      allowShell: false,
      allowWrites: false,
      allowedTools: ["docdex_search", "docdex_open"],
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 1,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-secure-docdex",
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.docdex?.baseUrl, "http://docdex.secure.test");
  assert.equal(capturedInput.docdex?.repoId, "repo-secure");
  assert.equal(capturedInput.docdex?.credentialSource, "attached_mswarm_api_key");
  assert.equal(capturedInput.docdex?.apiKey, "msw_docdex_secret");
  assert.deepEqual(capturedInput.docdex?.allowedOperations, ["search", "snippet"]);
  assert.deepEqual(capturedInput.docdex?.capabilities, { search: true, snippet: true, open: false });
  assert.equal(JSON.stringify(result.metadata).includes("msw_docdex_secret"), false);
});

test("MswarmCodaliExecutor passes session and subagent settings to Codali", async () => {
  const executor = new MswarmCodaliExecutor();
  const runtimeInput: { value?: CodaliRuntimeInput } = {};

  const result = await executor.invoke({
    jobId: "job-session",
    requestId: "req-session",
    model: "mcoda-local",
    messages: [{ role: "user", content: "Resume and delegate." }],
    agent: {
      slug: "local-ollama",
      adapter: "ollama-remote",
      model: "llama-local:latest",
      baseUrl: "http://ollama.test",
      supportsTools: false,
    },
    workspace: { root: "/tmp/workspace", readOnly: true },
    session: {
      id: "session-123",
      resume: true,
      focusPaths: ["packages/codali/src/runtime/CodaliRuntime.ts"],
    },
    subagents: {
      enabled: true,
      maxParallel: 2,
      maxSubagents: 3,
      defaultTools: ["docdex.search", "file.read"],
    },
    runCodali: async (input) => {
      runtimeInput.value = input;
      return {
        finalMessage: "done",
        messages: [{ role: "assistant", content: "done" }],
        toolCallsExecuted: 0,
        touchedFiles: [],
        warnings: [],
        events: [],
        runId: "run-session",
        session: {
          id: "session-123",
          summaryRefs: ["summaries/summary.json"],
          instructionSources: ["AGENTS.md"],
        },
      } satisfies CodaliRuntimeResult;
    },
  });

  const capturedInput = runtimeInput.value;
  assert.ok(capturedInput);
  assert.equal(capturedInput.docdex?.enabled, false);
  assert.deepEqual(capturedInput.session, {
    id: "session-123",
    resume: true,
    focusPaths: ["packages/codali/src/runtime/CodaliRuntime.ts"],
  });
  assert.deepEqual(capturedInput.subagents, {
    enabled: true,
    maxParallel: 2,
    maxSubagents: 3,
    defaultTools: ["docdex.search", "file.read"],
  });
  assert.equal(result.metadata.session_id, "session-123");
});
