import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobService } from "../../jobs/JobService.js";
import { OpenApiService } from "../OpenApiService.js";

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

test("OpenApiService generates spec with stubbed agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-openapi-"));
  const previous = process.env.MCODA_DISABLE_DB;
  process.env.MCODA_DISABLE_DB = "1";
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const jobService = new JobService(workspace.workspaceRoot);
  const spec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo API",
    "  version: 0.1.8",
    "paths: {}",
    "",
  ].join("\n");

  const service = new OpenApiService(workspace, {
    jobService,
    docdex: { search: async () => [] } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    agentService: {
      invoke: async () => ({ output: spec, adapter: "local" }),
    } as any,
  });

  try {
    const result = await service.generateFromDocs({
      workspace,
      cliVersion: "0.1.8",
      agentStream: false,
      dryRun: true,
    });
    assert.ok(result.spec.includes("openapi: 3.1.0"));
    assert.equal(result.outputPath, undefined);
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("dry run")));
  } finally {
    await service.close();
    if (previous === undefined) {
      delete process.env.MCODA_DISABLE_DB;
    } else {
      process.env.MCODA_DISABLE_DB = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("OpenApiService invokes agent rating when enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-openapi-"));
  const previous = process.env.MCODA_DISABLE_DB;
  process.env.MCODA_DISABLE_DB = "1";
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const jobService = new JobService(workspace.workspaceRoot);
  const spec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo API",
    "  version: 0.1.8",
    "paths: {}",
    "",
  ].join("\n");
  const ratingService = new StubRatingService();

  const service = new OpenApiService(workspace, {
    jobService,
    docdex: { search: async () => [] } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    agentService: {
      invoke: async () => ({ output: spec, adapter: "local" }),
    } as any,
    ratingService: ratingService as any,
  });

  try {
    await service.generateFromDocs({
      workspace,
      cliVersion: "0.1.8",
      agentStream: false,
      dryRun: true,
      rateAgents: true,
    });
    assert.equal(ratingService.calls.length, 1);
    assert.equal(ratingService.calls[0]?.commandName, "openapi-from-docs");
    assert.equal(ratingService.calls[0]?.agentId, "agent-1");
  } finally {
    await service.close();
    if (previous === undefined) {
      delete process.env.MCODA_DISABLE_DB;
    } else {
      process.env.MCODA_DISABLE_DB = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
