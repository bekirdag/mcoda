import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { JobService } from "../../jobs/JobService.js";
import { CodeReviewService } from "../CodeReviewService.js";
import { formatTaskCommentBody } from "../../tasks/TaskCommentFormatter.js";

let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
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
        type: "review",
        status: "ready_to_code_review",
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

test("CodeReviewService avoids repo prompt/job writes when noRepoWrites is set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-norepo-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir, noRepoWrites: true });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace, repo);

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

  const exists = async (target: string) => {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  };

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
        status: "ready_to_code_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(await exists(path.join(dir, ".mcoda", "prompts")), false);
    assert.equal(await exists(path.join(dir, ".mcoda", "jobs")), false);
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
        status: "ready_to_code_review",
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
        status: "ready_to_code_review",
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

    const stateDir = path.join(workspace.mcodaDir, "jobs", job.id, "review");
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
        status: "ready_to_code_review",
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

test("CodeReviewService resolves docdex doc_links into snippets", async () => {
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

  let findPathCalls = 0;

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
      search: async () => [],
      findDocumentByPath: async (docPath: string) => {
        findPathCalls += 1;
        if (docPath === "docs/sds/project.md") {
          return {
            id: "doc-1",
            docType: "SDS",
            title: "project.md",
            segments: [{ id: "doc-1-seg-1", docId: "doc-1", index: 0, content: "SDS excerpt" }],
            createdAt: "now",
            updatedAt: "now",
          };
        }
        return undefined;
      },
      fetchDocumentById: async () => undefined,
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
        status: "ready_to_code_review",
        metadata: { doc_links: ["docdex:docs/sds/project.md"] },
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
    assert.equal(findPathCalls, 1);
    const logs = await repo.getDb().all<{ source: string; details_json: string }[]>(
      "SELECT source, details_json FROM task_logs WHERE source = 'context_docdex'",
    );
    const parsed = logs.map((row) => JSON.parse(row.details_json));
    assert.ok(parsed.some((entry) => (entry.snippets ?? []).some((snippet: string) => snippet.includes("linked:SDS"))));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService normalizes non-JSON output to info_only", async () => {
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
        status: "ready_to_code_review",
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
    assert.equal(result.tasks[0]?.error, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes("not valid JSON")));

    const artifactPath = path.join(
      workspace.mcodaDir,
      "jobs",
      result.jobId,
      "review",
      "outputs",
      `${task.id}.json`,
    );
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
    assert.equal(artifact.primary_output, "not json");
    assert.equal(artifact.retry_output, "still not json");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService retries on transient agent errors", async () => {
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
        if (invokeCount === 1) {
          throw new Error("unexpected EOF");
        }
        return {
          output: JSON.stringify({
            decision: "approve",
            summary: "Looks good",
            findings: [],
            testRecommendations: [],
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
        status: "ready_to_code_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(invokeCount, 2);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "approve");
    assert.equal(result.tasks[0]?.error, undefined);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService accepts JSON with trailing text", async () => {
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
        output: [
          JSON.stringify({
            decision: "approve",
            summary: "Looks good",
            findings: [],
            testRecommendations: [],
          }),
          "Trailing narrative that should be ignored.",
        ].join("\n"),
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
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_code_review",
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
    assert.equal(result.tasks[0]?.error, undefined);
    assert.ok(!result.warnings.some((warning: string) => warning.includes("non-JSON output")));

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService retries with JSON-only agent override", async () => {
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

  const invokeCalls: Array<{ agentId: string; input: string }> = [];
  const service = new CodeReviewService(workspace, {
    agentService: {
      invoke: async (agentId: string, request: { input: string }) => {
        invokeCalls.push({ agentId, input: request.input });
        if (invokeCalls.length === 1) {
          return { output: "not json", adapter: "local" };
        }
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
      resolveAgentForCommand: async ({ overrideAgentSlug }: any) => ({
        agent:
          overrideAgentSlug === "review-json"
            ? { id: "agent-2", slug: "review-json", adapter: "local", defaultModel: "strict" }
            : { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
        agentId: overrideAgentSlug === "review-json" ? "agent-2" : "agent-1",
        agentSlug: overrideAgentSlug === "review-json" ? "review-json" : "agent-1",
        source: "override",
      }),
    } as any,
    vcsClient: {
      ensureRepo: async () => {},
      diff: async () => diffStub,
    } as any,
  });

  const prevOverride = process.env.MCODA_REVIEW_JSON_AGENT;
  process.env.MCODA_REVIEW_JSON_AGENT = "review-json";
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
        status: "ready_to_code_review",
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
    assert.equal(invokeCalls.length, 2);
    assert.equal(invokeCalls[1]?.agentId, "agent-2");
    assert.ok(invokeCalls[1]?.input.includes("Return ONLY valid JSON"));

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    if (prevOverride === undefined) {
      delete process.env.MCODA_REVIEW_JSON_AGENT;
    } else {
      process.env.MCODA_REVIEW_JSON_AGENT = prevOverride;
    }
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService fails fast when review agent override cannot be honored", async () => {
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
        agentId: "agent-1",
        agentSlug: "agent-1",
        source: "workspace_default",
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
    await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t03",
        title: "Task",
        description: "",
        status: "ready_to_code_review",
      },
    ]);

    await assert.rejects(
      async () => {
        await service.reviewTasks({
          workspace,
          projectKey: project.key,
          agentStream: false,
          dryRun: false,
          agentName: "override-agent",
        });
      },
      /Review agent override "override-agent"/,
    );
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService blocks when findings omit file/line", async () => {
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
        return {
          output: JSON.stringify({
            decision: "changes_requested",
            summary: "Missing location",
            findings: [
              {
                type: "bug",
                severity: "high",
                message: "Needs file/line",
              },
            ],
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
        status: "ready_to_code_review",
      },
    ]);
    await repo.updateTask(task.id, { vcsBranch: "feature/task" });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(invokeCount, 2);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "info_only");
    assert.equal(result.tasks[0]?.error, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes("missing required fields")));

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService reviews empty diff and completes when no changes are required", async () => {
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
        return { output: '{"decision":"approve","summary":"No changes required.","findings":[]}', adapter: "local" };
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
        status: "ready_to_code_review",
      },
    ]);
    await repo.updateTask(task.id, {
      vcsBranch: "feature/task",
      metadata: { completed_reason: "no_changes" },
    });

    const result = await service.reviewTasks({
      workspace,
      projectKey: project.key,
      agentStream: false,
      dryRun: false,
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.decision, "approve");
    assert.ok(result.warnings.some((warning) => warning.includes("Empty diff")));
    assert.equal(invokeCount, 1);

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "completed");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService requests changes when empty diff lacks justification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-review-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const diffStub = "";

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
        key: "proj-epic-us-01-t99",
        title: "Task",
        description: "",
        status: "ready_to_code_review",
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
    assert.equal(result.tasks[0]?.decision, "changes_requested");
    assert.ok((result.tasks[0]?.findings ?? []).length > 0);

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "changes_requested");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["code-review"] });
    const emptyDiff = comments.find((comment) => comment.category === "review_empty_diff");
    assert.ok(emptyDiff?.body.includes("Empty diff detected"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CodeReviewService downgrades changes_requested with no findings", async () => {
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
      invoke: async () =>
        ({ output: '{"decision":"changes_requested","summary":"needs changes","findings":[]}', adapter: "local" }),
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
        key: "proj-epic-us-01-t50",
        title: "Task",
        description: "",
        status: "ready_to_code_review",
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
    assert.ok(result.warnings.some((warning) => warning.includes("downgrading to info_only")));

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "ready_to_qa");
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
        status: "ready_to_code_review",
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
    assert.equal(ratingService.calls[0]?.discipline, "review");
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
        status: "ready_to_code_review",
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

test("CodeReviewService strips gateway-style prompts from agent profile", async () => {
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
        return { output: '{"decision":"approve","summary":"ok","findings":[]}', adapter: "local" };
      },
      getPrompts: async () => ({
        jobPrompt: "You are the gateway agent. Return JSON only.",
        characterPrompt: "Do not include fields outside the schema.",
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
    await repo.insertTasks([
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "ready_to_code_review",
        vcsBranch: "feature/task",
      },
    ]);

    await service.reviewTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });

    assert.ok(lastInput.length > 0);
    assert.ok(!lastInput.toLowerCase().includes("gateway agent"));
    assert.ok(!lastInput.toLowerCase().includes("return json only"));
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
        status: "ready_to_code_review",
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
        status: "ready_to_code_review",
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
    assert.equal(updated?.status, "changes_requested");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["code-review"] });
    const backlog = comments.find((comment) => comment.category === "comment_backlog");
    assert.ok(backlog?.body.includes("review-open"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
