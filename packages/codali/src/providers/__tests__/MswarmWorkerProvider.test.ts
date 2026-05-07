import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { MswarmWorkerProvider } from "../MswarmWorkerProvider.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test("MswarmWorkerProvider invokes the Worker run URL as a provider boundary", { concurrency: false }, async () => {
  global.fetch = async (input: any, init?: any) => {
    assert.equal(String(input), "https://api.mswarm.test/v1/swarm/workers/worker_123/run");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], "worker-key");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.model, "mswarm-worker:worker_123");
    assert.match(body.text, /SYSTEM: Follow instructions/);
    assert.match(body.text, /USER: Summarize this/);
    return new Response(
      JSON.stringify({
        run_id: "worker-run-1",
        result: { output: "{\"summary\":\"done\"}" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const provider = new MswarmWorkerProvider({
    model: "mswarm-worker:worker_123",
    baseUrl: "https://api.mswarm.test/v1/swarm/workers/worker_123/run",
    apiKey: "worker-key",
  });
  const result = await provider.generate({
    messages: [
      { role: "system", content: "Follow instructions" },
      { role: "user", content: "Summarize this" },
    ],
  });
  assert.equal(result.message.content, "{\"summary\":\"done\"}");
});
