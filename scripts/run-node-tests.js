#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["dist"];
const testFiles = [];
const skipDocdexTests = process.platform === "win32" && process.env.MCODA_RUN_DOCDEX_TESTS !== "1";

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

const filteredTests = skipDocdexTests
  ? testFiles.filter((file) => !file.replace(/\\/g, "/").toLowerCase().includes("/docdex/"))
  : testFiles;

if (!filteredTests.length) {
  console.log("No test files found; skipping.");
  process.exit(0);
}

if (skipDocdexTests && filteredTests.length !== testFiles.length) {
  console.log("[tests] Skipping docdex tests on Windows (set MCODA_RUN_DOCDEX_TESTS=1 to enable).");
}

const result = spawnSync(process.execPath, ["--test", ...filteredTests], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
