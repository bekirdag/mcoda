import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../config/ConfigLoader.js";
import { EvalTaskExecutor } from "../eval/EvalTaskExecutor.js";
import { EvalRunner } from "../eval/EvalRunner.js";
import { evaluateGates, resolveGateThresholds } from "../eval/GateEvaluator.js";
import { aggregateMetrics } from "../eval/MetricsAggregator.js";
import { compareAgainstBaseline } from "../eval/RegressionComparator.js";
import { type EvalReport, serializeEvalReport } from "../eval/ReportSerializer.js";
import { ReportStore } from "../eval/ReportStore.js";
import { loadSuiteFromFile } from "../eval/SuiteLoader.js";
import { SuiteValidationError } from "../eval/SuiteSchema.js";
import { resolveWorkspaceRoot } from "./RunCommand.js";

export const EVAL_EXIT_CODES = {
  usage_error: 2,
  suite_validation_error: 3,
  run_failure: 4,
  gate_failure: 5,
} as const;

type EvalExitCode = (typeof EVAL_EXIT_CODES)[keyof typeof EVAL_EXIT_CODES];

export class EvalCommandError extends Error {
  readonly exitCode: EvalExitCode;

  constructor(message: string, exitCode: EvalExitCode) {
    super(message);
    this.name = "EvalCommandError";
    this.exitCode = exitCode;
  }
}

export interface ParsedEvalArgs {
  suite_path?: string;
  output: "text" | "json";
  baseline_path?: string;
  report_dir?: string;
  workspace_root?: string;
  config_path?: string;
  provider?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
  agent?: string;
  agent_id?: string;
  agent_slug?: string;
  workflow_profile?: string;
  smart?: boolean;
  no_deep_investigation?: boolean;
  help?: boolean;
}

const HELP_TEXT =
  "Usage: codali eval --suite <path> [options]\n\n"
  + "Options:\n"
  + "  --suite <path>               Path to eval suite JSON (required)\n"
  + "  --output <text|json>         Output mode (default: text)\n"
  + "  --baseline <path>            Optional baseline report for regression diff\n"
  + "  --report-dir <path>          Override eval report output directory\n"
  + "  --workspace-root <path>      Workspace root for task execution\n"
  + "  --provider <name>            Provider override passed to task runs\n"
  + "  --model <name>               Model override passed to task runs\n"
  + "  --api-key <token>            API key override passed to task runs\n"
  + "  --base-url <url>             Base URL override passed to task runs\n"
  + "  --agent <slug>               Agent override passed to task runs\n"
  + "  --agent-id <id>              Agent id override passed to task runs\n"
  + "  --agent-slug <slug>          Agent slug override passed to task runs\n"
  + "  --profile <name>             Workflow profile override for task runs\n"
  + "  --smart                      Force smart mode for task runs\n"
  + "  --no-deep-investigation      Disable deep investigation for task runs\n"
  + "  --config <path>              Config file path\n"
  + "  --help                       Show help\n";

const expectValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new EvalCommandError(`Missing value for ${flag}.`, EVAL_EXIT_CODES.usage_error);
  }
  return value;
};

export const parseEvalArgs = (argv: string[]): ParsedEvalArgs => {
  const parsed: ParsedEvalArgs = {
    output: "text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--suite") {
      parsed.suite_path = expectValue(argv, index, "--suite");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const value = expectValue(argv, index, "--output").trim().toLowerCase();
      if (value !== "text" && value !== "json") {
        throw new EvalCommandError(
          "Invalid --output value. Expected text|json.",
          EVAL_EXIT_CODES.usage_error,
        );
      }
      parsed.output = value;
      index += 1;
      continue;
    }
    if (arg === "--baseline") {
      parsed.baseline_path = expectValue(argv, index, "--baseline");
      index += 1;
      continue;
    }
    if (arg === "--report-dir") {
      parsed.report_dir = expectValue(argv, index, "--report-dir");
      index += 1;
      continue;
    }
    if (arg === "--workspace-root") {
      parsed.workspace_root = expectValue(argv, index, "--workspace-root");
      index += 1;
      continue;
    }
    if (arg === "--config") {
      parsed.config_path = expectValue(argv, index, "--config");
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      parsed.provider = expectValue(argv, index, "--provider");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      parsed.model = expectValue(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--api-key") {
      parsed.api_key = expectValue(argv, index, "--api-key");
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      parsed.base_url = expectValue(argv, index, "--base-url");
      index += 1;
      continue;
    }
    if (arg === "--agent") {
      parsed.agent = expectValue(argv, index, "--agent");
      index += 1;
      continue;
    }
    if (arg === "--agent-id") {
      parsed.agent_id = expectValue(argv, index, "--agent-id");
      index += 1;
      continue;
    }
    if (arg === "--agent-slug") {
      parsed.agent_slug = expectValue(argv, index, "--agent-slug");
      index += 1;
      continue;
    }
    if (arg === "--profile" || arg === "--workflow-profile") {
      parsed.workflow_profile = expectValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--smart") {
      parsed.smart = true;
      continue;
    }
    if (arg === "--no-deep-investigation") {
      parsed.no_deep_investigation = true;
      continue;
    }
    throw new EvalCommandError(`Unknown eval flag: ${arg}`, EVAL_EXIT_CODES.usage_error);
  }
  return parsed;
};

const formatRate = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;

const formatNullable = (value: number | null, unit = ""): string =>
  value === null ? "n/a" : `${value.toFixed(2)}${unit}`;

const printTextReport = (report: EvalReport, reportPath: string): void => {
  const metrics = report.metrics;
  const gateSummary = report.gates.passed
    ? "passed"
    : `failed (${report.gates.failures.map((failure) => failure.code).join(", ")})`;
  const lines = [
    `Eval suite: ${report.suite.suite_name} (${report.suite.suite_id})`,
    `Tasks: ${report.summary.task_passed}/${report.summary.task_total} passed`,
    `Execution errors: ${report.summary.execution_errors}`,
    `M-001 task success: ${formatRate(metrics.m001_task_success_rate.value)}`,
    `M-002 first-pass success: ${formatRate(metrics.m002_first_pass_success_rate.value)}`,
    `M-003 patch apply success: ${formatRate(metrics.m003_patch_apply_success_rate.value)}`,
    `M-004 verification pass: ${formatRate(metrics.m004_verification_pass_rate.value)}`,
    `M-005 hallucination rate: ${formatRate(metrics.m005_hallucination_rate.value)}`,
    `M-006 scope violation rate: ${formatRate(metrics.m006_scope_violation_rate.value)}`,
    `M-007 latency median/p95: ${formatNullable(metrics.m007_latency_ms.median, "ms")}/${formatNullable(metrics.m007_latency_ms.p95, "ms")}`,
    `M-008 success tokens median/p95: ${formatNullable(metrics.m008_success_tokens.median)}/${formatNullable(metrics.m008_success_tokens.p95)}`,
    `M-008 success cost median/p95: ${formatNullable(metrics.m008_success_cost_usd.median, " USD")}/${formatNullable(metrics.m008_success_cost_usd.p95, " USD")}`,
    `Regression gates: ${gateSummary}`,
    `Report: ${reportPath}`,
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
};

const loadBaselineReport = async (params: {
  parsed: ParsedEvalArgs;
  suitePath: string;
  suiteBaselinePath?: string;
  store: ReportStore;
  suiteFingerprint: string;
  reportId: string;
}): Promise<{ path?: string; report?: EvalReport }> => {
  const { parsed, suitePath, suiteBaselinePath, store } = params;
  const suiteDir = path.dirname(suitePath);
  if (parsed.baseline_path) {
    const baselinePath = await store.resolvePath(parsed.baseline_path, process.cwd());
    return { path: baselinePath, report: await store.read(baselinePath) };
  }
  if (suiteBaselinePath) {
    const baselinePath = await store.resolvePath(suiteBaselinePath, suiteDir);
    return { path: baselinePath, report: await store.read(baselinePath) };
  }
  const latest = await store.findLatestForSuite({
    suite_fingerprint: params.suiteFingerprint,
    exclude_report_id: params.reportId,
  });
  if (!latest) return {};
  return { path: latest.path, report: latest.report };
};

export class EvalCommand {
  static helpText(): string {
    return HELP_TEXT;
  }

  static async run(argv: string[]): Promise<void> {
    const parsed = parseEvalArgs(argv);
    if (parsed.help) {
      // eslint-disable-next-line no-console
      console.log(HELP_TEXT);
      return;
    }
    if (!parsed.suite_path) {
      throw new EvalCommandError(
        "Missing required --suite <path>.",
        EVAL_EXIT_CODES.usage_error,
      );
    }

    const resolvedWorkspaceRoot = resolveWorkspaceRoot(process.cwd(), parsed.workspace_root);
    const cliConfig: Record<string, unknown> = {};
    if (parsed.workspace_root) cliConfig.workspaceRoot = parsed.workspace_root;
    if (parsed.provider) cliConfig.provider = parsed.provider;
    if (parsed.model) cliConfig.model = parsed.model;
    if (parsed.api_key) cliConfig.apiKey = parsed.api_key;
    if (parsed.base_url) cliConfig.baseUrl = parsed.base_url;
    if (parsed.workflow_profile) cliConfig.workflow = { profile: parsed.workflow_profile };
    if (parsed.smart !== undefined) cliConfig.smart = parsed.smart;
    if (parsed.no_deep_investigation !== undefined) {
      cliConfig.deepInvestigation = { enabled: !parsed.no_deep_investigation };
    }

    const config = await loadConfig({
      cli: cliConfig,
      cwd: resolvedWorkspaceRoot,
      configPath: parsed.config_path,
    });

    let loadedSuite;
    try {
      loadedSuite = await loadSuiteFromFile(parsed.suite_path, process.cwd());
    } catch (error: unknown) {
      if (error instanceof SuiteValidationError) {
        const issueSummary = error.issues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(", ");
        throw new EvalCommandError(
          `Suite validation failed: ${issueSummary}`,
          EVAL_EXIT_CODES.suite_validation_error,
        );
      }
      throw error;
    }

    const executor = new EvalTaskExecutor({
      workspace_root: config.workspaceRoot,
      suite_dir: loadedSuite.suite_dir,
      provider: parsed.provider ?? (config.provider || undefined),
      model: parsed.model ?? (config.model || undefined),
      api_key: parsed.api_key ?? config.apiKey,
      base_url: parsed.base_url ?? config.baseUrl,
      agent: parsed.agent,
      agent_id: parsed.agent_id,
      agent_slug: parsed.agent_slug,
      workflow_profile: parsed.workflow_profile,
      smart: parsed.smart,
      no_deep_investigation: parsed.no_deep_investigation,
    });
    const runner = new EvalRunner({
      suite_id: loadedSuite.suite.suite_id,
      suite_fingerprint: loadedSuite.suite_fingerprint,
      tasks: loadedSuite.suite.tasks,
      executor,
    });
    const runResult = await runner.run();
    const metrics = aggregateMetrics(runResult);
    const reportId = randomUUID();
    const reportStore = new ReportStore(
      config.workspaceRoot,
      parsed.report_dir ?? config.eval?.report_dir,
    );

    const suiteBaselinePath =
      loadedSuite.suite.baseline?.mode === "none"
        ? undefined
        : loadedSuite.suite.baseline?.report_path;
    const baseline = await loadBaselineReport({
      parsed,
      suitePath: loadedSuite.suite_path,
      suiteBaselinePath,
      store: reportStore,
      suiteFingerprint: loadedSuite.suite_fingerprint,
      reportId,
    });
    const regression = compareAgainstBaseline({
      current: metrics,
      baseline: baseline.report?.metrics,
      baseline_report_id: baseline.report?.report_id,
      baseline_created_at: baseline.report?.created_at,
    });
    const thresholds = resolveGateThresholds(config.eval?.gates, loadedSuite.suite.thresholds);
    const gates = evaluateGates({ metrics, thresholds, comparison: regression });

    const hasRunFailures = runResult.summary.failed > 0 || runResult.summary.execution_errors > 0;
    const exitCode = hasRunFailures
      ? EVAL_EXIT_CODES.run_failure
      : (!gates.passed ? EVAL_EXIT_CODES.gate_failure : 0);
    const report: EvalReport = {
      schema_version: 1,
      report_id: reportId,
      created_at: new Date().toISOString(),
      suite: {
        suite_id: loadedSuite.suite.suite_id,
        suite_name: loadedSuite.suite.name,
        suite_path: loadedSuite.suite_path,
        suite_fingerprint: loadedSuite.suite_fingerprint,
        task_count: loadedSuite.suite.tasks.length,
      },
      summary: {
        exit_code: exitCode,
        passed: exitCode === 0,
        gate_passed: gates.passed,
        task_total: runResult.summary.total,
        task_passed: runResult.summary.passed,
        task_failed: runResult.summary.failed,
        execution_errors: runResult.summary.execution_errors,
      },
      run: runResult,
      metrics,
      regression,
      gates,
    };
    const reportPath = await reportStore.save(report);

    if (parsed.output === "json") {
      // eslint-disable-next-line no-console
      console.log(serializeEvalReport(report, true));
    } else {
      printTextReport(report, reportPath);
    }

    if (exitCode === EVAL_EXIT_CODES.run_failure) {
      throw new EvalCommandError(
        "Eval run completed with failed tasks or execution errors.",
        EVAL_EXIT_CODES.run_failure,
      );
    }
    if (exitCode === EVAL_EXIT_CODES.gate_failure) {
      throw new EvalCommandError(
        "Eval regression gates failed.",
        EVAL_EXIT_CODES.gate_failure,
      );
    }
  }
}
