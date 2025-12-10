import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { TaskSelectionService } from "../TaskSelectionService.js";
import { TaskStateService } from "../TaskStateService.js";
import { WorkOnTasksService } from "../WorkOnTasksService.js";
import { JobService } from "../../jobs/JobService.js";

class StubAgentService {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
    return { output: patch, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubDocdex {
  async search() {
    return [];
  }
  async close() {}
}

class StubRepo {
  async getWorkspaceDefaults() {
    return [];
  }
  async close() {}
}

class StubVcs {
  async ensureRepo() {}
  async ensureBaseBranch() {}
  async checkoutBranch() {}
  async createOrCheckoutBranch() {}
  async applyPatch() {}
  async dirtyPaths() {
    return [];
  }
  async stage() {}
  async status() {
    return " M tmp.txt";
  }
  async commit() {}
  async lastCommitSha() {
    return "abc123";
  }
  async hasRemote() {
    return false;
  }
  async push() {}
  async merge() {}
}

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-work-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-epic",
        title: "Epic",
        description: "",
        priority: 1,
      },
    ],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-epic-us-01",
        title: "Story",
        description: "",
      },
    ],
    false,
  );
  const tasks = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task A",
        description: "",
        status: "not_started",
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task B",
        description: "",
        status: "not_started",
      },
    ],
    false,
  );
  return { dir, workspace, repo, tasks };
};

const cleanupWorkspace = async (dir: string, repo: WorkspaceRepository) => {
  try {
    await repo.close();
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true });
};

test("workOnTasks marks tasks ready_to_review and records task runs", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
    });
    assert.equal(result.results.length, 2);
    const updatedA = await repo.getTaskByKey(tasks[0].key);
    const updatedB = await repo.getTaskByKey(tasks[1].key);
    assert.equal(updatedA?.status, "ready_to_review");
    assert.equal(updatedB?.status, "ready_to_review");
    const db = repo.getDb();
    const taskRuns = await db.all<{ status: string }[]>("SELECT status FROM task_runs WHERE command = 'work-on-tasks'");
    assert.equal(taskRuns.length, 2);
    assert.ok(taskRuns.every((r) => r.status === "succeeded"));
    const jobs = await db.all<{ state: string }[]>("SELECT state FROM jobs");
    assert.ok(jobs.some((j) => j.state === "completed"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});
