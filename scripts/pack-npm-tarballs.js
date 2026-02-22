#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "artifacts");
const packages = [
  "packages/shared",
  "packages/db",
  "packages/agents",
  "packages/generators",
  "packages/integrations",
  "packages/core",
  "packages/cli",
];

mkdirSync(dest, { recursive: true });

const npmCommand = resolveNpmCommand();
const npmArgs = ["pack", "--pack-destination", dest, "--ignore-scripts"];

for (const pkg of packages) {
  execFileSync(npmCommand.bin, npmCommand.prefixArgs.concat(npmArgs), {
    cwd: path.join(root, pkg),
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
    },
  });
}

function resolveNpmCommand() {
  const candidates =
    process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return { bin: candidate, prefixArgs: [] };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        continue;
      }
    }
  }

  const npmCliPath = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );

  if (existsSync(npmCliPath)) {
    return { bin: process.execPath, prefixArgs: [npmCliPath] };
  }

  throw new Error(
    "npm not found on PATH and npm-cli.js is missing from the Node installation."
  );
}
