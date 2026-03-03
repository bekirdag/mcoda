import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { VerificationOutcome } from "../cognitive/Types.js";
import { DEFAULT_LOG_DIR } from "../config/Config.js";
import { RunLogReader } from "../runtime/RunLogReader.js";
import type { SafetyTelemetryEventData } from "../runtime/RunLogger.js";
import {
  adaptRunSummaryForReport,
  type NormalizedRunRecord,
} from "./ReportInputAdapter.js";
import type { EvalTaskDefinition } from "./SuiteSchema.js";
import { resolveTaskFilePath } from "./SuiteLoader.js";

export interface EvalRunMeta {
  runId?: string;
  fingerprint?: string | null;
  logPath?: string;
  outputLogPath?: string;
  touchedFiles: string[];
  command?: string;
  commandRunId?: string;
  jobId?: string;
  project?: string;
  taskId?: string;
  taskKey?: string;
  agentId?: string;
  agentSlug?: string;
  workflow?: Record<string, unknown> | null;
}

export interface EvalAssertionResult {
  code: string;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface EvalTaskExecution {
  task_id: string;
  title: string;
  command: string;
  mode: "success" | "failure";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number | null;
  run_succeeded: boolean;
  task_passed: boolean;
  first_pass: boolean | null;
  patch_apply_success: boolean | null;
  verification_outcome: VerificationOutcome | null;
  verification_passed: boolean | null;
  hallucination_detected: boolean | null;
  scope_violation_detected: boolean | null;
  latency_ms: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  assertion_results: EvalAssertionResult[];
  stdout: string;
  stderr: string;
  command_line: string[];
  run_meta?: EvalRunMeta;
  run_summary?: Record<string, unknown>;
  normalized_run?: NormalizedRunRecord;
  safety_events: SafetyTelemetryEventData[];
  execution_error?: string;
}

export interface EvalTaskExecutorOptions {
  workspace_root: string;
  suite_dir: string;
  cli_entry?: string;
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
  timeout_ms?: number;
  extra_env?: NodeJS.ProcessEnv;
  log_dir?: string;
}

interface ParsedRunLog {
  run_summary?: Record<string, unknown>;
  run_failed_reasons: string[];
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const parseRunMeta = (stderr: string): EvalRunMeta | undefined => {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("CODALI_RUN_META ")) continue;
    const payload = line.slice("CODALI_RUN_META ".length);
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const touched = parsed.touchedFiles;
      const touchedFiles = Array.isArray(touched)
        ? touched.filter((entry): entry is string => typeof entry === "string")
        : [];
      return {
        runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
        fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : null,
        logPath: typeof parsed.logPath === "string" ? parsed.logPath : undefined,
        outputLogPath: typeof parsed.outputLogPath === "string" ? parsed.outputLogPath : undefined,
        touchedFiles,
        command: typeof parsed.command === "string" ? parsed.command : undefined,
        commandRunId: typeof parsed.commandRunId === "string" ? parsed.commandRunId : undefined,
        jobId: typeof parsed.jobId === "string" ? parsed.jobId : undefined,
        project: typeof parsed.project === "string" ? parsed.project : undefined,
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
        taskKey: typeof parsed.taskKey === "string" ? parsed.taskKey : undefined,
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
        agentSlug: typeof parsed.agentSlug === "string" ? parsed.agentSlug : undefined,
        workflow: asRecord(parsed.workflow) ?? null,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const readRunLog = async (logPath?: string): Promise<ParsedRunLog> => {
  if (!logPath) return { run_failed_reasons: [] };
  let content = "";
  try {
    content = await readFile(logPath, "utf8");
  } catch {
    return { run_failed_reasons: [] };
  }
  let runSummary: Record<string, unknown> | undefined;
  const runFailedReasons: string[] = [];
  const lines = content.split("\n").filter(Boolean);
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const data = asRecord(parsed.data) ?? {};
    if (type === "run_summary") {
      runSummary = data;
      continue;
    }
    if (type !== "run_failed") continue;
    const reasonsValue = data.reasons;
    if (Array.isArray(reasonsValue)) {
      for (const reason of reasonsValue) {
        if (typeof reason === "string" && reason.trim()) runFailedReasons.push(reason.trim());
      }
    }
    const stage = typeof data.stage === "string" ? data.stage.trim() : "";
    if (stage) runFailedReasons.push(stage);
  }
  return { run_summary: runSummary, run_failed_reasons: runFailedReasons };
};

const resolveCliEntry = (provided?: string): string => {
  if (provided) return provided;
  if (process.argv[1]) return process.argv[1];
  const current = fileURLToPath(import.meta.url);
  return path.resolve(current, "..", "..", "cli.js");
};

const hasPatchFailure = (stderr: string, reasons: string[]): boolean => {
  const haystack = [stderr, ...reasons].join("\n").toLowerCase();
  return (
    haystack.includes("patch_apply_failed")
    || haystack.includes("patch_scope_violation")
    || haystack.includes("patch_search")
    || haystack.includes("patch_rollback")
    || haystack.includes("search block")
  );
};

const detectHallucination = (stderr: string, reasons: string[]): boolean => {
  const haystack = [stderr, ...reasons].join("\n");
  return /\bhallucinat|\bunknown symbol\b|\bunknown file\b|non[-_ ]existent|ENOENT|no such file or directory/i.test(
    haystack,
  );
};

const detectScopeViolation = (
  stderr: string,
  reasons: string[],
  safetyEvents: SafetyTelemetryEventData[],
): boolean => {
  if (safetyEvents.some((event) => event.code === "scope_violation")) return true;
  const haystack = [stderr, ...reasons].join("\n");
  return /\bscope_violation\b|patch_outside_allowed_scope|patch_outside_workspace/i.test(haystack);
};

const buildAssertions = (params: {
  task: EvalTaskDefinition;
  runSucceeded: boolean;
  exitCode: number | null;
  patchApplySuccess: boolean | null;
  verificationOutcome: VerificationOutcome | null;
  latencyMs: number | null;
  costUsd: number | null;
  hallucinationDetected: boolean | null;
  scopeViolationDetected: boolean | null;
}): EvalAssertionResult[] => {
  const assertions: EvalAssertionResult[] = [];
  const expectedSuccess = params.task.assertions.expect_success;
  assertions.push({
    code: "assert_expect_success",
    passed: params.runSucceeded === expectedSuccess,
    message: "Run success matched expectation.",
    expected: expectedSuccess,
    actual: params.runSucceeded,
  });

  if (params.task.assertions.expect_exit_code !== undefined) {
    assertions.push({
      code: "assert_expect_exit_code",
      passed: params.exitCode === params.task.assertions.expect_exit_code,
      message: "Exit code matched expectation.",
      expected: params.task.assertions.expect_exit_code,
      actual: params.exitCode,
    });
  }

  if (params.task.assertions.expect_patch_apply !== undefined) {
    const actual = params.patchApplySuccess;
    assertions.push({
      code: actual === null ? "assert_expect_patch_apply_missing" : "assert_expect_patch_apply",
      passed: actual !== null && actual === params.task.assertions.expect_patch_apply,
      message: "Patch apply outcome matched expectation.",
      expected: params.task.assertions.expect_patch_apply,
      actual,
    });
  }

  if (
    params.task.assertions.expect_verification !== undefined
    && params.task.assertions.expect_verification !== "any"
  ) {
    const actual = params.verificationOutcome;
    assertions.push({
      code: actual === null ? "assert_expect_verification_missing" : "assert_expect_verification",
      passed: actual !== null && actual === params.task.assertions.expect_verification,
      message: "Verification outcome matched expectation.",
      expected: params.task.assertions.expect_verification,
      actual,
    });
  }

  if (params.task.assertions.max_latency_ms !== undefined) {
    const actual = params.latencyMs;
    assertions.push({
      code: actual === null ? "assert_max_latency_missing" : "assert_max_latency",
      passed: actual !== null && actual <= params.task.assertions.max_latency_ms,
      message: "Latency stayed within threshold.",
      expected: params.task.assertions.max_latency_ms,
      actual,
    });
  }

  if (params.task.assertions.max_cost_usd !== undefined) {
    const actual = params.costUsd;
    assertions.push({
      code: actual === null ? "assert_max_cost_missing" : "assert_max_cost",
      passed: actual !== null && actual <= params.task.assertions.max_cost_usd,
      message: "Cost stayed within threshold.",
      expected: params.task.assertions.max_cost_usd,
      actual,
    });
  }

  if (!params.task.assertions.allow_hallucination) {
    assertions.push({
      code: "assert_no_hallucination",
      passed: params.hallucinationDetected !== true,
      message: "No hallucination signals were detected.",
      expected: false,
      actual: params.hallucinationDetected,
    });
  }

  if (!params.task.assertions.allow_scope_violation) {
    assertions.push({
      code: "assert_no_scope_violation",
      passed: params.scopeViolationDetected !== true,
      message: "No scope-violation signals were detected.",
      expected: false,
      actual: params.scopeViolationDetected,
    });
  }

  return assertions;
};

export class EvalTaskExecutor {
  private readonly options: EvalTaskExecutorOptions;

  constructor(options: EvalTaskExecutorOptions) {
    this.options = options;
  }

  async executeTask(task: EvalTaskDefinition): Promise<EvalTaskExecution> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const cliEntry = resolveCliEntry(this.options.cli_entry);
    const commandArgs: string[] = [task.command, "--workspace-root", this.options.workspace_root];
    if (this.options.provider) commandArgs.push("--provider", this.options.provider);
    if (this.options.model) commandArgs.push("--model", this.options.model);
    if (this.options.api_key) commandArgs.push("--api-key", this.options.api_key);
    if (this.options.base_url) commandArgs.push("--base-url", this.options.base_url);
    if (this.options.agent) commandArgs.push("--agent", this.options.agent);
    if (this.options.agent_id) commandArgs.push("--agent-id", this.options.agent_id);
    if (this.options.agent_slug) commandArgs.push("--agent-slug", this.options.agent_slug);
    if (this.options.workflow_profile) commandArgs.push("--profile", this.options.workflow_profile);
    if (this.options.smart === true) commandArgs.push("--smart");
    if (this.options.no_deep_investigation) commandArgs.push("--no-deep-investigation");
    if (task.args.length > 0) commandArgs.push(...task.args);
    const taskFilePath = resolveTaskFilePath(task, this.options.suite_dir, this.options.workspace_root);
    if (taskFilePath) {
      commandArgs.push("--task", taskFilePath);
    } else if (task.inline_task) {
      commandArgs.push(task.inline_task);
    }

    const commandLine = [process.execPath, cliEntry, ...commandArgs];
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let executionError: string | undefined;

    try {
      const result = spawnSync(process.execPath, [cliEntry, ...commandArgs], {
        cwd: this.options.workspace_root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(this.options.extra_env ?? {}),
        },
        timeout: this.options.timeout_ms ?? 20 * 60 * 1000,
      });
      stdout = (result.stdout ?? "").toString();
      stderr = (result.stderr ?? "").toString();
      exitCode = typeof result.status === "number" ? result.status : null;
      if (result.error) executionError = String(result.error);
      if (result.signal && exitCode === null) executionError = `terminated_by_signal:${result.signal}`;
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }

    const runMeta = parseRunMeta(stderr);
    const runLog = await readRunLog(runMeta?.logPath);
    const reader = new RunLogReader(
      this.options.workspace_root,
      this.options.log_dir ?? DEFAULT_LOG_DIR,
    );
    const safetyEvents = runMeta?.runId
      ? await reader.getSafetyEvents(runMeta.runId)
      : [];
    const verificationReports = runMeta?.runId
      ? await reader.getVerificationReports(runMeta.runId)
      : [];
    const latestVerification = verificationReports.length
      ? verificationReports[verificationReports.length - 1]
      : undefined;

    const runSummary = runLog.run_summary;
    const normalizedRun = adaptRunSummaryForReport({
      runSummary,
      runId: runMeta?.runId,
      taskId: task.id,
      verificationOutcome: latestVerification?.outcome ?? null,
      touchedFiles: runMeta?.touchedFiles ?? [],
    });
    const runSucceeded = exitCode === 0 && !executionError;
    const firstPass = (() => {
      const smartRuntime = asRecord(runSummary?.smartRuntime);
      const attempts = asNumber(smartRuntime?.attempts);
      if (attempts !== null) return attempts <= 1;
      return runSucceeded ? true : false;
    })();
    const patchApplySuccess = (() => {
      if (runMeta?.touchedFiles?.length) return true;
      if (hasPatchFailure(stderr, runLog.run_failed_reasons)) return false;
      return null;
    })();
    const verificationOutcome = (() => {
      const normalizedOutcome = normalizedRun.verification_outcome;
      if (normalizedOutcome) return normalizedOutcome;
      if (latestVerification?.outcome) return latestVerification.outcome;
      const verification = asRecord(runSummary?.verification);
      const outcome = verification?.outcome;
      if (
        outcome === "verified_passed"
        || outcome === "verified_failed"
        || outcome === "unverified_with_reason"
      ) {
        return outcome;
      }
      return null;
    })();
    const verificationPassed =
      verificationOutcome === null ? null : verificationOutcome === "verified_passed";
    const hallucinationDetected = detectHallucination(stderr, runLog.run_failed_reasons);
    const scopeViolationDetected = detectScopeViolation(
      stderr,
      runLog.run_failed_reasons,
      safetyEvents,
    );
    const latencyMs = normalizedRun.duration_ms ?? asNumber(runSummary?.durationMs) ?? (Date.now() - startedAtMs);
    const usage = asRecord(runSummary?.usage);
    const tokensUsed = normalizedRun.usage_tokens_total
      ?? asNumber(usage?.totalTokens)
      ?? (() => {
        const input = asNumber(usage?.inputTokens) ?? 0;
        const output = asNumber(usage?.outputTokens) ?? 0;
        return input + output > 0 ? input + output : null;
      })();
    const costUsd = normalizedRun.cost_usd ?? asNumber(runSummary?.actualCost);

    const assertionResults = buildAssertions({
      task,
      runSucceeded,
      exitCode,
      patchApplySuccess,
      verificationOutcome,
      latencyMs,
      costUsd,
      hallucinationDetected,
      scopeViolationDetected,
    });
    const taskPassed = assertionResults.every((assertion) => assertion.passed);

    const endedAtMs = Date.now();
    return {
      task_id: task.id,
      title: task.title,
      command: task.command,
      mode: task.mode,
      started_at: startedAt,
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: endedAtMs - startedAtMs,
      exit_code: exitCode,
      run_succeeded: runSucceeded,
      task_passed: taskPassed,
      first_pass: firstPass,
      patch_apply_success: patchApplySuccess,
      verification_outcome: verificationOutcome,
      verification_passed: verificationPassed,
      hallucination_detected: hallucinationDetected,
      scope_violation_detected: scopeViolationDetected,
      latency_ms: latencyMs,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      assertion_results: assertionResults,
      stdout,
      stderr,
      command_line: commandLine,
      run_meta: runMeta,
      run_summary: runSummary,
      normalized_run: normalizedRun,
      safety_events: safetyEvents,
      execution_error: executionError,
    };
  }
}
