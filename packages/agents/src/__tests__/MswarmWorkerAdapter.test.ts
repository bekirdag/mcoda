import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { MswarmWorkerAdapter } from "../adapters/mswarm/MswarmWorkerAdapter.js";
import type { Agent } from "@mcoda/shared";

const originalFetch = global.fetch;

const agent: Agent = {
  id: "agent-worker",
  slug: "mswarm-worker-client-intake",
  adapter: "mswarm-worker",
  createdAt: "now",
  updatedAt: "now",
  config: {
    mswarmWorker: {
      managed: true,
      remoteSlug: "worker_client_intake",
      workerId: "worker_client_intake",
      provider: "mswarm",
      modelId: "mswarm-worker:worker_client_intake",
      catalogBaseUrl: "https://api.mswarm.test",
      apiRunUrl: "https://api.mswarm.test/v1/swarm/workers/worker_client_intake/run",
      worker: {
        enabled: true,
      },
      syncedAt: "2026-05-07T08:00:00.000Z",
    },
  },
};

afterEach(() => {
  global.fetch = originalFetch;
});

test("MswarmWorkerAdapter healthCheck is metadata-only and does not call the Worker", async () => {
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("health check must not execute worker");
  };

  const adapter = new MswarmWorkerAdapter({
    agent,
    capabilities: ["mswarm-worker"],
    apiKey: "worker-api-key",
  });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "healthy");
  assert.equal((health.details as any)?.reason, "catalog_metadata_only");
  assert.equal(fetchCalls, 0);
});

test("MswarmWorkerAdapter invokes the Worker run URL with auth and idempotency headers", async () => {
  global.fetch = async (input: any, init?: any) => {
    assert.equal(String(input), "https://api.mswarm.test/v1/swarm/workers/worker_client_intake/run");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "worker-api-key");
    assert.equal(headers["idempotency-key"], "worker-run-1");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.text, "summarize this payload");
    assert.equal(body.input, "summarize this payload");
    assert.equal(body.metadata.runId, "worker-run-1");
    return new Response(
      JSON.stringify({
        run_id: "worker-run-1",
        result: { output: "{\"ok\":true}" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const adapter = new MswarmWorkerAdapter({
    agent,
    capabilities: ["mswarm-worker"],
    apiKey: "worker-api-key",
  });
  const result = await adapter.invoke({
    input: "summarize this payload",
    metadata: { runId: "worker-run-1" },
  });
  assert.equal(result.output, "{\"ok\":true}");
  assert.equal(result.adapter, "mswarm-worker");
  assert.equal((result.metadata as any)?.mswarmWorker?.remoteSlug, "worker_client_intake");
});
