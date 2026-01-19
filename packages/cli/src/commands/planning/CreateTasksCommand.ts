import path from "node:path";
import { promises as fs } from "node:fs";
import { CreateTasksService, WorkspaceResolver } from "@mcoda/core";
import { PathHelper } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  agentName?: string;
  agentStream: boolean;
  rateAgents: boolean;
  force: boolean;
  maxEpics?: number;
  maxStoriesPerEpic?: number;
  maxTasksPerStory?: number;
  quiet?: boolean;
  inputs: string[];
}

type ProjectKeyCandidate = { key: string; mtimeMs: number };

const usage = `mcoda create-tasks [INPUT...] [--workspace-root <path>] [--project-key <key>] [--agent <name>] [--agent-stream [true|false]] [--rate-agents] [--force] [--max-epics N] [--max-stories-per-epic N] [--max-tasks-per-story N] [--quiet]`;

const readWorkspaceConfig = async (mcodaDir: string): Promise<Record<string, unknown>> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeWorkspaceConfig = async (mcodaDir: string, config: Record<string, unknown>): Promise<void> => {
  const configPath = path.join(mcodaDir, "config.json");
  await fs.mkdir(mcodaDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
};

const listTaskProjects = async (mcodaDir: string): Promise<ProjectKeyCandidate[]> => {
  const tasksDir = path.join(mcodaDir, "tasks");
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: ProjectKeyCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const key = entry.name;
    const projectDir = path.join(tasksDir, key);
    const planPath = path.join(projectDir, "plan.json");
    const tasksPath = path.join(projectDir, "tasks.json");
    let statPath = projectDir;
    try {
      await fs.access(planPath);
      statPath = planPath;
    } catch {
      try {
        await fs.access(tasksPath);
        statPath = tasksPath;
      } catch {
        statPath = projectDir;
      }
    }
    try {
      const stat = await fs.stat(statPath);
      candidates.push({ key, mtimeMs: stat.mtimeMs });
    } catch {
      candidates.push({ key, mtimeMs: 0 });
    }
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

export const pickCreateTasksProjectKey = (options: {
  requestedKey?: string;
  configuredKey?: string;
  derivedKey: string;
  existing: ProjectKeyCandidate[];
}): { projectKey: string; warnings: string[] } => {
  const warnings: string[] = [];
  const derivedKey = options.derivedKey || "proj";
  const existing = options.existing ?? [];
  const latestExisting = existing[0]?.key;

  if (options.configuredKey) {
    if (options.requestedKey && options.requestedKey !== options.configuredKey) {
      warnings.push(
        `Using configured project key "${options.configuredKey}" from workspace config; ignoring requested "${options.requestedKey}".`,
      );
    }
    if (existing.length > 1) {
      warnings.push(
        `Multiple task plan folders detected (${existing.map((item) => item.key).join(", ")}); using configured project key "${options.configuredKey}".`,
      );
    }
    return { projectKey: options.configuredKey, warnings };
  }

  if (latestExisting) {
    const requestedMatches = options.requestedKey
      ? existing.some((item) => item.key === options.requestedKey)
      : false;
    const selected = requestedMatches ? (options.requestedKey ?? latestExisting) : latestExisting;
    if (options.requestedKey && !requestedMatches) {
      warnings.push(
        `Found existing project key "${latestExisting}" under workspace task plans; ignoring requested "${options.requestedKey}".`,
      );
    }
    if (!options.requestedKey && selected !== derivedKey) {
      warnings.push(`Reusing existing project key "${selected}" from workspace task plans.`);
    }
    if (existing.length > 1) {
      warnings.push(
        `Multiple task plan folders detected (${existing.map((item) => item.key).join(", ")}); using "${selected}".`,
      );
    }
    return { projectKey: selected, warnings };
  }

  return { projectKey: options.requestedKey ?? derivedKey, warnings };
};

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
  let rateAgents = false;
  let maxEpics: number | undefined;
  let maxStoriesPerEpic: number | undefined;
  let maxTasksPerStory: number | undefined;
  let force = false;
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
        case "--force":
          force = true;
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
    rateAgents,
    maxEpics: Number.isFinite(maxEpics) ? maxEpics : undefined,
    maxStoriesPerEpic: Number.isFinite(maxStoriesPerEpic) ? maxStoriesPerEpic : undefined,
    maxTasksPerStory: Number.isFinite(maxTasksPerStory) ? maxTasksPerStory : undefined,
    force,
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
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const existingProjects = await listTaskProjects(workspace.mcodaDir);
    const { projectKey, warnings } = pickCreateTasksProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      derivedKey: derivedKey || "proj",
      existing: existingProjects,
    });
    if (!configuredKey) {
      const config = await readWorkspaceConfig(workspace.mcodaDir);
      if (config.projectKey !== projectKey) {
        await writeWorkspaceConfig(workspace.mcodaDir, { ...config, projectKey });
      }
    }
    if (warnings.length > 0 && !parsed.quiet) {
      // eslint-disable-next-line no-console
      console.warn(warnings.join("\n"));
    }
    const service = await CreateTasksService.create(workspace);

    try {
      const result = await service.createTasks({
        workspace,
        projectKey,
        inputs: parsed.inputs,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        maxEpics: parsed.maxEpics,
        maxStoriesPerEpic: parsed.maxStoriesPerEpic,
        maxTasksPerStory: parsed.maxTasksPerStory,
        force: parsed.force,
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
