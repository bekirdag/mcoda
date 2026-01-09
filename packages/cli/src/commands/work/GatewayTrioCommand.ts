import path from "node:path";
import { GatewayTrioService, WorkspaceResolver } from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  limit?: number;
  maxIterations?: number;
  maxCycles?: number;
  gatewayAgentName?: string;
  workAgentName?: string;
  reviewAgentName?: string;
  qaAgentName?: string;
  maxDocs?: number;
  noCommit: boolean;
  dryRun: boolean;
  agentStream?: boolean;
  reviewBase?: string;
  qaProfileName?: string;
  qaLevel?: string;
  qaTestCommand?: string;
  qaMode: "auto" | "manual";
  qaFollowups: "auto" | "none" | "prompt";
  resumeJobId?: string;
  rateAgents: boolean;
  json: boolean;
  errors: string[];
}

const usage = `mcoda gateway-trio \\
  [--workspace-root <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \\
  [--status <CSV>] \\
  [--limit N] \\
  [--max-iterations N] \\
  [--max-cycles N] \\
  [--gateway-agent <NAME>] \\
  [--work-agent <NAME>] \\
  [--review-agent <NAME>] \\
  [--qa-agent <NAME>] \\
  [--max-docs N] \\
  [--no-commit] \\
  [--dry-run] \\
  [--review-base <BRANCH>] \\
  [--qa-profile <NAME>] \\
  [--qa-level <LEVEL>] \\
  [--qa-test-command "<CMD>"] \\
  [--qa-mode auto|manual] \\
  [--qa-followups auto|none|prompt] \\
  [--agent-stream <true|false>] \\
  [--rate-agents] \\
  [--resume <JOB_ID>] \\
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

const takeValue = (
  flag: string,
  argv: string[],
  index: number,
  errors: string[],
): { value: string | undefined; consumed: boolean } => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    errors.push(`gateway-trio: ${flag} requires a value`);
    return { value: undefined, consumed: false };
  }
  return { value, consumed: true };
};

const parseNumber = (flag: string, raw: string | undefined, errors: string[]): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    errors.push(`gateway-trio: ${flag} requires a number`);
    return undefined;
  }
  return parsed;
};

const normalizeQaMode = (value: string | undefined): "auto" | "manual" => (value === "manual" ? "manual" : "auto");

const normalizeQaFollowups = (value: string | undefined): "auto" | "none" | "prompt" => {
  if (value === "none" || value === "prompt" || value === "auto") return value;
  return "auto";
};

export const parseGatewayTrioArgs = (argv: string[]): ParsedArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  const taskKeys: string[] = [];
  const statusFilter: string[] = [];
  let limit: number | undefined;
  let maxIterations: number | undefined;
  let maxCycles: number | undefined;
  let gatewayAgentName: string | undefined;
  let workAgentName: string | undefined;
  let reviewAgentName: string | undefined;
  let qaAgentName: string | undefined;
  let maxDocs: number | undefined;
  let noCommit = false;
  let dryRun = false;
  let agentStream: boolean | undefined;
  let reviewBase: string | undefined;
  let qaProfileName: string | undefined;
  let qaLevel: string | undefined;
  let qaTestCommand: string | undefined;
  let qaMode: "auto" | "manual" = "auto";
  let qaFollowups: "auto" | "none" | "prompt" = "auto";
  let resumeJobId: string | undefined;
  let rateAgents = false;
  let json = false;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--status=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --status requires a value");
      } else {
        statusFilter.push(...parseCsv(raw));
      }
      continue;
    }
    if (arg.startsWith("--task=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --task requires a value");
      } else {
        taskKeys.push(raw);
      }
      continue;
    }
    if (arg.startsWith("--agent-stream=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --agent-stream requires a value");
      } else {
        agentStream = parseBooleanFlag(raw, true);
      }
      continue;
    }
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--gateway-agent=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --gateway-agent requires a value");
      } else {
        gatewayAgentName = value;
      }
      continue;
    }
    if (arg.startsWith("--work-agent=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --work-agent requires a value");
      } else {
        workAgentName = value;
      }
      continue;
    }
    if (arg.startsWith("--review-agent=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --review-agent requires a value");
      } else {
        reviewAgentName = value;
      }
      continue;
    }
    if (arg.startsWith("--qa-agent=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --qa-agent requires a value");
      } else {
        qaAgentName = value;
      }
      continue;
    }
    if (arg.startsWith("--max-docs=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --max-docs requires a value");
      } else {
        maxDocs = parseNumber("--max-docs", raw, errors);
      }
      continue;
    }
    if (arg.startsWith("--review-base=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --review-base requires a value");
      } else {
        reviewBase = value;
      }
      continue;
    }
    if (arg.startsWith("--qa-profile=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --qa-profile requires a value");
      } else {
        qaProfileName = value;
      }
      continue;
    }
    if (arg.startsWith("--qa-level=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --qa-level requires a value");
      } else {
        qaLevel = value;
      }
      continue;
    }
    if (arg.startsWith("--qa-test-command=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --qa-test-command requires a value");
      } else {
        qaTestCommand = value;
      }
      continue;
    }
    if (arg.startsWith("--qa-mode=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --qa-mode requires a value");
      } else {
        if (raw !== "auto" && raw !== "manual") {
          errors.push("gateway-trio: --qa-mode must be auto|manual");
        }
        qaMode = normalizeQaMode(raw);
      }
      continue;
    }
    if (arg.startsWith("--qa-followups=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --qa-followups requires a value");
      } else {
        if (!["auto", "none", "prompt"].includes(raw)) {
          errors.push("gateway-trio: --qa-followups must be auto|none|prompt");
        }
        qaFollowups = normalizeQaFollowups(raw);
      }
      continue;
    }
    if (arg.startsWith("--max-iterations=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --max-iterations requires a value");
      } else {
        maxIterations = parseNumber("--max-iterations", raw, errors);
      }
      continue;
    }
    if (arg.startsWith("--max-cycles=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --max-cycles requires a value");
      } else {
        maxCycles = parseNumber("--max-cycles", raw, errors);
      }
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const [, raw] = arg.split("=", 2);
      if (!raw) {
        errors.push("gateway-trio: --limit requires a value");
      } else {
        limit = parseNumber("--limit", raw, errors);
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const value = arg.split("=", 2)[1];
      if (!value) {
        errors.push("gateway-trio: --resume requires a value");
      } else {
        resumeJobId = value;
      }
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        {
          const { value, consumed } = takeValue("--workspace-root", argv, i, errors);
          if (value) workspaceRoot = path.resolve(value);
          if (consumed) i += 1;
        }
        break;
      case "--project":
      case "--project-key":
        {
          const { value, consumed } = takeValue("--project", argv, i, errors);
          if (value) projectKey = value;
          if (consumed) i += 1;
        }
        break;
      case "--status":
        {
          const { value, consumed } = takeValue("--status", argv, i, errors);
          if (value) statusFilter.push(...parseCsv(value));
          if (consumed) i += 1;
        }
        break;
      case "--epic":
        {
          const { value, consumed } = takeValue("--epic", argv, i, errors);
          if (value) epicKey = value;
          if (consumed) i += 1;
        }
        break;
      case "--story":
        {
          const { value, consumed } = takeValue("--story", argv, i, errors);
          if (value) storyKey = value;
          if (consumed) i += 1;
        }
        break;
      case "--task":
        {
          const { value, consumed } = takeValue("--task", argv, i, errors);
          if (value) taskKeys.push(value);
          if (consumed) i += 1;
        }
        break;
      case "--limit":
        {
          const { value, consumed } = takeValue("--limit", argv, i, errors);
          limit = parseNumber("--limit", value, errors);
          if (consumed) i += 1;
        }
        break;
      case "--max-iterations":
        {
          const { value, consumed } = takeValue("--max-iterations", argv, i, errors);
          maxIterations = parseNumber("--max-iterations", value, errors);
          if (consumed) i += 1;
        }
        break;
      case "--max-cycles":
        {
          const { value, consumed } = takeValue("--max-cycles", argv, i, errors);
          maxCycles = parseNumber("--max-cycles", value, errors);
          if (consumed) i += 1;
        }
        break;
      case "--gateway-agent":
        {
          const { value, consumed } = takeValue("--gateway-agent", argv, i, errors);
          if (value) gatewayAgentName = value;
          if (consumed) i += 1;
        }
        break;
      case "--work-agent":
        {
          const { value, consumed } = takeValue("--work-agent", argv, i, errors);
          if (value) workAgentName = value;
          if (consumed) i += 1;
        }
        break;
      case "--review-agent":
        {
          const { value, consumed } = takeValue("--review-agent", argv, i, errors);
          if (value) reviewAgentName = value;
          if (consumed) i += 1;
        }
        break;
      case "--qa-agent":
        {
          const { value, consumed } = takeValue("--qa-agent", argv, i, errors);
          if (value) qaAgentName = value;
          if (consumed) i += 1;
        }
        break;
      case "--max-docs":
        {
          const { value, consumed } = takeValue("--max-docs", argv, i, errors);
          maxDocs = parseNumber("--max-docs", value, errors);
          if (consumed) i += 1;
        }
        break;
      case "--no-commit":
        noCommit = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--review-base":
        {
          const { value, consumed } = takeValue("--review-base", argv, i, errors);
          if (value) reviewBase = value;
          if (consumed) i += 1;
        }
        break;
      case "--qa-profile":
        {
          const { value, consumed } = takeValue("--qa-profile", argv, i, errors);
          if (value) qaProfileName = value;
          if (consumed) i += 1;
        }
        break;
      case "--qa-level":
        {
          const { value, consumed } = takeValue("--qa-level", argv, i, errors);
          if (value) qaLevel = value;
          if (consumed) i += 1;
        }
        break;
      case "--qa-test-command":
        {
          const { value, consumed } = takeValue("--qa-test-command", argv, i, errors);
          if (value) qaTestCommand = value;
          if (consumed) i += 1;
        }
        break;
      case "--qa-mode":
        {
          const { value, consumed } = takeValue("--qa-mode", argv, i, errors);
          if (value && value !== "auto" && value !== "manual") {
            errors.push("gateway-trio: --qa-mode must be auto|manual");
          }
          qaMode = normalizeQaMode(value);
          if (consumed) i += 1;
        }
        break;
      case "--qa-followups":
        {
          const { value, consumed } = takeValue("--qa-followups", argv, i, errors);
          if (value && !["auto", "none", "prompt"].includes(value)) {
            errors.push("gateway-trio: --qa-followups must be auto|none|prompt");
          }
          qaFollowups = normalizeQaFollowups(value);
          if (consumed) i += 1;
        }
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
      case "--resume":
        {
          const { value, consumed } = takeValue("--resume", argv, i, errors);
          if (value) resumeJobId = value;
          if (consumed) i += 1;
        }
        break;
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
    statusFilter.push("not_started", "in_progress", "ready_to_review", "ready_to_qa");
  }

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys,
    statusFilter,
    limit: Number.isFinite(limit) ? limit : undefined,
    maxIterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
    maxCycles: Number.isFinite(maxCycles) ? maxCycles : undefined,
    gatewayAgentName,
    workAgentName,
    reviewAgentName,
    qaAgentName,
    maxDocs: Number.isFinite(maxDocs) ? maxDocs : undefined,
    noCommit,
    dryRun,
    agentStream: agentStream ?? true,
    reviewBase,
    qaProfileName,
    qaLevel,
    qaTestCommand,
    qaMode,
    qaFollowups,
    resumeJobId,
    rateAgents,
    json,
    errors,
  };
};

export const validateGatewayTrioArgs = (parsed: ParsedArgs): string | undefined => {
  if (parsed.errors.length) {
    return parsed.errors.join("; ");
  }
  const selectors = [
    parsed.taskKeys.length ? "task" : undefined,
    parsed.epicKey ? "epic" : undefined,
    parsed.storyKey ? "story" : undefined,
  ].filter(Boolean);
  if (selectors.length > 1) {
    return "gateway-trio: choose only one of --task, --epic, or --story";
  }
  return undefined;
};

export class GatewayTrioCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseGatewayTrioArgs(argv);
    const validationError = validateGatewayTrioArgs(parsed);
    if (validationError) {
      // eslint-disable-next-line no-console
      console.error(validationError);
      process.exitCode = 1;
      return;
    }
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const service = await GatewayTrioService.create(workspace);
    try {
      const result = await service.run({
        workspace,
        projectKey: parsed.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        limit: parsed.limit,
        maxIterations: parsed.maxIterations,
        maxCycles: parsed.maxCycles,
        gatewayAgentName: parsed.gatewayAgentName,
        workAgentName: parsed.workAgentName,
        reviewAgentName: parsed.reviewAgentName,
        qaAgentName: parsed.qaAgentName,
        maxDocs: parsed.maxDocs,
        noCommit: parsed.noCommit,
        dryRun: parsed.dryRun,
        agentStream: parsed.agentStream,
        reviewBase: parsed.reviewBase,
        qaProfileName: parsed.qaProfileName,
        qaLevel: parsed.qaLevel,
        qaTestCommand: parsed.qaTestCommand,
        qaMode: parsed.qaMode,
        qaFollowups: parsed.qaFollowups,
        resumeJobId: parsed.resumeJobId,
        rateAgents: parsed.rateAgents,
      });

      const counts = result.tasks.reduce(
        (acc, task) => {
          acc.total += 1;
          acc[task.status] = (acc[task.status] ?? 0) + 1;
          return acc;
        },
        {
          total: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          skipped: 0,
          pending: 0,
        } as Record<string, number>,
      );
      const incomplete = counts.total - counts.completed;
      if (incomplete > 0) {
        process.exitCode = 1;
      }

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              jobId: result.jobId,
              commandRunId: result.commandRunId,
              tasks: result.tasks,
              summary: {
                total: counts.total,
                completed: counts.completed,
                blocked: counts.blocked,
                failed: counts.failed,
                skipped: counts.skipped,
                pending: counts.pending,
              },
              blocked: result.blocked,
              failed: result.failed,
              skipped: result.skipped,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      const header = `Job: ${result.jobId}, Command Run: ${result.commandRunId}`;
      const summary = `Tasks: ${counts.total} (completed=${counts.completed}, blocked=${counts.blocked}, failed=${counts.failed}, skipped=${counts.skipped}, pending=${counts.pending})`;
      const taskLines = result.tasks.map((task) => {
        const details = [
          `status=${task.status}`,
          `attempts=${task.attempts}`,
          task.lastDecision ? `review=${task.lastDecision}` : undefined,
          task.lastOutcome ? `qa=${task.lastOutcome}` : undefined,
          task.lastError ? `error=${task.lastError}` : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return `${task.taskKey}: ${details}`;
      });
      const output = [header, summary, ...taskLines].join("\n");
      // eslint-disable-next-line no-console
      console.log(output);
      if (result.warnings.length) {
        // eslint-disable-next-line no-console
        console.warn(result.warnings.map((warning) => `! ${warning}`).join("\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`gateway-trio failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
