import assert from "node:assert/strict";
import test from "node:test";
import {
  MswarmCodaliExecutor,
  type CodaliRuntimeInput,
  type CodaliRuntimeResult,
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
