import test from "node:test";
import assert from "node:assert/strict";
import { JobsApiClient } from "../JobsApiClient.js";
import { PathHelper } from "@mcoda/shared";

const workspace = {
  workspaceRoot: "/tmp",
  workspaceId: "ws-1",
  id: "ws-1",
  legacyWorkspaceIds: [],
  mcodaDir: PathHelper.getWorkspaceDir("/tmp"),
  workspaceDbPath: PathHelper.getWorkspaceDbPath("/tmp"),
  globalDbPath: PathHelper.getGlobalDbPath(),
};

test("JobsApiClient listJobs builds query parameters", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl: URL | undefined;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seenUrl = new URL(input.toString());
      return new Response(JSON.stringify([{ id: "job-1", type: "plan" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new JobsApiClient(workspace as any, "https://api.example.com");
    const result = await client.listJobs({ status: "running", type: "plan", project: "proj", since: "yday", limit: 5 });
    assert.ok(result);
    assert.equal(result[0].id, "job-1");
    assert.equal(seenUrl?.pathname, "/jobs");
    assert.equal(seenUrl?.searchParams.get("status"), "running");
    assert.equal(seenUrl?.searchParams.get("type"), "plan");
    assert.equal(seenUrl?.searchParams.get("project"), "proj");
    assert.equal(seenUrl?.searchParams.get("since"), "yday");
    assert.equal(seenUrl?.searchParams.get("limit"), "5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JobsApiClient getLogs passes cursor parameters", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl: URL | undefined;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seenUrl = new URL(input.toString());
      return new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new JobsApiClient(workspace as any, "https://api.example.com");
    await client.getLogs("job-1", { since: "2024-01-01", after: { timestamp: "t", sequence: 3 } });
    assert.equal(seenUrl?.pathname, "/jobs/job-1/logs");
    assert.equal(seenUrl?.searchParams.get("since"), "2024-01-01");
    assert.equal(seenUrl?.searchParams.get("after"), "t");
    assert.equal(seenUrl?.searchParams.get("sequence"), "3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JobsApiClient cancelJob posts default reason", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let seenMethod: string | undefined;
  let seenBody: any;
  try {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method;
      seenBody = JSON.parse(init?.body as string);
      return new Response("", { status: 204 });
    };

    const client = new JobsApiClient(workspace as any, "https://api.example.com");
    await client.cancelJob("job-2");
    assert.equal(seenMethod, "POST");
    assert.equal(seenBody.force, false);
    assert.equal(seenBody.reason, "user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JobsApiClient returns undefined on non-ok response", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("boom", { status: 500 });

    const client = new JobsApiClient(workspace as any, "https://api.example.com");
    const result = await client.getJob("job-3");
    assert.equal(result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
