#!/usr/bin/env node
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { DocsCommands } from "../commands/docs/DocsCommands.js";
import { JobsCommands } from "../commands/jobs/JobsCommands.js";
import { OpenapiCommands } from "../commands/openapi/OpenapiCommands.js";

export class McodaEntrypoint {
  static async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    const [command, ...rest] = argv;
    if (!command) {
      throw new Error("Usage: mcoda <agent|docs|pdr> [...args]");
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
    if (command === "pdr" || command === "mcoda:pdr") {
      await DocsCommands.run(["pdr", "generate", ...rest]);
      return;
    }
    if (command === "sds" || command === "mcoda:sds") {
      await DocsCommands.run(["sds", "generate", ...rest]);
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
