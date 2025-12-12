import path from "node:path";
import { CreateTasksService, WorkspaceResolver } from "@mcoda/core";

const usage = `mcoda migrate-tasks [--workspace-root <path>] [--project-key <key>] [--plan-dir <path>] [--refine-plan <path>] [--quiet]`;

export class MigrateTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const args: Record<string, string | boolean | undefined> = {};
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--workspace-root" && argv[i + 1]) {
        args.workspaceRoot = argv[++i];
      } else if ((arg === "--project" || arg === "--project-key") && argv[i + 1]) {
        args.projectKey = argv[++i];
      } else if (arg === "--plan-dir" && argv[i + 1]) {
        args.planDir = argv[++i];
      } else if (arg === "--refine-plan" && argv[i + 1]) {
        args.refinePlan = argv[++i];
      } else if (arg === "--force") {
        args.force = true;
      } else if (arg === "--quiet") {
        args.quiet = true;
      } else if (arg === "--help" || arg === "-h") {
        console.log(usage);
        return;
      }
    }

    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: (args.workspaceRoot as string | undefined) ?? undefined,
    });
    const workspaceRoot = workspace.workspaceRoot;
    const derivedKey = path.basename(workspaceRoot).replace(/[^a-z0-9]+/gi, "").toLowerCase();
    const projectKey = (args.projectKey as string | undefined) ?? (derivedKey || "proj");
    const planDir = args.planDir as string | undefined;

    if (!projectKey) {
      console.error("Project key is required. Use --project-key <key>.");
      process.exitCode = 1;
      return;
    }

    const service = await CreateTasksService.create(workspace);

    try {
      const result = await service.migratePlanFromFolder({
        projectKey,
        planDir,
        force: !!args.force,
        refinePlanPath: args.refinePlan as string | undefined,
      });
      if (!args.quiet) {
        console.log(
          [
            `Migrated plan from ${planDir ?? path.join(workspaceRoot, ".mcoda", "tasks", projectKey)}`,
            `Epics: ${result.epics.length}`,
            `Stories: ${result.stories.length}`,
            `Tasks: ${result.tasks.length}`,
            `Dependencies: ${result.dependencies.length}`,
          ].join("\n"),
        );
      }
    } catch (error) {
      console.error(`migrate-tasks failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      try {
        await service.close();
      } catch (error) {
        const msg = (error as Error).message ?? "";
        if (!msg.includes("database is closed")) {
          throw error;
        }
      }
    }
  }
}
