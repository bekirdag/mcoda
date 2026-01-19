import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayTrioService } from "../GatewayTrioService.js";
import { JobService } from "../../jobs/JobService.js";
import { PathHelper } from "@mcoda/shared";

let tempHome: string | undefined;
let originalHome: string | undefined;
let originalProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalProfile = process.env.USERPROFILE;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-home-"));
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

type DocdexCheckFn = (options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<any>;

type TaskStatusStore = {
  get: (key: string) => string | undefined;
  set: (key: string, status: string) => void;
};

type TaskMetadataStore = {
  get: (key: string) => Record<string, unknown> | undefined;
  set: (key: string, metadata: Record<string, unknown> | undefined) => void;
};

type DependencyMap = Record<string, string[]>;

const makeStatusStore = (initial: Record<string, string>): TaskStatusStore => {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key),
    set: (key, status) => map.set(key, status),
  };
};

const makeMetadataStore = (initial: Record<string, Record<string, unknown>> = {}): TaskMetadataStore => {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key),
    set: (key, metadata) => {
      if (!metadata) {
        map.delete(key);
        return;
      }
      map.set(key, metadata);
    },
  };
};

const makeWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-trio-"));
  return {
    dir,
    workspace: {
      workspaceRoot: dir,
      workspaceId: "ws-1",
      mcodaDir: PathHelper.getWorkspaceDir(dir),
      workspaceDbPath: PathHelper.getWorkspaceDbPath(dir),
      globalDbPath: PathHelper.getGlobalDbPath(),
      legacyWorkspaceIds: [],
      id: "ws-1",
    },
  };
};

type SelectionSnapshot = {
  ordered: string[];
  blocked?: string[];
  warnings?: string[];
};

const buildTask = (key: string, statusStore: TaskStatusStore, metadataStore?: TaskMetadataStore) => ({
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
  metadata: metadataStore?.get(key),
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
  metadataStore?: TaskMetadataStore,
) => {
  const blockedSet = new Set(blockedKeys ?? []);
  const ordered = orderedKeys
    .filter((key) => !blockedSet.has(key))
    .map((key) => ({
      task: buildTask(key, statusStore, metadataStore),
      dependencies: { ids: [], keys: [], blocking: [] },
      blockedReason: undefined,
    }));
  const blocked = (blockedKeys ?? []).map((key) => ({
    task: buildTask(key, statusStore, metadataStore),
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
  metadataStore?: TaskMetadataStore;
  dependencyMap?: DependencyMap;
  selectionKeys: string[];
  blockedKeys?: string[];
  workOutcome?: "succeeded" | "failed";
  workSequence?: Array<"succeeded" | "failed">;
  workNotesSequence?: Array<string | undefined>;
  workCalls?: string[];
  stepCalls?: string[];
  reviewSequence?: Array<"approve" | "changes_requested" | "block" | "info_only">;
  reviewErrorSequence?: Array<string | undefined>;
  qaSequence?: Array<"pass" | "fix_required" | "infra_issue">;
  selectionSequence?: SelectionSnapshot[];
  gatewayRequests?: any[];
  gatewayAnalysisOverride?: Record<string, unknown>;
  gatewayDocdex?: any[];
  commentCalls?: Array<any>;
  cleanupExpiredLocks?: string[];
  jobStatusUpdates?: Array<{ state: string; payload: Record<string, unknown> }>;
  recordTokenUsage?: boolean;
  tokenUsageOverride?: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number };
  docdexCheck?: DocdexCheckFn;
}) => {
  const { dir, workspace } = await makeWorkspace();
  const jobService = new JobService(workspace);
  const statusStore = options.statusStore;
  const metadataStore = options.metadataStore;
  const dependencyMap = options.dependencyMap ?? {};
  let selectionIndex = 0;
  const recordTokens = async (commandName: string, jobId: string, commandRunId: string) => {
    if (options.recordTokenUsage === false) return;
    const tokensPrompt = options.tokenUsageOverride?.tokensPrompt ?? 5;
    const tokensCompletion = options.tokenUsageOverride?.tokensCompletion ?? 5;
    const tokensTotal =
      options.tokenUsageOverride?.tokensTotal ?? tokensPrompt + tokensCompletion;
    const tokenPath = path.join(workspace.mcodaDir, "token_usage.json");
    const entry = {
      workspaceId: workspace.workspaceId,
      commandName,
      jobId,
      commandRunId,
      tokensPrompt,
      tokensCompletion,
      tokensTotal,
      timestamp: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    try {
      const raw = await fs.readFile(tokenPath, "utf8");
      const parsed = JSON.parse(raw);
      const existing = Array.isArray(parsed) ? parsed : [];
      existing.push(entry);
      await fs.writeFile(tokenPath, JSON.stringify(existing, null, 2), "utf8");
    } catch {
      await fs.writeFile(tokenPath, JSON.stringify([entry], null, 2), "utf8");
    }
  };
  const selectionService = {
    selectTasks: async (filters?: { taskKeys?: string[]; limit?: number }) => {
      const entry = options.selectionSequence?.length
        ? options.selectionSequence[Math.min(selectionIndex, options.selectionSequence.length - 1)]
        : { ordered: options.selectionKeys, blocked: options.blockedKeys };
      selectionIndex += 1;
      const filterSet = filters?.taskKeys?.length ? new Set(filters.taskKeys) : undefined;
      let ordered = entry.ordered;
      let blocked = entry.blocked ?? [];
      if (filterSet) {
        ordered = ordered.filter((key) => filterSet.has(key));
        blocked = blocked.filter((key) => filterSet.has(key));
      }
      if (typeof filters?.limit === "number" && filters.limit > 0) {
        ordered = ordered.slice(0, filters.limit);
      }
      return buildSelection(ordered, blocked, entry.warnings, statusStore, metadataStore) as any;
    },
    close: async () => {},
  };

  const gatewayService = {
    run: async (req: any) => {
      if (options.gatewayRequests) {
        options.gatewayRequests.push(req);
      }
      const analysis = {
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
        ...(options.gatewayAnalysisOverride ?? {}),
      };
      return {
      commandRunId: `gw-${req.job}`,
      job: req.job,
      gatewayAgent: { id: "gw", slug: "gateway" },
      tasks: [],
      docdex: options.gatewayDocdex ?? [],
      analysis,
      chosenAgent: { agentId: "agent-1", agentSlug: "agent-1", rationale: "Fit" },
      warnings: [],
    };
    },
    close: async () => {},
    setDocdexAvailability: () => {},
  };

  const routingService = {
    resolveAgentForCommand: async () => ({
      agent: { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub" },
      agentSlug: "agent-1",
      source: "workspace_default",
    }),
    close: async () => {},
  };

  let reviewIndex = 0;
  let qaIndex = 0;
  let workIndex = 0;

  const workService = {
    workOnTasks: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      if (options.workCalls) options.workCalls.push(key);
      if (options.stepCalls) options.stepCalls.push("work");
      const sequence = options.workSequence ?? (options.workOutcome ? [options.workOutcome] : ["succeeded"]);
      const outcome = sequence[Math.min(workIndex, sequence.length - 1)];
      const notes =
        options.workNotesSequence?.[Math.min(workIndex, options.workNotesSequence.length - 1)];
      workIndex += 1;
      if (!dryRun) {
        const next = outcome === "failed" ? "in_progress" : "ready_to_review";
        statusStore.set(key, next);
      }
      await recordTokens("work-on-tasks", "work-job", "work-run");
      return {
        jobId: "work-job",
        commandRunId: "work-run",
        selection: { ordered: [], blocked: [], warnings: [], filters: { effectiveStatuses: [] } },
        results: [{ taskKey: key, status: outcome, notes }],
        warnings: [],
      };
    },
    close: async () => {},
    setDocdexAvailability: () => {},
  };

  const reviewService = {
    reviewTasks: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      const error = options.reviewErrorSequence?.[reviewIndex];
      const decision = options.reviewSequence?.[reviewIndex] ?? "approve";
      reviewIndex += 1;
      if (options.stepCalls) options.stepCalls.push("review");
      if (!dryRun && !error) {
        const next =
          decision === "approve" || decision === "info_only"
            ? "ready_to_qa"
            : decision === "block"
              ? "blocked"
              : "in_progress";
        statusStore.set(key, next);
      }
      await recordTokens("code-review", "review-job", "review-run");
      return {
        jobId: "review-job",
        commandRunId: "review-run",
        tasks: [
          { taskId: `task-${key}`, taskKey: key, statusBefore: "in_progress", decision, error, findings: [] },
        ],
        warnings: [],
      };
    },
    close: async () => {},
    setDocdexAvailability: () => {},
  };

  const qaService = {
    run: async ({ taskKeys, dryRun }: any) => {
      const key = taskKeys[0];
      const outcome = options.qaSequence?.[qaIndex] ?? "pass";
      qaIndex += 1;
      if (options.stepCalls) options.stepCalls.push("qa");
      if (!dryRun) {
        const next = outcome === "pass" ? "completed" : outcome === "infra_issue" ? "blocked" : "in_progress";
        statusStore.set(key, next);
      }
      await recordTokens("qa-tasks", "qa-job", "qa-run");
      return {
        jobId: "qa-job",
        commandRunId: "qa-run",
        selection: { ordered: [], blocked: [], warnings: [], filters: { effectiveStatuses: [] } },
        results: [{ taskKey: key, outcome }],
        warnings: [],
      };
    },
    close: async () => {},
    setDocdexAvailability: () => {},
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
      metadata: metadataStore?.get(key),
      openapiVersionAtCreation: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    getTaskDependencies: async (taskIds: string[]) => {
      const rows: Array<{
        id: string;
        taskId: string;
        dependsOnTaskId: string;
        relationType: string;
        createdAt: string;
        updatedAt: string;
      }> = [];
      for (const taskId of taskIds) {
        const key = taskId.replace("task-", "");
        const deps = dependencyMap[key] ?? [];
        for (const depKey of deps) {
          rows.push({
            id: `dep-${key}-${depKey}`,
            taskId,
            dependsOnTaskId: `task-${depKey}`,
            relationType: "blocks",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return rows;
    },
    getTasksByIds: async (taskIds: string[]) =>
      taskIds.map((id) => {
        const key = id.replace("task-", "");
        return {
          id,
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
          metadata: metadataStore?.get(key),
          openapiVersionAtCreation: undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
    updateTask: async (taskId: string, updates: { status?: string; metadata?: Record<string, unknown> | null }) => {
      const key = taskId.replace("task-", "");
      if (updates.status) statusStore.set(key, updates.status);
      if (updates.metadata !== undefined) {
        metadataStore?.set(key, updates.metadata ?? undefined);
      }
    },
    createTaskComment: async (record: any) => {
      options.commentCalls?.push(record);
      return { ...record, id: `comment-${options.commentCalls?.length ?? 1}`, status: record.status ?? "open" };
    },
    getProjectById: async () => ({
      id: "proj-1",
      key: "PROJ",
      name: "Project",
      description: undefined,
      metadata: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    cleanupExpiredTaskLocks: async () => options.cleanupExpiredLocks ?? [],
    close: async () => {},
  };

  if (options.jobStatusUpdates) {
    const originalUpdate = jobService.updateJobStatus.bind(jobService);
    jobService.updateJobStatus = async (jobId: string, state: any, payload: any) => {
      options.jobStatusUpdates?.push({ state, payload });
      return originalUpdate(jobId, state, payload);
    };
  }

  const service = new (GatewayTrioService as any)(workspace, {
    workspaceRepo,
    jobService,
    gatewayService,
    routingService,
    workService,
    reviewService,
    qaService,
    selectionService,
    docdexCheck: options.docdexCheck ?? (async () => ({ success: true, checks: [] })),
  });

  return { service, dir, workspace, jobService };
};

test("GatewayTrioService completes work-review-qa successfully", async () => {
  const statusStore = makeStatusStore({ "TASK-1": "in_progress" });
  const { service, dir, jobService } = await makeService({
    statusStore,
    selectionKeys: ["TASK-1"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[0].attempts, 1);
    const job = await jobService.getJob(result.jobId);
    assert.equal((job?.payload as any)?.maxIterations, undefined);
    assert.equal((job?.payload as any)?.maxCycles, undefined);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService skips work when task is ready_to_review", async () => {
  const statusStore = makeStatusStore({ "TASK-R": "ready_to_review" });
  const stepCalls: string[] = [];
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-R"],
    stepCalls,
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    assert.equal(result.tasks[0].status, "completed");
    assert.deepEqual(stepCalls, ["review", "qa"]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService skips work and review when task is ready_to_qa", async () => {
  const statusStore = makeStatusStore({ "TASK-QA": "ready_to_qa" });
  const stepCalls: string[] = [];
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-QA"],
    stepCalls,
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    assert.equal(result.tasks[0].status, "completed");
    assert.deepEqual(stepCalls, ["qa"]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService records docdex preflight failures", async () => {
  const statusStore = makeStatusStore({ "TASK-DOCDEX": "in_progress" });
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-DOCDEX"],
    docdexCheck: async () => ({
      success: false,
      checks: [{ name: "bind", status: "error", message: "bind blocked" }],
    }),
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 1 });
    assert.ok(result.warnings.some((warning: string) => warning.includes("Docdex unavailable")));
    const artifactPath = path.join(workspace.mcodaDir, "jobs", result.jobId, "gateway-trio", "docdex", "docdex-check.json");
    await fs.access(artifactPath);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService uses gateway planning for review and QA steps", async () => {
  const statusStore = makeStatusStore({ "TASK-1": "in_progress" });
  const gatewayRequests: any[] = [];
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-1"],
    gatewayRequests,
  });
  try {
    await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    const jobs = gatewayRequests.map((req) => req.job);
    assert.deepEqual(jobs, ["work-on-tasks", "code-review", "qa-tasks"]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService treats review info_only as success", async () => {
  const statusStore = makeStatusStore({ "TASK-1A": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-1A"],
    reviewSequence: ["info_only"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[0].lastDecision, "info_only");
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

test("GatewayTrioService advances processedItems after failed attempts", async () => {
  const statusStore = makeStatusStore({ "TASK-5A": "in_progress" });
  const jobStatusUpdates: Array<{ state: string; payload: Record<string, unknown> }> = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-5A"],
    workOutcome: "failed",
    jobStatusUpdates,
  });
  try {
    await service.run({ workspace, maxIterations: 1, maxCycles: 1 });
    const processedUpdates = jobStatusUpdates
      .map((entry) => entry.payload.processedItems)
      .filter((value) => typeof value === "number") as number[];
    assert.ok(processedUpdates.some((value) => value >= 1));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService updates job_state_detail with heartbeat context", async () => {
  const statusStore = makeStatusStore({ "TASK-HB": "in_progress" });
  const jobStatusUpdates: Array<{ state: string; payload: Record<string, unknown> }> = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-HB"],
    jobStatusUpdates,
  });
  try {
    await service.run({ workspace, maxIterations: 1, maxCycles: 1 });
    const details = jobStatusUpdates
      .map((entry) => entry.payload.job_state_detail)
      .filter((value): value is string => typeof value === "string");
    assert.ok(details.some((detail) => detail.includes("task:TASK-HB") && detail.includes("step:work")));
    assert.ok(details.some((detail) => detail.includes("last:")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService sets totalItems once tasks are selected", async () => {
  const statusStore = makeStatusStore({ "TASK-TOTAL": "in_progress" });
  const jobStatusUpdates: Array<{ state: string; payload: Record<string, unknown> }> = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-TOTAL"],
    jobStatusUpdates,
  });
  try {
    await service.run({ workspace, maxIterations: 1, maxCycles: 1 });
    const totals = jobStatusUpdates
      .map((entry) => entry.payload.totalItems)
      .filter((value): value is number => typeof value === "number");
    assert.ok(totals.length > 0);
    assert.ok(totals[0] > 0);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService retries tests_failed once before blocking", async () => {
  const statusStore = makeStatusStore({ "TASK-TF": "in_progress" });
  const gatewayRequests: any[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-TF"],
    workSequence: ["failed", "failed"],
    workNotesSequence: ["tests_failed", "tests_failed"],
    reviewSequence: ["approve"],
    qaSequence: ["pass"],
    gatewayRequests,
  });
  try {
    const result = await service.run({ workspace, maxIterations: 3, maxCycles: 3 });
    assert.equal(result.tasks[0].status, "blocked");
    assert.equal(result.tasks[0].attempts, 2);
    const workCalls = gatewayRequests.filter((req) => req.job === "work-on-tasks");
    assert.ok(workCalls.length >= 2);
    assert.deepEqual(workCalls[1].avoidAgents, ["agent-1"]);
    assert.equal(workCalls[1].forceStronger, true);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService skips [RUN] pseudo tasks", async () => {
  const statusStore = makeStatusStore({ "[RUN]TASK-1": "in_progress" });
  const workCalls: string[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["[RUN]TASK-1"],
    workCalls,
  });
  try {
    const result = await service.run({ workspace, maxCycles: 1 });
    assert.equal(workCalls.length, 0);
    assert.equal(result.tasks[0]?.status, "skipped");
    assert.ok(result.warnings.some((warning: string) => warning.includes("pseudo task")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService retries zero-token work once before failing", async () => {
  const statusStore = makeStatusStore({ "TASK-ZERO": "in_progress" });
  const workCalls: string[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-ZERO"],
    workCalls,
    tokenUsageOverride: { tokensPrompt: 0, tokensCompletion: 0, tokensTotal: 0 },
  });
  try {
    const result = await service.run({ workspace, maxIterations: 2, maxCycles: 2 });
    assert.equal(workCalls.length, 2);
    assert.equal(result.tasks[0].status, "failed");
    assert.equal(result.tasks[0].lastError, "zero_tokens");
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
  const workCalls: string[] = [];
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [
      { ordered: ["TASK-9"] },
      { ordered: ["TASK-9", "TASK-10"] },
    ],
    workCalls,
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 2 });
    const summary = Object.fromEntries(
      (result.tasks as Array<{ taskKey: string; status: string; attempts: number }>).map((task) => [task.taskKey, task]),
    );
    assert.equal(summary["TASK-9"]?.status, "completed");
    assert.equal(summary["TASK-10"]?.status, "completed");
    assert.equal(summary["TASK-10"]?.attempts, 1);
    assert.equal(workCalls.filter((key) => key === "TASK-9").length, 1);
    assert.equal(workCalls.filter((key) => key === "TASK-10").length, 1);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService respects limit across cycles", async () => {
  const statusStore = makeStatusStore({
    "TASK-L1": "in_progress",
    "TASK-L2": "in_progress",
    "TASK-L3": "in_progress",
    "TASK-L4": "in_progress",
  });
  const workCalls: string[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [{ ordered: ["TASK-L1", "TASK-L2", "TASK-L3", "TASK-L4"] }],
    workCalls,
  });
  try {
    const result = await service.run({ workspace, maxCycles: 2, limit: 3 });
    const keys = result.tasks.map((task: { taskKey: string }) => task.taskKey);
    assert.deepEqual(keys.sort(), ["TASK-L1", "TASK-L2", "TASK-L3"].sort());
    assert.equal(workCalls.length, 3);
    assert.ok(!workCalls.includes("TASK-L4"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService blocks when gateway lacks file paths and docdex context", async () => {
  const statusStore = makeStatusStore({ "TASK-NOCTX": "in_progress" });
  const metadataStore = makeMetadataStore();
  const commentCalls: Array<Record<string, unknown>> = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    metadataStore,
    selectionKeys: ["TASK-NOCTX"],
    gatewayAnalysisOverride: { filesLikelyTouched: [], filesToCreate: [], assumptions: [], docdexNotes: [] },
    gatewayDocdex: [],
    commentCalls,
  });
  try {
    const result = await service.run({ workspace, maxCycles: 1, maxIterations: 1 });
    const summary = result.tasks.find((task: { taskKey: string }) => task.taskKey === "TASK-NOCTX");
    assert.equal(summary?.status, "blocked");
    assert.equal(summary?.lastError, "missing_context");
    assert.equal(statusStore.get("TASK-NOCTX"), "blocked");
    assert.equal((metadataStore.get("TASK-NOCTX") as any)?.blocked_reason, "missing_context");
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].sourceCommand, "gateway-trio");
    assert.ok(String(commentCalls[0].body).includes("no file paths"));
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

test("GatewayTrioService reopens retryable blocked tasks", async () => {
  const statusStore = makeStatusStore({ "TASK-13": "blocked" });
  const metadataStore = makeMetadataStore({ "TASK-13": { blocked_reason: "patch_failed" } });
  const { service, dir } = await makeService({
    statusStore,
    metadataStore,
    selectionKeys: [],
    selectionSequence: [{ ordered: [] }, { ordered: ["TASK-13"] }],
  });
  try {
    const result = await service.run({
      workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
      taskKeys: ["TASK-13"],
      maxCycles: 2,
    });
    const summary = result.tasks.find((task: { taskKey: string }) => task.taskKey === "TASK-13");
    assert.equal(summary?.status, "completed");
    assert.equal(statusStore.get("TASK-13"), "completed");
    assert.equal((metadataStore.get("TASK-13") as any)?.blocked_reason, undefined);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService reopens dependency-blocked tasks only when deps complete", async () => {
  const statusStore = makeStatusStore({ "TASK-20": "blocked", "TASK-21": "completed", "TASK-30": "blocked", "TASK-31": "in_progress" });
  const metadataStore = makeMetadataStore({
    "TASK-20": { blocked_reason: "dependency_not_ready" },
    "TASK-30": { blocked_reason: "dependency_not_ready" },
  });
  const { service, dir } = await makeService({
    statusStore,
    metadataStore,
    dependencyMap: {
      "TASK-20": ["TASK-21"],
      "TASK-30": ["TASK-31"],
    },
    selectionKeys: [],
  });
  try {
    const state: any = {
      schema_version: 1,
      job_id: "job-1",
      command_run_id: "run-1",
      cycle: 0,
      tasks: {
        "TASK-20": { taskKey: "TASK-20", attempts: 0, status: "blocked", chosenAgents: {} },
        "TASK-30": { taskKey: "TASK-30", attempts: 0, status: "blocked", chosenAgents: {} },
      },
    };
    const warnings: string[] = [];
    await (service as any).reopenRetryableBlockedTasks(state, new Set(["TASK-20", "TASK-30"]), 3, warnings);
    assert.equal(statusStore.get("TASK-20"), "in_progress");
    assert.equal((metadataStore.get("TASK-20") as any)?.blocked_reason, undefined);
    assert.equal(statusStore.get("TASK-30"), "blocked");
    assert.equal((metadataStore.get("TASK-30") as any)?.blocked_reason, "dependency_not_ready");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService does not reopen tasks completed in DB", async () => {
  const statusStore = makeStatusStore({ "TASK-DONE": "completed" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
  });
  try {
    const state: any = {
      schema_version: 1,
      job_id: "job-3",
      command_run_id: "run-3",
      cycle: 0,
      tasks: {
        "TASK-DONE": { taskKey: "TASK-DONE", attempts: 1, status: "failed", chosenAgents: {} },
      },
    };
    const warnings: string[] = [];
    await (service as any).reopenRetryableBlockedTasks(state, new Set(["TASK-DONE"]), 3, warnings);
    assert.equal(state.tasks["TASK-DONE"].status, "completed");
    assert.equal(state.tasks["TASK-DONE"].lastError, "completed_in_db");
    assert.ok(warnings.some((warning) => warning.includes("TASK-DONE") && warning.includes("completed")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService reopens failed tasks when max iterations increases", async () => {
  const statusStore = makeStatusStore({ "TASK-40": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
  });
  try {
    const state: any = {
      schema_version: 1,
      job_id: "job-2",
      command_run_id: "run-2",
      cycle: 0,
      tasks: {
        "TASK-40": { taskKey: "TASK-40", attempts: 2, status: "failed", chosenAgents: {} },
      },
    };
    const warnings: string[] = [];
    await (service as any).reopenRetryableBlockedTasks(state, new Set(["TASK-40"]), 5, warnings);
    assert.equal(state.tasks["TASK-40"].status, "pending");
    assert.equal(statusStore.get("TASK-40"), "in_progress");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService marks max-iteration tasks as failed when reopening", async () => {
  const statusStore = makeStatusStore({ "TASK-MAX": "blocked" });
  const metadataStore = makeMetadataStore({ "TASK-MAX": { blocked_reason: "tests_failed" } });
  const { service, dir } = await makeService({
    statusStore,
    metadataStore,
    selectionKeys: [],
  });
  try {
    const state: any = {
      schema_version: 1,
      job_id: "job-4",
      command_run_id: "run-4",
      cycle: 0,
      tasks: {
        "TASK-MAX": { taskKey: "TASK-MAX", attempts: 2, status: "failed", chosenAgents: {} },
      },
    };
    const warnings: string[] = [];
    await (service as any).reopenRetryableBlockedTasks(state, new Set(["TASK-MAX"]), 2, warnings);
    assert.equal(state.tasks["TASK-MAX"].status, "failed");
    assert.equal(state.tasks["TASK-MAX"].lastError, "max_iterations_reached");
    assert.ok(warnings.some((warning) => warning.includes("TASK-MAX") && warning.includes("max iterations")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService reports expired task lock cleanup", async () => {
  const statusStore = makeStatusStore({ "TASK-LOCK": "in_progress" });
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: ["TASK-LOCK"],
    cleanupExpiredLocks: ["TASK-LOCK"],
  });
  try {
    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any });
    const warnings = result.warnings as string[];
    assert.ok(warnings.some((warning: string) => warning.includes("Cleared 1 expired task lock")));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService avoids failing agents on retryable errors", async () => {
  const statusStore = makeStatusStore({ "T1": "in_progress" });
  const gatewayRequests: any[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["T1"],
    workSequence: ["failed", "succeeded"],
    workNotesSequence: ["missing_patch", undefined],
    reviewSequence: ["approve"],
    qaSequence: ["pass"],
    gatewayRequests,
  });

  try {
    await service.run({
      workspace,
      projectKey: "proj-1",
      maxIterations: 2,
      maxCycles: 2,
      agentStream: false,
    });

    const workCalls = gatewayRequests.filter((req) => req.job === "work-on-tasks");
    assert.ok(workCalls.length >= 2);
    assert.deepEqual(workCalls[1].avoidAgents, ["agent-1"]);
    assert.equal(workCalls[1].forceStronger, true);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService escalates reviewer after invalid JSON output", async () => {
  const statusStore = makeStatusStore({ "TASK-RJ": "in_progress" });
  const gatewayRequests: any[] = [];
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-RJ"],
    workSequence: ["succeeded", "succeeded"],
    reviewSequence: ["block", "approve"],
    reviewErrorSequence: ["review_invalid_output", undefined],
    qaSequence: ["pass"],
    gatewayRequests,
  });

  try {
    await service.run({
      workspace,
      projectKey: "proj-1",
      maxIterations: 2,
      maxCycles: 2,
      agentStream: false,
    });

    const reviewCalls = gatewayRequests.filter((req) => req.job === "code-review");
    assert.ok(reviewCalls.length >= 2);
    const escalated = reviewCalls[reviewCalls.length - 1];
    assert.deepEqual(escalated.avoidAgents, ["agent-1"]);
    assert.equal(escalated.forceStronger, true);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayTrioService prioritizes feedback tasks within a cycle", async () => {
  const statusStore = makeStatusStore({ "TASK-A": "in_progress", "TASK-B": "in_progress" });
  const workCalls: string[] = [];
  const { service, dir } = await makeService({
    statusStore,
    selectionKeys: [],
    selectionSequence: [
      { ordered: ["TASK-A"] },
      { ordered: ["TASK-B", "TASK-A"] },
    ],
    reviewSequence: ["changes_requested", "approve", "approve"],
    qaSequence: ["pass", "pass"],
    workCalls,
  });
  try {
    await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, maxCycles: 2, maxIterations: 3 });
    assert.deepEqual(workCalls, ["TASK-A", "TASK-A", "TASK-B"]);
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
    const first = await service.run({
      workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
      maxCycles: 1,
      maxIterations: 1,
    });
    assert.equal(first.tasks[0].status, "failed");
    const resumed = await service.run({
      workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
      resumeJobId: first.jobId,
      maxCycles: 3,
      maxIterations: 3,
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
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-8"],
    reviewSequence: ["changes_requested"],
  });
  try {
    const first = await service.run({
      workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any,
      maxCycles: 1,
      maxIterations: 1,
    });
    const manifestPath = path.join(workspace.mcodaDir, "jobs", first.jobId, "manifest.json");
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

test("GatewayTrioService records rating summaries when enabled", async () => {
  const statusStore = makeStatusStore({ "TASK-13": "in_progress" });
  const { service, dir, workspace } = await makeService({
    statusStore,
    selectionKeys: ["TASK-13"],
  });
  try {
    const jobRoot = path.join(workspace.mcodaDir, "jobs");
    await fs.mkdir(path.join(jobRoot, "work-job"), { recursive: true });
    await fs.mkdir(path.join(jobRoot, "review-job"), { recursive: true });
    await fs.mkdir(path.join(jobRoot, "qa-job"), { recursive: true });
    const ratingPayload = { rating: 7.2, maxComplexity: 6, runScore: 7.1, qualityScore: 8 };
    await fs.writeFile(path.join(jobRoot, "work-job", "rating.json"), JSON.stringify(ratingPayload));
    await fs.writeFile(path.join(jobRoot, "review-job", "rating.json"), JSON.stringify({ ...ratingPayload, rating: 6.4 }));
    await fs.writeFile(path.join(jobRoot, "qa-job", "rating.json"), JSON.stringify({ ...ratingPayload, rating: 8.1 }));

    const result = await service.run({ workspace: { workspaceRoot: dir, workspaceId: "ws-1" } as any, rateAgents: true });
    const ratings = result.tasks[0].ratings ?? [];
    assert.equal(ratings.length, 3);
    assert.ok(ratings.some((entry: { step?: string; agent?: string }) => entry.step === "work" && entry.agent === "agent-1"));
    assert.ok(
      ratings.some((entry: { step?: string; agent?: string }) => entry.step === "review" && entry.agent === "agent-1"),
    );
    assert.ok(ratings.some((entry: { step?: string; agent?: string }) => entry.step === "qa" && entry.agent === "agent-1"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
