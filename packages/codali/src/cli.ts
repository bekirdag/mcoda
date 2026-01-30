#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunCommand } from "./cli/RunCommand.js";

const HELP_TEXT =
  "Usage: codali run [--workspace-root <path>] --agent <slug> [--task <file>]\n" +
  "   or: codali run [--workspace-root <path>] --provider <name> --model <model> [--task <file>]\n" +
  "\n" +
  "Commands:\n" +
  "  run      Run a single task (supports streaming output).\n" +
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

  if (command === "run") {
    await RunCommand.run(rest);
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
    process.exitCode = 1;
  });
}
