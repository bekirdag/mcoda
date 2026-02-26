import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { AddTestsService, WorkspaceResolver } from "@mcoda/core";
import { WORK_ALLOWED_STATUSES, filterTaskStatuses } from "@mcoda/shared";

interface ParsedArgs {
  workspaceRoot?: string;
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  limit?: number;
  noCommit: boolean;
  dryRun: boolean;
  baseBranch?: string;
  json: boolean;
}

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

const usage = `mcoda add-tests \\
  [--workspace <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \\
  [--status not_started,in_progress,changes_requested] \\
  [--limit N] \\
  [--base-branch <BRANCH>] \\
  [--no-commit] \\
  [--dry-run] \\
  [--json]`;

const parseCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

export const parseAddTestsArgs = (argv: string[]): ParsedArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let epicKey: string | undefined;
  let storyKey: string | undefined;
  const taskKeys: string[] = [];
  const statusFilter: string[] = [];
  let limit: number | undefined;
  let noCommit = false;
  let dryRun = false;
  let baseBranch: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--status=")) {
      const [, raw] = arg.split("=", 2);
      statusFilter.push(...parseCsv(raw));
      continue;
    }
    if (arg.startsWith("--task=")) {
      const [, raw] = arg.split("=", 2);
      if (raw) taskKeys.push(raw);
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
      case "--project-key":
        projectKey = argv[i + 1];
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
      case "--task":
        if (argv[i + 1]) {
          taskKeys.push(argv[i + 1]);
          i += 1;
        }
        break;
      case "--status":
        statusFilter.push(...parseCsv(argv[i + 1]));
        i += 1;
        break;
      case "--limit":
        limit = Number(argv[i + 1]);
        i += 1;
        break;
      case "--base-branch":
      case "--branch":
        baseBranch = argv[i + 1];
        i += 1;
        break;
      case "--no-commit":
        noCommit = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--json":
        json = true;
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

  const { filtered } = filterTaskStatuses(
    statusFilter.length ? statusFilter : undefined,
    WORK_ALLOWED_STATUSES,
    WORK_ALLOWED_STATUSES,
  );

  return {
    workspaceRoot,
    projectKey,
    epicKey,
    storyKey,
    taskKeys,
    statusFilter: filtered,
    limit: Number.isFinite(limit) ? limit : undefined,
    noCommit,
    dryRun,
    baseBranch: baseBranch?.trim() || undefined,
    json,
  };
};

const listWorkspaceProjects = async (workspaceRoot: string): Promise<ProjectKeyCandidate[]> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const rows = await repo
      .getDb()
      .all<{ key: string; created_at?: string | null }[]>(
        `SELECT key, created_at FROM projects ORDER BY created_at ASC, key ASC`,
      );
    return rows
      .map((row) => ({ key: String(row.key), createdAt: row.created_at ?? null }))
      .filter((row) => row.key.trim().length > 0);
  } catch {
    return [];
  } finally {
    await repo.close();
  }
};

export const pickAddTestsProjectKey = (options: {
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
        `Using explicitly requested project key "${requestedKey}"; overriding configured project key "${configuredKey}".`,
      );
    }
    if (firstExisting && requestedKey !== firstExisting) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; first workspace project is "${firstExisting}".`,
      );
    }
    return { projectKey: requestedKey, warnings };
  }

  if (configuredKey) {
    if (firstExisting && configuredKey !== firstExisting) {
      warnings.push(`Using configured project key "${configuredKey}" instead of first workspace project "${firstExisting}".`);
    }
    return { projectKey: configuredKey, warnings };
  }

  if (firstExisting) {
    warnings.push(`No --project provided; defaulting to first workspace project "${firstExisting}".`);
    return { projectKey: firstExisting, warnings };
  }

  return { projectKey: undefined, warnings };
};

export class AddTestsCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseAddTestsArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectResolution = pickAddTestsProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      existing: existingProjects,
    });
    const commandWarnings = [...projectResolution.warnings];
    if (!projectResolution.projectKey) {
      // eslint-disable-next-line no-console
      console.error("add-tests could not resolve a project key. Provide --project <PROJECT_KEY> or create tasks first.");
      process.exitCode = 1;
      return;
    }
    if (commandWarnings.length > 0 && !parsed.json) {
      // eslint-disable-next-line no-console
      console.warn(commandWarnings.map((warning) => `! ${warning}`).join("\n"));
    }

    const service = await AddTestsService.create(workspace);
    try {
      const result = await service.addTests({
        projectKey: projectResolution.projectKey,
        epicKey: parsed.epicKey,
        storyKey: parsed.storyKey,
        taskKeys: parsed.taskKeys.length ? parsed.taskKeys : undefined,
        statusFilter: parsed.statusFilter,
        ignoreStatusFilter: parsed.taskKeys.length > 0 ? true : undefined,
        ignoreDependencies: true,
        limit: parsed.limit,
        dryRun: parsed.dryRun,
        commit: !parsed.noCommit,
        baseBranch: parsed.baseBranch,
      });

      const warnings = [...commandWarnings, ...result.warnings];
      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              projectKey: result.projectKey,
              selectedTaskCount: result.selectedTaskKeys.length,
              tasksRequiringTests: result.tasksRequiringTests,
              updatedTaskKeys: result.updatedTaskKeys,
              skippedTaskKeys: result.skippedTaskKeys,
              createdFiles: result.createdFiles,
              runAllScriptPath: result.runAllScriptPath ?? null,
              runAllCommand: result.runAllCommand ?? null,
              branch: result.branch ?? null,
              commitSha: result.commitSha ?? null,
              warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log(
        [
          `add-tests project=${result.projectKey}`,
          `selected=${result.selectedTaskKeys.length}`,
          `requires_tests=${result.tasksRequiringTests.length}`,
          `updated=${result.updatedTaskKeys.length}`,
          `skipped=${result.skippedTaskKeys.length}`,
        ].join(" "),
      );
      if (result.createdFiles.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Created: ${result.createdFiles.join(", ")}`);
      }
      if (result.runAllCommand) {
        // eslint-disable-next-line no-console
        console.log(`Run-all command: ${result.runAllCommand}`);
      }
      if (result.commitSha) {
        // eslint-disable-next-line no-console
        console.log(`Committed on ${result.branch ?? "current branch"}: ${result.commitSha}`);
      } else if (!parsed.noCommit && !parsed.dryRun && result.createdFiles.length > 0) {
        // eslint-disable-next-line no-console
        console.log("No commit was created.");
      }
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(warnings.map((warning) => `! ${warning}`).join("\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`add-tests failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
