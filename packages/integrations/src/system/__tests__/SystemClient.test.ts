import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SystemClient } from "../SystemClient.js";

describe("SystemClient", () => {
  const originalFetch = globalThis.fetch;
  let lastRequest: { url?: string; method?: string; body?: string | null } = {};

  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      lastRequest = { url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : null };
      return {
        ok: true,
        status: 200,
        json: async () => ({ currentVersion: "0.1.8", latestVersion: "0.1.8", channel: "stable", updateAvailable: true }),
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds update check URL with channel", async () => {
    const client = new SystemClient("https://api.test");
    await client.checkUpdate("beta");
    assert.ok(lastRequest.url?.includes("/system/update"));
    assert.ok(lastRequest.url?.includes("channel=beta"));
    assert.equal(lastRequest.method, "GET");
  });

  it("posts update apply payload", async () => {
    const client = new SystemClient("https://api.test");
    await client.applyUpdate({ channel: "nightly" });
    assert.ok(lastRequest.url?.includes("/system/update"));
    assert.equal(lastRequest.method, "POST");
    assert.equal(lastRequest.body, JSON.stringify({ channel: "nightly" }));
  });
});
