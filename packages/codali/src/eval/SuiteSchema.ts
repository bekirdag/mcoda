import type { VerificationOutcome } from "../cognitive/Types.js";

export const EVAL_COMMANDS = ["run", "fix", "review", "explain", "test"] as const;
export type EvalCommandName = (typeof EVAL_COMMANDS)[number];

export const EVAL_VERIFICATION_EXPECTATIONS = [
  "verified_passed",
  "verified_failed",
  "unverified_with_reason",
  "any",
] as const;
export type EvalVerificationExpectation = (typeof EVAL_VERIFICATION_EXPECTATIONS)[number];

export interface EvalGateThresholds {
  patch_apply_drop_max: number;
  verification_pass_rate_min: number;
  hallucination_rate_max: number;
  scope_violation_rate_max: number;
}

export interface EvalSuiteBaseline {
  mode: "previous" | "none";
  report_path?: string;
}

export interface EvalTaskAssertions {
  expect_success: boolean;
  expect_exit_code?: number;
  expect_patch_apply?: boolean;
  expect_verification?: EvalVerificationExpectation;
  max_latency_ms?: number;
  max_cost_usd?: number;
  allow_hallucination: boolean;
  allow_scope_violation: boolean;
}

export interface EvalTaskDefinition {
  id: string;
  title: string;
  description?: string;
  mode: "success" | "failure";
  command: EvalCommandName;
  task_file?: string;
  inline_task?: string;
  args: string[];
  assertions: EvalTaskAssertions;
}

export interface EvalSuiteDefinition {
  schema_version: 1;
  suite_id: string;
  name: string;
  description?: string;
  thresholds?: Partial<EvalGateThresholds>;
  baseline?: EvalSuiteBaseline;
  tasks: EvalTaskDefinition[];
}

export interface SuiteValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class SuiteValidationError extends Error {
  readonly issues: SuiteValidationIssue[];

  constructor(message: string, issues: SuiteValidationIssue[]) {
    super(message);
    this.name = "SuiteValidationError";
    this.issues = issues;
  }
}

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
};

const readAliased = (source: JsonRecord, aliases: string[]): unknown => {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) return source[alias];
  }
  return undefined;
};

const readString = (source: JsonRecord, aliases: string[]): string | undefined => {
  const value = readAliased(source, aliases);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length ? normalized : undefined;
};

const readBoolean = (source: JsonRecord, aliases: string[]): boolean | undefined => {
  const value = readAliased(source, aliases);
  return typeof value === "boolean" ? value : undefined;
};

const readNumber = (source: JsonRecord, aliases: string[]): number | undefined => {
  const value = readAliased(source, aliases);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const readInteger = (source: JsonRecord, aliases: string[]): number | undefined => {
  const value = readNumber(source, aliases);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
};

const normalizeRateField = (
  source: JsonRecord,
  aliases: string[],
  issues: SuiteValidationIssue[],
  pathLabel: string,
): number | undefined => {
  const value = readNumber(source, aliases);
  if (value === undefined) return undefined;
  if (value < 0 || value > 1) {
    issues.push({
      path: pathLabel,
      code: "invalid_rate_range",
      message: "Expected a number between 0 and 1.",
    });
    return undefined;
  }
  return value;
};

const normalizeVerificationExpectation = (
  source: JsonRecord,
  issues: SuiteValidationIssue[],
  pathLabel: string,
): EvalVerificationExpectation | undefined => {
  const value = readString(source, ["expect_verification", "expectVerification"]);
  if (!value) return undefined;
  if ((EVAL_VERIFICATION_EXPECTATIONS as readonly string[]).includes(value)) {
    return value as EvalVerificationExpectation;
  }
  if (
    (["verified_passed", "verified_failed", "unverified_with_reason"] as VerificationOutcome[]).includes(
      value as VerificationOutcome,
    )
  ) {
    return value as EvalVerificationExpectation;
  }
  issues.push({
    path: pathLabel,
    code: "invalid_verification_expectation",
    message: `Expected one of: ${EVAL_VERIFICATION_EXPECTATIONS.join(", ")}.`,
  });
  return undefined;
};

const normalizeTaskAssertions = (
  rawValue: unknown,
  taskPath: string,
  taskMode: "success" | "failure",
  issues: SuiteValidationIssue[],
): EvalTaskAssertions => {
  const source = asRecord(rawValue) ?? {};
  if (!asRecord(rawValue) && rawValue !== undefined) {
    issues.push({
      path: `${taskPath}.assertions`,
      code: "invalid_object",
      message: "Expected an object for assertions.",
    });
  }

  const expectSuccess = readBoolean(source, ["expect_success", "expectSuccess"]) ?? (taskMode !== "failure");
  const explicitExitCode = readInteger(source, ["expect_exit_code", "expectExitCode"]);
  const expectExitCode = explicitExitCode ?? (expectSuccess ? 0 : undefined);
  if (explicitExitCode !== undefined && explicitExitCode < 0) {
    issues.push({
      path: `${taskPath}.assertions.expect_exit_code`,
      code: "invalid_exit_code",
      message: "Expected a non-negative integer.",
    });
  }
  const maxLatencyMs = readNumber(source, ["max_latency_ms", "maxLatencyMs"]);
  if (maxLatencyMs !== undefined && maxLatencyMs <= 0) {
    issues.push({
      path: `${taskPath}.assertions.max_latency_ms`,
      code: "invalid_latency",
      message: "Expected max latency to be greater than 0.",
    });
  }
  const maxCostUsd = readNumber(source, ["max_cost_usd", "maxCostUsd"]);
  if (maxCostUsd !== undefined && maxCostUsd < 0) {
    issues.push({
      path: `${taskPath}.assertions.max_cost_usd`,
      code: "invalid_cost",
      message: "Expected max cost to be greater than or equal to 0.",
    });
  }

  return {
    expect_success: expectSuccess,
    expect_exit_code: expectExitCode,
    expect_patch_apply: readBoolean(source, ["expect_patch_apply", "expectPatchApply"]),
    expect_verification: normalizeVerificationExpectation(
      source,
      issues,
      `${taskPath}.assertions.expect_verification`,
    ),
    max_latency_ms: maxLatencyMs !== undefined && maxLatencyMs > 0 ? maxLatencyMs : undefined,
    max_cost_usd: maxCostUsd !== undefined && maxCostUsd >= 0 ? maxCostUsd : undefined,
    allow_hallucination: readBoolean(source, ["allow_hallucination", "allowHallucination"]) ?? false,
    allow_scope_violation: readBoolean(source, ["allow_scope_violation", "allowScopeViolation"]) ?? false,
  };
};

const normalizeTask = (
  value: unknown,
  index: number,
  issues: SuiteValidationIssue[],
): EvalTaskDefinition => {
  const taskPath = `tasks[${index}]`;
  const source = asRecord(value);
  if (!source) {
    issues.push({
      path: taskPath,
      code: "invalid_object",
      message: "Expected task to be an object.",
    });
  }
  const taskSource: JsonRecord = source ?? {};

  const id = readString(taskSource, ["id"]) ?? `task-${index + 1}`;
  if (!readString(taskSource, ["id"])) {
    issues.push({
      path: `${taskPath}.id`,
      code: "missing_required",
      message: "Task id is required.",
    });
  }
  const title = readString(taskSource, ["title"]) ?? id;
  const modeValue = readString(taskSource, ["mode"]);
  const mode: "success" | "failure" =
    modeValue === "success" || modeValue === "failure"
      ? modeValue
      : (readBoolean(asRecord(readAliased(taskSource, ["assertions"])) ?? {}, ["expect_success", "expectSuccess"])
        === false
        ? "failure"
        : "success");
  if (modeValue && modeValue !== "success" && modeValue !== "failure") {
    issues.push({
      path: `${taskPath}.mode`,
      code: "invalid_mode",
      message: "Expected task mode to be success|failure.",
    });
  }
  const commandValue = readString(taskSource, ["command"]);
  const command: EvalCommandName =
    commandValue && (EVAL_COMMANDS as readonly string[]).includes(commandValue)
      ? (commandValue as EvalCommandName)
      : "run";
  if (commandValue && !(EVAL_COMMANDS as readonly string[]).includes(commandValue)) {
    issues.push({
      path: `${taskPath}.command`,
      code: "invalid_command",
      message: `Expected command to be one of: ${EVAL_COMMANDS.join(", ")}.`,
    });
  }
  const taskFile = readString(taskSource, ["task_file", "taskFile"]);
  const inlineTask = readString(taskSource, ["inline_task", "inlineTask"]);
  if (!taskFile && !inlineTask) {
    issues.push({
      path: taskPath,
      code: "missing_task_input",
      message: "Expected exactly one of task_file or inline_task.",
    });
  }
  if (taskFile && inlineTask) {
    issues.push({
      path: taskPath,
      code: "ambiguous_task_input",
      message: "Provide only one of task_file or inline_task.",
    });
  }
  const argsValue = readAliased(taskSource, ["args"]);
  const args: string[] = [];
  if (Array.isArray(argsValue)) {
    for (let argIndex = 0; argIndex < argsValue.length; argIndex += 1) {
      const entry = argsValue[argIndex];
      if (typeof entry !== "string") {
        issues.push({
          path: `${taskPath}.args[${argIndex}]`,
          code: "invalid_arg",
          message: "Expected every task arg to be a string.",
        });
        continue;
      }
      const normalized = entry.trim();
      if (normalized) args.push(normalized);
    }
  } else if (argsValue !== undefined) {
    issues.push({
      path: `${taskPath}.args`,
      code: "invalid_args",
      message: "Expected args to be an array of strings.",
    });
  }

  return {
    id,
    title,
    description: readString(taskSource, ["description"]),
    mode,
    command,
    task_file: taskFile,
    inline_task: inlineTask,
    args,
    assertions: normalizeTaskAssertions(readAliased(taskSource, ["assertions"]), taskPath, mode, issues),
  };
};

const normalizeThresholds = (
  value: unknown,
  issues: SuiteValidationIssue[],
): Partial<EvalGateThresholds> | undefined => {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (!source) {
    issues.push({
      path: "thresholds",
      code: "invalid_object",
      message: "Expected thresholds to be an object.",
    });
    return undefined;
  }
  const thresholds: Partial<EvalGateThresholds> = {};
  const patchApplyDropMax = normalizeRateField(
    source,
    ["patch_apply_drop_max", "patchApplyDropMax"],
    issues,
    "thresholds.patch_apply_drop_max",
  );
  if (patchApplyDropMax !== undefined) thresholds.patch_apply_drop_max = patchApplyDropMax;
  const verificationPassRateMin = normalizeRateField(
    source,
    ["verification_pass_rate_min", "verificationPassRateMin"],
    issues,
    "thresholds.verification_pass_rate_min",
  );
  if (verificationPassRateMin !== undefined) {
    thresholds.verification_pass_rate_min = verificationPassRateMin;
  }
  const hallucinationRateMax = normalizeRateField(
    source,
    ["hallucination_rate_max", "hallucinationRateMax"],
    issues,
    "thresholds.hallucination_rate_max",
  );
  if (hallucinationRateMax !== undefined) thresholds.hallucination_rate_max = hallucinationRateMax;
  const scopeViolationRateMax = normalizeRateField(
    source,
    ["scope_violation_rate_max", "scopeViolationRateMax"],
    issues,
    "thresholds.scope_violation_rate_max",
  );
  if (scopeViolationRateMax !== undefined) {
    thresholds.scope_violation_rate_max = scopeViolationRateMax;
  }
  return Object.keys(thresholds).length ? thresholds : undefined;
};

const normalizeBaseline = (
  value: unknown,
  issues: SuiteValidationIssue[],
): EvalSuiteBaseline | undefined => {
  if (value === undefined) return undefined;
  const source = asRecord(value);
  if (!source) {
    issues.push({
      path: "baseline",
      code: "invalid_object",
      message: "Expected baseline to be an object.",
    });
    return undefined;
  }
  const modeValue = readString(source, ["mode"]);
  let mode: EvalSuiteBaseline["mode"] = "previous";
  if (modeValue === "previous" || modeValue === "none") {
    mode = modeValue;
  } else if (modeValue) {
    issues.push({
      path: "baseline.mode",
      code: "invalid_baseline_mode",
      message: "Expected baseline.mode to be previous|none.",
    });
  }
  return {
    mode,
    report_path: readString(source, ["report_path", "reportPath"]),
  };
};

export const normalizeSuiteDefinition = (raw: unknown, label = "suite"): EvalSuiteDefinition => {
  const issues: SuiteValidationIssue[] = [];
  const source = asRecord(raw);
  if (!source) {
    throw new SuiteValidationError(`${label} is invalid.`, [
      {
        path: label,
        code: "invalid_object",
        message: "Expected suite root to be an object.",
      },
    ]);
  }

  const schemaVersion = readInteger(source, ["schema_version", "schemaVersion"]) ?? 1;
  if (schemaVersion !== 1) {
    issues.push({
      path: "schema_version",
      code: "unsupported_schema_version",
      message: "Only schema_version=1 is supported.",
    });
  }

  const suiteId = readString(source, ["suite_id", "suiteId"]);
  if (!suiteId) {
    issues.push({
      path: "suite_id",
      code: "missing_required",
      message: "suite_id is required.",
    });
  }
  const tasksValue = readAliased(source, ["tasks"]);
  if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
    issues.push({
      path: "tasks",
      code: "missing_tasks",
      message: "tasks must be a non-empty array.",
    });
  }
  const tasksRaw = Array.isArray(tasksValue) ? tasksValue : [];
  const tasks = tasksRaw.map((entry, index) => normalizeTask(entry, index, issues));

  const seenTaskIds = new Set<string>();
  for (const task of tasks) {
    if (seenTaskIds.has(task.id)) {
      issues.push({
        path: `tasks.${task.id}`,
        code: "duplicate_task_id",
        message: `Task id "${task.id}" is duplicated.`,
      });
      continue;
    }
    seenTaskIds.add(task.id);
  }

  if (issues.length > 0) {
    throw new SuiteValidationError(`${label} validation failed.`, issues);
  }

  const normalized: EvalSuiteDefinition = {
    schema_version: 1,
    suite_id: suiteId ?? "unknown-suite",
    name: readString(source, ["name"]) ?? (suiteId ?? "unnamed-suite"),
    description: readString(source, ["description"]),
    thresholds: normalizeThresholds(readAliased(source, ["thresholds"]), issues),
    baseline: normalizeBaseline(readAliased(source, ["baseline"]), issues),
    tasks,
  };

  if (issues.length > 0) {
    throw new SuiteValidationError(`${label} validation failed.`, issues);
  }

  return normalized;
};

const stableSort = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sortedEntries = Object.keys(source)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, stableSort(source[key])] as const);
  return Object.fromEntries(sortedEntries);
};

export const stableJsonStringify = (value: unknown): string =>
  JSON.stringify(stableSort(value));
