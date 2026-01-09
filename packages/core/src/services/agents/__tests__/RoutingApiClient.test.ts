import test from "node:test";
import assert from "node:assert/strict";
import { RoutingApiClient } from "../generated/RoutingApiClient.js";

test("RoutingApiClient.create throws without base url", { concurrency: false }, () => {
  const originalBase = process.env.MCODA_API_BASE_URL;
  const originalRouting = process.env.MCODA_ROUTING_API_URL;
  try {
    delete process.env.MCODA_API_BASE_URL;
    delete process.env.MCODA_ROUTING_API_URL;
    assert.throws(() => RoutingApiClient.create(), /MCODA_API_BASE_URL/);
  } finally {
    if (originalBase === undefined) {
      delete process.env.MCODA_API_BASE_URL;
    } else {
      process.env.MCODA_API_BASE_URL = originalBase;
    }
    if (originalRouting === undefined) {
      delete process.env.MCODA_ROUTING_API_URL;
    } else {
      process.env.MCODA_ROUTING_API_URL = originalRouting;
    }
  }
});

test("RoutingApiClient handles 404 defaults and encodes workspace id", { concurrency: false }, async () => {
  const originalBase = process.env.MCODA_API_BASE_URL;
  const originalFetch = globalThis.fetch;
  let seenUrl: string | undefined;
  try {
    process.env.MCODA_API_BASE_URL = "https://api.example.com";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seenUrl = input.toString();
      return new Response("", { status: 404 });
    };

    const client = RoutingApiClient.create();
    const result = await client.getWorkspaceDefaults("ws/1");
    assert.equal(result, undefined);
    assert.ok(seenUrl?.endsWith("/workspaces/ws%2F1/defaults"));
  } finally {
    if (originalBase === undefined) {
      delete process.env.MCODA_API_BASE_URL;
    } else {
      process.env.MCODA_API_BASE_URL = originalBase;
    }
    globalThis.fetch = originalFetch;
  }
});

test("RoutingApiClient updateWorkspaceDefaults posts JSON body", { concurrency: false }, async () => {
  const originalBase = process.env.MCODA_API_BASE_URL;
  const originalFetch = globalThis.fetch;
  let seenMethod: string | undefined;
  let seenBody: any;
  try {
    process.env.MCODA_API_BASE_URL = "https://api.example.com";
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method;
      seenBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify([{ workspaceId: "ws", commandName: "default", agentId: "a1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = RoutingApiClient.create();
    const result = await client.updateWorkspaceDefaults("ws", { set: { default: "agent" } });
    assert.equal(seenMethod, "PUT");
    assert.equal(seenBody.set.default, "agent");
    assert.ok(result?.length);
  } finally {
    if (originalBase === undefined) {
      delete process.env.MCODA_API_BASE_URL;
    } else {
      process.env.MCODA_API_BASE_URL = originalBase;
    }
    globalThis.fetch = originalFetch;
  }
});

test("RoutingApiClient preview posts request and parses response", { concurrency: false }, async () => {
  const originalBase = process.env.MCODA_API_BASE_URL;
  const originalFetch = globalThis.fetch;
  let seenBody: any;
  try {
    process.env.MCODA_API_BASE_URL = "https://api.example.com";
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          workspaceId: "ws",
          commandName: "work-on-tasks",
          provenance: "global_default",
          resolvedAgent: { id: "a1", slug: "agent", adapter: "local-model", createdAt: "t", updatedAt: "t" },
          candidates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = RoutingApiClient.create();
    const result = await client.preview({ workspaceId: "ws", commandName: "work-on-tasks" });
    assert.equal(seenBody.commandName, "work-on-tasks");
    assert.equal(result?.provenance, "global_default");
  } finally {
    if (originalBase === undefined) {
      delete process.env.MCODA_API_BASE_URL;
    } else {
      process.env.MCODA_API_BASE_URL = originalBase;
    }
    globalThis.fetch = originalFetch;
  }
});
