import path from "node:path";
import { JobService, TelemetryService, TokenUsageSummaryRow, TelemetryConfigState, WorkspaceResolver } from "@mcoda/core";

type OutputFormat = "table" | "json";

interface TokensArgs {
  workspaceRoot?: string;
  project?: string;
  agent?: string;
  command?: string;
  job?: string;
  since?: string;
  until?: string;
  groupBy: string[];
  format: OutputFormat;
}

interface TelemetryArgs {
  workspaceRoot?: string;
  subcommand: "show" | "opt-out" | "opt-in";
  format: OutputFormat;
  strict?: boolean;
}

const tokensUsage = `mcoda tokens \\
  [--workspace-root <PATH>] \\
  [--project <PROJECT_KEY|ID>] \\
  [--agent <NAME|ID>] \\
  [--command <COMMAND_NAME>] \\
  [--job <JOB_ID>] \\
  [--since <ISO_TIMESTAMP|DURATION>] \\
  [--until <ISO_TIMESTAMP>] \\
  [--group-by <project|agent|command|day|model|job|action>] \\
  [--format <table|json>]`;

const telemetryUsage = `mcoda telemetry <show|opt-out|opt-in> \\
  [--workspace-root <PATH>] \\
  [--format <table|json>] \\
  [--strict] (opt-out only)`;

const normalizeGroupBy = (input?: string[]): string[] => {
  const allowed = new Set(["project", "agent", "command", "day", "model", "job", "action"]);
  const selected = (input ?? []).filter((dim) => allowed.has(dim));
  if (selected.length === 0) {
    return ["project", "command", "agent"];
  }
  return Array.from(new Set(selected));
};

export const parseTokensArgs = (argv: string[]): TokensArgs => {
  const parsed: TokensArgs = {
    groupBy: [],
    format: "table",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace-root":
      case "--workspace":
        parsed.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        parsed.project = argv[i + 1];
        i += 1;
        break;
      case "--agent":
        parsed.agent = argv[i + 1];
        i += 1;
        break;
      case "--command":
        parsed.command = argv[i + 1];
        i += 1;
        break;
      case "--job":
        parsed.job = argv[i + 1];
        i += 1;
        break;
      case "--since":
        parsed.since = argv[i + 1];
        i += 1;
        break;
      case "--until":
        parsed.until = argv[i + 1];
        i += 1;
        break;
      case "--group-by":
        parsed.groupBy = (argv[i + 1] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
        i += 1;
        break;
      case "--format":
        parsed.format = argv[i + 1] === "json" ? "json" : "table";
        i += 1;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(tokensUsage);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--group-by=")) {
          parsed.groupBy = arg
            .split("=")[1]
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        } else if (arg.startsWith("--format=")) {
          parsed.format = arg.endsWith("json") ? "json" : "table";
        } else if (arg.startsWith("--job=")) {
          parsed.job = arg.split("=")[1];
        }
        break;
    }
  }
  parsed.groupBy = normalizeGroupBy(parsed.groupBy);
  return parsed;
};

export const parseTelemetryArgs = (argv: string[]): TelemetryArgs => {
  let subcommand: TelemetryArgs["subcommand"] = "show";
  const parsed: TelemetryArgs = {
    subcommand,
    format: "table",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") && i === 0) {
      subcommand = (arg as TelemetryArgs["subcommand"]) ?? "show";
      parsed.subcommand = subcommand;
      continue;
    }
    switch (arg) {
      case "--workspace-root":
      case "--workspace":
        parsed.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--format":
        parsed.format = argv[i + 1] === "json" ? "json" : "table";
        i += 1;
        break;
      case "--strict":
        parsed.strict = true;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(telemetryUsage);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--format=")) {
          parsed.format = arg.endsWith("json") ? "json" : "table";
        }
        break;
    }
  }
  return parsed;
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const formatTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)));
  const headerLine = headers.map((h, idx) => pad(h, widths[idx])).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join(" | ")).join("\n");
  return [headerLine, sepLine, body].filter(Boolean).join("\n");
};

const formatNumber = (value: number | null | undefined, digits = 0): string => {
  if (value === null || value === undefined) return "-";
  if (digits > 0) return value.toFixed(digits);
  return `${value}`;
};

const renderTokensTable = (rows: TokenUsageSummaryRow[], groupBy: string[]): void => {
  const dims = new Set(groupBy);
  const headers: string[] = [];
  const extractors: ((row: TokenUsageSummaryRow) => string)[] = [];

  if (dims.has("project")) {
    headers.push("PROJECT");
    extractors.push((row) => row.project_id ?? "-");
  }
  if (dims.has("command")) {
    headers.push("COMMAND");
    extractors.push((row) => row.command_name ?? "-");
  }
  if (dims.has("agent")) {
    headers.push("AGENT");
    extractors.push((row) => row.agent_id ?? "-");
  }
  if (dims.has("model")) {
    headers.push("MODEL");
    extractors.push((row) => row.model_name ?? "-");
  }
  if (dims.has("day")) {
    headers.push("DAY");
    extractors.push((row) => row.day ?? "-");
  }
  if (dims.has("job")) {
    headers.push("JOB");
    extractors.push((row) => row.job_id ?? "-");
  }
  if (dims.has("action")) {
    headers.push("ACTION");
    extractors.push((row) => row.action ?? "-");
  }

  headers.push("CALLS", "TOKENS_IN", "TOKENS_OUT", "TOKENS_TOTAL", "COST");
  extractors.push(
    (row) => `${row.calls}`,
    (row) => formatNumber(row.tokens_prompt),
    (row) => formatNumber(row.tokens_completion),
    (row) => formatNumber(row.tokens_total),
    (row) => formatNumber(row.cost_estimate, 4),
  );

  const tableRows = rows.map((row) => extractors.map((fn) => fn(row)));
  // eslint-disable-next-line no-console
  console.log(formatTable(headers, tableRows));
};

const renderTelemetryConfig = (config: TelemetryConfigState): void => {
  const rows = [
    ["Local recording", config.localRecording ? "enabled" : "disabled"],
    ["Remote export", config.remoteExport ? "enabled" : "disabled"],
    ["Strict mode", config.strict ? "on" : "off"],
    ["Config path", config.configPath],
  ];
  // eslint-disable-next-line no-console
  console.log(formatTable(["SETTING", "VALUE"], rows));
};

export class TelemetryCommands {
  static async runTokens(argv: string[]): Promise<void> {
    const parsed = parseTokensArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const jobService = new JobService(workspace.workspaceRoot, undefined, { noTelemetry: true });
    const commandRun = await jobService.startCommandRun("tokens", parsed.project);
    const telemetry = await TelemetryService.create(workspace);
    try {
      const config = await telemetry.getConfig();
      const summary = await telemetry.getSummary({
        projectKey: parsed.project,
        agent: parsed.agent,
        command: parsed.command,
        jobId: parsed.job,
        since: parsed.since,
        until: parsed.until,
        groupBy: parsed.groupBy as any,
      });
      if (!config.localRecording && summary.length === 0) {
        // eslint-disable-next-line no-console
        console.log("Local token tracking is disabled; no data available.");
        return;
      }
      if (summary.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No telemetry data for the selected filters/time window.");
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }
      if (parsed.format === "json") {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(summary, null, 2));
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }
      renderTokensTable(summary, parsed.groupBy);
      await jobService.finishCommandRun(commandRun.id, "succeeded");
    } catch (error) {
      await jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      const message = (error as Error).message ?? "Unknown error";
      if (message.includes("workspace DB") || message.includes("workspace")) {
        // eslint-disable-next-line no-console
        console.error("No mcoda workspace/DB found. Run mcoda init or create-tasks in this repo first.");
      } else {
        // eslint-disable-next-line no-console
        console.error(`tokens failed: ${message}`);
      }
      process.exitCode = 1;
    } finally {
      await jobService.close();
      await telemetry.close();
    }
  }

  static async runTelemetry(argv: string[]): Promise<void> {
    const parsed = parseTelemetryArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const jobService = new JobService(workspace.workspaceRoot, undefined, { noTelemetry: true });
    const commandRun = await jobService.startCommandRun(`telemetry-${parsed.subcommand}`, undefined);
    const telemetry = await TelemetryService.create(workspace, { allowMissingTelemetry: true });
    try {
      if (parsed.subcommand === "show") {
        const config = await telemetry.getConfig();
        if (parsed.format === "json") {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(config, null, 2));
        } else {
          renderTelemetryConfig(config);
        }
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }
      if (parsed.subcommand === "opt-out") {
        const config = await telemetry.optOut(parsed.strict ?? false);
        // eslint-disable-next-line no-console
        console.log(
          `Telemetry opted out.${config.strict ? " Strict mode enabled; local recording disabled." : " Local recording still enabled."}`,
        );
        await jobService.finishCommandRun(commandRun.id, "succeeded");
        return;
      }
      if (parsed.subcommand === "opt-in") {
        const config = await telemetry.optIn();
        // eslint-disable-next-line no-console
        console.log(
          `Telemetry opted in. Local recording ${config.localRecording ? "enabled" : "disabled"}, remote export ${config.remoteExport ? "enabled" : "disabled"}.`,
        );
        await jobService.finishCommandRun(commandRun.id, "succeeded");
      }
    } catch (error) {
      await jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      const message = (error as Error).message ?? "Unknown error";
      if (message.includes("workspace DB") || message.includes("workspace")) {
        // eslint-disable-next-line no-console
        console.error("No mcoda workspace/DB found. Run mcoda init or create-tasks in this repo first.");
      } else {
        // eslint-disable-next-line no-console
        console.error(`telemetry ${parsed.subcommand} failed: ${message}`);
      }
      process.exitCode = 1;
    } finally {
      await jobService.close();
      await telemetry.close();
    }
  }
}
