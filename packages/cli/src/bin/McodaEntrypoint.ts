#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { GatewayAgentCommand } from "../commands/agents/GatewayAgentCommand.js";
import { DocsCommands } from "../commands/docs/DocsCommands.js";
import { JobsCommands } from "../commands/jobs/JobsCommands.js";
import { OpenapiCommands } from "../commands/openapi/OpenapiCommands.js";
import { CreateTasksCommand } from "../commands/planning/CreateTasksCommand.js";
import { RefineTasksCommand } from "../commands/planning/RefineTasksCommand.js";
import { TaskSufficiencyAuditCommand } from "../commands/planning/TaskSufficiencyAuditCommand.js";
import { BacklogCommands } from "../commands/backlog/BacklogCommands.js";
import { TaskShowCommands } from "../commands/backlog/TaskShowCommands.js";
import { OrderTasksCommand } from "../commands/backlog/OrderTasksCommand.js";
import { EstimateCommands } from "../commands/estimate/EstimateCommands.js";
import { TelemetryCommands } from "../commands/telemetry/TelemetryCommands.js";
import { WorkOnTasksCommand } from "../commands/work/WorkOnTasksCommand.js";
import { GatewayTrioCommand } from "../commands/work/GatewayTrioCommand.js";
import { AddTestsCommand } from "../commands/work/AddTestsCommand.js";
import { CodeReviewCommand } from "../commands/review/CodeReviewCommand.js";
import { QaTasksCommand } from "../commands/planning/QaTasksCommand.js";
import { MigrateTasksCommand } from "../commands/planning/MigrateTasksCommand.js";
import { UpdateCommands } from "../commands/update/UpdateCommands.js";
import { RoutingCommands } from "../commands/routing/RoutingCommands.js";
import { TestAgentCommand } from "../commands/agents/TestAgentCommand.js";
import { AgentRunCommand } from "../commands/agents/AgentRunCommand.js";
import { SetWorkspaceCommand } from "../commands/workspace/SetWorkspaceCommand.js";
import { ProjectGuidanceCommand } from "../commands/workspace/ProjectGuidanceCommand.js";

export class McodaEntrypoint {
  static async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    const applyCodexNoSandboxFlag = (value: string | undefined): void => {
      if (value === undefined || value === "") {
        process.env.MCODA_CODEX_NO_SANDBOX = "1";
        return;
      }
      const normalized = value.trim().toLowerCase();
      if (["0", "false", "off", "no"].includes(normalized)) {
        process.env.MCODA_CODEX_NO_SANDBOX = "0";
        return;
      }
      process.env.MCODA_CODEX_NO_SANDBOX = "1";
    };

    const filteredArgs: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--codex-no-sandbox") {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          applyCodexNoSandboxFlag(next);
          i += 1;
        } else {
          applyCodexNoSandboxFlag(undefined);
        }
        continue;
      }
      if (arg.startsWith("--codex-no-sandbox=")) {
        const [, raw] = arg.split("=", 2);
        applyCodexNoSandboxFlag(raw);
        continue;
      }
      filteredArgs.push(arg);
    }

    const [command, ...rest] = filteredArgs;
    const wantsJson = argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
    const wantsQuiet = argv.some((arg) => arg === "--quiet" || arg.startsWith("--quiet="));
    if (wantsJson || wantsQuiet) {
      process.env.MCODA_STREAM_IO = "0";
      process.env.MCODA_STREAM_IO_PROMPT = "0";
    } else if (process.env.MCODA_STREAM_IO === undefined) {
      process.env.MCODA_STREAM_IO = "0";
      if (process.env.MCODA_STREAM_IO_PROMPT === undefined) {
        process.env.MCODA_STREAM_IO_PROMPT = "0";
      }
    }
    if (command === "--version" || command === "-v" || command === "version") {
      // Keep this simple so `mcoda --version` works even in thin installs.
      // eslint-disable-next-line no-console
      console.log((packageJson as { version?: string }).version ?? "dev");
      return;
    }
    if (!command) {
      throw new Error(
        "Usage: mcoda <agent|gateway-agent|test-agent|agent-run|routing|docs|openapi|job|jobs|tokens|telemetry|create-tasks|migrate-tasks|refine-tasks|task-sufficiency-audit|order-tasks|tasks|add-tests|work-on-tasks|gateway-trio|code-review|qa-tasks|backlog|task|task-detail|estimate|update|set-workspace|project-guidance|pdr|sds> [...args]\n" +
          "Routing: use `mcoda routing defaults` to view/update workspace/global defaults, `mcoda routing preview|explain` to inspect agent selection/provenance (override → workspace_default → global_default).\n" +
          "Aliases: `tasks order-by-deps` forwards to `order-tasks` (dependency-aware ordering), `task`/`task-detail` show a single task.\n" +
          "Job commands (mcoda job --help for details): list|status|watch|logs|inspect|resume|cancel|tokens\n" +
          "Jobs API required for job commands (set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl). status/watch/logs exit non-zero on failed/cancelled jobs per SDS.",
      );
    }
    if (command === "agent") {
      await AgentsCommands.run(rest);
      return;
    }
    if (command === "gateway-agent") {
      await GatewayAgentCommand.run(rest);
      return;
    }
    if (command === "test-agent") {
      await TestAgentCommand.run(rest);
      return;
    }
    if (command === "agent-run") {
      await AgentRunCommand.run(rest);
      return;
    }
    if (command === "routing") {
      await RoutingCommands.run(rest);
      return;
    }
    if (command === "docs") {
      await DocsCommands.run(rest);
      return;
    }
    if (command === "openapi-from-docs" || command === "openapi") {
      await OpenapiCommands.run(rest);
      return;
    }
    if (command === "job" || command === "jobs") {
      await JobsCommands.run(rest);
      return;
    }
    if (command === "tokens") {
      await TelemetryCommands.runTokens(rest);
      return;
    }
    if (command === "telemetry") {
      await TelemetryCommands.runTelemetry(rest);
      return;
    }
    if (command === "pdr" || command === "mcoda:pdr") {
      await DocsCommands.run(["pdr", "generate", ...rest]);
      return;
    }
    if (command === "sds" || command === "mcoda:sds") {
      await DocsCommands.run(["sds", "generate", ...rest]);
      return;
    }
    if (command === "create-tasks") {
      await CreateTasksCommand.run(rest);
      return;
    }
    if (command === "migrate-tasks") {
      await MigrateTasksCommand.run(rest);
      return;
    }
    if (command === "refine-tasks") {
      await RefineTasksCommand.run(rest);
      return;
    }
    if (command === "task-sufficiency-audit") {
      await TaskSufficiencyAuditCommand.run(rest);
      return;
    }
    if (command === "qa-tasks") {
      if (rest.includes("--help") || rest.includes("-h")) {
        // eslint-disable-next-line no-console
        console.log(
          "Usage: mcoda qa-tasks [--workspace-root <path>] --project <PROJECT_KEY> [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] [--status <STATUS_FILTER>] [--limit N] [--mode auto|manual] [--profile <PROFILE_NAME>] [--level unit|integration|acceptance] [--test-command \"<CMD>\"] [--agent <NAME>] [--agent-stream true|false] [--resume <JOB_ID>] [--create-followup-tasks auto|none|prompt] [--result pass|fail] [--notes \"<text>\"] [--evidence-url \"<url>\"] [--dry-run] [--json]",
        );
        return;
      }
      await QaTasksCommand.run(rest);
      return;
    }
    if (command === "order-tasks") {
      await OrderTasksCommand.run(rest);
      return;
    }
    if (command === "tasks") {
      const [sub, ...tail] = rest;
      if (sub === "order-by-deps" || sub === "order-by-dependencies") {
        await OrderTasksCommand.run(tail);
        return;
      }
    }
    if (command === "work-on-tasks") {
      await WorkOnTasksCommand.run(rest);
      return;
    }
    if (command === "add-tests") {
      await AddTestsCommand.run(rest);
      return;
    }
    if (command === "gateway-trio") {
      await GatewayTrioCommand.run(rest);
      return;
    }
    if (command === "code-review") {
      await CodeReviewCommand.run(rest);
      return;
    }
    if (command === "backlog") {
      await BacklogCommands.run(rest);
      return;
    }
    if (command === "task" || command === "task-detail") {
      await TaskShowCommands.run(rest);
      return;
    }
    if (command === "estimate") {
      await EstimateCommands.run(rest);
      return;
    }
    if (command === "update") {
      await UpdateCommands.run(rest);
      return;
    }
    if (command === "set-workspace") {
      await SetWorkspaceCommand.run(rest);
      return;
    }
    if (command === "project-guidance") {
      await ProjectGuidanceCommand.run(rest);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  }
}

const isDirectRun = (() => {
  if (typeof process.argv[1] !== "string") {
    return false;
  }
  try {
    const invokedPath = realpathSync(process.argv[1]);
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return invokedPath === modulePath;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  McodaEntrypoint.run().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
