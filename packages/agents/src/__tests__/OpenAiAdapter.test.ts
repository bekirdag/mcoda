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
