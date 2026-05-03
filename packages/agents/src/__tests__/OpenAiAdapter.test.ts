import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAiAdapter } from "../adapters/openai/OpenAiAdapter.js";
import { Agent } from "@mcoda/shared";

const originalFetch = global.fetch;

const agent: Agent = {
  id: "agent-openai",
  slug: "openai",
  adapter: "openai-api",
  createdAt: "now",
  updatedAt: "now",
};

afterEach(() => {
  global.fetch = originalFetch;
});

test("OpenAiAdapter healthCheck reflects missing api key", async () => {
  const adapter = new OpenAiAdapter({ agent, capabilities: ["chat"], model: "gpt-4o" });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "unreachable");
  assert.equal(health.details?.reason, "missing_api_key");
});

test("OpenAiAdapter healthCheck probes the configured endpoint", async () => {
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    assert.equal(url, "https://api.example.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.model, "gpt-4o");
    assert.equal(body.max_tokens, 1);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
  });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "healthy");
  assert.equal((health.details as any)?.source, "openai_probe");
});

test("OpenAiAdapter healthCheck keeps probe 429s non-blocking and records retry metadata", async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "120",
        "x-ratelimit-reset-after": "120",
      },
    });

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
  });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "healthy");
  assert.equal((health.details as any)?.reason, "rate_limited");
  assert.equal((health.details as any)?.rateLimited, true);
  assert.equal((health.details as any)?.transient, true);
  assert.equal((health.details as any)?.httpStatus, 429);
  assert.equal((health.details as any)?.resetAtSource, "header");
  assert.equal((health.details as any)?.retryAfterMs, 120_000);
  assert.deepEqual((health.details as any)?.windowTypes, ["other"]);
});

test("OpenAiAdapter healthCheck marks HTTP failures unreachable", async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "bad gateway" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
  });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "unreachable");
  assert.equal((health.details as any)?.reason, "http_error");
  assert.equal((health.details as any)?.httpStatus, 502);
});

test("OpenAiAdapter invoke posts to the configured endpoint and parses output", async () => {
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    assert.equal(url, "https://api.example.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.model, "gpt-4o");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.messages?.[0]?.content, "hello");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: [{ type: "output_text", text: "hello from api" }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    adapter: "openai-api",
    baseUrl: "https://api.example.com/v1",
    temperature: 0.2,
  });
  const result = await adapter.invoke({ input: "hello" });
  assert.equal(result.output, "hello from api");
  assert.equal(result.adapter, "openai-api");
  assert.equal(result.model, "gpt-4o");
  assert.equal(result.metadata?.authMode, "api");
  assert.equal((result.metadata as any)?.tokensTotal, 7);
});

test("OpenAiAdapter forwards managed mswarm Docdex runtime context without exposing the raw key", async () => {
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    assert.equal(url, "https://api.mswarm.test/v1/swarm/openai/chat/completions");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer msw_owner");
    assert.equal(headers["x-docdex-repo-id"], "repo-secure");
    assert.equal(headers["x-docdex-repo-root"], "/workspace");
    assert.equal(headers["x-api-key"], undefined);
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.model, "qwen3.5:35b");
    assert.equal(body.docdex.base_url, "https://docdex.secure.test");
    assert.equal(body.docdex.repo_id, "repo-secure");
    assert.equal(body.docdex.repo_root, "/workspace");
    assert.equal(body.docdex.required, true);
    assert.equal(body.docdex.credential_source, "attached_mswarm_api_key");
    assert.deepEqual(body.docdex.allowed_operations, ["search", "snippet", "chat_context"]);
    assert.deepEqual(body.docdex.capabilities, {
      search: true,
      snippet: true,
      chat_context: true,
      open: false,
    });
    assert.equal(JSON.stringify(body).includes("msw_owner"), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: "secured" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = new OpenAiAdapter({
    agent: {
      ...agent,
      config: {
        mswarmCloud: {
          managed: true,
          remoteSlug: "qwen-secure",
        },
      },
    } as Agent,
    capabilities: ["chat", "docdex_query"],
    model: "qwen3.5:35b",
    apiKey: "msw_owner",
    adapter: "openai-api",
    baseUrl: "https://api.mswarm.test/v1/swarm/openai",
  });
  const result = await adapter.invoke({
    input: "use docdex",
    metadata: {
      docdex: {
        base_url: "https://docdex.secure.test",
        repo_id: "repo-secure",
        repo_root: "/workspace",
        required: true,
        allowed_operations: ["search", "snippet", "chat_context"],
        credential_source: "attached_mswarm_api_key",
        capabilities: {
          search: true,
          snippet: true,
          chat_context: true,
          open: false,
        },
      },
    },
  });
  assert.equal(result.output, "secured");
});

test("OpenAiAdapter ignores Docdex metadata for non-mswarm OpenAI agents", async () => {
  global.fetch = async (_input: any, init?: any) => {
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.docdex, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
  });
  const result = await adapter.invoke({
    input: "hello",
    metadata: {
      docdexBaseUrl: "https://docdex.secure.test",
      docdexRepoId: "repo-secure",
    },
  });
  assert.equal(result.output, "plain");
});

test("OpenAiAdapter invokeStream parses SSE chunks", async () => {
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    assert.equal(url, "https://api.example.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body ?? ""));
    assert.equal(body.stream, true);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'),
        );
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"stream"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
  });
  const chunks: Array<{ output: string; metadata?: Record<string, unknown> }> = [];
  for await (const chunk of adapter.invokeStream({ input: "stream" })) {
    chunks.push(chunk);
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.output),
    ["hello", "stream"],
  );
  assert.equal((chunks[1]?.metadata as any)?.tokensTotal, 5);
});
