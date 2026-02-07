import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { OpenApiService } from "../../openapi/OpenApiService.js";
import { JobResumeService } from "../JobResumeService.js";

const withPatched = <T, K extends keyof T>(
  target: T,
  key: K,
  impl: T[K],
  fn: () => Promise<void> | void,
) => {
  const original = target[key];
  // @ts-ignore override
  target[key] = impl;
  return (async () => {
    try {
      await fn();
    } finally {
      // @ts-ignore restore
      target[key] = original;
    }
  })();
};

describe("JobResumeService", () => {
  it("throws when job is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-resume-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobResumeService(workspace, {
      getJob: async () => undefined,
      readCheckpoints: async () => [],
      readManifest: async () => undefined,
      updateJobStatus: async () => {},
    } as any);
    await assert.rejects(() => service.resume("job-1"), /Job not found/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects resume without checkpoints", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-resume-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobResumeService(workspace, {
      getJob: async () => ({ id: "job-1", state: "failed" }),
      readCheckpoints: async () => [],
      readManifest: async () => ({ job_id: "job-1" }),
      updateJobStatus: async () => {},
    } as any);
    await assert.rejects(() => service.resume("job-1"), /No checkpoints/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects completed jobs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-resume-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobResumeService(workspace, {
      getJob: async () => ({ id: "job-1", state: "completed" }),
      readCheckpoints: async () => [{ stage: "done", timestamp: new Date().toISOString() }],
      readManifest: async () => ({ job_id: "job-1" }),
      updateJobStatus: async () => {},
    } as any);
    await assert.rejects(() => service.resume("job-1"), /cannot resume/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resumes openapi jobs via OpenApiService", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-resume-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const calls: any[] = [];
    const service = new JobResumeService(workspace, {
      getJob: async () => ({
        id: "job-openapi",
        state: "failed",
        type: "openapi_change",
        commandName: "openapi-from-docs",
        payload: { resumeSupported: true, cliVersion: "0.1.0" },
      }),
      readCheckpoints: async () => [{ stage: "draft_primary_completed", timestamp: new Date().toISOString() }],
      readManifest: async () => ({
        id: "job-openapi",
        job_id: "job-openapi",
        type: "openapi_change",
        command: "openapi-from-docs",
      }),
      updateJobStatus: async () => {},
    } as any);

    await withPatched(OpenApiService, "create", async () => ({
      generateFromDocs: async (options: any) => {
        calls.push(options);
      },
      close: async () => {},
    }) as any, async () => {
      await service.resume("job-openapi", { agentName: "agent-x" });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].resumeJobId, "job-openapi");
    assert.equal(calls[0].agentName, "agent-x");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
