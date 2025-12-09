import path from "node:path";
import { BacklogService, BacklogSummary, WorkspaceResolver } from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  epic?: string;
  story?: string;
  assignee?: string;
  statuses?: string[];
  orderDependencies: boolean;
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
  [--order dependencies] \\
  [--json] \\
  [--verbose]`;

const parseStatuses = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
};

export const parseBacklogArgs = (argv: string[]): ParsedArgs => {
  const args: ParsedArgs = {
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
          args.statuses = parseStatuses(value);
          i += 1;
        }
        break;
      }
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
          args.statuses = parseStatuses(arg.split("=")[1]);
        } else if (arg === "--order") {
          const value = argv[i + 1];
          if (value === "dependencies") {
            args.orderDependencies = true;
            i += 1;
          }
        } else if (arg === "--order=dependencies") {
          args.orderDependencies = true;
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

const renderEpics = (summary: BacklogSummary): void => {
  if (summary.epics.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nEpics: none");
    return;
  }
  const rows = summary.epics.map((epic) => [
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

const renderStories = (summary: BacklogSummary): void => {
  const stories = summary.epics.flatMap((epic) => epic.stories);
  if (stories.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nStories: none");
    return;
  }
  const rows = stories.map((story) => [
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

const renderTasks = (summary: BacklogSummary): void => {
  if (summary.tasks.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nTasks: none");
    return;
  }
  const rows = summary.tasks.map((task) => [
    task.task_key,
    task.epic_key,
    task.user_story_key,
    task.status,
    formatNumber(task.story_points),
    formatNumber(task.priority),
    task.assignee ?? "-",
    truncate(task.dependency_keys.join(", "), 80),
    truncate(task.description, 100),
  ]);
  // eslint-disable-next-line no-console
  console.log("\nTasks:");
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["TASK_KEY", "EPIC_KEY", "STORY_KEY", "STATUS", "SP", "PRIORITY", "ASSIGNEE", "DEPENDS_ON", "DESC"],
      rows,
    ),
  );
};

const renderBacklog = (summary: BacklogSummary): void => {
  renderSummary(summary);
  renderEpics(summary);
  renderStories(summary);
  renderTasks(summary);
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
      const { summary, warnings } = await service.getBacklog({
        projectKey: parsed.project,
        epicKey: parsed.epic,
        storyKey: parsed.story,
        assignee: parsed.assignee,
        statuses: parsed.statuses,
        orderByDependencies: parsed.orderDependencies,
        verbose: parsed.verbose,
      });

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(summary, null, 2));
      } else {
        renderBacklog(summary);
        if (parsed.verbose && warnings.length > 0) {
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
