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
  qaProfiles?: string[];
  qaEntryUrl?: string;
  qaStartCommand?: string;
  qaRequires?: string[];
  sdsPreflightApplyToSds: boolean;
  sdsPreflightCommit: boolean;
  sdsPreflightCommitMessage?: string;
  unknownEpicServicePolicy?: "auto-remediate" | "fail";
  inputs: string[];
}

type ProjectKeyCandidate = { key: string; mtimeMs: number };

export const createTasksUsage = [
  "mcoda create-tasks [INPUT...] [--workspace-root <path>] [--project-key <key>] [--agent <name>] [--agent-stream [true|false]] [--rate-agents] [--force] [--max-epics N] [--max-stories-per-epic N] [--max-tasks-per-story N] [--qa-profile <csv>] [--qa-entry-url <url>] [--qa-start-command <cmd>] [--qa-requires <csv>] [--sds-preflight-apply [true|false]] [--sds-preflight-commit [true|false]] [--sds-preflight-commit-message <text>] [--unknown-epic-service-policy <auto-remediate|fail>] [--quiet]",
  "Default: SDS preflight runs in sidecar mode. Use --sds-preflight-apply to write remediations back to SDS sources.",
  "Use --sds-preflight-commit only together with --sds-preflight-apply.",
].join("\n");

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
  const requestedKey = options.requestedKey?.trim() || undefined;
  const configuredKey = options.configuredKey?.trim() || undefined;
  const derivedKey = options.derivedKey || "proj";
  const existing = options.existing ?? [];
  const latestExisting = existing[0]?.key;
  const existingMatchesRequested = requestedKey ? existing.some((item) => item.key === requestedKey) : false;

  if (requestedKey) {
    if (configuredKey && configuredKey !== requestedKey) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; overriding configured project key "${configuredKey}".`,
      );
    }
    if (latestExisting && !existingMatchesRequested) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; existing task plans were found for "${latestExisting}".`,
      );
    }
    if (existing.length > 1) {
      warnings.push(
        `Multiple task plan folders detected (${existing.map((item) => item.key).join(", ")}); using explicitly requested project key "${requestedKey}".`,
      );
    }
    return { projectKey: requestedKey, warnings };
  }

  if (configuredKey) {
    if (existing.length > 1) {
      warnings.push(
        `Multiple task plan folders detected (${existing.map((item) => item.key).join(", ")}); using configured project key "${configuredKey}".`,
      );
    }
    return { projectKey: configuredKey, warnings };
  }

  if (latestExisting && latestExisting !== derivedKey) {
    warnings.push(
      `Existing task plans were found for "${latestExisting}", but using derived project key "${derivedKey}" to avoid accidental cross-project reuse. Pass --project-key to reuse an existing project.`,
    );
  }
  if (existing.length > 1) {
    warnings.push(
      `Multiple task plan folders detected (${existing.map((item) => item.key).join(", ")}); using derived project key "${derivedKey}".`,
    );
  }

  return { projectKey: derivedKey, warnings };
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
  let qaProfiles: string[] | undefined;
  let qaEntryUrl: string | undefined;
  let qaStartCommand: string | undefined;
  let qaRequires: string[] | undefined;
  let sdsPreflightApplyToSds = false;
  let sdsPreflightCommit = false;
  let sdsPreflightCommitMessage: string | undefined;
  let unknownEpicServicePolicy: "auto-remediate" | "fail" | undefined;
  const normalizePolicy = (value: string | undefined): "auto-remediate" | "fail" | undefined => {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto-remediate" || normalized === "fail") return normalized;
    return undefined;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (arg.startsWith("--rate-agents=")) {
        const [, raw] = arg.split("=", 2);
        rateAgents = parseBooleanFlag(raw, true);
        continue;
      }
      if (arg.startsWith("--sds-preflight-commit=")) {
        const [, raw] = arg.split("=", 2);
        sdsPreflightCommit = parseBooleanFlag(raw, true);
        continue;
      }
      if (arg.startsWith("--sds-preflight-apply=")) {
        const [, raw] = arg.split("=", 2);
        sdsPreflightApplyToSds = parseBooleanFlag(raw, true);
        continue;
      }
      if (arg.startsWith("--unknown-epic-service-policy=")) {
        const [, raw] = arg.split("=", 2);
        const normalizedPolicy = normalizePolicy(raw);
        if (!normalizedPolicy) {
          throw new Error(`Invalid --unknown-epic-service-policy value: ${raw}. Expected auto-remediate or fail.`);
        }
        unknownEpicServicePolicy = normalizedPolicy;
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
        case "--qa-profile":
          qaProfiles = argv[i + 1]
            ? argv[i + 1]
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined;
          i += 1;
          break;
        case "--qa-entry-url":
          qaEntryUrl = argv[i + 1];
          i += 1;
          break;
        case "--qa-start-command":
          qaStartCommand = argv[i + 1];
          i += 1;
          break;
        case "--qa-requires":
          qaRequires = argv[i + 1]
            ? argv[i + 1]
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined;
          i += 1;
          break;
        case "--sds-preflight-commit": {
          const next = argv[i + 1];
          if (next && !next.startsWith("--")) {
            sdsPreflightCommit = parseBooleanFlag(next, true);
            i += 1;
          } else {
            sdsPreflightCommit = true;
          }
          break;
        }
        case "--sds-preflight-commit-message":
          sdsPreflightCommitMessage = argv[i + 1];
          i += 1;
          break;
        case "--sds-preflight-apply": {
          const next = argv[i + 1];
          if (next && !next.startsWith("--")) {
            sdsPreflightApplyToSds = parseBooleanFlag(next, true);
            i += 1;
          } else {
            sdsPreflightApplyToSds = true;
          }
          break;
        }
        case "--unknown-epic-service-policy": {
          const value = argv[i + 1];
          const normalizedPolicy = normalizePolicy(value);
          if (!normalizedPolicy) {
            throw new Error(
              `Invalid --unknown-epic-service-policy value: ${value ?? "(missing)"}. Expected auto-remediate or fail.`,
            );
          }
          unknownEpicServicePolicy = normalizedPolicy;
          i += 1;
          break;
        }
        case "--quiet":
          quiet = true;
          break;
        case "--force":
          force = true;
          break;
        case "--help":
        case "-h":
          // eslint-disable-next-line no-console
          console.log(createTasksUsage);
          process.exit(0);
          break;
        default:
          break;
      }
    } else {
      inputs.push(arg);
    }
  }

  if (sdsPreflightCommit && !sdsPreflightApplyToSds) {
    throw new Error("--sds-preflight-commit requires --sds-preflight-apply.");
  }
  if (sdsPreflightCommitMessage && !sdsPreflightCommit) {
    throw new Error("--sds-preflight-commit-message requires --sds-preflight-commit.");
  }

  return {
    workspaceRoot,
    projectKey,
    agentName,
    agentStream: agentStream ?? Boolean(agentName),
    rateAgents,
    maxEpics: Number.isFinite(maxEpics) ? maxEpics : undefined,
    maxStoriesPerEpic: Number.isFinite(maxStoriesPerEpic) ? maxStoriesPerEpic : undefined,
    maxTasksPerStory: Number.isFinite(maxTasksPerStory) ? maxTasksPerStory : undefined,
    force,
    quiet,
    qaProfiles,
    qaEntryUrl,
    qaStartCommand,
    qaRequires,
    sdsPreflightApplyToSds,
    sdsPreflightCommit,
    sdsPreflightCommitMessage,
    unknownEpicServicePolicy,
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
        qaProfiles: parsed.qaProfiles,
        qaEntryUrl: parsed.qaEntryUrl,
        qaStartCommand: parsed.qaStartCommand,
        qaRequires: parsed.qaRequires,
        sdsPreflightApplyToSds: parsed.sdsPreflightApplyToSds,
        sdsPreflightCommit: parsed.sdsPreflightCommit,
        sdsPreflightCommitMessage: parsed.sdsPreflightCommitMessage,
        unknownEpicServicePolicy: parsed.unknownEpicServicePolicy,
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
        if (result.warnings.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(result.warnings.join("\n"));
        }
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
