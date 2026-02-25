import path from "node:path";
import { TaskOrderingService, WorkspaceResolver, type TaskOrderingRequest } from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  epic?: string;
  story?: string;
  status?: string[];
  agentName?: string;
  agentStream?: boolean;
  rateAgents: boolean;
  inferDeps: boolean;
  apply: boolean;
  planningContextPolicy: "best_effort" | "require_any" | "require_sds_or_openapi";
  stageOrder?: string[];
  json: boolean;
}

const usage = `mcoda order-tasks \\
  [--workspace-root <PATH>] \\
  --project <PROJECT_KEY> \\
  [--epic <EPIC_KEY>] \\
  [--story <STORY_KEY>] \\
  [--status <STATUS_FILTER>] \\
  [--agent <NAME>] \\
  [--agent-stream <true|false>] \\
  [--infer-deps] \\
  [--apply <true|false>] \\
  [--planning-context-policy <best_effort|require_any|require_sds_or_openapi>] \\
  [--stage-order <foundation,backend,frontend,other>] \\
  [--rate-agents] \\
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
  const filtered = parts.map((s) => s.toLowerCase()).filter((s) => s !== "blocked");
  return filtered.length ? filtered : undefined;
};

const parseStageOrder = (value?: string): string[] | undefined => {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : undefined;
};

const normalizePlanningContextPolicy = (
  value?: string,
): ParsedArgs["planningContextPolicy"] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "best_effort" || normalized === "require_any" || normalized === "require_sds_or_openapi") {
    return normalized;
  }
  return undefined;
};

export const parseOrderTasksArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    agentStream: false,
    rateAgents: false,
    inferDeps: false,
    apply: true,
    planningContextPolicy: "require_sds_or_openapi",
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
    if (arg.startsWith("--rate-agents=")) {
      parsed.rateAgents = parseBooleanFlag(arg.split("=")[1], true);
      continue;
    }
    if (arg.startsWith("--infer-deps=")) {
      parsed.inferDeps = parseBooleanFlag(arg.split("=")[1], true);
      continue;
    }
    if (arg.startsWith("--apply=")) {
      parsed.apply = parseBooleanFlag(arg.split("=")[1], true);
      continue;
    }
    if (arg.startsWith("--stage-order=")) {
      parsed.stageOrder = parseStageOrder(arg.split("=")[1]);
      continue;
    }
    if (arg.startsWith("--planning-context-policy=")) {
      const policy = normalizePlanningContextPolicy(arg.split("=")[1]);
      if (policy) parsed.planningContextPolicy = policy;
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
      case "--story":
        parsed.story = argv[i + 1];
        i += 1;
        break;
      case "--status":
        parsed.status = parseStatuses(argv[i + 1]);
        i += 1;
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
      case "--infer-deps": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          parsed.inferDeps = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.inferDeps = true;
        }
        break;
      }
      case "--apply": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          parsed.apply = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.apply = true;
        }
        break;
      }
      case "--stage-order":
        parsed.stageOrder = parseStageOrder(argv[i + 1]);
        i += 1;
        break;
      case "--planning-context-policy": {
        const policy = normalizePlanningContextPolicy(argv[i + 1]);
        if (policy) {
          parsed.planningContextPolicy = policy;
        }
        i += 1;
        break;
      }
      case "--rate-agents": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          parsed.rateAgents = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.rateAgents = true;
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
        } else if (arg.startsWith("--story=")) {
          parsed.story = arg.split("=")[1];
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
    task.title.length > 60 ? `${task.title.slice(0, 57)}...` : task.title,
  ]);

  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["PRIORITY", "TASK", "STATUS", "SP", "EPIC", "STORY", "DEP_IMPACT", "TITLE"],
      rows,
    ),
  );

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
    if (parsed.inferDeps && !parsed.apply) {
      // eslint-disable-next-line no-console
      console.error("order-tasks requires --apply when --infer-deps is set");
      process.exitCode = 1;
      return;
    }
    const validStages = new Set(["foundation", "backend", "frontend", "other"]);
    const stageOrder = parsed.stageOrder?.filter((stage) => validStages.has(stage));
    const resolvedStageOrder =
      stageOrder && stageOrder.length > 0
        ? (stageOrder as TaskOrderingRequest["stageOrder"])
        : undefined;
    const service = await TaskOrderingService.create(workspace);
    try {
      const result = await service.orderTasks({
        projectKey: parsed.project,
        epicKey: parsed.epic,
        storyKey: parsed.story,
        statusFilter: parsed.status,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        inferDependencies: parsed.inferDeps,
        apply: parsed.apply,
        planningContextPolicy: parsed.planningContextPolicy,
        stageOrder: resolvedStageOrder,
      });
      if (parsed.json) {
        const payload: Record<string, unknown> = {
          order: result.ordered,
        };
        if (result.warnings.length > 0) {
          payload.warnings = result.warnings;
        }
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      renderOrder(result.ordered, result.warnings);
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
