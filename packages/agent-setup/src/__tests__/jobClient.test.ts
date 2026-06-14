import assert from "node:assert/strict";
import test from "node:test";
import { MswarmApi } from "@mcoda/core";
import { createMcodaGpuJobClient } from "../jobClient.js";

test("createMcodaGpuJobClient forwards defaults to core job methods", { concurrency: false }, async () => {
  const originalCreate = MswarmApi.create;
  const calls: Array<{ method: string; input: unknown }> = [];
  (MswarmApi as any).create = async (options: unknown) => {
    calls.push({ method: "create", input: options });
    return {
      async close() {
        calls.push({ method: "close", input: {} });
      },
      async listGpuCapabilities(input: unknown) {
        calls.push({ method: "listGpuCapabilities", input });
        return { generic_jobs_enabled: true };
      },
      async getGenericJob(input: unknown) {
        calls.push({ method: "getGenericJob", input });
        return { job: { state: "succeeded" }, events: [], logs: [], artifacts: [], audit: [] };
      },
      async getGenericJobOps(input: unknown) {
        calls.push({ method: "getGenericJobOps", input });
        return {
          schema_version: "2026-06-14",
          generated_at: "2026-06-14T00:00:00.000Z",
          node: { id: "shn_local" },
          capabilities: {},
          queue: { total: 1, states: { queued: 1 }, jobs: [] },
          quota: { active: [], production_enforced: false },
          usage: { jobs_total: 1, gpu_seconds_total: 0, artifact_bytes_total: 0, log_bytes_total: 0 },
          audit: { events: [], total: 0, limit: 1, offset: 0 }
        };
      },
      async runGenericJob(job: unknown, input: unknown) {
        calls.push({ method: "runGenericJob", input: { job, input } });
        return { job: { job_id: "job-gpu", state: "queued" }, events: [], logs: [], artifacts: [], audit: [] };
      },
      async retryGenericJob(input: unknown) {
        calls.push({ method: "retryGenericJob", input });
        return { job: { job_id: "job-gpu", state: "queued", retry_count: 1 }, events: [], logs: [], artifacts: [], audit: [] };
      },
      async getGenericJobEvents(input: unknown) {
        calls.push({ method: "getGenericJobEvents", input });
        return {
          job_id: "job-gpu",
          events: [
            { job_id: "job-gpu", type: "queued", sequence: 1, timestamp: "2026-06-14T00:00:00.000Z" }
          ]
        };
      }
    };
  };
  try {
    const client = await createMcodaGpuJobClient({
      baseUrl: "https://api.mswarm.test",
      apiKey: "owner-key",
      nodeBaseUrl: "http://127.0.0.1:18488",
      nodeId: "shn_local",
      signingSecret: "secret"
    });
    await client.listGpus();
    await client.ops({ auditLimit: 1 });
    await client.status({ jobId: "job-gpu", requestId: "req-gpu", jobType: "cuda.run", schemaVersion: "2026-06-14" });
    await client.jobs.create(
      {
        schema_version: "2026-06-14",
        job_type: "cuda.run",
        policy: { trust_mode: "owner-local", network: "none", allow_raw_command: false }
      },
      { jobId: "job-gpu", requestId: "req-gpu" }
    );
    const events = [];
    for await (const event of client.jobs.events("job-gpu", {
      requestId: "req-gpu",
      jobType: "cuda.run",
        schemaVersion: "2026-06-14",
        intervalMs: 1
      })) {
      events.push(event);
    }
    await client.jobs.retry({ jobId: "job-gpu", requestId: "req-gpu", jobType: "cuda.run", schemaVersion: "2026-06-14" });
    await client.close();

    assert.deepEqual(calls[0], {
      method: "create",
      input: { baseUrl: "https://api.mswarm.test", apiKey: "owner-key", timeoutMs: undefined }
    });
    assert.deepEqual(calls[1], {
      method: "listGpuCapabilities",
      input: {
        nodeBaseUrl: "http://127.0.0.1:18488",
        nodeId: "shn_local",
        signingSecret: "secret",
        token: undefined,
        tokenTtlSeconds: undefined
      }
    });
    assert.equal(calls[2].method, "getGenericJobOps");
    assert.equal((calls[2].input as Record<string, unknown>).auditLimit, 1);
    assert.equal((calls[2].input as Record<string, unknown>).nodeId, "shn_local");
    assert.equal(calls[3].method, "getGenericJob");
    assert.equal((calls[3].input as Record<string, unknown>).jobId, "job-gpu");
    assert.equal((calls[3].input as Record<string, unknown>).nodeId, "shn_local");
    assert.equal(calls[4].method, "runGenericJob");
    assert.equal(((calls[4].input as any).job as Record<string, unknown>).job_id, "job-gpu");
    assert.equal(((calls[4].input as any).job as Record<string, unknown>).node_id, "shn_local");
    assert.equal(calls[5].method, "getGenericJobEvents");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "queued");
    assert.equal(calls.at(-2)?.method, "retryGenericJob");
    assert.equal(calls.at(-1)?.method, "close");
  } finally {
    (MswarmApi as any).create = originalCreate;
  }
});
