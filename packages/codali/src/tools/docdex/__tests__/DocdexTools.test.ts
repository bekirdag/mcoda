import test from "node:test";
import assert from "node:assert/strict";
import { DocdexClient } from "../../../docdex/DocdexClient.js";
import { createDocdexTools } from "../DocdexTools.js";

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (key: string) => string | null };
};

type FetchHandler = (url: string, init?: RequestInit) => StubResponse;

const makeJsonResponse = (payload: unknown): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  headers: { get: () => "application/json" },
});

const makeTextResponse = (body: string): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => body,
  headers: { get: () => "text/plain" },
});

const makeErrorResponse = (status: number, body: string): StubResponse => ({
  ok: false,
  status,
  json: async () => ({ error: body }),
  text: async () => body,
  headers: { get: () => "text/plain" },
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

test("DocdexTools call health and search", { concurrency: false }, async () => {
  await withStubbedFetch((url) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.includes("/search")) {
      return makeJsonResponse({ hits: [{ doc_id: "doc-1", snippet: "Hello" }] });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd() });
    const tools = createDocdexTools(client);
    const searchTool = tools.find((tool) => tool.name === "docdex_search");
    assert.ok(searchTool);

    const result = await searchTool!.handler({ query: "hello" }, { workspaceRoot: process.cwd() });
    assert.match(result.output, /doc-1/);
  });
});

test("DocdexTools use MCP for symbols", { concurrency: false }, async () => {
  let lastMcpMethod: string | undefined;
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; id?: string };
      lastMcpMethod = payload.method;
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd() });
    const tools = createDocdexTools(client);
    const symbolsTool = tools.find((tool) => tool.name === "docdex_symbols");
    assert.ok(symbolsTool);

    const result = await symbolsTool!.handler({ path: "src/index.ts" }, { workspaceRoot: process.cwd() });
    assert.match(result.output, /"ok": true/);
    assert.equal(lastMcpMethod, "docdex_symbols");
  });
});

test("DocdexClient hits new HTTP endpoints", { concurrency: false }, async () => {
  const calls: string[] = [];
  await withStubbedFetch((url) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    calls.push(url);
    if (url.includes("/v1/graph/impact/diagnostics")) {
      return makeJsonResponse({ ok: true });
    }
    if (url.endsWith("/v1/index/rebuild")) {
      return makeJsonResponse({ ok: true });
    }
    if (url.endsWith("/v1/index/ingest")) {
      return makeJsonResponse({ ok: true });
    }
    if (url.endsWith("/v1/hooks/validate")) {
      return makeJsonResponse({ ok: true });
    }
    if (url.endsWith("/v1/delegate")) {
      return makeJsonResponse({ ok: true });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd() });
    await client.impactDiagnostics({ file: "src/index.ts", limit: 1 });
    await client.indexRebuild();
    await client.indexIngest("src/index.ts");
    await client.hooksValidate(["src/index.ts"]);
    await client.delegate({ task_type: "format_code", instruction: "x", context: "y" });
  });

  assert.ok(calls.some((url) => url.includes("/v1/graph/impact/diagnostics")));
  assert.ok(calls.some((url) => url.endsWith("/v1/index/rebuild")));
  assert.ok(calls.some((url) => url.endsWith("/v1/index/ingest")));
  assert.ok(calls.some((url) => url.endsWith("/v1/hooks/validate")));
  assert.ok(calls.some((url) => url.endsWith("/v1/delegate")));
});

test("DocdexClient uses MCP for tree/open/profile/web", { concurrency: false }, async () => {
  const seen: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; params?: Record<string, unknown>; id?: string };
      seen.push({ method: payload.method, params: payload.params });
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd() });
    await client.tree({ path: "src", maxDepth: 2 });
    await client.openFile("README.md", { head: 5, clamp: true });
    await client.getProfile("agent-1");
    await client.savePreference("agent-1", "constraint", "Use date-fns");
    await client.webResearch("docdex web search", { forceWeb: true, webLimit: 2 });
  });

  const methods = seen.map((entry) => entry.method);
  assert.ok(methods.includes("docdex_tree"));
  assert.ok(methods.includes("docdex_open"));
  assert.ok(methods.includes("docdex_get_profile"));
  assert.ok(methods.includes("docdex_save_preference"));
  assert.ok(methods.includes("docdex_web_research"));

  const treeCall = seen.find((entry) => entry.method === "docdex_tree");
  assert.equal(treeCall?.params?.project_root, process.cwd());
  const openCall = seen.find((entry) => entry.method === "docdex_open");
  assert.equal(openCall?.params?.path, "README.md");
  const profileCall = seen.find((entry) => entry.method === "docdex_get_profile");
  assert.ok(profileCall?.params && !("project_root" in profileCall.params));
  const webCall = seen.find((entry) => entry.method === "docdex_web_research");
  assert.equal(webCall?.params?.project_root, process.cwd());
});

test("DocdexTools expose expanded docdex toolset", { concurrency: false }, async () => {
  const calls: string[] = [];
  const mcpMethods: string[] = [];
  await withStubbedFetch((url, init) => {
    if (url.endsWith("/healthz")) {
      return makeTextResponse("ok");
    }
    if (url.endsWith("/v1/mcp")) {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as { method?: string; params?: Record<string, unknown>; id?: string };
      if (payload.method) mcpMethods.push(payload.method);
      return makeJsonResponse({ jsonrpc: "2.0", id: payload.id, result: { ok: true } });
    }
    calls.push(url);
    if (url.includes("/v1/graph/impact/diagnostics")) return makeJsonResponse({ ok: true });
    if (url.endsWith("/v1/index/rebuild")) return makeJsonResponse({ ok: true });
    if (url.endsWith("/v1/index/ingest")) return makeJsonResponse({ ok: true });
    if (url.endsWith("/v1/hooks/validate")) return makeJsonResponse({ ok: true });
    if (url.endsWith("/v1/delegate")) return makeJsonResponse({ ok: true });
    return makeErrorResponse(404, "not found");
  }, async () => {
    const client = new DocdexClient({ baseUrl: "http://127.0.0.1:28491", repoRoot: process.cwd() });
    const tools = createDocdexTools(client);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get("docdex_impact_diagnostics")?.handler({ file: "src/index.ts" }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_tree")?.handler({ path: "src" }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_open_file")?.handler({ path: "README.md", head: 5 }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_get_profile")?.handler({ agentId: "agent-1" }, { workspaceRoot: process.cwd() });
    await byName
      .get("docdex_save_preference")
      ?.handler({ agentId: "agent-1", category: "constraint", content: "Use date-fns" }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_web_research")?.handler({ query: "docdex web", webLimit: 1 }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_index_rebuild")?.handler({}, { workspaceRoot: process.cwd() });
    await byName.get("docdex_index_ingest")?.handler({ file: "src/index.ts" }, { workspaceRoot: process.cwd() });
    await byName
      .get("docdex_delegate")
      ?.handler({ taskType: "format_code", instruction: "x", context: "y" }, { workspaceRoot: process.cwd() });
    await byName.get("docdex_hooks_validate")?.handler({ files: ["src/index.ts"] }, { workspaceRoot: process.cwd() });
  });

  assert.ok(mcpMethods.includes("docdex_tree"));
  assert.ok(mcpMethods.includes("docdex_open"));
  assert.ok(mcpMethods.includes("docdex_get_profile"));
  assert.ok(mcpMethods.includes("docdex_save_preference"));
  assert.ok(mcpMethods.includes("docdex_web_research"));
  assert.ok(calls.some((url) => url.includes("/v1/graph/impact/diagnostics")));
  assert.ok(calls.some((url) => url.endsWith("/v1/index/rebuild")));
  assert.ok(calls.some((url) => url.endsWith("/v1/index/ingest")));
  assert.ok(calls.some((url) => url.endsWith("/v1/hooks/validate")));
  assert.ok(calls.some((url) => url.endsWith("/v1/delegate")));
});
