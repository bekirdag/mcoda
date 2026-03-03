#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunCommand } from "./cli/RunCommand.js";
import { FeedbackCommand } from "./cli/FeedbackCommand.js";
import { EvalCommand } from "./cli/EvalCommand.js";

const HELP_TEXT =
  "Usage: codali run [--workspace-root <path>] --agent <slug> [--task <file>]\n" +
  "   or: codali run [--workspace-root <path>] --provider <name> --model <model> [--task <file>]\n" +
  "   or: codali <fix|review|explain|test> [run options] [--task <file>]\n" +
  "   or: codali eval --suite <path> [eval options]\n" +
  "   or: codali learn --file <path/to/file> [--confirm <dedupe_key> ...]\n" +
  "   or: codali learn --confirm <dedupe_key> [--confirm <dedupe_key> ...]\n" +
  "\n" +
  "Commands:\n" +
  "  run      Run a single task (advanced/general profile).\n" +
  "  fix      Apply fix workflow profile (patch-focused output).\n" +
  "  review   Apply review workflow profile (findings-focused output).\n" +
  "  explain  Apply explain workflow profile (explanation-first output).\n" +
  "  test     Apply test workflow profile (verification-first output).\n" +
  "  eval     Run deterministic local evaluation suites and regression gates.\n" +
  "  learn    Analyze user edits/reverts and govern candidate->enforced learning.\n" +
  "  doctor   Print environment and install paths.\n" +
  "\n" +
  "Options:\n" +
  "  --help, -h     Show help\n" +
  "  --version, -v  Show version\n" +
  "  --smart        Enable the cognitive pipeline (default)\n";

const resolveReal = (value: string): string => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

const printDoctor = (): void => {
  const scriptPath = process.argv[1] ?? "unknown";
  const current = fileURLToPath(import.meta.url);
  const resolvedScript = resolveReal(scriptPath);
  const resolvedCurrent = resolveReal(current);
  const binDir = path.dirname(resolvedScript);
  const pkgRoot = path.resolve(resolvedCurrent, "..", "..");
  const pkgJson = path.join(pkgRoot, "package.json");
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const inPath = pathEntries.includes(binDir);

  const lines = [
    "codali doctor",
    `Node: ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    `CLI Path: ${scriptPath}`,
    `CLI Resolved: ${resolvedScript}`,
    `Entry Resolved: ${resolvedCurrent}`,
    `Bin Dir In PATH: ${inPath ? "yes" : "no"}`,
    `Package Root: ${pkgRoot}`,
    `Package.json: ${fs.existsSync(pkgJson) ? "found" : "missing"}`,
  ];

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
};

export const runCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    // eslint-disable-next-line no-console
    console.log(HELP_TEXT);
    return;
  }

  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    // Keep this lightweight for scaffold phase.
    // eslint-disable-next-line no-console
    console.log("dev");
    return;
  }

  if (command === "doctor" || command === "--doctor") {
    printDoctor();
    return;
  }

  if (["run", "fix", "review", "explain", "test"].includes(command)) {
    await RunCommand.run(["--command", command, ...rest]);
    return;
  }

  if (command === "eval") {
    await EvalCommand.run(rest);
    return;
  }

  if (command === "learn") {
    await FeedbackCommand.run(rest);
    return;
  }

  throw new Error(HELP_TEXT);
};

const isMain = (() => {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  const current = fileURLToPath(import.meta.url);
  return resolveReal(scriptPath) === resolveReal(current);
})();

if (isMain) {
  runCli().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    const maybeWithCode = error as { exitCode?: unknown };
    process.exitCode =
      typeof maybeWithCode.exitCode === "number" && Number.isInteger(maybeWithCode.exitCode)
        ? maybeWithCode.exitCode
        : 1;
  });
}
