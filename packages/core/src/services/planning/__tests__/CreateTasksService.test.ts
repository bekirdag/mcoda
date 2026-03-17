import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { CreateTasksService } from "../CreateTasksService.js";
import { SdsPreflightService } from "../SdsPreflightService.js";
import { TaskSufficiencyService } from "../TaskSufficiencyService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { createEpicKeyGenerator, createStoryKeyGenerator, createTaskKeyGenerator } from "../KeyHelpers.js";
import { PathHelper } from "@mcoda/shared";

let workspaceRoot: string;
let workspace: WorkspaceResolution;
let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;
let originalSdsPreflightCreate: typeof SdsPreflightService.create;
let originalTaskSufficiencyCreate: typeof TaskSufficiencyService.create;

const buildPassingPreflightResult = (sourceSdsPaths: string[]) => ({
  projectKey: "web",
  generatedAt: new Date().toISOString(),
  readyForPlanning: true,
  qualityStatus: "pass",
  sourceSdsPaths,
  reportPath: path.join(workspace.mcodaDir, "tasks", "web", "sds-preflight-report.json"),
  openQuestionsPath: undefined,
  gapAddendumPath: undefined,
  generatedDocPaths: [] as string[],
  questionCount: 0,
  requiredQuestionCount: 0,
  issueCount: 0,
  blockingIssueCount: 0,
  issues: [],
  questions: [],
  warnings: [] as string[],
  appliedToSds: false,
  appliedSdsPaths: [] as string[],
  commitHash: undefined as string | undefined,
});

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-create-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-test-"));
  workspace = {
    workspaceRoot,
    workspaceId: workspaceRoot,
    mcodaDir: PathHelper.getWorkspaceDir(workspaceRoot),
    id: workspaceRoot,
    legacyWorkspaceIds: [],
    workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
    globalDbPath: PathHelper.getGlobalDbPath(),
  };
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Folder Tree",
      "```text",
      ".",
      "├── docs/                  # documentation and runbooks",
      "├── apps/web/              # web interface",
      "├── services/api/          # HTTP API service",
      "├── services/worker/       # background workflows",
      "├── packages/shared/       # shared contracts and types",
      "├── db/migrations/         # database migrations",
      "├── tests/unit/            # unit tests",
      "└── scripts/               # build and release scripts",
      "```",
      "## Technology Stack",
      "Chosen stack: Node.js runtime, TypeScript language, PostgreSQL persistence, pnpm tooling.",
      "Alternatives considered: Python + FastAPI for backend orchestration.",
      "Rationale and trade-off: we prioritize unified TypeScript contracts over polyglot flexibility because it reduces integration drift.",
      "## Policy and Cache Consent",
      "Cache key policy: tenant_id + project_key + route + role.",
      "TTL tiers: hot=5m, warm=30m, cold=24h.",
      "Consent matrix: anonymous telemetry for usage counts, identified telemetry only with explicit opt-in.",
      "## Telemetry",
      "Telemetry schema includes anonymous event_name + timestamp and identified actor_id + request_id envelopes.",
      "## Metering and Usage",
      "Usage meter tracks request units and compute units.",
      "Rate limit and limit enforcement block requests and return deterministic retry windows.",
      "## Operations and Deployment",
      "Environment matrix: local, staging, production.",
      "Secrets strategy uses environment-scoped secret stores.",
      "Deployment workflow runs immutable build artifacts with migration checks.",
      "## Observability",
      "SLO: 99.9% availability target with p95 latency threshold of 300ms.",
      "Alert thresholds trigger paging on error-rate and saturation breaches.",
      "## Testing Gates",
      "Test gates require unit, integration, and validation coverage before release promotion.",
      "## Failure Recovery and Rollback",
      "Failure modes are documented with recovery runbooks and rollback steps per deployment wave.",
    ].join("\n"),
    "utf8",
  );

  originalSdsPreflightCreate = SdsPreflightService.create;
  (SdsPreflightService as any).create = async () =>
    new StubSdsPreflightService(buildPassingPreflightResult([path.join(workspaceRoot, "docs", "sds.md")])) as any;

  originalTaskSufficiencyCreate = TaskSufficiencyService.create;
  (TaskSufficiencyService as any).create = async () => new StubTaskSufficiencyService() as any;
});

afterEach(async () => {
  if (workspaceRoot) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
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
  (SdsPreflightService as any).create = originalSdsPreflightCreate;
  (TaskSufficiencyService as any).create = originalTaskSufficiencyCreate;
});

const fakeDoc = {
  id: "doc-1",
  docType: "SDS",
  content: "Sample content",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  segments: [{ id: "seg-1", docId: "doc-1", index: 0, content: "Segment content" }],
};

const EP_SDS_FIXTURE = [
  "# Software Design Specification",
  "## Folder Tree",
  "```text",
  ".",
  "├── foundry.toml",
  "├── contracts/",
  "│   ├── script/",
  "│   │   ├── DeployContracts.s.sol",
  "│   │   ├── UpgradeRegistry.s.sol",
  "│   │   └── ConfigurePolicies.s.sol",
  "│   └── src/",
  "│       └── IOraclePolicyRegistry.sol",
  "├── packages/",
  "│   ├── shared/",
  "│   │   └── src/",
  "│   │       └── index.ts",
  "│   ├── gatekeeper/",
  "│   │   └── src/",
  "│   │       └── worker.ts",
  "│   ├── oracle/",
  "│   │   └── src/",
  "│   │       └── oracle.ts",
  "│   └── terminal-client/",
  "│       └── src/",
  "│           └── main.ts",
  "└── ops/",
  "    └── systemd/",
  "        └── gatekeeper.service",
  "```",
  "## Deployment Waves",
  "1. Wave 0 - Artifact build: shared, contracts",
  "2. Wave 1 - Contract deployment: contracts, oracle",
  "3. Wave 2 - Runtime startup: gatekeeper, oracle",
  "4. Wave 3 - Terminal + operations: terminal client, ops",
  "## Gatekeeper Runtime",
  "packages/gatekeeper/src/worker.ts starts after contracts/script/ConfigurePolicies.s.sol finishes.",
  "## Registry Contracts",
  "Use IOraclePolicyRegistry.sol and ConfigurePolicies.s.sol as the canonical names.",
].join("\n");

const EP_RUNTIME_AND_VERIFICATION_FIXTURE = [
  "# Software Design Specification",
  "## Runtime Components",
  "1. Managed storage adapters: persist sanctioned and approved listing state.",
  "2. Read path: browse approved listings through the public query surface.",
  "3. Gatekeeper: consume events, moderation, and pricing providers.",
  "## Folder Tree",
  "```text",
  ".",
  "├── packages/gatekeeper/package.json",
  "├── packages/gatekeeper/src/providers.ts",
  "├── packages/gatekeeper/src/worker.ts",
  "├── packages/read-path/src/query.ts",
  "├── packages/storage-adapters/src/index.ts",
  "└── ops/systemd/gatekeeper.service",
  "```",
  "## Architectural Dependency Order",
  "- read path depends on managed storage adapters",
  "- gatekeeper depends on managed storage adapters",
  "## Verification Matrix",
  "| Verification Suite | Scope | Source Coverage |",
  "| --- | --- | --- |",
  "| Contract unit tests | fee quoting, lifecycle transitions | HR-01 |",
  "| Gatekeeper integration tests | event intake, finality, failover | HR-04 |",
  "| End-to-end acceptance tests | submit, approve, browse, reject | AT-01 to AT-44 |",
  "| Operations drills | signer rotation, policy rollback, replay from historical blocks | NFR-08 |",
  "## Required Acceptance Scenarios",
  "1. Minimal valid listing: `title` and `description` only, approved and rendered.",
  "2. Payload invalidation: missing `title` or `description`, rejected before publication.",
  "3. Image-cap failure: more than 10 images, rejected.",
  "4. KYT block: flagged wallet rejected before moderation spend.",
  "5. KYT outage: hold and retry, then reject after exhaustion.",
  "6. Moderation provider failover: primary fails, secondary succeeds.",
  "7. Gateway failover: first gateway fails, second succeeds.",
  "8. Pricing mismatch: final category is higher band than the declared class and rejects.",
  "9. Refund accounting: rejection refund obeys the locked fee tuple and `max_rejection_cost`.",
  "10. Creator removal: owner pays `1 USDT`, listing disappears immediately.",
  "11. Expiry enforcement: early expiration is honored exactly; any request above 180 days is rejected.",
  "12. Pricing version bump: stale cached pricing data is discarded and on-chain values win.",
  "13. Oracle rotation: old signer loses authority and new signer resolves backlog.",
  "14. Replay after restart: no duplicate or conflicting decision writes occur.",
].join("\n");

const EP_SUPPORT_DOC_NOISE_FIXTURE = [
  "# Supplemental Notes",
  "## Architecture Overview",
  "Quote/read and quote/getter are external glossary phrases, not repo paths.",
  "CID/gateway and AML/KYT describe provider pairs, not code modules.",
  "USD/TRY is a pricing notation and must not become a runtime surface.",
  "manifest.json and tsconfig.base.json are example config references only.",
  "## Storage Providers",
  "ops/scripts/verify-release.sh records deterministic release evidence.",
  "packages/gatekeeper-oracle/package.json is packaging metadata for a sidecar package.",
  "## Runtime Components",
  "1. Managed storage adapters: persist sanctioned and approved listing state.",
  "2. Read path: browse approved listings through the public query surface.",
  "3. Gatekeeper: consume events, moderation, and pricing providers.",
].join("\n");

const generatedPlanToAgentPlan = (plan: any) => ({
  epics: plan.epics.map((epic: any) => ({
    localId: epic.localId,
    area: epic.area,
    title: epic.title,
    description: epic.description,
    acceptanceCriteria: epic.acceptanceCriteria ?? [],
    relatedDocs: epic.relatedDocs ?? [],
    priorityHint: epic.priorityHint,
    serviceIds: epic.serviceIds ?? [],
    tags: epic.tags ?? [],
    stories: plan.stories
      .filter((story: any) => story.epicLocalId === epic.localId)
      .map((story: any) => ({
        localId: story.localId,
        title: story.title,
        userStory: story.userStory,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria ?? [],
        relatedDocs: story.relatedDocs ?? [],
        priorityHint: story.priorityHint,
        tasks: plan.tasks
          .filter((task: any) => task.epicLocalId === epic.localId && task.storyLocalId === story.localId)
          .map((task: any) => ({
            localId: task.localId,
            title: task.title,
            type: task.type,
            description: task.description,
            files: Array.isArray(task.metadata?.files)
              ? task.metadata.files
              : Array.isArray(task.files)
                ? task.files
                : [],
            estimatedStoryPoints: task.storyPoints ?? task.estimatedStoryPoints,
            priorityHint: task.priority,
            dependsOnKeys: task.dependsOnKeys ?? [],
            relatedDocs: task.relatedDocs ?? [],
            unitTests: task.unitTests ?? [],
            componentTests: task.componentTests ?? [],
            integrationTests: task.integrationTests ?? [],
            apiTests: task.apiTests ?? [],
          })),
      })),
  })),
});

const buildDefaultSdsDrivenAgentPlan = async (): Promise<any> => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const docs = await (service as any).prepareDocs([]);
  const sourceTopologyExpectation = (service as any).buildSourceTopologyExpectation(docs);
  const artifacts = (service as any).derivePlanningArtifacts(
    "web",
    docs,
    { epics: [], stories: [], tasks: [] },
    sourceTopologyExpectation,
  );
  return generatedPlanToAgentPlan((service as any).buildSdsDrivenPlan("web", docs, artifacts.architecture));
};

const agentPlanToStagedOutputs = (plan: any): string[] => {
  const outputs: string[] = [
    JSON.stringify({
      epics: plan.epics.map((epic: any) => ({
        localId: epic.localId,
        area: epic.area,
        title: epic.title,
        description: epic.description,
        acceptanceCriteria: epic.acceptanceCriteria ?? [],
        relatedDocs: epic.relatedDocs ?? [],
        priorityHint: epic.priorityHint,
        serviceIds: epic.serviceIds ?? [],
        tags: epic.tags ?? [],
      })),
    }),
  ];
  for (const epic of plan.epics) {
    outputs.push(
      JSON.stringify({
        stories: epic.stories.map((story: any) => ({
          localId: story.localId,
          title: story.title,
          userStory: story.userStory,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria ?? [],
          relatedDocs: story.relatedDocs ?? [],
          priorityHint: story.priorityHint,
        })),
      }),
    );
    for (const story of epic.stories) {
      outputs.push(
        JSON.stringify({
          tasks: story.tasks.map((task: any) => ({
            localId: task.localId,
            title: task.title,
            type: task.type,
            description: task.description,
            files: task.files ?? [],
            estimatedStoryPoints: task.estimatedStoryPoints,
            priorityHint: task.priorityHint,
            dependsOnKeys: task.dependsOnKeys ?? [],
            relatedDocs: task.relatedDocs ?? [],
            unitTests: task.unitTests ?? [],
            componentTests: task.componentTests ?? [],
            integrationTests: task.integrationTests ?? [],
            apiTests: task.apiTests ?? [],
            qa: task.qa ?? null,
          })),
        }),
      );
    }
  }
  return outputs;
};

class StubDocdex {
  registeredFiles: string[] = [];
  async fetchDocumentById(id: string) {
    return { ...fakeDoc, id };
  }
  async ensureRegisteredFromFile(filePath: string) {
    this.registeredFiles.push(path.resolve(filePath));
    return { ...fakeDoc, id: `doc-${this.registeredFiles.length}` };
  }
}

class StubDocdexTyped extends StubDocdex {
  async ensureRegisteredFromFile(filePath: string, docType?: string) {
    this.registeredFiles.push(path.resolve(filePath));
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    const content = await fs.readFile(filePath, "utf8");
    const isSdsByPath = /(^|\/)(sds|software[-_ ]design|design[-_ ]spec)/i.test(normalizedPath);
    const isSdsByContent = /\b(software design specification|system design specification|\bsds\b)\b/i.test(content);
    return {
      ...fakeDoc,
      id: `doc-${this.registeredFiles.length}`,
      docType: isSdsByPath || isSdsByContent ? "SDS" : (docType ?? "DOC"),
      path: filePath,
      title: path.basename(filePath),
      content,
    };
  }
}

class StubDocdexPathOnly extends StubDocdex {
  async ensureRegisteredFromFile(filePath: string, docType?: string) {
    this.registeredFiles.push(path.resolve(filePath));
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    return {
      ...fakeDoc,
      id: `doc-${this.registeredFiles.length}`,
      docType: /(^|\/)(sds|software[-_ ]design|design[-_ ]spec)/i.test(normalizedPath) ? "SDS" : (docType ?? "DOC"),
      path: filePath,
      title: path.basename(filePath),
      content: "",
      segments: [],
    };
  }
}

class StubDocdexMismatched extends StubDocdex {
  async ensureRegisteredFromFile(filePath: string, docType?: string) {
    this.registeredFiles.push(path.resolve(filePath));
    return {
      ...fakeDoc,
      id: "doc-mismatched",
      docType: docType ?? "DOC",
      path: "docs/requirements-implementation-tasks.md",
      title: "requirements-implementation-tasks.md",
      content: "mismatched docdex registration",
      segments: [],
    };
  }
}

class StubAgentService {
  private queue: Array<string | Error>;
  invocations: Array<{ input: string; metadata?: Record<string, unknown> }> = [];
  constructor(outputs: Array<string | Error>) {
    this.queue = [...outputs];
  }
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_agentId?: string, request?: { input?: string; metadata?: Record<string, unknown> }) {
    this.invocations.push({ input: request?.input ?? "", metadata: request?.metadata });
    const next = this.queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return { output: next ?? "" };
  }
}

class StubAgentServiceFailoverMetadata {
  private queue: string[];
  constructor(outputs: string[]) {
    this.queue = [...outputs];
  }
  async resolveAgent(identifier?: string) {
    if (identifier === "agent-fallback") {
      return {
        id: "agent-fallback",
        slug: "agent-fallback",
        adapter: "claude-cli",
        defaultModel: "sonnet",
      } as any;
    }
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke() {
    return {
      output: this.queue.shift() ?? "",
      metadata: {
        failoverEvents: [
          { type: "switch_agent", fromAgentId: "agent-1", toAgentId: "agent-fallback" },
        ],
      },
    };
  }
}

class StubRoutingService {
  private agent = { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  async resolveAgentForCommand() {
    return {
      agent: this.agent,
      agentId: this.agent.id,
      agentSlug: this.agent.slug,
      model: this.agent.defaultModel,
      capabilities: [],
      healthStatus: "healthy",
      source: "workspace_default",
      routingPreview: { workspaceId: workspace.workspaceId, commandName: "create-tasks" } as any,
    };
  }
}

class StubRepo {
  async getWorkspaceDefaults() {
    return [];
  }
  async close() {}
}

class StubWorkspaceRepo {
  projects: any[] = [];
  epics: any[] = [];
  stories: any[] = [];
  tasks: any[] = [];
  deps: any[] = [];
  taskRunCount = 0;
  taskQaRunCount = 0;
  taskCommentCount = 0;
  taskReviewCount = 0;
  taskRevisionCount = 0;
  taskLogCount = 0;
  storyTotals: Record<string, number | null> = {};
  epicTotals: Record<string, number | null> = {};
  lastOrderRequest: any;
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async createProjectIfMissing(input: any) {
    const existing = this.projects.find((p) => p.key === input.key);
    if (existing) return existing;
    const row = { id: `p-${this.projects.length + 1}`, ...input };
    this.projects.push(row);
    return row;
  }
  async deleteProjectBacklog(projectId: string) {
    const epicIds = new Set(this.epics.filter((epic) => epic.projectId === projectId).map((epic) => epic.id));
    const storyIds = new Set(
      this.stories
        .filter((story) => story.projectId === projectId || epicIds.has(story.epicId))
        .map((story) => story.id),
    );
    const taskIds = new Set(
      this.tasks
        .filter((task) => task.projectId === projectId || storyIds.has(task.userStoryId) || epicIds.has(task.epicId))
        .map((task) => task.id),
    );
    this.epics = this.epics.filter((epic) => !epicIds.has(epic.id));
    this.stories = this.stories.filter((story) => !storyIds.has(story.id));
    this.tasks = this.tasks.filter((task) => !taskIds.has(task.id));
    this.deps = this.deps.filter((dep) => !taskIds.has(dep.taskId) && !taskIds.has(dep.dependsOnTaskId));
  }
  async listEpicKeys() {
    return this.epics.map((e) => e.key);
  }
  async listStoryKeys(epicId: string) {
    return this.stories.filter((s) => s.epicId === epicId).map((s) => s.key);
  }
  async listTaskKeys(storyId: string) {
    return this.tasks.filter((t) => t.userStoryId === storyId).map((t) => t.key);
  }
  async getProjectBacklogSummary(projectId: string) {
    return {
      taskCount: this.tasks.filter((task) => task.projectId === projectId).length,
      nonNotStartedTaskCount: this.tasks.filter(
        (task) => task.projectId === projectId && task.status !== "not_started",
      ).length,
      taskRunCount: this.taskRunCount,
      taskQaRunCount: this.taskQaRunCount,
      taskCommentCount: this.taskCommentCount,
      taskReviewCount: this.taskReviewCount,
      taskRevisionCount: this.taskRevisionCount,
      taskLogCount: this.taskLogCount,
    };
  }
  async insertEpics(epics: any[]) {
    const rows = epics.map((e, idx) => ({
      ...e,
      id: `e-${this.epics.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.epics.push(...rows);
    return rows;
  }
  async insertStories(stories: any[]) {
    const rows = stories.map((s, idx) => ({
      ...s,
      id: `s-${this.stories.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.stories.push(...rows);
    return rows;
  }
  async insertTasks(tasks: any[]) {
    const rows = tasks.map((t, idx) => ({
      ...t,
      id: `t-${this.tasks.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.tasks.push(...rows);
    return rows;
  }
  async insertTaskDependencies(deps: any[]) {
    const rows = deps.map((d, idx) => ({
      ...d,
      id: `d-${this.deps.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.deps.push(...rows);
    return rows;
  }
  async createTaskRun(input: any) {
    return { id: `tr-${this.tasks.length + 1}`, ...input };
  }
  async updateStoryPointsTotal(id: string, total: number | null) {
    this.storyTotals[id] = total;
  }
  async updateEpicStoryPointsTotal(id: string, total: number | null) {
    this.epicTotals[id] = total;
  }
  async close() {}
}

const createOrderingFactory = (workspaceRepo: StubWorkspaceRepo) => async () => ({
  orderTasks: async (request: any) => {
    workspaceRepo.lastOrderRequest = request;
    workspaceRepo.tasks.forEach((task, idx) => {
      task.priority = idx + 1;
    });
    return { project: { id: "p-1", key: "web" }, ordered: [], warnings: [] } as any;
  },
  close: async () => {},
});

class StubJobService {
  commandRuns: any[] = [];
  jobs: any[] = [];
  checkpoints: any[] = [];
  logs: string[] = [];
  tokenUsage: any[] = [];
  async startCommandRun() {
    const rec = {
      id: `cmd-${this.commandRuns.length + 1}`,
      commandName: "create-tasks",
      workspaceId: workspace.workspaceId,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.commandRuns.push(rec);
    return rec;
  }
  async startJob(type: string, commandRunId: string) {
    const rec = {
      id: `job-${this.jobs.length + 1}`,
      type,
      state: "running",
      commandRunId,
      workspaceId: workspace.workspaceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.push(rec);
    return rec as any;
  }
  async writeCheckpoint(jobId: string, ckpt: any) {
    this.checkpoints.push({ jobId, ...ckpt });
  }
  async appendLog(_jobId: string, chunk: string) {
    this.logs.push(chunk);
  }
  async recordTokenUsage(entry: any) {
    this.tokenUsage.push(entry);
  }
  async updateJobStatus(jobId: string, state: string, meta?: any) {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx >= 0) this.jobs[idx] = { ...this.jobs[idx], state, meta };
  }
  async finishCommandRun(id: string, status: string, _error?: string, _spProcessed?: number) {
    const idx = this.commandRuns.findIndex((c) => c.id === id);
    if (idx >= 0) this.commandRuns[idx] = { ...this.commandRuns[idx], status };
  }
  async close() {}
}

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

class StubTaskSufficiencyService {
  calls: any[] = [];
  async runAudit(request: any) {
    this.calls.push(request);
    return {
      jobId: "suff-job-1",
      commandRunId: "suff-cmd-1",
      projectKey: request.projectKey,
      sourceCommand: request.sourceCommand,
      satisfied: true,
      dryRun: request?.dryRun === true,
      totalTasksAdded: 2,
      totalTasksUpdated: 0,
      maxIterations: 3,
      minCoverageRatio: 0.95,
      finalTotalSignals: 10,
      finalCoverageRatio: 1,
      remainingSectionHeadings: [] as string[],
      remainingFolderEntries: [] as string[],
      remainingGaps: {
        sections: 0,
        folders: 0,
        total: 0,
      },
      plannedGapBundles: [] as Array<{
        kind: "section" | "folder" | "mixed";
        domain: string;
        values: string[];
        anchors: string[];
        implementationTargets: string[];
      }>,
      unresolvedBundles: [] as Array<{
        kind: "section" | "folder" | "mixed";
        domain: string;
        values: string[];
        anchors: string[];
      }>,
      iterations: [
        {
          iteration: 1,
          coverageRatio: 0.65,
          totalSignals: 10,
          missingSectionCount: 2,
          missingFolderCount: 1,
          unresolvedBundleCount: 0,
          createdTaskKeys: ["web-01-us-01-t90"],
        },
      ],
      reportPath: undefined,
      reportHistoryPath: undefined,
      warnings: [],
    };
  }
  async close() {}
}

class StubSdsPreflightService {
  calls: any[] = [];
  private readonly result: any;
  constructor(result: any) {
    this.result = result;
  }
  async runPreflight(request: any) {
    this.calls.push(request);
    return this.result;
  }
  async close() {}
}

test("Key generators respect existing keys", () => {
  const epicGen = createEpicKeyGenerator("web", ["web-01"]);
  assert.equal(epicGen(), "web-02");
  const storyGen = createStoryKeyGenerator("web-02", ["web-02-us-01"]);
  assert.equal(storyGen(), "web-02-us-02");
  const taskGen = createTaskKeyGenerator("web-02-us-02", ["web-02-us-02-t01"]);
  assert.equal(taskGen(), "web-02-us-02-t02");
});

test("createTasks generates epics, stories, tasks with dependencies and totals", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Update packages/core/src/services/planning/CreateTasksService.ts and cover the planning path.",
          files: ["packages/core/src/services/planning/CreateTasksService.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Add unit coverage for task path"],
          componentTests: [],
          integrationTests: ["Run integration flow A"],
          apiTests: ["Validate API response contract"],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(result.epics.length >= 1);
  assert.ok(result.stories.length >= 1);
  const task = result.tasks.find((entry) => entry.title === "Task One");
  assert.ok(task, "expected generated task in result set");
  assert.equal(task.status, "not_started");
  assert.equal(task.storyPoints, 3);
  assert.equal(typeof task.priority, "number");
  const metadata = task.metadata as any;
  assert.deepEqual(metadata?.files, ["packages/core/src/services/planning/CreateTasksService.ts"]);
  assert.deepEqual(metadata?.test_requirements, {
    unit: ["Add unit coverage for task path"],
    component: [],
    integration: ["Run integration flow A"],
    api: ["Validate API response contract"],
  });
  assert.ok(Array.isArray(metadata?.qa?.profiles_expected));
  assert.ok(metadata?.qa?.profiles_expected.includes("cli"));
  assert.equal(metadata?.stage, "other");
  assert.equal(metadata?.foundation, false);
  assert.ok(
    !(metadata?.qa?.blockers as string[] | undefined)?.some((entry) =>
      entry.includes("No runnable test harness discovered for required tests during planning."),
    ),
  );
  assert.ok(task.description.includes("Unit tests: Add unit coverage for task path"));
  assert.ok(task.description.includes("Component tests: Not applicable"));
  assert.ok(task.description.includes("Integration tests: Run integration flow A"));
  assert.ok(task.description.includes("API tests: Validate API response contract"));
  assert.ok(task.description.includes("Files to Touch"));
  assert.ok(task.description.includes("packages/core/src/services/planning/CreateTasksService.ts"));
  assert.ok(task.description.includes("QA Readiness"));
  assert.ok(task.description.includes("Profiles:"));
  assert.ok(!task.description.includes("Break this into concrete steps during execution."));
  assert.ok(!task.description.includes("Tests passing, docs updated, review/QA complete."));
  assert.ok(!task.description.includes("Highlight edge cases or risky areas."));
});

test("createTasks infers metadata files from path-bearing task descriptions when files are omitted", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description:
            "Implement packages/core/src/services/planning/CreateTasksService.ts and validate packages/core/src/services/planning/__tests__/CreateTasksService.test.ts.",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Cover packages/core/src/services/planning/__tests__/CreateTasksService.test.ts"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const task = result.tasks.find((entry) => entry.title === "Task One");
  const metadata = task?.metadata as any;
  assert.ok(metadata?.files.includes("packages/core/src/services/planning/CreateTasksService.ts"));
  assert.ok(metadata?.files.includes("packages/core/src/services/planning/__tests__/CreateTasksService.test.ts"));
});

test("createTasks records failover metadata and usage against the switched agent", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentServiceFailoverMetadata(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(jobService.tokenUsage.length > 0);
  assert.ok(jobService.tokenUsage.every((entry) => entry.agentId === "agent-fallback"));
  assert.ok(jobService.logs.some((line) => line.includes("agent failover (epics): switch_agent")));
});

test("createTasks auto-runs task sufficiency audit and records summary checkpoint", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = new StubTaskSufficiencyService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.equal(sufficiencyService.calls.length, 1);
  assert.equal(sufficiencyService.calls[0].projectKey, "web");
  assert.equal(sufficiencyService.calls[0].dryRun, true);
  assert.ok(jobService.checkpoints.some((entry) => entry.stage === "task_sufficiency_audit"));
  const completedJob = jobService.jobs[0];
  assert.ok(completedJob?.meta?.payload?.sufficiencyAudit);
  assert.equal(completedJob.meta.payload.sufficiencyAudit.satisfied, true);
});

test("createTasks sends an explicit orchestration prompt to the selected agent", async () => {
  const outputs = [JSON.stringify(await buildDefaultSdsDrivenAgentPlan())];
  const agentService = new StubAgentService(outputs);
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentName: "agent-1",
    agentStream: false,
  });

  assert.ok(agentService.invocations.length >= 1);
  assert.match(
    agentService.invocations[0]?.input ?? "",
    /You are the orchestration agent for mcoda create-tasks on project web\./i,
  );
  assert.match(
    agentService.invocations[0]?.input ?? "",
    /producing the complete backlog in one response/i,
  );
  assert.ok(
    agentService.invocations.every((entry) =>
      entry.input.includes("turn the SDS and supporting docs into an executable backlog"),
    ),
  );
});

test("createTasks can escalate to full-plan refinement with the selected agent when needed", async () => {
  const initialAgentPlan = await buildDefaultSdsDrivenAgentPlan();
  const refinedAgentPlan = JSON.parse(JSON.stringify(initialAgentPlan));
  const refinedStory = refinedAgentPlan.epics[0]?.stories?.[0];
  refinedStory.tasks.push(
    {
      localId: "gap-1",
      title: "Implement runtime policy gap",
      type: "feature",
      description: "Implement the missing runtime policy logic in services/worker/src/runtime-policy.ts and wire it from services/worker/src/index.ts.",
      files: ["services/worker/src/runtime-policy.ts", "services/worker/src/index.ts"],
      estimatedStoryPoints: 3,
      priorityHint: 10,
      dependsOnKeys: [],
      relatedDocs: ["docdex:doc-1"],
      unitTests: ["Add runtime policy unit coverage"],
      componentTests: [],
      integrationTests: ["Run worker runtime policy integration coverage"],
      apiTests: [],
    },
    {
      localId: "gap-2",
      title: "Validate runtime policy verification",
      type: "chore",
      description: "Execute the runtime policy verification evidence after implementation lands; depends on gap-1.",
      files: ["tests/integration/runtime-policy.spec.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 20,
      dependsOnKeys: ["gap-1"],
      relatedDocs: ["docdex:doc-1"],
      unitTests: [],
      componentTests: [],
      integrationTests: ["Run worker runtime policy integration coverage"],
      apiTests: [],
    },
  );
  const outputs = [
    JSON.stringify(initialAgentPlan),
    JSON.stringify(refinedAgentPlan),
  ];
  const agentService = new StubAgentService(outputs);
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = {
    calls: [] as any[],
    async runAudit(request: any) {
      this.calls.push(request);
      if (this.calls.length === 1) {
        return {
          jobId: "suff-job-1",
          commandRunId: "suff-cmd-1",
          projectKey: request.projectKey,
          sourceCommand: request.sourceCommand,
          satisfied: false,
          dryRun: request?.dryRun === true,
          totalTasksAdded: 0,
          totalTasksUpdated: 0,
          maxIterations: 1,
          minCoverageRatio: 1,
          finalTotalSignals: 6,
          finalCoverageRatio: 0.66,
          remainingSectionHeadings: ["Runtime Policy"],
          remainingFolderEntries: ["packages/gatekeeper/src/runtime-policy.ts"],
          remainingGaps: { sections: 1, folders: 1, total: 2 },
          plannedGapBundles: [
            {
              kind: "mixed" as const,
              domain: "gatekeeper",
              values: ["Runtime Policy", "packages/gatekeeper/src/runtime-policy.ts"],
              anchors: ["section:runtime policy", "folder:packages/gatekeeper/src/runtime-policy.ts"],
              implementationTargets: [
                "packages/gatekeeper/src/runtime-policy.ts",
                "packages/gatekeeper/src/worker.ts",
              ],
            },
          ],
          unresolvedBundles: [],
          iterations: [],
          reportPath: undefined,
          reportHistoryPath: undefined,
          warnings: [],
        };
      }
      return {
        jobId: "suff-job-2",
        commandRunId: "suff-cmd-2",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: true,
        dryRun: request?.dryRun === true,
        totalTasksAdded: 0,
        totalTasksUpdated: 0,
        maxIterations: 1,
        minCoverageRatio: 1,
        finalTotalSignals: 6,
        finalCoverageRatio: 1,
        remainingSectionHeadings: [],
        remainingFolderEntries: [],
        remainingGaps: { sections: 0, folders: 0, total: 0 },
        plannedGapBundles: [],
        unresolvedBundles: [],
        iterations: [],
        reportPath: undefined,
        reportHistoryPath: undefined,
        warnings: [],
      };
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentName: "agent-1",
    agentStream: false,
    force: true,
  });

  assert.ok(sufficiencyService.calls.length >= 1);
  if (sufficiencyService.calls.length > 1) {
    assert.ok(jobService.checkpoints.some((entry) => entry.stage === "backlog_refinement"));
    assert.ok(agentService.invocations.some((entry) => entry.metadata?.action === "full_plan"));
    assert.ok(result.tasks.some((task) => task.title === "Implement runtime policy gap"));
    assert.ok(result.tasks.some((task) => task.title === "Validate runtime policy verification"));
  } else {
    assert.ok(result.tasks.length > 0);
    assert.ok(!jobService.checkpoints.some((entry) => entry.stage === "backlog_refinement"));
    assert.ok(!result.tasks.some((task) => task.title === "Implement runtime policy gap"));
  }
});

test("createTasks refreshes exported artifacts and result counts from the final persisted backlog", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "Implementation targets:",
      "- packages/gatekeeper/src/worker.ts",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = {
    calls: [] as any[],
    async runAudit(request: any) {
      this.calls.push(request);
      const project = workspaceRepo.projects[0];
      const epic = workspaceRepo.epics[0];
      const story = workspaceRepo.stories[0];
      const [gapTask] = await workspaceRepo.insertTasks([
        {
          projectId: project.id,
          epicId: epic.id,
          userStoryId: story.id,
          key: `${story.key}-t99`,
          title: "Implement gatekeeper coverage gap",
          description:
            "## Objective\nClose the remaining gatekeeper coverage gap in packages/gatekeeper/src/worker.ts and validate the runtime startup sequence.",
          type: "feature",
          status: "not_started",
          storyPoints: 2,
          priority: 99,
          metadata: {
            sufficiencyAudit: {
              source: "task-sufficiency-audit",
              anchor: "section:gatekeeper runtime",
              anchors: ["section:gatekeeper runtime"],
            },
          },
        },
      ]);
      await workspaceRepo.createTaskRun({
        taskId: gapTask.id,
        command: "task-sufficiency-audit",
        status: "succeeded",
        jobId: "suff-job-1",
        commandRunId: "suff-cmd-1",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return {
        jobId: "suff-job-1",
        commandRunId: "suff-cmd-1",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: true,
        dryRun: request?.dryRun === true,
        totalTasksAdded: 1,
        totalTasksUpdated: 0,
        maxIterations: 3,
        minCoverageRatio: 1,
        finalTotalSignals: 4,
        finalCoverageRatio: 1,
        remainingSectionHeadings: [] as string[],
        remainingFolderEntries: [] as string[],
        remainingGaps: { sections: 0, folders: 0, total: 0 },
        plannedGapBundles: [],
        unresolvedBundles: [],
        iterations: [],
        reportPath: undefined,
        reportHistoryPath: undefined,
        warnings: [],
      };
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  assert.ok(result.tasks.length >= 2);
  assert.ok(result.tasks.some((task) => task.title === "Implement gatekeeper coverage gap"));
  const tasksPath = path.join(workspace.mcodaDir, "tasks", "web", "tasks.json");
  const planPath = path.join(workspace.mcodaDir, "tasks", "web", "plan.json");
  const servicesPath = path.join(workspace.mcodaDir, "tasks", "web", "services.json");
  const buildPlanPath = path.join(workspace.mcodaDir, "tasks", "web", "build-plan.json");
  const exportedTasks = JSON.parse(await fs.readFile(tasksPath, "utf8"));
  const exportedPlan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const exportedServices = JSON.parse(await fs.readFile(servicesPath, "utf8"));
  const exportedBuildPlan = JSON.parse(await fs.readFile(buildPlanPath, "utf8"));
  assert.ok(exportedTasks.length >= 2);
  assert.ok(exportedTasks.some((task: any) => task.title === "Implement gatekeeper coverage gap"));
  assert.ok(exportedPlan.tasks.some((task: any) => task.title === "Implement gatekeeper coverage gap"));
  assert.ok(exportedBuildPlan.services.includes("gatekeeper"));
  assert.ok(
    exportedServices.services.some((service: any) => service.name === "gatekeeper"),
    `expected refreshed services.json to include gatekeeper, got ${JSON.stringify(exportedServices.services)}`,
  );
  assert.ok(jobService.checkpoints.some((entry) => entry.stage === "plan_refreshed"));
  const completedJob = jobService.jobs[0];
  assert.equal(completedJob?.meta?.payload?.tasksCreated, exportedTasks.length);
});

test("createTasks aligns coverage-report.json with sufficiency coverage totals", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "## Operator Console",
      "Implementation targets:",
      "- packages/gatekeeper/src/worker.ts",
      "- consoles/operator/app/main.py",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Runtime foundation", description: "Implement runtime surfaces.", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Runtime story", description: "Cover runtime surfaces.", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement Gatekeeper Runtime",
          type: "feature",
          description: "Implement Gatekeeper Runtime in packages/gatekeeper/src/worker.ts.",
          estimatedStoryPoints: 3,
          priorityHint: 3,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t2",
          title: "Implement Operator Console",
          type: "feature",
          description: "Implement Operator Console in consoles/operator/app/main.py.",
          estimatedStoryPoints: 3,
          priorityHint: 4,
          dependsOnKeys: ["t1"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = {
    async runAudit(request: any) {
      const reportPath = path.join(workspace.mcodaDir, "tasks", request.projectKey, "task-sufficiency-report.json");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            finalCoverage: {
              coverageRatio: 1,
              totalSignals: 4,
              missingSectionHeadings: [],
              missingFolderEntries: [],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        jobId: "suff-job-2",
        commandRunId: "suff-cmd-2",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: true,
        dryRun: request?.dryRun === true,
        totalTasksAdded: 0,
        totalTasksUpdated: 0,
        maxIterations: 1,
        minCoverageRatio: 1,
        finalTotalSignals: 4,
        finalCoverageRatio: 1,
        remainingSectionHeadings: [] as string[],
        remainingFolderEntries: [] as string[],
        remainingGaps: { sections: 0, folders: 0, total: 0 },
        plannedGapBundles: [],
        unresolvedBundles: [],
        iterations: [],
        reportPath,
        reportHistoryPath: path.join(workspace.mcodaDir, "tasks", request.projectKey, "sufficiency-audit", "snap.json"),
        warnings: [],
      };
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  const coveragePath = path.join(workspace.mcodaDir, "tasks", "web", "coverage-report.json");
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  assert.equal(coverage.totalSignals, 4);
  assert.equal(coverage.coverageRatio, 1);
  assert.deepEqual(coverage.missingSectionHeadings, []);
  assert.deepEqual(coverage.missingFolderEntries, []);
});

test("createTasks materializes workspace SDS files when docdex coverage docs lack actionable content", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "## Operator Console",
      "Implementation targets:",
      "- packages/gatekeeper/src/worker.ts",
      "- consoles/operator/app/main.py",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Runtime foundation", description: "Implement runtime surfaces.", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Runtime story", description: "Cover runtime surfaces.", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement Gatekeeper Runtime",
          type: "feature",
          description: "Implement Gatekeeper Runtime in packages/gatekeeper/src/worker.ts.",
          estimatedStoryPoints: 3,
          priorityHint: 3,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t2",
          title: "Implement Operator Console",
          type: "feature",
          description: "Implement Operator Console in consoles/operator/app/main.py.",
          estimatedStoryPoints: 3,
          priorityHint: 4,
          dependsOnKeys: ["t1"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const sufficiencyService = {
    async runAudit(request: any) {
      const reportPath = path.join(workspace.mcodaDir, "tasks", request.projectKey, "task-sufficiency-report.json");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            finalCoverage: {
              coverageRatio: 1,
              totalSignals: 4,
              missingSectionHeadings: [],
              missingFolderEntries: [],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        jobId: "suff-job-reload",
        commandRunId: "suff-cmd-reload",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: true,
        dryRun: request?.dryRun === true,
        totalTasksAdded: 0,
        totalTasksUpdated: 0,
        maxIterations: 1,
        minCoverageRatio: 1,
        finalTotalSignals: 4,
        finalCoverageRatio: 1,
        remainingSectionHeadings: [] as string[],
        remainingFolderEntries: [] as string[],
        remainingGaps: { sections: 0, folders: 0, total: 0 },
        plannedGapBundles: [],
        unresolvedBundles: [],
        iterations: [],
        reportPath,
        reportHistoryPath: path.join(workspace.mcodaDir, "tasks", request.projectKey, "sufficiency-audit", "snap.json"),
        warnings: [],
      };
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexPathOnly() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  const coveragePath = path.join(workspace.mcodaDir, "tasks", "web", "coverage-report.json");
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  assert.equal(coverage.totalSignals, 4);
  assert.equal(coverage.coverageRatio, 1);
  assert.deepEqual(coverage.missingSectionHeadings, []);
  assert.deepEqual(coverage.missingFolderEntries, []);
  assert.ok(
    Array.isArray(coverage.notes) &&
      coverage.notes.some(
        (note: string) => /task-sufficiency-audit/i.test(note),
      ),
    `expected workspace SDS reload note, got ${JSON.stringify(coverage.notes)}`,
  );
});

test("createTasks fails closed when task sufficiency coverage report cannot be loaded", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "Implementation targets:",
      "- packages/gatekeeper/src/worker.ts",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Runtime foundation", description: "Implement runtime surfaces.", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Runtime story", description: "Cover runtime surfaces.", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement Gatekeeper Runtime",
          type: "feature",
          description: "Implement Gatekeeper Runtime in packages/gatekeeper/src/worker.ts.",
          estimatedStoryPoints: 3,
          priorityHint: 3,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const sufficiencyService = {
    async runAudit(request: any) {
      const reportPath = path.join(workspace.mcodaDir, "tasks", request.projectKey, "task-sufficiency-report.json");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify({ finalCoverage: { coverageRatio: 1 } }, null, 2), "utf8");
      return {
        jobId: "suff-job-invalid",
        commandRunId: "suff-cmd-invalid",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: true,
        dryRun: request?.dryRun === true,
        totalTasksAdded: 0,
        totalTasksUpdated: 0,
        maxIterations: 1,
        minCoverageRatio: 1,
        finalTotalSignals: 1,
        finalCoverageRatio: 1,
        remainingSectionHeadings: [] as string[],
        remainingFolderEntries: [] as string[],
        remainingGaps: { sections: 0, folders: 0, total: 0 },
        plannedGapBundles: [],
        unresolvedBundles: [],
        iterations: [],
        reportPath,
        reportHistoryPath: path.join(workspace.mcodaDir, "tasks", request.projectKey, "sufficiency-audit", "snap.json"),
        warnings: [],
      };
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
        agentStream: false,
      }),
    /failed to load task sufficiency coverage report/i,
  );
});

test("createTasks defaults SDS preflight to sidecar mode and merges generated docs into planning context", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const generatedQaPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-open-questions-answers.md");
  const generatedGapPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-gap-remediation-addendum.md");
  await fs.mkdir(path.dirname(generatedQaPath), { recursive: true });
  await fs.writeFile(generatedQaPath, "# SDS Open Questions Q&A\n\nNo open questions were detected.\n", "utf8");
  await fs.writeFile(generatedGapPath, "# SDS Gap Remediation Addendum\n\nNo unresolved SDS gaps were detected.\n", "utf8");

  const preflightService = new StubSdsPreflightService({
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    readyForPlanning: true,
    qualityStatus: "pass",
    sourceSdsPaths: [path.join(workspaceRoot, "docs", "sds.md")],
    reportPath: path.join(workspace.mcodaDir, "tasks", "web", "sds-preflight-report.json"),
    openQuestionsPath: generatedQaPath,
    gapAddendumPath: generatedGapPath,
    generatedDocPaths: [generatedQaPath, generatedGapPath],
    questionCount: 0,
    requiredQuestionCount: 0,
    issueCount: 0,
    blockingIssueCount: 0,
    appliedToSds: false,
    appliedSdsPaths: [],
    commitHash: undefined,
    issues: [],
    questions: [],
    warnings: [],
  });
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const docdex = new StubDocdexTyped();
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () => preflightService as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.equal(preflightService.calls.length, 1);
  assert.equal(preflightService.calls[0]?.applyToSds, false);
  assert.equal(preflightService.calls[0]?.commitAppliedChanges, false);
  const preflightCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "sds_preflight");
  assert.ok(preflightCheckpoint);
  assert.equal(preflightCheckpoint.details.status, "succeeded");
  assert.equal(preflightCheckpoint.details.appliedToSds, false);
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedQaPath));
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedGapPath));
  const completedJob = jobService.jobs[0];
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.qualityStatus, "pass");
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.appliedToSds, false);
});

test("createTasks only avoids re-merging generated docs when SDS writeback is explicitly enabled", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const generatedQaPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-open-questions-answers.md");
  const generatedGapPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-gap-remediation-addendum.md");
  await fs.mkdir(path.dirname(generatedQaPath), { recursive: true });
  await fs.writeFile(generatedQaPath, "# SDS Open Questions Q&A\n\nNo open questions were detected.\n", "utf8");
  await fs.writeFile(generatedGapPath, "# SDS Gap Remediation Addendum\n\nNo unresolved SDS gaps were detected.\n", "utf8");

  const preflightService = new StubSdsPreflightService({
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    readyForPlanning: true,
    qualityStatus: "pass",
    sourceSdsPaths: [path.join(workspaceRoot, "docs", "sds.md")],
    reportPath: path.join(workspace.mcodaDir, "tasks", "web", "sds-preflight-report.json"),
    openQuestionsPath: generatedQaPath,
    gapAddendumPath: generatedGapPath,
    generatedDocPaths: [generatedQaPath, generatedGapPath],
    questionCount: 0,
    requiredQuestionCount: 0,
    issueCount: 0,
    blockingIssueCount: 0,
    appliedToSds: true,
    appliedSdsPaths: [path.join(workspaceRoot, "docs", "sds.md")],
    commitHash: "abc123def456",
    issues: [],
    questions: [],
    warnings: [],
  });
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const docdex = new StubDocdexTyped();
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () => preflightService as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
    sdsPreflightApplyToSds: true,
    sdsPreflightCommit: true,
    sdsPreflightCommitMessage: "mcoda: commit sds preflight output",
  });

  assert.equal(preflightService.calls.length, 1);
  assert.equal(preflightService.calls[0]?.applyToSds, true);
  assert.equal(preflightService.calls[0]?.commitAppliedChanges, true);
  assert.equal(preflightService.calls[0]?.commitMessage, "mcoda: commit sds preflight output");
  const preflightCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "sds_preflight");
  assert.ok(preflightCheckpoint);
  assert.equal(preflightCheckpoint.details.status, "succeeded");
  assert.equal(preflightCheckpoint.details.commitHash, "abc123def456");
  assert.ok(!docdex.registeredFiles.some((entry) => entry === generatedQaPath));
  assert.ok(!docdex.registeredFiles.some((entry) => entry === generatedGapPath));
  const completedJob = jobService.jobs[0];
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.qualityStatus, "pass");
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.appliedToSds, true);
});

test("createTasks continues when SDS preflight emits remediation warnings after applying to SDS", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const generatedQaPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-open-questions-answers.md");
  const generatedGapPath = path.join(workspace.mcodaDir, "tasks", "web", "sds-gap-remediation-addendum.md");
  await fs.mkdir(path.dirname(generatedQaPath), { recursive: true });
  await fs.writeFile(
    generatedQaPath,
    "# Planning decisions\n\nDecision coverage captured by mcoda preflight.\n",
    "utf8",
  );
  await fs.writeFile(
    generatedGapPath,
    "# Gap remediation addendum\n\nGap remediation details captured by mcoda preflight.\n",
    "utf8",
  );

  const preflightService = new StubSdsPreflightService({
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    readyForPlanning: false,
    qualityStatus: "fail",
    sourceSdsPaths: [path.join(workspaceRoot, "docs", "sds.md")],
    reportPath: path.join(workspace.mcodaDir, "tasks", "web", "sds-preflight-report.json"),
    openQuestionsPath: generatedQaPath,
    gapAddendumPath: generatedGapPath,
    generatedDocPaths: [generatedQaPath, generatedGapPath],
    questionCount: 2,
    requiredQuestionCount: 2,
    issueCount: 3,
    blockingIssueCount: 0,
    appliedToSds: true,
    appliedSdsPaths: [path.join(workspaceRoot, "docs", "sds.md")],
    commitHash: undefined,
    issues: [],
    questions: [],
    warnings: ["Synthetic preflight warning"],
  });
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const docdex = new StubDocdexTyped();
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () => preflightService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(result.tasks.some((task) => task.title === "Task One"));
  const preflightCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "sds_preflight");
  assert.ok(preflightCheckpoint);
  assert.equal(preflightCheckpoint.details.status, "continued_with_warnings");
  assert.equal(preflightCheckpoint.details.continuedWithWarnings, true);
  assert.deepEqual(preflightCheckpoint.details.blockingReasons, [
    "SDS quality gates failed.",
    "Required open questions remaining: 2.",
    "SDS preflight reported planning context is not ready.",
  ]);
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedQaPath));
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedGapPath));
  assert.ok(
    jobService.logs.some((entry) => entry.includes("create-tasks will continue with remediation context")),
  );
  const completedJob = jobService.jobs[0];
  assert.equal(completedJob?.state, "completed");
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.continuedWithWarnings, true);
  assert.deepEqual(completedJob?.meta?.payload?.sdsPreflight?.blockingReasons, [
    "SDS quality gates failed.",
    "Required open questions remaining: 2.",
    "SDS preflight reported planning context is not ready.",
  ]);
});

test("createTasks blocks when SDS preflight fails", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () =>
      ({
        runPreflight: async () => {
          throw new Error("preflight unavailable");
        },
        close: async () => {},
      }) as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentStream: false,
      }),
    /create-tasks blocked: SDS preflight failed/i,
  );
  const preflightCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "sds_preflight");
  assert.ok(preflightCheckpoint);
  assert.equal(preflightCheckpoint.details.status, "failed");
});

test("createTasks preserves the architecture-first backlog when dry-run sufficiency remains unsatisfied", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = new StubTaskSufficiencyService();
  const dryRunModes: boolean[] = [];
  sufficiencyService.runAudit = async (request: any) => {
    dryRunModes.push(request?.dryRun === true);
    const baseResult = await StubTaskSufficiencyService.prototype.runAudit.call(sufficiencyService, request);
    if (request?.dryRun === true) {
      return {
        ...baseResult,
        satisfied: false,
        finalTotalSignals: 12,
        finalCoverageRatio: 0.72,
        remainingGaps: { sections: 3, folders: 1, total: 4 },
        remainingSectionHeadings: ["Missing"],
        remainingFolderEntries: ["packages/gatekeeper/src/runtime-policy.ts"],
        plannedGapBundles: [
          {
            kind: "section" as const,
            domain: "coverage",
            values: ["Missing"],
            anchors: ["section:missing"],
            implementationTargets: ["packages/gatekeeper/src/runtime-policy.ts"],
          },
        ],
        unresolvedBundles: [
          {
            kind: "section" as const,
            domain: "coverage",
            values: ["Missing"],
            anchors: ["section:missing"],
          },
        ],
      };
    }
    return {
      ...baseResult,
      satisfied: true,
      finalTotalSignals: 12,
      finalCoverageRatio: 1,
      remainingGaps: { sections: 0, folders: 0, total: 0 },
      remainingSectionHeadings: [],
      remainingFolderEntries: [],
      plannedGapBundles: [],
      unresolvedBundles: [],
    };
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const sufficiencyCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "task_sufficiency_audit");
  assert.ok(sufficiencyCheckpoint);
  assert.ok(
    ["succeeded", "continued_with_warnings"].includes(sufficiencyCheckpoint.details.status),
    `unexpected sufficiency checkpoint status: ${sufficiencyCheckpoint.details.status}`,
  );
  assert.ok((sufficiencyCheckpoint.details.unresolvedBundleCount ?? 0) <= 1);
  assert.ok(dryRunModes.length >= 1);
  assert.ok(dryRunModes.every((value) => value === true));
  assert.equal(result.sufficiencyAudit?.satisfied, false);
  assert.equal(sufficiencyCheckpoint.details.remediationApplied, false);
  assert.ok(typeof result.sufficiencyAudit?.acceptedWithResidualSectionGaps === "boolean");
});

test("createTasks preserves completion-aligned backlog artifacts when residual sufficiency warnings remain", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Gatekeeper Runtime",
      "Implementation targets:",
      "- packages/gatekeeper/src/worker.ts",
      "- packages/gatekeeper/src/runtime-policy.ts",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const reportPath = path.join(workspace.mcodaDir, "tasks", "web", "task-sufficiency-report.json");
  const sufficiencyService = {
    async runAudit(request: any) {
      const project = workspaceRepo.projects[0];
      const epic = workspaceRepo.epics[0];
      const story = workspaceRepo.stories[0];
      if (!request?.dryRun) {
        await workspaceRepo.insertTasks([
          {
            projectId: project.id,
            epicId: epic.id,
            userStoryId: story.id,
            key: `${story.key}-t99`,
            title: "Implement gatekeeper runtime policy",
            description:
              "## Objective\nClose the remaining gatekeeper runtime gap in packages/gatekeeper/src/runtime-policy.ts.",
            type: "feature",
            status: "not_started",
            storyPoints: 2,
            priority: 99,
            metadata: {
              sufficiencyAudit: {
                source: "task-sufficiency-audit",
                anchor: "folder:packages/gatekeeper/src/runtime-policy.ts",
                anchors: ["folder:packages/gatekeeper/src/runtime-policy.ts"],
              },
            },
          },
        ]);
      }
      const result = {
        jobId: "suff-job-refresh-fail",
        commandRunId: "suff-cmd-refresh-fail",
        projectKey: request.projectKey,
        sourceCommand: request.sourceCommand,
        satisfied: false,
        dryRun: request?.dryRun === true,
        totalTasksAdded: request?.dryRun === true ? 0 : 1,
        totalTasksUpdated: 0,
        maxIterations: 2,
        minCoverageRatio: 1,
        finalTotalSignals: 10,
        finalCoverageRatio: 0.84,
        remainingSectionHeadings: ["Gatekeeper Runtime"],
        remainingFolderEntries: ["packages/gatekeeper/src/runtime-policy.ts"],
        remainingGaps: { sections: 1, folders: 1, total: 2 },
        plannedGapBundles: [
          {
            kind: "mixed" as const,
            domain: "gatekeeper",
            values: ["Gatekeeper Runtime", "packages/gatekeeper/src/runtime-policy.ts"],
            anchors: [
              "section:gatekeeper runtime",
              "folder:packages/gatekeeper/src/runtime-policy.ts",
            ],
            implementationTargets: ["packages/gatekeeper/src/runtime-policy.ts"],
          },
        ],
        unresolvedBundles: [],
        iterations: [],
        reportPath,
        reportHistoryPath: undefined,
        warnings: [],
      };
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(
        reportPath,
        JSON.stringify(
          {
            ...result,
            finalCoverage: {
              coverageRatio: result.finalCoverageRatio,
              totalSignals: result.finalTotalSignals,
              missingSectionHeadings: result.remainingSectionHeadings,
              missingFolderEntries: result.remainingFolderEntries,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      return result;
    },
    async close() {},
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  const tasksPath = path.join(workspace.mcodaDir, "tasks", "web", "tasks.json");
  const exportedTasks = JSON.parse(await fs.readFile(tasksPath, "utf8"));
  assert.ok(!exportedTasks.some((task: any) => task.title === "Implement gatekeeper runtime policy"));
  assert.ok(jobService.checkpoints.some((entry) => entry.stage === "plan_refreshed"));
  const sufficiencyCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "task_sufficiency_audit");
  assert.equal(sufficiencyCheckpoint?.details?.status, "continued_with_warnings");
  assert.equal(result.sufficiencyAudit?.satisfied, false);
  assert.equal(result.sufficiencyAudit?.acceptedWithResidualSectionGaps, true);
  assert.ok(
    result.warnings.some(
      (message) =>
        /completed with residual gaps/i.test(message) ||
        /project completion/i.test(message) ||
        /project completion target not reached/i.test(message),
    ),
    `expected residual-gap warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test("createTasks replaces a weak generic generated backlog with the SDS-first deterministic plan", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Runtime Components",
      "```text",
      ".",
      "├── packages/shared/src/types/index.ts",
      "├── packages/gatekeeper/src/worker.ts",
      "├── packages/terminal-client/src/commands/submit.ts",
      "└── ops/scripts/verify-release.sh",
      "```",
      "## Dependency Contracts",
      "- terminal client depends on shared",
      "- gatekeeper depends on shared",
      "## Deployment Waves",
      "- Wave 0: shared",
      "- Wave 1: gatekeeper",
      "- Wave 2: terminal client",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Initial planning for web", description: "Seed epic", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "story-1", title: "Review inputs and draft backlog", description: "Draft", acceptanceCriteria: ["draft"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "task-1",
          title: "Implement baseline project scaffolding",
          type: "feature",
          description: "Create SDS-aligned baseline structure and core implementation entrypoints from the available docs.",
          estimatedStoryPoints: 3,
          priorityHint: 1,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () =>
      ({
        async runAudit(request: any) {
          return {
            jobId: "suff-job-sds",
            commandRunId: "suff-cmd-sds",
            projectKey: request.projectKey,
            sourceCommand: request.sourceCommand,
            satisfied: true,
            dryRun: request?.dryRun === true,
            totalTasksAdded: 0,
            totalTasksUpdated: 0,
            maxIterations: 1,
            minCoverageRatio: 1,
            finalTotalSignals: 8,
            finalCoverageRatio: 1,
            remainingSectionHeadings: [],
            remainingFolderEntries: [],
            remainingGaps: { sections: 0, folders: 0, total: 0 },
            plannedGapBundles: [],
            unresolvedBundles: [],
            iterations: [],
            reportPath: undefined,
            reportHistoryPath: undefined,
            warnings: [],
          };
        },
        async close() {},
      }) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  assert.ok(result.epics.length >= 3, `expected multi-epic SDS plan, got ${result.epics.length}`);
  assert.ok(result.tasks.length > 6, `expected SDS-first task expansion, got ${result.tasks.length}`);
  assert.ok(!result.tasks.some((task) => task.title === "Implement baseline project scaffolding"));
  assert.ok(result.epics.some((epic) => /Build Shared/i.test(epic.title)));
  assert.ok(result.epics.some((epic) => /Build Gatekeeper/i.test(epic.title)));
});

test("buildSdsDrivenPlan prefers runtime modules and keeps verification as supporting grouped work", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-verification",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: EP_RUNTIME_AND_VERIFICATION_FIXTURE,
      segments: [],
    },
  ] as any[];
  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const architecture = (service as any).buildCanonicalArchitectureArtifact(docs, catalog, graph);
  const plan = (service as any).buildSdsDrivenPlan("ep", docs, architecture);
  const report = (service as any).buildProjectCompletionReport("ep", plan, architecture);
  const implementationTasks = plan.tasks.filter((task: any) => /^Implement /i.test(task.title));
  const verificationTasks = plan.tasks.filter(
    (task: any) => /^Validate /i.test(task.title) || /^Execute release readiness bundle/i.test(task.title),
  );
  const acceptanceTasks = plan.tasks.filter((task: any) => /^Validate acceptance scenario /i.test(task.title));

  assert.ok(plan.epics.some((epic: any) => /Build Managed Storage Adapters/i.test(epic.title)));
  assert.ok(plan.epics.some((epic: any) => /Build Read Path/i.test(epic.title)));
  assert.ok(
    implementationTasks.some(
      (task: any) =>
        /packages\/gatekeeper\/src\/worker\.ts/.test(task.description) ||
        /packages\/storage-adapters\/src\/index\.ts/.test(task.description) ||
        /packages\/read-path\/src\/query\.ts/.test(task.description),
    ),
  );
  assert.ok(
    implementationTasks.every(
      (task: any) =>
        !/package\.json/.test(task.description) &&
        !/gatekeeper\.service/.test(task.description) &&
        !/Update the concrete .* modules surfaced by the SDS/i.test(task.description),
    ),
  );
  assert.ok(verificationTasks.length > 0);
  assert.ok(
    verificationTasks.some(
      (task: any) =>
        /Contract unit tests/i.test(task.description ?? "") ||
        /End-to-end acceptance tests/i.test(task.description ?? "") ||
        /^Execute release readiness bundle/i.test(task.title),
    ),
    `expected grouped verification titles, got ${verificationTasks.map((task: any) => task.title).join(" | ")}`,
  );
  assert.equal(acceptanceTasks.length, 0);
  assert.ok(
    verificationTasks.every((task: any) => !/^Validate acceptance scenario /i.test(task.title)),
    `expected grouped verification tasks, got ${verificationTasks.map((task: any) => task.title).join(" | ")}`,
  );
  assert.ok(
    verificationTasks.length <= implementationTasks.length,
    `expected verification to stay subordinate to implementation, got ${implementationTasks.length} implementation vs ${verificationTasks.length} verification tasks`,
  );
  assert.ok(report.score >= report.threshold, `expected completion score to clear threshold, got ${report.score}/${report.threshold}`);
});

test("createTasks replaces an untouched existing backlog instead of appending another generation", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const inputs = [path.join(workspaceRoot, "docs", "sds.md")];
  const first = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs,
    agentStream: false,
  });
  assert.ok(first.tasks.length > 0);
  assert.equal(workspaceRepo.tasks.length, first.tasks.length);

  const second = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs,
    agentStream: false,
  });
  assert.equal(
    workspaceRepo.tasks.length,
    second.tasks.length,
    `expected untouched backlog replacement, got ${workspaceRepo.tasks.length} persisted tasks for ${second.tasks.length} generated tasks`,
  );
  assert.ok(
    jobService.logs.some((line) => /replace it instead of appending another generation/i.test(line)),
    `expected replacement warning in logs, got ${jobService.logs.join(" | ")}`,
  );
});

test("createTasks accepts residual section gaps when completion remains the primary signal", async () => {
  const outputs = [
    JSON.stringify({
      epics: [{ localId: "e1", area: "web", title: "Epic One", description: "Epic desc", acceptanceCriteria: ["ac1"] }],
    }),
    JSON.stringify({
      stories: [{ localId: "us1", title: "Story One", description: "Story desc", acceptanceCriteria: ["s ac1"] }],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const sufficiencyService = new StubTaskSufficiencyService();
  sufficiencyService.runAudit = async (request: any) => {
    const baseResult = await StubTaskSufficiencyService.prototype.runAudit.call(sufficiencyService, request);
    return {
      ...baseResult,
      satisfied: false,
      finalTotalSignals: 10,
      finalCoverageRatio: 0.94,
      remainingGaps: { sections: 3, folders: 0, total: 3 },
      remainingSectionHeadings: ["Missing"],
      remainingFolderEntries: [],
      plannedGapBundles: [],
      unresolvedBundles: [
        {
          kind: "section" as const,
          domain: "coverage",
          values: ["Missing"],
          anchors: ["section:missing"],
        },
      ],
    };
  };
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => sufficiencyService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });
  const refreshedCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "plan_refreshed");
  assert.equal(refreshedCheckpoint?.details?.acceptedWithResidualSectionGaps, true);
  assert.equal(result.sufficiencyAudit?.acceptedWithResidualSectionGaps, true);
});

test("validateTopologyExtraction fails when SDS runtime topology signals resolve to no services", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Runtime Topology",
      "## Deployment Waves",
      "```text",
      ".",
      "├── engines/",
      "│   └── ledger/",
      "│       └── src/",
      "│           └── main.rs",
      "└── consoles/",
      "    └── operator/",
      "        └── app/",
      "            └── main.py",
      "```",
      "Wave 0 - ledger",
      "Wave 1 - operator",
    ].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const docs = await (service as any).prepareDocs([path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")]);
  const expectation = (service as any).buildSourceTopologyExpectation(docs);

  assert.throws(
    () =>
      (service as any).validateTopologyExtraction("web", expectation, {
        services: [],
        dependencies: new Map(),
        aliases: new Map(),
        waveRank: new Map(),
        startupWaves: [],
        foundationalDependencies: [],
      }),
    /runtime topology signals but no services were resolved/i,
  );
});

test("validateTopologyExtraction fails when startup wave signals resolve to no startup waves", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Runtime Topology",
      "## Deployment Waves",
      "```text",
      ".",
      "├── engines/",
      "│   └── ledger/",
      "│       └── src/",
      "│           └── main.rs",
      "└── consoles/",
      "    └── operator/",
      "        └── app/",
      "            └── main.py",
      "```",
      "Wave 0 - ledger",
      "Wave 1 - operator",
      "Operator depends on ledger.",
    ].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const docs = await (service as any).prepareDocs([path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")]);
  const expectation = (service as any).buildSourceTopologyExpectation(docs);

  assert.throws(
    () =>
      (service as any).validateTopologyExtraction("web", expectation, {
        services: ["ledger", "operator"],
        dependencies: new Map([["operator", new Set(["ledger"])]]),
        aliases: new Map([
          ["ledger", new Set(["ledger"])],
          ["operator", new Set(["operator"])],
        ]),
        waveRank: new Map(),
        startupWaves: [],
        foundationalDependencies: [],
      }),
    /startup wave signals but no startup waves were resolved/i,
  );
});

test("createTasks propagates topology validation failures before artifact generation", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Runtime Topology",
      "## Deployment Waves",
      "```text",
      ".",
      "└── engines/",
      "    └── ledger/",
      "        └── src/",
      "            └── main.rs",
      "```",
      "Wave 0 - ledger",
    ].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  (service as any).validateTopologyExtraction = () => {
    throw new Error("topology validation triggered");
  };

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
        agentStream: false,
      }),
    /topology validation triggered/i,
  );
});

test("createTasks preserves custom-root topology through final artifact refresh", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "docs", "sds.md"),
    [
      "# Software Design Specification",
      "## Runtime Topology",
      "## Deployment Waves",
      "```text",
      ".",
      "├── engines/",
      "│   └── ledger/",
      "│       └── src/",
      "│           └── main.rs",
      "└── consoles/",
      "    └── operator/",
      "        └── app/",
      "            └── main.py",
      "```",
      "Wave 0 - ledger",
      "Wave 1 - operator",
      "The operator service depends on the ledger service.",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "runtime",
          title: "Runtime foundation",
          description: "Implement the runtime services.",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Deliver runtime slices",
          description: "Implement the source-backed runtime slices.",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t-ledger",
          title: "Implement ledger runtime",
          type: "feature",
          description: "Build the ledger runtime in engines/ledger/src/main.rs.",
          estimatedStoryPoints: 3,
          priorityHint: 2,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t-operator",
          title: "Implement operator console",
          type: "feature",
          description: "Build the operator console in consoles/operator/app/main.py after the ledger runtime is available.",
          estimatedStoryPoints: 3,
          priorityHint: 3,
          dependsOnKeys: ["t-ledger"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "runtime",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  const servicesPath = path.join(workspace.mcodaDir, "tasks", "runtime", "services.json");
  const buildPlanPath = path.join(workspace.mcodaDir, "tasks", "runtime", "build-plan.json");
  const services = JSON.parse(await fs.readFile(servicesPath, "utf8"));
  const buildPlan = JSON.parse(await fs.readFile(buildPlanPath, "utf8"));
  const serviceNames = new Set((services.services ?? []).map((entry: any) => entry.name));

  assert.deepEqual(buildPlan.services, ["ledger", "operator"]);
  assert.ok(serviceNames.has("ledger"));
  assert.ok(serviceNames.has("operator"));
  assert.ok(!serviceNames.has("engines"));
  assert.ok(!serviceNames.has("consoles"));
  assert.ok(
    buildPlan.startupWaves.some((wave: any) => wave.wave === 0 && wave.services.includes("ledger")),
    `expected ledger startup wave, got ${JSON.stringify(buildPlan.startupWaves)}`,
  );
  assert.ok(
    buildPlan.startupWaves.some((wave: any) => wave.wave === 1 && wave.services.includes("operator")),
    `expected operator startup wave, got ${JSON.stringify(buildPlan.startupWaves)}`,
  );
});

test("buildDocContext appends OpenAPI hint summary", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      id: "sds-1",
      docType: "SDS",
      title: "sds",
      content: "# SDS\n## Interfaces",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments: [],
    },
    {
      id: "openapi-1",
      docType: "OPENAPI",
      title: "openapi",
      content: [
        "openapi: 3.1.0",
        "info:",
        "  title: Demo API",
        "  version: 1.0.0",
        "paths:",
        "  /users:",
        "    get:",
        "      operationId: listUsers",
        "      x-mcoda-task-hints:",
        "        service: backend-api",
        "        capability: user-listing",
        "        stage: backend",
        "        complexity: 5",
        "        depends_on_operations: []",
        "        test_requirements:",
        "          unit: [\"test list query\"]",
        "          component: []",
        "          integration: [\"test users endpoint\"]",
        "          api: [\"validate users schema\"]",
        "      responses:",
        "        '200':",
        "          description: ok",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments: [],
    },
  ] as any[];

  const context = (service as any).buildDocContext(docs);
  assert.ok(context.docSummary.includes("[OPENAPI_HINTS]"));
  assert.ok(context.docSummary.includes("[SDS_COVERAGE_HINTS]"));
  assert.ok(context.docSummary.includes("Interfaces"));
  assert.ok(context.docSummary.includes("backend-api"));
  assert.ok(context.docSummary.includes("GET /users"));
});

test("buildDocContext samples SDS segments across long documents", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const segments = Array.from({ length: 12 }, (_, index) => ({
    id: `seg-${index + 1}`,
    docId: "sds-long",
    index,
    heading: `Section ${index + 1}`,
    content: `Segment ${index + 1} content marker`,
  }));
  const docs = [
    {
      id: "sds-long",
      docType: "SDS",
      title: "long sds",
      content: segments.map((segment) => `## ${segment.heading}\n${segment.content}`).join("\n"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments,
    },
  ] as any[];

  const context = (service as any).buildDocContext(docs);
  assert.ok(context.docSummary.includes("Section 1"));
  assert.ok(context.docSummary.includes("Section 10"));
  assert.ok(context.docSummary.includes("Section 12"));
});

test("prepareDocs strips managed preflight blocks from planning content", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds-managed.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "<!-- mcoda:sds-preflight:start -->",
      "## Open Questions (Resolved)",
      "- Resolved: No unresolved questions remain for this SDS file in this preflight run.",
      "## Gap Remediation Summary (mcoda preflight)",
      "- No unresolved SDS quality gaps remained for this SDS file in this preflight run.",
      "<!-- mcoda:sds-preflight:end -->",
      "## Folder Tree",
      "```text",
      ".",
      "└── packages/gatekeeper/src/worker.ts",
      "```",
      "## Deployment Waves",
      "1. Wave 1 - Runtime startup: gatekeeper",
    ].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = await (service as any).prepareDocs([sdsPath]);
  assert.equal(docs.length >= 1, true);
  assert.ok(!docs[0].content.includes("mcoda:sds-preflight:start"));
  assert.ok(!docs[0].content.includes("Open Questions (Resolved)"));
  assert.ok(docs[0].content.includes("packages/gatekeeper/src/worker.ts"));
  const context = (service as any).buildDocContext(docs);
  assert.ok(!context.docSummary.includes("mcoda:sds-preflight:start"));
  assert.ok(!context.docSummary.includes("Open Questions (Resolved)"));
});

test("prepareDocs dedupes SDS docs across path-like ids and coerces them to SDS", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "ep.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Folder Tree",
      "```text",
      ".",
      "└── packages/gatekeeper/src/worker.ts",
      "```",
    ].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = (service as any).dedupePlanningDocs([
    {
      ...fakeDoc,
      id: "docs/ep.md",
      docType: "SDS",
      path: "docs/ep.md",
      title: "ep.md",
      content: "# Software Design Specification\n## Folder Tree",
      segments: [],
    },
    {
      ...fakeDoc,
      id: "local-ep-doc",
      docType: "DOC",
      path: sdsPath,
      title: "ep.md",
      content: await fs.readFile(sdsPath, "utf8"),
      segments: [],
    },
  ]);

  assert.equal(docs.length, 1);
  assert.equal(docs[0].docType, "SDS");
  assert.ok(docs[0].content.includes("packages/gatekeeper/src/worker.ts"));
});

test("prepareDocs falls back to the explicit local file when docdex registration resolves a different file", async () => {
  const pdrPath = path.join(workspaceRoot, "docs", "pdr", "ep.md");
  await fs.mkdir(path.dirname(pdrPath), { recursive: true });
  await fs.writeFile(
    pdrPath,
    ["# Product Design Review", "## Folder Tree", "- packages/gatekeeper/src/worker.ts"].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexMismatched() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = await (service as any).prepareDocs([pdrPath, path.join(workspaceRoot, "docs", "sds.md")]);
  const pdrDoc = docs.find((doc: any) => `${doc.path}`.replace(/\\/g, "/") === "docs/pdr/ep.md");

  assert.ok(pdrDoc, JSON.stringify(docs.map((doc: any) => doc.path)));
  assert.ok(pdrDoc.content.includes("Product Design Review"));
  assert.ok(pdrDoc.content.includes("packages/gatekeeper/src/worker.ts"));
});

test("prepareDocs expands SDS-linked support docs into the planning corpus", async () => {
  const submissionFlowPath = path.join(workspaceRoot, "docs", "submission_flow.md");
  await fs.writeFile(
    submissionFlowPath,
    ["# Submission Flow", "The terminal client uploads before the gatekeeper resolves the result."].join("\n"),
    "utf8",
  );
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const sdsPath = path.join(workspaceRoot, "docs", "linked-sources-sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "Source hierarchy for this SDS is fixed:",
      "1. `docs/submission_flow.md`",
      "## Runtime Components",
      "- gatekeeper",
    ].join("\n"),
    "utf8",
  );

  const docs = await (service as any).prepareDocs([sdsPath]);
  const docPaths = docs.map((doc: any) => `${doc.path}`.replace(/\\/g, "/"));

  assert.ok(docPaths.includes("docs/linked-sources-sds.md"));
  assert.ok(docPaths.includes("docs/submission_flow.md"));
});

test("collectDependencyStatements inspects late lines in long SDS text", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const longText = [
    ...Array.from({ length: 1300 }, (_, index) => `filler-line-${index + 1}`),
    "web ui depends on backend api",
  ].join("\n");
  const statements = (service as any).collectDependencyStatements(longText);
  assert.ok(
    statements.some(
      (statement: { dependent: string; dependency: string }) =>
        statement.dependent.toLowerCase().includes("web ui") &&
        statement.dependency.toLowerCase().includes("backend api"),
    ),
    `late dependency statement was not captured: ${JSON.stringify(statements.slice(-3))}`,
  );
});

test("extractStartupWaveHints inspects late wave rows in long SDS text", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const longText = [
    ...Array.from({ length: 3800 }, (_, index) => `filler-wave-${index + 1}`),
    "| svc-web | Wave 7 | svc-api-gateway | svc-api-gateway |",
  ].join("\n");
  const aliases = new Map<string, Set<string>>([["svc web", new Set(["svc web", "svc-web"])]]);
  const hints = (service as any).extractStartupWaveHints(longText, aliases);
  const waveEntries = Array.from((hints.waveRank as Map<string, number>).entries());
  assert.ok(
    waveEntries.some(
      ([serviceName, wave]) => wave === 7 && /svc/.test(serviceName) && /web/.test(serviceName),
    ),
    `wave rank entries did not include expected late wave service: ${JSON.stringify(waveEntries)}`,
  );
});

test("extractStructureTargets parses EP-style folder trees and top-level files", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const targets = (service as any).extractStructureTargets([
    {
      ...fakeDoc,
      id: "doc-ep",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ]);

  assert.ok(targets.directories.includes("contracts/script"));
  assert.ok(targets.directories.includes("packages/gatekeeper/src"));
  assert.ok(targets.directories.includes("packages/terminal-client/src"));
  assert.ok(targets.directories.includes("ops/systemd"));
  assert.ok(targets.files.includes("foundry.toml"));
  assert.ok(targets.files.includes("contracts/script/DeployContracts.s.sol"));
  assert.ok(targets.files.includes("contracts/script/UpgradeRegistry.s.sol"));
  assert.ok(targets.files.includes("packages/gatekeeper/src/worker.ts"));
});

test("extractStructureTargets ignores source-hierarchy doc references when deriving runtime surfaces", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const targets = (service as any).extractStructureTargets([
    {
      ...fakeDoc,
      id: "doc-source-hierarchy",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "sds.md",
      content: [
        "# Software Design Specification",
        "1. `docs/rfp.md`",
        "2. `docs/pdr/ep.md`",
        "## Folder Tree",
        "```text",
        ".",
        "└── packages/gatekeeper/src/worker.ts",
        "```",
      ].join("\n"),
      segments: [],
    },
  ]);

  assert.ok(!targets.directories.includes("docs"));
  assert.ok(!targets.files.includes("docs/rfp.md"));
  assert.ok(!targets.files.includes("docs/pdr/ep.md"));
  assert.ok(targets.files.includes("packages/gatekeeper/src/worker.ts"));
});

test("extractStructureTargets ignores negated non-goal path mentions", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const targets = (service as any).extractStructureTargets([
    {
      ...fakeDoc,
      id: "doc-negated",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: [
        "# Software Design Specification",
        "No `apps/web`, `apps/admin`, or `services/api` subtree is part of the v1 target layout.",
        "```text",
        ".",
        "└── packages/gatekeeper/src/worker.ts",
        "```",
      ].join("\n"),
      segments: [],
    },
  ]);

  assert.ok(!targets.directories.includes("apps/admin"));
  assert.ok(!targets.directories.includes("apps/web"));
  assert.ok(!targets.directories.includes("services/api"));
  assert.ok(targets.files.includes("packages/gatekeeper/src/worker.ts"));
});

test("extractStructureTargets preserves root prefixes for root-line subtrees", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const targets = (service as any).extractStructureTargets([
    {
      ...fakeDoc,
      id: "doc-root-tree",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: [
        "# Software Design Specification",
        "Source hierarchy:",
        "- docs/rfp.md",
        "- docs/pdr/ep.md",
        "## Folder Tree",
        "```text",
        "contracts/",
        "├── src/",
        "│   └── OraclePolicyRegistry.sol",
        "├── script/",
        "│   └── ConfigurePolicies.s.sol",
        "packages/",
        "├── gatekeeper/",
        "│   └── src/",
        "│       └── worker.ts",
        "```",
        "Read/write capability interface notes.",
      ].join("\n"),
      segments: [],
    },
  ]);

  assert.ok(targets.directories.includes("contracts/src"));
  assert.ok(targets.directories.includes("contracts/script"));
  assert.ok(targets.directories.includes("packages/gatekeeper"));
  assert.ok(targets.directories.includes("packages/gatekeeper/src"));
  assert.ok(targets.files.includes("contracts/src/OraclePolicyRegistry.sol"));
  assert.ok(targets.files.includes("contracts/script/ConfigurePolicies.s.sol"));
  assert.ok(targets.files.includes("packages/gatekeeper/src/worker.ts"));
  assert.ok(!targets.directories.includes("docs"));
  assert.ok(!targets.files.includes("docs/rfp.md"));
  assert.ok(!targets.directories.includes("read/write"));
});

test("extractStartupWaveHints parses prose deployment waves with canonical aliases", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const aliases = new Map<string, Set<string>>([
    ["contracts", new Set(["contracts"])],
    ["shared", new Set(["shared"])],
    ["oracle", new Set(["oracle"])],
    ["gatekeeper", new Set(["gatekeeper"])],
    ["terminal client", new Set(["terminal client", "terminal-client"])],
    ["ops", new Set(["ops", "operations"])],
  ]);
  const hints = (service as any).extractStartupWaveHints(EP_SDS_FIXTURE, aliases);
  const waveRank = hints.waveRank as Map<string, number>;

  assert.equal(waveRank.get("shared"), 0);
  assert.equal(waveRank.get("contracts"), 0);
  assert.equal(waveRank.get("oracle"), 1);
  assert.equal(waveRank.get("gatekeeper"), 2);
  assert.equal(waveRank.get("terminal client"), 3);
  assert.ok(hints.startupWaves.some((wave: any) => wave.wave === 2 && wave.services.includes("gatekeeper")));
  assert.ok(!waveRank.has("gateway"));
  assert.ok(!waveRank.has("read"));
  assert.ok(!waveRank.has("test"));
});

test("buildServiceDependencyGraph ignores artifact-only and prose-noise service aliases", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-noise",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: [
        "# Software Design Specification",
        "## Deployment Waves",
        "4. Wave 4 - Gatekeeper dry run",
        "5. Wave 5 - Gatekeeper activation",
        "No runtime component depends on a project-owned public API.",
        "```text",
        ".",
        "├── packages/gatekeeper/src/worker.ts",
        "├── protocol-artifacts/pricing_classes.json",
        "└── read/write",
        "```",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const serviceNames = new Set(catalog.services.map((entry: any) => entry.name));

  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok(!serviceNames.has("owned public api"));
  assert.ok(!serviceNames.has("protocol artifacts"));
  assert.ok(!serviceNames.has("read"));
  assert.equal(graph.waveRank.get("gatekeeper"), 4);
});

test("buildServiceDependencyGraph registers textual runtime components as real services", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-runtime-components",
      path: path.join(workspaceRoot, "docs", "sds.md"),
      title: "ep.md",
      content: [
        "# Software Design Specification",
        "## Runtime Components",
        "1. Managed storage adapters: persist approved listings.",
        "2. Read path: browse approved listings.",
        "3. Gatekeeper: process moderation results.",
        "## Architectural Dependency Order",
        "- read path depends on managed storage adapters",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const serviceNames = new Set(graph.services as string[]);

  assert.ok(serviceNames.has("managed storage adapters"));
  assert.ok(serviceNames.has("read path"));
  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok((graph.dependencies as Map<string, Set<string>>).get("read path")?.has("managed storage adapters"));
});

test("buildServiceDependencyGraph ignores support-doc headings that only happen to contain the word services", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-service-taxonomy-noise",
      path: path.join(workspaceRoot, "docs", "taxonomy.md"),
      title: "taxonomy.md",
      content: [
        "# Ads Taxonomy",
        "## Automotive and Transport Services",
        "- brand strategy",
        "- quote support",
        "## Runtime Components",
        "- Gatekeeper",
        "- Terminal client",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const serviceNames = new Set(graph.services as string[]);

  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok(serviceNames.has("terminal client"));
  assert.ok(!serviceNames.has("brand"));
  assert.ok(!serviceNames.has("quote"));
});

test("extractSdsSectionCandidates keeps scanning after repeated headings", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const sections = (service as any).extractSdsSectionCandidates(
    [
      {
        ...fakeDoc,
        id: "doc-repeat",
        path: path.join(workspaceRoot, "docs", "repeat-sds.md"),
        title: "repeat-sds.md",
        content: [
          "# Software Design Specification",
          "## Architecture Overview",
          "## Architecture Overview",
          "## Architecture Overview",
          "## Architecture Overview",
          "## Foundry Deployment",
          "## Gatekeeper Worker",
          "## Policy Registry",
        ].join("\n"),
        segments: [],
      },
    ],
    4,
  );

  assert.deepEqual(sections, [
    "Architecture Overview",
    "Foundry Deployment",
    "Gatekeeper Worker",
    "Policy Registry",
  ]);
});

test("build planning prompts preserve documented names without stack-specific wording and dedupe source docs", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-1",
      path: sdsPath,
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
    {
      ...fakeDoc,
      id: "doc-ep-2",
      path: sdsPath,
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];
  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const buildMethod = (service as any).buildProjectConstructionMethod(docs, graph);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const architecture = (service as any).buildCanonicalArchitectureArtifact(docs, catalog, graph);
  const buildPlan = (service as any).buildProjectPlanArtifact("ep", docs, graph, buildMethod);
  const prompt = (
    service as any
  ).buildPrompt(
    "ep",
    "[SDS] docdex:doc-ep-1\n- packages/gatekeeper/src/worker.ts\n- contracts/script/ConfigurePolicies.s.sol",
    buildMethod,
    catalog,
    architecture,
    {},
  ).prompt as string;

  assert.deepEqual(buildPlan.sourceDocs, [sdsPath]);
  assert.deepEqual(catalog.sourceDocs, [sdsPath]);
  assert.ok(buildMethod.includes("create file: contracts/script/ConfigurePolicies.s.sol"));
  assert.ok(buildMethod.includes("create file: contracts/src/IOraclePolicyRegistry.sol"));
  assert.ok(buildPlan.startupWaves.some((wave: any) => wave.wave === 0 && wave.services.includes("contracts")));
  assert.ok(buildPlan.startupWaves.some((wave: any) => wave.wave === 3 && wave.services.includes("terminal client")));
  const serviceNames = new Set(catalog.services.map((entry: any) => entry.name));
  assert.ok(serviceNames.has("contracts"));
  assert.ok(serviceNames.has("shared"));
  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok(serviceNames.has("oracle"));
  assert.ok(serviceNames.has("terminal client"));
  assert.ok(serviceNames.has("ops"));
  assert.ok(!serviceNames.has("foundry toml"));
  assert.ok(!serviceNames.has("ep md"));
  assert.ok(!serviceNames.has("ordered gateway"));
  assert.ok(!serviceNames.has("no public rest api"));
  assert.ok(!serviceNames.has("artifact carries ordered gateway"));
  assert.ok(prompt.includes("packages/gatekeeper/src/worker.ts"));
  assert.ok(prompt.includes("ConfigurePolicies.s.sol"));
  assert.match(prompt, /Canonical architecture summary:/i);
  assert.match(
    prompt,
    /Use canonical documented names for modules, services, interfaces, commands, schemas, and files exactly as they appear/i,
  );
  assert.match(prompt, /Do not rename explicit documented targets or replace them with invented alternatives/i);
});

test("generateTasksForStory prompt requires explicit file targets when repo surfaces are known", async () => {
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement execution flow",
          type: "feature",
          description: "Update packages/core/src/services/execution/WorkOnTasksService.ts.",
          files: ["packages/core/src/services/execution/WorkOnTasksService.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 1,
          dependsOnKeys: [],
          relatedDocs: ["docdex:doc-sds"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ]);
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const agent = await agentService.resolveAgent();
  const tasks = await (service as any).generateTasksForStory(
    agent,
    "web",
    { key: "web-01", title: "Epic One" },
    {
      localId: "us1",
      key: "web-01-us-01",
      title: "Story One",
      description: "Implement the execution flow.",
      acceptanceCriteria: ["Execution flow is wired."],
      tasks: [],
    },
    "[SDS]\n- packages/core/src/services/execution/WorkOnTasksService.ts",
    "1. create file: packages/core/src/services/execution/WorkOnTasksService.ts",
    false,
    "job-1",
    "cmd-1",
  );

  assert.equal(tasks[0]?.files?.[0], "packages/core/src/services/execution/WorkOnTasksService.ts");
  const prompt = agentService.invocations[0]?.input ?? "";
  assert.match(
    prompt,
    /Each task should include files with repo-relative file or directory targets whenever the docs or story context identify them/i,
  );
  assert.match(
    prompt,
    /Do not return only root-level placeholders like src\/ or packages\/ when a deeper runtime, interface, test, or ops target is available/i,
  );
});

test("buildServiceDependencyGraph recognizes custom container roots without project-specific allowlists", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-custom-roots",
      path: path.join(workspaceRoot, "docs", "custom-sds.md"),
      title: "custom-sds.md",
      content: [
        "# Software Design Specification",
        "## Runtime Layout",
        "```text",
        ".",
        "├── engines/",
        "│   └── ledger/",
        "│       └── src/",
        "│           └── main.rs",
        "├── consoles/",
        "│   └── operator/",
        "│       └── app/",
        "│           └── main.py",
        "└── docs/",
        "    └── architecture.md",
        "```",
        "Wave 0 - ledger",
        "Wave 1 - operator",
        "The operator service depends on the ledger service.",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("proj", docs, graph);
  const serviceNames = new Set(catalog.services.map((entry: any) => entry.name));

  assert.ok(serviceNames.has("ledger"));
  assert.ok(serviceNames.has("operator"));
  assert.ok(!serviceNames.has("engines"));
  assert.ok(!serviceNames.has("consoles"));
  assert.ok(!serviceNames.has("docs"));
  assert.equal(graph.waveRank.get("ledger"), 0);
  assert.equal(graph.waveRank.get("operator"), 1);
});

test("buildServiceDependencyGraph ignores external state doc paths during structure extraction", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-external-state",
      path: path.join(path.dirname(workspaceRoot), ".mcoda-state", "cache", "generated-sds.md"),
      title: "generated-sds.md",
      content: [
        "# Software Design Specification",
        "```text",
        ".",
        "└── packages/api/src/server.ts",
        "```",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("proj", docs, graph);
  const serviceNames = new Set(catalog.services.map((entry: any) => entry.name));

  assert.ok(serviceNames.has("api"));
  assert.ok(!serviceNames.has("mcoda"));
});

test("validateTopologyExtraction preserves source-derived topology expectations across refreshes", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-topology-baseline",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];

  const expectation = (service as any).buildSourceTopologyExpectation(docs);
  const baselineGraph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);

  assert.equal(expectation.runtimeBearing, true);
  assert.ok(expectation.services.includes("contracts"));
  assert.ok(expectation.services.includes("gatekeeper"));
  assert.ok(expectation.startupWaves.some((wave: any) => wave.wave === 0 && wave.services.includes("contracts")));
  assert.doesNotThrow(() => (service as any).validateTopologyExtraction("ep", expectation, baselineGraph));
  assert.throws(
    () =>
      (service as any).validateTopologyExtraction("ep", expectation, {
        services: ["ep core"],
        dependencies: new Map(),
        aliases: new Map(),
        waveRank: new Map(),
        startupWaves: [],
        foundationalDependencies: [],
      }),
    /lost source-backed services/i,
  );
});

test("derivePlanningArtifacts allows docs-only inputs to use the fallback service catalog", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-docs-only",
      path: path.join(workspaceRoot, "docs", "docs-only-sds.md"),
      title: "docs-only-sds.md",
      content: [
        "# Software Design Specification",
        "## Architecture Overview",
        "## Documentation Workflow",
        "Document how the team captures release evidence and operational notes.",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const expectation = (service as any).buildSourceTopologyExpectation(docs);
  const artifacts = (service as any).derivePlanningArtifacts(
    "docs",
    docs,
    { epics: [], stories: [], tasks: [] },
    expectation,
  );

  assert.equal(expectation.runtimeBearing, false);
  assert.equal(artifacts.serviceCatalog.services.length, 1);
  assert.equal(artifacts.serviceCatalog.services[0].name, "docs core");
  assert.deepEqual(artifacts.projectBuildPlan.startupWaves, []);
});

test("prepareDocs excludes generated planning artifacts from the source planning corpus", async () => {
  const docdex = new StubDocdexTyped();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const sdsPath = path.join(workspaceRoot, "docs", "sds-source.md");
  const rfpPath = path.join(workspaceRoot, "docs", "rfp.md");
  const refineLogPath = path.join(workspaceRoot, "docs", "refine_tasks_logs2.md");
  const progressPath = path.join(workspaceRoot, "docs", "create-tasks-progress.md");

  await fs.writeFile(
    sdsPath,
    ["# Software Design Specification", "## Runtime Components", "- gatekeeper"].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    rfpPath,
    ["# Request for Proposal", "The gatekeeper service reviews listings."].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    refineLogPath,
    JSON.stringify({ projectKey: "EP", warnings: ["No parseable operations returned"] }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    progressPath,
    ["# Create-Tasks Progress", "Implementation plan completed for backlog quality report."].join("\n"),
    "utf8",
  );

  const docs = await (service as any).prepareDocs([sdsPath, rfpPath, refineLogPath, progressPath]);
  const docPaths = docs.map((doc: any) =>
    (path.isAbsolute(doc.path) ? path.relative(workspaceRoot, doc.path) : doc.path).replace(/\\/g, "/"),
  );

  assert.deepEqual(docPaths, ["docs/sds-source.md", "docs/rfp.md"]);
  assert.ok(docdex.registeredFiles.some((file) => file.endsWith("refine_tasks_logs2.md")));
  assert.ok(docdex.registeredFiles.some((file) => file.endsWith("create-tasks-progress.md")));
});

test("derivePlanningArtifacts keeps the canonical architecture frozen to source docs", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-source",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];
  const expectation = (service as any).buildSourceTopologyExpectation(docs);
  const baseline = (service as any).derivePlanningArtifacts("ep", docs, { epics: [], stories: [], tasks: [] }, expectation);
  const noisy = (service as any).derivePlanningArtifacts(
    "ep",
    docs,
    {
      epics: [
        {
          localId: "e1",
          area: "ep",
          title: "Create SDS-aligned folder tree",
          description: "Added directories and files from the backlog report.",
          acceptanceCriteria: [],
          relatedDocs: ["docdex:docs/refine_tasks_logs2.md"],
          serviceIds: ["folder"],
          tags: [],
          stories: [],
        },
      ],
      stories: [
        {
          localId: "us1",
          epicLocalId: "e1",
          title: "Define service dependency baseline",
          description: "Document codify service/module dependency direction.",
          acceptanceCriteria: [],
          relatedDocs: ["docdex:docs/refine_tasks_logs2.md"],
          tasks: [],
        },
      ],
      tasks: [
        {
          localId: "t1",
          epicLocalId: "e1",
          storyLocalId: "us1",
          title: "Create foundational file stubs for discovered modules",
          description: "Create minimal file stubs/config entrypoints for directories and files.",
          type: "feature",
          files: ["stubs/config", "modules/services."],
          dependsOnKeys: [],
          relatedDocs: ["docdex:docs/refine_tasks_logs2.md"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    },
    expectation,
  );

  assert.deepEqual(noisy.serviceCatalog.services, baseline.serviceCatalog.services);
  assert.deepEqual(noisy.projectBuildPlan.services, baseline.projectBuildPlan.services);
  assert.deepEqual(
    noisy.architecture.units.map((unit: any) => unit.name),
    baseline.architecture.units.map((unit: any) => unit.name),
  );
  assert.ok(!noisy.serviceCatalog.services.some((entry: any) => /added|directories|files|folder/i.test(entry.name)));
});

test("derivePlanningArtifacts ignores supplemental support-doc noise when building the canonical architecture", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-source",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
    {
      ...fakeDoc,
      id: "doc-ep-support",
      path: path.join(workspaceRoot, "docs", "supporting-architecture.md"),
      title: "supporting-architecture.md",
      docType: "DOC",
      content: EP_SUPPORT_DOC_NOISE_FIXTURE,
      segments: [],
    },
  ] as any[];

  const expectation = (service as any).buildSourceTopologyExpectation(docs);
  const artifacts = (service as any).derivePlanningArtifacts(
    "ep",
    docs,
    { epics: [], stories: [], tasks: [] },
    expectation,
  );
  const serviceNames = new Set(artifacts.serviceCatalog.services.map((entry: any) => entry.name));
  const roots = new Set<string>(artifacts.architecture.architectureRoots);
  const crossDomains = new Set(artifacts.architecture.crossCuttingDomains);

  assert.ok(serviceNames.has("contracts"));
  assert.ok(serviceNames.has("shared"));
  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok(serviceNames.has("oracle"));
  assert.ok(serviceNames.has("terminal client"));
  assert.ok(serviceNames.has("ops"));
  for (const noisyService of ["quote", "cid", "aml", "usd", "brand", "browse", "geo", "jobs", "node", "pass", "pin"]) {
    assert.ok(!serviceNames.has(noisyService), `expected ${noisyService} to be filtered from the service catalog`);
  }
  assert.ok([...roots].some((root) => root === "contracts" || root.startsWith("contracts/")));
  assert.ok([...roots].some((root) => root === "packages" || root.startsWith("packages/")));
  assert.ok([...roots].some((root) => root === "ops" || root.startsWith("ops/")));
  for (const noisyRoot of ["quote", "cid", "aml", "usd", "manifest.json", "tsconfig.base.json", "00.webp"]) {
    assert.ok(!roots.has(noisyRoot), `expected ${noisyRoot} to be filtered from architecture roots`);
  }
  assert.ok(!crossDomains.has("Architecture Overview"));
  assert.ok(!crossDomains.has("Runtime Components"));
  assert.ok(artifacts.architecture.units.length < 20);
});

test("buildCanonicalArchitectureArtifact derives fallback implementation targets for abstract runtime services", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-source",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: [
        "# Software Design Specification",
        "## Runtime Components",
        "1. Listing contract suite",
        "2. Policy pricing configuration",
        "3. Terminal client",
        "4. Managed storage adapters",
        "5. Gatekeeper",
        "6. Read path",
        "## Folder Tree",
        "```text",
        ".",
        "├── contracts/src/ListingRegistry.sol",
        "├── contracts/test/ListingRegistry.t.sol",
        "├── packages/shared/src/index.ts",
        "├── packages/gatekeeper/src/worker.ts",
        "└── packages/terminal-client/src/main.ts",
        "```",
        "## Required Acceptance Scenarios",
        "1. Creator removal: owner pays `1 USDT`, listing disappears immediately.",
      ].join("\n"),
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const architecture = (service as any).buildCanonicalArchitectureArtifact(docs, catalog, graph);
  const unitById = new Map(architecture.units.map((unit: any) => [unit.unitId, unit]));
  const listingContractSuite = unitById.get("svc-listing-contract-suite") as any;
  const managedStorageAdapters = unitById.get("svc-managed-storage-adapters") as any;
  const policyPricingConfiguration = unitById.get("svc-policy-pricing-configura") as any;
  const readPath = unitById.get("svc-read-path") as any;

  assert.ok(
    Array.isArray(listingContractSuite?.implementationTargets) &&
      listingContractSuite.implementationTargets.includes("contracts/src") &&
      listingContractSuite.implementationTargets.some((target: string) => target.startsWith("contracts/src/")),
  );
  assert.ok(
    Array.isArray(managedStorageAdapters?.implementationTargets) &&
      managedStorageAdapters.implementationTargets.length >= 1 &&
      managedStorageAdapters.implementationTargets.every((target: string) =>
        target.startsWith("contracts/src/"),
      ),
  );
  assert.ok(
    Array.isArray(policyPricingConfiguration?.implementationTargets) &&
      policyPricingConfiguration.implementationTargets.length === 1 &&
      policyPricingConfiguration.implementationTargets[0].startsWith("contracts/src/"),
  );
  assert.ok(
    Array.isArray(readPath?.implementationTargets) &&
      readPath.implementationTargets.length === 1 &&
      readPath.implementationTargets[0].startsWith("contracts/src/"),
  );
});

test("buildSdsDrivenPlan filters generated planning docs from related task references", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-source",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
    {
      ...fakeDoc,
      id: "doc-refine-log",
      path: path.join(workspaceRoot, "docs", "refine_tasks_logs2.md"),
      title: "refine_tasks_logs2.md",
      docType: "DOC",
      content: "# refine log\n\nNo parseable operations returned.",
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const architecture = (service as any).buildCanonicalArchitectureArtifact(docs, catalog, graph);
  const plan = (service as any).buildSdsDrivenPlan("ep", docs, architecture);

  assert.ok(plan.tasks.length > 0);
  assert.ok(plan.tasks.every((task: any) => !(task.relatedDocs ?? []).includes("docdex:doc-refine-log")));
  assert.ok(plan.tasks.every((task: any) => (task.relatedDocs ?? []).includes("docdex:doc-ep-source")));
});

test("buildSdsDrivenPlan follows the provided canonical architecture order", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-ep-source",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];

  const graph = (service as any).buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
  const catalog = (service as any).buildServiceCatalogArtifact("ep", docs, graph);
  const architecture = (service as any).buildCanonicalArchitectureArtifact(docs, catalog, graph);
  const plan = (service as any).buildSdsDrivenPlan("ep", docs, architecture);

  const unitById = new Map<string, any>(architecture.units.map((unit: any) => [unit.unitId, unit]));
  const expectedTitles = architecture.dependencyOrder.slice(0, 3).map((unitId: string) => {
    const unit = unitById.get(unitId) as any;
    return unit?.kind === "service"
      ? `Build ${String(unit.name)
          .split(/\s+/)
          .map((token: string) => (token ? token[0]!.toUpperCase() + token.slice(1) : token))
          .join(" ")}`
      : undefined;
  });

  assert.deepEqual(plan.epics.slice(0, 3).map((epic: any) => epic.title), expectedTitles);
});

test("buildProjectCompletionReport ignores dependency-order penalties for uncovered units", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const architecture = {
    projectKey: "ep",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds/ep.md"],
    architectureRoots: ["packages"],
    services: ["shared", "gatekeeper"],
    crossCuttingDomains: [],
    verificationSurfaces: [],
    startupWaves: [],
    dependencyOrder: ["svc-shared", "svc-gatekeeper"],
    units: [
      {
        unitId: "svc-shared",
        kind: "service",
        name: "shared",
        summary: "Build shared",
        sourceHeadings: ["Shared"],
        implementationTargets: ["packages/shared/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: [],
        startupWave: 0,
        isFoundational: true,
        sourceServiceIds: ["shared"],
        completionSignals: [],
      },
      {
        unitId: "svc-gatekeeper",
        kind: "service",
        name: "gatekeeper",
        summary: "Build gatekeeper",
        sourceHeadings: ["Gatekeeper"],
        implementationTargets: ["packages/gatekeeper/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: ["svc-shared"],
        startupWave: 1,
        isFoundational: false,
        sourceServiceIds: ["gatekeeper"],
        completionSignals: [],
      },
    ],
  };
  const plan = {
    epics: [],
    stories: [],
    tasks: [
      {
        localId: "t-gatekeeper",
        epicLocalId: "e1",
        storyLocalId: "us1",
        title: "Implement gatekeeper runtime",
        description: "Implement packages/gatekeeper/src.",
        type: "feature",
        files: ["packages/gatekeeper/src"],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  const report = (service as any).buildProjectCompletionReport("ep", plan, architecture);

  assert.ok(report.issues.some((issue: any) => issue.code === "architecture_units_uncovered"));
  assert.ok(!report.issues.some((issue: any) => issue.code === "dependency_order_weak"));
  assert.equal(report.metrics.dependencyOrderCoverage.ratio, 1);
});

test("buildProjectCompletionReport prefers unit-scoped task ownership over shared file overlap", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const architecture = {
    projectKey: "ep",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds/ep.md"],
    architectureRoots: ["packages/shared/src"],
    services: ["shared"],
    crossCuttingDomains: ["Identity Model"],
    verificationSurfaces: [],
    startupWaves: [],
    dependencyOrder: ["svc-shared", "cross-identity-model"],
    units: [
      {
        unitId: "svc-shared",
        kind: "service",
        name: "shared",
        summary: "Build shared",
        sourceHeadings: ["Shared"],
        implementationTargets: ["packages/shared/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: [],
        startupWave: 0,
        isFoundational: true,
        sourceServiceIds: ["shared"],
        completionSignals: [],
      },
      {
        unitId: "cross-identity-model",
        kind: "cross_cutting",
        name: "Identity Model",
        summary: "Establish identity model",
        sourceHeadings: ["Identity Model"],
        implementationTargets: ["packages/shared/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: ["svc-shared"],
        startupWave: undefined,
        isFoundational: false,
        sourceServiceIds: ["shared"],
        completionSignals: [],
      },
    ],
  };
  const plan = {
    epics: [],
    stories: [],
    tasks: [
      {
        localId: "svc-shared-implementation-task-1",
        epicLocalId: "service-shared",
        storyLocalId: "svc-shared-implementation",
        title: "Implement shared runtime",
        description: "Implement packages/shared/src.",
        type: "feature",
        files: ["packages/shared/src"],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  const report = (service as any).buildProjectCompletionReport("ep", plan, architecture);
  const identityCoverage = report.unitCoverage.find((entry: any) => entry.unitId === "cross-identity-model");

  assert.ok(identityCoverage);
  assert.equal(identityCoverage.satisfied, false);
  assert.deepEqual(identityCoverage.implementationTaskKeys, []);
  assert.ok(report.issues.some((issue: any) => issue.code === "architecture_units_uncovered"));
});

test("buildProjectCompletionReport keeps implementation tasks with attached tests in implementation coverage", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const architecture = {
    projectKey: "ep",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds/ep.md"],
    architectureRoots: ["packages/shared/src"],
    services: ["shared"],
    crossCuttingDomains: [],
    verificationSurfaces: [],
    startupWaves: [],
    dependencyOrder: ["svc-shared"],
    units: [
      {
        unitId: "svc-shared",
        kind: "service",
        name: "shared",
        summary: "Build shared",
        sourceHeadings: ["Shared"],
        implementationTargets: ["packages/shared/src/index.ts"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: [],
        startupWave: 0,
        isFoundational: true,
        sourceServiceIds: ["shared"],
        completionSignals: [],
      },
    ],
  };
  const plan = {
    epics: [],
    stories: [],
    tasks: [
      {
        localId: "svc-shared-implementation-task-1",
        epicLocalId: "svc-shared",
        storyLocalId: "svc-shared-implementation",
        title: "Implement shared runtime",
        description: "Implement packages/shared/src/index.ts.",
        type: "feature",
        files: ["packages/shared/src/index.ts"],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: ["Cover shared runtime behavior through packages/shared/src/index.ts."],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  const report = (service as any).buildProjectCompletionReport("ep", plan, architecture);
  const unitCoverage = report.unitCoverage.find((entry: any) => entry.unitId === "svc-shared");

  assert.ok(unitCoverage);
  assert.deepEqual(unitCoverage.implementationTaskKeys, ["svc-shared-implementation-task-1"]);
  assert.deepEqual(unitCoverage.verificationTaskKeys, []);
});

test("persisted backlog round-trip preserves architecture-scoped local ids for completion scoring", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const architecture = {
    projectKey: "ep",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds/ep.md"],
    architectureRoots: ["packages"],
    services: ["shared", "gatekeeper"],
    crossCuttingDomains: [],
    verificationSurfaces: [],
    startupWaves: [],
    dependencyOrder: ["svc-shared", "svc-gatekeeper"],
    units: [
      {
        unitId: "svc-shared",
        kind: "service",
        name: "shared",
        summary: "Build shared",
        sourceHeadings: ["Shared"],
        implementationTargets: ["packages/shared/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: [],
        startupWave: 0,
        isFoundational: true,
        sourceServiceIds: ["shared"],
        completionSignals: [],
      },
      {
        unitId: "svc-gatekeeper",
        kind: "service",
        name: "gatekeeper",
        summary: "Build gatekeeper",
        sourceHeadings: ["Gatekeeper"],
        implementationTargets: ["packages/gatekeeper/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: ["svc-shared"],
        startupWave: 1,
        isFoundational: false,
        sourceServiceIds: ["gatekeeper"],
        completionSignals: [],
      },
    ],
  };
  const plan = {
    epics: [
      {
        localId: "svc-shared",
        area: "ep",
        title: "Build shared",
        description: "Shared module implementation.",
        acceptanceCriteria: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        priorityHint: 1,
        serviceIds: ["shared"],
        tags: [],
        stories: [],
      },
      {
        localId: "svc-gatekeeper",
        area: "ep",
        title: "Build gatekeeper",
        description: "Gatekeeper module implementation.",
        acceptanceCriteria: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        priorityHint: 2,
        serviceIds: ["gatekeeper"],
        tags: [],
        stories: [],
      },
    ],
    stories: [
      {
        localId: "svc-shared-us-01",
        epicLocalId: "svc-shared",
        title: "Implement shared runtime",
        userStory: "As a system, I need shared runtime primitives.",
        description: "Implement shared runtime surfaces.",
        acceptanceCriteria: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        priorityHint: 1,
        tasks: [],
      },
      {
        localId: "svc-gatekeeper-us-01",
        epicLocalId: "svc-gatekeeper",
        title: "Implement gatekeeper runtime",
        userStory: "As a system, I need the gatekeeper runtime.",
        description: "Implement gatekeeper runtime surfaces.",
        acceptanceCriteria: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        priorityHint: 2,
        tasks: [],
      },
    ],
    tasks: [
      {
        localId: "svc-shared-impl-01",
        epicLocalId: "svc-shared",
        storyLocalId: "svc-shared-us-01",
        title: "Implement shared runtime",
        description: "Implement packages/shared/src runtime surfaces.",
        type: "feature",
        files: ["packages/shared/src"],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: "svc-gatekeeper-impl-01",
        epicLocalId: "svc-gatekeeper",
        storyLocalId: "svc-gatekeeper-us-01",
        title: "Implement gatekeeper runtime",
        description: "Implement packages/gatekeeper/src runtime surfaces.",
        type: "feature",
        files: ["packages/gatekeeper/src"],
        estimatedStoryPoints: 5,
        priorityHint: 2,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  const baselineReport = (service as any).buildProjectCompletionReport("ep", plan, architecture);
  assert.ok(!baselineReport.issues.some((issue: any) => issue.code === "dependency_order_weak"));

  const project = await workspaceRepo.createProjectIfMissing({
    workspaceId: workspace.workspaceId,
    key: "ep",
    title: "EP",
    description: "EP",
    status: "active",
  });
  await (service as any).persistPlanToDb(project.id, "ep", plan, "job-1", "cmd-1");
  workspaceRepo.epics = [...workspaceRepo.epics].reverse();
  workspaceRepo.stories = [...workspaceRepo.stories].reverse();
  workspaceRepo.tasks = [...workspaceRepo.tasks].reverse();
  const persisted = await (service as any).loadPersistedBacklog(project.id);
  const rebuilt = (service as any).buildPlanFromPersistedBacklog(persisted);
  const rebuiltReport = (service as any).buildProjectCompletionReport("ep", rebuilt, architecture);

  assert.equal(rebuilt.epics[0].localId, "svc-shared");
  assert.equal(rebuilt.stories[0].localId, "svc-shared-us-01");
  assert.equal(rebuilt.tasks[0].localId, "svc-shared-impl-01");
  assert.equal(rebuilt.tasks[1].localId, "svc-gatekeeper-impl-01");
  assert.equal(rebuilt.tasks[1].epicLocalId, "svc-gatekeeper");
  assert.equal(rebuilt.tasks[1].storyLocalId, "svc-gatekeeper-us-01");
  assert.equal(rebuiltReport.score, baselineReport.score);
  assert.ok(!rebuiltReport.issues.some((issue: any) => issue.code === "dependency_order_weak"));
});

test("buildProjectCompletionReport prefers the longest matching scoped unit prefix", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const architecture = {
    projectKey: "ep",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds/ep.md"],
    architectureRoots: ["packages"],
    services: ["gatekeeper", "gatekeeper oracle"],
    crossCuttingDomains: [],
    verificationSurfaces: [],
    startupWaves: [],
    dependencyOrder: ["svc-gatekeeper", "svc-gatekeeper-oracle"],
    units: [
      {
        unitId: "svc-gatekeeper",
        kind: "service",
        name: "gatekeeper",
        summary: "Build gatekeeper",
        sourceHeadings: ["Gatekeeper"],
        implementationTargets: ["packages/gatekeeper/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: [],
        startupWave: 0,
        isFoundational: true,
        sourceServiceIds: ["gatekeeper"],
        completionSignals: [],
      },
      {
        unitId: "svc-gatekeeper-oracle",
        kind: "service",
        name: "gatekeeper oracle",
        summary: "Build gatekeeper oracle",
        sourceHeadings: ["Gatekeeper Oracle"],
        implementationTargets: ["packages/gatekeeper-oracle/src"],
        supportingTargets: [],
        verificationTargets: [],
        verificationSurfaceIds: [],
        dependsOnUnitIds: ["svc-gatekeeper"],
        startupWave: 1,
        isFoundational: false,
        sourceServiceIds: ["gatekeeper-oracle"],
        completionSignals: [],
      },
    ],
  };
  const plan = {
    epics: [],
    stories: [],
    tasks: [
      {
        localId: "svc-gatekeeper-oracle-implementation-task-1",
        epicLocalId: "service-gatekeeper-oracle-1",
        storyLocalId: "svc-gatekeeper-oracle-implementation-1",
        title: "Implement gatekeeper oracle runtime",
        description: "Implement packages/gatekeeper-oracle/src runtime surfaces.",
        type: "feature",
        files: ["packages/gatekeeper-oracle/src"],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: ["docdex:docs/sds/ep.md"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  const report = (service as any).buildProjectCompletionReport("ep", plan, architecture);
  const gatekeeperCoverage = report.unitCoverage.find((entry: any) => entry.unitId === "svc-gatekeeper");
  const oracleCoverage = report.unitCoverage.find((entry: any) => entry.unitId === "svc-gatekeeper-oracle");

  assert.ok(gatekeeperCoverage);
  assert.ok(oracleCoverage);
  assert.equal(gatekeeperCoverage.satisfied, false);
  assert.equal(oracleCoverage.satisfied, true);
  assert.deepEqual(oracleCoverage.implementationTaskKeys, ["svc-gatekeeper-oracle-implementation-task-1"]);
});

test("buildCanonicalNameInventory preserves source-backed aliases for canonical matching", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-canonical-aliases",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];

  const inventory = (service as any).buildCanonicalNameInventory(docs);

  assert.ok(inventory.pathSet.has("packages/gatekeeper/src/worker.ts"));
  assert.ok(inventory.pathSet.has("contracts/script/ConfigurePolicies.s.sol"));
  assert.equal((service as any).resolveServiceMentionFromPhrase("terminal-client", inventory.serviceAliases), "terminal client");
  assert.equal((service as any).resolveServiceMentionFromPhrase("gatekeeper", inventory.serviceAliases), "gatekeeper");
});

test("assertCanonicalNameConsistency rejects undocumented near-duplicate path names", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const docs = [
    {
      ...fakeDoc,
      id: "doc-canonical-conflict",
      path: path.join(workspaceRoot, "docs", "ep.md"),
      title: "ep.md",
      content: EP_SDS_FIXTURE,
      segments: [],
    },
  ] as any[];
  const plan = {
    epics: [
      {
        localId: "e1",
        area: "ep",
        title: "Gatekeeper Runtime",
        description: "Implement the gatekeeper runtime.",
        acceptanceCriteria: ["Gatekeeper worker starts after contract configuration."],
        serviceIds: ["gatekeeper"],
        tags: [],
        stories: [],
      },
    ],
    stories: [
      {
        localId: "us1",
        epicLocalId: "e1",
        title: "Runtime startup",
        userStory: "As an operator, I want runtime startup ordered correctly.",
        description: "Start the gatekeeper runtime after policy configuration.",
        acceptanceCriteria: ["Runtime startup order is documented and enforced."],
        tasks: [],
      },
    ],
    tasks: [
      {
        localId: "t1",
        epicLocalId: "e1",
        storyLocalId: "us1",
        title: "Wire runtime worker",
        description:
          "Implement packages/gatekeeper-oracle/src/worker.ts so it starts after contracts/script/ConfigurePolicies.s.sol.",
        type: "feature",
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
  };

  assert.throws(
    () => (service as any).assertCanonicalNameConsistency("ep", docs, plan),
    /packages\/gatekeeper-oracle\/src\/worker\.ts -> packages\/gatekeeper\/src\/worker\.ts/i,
  );
});

test("writePlanArtifacts rejects inconsistent build-plan and services artifacts", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const buildPlan = {
    projectKey: "proj",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds.md"],
    startupWaves: [{ wave: 0, services: ["operator"] }],
    services: ["operator"],
    serviceIds: ["operator"],
    foundationalDependencies: [],
    buildMethod: "Build the runtime.",
  };
  const serviceCatalog = {
    projectKey: "proj",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds.md"],
    services: [
      {
        id: "ledger",
        name: "ledger",
        aliases: ["ledger"],
        startupWave: 0,
        dependsOnServiceIds: [],
        isFoundational: true,
      },
    ],
  };
  const architecture = {
    projectKey: "proj",
    generatedAt: new Date().toISOString(),
    sourceDocs: ["docs/sds.md"],
    architectureRoots: ["packages"],
    services: ["ledger"],
    crossCuttingDomains: [],
    verificationSurfaces: [],
    units: [],
    dependencyOrder: [],
    startupWaves: [],
  };

  await assert.rejects(
    () =>
      (service as any).writePlanArtifacts(
        "proj",
        { epics: [], stories: [], tasks: [] },
        "[SDS] docs/sds.md",
        [],
        buildPlan,
        serviceCatalog,
        architecture,
      ),
    /build-plan\.json and services\.json disagree on service identity ordering/i,
  );
});

test("createTasks persists runnable metadata tests when harness is discoverable", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "create-tasks-tests",
        version: "1.0.0",
        scripts: {
          "test:unit": "node tests/unit.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Add unit coverage for task path"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const task = result.tasks.find((entry) => entry.title === "Task One");
  assert.ok(task, "expected generated task in result set");
  const metadata = task.metadata as any;
  assert.ok(Array.isArray(metadata?.tests));
  assert.ok(metadata?.tests.some((command: string) => command.includes("test:unit")));
});

test("createTasks writes SDS coverage report artifact", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Lifecycle",
          description: "Implement lifecycle capabilities",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Lifecycle story",
          description: "Deliver lifecycle flow",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement lifecycle endpoint",
          type: "feature",
          description: "Implement endpoint and lifecycle persistence logic.",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
    sdsPreflightApplyToSds: true,
  });

  const coveragePath = path.join(workspace.mcodaDir, "tasks", "web", "coverage-report.json");
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  assert.equal(typeof coverage.totalSections, "number");
  assert.ok(Array.isArray(coverage.matched));
  assert.ok(Array.isArray(coverage.unmatched));
  assert.equal(typeof coverage.coverageRatio, "number");

  const buildPlanPath = path.join(workspace.mcodaDir, "tasks", "web", "build-plan.json");
  const buildPlan = JSON.parse(await fs.readFile(buildPlanPath, "utf8"));
  assert.equal(buildPlan.projectKey, "web");
  assert.equal(typeof buildPlan.buildMethod, "string");
  assert.ok(Array.isArray(buildPlan.startupWaves));

  const servicesPath = path.join(workspace.mcodaDir, "tasks", "web", "services.json");
  const services = JSON.parse(await fs.readFile(servicesPath, "utf8"));
  assert.equal(services.projectKey, "web");
  assert.ok(Array.isArray(services.services));
  assert.ok(services.services.length > 0);
});

test("createTasks writes backlog quality report from the refreshed persisted backlog", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Lifecycle",
          description: "Implement lifecycle capabilities",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Lifecycle story",
          description: "Deliver lifecycle flow",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement lifecycle endpoint",
          type: "feature",
          description: "Implement packages/core/src/services/planning/CreateTasksService.ts for lifecycle orchestration.",
          files: ["packages/core/src/services/planning/CreateTasksService.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 1,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const qualityPath = path.join(workspace.mcodaDir, "tasks", "web", "backlog-quality-report.json");
  const report = JSON.parse(await fs.readFile(qualityPath, "utf8"));
  assert.equal(report.projectKey, "web");
  assert.equal(typeof report.score, "number");
  assert.ok(Array.isArray(report.architectureRoots));
  assert.ok(report.architectureRoots.includes("packages"));
  assert.ok((report.metrics?.implementationFileCoverage?.numerator ?? 0) >= 1);
  assert.ok(
    (report.metrics?.implementationFileCoverage?.denominator ?? 0) >=
      (report.metrics?.implementationFileCoverage?.numerator ?? 0),
  );
  assert.ok(Array.isArray(report.issues));
});

test("createTasks builds EP-style coverage and planning artifacts from box-tree SDS", async () => {
  await fs.writeFile(path.join(workspaceRoot, "docs", "sds.md"), EP_SDS_FIXTURE, "utf8");
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "ep",
          title: "Protocol foundation",
          description: "Build contract and runtime foundations.",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Foundation story",
          description: "Deliver contract deployment and runtime startup.",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement deployment foundation",
          type: "feature",
          description: "Create deployment scripts and runtime wiring.",
          estimatedStoryPoints: 5,
          priorityHint: 3,
          dependsOnKeys: [],
          unitTests: ["Add coverage for deployment helpers"],
          componentTests: [],
          integrationTests: ["Run deployment sequencing smoke flow"],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "ep",
    inputs: [path.join(workspaceRoot, "docs"), path.join(workspaceRoot, "docs", "sds.md")],
    agentStream: false,
  });

  const coveragePath = path.join(workspace.mcodaDir, "tasks", "ep", "coverage-report.json");
  const buildPlanPath = path.join(workspace.mcodaDir, "tasks", "ep", "build-plan.json");
  const servicesPath = path.join(workspace.mcodaDir, "tasks", "ep", "services.json");
  const architecturePath = path.join(workspace.mcodaDir, "tasks", "ep", "architecture.json");
  const epicsPath = path.join(workspace.mcodaDir, "tasks", "ep", "epics.json");
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  const buildPlan = JSON.parse(await fs.readFile(buildPlanPath, "utf8"));
  const services = JSON.parse(await fs.readFile(servicesPath, "utf8"));
  const architecture = JSON.parse(await fs.readFile(architecturePath, "utf8"));
  const epics = JSON.parse(await fs.readFile(epicsPath, "utf8"));

  assert.ok(coverage.totalSections >= 4, `expected multiple SDS sections, got ${coverage.totalSections}`);
  assert.ok(!coverage.unmatched.includes("Software Design Specification"));
  assert.ok(!coverage.unmatched.some((section: string) => /roles/i.test(section)));
  assert.ok(buildPlan.startupWaves.length >= 3, `expected deployment waves, got ${JSON.stringify(buildPlan.startupWaves)}`);
  assert.ok(buildPlan.startupWaves.some((wave: any) => wave.wave === 0 && wave.services.includes("contracts")));
  assert.ok(buildPlan.startupWaves.some((wave: any) => wave.wave === 2 && wave.services.includes("gatekeeper")));
  assert.equal(new Set(buildPlan.sourceDocs).size, buildPlan.sourceDocs.length);
  assert.equal(buildPlan.sourceDocs.length, 1);
  assert.equal(new Set(services.sourceDocs).size, services.sourceDocs.length);
  const serviceNames = new Set((services.services ?? []).map((entry: any) => entry.name));
  assert.ok(serviceNames.has("contracts"));
  assert.ok(serviceNames.has("shared"));
  assert.ok(serviceNames.has("gatekeeper"));
  assert.ok(serviceNames.has("oracle"));
  assert.ok(serviceNames.has("terminal client"));
  assert.ok(serviceNames.has("ops"));
  assert.ok(!serviceNames.has("foundry toml"));
  assert.ok(!serviceNames.has("ordered gateway"));
  assert.ok(!serviceNames.has("no public rest api"));
  assert.ok(serviceNames.size >= 6, `expected concrete services, got ${JSON.stringify(Array.from(serviceNames))}`);
  assert.ok(Array.isArray(architecture.dependencyOrder));
  assert.ok(architecture.dependencyOrder.length >= 3);
  assert.ok(Array.isArray(epics));
  assert.ok(epics.length >= 2);
});

test("createTasks filters opaque local doc handles while preserving useful references", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          relatedDocs: [
            "docdex:local-xyz",
            "docdex:abc123",
            "docs/sds.md",
            "https://example.com/spec",
            "docs/sds.md",
          ],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const task = result.tasks.find((entry) => entry.title === "Task One");
  assert.ok(task, "expected generated task in result set");
  const links = ((task.metadata as any)?.doc_links ?? []) as string[];
  assert.ok(links.includes("docdex:abc123"));
  assert.ok(links.includes("docs/sds.md"));
  assert.ok(links.includes("https://example.com/spec"));
  assert.ok(!links.some((entry) => entry.startsWith("docdex:local")));
  assert.equal(links.filter((entry) => entry === "docs/sds.md").length, 1);
});

test("createTasks auto-remediates epic service ids and tags multi-service epics as cross_service", async () => {
  const sdsPath = path.join(workspaceRoot, "docs", "sds.md");
  await fs.writeFile(
    sdsPath,
    [
      "# Software Design Specification",
      "## Folder Tree",
      "```text",
      ".",
      "├── services/api-gateway/src/index.ts",
      "├── services/auth/src/index.ts",
      "└── workers/ingest/src/worker.ts",
      "```",
      "## Architectural Dependency Order",
      "- worker-ingest depends on svc-api-gateway",
      "- svc-api-gateway depends on svc-auth",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Cross-service delivery",
          description: "Coordinate API and worker rollout.",
          acceptanceCriteria: ["ac1"],
          serviceIds: ["svc-api-gateway", "worker-ingest", "unknown-surface"],
          tags: ["platform"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [sdsPath],
    agentStream: false,
  });

  const servicesPath = path.join(workspace.mcodaDir, "tasks", "web", "services.json");
  const serviceCatalog = JSON.parse(await fs.readFile(servicesPath, "utf8"));
  const knownServiceIds = new Set((serviceCatalog.services ?? []).map((entry: any) => entry.id));
  assert.ok(knownServiceIds.size > 0);

  const epic = workspaceRepo.epics.find((entry) => entry.title === "Cross-service delivery");
  const metadata = (epic?.metadata ?? {}) as Record<string, unknown>;
  const serviceIds = Array.isArray(metadata.service_ids) ? (metadata.service_ids as string[]) : [];
  const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
  assert.ok(serviceIds.length >= 2, `expected multi-service epic metadata, got: ${JSON.stringify(metadata)}`);
  serviceIds.forEach((serviceId) => assert.ok(knownServiceIds.has(serviceId), `unknown service id persisted: ${serviceId}`));
  assert.ok(tags.includes("cross_service"), `expected cross_service tag in metadata: ${JSON.stringify(metadata)}`);
  assert.ok(
    jobService.logs.some((line) => line.includes("unknown-surface") && line.includes("Auto-remediated")),
    `expected remediation warning in job logs, got: ${jobService.logs.join(" | ")}`,
  );
});

test("createTasks keeps explicit cross_service tag on single-service epics and logs warning", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Platform-wide concern",
          description: "Scope intentionally marked cross-service.",
          acceptanceCriteria: ["ac1"],
          serviceIds: ["http-api-service"],
          tags: ["cross_service"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const epic = workspaceRepo.epics.find((entry) => entry.title === "Platform-wide concern");
  const metadata = (epic?.metadata ?? {}) as Record<string, unknown>;
  const serviceIds = Array.isArray(metadata.service_ids) ? (metadata.service_ids as string[]) : [];
  const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
  assert.equal(serviceIds.length, 1);
  assert.ok(tags.includes("cross_service"), `expected cross_service tag in metadata: ${JSON.stringify(metadata)}`);
  assert.ok(
    jobService.logs.some((line) => line.includes("cross_service") && line.includes("only one service id")),
    `expected single-service cross_service warning in logs, got: ${jobService.logs.join(" | ")}`,
  );
});

test("createTasks fails when unknown epic service ids are present and policy is fail", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Failing epic",
          description: "Contains one valid and one invalid service id.",
          acceptanceCriteria: ["ac1"],
          serviceIds: ["http-api-service", "unknown-service"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentStream: false,
        unknownEpicServicePolicy: "fail",
      }),
    /unknown service ids|phase-0 service references/i,
  );
});

test("alignEpicsToServiceCatalog recovers unresolved service ids from epic text when some explicit ids are valid", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const catalog = {
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    sourceDocs: [],
    services: [
      {
        id: "auth-service",
        name: "auth service",
        aliases: ["authentication service"],
        dependsOnServiceIds: [],
        isFoundational: true,
      },
      {
        id: "billing-service",
        name: "billing service",
        aliases: ["billing"],
        dependsOnServiceIds: ["auth-service"],
        isFoundational: false,
      },
    ],
  };
  const aligned = (service as any).alignEpicsToServiceCatalog(
    [
      {
        localId: "e1",
        title: "Billing rollout",
        description: "Integrate billing service for invoice pipelines.",
        acceptanceCriteria: ["billing service is connected"],
        serviceIds: ["auth-service", "unknown-billing"],
        stories: [],
      },
    ],
    catalog,
    "auto-remediate",
  );
  assert.deepEqual(aligned.epics[0]?.serviceIds, ["auth-service", "billing-service"]);
  assert.ok(aligned.warnings.some((message: string) => message.includes("unknown-billing")));
});

test("alignEpicsToServiceCatalog avoids short-token substring matches and prefers foundational fallback", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const catalog = {
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    sourceDocs: [],
    services: [
      {
        id: "ui-service",
        name: "ui service",
        aliases: ["ui"],
        startupWave: 2,
        dependsOnServiceIds: ["core-service"],
        isFoundational: false,
      },
      {
        id: "core-service",
        name: "core service",
        aliases: ["core"],
        startupWave: 0,
        dependsOnServiceIds: [],
        isFoundational: true,
      },
    ],
  };
  const aligned = (service as any).alignEpicsToServiceCatalog(
    [
      {
        localId: "e1",
        title: "Audit logging reliability",
        description: "Increase resilience for audit trails.",
        acceptanceCriteria: ["audit events persist"],
        serviceIds: [],
        stories: [],
      },
    ],
    catalog,
    "auto-remediate",
  );
  assert.deepEqual(aligned.epics[0]?.serviceIds, ["core-service"]);
});

test("alignEpicsToServiceCatalog surfaces alias collisions as ambiguous mappings", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const catalog = {
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    sourceDocs: [],
    services: [
      {
        id: "billing-api",
        name: "billing api",
        aliases: ["billing service"],
        startupWave: 1,
        dependsOnServiceIds: [],
        isFoundational: true,
      },
      {
        id: "billing-worker",
        name: "billing worker",
        aliases: ["billing service"],
        startupWave: 1,
        dependsOnServiceIds: ["billing-api"],
        isFoundational: false,
      },
    ],
  };
  const aligned = (service as any).alignEpicsToServiceCatalog(
    [
      {
        localId: "e1",
        title: "Billing worker queue sync",
        description: "Ensure billing worker catches up on retries.",
        acceptanceCriteria: ["billing worker queue drains"],
        serviceIds: ["billing service"],
        stories: [],
      },
    ],
    catalog,
    "auto-remediate",
  );
  assert.deepEqual(aligned.epics[0]?.serviceIds, ["billing-worker"]);
  assert.ok(aligned.warnings.some((message: string) => message.includes("Ambiguous mappings")));
});

test("buildServiceCatalogPromptSummary includes all service ids even when detail lines are truncated", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const catalog = {
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    sourceDocs: [],
    services: Array.from({ length: 30 }, (_, index) => ({
      id: `svc-${index + 1}`,
      name: `service ${index + 1}`,
      aliases: [`service-${index + 1}`],
      dependsOnServiceIds: [],
      isFoundational: index === 0,
    })),
  };
  const summary = (service as any).buildServiceCatalogPromptSummary(catalog);
  assert.ok(summary.includes("Allowed serviceIds (30)"));
  assert.ok(summary.includes("svc-30"));
});

test("applyServiceDependencySequencing uses epic serviceIds when task text is generic", () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const plan = {
    epics: [
      {
        localId: "e-api",
        area: "web",
        title: "API Surface",
        description: "Public API implementation",
        acceptanceCriteria: [],
        serviceIds: ["backend-api"],
        tags: [],
        stories: [],
        priorityHint: 1,
      },
      {
        localId: "e-auth",
        area: "web",
        title: "Auth Core",
        description: "Authentication foundation",
        acceptanceCriteria: [],
        serviceIds: ["auth-service"],
        tags: [],
        stories: [],
        priorityHint: 2,
      },
    ],
    stories: [
      {
        localId: "us-api",
        epicLocalId: "e-api",
        title: "API story",
        description: "Implement endpoints",
        acceptanceCriteria: [],
        tasks: [],
        priorityHint: 1,
      },
      {
        localId: "us-auth",
        epicLocalId: "e-auth",
        title: "Auth story",
        description: "Implement auth layer",
        acceptanceCriteria: [],
        tasks: [],
        priorityHint: 1,
      },
    ],
    tasks: [
      {
        localId: "t-api",
        epicLocalId: "e-api",
        storyLocalId: "us-api",
        title: "Implement module",
        description: "Generic implementation task.",
        type: "feature",
        estimatedStoryPoints: 3,
        dependsOnKeys: [],
        priorityHint: 1,
      },
      {
        localId: "t-auth",
        epicLocalId: "e-auth",
        storyLocalId: "us-auth",
        title: "Implement module",
        description: "Generic implementation task.",
        type: "feature",
        estimatedStoryPoints: 3,
        dependsOnKeys: [],
        priorityHint: 1,
      },
    ],
  };
  const docs = [
    {
      id: "doc-1",
      docType: "SDS",
      title: "sds",
      content: "backend api depends on auth service",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments: [],
    },
  ];
  const sequenced = (service as any).applyServiceDependencySequencing(plan, docs);
  assert.equal(sequenced.epics[0]?.localId, "e-auth");
  assert.equal(sequenced.stories[0]?.epicLocalId, "e-auth");
});

test("acquirePlanArtifactLock prevents concurrent writes and releases lock file", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const lockDir = path.join(workspace.mcodaDir, "tasks", "web-lock-test");
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, ".plan-artifacts.lock");
  const releaseLock = await (service as any).acquirePlanArtifactLock(lockDir, {
    timeoutMs: 250,
    pollIntervalMs: 20,
    staleLockMs: 5_000,
  });
  await assert.rejects(
    () =>
      (service as any).acquirePlanArtifactLock(lockDir, {
        timeoutMs: 120,
        pollIntervalMs: 20,
        staleLockMs: 5_000,
      }),
    /Timed out acquiring plan artifact lock/i,
  );
  await releaseLock();
  const releaseAgain = await (service as any).acquirePlanArtifactLock(lockDir, {
    timeoutMs: 250,
    pollIntervalMs: 20,
    staleLockMs: 5_000,
  });
  await releaseAgain();
  await assert.rejects(() => fs.access(lockPath));
});

test("createTasks fails closed when generated backlog invents alternate source-backed path names", async () => {
  await fs.writeFile(path.join(workspaceRoot, "docs", "sds.md"), EP_SDS_FIXTURE, "utf8");
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "ep",
          title: "Gatekeeper Runtime",
          description: "Implement the gatekeeper runtime.",
          acceptanceCriteria: ["Gatekeeper runtime is sequenced after policy configuration."],
          serviceIds: ["gatekeeper"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Runtime startup",
          description: "Start the gatekeeper runtime after policy configuration.",
          acceptanceCriteria: ["Runtime startup order is enforced."],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Wire runtime worker",
          type: "feature",
          description:
            "Implement packages/gatekeeper-oracle/src/worker.ts so it starts after contracts/script/ConfigurePolicies.s.sol.",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "ep",
        inputs: [path.join(workspaceRoot, "docs", "sds.md")],
        agentStream: false,
      }),
    /failed canonical name validation/i,
  );
});

test("createTasks merges qa overrides into task metadata", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
    qaProfiles: ["cli", "chromium"],
    qaEntryUrl: "http://localhost:5555",
    qaStartCommand: "npm run dev",
    qaRequires: ["seed"],
  });

  const metadata = result.tasks[0].metadata as any;
  assert.ok(metadata?.qa?.profiles_expected.includes("chromium"));
  assert.ok(metadata?.qa?.requires.includes("seed"));
  assert.deepEqual(metadata?.qa?.entrypoints, [
    { kind: "web", base_url: "http://localhost:5555", command: "npm run dev" },
  ]);
});

test("createTasks records qa preflight scripts and entrypoints", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        scripts: {
          dev: "vite",
          test: "node tests/all.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Add unit coverage for task path"],
          componentTests: [],
          integrationTests: ["Run integration flow A"],
          apiTests: ["Validate API response contract"],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const preflight = jobService.checkpoints.find((ckpt) => ckpt.stage === "qa_preflight");
  assert.ok(preflight);
  assert.equal(preflight.details.scripts.dev, "vite");
  assert.equal(preflight.details.scripts.test, "node tests/all.js");
  assert.equal(preflight.details.entrypoints[0].command, "package script:dev");
  assert.equal(preflight.details.entrypoints[0].base_url, undefined);
});

test("createTasks records empty qa preflight when package.json is missing", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const preflight = jobService.checkpoints.find((ckpt) => ckpt.stage === "qa_preflight");
  assert.ok(preflight);
  assert.deepEqual(preflight.details.scripts, {});
  assert.deepEqual(preflight.details.entrypoints, []);
});

test("createTasks adds UI entrypoint blocker when scripts are missing", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "UI layout update",
          type: "feature",
          description: "Update UI components",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const task = result.tasks.find((entry) => entry.title === "UI layout update");
  assert.ok(task, "expected generated task in result set");
  const metadata = task.metadata as any;
  assert.ok(
    (metadata?.qa?.blockers as string[]).some((entry) => entry.includes("Missing UI entrypoint")),
  );
});

test("createTasks flags missing test dependencies in qa preflight", async () => {
  await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "tests", "server.test.js"),
    "import request from 'supertest';\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        scripts: {
          test: "node tests/all.js",
        },
        devDependencies: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Add unit coverage for task path"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const jobService = new StubJobService();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const preflight = jobService.checkpoints.find((ckpt) => ckpt.stage === "qa_preflight");
  assert.ok(preflight);
  assert.ok(
    (preflight.details.blockers as string[]).some((entry) => entry.includes("supertest")),
  );
});

test("createTasks invokes agent rating when enabled", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: ["Add unit coverage for task path"],
          componentTests: [],
          integrationTests: ["Run integration flow A"],
          apiTests: ["Validate API response contract"],
        },
      ],
    }),
  ];
  const ratingService = new StubRatingService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    ratingService: ratingService as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
    rateAgents: true,
  });

  assert.equal(ratingService.calls.length, 1);
  assert.equal(ratingService.calls[0]?.commandName, "create-tasks");
  assert.equal(ratingService.calls[0]?.agentId, "agent-1");
});

test("createTasks keeps duplicate local ids scoped across epics and stories", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
        {
          localId: "e2",
          area: "bck",
          title: "Epic Two",
          description: "Epic desc",
          acceptanceCriteria: ["ac2"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc one",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story Two",
          description: "Story desc two",
          acceptanceCriteria: ["s ac2"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Story One Task One",
          type: "feature",
          description: "Task one",
          estimatedStoryPoints: 3,
          priorityHint: 1,
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t2",
          title: "Story One Task Two",
          type: "feature",
          description: "Task two",
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: ["t1"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Story Two Task One",
          type: "feature",
          description: "Task one",
          estimatedStoryPoints: 3,
          priorityHint: 1,
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t2",
          title: "Story Two Task Two",
          type: "feature",
          description: "Task two",
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: ["t1"],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const generatedTasks = result.tasks.filter((task) => /^Story (One|Two) Task (One|Two)$/i.test(task.title));
  assert.equal(result.stories.length, 3);
  assert.equal(generatedTasks.length, 4);
  const tasksById = new Map(generatedTasks.map((task) => [task.id, task]));
  const storyTaskCount = new Map<string, number>();
  for (const task of generatedTasks) {
    storyTaskCount.set(task.userStoryId, (storyTaskCount.get(task.userStoryId) ?? 0) + 1);
  }
  assert.equal(Math.max(...Array.from(storyTaskCount.values())), 2);
  assert.equal(Math.min(...Array.from(storyTaskCount.values())), 2);
  const generatedDependencies = result.dependencies.filter(
    (dep) => tasksById.has(dep.taskId) && tasksById.has(dep.dependsOnTaskId),
  );
  assert.equal(generatedDependencies.length, 2);
  for (const dep of generatedDependencies) {
    const from = tasksById.get(dep.taskId);
    const to = tasksById.get(dep.dependsOnTaskId);
    assert.ok(from);
    assert.ok(to);
    assert.equal(from?.userStoryId, to?.userStoryId);
  }
});

test("createTasks fails fast on duplicate scoped task local ids", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc one",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task one",
          type: "feature",
          description: "Task one",
          estimatedStoryPoints: 3,
          priorityHint: 1,
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t1",
          title: "Task two",
          type: "feature",
          description: "Task two",
          estimatedStoryPoints: 2,
          priorityHint: 2,
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentStream: false,
      }),
    /duplicate task scope: e1::us1::t1/,
  );
  assert.equal(workspaceRepo.tasks.length, 0);
  assert.equal(workspaceRepo.deps.length, 0);
});

test("createTasks fuzzy-discovers SDS-like docs and injects structure bootstrap tasks", async () => {
  const externalSdsPath = path.join(workspaceRoot, "software-design-outline.md");
  await fs.writeFile(
    externalSdsPath,
    [
      "# Software Design",
      "Folder tree:",
      "- services/api/src/index.ts",
      "- apps/web/src/main.tsx",
      "- packages/shared/src/index.ts",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const docdex = new StubDocdex();
  const workspaceRepo = new StubWorkspaceRepo();
  const preflightService = new StubSdsPreflightService(buildPassingPreflightResult([externalSdsPath]));
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () => preflightService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(docdex.registeredFiles.some((entry) => entry.endsWith("software-design-outline.md")));
  assert.ok(result.tasks.some((task) => task.title === "Create SDS-aligned folder tree"));
  assert.ok(result.tasks.length >= 4);
  const bootstrapTask = result.tasks.find((task) => task.title === "Create SDS-aligned folder tree");
  assert.ok(bootstrapTask);
});

test("createTasks includes fuzzy SDS docs outside default docs paths when docs directory exists", async () => {
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.md"), "# Notes\nGeneral requirements.", "utf8");
  const externalSdsPath = path.join(workspaceRoot, "software-design-outline.md");
  await fs.writeFile(
    externalSdsPath,
    [
      "# Software Design",
      "Folder tree:",
      "- services/api/src/index.ts",
      "- apps/web/src/main.tsx",
      "- packages/shared/src/index.ts",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const docdex = new StubDocdex();
  const workspaceRepo = new StubWorkspaceRepo();
  const preflightService = new StubSdsPreflightService(buildPassingPreflightResult([externalSdsPath]));
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async () => preflightService as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(docdex.registeredFiles.some((entry) => entry === externalSdsPath));
  assert.ok(result.tasks.some((task) => task.title === "Create SDS-aligned folder tree"));
});

test("createTasks auto-discovers SDS docs when explicit inputs omit them", async () => {
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.md"), "# Notes\nGeneral requirements only.", "utf8");
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story desc",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Task One",
          type: "feature",
          description: "Task desc",
          estimatedStoryPoints: 3,
          priorityHint: 5,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const docdex = new StubDocdexTyped();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: docdex as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [path.join("docs", "notes.md")],
    agentStream: false,
  });

  assert.ok(
    docdex.registeredFiles.some((entry) => entry.endsWith(path.join("docs", "sds.md"))),
    `expected SDS file to be discovered; registered=${docdex.registeredFiles.join(", ")}`,
  );
});

test("createTasks blocks when no SDS document is discoverable", async () => {
  await fs.rm(path.join(workspaceRoot, "docs"), { recursive: true, force: true });
  await fs.writeFile(path.join(workspaceRoot, "requirements.md"), "# Requirements\nProduct objectives.", "utf8");
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    sdsPreflightFactory: async (resolvedWorkspace) => originalSdsPreflightCreate(resolvedWorkspace),
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [path.join(workspaceRoot, "requirements.md")],
        agentStream: false,
      }),
    /requires an SDS document/i,
  );
});

test("createTasks infers service dependency ordering from SDS text", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "architecture-overview.md"),
    [
      "# Architecture Overview",
      "Service dependency baseline:",
      "- web ui depends on backend api",
      "- backend api depends on database service",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Implementation",
          description: "Implement services",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Deliver service stack",
          description: [
            "Build dependent services in order.",
            "web ui depends on backend api",
            "backend api depends on database service",
          ].join("\n"),
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t-web",
          title: "Implement web ui shell",
          type: "feature",
          description: "Build web UI shell for user flows.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t-api",
          title: "Implement backend api endpoints",
          type: "feature",
          description: "Build backend API endpoints for web consumers.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t-db",
          title: "Implement database service schema",
          type: "feature",
          description: "Create database service schema and migrations.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const taskById = new Map(result.tasks.map((task) => [task.id, task]));
  const taskByTitle = new Map(result.tasks.map((task) => [task.title, task]));
  const webTask = taskByTitle.get("Implement web ui shell");
  const apiTask = taskByTitle.get("Implement backend api endpoints");
  const dbTask = taskByTitle.get("Implement database service schema");
  assert.ok(webTask);
  assert.ok(apiTask);
  assert.ok(dbTask);
  const depPairs = result.dependencies
    .map((dep) => {
      const from = taskById.get(dep.taskId);
      const to = taskById.get(dep.dependsOnTaskId);
      return `${from?.title ?? ""}->${to?.title ?? ""}`;
    })
    .filter(Boolean);
  assert.ok(
    depPairs.includes("Implement backend api endpoints->Implement database service schema"),
    `unexpected dependencies: ${depPairs.join(" | ")}`,
  );
  assert.ok(
    depPairs.includes("Implement web ui shell->Implement backend api endpoints"),
    `unexpected dependencies: ${depPairs.join(" | ")}`,
  );
});

test("createTasks prioritizes startup waves from SDS dependency tables", async () => {
  await fs.writeFile(
    path.join(workspaceRoot, "architecture-overview.md"),
    [
      "# Startup Dependency Contract",
      "| Service | Startup wave (`13.3.1.1`) | Startup dependencies | Runtime dependencies |",
      "|---|---|---|---|",
      "| `svc-api-gateway` | `Wave 1` | IAM, Redis | downstream services |",
      "| `svc-market-data` | `Wave 2` | Kafka, Redis | venue adapters |",
      "| `ui-web` | `Wave 7` | `svc-api-gateway` | ws/read models |",
    ].join("\n"),
    "utf8",
  );
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Implementation",
          description: "Implement services",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Deliver startup-aligned services",
          description: "Implement services aligned with startup waves.",
          acceptanceCriteria: ["s ac1"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t-ui",
          title: "Implement ui-web shell",
          type: "feature",
          description: "Build the UI shell consuming gateway APIs.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t-market",
          title: "Implement svc-market-data ingestion",
          type: "feature",
          description: "Build market feed ingestion service.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
        {
          localId: "t-gateway",
          title: "Implement svc-api-gateway routes",
          type: "feature",
          description: "Build gateway routing layer.",
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  const orderedTitles = result.tasks.map((task) => task.title);
  const gatewayIndex = orderedTitles.indexOf("Implement svc-api-gateway routes");
  const marketIndex = orderedTitles.indexOf("Implement svc-market-data ingestion");
  const uiIndex = orderedTitles.indexOf("Implement ui-web shell");
  assert.ok(gatewayIndex >= 0 && marketIndex >= 0 && uiIndex >= 0);
  assert.ok(
    gatewayIndex < marketIndex && marketIndex < uiIndex,
    `unexpected task order from startup waves: ${orderedTitles.join(" | ")}`,
  );
});

test("createTasks tolerates JSON wrapped in think tags", async () => {
  const epic = {
    epics: [
      {
        localId: "e1",
        area: "web",
        title: "Epic One",
        description: "Epic desc",
        acceptanceCriteria: ["ac1"],
      },
    ],
  };
  const story = {
    stories: [
      {
        localId: "us1",
        title: "Story One",
        description: "Story desc",
        acceptanceCriteria: ["s ac1"],
      },
    ],
  };
  const task = {
    tasks: [
      {
        localId: "t1",
        title: "Task One",
        type: "feature",
        description: "Task desc",
        estimatedStoryPoints: 3,
        priorityHint: 5,
        dependsOnKeys: [],
        unitTests: ["Add unit coverage for task path"],
        componentTests: [],
        integrationTests: ["Run integration flow A"],
        apiTests: ["Validate API response contract"],
      },
    ],
  };
  const outputs = [
    `<think>${JSON.stringify(epic)}</think>\n${JSON.stringify(epic)}`,
    `<think>${JSON.stringify(story)}</think>\n${JSON.stringify(story)}`,
    `<think>${JSON.stringify(task)}</think>\n${JSON.stringify(task)}`,
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(result.epics.length >= 1);
  assert.ok(result.stories.length >= 1);
  assert.ok(result.tasks.some((task) => task.title === "Task One"));
});

test("createTasks falls back to deterministic planning on invalid agent output", async () => {
  const outputs = ["not json"];
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });
  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });
  assert.ok(result.epics.length >= 1);
  assert.ok(result.stories.length >= 1);
  assert.ok(result.tasks.length >= 1);
  assert.ok(!result.tasks.some((task) => task.title === "Implement baseline project scaffolding"));
  assert.ok(
    result.tasks.some(
      (task: any) =>
        /^Implement /i.test(task.title) &&
        ((task.metadata?.files as string[] | undefined) ?? []).some((file) =>
          /apps\/web|services\/api|services\/worker|packages\/shared/i.test(file),
        ),
    ),
    `expected architecture-first implementation tasks, got ${result.tasks.map((task) => task.title).join(" | ")}`,
  );
  assert.ok(
    jobService.checkpoints.some(
      (entry) =>
        entry.stage === "epics_generated" &&
        (entry.details?.source === "fallback" || entry.details?.source === "sds"),
    ),
  );
});

test("outputSchemaForAction returns Codex-compatible strict object schemas", () => {
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: new StubWorkspaceRepo() as any,
    taskOrderingFactory: createOrderingFactory(new StubWorkspaceRepo()) as any,
  });

  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      const properties = Object.keys(node.properties ?? {}).sort();
      const required = Array.isArray(node.required) ? [...node.required].sort() : [];
      assert.deepEqual(required, properties);
      for (const child of Object.values(node.properties ?? {})) {
        visit(child);
      }
      return;
    }
    if (node.type === "array") {
      visit(node.items);
      return;
    }
    if (Array.isArray(node.anyOf)) {
      for (const child of node.anyOf) {
        visit(child);
      }
    }
  };

  visit((service as any).outputSchemaForAction("full_plan"));
  visit((service as any).outputSchemaForAction("epics"));
  visit((service as any).outputSchemaForAction("stories"));
  visit((service as any).outputSchemaForAction("stories_batch"));
  visit((service as any).outputSchemaForAction("tasks"));
  visit((service as any).outputSchemaForAction("tasks_compact"));
  visit((service as any).outputSchemaForAction("tasks_batch"));
});

test("createTasks repairs invalid explicit-agent planning output without switching to deterministic fallback", async () => {
  const outputs = [
    "not json",
    "still not json",
    JSON.stringify(await buildDefaultSdsDrivenAgentPlan()),
  ];
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const agentService = new StubAgentService(outputs);
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  (service as any).shouldUseStrictAgentStagedPlanning = () => ({ useStaged: false, promptTokens: 1000 });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentName: "agent-1",
    agentStream: false,
  });

  assert.ok(result.tasks.length > 0);
  assert.ok(
    jobService.checkpoints.some(
      (entry) =>
        entry.stage === "epics_generated" &&
        entry.details?.source === "agent" &&
        entry.details?.mode === "strict_full_plan",
    ),
  );
  assert.ok(!jobService.logs.some((line) => /deterministic planner fallback/i.test(line)));
  assert.ok(jobService.tokenUsage.length >= 3, `expected failed attempts to be recorded, got ${jobService.tokenUsage.length}`);
  assert.ok(jobService.tokenUsage.some((entry) => entry.metadata?.attempt === 2));
  assert.ok(agentService.invocations.some((entry) => entry.metadata?.action === "full_plan"));
});

test("createTasks recovers from strict full-plan timeout by switching to staged agent planning", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const agentService = new StubAgentService([]);
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  (service as any).shouldUseStrictAgentStagedPlanning = () => ({ useStaged: false, promptTokens: 1000 });
  (service as any).generateStrictAgentPlan = async () => {
    throw new Error("AUTH_ERROR: codex CLI timed out after 900000ms");
  };
  (service as any).generateStrictAgentPlanStaged = async () => ({
    epics: [
      {
        localId: "e1",
        area: "web",
        title: "Build Runtime",
        description: "Build the runtime surface.",
        acceptanceCriteria: ["Runtime surface exists"],
        relatedDocs: ["docdex:doc-1"],
        priorityHint: 10,
        serviceIds: ["svc-api"],
        tags: [],
        stories: [],
      },
    ],
    stories: [
      {
        localId: "us1",
        epicLocalId: "e1",
        title: "Implement runtime service",
        userStory: "As an operator, I need the runtime service to exist.",
        description: "Implement the runtime service module and entrypoint.",
        acceptanceCriteria: ["Runtime module is wired"],
        relatedDocs: ["docdex:doc-1"],
        priorityHint: 10,
        tasks: [],
      },
    ],
    tasks: [
      {
        localId: "t1",
        epicLocalId: "e1",
        storyLocalId: "us1",
        title: "Implement runtime module",
        type: "feature",
        description: "Implement services/api/src/runtime.ts and wire services/api/src/index.ts so the runtime service can execute.",
        files: ["services/api/src/runtime.ts", "services/api/src/index.ts"],
        estimatedStoryPoints: 3,
        priorityHint: 10,
        dependsOnKeys: [],
        relatedDocs: ["docdex:doc-1"],
        unitTests: ["Add runtime unit coverage"],
        componentTests: [],
        integrationTests: ["Run runtime integration coverage"],
        apiTests: [],
        qa: null,
      },
    ],
  });
  (service as any).planLooksTooWeakForSds = () => false;
  (service as any).buildProjectCompletionReport = () => ({
    projectKey: "web",
    generatedAt: new Date().toISOString(),
    score: 100,
    threshold: 80,
    satisfied: true,
    summary: "ok",
    architectureRoots: [],
    metrics: {
      architectureUnitCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      implementationSurfaceCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      crossCuttingCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      dependencyOrderCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      verificationSupportCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      implementationToVerificationBalance: { numerator: 1, denominator: 1, ratio: 1 },
      docsOnlyPenalty: { count: 0, ratio: 0 },
      metaTaskPenalty: { count: 0, ratio: 0 },
    },
    issues: [],
    unitCoverage: [],
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentName: "agent-1",
    agentStream: false,
  });

  assert.ok(result.tasks.length > 0);
  assert.ok(
    jobService.checkpoints.some(
      (entry) =>
        entry.stage === "epics_generated" &&
        entry.details?.source === "agent" &&
        entry.details?.mode === "strict_staged_plan",
    ),
  );
  assert.ok(
    jobService.logs.some((line) => /recovering from full-plan timeout through staged generation/i.test(line)),
    `expected staged recovery log, got ${jobService.logs.join("\n")}`,
  );
  assert.ok(!jobService.logs.some((line) => /deterministic planner fallback/i.test(line)));
  assert.equal(agentService.invocations.length, 0);
});

test("collectStrictEpicChunk uses compact single-unit epic generation with retry instead of batch timeout loops", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const unit = {
    unitId: "svc-shared",
    kind: "service",
    name: "shared package",
    summary: "Shared runtime and contract package.",
    sourceHeadings: ["Architecture Overview"],
    implementationTargets: ["packages/shared/src/index.ts"],
    supportingTargets: [],
    verificationTargets: [],
    verificationSurfaceIds: [],
    dependsOnUnitIds: [],
    startupWave: 0,
    isFoundational: true,
    sourceServiceIds: ["shared"],
    completionSignals: ["shared package exists"],
  };
  let batchAttempts = 0;
  let singleUnitAttempts = 0;
  (service as any).generateEpicsForArchitectureChunk = async () => {
    batchAttempts += 1;
    return [];
  };
  (service as any).generateEpicForSingleArchitectureUnit = async (params: { retryReason?: string }) => {
    singleUnitAttempts += 1;
    if (!params.retryReason) {
      throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
    }
    return [
      {
        localId: "e1",
        area: "ep",
        title: "Build Shared Package",
        description: "Repair-generated shared package epic.",
        acceptanceCriteria: [],
        relatedDocs: [],
        priorityHint: 1,
        serviceIds: ["shared"],
        tags: [],
        stories: [],
      },
    ];
  };

  const collectedEpics: any[] = [];
  await (service as any).collectStrictEpicChunk({
    agent: { id: "agent-1", slug: "agent-1" },
    projectKey: "EP",
    chunk: [unit],
    docSummary: "",
    projectBuildMethod: "",
    serviceCatalog: { projectKey: "EP" },
    options: {},
    stream: true,
    jobId: "job-1",
    commandRunId: "cmd-1",
    collectedEpics,
  });

  assert.equal(batchAttempts, 0);
  assert.equal(singleUnitAttempts, 2);
  assert.equal(collectedEpics.length, 1);
  assert.equal(collectedEpics[0]?.title, "Build Shared Package");
  assert.ok(
    jobService.logs.some((line) => /strict single-unit epic generation requested/i.test(line)),
    `expected single-unit generation log, got ${jobService.logs.join("\n")}`,
  );
  assert.ok(
    jobService.logs.some((line) => /retrying through single-unit repair/i.test(line)),
    `expected single-unit repair log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictEpicChunk falls back to deterministic architecture scaffold when both single-unit agent attempts fail", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const unit = {
    unitId: "gate-release-readiness",
    kind: "release_gate",
    name: "release readiness",
    summary: "Release readiness gate for SDS acceptance scenarios.",
    sourceHeadings: ["Wave 4", "Acceptance"],
    implementationTargets: ["ops/scripts/verify-release.sh"],
    supportingTargets: [],
    verificationTargets: ["ops/tests/release"],
    verificationSurfaceIds: [],
    dependsOnUnitIds: ["svc-ops"],
    startupWave: 4,
    isFoundational: false,
    sourceServiceIds: ["ops"],
    completionSignals: ["release readiness verified"],
  };
  let singleUnitAttempts = 0;
  (service as any).generateEpicForSingleArchitectureUnit = async () => {
    singleUnitAttempts += 1;
    throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
  };

  const collectedEpics: any[] = [];
  await (service as any).collectStrictEpicChunk({
    agent: { id: "agent-1", slug: "agent-1" },
    projectKey: "EP",
    chunk: [unit],
    docSummary: "",
    projectBuildMethod: "",
    serviceCatalog: { projectKey: "EP" },
    options: {},
    stream: true,
    jobId: "job-1",
    commandRunId: "cmd-1",
    collectedEpics,
  });

  assert.equal(singleUnitAttempts, 2);
  assert.equal(collectedEpics.length, 1);
  assert.equal(collectedEpics[0]?.title, "Verify Release Readiness");
  assert.deepEqual(collectedEpics[0]?.serviceIds, ["ops"]);
  assert.ok(
    jobService.logs.some((line) => /using deterministic architecture scaffold and continuing/i.test(line)),
    `expected deterministic scaffold log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictStoriesChunk falls back to deterministic story scaffold when strict story repair fails", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  (service as any).generateStoriesForEpic = async () => {
    throw new Error("Agent output was not valid JSON for stories");
  };
  (service as any).repairStoriesForEpic = async () => {
    throw new Error("Agent output was not valid JSON for stories");
  };

  const storiesByEpic = new Map<string, any[]>();
  await (service as any).collectStrictStoriesChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [epic],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    storiesByEpic,
  );

  assert.equal(storiesByEpic.get("e1")?.length, 1);
  assert.equal(storiesByEpic.get("e1")?.[0]?.title, "Deliver Build Shared");
  assert.ok(
    jobService.logs.some((line) => /using deterministic fallback story and continuing/i.test(line)),
    `expected deterministic story fallback log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictStoriesChunk falls back when strict story repair returns no stories after empty output", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  let repairCalls = 0;
  (service as any).generateStoriesForEpic = async () => [];
  (service as any).repairStoriesForEpic = async () => {
    repairCalls += 1;
    return [];
  };

  const storiesByEpic = new Map<string, any[]>();
  await (service as any).collectStrictStoriesChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [epic],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    storiesByEpic,
  );

  assert.equal(repairCalls, 1);
  assert.equal(storiesByEpic.get("e1")?.length, 1);
  assert.equal(storiesByEpic.get("e1")?.[0]?.title, "Deliver Build Shared");
  assert.ok(
    jobService.logs.some((line) =>
      /Strict story repair returned no stories .* after empty output\. Using deterministic fallback story/i.test(
        line,
      ),
    ),
    `expected empty-output story fallback log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictTasksChunk falls back to deterministic task scaffold when strict task repair fails", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  const story = {
    localId: "us1",
    epicLocalId: "e1",
    title: "Implement shared runtime",
    userStory: "As an operator, I need the shared runtime.",
    description: "Implement shared runtime surfaces.",
    acceptanceCriteria: ["runtime exists"],
    relatedDocs: [],
    priorityHint: 1,
    tasks: [],
  };
  (service as any).generateTasksForStory = async () => {
    throw new Error("Agent output was not valid JSON for tasks");
  };
  (service as any).repairTasksForStory = async () => {
    throw new Error("Agent output was not valid JSON for tasks");
  };

  const tasksByStoryScope = new Map<string, any[]>();
  await (service as any).collectStrictTasksChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [{ epic, story }],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    new Map([["e1", "Build Shared"]]),
    tasksByStoryScope,
  );

  const fallbackTasks = tasksByStoryScope.get("e1::us1") ?? [];
  assert.ok(fallbackTasks.length >= 1);
  assert.match(fallbackTasks[0]?.title ?? "", /Implement .*shared runtime/i);
  assert.ok(
    jobService.logs.some((line) => /using deterministic fallback tasks and continuing/i.test(line)),
    `expected deterministic task fallback log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictTasksChunk falls back when strict task repair returns no tasks after empty output", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  const story = {
    localId: "us1",
    epicLocalId: "e1",
    title: "Implement shared runtime",
    userStory: "As an operator, I need the shared runtime.",
    description: "Implement shared runtime surfaces.",
    acceptanceCriteria: ["runtime exists"],
    relatedDocs: [],
    priorityHint: 1,
    tasks: [],
  };
  let repairCalls = 0;
  (service as any).generateTasksForStory = async () => [];
  (service as any).repairTasksForStory = async () => {
    repairCalls += 1;
    return [];
  };

  const tasksByStoryScope = new Map<string, any[]>();
  await (service as any).collectStrictTasksChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [{ epic, story }],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    new Map([["e1", "Build Shared"]]),
    tasksByStoryScope,
  );

  assert.equal(repairCalls, 1);
  const fallbackTasks = tasksByStoryScope.get("e1::us1") ?? [];
  assert.ok(fallbackTasks.length >= 1);
  assert.match(fallbackTasks[0]?.title ?? "", /Implement .*shared runtime/i);
  assert.ok(
    jobService.logs.some((line) =>
      /Strict task repair returned no tasks .* after empty output\. Using deterministic fallback tasks/i.test(
        line,
      ),
    ),
    `expected empty-output task fallback log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictStoriesChunk skips repair after timeout-like single-epic failure", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  let repairCalls = 0;
  (service as any).generateStoriesForEpic = async () => {
    throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
  };
  (service as any).repairStoriesForEpic = async () => {
    repairCalls += 1;
    return [];
  };

  const storiesByEpic = new Map<string, any[]>();
  await (service as any).collectStrictStoriesChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [epic],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    storiesByEpic,
  );

  assert.equal(repairCalls, 0);
  assert.equal(storiesByEpic.get("e1")?.length, 1);
  assert.equal(storiesByEpic.get("e1")?.[0]?.title, "Deliver Build Shared");
  assert.ok(
    jobService.logs.some((line) => /without a second repair attempt/i.test(line)),
    `expected timeout short-circuit log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictTasksChunk retries timeout-like single-story failure through repair before fallback", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  const story = {
    localId: "us1",
    epicLocalId: "e1",
    title: "Implement shared runtime",
    userStory: "As an operator, I need the shared runtime.",
    description: "Implement shared runtime surfaces.",
    acceptanceCriteria: ["runtime exists"],
    relatedDocs: [],
    priorityHint: 1,
    tasks: [],
  };
  let repairCalls = 0;
  (service as any).generateTasksForStory = async () => {
    throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
  };
  (service as any).repairTasksForStory = async () => {
    repairCalls += 1;
    return [
      {
        localId: "t-repair-1",
        title: "Repair shared runtime module",
        type: "feature",
        description: "Repair packages/shared/src/runtime.ts after the timed out generation attempt.",
        files: ["packages/shared/src/runtime.ts"],
        estimatedStoryPoints: 3,
        priorityHint: 10,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
        qa: null,
      },
    ];
  };

  const tasksByStoryScope = new Map<string, any[]>();
  await (service as any).collectStrictTasksChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [{ epic, story }],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    new Map([["e1", "Build Shared"]]),
    tasksByStoryScope,
  );

  assert.equal(repairCalls, 1);
  const timeoutRecoveredTasks = tasksByStoryScope.get("e1::us1") ?? [];
  assert.equal(timeoutRecoveredTasks.length, 1);
  assert.equal(timeoutRecoveredTasks[0]?.title, "Repair shared runtime module");
  assert.ok(
    jobService.logs.some((line) => /Retrying through strict staged recovery before deterministic fallback/i.test(line)),
    `expected timeout recovery log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictTasksChunk falls back after timeout when strict repair also fails", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  const story = {
    localId: "us1",
    epicLocalId: "e1",
    title: "Implement shared runtime",
    userStory: "As an operator, I need the shared runtime.",
    description: "Implement shared runtime surfaces.",
    acceptanceCriteria: ["runtime exists"],
    relatedDocs: [],
    priorityHint: 1,
    tasks: [],
  };
  let repairCalls = 0;
  (service as any).generateTasksForStory = async () => {
    throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
  };
  (service as any).repairTasksForStory = async () => {
    repairCalls += 1;
    throw new Error("AUTH_ERROR: codex CLI timed out after 120000ms");
  };

  const tasksByStoryScope = new Map<string, any[]>();
  await (service as any).collectStrictTasksChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [{ epic, story }],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    new Map([["e1", "Build Shared"]]),
    tasksByStoryScope,
  );

  assert.equal(repairCalls, 1);
  const timeoutFallbackTasks = tasksByStoryScope.get("e1::us1") ?? [];
  assert.ok(timeoutFallbackTasks.length >= 1);
  assert.match(timeoutFallbackTasks[0]?.title ?? "", /Implement .*shared runtime/i);
  assert.ok(
    jobService.logs.some((line) => /after timeout\. Using deterministic fallback tasks/i.test(line)),
    `expected timeout fallback log, got ${jobService.logs.join("\n")}`,
  );
});

test("collectStrictTasksChunk passes compact repair mode for deterministic single-story recovery", async () => {
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const epic = {
    localId: "e1",
    area: "ep",
    title: "Build Shared",
    description: "Build shared service surfaces.",
    acceptanceCriteria: ["shared service exists"],
    relatedDocs: [],
    priorityHint: 1,
    serviceIds: ["shared"],
    tags: [],
    stories: [],
  };
  const story = {
    localId: "us1",
    epicLocalId: "e1",
    title: "Implement shared runtime",
    userStory: "As an operator, I need the shared runtime.",
    description: "Implement shared runtime surfaces.",
    acceptanceCriteria: ["runtime exists"],
    relatedDocs: [],
    priorityHint: 1,
    tasks: [],
  };
  let repairOptions: any;
  (service as any).generateTasksForStory = async () => {
    throw new Error("Agent output was not valid JSON for tasks_compact");
  };
  (service as any).repairTasksForStory = async (...args: any[]) => {
    repairOptions = args[11];
    return [
      {
        localId: "t1",
        title: "Implement shared runtime module",
        type: "feature",
        description: "Implement packages/shared/src/runtime.ts.",
        files: ["packages/shared/src/runtime.ts"],
        estimatedStoryPoints: 3,
        priorityHint: 10,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
        qa: null,
      },
    ];
  };

  const tasksByStoryScope = new Map<string, any[]>();
  await (service as any).collectStrictTasksChunk(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    [{ epic, story }],
    "",
    "",
    true,
    "job-1",
    "cmd-1",
    new Map([["e1", "Build Shared"]]),
    tasksByStoryScope,
    { compactSingleStorySchema: true },
  );

  assert.equal(repairOptions?.compactSchema, true);
  assert.equal(tasksByStoryScope.get("e1::us1")?.[0]?.title, "Implement shared runtime module");
});

test("single-item story generation and repair use bounded timeout metadata with compact context", async () => {
  const largeBuildMethod = `build-start\n${"build-step ".repeat(4000)}\nbuild-end-sentinel`;
  const largeDocSummary = `doc-start\n${"doc-segment ".repeat(5000)}\ndoc-end-sentinel`;
  const agentService = new StubAgentService([
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Implement shared runtime",
          userStory: "As an operator, I need shared runtime support.",
          description: "Implement shared runtime surfaces.",
          acceptanceCriteria: ["shared runtime works"],
          relatedDocs: [],
          priorityHint: 1,
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us2",
          title: "Repair shared runtime sequencing",
          userStory: "As an operator, I need repaired shared runtime sequencing.",
          description: "Repair story output for shared runtime.",
          acceptanceCriteria: ["repair works"],
          relatedDocs: [],
          priorityHint: 2,
        },
      ],
    }),
  ]);
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  await (service as any).generateStoriesForEpic(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    {
      localId: "e1",
      key: "e1",
      title: "Build Shared",
      description: "Build shared service surfaces.",
      acceptanceCriteria: ["shared service exists"],
      relatedDocs: [],
      priorityHint: 1,
      serviceIds: ["shared"],
      tags: [],
      stories: [],
    },
    largeDocSummary,
    largeBuildMethod,
    false,
    "job-1",
    "cmd-1",
  );
  await (service as any).repairStoriesForEpic(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    {
      localId: "e1",
      key: "e1",
      title: "Build Shared",
      description: "Build shared service surfaces.",
      acceptanceCriteria: ["shared service exists"],
      relatedDocs: [],
      priorityHint: 1,
      serviceIds: ["shared"],
      tags: [],
      stories: [],
    },
    largeDocSummary,
    largeBuildMethod,
    "AUTH_ERROR: codex CLI timed out after 120000ms",
    [
      {
        localId: "us-fallback-1",
        title: "Deliver Build Shared",
        userStory: "As a delivery team, we need an executable implementation story for Build Shared.",
        description: "Fallback story.",
        acceptanceCriteria: ["fallback works"],
        relatedDocs: [],
        priorityHint: 1,
        tasks: [],
      },
    ],
    false,
    "job-1",
    "cmd-1",
  );

  const storyInvocations = agentService.invocations.filter((entry) => entry.metadata?.action === "stories");
  assert.equal(storyInvocations.length, 2);
  assert.ok(
    storyInvocations.every((entry) => entry.metadata?.timeoutMs === 120_000),
    `expected bounded story timeout metadata, got ${JSON.stringify(storyInvocations.map((entry) => entry.metadata))}`,
  );
  assert.ok(
    storyInvocations.every((entry) => entry.input.length < 25_000),
    `expected compact story prompts, got lengths ${storyInvocations.map((entry) => entry.input.length).join(", ")}`,
  );
  assert.ok(storyInvocations.every((entry) => !entry.input.includes("doc-end-sentinel")));
  assert.ok(storyInvocations.every((entry) => !entry.input.includes("build-end-sentinel")));
});

test("single-item task generation and repair use bounded timeout metadata with compact context", async () => {
  const largeBuildMethod = `build-start\n${"build-step ".repeat(4000)}\nbuild-end-sentinel`;
  const largeDocSummary = `doc-start\n${"doc-segment ".repeat(5000)}\ndoc-end-sentinel`;
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime",
          type: "feature",
          description: "Implement shared runtime surfaces.",
          files: ["packages/shared/src/index.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 1,
          dependsOnKeys: [],
          relatedDocs: [],
          unitTests: ["tests/unit/shared-runtime.test.ts"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
          qa: null,
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t2",
          title: "Repair shared runtime validation",
          type: "feature",
          description: "Repair task output for shared runtime.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: [],
          relatedDocs: [],
          unitTests: ["tests/unit/shared-runtime-repair.test.ts"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
          qa: null,
        },
      ],
    }),
  ]);
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  await (service as any).generateTasksForStory(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    { key: "e1", title: "Build Shared" },
    {
      localId: "us1",
      key: "us1",
      title: "Implement shared runtime",
      userStory: "As an operator, I need the shared runtime.",
      description: "Implement shared runtime surfaces.",
      acceptanceCriteria: ["runtime exists"],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    largeDocSummary,
    largeBuildMethod,
    false,
    "job-1",
    "cmd-1",
  );
  await (service as any).repairTasksForStory(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    { key: "e1", title: "Build Shared" },
    {
      localId: "us1",
      key: "us1",
      title: "Implement shared runtime",
      userStory: "As an operator, I need the shared runtime.",
      description: "Implement shared runtime surfaces.",
      acceptanceCriteria: ["runtime exists"],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    largeDocSummary,
    largeBuildMethod,
    "AUTH_ERROR: codex CLI timed out after 120000ms",
    [
      {
        localId: "t-fallback-1",
        title: "Implement core scope",
        type: "feature",
        description: "Fallback task.",
        files: [],
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
        qa: null,
      },
    ],
    false,
    "job-1",
    "cmd-1",
  );

  const taskInvocations = agentService.invocations.filter((entry) => entry.metadata?.action === "tasks");
  assert.equal(taskInvocations.length, 2);
  assert.ok(
    taskInvocations.every((entry) => entry.metadata?.timeoutMs === 120_000),
    `expected bounded task timeout metadata, got ${JSON.stringify(taskInvocations.map((entry) => entry.metadata))}`,
  );
  assert.ok(
    taskInvocations.every((entry) => entry.input.length < 28_000),
    `expected compact task prompts, got lengths ${taskInvocations.map((entry) => entry.input.length).join(", ")}`,
  );
  assert.ok(taskInvocations.every((entry) => !entry.input.includes("doc-end-sentinel")));
  assert.ok(taskInvocations.every((entry) => !entry.input.includes("build-end-sentinel")));
});

test("buildDerivedStoriesForEpic splits deterministic stories by architecture targets", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const stories = (service as any).buildDerivedStoriesForEpic(
    {
      localId: "e1",
      area: "shared",
      title: "Build Shared",
      description: "Shared runtime epic.",
      acceptanceCriteria: ["shared completion"],
      relatedDocs: ["docdex:doc-1"],
      priorityHint: 10,
      serviceIds: ["shared"],
      tags: [],
      stories: [],
    },
    {
      unitId: "shared-core",
      kind: "service",
      name: "Shared",
      summary: "Shared runtime surfaces.",
      sourceHeadings: ["Shared"],
      implementationTargets: ["packages/shared/src/runtime.ts", "packages/shared/src/config.ts"],
      supportingTargets: ["packages/shared/src/index.ts"],
      verificationTargets: ["packages/shared/test/runtime.test.ts"],
      verificationSurfaceIds: ["shared-suite"],
      dependsOnUnitIds: ["contracts-core"],
      startupWave: 1,
      isFoundational: true,
      sourceServiceIds: ["shared"],
      completionSignals: ["shared runtime completes startup"],
    },
    new Map([
      [
        "shared-suite",
        {
          surfaceId: "shared-suite",
          kind: "suite",
          name: "Shared Runtime Suite",
          summary: "Shared runtime verification.",
          sourceCoverage: "shared",
          targetHints: ["packages/shared/test/runtime.test.ts"],
          relatedUnitIds: ["shared-core"],
        },
      ],
    ]),
  );

  assert.equal(stories.length, 3);
  assert.equal(stories[0]?.title, "Implement Shared core");
  assert.match(stories[0]?.description ?? "", /packages\/shared\/src\/runtime\.ts/);
  assert.equal(stories[1]?.title, "Integrate Shared dependencies");
  assert.match(stories[1]?.description ?? "", /contracts-core/);
  assert.equal(stories[2]?.title, "Validate Shared readiness");
  assert.match(stories[2]?.description ?? "", /Shared Runtime Suite/);
});

test("createTasks batches strict staged story and task generation to avoid one-call-per-item planning", async () => {
  const outputs = [
    JSON.stringify({
      epicStories: [
        {
          epicLocalId: "e1",
          stories: [
            {
              localId: "us1",
              title: "Build shared package",
              userStory: "As a maintainer, I need shared package scaffolding.",
              description: "Implement packages/shared runtime surfaces.",
              acceptanceCriteria: ["shared story ac"],
              relatedDocs: ["docdex:doc-1"],
              priorityHint: 10,
            },
          ],
        },
        {
          epicLocalId: "e2",
          stories: [
            {
              localId: "us2",
              title: "Build ops scripts",
              userStory: "As an operator, I need release scripts.",
              description: "Implement ops scripts and runbooks.",
              acceptanceCriteria: ["ops story ac"],
              relatedDocs: ["docdex:doc-2"],
              priorityHint: 20,
            },
          ],
        },
      ],
    }),
    JSON.stringify({
      storyTasks: [
        {
          epicLocalId: "e1",
          storyLocalId: "us1",
          tasks: [
            {
              localId: "t1",
              title: "Implement shared package",
              type: "feature",
              description: "Implement packages/shared/src/index.ts and packages/shared/src/types.ts.",
              files: ["packages/shared/src/index.ts", "packages/shared/src/types.ts"],
              estimatedStoryPoints: 3,
              priorityHint: 10,
              dependsOnKeys: [],
              relatedDocs: ["docdex:doc-1"],
              unitTests: ["Run shared unit coverage"],
              componentTests: [],
              integrationTests: [],
              apiTests: [],
              qa: null,
            },
          ],
        },
        {
          epicLocalId: "e2",
          storyLocalId: "us2",
          tasks: [
            {
              localId: "t1",
              title: "Implement ops scripts",
              type: "feature",
              description: "Implement ops/scripts/replay-from-block.sh and docs/runbooks/gatekeeper-replay.md.",
              files: ["ops/scripts/replay-from-block.sh", "docs/runbooks/gatekeeper-replay.md"],
              estimatedStoryPoints: 2,
              priorityHint: 20,
              dependsOnKeys: [],
              relatedDocs: ["docdex:doc-2"],
              unitTests: [],
              componentTests: [],
              integrationTests: ["Run ops integration coverage"],
              apiTests: [],
              qa: null,
            },
          ],
        },
      ],
    }),
  ];
  const agentService = new StubAgentService(outputs);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  (service as any).buildStoryGenerationChunks = (_projectKey: string, epics: any[]) => [epics];
  (service as any).buildTaskGenerationChunks = (_projectKey: string, entries: any[]) => [entries];
  const agent = await agentService.resolveAgent();
  const result = await (service as any).generatePlanFromAgent(
    "web",
    [
      {
        localId: "e1",
        area: "shared",
        title: "Shared Foundation",
        description: "Foundation epic.",
        acceptanceCriteria: ["shared ac"],
        relatedDocs: ["docdex:doc-1"],
        priorityHint: 10,
        serviceIds: ["shared"],
        tags: [],
        stories: [],
      },
      {
        localId: "e2",
        area: "ops",
        title: "Operations",
        description: "Ops epic.",
        acceptanceCriteria: ["ops ac"],
        relatedDocs: ["docdex:doc-2"],
        priorityHint: 20,
        serviceIds: ["ops"],
        tags: [],
        stories: [],
      },
    ],
    agent,
    "Docs: none",
    {
      agentStream: false,
      jobId: "job-1",
      commandRunId: "cmd-1",
      projectBuildMethod: "Build the project in dependency order.",
      strictAgentMode: true,
    },
  );

  assert.equal(result.stories.length, 2);
  assert.equal(result.tasks.length, 2);
  assert.ok(agentService.invocations.some((entry) => entry.metadata?.action === "stories_batch"));
  assert.ok(agentService.invocations.some((entry) => entry.metadata?.action === "tasks_batch"));
  assert.ok(
    agentService.invocations
      .filter((entry) => entry.metadata?.action === "stories_batch" || entry.metadata?.action === "tasks_batch")
      .every((entry) => typeof entry.metadata?.timeoutMs === "number" && (entry.metadata?.timeoutMs as number) > 0),
  );
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "full_plan"));
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "stories"));
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "tasks"));
});

test("generatePlanFromAgent can skip agent story synthesis and use deterministic epic-derived stories with single-story task prompts", async () => {
  const outputs = [
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared package",
          type: "feature",
          description: "Implement packages/shared/src/index.ts and packages/shared/src/types.ts.",
          files: ["packages/shared/src/index.ts", "packages/shared/src/types.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          relatedDocs: ["docdex:doc-1"],
          unitTests: ["pnpm --filter @ep/shared test"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
          qa: null,
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement ops scripts",
          type: "feature",
          description: "Implement ops/scripts/replay-from-block.sh and docs/runbooks/gatekeeper-replay.md.",
          files: ["ops/scripts/replay-from-block.sh", "docs/runbooks/gatekeeper-replay.md"],
          estimatedStoryPoints: 2,
          priorityHint: 20,
          dependsOnKeys: [],
          relatedDocs: ["docdex:doc-2"],
          unitTests: [],
          componentTests: [],
          integrationTests: ["./ops/scripts/replay-from-block.sh --dry-run"],
          apiTests: [],
          qa: null,
        },
      ],
    }),
  ];
  const agentService = new StubAgentService(outputs);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  (service as any).buildTaskGenerationChunks = (_projectKey: string, entries: any[]) => [entries];
  const agent = await agentService.resolveAgent();

  const result = await (service as any).generatePlanFromAgent(
    "web",
    [
      {
        localId: "e1",
        area: "shared",
        title: "Shared Foundation",
        description: "Foundation epic.",
        acceptanceCriteria: ["shared ac"],
        relatedDocs: ["docdex:doc-1"],
        priorityHint: 10,
        serviceIds: ["shared"],
        tags: [],
        stories: [],
      },
      {
        localId: "e2",
        area: "ops",
        title: "Operations",
        description: "Ops epic.",
        acceptanceCriteria: ["ops ac"],
        relatedDocs: ["docdex:doc-2"],
        priorityHint: 20,
        serviceIds: ["ops"],
        tags: [],
        stories: [],
      },
    ],
    agent,
    "Docs: none",
    {
      agentStream: false,
      jobId: "job-1",
      commandRunId: "cmd-1",
      projectBuildMethod: "Build the project in dependency order.",
      strictAgentMode: true,
      strictStagedStoryMode: "deterministic",
    },
  );

  assert.equal(result.stories.length, 2);
  assert.equal(result.tasks.length, 2);
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "stories_batch"));
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "stories"));
  assert.ok(!agentService.invocations.some((entry) => entry.metadata?.action === "tasks_batch"));
  assert.equal(
    agentService.invocations.filter((entry) => entry.metadata?.action === "tasks_compact").length,
    2,
  );
  assert.ok(
    agentService.invocations
      .filter((entry) => entry.metadata?.action === "tasks_compact")
      .every((entry) => Boolean(entry.metadata?.outputSchema)),
    "expected tasks_compact calls to carry structured output schema",
  );
  assert.ok(
    agentService.invocations
      .filter((entry) => entry.metadata?.action === "tasks_compact")
      .every((entry) => /Preserve the seed task localIds/i.test(entry.input)),
    "expected compact task generation to rewrite seeded tasks instead of open-ended synthesis",
  );
  assert.ok(
    jobService.logs.some((line) => /deterministic epic-derived stories/i.test(line)),
    `expected deterministic story log, got ${jobService.logs.join("\n")}`,
  );
  assert.ok(
    jobService.logs.some((line) => /single-story agent task synthesis/i.test(line)),
    `expected deterministic task log, got ${jobService.logs.join("\n")}`,
  );
});

test("repairTasksForStory uses tasks_compact contract for compact single-story recovery", async () => {
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: ["packages/shared/test/runtime.test.ts"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const tasks = await (service as any).repairTasksForStory(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    { key: "e1", title: "Build Shared" },
    {
      key: "us1",
      localId: "us1",
      epicLocalId: "e1",
      title: "Implement shared runtime",
      userStory: "As an operator, I need the shared runtime.",
      description: "Implement shared runtime surfaces.",
      acceptanceCriteria: ["runtime exists"],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    "Docs: none",
    "Build the project in dependency order.",
    "Agent output was not valid JSON for tasks_compact",
    [
      {
        localId: "t-fallback-1",
        title: "Implement shared runtime surfaces",
        type: "feature",
        description: "Implement packages/shared/src/runtime.ts and keep story scope local.",
        files: ["packages/shared/src/runtime.ts"],
        estimatedStoryPoints: 2,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
    true,
    "job-1",
    "cmd-1",
    { compactSchema: true },
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "Implement shared runtime module");
  const invocation = agentService.invocations.at(-1);
  assert.equal(invocation?.metadata?.action, "tasks_compact");
  assert.ok(invocation?.metadata?.outputSchema);
  assert.match(invocation?.input ?? "", /Do not narrate your work/i);
  assert.match(invocation?.input ?? "", /You do not have tool access in this subtask/i);
  assert.match(invocation?.input ?? "", /Preserve the seed task localIds/i);
  assert.match(invocation?.input ?? "", /Return exactly 1 tasks\./i);
});

test("repairTasksForStory uses reduced compact prompt context after timeout-like failure", async () => {
  const largeBuildMethod = `build-start\n${"build-step ".repeat(2000)}\nbuild-end-sentinel`;
  const largeDocSummary = `doc-start\n${"doc-segment ".repeat(2000)}\ndoc-end-sentinel`;
  const largeStoryDescription = `story-start\n${"story-segment ".repeat(2500)}\nstory-end-sentinel`;
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t-fallback-1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          unitTests: ["packages/shared/test/runtime.test.ts"],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const tasks = await (service as any).repairTasksForStory(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    { key: "e1", title: "Build Shared" },
    {
      key: "us1",
      localId: "us1",
      epicLocalId: "e1",
      title: "Implement shared runtime",
      userStory: "As an operator, I need the shared runtime.",
      description: largeStoryDescription,
      acceptanceCriteria: [
        "runtime exists",
        "exports stay stable",
        "type bindings stay compatible",
        "downstream consumers keep compiling",
      ],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    largeDocSummary,
    largeBuildMethod,
    "AUTH_ERROR: codex CLI timed out after 120000ms",
    [
      {
        localId: "t-fallback-1",
        title: "Implement shared runtime surfaces",
        type: "feature",
        description: "Implement packages/shared/src/runtime.ts and keep story scope local.",
        files: ["packages/shared/src/runtime.ts"],
        estimatedStoryPoints: 2,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: ["packages/shared/test/runtime.test.ts"],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ],
    false,
    "job-1",
    "cmd-1",
    { compactSchema: true },
  );

  assert.equal(tasks.length, 1);
  const invocation = agentService.invocations.at(-1);
  assert.equal(invocation?.metadata?.action, "tasks_compact");
  assert.doesNotMatch(invocation?.input ?? "", /doc-end-sentinel/);
  assert.doesNotMatch(invocation?.input ?? "", /build-end-sentinel/);
  assert.doesNotMatch(invocation?.input ?? "", /story-end-sentinel/);
  assert.ok(
    jobService.logs.some((line) => /reduced prompt context/i.test(line)),
    `expected reduced prompt context log, got ${jobService.logs.join("\n")}`,
  );
});

test("planCompactTaskRewriteChunks splits prompt-heavy compact rewrites into minimal chunks", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const seedTasks = [
    {
      localId: "t1",
      title: "Seed runtime",
      type: "feature",
      description: "runtime ".repeat(200),
      files: ["packages/shared/src/runtime.ts", "packages/shared/src/index.ts", "packages/shared/src/config.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 1,
      dependsOnKeys: [],
      relatedDocs: ["docdex:doc-1", "docdex:doc-2", "docdex:doc-3"],
      unitTests: ["runtime-test-1", "runtime-test-2"],
      componentTests: ["runtime-component"],
      integrationTests: ["runtime-integration"],
      apiTests: [],
    },
    {
      localId: "t2",
      title: "Seed pricing",
      type: "feature",
      description: "pricing ".repeat(200),
      files: ["packages/shared/src/pricing/helpers.ts", "packages/shared/src/pricing/index.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 2,
      dependsOnKeys: ["t1"],
      relatedDocs: ["docdex:doc-1", "docdex:doc-2"],
      unitTests: ["pricing-test-1", "pricing-test-2"],
      componentTests: [],
      integrationTests: ["pricing-integration"],
      apiTests: [],
    },
    {
      localId: "t3",
      title: "Seed validation",
      type: "chore",
      description: "validation ".repeat(200),
      files: ["packages/shared/src/validation.ts", "packages/shared/src/validation/index.ts"],
      estimatedStoryPoints: 1,
      priorityHint: 3,
      dependsOnKeys: ["t2"],
      relatedDocs: ["docdex:doc-2", "docdex:doc-3"],
      unitTests: ["validation-test-1", "validation-test-2"],
      componentTests: [],
      integrationTests: ["validation-integration"],
      apiTests: [],
    },
  ];

  const initialChunks = (service as any).splitCompactTaskRewriteChunks(seedTasks);
  const plannedChunks = (service as any).planCompactTaskRewriteChunks({
    projectKey: "EP",
    epic: { key: "e1", title: "Build Shared" },
    story: {
      key: "us1",
      localId: "us1",
      epicLocalId: "e1",
      title: "Implement shared runtime",
      userStory: "As an operator, I need the shared runtime.",
      description: `story-start\n${"story-detail ".repeat(3000)}\nstory-end-sentinel`,
      acceptanceCriteria: [
        "runtime exists",
        "exports stay stable",
        "pricing helpers remain compatible",
        "validation coverage stays wired",
      ],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    docSummary: `doc-start\n${"doc-detail ".repeat(2500)}\ndoc-end-sentinel`,
    projectBuildMethod: `build-start\n${"build-step ".repeat(2500)}\nbuild-end-sentinel`,
    seedTasks,
  });

  assert.equal(initialChunks.length, 1);
  assert.ok(plannedChunks.length >= initialChunks.length);
  assert.ok(plannedChunks.some((chunk: any) => chunk.contextMode === "minimal"));
});

test("generateTasksForStory splits oversized compact rewrites into smaller agent-authored chunks", async () => {
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
        {
          localId: "t2",
          title: "Implement shared pricing helpers",
          type: "feature",
          description: "Implement packages/shared/src/pricing/helpers.ts.",
          files: ["packages/shared/src/pricing/helpers.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: ["t1"],
        },
        {
          localId: "t3",
          title: "Validate shared runtime exports",
          type: "chore",
          description: "Validate packages/shared/src/index.ts exports.",
          files: ["packages/shared/src/index.ts"],
          estimatedStoryPoints: 1,
          priorityHint: 3,
          dependsOnKeys: ["t2"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t4",
          title: "Implement shared schema surface",
          type: "feature",
          description: "Implement packages/shared/src/schemas/runtime.ts.",
          files: ["packages/shared/src/schemas/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 4,
          dependsOnKeys: ["t3"],
        },
        {
          localId: "t5",
          title: "Wire shared schema exports",
          type: "feature",
          description: "Wire packages/shared/src/schemas/index.ts.",
          files: ["packages/shared/src/schemas/index.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 5,
          dependsOnKeys: ["t4"],
        },
        {
          localId: "t6",
          title: "Validate shared schema exports",
          type: "chore",
          description: "Validate packages/shared/src/schemas exports.",
          files: ["packages/shared/src/schemas"],
          estimatedStoryPoints: 1,
          priorityHint: 6,
          dependsOnKeys: ["t5"],
        },
      ],
    }),
  ]);
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  (service as any).buildFallbackTasksForStory = () => [
    {
      localId: "t1",
      title: "Seed runtime",
      type: "feature",
      description: "Seed runtime task.",
      files: ["packages/shared/src/runtime.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 1,
      dependsOnKeys: [],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
    {
      localId: "t2",
      title: "Seed pricing",
      type: "feature",
      description: "Seed pricing task.",
      files: ["packages/shared/src/pricing/helpers.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 2,
      dependsOnKeys: ["t1"],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
    {
      localId: "t3",
      title: "Seed runtime validation",
      type: "chore",
      description: "Seed runtime validation task.",
      files: ["packages/shared/src/index.ts"],
      estimatedStoryPoints: 1,
      priorityHint: 3,
      dependsOnKeys: ["t2"],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
    {
      localId: "t4",
      title: "Seed schema",
      type: "feature",
      description: "Seed schema task.",
      files: ["packages/shared/src/schemas/runtime.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 4,
      dependsOnKeys: ["t3"],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
    {
      localId: "t5",
      title: "Seed schema exports",
      type: "feature",
      description: "Seed schema export task.",
      files: ["packages/shared/src/schemas/index.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 5,
      dependsOnKeys: ["t4"],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
    {
      localId: "t6",
      title: "Seed schema validation",
      type: "chore",
      description: "Seed schema validation task.",
      files: ["packages/shared/src/schemas"],
      estimatedStoryPoints: 1,
      priorityHint: 6,
      dependsOnKeys: ["t5"],
      relatedDocs: [],
      unitTests: [],
      componentTests: [],
      integrationTests: [],
      apiTests: [],
    },
  ];

  const tasks = await (service as any).generateTasksForStory(
    { id: "agent-1", slug: "agent-1" },
    "EP",
    { key: "e1", title: "Build Shared" },
    {
      key: "us1",
      localId: "us1",
      epicLocalId: "e1",
      title: "Implement shared runtime and schema surfaces",
      userStory: "As an operator, I need the shared runtime and schema surfaces.",
      description: "Implement runtime and schema surfaces.",
      acceptanceCriteria: ["runtime exists", "schemas exist"],
      relatedDocs: [],
      priorityHint: 1,
      tasks: [],
    },
    "Docs: none",
    "Build the project in dependency order.",
    false,
    "job-1",
    "cmd-1",
    { compactSchema: true },
  );

  assert.equal(agentService.invocations.length, 2);
  assert.match(agentService.invocations[0]?.input ?? "", /chunk 1\/2/i);
  assert.match(agentService.invocations[1]?.input ?? "", /chunk 2\/2/i);
  assert.equal(tasks.length, 6);
  assert.deepEqual(
    tasks.map((task: any) => task.localId),
    ["t1", "t2", "t3", "t4", "t5", "t6"],
  );
});

test("invokeAgentWithRetry retries timeout-like compact task calls without output schema", async () => {
  const agentService = new StubAgentService([
    new Error("AUTH_ERROR: codex CLI timed out after 120000ms"),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const agent = await agentService.resolveAgent();

  const result = await (service as any).invokeAgentWithRetry(
    agent,
    "Return one compact task as JSON only.",
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-1" },
  );

  assert.ok(result.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 2);
  assert.ok(
    agentService.invocations[0]?.metadata?.outputSchema,
    "expected first compact attempt to carry structured output schema",
  );
  assert.equal(agentService.invocations[1]?.metadata?.outputSchema, undefined);
  assert.equal(agentService.invocations[1]?.metadata?.schemaRetryMode, "without_output_schema");
  assert.ok(
    jobService.logs.some((line) => /retrying once without output schema/i.test(line)),
    `expected schema-free retry log, got ${jobService.logs.join("\n")}`,
  );
});

test("invokeAgentWithRetry prefers schema-free initial compact task calls after a structured timeout in the same run", async () => {
  const agentService = new StubAgentService([
    new Error("AUTH_ERROR: codex CLI timed out after 120000ms"),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t2",
          title: "Wire shared exports",
          type: "feature",
          description: "Wire packages/shared/src/index.ts.",
          files: ["packages/shared/src/index.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: ["t1"],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const first = await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    "Prompt one",
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-1" },
  );
  const second = await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    "Prompt two",
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-2" },
  );

  assert.ok(first.output.includes("\"tasks\""));
  assert.ok(second.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 3);
  assert.ok(agentService.invocations[0]?.metadata?.outputSchema);
  assert.equal(agentService.invocations[1]?.metadata?.outputSchema, undefined);
  assert.equal(agentService.invocations[1]?.metadata?.schemaRetryMode, "without_output_schema");
  assert.equal(agentService.invocations[2]?.metadata?.outputSchema, undefined);
  assert.equal(agentService.invocations[2]?.metadata?.schemaRetryMode, undefined);
  assert.equal(
    jobService.logs.filter((line) => /preferring schema-free initial calls/i.test(line)).length,
    1,
  );
});

test("invokeAgentWithRetry prefers schema-free initial compact task calls for oversized prompts", async () => {
  const agentService = new StubAgentService([
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const oversizedPrompt = `Prompt start\n${"compact-task ".repeat(7000)}\nPrompt end`;
  const result = await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    oversizedPrompt,
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-oversized" },
  );

  assert.ok(result.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 1);
  assert.equal(agentService.invocations[0]?.metadata?.outputSchema, undefined);
  assert.equal(agentService.invocations[0]?.metadata?.schemaRetryMode, undefined);
  assert.ok(
    jobService.logs.some((line) => /prompt estimate .* exceeds structured reliability limit/i.test(line)),
    `expected oversized prompt log, got ${jobService.logs.join("\n")}`,
  );
});

test("invokeAgentWithRetry keeps compact task json repair schema after schema-free preference activates", async () => {
  const agentService = new StubAgentService([
    new Error("AUTH_ERROR: codex CLI timed out after 120000ms"),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
      ],
    }),
    "I am still analyzing the tasks.",
    JSON.stringify({
      tasks: [
        {
          localId: "t2",
          title: "Wire shared exports",
          type: "feature",
          description: "Wire packages/shared/src/index.ts.",
          files: ["packages/shared/src/index.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 2,
          dependsOnKeys: ["t1"],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    "Prompt one",
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-1" },
  );
  const repaired = await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    "Prompt two",
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-2" },
  );

  assert.ok(repaired.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 4);
  assert.equal(agentService.invocations[2]?.metadata?.outputSchema, undefined);
  assert.ok(
    agentService.invocations[3]?.metadata?.outputSchema,
    "expected compact json repair to re-apply the structured schema",
  );
  assert.equal(agentService.invocations[3]?.metadata?.stage, "json_repair");
});

test("invokeAgentWithRetry reuses original compact task prompt context during json repair", async () => {
  const agentService = new StubAgentService([
    "I am grounding this in repo context first.",
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared runtime module",
          type: "feature",
          description: "Implement packages/shared/src/runtime.ts.",
          files: ["packages/shared/src/runtime.ts"],
          estimatedStoryPoints: 2,
          priorityHint: 1,
          dependsOnKeys: [],
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const originalPrompt = [
    'Project EP. Phase 3 compact task synthesis for story "Implement shared core targets 1" in epic "Build Shared".',
    "Return strictly valid JSON only matching:",
    "{ tasks: [...] }",
  ].join("\n\n");

  const result = await (service as any).invokeAgentWithRetry(
    { id: "agent-1", defaultModel: "stub" },
    originalPrompt,
    "tasks_compact",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-compact-1" },
  );

  assert.ok(result.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 2);
  assert.match(agentService.invocations[1]?.input ?? "", /Original request:/i);
  assert.match(agentService.invocations[1]?.input ?? "", /Project EP\. Phase 3 compact task synthesis/i);
  assert.match(agentService.invocations[1]?.input ?? "", /You do not have tool access in this repair step/i);
  assert.ok(agentService.invocations[1]?.metadata?.outputSchema);
  assert.equal(agentService.invocations[1]?.metadata?.stage, "json_repair");
});

test("buildFallbackTasksForStory expands target-aware fallback seeds across grouped implementation and verification slices", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const tasks = (service as any).buildFallbackTasksForStory({
    localId: "us-core-1",
    title: "Implement shared core",
    description: [
      "Implement the primary shared build targets for epic \"Build Shared\".",
      "Primary implementation targets: packages/shared/src/index.ts, packages/shared/src/types.ts, packages/shared/src/pricing/fees.ts, packages/shared/src/abi/index.ts.",
      "Supporting targets: packages/shared/src/runtime.ts, packages/shared/src/contracts.ts.",
      "Verification targets: packages/shared/test/runtime.test.ts, packages/shared/test/pricing.integration.test.ts.",
      "Verification surfaces: shared runtime tests.",
    ].join("\n"),
    acceptanceCriteria: ["shared runtime is buildable"],
    relatedDocs: ["docdex:doc-1"],
  });

  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks[0]?.files, ["packages/shared/src/index.ts", "packages/shared/src/types.ts"]);
  assert.deepEqual(
    [...(tasks[1]?.files ?? [])].sort(),
    ["packages/shared/src/abi/index.ts", "packages/shared/src/pricing/fees.ts"].sort(),
  );
  assert.deepEqual(tasks[2]?.files, [
    "packages/shared/src/runtime.ts",
    "packages/shared/src/contracts.ts",
  ]);
  assert.deepEqual(tasks[3]?.files, [
    "packages/shared/test/runtime.test.ts",
    "packages/shared/test/pricing.integration.test.ts",
  ]);
  assert.ok(tasks[3]?.integrationTests.some((value: string) => value.includes("packages/shared/test/runtime.test.ts")));
});

test("buildFallbackTasksForStory prunes broad parent directories when more specific child targets are known", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const tasks = (service as any).buildFallbackTasksForStory({
    localId: "us-core-2",
    title: "Implement shared reason layer",
    description: [
      "Implement the shared reason layer.",
      "Primary implementation targets: packages/shared/src, packages/shared/src/reasons, packages/shared/src/reasons/index.ts.",
      "Supporting targets: packages/shared/src/schemas, packages/shared/src/schemas/index.ts.",
      "Verification targets: packages/shared/test/reasons.test.ts, packages/shared/test/schemas.test.ts.",
    ].join("\n"),
    acceptanceCriteria: ["shared reason layer is buildable"],
    relatedDocs: ["docdex:doc-1"],
  });

  assert.ok(tasks.length >= 3);
  assert.ok(
    tasks.every((task: { files?: string[] }) => !(task.files ?? []).includes("packages/shared/src")),
    `expected broad parent directory to be pruned, got ${JSON.stringify(tasks.map((task: { files?: string[] }) => task.files))}`,
  );
  assert.ok(
    tasks.some(
      (task: { files?: string[] }) =>
        JSON.stringify(task.files ?? []) === JSON.stringify(["packages/shared/src/reasons/index.ts"]),
    ),
  );
});

test("buildFallbackTasksForStory caps grouped fallback seeds so one story does not explode into too many compact rewrites", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const tasks = (service as any).buildFallbackTasksForStory({
    localId: "us-core-3",
    title: "Implement contracts core target group",
    description: [
      "Implement the contracts core target group.",
      "Primary implementation targets: contracts/src/a.sol, contracts/src/b.sol, contracts/src/c.sol, contracts/src/d.sol, contracts/src/e.sol, contracts/src/f.sol.",
      "Supporting targets: contracts/script/deploy.ts, contracts/script/publish.ts, contracts/src/interfaces/index.ts, contracts/src/libraries/math.ts.",
      "Verification targets: contracts/test/a.t.sol, contracts/test/b.t.sol, contracts/test/c.t.sol, contracts/test/d.t.sol.",
    ].join("\n"),
    acceptanceCriteria: ["contracts core target group is buildable"],
    relatedDocs: ["docdex:doc-1"],
  });

  assert.ok(tasks.length <= 4, `expected at most four fallback tasks, got ${tasks.length}`);
  assert.ok(tasks.some((task: { title?: string }) => /Validate /.test(task.title ?? "")));
  assert.ok(tasks.some((task: { title?: string }) => /Wire /.test(task.title ?? "")));
  assert.ok(
    tasks.some((task: { files?: string[] }) => (task.files ?? []).includes("contracts/src/a.sol")),
    `expected primary concrete targets to be preserved, got ${JSON.stringify(tasks.map((task: { files?: string[] }) => task.files))}`,
  );
  assert.ok(
    tasks.some((task: { files?: string[] }) => (task.files ?? []).includes("contracts/test/a.t.sol")),
    `expected verification concrete targets to be preserved, got ${JSON.stringify(tasks.map((task: { files?: string[] }) => task.files))}`,
  );
});

test("buildCompactTaskSeeds preserves related docs and verification metadata for compact rewrites", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const seeds = (service as any).buildCompactTaskSeeds([
    {
      localId: "t-fallback-1",
      title: "Validate shared runtime",
      type: "chore",
      description: "Validate shared runtime readiness.",
      files: ["packages/shared/test/runtime.test.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 30,
      dependsOnKeys: ["t-fallback-0"],
      relatedDocs: ["docdex:doc-1"],
      unitTests: [],
      componentTests: [],
      integrationTests: ["Execute packages/shared/test/runtime.test.ts for shared runtime."],
      apiTests: [],
      qa: null,
    },
  ]);

  assert.deepEqual(seeds, [
    {
      localId: "t-fallback-1",
      title: "Validate shared runtime",
      type: "chore",
      description: "Validate shared runtime readiness.",
      files: ["packages/shared/test/runtime.test.ts"],
      estimatedStoryPoints: 2,
      priorityHint: 30,
      dependsOnKeys: ["t-fallback-0"],
      relatedDocs: ["docdex:doc-1"],
      unitTests: [],
      componentTests: [],
      integrationTests: ["Execute packages/shared/test/runtime.test.ts for shared runtime."],
      apiTests: [],
    },
  ]);
});

test("buildCompactTaskSeeds compacts verbose descriptions and prunes broad parent targets", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const verboseDescription = [
    "Implement the shared reason modules and shared schema wiring for the story.",
    "Create the initial files, wire exports, align contracts, preserve naming, and make the runtime available to downstream consumers.",
    "Keep the story scoped, preserve dependency order, and ensure the task remains concrete enough for automated execution.",
    "This sentence only exists to make the seed description obviously longer than the compact prompt should carry verbatim.",
  ].join(" ");

  const seeds = (service as any).buildCompactTaskSeeds([
    {
      localId: "t-fallback-1",
      title: "Implement shared reason modules",
      type: "feature",
      description: verboseDescription,
      files: ["packages/shared/src", "packages/shared/src/reasons", "packages/shared/src/reasons/index.ts"],
      estimatedStoryPoints: 3,
      priorityHint: 20,
      dependsOnKeys: [],
      relatedDocs: ["docdex:doc-1", "docdex:doc-2", "docdex:doc-3", "docdex:doc-4", "docdex:doc-5"],
      unitTests: ["unit 1", "unit 2", "unit 3"],
      componentTests: ["component 1", "component 2", "component 3"],
      integrationTests: ["integration 1", "integration 2", "integration 3"],
      apiTests: ["api 1", "api 2", "api 3"],
      qa: null,
    },
  ]);

  assert.deepEqual(seeds[0]?.files, ["packages/shared/src/reasons/index.ts"]);
  assert.equal(seeds[0]?.relatedDocs?.length, 4);
  assert.equal(seeds[0]?.unitTests?.length, 2);
  assert.equal(seeds[0]?.componentTests?.length, 2);
  assert.equal(seeds[0]?.integrationTests?.length, 2);
  assert.equal(seeds[0]?.apiTests?.length, 2);
  assert.ok((seeds[0]?.description ?? "").length < verboseDescription.length);
  assert.ok((seeds[0]?.description ?? "").endsWith("..."));
});

test("mergeCompactTaskMetadata preserves seed file specificity when compact rewrite broadens targets", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const merged = (service as any).mergeCompactTaskMetadata(
    [
      {
        localId: "t-fallback-1",
        title: "Create shared scaffold",
        type: "feature",
        description: "Broadened by the compact rewrite.",
        files: ["packages/shared/src", "packages/shared/src/abi"],
        estimatedStoryPoints: 3,
        priorityHint: 10,
        dependsOnKeys: [],
        relatedDocs: [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
        qa: null,
      },
    ],
    [
      {
        localId: "t-fallback-1",
        title: "Create shared scaffold",
        type: "feature",
        description: "Seed task with concrete files.",
        files: ["packages/shared/src/index.ts", "packages/shared/src/abi/index.ts"],
        estimatedStoryPoints: 3,
        priorityHint: 10,
        dependsOnKeys: [],
        relatedDocs: ["docdex:doc-1"],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
        qa: null,
      },
    ],
  );

  assert.deepEqual(
    [...(merged[0]?.files ?? [])].sort(),
    ["packages/shared/src/abi/index.ts", "packages/shared/src/index.ts"].sort(),
  );
});

test("normalizeTaskFiles prefers specific descendants over broad parent directories", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const files = (service as any).normalizeTaskFiles({
    files: [
      "contracts/src",
      "contracts/src/interfaces",
      "contracts/src/interfaces/IListingRegistry.sol",
      "contracts/src/libraries",
      "contracts/src/libraries/FeeMath.sol",
    ],
    description: "",
    unitTests: [],
    componentTests: [],
    integrationTests: [],
    apiTests: [],
  });

  assert.deepEqual(
    [...files].sort(),
    ["contracts/src/interfaces/IListingRegistry.sol", "contracts/src/libraries/FeeMath.sol"].sort(),
  );
});

test("tasks_compact schema retains related docs and test arrays", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const schema = (service as any).outputSchemaForAction("tasks_compact");
  const taskSchema = schema?.properties?.tasks?.items;
  assert.ok(taskSchema?.properties?.relatedDocs);
  assert.ok(taskSchema?.properties?.unitTests);
  assert.ok(taskSchema?.properties?.componentTests);
  assert.ok(taskSchema?.properties?.integrationTests);
  assert.ok(taskSchema?.properties?.apiTests);
});

test("invokeAgentWithRetry retries timeout-like structured task calls without output schema", async () => {
  const agentService = new StubAgentService([
    new Error("AUTH_ERROR: codex CLI timed out after 120000ms"),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Implement shared package",
          type: "feature",
          description: "Implement packages/shared/src/index.ts.",
          files: ["packages/shared/src/index.ts"],
          estimatedStoryPoints: 3,
          priorityHint: 10,
          dependsOnKeys: [],
          relatedDocs: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
          qa: {
            requires: [],
            profiles_expected: [],
            entrypoints: [],
            data_setup: [],
            blockers: [],
            notes: null,
          },
        },
      ],
    }),
  ]);
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: agentService as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });
  const agent = await agentService.resolveAgent();

  const result = await (service as any).invokeAgentWithRetry(
    agent,
    "Return one compact task as JSON only.",
    "tasks",
    false,
    "job-1",
    "cmd-1",
    { storyKey: "us-impl-1" },
  );

  assert.ok(result.output.includes("\"tasks\""));
  assert.equal(agentService.invocations.length, 2);
  assert.ok(
    agentService.invocations[0]?.metadata?.outputSchema,
    "expected first attempt to carry structured output schema",
  );
  assert.equal(agentService.invocations[1]?.metadata?.outputSchema, undefined);
  assert.equal(agentService.invocations[1]?.metadata?.schemaRetryMode, "without_output_schema");
  assert.ok(
    jobService.logs.some((line) => /retrying once without output schema/i.test(line)),
    `expected schema-free retry log, got ${jobService.logs.join("\n")}`,
  );
});

test("createTasks keeps an explicit-agent backlog when project completion passes but sufficiency stays below target", async () => {
  class ResidualGapTaskSufficiencyService extends StubTaskSufficiencyService {
    async runAudit(request: any) {
      const base = await super.runAudit(request);
      return {
        ...base,
        satisfied: false,
        finalCoverageRatio: 0.61,
        remainingSectionHeadings: ["Architecture Overview"],
        remainingFolderEntries: ["packages/listing-contract-suite/src"],
        remainingGaps: { sections: 1, folders: 1, total: 2 },
        warnings: [],
      };
    }
  }

  const outputs = [JSON.stringify(await buildDefaultSdsDrivenAgentPlan())];
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new ResidualGapTaskSufficiencyService() as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentName: "agent-1",
    agentStream: false,
  });

  assert.ok(result.tasks.length > 0);
  assert.equal(result.sufficiencyAudit?.satisfied, false);
  assert.ok(
    result.warnings.some((warning) => /task sufficiency audit remained below target/i.test(warning)),
    `expected residual-gap warning, got ${result.warnings.join("\n")}`,
  );
  assert.ok(!jobService.logs.some((line) => /deterministic planner fallback/i.test(line)));
});

test("createTasks fails closed for explicit-agent runs when the agent never returns a valid backlog", async () => {
  const outputs = ["not json", "still not json", "nope", "still nope", "bad", "worse"];
  const jobService = new StubJobService();
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: jobService as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentName: "agent-1",
        agentStream: false,
      }),
    /failed before backlog persistence|did not produce an acceptable backlog/i,
  );
  assert.equal(workspaceRepo.tasks.length, 0);
  assert.equal(workspaceRepo.deps.length, 0);
  assert.ok(!jobService.logs.some((line) => /deterministic planner fallback/i.test(line)));
  assert.equal(jobService.tokenUsage.length, 6);
});

test("createTasks keeps partial plan and applies story-level fallback when one story task generation fails", async () => {
  const outputs = [
    JSON.stringify({
      epics: [
        {
          localId: "e1",
          area: "web",
          title: "Epic One",
          description: "Epic desc",
          acceptanceCriteria: ["ac1"],
        },
      ],
    }),
    JSON.stringify({
      stories: [
        {
          localId: "us1",
          title: "Story One",
          description: "Story one desc",
          acceptanceCriteria: ["story one ac"],
        },
        {
          localId: "us2",
          title: "Story Two",
          description: "Story two desc",
          acceptanceCriteria: ["story two ac"],
        },
      ],
    }),
    JSON.stringify({
      tasks: [
        {
          localId: "t1",
          title: "Story One Task One",
          type: "feature",
          description: "Task for story one",
          estimatedStoryPoints: 3,
          priorityHint: 1,
          dependsOnKeys: [],
          unitTests: [],
          componentTests: [],
          integrationTests: [],
          apiTests: [],
        },
      ],
    }),
    "not json",
    "still not json",
  ];
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdex() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService(outputs) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
  });

  const result = await service.createTasks({
    workspace,
    projectKey: "web",
    inputs: [],
    agentStream: false,
  });

  assert.ok(result.tasks.some((task) => task.title === "Story One Task One"));
  const storyTwoFallbackTasks = result.tasks.filter((task) => /Story Two/i.test(task.title));
  assert.ok(storyTwoFallbackTasks.length >= 1);
  assert.ok(storyTwoFallbackTasks.some((task) => /^(Implement|Validate) /i.test(task.title)));
  assert.ok(!result.tasks.some((task) => task.title === "Summarize requirements"));
});

test("CreateTasksService prompt examples remain tech-agnostic", async () => {
  const source = await fs.readFile(new URL("../CreateTasksService.js", import.meta.url), "utf8");
  assert.ok(source.includes("relative/path/to/implementation.file"));
  assert.ok(source.includes("project start command"));
  assert.ok(!source.includes("packages/service/src/file.ts"));
  assert.ok(!source.includes("npm run dev"));
});

test("resolveDefaultDocInputs uses fuzzy planning discovery instead of docs/openapi defaults", async () => {
  await fs.mkdir(path.join(workspaceRoot, "planning"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "interfaces"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "planning", "architecture.md"), "# Architecture Overview\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "interfaces", "api-contract.yaml"), "openapi: 3.1.0\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "docs", "readme.txt"), "supporting note\n", "utf8");

  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const inputs = await (service as any).resolveDefaultDocInputs();
  assert.ok(inputs.includes(path.join(workspaceRoot, "planning", "architecture.md")));
  assert.ok(inputs.includes(path.join(workspaceRoot, "interfaces", "api-contract.yaml")));
  assert.ok(!inputs.includes(path.join(workspaceRoot, "docs")));
});

test("inferFallbackImplementationTargets derives neutral targets from repo roots", async () => {
  const workspaceRepo = new StubWorkspaceRepo();
  const service = new CreateTasksService(workspace, {
    docdex: new StubDocdexTyped() as any,
    jobService: new StubJobService() as any,
    agentService: new StubAgentService([]) as any,
    routingService: new StubRoutingService() as any,
    repo: new StubRepo() as any,
    workspaceRepo: workspaceRepo as any,
    taskOrderingFactory: createOrderingFactory(workspaceRepo) as any,
    taskSufficiencyFactory: async () => new StubTaskSufficiencyService() as any,
  });

  const targets = (service as any).inferFallbackImplementationTargets(
    {
      unitId: "svc-listing-contract-suite",
      kind: "service",
      name: "Listing Contract Suite",
      summary: "Contract lifecycle unit.",
      sourceHeadings: ["Requirements Constraints"],
      implementationTargets: [],
      supportingTargets: [],
      verificationTargets: [],
      verificationSurfaceIds: [],
      dependsOnUnitIds: [],
      startupWave: 1,
      isFoundational: false,
      sourceServiceIds: ["listing-contract-suite"],
      completionSignals: [],
    },
    ["packages", "contracts", "ops"],
    [],
  );

  assert.deepEqual(targets, ["contracts/listing-contract-suite"]);
  assert.ok(!targets.includes("contracts/src"));
  assert.ok(!targets.includes("contracts/test"));
  assert.ok(!targets.includes("ops/scripts"));
  assert.ok(!targets.includes("packages/listing-contract-suite/src"));
});
