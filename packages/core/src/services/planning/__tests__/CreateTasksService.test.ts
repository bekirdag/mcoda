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

class StubAgentService {
  private queue: string[];
  constructor(outputs: string[]) {
    this.queue = [...outputs];
  }
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke() {
    return { output: this.queue.shift() ?? "" };
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
  async listEpicKeys() {
    return this.epics.map((e) => e.key);
  }
  async listStoryKeys(epicId: string) {
    return this.stories.filter((s) => s.epicId === epicId).map((s) => s.key);
  }
  async listTaskKeys(storyId: string) {
    return this.tasks.filter((t) => t.userStoryId === storyId).map((t) => t.key);
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
      dryRun: false,
      totalTasksAdded: 2,
      totalTasksUpdated: 0,
      maxIterations: 3,
      minCoverageRatio: 0.95,
      finalCoverageRatio: 1,
      remainingSectionHeadings: [] as string[],
      remainingFolderEntries: [] as string[],
      remainingGaps: {
        sections: 0,
        folders: 0,
        total: 0,
      },
      iterations: [
        {
          iteration: 1,
          coverageRatio: 0.65,
          totalSignals: 10,
          missingSectionCount: 2,
          missingFolderCount: 1,
          createdTaskKeys: ["web-01-us-01-t90"],
        },
      ],
      reportPath: path.join(workspace.mcodaDir, "tasks", request.projectKey, "task-sufficiency-report.json"),
      reportHistoryPath: path.join(workspace.mcodaDir, "tasks", request.projectKey, "sufficiency-audit", "snap.json"),
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
  assert.ok(task.description.includes("QA Readiness"));
  assert.ok(task.description.includes("Profiles:"));
  assert.ok(!task.description.includes("Break this into concrete steps during execution."));
  assert.ok(!task.description.includes("Tests passing, docs updated, review/QA complete."));
  assert.ok(!task.description.includes("Highlight edge cases or risky areas."));
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
  assert.ok(jobService.checkpoints.some((entry) => entry.stage === "task_sufficiency_audit"));
  const completedJob = jobService.jobs[0];
  assert.ok(completedJob?.meta?.payload?.sufficiencyAudit);
  assert.equal(completedJob.meta.payload.sufficiencyAudit.satisfied, true);
});

test("createTasks runs SDS preflight, records checkpoint, and merges generated preflight docs", async () => {
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
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedQaPath));
  assert.ok(docdex.registeredFiles.some((entry) => entry === generatedGapPath));
  const completedJob = jobService.jobs[0];
  assert.equal(completedJob?.meta?.payload?.sdsPreflight?.qualityStatus, "pass");
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

test("createTasks blocks when task sufficiency audit is unsatisfied", async () => {
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
  sufficiencyService.runAudit = async (request: any) => ({
    ...(await StubTaskSufficiencyService.prototype.runAudit.call(sufficiencyService, request)),
    satisfied: false,
    finalCoverageRatio: 0.94,
    remainingGaps: { sections: 3, folders: 0, total: 3 },
    remainingSectionHeadings: ["Missing"],
    remainingFolderEntries: [],
  });
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

  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentStream: false,
      }),
    /task sufficiency audit did not reach full coverage/i,
  );

  const sufficiencyCheckpoint = jobService.checkpoints.find((entry) => entry.stage === "task_sufficiency_audit");
  assert.ok(sufficiencyCheckpoint);
  assert.equal(sufficiencyCheckpoint.details.status, "blocked");
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
  const architecturePath = path.join(workspaceRoot, "architecture-overview.md");
  await fs.writeFile(
    architecturePath,
    [
      "# Architecture Overview",
      "Service dependency baseline:",
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
    inputs: [architecturePath],
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
  assert.equal(preflight.details.entrypoints[0].command, "npm run dev");
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
  assert.ok(result.tasks.some((task) => task.title === "Implement baseline project scaffolding"));
  assert.ok(result.tasks.some((task) => task.title === "Validate baseline behavior and regressions"));
  assert.ok(
    jobService.checkpoints.some((entry) => entry.stage === "epics_generated" && entry.details?.source === "fallback"),
  );
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
  assert.ok(result.tasks.some((task) => task.title === "Implement core scope for Story Two"));
  assert.ok(result.tasks.some((task) => task.title === "Integrate contracts for Story Two"));
  assert.ok(result.tasks.some((task) => task.title === "Validate Story Two regressions and readiness"));
  assert.ok(!result.tasks.some((task) => task.title === "Summarize requirements"));
});
