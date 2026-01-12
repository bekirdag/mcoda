import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobService } from "../../jobs/JobService.js";
import { CodeReviewService } from "../CodeReviewService.js";
import { formatTaskCommentBody } from "../../tasks/TaskCommentFormatter.js";

test("CodeReviewService records approvals and updates status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "approve");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService treats info_only as ready_to_qa", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"info_only","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "info_only");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService resume skips terminal tasks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [taskReady] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    const [taskDone] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Done Task",
        description: "",
        status: "completed",
      },
    ]);
    await repo.updateTask(taskReady.id, { vcsBranch: "feature/task" });
    await repo.updateTask(taskDone.id, { vcsBranch: "feature/task-done" });

    const commandRun = await jobService.startCommandRun("code-review", project.key, {
      taskIds: [taskReady.id, taskDone.id],
    });
    const job = await jobService.startJob("review", commandRun.id, project.key, {
      commandName: "code-review",
      payload: { selection: [taskReady.id, taskDone.id] },
      totalItems: 2,
      processedItems: 0,
    });

    const stateDir = path.join(workspace.workspaceRoot, ".mcoda", "jobs", job.id, "review");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify(
        {
          schema_version: 1,
          job_id: job.id,
          selectedTaskIds: [taskReady.id, taskDone.id],
          contextBuilt: [],
          reviewed: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      resumeJobId: job.id,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.taskKey, taskReady.key);
    assert.ok(result.warnings.some((warning) => warning.includes(taskDone.key)));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService retries docdex search after reindex", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  let searchCalls = 0;
  let reindexCalls = 0;

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: {
      search: async () => {
        searchCalls += 1;
        if (searchCalls === 1) {
          throw new Error("docdex down");
        }
        return [{ id: "doc-1", docType: "DOC", content: "Doc content", createdAt: "now", updatedAt: "now" }];
      },
      reindex: async () => {
        reindexCalls += 1;
      },
    } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(reindexCalls, 1);
    assert.ok(searchCalls >= 2);
    assert.ok(result.warnings.every((warning) => !warning.includes("docdex search failed")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService blocks after invalid JSON retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  let invokeCount = 0;
  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => {
        invokeCount += 1;
        return { output: invokeCount === 1 ? "not json" : "still not json", adapter: "local" };
      },
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "block");
    assert.ok(result.warnings.some((warning) => warning.includes("non-JSON output")));

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService blocks empty diff without invoking agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = "";

  let invokeCount = 0;
  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => {
        invokeCount += 1;
        return { output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" };
      },
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "block");
    assert.ok(result.warnings.some((warning) => warning.includes("Empty diff")));
    assert.equal(invokeCount, 0);

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService invokes agent rating when enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const ratingService = {
    calls: [] as any[],
    async rate(request: any) {
      this.calls.push(request);
    },
  };

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({ output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
    ratingService: ratingService as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
      rateAgents: true,
    });

    assert.equal(ratingService.calls.length, 1);
    assert.equal(ratingService.calls[0]?.taskKey, task.key);
    assert.equal(ratingService.calls[0]?.commandName, "code-review");
    assert.equal(ratingService.calls[0]?.agentId, "agent-1");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService prepends project guidance to agent prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const guidanceDir = path.join(dir, "docs");
  await fs.mkdir(guidanceDir, { recursive: true });
  await fs.writeFile(path.join(guidanceDir, "project-guidance.md"), "GUIDANCE BLOCK", "utf8");

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  let lastInput = "";
  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async (_id: string, { input }: { input: string }) => {
        lastInput = input;
        return { output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" };
      },
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: true,
    });

    assert.ok(lastInput);
    const guidanceIndex = lastInput.indexOf("GUIDANCE BLOCK");
    const taskIndex = lastInput.indexOf(`Task ${task.key}`);
    assert.ok(guidanceIndex >= 0);
    assert.ok(taskIndex > guidanceIndex);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService resolves comment slugs and avoids duplicate findings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  let lastInput = "";
  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async (_id: string, { input }: { input: string }) => {
        lastInput = input;
        return {
          output: JSON.stringify({
            decision: "changes_requested",
            summary: "needs work",
            findings: [
              {
                type: "bug",
                severity: "high",
                file: "file.txt",
                line: 1,
                message: "Issue A",
              },
            ],
            resolvedSlugs: ["review-open"],
            unresolvedSlugs: ["review-resolved"],
          }),
          adapter: "local",
        };
      },
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "code-review",
      authorType: "agent",
      authorAgentId: "agent-0",
      category: "bug",
      slug: "review-issue",
      file: "file.txt",
      line: 1,
      pathHint: "file.txt",
      body: formatTaskCommentBody({
        slug: "review-issue",
        source: "code-review",
        message: "Issue A",
        status: "open",
        category: "bug",
        file: "file.txt",
        line: 1,
      }),
      createdAt: new Date().toISOString(),
    });

    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "code-review",
      authorType: "agent",
      authorAgentId: "agent-0",
      category: "info",
      slug: "review-open",
      body: formatTaskCommentBody({
        slug: "review-open",
        source: "code-review",
        message: "Open comment",
        status: "open",
        category: "info",
      }),
      createdAt: new Date().toISOString(),
    });

    const resolvedAt = new Date(Date.now() - 1000).toISOString();
    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "code-review",
      authorType: "agent",
      authorAgentId: "agent-0",
      category: "info",
      slug: "review-resolved",
      body: formatTaskCommentBody({
        slug: "review-resolved",
        source: "code-review",
        message: "Resolved comment",
        status: "resolved",
        category: "info",
      }),
      createdAt: resolvedAt,
      resolvedAt,
      resolvedBy: "agent-0",
    });

    await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.ok(lastInput.includes("review-open"));
    assert.ok(lastInput.includes("review-issue"));

    const resolved = await repo.listTaskComments(task.id, { slug: "review-open", resolved: true });
    assert.ok(resolved.length > 0);

    const reopened = await repo.listTaskComments(task.id, { slug: "review-resolved", resolved: false });
    assert.ok(reopened.length > 0);

    const sameSlug = await repo.listTaskComments(task.id, { slug: "review-issue" });
    assert.equal(sameSlug.length, 1);

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["code-review"] });
    assert.ok(comments.some((comment) => comment.category === "comment_resolution"));
    const summary = comments.find((comment) => comment.category === "review_summary");
    assert.ok(summary?.body.includes("resolved_slugs: 1"));
    assert.ok(summary?.body.includes("reopened_slugs: 1"));
    assert.ok(summary?.body.includes("open_slugs: 2"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService forces changes_requested when unresolved slugs remain", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-foo",
    "+bar",
    "",
  ].join("\n");

  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async () => ({
        output: JSON.stringify({
          decision: "approve",
          summary: "ok",
          findings: [],
        }),
        adapter: "local",
      }),
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "code-review": "Review prompt" },
      }),
    } as any,
    docdex: { search: async () => [] } as any,
    jobService,
    workspaceRepo: repo,
    repo: { close: async () => {} } as any,
    routingService: {
      resolveAgentForCommand: async () => ({
        agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  try {
    const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const [epic] = await repo.insertEpics([
      { projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 },
    ]);
    const [story] = await repo.insertStories([
      { projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" },
    ]);
    const [task] = await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task",
        description: "",
        status: "ready_to_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    await repo.createTaskComment({
      taskId: task.id,
      sourceCommand: "code-review",
      authorType: "agent",
      authorAgentId: "agent-0",
      category: "info",
      slug: "review-open",
      body: formatTaskCommentBody({
        slug: "review-open",
        source: "code-review",
        message: "Open comment",
        status: "open",
        category: "info",
      }),
      createdAt: new Date().toISOString(),
    });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "changes_requested");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "in_progress");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["code-review"] });
    const backlog = comments.find((comment) => comment.category === "comment_backlog");
    assert.ok(backlog?.body.includes("review-open"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
