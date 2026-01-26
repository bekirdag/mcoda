import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";
import { TaskStateService } from "../TaskStateService.js";
import { QaTasksService } from "../QaTasksService.js";
import { QaProfileService } from "../QaProfileService.js";
import { JobService } from "../../jobs/JobService.js";
import { createTaskCommentSlug, formatTaskCommentBody } from "../../tasks/TaskCommentFormatter.js";

let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;
let originalQaInterpretation: string | undefined;
let originalQaStartServer: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  originalQaInterpretation = process.env.MCODA_QA_AGENT_INTERPRETATION;
  originalQaStartServer = process.env.MCODA_QA_START_SERVER;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.MCODA_QA_AGENT_INTERPRETATION = "1";
  process.env.MCODA_QA_START_SERVER = "0";
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
  if (originalQaInterpretation === undefined) {
    delete process.env.MCODA_QA_AGENT_INTERPRETATION;
  } else {
    process.env.MCODA_QA_AGENT_INTERPRETATION = originalQaInterpretation;
  }
  if (originalQaStartServer === undefined) {
    delete process.env.MCODA_QA_START_SERVER;
  } else {
    process.env.MCODA_QA_START_SERVER = originalQaStartServer;
  }
});

class StubQaAdapter {
  async ensureInstalled() {
    return { ok: true };
  }
  async invoke(_profile: any, ctx: any) {
    const now = new Date().toISOString();
    const artifactDir =
      ctx.artifactDir ??
      path.join(PathHelper.getWorkspaceDir(ctx.workspaceRoot), "jobs", ctx.jobId, "qa", ctx.taskKey);
    return {
      outcome: "pass",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      artifacts: [path.join(artifactDir, "stdout.log")],
      startedAt: now,
      finishedAt: now,
    };
  }
}

class StubProfileService {
  async loadProfiles() {
    return [{ name: "unit", runner: "cli", test_command: "echo ok", default: true }];
  }
  async resolveProfileForTask() {
    return { name: "unit", runner: "cli", test_command: "echo ok" };
  }
}

class StubAgentService {
  async resolveAgent() {
    return { id: "qa-agent", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req?: { input?: string }) {
    const input = req?.input ?? "";
    if (input.includes("QA routing agent")) {
      return { output: '{"task_profiles":{}}' };
    }
    return {
      output:
        '{"recommendation":"pass","tested_scope":"unit","coverage_summary":"ok","failures":[],"follow_up_tasks":[],"resolvedSlugs":[],"unresolvedSlugs":[]}',
    };
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
    const input = req?.input ?? "";
    if (input.includes("QA routing agent")) {
      return { output: '{"task_profiles":{}}' };
    }
    this.lastInput = input;
    return {
      output:
        '{"recommendation":"pass","tested_scope":"unit","coverage_summary":"ok","failures":[],"follow_up_tasks":[],"resolvedSlugs":[],"unresolvedSlugs":[]}',
    };
  }
}

class StubVcs {
  cleanCalls: Array<{ cwd: string; ignoreDotMcoda: boolean; ignorePaths: string[] }> = [];
  worktrees: Array<{ cwd: string; path: string; branch: string }> = [];
  addedWorktrees: Array<{ path: string; branch: string }> = [];
  branchByWorktree = new Map<string, string>();
  currentBranchCalls: string[] = [];
  checkoutCalls: Array<{ cwd: string; branch: string }> = [];
  addCalls = 0;
  removeCalls = 0;
  async ensureRepo() {}
  async ensureClean(cwd: string, ignoreDotMcoda = true, ignorePaths: string[] = []) {
    this.cleanCalls.push({ cwd, ignoreDotMcoda, ignorePaths });
  }
  async branchExists() {
    return true;
  }
  async currentBranch(cwd: string) {
    this.currentBranchCalls.push(cwd);
    return this.branchByWorktree.get(cwd) ?? null;
  }
  async checkoutBranch(cwd: string, branch: string) {
    this.checkoutCalls.push({ cwd, branch });
    this.branchByWorktree.set(cwd, branch);
  }
  async ensureBaseBranch() {}
  async addWorktree(cwd: string, worktreePath: string, branch: string) {
    this.addCalls += 1;
    this.worktrees.push({ cwd, path: worktreePath, branch });
    this.addedWorktrees.push({ path: worktreePath, branch });
    this.branchByWorktree.set(worktreePath, branch);
    await fs.mkdir(worktreePath, { recursive: true });
    try {
      await fs.copyFile(path.join(cwd, "package.json"), path.join(worktreePath, "package.json"));
      const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      const binValue = pkg?.bin;
      const binEntries: string[] = [];
      if (typeof binValue === "string") {
        binEntries.push(binValue);
      } else if (binValue && typeof binValue === "object") {
        for (const entry of Object.values(binValue)) {
          if (typeof entry === "string") binEntries.push(entry);
        }
      }
      for (const entry of binEntries) {
        const source = path.isAbsolute(entry) ? entry : path.join(cwd, entry);
        const relative = path.isAbsolute(entry) ? path.relative(cwd, entry) : entry;
        const target = path.join(worktreePath, relative);
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
        } catch {
          // ignore bin copy failures
        }
      }
    } catch {
      // ignore
    }
  }
  async removeWorktree(cwd: string, worktreePath: string) {
    this.removeCalls += 1;
    this.worktrees = this.worktrees.filter((entry) => entry.path !== worktreePath || entry.cwd !== cwd);
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

class MarkerProfileService {
  async loadProfiles() {
    return [{ name: "unit", runner: "cli", test_command: "node tests/all.js", default: true }];
  }
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
    assert.equal(tokens.length, 2);

    const jobs = await db.all<{ state: string }[]>("SELECT state FROM jobs WHERE id = ?", result.jobId);
    assert.equal(jobs[0]?.state, "completed");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks routing-only skips agent interpretation by default", async () => {
  process.env.MCODA_QA_AGENT_INTERPRETATION = "0";
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
        invokeCount += 1;
        if (input.includes("QA routing agent")) {
          return { output: "{\"task_profiles\":{}}" };
        }
        return {
          output:
            "{\"recommendation\":\"pass\",\"tested_scope\":\"unit\",\"coverage_summary\":\"ok\",\"failures\":[],\"follow_up_tasks\":[],\"resolvedSlugs\":[],\"unresolvedSlugs\":[]}",
        };
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
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "pass");
    assert.equal(invokeCount, 1);

    const db = repo.getDb();
    const qaRuns = await db.all<{ agent_id: string | null }[]>(
      "SELECT agent_id FROM task_qa_runs WHERE task_id = ?",
      task.id,
    );
    assert.equal(qaRuns[0]?.agent_id, null);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks skips execution when review shows no code changes", async () => {
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
        metadata: { last_review_diff_empty: true, last_review_decision: "approve" },
      },
    ],
    false,
  );
  let adapterInvoked = false;
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
  (service as any).adapterForProfile = () => ({
    async ensureInstalled() {
      adapterInvoked = true;
      return { ok: true };
    },
    async invoke() {
      adapterInvoked = true;
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    },
  });

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].outcome, "pass");
    assert.equal(adapterInvoked, false);
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "completed");
    const qaRuns = await repo.listTaskQaRuns(task.id);
    assert.equal(qaRuns.length, 1);
    assert.equal((qaRuns[0].metadata as any)?.reason, "review_no_changes");
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks aggregates multiple profiles when available", async () => {
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

  class MultiProfileService {
    async loadProfiles() {
      return [
        { name: "cli", runner: "cli", test_command: "echo ok", default: true },
        { name: "chromium", runner: "chromium", test_command: "http://localhost" },
      ];
    }
    async resolveProfilesForTask() {
      return [
        { name: "cli", runner: "cli", test_command: "echo ok" },
        { name: "chromium", runner: "chromium", test_command: "http://localhost" },
      ];
    }
    async resolveProfileForTask() {
      return { name: "cli", runner: "cli", test_command: "echo ok" };
    }
  }

  class MultiAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(profile: any) {
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: `${profile.name} ok`,
        stderr: "",
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    }
  }

  class RoutingAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, req?: { input?: string }) {
      const input = req?.input ?? "";
      if (input.includes("QA routing agent")) {
        return {
          output: `{\"task_profiles\":{\"${task.key}\":[\"cli\",\"chromium\"]}}`,
        };
      }
      return {
        output:
          '{"recommendation":"pass","tested_scope":"unit","coverage_summary":"ok","failures":[],"follow_up_tasks":[],"resolvedSlugs":[],"unresolvedSlugs":[]}',
      };
    }
  }

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new MultiProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new RoutingAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new MultiAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].profile, "auto");
    assert.equal(result.results[0].runner, "multi");
    const qaRuns = await repo.listTaskQaRuns(task.id);
    assert.equal(qaRuns.length, 1);
    assert.equal((qaRuns[0].metadata as any)?.runCount, 2);
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks multi-profile failure resets status, comments, and cleans worktree", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "qa-worktree", version: "1.0.0" }, null, 2),
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
        key: "proj-epic-us-01-t03",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class MultiProfileService {
    async loadProfiles() {
      return [
        { name: "cli", runner: "cli", test_command: "echo ok", default: true },
        { name: "chromium", runner: "chromium", test_command: "http://localhost" },
      ];
    }
    async resolveProfilesForTask() {
      return [
        { name: "cli", runner: "cli", test_command: "echo ok" },
        { name: "chromium", runner: "chromium", test_command: "http://localhost" },
      ];
    }
    async resolveProfileForTask() {
      return { name: "cli", runner: "cli", test_command: "echo ok" };
    }
  }

  const invokedProfiles: string[] = [];
  class MultiOutcomeAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(profile: any) {
      invokedProfiles.push(profile.name);
      const now = new Date().toISOString();
      if (profile.runner === "chromium") {
        return {
          outcome: "fail",
          exitCode: 1,
          stdout: "chromium failed",
          stderr: "UI failure",
          artifacts: [],
          startedAt: now,
          finishedAt: now,
        };
      }
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "cli ok",
        stderr: "",
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    }
  }

  class MultiOutcomeAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, req?: { input?: string }) {
      const input = req?.input ?? "";
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({ task_profiles: { [task.key]: ["cli", "chromium"] } }),
        };
      }
      return {
        output: JSON.stringify({
          recommendation: "fix_required",
          tested_scope: "cli+chromium",
          coverage_summary: "Chromium QA failed.",
          failures: [
            {
              category: "qa_issue",
              message: "Chromium failed",
              suggested_fix: "Resolve UI failure and rerun QA.",
            },
          ],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
        }),
      };
    }
  }

  const vcs = new StubVcs();
  const adapter = new MultiOutcomeAdapter();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new MultiProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: vcs as any,
    agentService: new MultiOutcomeAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => adapter;

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.ok(invokedProfiles.includes("cli"));
    assert.ok(invokedProfiles.includes("chromium"));
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "not_started");
    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.category === "qa_issue"));
    assert.equal(vcs.addCalls, 1);
    assert.equal(vcs.removeCalls, 1);
    assert.equal(vcs.worktrees.length, 0);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks filters chromium for non-ui tasks even when agent selects it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "qa-filter", version: "1.0.0" }, null, 2),
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
        key: "bck-01-us-01-t01",
        title: "Backend task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class ProfileServiceWithPlan {
    async loadProfiles() {
      return [
        { name: "cli", runner: "cli", test_command: "echo ok", default: true },
        { name: "chromium", runner: "chromium", test_command: "http://localhost" },
      ];
    }
    async resolveProfileForTask() {
      return { name: "cli", runner: "cli", test_command: "echo ok" };
    }
    async getRunnerPlan() {
      return { runners: ["cli"], hasWebInterface: true, uiTask: false, mobileTask: false };
    }
  }

  class AgentServiceSelectsChromium {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, req?: { input?: string }) {
      const input = req?.input ?? "";
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({ task_profiles: { [task.key]: ["chromium"] } }),
        };
      }
      return {
        output: JSON.stringify({
          recommendation: "pass",
          tested_scope: "cli",
          coverage_summary: "ok",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
        }),
      };
    }
  }

  const invokedProfiles: string[] = [];
  class RecordingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(profile: any) {
      invokedProfiles.push(profile.name);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: `${profile.name} ok`,
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
    profileService: new ProfileServiceWithPlan() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new AgentServiceSelectsChromium() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new RecordingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.ok(invokedProfiles.includes("cli"));
    assert.ok(!invokedProfiles.includes("chromium"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks passes clean ignore paths to VCS", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  workspace.config = {
    ...(workspace.config ?? {}),
    qa: { cleanIgnorePaths: ["cache/"] },
  };
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
      },
    ],
    false,
  );

  const vcs = new StubVcs();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: vcs as any,
    agentService: new StubAgentService() as any,
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
      cleanIgnorePaths: ["scratch/"],
    });

    assert.ok(vcs.cleanCalls.length > 0);
    const ignorePaths = vcs.cleanCalls[0]?.ignorePaths ?? [];
    assert.ok(ignorePaths.includes("repo_meta.json"));
    assert.ok(ignorePaths.includes("logs/"));
    assert.ok(ignorePaths.includes(".docdexignore"));
    assert.ok(ignorePaths.includes("cache/"));
    assert.ok(ignorePaths.includes("scratch/"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks avoids repo prompt/job writes when noRepoWrites is set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-norepo-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir, noRepoWrites: true });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace, repo);
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
  (service as any).adapterForProfile = () => new StubQaAdapter();

  const exists = async (target: string) => {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  };

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(await exists(path.join(dir, ".mcoda", "prompts")), false);
    assert.equal(await exists(path.join(dir, ".mcoda", "jobs")), false);
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
        return {
          output:
            '{"recommendation":"pass","tested_scope":"unit","coverage_summary":"ok","failures":[],"follow_up_tasks":[],"resolvedSlugs":[],"unresolvedSlugs":[]}',
        };
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

test("qa-tasks refreshes stale QA prompt content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);

  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
  });

  const mcodaPromptPath = path.join(workspace.mcodaDir, "prompts", "qa-agent.md");
  const workspacePromptPath = path.join(workspace.workspaceRoot, "prompts", "qa-agent.md");
  await fs.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
  await fs.mkdir(path.dirname(workspacePromptPath), { recursive: true });
  await fs.writeFile(
    mcodaPromptPath,
    "QA policy: always run automated tests. Use browser (Legacy) tests only when the project has a web UI.",
    "utf8",
  );
  await fs.writeFile(
    workspacePromptPath,
    "QA policy: always run automated tests. Use browser (Chromium) tests only when the project has a web UI.",
    "utf8",
  );

  try {
    await (service as any).loadPrompts("qa-agent");
    const refreshed = await fs.readFile(mcodaPromptPath, "utf8");
    assert.ok(!/legacy/i.test(refreshed));
    assert.ok(/chromium/i.test(refreshed));
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
        return {
          output:
            '{"recommendation":"pass","tested_scope":"unit","coverage_summary":"ok","failures":[],"follow_up_tasks":[],"resolvedSlugs":[],"unresolvedSlugs":[]}',
        };
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

test("qa-tasks selects chromium profile for UI-tagged tasks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await fs.mkdir(workspace.mcodaDir, { recursive: true });
  await fs.writeFile(
    path.join(workspace.mcodaDir, "qa-profiles.json"),
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
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "export {};", "utf8");

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

  const routingAgent = {
    invoke: async (_id: string, { input }: { input: string }) => {
      if (input.includes("QA routing agent")) {
        return { output: `{\"task_profiles\":{\"proj-epic-us-01-t01\":[\"cli\"]}}` };
      }
      return {
        output:
          "{\"recommendation\":\"pass\",\"tested_scope\":\"unit\",\"coverage_summary\":\"ok\",\"failures\":[],\"follow_up_tasks\":[],\"resolvedSlugs\":[],\"unresolvedSlugs\":[]}",
      };
    },
  };

  const selectedProfiles: string[] = [];
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new QaProfileService(workspace.workspaceRoot),
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: routingAgent as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = (profile: any) => {
    selectedProfiles.push(profile.name);
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
    assert.ok(selectedProfiles.includes("cli"));
    assert.ok(selectedProfiles.includes("chromium"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks uses CLI commands from routing plan", async () => {
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
        title: "CLI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const planCommands = ["node -e \"console.log('one')\"", "node -e \"console.log('two')\""];
  class PlanAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({
            task_profiles: { [task.key]: ["unit"] },
            task_plans: { [task.key]: { cli: { commands: planCommands } } },
          }),
        };
      }
      return {
        output: JSON.stringify({
          tested_scope: "cli",
          coverage_summary: "ok",
          recommendation: "pass",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
        }),
      };
    }
  }

  const captured: { commands?: string[] } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.commands = ctx.commands ?? (ctx.testCommandOverride ? [ctx.testCommandOverride] : []);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new PlanAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(captured.commands, planCommands);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks uses category commands in unit/component/integration/api order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-order-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        scripts: {
          "test:unit": "node -e \"console.log('unit')\"",
          "test:component": "node -e \"console.log('component')\"",
          "test:integration": "node -e \"console.log('integration')\"",
          "test:api": "node -e \"console.log('api')\"",
        },
      },
      null,
      2,
    ),
    "utf8",
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
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "API Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        metadata: {
          test_requirements: {
            unit: ["u"],
            component: ["c"],
            integration: ["i"],
            api: ["a"],
          },
        },
      },
    ],
    false,
  );

  const captured: { commands?: string[] } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.commands = ctx.commands ?? (ctx.testCommandOverride ? [ctx.testCommandOverride] : []);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(captured.commands, [
      "npm run test:unit",
      "npm run test:component",
      "npm run test:integration",
      "npm run test:api",
    ]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks falls back to tests/all.js when category commands are missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-fallback-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", scripts: {} }, null, 2),
    "utf8",
  );
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  await fs.writeFile(path.join(dir, "tests", "all.js"), "console.log('ok');\n", "utf8");
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
        title: "Fallback Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        metadata: {
          test_requirements: { unit: ["u"], component: [], integration: [], api: [] },
        },
      },
    ],
    false,
  );

  const captured: { commands?: string[] } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.commands = ctx.commands ?? (ctx.testCommandOverride ? [ctx.testCommandOverride] : []);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(captured.commands, ["node tests/all.js"]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks injects chromium env for CLI browser tools", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-chromium-"));
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const chromiumPath = path.join(dir, "bin", "chromium");
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(chromiumPath, "", "utf8");
  process.env.MCODA_QA_CHROMIUM_PATH = chromiumPath;

  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", scripts: {} }, null, 2),
    "utf8",
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
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Browser QA Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        metadata: { tests: ["npx cypress run"] },
      },
    ],
    false,
  );

  const captured: { commands?: string[]; env?: NodeJS.ProcessEnv } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.env = ctx.env;
      captured.commands = ctx.commands ?? (ctx.testCommandOverride ? [ctx.testCommandOverride] : []);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(captured.commands, ["npx cypress run --browser chromium"]);
    assert.equal(captured.env?.CHROME_PATH, chromiumPath);
    assert.equal(captured.env?.CHROME_BIN, chromiumPath);
    assert.equal(captured.env?.PUPPETEER_EXECUTABLE_PATH, chromiumPath);
    assert.equal(captured.env?.PUPPETEER_PRODUCT, "chrome");
    assert.equal(captured.env?.CYPRESS_BROWSER, "chromium");
  } finally {
    if (prevChromiumPath === undefined) {
      delete process.env.MCODA_QA_CHROMIUM_PATH;
    } else {
      process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    }
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks appends CLI checklist commands when scripts exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(path.join(dir, "bin", "demo.js"), "console.log('demo');\n", "utf8");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        bin: { demo: "bin/demo.js" },
        scripts: {
          test: "node -e \"console.log('test')\"",
          lint: "node -e \"console.log('lint')\"",
          build: "node -e \"console.log('build')\"",
        },
      },
      null,
      2,
    ),
    "utf8",
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
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "CLI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        metadata: { files: ["packages/cli/index.ts"] },
      },
    ],
    false,
  );

  const captured: { commands?: string[] } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.commands = ctx.commands ?? (ctx.testCommandOverride ? [ctx.testCommandOverride] : []);
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new QaProfileService(workspace.workspaceRoot),
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(captured.commands, [
      "npm test",
      "npm run lint --if-present",
      "npm run build --if-present",
      "node bin/demo.js --help",
    ]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks shifts local base URL to a free port when CLI runs and port is in use", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        scripts: { test: "node -e \"console.log('ok')\"" },
      },
      null,
      2,
    ),
    "utf8",
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
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t03",
        title: "CLI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const usedPort = (server.address() as any).port as number;

  const captured: { env?: NodeJS.ProcessEnv } = {};
  class CapturingAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.env = ctx.env;
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new QaProfileService(workspace.workspaceRoot),
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
      testCommand: `http://127.0.0.1:${usedPort}`,
    });

    assert.equal(result.results.length, 1);
    const apiBase = captured.env?.MCODA_QA_API_BASE_URL ?? "";
    assert.ok(apiBase.includes("http://127.0.0.1:"));
    assert.ok(!apiBase.includes(`:${usedPort}`));
    const envPort = Number(captured.env?.PORT);
    assert.ok(Number.isFinite(envPort));
    assert.notEqual(envPort, usedPort);
  } finally {
    server.close();
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks runs in a worktree and cleans it up", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "qa-worktree", version: "1.0.0" }, null, 2),
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
  await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "CLI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const vcs = new StubVcs();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: vcs as any,
    agentService: new StubAgentService() as any,
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
    assert.equal(vcs.addCalls, 1);
    assert.equal(vcs.removeCalls, 1);
    assert.equal(vcs.worktrees.length, 0);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks switches branches per task run", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "qa-worktree", version: "1.0.0" }, null, 2),
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
  const [taskA, taskB] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t10",
        title: "Task QA A",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        vcsBranch: "feature/a",
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t11",
        title: "Task QA B",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
        vcsBranch: "feature/b",
      },
    ],
    false,
  );

  const vcs = new StubVcs();
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: vcs as any,
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      taskKeys: [taskA.key, taskB.key],
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 2);
    const branches = vcs.addedWorktrees.map((entry) => entry.branch).sort();
    assert.deepEqual(branches, ["feature/a", "feature/b"]);
    assert.ok(vcs.currentBranchCalls.length >= 2);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks injects localhost host env defaults", async () => {
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
        key: "proj-epic-us-01-t12",
        title: "Task QA",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  class EnvAdapter {
    env?: NodeJS.ProcessEnv;
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      this.env = ctx.env;
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "",
        stderr: "",
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    }
  }

  const originalHost = process.env.HOST;
  process.env.HOST = "0.0.0.0";
  const adapter = new EnvAdapter();
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
  (service as any).adapterForProfile = () => adapter;

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(adapter.env?.HOST, "127.0.0.1");
  } finally {
    if (originalHost === undefined) {
      delete process.env.HOST;
    } else {
      process.env.HOST = originalHost;
    }
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks passes browser actions and stress actions to chromium adapter", async () => {
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
        title: "UI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const baseUrl = "http://127.0.0.1:3000";
  class BrowserPlanAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({
            task_profiles: { [task.key]: ["chromium"] },
            task_plans: {
              [task.key]: {
                browser: { base_url: baseUrl, actions: [{ type: "navigate", url: "/" }] },
                stress: { browser: [{ type: "repeat", count: 2, action: { type: "click", selector: "#save" } }] },
              },
            },
          }),
        };
      }
      return {
        output: JSON.stringify({
          tested_scope: "chromium",
          coverage_summary: "ok",
          recommendation: "pass",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
        }),
      };
    }
  }

  class BrowserProfileService {
    async loadProfiles() {
      return [{ name: "chromium", runner: "chromium", default: true }];
    }
    async resolveProfileForTask() {
      return { name: "chromium", runner: "chromium" };
    }
  }

  const captured: { actions?: any[]; baseUrl?: string } = {};
  class CapturingChromiumAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.actions = ctx.browserActions ?? [];
      captured.baseUrl = ctx.browserBaseUrl;
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new BrowserProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new BrowserPlanAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingChromiumAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(captured.baseUrl, baseUrl);
    assert.equal(captured.actions?.length, 3);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks injects default browser actions when missing", async () => {
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
        title: "UI Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const baseUrl = "http://127.0.0.1:3000";
  class BrowserPlanAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({
            task_profiles: { [task.key]: ["chromium"] },
            task_plans: { [task.key]: { browser: { base_url: baseUrl } } },
          }),
        };
      }
      return {
        output: JSON.stringify({
          tested_scope: "chromium",
          coverage_summary: "ok",
          recommendation: "pass",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
        }),
      };
    }
  }

  class BrowserProfileService {
    async loadProfiles() {
      return [{ name: "chromium", runner: "chromium", default: true }];
    }
    async resolveProfileForTask() {
      return { name: "chromium", runner: "chromium" };
    }
  }

  const captured: { actions?: any[] } = {};
  class CapturingChromiumAdapter {
    async ensureInstalled() {
      return { ok: true };
    }
    async invoke(_profile: any, ctx: any) {
      captured.actions = ctx.browserActions ?? [];
      const now = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "ok",
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
    profileService: new BrowserProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: new BrowserPlanAgentService() as any,
    docdex: new StubDocdex() as any,
    routingService: new StubRoutingService() as any,
  });
  (service as any).adapterForProfile = () => new CapturingChromiumAdapter();

  try {
    await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
    });

    assert.ok((captured.actions ?? []).length >= 3);
    assert.equal(captured.actions?.[0]?.type, "navigate");
    assert.equal(captured.actions?.[1]?.type, "script");
    assert.equal(captured.actions?.[2]?.type, "snapshot");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks runs API actions from routing plan", async () => {
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
        title: "API Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  class ApiPlanAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({
            task_profiles: { [task.key]: ["unit"] },
            task_plans: {
              [task.key]: {
                cli: { commands: ["node -e \"console.log('cli')\""] },
                api: {
                  base_url: baseUrl,
                  requests: [{ method: "GET", path: "/health", expect: { status: 200 } }],
                },
              },
            },
          }),
        };
      }
      return {
        output: JSON.stringify({
          tested_scope: "cli",
          coverage_summary: "ok",
          recommendation: "pass",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
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
    agentService: new ApiPlanAgentService() as any,
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
    const artifacts = result.results[0]?.artifacts ?? [];
    assert.ok(artifacts.some((artifact) => artifact.endsWith("api-results.json")));
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks injects default API requests when missing", async () => {
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
        title: "API Task",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  class ApiFallbackAgentService {
    async resolveAgent() {
      return { id: "qa-agent", defaultModel: "stub" } as any;
    }
    async invoke(_id: string, { input }: { input: string }) {
      if (input.includes("QA routing agent")) {
        return {
          output: JSON.stringify({
            task_profiles: { [task.key]: ["unit"] },
            task_plans: {
              [task.key]: {
                cli: { commands: ["node -e \"console.log('cli')\""] },
                api: { base_url: baseUrl },
              },
            },
          }),
        };
      }
      return {
        output: JSON.stringify({
          tested_scope: "cli",
          coverage_summary: "ok",
          recommendation: "pass",
          failures: [],
          follow_up_tasks: [],
          resolvedSlugs: [],
          unresolvedSlugs: [],
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
    agentService: new ApiFallbackAgentService() as any,
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
    const artifacts = result.results[0]?.artifacts ?? [];
    assert.ok(artifacts.some((artifact) => artifact.endsWith("api-results.json")));
    assert.ok(hits.includes("/health"));
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks skips API runs when an explicit non-api profile is requested", async () => {
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
        key: "bck-epic-us-01-t03",
        title: "Backend Task",
        description: "API endpoint work",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const originalApiBase = process.env.MCODA_QA_API_BASE_URL;
  process.env.MCODA_QA_API_BASE_URL = baseUrl;

  class ChromiumProfileService {
    async loadProfiles() {
      return [{ name: "chromium", runner: "chromium", default: true }];
    }
    async resolveProfileForTask() {
      return { name: "chromium", runner: "chromium" };
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
  (service as any).adapterForProfile = () => new StubQaAdapter();

  try {
    const result = await service.run({
      workspace,
      projectKey: project.key,
      statusFilter: ["ready_to_qa"],
      mode: "auto",
      agentStream: false,
      profileName: "chromium",
    });
    assert.equal(result.results.length, 1);
    const artifacts = result.results[0]?.artifacts ?? [];
    assert.ok(!artifacts.some((artifact) => artifact.endsWith("api-results.json")));
    assert.ok(!hits.includes("/health"));
  } finally {
    if (originalApiBase === undefined) {
      delete process.env.MCODA_QA_API_BASE_URL;
    } else {
      process.env.MCODA_QA_API_BASE_URL = originalApiBase;
    }
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    assert.equal(updated?.status, "not_started");
    assert.equal((updated?.metadata as any)?.qa_failure_reason, "qa_invalid_output");
    assert.ok(followups.length >= 1);

    const comments = await repo.listTaskComments(task.id);
    const summary = comments.find((comment) => (comment.body ?? "").includes("QA agent output (invalid JSON)"));
    assert.ok(summary);
    assert.ok((summary?.body ?? "").includes("qa_invalid_output"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks blocks when QA output is missing required fields", async () => {
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
        title: "Task QA missing fields",
        description: "",
        status: "ready_to_qa",
        storyPoints: 1,
      },
    ],
    false,
  );

  let invokeCount = 0;
  const service = new QaTasksService(workspace, {
    workspaceRepo: repo,
    jobService,
    selectionService,
    stateService,
    profileService: new StubProfileService() as any,
    followupService: { createFollowupTask: async () => ({}) } as any,
    vcsClient: new StubVcs() as any,
    agentService: {
      resolveAgent: async () => ({ id: "qa-agent", defaultModel: "stub" } as any),
      invoke: async () => {
        invokeCount += 1;
        return {
          output: JSON.stringify({
            recommendation: "fix_required",
            failures: [{ message: "missing file and line" }],
          }),
        };
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
      agentStream: false,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.outcome, "unclear");
    assert.ok(invokeCount >= 2);
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "not_started");
    assert.equal((updated?.metadata as any)?.qa_failure_reason, "qa_invalid_output");
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
          tested_scope: "cli",
          coverage_summary: "QA follow-up evaluation completed.",
          recommendation: "fix_required",
          failures: [{ kind: "functional", message: "QA issue", file: "src/app.ts", line: 5, evidence: "log" }],
          follow_up_tasks: [suggestion],
          resolvedSlugs: [],
          unresolvedSlugs: [],
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
          tested_scope: "cli",
          coverage_summary: "Login flow retested with QA checks.",
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
    assert.equal(updated?.status, "not_started");
    assert.equal((updated?.metadata as any)?.qa_failure_reason, "qa_unclear");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("QA outcome unclear")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks warns on missing run-all marker when tests pass", async () => {
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
    assert.equal(result.results[0]?.outcome, "pass");
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "completed");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("MCODA_RUN_ALL_TESTS_COMPLETE")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("qa-tasks warns on missing run-all marker when policy is relaxed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-service-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  workspace.config = { ...(workspace.config ?? {}), qa: { ...(workspace.config?.qa ?? {}), runAllMarkerRequired: false } };
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
        key: "proj-epic-us-01-t07",
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
    assert.equal(result.results[0]?.outcome, "pass");
    const updated = await repo.getTaskByKey(task.key);
    assert.equal(updated?.status, "completed");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    const summary = comments.find((comment) => comment.category === "qa_result");
    assert.ok(summary?.body.includes("MCODA_RUN_ALL_TESTS_COMPLETE"));
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
    async loadProfiles() {
      return [{ name: "unit", runner: "cli", test_command: "node tests/all.js", default: true }];
    }
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
    assert.equal(updated?.status, "not_started");
    assert.equal((updated?.metadata as any)?.qa_failure_reason, "qa_infra_issue");

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

test("qa-tasks install failure includes chromium guidance for chromium runner", async () => {
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
      return { ok: false, message: "QA install failed" };
    }
    async invoke() {
      throw new Error("should not invoke when install fails");
    }
  }

  class ChromiumProfileService {
    async loadProfiles() {
      return [{ name: "ui", runner: "chromium", default: true }];
    }
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
    assert.equal(updated?.status, "not_started");
    assert.equal((updated?.metadata as any)?.qa_failure_reason, "qa_infra_issue");

    const comments = await repo.listTaskComments(task.id, { sourceCommands: ["qa-tasks"] });
    assert.ok(comments.some((comment) => comment.body.includes("Docdex Chromium")));

    const db = repo.getDb();
    const logs = await db.all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Docdex Chromium")));
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
