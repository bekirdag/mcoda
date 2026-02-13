import path from "node:path";
import {
  EstimateService,
  JobService,
  VelocitySource,
  WorkspaceResolver,
  type EstimateResult,
} from "@mcoda/core";

interface ParsedArgs {
  workspaceRoot?: string;
  project?: string;
  epic?: string;
  story?: string;
  assignee?: string;
  quiet: boolean;
  noColor: boolean;
  noTelemetry: boolean;
  spPerHour?: number;
  spPerHourImplementation?: number;
  spPerHourReview?: number;
  spPerHourQa?: number;
  velocityMode?: VelocitySource;
  velocityWindow?: 10 | 20 | 50;
  json: boolean;
  debug: boolean;
}

const usage = `mcoda estimate \\
  [--workspace <PATH>] \\
  [--project <PROJECT_KEY>] \\
  [--epic <EPIC_KEY>] \\
  [--story <STORY_KEY>] \\
  [--assignee <USER>] \\
  [--sp-per-hour <FLOAT>] \\
  [--sp-per-hour-implementation <FLOAT>] \\
  [--sp-per-hour-review <FLOAT>] \\
  [--sp-per-hour-qa <FLOAT>] \\
  [--velocity-mode config|empirical|mixed] \\
  [--velocity-window 10|20|50] \\
  [--quiet] [--no-color] [--no-telemetry] \\
  [--json]`;

const parseNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseVelocityMode = (value: string | undefined): VelocitySource | undefined => {
  if (!value) return undefined;
  if (value === "config" || value === "empirical" || value === "mixed") return value;
  return undefined;
};

export const parseEstimateArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    json: false,
    debug: false,
    quiet: false,
    noColor: false,
    noTelemetry: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) continue;
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        parsed.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
        parsed.project = argv[i + 1];
        i += 1;
        break;
      case "--epic":
        parsed.epic = argv[i + 1];
        i += 1;
        break;
      case "--story":
        parsed.story = argv[i + 1];
        i += 1;
        break;
      case "--assignee":
        parsed.assignee = argv[i + 1];
        i += 1;
        break;
      case "--quiet":
        parsed.quiet = true;
        break;
      case "--no-color":
        parsed.noColor = true;
        break;
      case "--no-telemetry":
        parsed.noTelemetry = true;
        break;
      case "--sp-per-hour":
        parsed.spPerHour = parseNumber(argv[i + 1]);
        i += 1;
        break;
      case "--sp-per-hour-implementation":
        parsed.spPerHourImplementation = parseNumber(argv[i + 1]);
        i += 1;
        break;
      case "--sp-per-hour-review":
        parsed.spPerHourReview = parseNumber(argv[i + 1]);
        i += 1;
        break;
      case "--sp-per-hour-qa":
        parsed.spPerHourQa = parseNumber(argv[i + 1]);
        i += 1;
        break;
      case "--velocity-mode":
        parsed.velocityMode = parseVelocityMode(argv[i + 1]);
        i += 1;
        break;
      case "--velocity-window":
      case "--window": {
        const value = parseNumber(argv[i + 1]);
        if (value === 10 || value === 20 || value === 50) {
          parsed.velocityWindow = value;
        }
        i += 1;
        break;
      }
      default:
        if (arg === "--json") {
          parsed.json = true;
        } else if (arg === "--debug") {
          parsed.debug = true;
        } else if (arg === "--quiet") {
          parsed.quiet = true;
        } else if (arg === "--no-color") {
          parsed.noColor = true;
        } else if (arg === "--no-telemetry") {
          parsed.noTelemetry = true;
        } else if (arg === "--help" || arg === "-h") {
          // eslint-disable-next-line no-console
          console.log(usage);
          process.exit(0);
        } else if (arg.startsWith("--project=")) {
          parsed.project = arg.split("=")[1];
        } else if (arg.startsWith("--epic=")) {
          parsed.epic = arg.split("=")[1];
        } else if (arg.startsWith("--story=")) {
          parsed.story = arg.split("=")[1];
        } else if (arg.startsWith("--assignee=")) {
          parsed.assignee = arg.split("=")[1];
        } else if (arg.startsWith("--velocity-mode=")) {
          parsed.velocityMode = parseVelocityMode(arg.split("=")[1]);
        } else if (arg.startsWith("--velocity-window=") || arg.startsWith("--window=")) {
          const value = parseNumber(arg.split("=")[1]);
          if (value === 10 || value === 20 || value === 50) {
            parsed.velocityWindow = value;
          }
        } else if (arg.startsWith("--sp-per-hour=")) {
          parsed.spPerHour = parseNumber(arg.split("=")[1]);
        } else if (arg.startsWith("--sp-per-hour-implementation=")) {
          parsed.spPerHourImplementation = parseNumber(arg.split("=")[1]);
        } else if (arg.startsWith("--sp-per-hour-review=")) {
          parsed.spPerHourReview = parseNumber(arg.split("=")[1]);
        } else if (arg.startsWith("--sp-per-hour-qa=")) {
          parsed.spPerHourQa = parseNumber(arg.split("=")[1]);
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

const fmt = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(2);
};

const pad2 = (value: number): string => `${value}`.padStart(2, "0");

const formatLocalDateTime = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;

const formatRelativeDuration = (targetMs: number, nowMs: number): string => {
  const diffMs = targetMs - nowMs;
  const sign = diffMs < 0 ? "-" : "+";
  let remaining = Math.abs(diffMs);
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const minuteMs = 60 * 1000;
  const days = Math.floor(remaining / dayMs);
  remaining -= days * dayMs;
  const hours = Math.floor(remaining / hourMs);
  remaining -= hours * hourMs;
  const minutes = Math.floor(remaining / minuteMs);
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
  } else if (hours > 0) {
    parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
  } else {
    parts.push(`${minutes}m`);
  }

  return `${sign}${parts.join(" ")}`;
};

const formatEtaCell = (eta?: string): string => {
  if (!eta) return "N/A";
  const date = new Date(eta);
  if (Number.isNaN(date.getTime())) return eta;
  const local = formatLocalDateTime(date);
  const relative = formatRelativeDuration(date.getTime(), Date.now());
  return `${eta} (local ${local}, ${relative})`;
};

const renderResult = (result: EstimateResult): void => {
  const velocity = result.effectiveVelocity;
  const source = velocity.source;
  const spHeader = `SP/H (${source})`;
  const totalSp =
    result.backlogTotals.implementation.story_points +
    result.backlogTotals.review.story_points +
    result.backlogTotals.qa.story_points +
    result.backlogTotals.done.story_points;
  const rows = [
    [
      "Implementation",
      fmt(result.backlogTotals.implementation.story_points),
      fmt(result.effectiveVelocity.implementationSpPerHour),
      fmt(result.durationsHours.implementationHours),
    ],
    [
      "Review",
      fmt(result.backlogTotals.review.story_points),
      fmt(result.effectiveVelocity.reviewSpPerHour),
      fmt(result.durationsHours.reviewHours),
    ],
    [
      "QA",
      fmt(result.backlogTotals.qa.story_points),
      fmt(result.effectiveVelocity.qaSpPerHour),
      fmt(result.durationsHours.qaHours),
    ],
    [
      "Done",
      fmt(result.backlogTotals.done.story_points),
      fmt(null),
      fmt(0),
    ],
    [
      "Total",
      fmt(totalSp),
      fmt(null),
      fmt(result.durationsHours.totalHours),
    ],
  ];
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["LANE", "STORY_POINTS", spHeader, "HOURS"],
      rows,
    ),
  );
  const samples = velocity.samples ?? { implementation: 0, review: 0, qa: 0 };
  const windowLabel = velocity.windowTasks ? ` (window ${velocity.windowTasks})` : "";
  const fallbackNote =
    velocity.requestedMode && velocity.requestedMode !== velocity.source
      ? ` (requested ${velocity.requestedMode}; no empirical samples, using config)`
      : "";
  // eslint-disable-next-line no-console
  console.log(`\nVelocity source: ${velocity.source}${fallbackNote}`);
  // eslint-disable-next-line no-console
  console.log(
    `Velocity samples${windowLabel}: impl=${samples.implementation ?? 0}, review=${samples.review ?? 0}, qa=${samples.qa ?? 0}`,
  );
  // eslint-disable-next-line no-console
  console.log("ETAs:");
  // eslint-disable-next-line no-console
  console.log(
    formatTable(
      ["READY_TO_REVIEW", "READY_TO_QA", "COMPLETE"],
      [
        [
          formatEtaCell(result.etas.readyToReviewEta),
          formatEtaCell(result.etas.readyToQaEta),
          formatEtaCell(result.etas.completeEta),
        ],
      ],
    ),
  );
  // eslint-disable-next-line no-console
  console.log("\nAssumptions: lane work runs in parallel; total hours uses the longest lane.");
};

export class EstimateCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseEstimateArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    const service = await EstimateService.create(workspace);
    const jobService = new JobService(workspace, undefined, { noTelemetry: parsed.noTelemetry });
    const commandRun = await jobService.startCommandRun("estimate", parsed.project);

    try {
      const result = await service.estimate({
        projectKey: parsed.project,
        epicKey: parsed.epic,
        storyKey: parsed.story,
        assignee: parsed.assignee,
        mode: parsed.velocityMode,
        windowTasks: parsed.velocityWindow,
        spPerHourAll: parsed.spPerHour,
        spPerHourImplementation: parsed.spPerHourImplementation,
        spPerHourReview: parsed.spPerHourReview,
        spPerHourQa: parsed.spPerHourQa,
      });

      const totalSp =
        result.backlogTotals.implementation.story_points +
        result.backlogTotals.review.story_points +
        result.backlogTotals.qa.story_points +
        result.backlogTotals.done.story_points;

      await jobService.finishCommandRun(commandRun.id, "succeeded", undefined, totalSp);

      if (parsed.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
      } else if (!parsed.quiet) {
        const totalTasks =
          result.backlogTotals.implementation.tasks +
          result.backlogTotals.review.tasks +
          result.backlogTotals.qa.tasks +
          result.backlogTotals.done.tasks;
        // eslint-disable-next-line no-console
        console.log(
          `Scope: project=${parsed.project ?? "all"}${parsed.epic ? `, epic=${parsed.epic}` : ""}${
            parsed.story ? `, story=${parsed.story}` : ""
          }${parsed.assignee ? `, assignee=${parsed.assignee}` : ""}`,
        );
        if (totalTasks === 0) {
          // eslint-disable-next-line no-console
          console.log("No tasks found in the selected scope. Showing zeroed estimate.");
        }
        renderResult(result);
      }
    } catch (error) {
      await jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      // eslint-disable-next-line no-console
      console.error(`estimate failed: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await service.close?.();
      await jobService.close?.();
    }
  }
}
