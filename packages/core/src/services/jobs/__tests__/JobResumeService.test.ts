import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobResumeService } from "../JobResumeService.js";

describe("JobResumeService", () => {
  it("throws when job is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-resume-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobResumeService(workspace, {
      getJob: async () => undefined,
      readCheckpoints: async () => [],
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
      updateJobStatus: async () => {},
    } as any);
    await assert.rejects(() => service.resume("job-1"), /cannot resume/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
