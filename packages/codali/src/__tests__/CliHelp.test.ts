import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "..", "cli.js");

const runCli = (args: string[]): ReturnType<typeof spawnSync> => {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
};

test("codali --help prints usage", { concurrency: false }, () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  const output = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString() ?? "";
  assert.match(output, /Usage: codali/);
  assert.match(output, /fix\|review\|explain\|test/);
  assert.match(output, /codali eval --suite <path>/);
  assert.match(output, /codali learn --file <path\/to\/file>/);
  assert.match(output, /--confirm <dedupe_key>/);
  assert.match(output, /\n  eval\s+/);
  assert.match(output, /\n  fix\s+/);
  assert.match(output, /\n  review\s+/);
  assert.match(output, /\n  explain\s+/);
  assert.match(output, /\n  test\s+/);
  assert.match(output, /--smart/);
});

test("codali doctor prints paths", { concurrency: false }, () => {
  const result = runCli(["doctor"]);
  assert.equal(result.status, 0);
  const output = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString() ?? "";
  assert.match(output, /codali doctor/);
  assert.match(output, /CLI Path:/);
  assert.match(output, /Package Root:/);
});
