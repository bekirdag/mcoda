import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../OpenAiCompatibleProvider.js";
import type { ProviderRequest } from "../ProviderTypes.js";

type FetchHandler = (url: string, body: string) => unknown;

const withStubbedFetch = async (handler: FetchHandler, fn: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const response = handler(String(input), body);
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
      headers: {
        get: () => "application/json",
      },
    } as unknown as Response;
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test("OpenAiCompatibleProvider returns message content", { concurrency: false }, async () => {
  await withStubbedFetch(
    () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: "hello",
          },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    }),
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
      });
      const request: ProviderRequest = {
        messages: [{ role: "user", content: "hi" }],
      };

      const result = await provider.generate(request);
      assert.equal(result.message.content, "hello");
      assert.equal(result.usage?.totalTokens, 5);
    },
  );
});

test("OpenAiCompatibleProvider parses tool calls", { concurrency: false }, async () => {
  await withStubbedFetch(
    () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\"}",
                },
              },
            ],
          },
        },
      ],
    }),
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
      });
      const request: ProviderRequest = {
        messages: [{ role: "user", content: "read file" }],
      };

      const result = await provider.generate(request);
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0].name, "read_file");
      assert.deepEqual(result.toolCalls?.[0].args, { path: "README.md" });
    },
  );
});

test("OpenAiCompatibleProvider sends response_format and temperature", { concurrency: false }, async () => {
  let received: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (_, body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "{}",
            },
          },
        ],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
      });
      const request: ProviderRequest = {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        responseFormat: { type: "json" },
      };

      await provider.generate(request);
      assert.equal(received?.temperature, 0.2);
      assert.deepEqual(received?.response_format, { type: "json_object" });
    },
  );
});
