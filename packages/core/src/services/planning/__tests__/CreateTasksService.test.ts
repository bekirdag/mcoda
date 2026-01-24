import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { CreateTasksService } from "../CreateTasksService.js";
import { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";
import { createEpicKeyGenerator, createStoryKeyGenerator, createTaskKeyGenerator } from "../KeyHelpers.js";
import { PathHelper } from "@mcoda/shared";

let workspaceRoot: string;
let workspace: WorkspaceResolution;
let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

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
  async fetchDocumentById(id: string) {
    return { ...fakeDoc, id };
  }
  async ensureRegisteredFromFile() {
    return fakeDoc;
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
  async appendLog() {}
  async recordTokenUsage() {}
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

  assert.equal(result.epics.length, 1);
  assert.equal(result.stories.length, 1);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.dependencies.length, 0);
  assert.equal(result.tasks[0].status, "not_started");
  assert.equal(result.tasks[0].storyPoints, 3);
  assert.equal(typeof result.tasks[0].priority, "number");
  const metadata = result.tasks[0].metadata as any;
  assert.deepEqual(metadata?.test_requirements, {
    unit: ["Add unit coverage for task path"],
    component: [],
    integration: ["Run integration flow A"],
    api: ["Validate API response contract"],
  });
  assert.equal(metadata?.stage, "other");
  assert.equal(metadata?.foundation, false);
  assert.ok(result.tasks[0].description.includes("Unit tests: Add unit coverage for task path"));
  assert.ok(result.tasks[0].description.includes("Component tests: Not applicable"));
  assert.ok(result.tasks[0].description.includes("Integration tests: Run integration flow A"));
  assert.ok(result.tasks[0].description.includes("API tests: Validate API response contract"));
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

  assert.equal(result.epics.length, 1);
  assert.equal(result.stories.length, 1);
  assert.equal(result.tasks.length, 1);
});

test("createTasks fails on invalid agent output", async () => {
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
  await assert.rejects(
    () =>
      service.createTasks({
        workspace,
        projectKey: "web",
        inputs: [],
        agentStream: false,
      }),
    /valid JSON/i,
  );
});
