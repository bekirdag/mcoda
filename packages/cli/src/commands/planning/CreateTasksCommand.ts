import path from "node:path";
import { CreateTasksService, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  agentName?: string;
  agentStream: boolean;
  maxEpics?: number;
  maxStoriesPerEpic?: number;
  maxTasksPerStory?: number;
  quiet?: boolean;
  inputs: string[];
}

const usage = `mcoda create-tasks [INPUT...] [--workspace-root <path>] [--project-key <key>] [--agent <name>] [--agent-stream [true|false]] [--max-epics N] [--max-stories-per-epic N] [--max-tasks-per-story N] [--quiet]`;

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseCreateTasksArgs = (argv: string[]): ParsedArgs => {
  const inputs: string[] = [];
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let maxEpics: number | undefined;
  let maxStoriesPerEpic: number | undefined;
  let maxTasksPerStory: number | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      switch (arg) {
        case "--workspace-root":
          workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
          i += 1;
          break;
        case "--project-key":
        case "--project":
          projectKey = argv[i + 1];
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
        case "--max-epics":
          maxEpics = Number(argv[i + 1]);
          i += 1;
          break;
        case "--max-stories-per-epic":
          maxStoriesPerEpic = Number(argv[i + 1]);
          i += 1;
          break;
        case "--max-tasks-per-story":
          maxTasksPerStory = Number(argv[i + 1]);
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
    } else {
      inputs.push(arg);
    }
  }

  return {
    workspaceRoot,
    projectKey,
    agentName,
    agentStream: agentStream ?? true,
    maxEpics: Number.isFinite(maxEpics) ? maxEpics : undefined,
    maxStoriesPerEpic: Number.isFinite(maxStoriesPerEpic) ? maxStoriesPerEpic : undefined,
    maxTasksPerStory: Number.isFinite(maxTasksPerStory) ? maxTasksPerStory : undefined,
    quiet,
    inputs,
  };
};

export class CreateTasksCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseCreateTasksArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const derivedKey = path.basename(workspace.workspaceRoot).replace(/[^a-z0-9]+/gi, "").toLowerCase();
    const projectKey = parsed.projectKey ?? (derivedKey || "proj");
    const service = await CreateTasksService.create(workspace);

    try {
      const result = await service.createTasks({
        workspace,
        projectKey,
        inputs: parsed.inputs,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        maxEpics: parsed.maxEpics,
        maxStoriesPerEpic: parsed.maxStoriesPerEpic,
        maxTasksPerStory: parsed.maxTasksPerStory,
      });

      const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
      if (!parsed.quiet) {
        // eslint-disable-next-line no-console
        console.log(
          [
            `Created ${result.epics.length} epics, ${result.stories.length} stories, ${result.tasks.length} tasks, ${result.dependencies.length} dependencies.`,
            `Stored in ${dbPath}.`,
            `Job ID: ${result.jobId}, Command Run: ${result.commandRunId}`,
          ].join("\n"),
        );
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`create-tasks failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
