import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { CodeReviewService } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";
import { CodeReviewCommand } from "../commands/review/CodeReviewCommand.js";
import { parseCodeReviewArgs, pickCodeReviewProjectKey } from "../commands/review/CodeReviewCommand.js";

class FakeAgentService {
  constructor(private decision: string = "approve") {}
  async resolveAgent() {
    return { id: "agent-1", defaultModel: "stub" } as any;
  }
  async getCapabilities() {
    return ["code_review"];
  }
  async invoke(_agentId: string, _req: any) {
    return {
      output: JSON.stringify({
        decision: this.decision,
        summary: "Looks good",
        findings: [
          {
            type: "style",
            severity: "low",
            file: "src/demo.ts",
            line: 10,
            message: "Minor nit",
          },
        ],
      }),
      model: "stub-model",
    };
  }
  async invokeStream() {
    throw new Error("stream not supported in fake");
  }
  async getPrompts() {
    return { jobPrompt: "review", characterPrompt: "be concise", commandPrompts: { "code-review": "follow checklist" } };
  }
  async close() {}
}

class FakeDocdex {
  async search() {
    return [];
  }
}

class FakeRoutingService {
  async resolveAgentForCommand() {
    const agent = {
      id: "agent-1",
      slug: "agent-1",
      adapter: "local-model",
      defaultModel: "stub-model",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return {
      agent,
      agentId: agent.id,
      agentSlug: agent.slug,
      model: agent.defaultModel,
      capabilities: ["code_review"],
      healthStatus: "healthy",
      source: "workspace_default",
      routingPreview: { workspaceId: "ws", commandName: "code-review", resolvedAgent: agent },
    };
  }
}

class FakeSelectionService {
  lastFilters?: any;
  constructor(private task: any) {}
  async selectTasks(filters: any) {
    this.lastFilters = filters;
    return {
      project: undefined,
      filters,
      ordered: [
        {
          task: this.task,
          dependencies: { ids: [], keys: [], blocking: [] },
        },
      ],
      warnings: [],
    };
  }
  async close() {}
}

class FakeStateService {
  readyToQaCalled = false;
  inProgressCalled = false;
  async markReadyToQa() {
    this.readyToQaCalled = true;
  }
  async returnToInProgress() {
    this.inProgressCalled = true;
  }
  async recordReviewMetadata() {}
}

class FakeJobService {
  createdJob?: any;
  commandRun?: any;
  checkpoints: any[] = [];
  tokenUsage: any[] = [];
  jobStatuses: any[] = [];
  resumeJob?: any;
  constructor(resumeJob?: any) {
    this.resumeJob = resumeJob;
  }
  async startCommandRun() {
    this.commandRun = { id: "cmd-1" };
    return { ...this.commandRun };
  }
  async startJob(type: string, commandRunId?: string, _projectKey?: string, options: any = {}) {
    this.createdJob = { id: "job-1", type, commandRunId, ...options };
    return { id: "job-1", type };
  }
  async updateJobStatus(id: string, state: any, meta?: any) {
    this.jobStatuses.push({ id, state, meta });
  }
  async finishCommandRun() {}
  async writeCheckpoint(_jobId: string, ckpt: any) {
    this.checkpoints.push(ckpt);
  }
  async recordTokenUsage(entry: any) {
    this.tokenUsage.push(entry);
  }
  async getJob(id: string) {
    if (this.resumeJob && this.resumeJob.id === id) return this.resumeJob;
    return undefined;
  }
  async close() {}
}

class FakeWorkspaceRepo {
  comments: any[] = [];
  reviews: any[] = [];
  taskRuns: any[] = [];
  logs: any[] = [];
  epics: any[] = [];
  stories: any[] = [];
  constructor(public tasks: any[]) {
    if (tasks.length) {
      this.epics.push({ id: tasks[0].epicId, projectId: tasks[0].projectId, key: tasks[0].epicKey ?? "E1", title: "Epic", description: "" });
      this.stories.push({
        id: tasks[0].userStoryId,
        epicId: tasks[0].epicId,
        projectId: tasks[0].projectId,
        key: tasks[0].storyKey ?? "S1",
        title: "Story",
        description: "",
      });
    }
  }
  async getTasksWithRelations(ids: string[]) {
    return this.tasks.filter((t: any) => ids.includes(t.id));
  }
  async listTaskComments() {
    return [];
  }
  async getLatestTaskReview() {
    return undefined;
  }
  async getEpicByKey(_projectId: string, key: string) {
    return this.epics.find((e) => e.key === key);
  }
  async getStoryByKey(epicId: string, key: string) {
    return this.stories.find((s) => s.epicId === epicId && s.key === key);
  }
  async insertEpics(epics: any[]) {
    const created = epics.map((e, idx) => ({
      ...e,
      id: e.id ?? `epic-${this.epics.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.epics.push(...created);
    return created;
  }
  async insertStories(stories: any[]) {
    const created = stories.map((s, idx) => ({
      ...s,
      id: s.id ?? `story-${this.stories.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.stories.push(...created);
    return created;
  }
  async listTaskKeys(userStoryId: string) {
    return this.tasks.filter((t: any) => t.userStoryId === userStoryId).map((t: any) => t.key);
  }
  async insertTasks(taskInserts: any[]) {
    const created = taskInserts.map((t, idx) => ({
      ...t,
      id: t.id ?? `task-${this.tasks.length + idx + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.tasks.push(...created);
    return created;
  }
  async insertTaskLog(entry: any) {
    this.logs.push(entry);
  }
  async createTaskRun(record: any) {
    const run = { id: `run-${this.taskRuns.length + 1}`, ...record };
    this.taskRuns.push(run);
    return run;
  }
  async updateTaskRun() {}
  async createTaskComment(input: any) {
    this.comments.push(input);
    return { id: `c-${this.comments.length}`, ...input };
  }
  async createTaskReview(input: any) {
    this.reviews.push(input);
    return { id: `r-${this.reviews.length}`, ...input };
  }
  async updateTask() {}
  async close() {}
}

class FakeVcs {
  async ensureRepo() {}
  async diff() {
    return "diff --git a/src/demo.ts b/src/demo.ts\n+console.log('hi');";
  }
}

class FakeGlobalRepo {
  async getWorkspaceDefaults() {
    return [];
  }
  async close() {}
}

const makeWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  return {
    workspaceRoot: dir,
    workspaceId: dir,
    mcodaDir: PathHelper.getWorkspaceDir(dir),
  };
};

describe("code-review argument parsing", () => {
  it("defaults status to ready_to_code_review and agent streaming off", () => {
    const parsed = parseCodeReviewArgs([]);
    assert.deepEqual(parsed.statusFilter, ["ready_to_code_review"]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.createFollowupTasks, false);
    assert.equal(parsed.executionContextPolicy, "require_sds_or_openapi");
    assert.equal(parsed.emptyDiffApprovalPolicy, "ready_to_qa");
  });

  it("parses filters, resume and agent stream override", () => {
    const parsed = parseCodeReviewArgs([
      "--workspace-root",
      "/tmp/demo",
      "--project",
      "P1",
      "--epic",
      "E1",
      "--story",
      "S1",
      "--task=TASK-1",
      "--status",
      "ready_to_code_review",
      "--base",
      "main",
      "--resume",
      "job-1",
      "--agent-stream=false",
      "--rate-agents",
      "--create-followup-tasks=true",
      "--execution-context-policy=require_any",
      "--empty-diff-approval-policy=complete",
      "--json",
    ]);
    assert.equal(parsed.workspaceRoot, path.resolve("/tmp/demo"));
    assert.equal(parsed.projectKey, "P1");
    assert.equal(parsed.epicKey, "E1");
    assert.equal(parsed.storyKey, "S1");
    assert.equal(parsed.resumeJobId, "job-1");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, true);
    assert.equal(parsed.createFollowupTasks, true);
    assert.equal(parsed.executionContextPolicy, "require_any");
    assert.equal(parsed.emptyDiffApprovalPolicy, "complete");
    assert.equal(parsed.baseRef, "main");
    assert.equal(parsed.json, true);
    assert.deepEqual(parsed.taskKeys, ["TASK-1"]);
    assert.deepEqual(parsed.statusFilter, ["ready_to_code_review"]);
  });

  it("resolves project key using explicit, configured, then first existing", () => {
    const explicit = pickCodeReviewProjectKey({
      requestedKey: "P2",
      configuredKey: "P1",
      existing: [{ key: "P1" }, { key: "P2" }],
    });
    assert.equal(explicit.projectKey, "P2");

    const configured = pickCodeReviewProjectKey({
      configuredKey: "P1",
      existing: [{ key: "P2" }, { key: "P1" }],
    });
    assert.equal(configured.projectKey, "P1");

    const fallback = pickCodeReviewProjectKey({
      existing: [{ key: "P3" }, { key: "P4" }],
    });
    assert.equal(fallback.projectKey, "P3");
  });
});

describe("code-review service flow", () => {
  let workspace: any;
  let task: any;
  let fakeSelection: FakeSelectionService;
  let fakeWorkspaceRepo: FakeWorkspaceRepo;
  let fakeJobService: FakeJobService;
  let fakeStateService: FakeStateService;
  let tempHome: string | undefined;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    workspace = await makeWorkspace();
    task = {
      id: "task-1",
      projectId: "proj-1",
      epicId: "epic-1",
      userStoryId: "story-1",
      key: "TASK-1",
      title: "Review demo",
      description: "",
      type: "feature",
      status: "ready_to_code_review",
      storyPoints: 3,
      priority: 1,
      assignedAgentId: null,
      assigneeHuman: null,
      vcsBranch: "mcoda/task/TASK-1",
      vcsBaseBranch: "mcoda-dev",
      vcsLastCommitSha: null,
      metadata: { files: ["src/demo.ts"] },
      openapiVersionAtCreation: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      epicKey: "E1",
      storyKey: "S1",
    };
    fakeSelection = new FakeSelectionService(task);
    fakeWorkspaceRepo = new FakeWorkspaceRepo([task]);
    fakeJobService = new FakeJobService();
    fakeStateService = new FakeStateService();
  });

  afterEach(async () => {
    if (workspace?.workspaceRoot) {
      await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });
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

  it("creates a review job, writes comments/reviews, and records token usage", async () => {
    const service = new CodeReviewService(workspace, {
      agentService: new FakeAgentService() as any,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });

    const result = await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      taskKeys: ["TASK-1"],
      agentStream: false,
    });

    assert.equal(result.jobId, "job-1");
    assert.equal(fakeJobService.createdJob?.type, "review");
    assert.equal(fakeWorkspaceRepo.comments.length, 2);
    assert.equal(fakeWorkspaceRepo.reviews.length, 1);
    assert.equal(fakeStateService.inProgressCalled, false);
    assert.equal(fakeStateService.readyToQaCalled, true);
    assert.equal(fakeJobService.tokenUsage.length, 1);
  });

  it("handles changes_requested decision without throwing", async () => {
    const service = new CodeReviewService(workspace, {
      agentService: new FakeAgentService("changes_requested") as any,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });
    const result = await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      taskKeys: ["TASK-1"],
    });
    assert.equal(result.tasks.length, 1);
  });

  it("creates follow-up tasks for actionable findings and uses generic containers when needed", async () => {
    const agent = new FakeAgentService("changes_requested") as any;
    agent.invoke = async () => ({
      output: JSON.stringify({
        decision: "changes_requested",
        summary: "Needs fixes",
        findings: [
          {
            type: "bug",
            severity: "high",
            message: "Fix this issue",
            file: "src/demo.ts",
            line: 12,
          },
        ],
      }),
      model: "stub-model",
    });
    const service = new CodeReviewService(workspace, {
      agentService: agent,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });
    const result = await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      taskKeys: ["TASK-1"],
      agentStream: false,
      createFollowupTasks: true,
    });
    const followups = result.tasks[0].followupTasks ?? [];
    assert.ok(followups.length >= 1);
    assert.ok(fakeWorkspaceRepo.tasks.length > 1);
    const created = fakeWorkspaceRepo.tasks.find((item: any) => item.key !== task.key);
    assert.equal(created?.epicId, task.epicId);
  });

  it("does not create follow-up tasks for approved low/info findings", async () => {
    const agent = new FakeAgentService("approve") as any;
    agent.invoke = async () => ({
      output: JSON.stringify({
        decision: "approve",
        summary: "Fine",
        findings: [
          {
            type: "style",
            severity: "low",
            message: "Nit only",
            file: "src/demo.ts",
            line: 8,
          },
          {
            type: "docs",
            severity: "info",
            message: "Note",
            file: "README.md",
            line: 3,
          },
        ],
      }),
      model: "stub-model",
    });
    const service = new CodeReviewService(workspace, {
      agentService: agent,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });
    const beforeCount = fakeWorkspaceRepo.tasks.length;
    const result = await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      taskKeys: ["TASK-1"],
      agentStream: false,
      createFollowupTasks: true,
    });
    const afterCount = fakeWorkspaceRepo.tasks.length;
    assert.equal(afterCount, beforeCount);
    assert.equal(result.tasks[0].followupTasks?.length ?? 0, 0);
  });

  it("respects limit and records job payload", async () => {
    const service = new CodeReviewService(workspace, {
      agentService: new FakeAgentService() as any,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });
    await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      taskKeys: ["TASK-1"],
      limit: 1,
    });
    assert.equal(fakeJobService.createdJob?.payload?.selection.length, 1);
    assert.equal(fakeSelection.lastFilters?.limit, 1);
    assert.ok(fakeJobService.checkpoints.find((c) => c.stage === "tasks_selected"));
  });

  it("supports resume using persisted selection", async () => {
    const resumeJob = { id: "job-1", commandName: "code-review", type: "review", payload: { selection: [task.id] }, totalItems: 1 };
    fakeJobService = new FakeJobService(resumeJob);
    fakeWorkspaceRepo = new FakeWorkspaceRepo([task]);
    await fs.mkdir(path.join(workspace.mcodaDir, "jobs", "job-1", "review"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.mcodaDir, "jobs", "job-1", "review", "state.json"),
      JSON.stringify({ schema_version: 1, job_id: "job-1", selectedTaskIds: [task.id], contextBuilt: [], reviewed: [] }, null, 2),
      "utf8",
    );
    const service = new CodeReviewService(workspace, {
      agentService: new FakeAgentService() as any,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });
    const result = await service.reviewTasks({
      workspace,
      projectKey: "P1",
      statusFilter: ["ready_to_code_review"],
      resumeJobId: "job-1",
    });
    assert.equal(result.jobId, "job-1");
    assert.equal(fakeJobService.jobStatuses.length > 0, true);
  });

  it("ignores status filters when task keys are explicit", async () => {
    const service = new CodeReviewService(workspace, {
      agentService: new FakeAgentService() as any,
      docdex: new FakeDocdex() as any,
      jobService: fakeJobService as any,
      workspaceRepo: fakeWorkspaceRepo as any,
      selectionService: fakeSelection as any,
      stateService: fakeStateService as any,
      repo: new FakeGlobalRepo() as any,
      vcsClient: new FakeVcs() as any,
      routingService: new FakeRoutingService() as any,
    });

    await service.reviewTasks({
      workspace,
      projectKey: "P1",
      taskKeys: ["TASK-1"],
    });

    assert.ok(fakeSelection.lastFilters);
    assert.equal(fakeSelection.lastFilters.ignoreStatusFilter, true);
    assert.equal(fakeSelection.lastFilters.statusFilter, undefined);
  });
});

describe("code-review CLI output shape", () => {
  it("emits structured JSON output", async () => {
    const originalCreate = CodeReviewService.create;
    const fakeResult = {
      jobId: "job-123",
      commandRunId: "cmd-123",
      tasks: [
        {
          taskId: "t1",
          taskKey: "TASK-1",
          decision: "approve",
          statusBefore: "ready_to_code_review",
          statusAfter: "ready_to_qa",
          findings: [],
        },
      ],
      warnings: [],
    };
    // @ts-expect-error override for test
    CodeReviewService.create = async () => ({
      reviewTasks: async () => fakeResult,
      close: async () => {},
    });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: any) => {
      logs.push(String(msg));
    };
    await CodeReviewCommand.run(["--project", "P1", "--json"]);
    console.log = originalLog;
    CodeReviewService.create = originalCreate;
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed.job, { id: "job-123", commandRunId: "cmd-123" });
    assert.equal(parsed.tasks[0].taskKey, "TASK-1");
  });
});
