import path from "node:path";
import { QaTasksApi, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  taskKeys: string[];
  epicKey?: string;
  storyKey?: string;
  statusFilter: string[];
  mode: "auto" | "manual";
  profileName?: string;
  level?: string;
  testCommand?: string;
  agentName?: string;
  agentStream: boolean;
  rateAgents: boolean;
  createFollowupTasks: "auto" | "none" | "prompt";
  dryRun: boolean;
  json: boolean;
  debug: boolean;
  noTelemetry: boolean;
  resumeJobId?: string;
  result?: "pass" | "fail" | "blocked";
  notes?: string;
  evidenceUrl?: string;
  allowDirty: boolean;
  quiet?: boolean;
}

const usage = `mcoda qa-tasks [--workspace-root <path>] --project <PROJECT_KEY> [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] [--status <STATUS_FILTER>] [--mode auto|manual] [--profile <PROFILE_NAME>] [--level unit|integration|acceptance] [--test-command "<CMD>"] [--agent <NAME>] [--agent-stream true|false] [--rate-agents] [--create-followup-tasks auto|none|prompt] [--result pass|fail|blocked] [--notes "<text>"] [--evidence-url "<url>"] [--resume <JOB_ID>] [--allow-dirty true|false] [--dry-run] [--json]`;

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseQaTasksArgs = (argv: string[]): ParsedArgs => {
  const tasks: string[] = [];
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  let statusFilter: string[] = ["ready_to_qa"];
  let mode: "auto" | "manual" = "auto";
  let profileName: string | undefined;
  let level: string | undefined;
  let testCommand: string | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let rateAgents = false;
  let followups: "auto" | "none" | "prompt" = "auto";
  let dryRun = false;
  let json = false;
  let debug = false;
  let noTelemetry = false;
  let resumeJobId: string | undefined;
  let allowDirty = false;
  let result: "pass" | "fail" | "blocked" | undefined;
  let notes: string | undefined;
  let evidenceUrl: string | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (arg.startsWith("--rate-agents=")) {
        const [, raw] = arg.split("=", 2);
        rateAgents = parseBooleanFlag(raw, true);
        continue;
      }
      switch (arg) {
        case "--workspace-root":
          workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
          i += 1;
          break;
        case "--project":
          projectKey = argv[i + 1];
          i += 1;
          break;
        case "--task":
          if (argv[i + 1]) tasks.push(argv[i + 1]);
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
        case "--status":
          statusFilter =
            argv[i + 1] && !argv[i + 1].startsWith("--")
              ? argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean)
              : statusFilter;
          i += 1;
          break;
        case "--mode":
          mode = (argv[i + 1] as any) === "manual" ? "manual" : "auto";
          i += 1;
          break;
        case "--profile":
          profileName = argv[i + 1];
          i += 1;
          break;
        case "--level":
          level = argv[i + 1];
          i += 1;
          break;
        case "--test-command":
          testCommand = argv[i + 1];
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
        case "--create-followup-tasks":
          followups = (argv[i + 1] as any) ?? "auto";
          i += 1;
          break;
        case "--dry-run":
          dryRun = true;
          break;
        case "--json":
          json = true;
          break;
        case "--debug":
          debug = true;
          break;
        case "--no-telemetry":
          noTelemetry = true;
          break;
        case "--resume":
          resumeJobId = argv[i + 1];
          i += 1;
          break;
        case "--allow-dirty":
          allowDirty = parseBooleanFlag(argv[i + 1], allowDirty);
          i += 1;
          break;
        case "--result":
          result = argv[i + 1] as any;
          i += 1;
          break;
        case "--notes":
          notes = argv[i + 1];
          i += 1;
          break;
        case "--evidence-url":
          evidenceUrl = argv[i + 1];
          i += 1;
          break;
        case "--quiet":
          quiet = true;
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
  }

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys: tasks,
    statusFilter,
    mode,
    profileName,
    level,
    testCommand,
    agentName,
    agentStream: agentStream ?? true,
    rateAgents,
    createFollowupTasks: followups,
    dryRun,
    json,
    debug,
    noTelemetry,
    resumeJobId,
    allowDirty,
    result,
    notes,
    evidenceUrl,
    quiet,
  };
};

export class QaTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseQaTasksArgs(argv);
    if (parsed.taskKeys.length && (parsed.epicKey || parsed.storyKey)) {
      // eslint-disable-next-line no-console
      console.error("Use either --task or --epic/--story, not both.");
      process.exitCode = 1;
      return;
    }
    if (parsed.mode === "manual" && !parsed.result) {
      // eslint-disable-next-line no-console
      console.error("--mode manual requires --result <pass|fail|blocked>.");
      process.exitCode = 1;
      return;
    }
    if (parsed.mode === "manual" && parsed.result && parsed.result !== "pass" && !parsed.notes && !parsed.evidenceUrl) {
      // eslint-disable-next-line no-console
      console.error("--mode manual with fail/blocked requires --notes or --evidence-url.");
      process.exitCode = 1;
      return;
    }
    const followupMode =
      parsed.createFollowupTasks === "prompt" && !process.stdout.isTTY ? "auto" : parsed.createFollowupTasks;
    if (parsed.createFollowupTasks === "prompt" && !process.stdout.isTTY && !parsed.quiet && !parsed.json) {
      // eslint-disable-next-line no-console
      console.warn("Non-interactive environment; treating --create-followup-tasks=prompt as auto.");
    }
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const derivedKey = path.basename(workspace.workspaceRoot).replace(/[^a-z0-9]+/gi, "").toLowerCase();
    const projectKey = parsed.projectKey ?? (derivedKey || undefined);
    if (!projectKey) {
      // eslint-disable-next-line no-console
      console.error("--project is required for qa-tasks.");
      process.exitCode = 1;
      return;
    }
    try {
      const result = await QaTasksApi.runQa({
        workspaceRoot: workspace.workspaceRoot,
        projectKey,
        taskKeys: parsed.taskKeys,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        statusFilter: parsed.statusFilter,
        mode: parsed.mode,
        resumeJobId: parsed.resumeJobId,
        profileName: parsed.profileName,
        level: parsed.level,
        testCommand: parsed.testCommand,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        createFollowupTasks: followupMode,
        dryRun: parsed.dryRun,
        result: parsed.result,
        notes: parsed.notes,
        evidenceUrl: parsed.evidenceUrl,
        allowDirty: parsed.allowDirty,
        noTelemetry: parsed.noTelemetry,
      });

      if (parsed.debug && !parsed.json && !parsed.quiet) {
        // eslint-disable-next-line no-console
        console.log("[debug] options", {
          projectKey,
          tasks: parsed.taskKeys,
          epicKey: parsed.epicKey,
          storyKey: parsed.storyKey,
          mode: parsed.mode,
          profile: parsed.profileName,
          level: parsed.level,
          testCommand: parsed.testCommand,
          followups: followupMode,
          dryRun: parsed.dryRun,
          noTelemetry: parsed.noTelemetry,
        });
      }

      if (parsed.json) {
        const payload = {
          jobId: result.jobId,
          commandRunId: result.commandRunId,
          results: result.results,
          warnings: result.warnings,
        };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (parsed.quiet) return;

      const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
      const lines = [
        `QA run complete.`,
        `  Job ID: ${result.jobId}`,
        `  Command Run: ${result.commandRunId}`,
        `  Workspace DB: ${dbPath}`,
      ];
      if (result.warnings.length) {
        lines.push(`  Warnings: ${result.warnings.join("; ")}`);
      }
      lines.push("Results:");
      for (const r of result.results) {
        const bits = [
          `${r.taskKey}: ${r.outcome}`,
          r.profile ? `profile=${r.profile}` : "",
          r.runner ? `runner=${r.runner}` : "",
        ].filter(Boolean);
        if (r.followups?.length) bits.push(`follow-ups=${r.followups.join(",")}`);
        if (r.artifacts?.length) bits.push(`artifacts=${r.artifacts.join(",")}`);
        lines.push(`- ${bits.join(" | ")}`);
        if (r.notes) {
          lines.push(`  notes: ${r.notes}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`qa-tasks failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}
