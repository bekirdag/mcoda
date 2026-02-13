import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobInsightsService } from "../JobInsightsService.js";

describe("JobInsightsService", () => {
  it("fails without a configured jobs API", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobinsights-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobInsightsService(workspace, { close: async () => {} } as any, undefined);
    await assert.rejects(() => service.listJobs(), /Jobs API is not configured/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("hydrates docgen detail from payload when job state detail is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-jobinsights-"));
    const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
    const service = new JobInsightsService(workspace, { close: async () => {} } as any, "http://localhost");
    (service as any).apiClient = {
      getJob: async () => ({
        id: "job-docgen",
        type: "pdr_generate",
        state: "running",
        payload_json: JSON.stringify({
          docgen_status_message: "Review iteration 1/3",
          docgen_iteration_current: 1,
          docgen_iteration_max: 3,
          docgen_elapsed_seconds: 61,
        }),
      }),
    };
    const job = await service.getJob("job-docgen");
    assert.equal(job?.jobStateDetail, "Review iteration 1/3 iter:1/3 elapsed:1m1s");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
