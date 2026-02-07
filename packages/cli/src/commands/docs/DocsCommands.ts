import path from "node:path";
import { DocsService, WorkspaceResolver } from "@mcoda/core";

const pdrUsage = `mcoda docs pdr generate --rfp-path <FILE> [--workspace-root <PATH>] [--project <KEY>] [--out <FILE>] [--agent <NAME>] [--agent-stream <true|false>] [--rate-agents] [--rfp-id <ID>] [--fast] [--iterate] [--quality <build-ready>] [--resolve-open-questions] [--no-placeholders] [--no-maybes] [--cross-align] [--json] [--dry-run] [--debug] [--no-color] [--quiet] [--no-telemetry]`;
const sdsUsage = `mcoda docs sds generate [--workspace-root <PATH>] [--project <KEY>] [--out <FILE>] [--agent <NAME>] [--template <NAME>] [--agent-stream <true|false>] [--rate-agents] [--fast] [--iterate] [--quality <build-ready>] [--resolve-open-questions] [--no-placeholders] [--no-maybes] [--cross-align] [--force] [--resume <JOB_ID>] [--json] [--dry-run] [--debug] [--no-color] [--quiet] [--no-telemetry]`;

export interface ParsedPdrArgs {
  workspaceRoot?: string;
  projectKey?: string;
  rfpId?: string;
  rfpPath?: string;
  outPath?: string;
  agentName?: string;
  agentStream: boolean;
  rateAgents: boolean;
  fast: boolean;
  iterate: boolean;
  quality?: string;
  buildReady: boolean;
  resolveOpenQuestions: boolean;
  noPlaceholders: boolean;
  noMaybes: boolean;
  crossAlign: boolean;
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
  rateAgents: boolean;
  fast: boolean;
  iterate: boolean;
  quality?: string;
  buildReady: boolean;
  resolveOpenQuestions: boolean;
  noPlaceholders: boolean;
  noMaybes: boolean;
  crossAlign: boolean;
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
  let rateAgents = false;
  let fast = false;
  let iterate = false;
  let quality: string | undefined;
  let resolveOpenQuestions = false;
  let noPlaceholders = false;
  let noMaybes = false;
  let crossAlign = true;
  let dryRun = false;
  let json = false;
  let quiet = false;
  let debug = false;
  let noColor = false;
  let noTelemetry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--quality=")) {
      const [, raw] = arg.split("=", 2);
      quality = raw;
      continue;
    }
    if (arg.startsWith("--iterate=")) {
      const [, raw] = arg.split("=", 2);
      iterate = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--resolve-open-questions=")) {
      const [, raw] = arg.split("=", 2);
      resolveOpenQuestions = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--no-placeholders=")) {
      const [, raw] = arg.split("=", 2);
      noPlaceholders = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--no-maybes=")) {
      const [, raw] = arg.split("=", 2);
      noMaybes = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--cross-align=")) {
      const [, raw] = arg.split("=", 2);
      crossAlign = parseBooleanFlag(raw, true);
      continue;
    }
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
      case "--fast":
        fast = true;
        break;
      case "--iterate": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          iterate = parseBooleanFlag(next, true);
          i += 1;
        } else {
          iterate = true;
        }
        break;
      }
      case "--quality": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          quality = next;
          i += 1;
        } else {
          quality = "";
        }
        break;
      }
      case "--resolve-open-questions": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          resolveOpenQuestions = parseBooleanFlag(next, true);
          i += 1;
        } else {
          resolveOpenQuestions = true;
        }
        break;
      }
      case "--no-placeholders": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          noPlaceholders = parseBooleanFlag(next, true);
          i += 1;
        } else {
          noPlaceholders = true;
        }
        break;
      }
      case "--no-maybes": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          noMaybes = parseBooleanFlag(next, true);
          i += 1;
        } else {
          noMaybes = true;
        }
        break;
      }
      case "--cross-align": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          crossAlign = parseBooleanFlag(next, true);
          i += 1;
        } else {
          crossAlign = true;
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

  const normalizedQuality = quality?.trim().toLowerCase();
  const buildReady = normalizedQuality === "build-ready";
  return {
    workspaceRoot,
    projectKey,
    rfpId,
    rfpPath,
    outPath,
    agentName,
    agentStream: agentStream ?? false,
    rateAgents,
    fast,
    iterate,
    quality,
    buildReady,
    resolveOpenQuestions,
    noPlaceholders,
    noMaybes,
    crossAlign,
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
  let rateAgents = false;
  let force = false;
  let fast = false;
  let iterate = false;
  let quality: string | undefined;
  let resolveOpenQuestions = false;
  let noPlaceholders = false;
  let noMaybes = false;
  let crossAlign = true;
  let resumeJobId: string | undefined;
  let dryRun = false;
  let json = false;
  let quiet = false;
  let debug = false;
  let noColor = false;
  let noTelemetry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--rate-agents=")) {
      const [, raw] = arg.split("=", 2);
      rateAgents = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--quality=")) {
      const [, raw] = arg.split("=", 2);
      quality = raw;
      continue;
    }
    if (arg.startsWith("--iterate=")) {
      const [, raw] = arg.split("=", 2);
      iterate = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--resolve-open-questions=")) {
      const [, raw] = arg.split("=", 2);
      resolveOpenQuestions = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--no-placeholders=")) {
      const [, raw] = arg.split("=", 2);
      noPlaceholders = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--no-maybes=")) {
      const [, raw] = arg.split("=", 2);
      noMaybes = parseBooleanFlag(raw, true);
      continue;
    }
    if (arg.startsWith("--cross-align=")) {
      const [, raw] = arg.split("=", 2);
      crossAlign = parseBooleanFlag(raw, true);
      continue;
    }
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
      case "--fast":
        fast = true;
        break;
      case "--iterate": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          iterate = parseBooleanFlag(next, true);
          i += 1;
        } else {
          iterate = true;
        }
        break;
      }
      case "--quality": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          quality = next;
          i += 1;
        } else {
          quality = "";
        }
        break;
      }
      case "--resolve-open-questions": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          resolveOpenQuestions = parseBooleanFlag(next, true);
          i += 1;
        } else {
          resolveOpenQuestions = true;
        }
        break;
      }
      case "--no-placeholders": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          noPlaceholders = parseBooleanFlag(next, true);
          i += 1;
        } else {
          noPlaceholders = true;
        }
        break;
      }
      case "--no-maybes": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          noMaybes = parseBooleanFlag(next, true);
          i += 1;
        } else {
          noMaybes = true;
        }
        break;
      }
      case "--cross-align": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          crossAlign = parseBooleanFlag(next, true);
          i += 1;
        } else {
          crossAlign = true;
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

  const normalizedQuality = quality?.trim().toLowerCase();
  const buildReady = normalizedQuality === "build-ready";
  return {
    workspaceRoot,
    projectKey,
    outPath,
    agentName,
    templateName,
    agentStream: agentStream ?? false,
    rateAgents,
    fast,
    iterate,
    quality,
    buildReady,
    resolveOpenQuestions,
    noPlaceholders,
    noMaybes,
    crossAlign,
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

const resolveBuildReady = (quality: string | undefined, usage: string): boolean => {
  if (quality === undefined) return false;
  const trimmed = quality.trim();
  if (!trimmed) {
    throw new Error(`Missing --quality value.\n\n${usage}`);
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "build-ready") return true;
  throw new Error(`Unsupported --quality value: ${quality}\n\n${usage}`);
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
        const buildReady = resolveBuildReady(parsed.quality, sdsUsage);
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
          rateAgents: parsed.rateAgents,
          fast: parsed.fast,
          iterate: parsed.iterate,
          buildReady,
          resolveOpenQuestions: parsed.resolveOpenQuestions,
          noPlaceholders: parsed.noPlaceholders,
          noMaybes: parsed.noMaybes,
          crossAlign: parsed.crossAlign,
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
      const buildReady = resolveBuildReady(parsed.quality, pdrUsage);
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
        rateAgents: parsed.rateAgents,
        fast: parsed.fast,
        iterate: parsed.iterate,
        buildReady,
        resolveOpenQuestions: parsed.resolveOpenQuestions,
        noPlaceholders: parsed.noPlaceholders,
        noMaybes: parsed.noMaybes,
        crossAlign: parsed.crossAlign,
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
