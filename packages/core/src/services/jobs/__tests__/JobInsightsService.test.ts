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
});
