import path from "node:path";
import { createRequire } from "node:module";
import { OpenApiJobError, OpenApiService, WorkspaceResolver } from "@mcoda/core";

const usage =
  "mcoda openapi-from-docs [--workspace-root <PATH>] [--project <PROJECT_KEY>] [--agent <NAME>] [--agent-stream <true|false>] [--rate-agents] [--force] [--dry-run] [--validate-only] [--no-telemetry]";

export interface ParsedOpenapiArgs {
  workspaceRoot?: string;
  project?: string;
  agentName?: string;
  agentStream: boolean;
  rateAgents: boolean;
  force: boolean;
  dryRun: boolean;
  validateOnly: boolean;
  noTelemetry: boolean;
}

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseOpenapiArgs = (argv: string[]): ParsedOpenapiArgs => {
  let workspaceRoot: string | undefined;
  let project: string | undefined;
  let agentName: string | undefined;
  let agentStream: boolean | undefined;
  let rateAgents = false;
  let force = false;
  let dryRun = false;
  let validateOnly = false;
  let noTelemetry = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--agent-stream=")) {
      const [, raw] = arg.split("=", 2);
      agentStream = parseBooleanFlag(raw, true);
      continue;
    }
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
      case "--project":
        project = argv[i + 1];
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
      case "--force":
        force = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--validate-only":
        validateOnly = true;
        break;
      case "--no-telemetry":
        noTelemetry = true;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(usage);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--project=")) {
          project = arg.split("=")[1];
        }
        break;
    }
  }

  return {
    workspaceRoot,
    project,
    agentName,
    agentStream: agentStream ?? false,
    rateAgents,
    force,
    dryRun,
    validateOnly,
    noTelemetry,
  };
};

const readCliVersion = (): string => {
  const require = createRequire(import.meta.url);
  try {
    // Resolve the package version from the CLI package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

export const formatOpenapiErrorOutput = (error: unknown): string[] => {
  if (error instanceof OpenApiJobError) {
    const jobLabel = error.jobId ? ` ${error.jobId}` : "";
    const lines: string[] = [`ERROR: ${error.message || `OpenAPI job${jobLabel} failed.`}`];
    if (error.code === "timeout") {
      lines.push("Hint: set MCODA_OPENAPI_TIMEOUT_SECONDS to extend the timeout.");
    }
    if (error.code === "cancelled") {
      lines.push("Hint: rerun the command if the cancellation was accidental.");
    }
    if (error.jobId) {
      lines.push(`Resume: mcoda job resume ${error.jobId}`);
    }
    return lines;
  }
  const message = error instanceof Error ? error.message : String(error);
  return [`ERROR: ${message}`];
};

export class OpenapiCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseOpenapiArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const service = await OpenApiService.create(workspace, { noTelemetry: parsed.noTelemetry });
    try {
      const cliVersion = readCliVersion();
      const shouldStream = parsed.agentStream;
      const onToken = shouldStream ? (token: string) => process.stdout.write(token) : undefined;
      const result = await service.generateFromDocs({
        workspace,
        projectKey: parsed.project,
        agentName: parsed.agentName,
        agentStream: parsed.agentStream,
        rateAgents: parsed.rateAgents,
        force: parsed.force,
        dryRun: parsed.dryRun,
        validateOnly: parsed.validateOnly,
        cliVersion,
        onToken,
      });
      if (shouldStream) {
        // separate streamed content from the summary
        // eslint-disable-next-line no-console
        console.log("\n");
      }
      // eslint-disable-next-line no-console
      console.log(`OpenAPI job ${result.jobId} ${parsed.validateOnly ? "validated" : "completed"}.`);
      if (result.outputPath) {
        // eslint-disable-next-line no-console
        console.log(`Output: ${result.outputPath}${parsed.dryRun ? " (dry run, not written)" : ""}`);
      } else if (parsed.dryRun) {
        // eslint-disable-next-line no-console
        console.log("Dry run: spec not written to disk.");
      }
      if (result.adminOutputPath) {
        // eslint-disable-next-line no-console
        console.log(`Admin Output: ${result.adminOutputPath}`);
      }
      if (result.docdexId) {
        // eslint-disable-next-line no-console
        console.log(`Docdex ID: ${result.docdexId}`);
      }
      if (result.adminDocdexId) {
        // eslint-disable-next-line no-console
        console.log(`Admin Docdex ID: ${result.adminDocdexId}`);
      }
      if (result.warnings.length) {
        const banner = result.warnings.map((w) => `! ${w}`).join("\n");
        // eslint-disable-next-line no-console
        console.warn(banner);
      }
      if (parsed.dryRun) {
        // eslint-disable-next-line no-console
        console.log("\n--- Generated OpenAPI ---\n");
        // eslint-disable-next-line no-console
        console.log(result.spec);
        if (result.adminSpec) {
          // eslint-disable-next-line no-console
          console.log("\n--- Generated Admin OpenAPI ---\n");
          // eslint-disable-next-line no-console
          console.log(result.adminSpec);
        }
      }
    } catch (error) {
      const lines = formatOpenapiErrorOutput(error);
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.error(line);
      }
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
