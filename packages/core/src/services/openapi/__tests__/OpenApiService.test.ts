import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobService } from "../../jobs/JobService.js";
import {
  OpenApiService,
  extractOpenApiPaths,
  findAdminSurfaceMentions,
  findOpenApiPathLine,
  normalizeOpenApiPath,
  validateOpenApiSchemaContent,
} from "../OpenApiService.js";

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
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Health'",
    "components:",
    "  schemas:",
    "    Health:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
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
    assert.equal(result.adminSpec, undefined);
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

test("OpenApiService generates admin spec when docs mention admin surfaces", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-openapi-"));
  const previous = process.env.MCODA_DISABLE_DB;
  process.env.MCODA_DISABLE_DB = "1";
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const jobService = new JobService(workspace.workspaceRoot);
  const primarySpec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo API",
    "  version: 0.1.8",
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Health'",
    "components:",
    "  schemas:",
    "    Health:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
    "",
  ].join("\n");
  const adminSpec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo Admin API",
    "  version: 0.1.8",
    "paths:",
    "  /admin/health:",
    "    get:",
    "      operationId: getAdminHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/AdminHealth'",
    "components:",
    "  schemas:",
    "    AdminHealth:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
    "",
  ].join("\n");

  await fs.mkdir(path.join(workspace.workspaceRoot, "docs", "pdr"), { recursive: true });
  await fs.writeFile(
    path.join(workspace.workspaceRoot, "docs", "pdr", "admin-pdr.md"),
    "# Product Design Review\n\n## Interfaces / APIs\nAdmin API: /admin/health\n",
    "utf8",
  );

  const service = new OpenApiService(workspace, {
    jobService,
    docdex: { search: async () => [] } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    agentService: {
      invoke: async (_agentId: string, request: any) => {
        const prompt = request.input ?? "";
        const output = prompt.includes("ADMIN OpenAPI spec") ? adminSpec : primarySpec;
        return { output, adapter: "local" };
      },
    } as any,
  });

  try {
    const result = await service.generateFromDocs({
      workspace,
      cliVersion: "0.1.8",
      agentStream: false,
      dryRun: true,
    });
    assert.ok(result.spec.includes("/health:"));
    assert.ok(result.adminSpec?.includes("/admin/health:"));
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
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Health'",
    "components:",
    "  schemas:",
    "    Health:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
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

test("OpenApiService resumes from saved draft without invoking agent", async () => {
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
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Health'",
    "components:",
    "  schemas:",
    "    Health:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
    "",
  ].join("\n");

  const commandRun = await jobService.startCommandRun("openapi-from-docs", "proj");
  const job = await jobService.startJob("openapi_change", commandRun.id, "proj", {
    commandName: "openapi-from-docs",
    payload: { resumeSupported: true },
  });
  const draftPath = path.join(workspace.mcodaDir, "jobs", job.id, "openapi-primary-draft.yaml");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  await fs.writeFile(draftPath, spec, "utf8");
  await jobService.writeCheckpoint(job.id, {
    stage: "draft_primary_completed",
    timestamp: new Date().toISOString(),
    details: { variant: "primary", draftPath },
  });
  await jobService.updateJobStatus(job.id, "failed", {
    errorSummary: "timeout",
    payload: { resumeSupported: true, openapi_primary_draft_path: draftPath },
  });

  let agentInvoked = false;
  const service = new OpenApiService(workspace, {
    jobService,
    docdex: { search: async () => [] } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    agentService: {
      invoke: async () => {
        agentInvoked = true;
        return { output: spec, adapter: "local" };
      },
    } as any,
  });

  try {
    const result = await service.generateFromDocs({
      workspace,
      cliVersion: "0.1.8",
      agentStream: false,
      dryRun: true,
      resumeJobId: job.id,
    });
    assert.equal(agentInvoked, false);
    assert.equal(result.jobId, job.id);
    assert.ok(result.spec.includes("openapi: 3.1.0"));
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

test("OpenApiService times out agent invocation", async () => {
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
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      responses:",
    "        '200':",
    "          description: ok",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/Health'",
    "components:",
    "  schemas:",
    "    Health:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
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
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { output: spec, adapter: "local" };
      },
    } as any,
  });

  try {
    await assert.rejects(
      () =>
        service.generateFromDocs({
          workspace,
          cliVersion: "0.1.8",
          agentStream: false,
          dryRun: true,
          timeoutMs: 10,
        }),
      (err: any) => err?.code === "timeout",
    );
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

test("extractOpenApiPaths parses YAML and normalizes parameters", () => {
  const spec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo",
    "  version: 1.0.0",
    "paths:",
    "  /api/v1/users/{userId}:",
    "    get:",
    "      responses:",
    "        '200':",
    "          description: ok",
    "  '/api/v1/orders/{orderId}':",
    "    post:",
    "      responses:",
    "        '200':",
    "          description: ok",
  ].join("\n");

  const result = extractOpenApiPaths(spec);
  const paths = result.paths.slice().sort();
  assert.deepEqual(paths, ["/api/v1/orders/{orderId}", "/api/v1/users/{userId}"]);
  assert.equal(result.errors.length, 0);
  assert.equal(normalizeOpenApiPath("/api/v1/users/{id}"), "/api/v1/users/{param}");
});

test("findOpenApiPathLine locates quoted and unquoted paths", () => {
  const spec = [
    "openapi: 3.1.0",
    "info:",
    "  title: Demo",
    "  version: 1.0.0",
    "paths:",
    "  /health:",
    "    get:",
    "      responses:",
    "        '200':",
    "          description: ok",
    "  '/items/{id}':",
    "    get:",
    "      responses:",
    "        '200':",
    "          description: ok",
  ].join("\n");

  assert.equal(findOpenApiPathLine(spec, "/health"), 6);
  assert.equal(findOpenApiPathLine(spec, "/items/{id}"), 11);
  assert.equal(findOpenApiPathLine(spec, "/missing"), undefined);
});

test("findAdminSurfaceMentions detects admin headings and paths", () => {
  const content = [
    "# Intro",
    "## Admin APIs",
    "Use /admin/users for management.",
    "```",
    "/admin/ignored",
    "```",
    "Admin console endpoint /admin/health",
  ].join("\n");

  const mentions = findAdminSurfaceMentions(content);
  const lines = mentions.map((m) => m.line);
  assert.ok(lines.includes(2));
  assert.ok(lines.includes(3));
  assert.ok(lines.includes(7));
});

test("validateOpenApiSchemaContent flags invalid versions and operation ids", () => {
  const spec = [
    "openapi: 2.0.0",
    "info:",
    "  title: Demo",
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: bad id",
    "      responses:",
    "        '200':",
    "          description: ok",
  ].join("\n");

  const result = validateOpenApiSchemaContent(spec);
  assert.ok(result.errors.some((error) => error.includes("Invalid openapi version")));
  assert.ok(result.errors.some((error) => error.includes("Missing info.version")));
  assert.ok(result.errors.some((error) => error.includes("Invalid operationId")));
});
