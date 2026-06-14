import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MswarmApi } from "@mcoda/core";
import { GpuCommands, GpuJobCommands } from "../commands/gpu/GpuCommands.js";

const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
};

test("GpuCommands list reads owner-local capability projection", { concurrency: false }, async () => {
  const originalCreate = MswarmApi.create;
  (MswarmApi as any).create = async (options: unknown) => ({
    async close() {},
    async listGpuCapabilities(input: unknown) {
      assert.deepEqual(options, {
        baseUrl: "http://127.0.0.1:18488",
        apiKey: undefined,
        timeoutMs: undefined
      });
      assert.deepEqual(input, {
        nodeBaseUrl: "http://127.0.0.1:18488",
        token: undefined,
        signingSecret: "secret",
        tokenTtlSeconds: undefined,
        nodeId: "shn_local"
      });
      return {
        generic_jobs_enabled: true,
        job_types: ["cuda.run"],
        accelerators: { gpu: { available: true, count: 1 } }
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuCommands.run([
        "list",
        "--node-base-url",
        "http://127.0.0.1:18488",
        "--node-id",
        "shn_local",
        "--signing-secret",
        "secret",
        "--json"
      ])
    );
    const payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    assert.equal(payload.generic_jobs_enabled, true);
  } finally {
    (MswarmApi as any).create = originalCreate;
  }
});

test("GpuCommands ops reads owner-local job operations summary", { concurrency: false }, async () => {
  const originalCreate = MswarmApi.create;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async getGenericJobOps(input: unknown) {
      assert.deepEqual(input, {
        nodeBaseUrl: "http://127.0.0.1:18488",
        token: undefined,
        signingSecret: "secret",
        tokenTtlSeconds: undefined,
        nodeId: "shn_local",
        auditLimit: 2,
        auditOffset: 0
      });
      return {
        node: { node_id: "shn_local", generic_jobs_enabled: true },
        queue: { active_jobs: 0, queued_jobs: 1, terminal_jobs: 0, jobs: [] },
        quota: { available_slots: 1, max_concurrent_jobs: 1, production_enforced: false },
        usage: {
          total_jobs: 1,
          succeeded_jobs: 0,
          failed_jobs: 0,
          cancelled_jobs: 0,
          blocked_jobs: 0,
          gpu_seconds: 0
        },
        audit: { offset: 0, limit: 2, total: 0, events: [] }
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuCommands.run([
        "ops",
        "--node-base-url",
        "http://127.0.0.1:18488",
        "--node-id",
        "shn_local",
        "--signing-secret",
        "secret",
        "--audit-limit",
        "2",
        "--audit-offset",
        "0"
      ])
    );
    assert.match(logs.join("\n"), /queue active=0 queued=1 terminal=0/);
  } finally {
    (MswarmApi as any).create = originalCreate;
  }
});

test("GpuJobCommands runs job envelopes from JSON files", { concurrency: false }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gpu-cli-"));
  const jobFile = path.join(tempDir, "job.json");
  await fs.writeFile(
    jobFile,
    JSON.stringify({
      job_id: "job-gpu",
      request_id: "req-gpu",
      node_id: "shn_local",
      job: {
        schema_version: "2026-06-14",
        job_type: "cuda.run",
        args: { manifest_path: "mcoda-job.json", profile: "nvcc-default", target: "vector-add" },
        policy: { trust_mode: "owner-local", network: "none", allow_raw_command: false }
      }
    }),
    "utf8"
  );
  const originalCreate = MswarmApi.create;
  let capturedJob: unknown;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async runGenericJob(job: unknown, auth: unknown) {
      capturedJob = job;
      assert.deepEqual(auth, {
        nodeBaseUrl: "http://127.0.0.1:18488",
        token: undefined,
        signingSecret: "secret",
        tokenTtlSeconds: undefined
      });
      return {
        job: { job_id: "job-gpu", state: "queued" },
        events: [],
        logs: [],
        artifacts: [],
        audit: []
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuJobCommands.run([
        "run",
        "--job-file",
        jobFile,
        "--node-base-url",
        "http://127.0.0.1:18488",
        "--signing-secret",
        "secret"
      ])
    );
    assert.equal((capturedJob as Record<string, unknown>).job_id, "job-gpu");
    assert.match(logs.join("\n"), /job-gpu queued/);
  } finally {
    (MswarmApi as any).create = originalCreate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("GpuJobCommands accepts plan-compatible type and payload-file run aliases", { concurrency: false }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gpu-cli-payload-"));
  const jobFile = path.join(tempDir, "job.json");
  await fs.writeFile(
    jobFile,
    JSON.stringify({
      args: { manifest_path: "mcoda-job.json", profile: "nvcc-default", target: "vector-add" },
      policy: { trust_mode: "owner-local", network: "none", allow_raw_command: false }
    }),
    "utf8"
  );
  const originalCreate = MswarmApi.create;
  let capturedJob: any;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async runGenericJob(job: unknown) {
      capturedJob = job;
      return {
        job: { job_id: "job-generated", state: "queued" },
        events: [],
        logs: [],
        artifacts: [],
        audit: []
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuJobCommands.run([
        "run",
        "--type",
        "cuda.run",
        "--payload-file",
        jobFile,
        "--node-id",
        "shn_local",
        "--signing-secret",
        "secret"
      ])
    );
    assert.equal(capturedJob.node_id, "shn_local");
    assert.equal(capturedJob.job.schema_version, "2026-06-14");
    assert.equal(capturedJob.job.job_type, "cuda.run");
    assert.match(logs.join("\n"), /job-generated queued/);
  } finally {
    (MswarmApi as any).create = originalCreate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("GpuJobCommands uploads artifacts with job reference flags", { concurrency: false }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gpu-upload-cli-"));
  const artifactFile = path.join(tempDir, "package.tar.gz");
  await fs.writeFile(artifactFile, "pkg", "utf8");
  const originalCreate = MswarmApi.create;
  let captured: Record<string, unknown> | undefined;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async uploadGenericJobArtifact(input: Record<string, unknown>) {
      captured = input;
      return {
        job_id: "job-gpu",
        artifact: {
          uri: "artifact://local/job-gpu/inputs/package.tar.gz",
          size_bytes: 3
        }
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuJobCommands.run([
        "artifact",
        "upload",
        artifactFile,
        "--job-id",
        "job-gpu",
        "--request-id",
        "req-gpu",
        "--node-id",
        "shn_local",
        "--job-type",
        "cuda.run",
        "--signing-secret",
        "secret",
        "--artifact-path",
        "inputs/package.tar.gz",
        "--json"
      ])
    );
    assert.equal(captured?.jobId, "job-gpu");
    assert.equal(captured?.path, "inputs/package.tar.gz");
    assert.equal(captured?.contentBase64, Buffer.from("pkg").toString("base64"));
    assert.match(logs.join("\n"), /artifact:\/\/local\/job-gpu\/inputs\/package.tar.gz/);
  } finally {
    (MswarmApi as any).create = originalCreate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("GpuJobCommands retries jobs with job reference flags", { concurrency: false }, async () => {
  const originalCreate = MswarmApi.create;
  let captured: Record<string, unknown> | undefined;
  (MswarmApi as any).create = async () => ({
    async close() {},
    async retryGenericJob(input: Record<string, unknown>) {
      captured = input;
      return {
        job: { job_id: "job-gpu", state: "queued" },
        events: [],
        logs: [],
        artifacts: [],
        audit: []
      };
    }
  });
  try {
    const logs = await captureLogs(() =>
      GpuJobCommands.run([
        "retry",
        "job-gpu",
        "--request-id",
        "req-gpu",
        "--node-id",
        "shn_local",
        "--job-type",
        "cuda.run",
        "--signing-secret",
        "secret"
      ])
    );
    assert.equal(captured?.jobId, "job-gpu");
    assert.equal(captured?.requestId, "req-gpu");
    assert.match(logs.join("\n"), /job-gpu queued/);
  } finally {
    (MswarmApi as any).create = originalCreate;
  }
});
