import assert from "node:assert/strict";
import test from "node:test";
import { createMcodaAgentSetupClient } from "../client.js";

test("HTTP client sends expected mswarm key request shape", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const client = createMcodaAgentSetupClient({
    baseUrl: "/api/mcoda/",
    getAuthHeaders: { authorization: "Bearer test" },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return { ok: true };
        },
        async text() {
          return "";
        },
      };
    },
  });
  await client.configureMswarmApiKey({
    apiKey: "sk_test_1234",
    connection: {
      tenantId: "tenant-bdya",
      productSlug: "bdya",
      ownerUserId: "user-bekir",
      featureKey: "okacam-badges",
      validationMode: "required",
    },
    reasonCode: "configure",
  });
  assert.equal(calls[0].url, "/api/mcoda/mswarm-api-key");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    mswarm_api_key: "sk_test_1234",
    connection: {
      tenantId: "tenant-bdya",
      productSlug: "bdya",
      ownerUserId: "user-bekir",
      featureKey: "okacam-badges",
      validationMode: "required",
    },
    reason_code: "configure",
  });
});

test("HTTP client surfaces JSON error messages", async () => {
  const client = createMcodaAgentSetupClient({
    baseUrl: "/api/mcoda",
    fetch: async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      async json() {
        return { error: "invalid stage" };
      },
      async text() {
        return "";
      },
    }),
  });
  await assert.rejects(() => client.fetchSnapshot(), /invalid stage/);
});
