import test from "node:test";
import assert from "node:assert/strict";
import { DocdexClient } from "../DocdexClient.js";

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (key: string) => string | null };
};

type FetchHandler = (url: string, init?: RequestInit) => StubResponse;

const makeHeaders = (
  contentType: string,
  headers: Record<string, string> = {},
): StubResponse["headers"] => {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get: (key: string) => {
      const normalized = key.toLowerCase();
      if (normalized === "content-type") return contentType;
      return normalizedHeaders.get(normalized) ?? null;
    },
  };
};

const makeJsonResponse = (
  payload: unknown,
  headers: Record<string, string> = {},
): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  headers: makeHeaders("application/json", headers),
});

const makeTextResponse = (body: string): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => body,
  headers: makeHeaders("text/plain"),
});

const makeErrorResponse = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): StubResponse => ({
  ok: false,
  status,
  json: async () => ({ error: body }),
  text: async () => body,
  headers: makeHeaders("text/plain", headers),
});

const withStubbedFetch = async (handler: FetchHandler, fn: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = handler(String(input), init);
    return response as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test("DocdexClient initializes repo before HTTP search when repo id is missing", {
  concurrency: false,
}, async () => {
  const calls: string[] = [];
  await withStubbedFetch((url, init) => {
    calls.push(url);
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/initialize")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      assert.match(String(body.rootUri), /^file:\/\//);
      return makeJsonResponse({ repo_id: "repo-123", repo_root: process.cwd() });
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("repo_id"), "repo-123");
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["x-docdex-repo-id"], "repo-123");
      return makeJsonResponse({ results: [{ rel_path: "src/index.ts" }] });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const result = await client.search("runtime protocol loop", { limit: 1 });
    assert.deepEqual(result, { results: [{ rel_path: "src/index.ts" }] });
    assert.equal(client.getRepoId(), "repo-123");
  });

  assert.deepEqual(calls.map((url) => new URL(url).pathname), [
    "/healthz",
    "/v1/initialize",
    "/search",
  ]);
});

test("DocdexClient sends attached mswarm API key as x-api-key for encrypted repo calls", {
  concurrency: false,
}, async () => {
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("repo_id"), "secure-repo");
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["x-api-key"], "msw_docdex_secret");
      assert.equal(headers?.["x-docdex-repo-id"], "secure-repo");
      assert.equal(headers?.["x-mswarm-client-identity"], "theneuralledger");
      assert.equal(headers?.["x-mswarm-client"], "theneuralledger");
      assert.equal(headers?.authorization, undefined);
      return makeJsonResponse({ results: [] });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      authToken: "legacy-bearer-token",
      apiKey: "msw_docdex_secret",
      clientIdentity: "theneuralledger",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    await client.search("encrypted repo context", { limit: 2 });
  });
});

test("DocdexClient uses tenant-scoped encrypted search, web, and batch endpoints", {
  concurrency: false,
}, async () => {
  const requestBodies: Record<string, unknown>[] = [];
  await withStubbedFetch((url, init) => {
    if (url === "https://api.mswarm.org/v1/docdex/encrypted/healthz") {
      return makeTextResponse("ok");
    }
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["x-api-key"], "msw_docdex_secret");
    assert.equal(headers?.["x-mswarm-client-identity"], "theneuralledger");
    assert.equal(init?.method, "POST");
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    requestBodies.push(body);
    assert.equal(body.repo_key, "theneuralledger");

    if (url.endsWith("/web/search")) {
      assert.equal(body.query, "current external developments");
      assert.equal(body.web_limit, 4);
      return makeJsonResponse({
        feature_key: "docdex-encrypted-search",
        runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
        result: {
          hits: [{ title: "External development", url: "https://example.test/news" }],
          meta: { provider: "mswarm" },
        },
      }, { "x-docdex-request-id": "docdex-web-1" });
    }

    assert.equal(url, "https://api.mswarm.org/v1/docdex/encrypted/search");
    const queries = body.queries as string[];
    if (queries.length === 1) {
      assert.deepEqual(queries, ["most important news last 7 days"]);
      assert.equal(body.limit, 5);
      return makeJsonResponse({
        feature_key: "docdex-encrypted-search",
        runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
        results: [{
          query: queries[0],
          hits: [{ doc_id: "story-1", title: "Current TNL story" }],
        }],
      }, { "x-docdex-request-id": "docdex-search-1" });
    }
    assert.deepEqual(queries, ["markets", "technology"]);
    assert.equal(body.limit, 3);
    return makeJsonResponse({
      feature_key: "docdex-encrypted-search",
      runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
      results: queries.map((query) => ({ query, hits: [{ doc_id: `story-${query}` }] })),
    }, { "x-docdex-request-id": "docdex-batch-1" });
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "https://api.mswarm.org/v1/docdex/encrypted/",
      repoId: "theneuralledger",
      apiKey: "msw_docdex_secret",
      clientIdentity: "theneuralledger",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search", "batch_search", "web_research"],
      capabilities: { search: true, batch_search: true, web_research: true },
    });

    const search = await client.search("most important news last 7 days", { limit: 5 });
    assert.deepEqual(search, {
      query: "most important news last 7 days",
      hits: [{ doc_id: "story-1", title: "Current TNL story" }],
      results: [{ doc_id: "story-1", title: "Current TNL story" }],
      meta: {
        source: "docdex_encrypted_search",
        feature_key: "docdex-encrypted-search",
        runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
        docdex_request_id: "docdex-search-1",
        docdex_operation: "search",
      },
    });

    const web = await client.webResearch("current external developments", { webLimit: 4 });
    assert.deepEqual(web, {
      hits: [{ title: "External development", url: "https://example.test/news" }],
      meta: {
        provider: "mswarm",
        source: "docdex_encrypted_search",
        feature_key: "docdex-encrypted-search",
        runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
        docdex_request_id: "docdex-web-1",
        docdex_operation: "web_research",
      },
    });

    const batch = await client.batchSearch(["markets", "technology"], { limit: 3 });
    assert.deepEqual(batch, {
      results: [
        { query: "markets", hits: [{ doc_id: "story-markets" }] },
        { query: "technology", hits: [{ doc_id: "story-technology" }] },
      ],
      meta: {
        source: "docdex_encrypted_search",
        feature_key: "docdex-encrypted-search",
        runtime_context: { docdex_repo_key: "theneuralledger", docdex_repo_id: "repo-tnl" },
        docdex_request_id: "docdex-batch-1",
        docdex_operation: "batch_search",
      },
    });
  });

  assert.equal(requestBodies.length, 3);
});

test("DocdexClient treats attached-key repo context as immutable and records request ids", {
  concurrency: false,
}, async () => {
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("repo_id"), "secure-repo");
      assert.equal(parsed.searchParams.get("repo_root"), null);
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["x-api-key"], "msw_docdex_secret");
      assert.equal(headers?.["x-docdex-repo-id"], "secure-repo");
      assert.equal(headers?.["x-docdex-repo-root"], undefined);
      return makeJsonResponse(
        {
          results: [{ doc_id: "doc-1", rel_path: "tenant/policy.md" }],
          meta: { source: "encrypted-docdex" },
        },
        { "x-docdex-request-id": "docdex-req-1" },
      );
    }
    assert.notEqual(new URL(url).pathname, "/v1/initialize");
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    const result = await client.search("tenant policy", { limit: 1 });
    assert.deepEqual(result, {
      results: [{ doc_id: "doc-1", rel_path: "tenant/policy.md" }],
      meta: {
        source: "encrypted-docdex",
        docdex_request_id: "docdex-req-1",
        docdex_operation: "search",
      },
    });
  });
});

test("DocdexClient rejects immutable encrypted jobs without repo id before local initialization", {
  concurrency: false,
}, async () => {
  let fetchCalls = 0;
  await withStubbedFetch(() => {
    fetchCalls += 1;
    return makeErrorResponse(500, "should not call network");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    await assert.rejects(
      () => client.search("tenant policy"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "scope_denied");
        return true;
      },
    );
  });
  assert.equal(fetchCalls, 0);
});

test("DocdexClient requires immutable encrypted operation and capability contracts", {
  concurrency: false,
}, async () => {
  let fetchCalls = 0;
  await withStubbedFetch(() => {
    fetchCalls += 1;
    return makeErrorResponse(500, "should not call network");
  }, async () => {
    const missingAllowedOperations = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      capabilities: { search: true },
    });
    await assert.rejects(
      () => missingAllowedOperations.search("tenant policy"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "scope_denied");
        return true;
      },
    );

    const missingCapabilities = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
    });
    await assert.rejects(
      () => missingCapabilities.search("tenant policy"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "scope_denied");
        return true;
      },
    );
  });
  assert.equal(fetchCalls, 0);
});

test("DocdexClient blocks encrypted capability-disabled operations before network access", {
  concurrency: false,
}, async () => {
  let fetchCalls = 0;
  await withStubbedFetch(() => {
    fetchCalls += 1;
    return makeErrorResponse(500, "should not call network");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: false },
    });
    await assert.rejects(
      () => client.search("tenant policy"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "encrypted_operation_disabled");
        return true;
      },
    );
  });
  assert.equal(fetchCalls, 0);
});

test("DocdexClient retries invalid parser search queries with sanitized plain text", {
  concurrency: false,
}, async () => {
  const originalQuery =
    "marker:DOCDEX-LIVE-AUDIT-1777880062366 OR DOCDEX-LIVE-AUDIT-1777880062366";
  const retryQuery = "DOCDEX-LIVE-AUDIT-1777880062366 DOCDEX-LIVE-AUDIT-1777880062366";
  const seenQueries: string[] = [];
  await withStubbedFetch((url) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("q") ?? "";
      seenQueries.push(query);
      assert.equal(parsed.searchParams.get("repo_id"), "secure-repo");
      if (query === originalQuery) {
        return makeErrorResponse(
          400,
          '{"error":{"code":"invalid_query","message":"query parse failed: Field does not exist: marker"}}',
        );
      }
      assert.equal(query, retryQuery);
      return makeJsonResponse({
        results: [{ rel_path: "daily-logs/sample.md", snippet: "DOCDEX-LIVE-AUDIT-1777880062366" }],
        meta: { source: "retry" },
      });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    const result = await client.search(originalQuery, { limit: 2 });
    assert.deepEqual(seenQueries, [originalQuery, retryQuery]);
    assert.deepEqual(result, {
      results: [{ rel_path: "daily-logs/sample.md", snippet: "DOCDEX-LIVE-AUDIT-1777880062366" }],
      meta: {
        source: "retry",
        codali_query_retry: {
          reason: "invalid_query",
          original_query: originalQuery,
          retried_query: retryQuery,
        },
      },
    });
  });
});

test("DocdexClient posts chat context through the encrypted repo runtime envelope", {
  concurrency: false,
}, async () => {
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/chat/completions")) {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.["x-api-key"], "msw_docdex_secret");
      assert.equal(headers?.authorization, undefined);
      assert.equal(headers?.["x-docdex-repo-id"], "secure-repo");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      assert.equal(body.stream, false);
      assert.equal(body.model, "qwen3.5:35b");
      assert.equal(body.max_tokens, 512);
      assert.equal(body.messages[0]?.role, "user");
      return makeJsonResponse({
        choices: [{ message: { role: "assistant", content: "context ready" } }],
      });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      authToken: "legacy-bearer-token",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["chat_context"],
      capabilities: { chat_context: true },
    });
    const result = await client.chatContext(
      [{ role: "user", content: "Summarize project context." }],
      { model: "qwen3.5:35b", maxTokens: 512 },
    );
    assert.deepEqual(result, {
      choices: [{ message: { role: "assistant", content: "context ready" } }],
    });
  });
});

test("DocdexClient blocks disallowed encrypted repo operations before network access", {
  concurrency: false,
}, async () => {
  let fetchCalls = 0;
  await withStubbedFetch(() => {
    fetchCalls += 1;
    return makeErrorResponse(500, "should not call network");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    await assert.rejects(
      () => client.openSnippet("doc-1"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "encrypted_operation_disabled");
        return true;
      },
    );
  });
  assert.equal(fetchCalls, 0);
});

test("DocdexClient fails required attached-key jobs before network access when key is missing", {
  concurrency: false,
}, async () => {
  let fetchCalls = 0;
  await withStubbedFetch(() => {
    fetchCalls += 1;
    return makeErrorResponse(500, "should not call network");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
    });
    await assert.rejects(
      () => client.search("runtime context"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "missing_credentials");
        return true;
      },
    );
  });
  assert.equal(fetchCalls, 0);
});

test("DocdexClient maps and redacts encrypted repo auth failures", {
  concurrency: false,
}, async () => {
  await withStubbedFetch((url) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      return makeErrorResponse(
        401,
        '{"error":{"code":"invalid_credentials","message":"bad x-api-key msw_docdex_secret"}}',
      );
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoId: "secure-repo",
      apiKey: "msw_docdex_secret",
      credentialSource: "attached_mswarm_api_key",
      required: true,
      allowedOperations: ["search"],
      capabilities: { search: true },
    });
    await assert.rejects(
      () => client.search("runtime context"),
      (error: unknown) => {
        const runtimeError = error as { code?: string; message?: string };
        assert.equal(runtimeError.code, "missing_credentials");
        assert.ok(!String(runtimeError.message).includes("msw_docdex_secret"));
        assert.ok(String(runtimeError.message).includes("[redacted]"));
        return true;
      },
    );
  });
});

test("DocdexClient caches capability probe results", { concurrency: false }, async () => {
  let probeCalls = 0;
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; id?: string };
      if (payload.method === "docdex_capabilities") {
        probeCalls += 1;
        return makeJsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            retrieval: {
              score_breakdown: true,
              rerank: true,
              snippet_provenance: "available",
              retrieval_explanation: false,
              batch_search: "unknown",
            },
          },
        });
      }
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const first = await client.getCapabilities();
    const cached = await client.getCapabilities();
    const refreshed = await client.getCapabilities(true);

    assert.equal(first.cached, false);
    assert.equal(first.source, "mcp_probe");
    assert.equal(first.capabilities.score_breakdown, "available");
    assert.equal(first.capabilities.rerank, "available");
    assert.equal(first.capabilities.snippet_provenance, "available");
    assert.equal(first.capabilities.retrieval_explanation, "unavailable");
    assert.equal(first.capabilities.batch_search, "unknown");

    assert.equal(cached.cached, true);
    assert.equal(refreshed.cached, false);
    assert.equal(probeCalls, 2);
  });
});

test("DocdexClient capability probe falls back when MCP probe is unavailable", { concurrency: false }, async () => {
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; id?: string };
      if (payload.method === "docdex_capabilities") {
        return makeErrorResponse(404, "method not found");
      }
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const snapshot = await client.getCapabilities();

    assert.equal(snapshot.cached, false);
    assert.equal(snapshot.source, "fallback");
    assert.equal(snapshot.capabilities.score_breakdown, "unavailable");
    assert.equal(snapshot.capabilities.rerank, "unavailable");
    assert.equal(snapshot.capabilities.snippet_provenance, "unavailable");
    assert.equal(snapshot.capabilities.retrieval_explanation, "unavailable");
    assert.equal(snapshot.capabilities.batch_search, "unavailable");
    assert.ok((snapshot.warnings?.[0] ?? "").startsWith("probe_failed:"));
  });
});

test("DocdexClient falls back to HTTP search for web research when MCP fails", {
  concurrency: false,
}, async () => {
  const calls: string[] = [];
  await withStubbedFetch((url, init) => {
    calls.push(url);
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method === "docdex_web_research") {
        return makeErrorResponse(500, "mcp proxy timeout");
      }
      return makeJsonResponse({ jsonrpc: "2.0", result: { ok: true } });
    }
    if (url.endsWith("/v1/initialize")) {
      return makeJsonResponse({ repo_id: "repo-web", repo_root: process.cwd() });
    }
    if (url.startsWith("http://127.0.0.1:28491/search?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("q"), "codex cli local loop");
      assert.equal(parsed.searchParams.get("force_web"), "true");
      assert.equal(parsed.searchParams.get("max_web_results"), "1");
      assert.equal(parsed.searchParams.get("no_cache"), "true");
      assert.equal(parsed.searchParams.get("repo_id"), "repo-web");
      return makeJsonResponse({ results: [{ title: "Codex CLI" }] });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    const result = await client.webResearch("codex cli local loop", {
      forceWeb: true,
      webLimit: 1,
      noCache: true,
    });
    assert.deepEqual(result, { results: [{ title: "Codex CLI" }] });
  });

  assert.deepEqual(calls.map((url) => new URL(url).pathname), [
    "/healthz",
    "/v1/mcp",
    "/v1/initialize",
    "/search",
  ]);
});

test("DocdexClient forwards metadata for memorySave and savePreference", {
  concurrency: false,
}, async () => {
  const seenCalls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as {
        method?: string;
        id?: string;
        params?: Record<string, unknown>;
      };
      seenCalls.push({ method: payload.method, params: payload.params });
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({
      baseUrl: "http://127.0.0.1:28491",
      repoRoot: process.cwd(),
    });
    await client.memorySave("rule text", { lifecycle_state: "candidate", score: 0.7 });
    await client.savePreference("codali", "constraint", "Do not use moment.js", {
      dedupe_key: "profile_memory::constraint::do not use moment.js",
    });
  });

  const memoryCall = seenCalls.find((entry) => entry.method === "docdex_memory_save");
  const preferenceCall = seenCalls.find((entry) => entry.method === "docdex_save_preference");
  assert.equal(memoryCall?.params?.text, "rule text");
  assert.deepEqual(memoryCall?.params?.metadata, { lifecycle_state: "candidate", score: 0.7 });
  assert.equal(preferenceCall?.params?.agent_id, "codali");
  assert.equal(preferenceCall?.params?.category, "constraint");
  assert.equal(preferenceCall?.params?.content, "Do not use moment.js");
  assert.deepEqual(preferenceCall?.params?.metadata, {
    dedupe_key: "profile_memory::constraint::do not use moment.js",
  });
});
