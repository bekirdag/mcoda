import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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

test("model context survives a strict Unicode server without changing source or tool values", async () => {
  const originalText = "high:\ud800 low:\udfff adjacent:\ud800\ud800\udc00 emoji:😀 literal:\\ud800";
  const expectedText = "high:\\ud800 low:\\udfff adjacent:\\ud800\ud800\udc00 emoji:😀 literal:\\ud800";
  const args = { text: "\ud800", emoji: "😀", literal: "\\ud800" };
  const messages: ProviderRequest["messages"] = [
    { role: "system", content: originalText },
    { role: "user", content: originalText },
    { role: "assistant", content: originalText, toolCalls: [{ id: "call_1", name: "inspect", args }] },
    { role: "tool", toolCallId: "call_1", content: originalText },
  ];
  let received: any;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // This checks the strings AFTER JSON decoding, where the native Python
    // tokenizer failed. A well-formed JSON byte stream alone is insufficient.
    const scalarText = (value: unknown): boolean => {
      if (typeof value === "string") return !/[\uD800-\uDFFF]/u.test(value);
      if (value && typeof value === "object") return Object.values(value).every(scalarText);
      return true;
    };
    response.writeHead(scalarText(received) ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "accepted" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = new OpenAiCompatibleProvider({ model: "test", baseUrl: `http://127.0.0.1:${address.port}/v1/` });
    const result = await provider.generate({ messages, tools: [{ name: "inspect", description: originalText }] });
    assert.equal(result.message.content, "accepted");
    assert.deepEqual(received.messages.map((message: { content: string }) => message.content), Array(4).fill(expectedText));
    assert.equal(received.tools[0].function.description, expectedText);
    assert.deepEqual(JSON.parse(received.messages[2].tool_calls[0].function.arguments), args);
    assert.deepEqual(messages.map((message) => message.content), Array(4).fill(originalText));
    assert.equal(messages[2].toolCalls?.[0].args, args);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAiCompatibleProvider reports HTTP 200 error envelopes without leaking credentials", { concurrency: false }, async () => {
  const apiKey = "test-private-api-key";
  for (const error of [
    { code: `upstream_${apiKey}`, message: `failure ${apiKey} ${"x".repeat(800)}` },
    `failure ${apiKey}`,
  ]) {
    await withStubbedFetch(() => ({ error }), async () => {
      const provider = new OpenAiCompatibleProvider({ model: "test", apiKey });
      await assert.rejects(provider.generate({ messages: [{ role: "user", content: "test" }] }),
        (failure: unknown) => {
          assert.ok(failure instanceof Error);
          assert.match(failure.message, /^OpenAI-compatible error/);
          assert.match(failure.message, /\[redacted\]/);
          assert.ok(!failure.message.includes(apiKey));
          assert.ok(failure.message.length <= 600);
          return true;
        });
    });
  }
});

test("OpenAiCompatibleProvider diagnoses an empty successful envelope", { concurrency: false }, async () => {
  await withStubbedFetch(() => ({}), async () => {
    const provider = new OpenAiCompatibleProvider({ model: "test" });
    await assert.rejects(provider.generate({ messages: [] }), /response missing choices/);
  });
});

test("OpenAiCompatibleProvider preserves typed refusals in JSON and SSE relay envelopes without replay", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const stream of [false, true]) for (const code of ["context_length_exceeded", "rate_limited"]) {
      let posts = 0;
      const error = { code, message: "Private upstream input" };
      globalThis.fetch = async () => {
        posts++;
        return stream
          ? new Response(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json({ error });
      };
      await assert.rejects(new OpenAiCompatibleProvider({ model: "test", retryTransient: false }).generate({ messages: [], stream }), (failure: unknown) => {
        assert.ok(failure instanceof Error);
        assert.equal(failure.name, "ModelServiceError");
        assert.equal((failure as Error & { code: string }).code, code);
        assert.doesNotMatch(failure.message, /Private upstream/);
        return true;
      });
      assert.equal(posts, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("OpenAiCompatibleProvider preserves the initial system policy for prompt-only schemas", { concurrency: false }, async () => {
  const messages: ProviderRequest["messages"] = [
    { role: "system", content: "Read-only tenant policy." },
    { role: "user", content: "Return status." },
  ];
  await withStubbedFetch((_url, body) => {
    const sent = JSON.parse(body);
    assert.deepEqual(sent.messages.map((message: { role: string }) => message.role), ["system", "user"]);
    assert.match(sent.messages[0].content, /^Read-only tenant policy\.\n\nOutput format constraint:/);
    return { choices: [{ message: { role: "assistant", content: "{}" } }] };
  }, async () => {
    const provider = new OpenAiCompatibleProvider({ model: "test", responseFormatStrategy: "prompt-only" });
    await provider.generate({ messages, responseFormat: { type: "json" } });
  });
  assert.equal(messages[0].content, "Read-only tenant policy.");
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

test("OpenAiCompatibleProvider wraps JSON Schemas for strict OpenAI-compatible servers", { concurrency: false }, async () => {
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const envelope = { name: "health_check", strict: true, schema };
  for (const input of [schema, envelope]) {
    await withStubbedFetch(
      (_url, body) => {
        const format = JSON.parse(body).response_format;
        assert.equal(format.type, "json_schema");
        assert.deepEqual(format.json_schema.schema, schema);
        assert.equal(format.json_schema.name, input === schema ? "codali_response" : "health_check");
        if (input === envelope) assert.equal(format.json_schema.strict, true);
        return { choices: [{ message: { role: "assistant", content: '{"ok":true}' } }] };
      },
      async () => {
        const provider = new OpenAiCompatibleProvider({ model: "strata-test", baseUrl: "http://127.0.0.1:9999/v1/" });
        const result = await provider.generate({
          messages: [{ role: "user", content: "Report health." }],
          responseFormat: { type: "json_schema", schema: input },
        });
        assert.deepEqual(JSON.parse(result.message.content), { ok: true });
      },
    );
  }
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
