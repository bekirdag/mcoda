import path from "node:path";
import YAML from "yaml";
import { JobService, TaskDetailService, WorkspaceResolver } from "@mcoda/core";

type OutputFormat = "table" | "json" | "yaml";

export interface ParsedTaskShowArgs {
  workspaceRoot?: string;
  project?: string;
  taskKey?: string;
  includeLogs: boolean;
  includeHistory: boolean;
  format: OutputFormat;
  noTelemetry: boolean;
}

const usage = `mcoda task show <TASK_KEY> \\
  [--project <PROJECT_KEY>] \\
  [--include-logs] \\
  [--include-history] \\
  [--format <table|json|yaml>] (yaml output is experimental) \\
  [--no-telemetry] \\
  [--workspace-root <PATH>]

Aliases:
  mcoda task <TASK_KEY>
  mcoda task-detail --project <PROJECT_KEY> --task <TASK_KEY>`;

const parseFormat = (value?: string): OutputFormat => {
  if (!value) return "table";
  const normalized = value.toLowerCase();
  if (normalized === "table" || normalized === "json" || normalized === "yaml") return normalized;
  throw new Error(`Unknown format "${value}". Allowed: table, json, yaml.`);
};

const cleanSnippet = (value: string, max = 180): string => {
  const condensed = value.replace(/\s+/g, " ").trim();
  if (!condensed) return "(empty)";
  return condensed.length > max ? `${condensed.slice(0, max - 3)}...` : condensed;
};

const shortSha = (value?: string | null): string => {
  if (!value) return "-";
  return value.length > 8 ? value.slice(0, 8) : value;
};

export const parseTaskShowArgs = (argv: string[]): ParsedTaskShowArgs => {
  const parsed: ParsedTaskShowArgs = {
    includeLogs: false,
    includeHistory: false,
    format: "table",
    noTelemetry: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "show" && !parsed.taskKey) continue;
    if (!arg.startsWith("-") && !parsed.taskKey) {
      parsed.taskKey = arg;
      continue;
    }
    switch (arg) {
      case "--workspace-root":
        parsed.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        parsed.project = argv[i + 1];
        i += 1;
        break;
      case "--task":
        parsed.taskKey = argv[i + 1];
        i += 1;
        break;
      case "--include-logs":
        parsed.includeLogs = true;
        break;
      case "--include-history":
        parsed.includeHistory = true;
        break;
      case "--no-telemetry":
        parsed.noTelemetry = true;
        break;
      case "--format":
        parsed.format = parseFormat(argv[i + 1]);
        i += 1;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(usage);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--project=")) {
          parsed.project = arg.split("=")[1];
        } else if (arg.startsWith("--task=")) {
          parsed.taskKey = arg.split("=")[1];
        } else if (arg.startsWith("--format=")) {
          parsed.format = parseFormat(arg.split("=")[1]);
        } else if (arg === "--json") {
          parsed.format = "json";
        } else if (arg === "--yaml") {
          parsed.format = "yaml";
        } else if (arg === "--include-logs=true") {
          parsed.includeLogs = true;
        } else if (arg === "--include-history=true") {
          parsed.includeHistory = true;
        } else if (arg === "--no-telemetry") {
          parsed.noTelemetry = true;
        }
        break;
    }
  }

  return parsed;
};

const renderDependencies = (label: string, deps: { key: string; status: string; relationType: string }[]): string => {
  if (!deps.length) return `${label}: none`;
  const items = deps.map((dep) => `${dep.key} (${dep.status}; ${dep.relationType || "relation"})`);
  return `${label}: ${items.join(", ")}`;
};

const renderTable = (detail: Awaited<ReturnType<TaskDetailService["getTaskDetail"]>>): void => {
  const { task, dependencies, comments, logs, history } = detail;
  const metadata = task.metadata as Record<string, unknown> | null | undefined;
  const prUrl = typeof metadata?.pr_url === "string" ? metadata.pr_url : undefined;
  const lines = [
    `[${task.key}] ${task.title} — ${task.status} (Type: ${task.type ?? "-"}, SP: ${task.storyPoints ?? "-"}, Priority: ${task.priority ?? "-"})`,
    `Project: ${task.project.key}${task.project.name ? ` – ${task.project.name}` : ""}`,
    `Epic: ${task.epic.key} – ${task.epic.title}`,
    `Story: ${task.story.key} – ${task.story.title}`,
    `Assignee: ${
      task.assigneeHuman
        ? `human:${task.assigneeHuman}`
        : task.assignedAgentSlug
          ? `agent:${task.assignedAgentSlug}`
          : task.assignedAgentId
            ? `agent-id:${task.assignedAgentId}`
            : "-"
    }`,
    "",
    "Description:",
    task.description ?? "(none)",
    "",
    "VCS:",
    `  Branch: ${task.vcsBranch ?? "-"}`,
    `  Base: ${task.vcsBaseBranch ?? "-"}`,
    `  Last commit: ${shortSha(task.vcsLastCommitSha)}`,
    prUrl ? `  PR: ${prUrl}` : "",
    "",
    "Dependencies:",
    dependencies.upstream.length === 0 && dependencies.downstream.length === 0
      ? "  No dependencies recorded."
      : [
          `  ${renderDependencies("Upstream", dependencies.upstream)}`,
          `  ${renderDependencies("Downstream", dependencies.downstream)}`,
        ].join("\n"),
    "",
    "Recent comments:",
  ];

  if (comments.length === 0) {
    lines.push("  None.");
  } else {
    for (const comment of comments) {
      const origin = [comment.authorType, comment.sourceCommand, comment.category].filter(Boolean).join("/");
      lines.push(`  - ${comment.createdAt} [${origin || "comment"}] ${cleanSnippet(comment.body)}`);
    }
  }

  if (logs) {
    lines.push("", "Recent logs:");
    if (logs.length === 0) {
      lines.push("  None.");
    } else {
      for (const log of logs) {
        const parts = [
          log.timestamp,
          log.command ? `cmd=${log.command}` : undefined,
          log.status ? `status=${log.status}` : undefined,
          log.level ? log.level.toUpperCase() : undefined,
          cleanSnippet(log.message ?? "", 120),
        ].filter(Boolean);
        lines.push(`  - ${parts.join(" | ")}`);
      }
    }
  }

  if (history) {
    lines.push("", "History:");
    if (history.length === 0) {
      lines.push("  None.");
    } else {
      for (const revision of history) {
        const statusChange =
          revision.statusBefore || revision.statusAfter
            ? `${revision.statusBefore ?? "-"} → ${revision.statusAfter ?? "-"}`
            : undefined;
        const spChange =
          revision.storyPointsBefore !== undefined || revision.storyPointsAfter !== undefined
            ? `${revision.storyPointsBefore ?? "-"} → ${revision.storyPointsAfter ?? "-"}`
            : undefined;
        const parts = [
          revision.changedAt,
          statusChange ? `status ${statusChange}` : undefined,
          spChange ? `SP ${spChange}` : undefined,
          revision.changedFields?.length ? `fields: ${revision.changedFields.join(", ")}` : undefined,
        ].filter(Boolean);
        lines.push(`  - ${parts.join(" | ")}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
};

export class TaskShowCommands {
  static async run(argv: string[]): Promise<void> {
    let parsed: ParsedTaskShowArgs;
    try {
      parsed = parseTaskShowArgs(argv);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    if (!parsed.taskKey) {
      // eslint-disable-next-line no-console
      console.error("Missing task key.\n");
      // eslint-disable-next-line no-console
      console.log(usage);
      process.exitCode = 1;
      return;
    }
    let service: TaskDetailService | undefined;
    let jobService: JobService | undefined;
    let commandRunId: string | undefined;
    try {
      const workspace = await WorkspaceResolver.resolveWorkspace({
        cwd: process.cwd(),
        explicitWorkspace: parsed.workspaceRoot,
      });
      service = await TaskDetailService.create(workspace);
      jobService = new JobService(workspace, service.getRepository(), { noTelemetry: parsed.noTelemetry });
      const commandRun = await jobService.startCommandRun("task-show", parsed.project);
      commandRunId = commandRun.id;
      const detail = await service.getTaskDetail({
        taskKey: parsed.taskKey,
        projectKey: parsed.project,
        includeLogs: parsed.includeLogs,
        includeHistory: parsed.includeHistory,
      });

      if (commandRunId) {
        await jobService.finishCommandRun(commandRunId, "succeeded");
      }

      if (parsed.format === "json") {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      if (parsed.format === "yaml") {
        // eslint-disable-next-line no-console
        console.error("Note: YAML output is experimental; table/json are the primary supported formats.");
        // eslint-disable-next-line no-console
        console.log(YAML.stringify(detail));
        return;
      }

      renderTable(detail);
    } catch (error) {
      if (jobService && commandRunId) {
        await jobService.finishCommandRun(commandRunId, "failed", (error as Error).message);
      }
      // eslint-disable-next-line no-console
      console.error(`task show failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      if (service) {
        await service.close();
      }
    }
  }
}
