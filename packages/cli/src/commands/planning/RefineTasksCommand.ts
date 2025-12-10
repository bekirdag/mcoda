import path from "node:path";
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
  fromDb: boolean;
  dryRun: boolean;
  json: boolean;
  planIn?: string;
  planOut?: string;
  jobId?: string;
}

const usage = `mcoda refine-tasks --project <PROJECT_KEY> [--workspace-root <PATH>] [--epic <EPIC_KEY>] [--story <STORY_KEY>] [--task <TASK_KEY> ...] [--status <STATUS>] [--max-tasks N] [--strategy split|merge|enrich|estimate|auto] [--agent <NAME>] [--agent-stream [true|false]] [--from-db [true|false]] [--dry-run] [--plan-in <PATH>] [--plan-out <PATH>] [--json]`;

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
  let fromDb: boolean | undefined;
  let dryRun = false;
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
    if (arg.startsWith("--from-db=")) {
      const [, raw] = arg.split("=", 2);
      fromDb = parseBooleanFlag(raw, true);
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
    agentStream: agentStream ?? true,
    fromDb: fromDb ?? true,
    dryRun,
    json,
    planIn,
    planOut,
    jobId,
  };
};

export class RefineTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseRefineTasksArgs(argv);
    if (!parsed.projectKey) {
      // eslint-disable-next-line no-console
      console.error("refine-tasks requires --project <PROJECT_KEY>");
      process.exitCode = 1;
      return;
    }
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const service = await RefineTasksService.create(workspace);
    try {
      const result = await service.refineTasks({
        workspace,
        projectKey: parsed.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter.length ? parsed.statusFilter : undefined,
        maxTasks: parsed.maxTasks,
        strategy: parsed.strategy ?? "auto",
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        fromDb: parsed.fromDb,
        dryRun: parsed.dryRun,
        planInPath: parsed.planIn,
        planOutPath: parsed.planOut,
        jobId: parsed.jobId,
        outputJson: parsed.json,
      });

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              status: result.applied ? "applied" : "dry_run",
              summary: result.summary,
              plan: result.plan,
              warnings: result.plan.warnings ?? [],
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
      await service.close();
    }
  }
}
