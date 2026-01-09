import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayTrioService } from "../GatewayTrioService.js";
import { JobService } from "../../jobs/JobService.js";

type TaskStatusStore = {
  get: (key: string) => string | undefined;
  set: (key: string, status: string) => void;
};

const makeStatusStore = (initial: Record<string, string>): TaskStatusStore => {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key),
    set: (key, status) => map.set(key, status),
  };
};

const makeWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-trio-"));
  return {
    dir,
    workspace: { workspaceRoot: dir, workspaceId: "ws-1" },
  };
};

type SelectionSnapshot = {
  ordered: string[];
  blocked?: string[];
  warnings?: string[];
};

const buildTask = (key: string, statusStore: TaskStatusStore) => ({
  id: `task-${key}`,
  projectId: "proj-1",
  epicId: "epic-1",
  userStoryId: "story-1",
  key,
  title: key,
  description: "",
  type: "feature",
  status: statusStore.get(key) ?? "in_progress",
  storyPoints: 1,
  priority: 1,
  assignedAgentId: undefined,
  assigneeHuman: undefined,
  vcsBranch: undefined,
  vcsBaseBranch: undefined,
  vcsLastCommitSha: undefined,
  metadata: undefined,
  openapiVersionAtCreation: undefined,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  epicKey: "EPIC",
  storyKey: "STORY",
  epicTitle: "Epic",
  storyTitle: "Story",
  storyDescription: undefined,
  acceptanceCriteria: [],
});

const buildSelection = (
  orderedKeys: string[],
  blockedKeys: string[] | undefined,
  warnings: string[] | undefined,
  statusStore: TaskStatusStore,
) => {
  const blockedSet = new Set(blockedKeys ?? []);
  const ordered = orderedKeys
    .filter((key) => !blockedSet.has(key))
    .map((key) => ({
      task: buildTask(key, statusStore),
      dependencies: { ids: [], keys: [], blocking: [] },
      blockedReason: undefined,
    }));
  const blocked = (blockedKeys ?? []).map((key) => ({
    task: buildTask(key, statusStore),
    dependencies: { ids: ["dep-1"], keys: ["DEP-1"], blocking: ["dep-1"] },
    blockedReason: "dependency_not_ready",
  }));
  return {
    project: undefined,
    filters: { effectiveStatuses: [] },
    ordered,
    blocked,
    warnings: warnings ?? [],
  };
};

const makeService = async (options: {
  statusStore: TaskStatusStore;
  selectionKeys: string[];
  blockedKeys?: string[];
  workOutcome?: "succeeded" | "failed";
  reviewSequence?: Array<"approve" | "changes_requested" | "block">;
  qaSequence?: Array<"pass" | "fix_required" | "infra_issue">;
  selectionSequence?: SelectionSnapshot[];
}) => {
  const { dir, workspace } = await makeWorkspace();
  const statusStore = options.statusStore;
  let selectionIndex = 0;
  const selectionService = {
    selectTasks: async () => {
      const entry = options.selectionSequence?.length
        ? options.selectionSequence[Math.min(selectionIndex, options.selectionSequence.length - 1)]
        : { ordered: options.selectionKeys, blocked: options.blockedKeys };
      selectionIndex += 1;
      return buildSelection(entry.ordered, entry.blocked, entry.warnings, statusStore) as any;
    },
    close: async () => {},
  };

  const gatewayService = {
    run: async (req: any) => ({
      commandRunId: `gw-${req.job}`,
      job: req.job,
      gatewayAgent: { id: "gw", slug: "gateway" },
      tasks: [],
      docdex: [],
      analysis: {
        summary: "Summary",
        reasoningSummary: "Reason",
        currentState: "Current",
        todo: "Todo",
        understanding: "Understanding",
        plan: ["Step"],
        complexity: 3,
        discipline: "backend",
        filesLikelyTouched: ["src/file.ts"],
        filesToCreate: [],
        assumptions: [],
        risks: [],
        docdexNotes: [],
      },
      chosenAgent: { agentId: "agent-1", agentSlug: "agent-1", rationale: "Fit" },
      warnings: [],
    }),
    close: async () => {},
  };

  let reviewIndex = 0;
  let qaIndex = 0;

  const workService = {
    workOnTasks: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      if (!dryRun) {
        const next = options.workOutcome === "failed" ? "in_progress" : "ready_to_review";
        statusStore.set(key, next);
      }
      return {
        jobId: "work-job",
        commandRunId: "work-run",
        selection: { ordered: [], blocked: [], warnings: [], filters: { effectiveStatuses: [] } },
        results: [{ taskKey: key, status: options.workOutcome ?? "succeeded" }],
        warnings: [],
      };
    },
    close: async () => {},
  };

  const reviewService = {
    reviewTasks: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      const decision = options.reviewSequence?.[reviewIndex] ?? "approve";
      reviewIndex += 1;
      if (!dryRun) {
        const next = decision === "approve" ? "ready_to_qa" : decision === "block" ? "blocked" : "in_progress";
        statusStore.set(key, next);
      }
      return {
        jobId: "review-job",
        commandRunId: "review-run",
        tasks: [{ taskId: `task-${key}`, taskKey: key, statusBefore: "in_progress", decision, findings: [] }],
        warnings: [],
      };
    },
    close: async () => {},
  };

  const qaService = {
    run: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      const outcome = options.qaSequence?.[qaIndex] ?? "pass";
      qaIndex += 1;
      if (!dryRun) {
        const next = outcome === "pass" ? "completed" : outcome === "infra_issue" ? "blocked" : "in_progress";
        statusStore.set(key, next);
      }
      return {
        jobId: "qa-job",
        commandRunId: "qa-run",
        selection: { ordered: [], blocked: [], warnings: [], filters: { effectiveStatuses: [] } },
        results: [{ taskKey: key, outcome }],
        warnings: [],
      };
    },
    close: async () => {},
  };

  const workspaceRepo = {
    getTaskByKey: async (key: string) => ({
      id: `task-${key}`,
      projectId: "proj-1",
      epicId: "epic-1",
      userStoryId: "story-1",
      key,
      title: key,
      description: "",
      type: "feature",
      status: statusStore.get(key) ?? "in_progress",
      storyPoints: 1,
      priority: 1,
      assignedAgentId: undefined,
      assigneeHuman: undefined,
      vcsBranch: undefined,
      vcsBaseBranch: undefined,
      vcsLastCommitSha: undefined,
      metadata: undefined,
      openapiVersionAtCreation: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    getProjectById: async () => ({
      id: "proj-1",
      key: "PROJ",
      name: "Project",
      description: undefined,
      metadata: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    close: async () => {},
  };

  const jobService = new JobService(workspace);

  const service = new (GatewayTrioService as any)(workspace, {
    workspaceRepo,
    jobService,
    gatewayService,
    workService,
    reviewService,
    qaService,
    selectionService,
  });

  return { service, dir };
};

test("GatewayTrioService completes work-review-qa successfully", async () => {
  const statusStore = makeStatusStore({ "TASK-1": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-1"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[0].attempts, 1);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService loops on review changes_requested", async () => {
  const statusStore = makeStatusStore({ "TASK-2": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-2"],
    reviewSequence: ["changes_requested", "approve"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxIterations: 3 });
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[0].attempts, 2);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService loops on QA fix_required", async () => {
  const statusStore = makeStatusStore({ "TASK-3": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-3"],
    qaSequence: ["fix_required", "pass"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxIterations: 3 });
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[0].attempts, 2);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService stops on QA infra_issue", async () => {
  const statusStore = makeStatusStore({ "TASK-4": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-4"],
    qaSequence: ["infra_issue"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    assert.equal(result.tasks[0].status, "blocked");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService fails after max iterations", async () => {
  const statusStore = makeStatusStore({ "TASK-5": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-5"],
    workOutcome: "failed",
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxIterations: 2 });
    assert.equal(result.tasks[0].status, "failed");
    assert.equal(result.tasks[0].attempts, 2);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService skips dependency-blocked tasks unless explicit", async () => {
  const statusStore = makeStatusStore({ "TASK-6": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-6"],
    blockedKeys: ["TASK-6"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    assert.equal(result.tasks[0].status, "skipped");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService picks up new tasks on later cycles", async () => {
  const statusStore = makeStatusStore({ "TASK-9": "in_progress", "TASK-10": "not_started" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [
      { ordered: ["TASK-9"] },
      { ordered: ["TASK-9", "TASK-10"] },
    ],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 2 });
    const summary = Object.fromEntries(
      (result.tasks as Array<{ taskKey: string; status: string; attempts: number }>).map((task) => [task.taskKey, task]),
    );
    assert.equal(summary["TASK-9"]?.status, "completed");
    assert.equal(summary["TASK-10"]?.status, "completed");
    assert.equal(summary["TASK-10"]?.attempts, 1);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService retries blocked tasks when dependencies clear", async () => {
  const statusStore = makeStatusStore({ "TASK-11": "in_progress", "TASK-12": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [
      { ordered: ["TASK-12"], blocked: ["TASK-11"] },
      { ordered: ["TASK-11"] },
    ],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 2 });
    const summary = Object.fromEntries(
      (result.tasks as Array<{ taskKey: string; status: string; attempts: number }>).map((task) => [task.taskKey, task]),
    );
    assert.equal(summary["TASK-11"]?.status, "completed");
    assert.equal(summary["TASK-11"]?.attempts, 1);
    assert.equal(summary["TASK-12"]?.status, "completed");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService stops when no tasks are attempted in a cycle", async () => {
  const statusStore = makeStatusStore({});
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [{ ordered: [] }],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 3 });
    assert.equal(result.tasks.length, 0);
    assert.ok((result.warnings as string[]).some((warning) => warning.includes("No tasks attempted in this cycle")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService resumes a partial job from saved state", async () => {
  const statusStore = makeStatusStore({ "TASK-7": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-7"],
    reviewSequence: ["changes_requested", "approve"],
  });
  try {
    const first = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    assert.equal(first.tasks[0].status, "pending");
    const resumed = await service.run({
      workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
      resumeJobId: first.jobId,
      maxCycles: 3,
    });
    assert.equal(resumed.jobId, first.jobId);
    assert.equal(resumed.tasks[0].status, "completed");
    assert.equal(resumed.tasks[0].attempts, 2);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService rejects resume when manifest command mismatches", async () => {
  const statusStore = makeStatusStore({ "TASK-8": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-8"],
    reviewSequence: ["changes_requested"],
  });
  try {
    const first = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    const manifestPath = path.join(dir, ".mcoda", "jobs", first.jobId, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.commandName = "not-gateway-trio";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await assert.rejects(
      () =>
        service.run({
          workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
          resumeJobId: first.jobId,
        }),
      /manifest command .* does not match job command/i,
    );
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
