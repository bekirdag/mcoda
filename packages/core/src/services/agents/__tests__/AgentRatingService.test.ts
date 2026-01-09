import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Connection, GlobalMigrations, GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { AgentRatingService } from "../AgentRatingService.js";

test("AgentRatingService records run rating and updates agent fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-rating-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);

  const globalDbPath = path.join(os.tmpdir(), `mcoda-global-${Date.now()}-${Math.random()}.db`);
  const conn = await Connection.open(globalDbPath);
  await GlobalMigrations.run(conn.db);
  const globalRepo = new GlobalRepository(conn.db, conn);

  const worker = await globalRepo.createAgent({ slug: "worker", adapter: "codex-cli", rating: 6, costPerMillion: 10 });
  const reviewer = await globalRepo.createAgent({ slug: "reviewer", adapter: "codex-cli" });

  const project = await workspaceRepo.createProjectIfMissing({ key: "proj", name: "Project" });
  const [epic] = await workspaceRepo.insertEpics(
    [{ projectId: project.id, key: "proj-epic", title: "Epic", description: "", priority: 1 }],
    false,
  );
  const [story] = await workspaceRepo.insertStories(
    [{ projectId: project.id, epicId: epic.id, key: "proj-epic-us-01", title: "Story", description: "" }],
    false,
  );
  const [task] = await workspaceRepo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "Demo",
        status: "in_progress",
      },
    ],
    false,
  );

  const job = await workspaceRepo.createJob({
    workspaceId: workspace.workspaceId,
    type: "work",
    state: "running",
    commandName: "work-on-tasks",
  });
  const commandRun = await workspaceRepo.createCommandRun({
    workspaceId: workspace.workspaceId,
    commandName: "work-on-tasks",
    jobId: job.id,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  await workspaceRepo.recordTokenUsage({
    workspaceId: workspace.workspaceId,
    agentId: worker.id,
    commandRunId: commandRun.id,
    taskId: task.id,
    tokensPrompt: 500,
    tokensCompletion: 500,
    tokensTotal: 1000,
    durationSeconds: 12,
    timestamp: new Date().toISOString(),
    metadata: { commandName: "work-on-tasks", action: "agent" },
  });

  const ratingService = new AgentRatingService(workspace, {
    workspaceRepo,
    globalRepo,
    agentService: {
      resolveAgent: async (idOrSlug: string) =>
        ((await globalRepo.getAgentById(idOrSlug)) ?? (await globalRepo.getAgentBySlug(idOrSlug))) as any,
      invoke: async () => ({ output: '{"quality_score":8.5,"reasoning":"ok"}' }),
    } as any,
    routingService: {
      resolveAgentForCommand: async () => ({ agent: reviewer }),
    } as any,
  });

  try {
    await ratingService.rate({
      workspace,
      agentId: worker.id,
      commandName: "work-on-tasks",
      jobId: job.id,
      commandRunId: commandRun.id,
      taskId: task.id,
      taskKey: task.key,
      discipline: "backend",
      complexity: 6,
      reviewerAgentName: reviewer.slug,
    });

    const updated = await globalRepo.getAgentById(worker.id);
    assert.ok(updated?.ratingSamples && updated.ratingSamples >= 1);
    assert.ok(updated?.ratingLastScore !== undefined);
    assert.ok(updated?.maxComplexity);

    const ratings = await globalRepo.listAgentRunRatings(worker.id, 5);
    assert.equal(ratings.length, 1);
    assert.equal(ratings[0]?.taskKey, task.key);
  } finally {
    await ratingService.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(globalDbPath, { force: true });
  }
});
