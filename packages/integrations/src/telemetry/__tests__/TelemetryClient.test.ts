import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TelemetryClient } from "../TelemetryClient.js";

describe("TelemetryClient", () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url?: string; method?: string; body?: string | null } = {};

  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      lastRequest = { url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : null };
      return {
        ok: true,
        status: 200,
        json: async () => ([]),
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds summary query parameters", async () => {
    const client = new TelemetryClient({ baseUrl: "https://telemetry.test" });
    await client.getSummary({ workspaceId: "ws", projectId: "proj", groupBy: ["day"] });
    assert.ok(lastRequest.url?.includes("/telemetry/summary"));
    assert.ok(lastRequest.url?.includes("workspace_id=ws"));
    assert.ok(lastRequest.url?.includes("project_id=proj"));
    assert.ok(lastRequest.url?.includes("group_by=day"));
  });

  it("posts opt-out payload", async () => {
    const client = new TelemetryClient({ baseUrl: "https://telemetry.test" });
    await client.optOut("ws-1", true);
    assert.ok(lastRequest.url?.includes("/telemetry/opt-out"));
    assert.equal(lastRequest.method, "POST");
    assert.equal(lastRequest.body, JSON.stringify({ workspace_id: "ws-1", strict: true }));
  });
});
