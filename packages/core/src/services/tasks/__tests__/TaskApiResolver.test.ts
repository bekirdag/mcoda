import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TaskApiResolver } from "../TaskApiResolver.js";

describe("TaskApiResolver", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      if (url.searchParams.get("key") === "task-1") {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "task-id-1" }],
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined when no base url is configured", async () => {
    const resolver = new TaskApiResolver();
    const result = await resolver.resolveTaskId("task-1");
    assert.equal(result, undefined);
  });

  it("resolves task id from API response", async () => {
    const resolver = new TaskApiResolver("https://api.test");
    const result = await resolver.resolveTaskId("task-1");
    assert.equal(result, "task-id-1");
  });
});
