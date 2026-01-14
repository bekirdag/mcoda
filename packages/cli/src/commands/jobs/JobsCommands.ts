import path from "node:path";
import { JobInsightsService, JobResumeService, JobService, TelemetryService, TokenUsageRow, WorkspaceResolver, WorkspaceResolution } from "@mcoda/core";
import { DocsCommands } from "../docs/DocsCommands.js";

type JobSubcommand = "list" | "status" | "watch" | "logs" | "inspect" | "resume" | "cancel" | "tokens";

export interface ParsedJobArgs {
  subcommand: JobSubcommand;
  jobId?: string;
  workspaceRoot?: string;
  project?: string;
  status?: string;
  type?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  intervalSeconds?: number;
  noLogs?: boolean;
  follow?: boolean;
  agent?: string;
  noTelemetry?: boolean;
  force?: boolean;
}

const usage = `mcoda job <list|status|watch|logs|inspect|resume|cancel|tokens> ...

Commands:
  mcoda job list [--project <KEY>] [--status <STATE>] [--type <TYPE>] [--since <DURATION|TIMESTAMP>] [--limit <N>] [--json]
  mcoda job status <JOB_ID> [--json]
  mcoda job watch <JOB_ID> [--interval <SECONDS>] [--no-logs]
  mcoda job logs <JOB_ID> [--since <TIMESTAMP|DURATION>] [--follow]
  mcoda job inspect <JOB_ID> [--json]
  mcoda job resume <JOB_ID> [--agent <NAME>] [--no-telemetry]
  mcoda job cancel <JOB_ID> [--force]
  mcoda job tokens <JOB_ID> [--since <TIMESTAMP|DURATION>] [--format table|json]

Flags:
  --workspace-root <PATH>    Override workspace root (defaults to cwd)
  --project <KEY>            Filter jobs by project key (when available in payload)
  --status <STATE>           Filter by job state (queued|running|checkpointing|paused|completed|failed|cancelled)
  --type <TYPE>              Filter by job type (task_creation|task_refinement|work|review|qa|pdr_generate|sds_generate|openapi_change|other)
  --since <DURATION|TS>      Time filter (e.g. 1h, 24h, 2025-01-01T00:00:00Z)
  --limit <N>                Max rows for list (default 50)
  --json                     JSON output for list/status/inspect
  Jobs API required          Set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl for all job commands

Examples:
  mcoda job list --status running
  mcoda job status <JOB_ID> --json
  mcoda job watch <JOB_ID> --interval 2 --no-logs
  mcoda job logs <JOB_ID> --since 10m --follow
  mcoda job inspect <JOB_ID>
  mcoda job resume <JOB_ID> --agent codex
  mcoda job cancel <JOB_ID>
  mcoda job tokens <JOB_ID> --since 24h

Exit codes:
  status/watch/logs return non-zero when a job is failed or cancelled.

Run "mcoda job --help" to see all flags and usage details for job management.`;

export const parseJobArgs = (argv: string[]): ParsedJobArgs => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    // eslint-disable-next-line no-console
    console.log(usage);
    process.exit(0);
  }

  let subcommand: JobSubcommand | undefined;
  let workspaceRoot: string | undefined;
  let jobId: string | undefined;
  let project: string | undefined;
  let status: string | undefined;
  let type: string | undefined;
  let since: string | undefined;
  let limit: number | undefined;
  let json = false;
  let intervalSeconds: number | undefined;
  let noLogs = false;
  let follow = false;
  let agent: string | undefined;
  let noTelemetry = false;
  let force = false;

  const [first, ...rest] = argv;
  if (first && !first.startsWith("--")) {
    subcommand = first as JobSubcommand;
  }
  const args = subcommand ? rest : argv;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--") && !jobId) {
      jobId = arg;
      continue;
    }
    switch (arg) {
      case "--workspace-root":
      case "--workspace":
        workspaceRoot = args[i + 1] ? path.resolve(args[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        project = args[i + 1];
        i += 1;
        break;
      case "--status":
        status = args[i + 1];
        i += 1;
        break;
      case "--type":
        type = args[i + 1];
        i += 1;
        break;
      case "--since":
        since = args[i + 1];
        i += 1;
        break;
      case "--limit":
        limit = Number(args[i + 1]);
        i += 1;
        break;
      case "--interval":
        intervalSeconds = Number(args[i + 1]);
        i += 1;
        break;
      case "--no-logs":
        noLogs = true;
        break;
      case "--follow":
        follow = true;
        break;
      case "--agent":
        agent = args[i + 1];
        i += 1;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--force":
        force = true;
        break;
      case "--json":
        json = true;
        break;
      case "--format":
        json = args[i + 1] === "json";
        i += 1;
        break;
      case "--id":
        jobId = args[i + 1];
        i += 1;
        break;
      default:
        break;
    }
  }

  if (!subcommand || !["list", "status", "watch", "logs", "inspect", "resume", "cancel", "tokens"].includes(subcommand)) {
    throw new Error(`Unknown job subcommand.\n\n${usage}`);
  }
  if (["status", "watch", "logs", "inspect", "resume", "cancel", "tokens"].includes(subcommand) && !jobId) {
    throw new Error(`${subcommand} requires a JOB_ID.\n\n${usage}`);
  }

  return {
    subcommand,
    jobId,
    workspaceRoot,
    project,
    status,
    type,
    since,
    limit: Number.isFinite(limit) ? (limit as number) : undefined,
    json,
    intervalSeconds: Number.isFinite(intervalSeconds) ? (intervalSeconds as number) : undefined,
    noLogs,
    follow,
    agent,
    noTelemetry,
    force,
  };
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const formatTable = (headers: string[], rows: string[][]): string => {
  if (rows.length === 0) return headers.join(" | ");
  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)));
  const headerLine = headers.map((h, idx) => pad(h, widths[idx])).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join(" | ")).join("\n");
  return [headerLine, sepLine, body].filter(Boolean).join("\n");
};

const formatProgress = (total?: number | null, completed?: number | null): string => {
  if (!total || total <= 0) return "-";
  const pct = Math.round(((completed ?? 0) / total) * 100);
  return `${pct}% (${completed ?? 0}/${total})`;
};

const isTerminalState = (state: string | undefined): boolean => {
  if (!state) return false;
  return ["completed", "failed", "cancelled", "paused"].includes(state);
};

const statusExitCode = (state: string | undefined): number => {
  if (!state) return 1;
  if (["failed", "cancelled"].includes(state)) return 1;
  return 0;
};

export const renderJobTokens = (rows: TokenUsageRow[]): void => {
  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No telemetry data for this job.");
    return;
  }
  const headers = [
    "TIME",
    "ACTION",
    "COMMAND",
    "CMD_RUN",
    "TASK",
    "AGENT",
    "MODEL",
    "TOKENS_IN",
    "TOKENS_OUT",
    "TOKENS_TOTAL",
    "TOKENS_CACHED",
    "CACHE_READ",
    "CACHE_WRITE",
    "DURATION_MS",
    "ERROR_KIND",
  ];
  const tableRows = rows.map((row) => [
    row.timestamp,
    row.action ?? "-",
    row.command_name ?? "-",
    row.command_run_id ?? "-",
    row.task_id ?? row.task_run_id ?? "-",
    row.agent_id ?? "-",
    row.model_name ?? "-",
    row.tokens_prompt != null ? `${row.tokens_prompt}` : "-",
    row.tokens_completion != null ? `${row.tokens_completion}` : "-",
    row.tokens_total != null ? `${row.tokens_total}` : "-",
    row.tokens_cached != null ? `${row.tokens_cached}` : "-",
    row.tokens_cache_read != null ? `${row.tokens_cache_read}` : "-",
    row.tokens_cache_write != null ? `${row.tokens_cache_write}` : "-",
    row.duration_ms != null
      ? `${row.duration_ms}`
      : row.duration_seconds != null
        ? `${Math.round(row.duration_seconds * 1000)}`
        : "-",
    row.error_kind ?? "-",
  ]);
  // eslint-disable-next-line no-console
  console.log(formatTable(headers, tableRows));
};

const printLogs = (entries: { timestamp: string; taskKey?: string | null; source?: string | null; message?: string | null; level?: string | null; phase?: string | null }[]): void => {
  for (const entry of entries) {
    const parts = [entry.timestamp];
    if (entry.taskKey) parts.push(`[${entry.taskKey}]`);
    if (entry.phase) parts.push(entry.phase);
    if (entry.source) parts.push(entry.source);
    const prefix = parts.join(" ");
    // eslint-disable-next-line no-console
    console.log(`${prefix}: ${entry.message ?? ""}`.trim());
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const printJobStatus = (
  job: {
    id: string;
    type: string;
    commandName?: string;
    commandRunId?: string;
    state?: string;
    stateDetail?: string;
    jobState?: string;
    jobStateDetail?: string;
    errorSummary?: string;
    totalItems?: number | null;
    processedItems?: number | null;
    totalUnits?: number | null;
    completedUnits?: number | null;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string | null;
  },
  checkpoint?: { stage?: string; timestamp?: string },
): void => {
  // eslint-disable-next-line no-console
  console.log(`Job ${job.id} (${job.commandName ?? job.type})`);
  if (job.commandRunId) {
    // eslint-disable-next-line no-console
    console.log(`Command Run: ${job.commandRunId}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `State: ${job.jobState ?? job.state ?? "unknown"}${job.jobStateDetail ? ` (${job.jobStateDetail})` : job.stateDetail ? ` (${job.stateDetail})` : ""}${
      job.errorSummary ? ` [${job.errorSummary}]` : ""
    }`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Progress: ${formatProgress(
      (job as any).totalUnits ?? job.totalItems,
      (job as any).completedUnits ?? job.processedItems,
    )}`,
  );
  if (job.createdAt) {
    // eslint-disable-next-line no-console
    console.log(`Created: ${job.createdAt}`);
  }
  if (job.updatedAt) {
    // eslint-disable-next-line no-console
    console.log(`Updated: ${job.updatedAt}`);
  }
  if (job.completedAt) {
    // eslint-disable-next-line no-console
    console.log(`Completed: ${job.completedAt}`);
  }
  if (checkpoint?.stage || checkpoint?.timestamp) {
    // eslint-disable-next-line no-console
    console.log(`Last checkpoint: ${checkpoint?.stage ?? ""}${checkpoint?.timestamp ? ` @ ${checkpoint.timestamp}` : ""}`.trim());
  }
};

const handleResume = async (
  parsed: ParsedJobArgs,
  workspace: WorkspaceResolution,
  resumeService: JobResumeService,
): Promise<void> => {
  if (!parsed.jobId) throw new Error("resume requires a job id");
  await resumeService.resume(parsed.jobId, { agentName: parsed.agent, noTelemetry: parsed.noTelemetry });
};

const handleCancel = async (parsed: ParsedJobArgs, jobService: JobService, insights: JobInsightsService): Promise<void> => {
  if (!parsed.jobId) throw new Error("cancel requires a job id");
  const existing = await insights.getJob(parsed.jobId);
  if (!existing) {
    throw new Error(`Job not found: ${parsed.jobId}`);
  }
  const currentState = (existing as any).jobState ?? existing.state ?? "unknown";
  const cancellableStates = new Set(["queued", "running", "checkpointing", "paused"]);
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  if (terminalStates.has(currentState) && !parsed.force) {
    throw new Error(`Job ${existing.id} is ${currentState}; rerun with --force to mark cancelled.`);
  }
  if (!cancellableStates.has(currentState) && !parsed.force) {
    throw new Error(`Job ${existing.id} is ${currentState}; rerun with --force to mark cancelled.`);
  }
  const reason = parsed.force ? "force" : "user";
  await insights.cancelJob(parsed.jobId, { force: parsed.force, reason });
  const updated = await insights.getJob(parsed.jobId);
  if (updated) {
    // eslint-disable-next-line no-console
    console.log(`Job ${updated.id} is now ${updated.state ?? updated.jobState ?? "cancelled"}`);
  }
};

const handleTokens = async (parsed: ParsedJobArgs, workspace: WorkspaceResolution): Promise<void> => {
  if (!parsed.jobId) throw new Error("tokens requires a job id");
  const telemetry = await TelemetryService.create(workspace, { allowMissingTelemetry: false, requireApi: true });
  try {
    const usage = await telemetry.getTokenUsage({ jobId: parsed.jobId, since: parsed.since });
    if (parsed.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(usage, null, 2));
    } else {
      renderJobTokens(usage);
      if (usage.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No telemetry data for the selected filters/time window.");
      }
    }
  } finally {
    await telemetry.close();
  }
};

export class JobsCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseJobArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    const jobService = new JobService(workspace, undefined, {
      noTelemetry: parsed.noTelemetry,
      requireRepo: true,
    });
    const apiBaseUrl =
      (workspace as any).config?.api?.baseUrl ??
      process.env.MCODA_API_BASE_URL ??
      process.env.MCODA_JOBS_API_URL ??
      undefined;
    if (!apiBaseUrl) {
      throw new Error(
        "Jobs API is not configured. Set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or configure workspace api.baseUrl to use job commands.",
      );
    }
    const insights = new JobInsightsService(workspace, jobService, apiBaseUrl);
    const resumeService = new JobResumeService(workspace, jobService);
    const commandRun = await jobService.startCommandRun(`job ${parsed.subcommand}`, undefined, { jobId: parsed.jobId });
    try {
      if (parsed.subcommand === "list") {
        const jobs = await insights.listJobs({
          projectKey: parsed.project,
          status: parsed.status,
          type: parsed.type,
          since: parsed.since,
          limit: parsed.limit,
        });
        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(jobs, null, 2));
        } else if (jobs.length === 0) {
          // eslint-disable-next-line no-console
          console.log("No jobs found.");
        } else {
          const headers = ["ID", "TYPE", "COMMAND", "STATE", "DETAIL", "PROGRESS", "CREATED", "UPDATED"];
          const rows = jobs.map((job) => [
            job.id,
            job.type,
            job.commandName ?? "-",
            job.jobState ?? job.state ?? "-",
            job.jobStateDetail ?? (job as any).stateDetail ?? job.errorSummary ?? "-",
            formatProgress(job.totalUnits ?? job.totalItems, job.completedUnits ?? job.processedItems),
            job.createdAt ?? "-",
            job.updatedAt ?? "-",
          ]);
          // eslint-disable-next-line no-console
          console.log(formatTable(headers, rows));
        }
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }

      if (parsed.subcommand === "status") {
        const job = parsed.jobId ? await insights.getJob(parsed.jobId) : undefined;
        if (!job) throw new Error(`Job not found: ${parsed.jobId}`);
        const checkpoint = parsed.jobId ? await insights.latestCheckpoint(parsed.jobId) : undefined;
        if (parsed.json) {
          const payload = {
            job: {
              ...job,
              job_state: (job as any).jobState ?? job.state,
              job_state_detail: job.jobStateDetail ?? (job as any).stateDetail ?? job.errorSummary,
              total_units: job.totalUnits ?? job.totalItems,
              completed_units: job.completedUnits ?? job.processedItems,
            },
            checkpoint,
          };
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printJobStatus({ ...job, stateDetail: (job as any).stateDetail ?? job.errorSummary }, checkpoint);
        }
        const exit = statusExitCode(job.jobState ?? job.state);
        if (exit !== 0) process.exitCode = exit;
        await jobService.finishCommandRun(commandRun.id, exit === 0 ? "succeeded" : "failed", job.errorSummary);
        return;
      }

      if (parsed.subcommand === "watch") {
        const intervalMs = Math.max(1, parsed.intervalSeconds ?? 3) * 1000;
        let stop = false;
        let logCursor: { timestamp: string; sequence?: number | null } | undefined;
        const onSigint = () => {
          stop = true;
        };
        process.once("SIGINT", onSigint);
        while (!stop) {
          const job = parsed.jobId ? await insights.getJob(parsed.jobId) : undefined;
          if (!job) throw new Error(`Job not found: ${parsed.jobId}`);
          const checkpoint = parsed.jobId ? await insights.latestCheckpoint(parsed.jobId) : undefined;
          printJobStatus(job, checkpoint);
          if (!parsed.noLogs) {
            const logs = await insights.getJobLogs(parsed.jobId!, { since: logCursor ? undefined : parsed.since, after: logCursor });
            printLogs(logs.entries);
            logCursor = logs.cursor;
          }
          if (isTerminalState(job.state)) {
            const exit = statusExitCode(job.state);
            if (exit !== 0) process.exitCode = exit;
            // eslint-disable-next-line no-console
            console.log(`Job reached terminal state: ${job.state}`);
            break;
          }
          await sleep(intervalMs);
        }
        process.removeListener("SIGINT", onSigint);
        await jobService.finishCommandRun(commandRun.id, process.exitCode ? "failed" : "succeeded");
        return;
      }

      if (parsed.subcommand === "logs") {
        let logCursor: { timestamp: string; sequence?: number | null } | undefined;
        const intervalMs = Math.max(1, parsed.intervalSeconds ?? 3) * 1000;
        let done = false;
        const onSigint = () => {
          done = true;
        };
        process.once("SIGINT", onSigint);
        while (!done) {
          const logs = await insights.getJobLogs(parsed.jobId!, { since: logCursor ? undefined : parsed.since, after: logCursor });
          printLogs(logs.entries);
          logCursor = logs.cursor;

          if (!parsed.follow) break;
          const job = await insights.getJob(parsed.jobId!);
          if (job && isTerminalState(job.state)) {
            const exit = statusExitCode(job.state);
            if (exit !== 0) process.exitCode = exit;
            break;
          }
          await sleep(intervalMs);
        }
        process.removeListener("SIGINT", onSigint);
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }

      if (parsed.subcommand === "inspect") {
        const job = parsed.jobId ? await insights.getJob(parsed.jobId) : undefined;
        if (!job) throw new Error(`Job not found: ${parsed.jobId}`);
        const checkpoint = await insights.latestCheckpoint(parsed.jobId!);
        const tasks = await insights.summarizeTasks(parsed.jobId!);
        const tokens = await insights.summarizeTokenUsage(parsed.jobId!);
        const payload = { job, checkpoint, tasks, tokens };
        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printJobStatus(job, checkpoint);
          if (job.commandRunId) {
            // eslint-disable-next-line no-console
            console.log(`Command run: ${job.commandRunId}`);
          }
          // eslint-disable-next-line no-console
          console.log("\nTasks:");
          const totalsLine = Object.entries(tasks.totals)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ");
          // eslint-disable-next-line no-console
          console.log(totalsLine || "(no task runs)");
          tasks.tasks.forEach((task) => {
            const parts = [task.taskKey ?? task.taskId ?? "(unknown)", task.status ?? "unknown"];
            if (task.startedAt) parts.push(`started ${task.startedAt}`);
            if (task.finishedAt) parts.push(`finished ${task.finishedAt}`);
            // eslint-disable-next-line no-console
            console.log(`- ${parts.join(" | ")}`);
          });
          if (tokens.length) {
            // eslint-disable-next-line no-console
            console.log("\nToken usage:");
            tokens.forEach((row) => {
              const r: any = row as any;
              const cached = row.tokensCached ?? null;
              const durationMs = row.durationMs ?? null;
              // eslint-disable-next-line no-console
              console.log(
                `- command=${r.commandName ?? job.commandName ?? "-"} agent=${row.agentId ?? "-"} model=${row.modelName ?? "-"} tokens=${row.tokensTotal ?? row.tokensPrompt ?? 0}` +
                  (cached != null ? ` cached=${cached}` : "") +
                  (row.tokensCacheRead != null ? ` cache_read=${row.tokensCacheRead}` : "") +
                  (row.tokensCacheWrite != null ? ` cache_write=${row.tokensCacheWrite}` : "") +
                  (durationMs != null ? ` duration_ms=${durationMs}` : "") +
                  (row.cost != null ? ` cost=${row.cost}` : "") +
                  (r.commandRunId ? ` cmd_run=${r.commandRunId}` : "") +
                  (r.taskId ? ` task=${r.taskId}` : ""),
              );
            });
          }
        }
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }

      if (parsed.subcommand === "resume") {
        await handleResume(parsed, workspace, resumeService);
        await jobService.finishCommandRun(commandRun.id, process.exitCode ? "failed" : "succeeded");
        return;
      }

      if (parsed.subcommand === "cancel") {
        await handleCancel(parsed, jobService, insights);
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }

      if (parsed.subcommand === "tokens") {
        await handleTokens(parsed, workspace);
        await jobService.finishCommandRun(commandRun.id, "succeeded");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(message);
      process.exitCode = process.exitCode ?? 1;
      await jobService.finishCommandRun(commandRun.id, "failed", message);
    } finally {
      await insights.close();
    }
  }
}
