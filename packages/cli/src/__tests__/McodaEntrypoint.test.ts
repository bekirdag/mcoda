import test from "node:test";
import assert from "node:assert/strict";
import packageJson from "../../package.json" with { type: "json" };
import { McodaEntrypoint } from "../bin/McodaEntrypoint.js";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

test("McodaEntrypoint prints version", { concurrency: false }, async () => {
  const logs = await captureLogs(() => McodaEntrypoint.run(["--version"]));
  const output = logs.join("\n");
  assert.match(output, new RegExp(String((packageJson as any).version ?? "dev")));
});

test("McodaEntrypoint disables stream io for --json", { concurrency: false }, async () => {
  const originalStream = process.env.MCODA_STREAM_IO;
  try {
    delete process.env.MCODA_STREAM_IO;
    await captureLogs(() => McodaEntrypoint.run(["--version", "--json"]));
    assert.equal(process.env.MCODA_STREAM_IO, "0");
  } finally {
    if (originalStream === undefined) {
      delete process.env.MCODA_STREAM_IO;
    } else {
      process.env.MCODA_STREAM_IO = originalStream;
    }
  }
});

test("McodaEntrypoint qa-tasks help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => McodaEntrypoint.run(["qa-tasks", "--help"]));
  assert.ok(logs.join("\n").includes("Usage: mcoda qa-tasks"));
});

test("McodaEntrypoint project-guidance help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => McodaEntrypoint.run(["project-guidance", "--help"]));
  assert.ok(logs.join("\n").includes("Usage: mcoda project-guidance"));
});

test("McodaEntrypoint rejects unknown commands", { concurrency: false }, async () => {
  await assert.rejects(() => McodaEntrypoint.run(["totally-unknown"]), /Unknown command/);
});
