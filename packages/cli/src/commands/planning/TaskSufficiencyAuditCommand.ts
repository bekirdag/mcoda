import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { TaskSufficiencyService, WorkspaceResolver } from "@mcoda/core";

interface ParsedTaskSufficiencyArgs {
  workspaceRoot?: string;
  projectKey?: string;
  maxIterations?: number;
  maxTasksPerIteration?: number;
  minCoverageRatio?: number;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
}

type ProjectKeyCandidate = { key: string; createdAt?: string | null };

const usage = `mcoda task-sufficiency-audit [--workspace-root <path>] [--project <PROJECT_KEY>] [--max-iterations N] [--max-tasks-per-iteration N] [--min-coverage-ratio 0..1] [--dry-run] [--json] [--quiet]`;

const listWorkspaceProjects = async (workspaceRoot: string): Promise<ProjectKeyCandidate[]> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const rows = await repo
      .getDb()
      .all<{ key: string; created_at?: string | null }[]>(
        `SELECT key, created_at FROM projects ORDER BY datetime(created_at) DESC, key ASC`,
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

export const pickTaskSufficiencyProjectKey = (options: {
  requestedKey?: string;
  configuredKey?: string;
  existing: ProjectKeyCandidate[];
}): { projectKey?: string; warnings: string[] } => {
  const warnings: string[] = [];
  const requestedKey = options.requestedKey?.trim() || undefined;
  const configuredKey = options.configuredKey?.trim() || undefined;
  const existing = options.existing ?? [];
  const latestExisting = existing[0]?.key;

  if (requestedKey) {
    if (configuredKey && configuredKey !== requestedKey) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; overriding configured project key "${configuredKey}".`,
      );
    }
    if (latestExisting && requestedKey !== latestExisting) {
      warnings.push(
        `Using explicitly requested project key "${requestedKey}"; latest workspace project is "${latestExisting}".`,
      );
    }
    return { projectKey: requestedKey, warnings };
  }

  if (configuredKey) {
    if (latestExisting && configuredKey !== latestExisting) {
      warnings.push(`Using configured project key "${configuredKey}" instead of latest workspace project "${latestExisting}".`);
    }
    return { projectKey: configuredKey, warnings };
  }

  if (latestExisting) {
    warnings.push(`No --project provided; defaulting to latest workspace project "${latestExisting}".`);
    return { projectKey: latestExisting, warnings };
  }

  return { projectKey: undefined, warnings };
};

export const parseTaskSufficiencyAuditArgs = (argv: string[]): ParsedTaskSufficiencyArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let maxIterations: number | undefined;
  let maxTasksPerIteration: number | undefined;
  let minCoverageRatio: number | undefined;
  let dryRun = false;
  let json = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace-root":
      case "--workspace":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
      case "--project-key":
        projectKey = argv[i + 1];
        i += 1;
        break;
      case "--max-iterations":
        maxIterations = Number(argv[i + 1]);
        i += 1;
        break;
      case "--max-tasks-per-iteration":
      case "--max-new-tasks":
        maxTasksPerIteration = Number(argv[i + 1]);
        i += 1;
        break;
      case "--min-coverage-ratio":
      case "--min-coverage":
        minCoverageRatio = Number(argv[i + 1]);
        i += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--json":
        json = true;
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
  }

  return {
    workspaceRoot,
    projectKey,
    maxIterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
    maxTasksPerIteration: Number.isFinite(maxTasksPerIteration) ? maxTasksPerIteration : undefined,
    minCoverageRatio: Number.isFinite(minCoverageRatio) ? minCoverageRatio : undefined,
    dryRun,
    json,
    quiet,
  };
};

export class TaskSufficiencyAuditCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseTaskSufficiencyAuditArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    const existingProjects = parsed.projectKey ? [] : await listWorkspaceProjects(workspace.workspaceRoot);
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectResolution = pickTaskSufficiencyProjectKey({
      requestedKey: parsed.projectKey,
      configuredKey,
      existing: existingProjects,
    });

    if (!projectResolution.projectKey) {
      // eslint-disable-next-line no-console
      console.error(
        "task-sufficiency-audit could not resolve a project key. Provide --project <PROJECT_KEY> or run create-tasks first.",
      );
      process.exitCode = 1;
      return;
    }

    if (projectResolution.warnings.length > 0 && !parsed.json && !parsed.quiet) {
      // eslint-disable-next-line no-console
      console.warn(projectResolution.warnings.map((warning) => `! ${warning}`).join("\n"));
    }

    const service = await TaskSufficiencyService.create(workspace);
    try {
      const result = await service.runAudit({
        workspace,
        projectKey: projectResolution.projectKey,
        dryRun: parsed.dryRun,
        maxIterations: parsed.maxIterations,
        maxTasksPerIteration: parsed.maxTasksPerIteration,
        minCoverageRatio: parsed.minCoverageRatio,
      });
      const warnings = [...projectResolution.warnings, ...result.warnings];

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              projectKey: result.projectKey,
              jobId: result.jobId,
              commandRunId: result.commandRunId,
              sourceCommand: result.sourceCommand ?? null,
              satisfied: result.satisfied,
              dryRun: result.dryRun,
              maxIterations: result.maxIterations,
              minCoverageRatio: result.minCoverageRatio,
              totalTasksAdded: result.totalTasksAdded,
              totalTasksUpdated: result.totalTasksUpdated,
              finalCoverageRatio: result.finalCoverageRatio,
              remainingSectionHeadings: result.remainingSectionHeadings,
              remainingFolderEntries: result.remainingFolderEntries,
              remainingGaps: result.remainingGaps,
              iterations: result.iterations,
              reportPath: result.reportPath,
              reportHistoryPath: result.reportHistoryPath ?? null,
              warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (!parsed.quiet) {
        const lines = [
          `task-sufficiency-audit project=${result.projectKey}`,
          `Job: ${result.jobId}, Command Run: ${result.commandRunId}`,
          `Satisfied: ${result.satisfied ? "yes" : "no"}`,
          `Dry run: ${result.dryRun ? "yes" : "no"}`,
          `Coverage: ${result.finalCoverageRatio} (target ${result.minCoverageRatio})`,
          `Tasks added: ${result.totalTasksAdded}`,
          `Tasks updated: ${result.totalTasksUpdated}`,
          `Remaining section gaps: ${result.remainingSectionHeadings.length}`,
          `Remaining folder gaps: ${result.remainingFolderEntries.length}`,
          `Remaining total gaps: ${result.remainingGaps.total}`,
          `Report: ${result.reportPath}`,
          result.reportHistoryPath ? `History snapshot: ${result.reportHistoryPath}` : undefined,
        ].filter(Boolean);
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));
      }
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(warnings.map((warning) => `! ${warning}`).join("\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`task-sufficiency-audit failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
