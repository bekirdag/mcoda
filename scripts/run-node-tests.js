#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["dist"];
const testFiles = [];

const collectTests = (target) => {
  if (!existsSync(target)) return;
  const stat = statSync(target);
  if (stat.isDirectory()) {
    const entries = readdirSync(target);
    for (const entry of entries) {
      collectTests(path.join(target, entry));
    }
    return;
  }
  if (target.endsWith(".test.js")) {
    testFiles.push(target);
  }
};

for (const root of roots) {
  collectTests(path.resolve(process.cwd(), root));
}

if (!testFiles.length) {
  console.log("No test files found; skipping.");
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
