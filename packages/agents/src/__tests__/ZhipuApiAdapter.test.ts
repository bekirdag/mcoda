import test from "node:test";
import assert from "node:assert/strict";
import { ZhipuApiAdapter } from "../adapters/zhipu/ZhipuApiAdapter.js";
import { Agent } from "@mcoda/shared";

const agent: Agent = {
  id: "agent-zhipu",
  slug: "zhipu",
  adapter: "zhipu-api",
  createdAt: "now",
  updatedAt: "now",
};

test("ZhipuApiAdapter rejects invalid baseUrl", () => {
  assert.throws(
    () =>
      new ZhipuApiAdapter({
        agent,
        capabilities: ["chat"],
        model: "glm-4",
        apiKey: "secret",
        baseUrl: "ftp://invalid",
      } as any),
    /baseUrl must start with http/,
  );
});

test("ZhipuApiAdapter healthCheck reports missing api key", async () => {
  const adapter = new ZhipuApiAdapter({ agent, capabilities: ["chat"], model: "glm-4" } as any);
  const health = await adapter.healthCheck();
  assert.equal(health.status, "unreachable");
  assert.equal(health.details?.reason, "missing_api_key");
});

test("ZhipuApiAdapter invoke returns parsed output and usage", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      assert.equal(url, "https://api.example.com/chat/completions");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, "glm-4");
      assert.equal(body.stream, false);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: " hello " } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const adapter = new ZhipuApiAdapter({
      agent,
      capabilities: ["chat"],
      model: "glm-4",
      apiKey: "secret",
      baseUrl: "https://api.example.com/",
    } as any);
    const result = await adapter.invoke({ input: "hi" });
    assert.equal(result.output, "hello");
    assert.equal(result.metadata?.tokensPrompt, 2);
    assert.equal(result.metadata?.tokensCompletion, 3);
    assert.equal(result.metadata?.baseUrl, "https://api.example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZhipuApiAdapter invokeStream parses SSE chunks", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n'));
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const adapter = new ZhipuApiAdapter({
      agent,
      capabilities: ["chat"],
      model: "glm-4",
      apiKey: "secret",
      baseUrl: "https://api.example.com",
    } as any);

    const outputs: string[] = [];
    let lastMetadata: Record<string, unknown> | undefined;
    for await (const chunk of adapter.invokeStream({ input: "hi" })) {
      outputs.push(chunk.output);
      lastMetadata = chunk.metadata;
    }

    assert.deepEqual(outputs, ["Hello ", "world"]);
    assert.equal(lastMetadata?.tokensPrompt, 1);
    assert.equal(lastMetadata?.tokensCompletion, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
