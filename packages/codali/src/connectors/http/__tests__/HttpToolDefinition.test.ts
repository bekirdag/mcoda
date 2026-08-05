import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResponseSelector,
  buildHttpUrl,
  httpConnectorToDefinitions,
  httpToolToDefinition,
  type HttpConnectorDefinition,
} from "../HttpToolDefinition.js";

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  }) as unknown as Response;

const connector = (
  overrides: Partial<HttpConnectorDefinition> = {},
): HttpConnectorDefinition => ({
  name: "jira",
  baseUrl: "https://acme.atlassian.net",
  tools: [
    {
      id: "get_issue",
      description: "Fetch one issue by key.",
      method: "GET",
      urlTemplate: "/rest/api/3/issue/{issueKey}",
      inputSchema: {
        type: "object",
        required: ["issueKey"],
        properties: { issueKey: { type: "string" } },
      },
    },
  ],
  ...overrides,
});

test("path placeholders are substituted and leftovers become query params", () => {
  const url = buildHttpUrl(
    "https://acme.atlassian.net",
    "/rest/api/3/issue/{issueKey}",
    { issueKey: "ENG-1", expand: "changelog" },
  );
  assert.equal(
    url,
    "https://acme.atlassian.net/rest/api/3/issue/ENG-1?expand=changelog",
  );
});

test("a model cannot escape the base URL through a path parameter", () => {
  // Placeholder values are URL-encoded, so "../../admin" cannot traverse.
  const url = buildHttpUrl("https://acme.example/api/", "/issue/{key}", {
    key: "../../admin",
  });
  assert.ok(url.startsWith("https://acme.example/api/issue/"));
  assert.ok(!url.includes("/admin"));
});

test("a missing path parameter is a validation error, not a malformed URL", () => {
  assert.throws(
    () => buildHttpUrl("https://x.example", "/issue/{key}", {}),
    /Missing required path parameter "key"/,
  );
});

test("a mutating method is rejected at declaration time", () => {
  // Write access is a separate decision with its own approval story, not a
  // config flag a connector can set.
  assert.throws(
    () =>
      httpToolToDefinition(
        {
          id: "delete_issue",
          description: "Delete",
          method: "DELETE" as never,
          urlTemplate: "/x",
        },
        { connector: connector() },
      ),
    /only GET and HEAD are permitted/,
  );
});

test("response selectors project a payload down before a model sees it", () => {
  const payload = { issues: [{ fields: { summary: "a" } }, { fields: { summary: "b" } }] };
  assert.deepEqual(
    applyResponseSelector(payload, "issues[].fields.summary"),
    ["a", "b"],
  );
});

test("a plain dotted selector drills in", () => {
  assert.equal(applyResponseSelector({ a: { b: { c: 7 } } }, "a.b.c"), 7);
});

test("a selector that matches nothing yields undefined rather than throwing", () => {
  assert.equal(applyResponseSelector({ a: 1 }, "x.y.z"), undefined);
});

test("a successful call returns the projected response", async () => {
  const definition = httpToolToDefinition(connector().tools[0]!, {
    connector: connector(),
    fetchImpl: async () => jsonResponse({ fields: { summary: "Fix the thing" } }),
  });
  const result = await definition.handler({ issueKey: "ENG-1" }, { workspaceRoot: "/tmp" });
  assert.match(result.output, /Fix the thing/);
});

test("bearer auth is sent as a header, never in the URL", async () => {
  let seenHeaders: Record<string, string> = {};
  const definition = httpToolToDefinition(connector().tools[0]!, {
    connector: connector({ auth: { type: "bearer", token: "secret-token" } }),
    fetchImpl: async (url, init) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      assert.ok(!String(url).includes("secret-token"));
      return jsonResponse({});
    },
  });
  await definition.handler({ issueKey: "ENG-1" }, { workspaceRoot: "/tmp" });
  assert.equal(seenHeaders.Authorization, "Bearer secret-token");
});

test("basic auth is base64 encoded", async () => {
  let auth = "";
  const definition = httpToolToDefinition(connector().tools[0]!, {
    connector: connector({
      auth: { type: "basic", username: "user", password: "pass" },
    }),
    fetchImpl: async (_url, init) => {
      auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      return jsonResponse({});
    },
  });
  await definition.handler({ issueKey: "ENG-1" }, { workspaceRoot: "/tmp" });
  assert.equal(auth, `Basic ${Buffer.from("user:pass").toString("base64")}`);
});

test("an auth failure is reported as permission denied, without the body", async () => {
  // The body may carry a credential or an internal hostname, so only the status
  // is forwarded.
  const definition = httpToolToDefinition(connector().tools[0]!, {
    connector: connector(),
    fetchImpl: async () => jsonResponse({ secret: "leaked" }, 403),
  });
  await assert.rejects(
    () => definition.handler({ issueKey: "ENG-1" }, { workspaceRoot: "/tmp" }),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /HTTP 403/);
      assert.ok(!message.includes("leaked"));
      return true;
    },
  );
});

test("a 5xx is retryable and a 4xx is not", async () => {
  const build = (status: number) =>
    httpToolToDefinition(connector().tools[0]!, {
      connector: connector(),
      fetchImpl: async () => jsonResponse({}, status),
    });

  await assert.rejects(
    () => build(503).handler({ issueKey: "X" }, { workspaceRoot: "/tmp" }),
    (error: unknown) => (error as { retryable?: boolean }).retryable === true,
  );
  await assert.rejects(
    () => build(404).handler({ issueKey: "X" }, { workspaceRoot: "/tmp" }),
    (error: unknown) => (error as { retryable?: boolean }).retryable === false,
  );
});

test("oversized responses are truncated before reaching a model", async () => {
  const definition = httpToolToDefinition(
    { ...connector().tools[0]!, maxResponseChars: 100 },
    { connector: connector(), fetchImpl: async () => jsonResponse({ blob: "x".repeat(5_000) }) },
  );
  const result = await definition.handler({ issueKey: "X" }, { workspaceRoot: "/tmp" });
  assert.ok(result.output.length < 400);
  // The notice must be loud enough that the model reports incompleteness
  // rather than presenting a partial result as whole.
  assert.match(result.output, /TRUNCATED/);
  assert.match(result.output, /INCOMPLETE/);
});

test("connector tools are namespaced and marked read-only", () => {
  const definitions = httpConnectorToDefinitions({ connector: connector() });
  assert.equal(definitions[0]?.name, "http:jira:get_issue");
  assert.equal(definitions[0]?.readOnly, true);
  assert.equal(definitions[0]?.capability, "jira");
});

test("a disabled connector contributes nothing", () => {
  assert.deepEqual(
    httpConnectorToDefinitions({ connector: connector({ enabled: false }) }),
    [],
  );
});
