import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver, ensureProjectGuidance } from "@mcoda/core";

const USAGE =
  "Usage: mcoda project-guidance [--workspace <path>|--workspace-root <path>] [--project <key>] [--force] [--json]";

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

export interface ParsedProjectGuidanceArgs {
  workspaceRoot?: string;
  projectKey?: string;
  force: boolean;
  json: boolean;
  help: boolean;
}

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseProjectGuidanceArgs = (argv: string[]): ParsedProjectGuidanceArgs => {
  const parsed: ParsedProjectGuidanceArgs = {
    force: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--workspace-root=") || arg.startsWith("--workspace=")) {
      const [, raw] = arg.split("=", 2);
      if (raw) parsed.workspaceRoot = path.resolve(raw);
      continue;
    }
    if (arg.startsWith("--project=")) {
      const [, raw] = arg.split("=", 2);
      if (raw) parsed.projectKey = raw.trim() || undefined;
      continue;
    }
    if (arg.startsWith("--force=")) {
      const [, raw] = arg.split("=", 2);
      parsed.force = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--json=")) {
      const [, raw] = arg.split("=", 2);
      parsed.json = parseBooleanFlag(raw, true);
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        if (argv[i + 1]) {
          parsed.workspaceRoot = path.resolve(argv[i + 1]);
          i += 1;
        }
        break;
      case "--project":
        if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
          parsed.projectKey = argv[i + 1].trim() || undefined;
          i += 1;
        }
        break;
      case "--force": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          parsed.force = parseBooleanFlag(next, true);
          i += 1;
        } else {
          parsed.force = true;
        }
        break;
      }
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        break;
    }
  }
  return parsed;
};

const listWorkspaceProjects = async (workspaceRoot: string): Promise<ProjectKeyCandidate[]> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const rows = await repo
      .getDb()
      .all<{ key: string; created_at?: string | null }[]>(`SELECT key, created_at FROM projects ORDER BY created_at ASC, key ASC`);
    return rows
      .map((row) => ({ key: String(row.key), createdAt: row.created_at ?? null }))
      .filter((row) => row.key.trim().length > 0);
  } catch {
    return [];
  } finally {
    await repo.close();
  }
};

const pickProjectGuidanceProjectKey = (options: {
  requestedKey?: string;
  configuredKey?: string;
  existing: ProjectKeyCandidate[];
}): { projectKey?: string; warnings: string[] } => {
  const warnings: string[] = [];
  const requestedKey = options.requestedKey?.trim() || undefined;
  const configuredKey = options.configuredKey?.trim() || undefined;
  const existing = options.existing ?? [];
  const firstExisting = existing[0]?.key;

  if (requestedKey) {
    if (configuredKey && configuredKey !== requestedKey) {
      warnings.push(
        `Using explicitly requested project key \"${requestedKey}\"; overriding configured project key \"${configuredKey}\".`,
      );
    }
    if (firstExisting && requestedKey !== firstExisting) {
      warnings.push(
        `Using explicitly requested project key \"${requestedKey}\"; first workspace project is \"${firstExisting}\".`,
      );
    }
    return { projectKey: requestedKey, warnings };
  }

  if (configuredKey) {
    if (firstExisting && configuredKey !== firstExisting) {
      warnings.push(`Using configured project key \"${configuredKey}\" instead of first workspace project \"${firstExisting}\".`);
    }
    return { projectKey: configuredKey, warnings };
  }

  if (firstExisting) {
    warnings.push(`No --project provided; defaulting to first workspace project \"${firstExisting}\".`);
    return { projectKey: firstExisting, warnings };
  }

  warnings.push("No workspace project found; creating workspace-global project guidance.");
  return { projectKey: undefined, warnings };
};

export class ProjectGuidanceCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseProjectGuidanceArgs(argv);
    if (parsed.help) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }

    try {
      const workspace = await WorkspaceResolver.resolveWorkspace({
        cwd: process.cwd(),
        explicitWorkspace: parsed.workspaceRoot,
      });
      const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
      const configuredKey =
        typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
          ? workspace.config.projectKey
          : undefined;
      const projectResolution = pickProjectGuidanceProjectKey({
        requestedKey: parsed.projectKey,
        configuredKey,
        existing: existingProjects,
      });
      const result = await ensureProjectGuidance(workspace.workspaceRoot, {
        mcodaDir: workspace.mcodaDir,
        force: parsed.force,
        projectKey: projectResolution.projectKey,
      });
      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              workspaceRoot: workspace.workspaceRoot,
              mcodaDir: workspace.mcodaDir,
              projectKey: projectResolution.projectKey ?? null,
              path: result.path,
              status: result.status,
              source: result.source ?? null,
              sdsSource: result.sdsSource ?? null,
              warnings: [...projectResolution.warnings, ...(result.warnings ?? [])],
            },
            null,
            2,
          ),
        );
        return;
      }
      for (const warning of projectResolution.warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[project-guidance] ${warning}`);
      }
      for (const warning of result.warnings ?? []) {
        // eslint-disable-next-line no-console
        console.warn(`[project-guidance] ${warning}`);
      }
      // eslint-disable-next-line no-console
      console.log(`project-guidance ${result.status}: ${result.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`project-guidance failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
