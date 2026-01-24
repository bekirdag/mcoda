import path from "node:path";
import { BacklogService, BacklogSummary, WorkspaceResolver } from "@mcoda/core";
import { READY_TO_CODE_REVIEW, normalizeReviewStatuses } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  epic?: string;
  story?: string;
  assignee?: string;
  statuses?: string[];
  statusAll?: boolean;
  includeDone: boolean;
  includeCancelled: boolean;
  orderDependencies: boolean;
  view?: "summary" | "epics" | "stories" | "tasks";
  limit?: number;
  json: boolean;
  verbose: boolean;
}

const usage = `mcoda backlog \\
  [--workspace-root <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--epic <EPIC_KEY>] \\
  [--story <STORY_KEY>] \\
  [--assignee <USER>] \\
  [--status <STATUS_FILTER>] \\
  [--status all] \\
  [--include-done] \\
  [--include-cancelled] \\
  [--order dependencies]   # dependency-aware ordering (topological, most depended-on first) \\
  [--view summary|epics|stories|tasks] \\
  [--limit <N> | --top <N>] \\
  [--json] \\
  [--verbose]`;

const parseStatuses = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .filter((s) => s !== "blocked");
  return normalizeReviewStatuses(parsed);
};

export const parseBacklogArgs = (argv: string[]): ParsedArgs => {
  const args: ParsedArgs = {
    includeDone: false,
    includeCancelled: false,
    orderDependencies: false,
    json: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) continue;
    switch (arg) {
      case "--workspace-root":
        args.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        args.project = argv[i + 1];
        i += 1;
        break;
      case "--epic":
        args.epic = argv[i + 1];
        i += 1;
        break;
      case "--story":
        args.story = argv[i + 1];
        i += 1;
        break;
      case "--assignee":
        args.assignee = argv[i + 1];
        i += 1;
        break;
      case "--status": {
        const value = argv[i + 1];
        if (value && !value.startsWith("-")) {
          const parsedStatuses = parseStatuses(value);
          if (parsedStatuses?.includes("all")) {
            args.statusAll = true;
            args.statuses = undefined;
          } else {
            args.statuses = parsedStatuses;
          }
          i += 1;
        }
        break;
      }
      case "--include-done":
        args.includeDone = true;
        break;
      case "--include-cancelled":
        args.includeCancelled = true;
        break;
      default:
        if (arg.startsWith("--project=")) {
          args.project = arg.split("=")[1];
        } else if (arg.startsWith("--epic=")) {
          args.epic = arg.split("=")[1];
        } else if (arg.startsWith("--story=")) {
          args.story = arg.split("=")[1];
        } else if (arg.startsWith("--assignee=")) {
          args.assignee = arg.split("=")[1];
        } else if (arg.startsWith("--status=")) {
          const parsedStatuses = parseStatuses(arg.split("=")[1]);
          if (parsedStatuses?.includes("all")) {
            args.statusAll = true;
            args.statuses = undefined;
          } else {
            args.statuses = parsedStatuses;
          }
        } else if (arg === "--order") {
          const value = argv[i + 1];
          if (value === "dependencies") {
            args.orderDependencies = true;
            i += 1;
          }
        } else if (arg === "--order=dependencies") {
          args.orderDependencies = true;
        } else if (arg === "--include-done") {
          args.includeDone = true;
        } else if (arg === "--include-cancelled") {
          args.includeCancelled = true;
        } else if (arg === "--view") {
          const value = argv[i + 1];
          if (value === "summary" || value === "epics" || value === "stories" || value === "tasks") {
            args.view = value;
            i += 1;
          }
        } else if (arg.startsWith("--view=")) {
          const value = arg.split("=")[1];
          if (value === "summary" || value === "epics" || value === "stories" || value === "tasks") {
            args.view = value;
          }
        } else if (arg === "--limit" || arg === "--top") {
          const value = Number(argv[i + 1]);
          if (Number.isFinite(value) && value > 0) {
            args.limit = Math.floor(value);
            i += 1;
          }
        } else if (arg.startsWith("--limit=") || arg.startsWith("--top=")) {
          const value = Number(arg.split("=")[1]);
          if (Number.isFinite(value) && value > 0) {
            args.limit = Math.floor(value);
          }
        } else if (arg === "--json") {
          args.json = true;
        } else if (arg === "--verbose") {
          args.verbose = true;
        } else if (arg === "--help" || arg === "-h") {
          // eslint-disable-next-line no-console
          console.log(usage);
          process.exit(0);
        }
        break;
    }
  }

  return args;
};

const resolveStatuses = (parsed: ParsedArgs): string[] | undefined => {
  if (parsed.statusAll) return undefined;
  if (parsed.statuses && parsed.statuses.length > 0) return parsed.statuses;
  const active = normalizeReviewStatuses(["not_started", "in_progress", READY_TO_CODE_REVIEW, "ready_to_qa"]);
  if (parsed.includeDone) active.push("completed");
  if (parsed.includeCancelled) active.push("cancelled");
  return active;
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const formatTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, idx) => {
    return Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length));
  });
  const headerLine = headers.map((h, idx) => pad(h, widths[idx])).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join(" | ")).join("\n");
  return [headerLine, sepLine, body].filter(Boolean).join("\n");
};

const truncate = (value: string | undefined, max = 100): string => {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
};

const formatNumber = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "-";
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(2);
};

const renderScope = (parts: { label: string; value?: string | number }[]): void => {
  const entries = parts
    .filter((part) => part.value !== undefined && part.value !== "")
    .map((part) => `${part.label}=${part.value}`);
  if (entries.length === 0) return;
  // eslint-disable-next-line no-console
  console.log(`Scope: ${entries.join(", ")}`);
};

const renderSummary = (summary: BacklogSummary): void => {
  const rows = [
    ["Implementation", `${summary.totals.implementation.tasks}`, formatNumber(summary.totals.implementation.story_points)],
    ["Review", `${summary.totals.review.tasks}`, formatNumber(summary.totals.review.story_points)],
    ["QA", `${summary.totals.qa.tasks}`, formatNumber(summary.totals.qa.story_points)],
    ["Done", `${summary.totals.done.tasks}`, formatNumber(summary.totals.done.story_points)],
  ];
  // eslint-disable-next-line no-console
  console.log("Summary (tasks / SP):");
  // eslint-disable-next-line no-console
  console.log(formatTable(["LANE", "TASKS", "SP"], rows));
};

const renderEpics = (summary: BacklogSummary, limit?: number): void => {
  const epics = limit ? summary.epics.slice(0, limit) : summary.epics;
  if (epics.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nEpics: none");
    return;
  }
  const rows = epics.map((epic) => [
    epic.epic_key,
    truncate(epic.title, 40),
    formatNumber(epic.priority),
    formatNumber(epic.totals.implementation.story_points),
    formatNumber(epic.totals.review.story_points),
    formatNumber(epic.totals.qa.story_points),
    formatNumber(epic.totals.done.story_points),
    `${epic.totals.implementation.tasks + epic.totals.review.tasks + epic.totals.qa.tasks + epic.totals.done.tasks}`,
    truncate(epic.description, 100),
  ]);
  // eslint-disable-next-line no-console
  console.log("\nEpics:");
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["EPIC_KEY", "TITLE", "PRIORITY", "IMPL_SP", "REVIEW_SP", "QA_SP", "DONE_SP", "TASKS", "DESC"],
      rows,
    ),
  );
};

const renderStories = (summary: BacklogSummary, limit?: number): void => {
  const stories = summary.epics.flatMap((epic) => epic.stories);
  const limited = limit ? stories.slice(0, limit) : stories;
  if (limited.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nStories: none");
    return;
  }
  const rows = limited.map((story) => [
    story.user_story_key,
    story.epic_key,
    truncate(story.title, 40),
    formatNumber(story.priority),
    story.status ?? "-",
    formatNumber(story.totals.implementation.story_points),
    formatNumber(story.totals.review.story_points),
    formatNumber(story.totals.qa.story_points),
    formatNumber(story.totals.done.story_points),
    `${story.totals.implementation.tasks + story.totals.review.tasks + story.totals.qa.tasks + story.totals.done.tasks}`,
    truncate(story.description, 100),
  ]);
  // eslint-disable-next-line no-console
  console.log("\nStories:");
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["STORY_KEY", "EPIC_KEY", "TITLE", "PRIORITY", "STATUS", "IMPL_SP", "REVIEW_SP", "QA_SP", "DONE_SP", "TASKS", "DESC"],
      rows,
    ),
  );
};

const renderTasks = (summary: BacklogSummary, options: { limit?: number; verbose?: boolean }): void => {
  const tasks = options.limit ? summary.tasks.slice(0, options.limit) : summary.tasks;
  if (tasks.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nTasks: none");
    return;
  }
  const rows = tasks.map((task) => {
    const base = [
      task.task_key,
      task.epic_key,
      task.user_story_key,
      truncate(task.title, 40),
      task.status,
      formatNumber(task.story_points),
      formatNumber(task.priority),
      task.assignee ?? "-",
      truncate(task.dependency_keys.join(", "), 80),
    ];
    if (options.verbose) {
      base.push(truncate(task.description, 100));
    }
    return base;
  });
  const columns = ["TASK_KEY", "EPIC_KEY", "STORY_KEY", "TITLE", "STATUS", "SP", "PRIORITY", "ASSIGNEE", "DEPENDS_ON"];
  if (options.verbose) {
    columns.push("DESC");
  }
  // eslint-disable-next-line no-console
  console.log("\nTasks:");
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      columns,
      rows as string[][],
    ),
  );
};

const renderBacklog = (
  summary: BacklogSummary,
  options: { view?: ParsedArgs["view"]; limit?: number; verbose?: boolean },
): void => {
  const shouldRender = (section: ParsedArgs["view"]) => !options.view || options.view === section;
  if (shouldRender("summary")) {
    renderSummary(summary);
  }
  if (shouldRender("epics")) {
    renderEpics(summary, options.limit);
  }
  if (shouldRender("stories")) {
    renderStories(summary, options.limit);
  }
  if (shouldRender("tasks")) {
    renderTasks(summary, { limit: options.limit, verbose: options.verbose });
  }
};

export class BacklogCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseBacklogArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    let service: BacklogService | undefined;
    try {
      service = await BacklogService.create(workspace);
      const statuses = resolveStatuses(parsed);
      const { summary, warnings, meta } = await service.getBacklog({
        projectKey: parsed.project,
        epicKey: parsed.epic,
        storyKey: parsed.story,
        assignee: parsed.assignee,
        statuses,
        orderByDependencies: parsed.orderDependencies,
        verbose: parsed.verbose,
      });

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ summary, warnings, meta }, null, 2));
      } else {
        const statusLabel = parsed.statusAll
          ? "all"
          : statuses?.length
            ? statuses.join(",")
            : "all";
        renderScope([
          { label: "project", value: parsed.project ?? "all" },
          { label: "epic", value: parsed.epic },
          { label: "story", value: parsed.story },
          { label: "assignee", value: parsed.assignee },
          { label: "status", value: statusLabel },
          { label: "order", value: parsed.orderDependencies ? "dependencies" : "default" },
          { label: "view", value: parsed.view ?? "all" },
          { label: "limit", value: parsed.limit },
        ]);
        renderBacklog(summary, { view: parsed.view, limit: parsed.limit, verbose: parsed.verbose });
        if (warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.error("\nWarnings:");
          for (const warning of warnings) {
            // eslint-disable-next-line no-console
            console.error(`- ${warning}`);
          }
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`backlog failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      if (service) {
        await service.close();
      }
    }
  }
}
