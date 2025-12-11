#!/usr/bin/env node
import packageJson from "../../package.json" with { type: "json" };
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { DocsCommands } from "../commands/docs/DocsCommands.js";
import { JobsCommands } from "../commands/jobs/JobsCommands.js";
import { OpenapiCommands } from "../commands/openapi/OpenapiCommands.js";
import { CreateTasksCommand } from "../commands/planning/CreateTasksCommand.js";
import { RefineTasksCommand } from "../commands/planning/RefineTasksCommand.js";
import { BacklogCommands } from "../commands/backlog/BacklogCommands.js";
import { TaskShowCommands } from "../commands/backlog/TaskShowCommands.js";
import { OrderTasksCommand } from "../commands/backlog/OrderTasksCommand.js";
import { EstimateCommands } from "../commands/estimate/EstimateCommands.js";
import { TelemetryCommands } from "../commands/telemetry/TelemetryCommands.js";
import { WorkOnTasksCommand } from "../commands/work/WorkOnTasksCommand.js";
import { CodeReviewCommand } from "../commands/review/CodeReviewCommand.js";
import { QaTasksCommand } from "../commands/planning/QaTasksCommand.js";
import { UpdateCommands } from "../commands/update/UpdateCommands.js";
import { RoutingCommands } from "../commands/routing/RoutingCommands.js";
import { TestAgentCommand } from "../commands/agents/TestAgentCommand.js";

export class McodaEntrypoint {
  static async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    const [command, ...rest] = argv;
    if (command === "--version" || command === "-v" || command === "version") {
      // Keep this simple so `mcoda --version` works even in thin installs.
      // eslint-disable-next-line no-console
      console.log((packageJson as { version?: string }).version ?? "dev");
      return;
    }
    if (!command) {
      throw new Error(
        "Usage: mcoda <agent|routing|docs|openapi|job|jobs|tokens|telemetry|create-tasks|refine-tasks|order-tasks|tasks|work-on-tasks|code-review|qa-tasks|backlog|task|task-detail|estimate|update|pdr|sds> [...args]\n" +
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
    if (command === "test-agent") {
      await TestAgentCommand.run(rest);
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
    if (command === "refine-tasks") {
      await RefineTasksCommand.run(rest);
      return;
    }
    if (command === "qa-tasks") {
      if (rest.includes("--help") || rest.includes("-h")) {
        // eslint-disable-next-line no-console
        console.log(
          "Usage: mcoda qa-tasks [--workspace-root <path>] --project <PROJECT_KEY> [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] [--status <STATUS_FILTER>] [--mode auto|manual] [--profile <PROFILE_NAME>] [--level unit|integration|acceptance] [--test-command \"<CMD>\"] [--agent <NAME>] [--agent-stream true|false] [--resume <JOB_ID>] [--create-followup-tasks auto|none|prompt] [--result pass|fail|blocked] [--notes \"<text>\"] [--evidence-url \"<url>\"] [--dry-run] [--json]",
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
    throw new Error(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("mcoda.js")) {
  McodaEntrypoint.run().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
