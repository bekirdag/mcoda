import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";
import { TaskStateService } from "../TaskStateService.js";
import { QaTasksService } from "../QaTasksService.js";
import { QaProfileService } from "../QaProfileService.js";
import { JobService } from "../../jobs/JobService.js";
import { createTaskCommentSlug, formatTaskCommentBody } from "../../tasks/TaskCommentFormatter.js";

class StubQaAdapter {
  async ensureInstalled() {
    return { ok: true };
  }
  async invoke(_profile: any, ctx: any) {
    const now = new Date().toISOString();
    return {
      outcome: "pass",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      artifacts: [path.join(ctx.workspaceRoot, ".mcoda", "jobs", ctx.jobId, "qa", ctx.taskKey, "stdout.log")],
      startedAt: now,
      finishedAt: now,
    };
  }
}

class StubProfileService {
  async resolveProfileForTask() {
    return { name: "unit", runner: "cli", test_command: "echo ok" };
  }
}

class StubAgentService {
  async resolveAgent() {
    return { id: "qa-agent", defaultModel: "stub" } as any;
  }
  async invoke() {
    return { output: '{"recommendation":"pass"}' };
  }
}

class StubRoutingService {
  async resolveAgentForCommand() {
    return {
      agent: { id: "qa-agent", defaultModel: "stub" } as any,
      agentId: "qa-agent",
      agentSlug: "qa-agent",
      model: "stub",
      capabilities: [],
      healthStatus: "healthy",
      source: "workspace_default",
      routingPreview: { workspaceId: "ws", commandName: "qa-tasks" } as any,
    };
  }
}

class StubDocdex {
  async search() {
    return [];
  }
  async close() {}
}

class CapturingAgentService {
  lastInput = "";
  async resolveAgent() {
    return { id: "qa-agent", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.lastInput = req?.input ?? "";
    return { output: '{"recommendation":"pass"}' };
  }
}

class StubVcs {
  async ensureRepo() {}
  async ensureClean() {}
  async branchExists() {
    return true;
  }
  async checkoutBranch() {}
  async ensureBaseBranch() {}
}

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

test("qa-tasks auto run records QA outcome, tokens, and state transitions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  // Override adapter selection to use stubbed adapter.
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "pass");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "completed");

    const db = repo.getDb();
    const qaRuns = await db.all<{ recommendation: string }[]>(
      "SELECT recommendation FROM task_qa_runs WHERE task_id = ?",
      task.id,
    );
    assert.equal(qaRuns.length, 1);
    assert.equal(qaRuns[0]?.recommendation, "pass");

    const tokens = await db.all("SELECT tokens_prompt FROM token_usage");
    assert.equal(tokens.length, 1);

    const jobs = await db.all<{ state: string }[]>("SELECT state FROM jobs WHERE id = ?", result.jobId);
    assert.equal(jobs[0]?.state, "completed");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks includes QA docs in context and filters .mcoda docs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );
  const agent = new CapturingAgentService();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: agent as any,
    docdex: {
      search: async () => [
        {
          id: "doc-qa",
          docType: "DOC",
          path: "docs/qa-workflow.md",
          title: "QA Workflow",
          segments: [{ id: "seg-1", docId: "doc-qa", index: 0, content: "QA details" }],
          createdAt: "now",
          updatedAt: "now",
        },
        {
          id: "doc-internal",
          docType: "DOC",
          path: ".mcoda/docs/internal.md",
          title: "Internal Guidance",
          segments: [{ id: "seg-2", docId: "doc-internal", index: 0, content: "Hidden" }],
          createdAt: "now",
          updatedAt: "now",
        },
      ],
      close: async () => {},
    } as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });
    assert.ok(agent.lastInput.includes("QA Workflow"));
    assert.ok(!agent.lastInput.includes("Internal Guidance"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks prepends project guidance to agent prompt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const guidanceDir = path.join(dir, "docs");
  await fs.mkdir(guidanceDir, { recursive: true });
  await fs.writeFile(path.join(guidanceDir, "project-guidance.md"), "GUIDANCE BLOCK", "utf8");

  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  let lastInput = "";
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: {
      invoke: async (_id: string, { input }: { input: string }) => {
        lastInput = input;
        return { output: '{"recommendation":"pass"}' };
      },
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "qa-tasks": "QA prompt" },
      }),
    } as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.ok(lastInput);
    const guidanceIndex = lastInput.indexOf("GUIDANCE BLOCK");
    const taskIndex = lastInput.indexOf("Task: proj-epic-us-01-t01");
    assert.ok(guidanceIndex >= 0);
    assert.ok(taskIndex > guidanceIndex);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks strips gateway-style prompts from agent profile", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);

  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  let lastInput = "";
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: {
      invoke: async (_id: string, { input }: { input: string }) => {
        lastInput = input;
        return { output: '{"recommendation":"pass"}' };
      },
      getPrompts: async () => ({
        jobPrompt: "You are the gateway agent. Return JSON only.",
        characterPrompt: "Do not include fields outside the schema.",
        commandPrompts: { "qa-tasks": "QA prompt" },
      }),
    } as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.ok(!lastInput.toLowerCase().includes("gateway agent"));
    assert.ok(!lastInput.toLowerCase().includes("return json only"));
    assert.ok(lastInput.includes("QA prompt"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks selects Playwright profile for UI-tagged tasks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await fs.mkdir(path.join(dir, ".mcoda"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".mcoda", "qa-profiles.json"),
    JSON.stringify(
      [
        { name: "cli", runner: "cli", default: true, test_command: "echo ok" },
        { name: "chromium", runner: "chromium" },
      ],
      null,
      2,
    ),
    "utf8",
  );

  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "UI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        metadata: { tags: ["ui"], files: ["src/App.tsx"] },
      },
    ],
    false,
  );

  let selectedProfile = "";
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new QaProfileService(workspace.workspaceRoot),
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = (profile: any) => {
    selectedProfile = profile.name;
    return new StubQaAdapter();
  };

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(selectedProfile, "chromium");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks treats invalid JSON as unclear and records raw output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  let invokeCount = 0;
  const followups: any[] = [];
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: {
      createFollowupTask: async (_task: any, suggestion: any) => {
        followups.push(suggestion);
        return { task: { key: "QA-1" } };
      },
    } as any,
    vcsClient: new StubVcs() as any,
    agentService: {
      resolveAgent: async () => ({ id: "qa-agent", defaultModel: "stub" } as any),
      invoke: async () => {
        invokeCount += 1;
        return { output: invokeCount === 1 ? "not json" : "still not json" };
      },
    } as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      createFollowupTasks: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "unclear");
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");
    assert.ok(followups.length >= 1);

    const comments = await repo.listTaskComments(task.id);
    const summary = comments.find((comment) => (comment.body ?? "").includes("QA agent output (invalid JSON)"));
    assert.ok(summary);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks skips duplicate QA follow-up tasks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const suggestion = {
    title: `QA follow-up for ${task.key}`,
    description: "Issue found during QA.",
    type: "bug",
    priority: 90,
    story_points: 1,
    tags: ["qa"],
    related_task_key: task.key,
  };
  const seedParts = [
    task.key,
    suggestion.title ?? "",
    suggestion.description ?? "",
    suggestion.type ?? "",
    "",
    "",
    ...(suggestion.tags ?? []),
  ];
  const seed = seedParts.join("|").toLowerCase();
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 12);
  const followupSlug = `qa-followup-${task.key}-${digest}`;

  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t99",
        title: "Existing follow-up",
        description: "",
        status: "not_started",
        storyPoints: 1,
        metadata: { qa_followup_slug: followupSlug },
      },
    ],
    false,
  );

  const followupCalls: any[] = [];
  class FollowupAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke() {
      return {
        output: JSON.stringify({
          recommendation: "fix_required",
          failures: [{ kind: "functional", message: "QA issue", file: "src/app.ts", line: 5, evidence: "log" }],
          follow_up_tasks: [suggestion],
        }),
      };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: {
      createFollowupTask: async (_task: any, followup: any) => {
        followupCalls.push(followup);
        return { task: { key: "QA-NEW" } };
      },
    } as any,
    vcsClient: new StubVcs() as any,
    agentService: new FollowupAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      createFollowupTasks: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(followupCalls.length, 0);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks resolves comment slugs and creates issue comments with slugs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const openMessage = "Open review comment";
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
      message: openMessage,
      status: "open",
      category: "info",
    }),
    createdAt: new Date().toISOString(),
  });

  const resolvedAt = new Date(Date.now() - 1000).toISOString();
  await repo.createTaskComment({
    taskId: task.id,
    sourceCommand: "qa-tasks",
    authorType: "agent",
    authorAgentId: "agent-0",
    category: "qa_issue",
    slug: "qa-old",
    body: formatTaskCommentBody({
      slug: "qa-old",
      source: "qa-tasks",
      message: "Old QA issue",
      status: "resolved",
      category: "qa_issue",
    }),
    createdAt: resolvedAt,
    resolvedAt,
    resolvedBy: "agent-0",
  });

  let lastInput = "";
  class CommentAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      lastInput = input;
      return {
        output: JSON.stringify({
          recommendation: "fix_required",
          failures: [{ kind: "functional", message: "Login fails", file: "src/auth/login.ts", line: 42, evidence: "e2e.log" }],
          resolvedSlugs: ["review-open"],
          unresolvedSlugs: ["qa-old"],
        }),
      };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new CommentAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.ok(lastInput.includes("review-open"));

    const resolved = await repo.listTaskComments(task.id, { slug: "review-open", resolved: true });
    assert.ok(resolved.length > 0);

    const reopened = await repo.listTaskComments(task.id, { slug: "qa-old", resolved: false });
    assert.ok(reopened.length > 0);

    const failureSlug = createTaskCommentSlug({
      source: "qa-tasks",
      message: "Login fails",
      category: "functional",
      file: "src/auth/login.ts",
      line: 42,
    });
    const failureComments = await repo.listTaskComments(task.id, { slug: failureSlug, resolved: false });
    assert.ok(failureComments.length > 0);

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.category === "comment_resolution"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks blocks unclear outcomes with guidance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t03",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class UnclearAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke() {
      return {
        output: JSON.stringify({
          recommendation: "unclear",
          tested_scope: "unit",
          coverage_summary: "Missing acceptance criteria",
          failures: [],
        }),
      };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new UnclearAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "unclear");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");
    assert.equal((updated?.metadata as any)?.blocked_reason, "qa_unclear");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("QA outcome unclear")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks flags missing run-all marker as infra issue", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t05",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class MarkerProfileService {
    async resolveProfileForTask() {
      return { name: "unit", runner: "cli", test_command: "node tests/all.js" };
    }
  }

  class MarkerAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: `Tests finished for ${ctx.taskKey}`,
        stderr: "",
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new MarkerProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new MarkerAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "infra_issue");
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("MCODA_RUN_ALL_TESTS_COMPLETE")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks preflight blocks missing dependencies and env vars", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-preflight-"));
  const pkgPath = path.join(dir, "package.json");
  await fs.writeFile(
    pkgPath,
    JSON.stringify(
      {
        name: "qa-preflight",
        version: "1.0.0",
        dependencies: { pg: "1.0.0", ioredis: "1.0.0", argon2: "1.0.0" },
      },
      null,
      2,
    ),
  );
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t06",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class PreflightProfileService {
    async resolveProfileForTask() {
      return { name: "unit", runner: "cli", test_command: "node tests/all.js" };
    }
  }

  let ensureCalled = false;
  class PreflightAdapter {
    async ensureInstalled() {
      ensureCalled = true;
      return { ok: true };
    }
    async invoke() {
      throw new Error("should not invoke when preflight fails");
    }
  }

  const existingDb = process.env.TEST_DB_URL;
  const existingRedis = process.env.TEST_REDIS_URL;
  delete process.env.TEST_DB_URL;
  delete process.env.TEST_REDIS_URL;

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new PreflightProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new PreflightAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "infra_issue");
    assert.equal(ensureCalled, false);

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("Missing QA dependencies")));
    assert.ok(comments.some((comment) => comment.body.includes("Missing QA environment variables")));
  } finally {
    if (existingDb === undefined) {
      delete process.env.TEST_DB_URL;
    } else {
      process.env.TEST_DB_URL = existingDb;
    }
    if (existingRedis === undefined) {
      delete process.env.TEST_REDIS_URL;
    } else {
      process.env.TEST_REDIS_URL = existingRedis;
    }
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks install failure includes Playwright guidance for chromium runner", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t04",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class InstallFailAdapter {
    async ensureInstalled() {
      return { ok: false, message: "Playwright missing" };
    }
    async invoke() {
      throw new Error("should not invoke when install fails");
    }
  }

  class ChromiumProfileService {
    async resolveProfileForTask() {
      return { name: "ui", runner: "chromium" };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new ChromiumProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new InstallFailAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "infra_issue");

    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "blocked");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("Playwright")));

    const db = repo.getDb();
    const logs = await db.all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Playwright")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks auto run invokes agent rating when enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await repo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await repo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 2,
      },
    ],
    false,
  );

  const ratingService = new StubRatingService();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
    ratingService: ratingService as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
      rateAgents: true,
    });

    assert.equal(ratingService.calls.length, 1);
    const call = ratingService.calls[0];
    assert.equal(call.agentId, "qa-agent");
    assert.equal(call.commandName, "qa-tasks");
    assert.equal(call.taskKey, task.key);
    assert.equal(call.jobId, result.jobId);
    assert.equal(call.commandRunId, result.commandRunId);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
