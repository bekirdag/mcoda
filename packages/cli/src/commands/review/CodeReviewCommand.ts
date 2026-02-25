import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { CodeReviewService, WorkspaceResolver } from "@mcoda/core";
import { REVIEW_ALLOWED_STATUSES, filterTaskStatuses, normalizeReviewStatuses } from "@mcoda/shared";

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
  rateAgents: boolean;
  createFollowupTasks: boolean;
  executionContextPolicy?: "best_effort" | "require_any" | "require_sds_or_openapi";
  emptyDiffApprovalPolicy?: "ready_to_qa" | "complete";
  json: boolean;
}

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

const usage = `mcoda code-review \\
  [--workspace-root <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \\
  [--status ready_to_code_review] \\
  [--base <BRANCH>] \\
  [--dry-run] \\
  [--resume <JOB_ID>] \\
  [--limit N] \\
  [--agent <NAME>] \\
  [--agent-stream <true|false>] \\
  [--create-followup-tasks <true|false>] \\
  [--execution-context-policy <best_effort|require_any|require_sds_or_openapi>] \\
  [--empty-diff-approval-policy <ready_to_qa|complete>] \\
  [--rate-agents] \\
  [--json]

Runs AI code review on task branches. Side effects: writes task_comments/task_reviews, may spawn follow-up tasks when --create-followup-tasks=true, updates task state (unless --dry-run), records jobs/command_runs/task_runs/token_usage, saves diffs/context under ~/.mcoda/workspaces/<fingerprint>/jobs/<job_id>/review/. Default status filter: ready_to_code_review. JSON output: { job, tasks, errors, warnings }.`;

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

const normalizeEmptyDiffApprovalPolicy = (
  value?: string,
): ParsedArgs["emptyDiffApprovalPolicy"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "ready_to_qa" || normalized === "complete") {
    return normalized;
  }
  return undefined;
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
  let rateAgents = false;
  let createFollowupTasks = false;
  let executionContextPolicy: ParsedArgs["executionContextPolicy"];
  let emptyDiffApprovalPolicy: ParsedArgs["emptyDiffApprovalPolicy"];
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
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--create-followup-tasks=")) {
      const [, raw] = arg.split("=", 2);
      createFollowupTasks = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--execution-context-policy=")) {
      const [, raw] = arg.split("=", 2);
      const parsedPolicy = normalizeExecutionContextPolicy(raw);
      if (parsedPolicy) executionContextPolicy = parsedPolicy;
      continue;
    }
    if (arg.startsWith("--empty-diff-approval-policy=")) {
      const [, raw] = arg.split("=", 2);
      const parsedPolicy = normalizeEmptyDiffApprovalPolicy(raw);
      if (parsedPolicy) emptyDiffApprovalPolicy = parsedPolicy;
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
      case "--create-followup-tasks": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          createFollowupTasks = parseBooleanFlag(next, true);
          i += 1;
        } else {
          createFollowupTasks = true;
        }
        break;
      }
      case "--execution-context-policy": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          const parsedPolicy = normalizeExecutionContextPolicy(next);
          if (parsedPolicy) {
            executionContextPolicy = parsedPolicy;
            i += 1;
          }
        }
        break;
      }
      case "--empty-diff-approval-policy": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          const parsedPolicy = normalizeEmptyDiffApprovalPolicy(next);
          if (parsedPolicy) {
            emptyDiffApprovalPolicy = parsedPolicy;
            i += 1;
          }
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
    REVIEW_ALLOWED_STATUSES,
    REVIEW_ALLOWED_STATUSES,
  );
  const normalized = normalizeReviewStatuses(filtered);
  statusFilter.splice(0, statusFilter.length, ...normalized);

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
    agentStream: agentStream ?? false,
    rateAgents,
    createFollowupTasks,
    executionContextPolicy: executionContextPolicy ?? "require_sds_or_openapi",
    emptyDiffApprovalPolicy: emptyDiffApprovalPolicy ?? "ready_to_qa",
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

export const pickCodeReviewProjectKey = (options: {
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

export class CodeReviewCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseCodeReviewArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
      noRepoWrites: true,
    });
    const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectResolution = pickCodeReviewProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      existing: existingProjects,
    });
    const commandWarnings = [...projectResolution.warnings];
    if (!projectResolution.projectKey) {
      // eslint-disable-next-line no-console
      console.error(
        "code-review could not resolve a project key. Provide --project <PROJECT_KEY> or create tasks for this workspace first.",
      );
      process.exitCode = 1;
      return;
    }
    if (commandWarnings.length && !parsed.json) {
      // eslint-disable-next-line no-console
      console.warn(commandWarnings.map((warning) => `! ${warning}`).join("\n"));
    }
    const service = await CodeReviewService.create(workspace);
    try {
      const result = await service.reviewTasks({
        workspace,
        projectKey: projectResolution.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        ignoreStatusFilter: parsed.taskKeys.length > 0 ? true : undefined,
        baseRef: parsed.baseRef,
        dryRun: parsed.dryRun,
        resumeJobId: parsed.resumeJobId,
        limit: parsed.limit,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        createFollowupTasks: parsed.createFollowupTasks,
        executionContextPolicy: parsed.executionContextPolicy,
        emptyDiffApprovalPolicy: parsed.emptyDiffApprovalPolicy,
      });

      if (parsed.json) {
        const warnings = [...commandWarnings, ...result.warnings];
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
              warnings,
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
      const warnings = [...commandWarnings, ...result.warnings];
      if (warnings.length) {
        summary.push(`Warnings: ${warnings.join("; ")}`);
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
