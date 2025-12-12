import path from "node:path";
import { TaskOrderingService, WorkspaceResolver } from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  epic?: string;
  status?: string[];
  includeBlocked: boolean;
  agentName?: string;
  agentStream?: boolean;
  json: boolean;
}

const usage = `mcoda order-tasks \\
  [--workspace-root <PATH>] \\
  --project <PROJECT_KEY> \\
  [--epic <EPIC_KEY>] \\
  [--status <STATUS_FILTER>] \\
  [--include-blocked] \\
  [--agent <NAME>] \\
  [--agent-stream <true|false>] \\
  [--json]`;

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

const parseStatuses = (value?: string): string[] | undefined => {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
};

export const parseOrderTasksArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    includeBlocked: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--status=")) {
      parsed.status = parseStatuses(arg.split("=")[1]);
      continue;
    }
    if (arg.startsWith("--agent-stream=")) {
      parsed.agentStream = parseBooleanFlag(arg.split("=")[1], true);
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
      case "--epic":
        parsed.epic = argv[i + 1];
        i += 1;
        break;
      case "--status":
        parsed.status = parseStatuses(argv[i + 1]);
        i += 1;
        break;
      case "--include-blocked":
        parsed.includeBlocked = true;
        break;
      case "--agent":
        parsed.agentName = argv[i + 1];
        i += 1;
        break;
      case "--agent-stream": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          parsed.agentStream = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.agentStream = true;
        }
        break;
      }
      case "--json":
        parsed.json = true;
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
        } else if (arg.startsWith("--epic=")) {
          parsed.epic = arg.split("=")[1];
        } else if (arg === "--include-blocked=true") {
          parsed.includeBlocked = true;
        } else if (arg === "--json=true") {
          parsed.json = true;
        }
        break;
    }
  }
  return parsed;
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const formatTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)));
  const headerLine = headers.map((h, idx) => pad(h, widths[idx])).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join(" | ")).join("\n");
  return [headerLine, sepLine, body].filter(Boolean).join("\n");
};

const formatImpact = (value?: { direct: number; total: number }): string => {
  if (!value) return "-";
  return `${value.direct}/${value.total}`;
};

const renderOrder = (
  ordered: Awaited<ReturnType<TaskOrderingService["orderTasks"]>>["ordered"],
  blocked: Awaited<ReturnType<TaskOrderingService["orderTasks"]>>["blocked"],
  includeBlocked: boolean,
  warnings: string[],
): void => {
  const rows = ordered.map((task) => [
    `${task.priority}`,
    task.taskKey,
    task.status,
    task.storyPoints === null || task.storyPoints === undefined ? "-" : `${task.storyPoints}`,
    task.epicKey,
    task.storyKey,
    formatImpact(task.dependencyImpact),
    task.blocked ? "yes" : "",
    task.title.length > 60 ? `${task.title.slice(0, 57)}...` : task.title,
  ]);

  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["PRIORITY", "TASK", "STATUS", "SP", "EPIC", "STORY", "DEP_IMPACT", "BLOCKED", "TITLE"],
      rows,
    ),
  );

  if (!includeBlocked && blocked.length > 0) {
    // eslint-disable-next-line no-console
    console.log("\nBlocked tasks (excluded from ordering):");
    const blockedRows = blocked.map((task) => [
      `${task.priority}`,
      task.taskKey,
      task.status,
      task.storyPoints === null || task.storyPoints === undefined ? "-" : `${task.storyPoints}`,
      task.epicKey,
      task.storyKey,
      formatImpact(task.dependencyImpact),
      (task.blockedBy ?? []).join(", "),
      task.title.length > 60 ? `${task.title.slice(0, 57)}...` : task.title,
    ]);
    // eslint-disable-next-line no-console
    console.log(
      formatTable(
        ["PRIORITY", "TASK", "STATUS", "SP", "EPIC", "STORY", "DEP_IMPACT", "BLOCKED_BY", "TITLE"],
        blockedRows,
      ),
    );
  }

  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("\nWarnings:");
    warnings.forEach((w) => {
      // eslint-disable-next-line no-console
      console.warn(`- ${w}`);
    });
  }
};

export class OrderTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseOrderTasksArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    if (!parsed.project) {
      // eslint-disable-next-line no-console
      console.error("order-tasks requires --project <PROJECT_KEY>");
      process.exitCode = 1;
      return;
    }
    const service = await TaskOrderingService.create(workspace);
    try {
      const result = await service.orderTasks({
        projectKey: parsed.project,
        epicKey: parsed.epic,
        statusFilter: parsed.status,
        includeBlocked: parsed.includeBlocked,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
      });
      if (parsed.json) {
        const payload: Record<string, unknown> = {
          order: parsed.includeBlocked ? result.ordered : result.ordered.filter((t) => !t.blocked),
        };
        if (result.warnings.length > 0) {
          payload.warnings = result.warnings;
        }
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      renderOrder(result.ordered, result.blocked, parsed.includeBlocked, result.warnings);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`order-tasks failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      try {
        await service.close();
      } catch {
        // ignore close errors (e.g., database already closed)
      }
    }
  }
}
