import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codaliEventToOpenAIChatCompletionChunk,
  codaliEventToOpenAISseData,
  runCodaliTask,
  type CodaliRuntimePolicy,
} from "../CodaliRuntime.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import type { ToolDefinition } from "../../tools/ToolTypes.js";

class StubProvider implements Provider {
  name = "stub";
  requests: ProviderRequest[] = [];
  private calls = 0;

  constructor(private responses: ProviderResponse[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    request.onEvent?.({ type: "token", content: "streamed " });
    const response = this.responses[this.calls];
    this.calls += 1;
    if (!response) {
      return { message: { role: "assistant", content: "" } };
    }
    return response;
  }
}

type RuntimeStubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (key: string) => string | null };
};

type RuntimeFetchHandler = (url: string, init?: RequestInit) => RuntimeStubResponse;

const runtimeJsonResponse = (payload: unknown): RuntimeStubResponse => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  headers: { get: () => "application/json" },
});

const runtimeTextResponse = (body: string): RuntimeStubResponse => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => body,
  headers: { get: () => "text/plain" },
});

const withRuntimeStubbedFetch = async (
  handler: RuntimeFetchHandler,
  fn: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init) as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const basePolicy = (overrides: Partial<CodaliRuntimePolicy> = {}): CodaliRuntimePolicy => ({
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  maxSteps: 4,
  maxToolCalls: 4,
  timeoutMs: 5_000,
  mode: "tool_loop",
  ...overrides,
});

test("runCodaliTask returns a structured direct result", { concurrency: false }, async () => {
  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "pong" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]);
  const events: string[] = [];

  const result = await runCodaliTask({
    task: "say ping",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools: [],
    policy: basePolicy(),
    streaming: { enabled: true },
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  assert.equal(result.finalMessage, "pong");
  assert.equal(result.toolCallsExecuted, 0);
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  assert.ok(result.runId);
  assert.ok(result.events.some((event) => event.type === "token" && event.content === "streamed "));
  assert.ok(result.events.some((event) => event.type === "final" && event.content === "pong"));
  assert.ok(events.includes("token"));
  assert.ok(events.includes("final"));
});

test("runCodaliTask executes injected tools and records touched files", { concurrency: false }, async () => {
  const tool: ToolDefinition = {
    name: "touch_marker",
    description: "record a touched file",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    handler: async (args, context) => {
      const { path } = args as { path: string };
      context.recordTouchedFile?.(path);
      return { output: `touched:${path}` };
    },
  };
  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_1", name: "touch_marker", args: { path: "src/ping.ts" } }],
    },
    { message: { role: "assistant", content: "done" } },
  ]);

  const result = await runCodaliTask({
    task: "touch marker",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools: [tool],
    policy: basePolicy({ allowWrites: true }),
  });

  assert.equal(result.finalMessage, "done");
  assert.equal(result.toolCallsExecuted, 1);
  assert.deepEqual(result.touchedFiles, ["src/ping.ts"]);
  assert.ok(result.events.some((event) => event.type === "tool_call" && event.name === "touch_marker"));
  assert.ok(result.events.some((event) => event.type === "tool_result" && event.name === "touch_marker"));
});

test("runCodaliTask filters injected tools with allow and deny lists", { concurrency: false }, async () => {
  const tools: ToolDefinition[] = [
    {
      name: "allowed_tool",
      description: "allowed",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "ok" }),
    },
    {
      name: "denied_tool",
      description: "denied",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "no" }),
    },
  ];
  const provider = new StubProvider([{ message: { role: "assistant", content: "done" } }]);

  await runCodaliTask({
    task: "inspect tools",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools,
    policy: basePolicy({
      allowedTools: ["allowed_tool", "denied_tool"],
      deniedTools: ["denied_tool"],
    }),
  });

  assert.deepEqual(
    provider.requests[0]?.tools?.map((tool) => tool.name),
    ["allowed_tool"],
  );
});

test("runCodaliTask disables write tools when policy forbids writes", { concurrency: false }, async () => {
  const provider = new StubProvider([{ message: { role: "assistant", content: "done" } }]);

  await runCodaliTask({
    task: "inspect default tools",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    policy: basePolicy({ allowedTools: ["read_file", "write_file"] }),
  });

  const offeredTools = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(offeredTools.includes("read_file"));
  assert.ok(!offeredTools.includes("write_file"));
});

test("runCodaliTask scopes Docdex tools by runtime policy", { concurrency: false }, async () => {
  const provider = new StubProvider([{ message: { role: "assistant", content: "done" } }]);
  const docdexTools: ToolDefinition[] = [
    {
      name: "docdex_search",
      description: "safe search",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "search" }),
    },
    {
      name: "docdex_web_research",
      description: "web",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "web" }),
    },
    {
      name: "docdex_memory_save",
      description: "memory write",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "memory" }),
    },
    {
      name: "docdex_save_preference",
      description: "profile write",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "profile" }),
    },
    {
      name: "docdex_index_rebuild",
      description: "index rebuild",
      inputSchema: { type: "object" },
      handler: async () => ({ output: "index" }),
    },
  ];

  await runCodaliTask({
    task: "inspect docdex tools",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools: docdexTools,
    docdex: {
      allowWeb: false,
      allowMemoryWrite: false,
      allowProfileWrite: false,
      allowIndexRebuild: false,
    },
    policy: basePolicy({
      allowWrites: true,
      allowedTools: docdexTools.map((tool) => tool.name),
    }),
  });

  assert.deepEqual(
    provider.requests[0]?.tools?.map((tool) => tool.name),
    ["docdex_search"],
  );
});

test("runCodaliTask scopes built-in Docdex tools by encrypted runtime operations", {
  concurrency: false,
}, async () => {
  const provider = new StubProvider([{ message: { role: "assistant", content: "done" } }]);

  await runCodaliTask({
    task: "inspect encrypted docdex tools",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    docdex: {
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search", "snippet"],
      capabilities: { search: true, snippet: true, open: false },
      allowWeb: false,
      allowMemoryWrite: false,
      allowProfileWrite: false,
      allowIndexRebuild: false,
    },
    policy: basePolicy(),
  });

  const offeredTools = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(offeredTools.includes("docdex_search"));
  assert.ok(offeredTools.includes("docdex_open"));
  assert.ok(!offeredTools.includes("docdex_open_file"));
  assert.ok(!offeredTools.includes("docdex_web_research"));
  assert.ok(!offeredTools.includes("docdex_symbols"));
});

test("runCodaliTask sends encrypted Docdex context to built-in search without prompt repo override", {
  concurrency: false,
}, async () => {
  const secret = "msw_docdex_secret";
  const repoId = "secure-repo";
  const seenSearch: Array<{ url: string; headers?: Record<string, string> }> = [];
  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [
        {
          id: "call-search",
          name: "docdex_search",
          args: { query: "repo_id=prompt-controlled search term", limit: 1 },
        },
      ],
    },
    { message: { role: "assistant", content: "done" } },
  ]);

  await withRuntimeStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return runtimeTextResponse("ok");
    }
    if (url.startsWith("http://docdex.secure.test/search?")) {
      const headers = init?.headers as Record<string, string> | undefined;
      const parsed = new URL(url);
      seenSearch.push({ url, headers });
      assert.equal(headers?.["x-api-key"], secret);
      assert.equal(headers?.["x-docdex-repo-id"], repoId);
      assert.equal(parsed.searchParams.get("repo_id"), repoId);
      assert.equal(parsed.searchParams.get("q"), "repo_id=prompt-controlled search term");
      return runtimeJsonResponse({ results: [{ rel_path: "src/secure.ts" }] });
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
      headers: { get: () => "text/plain" },
    };
  }, async () => {
    const result = await runCodaliTask({
      task: "Use Docdex. The repo_id is prompt-controlled.",
      workspace: { root: process.cwd() },
      provider: { name: "stub", model: "stub" },
      providerInstance: provider,
      docdex: {
        baseUrl: "http://docdex.secure.test",
        repoId,
        apiKey: secret,
        credentialSource: "attached_mswarm_api_key",
        required: true,
        allowedOperations: ["search"],
        capabilities: { search: true },
      },
      policy: basePolicy({ allowedTools: ["docdex_search"] }),
    });

    assert.equal(result.toolCallsExecuted, 1);
    assert.equal(result.finalMessage, "done");
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  assert.equal(seenSearch.length, 1);
});

test("runCodaliTask protocol_loop executes AGENT_REQUEST Docdex needs", { concurrency: false }, async () => {
  const executed: Array<{ name: string; args: unknown }> = [];
  const tools: ToolDefinition[] = [
    {
      name: "docdex_search",
      description: "search",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "number" } },
      },
      handler: async (args) => {
        executed.push({ name: "docdex_search", args });
        return {
          output: "search output",
          data: { results: [{ rel_path: "packages/codali/src/runtime/CodaliRuntime.ts" }] },
        };
      },
    },
    {
      name: "docdex_web_research",
      description: "web",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, forceWeb: { type: "boolean" } },
      },
      handler: async (args) => {
        executed.push({ name: "docdex_web_research", args });
        return {
          output: "web output",
          data: { results: [{ title: "Ollama tool use", url: "https://example.test/ollama" }] },
        };
      },
    },
  ];
  const provider = new StubProvider([
    {
      message: {
        role: "assistant",
        content: [
          "AGENT_REQUEST v1",
          "role: reviewer",
          "request_id: req-context",
          "needs:",
          "  - type: docdex.search",
          '    query: "CodaliRuntime protocol_loop"',
          "    limit: 3",
          "  - type: docdex.web",
          '    query: "Ollama local tool orchestration"',
          "context:",
          '  summary: "Need repo and web context before answering"',
        ].join("\n"),
      },
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    {
      message: { role: "assistant", content: "Final answer with Docdex and web context." },
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
  ]);

  const result = await runCodaliTask({
    task: "Explain protocol loop",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools,
    docdex: { allowWeb: true },
    policy: basePolicy({ mode: "protocol_loop" }),
  });

  assert.equal(result.finalMessage, "Final answer with Docdex and web context.");
  assert.equal(result.toolCallsExecuted, 2);
  assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 8, totalTokens: 14 });
  assert.deepEqual(executed, [
    { name: "docdex_search", args: { query: "CodaliRuntime protocol_loop", limit: 3 } },
    {
      name: "docdex_web_research",
      args: { query: "Ollama local tool orchestration", forceWeb: true },
    },
  ]);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0]?.tools, undefined);
  assert.match(provider.requests[0]?.messages[0]?.content ?? "", /AGENT_REQUEST v1/);
  const responseMessage = provider.requests[1]?.messages.at(-1);
  assert.equal(responseMessage?.role, "user");
  assert.match(responseMessage?.content ?? "", /CODALI_RESPONSE v1/);
  assert.match(responseMessage?.content ?? "", /docdex\.search/);
  assert.match(responseMessage?.content ?? "", /docdex\.web/);
  assert.match(responseMessage?.content ?? "", /CodaliRuntime\.ts/);
  assert.match(responseMessage?.content ?? "", /Ollama tool use/);
  assert.ok(result.events.some((event) => event.type === "tool_call" && event.name === "docdex_search"));
  assert.ok(
    result.events.some((event) => event.type === "tool_call" && event.name === "docdex_web_research"),
  );
});

test("runCodaliTask protocol_loop maps file list requests", { concurrency: false }, async () => {
  const listTool: ToolDefinition = {
    name: "list_files",
    description: "list",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, maxDepth: { type: "number" } },
    },
    handler: async () => ({
      output: "src/a.ts\nsrc/b.test.ts\nREADME.md",
      data: { entries: ["src/a.ts", "src/b.test.ts", "README.md"] },
    }),
  };
  const provider = new StubProvider([
    {
      message: {
        role: "assistant",
        content: [
          "AGENT_REQUEST v1",
          "role: reviewer",
          "request_id: req-files",
          "needs:",
          "  - type: file.list",
          "    root: src",
          '    pattern: "*.test.ts"',
        ].join("\n"),
      },
    },
    { message: { role: "assistant", content: "tests found" } },
  ]);

  const result = await runCodaliTask({
    task: "list tests",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    tools: [listTool],
    policy: basePolicy({ mode: "protocol_loop" }),
  });

  assert.equal(result.toolCallsExecuted, 1);
  const responseMessage = provider.requests[1]?.messages.at(-1)?.content ?? "";
  assert.match(responseMessage, /"files": \[/);
  assert.match(responseMessage, /src\/b\.test\.ts/);
  assert.doesNotMatch(responseMessage, /README\.md/);
});

test("runCodaliTask protocol_loop executes agent.delegate subagents", { concurrency: false }, async () => {
  const provider = new StubProvider([
    {
      message: {
        role: "assistant",
        content: [
          "AGENT_REQUEST v1",
          "role: architect",
          "request_id: req-delegate",
          "needs:",
          "  - type: agent.delegate",
          "    role: explorer",
          '    goal: "Find runtime context"',
          "    tools: file.read",
          "    allowed_paths: packages/codali/src/runtime",
          "    read_only: true",
        ].join("\n"),
      },
    },
    { message: { role: "assistant", content: "Subagent found runtime context." } },
    { message: { role: "assistant", content: "Final answer after delegation." } },
  ]);

  const result = await runCodaliTask({
    task: "delegate context gathering",
    workspace: { root: process.cwd() },
    provider: { name: "stub", model: "stub" },
    providerInstance: provider,
    agent: {
      slug: "local-ollama",
      adapter: "ollama-remote",
      model: "stub",
      supportsTools: false,
    },
    tools: [],
    policy: basePolicy({ mode: "protocol_loop", maxToolCalls: 4, maxSteps: 5 }),
    subagents: { enabled: true, maxParallel: 1, maxSubagents: 2 },
  });

  assert.equal(result.finalMessage, "Final answer after delegation.");
  assert.equal(result.toolCallsExecuted, 1);
  assert.equal(provider.requests.length, 3);
  assert.ok(
    provider.requests[1]?.messages.some((message) => /Codali explorer subagent/.test(message.content)),
  );
  const codaliResponse = provider.requests[2]?.messages.at(-1)?.content ?? "";
  assert.match(codaliResponse, /agent\.delegate/);
  assert.match(codaliResponse, /Subagent found runtime context/);
  assert.ok(result.events.some((event) => event.type === "subagent_start"));
  assert.ok(result.events.some((event) => event.type === "subagent_result" && event.status === "completed"));
});

test("runCodaliTask persists and resumes protocol_loop sessions", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-runtime-session-"));
  writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "repo instruction\n");
  const session = {
    id: "session-resume",
    storageDir: ".mcoda/codali/sessions",
    compactOnFinish: true,
  };

  const firstProvider = new StubProvider([{ message: { role: "assistant", content: "first final" } }]);
  const first = await runCodaliTask({
    task: "remember this session",
    workspace: { root: workspaceRoot },
    provider: { name: "stub", model: "stub" },
    providerInstance: firstProvider,
    tools: [],
    policy: basePolicy({ mode: "protocol_loop" }),
    session,
  });
  assert.equal(first.session?.id, "session-resume");
  assert.ok(first.session?.summaryRefs.length);
  assert.deepEqual(first.session?.instructionSources, ["AGENTS.md"]);

  const secondProvider = new StubProvider([{ message: { role: "assistant", content: "resumed final" } }]);
  await runCodaliTask({
    task: "continue session",
    workspace: { root: workspaceRoot },
    provider: { name: "stub", model: "stub" },
    providerInstance: secondProvider,
    tools: [],
    policy: basePolicy({ mode: "protocol_loop" }),
    session: { ...session, resume: true },
  });

  const systemPrompt = secondProvider.requests[0]?.messages[0]?.content ?? "";
  assert.match(systemPrompt, /Loaded project instructions/);
  assert.match(systemPrompt, /repo instruction/);
  assert.match(systemPrompt, /Resume context/);
  assert.match(systemPrompt, /first final/);
});

test("codali OpenAI stream helpers hide internal events by default", () => {
  const tokenChunk = codaliEventToOpenAIChatCompletionChunk(
    { type: "token", content: "pong", at: "2026-04-30T00:00:00.000Z" },
    { requestId: "req-stream", model: "local-agent", created: 1 },
  );
  assert.deepEqual(tokenChunk, {
    id: "chatcmpl-req-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-agent",
    choices: [
      {
        index: 0,
        delta: { content: "pong" },
        finish_reason: null,
      },
    ],
  });

  const toolResult = codaliEventToOpenAIChatCompletionChunk(
    {
      type: "tool_result",
      id: "call-1",
      name: "docdex_search",
      ok: true,
      output: "hidden evidence",
      at: "2026-04-30T00:00:00.000Z",
    },
    { requestId: "req-stream", model: "local-agent", created: 1 },
  );
  assert.equal(toolResult, null);

  const finalSse = codaliEventToOpenAISseData(
    { type: "final", content: "done", at: "2026-04-30T00:00:00.000Z" },
    { requestId: "req-stream", model: "local-agent", created: 1 },
  );
  assert.equal(
    finalSse,
    'data: {"id":"chatcmpl-req-stream","object":"chat.completion.chunk","created":1,"model":"local-agent","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  );
});
