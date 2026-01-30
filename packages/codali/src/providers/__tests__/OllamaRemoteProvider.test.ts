import test from "node:test";
import assert from "node:assert/strict";
import { OllamaRemoteProvider } from "../OllamaRemoteProvider.js";
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

type FetchResponseHandler = (url: string, body: string) => {
  status: number;
  ok: boolean;
  json?: unknown;
  text?: string;
};

const withStubbedFetchResponse = async (
  handler: FetchResponseHandler,
  fn: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const response = handler(String(input), body);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json ?? {},
      text: async () => response.text ?? "",
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

test("OllamaRemoteProvider returns content", { concurrency: false }, async () => {
  await withStubbedFetch(
    () => ({
      message: {
        role: "assistant",
        content: "hello from ollama",
      },
      done: true,
    }),
    async () => {
      const provider = new OllamaRemoteProvider({
        model: "llama3",
        baseUrl: "http://127.0.0.1:11434",
      });

      const request: ProviderRequest = {
        messages: [{ role: "user", content: "hi" }],
      };

      const result = await provider.generate(request);
      assert.equal(result.message.content, "hello from ollama");
    },
  );
});

test("OllamaRemoteProvider parses tool calls", { concurrency: false }, async () => {
  await withStubbedFetch(
    () => ({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "list_files",
              arguments: "{\"path\":\"src\"}",
            },
          },
        ],
      },
      done: true,
    }),
    async () => {
      const provider = new OllamaRemoteProvider({
        model: "llama3",
        baseUrl: "http://127.0.0.1:11434",
      });

      const request: ProviderRequest = {
        messages: [{ role: "user", content: "list files" }],
      };

      const result = await provider.generate(request);
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0].name, "list_files");
      assert.deepEqual(result.toolCalls?.[0].args, { path: "src" });
    },
  );
});

test("OllamaRemoteProvider extracts tool calls from content", { concurrency: false }, async () => {
  await withStubbedFetch(
    () => ({
      message: {
        role: "assistant",
        content: "{\"tool\":\"read_file\",\"args\":{\"path\":\"README.md\"}}",
      },
      done: true,
    }),
    async () => {
      const provider = new OllamaRemoteProvider({
        model: "llama3",
        baseUrl: "http://127.0.0.1:11434",
      });

      const request: ProviderRequest = {
        messages: [{ role: "user", content: "read readme" }],
      };

      const result = await provider.generate(request);
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0].name, "read_file");
      assert.deepEqual(result.toolCalls?.[0].args, { path: "README.md" });
    },
  );
});

test("OllamaRemoteProvider sends format and temperature options", { concurrency: false }, async () => {
  let received: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (_, body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      return {
        message: {
          role: "assistant",
          content: "ok",
        },
        done: true,
      };
    },
    async () => {
      const provider = new OllamaRemoteProvider({
        model: "llama3",
        baseUrl: "http://127.0.0.1:11434",
      });

      const request: ProviderRequest = {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.15,
        responseFormat: { type: "json" },
      };

      await provider.generate(request);
      assert.deepEqual(received?.options, { temperature: 0.15 });
      assert.equal(received?.format, "json");
    },
  );
});

test("OllamaRemoteProvider retries with fallback model when not found", { concurrency: false }, async () => {
  let call = 0;
  await withStubbedFetchResponse(
    (url, body) => {
      if (url.endsWith("/api/tags")) {
        return {
          status: 200,
          ok: true,
          json: { models: [{ name: "glm-4.7-flash:latest" }] },
        };
      }
      call += 1;
      if (call === 1) {
        return {
          status: 404,
          ok: false,
          text: "{\"error\":\"model 'glm-4.7-flash' not found\"}",
        };
      }
      const parsed = JSON.parse(body) as { model?: string };
      assert.equal(parsed.model, "glm-4.7-flash:latest");
      return {
        status: 200,
        ok: true,
        json: { message: { role: "assistant", content: "ok" }, done: true },
      };
    },
    async () => {
      const provider = new OllamaRemoteProvider({
        model: "glm-4.7-flash",
        baseUrl: "http://127.0.0.1:11434",
      });
      const request: ProviderRequest = {
        messages: [{ role: "user", content: "hi" }],
      };
      const result = await provider.generate(request);
      assert.equal(result.message.content, "ok");
    },
  );
});
