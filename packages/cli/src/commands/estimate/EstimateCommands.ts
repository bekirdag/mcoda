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
    velocityMode: "empirical",
    velocityWindow: 50,
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
        {
          const mode = parseVelocityMode(argv[i + 1]);
          if (mode) {
            parsed.velocityMode = mode;
          }
        }
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
          const mode = parseVelocityMode(arg.split("=")[1]);
          if (mode) {
            parsed.velocityMode = mode;
          }
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

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

const stripAnsi = (value: string): string => value.replace(ANSI_REGEX, "");

const visibleLength = (value: string): number => stripAnsi(value).length;

const padVisible = (value: string, width: number): string => {
  const diff = width - visibleLength(value);
  return diff > 0 ? `${value}${" ".repeat(diff)}` : value;
};

const colorize = (enabled: boolean, code: number, value: string): string =>
  enabled ? `\x1b[${code}m${value}\x1b[0m` : value;

const style = {
  bold: (enabled: boolean, value: string) => colorize(enabled, 1, value),
  dim: (enabled: boolean, value: string) => colorize(enabled, 2, value),
  blue: (enabled: boolean, value: string) => colorize(enabled, 34, value),
  cyan: (enabled: boolean, value: string) => colorize(enabled, 36, value),
  green: (enabled: boolean, value: string) => colorize(enabled, 32, value),
  yellow: (enabled: boolean, value: string) => colorize(enabled, 33, value),
  magenta: (enabled: boolean, value: string) => colorize(enabled, 35, value),
  red: (enabled: boolean, value: string) => colorize(enabled, 31, value),
};

const formatPanel = (lines: string[]): string => {
  const width = Math.max(0, ...lines.map((line) => visibleLength(line)));
  const top = `╭${"─".repeat(width + 2)}╮`;
  const body = lines.map((line) => `│ ${padVisible(line, width)} │`);
  const bottom = `╰${"─".repeat(width + 2)}╯`;
  return [top, ...body, bottom].join("\n");
};

const formatBoxTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, idx) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[idx] ?? ""))));
  const border = (left: string, join: string, right: string): string =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(join)}${right}`;
  const headerLine = `│${headers.map((header, idx) => ` ${padVisible(header, widths[idx])} `).join("│")}│`;
  const rowLines = rows.map(
    (row) => `│${row.map((cell, idx) => ` ${padVisible(cell ?? "", widths[idx])} `).join("│")}│`,
  );
  return [
    border("╭", "┬", "╮"),
    headerLine,
    border("├", "┼", "┤"),
    ...rowLines,
    border("╰", "┴", "╯"),
  ].join("\n");
};

const fmt = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "N/A";
  if (Number.isInteger(value)) return `${value}`;
  return value.toFixed(2);
};

export const formatTimeLeft = (hours: number | null | undefined): string => {
  if (hours === null || hours === undefined) return "N/A";
  if (!Number.isFinite(hours) || hours <= 0) return "0h";

  let remainingHours = Math.max(1, Math.round(hours));
  const monthHours = 24 * 30;
  const weekHours = 24 * 7;
  const dayHours = 24;

  const months = Math.floor(remainingHours / monthHours);
  remainingHours -= months * monthHours;

  const weeks = Math.floor(remainingHours / weekHours);
  remainingHours -= weeks * weekHours;

  const days = Math.floor(remainingHours / dayHours);
  remainingHours -= days * dayHours;

  const parts: string[] = [];
  if (months > 0) parts.push(`${months}mo`);
  if (weeks > 0) parts.push(`${weeks}w`);
  if (days > 0) parts.push(`${days}d`);
  if (remainingHours > 0 || parts.length === 0) parts.push(`${remainingHours}h`);
  return parts.join("");
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

type ProgressBarTheme = {
  full: (value: string) => string;
  partial: (value: string) => string;
  empty: (value: string) => string;
};

const createBar = (percentValue: number, theme: ProgressBarTheme): string => {
  const percent = Math.max(0, Math.min(100, Number.isFinite(percentValue) ? percentValue : 0));
  const rounded = Math.round(percent);
  const width = 10;
  if (rounded <= 0) {
    return theme.empty("░".repeat(width));
  }
  if (rounded >= 100) {
    return theme.full("█".repeat(width));
  }
  const fullCount = Math.min(width - 1, Math.floor((rounded / 100) * width));
  const partialCount = 1;
  const emptyCount = Math.max(0, width - fullCount - partialCount);
  return `${theme.full("█".repeat(fullCount))}${theme.partial("▒".repeat(partialCount))}${theme.empty("░".repeat(emptyCount))}`;
};

const renderProgressSection = (result: EstimateResult, colorEnabled: boolean): string => {
  const work = result.completion.workOnTasks;
  const qa = result.completion.readyToQa;
  const done = result.completion.done;
  const labels = [
    "🛠️ Work on tasks",
    "🧪 Ready to qa",
    "✅ Done",
  ];
  const maxLabel = Math.max(...labels.map((label) => visibleLength(label)));
  const formatLine = (
    label: string,
    metric: { done: number; total: number; percent: number },
    theme: ProgressBarTheme,
  ): string => {
    const bar = createBar(metric.percent, theme);
    const percent = `${Math.round(metric.percent)}%`;
    return `${padVisible(label, maxLabel)} : ${bar} ${percent} (${metric.done}/${metric.total})`;
  };
  return formatPanel([
    style.bold(colorEnabled, "📊 Completion"),
    formatLine("🛠️ Work on tasks", work, {
      full: (value) => style.cyan(colorEnabled, value),
      partial: (value) => style.blue(colorEnabled, value),
      empty: (value) => style.dim(colorEnabled, value),
    }),
    formatLine("🧪 Ready to qa", qa, {
      full: (value) => style.yellow(colorEnabled, value),
      partial: (value) => style.magenta(colorEnabled, value),
      empty: (value) => style.dim(colorEnabled, value),
    }),
    formatLine("✅ Done", done, {
      full: (value) => style.green(colorEnabled, value),
      partial: (value) => style.yellow(colorEnabled, value),
      empty: (value) => style.dim(colorEnabled, value),
    }),
  ]);
};

const renderResult = (result: EstimateResult, options: { colorEnabled: boolean }): void => {
  const { colorEnabled } = options;
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
      formatTimeLeft(result.durationsHours.implementationHours),
    ],
    [
      "Review",
      fmt(result.backlogTotals.review.story_points),
      fmt(result.effectiveVelocity.reviewSpPerHour),
      formatTimeLeft(result.durationsHours.reviewHours),
    ],
    [
      "QA",
      fmt(result.backlogTotals.qa.story_points),
      fmt(result.effectiveVelocity.qaSpPerHour),
      formatTimeLeft(result.durationsHours.qaHours),
    ],
    [
      "Done",
      fmt(result.backlogTotals.done.story_points),
      fmt(null),
      formatTimeLeft(0),
    ],
    [
      "Total",
      fmt(totalSp),
      fmt(null),
      formatTimeLeft(result.durationsHours.totalHours),
    ],
  ];
  // eslint-disable-next-line no-console
  console.log(
    formatPanel([
      style.bold(colorEnabled, "🧮 Effort by Lane"),
      formatBoxTable(
        [
          style.bold(colorEnabled, "LANE"),
          style.bold(colorEnabled, "STORY POINTS"),
          style.bold(colorEnabled, spHeader.toUpperCase()),
          style.bold(colorEnabled, "TIME LEFT"),
        ],
        rows,
      ),
    ]),
  );
  const counts = result.statusCounts;
  // eslint-disable-next-line no-console
  console.log(
    formatPanel([
      style.bold(colorEnabled, "📌 Task Status"),
      `${style.bold(colorEnabled, "Total tasks")}           : ${counts.total}`,
      `${style.cyan(colorEnabled, "Ready to code review")} : ${counts.readyToCodeReview}`,
      `${style.yellow(colorEnabled, "Ready to qa")}         : ${counts.readyToQa}`,
      `${style.blue(colorEnabled, "In progress")}          : ${counts.inProgress}`,
      `${style.red(colorEnabled, "Failed")}               : ${counts.failed}`,
      `${style.green(colorEnabled, "Completed")}            : ${counts.completed}`,
    ]),
  );
  // eslint-disable-next-line no-console
  console.log(renderProgressSection(result, colorEnabled));
  const samples = velocity.samples ?? { implementation: 0, review: 0, qa: 0 };
  const windowLabel = velocity.windowTasks ? ` (window ${velocity.windowTasks})` : "";
  const fallbackNote =
    velocity.requestedMode && velocity.requestedMode !== velocity.source
      ? ` (requested ${velocity.requestedMode}; no empirical samples, using config)`
      : "";
  // eslint-disable-next-line no-console
  console.log(
    formatPanel([
      style.bold(colorEnabled, "📈 Velocity"),
      `${style.bold(colorEnabled, "Velocity source")} : ${velocity.source}${fallbackNote}`,
      `${style.bold(colorEnabled, "Samples")}${windowLabel}        : impl=${samples.implementation ?? 0}, review=${samples.review ?? 0}, qa=${samples.qa ?? 0}`,
    ]),
  );
  // eslint-disable-next-line no-console
  console.log(
    formatPanel([
      style.bold(colorEnabled, "⏱️ ETAs"),
      formatBoxTable(
        [
          style.bold(colorEnabled, "READY TO REVIEW"),
          style.bold(colorEnabled, "READY TO QA"),
          style.bold(colorEnabled, "COMPLETE"),
        ],
        [
          [
            formatEtaCell(result.etas.readyToReviewEta),
            formatEtaCell(result.etas.readyToQaEta),
            formatEtaCell(result.etas.completeEta),
          ],
        ],
      ),
    ]),
  );
  // eslint-disable-next-line no-console
  console.log(
    formatPanel([
      `${style.bold(colorEnabled, "ℹ️ Assumptions")} : lane work runs in parallel; total hours uses the longest lane.`,
    ]),
  );
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
        const colorEnabled = !parsed.noColor;
        const totalTasks =
          result.backlogTotals.implementation.tasks +
          result.backlogTotals.review.tasks +
          result.backlogTotals.qa.tasks +
          result.backlogTotals.done.tasks;
        const scopeText = `project=${parsed.project ?? "all"}${parsed.epic ? `, epic=${parsed.epic}` : ""}${
          parsed.story ? `, story=${parsed.story}` : ""
        }${parsed.assignee ? `, assignee=${parsed.assignee}` : ""}`;
        // eslint-disable-next-line no-console
        console.log(formatPanel([`${style.bold(colorEnabled, "🧭 Scope")} : ${scopeText}`]));
        if (totalTasks === 0) {
          // eslint-disable-next-line no-console
          console.log(
            formatPanel([style.yellow(colorEnabled, "No tasks found in the selected scope. Showing zeroed estimate.")]),
          );
        }
        renderResult(result, { colorEnabled });
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
