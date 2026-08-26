import assert from "node:assert/strict";
import test from "node:test";
import { startCodaliServer, type CodaliServerPrincipal } from "../CodaliServer.js";
import type { CodaliRequest, CodaliResult } from "../CodaliApi.js";

const okResult = (): CodaliResult => ({
  status: "succeeded",
  answer: "answered",
  output: "answered",
  sources: [],
  artifacts: [],
  warnings: [],
  traceId: "trace-1",
  toolCalls: [],
});

const principals: Record<string, CodaliServerPrincipal> = {
  "key-a": {
    tenant: { id: "tenant-a", slug: "acme" },
    runContext: { allowedTools: ["mcp:acme:search"] },
  },
  "key-b": {
    tenant: { id: "tenant-b", slug: "globex" },
    runContext: { allowedTools: ["mcp:globex:search"] },
  },
};

const withServer = async (
  handler: (base: string, seen: CodaliRequest[]) => Promise<void>,
): Promise<void> => {
  const seen: CodaliRequest[] = [];
  const { server, port } = await startCodaliServer({
    port: 0,
    authenticate: async (apiKey) => (apiKey ? principals[apiKey] : undefined),
    run: async (request) => {
      seen.push(request);
      return okResult();
    },
  });
  try {
    await handler(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("health needs no authentication", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
  });
});

test("an unauthenticated request is rejected", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/codali/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 401);
  });
});

test("an unknown API key is rejected", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/codali/run`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-key", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 401);
  });
});

test("tenant comes from the authenticated caller", async () => {
  await withServer(async (base, seen) => {
    await fetch(`${base}/v1/codali/run`, {
      method: "POST",
      headers: { Authorization: "Bearer key-a", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(seen[0]?.runContext?.tenant?.id, "tenant-a");
    assert.deepEqual(seen[0]?.runContext?.allowedTools, ["mcp:acme:search"]);
  });
});

test("a caller cannot impersonate another tenant through the request body", async () => {
  // A tenant id in a body field is an assertion by an untrusted party.
  // Honouring it would let any caller read another tenant's tools by editing
  // one JSON value.
  await withServer(async (base, seen) => {
    await fetch(`${base}/v1/codali/run`, {
      method: "POST",
      headers: { Authorization: "Bearer key-a", "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        runContext: {
          tenant: { id: "tenant-b", slug: "globex" },
          allowedTools: ["mcp:globex:search"],
        },
      }),
    });

    assert.equal(seen[0]?.runContext?.tenant?.id, "tenant-a", "tenant must not be spoofable");
    assert.deepEqual(
      seen[0]?.runContext?.allowedTools,
      ["mcp:acme:search"],
      "another tenant's tools must not be reachable",
    );
  });
});

test("a caller cannot impersonate another tenant through the chat endpoint either", async () => {
  await withServer(async (base, seen) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer key-b", "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        codali: { runContext: { tenant: { id: "tenant-a" }, allowedTools: ["mcp:acme:search"] } },
      }),
    });
    assert.equal(seen[0]?.runContext?.tenant?.id, "tenant-b");
    assert.deepEqual(seen[0]?.runContext?.allowedTools, ["mcp:globex:search"]);
  });
});

test("the chat endpoint returns an OpenAI-shaped response carrying Codali provenance", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer key-a", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codali", messages: [{ role: "user", content: "hi" }] }),
    });
    const payload = await response.json();

    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "answered");
    assert.equal(payload.choices[0].finish_reason, "stop");
    // Provenance is what makes an orchestrated answer trustworthy; the adapter
    // must not discard it to fit the OpenAI shape.
    assert.equal(payload.codali.status, "succeeded");
    assert.equal(payload.codali.traceId, "trace-1");
    assert.ok(Array.isArray(payload.codali.sources));
  });
});

test("a malformed body is rejected before any run starts", async () => {
  await withServer(async (base, seen) => {
    const response = await fetch(`${base}/v1/codali/run`, {
      method: "POST",
      headers: { Authorization: "Bearer key-a", "Content-Type": "application/json" },
      body: "not json",
    });
    assert.equal(response.status, 400);
    assert.equal(seen.length, 0);
  });
});

test("an unknown path is a 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/nope`, {
      method: "POST",
      headers: { Authorization: "Bearer key-a", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  });
});
