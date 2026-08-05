#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AskCommand } from "./cli/AskCommand.js";
import { RunCommand } from "./cli/RunCommand.js";
import { ToolsCommand } from "./cli/ToolsCommand.js";
import { ServeCommand } from "./cli/ServeCommand.js";
import { AuthCommand } from "./cli/AuthCommand.js";
import { FeedbackCommand } from "./cli/FeedbackCommand.js";
import { EvalCommand } from "./cli/EvalCommand.js";
import { DatasetCommand } from "./cli/DatasetCommand.js";
import { ImprovementCommand } from "./cli/ImprovementCommand.js";

const HELP_TEXT =
  "Usage: codali ask \"<question>\" [--trace] [--json] [--workspace-root <path>]\n" +
  "   or: codali tools <list|describe|call|health> [options]\n" +
  "   or: codali auth <microsoft>\n" +
  "   or: codali serve [--port <n>] [--api-key <key>]\n" +
  "   or: codali run [--workspace-root <path>] --agent <slug> [--task <file>]\n" +
  "   or: codali run [--workspace-root <path>] --provider <name> --model <model> [--task <file>]\n" +
  "   or: codali <fix|review|explain|test> [run options] [--task <file>]\n" +
  "   or: codali eval --suite <path> [eval options]\n" +
  "   or: codali eval --gateway-live-smoke [eval options]\n" +
  "   or: codali dataset <inspect|review-queue|label|promote-target|export> [options]\n" +
  "   or: codali improvement|improve <policy|levels|inspect|propose|build-release|eval|publish|monitor> [options]\n" +
  "   or: codali learn --file <path/to/file> [--confirm <dedupe_key> ...]\n" +
  "   or: codali learn --confirm <dedupe_key> [--confirm <dedupe_key> ...]\n" +
  "\n" +
  "Commands:\n" +
  "  ask      Ask a question. Routes, gathers evidence with tools, answers with citations.\n" +
  "  tools    Inspect the tools a run can reach, including MCP servers.\n" +
  "  auth     Sign in to a connector that needs a user context (Microsoft Graph).\n" +
  "  serve    Serve Codali over HTTP with the same contract as the CLI.\n" +
  "  run      Run a single task (advanced/general profile).\n" +
  "  fix      Apply fix workflow profile (patch-focused output).\n" +
  "  review   Apply review workflow profile (findings-focused output).\n" +
  "  explain  Apply explain workflow profile (explanation-first output).\n" +
  "  test     Apply test workflow profile (verification-first output).\n" +
  "  eval     Run deterministic local evaluation suites and regression gates.\n" +
  "  dataset  Inspect, review, label, promote, and export local-only dataset collections.\n" +
  "  improvement  Build improvement policy contracts, inspect exports, propose fixtures, and prepare candidate releases.\n" +
  "  improve  Alias for improvement.\n" +
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

  if (command === "ask") {
    await AskCommand.run(rest);
    return;
  }

  if (command === "auth") {
    await AuthCommand.run(rest);
    return;
  }

  if (command === "serve") {
    await ServeCommand.run(rest);
    return;
  }

  if (command === "tools" || command === "mcp") {
    await ToolsCommand.run(command === "mcp" ? ["health", ...rest] : rest);
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

  if (command === "dataset") {
    await DatasetCommand.run(rest);
    return;
  }

  if (command === "improvement" || command === "improve") {
    await ImprovementCommand.run(rest);
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
