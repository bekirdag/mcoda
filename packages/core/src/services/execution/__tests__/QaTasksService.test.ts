import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";
import { TaskStateService } from "../TaskStateService.js";
import { QaTasksService } from "../QaTasksService.js";
import { JobService } from "../../jobs/JobService.js";

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

class StubVcs {
  async ensureRepo() {}
  async ensureClean() {}
  async branchExists() {
    return true;
  }
  async checkoutBranch() {}
  async ensureBaseBranch() {}
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
