import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Agent } from "@mcoda/shared";
import { DocdexClient } from "@mcoda/integrations";
import { DocsService } from "../DocsService.js";
import { JobService } from "../../jobs/JobService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

// Disable sqlite usage in tests to avoid FK constraints from incomplete fixtures.
process.env.MCODA_DISABLE_DB = "1";

class FakeAgentService {
  constructor(private agent: Agent, private response?: string) {}

  async close(): Promise<void> {
    // no-op
  }

  async resolveAgent(): Promise<Agent> {
    return this.agent;
  }

  async getCapabilities(): Promise<string[]> {
    return ["docdex_query", "doc_generation"];
  }

  async getPrompts() {
    return { jobPrompt: "# Job\nFollow runbook", characterPrompt: "character" };
  }

  async invoke(_agentId: string, request: any) {
    const jobId = request.metadata?.jobId ?? "job";
    const output =
      this.response ??
      `# Product Design Review\n\n## Introduction\nGenerated draft for ${jobId}\n\n## Scope\nscope\n\n## Requirements & Constraints\n- goal\n\n## Architecture Overview\narch\n\n## Interfaces / APIs\napi\n\n## Non-Functional Requirements\nnfr\n\n## Risks & Mitigations\nrisk\n\n## Open Questions\nq`;
    return {
      output,
      adapter: "fake",
      metadata: { request },
    };
  }

  async invokeStream() {
    async function* generator() {
      yield { output: "streamed-output", adapter: "fake" };
    }
    return generator();
  }
}

class FakeRepo {
  constructor(private agent: Agent) {}

  async close(): Promise<void> {
    // no-op
  }

  async getWorkspaceDefaults(): Promise<any[]> {
    return [];
  }

  async listAgents(): Promise<Agent[]> {
    return [this.agent];
  }

  async getAgentCapabilities(): Promise<string[]> {
    return ["docdex_query", "doc_generation"];
  }
}

class FakeRoutingService {
  constructor(private agent: Agent) {}

  async resolveAgentForCommand(params: { commandName: string; overrideAgentSlug?: string }): Promise<any> {
    return {
      agent: this.agent,
      agentId: this.agent.id,
      agentSlug: this.agent.slug,
      model: this.agent.defaultModel,
      capabilities: ["docdex_query", "doc_generation"],
      healthStatus: "healthy",
      source: params.overrideAgentSlug ? "override" : "workspace_default",
      routingPreview: { workspaceId: "ws", commandName: params.commandName } as any,
    };
  }
}

class FailingDocdex {
  async fetchDocumentById(): Promise<never> {
    throw new Error("docdex down");
  }
  async ensureRegisteredFromFile(): Promise<never> {
    throw new Error("docdex down");
  }
  async search(): Promise<any[]> {
    throw new Error("docdex down");
  }
}

describe("DocsService.generatePdr", () => {
  it("writes a PDR and records job + telemetry artifacts", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: path.join(workspaceRoot, ".mcoda"),
      id: workspaceRoot,
      workspaceDbPath: path.join(workspaceRoot, ".mcoda", "mcoda.db"),
      globalDbPath: path.join(os.homedir(), ".mcoda", "mcoda.db"),
    };
    const agent: Agent = {
      id: "agent-1",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspaceRoot);
    const docdex = new DocdexClient({ workspaceRoot });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal one\n- goal two\n", "utf8");

    const result = await service.generatePdr({
      workspace,
      projectKey: "TEST",
      rfpPath,
      agentName: "fake",
      agentStream: false,
      dryRun: false,
      json: false,
    });

    assert.ok(result.outputPath);
    const content = await fs.readFile(result.outputPath ?? "", "utf8");
    assert.match(content, /Product Design Review/);
    const manifestPath = path.join(workspace.mcodaDir, "jobs", result.jobId, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.state ?? manifest.status, "completed");

    const tokenPath = path.join(workspace.mcodaDir, "token_usage.json");
    const tokenUsage = JSON.parse(await fs.readFile(tokenPath, "utf8"));
    assert.ok(Array.isArray(tokenUsage));
    assert.ok(tokenUsage.length > 0);

    await service.close();
  });

  it("supports dry-run without writing files", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: path.join(workspaceRoot, ".mcoda"),
      id: workspaceRoot,
      workspaceDbPath: path.join(workspaceRoot, ".mcoda", "mcoda.db"),
      globalDbPath: path.join(os.homedir(), ".mcoda", "mcoda.db"),
    };
    const agent: Agent = {
      id: "agent-2",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspaceRoot);
    const docdex = new DocdexClient({ workspaceRoot });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal one\n", "utf8");

    const result = await service.generatePdr({
      workspace,
      projectKey: "DRY",
      rfpPath,
      agentName: "fake",
      agentStream: false,
      dryRun: true,
      json: true,
    });

    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("dry run")));
    const outputPath = result.outputPath ?? path.join(workspace.mcodaDir, "docs", "pdr");
    await assert.rejects(fs.access(outputPath));
    await service.close();
  });

  it("emits degraded warning when docdex unavailable", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: path.join(workspaceRoot, ".mcoda"),
      id: workspaceRoot,
      workspaceDbPath: path.join(workspaceRoot, ".mcoda", "mcoda.db"),
      globalDbPath: path.join(os.homedir(), ".mcoda", "mcoda.db"),
    };
    const agent: Agent = {
      id: "agent-3",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspaceRoot);
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex: new FailingDocdex() as any,
    });
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal\n", "utf8");

    const result = await service.generatePdr({
      workspace,
      projectKey: "DOWN",
      rfpPath,
      agentName: "fake",
      agentStream: false,
      dryRun: true,
      json: false,
    });
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("docdex")));
    await service.close();
  });

  it("writes an SDS and records job + telemetry artifacts", async () => {
    process.env.MCODA_SKIP_SDS_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: path.join(workspaceRoot, ".mcoda"),
      id: workspaceRoot,
      workspaceDbPath: path.join(workspaceRoot, ".mcoda", "mcoda.db"),
      globalDbPath: path.join(os.homedir(), ".mcoda", "mcoda.db"),
    };
    const agent: Agent = {
      id: "agent-sds",
      slug: "fake-sds",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const sdsDraft = [
      "# Software Design Specification",
      "## Introduction",
      "intro",
      "## Goals & Scope",
      "scope",
      "## Architecture Overview",
      "arch",
      "## Components & Responsibilities",
      "components",
      "## Data Model & Persistence",
      "data",
      "## Interfaces & Contracts",
      "interfaces",
      "## Non-Functional Requirements",
      "nfr",
      "## Security & Compliance",
      "security",
      "## Failure Modes & Resilience",
      "failures",
      "## Risks & Mitigations",
      "risks",
      "## Assumptions",
      "assumptions",
      "## Open Questions",
      "questions",
      "## Acceptance Criteria",
      "criteria",
    ].join("\n");
    const agentService = new FakeAgentService(agent, sdsDraft);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspaceRoot);
    const docdex = new DocdexClient({ workspaceRoot });
    await docdex.registerDocument({
      docType: "PDR",
      path: path.join(workspaceRoot, "pdr.md"),
      content: "- goal from pdr",
      metadata: { projectKey: "SDS" },
    });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const result = await service.generateSds({
      workspace,
      projectKey: "SDS",
      agentName: "fake-sds",
      agentStream: false,
      dryRun: false,
      json: false,
      force: true,
    });

    assert.ok(result.outputPath);
    const content = await fs.readFile(result.outputPath ?? "", "utf8");
    assert.match(content, /Software Design Specification/);
    const manifestPath = path.join(workspace.mcodaDir, "jobs", result.jobId, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.type, "sds_generate");

    const tokenPath = path.join(workspace.mcodaDir, "token_usage.json");
    const tokenUsage = JSON.parse(await fs.readFile(tokenPath, "utf8"));
    assert.ok(tokenUsage.some((entry: any) => entry.commandName === "docs-sds-generate"));

    await service.close();
  });
});
