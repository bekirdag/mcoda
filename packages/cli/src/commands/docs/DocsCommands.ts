import path from "node:path";
import { DocsService, WorkspaceResolver } from "@mcoda/core";

const pdrUsage = `mcoda docs pdr generate --rfp-path <FILE> [--workspace-root <PATH>] [--project <KEY>] [--out <FILE>] [--agent <NAME>] [--agent-stream <true|false>] [--rfp-id <ID>] [--json] [--dry-run] [--debug] [--no-color] [--quiet] [--no-telemetry]`;
const sdsUsage = `mcoda docs sds generate [--workspace-root <PATH>] [--project <KEY>] [--out <FILE>] [--agent <NAME>] [--template <NAME>] [--agent-stream <true|false>] [--force] [--resume <JOB_ID>] [--json] [--dry-run] [--debug] [--no-color] [--quiet] [--no-telemetry]`;

export interface ParsedPdrArgs {
  workspaceRoot?: string;
  projectKey?: string;
  rfpId?: string;
  rfpPath?: string;
  outPath?: string;
  agentName?: string;
  agentStream: boolean;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  debug: boolean;
  noColor: boolean;
  noTelemetry: boolean;
}

export interface ParsedSdsArgs {
  workspaceRoot?: string;
  projectKey?: string;
  outPath?: string;
  agentName?: string;
  templateName?: string;
  agentStream: boolean;
  force: boolean;
  resumeJobId?: string;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  debug: boolean;
  noColor: boolean;
  noTelemetry: boolean;
}

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parsePdrArgs = (argv: string[]): ParsedPdrArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let rfpId: string | undefined;
  let rfpPath: string | undefined;
  let outPath: string | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let dryRun = false;
  let json = false;
  let quiet = false;
  let debug = false;
  let noColor = false;
  let noTelemetry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        projectKey = argv[i + 1];
        i += 1;
        break;
      case "--rfp-id":
        rfpId = argv[i + 1];
        i += 1;
        break;
      case "--rfp-path":
        rfpPath = argv[i + 1];
        i += 1;
        break;
      case "--out":
        outPath = argv[i + 1];
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
      case "--json":
        json = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--debug":
        debug = true;
        break;
      case "--no-color":
        noColor = true;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(pdrUsage);
        process.exit(0);
      default:
        break;
    }
  }

  return {
    workspaceRoot,
    projectKey,
    rfpId,
    rfpPath,
    outPath,
    agentName,
    agentStream: agentStream ?? true,
    dryRun,
    json,
    quiet,
    debug,
    noColor,
    noTelemetry,
  };
};

export const parseSdsArgs = (argv: string[]): ParsedSdsArgs => {
  let workspaceRoot: string | undefined;
  let projectKey: string | undefined;
  let outPath: string | undefined;
  let agentName: string | undefined;
  let templateName: string | undefined;
  let agentStream: boolean | undefined;
  let force = false;
  let resumeJobId: string | undefined;
  let dryRun = false;
  let json = false;
  let quiet = false;
  let debug = false;
  let noColor = false;
  let noTelemetry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        projectKey = argv[i + 1];
        i += 1;
        break;
      case "--out":
        outPath = argv[i + 1];
        i += 1;
        break;
      case "--agent":
        agentName = argv[i + 1];
        i += 1;
        break;
      case "--template":
        templateName = argv[i + 1];
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
      case "--force":
        force = true;
        break;
      case "--resume":
      case "--job-id":
        resumeJobId = argv[i + 1];
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--debug":
        debug = true;
        break;
      case "--no-color":
        noColor = true;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(sdsUsage);
        process.exit(0);
      default:
        break;
    }
  }

  return {
    workspaceRoot,
    projectKey,
    outPath,
    agentName,
    templateName,
    agentStream: agentStream ?? true,
    force,
    resumeJobId,
    dryRun,
    json,
    quiet,
    debug,
    noColor,
    noTelemetry,
  };
};

const printWarnings = (warnings: string[]): void => {
  if (warnings.length === 0) return;
  const banner = warnings.map((w) => `! ${w}`).join("\n");
  // eslint-disable-next-line no-console
  console.warn(banner);
};

export class DocsCommands {
  static async run(argv: string[]): Promise<void> {
    let service: DocsService | undefined;
    try {
      let args = [...argv];
      if (args[0] === "sds") {
        args = args.slice(1);
        if (args[0] === "generate") args = args.slice(1);
        const parsed = parseSdsArgs(args);
        const workspace = await WorkspaceResolver.resolveWorkspace({
          cwd: process.cwd(),
          explicitWorkspace: parsed.workspaceRoot,
        });
        if (parsed.debug) {
          // eslint-disable-next-line no-console
          console.error(`[debug] workspace resolved: ${workspace.workspaceRoot}`);
        }
        service = await DocsService.create(workspace, { noTelemetry: parsed.noTelemetry });
        const shouldStream = parsed.agentStream && !parsed.json && !parsed.quiet;
        const onToken = shouldStream ? (token: string) => process.stdout.write(token) : undefined;
        const result = await service.generateSds({
          workspace,
          projectKey: parsed.projectKey,
          outPath: parsed.outPath,
          agentName: parsed.agentName,
          templateName: parsed.templateName,
          agentStream: parsed.agentStream,
          dryRun: parsed.dryRun,
          json: parsed.json,
          force: parsed.force,
          resumeJobId: parsed.resumeJobId,
          onToken,
        });
        if (parsed.json) {
          const payload = {
            jobId: result.jobId,
            commandRunId: result.commandRunId,
            outputPath: result.outputPath,
            docdexId: result.docdexId,
            warnings: result.warnings,
          };
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        if (shouldStream) {
          // eslint-disable-next-line no-console
          console.log("\n");
        }
        // eslint-disable-next-line no-console
        console.log(`SDS job ${result.jobId} completed.`);
        if (result.outputPath) {
          // eslint-disable-next-line no-console
          console.log(`Output: ${result.outputPath}${parsed.dryRun ? " (dry run, not written)" : ""}`);
        } else {
          // eslint-disable-next-line no-console
          console.log("Dry run: draft not written to disk.");
        }
        if (result.docdexId) {
          // eslint-disable-next-line no-console
          console.log(`Docdex ID: ${result.docdexId}`);
        }
        printWarnings(result.warnings);
        if (parsed.dryRun && !parsed.quiet) {
          // eslint-disable-next-line no-console
          console.log("\n--- Draft Preview ---\n");
          // eslint-disable-next-line no-console
          console.log(result.draft);
        }
        if (parsed.debug) {
          // eslint-disable-next-line no-console
          console.error("[debug] Completed docs:sds generate");
        }
        return;
      }

      if (args[0] === "pdr") args = args.slice(1);
      if (args[0] === "generate") args = args.slice(1);
      const parsed = parsePdrArgs(args);
      if (!parsed.rfpId && !parsed.rfpPath) {
        throw new Error(`Missing --rfp-id or --rfp-path\n\n${pdrUsage}`);
      }

      const workspace = await WorkspaceResolver.resolveWorkspace({
        cwd: process.cwd(),
        explicitWorkspace: parsed.workspaceRoot,
      });
      if (parsed.debug) {
        // eslint-disable-next-line no-console
        console.error(`[debug] workspace resolved: ${workspace.workspaceRoot}`);
      }
        service = await DocsService.create(workspace, { noTelemetry: parsed.noTelemetry });
      const shouldStream = parsed.agentStream && !parsed.json && !parsed.quiet;
      const onToken = shouldStream ? (token: string) => process.stdout.write(token) : undefined;
      const result = await service.generatePdr({
        workspace,
        projectKey: parsed.projectKey,
        rfpId: parsed.rfpId,
        rfpPath: parsed.rfpPath,
        outPath: parsed.outPath,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        dryRun: parsed.dryRun,
        json: parsed.json,
        onToken,
      });
      if (parsed.json) {
        const payload = {
          jobId: result.jobId,
          commandRunId: result.commandRunId,
          outputPath: result.outputPath,
          docdexId: result.docdexId,
          warnings: result.warnings,
        };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (shouldStream) {
        // separate streamed content from summary
        // eslint-disable-next-line no-console
        console.log("\n");
      }
      // eslint-disable-next-line no-console
      console.log(`PDR job ${result.jobId} completed.`);
      if (result.outputPath) {
        // eslint-disable-next-line no-console
        console.log(`Output: ${result.outputPath}${parsed.dryRun ? " (dry run, not written)" : ""}`);
      } else {
        // eslint-disable-next-line no-console
        console.log("Dry run: draft not written to disk.");
      }
      if (result.docdexId) {
        // eslint-disable-next-line no-console
        console.log(`Docdex ID: ${result.docdexId}`);
      }
      printWarnings(result.warnings);
      if (parsed.dryRun && !parsed.quiet) {
        // eslint-disable-next-line no-console
        console.log("\n--- Draft Preview ---\n");
        // eslint-disable-next-line no-console
        console.log(result.draft);
      }
      if (parsed.debug) {
        // eslint-disable-next-line no-console
        console.error("[debug] Completed docs:pdr generate");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`ERROR: ${message}`);
      process.exitCode = 1;
    } finally {
      if (service) {
        await service.close();
      }
    }
  }
}
