#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetCommand } from "./cli/DatasetCommand.js";

const resolveReal = (value: string): string => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

const isMain = (() => {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  return resolveReal(fileURLToPath(import.meta.url)) === resolveReal(scriptPath);
})();

if (isMain) {
  DatasetCommand.run(process.argv.slice(2)).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    const maybeWithCode = error as { exitCode?: unknown };
    process.exitCode =
      typeof maybeWithCode.exitCode === "number" && Number.isInteger(maybeWithCode.exitCode)
        ? maybeWithCode.exitCode
        : 1;
  });
}
