#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunCommand } from "./cli/RunCommand.js";

const HELP_TEXT = "Usage: codali run --workspace-root <path> --provider <name> --model <model> [--task <file>]\n" +
  "\n" +
  "Commands:\n" +
  "  run      Run a single task (supports streaming output).\n" +
  "\n" +
  "Options:\n" +
  "  --help, -h     Show help\n" +
  "  --version, -v  Show version\n" +
  "  --smart        Enable the cognitive pipeline\n";

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
  return path.resolve(scriptPath) === path.resolve(current);
})();

if (isMain) {
  runCli().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
