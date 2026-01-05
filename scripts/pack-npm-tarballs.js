#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dest = path.join(root, "artifacts");
const packages = [
  "packages/cli",
  "packages/core",
  "packages/shared",
  "packages/db",
  "packages/integrations",
  "packages/agents",
];

mkdirSync(dest, { recursive: true });

for (const pkg of packages) {
  execFileSync("npm", ["pack", "--pack-destination", dest, "--ignore-scripts"], {
    cwd: path.join(root, pkg),
    stdio: "inherit",
  });
}
