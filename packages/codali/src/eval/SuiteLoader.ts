import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeSuiteDefinition,
  stableJsonStringify,
  SuiteValidationError,
  type EvalSuiteDefinition,
  type EvalTaskDefinition,
} from "./SuiteSchema.js";

export interface LoadedEvalSuite {
  suite_path: string;
  suite_dir: string;
  suite_fingerprint: string;
  suite: EvalSuiteDefinition;
}

const toSuiteValidationError = (
  label: string,
  message: string,
  code: string,
  pathLabel = label,
): SuiteValidationError =>
  new SuiteValidationError(`${label} validation failed.`, [
    {
      path: pathLabel,
      code,
      message,
    },
  ]);

export const hashSuiteDefinition = (suite: EvalSuiteDefinition): string =>
  createHash("sha256").update(stableJsonStringify(suite), "utf8").digest("hex");

export const resolveSuitePath = (suitePath: string, cwd: string): string => {
  const trimmed = suitePath.trim();
  if (!trimmed) {
    throw toSuiteValidationError("suite", "Suite path must be non-empty.", "missing_suite_path");
  }
  return path.resolve(cwd, trimmed);
};

export const resolveTaskFilePath = (
  task: EvalTaskDefinition,
  suiteDir: string,
  workspaceRoot: string,
): string | undefined => {
  if (!task.task_file) return undefined;
  const candidate = path.isAbsolute(task.task_file)
    ? task.task_file
    : path.resolve(suiteDir, task.task_file);
  return path.resolve(workspaceRoot, path.relative(workspaceRoot, candidate));
};

export const loadSuiteFromFile = async (
  suitePath: string,
  cwd = process.cwd(),
): Promise<LoadedEvalSuite> => {
  const resolvedPath = resolveSuitePath(suitePath, cwd);
  let content = "";
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw toSuiteValidationError(
      "suite",
      `Unable to read suite file: ${error instanceof Error ? error.message : String(error)}`,
      "suite_read_failed",
      resolvedPath,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw toSuiteValidationError(
      "suite",
      `Suite file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "suite_invalid_json",
      resolvedPath,
    );
  }

  const suite = normalizeSuiteDefinition(raw, resolvedPath);
  return {
    suite_path: resolvedPath,
    suite_dir: path.dirname(resolvedPath),
    suite_fingerprint: hashSuiteDefinition(suite),
    suite,
  };
};
