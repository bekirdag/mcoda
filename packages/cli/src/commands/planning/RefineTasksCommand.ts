import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { RefineTasksService, WorkspaceResolver } from "@mcoda/core";
import type { RefineStrategy } from "@mcoda/shared";

interface ParsedRefineArgs {
  workspaceRoot?: string;
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  maxTasks?: number;
  strategy?: RefineStrategy;
  agentName?: string;
  agentStream: boolean;
  rateAgents: boolean;
  fromDb: boolean;
  dryRun: boolean;
  apply: boolean;
  resume: boolean;
  runAll: boolean;
  batchSize?: number;
  maxBatches?: number;
  json: boolean;
  planIn?: string;
  planOut?: string;
  jobId?: string;
}

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

const usage = `mcoda refine-tasks [--project <PROJECT_KEY>] [--workspace-root <PATH>] [--epic <EPIC_KEY>] [--story <STORY_KEY>] [--task <TASK_KEY> ...] [--status <STATUS>] [--max-tasks N] [--strategy split|merge|enrich|estimate|auto] [--agent <NAME>] [--agent-stream [true|false]] [--rate-agents] [--from-db [true|false]] [--dry-run] [--apply] [--resume|--skip-refined] [--run-all] [--batch-size N] [--max-batches N] [--plan-in <PATH>] [--plan-out <PATH>] [--json]`;

const listWorkspaceProjects = async (workspaceRoot: string): Promise<ProjectKeyCandidate[]> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const rows = await repo
      .getDb()
      .all<{ key: string; created_at?: string | null }[]>(
        `SELECT key, created_at FROM projects ORDER BY created_at ASC, key ASC`,
      );
    return rows
      .map((row) => ({ key: String(row.key), createdAt: row.created_at ?? null }))
      .filter((row) => row.key.trim().length > 0);
  } catch {
    return [];
  } finally {
    await repo.close();
  }
};

export const pickRefineTasksProjectKey = (options: {
  requestedKey?: string;
  configuredKey?: string;
  existing: ProjectKeyCandidate[];
}): { projectKey?: string; warnings: string[] } => {
  const warnings: string[] = [];
  const requestedKey = options.requestedKey?.trim() || undefined;
  const configuredKey = options.configuredKey?.trim() || undefined;
  const existing = options.existing ?? [];
  const firstExisting = existing[0]?.key;

  if (requestedKey) {
    if (configuredKey && configuredKey !== requestedKey) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; overriding configured project key "${configuredKey}".`,
      );
    }
    if (firstExisting && requestedKey !== firstExisting) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; first workspace project is "${firstExisting}".`,
      );
    }
    return { projectKey: requestedKey, warnings };
  }

  if (configuredKey) {
    if (firstExisting && configuredKey !== firstExisting) {
      warnings.push(`Using configured project key "${configuredKey}" instead of first workspace project "${firstExisting}".`);
    }
    return { projectKey: configuredKey, warnings };
  }

  if (firstExisting) {
    warnings.push(`No --project provided; defaulting to first workspace project "${firstExisting}".`);
    return { projectKey: firstExisting, warnings };
  }

  return { projectKey: undefined, warnings };
};

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

const parseCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
};

const formatCounts = (ops: any[]): string => {
  const counts = ops.reduce<Record<string, number>>((acc, op) => {
    acc[op.op] = (acc[op.op] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([op, count]) => `${op}: ${count}`)
    .join(", ");
};

export const parseRefineTasksArgs = (argv: string[]): ParsedRefineArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  const taskKeys: string[] = [];
  const statusFilter: string[] = [];
  let maxTasks: number | undefined;
  let strategy: RefineStrategy | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let rateAgents = false;
  let fromDb: boolean | undefined;
  let dryRun = false;
  let apply = false;
  let resume = false;
  let runAll = false;
  let batchSize: number | undefined;
  let maxBatches: number | undefined;
  let json = false;
  let planIn: string | undefined;
  let planOut: string | undefined;
  let jobId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--status=")) {
      const [, raw] = arg.split("=", 2);
      statusFilter.push(...parseCsv(raw));
      continue;
    }
    if (arg.startsWith("--task=")) {
      const [, raw] = arg.split("=", 2);
      if (raw) taskKeys.push(raw);
      continue;
    }
    if (arg.startsWith("--agent-stream=")) {
      const [, raw] = arg.split("=", 2);
      agentStream = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--from-db=")) {
      const [, raw] = arg.split("=", 2);
      fromDb = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--apply=")) {
      const [, raw] = arg.split("=", 2);
      apply = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const [, raw] = arg.split("=", 2);
      resume = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--skip-refined=")) {
      const [, raw] = arg.split("=", 2);
      resume = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--run-all=")) {
      const [, raw] = arg.split("=", 2);
      runAll = parseBooleanFlag(raw, true);
      continue;
    }
    switch (arg) {
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
      case "--project-key":
        projectKey = argv[i + 1];
        i += 1;
        break;
      case "--epic":
        epicKey = argv[i + 1];
        i += 1;
        break;
      case "--story":
        storyKey = argv[i + 1];
        i += 1;
        break;
      case "--task":
        if (argv[i + 1]) {
          taskKeys.push(argv[i + 1]);
          i += 1;
        }
        break;
      case "--status":
        statusFilter.push(...parseCsv(argv[i + 1]));
        i += 1;
        break;
      case "--max-tasks":
        maxTasks = Number(argv[i + 1]);
        i += 1;
        break;
      case "--strategy":
        strategy = argv[i + 1] as RefineStrategy;
        i += 1;
        break;
      case "--agent":
        agentName = argv[i + 1];
        i += 1;
        break;
      case "--agent-stream": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          agentStream = parseBooleanFlag(next, true);
          i += 1;
        } else {
          agentStream = true;
        }
        break;
      }
      case "--rate-agents": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          rateAgents = parseBooleanFlag(next, true);
          i += 1;
        } else {
          rateAgents = true;
        }
        break;
      }
      case "--from-db": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          fromDb = parseBooleanFlag(next, true);
          i += 1;
        } else {
          fromDb = true;
        }
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--apply":
        apply = true;
        break;
      case "--resume":
      case "--skip-refined":
        resume = true;
        break;
      case "--run-all":
        runAll = true;
        break;
      case "--batch-size":
        batchSize = Number(argv[i + 1]);
        i += 1;
        break;
      case "--max-batches":
        maxBatches = Number(argv[i + 1]);
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "--plan-in":
        planIn = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--plan-out":
        planOut = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--job-id":
        jobId = argv[i + 1];
        i += 1;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(usage);
        process.exit(0);
        break;
      default:
        break;
    }
  }
  for (let i = statusFilter.length - 1; i >= 0; i -= 1) {
    if (statusFilter[i]?.toLowerCase() === "blocked") {
      statusFilter.splice(i, 1);
    }
  }

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys,
    statusFilter,
    maxTasks: Number.isFinite(maxTasks) ? maxTasks : undefined,
    strategy,
    agentName,
    agentStream: agentStream ?? false,
    rateAgents,
    fromDb: fromDb ?? true,
    dryRun,
    apply,
    resume,
    runAll,
    batchSize: Number.isFinite(batchSize) ? batchSize : undefined,
    maxBatches: Number.isFinite(maxBatches) ? maxBatches : undefined,
    json,
    planIn,
    planOut,
    jobId,
  };
};

export class RefineTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseRefineTasksArgs(argv);
    if (parsed.apply && parsed.dryRun) {
      // eslint-disable-next-line no-console
      console.error("refine-tasks: --apply cannot be used with --dry-run");
      process.exitCode = 1;
      return;
    }
    if ((parsed.runAll || parsed.resume) && !parsed.apply) {
      // eslint-disable-next-line no-console
      console.error("refine-tasks: --run-all/--resume requires --apply (needed for durable progress tracking)");
      process.exitCode = 1;
      return;
    }
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectResolution = pickRefineTasksProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      existing: existingProjects,
    });
    const commandWarnings = [...projectResolution.warnings];
    if (!projectResolution.projectKey) {
      // eslint-disable-next-line no-console
      console.error(
        "refine-tasks could not resolve a project key. Provide --project <PROJECT_KEY> or create tasks for this workspace first.",
      );
      process.exitCode = 1;
      return;
    }
    if (commandWarnings.length > 0 && !parsed.json) {
      // eslint-disable-next-line no-console
      console.warn(commandWarnings.map((warning) => `! ${warning}`).join("\n"));
    }
    const service = await RefineTasksService.create(workspace);
    try {
      const baseRequest = {
        workspace,
        projectKey: projectResolution.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter.length ? parsed.statusFilter : undefined,
        strategy: parsed.strategy ?? "auto",
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        fromDb: parsed.fromDb,
        dryRun: parsed.dryRun,
        planInPath: parsed.planIn,
        planOutPath: parsed.planOut,
        jobId: parsed.jobId,
        apply: parsed.apply,
        excludeAlreadyRefined: parsed.runAll || parsed.resume,
        allowEmptySelection: parsed.runAll || parsed.resume,
      } as const;

      if (parsed.runAll) {
        const batchSize = parsed.batchSize ?? parsed.maxTasks ?? 250;
        const maxBatches = parsed.maxBatches ?? Number.POSITIVE_INFINITY;
        const batches: Array<{
          batch: number;
          jobId: string;
          commandRunId: string;
          tasksProcessed: number;
          tasksAffected: number;
          operations: number;
        }> = [];
        let totalProcessed = 0;
        let totalAffected = 0;

        for (let batch = 1; batch <= maxBatches; batch += 1) {
          const result = await service.refineTasks({
            ...baseRequest,
            maxTasks: batchSize,
          });
          const tasksProcessed = result.summary?.tasksProcessed ?? 0;
          const tasksAffected = result.summary?.tasksAffected ?? 0;
          const operations = result.plan.operations.length;

          if (tasksProcessed === 0 || operations === 0) break;

          totalProcessed += tasksProcessed;
          totalAffected += tasksAffected;
          batches.push({
            batch,
            jobId: result.jobId,
            commandRunId: result.commandRunId,
            tasksProcessed,
            tasksAffected,
            operations,
          });

          if (!parsed.json) {
            // eslint-disable-next-line no-console
            console.log(
              `Batch ${batch}: Job ${result.jobId}, Command Run ${result.commandRunId}\n` +
                `Processed: ${tasksProcessed}, affected: ${tasksAffected}, operations: ${operations}`,
            );
          }
        }

        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              { status: "completed", totalProcessed, totalAffected, batches, warnings: commandWarnings },
              null,
              2,
            ),
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(`Done. Total processed: ${totalProcessed}, total affected: ${totalAffected}`);
        }
        return;
      }

      const result = await service.refineTasks({
        ...baseRequest,
        maxTasks: parsed.maxTasks,
      });

      if (parsed.json) {
        const warnings = [...commandWarnings, ...(result.plan.warnings ?? [])];
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              status: result.applied ? "applied" : "dry_run",
              summary: result.summary,
              plan: result.plan,
              warnings,
            },
            null,
            2,
          ),
        );
      } else {
        const opSummary = formatCounts(result.plan.operations);
        const summaryLines = [
          `Job: ${result.jobId}, Command Run: ${result.commandRunId}`,
          `Applied: ${result.applied ? "yes" : "no (dry run)"}`,
          `Operations: ${result.plan.operations.length}${opSummary ? ` (${opSummary})` : ""}`,
          result.summary
            ? `Tasks processed: ${result.summary.tasksProcessed}, affected: ${result.summary.tasksAffected}, story points delta: ${result.summary.storyPointsDelta ?? 0}`
            : undefined,
          result.createdTasks?.length ? `Created: ${result.createdTasks.join(", ")}` : undefined,
          result.updatedTasks?.length ? `Updated: ${result.updatedTasks.join(", ")}` : undefined,
          result.cancelledTasks?.length ? `Cancelled: ${result.cancelledTasks.join(", ")}` : undefined,
        ].filter(Boolean);
        // eslint-disable-next-line no-console
        console.log(summaryLines.join("\n"));
        if (result.plan.warnings && result.plan.warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(result.plan.warnings.map((w) => `! ${w}`).join("\n"));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`refine-tasks failed: ${message}`);
      process.exitCode = 1;
    } finally {
      try {
        await service.close();
      } catch {
        // ignore close-time errors (e.g., db already closed)
      }
    }
  }
}
