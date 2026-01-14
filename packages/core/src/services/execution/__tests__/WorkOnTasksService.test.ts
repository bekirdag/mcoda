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

class StubAgentServiceNoPlus {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "hello world",
      "*** End Patch",
      "```",
    ].join("\n");
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

class StubAgentServiceAbsolutePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- /dev/null",
      "+++ FILE: tests/absolute.txt",
      "@@ -0,0 +1,1 @@",
      "+hello world",
      "```",
    ].join("\n");
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

class StubAgentServiceOutOfScopePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/../outside.txt",
      "+++ b/../outside.txt",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
      "```",
    ].join("\n");
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

class StubAgentServiceAddPatchMissingFile {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/tests/newfile.txt",
      "+++ b/tests/newfile.txt",
      "@@ -0,0 +1,1 @@",
      "+hello world",
      "```",
    ].join("\n");
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

class StubAgentServiceCapture {
  lastInput: string | null = null;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.lastInput = req?.input ?? null;
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

class StubAgentServiceNoChange {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const output = ["FILE: existing.txt", "```", "no-op", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceBulletFile {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const output = ["- FILE: `bullet.txt`", "```", "bullet content", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceJsonPlanThenPatch {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    if (this.invocations === 1) {
      return { output: JSON.stringify({ plan: ["step one", "step two"], notes: "no patch yet" }), adapter: "local-model" };
    }
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

class StubAgentServiceNonPatchFenceThenPatch {
  invocations = 0;
  inputs: string[] = [];
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, req: any) {
    this.invocations += 1;
    this.inputs.push(req?.input ?? "");
    if (this.invocations === 1) {
      const output = ["```patch", "console.log('no diff')", "```"].join("\n");
      return { output, adapter: "local-model" };
    }
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

class StubAgentServiceJsonPreamblePatch {
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    const patch = [
      "```patch",
      "--- a/tmp.txt",
      "+++ b/tmp.txt",
      "@@",
      "-foo",
      "+hello world",
      "```",
    ].join("\n");
    const payload = { patch };
    const output = `Result:\n${JSON.stringify(payload)}\nDone.`;
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceTestFix {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const fileName = this.invocations === 1 ? "fail.flag" : "pass.flag";
    const content = this.invocations === 1 ? "fail" : "ok";
    const output = [`FILE: ${fileName}`, "```", content, "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceRunAllFix {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const fileName = this.invocations === 1 ? "work.txt" : "global.pass";
    const output = [`FILE: ${fileName}`, "```", "ok", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceRunAllOnce {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: global.pass", "```", "ok", "```"].join("\n");
    return { output, adapter: "local-model" };
  }
  async getPrompts() {
    return {
      jobPrompt: "You are a worker.",
      characterPrompt: "Be concise.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    };
  }
}

class StubAgentServiceAlwaysFail {
  invocations = 0;
  async resolveAgent() {
    return { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any;
  }
  async invoke(_id: string, _req: any) {
    this.invocations += 1;
    const output = ["FILE: fail.flag", "```", "fail", "```"].join("\n");
    return { output, adapter: "local-model" };
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

class StubDocdexScopeFail {
  async ensureRepoScope() {
    throw new Error("Docdex repo scope missing for /tmp/ws");
  }
  async search() {
    throw new Error("docdex search should not run without scope");
  }
  async close() {}
}

class StubDocdexWithLinks {
  findByPathCalls: string[] = [];
  fetchByIdCalls: string[] = [];
  async search() {
    return [];
  }
  async findDocumentByPath(docPath: string) {
    this.findByPathCalls.push(docPath);
    if (docPath === "docs/sds/project.md") {
      return {
        id: "doc-1",
        docType: "SDS",
        path: "docs/sds/project.md",
        title: "project.md",
        segments: [{ id: "doc-1-seg-1", docId: "doc-1", index: 0, content: "SDS excerpt" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return undefined;
  }
  async fetchDocumentById(id: string) {
    this.fetchByIdCalls.push(id);
    return {
      id,
      docType: "DOC",
      title: id,
      segments: [{ id: `${id}-seg-1`, docId: id, index: 0, content: "fallback excerpt" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  async close() {}
}

class StubRepo {
  async getWorkspaceDefaults() {
    return [];
  }
  async close() {}
}

class StubRoutingService {
  async resolveAgentForCommand() {
    return {
      agent: { id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any,
      agentId: "agent-1",
      agentSlug: "agent-1",
      model: "stub",
      capabilities: [],
      healthStatus: "healthy",
      source: "override",
      routingPreview: { workspaceId: "ws", commandName: "work-on-tasks" } as any,
    };
  }
}

class StubRatingService {
  calls: any[] = [];
  async rate(request: any) {
    this.calls.push(request);
  }
}

class StubVcs {
  async ensureRepo(_cwd: string) {}
  async ensureBaseBranch(_cwd: string, _base: string) {}
  async branchExists(_cwd: string, _branch: string) {
    return false;
  }
  async checkoutBranch(_cwd: string, _branch: string) {}
  async createOrCheckoutBranch(_cwd: string, _branch: string, _base: string) {}
  async applyPatch(_cwd: string, _patch: string) {}
  async applyPatchWithReject(_cwd: string, _patch: string) {
    return {};
  }
  async pull(_cwd: string, _remote: string, _branch: string, _ffOnly = true) {}
  async conflictPaths(_cwd?: string): Promise<string[]> {
    return [];
  }
  async currentBranch(_cwd?: string) {
    return "mcoda-dev";
  }
  async ensureClean(_cwd: string, _ignoreDotMcoda = true) {}
  async dirtyPaths(_cwd?: string): Promise<string[]> {
    return [];
  }
  async stage(_cwd: string, _paths: string[]) {}
  async status(_cwd?: string) {
    return " M tmp.txt";
  }
  async commit(_cwd: string, _message: string) {}
  async lastCommitSha(_cwd?: string) {
    return "abc123";
  }
  async hasRemote(_cwd?: string) {
    return false;
  }
  async push(_cwd: string, _remote: string, _branch: string) {}
  async merge(_cwd: string, _source: string, _target: string) {}
  async abortMerge(_cwd: string) {}
}

class BaseBranchRecordingVcs extends StubVcs {
  bases: string[] = [];
  override async ensureBaseBranch(_cwd: string, base: string) {
    this.bases.push(base);
  }
}

class RecordingVcs extends StubVcs {
  patches: string[] = [];
  override async applyPatch(_cwd: string, patch: string) {
    this.patches.push(patch);
    if (!patch.includes("+hello world")) {
      throw new Error("patch missing content");
    }
  }
  override async status() {
    return "";
  }
}

class RejectRecordingVcs extends StubVcs {
  rejectCalls = 0;
  override async applyPatch(_cwd: string, _patch: string) {
    throw new Error("apply failed");
  }
  override async applyPatchWithReject(_cwd: string, _patch: string) {
    this.rejectCalls += 1;
    return { error: "reject failed" };
  }
}

class MergeRecordingVcs extends StubVcs {
  merges: Array<{ source: string; target: string }> = [];
  checkouts: string[] = [];
  dirtyCalls = 0;
  override async merge(_cwd: string, source: string, target: string) {
    this.merges.push({ source, target });
  }
  override async checkoutBranch(_cwd: string, branch: string) {
    this.checkouts.push(branch);
  }
  override async dirtyPaths() {
    this.dirtyCalls += 1;
    if (this.dirtyCalls <= 4) return [];
    return ["tmp.txt"];
  }
}

class MergeConflictVcs extends StubVcs {
  conflicts: string[] = ["server/src/index.ts"];
  abortCalls = 0;
  override async branchExists() {
    return true;
  }
  override async merge() {
    throw new Error("merge conflict");
  }
  override async conflictPaths() {
    return this.conflicts;
  }
  override async abortMerge() {
    this.abortCalls += 1;
  }
}

class PushRecordingVcs extends MergeRecordingVcs {
  pushes: Array<{ remote: string; branch: string }> = [];
  override async hasRemote() {
    return true;
  }
  override async push(_cwd: string, remote: string, branch: string) {
    this.pushes.push({ remote, branch });
  }
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
        storyPoints: 1,
      },
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t02",
        title: "Task B",
        description: "",
        status: "not_started",
        storyPoints: 2,
      },
    ],
    false,
  );
  await writeRunAllScript(dir);
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

const resolveNodeCommand = () => {
  const override = process.env.NODE_BIN?.trim();
  const resolved = override || (process.platform === "win32" ? "node.exe" : "node");
  return resolved.includes(" ") ? `"${resolved}"` : resolved;
};

const writeTestCheckScript = async (dir: string) => {
  const scriptPath = path.join(dir, "test-check.js");
  const contents = [
    "const fs = require(\"node:fs\");",
    "if (!fs.existsSync(\"pass.flag\")) {",
    "  console.error(\"missing pass.flag\");",
    "  process.exit(1);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  await fs.writeFile(scriptPath, contents, "utf8");
  return `${resolveNodeCommand()} ./test-check.js`;
};

const writeRunAllScript = async (dir: string, contents?: string) => {
  const testsDir = path.join(dir, "tests");
  await fs.mkdir(testsDir, { recursive: true });
  const scriptPath = path.join(testsDir, "all.js");
  const script = contents ?? "process.exit(0);\n";
  await fs.writeFile(scriptPath, script, "utf8");
  return scriptPath;
};

const writeNoopTestScript = async (dir: string) => {
  const scriptPath = path.join(dir, "unit-test.js");
  const contents = ["process.exit(0);", ""].join("\n");
  await fs.writeFile(scriptPath, contents, "utf8");
  return `${resolveNodeCommand()} ./unit-test.js`;
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
    routingService: new StubRoutingService() as any,
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
    const tokens = await db.all<{ tokens_prompt: number }[]>("SELECT tokens_prompt FROM token_usage");
    assert.equal(tokens.length, 2);
    const logs = await db.all<{ source: string }[]>("SELECT source FROM task_logs");
    assert.ok(logs.some((l) => l.source === "agent"));
    assert.ok(logs.some((l) => l.source === "finalize"));
    const commandRunRow = await db.get<{ sp_processed: number | null }>(
      "SELECT sp_processed FROM command_runs WHERE id = ?",
      result.commandRunId,
    );
    assert.equal(commandRunRow?.sp_processed, 3);
    const checkpointPath = path.join(workspace.workspaceRoot, ".mcoda", "jobs", result.jobId, "work", "state.json");
    const exists = await fs.stat(checkpointPath).then(() => true, () => false);
    assert.equal(exists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks patches outside workspace", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceOutOfScopePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "scope_violation");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    assert.equal((updated?.metadata as any)?.blocked_reason, "scope_violation");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks invokes agent rating when enabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const ratingService = new StubRatingService();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
    ratingService: ratingService as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      rateAgents: true,
    });
    assert.equal(result.results.length, 2);
    assert.equal(ratingService.calls.length, 2);
    const ratedKeys = ratingService.calls.map((call) => call.taskKey).sort();
    assert.deepEqual(ratedKeys, tasks.map((task) => task.key).sort());
    assert.ok(ratingService.calls.every((call) => call.commandName === "work-on-tasks"));
    assert.ok(ratingService.calls.every((call) => call.agentId === "agent-1"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks handles apply_patch add-file output without leading '+' lines", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoPlus() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((p) => p.includes("+hello world")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks accepts bullet FILE blocks with backticked paths", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceBulletFile() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    const contents = await fs.readFile(path.join(dir, "bullet.txt"), "utf8");
    assert.equal(contents, "bullet content");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks parses JSON patches with surrounding text", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceJsonPreamblePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("+hello world")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks logs docdex scope failures before search", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdexScopeFail() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
      noCommit: true,
    });
    assert.equal(result.results.length, 1);
    const logs = await repo.getDb().all<{ source: string; message: string }[]>(
      "SELECT source, message FROM task_logs",
    );
    assert.ok(logs.some((log) => log.source === "docdex" && log.message.includes("docdex scope missing")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks normalizes absolute patch paths into workspace-relative paths", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceAbsolutePatch() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("+++ b/tests/absolute.txt")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks converts add patches for missing files into new-file patches", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceAddPatchMissingFile() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(vcs.patches.some((patch) => patch.includes("--- /dev/null")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks persists patch artifacts when apply fails", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new RejectRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "patch_failed");
    assert.ok(vcs.rejectCalls >= 1);

    const patchDir = path.join(dir, ".mcoda", "jobs", result.jobId, "work", "patches");
    const entries = await fs.readdir(patchDir);
    assert.ok(entries.length > 0);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks prepends project guidance to agent input", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const guidanceDir = path.join(dir, "docs");
  await fs.mkdir(guidanceDir, { recursive: true });
  const guidancePath = path.join(guidanceDir, "project-guidance.md");
  await fs.writeFile(guidancePath, "GUIDANCE BLOCK", "utf8");
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.ok(agent.lastInput);
    const input = agent.lastInput ?? "";
    const guidanceIndex = input.indexOf("GUIDANCE BLOCK");
    const taskIndex = input.indexOf("Task proj-epic-us-01-t01");
    assert.ok(guidanceIndex >= 0);
    assert.ok(taskIndex > guidanceIndex);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks prompt omits plan instruction in favor of patch-only output", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(!input.includes("Provide a concise plan"));
    assert.ok(input.includes("Output requirements (strict):"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks strips gateway-style prompts from agent profile", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  let lastInput = "";
  const agent = {
    resolveAgent: async () => ({ id: "agent-1", slug: "agent-1", adapter: "local-model", defaultModel: "stub" } as any),
    invoke: async (_id: string, { input }: { input: string }) => {
      lastInput = input;
      const patch = "```patch\n--- a/tmp.txt\n+++ b/tmp.txt\n@@\n-foo\n+bar\n```";
      return { output: patch, adapter: "local-model" };
    },
    getPrompts: async () => ({
      jobPrompt: "You are the gateway agent. Return JSON only.",
      characterPrompt: "Do not include fields outside the schema.",
      commandPrompts: { "work-on-tasks": "Apply patches carefully." },
    }),
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.ok(!lastInput.toLowerCase().includes("gateway agent"));
    assert.ok(!lastInput.toLowerCase().includes("return json only"));
    assert.ok(lastInput.includes("Apply patches carefully."));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks resolves docdex path links via findDocumentByPath", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  await repo.updateTask(tasks[0].id, {
    metadata: { doc_links: ["docdex:docs/sds/project.md"] },
  });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const docdex = new StubDocdexWithLinks();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(docdex.findByPathCalls.includes("docs/sds/project.md"));
    assert.ok(input.includes("[linked:SDS]"));
    assert.ok(input.includes("SDS excerpt"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks downgrades SDS doc types outside docs/sds in doc context", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  await repo.updateTask(tasks[0].id, {
    metadata: { doc_links: ["docdex:docs/architecture.md"] },
  });
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const now = new Date().toISOString();
  const docdex = {
    search: async () => [
      {
        id: "doc-arch",
        docType: "SDS",
        path: "docs/architecture.md",
        title: "Architecture",
        segments: [{ id: "doc-arch-seg-1", docId: "doc-arch", index: 0, content: "Architecture excerpt" }],
        createdAt: now,
        updatedAt: now,
      },
    ],
    findDocumentByPath: async () => ({
      id: "doc-arch-link",
      docType: "SDS",
      path: "docs/architecture.md",
      title: "Architecture",
      segments: [{ id: "doc-arch-link-seg-1", docId: "doc-arch-link", index: 0, content: "Link excerpt" }],
      createdAt: now,
      updatedAt: now,
    }),
    fetchDocumentById: async (id: string) => ({
      id,
      docType: "DOC",
      title: id,
      createdAt: now,
      updatedAt: now,
    }),
    close: async () => {},
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("[DOC] Architecture"));
    assert.ok(input.includes("[linked:DOC] Architecture"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks filters QA and .mcoda docs from doc context", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const docdex = {
    search: async () => [
      {
        id: "doc-qa",
        docType: "DOC",
        path: "docs/qa-workflow.md",
        title: "QA Workflow",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-e2e",
        docType: "DOC",
        path: "docs/e2e-test-issues.md",
        title: "E2E Issues",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-hidden",
        docType: "DOC",
        path: ".mcoda/docs/internal.md",
        title: "Internal Guidance",
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "doc-sds",
        docType: "SDS",
        path: "docs/sds/project.md",
        title: "Project SDS",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    close: async () => {},
  };
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: docdex as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("Project SDS"));
    assert.ok(!input.includes("QA Workflow"));
    assert.ok(!input.includes("E2E Issues"));
    assert.ok(!input.includes("Internal Guidance"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks includes unresolved review/qa comment backlog", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceCapture();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  const now = new Date().toISOString();
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    file: "src/app.ts",
    line: 12,
    body: "Fix null guard in handler",
    metadata: { suggestedFix: "Add early return when value missing" },
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    file: "src/app.ts",
    line: 12,
    body: "Duplicate of review-1",
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "qa-tasks",
    authorType: "agent",
    slug: "qa-1",
    status: "open",
    file: "src/app.ts",
    line: 20,
    body: "QA failed for empty input",
    metadata: { suggestedFix: "Add unit test for empty input" },
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "work-on-tasks",
    authorType: "agent",
    slug: "work-1",
    status: "open",
    body: "Internal work note",
    createdAt: now,
  });
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "resolved-1",
    status: "resolved",
    body: "Resolved note",
    resolvedAt: new Date().toISOString(),
    resolvedBy: "agent-1",
    createdAt: now,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    const input = agent.lastInput ?? "";
    assert.ok(input.includes("Comment backlog:"));
    assert.ok(input.includes("review-1"));
    assert.ok(input.includes("qa-1"));
    assert.ok(!input.includes("work-1"));
    assert.ok(!input.includes("resolved-1"));
    assert.equal((input.match(/review-1/g) ?? []).length, 1);
    assert.ok(input.includes("src/app.ts:12"));
    assert.ok(input.includes("Suggested fix: Add early return when value missing"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks no-change runs when unresolved comments exist", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");
  await repo.createTaskComment({
    taskId: tasks[0].id,
    sourceCommand: "code-review",
    authorType: "agent",
    slug: "review-1",
    status: "open",
    body: "Fix missing guard",
    createdAt: new Date().toISOString(),
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "no_changes");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const backlog = comments.find((comment) => comment.category === "comment_backlog");
    assert.ok(backlog?.body.includes("Open comment slugs: review-1"));
    assert.ok(backlog?.body.includes("Justification:"));
    assert.ok((backlog?.metadata as any)?.justification);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks honors workspace config base branch", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { ...(workspace.config ?? {}), branch: "main" };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new BaseBranchRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: true,
      noCommit: true,
      limit: 1,
    });
    assert.ok(vcs.bases.includes("main"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks defaults base branch to mcoda-dev when config missing", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { ...(workspace.config ?? {}), branch: undefined };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new BaseBranchRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: true,
      noCommit: true,
      limit: 1,
    });
    assert.ok(vcs.bases.includes("mcoda-dev"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks no-change runs without unresolved comments", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "no_changes");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const noChange = comments.find((comment) => comment.category === "no_changes");
    assert.ok(noChange?.body.includes("No changes were applied"));
    assert.ok(noChange?.body.includes("Justification:"));
    assert.ok((noChange?.metadata as any)?.justification);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks overwrites existing files from FILE blocks when enabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  const targetPath = path.join(dir, "existing.txt");
  await fs.writeFile(targetPath, "before", "utf8");

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      allowFileOverwrite: true,
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "succeeded");
    const updated = await fs.readFile(targetPath, "utf8");
    assert.equal(updated.trim(), "no-op");
    const logs = await repo.getDb().all<{ message: string }[]>("SELECT message FROM task_logs");
    assert.ok(logs.some((log) => log.message.includes("Overwriting existing file")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks no-change runs for ready_to_review status", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentServiceNoChange() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });
  await fs.writeFile(path.join(dir, "existing.txt"), "keep", "utf8");
  await repo.updateTask(tasks[0].id, { status: "ready_to_review" });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      statusFilter: ["ready_to_review"],
      limit: 1,
    });
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "no_changes");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    const comments = await repo.listTaskComments(tasks[0].id, { sourceCommands: ["work-on-tasks"] });
    const noChange = comments.find((comment) => comment.category === "no_changes");
    assert.ok(noChange?.body.includes("Justification:"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when agent returns json-only output", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceJsonPlanThenPatch();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.ok(agent.invocations >= 2);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when patch fence lacks diff markers", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceNonPatchFenceThenPatch();
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(agent.invocations, 2);
    assert.ok(agent.inputs[1]?.includes("Output ONLY code changes."));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries failing tests until they pass", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceTestFix();
  const testCommand = await writeTestCheckScript(dir);
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["pass.flag exists"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations >= 2);
    assert.equal(result.results[0]?.status, "succeeded");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_review");
    const passExists = await fs.stat(path.join(dir, "pass.flag")).then(
      () => true,
      () => false,
    );
    assert.equal(passExists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks creates run-all tests script when missing", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const testCommand = await writeNoopTestScript(dir);
  await fs.rm(path.join(dir, "tests", "all.js"), { force: true });
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["unit-test.js"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");

    const scriptPath = path.join(dir, "tests", "all.js");
    const exists = await fs.stat(scriptPath).then(
      () => true,
      () => false,
    );
    assert.equal(exists, true);
    const contents = await fs.readFile(scriptPath, "utf8");
    assert.ok(contents.includes("unit-test.js"));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks prefers nested package test command", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const nestedRoot = path.join(dir, "packages", "app");
  await fs.mkdir(path.join(nestedRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(nestedRoot, "src", "index.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(nestedRoot, "test-pass.js"), "process.exit(0);\n", "utf8");
  await fs.writeFile(
    path.join(nestedRoot, "package.json"),
    JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        scripts: { test: "node ./test-pass.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      files: ["packages/app/src/index.ts"],
      test_requirements: {
        unit: ["nested package tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");

    const updated = await repo.getTaskByKey(tasks[0].key);
    const testCommands = (updated?.metadata as any)?.test_commands ?? [];
    assert.ok(testCommands.some((command: string) => command.includes("packages/app")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks retries when run-all tests fail", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceRunAllFix();
  await writeRunAllScript(
    dir,
    [
      "const fs = require(\"node:fs\");",
      "if (!fs.existsSync(\"global.pass\")) {",
      "  console.error(\"missing global.pass\");",
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations >= 2);
    assert.equal(result.results[0]?.status, "succeeded");
    const globalPassExists = await fs.stat(path.join(dir, "global.pass")).then(
      () => true,
      () => false,
    );
    assert.equal(globalPassExists, true);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips package-manager test commands when no package.json", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceRunAllOnce();
  await writeRunAllScript(
    dir,
    [
      "const fs = require(\"node:fs\");",
      "if (!fs.existsSync(\"global.pass\")) {",
      "  console.error(\"missing global.pass\");",
      "  process.exit(1);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: ["npm test"],
      test_requirements: {
        unit: ["password utility tests"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(agent.invocations, 1);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks tasks when tests keep failing", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const agent = new StubAgentServiceAlwaysFail();
  const testCommand = await writeTestCheckScript(dir);
  await repo.updateTask(tasks[0].id, {
    metadata: {
      tests: [testCommand],
      test_requirements: {
        unit: ["pass.flag exists"],
        component: [],
        integration: [],
        api: [],
      },
    },
  });
  const service = new WorkOnTasksService(workspace, {
    agentService: agent as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: new StubVcs() as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.ok(agent.invocations > 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "tests_failed");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    assert.equal((updated?.metadata as any)?.blocked_reason, "tests_failed");
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks blocks task when merge conflicts are detected", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new MergeConflictVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      noCommit: true,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "failed");
    assert.equal(result.results[0]?.notes, "merge_conflict");
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "blocked");
    assert.equal((updated?.metadata as any)?.blocked_reason, "merge_conflict");
    assert.equal(vcs.abortCalls, 1);
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips auto-merge when file scope missing and config enabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  workspace.config = { restrictAutoMergeWithoutScope: true };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  await repo.updateTask(tasks[0].id, { metadata: {} });
  const vcs = new MergeRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.status, "succeeded");
    assert.equal(vcs.merges.length, 0);
    const updated = await repo.getTaskByKey(tasks[0].key);
    assert.equal(updated?.status, "ready_to_review");
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-merge skipped")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips auto-merge when autoMerge disabled", async () => {
  const { dir, workspace, repo, tasks } = await setupWorkspace();
  workspace.config = { autoMerge: false };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new MergeRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(vcs.merges.length, 0);
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-merge disabled")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});

test("workOnTasks skips auto-push when autoPush disabled", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  workspace.config = { autoPush: false };
  const jobService = new JobService(workspace.workspaceRoot, repo);
  const selectionService = new TaskSelectionService(workspace, repo);
  const stateService = new TaskStateService(repo);
  const vcs = new PushRecordingVcs();
  const service = new WorkOnTasksService(workspace, {
    agentService: new StubAgentService() as any,
    docdex: new StubDocdex() as any,
    jobService,
    workspaceRepo: repo,
    selectionService,
    stateService,
    repo: new StubRepo() as any,
    routingService: new StubRoutingService() as any,
    vcsClient: vcs as any,
  });

  try {
    const result = await service.workOnTasks({
      workspace,
      projectKey: "proj",
      agentStream: false,
      dryRun: false,
      limit: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(vcs.pushes.length, 0);
    const db = repo.getDb();
    const logs = await db.all<{ message: string | null }[]>("SELECT message FROM task_logs WHERE source = 'vcs'");
    assert.ok(logs.some((log) => (log.message ?? "").includes("Auto-push disabled")));
  } finally {
    await service.close();
    await cleanupWorkspace(dir, repo);
  }
});
