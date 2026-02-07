import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Agent, PathHelper } from "@mcoda/shared";
import { DocdexClient } from "@mcoda/integrations";
import { DocsService } from "../DocsService.js";
import { buildDocInventory } from "../DocInventory.js";
import { createEmptyArtifacts } from "../DocgenRunContext.js";
import type { DocgenArtifactInventory, DocgenRunContext } from "../DocgenRunContext.js";
import { DocPatchEngine } from "../patch/DocPatchEngine.js";
import type { DocPatchRequest } from "../patch/DocPatchEngine.js";
import { DocAlignmentGraph } from "../alignment/DocAlignmentGraph.js";
import { DocAlignmentPatcher } from "../alignment/DocAlignmentPatcher.js";
import { aggregateReviewOutcome, summarizeGateResults } from "../review/ReviewTypes.js";
import type { ReviewGateResult, ReviewIssue } from "../review/ReviewTypes.js";
import { serializeReviewReport, validateReviewReport } from "../review/ReviewReportSchema.js";
import { renderReviewReport } from "../review/ReviewReportRenderer.js";
import { runApiPathConsistencyGate } from "../review/gates/ApiPathConsistencyGate.js";
import { runOpenApiCoverageGate } from "../review/gates/OpenApiCoverageGate.js";
import { runPlaceholderArtifactGate } from "../review/gates/PlaceholderArtifactGate.js";
import { runSqlSyntaxGate } from "../review/gates/SqlSyntaxGate.js";
import { runSqlRequiredTablesGate } from "../review/gates/SqlRequiredTablesGate.js";
import { runTerminologyNormalizationGate } from "../review/gates/TerminologyNormalizationGate.js";
import { runOpenQuestionsGate } from "../review/gates/OpenQuestionsGate.js";
import { runNoMaybesGate } from "../review/gates/NoMaybesGate.js";
import { runBuildReadyCompletenessGate } from "../review/gates/BuildReadyCompletenessGate.js";
import { runDeploymentBlueprintGate } from "../review/gates/DeploymentBlueprintGate.js";
import { runRfpConsentGate } from "../review/gates/RfpConsentGate.js";
import { runRfpDefinitionGate } from "../review/gates/RfpDefinitionGate.js";
import { runPdrInterfacesGate } from "../review/gates/PdrInterfacesGate.js";
import { runPdrOwnershipGate } from "../review/gates/PdrOwnershipGate.js";
import { runPdrOpenQuestionsGate } from "../review/gates/PdrOpenQuestionsGate.js";
import { runSdsDecisionsGate } from "../review/gates/SdsDecisionsGate.js";
import { runSdsPolicyTelemetryGate } from "../review/gates/SdsPolicyTelemetryGate.js";
import { runSdsOpsGate } from "../review/gates/SdsOpsGate.js";
import { runSdsAdaptersGate } from "../review/gates/SdsAdaptersGate.js";
import { formatGlossaryForPrompt, getGlossaryEntry, loadGlossary } from "../review/Glossary.js";
import type { GlossaryData } from "../review/Glossary.js";
import { JobService } from "../../jobs/JobService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

// Disable sqlite usage in tests to avoid FK constraints from incomplete fixtures.
process.env.MCODA_DISABLE_DB = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCandidates = [
  path.join(__dirname, "fixtures"),
  path.resolve(process.cwd(), "packages/core/src/services/docs/__tests__/fixtures"),
  path.resolve(process.cwd(), "src/services/docs/__tests__/fixtures"),
];
const fixturesRoot = fixtureCandidates.find((candidate) => existsSync(candidate)) ?? fixtureCandidates[0];
const readFixture = async (relativePath: string): Promise<string> =>
  fs.readFile(path.join(fixturesRoot, relativePath), "utf8");
const writeFixture = async (relativePath: string, destPath: string): Promise<void> => {
  const content = await readFixture(relativePath);
  await fs.writeFile(destPath, content, "utf8");
};

let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

before(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-docs-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

after(async () => {
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalProfile;
  }
});

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
    const prompt = request.input ?? "";
    if (prompt.includes("Generate ONLY a concise table of contents for the Product Design Review")) {
      const output = [
        "- Introduction",
        "- Scope",
        "- Technology Stack",
        "- Requirements & Constraints",
        "- Architecture Overview",
        "- Interfaces / APIs",
        "- Non-Functional Requirements",
        "- Risks & Mitigations",
        "- Open Questions",
        "- Acceptance Criteria",
      ].join("\n");
      return { output, adapter: "fake", metadata: { request } };
    }
    if (prompt.includes("Generate ONLY a concise table of contents for the Software Design Specification")) {
      const output = [
        "1. Introduction",
        "2. Goals & Scope",
        "3. Architecture Overview",
        "4. Components & Responsibilities",
        "5. Planned Folder Tree",
        "6. Data Model & Persistence",
        "7. Interfaces & Contracts",
        "8. Non-Functional Requirements",
        "9. Security & Compliance",
        "10. Failure Modes & Resilience",
        "11. Risks & Mitigations",
        "12. Assumptions",
        "13. Open Questions",
        "14. Acceptance Criteria",
      ].join("\n");
      return { output, adapter: "fake", metadata: { request } };
    }
    const sectionMatch = prompt.match(/Generate the section \"([^\"]+)\"/);
    if (sectionMatch) {
      const heading = sectionMatch[1];
      const output = `## ${heading}\ncontent for ${heading}`;
      return { output, adapter: "fake", metadata: { request } };
    }
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

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

describe("DocsService.generatePdr", () => {
  it("writes a PDR and records job + telemetry artifacts", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
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
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
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
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
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
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
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

  it("invokes agent rating when enabled", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };
    const agent: Agent = {
      id: "agent-rate",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ratingService = new StubRatingService();
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
      ratingService: ratingService as any,
    });

    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal one\n- goal two\n", "utf8");

    try {
      await service.generatePdr({
        workspace,
        projectKey: "TEST",
        rfpPath,
        agentName: "fake",
        agentStream: false,
        dryRun: true,
        json: false,
        rateAgents: true,
      });
      assert.equal(ratingService.calls.length, 1);
      assert.equal(ratingService.calls[0]?.commandName, "docs-pdr-generate");
      assert.equal(ratingService.calls[0]?.agentId, agent.id);
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("emits degraded warning when docdex unavailable", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
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
    const jobService = new JobService(workspace);
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

  it("rejects placeholders when noPlaceholders is enabled", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };
    const agent: Agent = {
      id: "agent-3b",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const placeholderDraft = [
      "# Product Design Review",
      "",
      "## Introduction",
      "Intro",
      "",
      "## Scope",
      "TBD: fill in scope",
      "",
      "## Technology Stack",
      "- TypeScript",
      "",
      "## Requirements & Constraints",
      "- requirement",
      "",
      "## Architecture Overview",
      "arch",
      "",
      "## Interfaces / APIs",
      "api",
      "",
      "## Non-Functional Requirements",
      "nfr",
      "",
      "## Risks & Mitigations",
      "risk",
      "",
      "## Open Questions",
      "q",
      "",
      "## Acceptance Criteria",
      "- done",
    ].join("\n");
    const agentService = new FakeAgentService(agent, placeholderDraft);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal\n", "utf8");

    try {
      await assert.rejects(
        service.generatePdr({
          workspace,
          projectKey: "NOPLACE",
          rfpPath,
          agentName: "fake",
          agentStream: false,
          dryRun: false,
          json: false,
          fast: true,
          noPlaceholders: true,
        }),
        /placeholder detected/i,
      );
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("adds Technology Stack defaults when missing", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };
    const agent: Agent = {
      id: "agent-4",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "Build a simple todo app.\n", "utf8");

    try {
      const result = await service.generatePdr({
        workspace,
        projectKey: "STACK",
        rfpPath,
        agentName: "fake",
        agentStream: false,
        dryRun: true,
        json: false,
      });

      const content = result.draft;
      assert.match(content, /## Technology Stack/i);
      assert.match(content, /TypeScript/i);
      assert.match(content, /React/i);
      assert.match(content, /MySQL/i);
      assert.match(content, /Redis/i);
      assert.match(content, /Bash/i);
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses Python stack defaults for ML-focused RFPs", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };
    const agent: Agent = {
      id: "agent-5",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(
      rfpPath,
      "We need a neural network model for machine learning inference and model training.\n",
      "utf8",
    );

    try {
      const result = await service.generatePdr({
        workspace,
        projectKey: "MLSTACK",
        rfpPath,
        agentName: "fake",
        agentStream: false,
        dryRun: true,
        json: false,
      });

      const content = result.draft;
      assert.match(content, /## Technology Stack/i);
      assert.match(content, /Python/i);
      assert.match(content, /PyTorch|TensorFlow/i);
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses a generic OpenAPI fallback without domain placeholders", async () => {
    process.env.MCODA_SKIP_PDR_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };
    const agent: Agent = {
      id: "agent-openapi-fallback",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const draft = [
      "# Product Design Review",
      "",
      "## Interfaces / APIs",
      "POST /widgets endpoint",
    ].join("\n");
    const agentService = new FakeAgentService(agent, draft);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const rfpPath = path.join(workspaceRoot, "rfp.md");
    await fs.writeFile(rfpPath, "- goal\n", "utf8");

    try {
      const result = await service.generatePdr({
        workspace,
        projectKey: "OPENAPI",
        rfpPath,
        agentName: "fake",
        agentStream: false,
        dryRun: true,
        json: false,
      });

      const content = result.draft ?? "";
      assert.match(content, /## Interfaces \/ APIs/i);
      assert.match(content, /Capture interface needs as open questions/i);
      assert.match(content, /authentication\/identity/i);
      assert.doesNotMatch(content, /restaurant/i);
      assert.doesNotMatch(content, /voting cycles/i);
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("writes an SDS and records job + telemetry artifacts", async () => {
    process.env.MCODA_SKIP_SDS_VALIDATION = "1";
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
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
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const docdexDir = path.join(PathHelper.getWorkspaceDir(workspaceRoot), "docdex");
    await fs.mkdir(docdexDir, { recursive: true });
    await fs.writeFile(path.join(docdexDir, "documents.json"), "[]", "utf8");
    const localPdrDir = path.join(PathHelper.getWorkspaceDir(workspaceRoot), "docs", "pdr");
    await fs.mkdir(localPdrDir, { recursive: true });
    await fs.writeFile(path.join(localPdrDir, "pdr.md"), "# PDR\n- goal from pdr", "utf8");
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
    assert.match(content, /Planned Folder Tree/i);
    const manifestPath = path.join(workspace.mcodaDir, "jobs", result.jobId, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.type, "sds_generate");

    const tokenPath = path.join(workspace.mcodaDir, "token_usage.json");
    const tokenUsage = JSON.parse(await fs.readFile(tokenPath, "utf8"));
    assert.ok(tokenUsage.some((entry: any) => entry.commandName === "docs-sds-generate"));

    await service.close();
  });
});

describe("DocInventory", () => {
  it("builds a stable artifact inventory from workspace files", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-inventory-"));
    const workspace: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
      id: workspaceRoot,
      legacyWorkspaceIds: [],
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
    };

    const pdrPath = path.join(workspace.mcodaDir, "docs", "pdr", "project-pdr.md");
    const sdsPath = path.join(workspace.mcodaDir, "docs", "sds", "project-sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi", "mcoda.yaml");
    const openapiAdminPath = path.join(workspaceRoot, "openapi", "mcoda-admin.yaml");
    const schemaPath = path.join(workspaceRoot, "db", "schema.sql");
    const extraSqlPath = path.join(workspaceRoot, "db", "extra.sql");
    const composePath = path.join(workspaceRoot, "deploy", "docker-compose.yml");
    const k8sPath = path.join(workspaceRoot, "k8s", "deployment.yaml");
    const envExamplePath = path.join(workspaceRoot, ".env.example");

    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.mkdir(path.dirname(sdsPath), { recursive: true });
    await fs.mkdir(path.dirname(openapiPath), { recursive: true });
    await fs.mkdir(path.dirname(schemaPath), { recursive: true });
    await fs.mkdir(path.dirname(composePath), { recursive: true });
    await fs.mkdir(path.dirname(k8sPath), { recursive: true });

    await fs.writeFile(pdrPath, "# PDR\n", "utf8");
    await fs.writeFile(
      `${pdrPath}.meta.json`,
      JSON.stringify({ docdexId: "doc-pdr", segments: ["seg-1"], projectKey: "TEST" }, null, 2),
      "utf8",
    );
    await fs.writeFile(sdsPath, "# SDS\n", "utf8");
    await fs.writeFile(openapiPath, "openapi: 3.0.0\n", "utf8");
    await fs.writeFile(openapiAdminPath, "openapi: 3.0.0\n", "utf8");
    await fs.writeFile(schemaPath, "create table widgets (id int);\n", "utf8");
    await fs.writeFile(extraSqlPath, "create table widgets_extra (id int);\n", "utf8");
    await fs.writeFile(composePath, "services:\n  app:\n", "utf8");
    await fs.writeFile(k8sPath, "apiVersion: apps/v1\nkind: Deployment\n", "utf8");
    await fs.writeFile(envExamplePath, "PORT=3000\n", "utf8");

    try {
      const inventory = await buildDocInventory({ workspace, preferred: { pdrPath, sdsPath } });
      assert.equal(inventory.pdr?.path, pdrPath);
      assert.equal(inventory.pdr?.meta.docdexId, "doc-pdr");
      assert.deepEqual(inventory.pdr?.meta.segments, ["seg-1"]);
      assert.equal(inventory.pdr?.meta.projectKey, "TEST");
      assert.equal(inventory.sds?.path, sdsPath);
      assert.equal(inventory.openapi.length, 2);
      assert.ok(inventory.openapi.some((record) => record.variant === "admin"));
      assert.equal(inventory.sql?.path, schemaPath);
      assert.ok(inventory.blueprints.some((record) => record.path === composePath));
      assert.ok(inventory.blueprints.some((record) => record.path === k8sPath));
      assert.ok(inventory.blueprints.some((record) => record.path === envExamplePath));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

const buildWorkspace = async (prefix: string): Promise<{
  workspaceRoot: string;
  workspace: WorkspaceResolution;
}> => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace: WorkspaceResolution = {
    workspaceRoot,
    workspaceId: workspaceRoot,
    mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
    id: workspaceRoot,
    legacyWorkspaceIds: [],
    workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
    globalDbPath: PathHelper.getGlobalDbPath(),
  };
  await fs.mkdir(workspace.mcodaDir, { recursive: true });
  return { workspaceRoot, workspace };
};

const buildRunContext = (workspace: WorkspaceResolution, outputPath: string): DocgenRunContext => ({
  version: 1,
  commandName: "docs-pdr-generate",
  commandRunId: "command-run",
  jobId: "job",
  workspace,
  outputPath,
  createdAt: new Date().toISOString(),
  flags: {
    dryRun: false,
    fast: false,
    iterate: false,
    json: false,
    stream: false,
    buildReady: false,
    noPlaceholders: false,
    resolveOpenQuestions: false,
    noMaybes: false,
    crossAlign: true,
  },
  iteration: { current: 0, max: 0 },
  artifacts: createEmptyArtifacts(),
  warnings: [],
});

describe("DocPatchEngine", () => {
  it("replaces markdown sections by heading and refreshes inventory", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-patch-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(
      pdrPath,
      "# PDR\n\n## Scope\nold scope\n\n## Notes\nunchanged\n",
      "utf8",
    );

    const runContext = buildRunContext(workspace, pdrPath);
    const patches: DocPatchRequest[] = [
      {
        path: pdrPath,
        operations: [
          {
            type: "replace_section",
            location: { kind: "heading", path: pdrPath, heading: "Scope" },
            content: "Updated scope content.",
          },
        ],
      },
    ];

    try {
      const engine = new DocPatchEngine();
      const result = await engine.apply({ runContext, patches });
      const updated = await fs.readFile(pdrPath, "utf8");
      assert.match(updated, /## Scope/);
      assert.ok(updated.includes("Updated scope content."));
      assert.equal(result.results[0]?.changed, true);
      assert.equal(result.updatedArtifacts?.pdr?.path, pdrPath);
      assert.equal(runContext.artifacts.pdr?.path, pdrPath);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("inserts markdown sections after a heading", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-patch-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(
      pdrPath,
      "# PDR\n\n## Scope\nscope details\n\n## Next\nnext details\n",
      "utf8",
    );

    const runContext = buildRunContext(workspace, pdrPath);
    const patches: DocPatchRequest[] = [
      {
        path: pdrPath,
        operations: [
          {
            type: "insert_section",
            heading: "Patch Notes",
            content: "Inserted content.",
            location: { kind: "heading", path: pdrPath, heading: "Scope" },
            position: "after",
            headingLevel: 2,
          },
        ],
      },
    ];

    try {
      const engine = new DocPatchEngine();
      await engine.apply({ runContext, patches });
      const updated = await fs.readFile(pdrPath, "utf8");
      assert.match(updated, /## Patch Notes/);
      assert.ok(updated.includes("Inserted content."));
      const indexPatch = updated.indexOf("## Patch Notes");
      const indexNext = updated.indexOf("## Next");
      assert.ok(indexPatch > -1);
      assert.ok(indexNext > -1);
      assert.ok(indexPatch < indexNext);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("removes YAML blocks by line range", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-patch-");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    await fs.writeFile(
      openapiPath,
      "openapi: 3.0.0\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}\n",
      "utf8",
    );

    const runContext = buildRunContext(workspace, openapiPath);
    const patches: DocPatchRequest[] = [
      {
        path: openapiPath,
        format: "yaml",
        operations: [
          {
            type: "remove_block",
            location: { kind: "line_range", path: openapiPath, lineStart: 2, lineEnd: 4 },
          },
        ],
      },
    ];

    try {
      const engine = new DocPatchEngine();
      await engine.apply({ runContext, patches });
      const updated = await fs.readFile(openapiPath, "utf8");
      assert.ok(!updated.includes("info:"));
      assert.ok(!updated.includes("title: Demo"));
      assert.ok(updated.includes("openapi: 3.0.0"));
      assert.ok(updated.includes("paths: {}"));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not write changes in dry-run mode", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-patch-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    const original = "# PDR\n\n## Scope\noriginal\n";
    await fs.writeFile(pdrPath, original, "utf8");

    const runContext = buildRunContext(workspace, pdrPath);
    const patches: DocPatchRequest[] = [
      {
        path: pdrPath,
        operations: [
          {
            type: "replace_section",
            location: { kind: "heading", path: pdrPath, heading: "Scope" },
            content: "dry-run replacement",
          },
        ],
      },
    ];

    try {
      const engine = new DocPatchEngine();
      await engine.apply({ runContext, patches, dryRun: true });
      const updated = await fs.readFile(pdrPath, "utf8");
      assert.equal(updated, original);
      assert.equal(runContext.artifacts.pdr, undefined);
      assert.equal(runContext.artifacts.openapi.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("DocgenIteration", () => {
  it("iterates to remove placeholders when enabled", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-iter-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(pdrPath, "# PDR\n\n## Scope\nTODO: fill in scope\n", "utf8");

    const agent: Agent = {
      id: "agent-iter",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const commandRun = await jobService.startCommandRun("docs-pdr-generate", "proj");
    const job = await jobService.startJob("pdr_generate", commandRun.id, "proj", {
      commandName: "docs-pdr-generate",
    });

    const runContext = buildRunContext(workspace, pdrPath);
    runContext.jobId = job.id;
    runContext.commandRunId = commandRun.id;
    runContext.flags.noPlaceholders = true;
    runContext.artifacts = await buildDocInventory({ workspace, preferred: { pdrPath } });

    try {
      await (service as any).runIterationLoop(runContext);
      const updated = await fs.readFile(pdrPath, "utf8");
      assert.ok(!updated.includes("TODO"));

      const reviewDir = path.join(workspace.mcodaDir, "jobs", job.id, "review");
      const iterationReport = JSON.parse(
        await fs.readFile(path.join(reviewDir, "review-iteration-1.json"), "utf8"),
      );
      assert.equal(iterationReport.iteration.status, "completed");
      assert.ok(iterationReport.fixesApplied.length > 0);

      const finalReport = JSON.parse(
        await fs.readFile(path.join(reviewDir, "review-final.json"), "utf8"),
      );
      assert.equal(finalReport.iteration.status, "completed");
      assert.ok(finalReport.metadata?.iterationReports?.length);

      const finalMarkdown = await fs.readFile(path.join(reviewDir, "review-final.md"), "utf8");
      assert.match(finalMarkdown, /## Summary/);
      assert.match(finalMarkdown, /Prior Iterations/);
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails after max iterations when blocking issues persist", async () => {
    const previousNoMaybes = process.env.MCODA_DOCS_NO_MAYBES;
    const previousMaxIterations = process.env.MCODA_DOCS_MAX_ITERATIONS;
    process.env.MCODA_DOCS_NO_MAYBES = "1";
    process.env.MCODA_DOCS_MAX_ITERATIONS = "2";

    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-iter-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(
      pdrPath,
      "# PDR\n\n## Architecture\nWe maybe choose Redis.\n",
      "utf8",
    );

    const agent: Agent = {
      id: "agent-iter-2",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const commandRun = await jobService.startCommandRun("docs-pdr-generate", "proj");
    const job = await jobService.startJob("pdr_generate", commandRun.id, "proj", {
      commandName: "docs-pdr-generate",
    });

    const runContext = buildRunContext(workspace, pdrPath);
    runContext.jobId = job.id;
    runContext.commandRunId = commandRun.id;
    runContext.artifacts = await buildDocInventory({ workspace, preferred: { pdrPath } });

    try {
      await assert.rejects(
        (service as any).runIterationLoop(runContext),
        /after 2 iteration/i,
      );
      const reviewDir = path.join(workspace.mcodaDir, "jobs", job.id, "review");
      const finalReport = JSON.parse(
        await fs.readFile(path.join(reviewDir, "review-final.json"), "utf8"),
      );
      assert.equal(finalReport.iteration.status, "max_iterations");
      assert.equal(finalReport.metadata?.iterationReports?.length, 2);
      assert.ok(finalReport.metadata?.iterationReports?.some((entry: string) => entry.includes("review-iteration-2.md")));
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if (previousNoMaybes === undefined) {
        delete process.env.MCODA_DOCS_NO_MAYBES;
      } else {
        process.env.MCODA_DOCS_NO_MAYBES = previousNoMaybes;
      }
      if (previousMaxIterations === undefined) {
        delete process.env.MCODA_DOCS_MAX_ITERATIONS;
      } else {
        process.env.MCODA_DOCS_MAX_ITERATIONS = previousMaxIterations;
      }
    }
  });

  it("resolves open questions and records decisions when enabled", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-resolve-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(
      pdrPath,
      [
        "# PDR",
        "",
        "## Technology Stack",
        "We maybe choose Redis for caching.",
        "",
        "## Open Questions",
        "- Should we use Redis?",
        "",
      ].join("\n"),
      "utf8",
    );

    const agent: Agent = {
      id: "agent-resolve",
      slug: "fake",
      adapter: "codex-api",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const agentService = new FakeAgentService(agent);
    const repo = new FakeRepo(agent);
    const routingService = new FakeRoutingService(agent);
    const jobService = new JobService(workspace);
    const docdex = new DocdexClient({ workspaceRoot, baseUrl: "" });
    const service = new DocsService(workspace, {
      agentService: agentService as any,
      repo: repo as any,
      routingService: routingService as any,
      jobService,
      docdex,
    });

    const commandRun = await jobService.startCommandRun("docs-pdr-generate", "proj");
    const job = await jobService.startJob("pdr_generate", commandRun.id, "proj", {
      commandName: "docs-pdr-generate",
    });

    const runContext = buildRunContext(workspace, pdrPath);
    runContext.jobId = job.id;
    runContext.commandRunId = commandRun.id;
    runContext.flags.resolveOpenQuestions = true;
    runContext.flags.noMaybes = true;
    runContext.artifacts = await buildDocInventory({ workspace, preferred: { pdrPath } });

    try {
      await (service as any).runIterationLoop(runContext);
      const updated = await fs.readFile(pdrPath, "utf8");
      assert.ok(updated.includes("We choose Redis for caching."));
      assert.ok(updated.includes("Resolved: Use Redis."));
      assert.match(updated, /## Resolved Decisions/);

      const reviewDir = path.join(workspace.mcodaDir, "jobs", job.id, "review");
      const finalReport = JSON.parse(
        await fs.readFile(path.join(reviewDir, "review-final.json"), "utf8"),
      );
      assert.ok(finalReport.decisions.length > 0);
      assert.ok(finalReport.decisions.some((entry: any) => entry.summary.includes("Use Redis")));
    } finally {
      await service.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("DocAlignmentGraph", () => {
  it("returns impacted artifacts for consent model changes", () => {
    const graph = DocAlignmentGraph.createDefault();
    const impacted = graph.getImpactedSections("consent-model");
    assert.ok(impacted.some((node) => node.artifact === "pdr"));
    assert.ok(impacted.some((node) => node.artifact === "sds"));
    assert.ok(impacted.some((node) => node.artifact === "telemetry"));
    const openapiVariants = impacted
      .filter((node) => node.artifact === "openapi")
      .map((node) => node.variant);
    assert.ok(openapiVariants.includes("primary"));
    assert.ok(openapiVariants.includes("admin"));
  });

  it("returns impacted artifacts for api prefix changes", () => {
    const graph = DocAlignmentGraph.createDefault();
    const impacted = graph.getImpactedSections("api-prefix");
    assert.ok(impacted.some((node) => node.artifact === "pdr"));
    assert.ok(impacted.some((node) => node.artifact === "sds"));
    assert.ok(
      impacted.some((node) => node.artifact === "openapi" && node.variant === "primary"),
    );
  });

  it("returns empty results for unknown rules", () => {
    const graph = DocAlignmentGraph.createDefault();
    assert.deepEqual(graph.getImpactedSections("unknown"), []);
  });
});

describe("DocAlignmentPatcher", () => {
  it("applies api prefix and terminology alignment patches with deltas", async () => {
    const { workspaceRoot, workspace } = await buildWorkspace("mcoda-align-");
    const pdrPath = path.join(workspaceRoot, "docs", "pdr.md");
    await fs.mkdir(path.dirname(pdrPath), { recursive: true });
    await fs.writeFile(
      pdrPath,
      [
        "# PDR",
        "",
        "## Interfaces / APIs",
        "- /v1/users",
        "",
        "## Consent Flow",
        "Uses anon token for session tracking.",
        "",
      ].join("\n"),
      "utf8",
    );
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    await fs.writeFile(
      openapiPath,
      [
        "openapi: 3.0.0",
        "paths:",
        "  /api/v1/users:",
        "    get:",
        "      responses:",
        "        '200':",
        "          description: ok",
        "",
      ].join("\n"),
      "utf8",
    );

    const runContext = buildRunContext(workspace, pdrPath);
    runContext.artifacts = await buildDocInventory({ workspace, preferred: { pdrPath } });

    try {
      const apiGate = await runApiPathConsistencyGate({ artifacts: runContext.artifacts });
      const terminologyGate = await runTerminologyNormalizationGate({
        artifacts: runContext.artifacts,
      });
      const patcher = new DocAlignmentPatcher();
      const result = await patcher.apply({
        runContext,
        gateResults: [apiGate, terminologyGate],
      });

      const updated = await fs.readFile(pdrPath, "utf8");
      assert.match(updated, /\/api\/v1\/users/);
      assert.ok(updated.includes("anonymous token"));
      assert.equal(result.deltas.length, 1);
      assert.equal(result.deltas[0]?.path, pdrPath);
      assert.ok(result.deltas[0]?.summary.includes("Aligned API prefix"));
      assert.ok(result.deltas[0]?.summary.includes("Replaced"));
      assert.ok(result.deltas[0]?.beforeChecksum);
      assert.ok(result.deltas[0]?.afterChecksum);
      assert.notEqual(result.deltas[0]?.beforeChecksum, result.deltas[0]?.afterChecksum);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("DocReviewTypes", () => {
  it("summarizes gate results and aggregates outcomes deterministically", () => {
    const issueA: ReviewIssue = {
      id: "issue-a",
      gateId: "gate-placeholders",
      severity: "blocker",
      category: "content",
      artifact: "pdr",
      message: "Placeholder text detected.",
      remediation: "Replace placeholders with concrete content.",
      location: { kind: "heading", heading: "Scope", path: "/tmp/pdr.md" },
    };
    const issueB: ReviewIssue = {
      id: "issue-b",
      gateId: "gate-openapi",
      severity: "low",
      category: "api",
      artifact: "openapi",
      message: "Missing response schema.",
      remediation: "Add response schema for 200 OK.",
      location: { kind: "line_range", path: "/tmp/openapi.yaml", lineStart: 12, lineEnd: 18 },
    };

    const gateResults: ReviewGateResult[] = [
      { gateId: "gate-placeholders", gateName: "Placeholders", status: "fail", issues: [issueA] },
      { gateId: "gate-openapi", gateName: "OpenAPI", status: "warn", issues: [issueB] },
      { gateId: "gate-consistency", gateName: "Consistency", status: "pass", issues: [] },
    ];

    const summary = summarizeGateResults(gateResults);
    assert.equal(summary.status, "fail");
    assert.equal(summary.issueCount, 2);
    assert.equal(summary.severityCounts.blocker, 1);
    assert.equal(summary.severityCounts.low, 1);
    assert.equal(summary.gateCounts.fail, 1);
    assert.equal(summary.gateCounts.warn, 1);
    assert.equal(summary.gateCounts.pass, 1);

    const outcome = aggregateReviewOutcome({
      gateResults,
      remainingOpenItems: [issueA],
      fixesApplied: [{ issueId: issueB.id, summary: "Added schema", appliedAt: "2024-01-01T00:00:00.000Z" }],
      decisions: [
        {
          id: "decision-1",
          summary: "Use canonical prefix /api/v1",
          rationale: "Matches OpenAPI spec",
          decidedAt: "2024-01-01T00:00:00.000Z",
          relatedIssueIds: [issueB.id],
        },
      ],
      generatedAt: "2024-01-02T00:00:00.000Z",
    });

    assert.equal(outcome.version, 1);
    assert.equal(outcome.issues[0].id, "issue-a");
    assert.equal(outcome.remainingOpenItems.length, 1);
    assert.equal(outcome.fixesApplied.length, 1);
    assert.equal(outcome.decisions.length, 1);
    assert.equal(outcome.summary.status, "fail");
  });
});

describe("ReviewReportSchema", () => {
  it("supports no-findings reports and max-iteration failures", () => {
    const emptyGates: ReviewGateResult[] = [];
    const emptySummary = summarizeGateResults(emptyGates);
    const noFindings = validateReviewReport({
      version: 1,
      generatedAt: "2024-01-01T00:00:00.000Z",
      iteration: { current: 1, max: 3, status: "completed" },
      status: emptySummary.status,
      summary: emptySummary,
      gateResults: emptyGates,
      issues: [],
      remainingOpenItems: [],
      fixesApplied: [],
      decisions: [],
      deltas: [],
    });
    assert.equal(noFindings.summary.issueCount, 0);

    const issue: ReviewIssue = {
      id: "issue-max",
      gateId: "gate-build-ready",
      severity: "high",
      category: "completeness",
      artifact: "sds",
      message: "Missing deployment blueprint.",
      remediation: "Generate deployment blueprint for the service.",
      location: { kind: "heading", heading: "Deployment", path: "/tmp/sds.md" },
    };
    const gates: ReviewGateResult[] = [
      { gateId: "gate-build-ready", gateName: "Build Ready", status: "fail", issues: [issue] },
    ];
    const summary = summarizeGateResults(gates);
    const maxIterations = validateReviewReport({
      version: 1,
      generatedAt: "2024-01-02T00:00:00.000Z",
      iteration: { current: 3, max: 3, status: "max_iterations" },
      status: summary.status,
      summary,
      gateResults: gates,
      issues: [issue],
      remainingOpenItems: [issue],
      fixesApplied: [],
      decisions: [],
      deltas: [],
    });

    const serialized = serializeReviewReport(maxIterations);
    assert.match(serialized, /max_iterations/);
    assert.match(serialized, /build-ready/i);
  });

  it("throws on missing required fields before serialization", () => {
    assert.throws(() => serializeReviewReport({ version: 1 } as any), /generatedAt/);
  });
});

describe("ReviewReportRenderer", () => {
  it("renders a deterministic markdown summary", () => {
    const issuePdr: ReviewIssue = {
      id: "issue-pdr",
      gateId: "gate-placeholder",
      severity: "medium",
      category: "content",
      artifact: "pdr",
      message: "Placeholder detected.",
      remediation: "Replace placeholder.",
      location: { kind: "heading", heading: "Scope", path: "/tmp/pdr.md" },
    };
    const issueApi: ReviewIssue = {
      id: "issue-api",
      gateId: "gate-openapi",
      severity: "low",
      category: "api",
      artifact: "openapi",
      message: "Missing schema.",
      remediation: "Add schema.",
      location: { kind: "line_range", path: "/tmp/openapi.yaml", lineStart: 10, lineEnd: 12 },
    };
    const gates: ReviewGateResult[] = [
      { gateId: "gate-openapi", gateName: "OpenAPI", status: "warn", issues: [issueApi] },
      { gateId: "gate-placeholder", gateName: "Placeholder", status: "fail", issues: [issuePdr] },
    ];
    const summary = summarizeGateResults(gates);
    const report = validateReviewReport({
      version: 1,
      generatedAt: "2024-01-03T00:00:00.000Z",
      iteration: { current: 1, max: 2, status: "in_progress" },
      status: summary.status,
      summary,
      gateResults: gates,
      issues: [issuePdr, issueApi],
      remainingOpenItems: [issuePdr],
      fixesApplied: [],
      decisions: [],
      deltas: [
        { artifact: "pdr", path: "/tmp/pdr.md", summary: "Updated scope section" },
        { artifact: "openapi", path: "/tmp/openapi.yaml", summary: "Added response schema" },
      ],
    });

    const output = renderReviewReport(report);
    assert.match(output, /# Docgen Review Report/);
    assert.match(output, /## Summary/);
    assert.match(output, /Iteration: 1\/2 \(in_progress\)/);
    assert.ok(output.indexOf("### pdr") < output.indexOf("### openapi"));
    assert.match(output, /Cross-Document Deltas/);
  });
});

describe("Glossary", () => {
  it("formats glossary entries consistently for prompts", () => {
    const customGlossary: GlossaryData = {
      version: 1,
      entries: [
        {
          key: "api_gateway",
          term: "API gateway",
          description: "Routes inbound traffic to backend services",
          aliases: ["gateway", "edge proxy"],
        },
      ],
      canonicalPhrases: { routing: "API gateway routing rules" },
    };

    const entry = getGlossaryEntry("api_gateway", customGlossary);
    assert.equal(entry?.term, "API gateway");

    const output = formatGlossaryForPrompt(customGlossary);
    assert.match(output, /Glossary \(canonical terminology\)/);
    assert.match(output, /API gateway: Routes inbound traffic to backend services\./);
    assert.match(output, /Aliases: gateway, edge proxy/);
  });

  it("loads overrides and falls back to the default glossary when missing", async () => {
    const overrideGlossary: GlossaryData = {
      version: 1,
      entries: [
        {
          key: "token",
          term: "token",
          description: "Ephemeral credential for request authorization",
        },
      ],
      canonicalPhrases: { token: "short-lived token" },
    };
    const overridePath = path.join(
      os.tmpdir(),
      `mcoda-glossary-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );

    await fs.writeFile(overridePath, JSON.stringify(overrideGlossary), "utf8");

    const loaded = loadGlossary(overridePath);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].term, "token");

    const fallback = loadGlossary(`/nonexistent/${Date.now()}.json`);
    assert.ok(fallback.entries.length > 0);
  });
});

describe("PlaceholderArtifactGate", () => {
  it("detects placeholders and template artifacts with locations", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-placeholder-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await writeFixture("pdr/placeholder.md", pdrPath);
    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPlaceholderArtifactGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.equal(result.issues.length, 2);
      const placeholderIssue = result.issues.find((issue) =>
        String(issue.metadata?.matchedText ?? "").toUpperCase().includes("TBD"),
      );
      const templateIssue = result.issues.find(
        (issue) => issue.metadata?.placeholderType === "template_artifact",
      );
      assert.ok(placeholderIssue);
      assert.ok(templateIssue);
      assert.equal(placeholderIssue?.location.kind, "line_range");
      assert.equal((placeholderIssue?.location as any).lineStart, 3);
      assert.equal((templateIssue?.location as any).lineStart, 5);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("respects allowlist overrides", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-placeholder-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Scope\nTBD: allowed example\n", "utf8");
    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPlaceholderArtifactGate({
        artifacts,
        allowlist: ["TBD: allowed example"],
      });
      assert.equal(result.status, "pass");
      assert.equal(result.issues.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("ApiPathConsistencyGate", () => {
  it("flags prefix mismatches and doc/openapi gaps", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-api-paths-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    await Promise.all([
      writeFixture("pdr/api-paths.md", pdrPath),
      writeFixture("sds/api-paths.md", sdsPath),
      writeFixture("openapi/prefix-mismatch.yaml", openapiPath),
    ]);

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [],
    };

    try {
      const result = await runApiPathConsistencyGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.equal((result.metadata as any)?.canonicalPrefix, "/api/v1");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "prefix_mismatch"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "doc_missing_openapi"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "openapi_missing_docs"),
      );
      assert.ok(
        !result.issues.some((issue) => String(issue.message).includes("/api/v9/ignore")),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the most frequent prefix when OpenAPI is missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-api-paths-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await writeFixture("pdr/api-paths-no-openapi.md", pdrPath);

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runApiPathConsistencyGate({ artifacts });
      assert.equal((result.metadata as any)?.canonicalPrefix, "/api/v1");
      assert.ok(result.notes?.some((note) => note.includes("OpenAPI spec not found")));
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "prefix_mismatch"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("OpenApiCoverageGate", () => {
  it("flags mismatches between docs and OpenAPI coverage", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-openapi-coverage-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    await Promise.all([
      writeFixture("pdr/openapi-coverage.md", pdrPath),
      writeFixture("sds/openapi-coverage.md", sdsPath),
      writeFixture("openapi/coverage.yaml", openapiPath),
    ]);

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [],
    };

    try {
      const result = await runOpenApiCoverageGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "doc_missing_openapi"),
      );
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "openapi_missing_docs",
        ),
      );
      assert.ok(
        !result.issues.some((issue) => String(issue.message).includes("/api/v1/ignore")),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when interface lists align with OpenAPI paths", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-openapi-coverage-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    const pdrContent = [
      "# PDR",
      "## Interfaces",
      "- GET /api/v1/users",
      "- POST /api/v1/orders",
    ].join("\n");
    const openapiContent = [
      "openapi: 3.1.0",
      "info:",
      "  title: Demo API",
      "  version: 0.1.0",
      "paths:",
      "  /api/v1/users:",
      "    get:",
      "      responses:",
      "        '200':",
      "          description: ok",
      "  /api/v1/orders:",
      "    post:",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n");

    await Promise.all([
      fs.writeFile(pdrPath, pdrContent, "utf8"),
      fs.writeFile(openapiPath, openapiContent, "utf8"),
    ]);

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [],
    };

    try {
      const result = await runOpenApiCoverageGate({ artifacts });
      assert.equal(result.status, "pass");
      assert.equal(result.issues.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SqlSyntaxGate", () => {
  it("flags prose lines and unterminated SQL statements", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sql-syntax-"));
    const sqlPath = path.join(workspaceRoot, "schema.sql");
    await writeFixture("sql/invalid.sql", sqlPath);

    const artifacts: DocgenArtifactInventory = {
      sql: { kind: "sql", path: sqlPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSqlSyntaxGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(result.issues.some((issue) => issue.metadata?.issueType === "prose"));
      assert.ok(result.issues.some((issue) => issue.metadata?.issueType === "unterminated"));
      const proseIssue = result.issues.find((issue) => issue.metadata?.issueType === "prose");
      assert.equal((proseIssue?.location as any)?.lineStart, 5);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes for valid SQL", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sql-syntax-"));
    const sqlPath = path.join(workspaceRoot, "schema.sql");
    const sqlContent = [
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY,",
      "  name TEXT NOT NULL",
      ");",
      "CREATE INDEX idx_users_name ON users(name);",
      "PRAGMA foreign_keys = ON;",
    ].join("\n");
    await fs.writeFile(sqlPath, sqlContent, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sql: { kind: "sql", path: sqlPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSqlSyntaxGate({ artifacts });
      assert.equal(result.status, "pass");
      assert.equal(result.issues.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SqlRequiredTablesGate", () => {
  it("flags missing tables and incorrect FK naming", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sql-required-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const sqlPath = path.join(workspaceRoot, "schema.sql");
    await Promise.all([
      writeFixture("sds/sql-missing-tables.md", sdsPath),
      writeFixture("sql/missing-tables.sql", sqlPath),
    ]);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      sql: { kind: "sql", path: sqlPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSqlRequiredTablesGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.metadata?.issueType === "missing_table" &&
            issue.metadata?.table === "data_export_artifacts",
        ),
      );
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.metadata?.issueType === "missing_table" &&
            issue.metadata?.table === "admin_audit_log",
        ),
      );
      assert.ok(
        result.issues.some(
          (issue) =>
            issue.metadata?.issueType === "missing_table" &&
            issue.metadata?.table === "event_outbox",
        ),
      );
      assert.ok(result.issues.some((issue) => issue.metadata?.issueType === "fk_naming"));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when required tables exist with correct FK names", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sql-required-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const sqlPath = path.join(workspaceRoot, "schema.sql");
    const sdsContent = [
      "# SDS",
      "Data export jobs and artifacts are supported.",
      "Rights policy enforcement is required.",
      "Admin audit log tracks admin actions.",
      "Event outbox publishes integration events.",
    ].join("\n");
    const sqlContent = [
      "CREATE TABLE rights_policies (",
      "  id INTEGER PRIMARY KEY",
      ");",
      "CREATE TABLE data_export_jobs (",
      "  id INTEGER PRIMARY KEY",
      ");",
      "CREATE TABLE data_export_artifacts (",
      "  id INTEGER PRIMARY KEY",
      ");",
      "CREATE TABLE admin_audit_log (",
      "  id INTEGER PRIMARY KEY",
      ");",
      "CREATE TABLE event_outbox (",
      "  id INTEGER PRIMARY KEY",
      ");",
      "CREATE TABLE rights_policy_links (",
      "  id INTEGER PRIMARY KEY,",
      "  rights_policy_id INTEGER",
      ");",
    ].join("\n");

    await Promise.all([
      fs.writeFile(sdsPath, sdsContent, "utf8"),
      fs.writeFile(sqlPath, sqlContent, "utf8"),
    ]);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      sql: { kind: "sql", path: sqlPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSqlRequiredTablesGate({ artifacts });
      assert.equal(result.status, "pass");
      assert.equal(result.issues.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("TerminologyNormalizationGate", () => {
  it("flags non-canonical aliases with replacements", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-terminology-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await writeFixture("pdr/terminology-aliases.md", pdrPath);

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runTerminologyNormalizationGate({ artifacts });
      assert.equal(result.status, "warn");
      assert.ok(result.issues.length >= 3);
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.canonicalTerm) === "consent token"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.canonicalTerm) === "anonymous token"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.canonicalTerm) === "policy owner"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("detects contradictory canonical terms", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-terminology-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    await writeFixture("sds/terminology-contradiction.md", sdsPath);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runTerminologyNormalizationGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "contradiction"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("OpenQuestionsGate", () => {
  it("extracts explicit and implicit questions with deduping", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-open-questions-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const content = [
      "# PDR",
      "## Open Questions",
      "- What is the consent token TTL?",
      "- What is the consent token TTL?",
      "## Scope",
      "Should we support batch imports?",
      "TBD: Decide on API rate limits.",
    ].join("\n");
    await fs.writeFile(pdrPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runOpenQuestionsGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.equal((result.metadata as any)?.requiredCount >= 1, true);
      assert.ok((result.metadata as any)?.questionCount <= 3);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("marks optional explorations without failing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-open-questions-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Considerations",
      "Optional: should we add a dashboard?",
      "Maybe explore a future mobile client.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runOpenQuestionsGate({ artifacts });
      assert.equal(result.status, "warn");
      assert.equal((result.metadata as any)?.requiredCount, 0);
      assert.ok((result.metadata as any)?.optionalCount >= 1);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("NoMaybesGate", () => {
  it("skips when disabled", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-no-maybes-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Architecture\nMaybe use Redis.\n", "utf8");
    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };
    try {
      const result = await runNoMaybesGate({ artifacts, enabled: false });
      assert.equal(result.status, "skipped");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags indecisive language in decision sections and ignores options", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-no-maybes-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Architecture",
      "We might use Redis for caching.",
      "## Options Considered",
      "We could use Memcached instead.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");
    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };
    try {
      const result = await runNoMaybesGate({ artifacts, enabled: true });
      assert.equal(result.status, "fail");
      assert.equal(result.issues.length, 1);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("BuildReadyCompletenessGate", () => {
  it("fails build-ready runs when required artifacts are missing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-build-ready-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const sdsPath = path.join(workspaceRoot, "sds.md");
    await fs.writeFile(pdrPath, "# PDR\n## Scope\n## Interfaces\n", "utf8");
    await fs.writeFile(sdsPath, "# SDS\n## Architecture\n## Operations\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runBuildReadyCompletenessGate({ artifacts, buildReady: true });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_artifact"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.required) === "openapi"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("warns (but does not fail) when build-ready is false", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-build-ready-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Scope\n## Interfaces\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runBuildReadyCompletenessGate({ artifacts, buildReady: false });
      assert.equal(result.status, "warn");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags missing structural sections even when artifacts exist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-build-ready-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    const sqlPath = path.join(workspaceRoot, "schema.sql");
    const envPath = path.join(workspaceRoot, ".env.example");
    const composePath = path.join(workspaceRoot, "docker-compose.yml");

    await fs.writeFile(pdrPath, "# PDR\n## Scope\n", "utf8");
    await fs.writeFile(sdsPath, "# SDS\n## Architecture\n## Operations\n", "utf8");
    await fs.writeFile(openapiPath, "openapi: 3.1.0\npaths:\n  /health:\n    get:\n      responses:\n        '200':\n          description: ok\n", "utf8");
    await fs.writeFile(sqlPath, "create table widgets (id int);\n", "utf8");
    await fs.writeFile(envPath, "PORT=3000\n", "utf8");
    await fs.writeFile(composePath, "services:\n  app:\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      sql: { kind: "sql", path: sqlPath, meta: {} },
      blueprints: [
        { kind: "deployment", path: envPath, meta: {} },
        { kind: "deployment", path: composePath, meta: {} },
      ],
    };

    try {
      const result = await runBuildReadyCompletenessGate({ artifacts, buildReady: true });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_heading"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("DeploymentBlueprintGate", () => {
  it("flags missing env mapping, dependency mismatch, and port mismatch", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-blueprint-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    const envPath = path.join(workspaceRoot, ".env.example");
    const envDocPath = path.join(workspaceRoot, "env-secrets.md");
    const composePath = path.join(workspaceRoot, "docker-compose.yml");

    await Promise.all([
      writeFixture("sds/deployment-blueprint.md", sdsPath),
      writeFixture("openapi/deployment-openapi.yaml", openapiPath),
      writeFixture("deployment/.env.example", envPath),
      writeFixture("deployment/env-secrets.md", envDocPath),
      writeFixture("deployment/docker-compose.yml", composePath),
    ]);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [
        { kind: "deployment", path: envPath, meta: {} },
        { kind: "deployment", path: envDocPath, meta: {} },
        { kind: "deployment", path: composePath, meta: {} },
      ],
    };

    try {
      const result = await runDeploymentBlueprintGate({ artifacts, buildReady: true });
      assert.equal(result.status, "fail");
      const issueTypes = new Set(result.issues.map((issue) => String(issue.metadata?.issueType)));
      assert.ok(issueTypes.has("missing_env_example"));
      assert.ok(issueTypes.has("missing_env_documentation"));
      assert.ok(issueTypes.has("missing_dependency"));
      assert.ok(issueTypes.has("port_mismatch"));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when env mapping and dependencies align", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-blueprint-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    const envPath = path.join(workspaceRoot, ".env.example");
    const envDocPath = path.join(workspaceRoot, "env-secrets.md");
    const composePath = path.join(workspaceRoot, "docker-compose.yml");

    await fs.writeFile(
      sdsPath,
      ["# SDS", "## Architecture", "We use MySQL and Redis for storage."].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      openapiPath,
      [
        "openapi: 3.1.0",
        "servers:",
        "  - url: http://localhost:8080",
        "paths:",
        "  /health:",
        "    get:",
        "      responses:",
        "        '200':",
        "          description: ok",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "SERVICE_PORT=8080",
        "DATABASE_URL=mysql://app:change-me@mysql:3306/app",
        "REDIS_URL=redis://redis:6379",
        "MYSQL_DATABASE=app",
        "MYSQL_USER=app",
        "MYSQL_PASSWORD=change-me",
        "MYSQL_ROOT_PASSWORD=change-me",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      envDocPath,
      [
        "# Deployment Environment Variables",
        "",
        "| Name | Secret | Used By | Description |",
        "| --- | --- | --- | --- |",
        "| SERVICE_PORT | No | app | Port |",
        "| DATABASE_URL | Yes | app | MySQL connection |",
        "| REDIS_URL | No | app | Redis connection |",
        "| MYSQL_DATABASE | No | mysql | Database name |",
        "| MYSQL_USER | No | mysql | Database user |",
        "| MYSQL_PASSWORD | Yes | mysql | Database password |",
        "| MYSQL_ROOT_PASSWORD | Yes | mysql | Root password |",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      composePath,
      [
        'version: "3.9"',
        "services:",
        "  app:",
        "    image: app",
        "    environment:",
        '      DATABASE_URL: "${DATABASE_URL}"',
        '      REDIS_URL: "${REDIS_URL}"',
        "    ports:",
        '      - "${SERVICE_PORT}:${SERVICE_PORT}"',
        "  mysql:",
        "    image: mysql:8",
        "    environment:",
        '      MYSQL_DATABASE: "${MYSQL_DATABASE}"',
        '      MYSQL_USER: "${MYSQL_USER}"',
        '      MYSQL_PASSWORD: "${MYSQL_PASSWORD}"',
        '      MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD}"',
        "  redis:",
        "    image: redis:7",
        "",
      ].join("\n"),
      "utf8",
    );

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [
        { kind: "deployment", path: envPath, meta: {} },
        { kind: "deployment", path: envDocPath, meta: {} },
        { kind: "deployment", path: composePath, meta: {} },
      ],
    };

    try {
      const result = await runDeploymentBlueprintGate({ artifacts, buildReady: true });
      assert.equal(result.status, "pass");
      assert.equal(result.issues.length, 0);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("RfpConsentGate", () => {
  it("flags over-broad retention when minimization is declared", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-rfp-consent-"));
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    const content = [
      "# RFP",
      "## Data Handling",
      "We follow data minimization for user requests.",
      "Store all interactions for analytics.",
    ].join("\n");
    await fs.writeFile(rfpPath, content, "utf8");

    try {
      const result = await runRfpConsentGate({ rfpPath });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "overbroad_statement"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("detects anonymous vs identified handling contradictions", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-rfp-consent-"));
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    const content = [
      "# RFP",
      "## Tokens",
      "Anonymous token flow is required for privacy.",
      "User id is stored for billing.",
    ].join("\n");
    await fs.writeFile(rfpPath, content, "utf8");

    try {
      const result = await runRfpConsentGate({ rfpPath });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "anon_ident_contradiction",
        ),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("RfpDefinitionGate", () => {
  it("flags undefined referenced terms", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-rfp-defs-"));
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    const content = [
      "# RFP",
      "## Definitions",
      "- **Consent Token**: token issued at install time.",
      "## Scope",
      "We will issue a **Consent Token** for onboarding.",
      "Attestation requirements are described in **Attestation** policy.",
    ].join("\n");
    await fs.writeFile(rfpPath, content, "utf8");

    try {
      const result = await runRfpDefinitionGate({ rfpPath });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "undefined_term"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.term).toLowerCase().includes("attestation")),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("warns when definitions section is missing but terms are referenced", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-rfp-defs-"));
    const rfpPath = path.join(workspaceRoot, "rfp.md");
    const content = [
      "# RFP",
      "## Security",
      "All requests are logged in the **Audit Log** system.",
    ].join("\n");
    await fs.writeFile(rfpPath, content, "utf8");

    try {
      const result = await runRfpDefinitionGate({ rfpPath });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "missing_definitions_section",
        ),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("PdrInterfacesGate", () => {
  it("flags missing interfaces and pipeline sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-interfaces-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Scope\nOverview only.\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrInterfacesGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_interfaces"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_pipeline"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("detects interface/OpenAPI mismatches and missing pipeline details", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-interfaces-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const openapiPath = path.join(workspaceRoot, "openapi.yaml");
    const pdrContent = [
      "# PDR",
      "## Interfaces",
      "This service exposes endpoints for client usage.",
      "## Data Pipeline",
      "We process data through a pipeline.",
    ].join("\n");
    await fs.writeFile(pdrPath, pdrContent, "utf8");
    await fs.writeFile(openapiPath, "openapi: 3.1.0\npaths:\n  /api/v1/health:\n    get:\n      responses:\n        '200':\n          description: ok\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [{ kind: "openapi", path: openapiPath, meta: {} }],
      blueprints: [],
    };

    try {
      const result = await runPdrInterfacesGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "interfaces_missing_paths",
        ),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_landing_zones"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_ownership"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when interfaces and pipeline details are present", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-interfaces-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const pdrContent = [
      "# PDR",
      "## Interfaces",
      "- GET /api/v1/health",
      "- POST /api/v1/consent",
      "## Pipeline",
      "Data flows into a raw landing zone, then staging, then warehouse.",
      "Normalization rules are owned by the policy owner.",
    ].join("\n");
    await fs.writeFile(pdrPath, pdrContent, "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrInterfacesGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("PdrOwnershipGate", () => {
  it("flags missing ownership and consent flow sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-ownership-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Scope\nOverview only.\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrOwnershipGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "missing_ownership_section",
        ),
      );
      assert.ok(
        result.issues.some(
          (issue) => String(issue.metadata?.issueType) === "missing_consent_flow",
        ),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags missing TTL/revoke and non-canonical consent terms", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-ownership-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const content = [
      "# PDR",
      "## Ownership",
      "Policy steward approves cache rules.",
      "## Consent Flow",
      "Consent id is issued during install.",
    ].join("\n");
    await fs.writeFile(pdrPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrOwnershipGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_ttl"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_revoke"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "noncanonical_term"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("PdrOpenQuestionsGate", () => {
  it("skips when disabled", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-questions-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    await fs.writeFile(pdrPath, "# PDR\n## Open Questions\n- What is the timeline?\n", "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrOpenQuestionsGate({ artifacts, enabled: false });
      assert.equal(result.status, "skipped");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags generic open questions without domain terms", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-questions-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const content = [
      "# PDR",
      "## Open Questions",
      "- What is the timeline?",
      "- What are the risks?",
    ].join("\n");
    await fs.writeFile(pdrPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrOpenQuestionsGate({ artifacts, enabled: true });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "generic_question"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when open questions reference domain terms", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-pdr-questions-"));
    const pdrPath = path.join(workspaceRoot, "pdr.md");
    const content = [
      "# PDR",
      "## Open Questions",
      "- What is the consent token TTL for install-time issuance?",
    ].join("\n");
    await fs.writeFile(pdrPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      pdr: { kind: "pdr", path: pdrPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runPdrOpenQuestionsGate({ artifacts, enabled: true });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SdsDecisionsGate", () => {
  it("flags ambiguous choices in decision sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-decisions-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Architecture",
      "We will use Redis or Memcached for caching.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsDecisionsGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "ambiguous_decision"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("ignores options considered sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-decisions-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Options Considered",
      "Redis or Memcached are possible choices.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsDecisionsGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when decisions are explicit", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-decisions-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Architecture",
      "We will use Redis for caching.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsDecisionsGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SdsPolicyTelemetryGate", () => {
  it("flags missing policy, telemetry, and metering sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-policy-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    await writeFixture("sds/missing-sections.md", sdsPath);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsPolicyTelemetryGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_policy"));
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_telemetry"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_metering"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when policy, telemetry, and metering details exist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-policy-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Cache Policy",
      "Cache key policy and TTL tiers with consent matrix.",
      "## Telemetry",
      "Telemetry schema for anonymous and identified events.",
      "## Metering",
      "Usage metering with rate limits and enforcement rules.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsPolicyTelemetryGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SdsOpsGate", () => {
  it("flags missing ops, observability, testing, and failure sections", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-ops-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    await writeFixture("sds/missing-sections.md", sdsPath);

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsOpsGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_ops"));
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_observability"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_testing"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_failure"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when ops, observability, testing, and failure details exist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-ops-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Operations",
      "Environment strategy covers staging and production. Secrets are managed in a vault. Deploy via pipeline.",
      "## Observability",
      "SLOs are 99.9% uptime with alert thresholds for latency.",
      "## Testing",
      "Test gates include unit validation and integration suites.",
      "## Failure Modes",
      "Failure recovery and rollback steps are documented.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsOpsGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("SdsAdaptersGate", () => {
  it("flags external references without adapter section", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-adapters-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## Architecture",
      "We use Brave Search for discovery and OpenRouter for model routing.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsAdaptersGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.service) === "Brave"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.service) === "OpenRouter"),
      );
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_adapter_section"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("flags missing adapter detail coverage", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-adapters-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## External Integrations",
      "Brave adapter handles search requests.",
      "OpenRouter adapter brokers model calls.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsAdaptersGate({ artifacts });
      assert.equal(result.status, "fail");
      assert.ok(
        result.issues.some((issue) => String(issue.metadata?.issueType) === "missing_adapter_details"),
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("passes when adapter constraints, error handling, and fallback are described", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-sds-adapters-"));
    const sdsPath = path.join(workspaceRoot, "sds.md");
    const content = [
      "# SDS",
      "## External Integrations",
      "Brave adapter uses API keys with rate limits and timeouts.",
      "OpenRouter adapter enforces auth tokens and SLA constraints.",
      "On error we retry with backoff and emit circuit-breaker alerts.",
      "Fallback uses a secondary provider when Brave or OpenRouter is unavailable.",
    ].join("\n");
    await fs.writeFile(sdsPath, content, "utf8");

    const artifacts: DocgenArtifactInventory = {
      sds: { kind: "sds", path: sdsPath, meta: {} },
      openapi: [],
      blueprints: [],
    };

    try {
      const result = await runSdsAdaptersGate({ artifacts });
      assert.equal(result.status, "pass");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
