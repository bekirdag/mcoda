#!/usr/bin/env node
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { DocsCommands } from "../commands/docs/DocsCommands.js";
import { JobsCommands } from "../commands/jobs/JobsCommands.js";
import { OpenapiCommands } from "../commands/openapi/OpenapiCommands.js";
import { CreateTasksCommand } from "../commands/planning/CreateTasksCommand.js";
import { RefineTasksCommand } from "../commands/planning/RefineTasksCommand.js";
import { BacklogCommands } from "../commands/backlog/BacklogCommands.js";
import { TaskShowCommands } from "../commands/backlog/TaskShowCommands.js";
import { EstimateCommands } from "../commands/estimate/EstimateCommands.js";
import { TelemetryCommands } from "../commands/telemetry/TelemetryCommands.js";
import { WorkOnTasksCommand } from "../commands/work/WorkOnTasksCommand.js";
import { CodeReviewCommand } from "../commands/review/CodeReviewCommand.js";
import { QaTasksCommand } from "../commands/planning/QaTasksCommand.js";

export class McodaEntrypoint {
  static async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    const [command, ...rest] = argv;
    if (!command) {
      throw new Error(
        "Usage: mcoda <agent|docs|openapi|jobs|tokens|telemetry|create-tasks|refine-tasks|work-on-tasks|code-review|qa-tasks|backlog|task|task-detail|estimate|pdr|sds> [...args]",
      );
    }
    if (command === "agent") {
      await AgentsCommands.run(rest);
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
