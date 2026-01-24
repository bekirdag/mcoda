import path from "node:path";
import { WorkOnTasksService, WorkspaceResolver } from "@mcoda/core";
import { WORK_ALLOWED_STATUSES, filterTaskStatuses } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  limit?: number;
  parallel?: number;
  noCommit: boolean;
  dryRun: boolean;
  agentName?: string;
  agentStream?: boolean;
  rateAgents: boolean;
  autoMerge?: boolean;
  autoPush?: boolean;
  json: boolean;
}

const usage = `mcoda work-on-tasks \\
  [--workspace <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \\
  [--status not_started,in_progress,changes_requested] \\
  [--limit N] \\
  [--parallel N] \\
  [--no-commit] \\
  [--dry-run] \\
  [--agent <NAME>] \\
  [--agent-stream <true|false>] \\
  [--rate-agents] \\
  [--auto-merge <true|false>] \\
  [--auto-push <true|false>] \\
  [--no-auto-merge] \\
  [--no-auto-push] \\
  [--json]`;

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

export const parseWorkOnTasksArgs = (argv: string[]): ParsedArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  const taskKeys: string[] = [];
  const statusFilter: string[] = [];
  let limit: number | undefined;
  let parallel: number | undefined;
  let noCommit = false;
  let dryRun = false;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let rateAgents = false;
  let autoMerge: boolean | undefined;
  let autoPush: boolean | undefined;
  let json = false;

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
    if (arg.startsWith("--auto-merge=")) {
      const [, raw] = arg.split("=", 2);
      autoMerge = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--auto-push=")) {
      const [, raw] = arg.split("=", 2);
      autoPush = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
      case "--project-key":
        projectKey = argv[i + 1];
        i += 1;
        break;
      case "--status":
        statusFilter.push(...parseCsv(argv[i + 1]));
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
      case "--limit":
        limit = Number(argv[i + 1]);
        i += 1;
        break;
      case "--parallel":
        parallel = Number(argv[i + 1]);
        i += 1;
        break;
      case "--no-commit":
        noCommit = true;
        break;
      case "--dry-run":
        dryRun = true;
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
      case "--auto-merge": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          autoMerge = parseBooleanFlag(next, true);
          i += 1;
        } else {
          autoMerge = true;
        }
        break;
      }
      case "--auto-push": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          autoPush = parseBooleanFlag(next, true);
          i += 1;
        } else {
          autoPush = true;
        }
        break;
      }
      case "--no-auto-merge":
        autoMerge = false;
        break;
      case "--no-auto-push":
        autoPush = false;
        break;
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
      case "--json":
        json = true;
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

  const { filtered } = filterTaskStatuses(
    statusFilter.length ? statusFilter : undefined,
    WORK_ALLOWED_STATUSES,
    WORK_ALLOWED_STATUSES,
  );
  statusFilter.splice(0, statusFilter.length, ...filtered);

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys,
    statusFilter,
    limit: Number.isFinite(limit) ? limit : undefined,
    parallel: Number.isFinite(parallel) ? parallel : undefined,
    noCommit,
    dryRun,
    agentName,
    agentStream: agentStream ?? false,
    rateAgents,
    autoMerge,
    autoPush,
    json,
  };
};

export class WorkOnTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseWorkOnTasksArgs(argv);
    if (parsed.agentStream === false) {
      process.env.MCODA_STREAM_IO = "0";
      process.env.MCODA_STREAM_IO_PROMPT = "0";
    }
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    if (!parsed.projectKey) {
      // eslint-disable-next-line no-console
      console.error("work-on-tasks requires --project <PROJECT_KEY>");
      process.exitCode = 1;
      return;
    }
    const service = await WorkOnTasksService.create(workspace);
    try {
      const streamSink = (chunk: string) => {
        const target = parsed.json ? process.stderr : process.stdout;
        target.write(chunk);
      };
      const onAgentChunk = parsed.agentStream !== false ? streamSink : undefined;
      const result = await service.workOnTasks({
        workspace,
        projectKey: parsed.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        limit: parsed.limit,
        parallel: parsed.parallel,
        noCommit: parsed.noCommit,
        dryRun: parsed.dryRun,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        autoMerge: parsed.autoMerge,
        autoPush: parsed.autoPush,
        onAgentChunk,
      });

      const success = result.results.filter((r) => r.status === "succeeded").length;
      const failed = result.results.filter((r) => r.status === "failed").length;
      const skipped = result.results.filter((r) => r.status === "skipped").length;
      if (failed > 0) {
        process.exitCode = 1;
      }

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              jobId: result.jobId,
              commandRunId: result.commandRunId,
              processed: result.results.length,
              succeeded: success,
              failed,
              skipped,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      const summary = [
        `Job: ${result.jobId}, Command Run: ${result.commandRunId}`,
        `Tasks processed: ${result.results.length} (succeeded=${success}, failed=${failed}, skipped=${skipped})`,
      ]
        .filter(Boolean)
        .join("\n");

      // eslint-disable-next-line no-console
      console.log(summary);
      if (result.warnings.length) {
        // eslint-disable-next-line no-console
        console.warn(result.warnings.map((w) => `! ${w}`).join("\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`work-on-tasks failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
