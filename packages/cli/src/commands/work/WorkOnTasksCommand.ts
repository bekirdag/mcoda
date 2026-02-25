import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { JobService, WorkOnTasksService, WorkspaceResolver } from "@mcoda/core";
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
  workRunner?: string;
  useCodali?: boolean;
  agentAdapterOverride?: string;
  missingTestsPolicy?: "block_job" | "skip_task" | "fail_task" | "continue_task";
  allowMissingTests?: boolean;
  missingContextPolicy?: "allow" | "warn" | "block";
  executionContextPolicy?: "best_effort" | "require_any" | "require_sds_or_openapi";
  json: boolean;
}

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

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
  [--work-runner <codali|default>] \\
  [--use-codali <true|false>] \\
  [--missing-tests-policy <continue_task|block_job|skip_task|fail_task>] \\
  [--allow-missing-tests <true|false>] \\
  [--missing-context-policy <allow|warn|block>] \\
  [--execution-context-policy <best_effort|require_any|require_sds_or_openapi>] \\
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

const normalizeRunner = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
};

const normalizeMissingTestsPolicy = (
  value?: string,
): ParsedArgs["missingTestsPolicy"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "block_job" ||
    normalized === "skip_task" ||
    normalized === "fail_task" ||
    normalized === "continue_task" ||
    normalized === "continue" ||
    normalized === "allow" ||
    normalized === "warn_task"
  ) {
    if (normalized === "continue" || normalized === "allow" || normalized === "warn_task") {
      return "continue_task";
    }
    return normalized;
  }
  return undefined;
};

const normalizeMissingContextPolicy = (
  value?: string,
): ParsedArgs["missingContextPolicy"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "allow" || normalized === "warn" || normalized === "block") {
    return normalized;
  }
  return undefined;
};

const normalizeExecutionContextPolicy = (
  value?: string,
): ParsedArgs["executionContextPolicy"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "best_effort" || normalized === "require_any" || normalized === "require_sds_or_openapi") {
    return normalized;
  }
  return undefined;
};

const resolveEnvRunner = (): string | undefined => normalizeRunner(process.env.MCODA_WORK_ON_TASKS_ADAPTER);

const resolveRunnerOverride = (
  workRunner?: string,
): { agentAdapterOverride?: string; workRunner?: string } => {
  if (!workRunner) return {};
  const normalized = normalizeRunner(workRunner);
  if (!normalized || normalized === "default") {
    return {};
  }
  if (normalized === "codali") {
    return { workRunner: normalized, agentAdapterOverride: "codali-cli" };
  }
  if (normalized === "codali-cli") {
    return { workRunner: normalized, agentAdapterOverride: "codali-cli" };
  }
  return { workRunner: normalized, agentAdapterOverride: normalized };
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
  let workRunner: string | undefined;
  let useCodali: boolean | undefined;
  let missingTestsPolicy: ParsedArgs["missingTestsPolicy"];
  let allowMissingTests: boolean | undefined;
  let missingContextPolicy: ParsedArgs["missingContextPolicy"];
  let executionContextPolicy: ParsedArgs["executionContextPolicy"];
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
    if (arg.startsWith("--work-runner=")) {
      const [, raw] = arg.split("=", 2);
      workRunner = normalizeRunner(raw);
      continue;
    }
    if (arg.startsWith("--use-codali=")) {
      const [, raw] = arg.split("=", 2);
      useCodali = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--missing-tests-policy=")) {
      const [, raw] = arg.split("=", 2);
      const parsedPolicy = normalizeMissingTestsPolicy(raw);
      if (parsedPolicy) missingTestsPolicy = parsedPolicy;
      continue;
    }
    if (arg.startsWith("--allow-missing-tests=")) {
      const [, raw] = arg.split("=", 2);
      allowMissingTests = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--missing-context-policy=")) {
      const [, raw] = arg.split("=", 2);
      const parsedPolicy = normalizeMissingContextPolicy(raw);
      if (parsedPolicy) missingContextPolicy = parsedPolicy;
      continue;
    }
    if (arg.startsWith("--execution-context-policy=")) {
      const [, raw] = arg.split("=", 2);
      const parsedPolicy = normalizeExecutionContextPolicy(raw);
      if (parsedPolicy) executionContextPolicy = parsedPolicy;
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
      case "--work-runner": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          workRunner = normalizeRunner(next);
          i += 1;
        }
        break;
      }
      case "--use-codali": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          useCodali = parseBooleanFlag(next, true);
          i += 1;
        } else {
          useCodali = true;
        }
        break;
      }
      case "--missing-tests-policy": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          const parsedPolicy = normalizeMissingTestsPolicy(next);
          if (parsedPolicy) {
            missingTestsPolicy = parsedPolicy;
          }
          i += 1;
        }
        break;
      }
      case "--allow-missing-tests": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          allowMissingTests = parseBooleanFlag(next, true);
          i += 1;
        } else {
          allowMissingTests = true;
        }
        break;
      }
      case "--missing-context-policy": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          const parsedPolicy = normalizeMissingContextPolicy(next);
          if (parsedPolicy) {
            missingContextPolicy = parsedPolicy;
          }
          i += 1;
        }
        break;
      }
      case "--execution-context-policy": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          const parsedPolicy = normalizeExecutionContextPolicy(next);
          if (parsedPolicy) {
            executionContextPolicy = parsedPolicy;
          }
          i += 1;
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

  if (!workRunner) {
    workRunner = resolveEnvRunner();
  }
  const envUseCodali = parseBooleanFlag(process.env.MCODA_WORK_ON_TASKS_USE_CODALI, false);
  const runnerImpliesCodali = workRunner === "codali" || workRunner === "codali-cli";
  if (useCodali === undefined) {
    useCodali = runnerImpliesCodali || envUseCodali;
  }
  if (!workRunner && useCodali) {
    workRunner = "codali";
  }
  const runnerOverride = resolveRunnerOverride(workRunner);

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
    workRunner: runnerOverride.workRunner ?? workRunner,
    useCodali,
    agentAdapterOverride: runnerOverride.agentAdapterOverride,
    missingTestsPolicy,
    allowMissingTests,
    missingContextPolicy,
    executionContextPolicy: executionContextPolicy ?? "require_sds_or_openapi",
    json,
  };
};

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

export const pickWorkOnTasksProjectKey = (options: {
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
    const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectResolution = pickWorkOnTasksProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      existing: existingProjects,
    });
    const commandWarnings = [...projectResolution.warnings];
    if (!projectResolution.projectKey) {
      // eslint-disable-next-line no-console
      console.error(
        "work-on-tasks could not resolve a project key. Provide --project <PROJECT_KEY> or create tasks for this workspace first.",
      );
      process.exitCode = 1;
      return;
    }
    if (commandWarnings.length && !parsed.json) {
      // eslint-disable-next-line no-console
      console.warn(commandWarnings.map((warning) => `! ${warning}`).join("\n"));
    }
    const service = await WorkOnTasksService.create(workspace);
    try {
      const abortController = new AbortController();
      let cancelHandled = false;
      const handleCancel = async (signal: NodeJS.Signals) => {
        if (cancelHandled) return;
        cancelHandled = true;
        abortController.abort(new Error(`Cancelled by ${signal}`));
        await JobService.cancelActiveJobs(signal);
      };
      process.once("SIGINT", () => {
        void handleCancel("SIGINT");
      });
      process.once("SIGTERM", () => {
        void handleCancel("SIGTERM");
      });
      process.once("SIGTSTP", () => {
        void handleCancel("SIGTSTP");
      });
      const streamSink = (chunk: string) => {
        const target = parsed.json ? process.stderr : process.stdout;
        target.write(chunk);
      };
      const onAgentChunk = parsed.agentStream !== false ? streamSink : undefined;
      const result = await service.workOnTasks({
        workspace,
        projectKey: projectResolution.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        ignoreStatusFilter: parsed.taskKeys.length > 0 ? true : undefined,
        limit: parsed.limit,
        parallel: parsed.parallel,
        noCommit: parsed.noCommit,
        dryRun: parsed.dryRun,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        autoMerge: parsed.autoMerge,
        autoPush: parsed.autoPush,
        workRunner: parsed.workRunner,
        useCodali: parsed.useCodali,
        agentAdapterOverride: parsed.agentAdapterOverride,
        missingTestsPolicy: parsed.missingTestsPolicy,
        allowMissingTests: parsed.allowMissingTests,
        missingContextPolicy: parsed.missingContextPolicy,
        executionContextPolicy: parsed.executionContextPolicy,
        onAgentChunk,
        abortSignal: abortController.signal,
      });
      const warnings = [...commandWarnings, ...result.warnings];

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
              projectKey: projectResolution.projectKey,
              warnings,
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
      if (warnings.length) {
        // eslint-disable-next-line no-console
        console.warn(warnings.map((w) => `! ${w}`).join("\n"));
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
