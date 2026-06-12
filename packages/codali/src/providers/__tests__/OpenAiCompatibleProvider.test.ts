import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../OpenAiCompatibleProvider.js";
import type { ProviderRequest } from "../ProviderTypes.js";

type FetchHandler = (url: string, body: string, headers: HeadersInit | undefined) => unknown;

const withStubbedFetch = async (handler: FetchHandler, fn: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const response = handler(String(input), body, init?.headers);
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

test("OpenAiCompatibleProvider can downgrade json_schema to json_object for local runners", { concurrency: false }, async () => {
  let received: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (_url, body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      return {
        choices: [{ message: { role: "assistant", content: "{}" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        responseFormatStrategy: "json-object",
      });

      await provider.generate({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: {
          type: "json_schema",
          schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
        },
      });
    },
  );

  assert.deepEqual(received?.response_format, { type: "json_object" });
});

test("OpenAiCompatibleProvider supports prompt-only response format constraints", { concurrency: false }, async () => {
  let received: Record<string, any> | undefined;
  await withStubbedFetch(
    (_url, body) => {
      received = JSON.parse(body) as Record<string, any>;
      return {
        choices: [{ message: { role: "assistant", content: "{}" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        responseFormatStrategy: "prompt-only",
      });

      await provider.generate({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      });
    },
  );

  assert.equal(received?.response_format, undefined);
  assert.equal(received?.messages?.[0]?.role, "system");
  assert.match(received?.messages?.[0]?.content ?? "", /Output format constraint/);
  assert.match(received?.messages?.[0]?.content ?? "", /"ok"/);
});

test("OpenAiCompatibleProvider can omit response format payloads", { concurrency: false }, async () => {
  let received: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (_url, body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      return {
        choices: [{ message: { role: "assistant", content: "{}" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        responseFormatStrategy: "none",
      });

      await provider.generate({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "json" },
      });
    },
  );

  assert.equal(received?.response_format, undefined);
});

test("OpenAiCompatibleProvider maps gbnf strategy to grammar payload", { concurrency: false }, async () => {
  let received: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (_url, body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      return {
        choices: [{ message: { role: "assistant", content: "ok" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        responseFormatStrategy: "gbnf",
      });

      await provider.generate({
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "gbnf", grammar: "root ::= \"ok\"" },
      });
    },
  );

  assert.equal(received?.response_format, undefined);
  assert.equal(received?.grammar, "root ::= \"ok\"");
});

test("OpenAiCompatibleProvider omits auth header for authMode none", { concurrency: false }, async () => {
  await withStubbedFetch(
    (_url, body, headers) => {
      assert.equal((headers as Record<string, string>).authorization, undefined);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.model, "test-model");
      return {
        choices: [{ message: { role: "assistant", content: "local" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        authMode: "none",
      });

      const result = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.message.content, "local");
    },
  );
});

test("OpenAiCompatibleProvider sends dummy bearer auth", { concurrency: false }, async () => {
  await withStubbedFetch(
    (_url, _body, headers) => {
      assert.equal((headers as Record<string, string>).authorization, "Bearer local");
      return {
        choices: [{ message: { role: "assistant", content: "dummy" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        authMode: "dummy-bearer",
      });

      const result = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.message.content, "dummy");
    },
  );
});

test("OpenAiCompatibleProvider keeps bearer auth when api key is combined with local extensions", { concurrency: false }, async () => {
  await withStubbedFetch(
    (_url, body, headers) => {
      assert.equal((headers as Record<string, string>).authorization, "Bearer secret");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.model, "test-model");
      assert.equal(parsed.top_k, 40);
      return {
        choices: [{ message: { role: "assistant", content: "bearer" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "https://api.example.com/v1/",
        apiKey: "secret",
        extraBody: { top_k: 40 },
      });

      const result = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.message.content, "bearer");
    },
  );
});

test("OpenAiCompatibleProvider bearer auth requires api key", { concurrency: false }, async () => {
  const provider = new OpenAiCompatibleProvider({
    model: "test-model",
    baseUrl: "http://127.0.0.1:9999/v1/",
    authMode: "bearer",
  });

  await assert.rejects(
    () => provider.generate({ messages: [{ role: "user", content: "hi" }] }),
    /AUTH_REQUIRED/,
  );
});

test("OpenAiCompatibleProvider merges safe extraBody and rejects reserved keys", { concurrency: false }, async () => {
  await withStubbedFetch(
    (_url, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.model, "test-model");
      assert.equal(parsed.top_k, 40);
      return {
        choices: [{ message: { role: "assistant", content: "merged" } }],
      };
    },
    async () => {
      const provider = new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        extraBody: { top_k: 40 },
      });
      await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    },
  );

  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        model: "test-model",
        baseUrl: "http://127.0.0.1:9999/v1/",
        extraBody: { model: "override" },
      }),
    /extraBody must not override/,
  );
});
