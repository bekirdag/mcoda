import path from "node:path";
import { SdsPreflightService, WorkspaceResolver } from "@mcoda/core";

interface ParsedSdsPreflightArgs {
  workspaceRoot?: string;
  projectKey?: string;
  sdsPaths: string[];
  apply: boolean;
  commitAppliedChanges: boolean;
  commitMessage?: string;
  json: boolean;
  quiet: boolean;
}

const usage =
  "mcoda sds-preflight [--workspace-root <path>] [--project <PROJECT_KEY>] [--sds <path> ...] [--apply] [--commit] [--commit-message <text>] [--json] [--quiet]";

const normalizeProjectKey = (workspaceRoot: string): string => {
  const derived = path.basename(workspaceRoot).replace(/[^a-z0-9]+/gi, "").toLowerCase();
  return derived || "proj";
};

export const parseSdsPreflightArgs = (argv: string[]): ParsedSdsPreflightArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  const sdsPaths: string[] = [];
  let apply = false;
  let commitAppliedChanges = false;
  let commitMessage: string | undefined;
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
      case "--sds":
        if (argv[i + 1]) {
          sdsPaths.push(path.resolve(argv[i + 1]));
          i += 1;
        }
        break;
      case "--apply":
        apply = true;
        break;
      case "--commit":
        commitAppliedChanges = true;
        apply = true;
        break;
      case "--commit-message":
        commitMessage = argv[i + 1];
        i += 1;
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
    sdsPaths: Array.from(new Set(sdsPaths)),
    apply,
    commitAppliedChanges,
    commitMessage,
    json,
    quiet,
  };
};

export class SdsPreflightCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseSdsPreflightArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const configuredKey =
      typeof workspace.config?.projectKey === "string" && workspace.config.projectKey.trim().length > 0
        ? workspace.config.projectKey
        : undefined;
    const projectKey = parsed.projectKey?.trim() || configuredKey || normalizeProjectKey(workspace.workspaceRoot);

    const service = await SdsPreflightService.create(workspace);
    try {
      const result = await service.runPreflight({
        workspace,
        projectKey,
        inputPaths: [],
        sdsPaths: parsed.sdsPaths,
        writeArtifacts: true,
        applyToSds: parsed.apply,
        commitAppliedChanges: parsed.commitAppliedChanges,
        commitMessage: parsed.commitMessage,
      });

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              projectKey: result.projectKey,
              generatedAt: result.generatedAt,
              readyForPlanning: result.readyForPlanning,
              qualityStatus: result.qualityStatus,
              sourceSdsPaths: result.sourceSdsPaths,
              reportPath: result.reportPath,
              openQuestionsPath: result.openQuestionsPath,
              gapAddendumPath: result.gapAddendumPath,
              generatedDocPaths: result.generatedDocPaths,
              questionCount: result.questionCount,
              requiredQuestionCount: result.requiredQuestionCount,
              issueCount: result.issueCount,
              blockingIssueCount: result.blockingIssueCount,
              appliedToSds: result.appliedToSds,
              appliedSdsPaths: result.appliedSdsPaths,
              commitHash: result.commitHash,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (!parsed.quiet) {
        const lines = [
          `sds-preflight project=${result.projectKey}`,
          `Ready for planning: ${result.readyForPlanning ? "yes" : "no"}`,
          `Quality status: ${result.qualityStatus}`,
          `SDS sources: ${result.sourceSdsPaths.length}`,
          `Open questions answered: ${result.questionCount} (required=${result.requiredQuestionCount})`,
          `Issues: ${result.issueCount} (blocking=${result.blockingIssueCount})`,
          `SDS apply mode: ${result.appliedToSds ? "on" : "off"}`,
          `SDS files updated: ${result.appliedSdsPaths.length}`,
          `Commit: ${result.commitHash ?? "n/a"}`,
          `Report: ${result.reportPath}`,
          `Q&A doc: ${result.openQuestionsPath}`,
          `Gap addendum: ${result.gapAddendumPath}`,
        ];
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));
      }
      if (result.warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(result.warnings.map((warning) => `! ${warning}`).join("\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`sds-preflight failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
