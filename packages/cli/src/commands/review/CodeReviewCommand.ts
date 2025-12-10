import path from "node:path";
import { CodeReviewService, WorkspaceResolver } from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  baseRef?: string;
  dryRun: boolean;
  resumeJobId?: string;
  limit?: number;
  agentName?: string;
  agentStream?: boolean;
  json: boolean;
}

const usage = `mcoda code-review \\
  [--workspace-root <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \\
  [--status ready_to_review] \\
  [--base <BRANCH>] \\
  [--dry-run] \\
  [--resume <JOB_ID>] \\
  [--limit N] \\
  [--agent <NAME>] \\
  [--agent-stream <true|false>] \\
  [--json]

Runs AI code review on task branches. Side effects: writes task_comments/task_reviews, may spawn follow-up tasks for critical findings, updates task state (unless --dry-run), records jobs/command_runs/task_runs/token_usage, saves diffs/context under .mcoda/jobs/<job_id>/review/. Default status filter: ready_to_review. JSON output: { job, tasks, errors, warnings }.`;

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

export const parseCodeReviewArgs = (argv: string[]): ParsedArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  const taskKeys: string[] = [];
  const statusFilter: string[] = [];
  let baseRef: string | undefined;
  let dryRun = false;
  let resumeJobId: string | undefined;
  let limit: number | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
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
      case "--base":
        baseRef = argv[i + 1];
        i += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--resume":
        resumeJobId = argv[i + 1];
        i += 1;
        break;
      case "--limit":
        limit = Number(argv[i + 1]);
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

  if (statusFilter.length === 0) {
    statusFilter.push("ready_to_review");
  }

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys,
    statusFilter,
    baseRef,
    dryRun,
    resumeJobId,
    limit: Number.isFinite(limit) ? limit : undefined,
    agentName,
    agentStream: agentStream ?? true,
    json,
  };
};

export class CodeReviewCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseCodeReviewArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const service = await CodeReviewService.create(workspace);
    try {
      const result = await service.reviewTasks({
        workspace,
        projectKey: parsed.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        baseRef: parsed.baseRef,
        dryRun: parsed.dryRun,
        resumeJobId: parsed.resumeJobId,
        limit: parsed.limit,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
      });

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              job: { id: result.jobId, commandRunId: result.commandRunId },
              tasks: result.tasks.map((t) => ({
                taskId: t.taskId,
                taskKey: t.taskKey,
                decision: t.decision,
                statusBefore: t.statusBefore,
                statusAfter: t.statusAfter,
                findings: t.findings,
                error: t.error,
                followupTasks: t.followupTasks,
              })),
              errors: result.tasks.filter((t) => t.error).map((t) => ({ taskId: t.taskId, taskKey: t.taskKey, error: t.error })),
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      const lines = result.tasks.map((t) => {
        const decision = t.decision ?? "error";
        const severityCounts = (t.findings ?? []).reduce<Record<string, number>>((acc, f) => {
          const sev = (f.severity ?? "unknown").toUpperCase();
          acc[sev] = (acc[sev] ?? 0) + 1;
          return acc;
        }, {});
        const severitySummary = Object.entries(severityCounts)
          .map(([s, c]) => `${s}:${c}`)
          .join(" ");
        const findingsCount = t.findings?.length ?? 0;
        const followups = t.followupTasks && t.followupTasks.length ? `, followups=[${t.followupTasks.map((f) => f.taskKey).join(", ")}]` : "";
        const statusChange = t.statusAfter ? `${t.statusBefore} -> ${t.statusAfter}` : t.statusBefore;
        return `${t.taskKey}: ${decision} (${statusChange}), findings=${findingsCount}${severitySummary ? ` (${severitySummary})` : ""}${
          t.error ? `, error=${t.error}` : ""
        }${followups}`;
      });
      const summary = [
        `Job: ${result.jobId}`,
        `Artifacts: ${path.join(workspace.mcodaDir, "jobs", result.jobId, "review")}`,
        ...lines,
      ];
      if (result.warnings.length) {
        summary.push(`Warnings: ${result.warnings.join("; ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(summary.join("\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`code-review failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
